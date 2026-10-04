import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  captureGateCandidateIdentity,
  type GateCandidateIdentity,
} from "../../src/application/gate-candidate-identity.js";
import {
  loadGateEvidence,
  type GateEvidenceManifest,
} from "../../src/application/gate-evidence-service.js";
import {
  RETAINED_GATE_EVIDENCE_LIMITS,
  RetainedGateEvidenceSession,
  type RetainedGateEvidenceAdditionalReference,
} from "../../src/application/retained-gate-evidence.js";
import { resolveLocalGateShell } from "../../src/gates.js";
import type { LocalGateExecutionReceipt } from "../../src/gates/execution-receipt.js";
import { loadPlan, type Gate, type Plan } from "../../src/schema.js";
import { computeCanonicalHash } from "../../src/schemas/task-contract.js";

vi.mock("../../src/application/gate-candidate-identity.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/application/gate-candidate-identity.js")>();
  return { ...actual, captureGateCandidateIdentity: vi.fn() };
});

const directories: string[] = [];
const capture = vi.mocked(captureGateCandidateIdentity);
const nativeFs = await vi.importActual<typeof import("node:fs")>("node:fs");

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: vi.fn(actual.statSync),
    lstatSync: vi.fn(actual.lstatSync),
    openSync: vi.fn(actual.openSync),
    readSync: vi.fn(actual.readSync),
    closeSync: vi.fn(actual.closeSync),
  };
});

beforeEach(() => {
  capture.mockReset();
  vi.mocked(fs.statSync).mockReset().mockImplementation(nativeFs.statSync);
  vi.mocked(fs.lstatSync).mockReset().mockImplementation(nativeFs.lstatSync);
  vi.mocked(fs.openSync).mockReset().mockImplementation(nativeFs.openSync);
  vi.mocked(fs.readSync).mockReset().mockImplementation(nativeFs.readSync);
  vi.mocked(fs.closeSync).mockReset().mockImplementation(nativeFs.closeSync);
});
afterEach(() => {
  vi.restoreAllMocks();
  const temporaryRoot = nativeFs.realpathSync(tmpdir());
  for (const directory of directories.splice(0)) {
    if (
      path.dirname(directory) !== temporaryRoot ||
      !path.basename(directory).startsWith("lexrunner-retained-") ||
      nativeFs.lstatSync(directory).isSymbolicLink() ||
      nativeFs.realpathSync(directory) !== directory
    ) {
      throw new Error("Refusing cleanup of a redirected or unowned fixture root");
    }
    nativeFs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("opt-in retained gate evidence", () => {
  it.each([null, "true", 1])(
    "rejects an invalid verification selector %s before filesystem access",
    (verifyArtifacts) => {
      const fixture = evidenceFixture();
      const stat = vi.mocked(fs.statSync);
      expect(() =>
        loadGateEvidence({ ...fixture.input(), verifyArtifacts } as unknown as Parameters<
          typeof loadGateEvidence
        >[0])
      ).toThrowError(expect.objectContaining({ code: "GATE_EVIDENCE_REFERENCE_INVALID" }));
      expect(stat).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
    }
  );
  it("keeps default loading unchanged and does not read retained artifacts", () => {
    const fixture = evidenceFixture();
    fs.rmSync(fixture.retainedPath);
    const projection = loadGateEvidence(fixture.input(false));
    expect(projection).not.toHaveProperty("artifactVerification");
    expect(projection.observations.passed).toEqual(["one/test"]);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("performs final candidate capture after all rehashes while the descriptors remain held", () => {
    const fixture = evidenceFixture();
    let initialReads = 0;
    vi.mocked(fs.readSync).mockImplementation(((...args: unknown[]) => {
      if (args[4] === 0) initialReads++;
      return Reflect.apply(nativeFs.readSync, fs, args);
    }) as typeof fs.readSync);
    capture.mockReturnValueOnce(fixture.candidate).mockImplementationOnce(() => {
      expect(initialReads).toBe(6);
      expect(fs.closeSync).not.toHaveBeenCalled();
      return fixture.candidate;
    });
    expect(loadGateEvidence(fixture.input()).artifactVerification!.status).toBe("complete");
    expect(fs.closeSync).toHaveBeenCalledTimes(3);
  });

  it.each(["manifest", "execution-receipt", "retained-artifact", "operation-terminal"] as const)(
    "detects %s mutation during the final candidate capture",
    (kind) => {
      const fixture = evidenceFixture();
      const terminal = path.join(fixture.evidenceRoot, "terminal.json");
      fs.writeFileSync(terminal, "original");
      const selected =
        kind === "manifest"
          ? fixture.manifestPath
          : kind === "execution-receipt"
            ? fixture.receiptPath
            : kind === "retained-artifact"
              ? fixture.retainedPath
              : terminal;
      const additionalReferences: RetainedGateEvidenceAdditionalReference[] =
        kind === "operation-terminal" ? [{ kind, path: terminal, sha256: fileHash(terminal) }] : [];
      capture.mockReturnValueOnce(fixture.candidate).mockImplementationOnce(() => {
        fs.appendFileSync(selected, "changed");
        return fixture.candidate;
      });
      const report = loadGateEvidence({
        ...fixture.input(),
        additionalReferences,
      }).artifactVerification!;
      expect(report.status).toBe("incomplete");
      expect(report.reasonCodes).toContain("FILE_CHANGED");
      expect(report.references.find((reference) => reference.kind === kind)?.outcome).toBe(
        "changed"
      );
    }
  );

  it("reads the complete pinned closure without reading sources, latest files, or shell bytes", () => {
    const fixture = evidenceFixture();
    fixture.receipt.execution.shell.executable = identity(
      path.join(fixture.root, "absent-shell"),
      "old shell"
    );
    fixture.receipt.execution.shell.identityAfter = fixture.receipt.execution.shell.executable;
    fixture.rewrite();
    const opened: string[] = [];
    vi.mocked(fs.openSync).mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      opened.push(String(args[0]));
      return nativeFs.openSync(...args);
    });
    const projection = loadGateEvidence(fixture.input());
    expect(projection.artifactVerification).toMatchObject({
      contract: "lexrunner-retained-gate-evidence/v1",
      status: "complete",
      authority: "unverified",
      scope: "referenced-evidence-closure",
      reasonCodes: [],
      references: [
        { kind: "manifest", path: "gate-evidence-manifest.json", outcome: "complete" },
        { kind: "execution-receipt", path: "one/test/receipt.json", outcome: "complete" },
        { kind: "retained-artifact", path: "one/test/report.json", bytes: 17, outcome: "complete" },
      ],
    });
    expect(opened).toEqual([fixture.manifestPath, fixture.receiptPath, fixture.retainedPath]);
    expect(capture).toHaveBeenCalledTimes(2);
    const report = JSON.stringify(projection.artifactVerification);
    expect(report).not.toContain(fixture.root);
    expect(report).not.toContain(fixture.plan.items[0]!.gates[0]!.run);
    expect(report).not.toContain("secret output");
  });

  it("includes only the two explicit internal operation pins in the same bounded session", () => {
    const fixture = evidenceFixture();
    const pins: RetainedGateEvidenceAdditionalReference[] = [
      "operation-descriptor",
      "operation-terminal",
    ].map((kind) => {
      const file = path.join(fixture.evidenceRoot, `${kind}.json`);
      fs.writeFileSync(file, JSON.stringify({ kind }));
      return {
        kind: kind as RetainedGateEvidenceAdditionalReference["kind"],
        path: file,
        sha256: fileHash(file),
      };
    });
    expect(
      loadGateEvidence({ ...fixture.input(), additionalReferences: pins }).artifactVerification
    ).toMatchObject({
      status: "complete",
      references: [
        { kind: "manifest" },
        { kind: "operation-descriptor", outcome: "complete" },
        { kind: "operation-terminal", outcome: "complete" },
        { kind: "execution-receipt" },
        { kind: "retained-artifact" },
      ],
    });
    expect(
      loadGateEvidence({
        ...fixture.input(false),
        additionalReferences: [{ ...pins[0]!, path: "missing" }],
      })
    ).not.toHaveProperty("artifactVerification");
  });

  it.each(["operation-descriptor", "operation-terminal"] as const)(
    "retains and rechecks %s through the final candidate check",
    (kind) => {
      const fixture = evidenceFixture();
      const file = path.join(fixture.evidenceRoot, `${kind}.json`);
      fs.writeFileSync(file, "original");
      const pin = { kind, path: file, sha256: fileHash(file) };
      // The final capture occurs after every final descriptor rehash while descriptors are held.
      let manifestReads = 0;
      vi.mocked(fs.readSync).mockImplementation(((...args: unknown[]) => {
        if (args[4] === 0 && ++manifestReads === 4) fs.writeFileSync(file, "modified");
        return Reflect.apply(nativeFs.readSync, fs, args);
      }) as typeof fs.readSync);
      const report = loadGateEvidence({
        ...fixture.input(),
        additionalReferences: [pin],
      }).artifactVerification!;
      expect(report.status).toBe("incomplete");
      expect(report.reasonCodes).toContain("FILE_CHANGED");
      expect(report.references.find((reference) => reference.kind === kind)?.outcome).toBe(
        "changed"
      );
    }
  );

  it.each([
    ["missing", "FILE_MISSING"],
    ["bytes", "DIGEST_MISMATCH"],
    ["size", "SIZE_MISMATCH"],
    ["source", "SOURCE_METADATA_MISMATCH"],
    ["stale", "COLLECTION_INCOMPLETE"],
    ["absent-retained", "COLLECTION_INCOMPLETE"],
  ] as const)(
    "reports %s retained evidence precisely without replacing the recorded outcome",
    (failure, code) => {
      const fixture = evidenceFixture();
      const artifact = fixture.receipt.artifacts[0]!;
      if (failure === "missing") fs.rmSync(fixture.retainedPath);
      if (failure === "bytes") fs.writeFileSync(fixture.retainedPath, "tampered content!");
      if (failure === "size") {
        artifact.source!.bytes++;
        artifact.retained!.bytes++;
      }
      if (failure === "source") artifact.source!.sha256 = hash("forged source");
      if (failure === "stale") artifact.status = "stale";
      if (failure === "absent-retained") delete artifact.retained;
      fixture.rewrite();
      const projection = loadGateEvidence(fixture.input());
      expect(projection.observations.passed).toEqual(["one/test"]);
      expect(projection.artifactVerification).toMatchObject({
        status: "incomplete",
        authority: "unverified",
      });
      expect(projection.artifactVerification!.reasonCodes).toContain(code);
      expect(projection.artifactVerification!.references.at(-1)!.outcome).not.toBe("complete");
    }
  );

  it.each(["run", "cwd", "artifacts", "execution-cwd", "shell"] as const)(
    "checks the full descriptive %s binding",
    (field) => {
      const fixture = evidenceFixture();
      if (field === "run") fixture.receipt.declaredGate.run = "different command";
      if (field === "cwd") fixture.receipt.declaredGate.cwd = ".";
      if (field === "artifacts") fixture.receipt.declaredGate.artifacts = ["different.json"];
      if (field === "execution-cwd") fixture.receipt.execution.cwd = fixture.evidenceRoot;
      if (field === "shell") fixture.receipt.execution.shell.argv = ["-c", "different command"];
      fixture.rewrite();
      const projection = loadGateEvidence(fixture.input());
      expect(projection.artifactVerification!.status).toBe("incomplete");
      expect(projection.artifactVerification!.reasonCodes).toContain(
        field === "shell"
          ? "SHELL_MISMATCH"
          : field === "execution-cwd"
            ? "CWD_MISMATCH"
            : "GATE_MISMATCH"
      );
    }
  );

  it("rejects duplicate retained path references rather than crediting the same file twice", () => {
    const fixture = evidenceFixture();
    const gate = fixture.plan.items[0]!.gates[0]!;
    gate.artifacts.push("latest-second.json");
    fixture.receipt.declaredGate.artifacts = [...gate.artifacts];
    fixture.receipt.binding.declaredGateDigest = computeCanonicalHash(gate);
    const duplicate = structuredClone(fixture.receipt.artifacts[0]!);
    duplicate.declaredPath = gate.artifacts[1]!;
    duplicate.resolvedPath = path.join(fixture.root, duplicate.declaredPath);
    duplicate.source!.path = duplicate.resolvedPath;
    duplicate.source!.realPath = duplicate.resolvedPath;
    fixture.receipt.artifacts.push(duplicate);
    fixture.rewrite();
    const report = loadGateEvidence(fixture.input()).artifactVerification!;
    expect(report.reasonCodes).toContain("REFERENCE_DUPLICATE");
    expect(
      report.references.filter((reference) => reference.kind === "retained-artifact")
    ).toHaveLength(2);
    expect(report.references.at(-1)!.outcome).toBe("mismatched");
  });

  it("does not automatically relocate a retained path outside its receipt directory", () => {
    const fixture = evidenceFixture();
    const relocated = path.join(fixture.evidenceRoot, "elsewhere.json");
    fs.copyFileSync(fixture.retainedPath, relocated);
    const artifact = fixture.receipt.artifacts[0]!;
    artifact.retainedPath = relocated;
    artifact.retained!.path = relocated;
    artifact.retained!.realPath = relocated;
    fixture.rewrite();
    const report = loadGateEvidence(fixture.input()).artifactVerification!;
    expect(report.reasonCodes).toContain("REFERENCE_INVALID");
    expect(report.references.at(-1)!.outcome).toBe("mismatched");
  });

  it("makes candidate drift or unavailable final capture incomplete", () => {
    const fixture = evidenceFixture();
    capture
      .mockReturnValueOnce(fixture.candidate)
      .mockReturnValueOnce({ ...fixture.candidate, worktreeDigest: hash("new candidate") });
    expect(loadGateEvidence(fixture.input()).artifactVerification!.reasonCodes).toContain(
      "CANDIDATE_CHANGED"
    );
    capture.mockReturnValueOnce(fixture.candidate).mockImplementationOnce(() => {
      throw new Error("private detail");
    });
    const report = loadGateEvidence(fixture.input()).artifactVerification!;
    expect(report.reasonCodes).toContain("CANDIDATE_UNAVAILABLE");
    expect(JSON.stringify(report)).not.toContain("private detail");
  });

  it("preserves existing outer digest and schema errors in opt-in mode", () => {
    const fixture = evidenceFixture();
    expect(() =>
      loadGateEvidence({ ...fixture.input(), evidenceSha256: hash("wrong") })
    ).toThrowError(expect.objectContaining({ code: "GATE_EVIDENCE_DIGEST_MISMATCH" }));
    fs.writeFileSync(fixture.receiptPath, "{}");
    fixture.manifest.entries[0]!.receipt.sha256 = fileHash(fixture.receiptPath);
    fs.writeFileSync(fixture.manifestPath, JSON.stringify(fixture.manifest));
    expect(() => loadGateEvidence(fixture.input())).toThrowError(
      expect.objectContaining({ code: "GATE_EVIDENCE_UNREADABLE" })
    );
  });

  it("returns a bounded incomplete report when an otherwise valid closure exceeds the reference limit", () => {
    const fixture = evidenceFixture();
    const gate = fixture.plan.items[0]!.gates[0]!;
    fixture.plan.items[0]!.gates = [];
    fixture.manifest.entries = [];
    for (let index = 0; index < 257; index++) {
      const nextGate = { ...gate, name: `test-${index}`, artifacts: [] };
      fixture.plan.items[0]!.gates.push(nextGate);
      const receipt = structuredClone(fixture.receipt);
      receipt.declaredGate = { ...receipt.declaredGate, name: nextGate.name, artifacts: [] };
      receipt.binding.declaredGateDigest = computeCanonicalHash(nextGate);
      receipt.artifacts = [];
      const file = path.join(fixture.evidenceRoot, `receipt-${index}.json`);
      fs.writeFileSync(file, JSON.stringify(receipt));
      fixture.manifest.entries.push({
        ...fixture.entry(),
        gate: nextGate.name,
        declaredGateDigest: receipt.binding.declaredGateDigest,
        receipt: { path: path.basename(file), sha256: fileHash(file) },
      });
    }
    fixture.manifest.plan.digest = computeCanonicalHash(fixture.plan);
    fs.writeFileSync(fixture.manifestPath, JSON.stringify(fixture.manifest));
    const projection = loadGateEvidence(fixture.input());
    expect(projection.artifactVerification!.reasonCodes).toContain("REFERENCE_LIMIT");
    expect(projection.artifactVerification!.references).toHaveLength(256);
    expect(projection.applied).toBe(255);
    expect(projection.observations.passed).toHaveLength(255);
    expect(Buffer.byteLength(JSON.stringify(projection.artifactVerification))).toBeLessThanOrEqual(
      RETAINED_GATE_EVIDENCE_LIMITS.maxReportBytes
    );
  }, 15_000);
});

describe("held bounded evidence observation", () => {
  it.each([
    "../outside",
    "sub/../held.json",
    "./held.json",
    "held.json:stream",
    "NUL.json",
    "trailing. ",
    "sub//held.json",
  ])("refuses the raw namespace spelling %s before opening it", (reference) => {
    const fixture = evidenceFixture();
    const session = new RetainedGateEvidenceSession(fixture.manifestPath);
    try {
      expect(() =>
        session.readMetadata("operation-descriptor", reference, hash("content"))
      ).toThrow();
      const report = session.finish();
      expect(report.reasonCodes).toContain("REFERENCE_INVALID");
      expect(report.references[0]).not.toHaveProperty("path");
    } finally {
      session.close();
    }
  });

  it("rejects absolute dot traversal before normalization and does not echo escaped absolute paths", () => {
    const fixture = evidenceFixture();
    const session = new RetainedGateEvidenceSession(fixture.manifestPath);
    try {
      expect(() =>
        session.readMetadata(
          "operation-descriptor",
          `${fixture.evidenceRoot}${path.sep}sub${path.sep}..${path.sep}gate-evidence-manifest.json`,
          fileHash(fixture.manifestPath)
        )
      ).toThrow();
      expect(() =>
        session.readMetadata(
          "operation-terminal",
          path.join(fixture.root, "outside.json"),
          hash("content")
        )
      ).toThrow();
      const report = session.finish();
      expect(report.reasonCodes).toContain("REFERENCE_INVALID");
      expect(report.references.every((reference) => reference.path === undefined)).toBe(true);
      expect(JSON.stringify(report)).not.toContain(fixture.root);
    } finally {
      session.close();
    }
  });

  it("rejects hard-linked metadata and observed directory symlinks/junctions", () => {
    const fixture = evidenceFixture();
    const link = path.join(fixture.evidenceRoot, "hard.json");
    fs.linkSync(fixture.manifestPath, link);
    const junction = path.join(fixture.evidenceRoot, "linked");
    fs.symlinkSync(
      path.dirname(fixture.receiptPath),
      junction,
      process.platform === "win32" ? "junction" : "dir"
    );
    const session = new RetainedGateEvidenceSession(fixture.manifestPath);
    try {
      expect(() =>
        session.readMetadata("manifest", fixture.manifestPath, fileHash(fixture.manifestPath))
      ).toThrow();
      expect(() =>
        session.readMetadata(
          "execution-receipt",
          "linked/receipt.json",
          fileHash(fixture.receiptPath)
        )
      ).toThrow();
      expect(session.finish().reasonCodes).toContain("FILESYSTEM_UNSUPPORTED");
    } finally {
      session.close();
    }
  });

  it.each(["modify", "replace", "remove"] as const)(
    "detects %s after the initial acquisition",
    (action) => {
      const fixture = evidenceFixture();
      const file = path.join(fixture.evidenceRoot, "held.json");
      fs.writeFileSync(file, "original");
      const session = new RetainedGateEvidenceSession(fixture.manifestPath);
      try {
        session.readMetadata("operation-descriptor", file, fileHash(file));
        if (action === "modify") fs.writeFileSync(file, "modified");
        if (action === "replace") {
          fs.renameSync(file, `${file}.old`);
          fs.writeFileSync(file, "original");
        }
        if (action === "remove") fs.rmSync(file);
        const report = session.finish();
        expect(report.status).toBe("incomplete");
        expect(report.references[0]!.outcome).not.toBe("complete");
        expect(report.reasonCodes).toContain("FILE_CHANGED");
      } finally {
        session.close();
      }
    }
  );

  it("detects a changed retained ancestor identity under fault injection", () => {
    const fixture = evidenceFixture();
    const session = new RetainedGateEvidenceSession(fixture.manifestPath);
    try {
      session.readMetadata("execution-receipt", fixture.receiptPath, fileHash(fixture.receiptPath));
      const directory = path.dirname(fixture.receiptPath);
      vi.mocked(fs.lstatSync).mockImplementation(((...args: unknown[]) => {
        const stats = Reflect.apply(nativeFs.lstatSync, fs, args);
        return String(args[0]) === directory
          ? Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
              ino: stats.ino + 1n,
            })
          : stats;
      }) as typeof fs.lstatSync);
      expect(session.finish().reasonCodes).toContain("FILE_CHANGED");
    } finally {
      session.close();
    }
  });

  it("rejects metadata and retained artifacts above their limits before opening", () => {
    const fixture = evidenceFixture();
    const metadata = path.join(fixture.evidenceRoot, "oversized.json");
    const fd = fs.openSync(metadata, "w");
    fs.ftruncateSync(fd, RETAINED_GATE_EVIDENCE_LIMITS.maxMetadataBytes + 1);
    fs.closeSync(fd);
    const artifactFd = fs.openSync(fixture.retainedPath, "w");
    fs.ftruncateSync(artifactFd, RETAINED_GATE_EVIDENCE_LIMITS.maxArtifactBytes + 1);
    fs.closeSync(artifactFd);
    const artifact = fixture.receipt.artifacts[0]!;
    artifact.source!.bytes = artifact.retained!.bytes =
      RETAINED_GATE_EVIDENCE_LIMITS.maxArtifactBytes + 1;
    const opened = vi.mocked(fs.openSync);
    opened.mockClear();
    const session = new RetainedGateEvidenceSession(fixture.manifestPath);
    try {
      expect(() => session.readMetadata("operation-descriptor", metadata, hash("wrong"))).toThrow();
      session.observeReceipt(
        fixture.receipt,
        fixture.plan.items[0]!.gates[0]!,
        fixture.receiptPath,
        fixture.root
      );
      expect(session.finish().reasonCodes).toEqual(["ARTIFACT_LIMIT", "METADATA_LIMIT"]);
      expect(opened).not.toHaveBeenCalled();
    } finally {
      session.close();
    }
  });

  it("counts the final rehash toward the aggregate byte budget", () => {
    const fixture = evidenceFixture();
    const gate = fixture.plan.items[0]!.gates[0]!;
    gate.artifacts = [];
    fixture.receipt.artifacts = [];
    const bytes = Buffer.alloc(17 * 1024 * 1024);
    for (let index = 0; index < 4; index++) {
      const name = `large-${index}.bin`;
      gate.artifacts.push(name);
      const retainedPath = path.join(path.dirname(fixture.receiptPath), name);
      fs.writeFileSync(retainedPath, bytes);
      const sourcePath = path.join(fixture.root, name);
      fixture.receipt.artifacts.push({
        declaredPath: name,
        resolvedPath: sourcePath,
        status: "collected",
        before: null,
        source: identity(sourcePath, bytes),
        retainedPath,
        retained: identity(retainedPath, bytes),
      });
    }
    fixture.receipt.declaredGate.artifacts = [...gate.artifacts];
    const session = new RetainedGateEvidenceSession(fixture.manifestPath);
    try {
      session.observeReceipt(fixture.receipt, gate, fixture.receiptPath, fixture.root);
      const report = session.finish();
      expect(report.reasonCodes).toContain("TOTAL_BYTE_LIMIT");
      expect(report.status).toBe("incomplete");
      expect(report.references.at(-1)!.outcome).toBe("limit_exceeded");
    } finally {
      session.close();
    }
  });

  it("bounds oversized diagnostics without echoing historical absolute references", () => {
    const fixture = evidenceFixture();
    const gate = fixture.plan.items[0]!.gates[0]!;
    gate.artifacts = [];
    fixture.receipt.artifacts = [];
    const longParent = Array.from({ length: 6 }, () => "x".repeat(190)).join(path.sep);
    for (let index = 0; index < 256; index++) {
      const name = `missing-${index}.json`;
      gate.artifacts.push(name);
      fixture.receipt.artifacts.push({
        declaredPath: name,
        resolvedPath: path.join(fixture.root, name),
        status: "missing",
        before: null,
        source: null,
        retainedPath: path.join(fixture.evidenceRoot, longParent, name),
      });
    }
    fixture.receipt.declaredGate.artifacts = [...gate.artifacts];
    const session = new RetainedGateEvidenceSession(fixture.manifestPath);
    try {
      session.observeReceipt(fixture.receipt, gate, fixture.receiptPath, fixture.root);
      const report = session.finish();
      expect(report.reasonCodes).toContain("REPORT_LIMIT");
      expect(report.references).toEqual([]);
      expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(
        RETAINED_GATE_EVIDENCE_LIMITS.maxReportBytes
      );
      expect(JSON.stringify(report)).not.toContain(fixture.root);
    } finally {
      session.close();
    }
  });

  it("reports an unreadable retained file with a stable code and no native exception detail", () => {
    const fixture = evidenceFixture();
    vi.mocked(fs.openSync).mockImplementation((...args) => {
      if (String(args[0]) === fixture.retainedPath)
        throw Object.assign(new Error("private filesystem detail"), { code: "EACCES" });
      return nativeFs.openSync(...args);
    });
    const report = loadGateEvidence(fixture.input()).artifactVerification!;
    expect(report.reasonCodes).toContain("FILE_UNREADABLE");
    expect(report.references.at(-1)!.outcome).toBe("unreadable");
    expect(JSON.stringify(report)).not.toContain("private filesystem detail");
  });

  it("closes all held descriptors on an outer error and after a successful final check", () => {
    const fixture = evidenceFixture();
    const close = vi.mocked(fs.closeSync);
    close.mockClear();
    fixture.receipt.binding.item = "different";
    fixture.rewrite();
    expect(() => loadGateEvidence(fixture.input())).toThrowError(
      expect.objectContaining({ code: "GATE_EVIDENCE_ENTRY_MISMATCH" })
    );
    expect(close).toHaveBeenCalledTimes(2);
    close.mockClear();
    fixture.receipt.binding.item = "one";
    fixture.rewrite();
    expect(loadGateEvidence(fixture.input()).artifactVerification!.status).toBe("complete");
    expect(close).toHaveBeenCalledTimes(3);
  });

  it("makes an observed close failure incomplete without retrying or exposing its message", () => {
    const fixture = evidenceFixture();
    const close = vi
      .mocked(fs.closeSync)
      .mockClear()
      .mockImplementation((fd) => {
        nativeFs.closeSync(fd);
        throw new Error("private native close detail");
      });
    const report = loadGateEvidence(fixture.input()).artifactVerification!;
    expect(report.reasonCodes).toContain("CLEANUP_UNCERTAIN");
    expect(report.status).toBe("incomplete");
    expect(close).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(report)).not.toContain("private native close detail");
  });
});

function evidenceFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "lexrunner-retained-")));
  directories.push(root);
  const evidenceRoot = path.join(root, "owned-evidence");
  const receiptPath = path.join(evidenceRoot, "one", "test", "receipt.json");
  const retainedPath = path.join(path.dirname(receiptPath), "report.json");
  const manifestPath = path.join(evidenceRoot, "gate-evidence-manifest.json");
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  const candidate: GateCandidateIdentity = {
    repositoryRoot: root,
    head: "a".repeat(40),
    worktreeDigest: hash("candidate"),
  };
  capture.mockReturnValue(candidate);
  const plan: Plan = loadPlan(
    JSON.stringify({
      schemaVersion: "1.0.0",
      target: "main",
      policy: {
        requiredGates: ["test"],
        optionalGates: [],
        maxWorkers: 1,
        retries: {},
        overrides: {},
        blockOn: [],
        mergeRule: { type: "strict-required" },
      },
      items: [
        {
          name: "one",
          deps: [],
          gates: [
            { name: "test", run: "never execute this command", artifacts: ["latest-report.json"] },
          ],
        },
      ],
    })
  );
  const gate: Gate = plan.items[0]!.gates[0]!;
  const content = "retained content!";
  fs.writeFileSync(retainedPath, content);
  const sourcePath = path.join(root, gate.artifacts[0]!);
  const shell = resolveLocalGateShell(gate.run, process.platform);
  const output = { bytes: 0, sha256: hash(""), truncated: false, content: "secret output" };
  const receipt: LocalGateExecutionReceipt = {
    schemaVersion: "lexrunner-gate-execution-receipt/v2",
    attempt: 1,
    binding: {
      item: "one",
      declaredGateDigest: computeCanonicalHash(gate),
      candidateDigest: candidate.worktreeDigest,
      timeoutMs: 1000,
    },
    declaredGate: {
      name: gate.name,
      run: gate.run,
      cwd: gate.cwd ?? null,
      runtime: gate.runtime,
      artifacts: [...gate.artifacts],
    },
    execution: {
      cwd: root,
      startedAt: "2026-10-04T00:00:00.000Z",
      finishedAt: "2026-10-04T00:00:00.001Z",
      durationMs: 1,
      shell: {
        command: shell.command,
        executable: null,
        argv: shell.arguments,
        identityAfter: null,
        unchanged: true,
        spawned: true,
      },
    },
    outcome: {
      status: "pass",
      exitCode: 0,
      failureKind: null,
      timeoutCleanup: null,
      evidenceComplete: true,
    },
    output: { stdout: output, stderr: output },
    artifacts: [
      {
        declaredPath: gate.artifacts[0]!,
        resolvedPath: sourcePath,
        status: "collected",
        before: null,
        source: identity(sourcePath, content),
        retainedPath,
        retained: identity(retainedPath, content),
      },
    ],
  };
  const entry = (): GateEvidenceManifest["entries"][number] => ({
    item: "one",
    gate: gate.name,
    declaredGateDigest: computeCanonicalHash(gate),
    result: {
      status: "pass",
      exitCode: 0,
      duration: 1,
      timeoutMs: 1000,
      attempts: 1,
      lastAttempt: receipt.execution.startedAt,
    },
    receipt: {
      path: path.relative(evidenceRoot, receiptPath).split(path.sep).join("/"),
      sha256: fileHash(receiptPath),
    },
  });
  const manifest: GateEvidenceManifest = {
    schemaVersion: "lexrunner-gate-evidence-manifest/v1",
    createdAt: "2026-10-04T00:00:00.002Z",
    plan: {
      digest: computeCanonicalHash(plan),
      schemaVersion: plan.schemaVersion,
      target: plan.target,
      itemCount: 1,
    },
    candidate,
    selection: { onlyItem: null, onlyGate: null },
    entries: [],
  };
  const rewrite = () => {
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    manifest.plan.digest = computeCanonicalHash(plan);
    manifest.entries = [entry()];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  };
  rewrite();
  return {
    root,
    evidenceRoot,
    receiptPath,
    retainedPath,
    manifestPath,
    candidate,
    plan,
    receipt,
    manifest,
    rewrite,
    entry,
    input: (verifyArtifacts = true) => ({
      plan,
      repoRoot: root,
      evidenceFile: manifestPath,
      evidenceSha256: fileHash(manifestPath),
      verifyArtifacts,
    }),
  };
}

function hash(bytes: string | Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function fileHash(file: string): string {
  return hash(fs.readFileSync(file));
}
function identity(file: string, bytes: string | Buffer) {
  return {
    path: file,
    realPath: file,
    bytes: Buffer.byteLength(bytes),
    mtimeMs: 1,
    sha256: hash(bytes),
  };
}
