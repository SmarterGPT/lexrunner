import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GateOperationObserveArgs,
  GateOperationService,
  GateOperationStartArgs,
  GateOperationStatusArgs,
  runGateOperationWorker,
  type GateOperationHandle,
  type GateOperationStartInput,
} from "../../src/application/gate-operation-service.js";
import { loadPlan } from "../../src/schema.js";
import { canonicalJSONStringify } from "../../src/util/canonicalJson.js";
import { candidateFixture, type CandidateFixture } from "../helpers/gate-candidate-fixture.js";

// Native workers run in separate processes. These hooks only exercise deterministic
// reader/publication transitions in the source service against exact owned paths.
const publicationHooks = vi.hoisted(() => ({
  openFiles: new Map<number, string>(),
  beforeRead: undefined as undefined | ((file: string, descriptor: number) => void),
  afterClose: undefined as undefined | ((file: string) => void),
  afterLink: undefined as undefined | ((temporary: string, published: string) => void),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const descriptor = actual.openSync(...args);
      publicationHooks.openFiles.set(descriptor, String(args[0]));
      return descriptor;
    },
    closeSync: (descriptor: number) => {
      const file = publicationHooks.openFiles.get(descriptor);
      publicationHooks.openFiles.delete(descriptor);
      actual.closeSync(descriptor);
      if (file !== undefined) publicationHooks.afterClose?.(file);
    },
    readSync: (...args: Parameters<typeof actual.readSync>) => {
      const file = publicationHooks.openFiles.get(args[0]);
      if (file !== undefined) publicationHooks.beforeRead?.(file, args[0]);
      return actual.readSync(...args);
    },
    linkSync: (...args: Parameters<typeof actual.linkSync>) => {
      actual.linkSync(...args);
      publicationHooks.afterLink?.(String(args[0]), String(args[1]));
    },
  };
});

type NativeFixture = CandidateFixture & {
  planFile: string;
  markers: string;
  releaseFile: string;
  input: GateOperationStartInput;
};

const fixtures: NativeFixture[] = [];
const operations: GateOperationHandle[] = [];
const service = new GateOperationService();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until<T>(read: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await delay(40);
  }
  throw new Error(`Owned gate operation did not settle within ${timeoutMs}ms`);
}

async function terminal(operation: GateOperationHandle): Promise<Record<string, unknown>> {
  return until(() => {
    const observation = new GateOperationService().status(operation);
    return ["completed", "cancelled", "failed"].includes(String(observation.state))
      ? observation
      : undefined;
  });
}

afterEach(async () => {
  publicationHooks.beforeRead = undefined;
  publicationHooks.afterClose = undefined;
  publicationHooks.afterLink = undefined;
  // Every barrier and artifact is private to these fixtures. Never signal an inferred PID.
  for (const fixture of fixtures) writeFileSync(fixture.releaseFile, "release\n");
  for (const operation of operations.splice(0)) {
    try {
      new GateOperationService().cancel(operation);
    } catch {
      // Tamper tests restore their bytes in finally; a real terminal also needs no cancellation.
    }
    await until(() =>
      existsSync(join(dirname(operation.operationFile), "terminal.json")) ? true : undefined
    );
  }
  for (const fixture of fixtures.splice(0)) fixture.dispose();
}, 30_000);

function shellQuote(value: string): string {
  return process.platform === "win32"
    ? "'" + value.replaceAll("'", "''") + "'"
    : "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

function nativeFixture(
  options: { held?: boolean; exitCode?: number; later?: boolean; artifact?: boolean } = {}
): NativeFixture {
  const fixture = candidateFixture();
  const markers = join(fixture.root, "markers.log");
  const releaseFile = join(fixture.root, "release.marker");
  const commandScript = join(fixture.root, "owned-gate.cjs");
  writeFileSync(
    commandScript,
    `const fs = require('node:fs');
const [marker, release, name, held, code] = process.argv.slice(2);
fs.appendFileSync(marker, name + ':started\\n');
const deadline = Date.now() + 12000;
const timer = setInterval(() => {
  if (held === 'yes' && !fs.existsSync(release)) {
    if (Date.now() < deadline) return;
    clearInterval(timer); process.exit(124);
  }
  clearInterval(timer);
  fs.appendFileSync(marker, name + ':finished\\n');
  if (${options.artifact === true}) fs.writeFileSync(marker + '.json', JSON.stringify({ name, completed: true }));
  process.exit(Number(code));
}, 20);
`
  );
  const command = (name: string, held: boolean, code: number) =>
    (process.platform === "win32" ? "& " : "") +
    [process.execPath, commandScript, markers, releaseFile, name, held ? "yes" : "no", String(code)]
      .map(shellQuote)
      .join(" ");
  const first = {
    name: "first",
    deps: [],
    gates: [
      {
        name: "probe",
        run: command("first", options.held ?? false, options.exitCode ?? 0),
        ...(options.artifact ? { artifacts: [markers + ".json"] } : {}),
      },
    ],
  };
  const second = {
    name: "later",
    deps: ["first"],
    gates: [{ name: "probe", run: command("later", false, 0) }],
  };
  const planFile = join(fixture.root, "operation-plan.json");
  writeFileSync(
    planFile,
    JSON.stringify(
      loadPlan(
        JSON.stringify({
          schemaVersion: "1.0.0",
          target: "main",
          items: options.later ? [first, second] : [first],
          policy: { requiredGates: ["probe"], maxWorkers: 1, retries: {} },
        })
      )
    )
  );
  const input: GateOperationStartInput = {
    repoRoot: fixture.a,
    planFile,
    outDir: fixture.artifacts,
    idempotencyKey: "owned-test-operation",
    timeoutMs: 15_000,
  };
  const result = { ...fixture, planFile, markers, releaseFile, input };
  fixtures.push(result);
  return result;
}

function markerLines(fixture: NativeFixture): string[] {
  return existsSync(fixture.markers)
    ? readFileSync(fixture.markers, "utf8").trim().split("\n")
    : [];
}

async function started(fixture: NativeFixture): Promise<GateOperationHandle> {
  const admitted = await service.start(fixture.input);
  expect(admitted).toMatchObject({
    contract: "gate-operation-handle/v1",
    reused: false,
    cancellationMode: "after-active-gates",
  });
  operations.push(admitted.operation);
  return admitted.operation;
}

function prefixedHash(bytes: string | Buffer): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

function freshWorkerDescriptor(
  original: GateOperationHandle,
  idempotencyKey: string
): GateOperationHandle {
  const descriptor = JSON.parse(readFileSync(original.operationFile, "utf8"));
  descriptor.idempotencyKey = idempotencyKey;
  descriptor.operationId = createHash("sha256").update(idempotencyKey).digest("hex");
  descriptor.directory = join(
    dirname(dirname(original.operationFile)),
    "gate-operation-" + descriptor.operationId
  );
  descriptor.createdAt = new Date().toISOString();
  descriptor.requestDigest = prefixedHash(
    canonicalJSONStringify({
      idempotencyKey: descriptor.idempotencyKey,
      directory: descriptor.directory,
      candidate: descriptor.candidate,
      plan: loadPlan(canonicalJSONStringify(descriptor.plan)),
      onlyItem: descriptor.onlyItem,
      onlyGate: descriptor.onlyGate,
      timeoutMs: descriptor.timeoutMs,
      worker: descriptor.worker,
      node: descriptor.node,
    })
  );
  mkdirSync(descriptor.directory);
  const operationFile = join(descriptor.directory, "operation.json");
  const bytes = canonicalJSONStringify(descriptor);
  writeFileSync(operationFile, bytes);
  return {
    repoRoot: descriptor.candidate.repositoryRoot,
    operationFile,
    operationSha256: prefixedHash(bytes),
  };
}

describe("durable gate operation argument contracts", () => {
  it("admits read-back only on status without changing the operation handle contract", () => {
    const handle = {
      repoRoot: "repo",
      operationFile: "operation.json",
      operationSha256: "sha256:" + "a".repeat(64),
    };
    expect(GateOperationStatusArgs.parse({ ...handle, verifyArtifacts: true })).toEqual({
      ...handle,
      verifyArtifacts: true,
    });
    expect(() => GateOperationObserveArgs.parse({ ...handle, verifyArtifacts: true })).toThrow();
    for (const verifyArtifacts of ["true", 1, null, {}]) {
      expect(() => GateOperationStatusArgs.parse({ ...handle, verifyArtifacts })).toThrow();
    }
  });
  it("requires explicit roots, artifacts, plan and idempotency while refusing unbounded selectors", () => {
    expect(() => GateOperationStartArgs.parse({})).toThrow();
    const base = {
      repoRoot: "repo",
      planFile: "plan.json",
      outDir: "artifacts",
      idempotencyKey: "key",
    };
    for (const invalid of [
      { repoRoot: "" },
      { repoRoot: null },
      { outDir: "x".repeat(4097) },
      { idempotencyKey: "x".repeat(129) },
      { onlyItem: "" },
      { onlyGate: "" },
      { timeoutMs: 0 },
      { timeoutMs: 86_400_001 },
      { hiddenInput: true },
    ])
      expect(() => GateOperationStartArgs.parse({ ...base, ...invalid })).toThrow();
    expect(() =>
      GateOperationObserveArgs.parse({
        repoRoot: "repo",
        operationFile: "operation.json",
        operationSha256: "0".repeat(64),
      })
    ).toThrow();
  });
});

describe("native artifact-backed gate operations", () => {
  it("reads the complete operation closure and makes missing retained bytes unknown only when requested", async () => {
    const fixture = nativeFixture({ artifact: true });
    const operation = await started(fixture);
    await terminal(operation);
    const checked = service.status({ ...operation, verifyArtifacts: true });
    expect(checked).toMatchObject({
      state: "completed",
      outcome: "pass",
      operation,
      authority: "unverified",
      artifactVerification: { status: "complete", authority: "unverified" },
    });
    const report = checked.artifactVerification as {
      references: Array<{ kind: string; path: string; outcome: string }>;
    };
    expect(report.references.map(({ kind }) => kind).sort()).toEqual([
      "execution-receipt",
      "manifest",
      "operation-descriptor",
      "operation-terminal",
      "retained-artifact",
    ]);
    expect(report.references.every(({ path }) => !path.includes(fixture.root))).toBe(true);
    const directory = dirname(operation.operationFile);
    const manifest = JSON.parse(
      readFileSync(join(directory, "gate-evidence-manifest.json"), "utf8")
    );
    const receipt = JSON.parse(
      readFileSync(join(directory, manifest.entries[0].receipt.path), "utf8")
    );
    const retained = receipt.artifacts[0].retainedPath;
    unlinkSync(retained);
    expect(service.status(operation)).toMatchObject({ state: "completed", outcome: "pass" });
    expect(service.status({ ...operation, verifyArtifacts: false })).not.toHaveProperty(
      "artifactVerification"
    );
    const incomplete = service.status({ ...operation, verifyArtifacts: true });
    expect(incomplete).toMatchObject({
      state: "unknown",
      lastReportedState: "completed",
      errorCode: "GATE_OPERATION_ARTIFACTS_INCOMPLETE",
      recordedOutcome: "pass",
      artifactVerification: { status: "incomplete", authority: "unverified" },
    });
    expect(incomplete).not.toHaveProperty("outcome");
    expect((incomplete.artifactVerification as typeof report).references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "retained-artifact", outcome: "missing" }),
      ])
    );
    expect(markerLines(fixture)).toEqual(["first:started", "first:finished"]);
  }, 30_000);
  it.skipIf(process.platform !== "win32")(
    "records native Win32 heartbeat replacement denial during an open read and successful publication after release",
    async () => {
      const fixture = nativeFixture();
      const operation = await started(fixture);
      await terminal(operation);
      const directory = dirname(operation.operationFile);
      const terminalFile = join(directory, "terminal.json");
      const terminalBytes = readFileSync(terminalFile);
      const stateFile = join(directory, "worker-state.json");
      const stateBytes = readFileSync(stateFile);
      const pending = stateFile + ".owned-denied-publication.pending";
      try {
        unlinkSync(terminalFile);
        const state = {
          ...JSON.parse(stateBytes.toString("utf8")),
          updatedAt: new Date().toISOString(),
          state: "running",
        };
        writeFileSync(stateFile, JSON.stringify(state));
        writeFileSync(pending, JSON.stringify({ ...state, state: "cancel_requested" }));
        let denied: NodeJS.ErrnoException | undefined;
        publicationHooks.beforeRead = (file) => {
          if (file !== stateFile) return;
          publicationHooks.beforeRead = undefined;
          try {
            renameSync(pending, stateFile);
          } catch (error) {
            denied = error as NodeJS.ErrnoException;
          }
        };
        expect(service.status(operation)).toMatchObject({
          state: "running",
          authority: "unverified",
        });
        expect(denied?.syscall).toBe("rename");
        expect(["EPERM", "EACCES", "EBUSY"]).toContain(denied?.code);
        expect(existsSync(pending)).toBe(true);
        renameSync(pending, stateFile);
        expect(service.status(operation)).toMatchObject({ state: "cancel_requested" });
      } finally {
        publicationHooks.beforeRead = undefined;
        if (existsSync(pending)) unlinkSync(pending);
        writeFileSync(stateFile, stateBytes);
        writeFileSync(terminalFile, terminalBytes);
      }
    },
    30_000
  );

  it("defers a real worker heartbeat collision during an opened read without cancelling its active gate", async () => {
    const fixture = nativeFixture({ held: true });
    const original = await started(fixture);
    await until(() => (markerLines(fixture).includes("first:started") ? true : undefined));
    writeFileSync(fixture.releaseFile, "release\n");
    await terminal(original);
    unlinkSync(fixture.releaseFile);
    const operation = freshWorkerDescriptor(original, "owned-source-heartbeat-collision");
    operations.push(operation);
    const actualSetInterval = globalThis.setInterval;
    let heartbeatTick: (() => void) | undefined;
    const intervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation((callback, ms, ...args) => {
        if (ms === 2000) heartbeatTick = () => callback(...args);
        return actualSetInterval(callback, ms, ...args);
      });
    const worker = runGateOperationWorker(operation.operationFile, operation.operationSha256);
    try {
      await until(() =>
        markerLines(fixture).filter((line) => line === "first:started").length === 2
          ? true
          : undefined
      );
      expect(heartbeatTick).toBeDefined();
      const stateFile = join(dirname(operation.operationFile), "worker-state.json");
      let injected = false;
      publicationHooks.beforeRead = (file) => {
        if (file !== stateFile) return;
        publicationHooks.beforeRead = undefined;
        heartbeatTick!();
        injected = true;
      };
      expect(service.status(operation)).toMatchObject({
        state: "running",
        authority: "unverified",
      });
      expect(injected).toBe(true);
      // The reader fd is now closed. The next publication uses the same producer callback.
      heartbeatTick!();
      expect(service.status(operation)).toMatchObject({ state: "running" });
      writeFileSync(fixture.releaseFile, "release\n");
      await worker;
      const observed = service.status(operation);
      expect(observed).toMatchObject({
        state: "completed",
        outcome: "pass",
        authority: "unverified",
      });
      if (process.platform === "win32")
        expect(Number(observed.deferredHeartbeatPublications)).toBeGreaterThanOrEqual(1);
      else expect(observed.deferredHeartbeatPublications).toBe(0);
      expect(markerLines(fixture)).toEqual([
        "first:started",
        "first:finished",
        "first:started",
        "first:finished",
      ]);
    } finally {
      publicationHooks.beforeRead = undefined;
      writeFileSync(fixture.releaseFile, "release\n");
      await worker;
      intervalSpy.mockRestore();
    }
  }, 30_000);

  it("observes a complete newly linked cancellation while its publication hardlink disappears during the opened read", async () => {
    const fixture = nativeFixture({ held: true });
    const operation = await started(fixture);
    await until(() => (markerLines(fixture).includes("first:started") ? true : undefined));
    const cancelFile = join(dirname(operation.operationFile), "cancel.json");
    let observedPublication = false;
    let removedDuringRead = false;
    publicationHooks.afterLink = (temporary, published) => {
      if (published !== cancelFile) return;
      publicationHooks.afterLink = undefined;
      expect(existsSync(temporary)).toBe(true);
      expect(JSON.parse(readFileSync(published, "utf8"))).toMatchObject({
        operationSha256: operation.operationSha256,
        mode: "after-active-gates",
      });
      publicationHooks.beforeRead = (file) => {
        if (file !== cancelFile) return;
        publicationHooks.beforeRead = undefined;
        unlinkSync(temporary);
        removedDuringRead = true;
      };
      expect(new GateOperationService().status(operation)).toMatchObject({
        cancelRequested: true,
        authority: "unverified",
      });
      observedPublication = true;
    };
    expect(service.cancel(operation)).toMatchObject({
      cancelRequested: true,
      terminalAcknowledged: false,
    });
    expect(observedPublication).toBe(true);
    expect(removedDuringRead).toBe(true);
    writeFileSync(fixture.releaseFile, "release\n");
    expect(await terminal(operation)).toMatchObject({ state: "cancelled" });
  }, 30_000);

  it("reads complete terminal snapshots for status and late cancel while temporary publication links are removed", async () => {
    const fixture = nativeFixture();
    const operation = await started(fixture);
    await terminal(operation);
    const terminalFile = join(dirname(operation.operationFile), "terminal.json");
    const completedBytes = readFileSync(terminalFile);
    const pending = terminalFile + ".owned-publication.pending";
    try {
      for (const observe of [() => service.status(operation), () => service.cancel(operation)]) {
        // Model publication of the real completed bytes: pending file -> atomic hardlink -> unlink pending.
        unlinkSync(terminalFile);
        writeFileSync(pending, completedBytes);
        linkSync(pending, terminalFile);
        let removedDuringRead = false;
        publicationHooks.beforeRead = (file) => {
          if (file !== terminalFile) return;
          publicationHooks.beforeRead = undefined;
          unlinkSync(pending);
          removedDuringRead = true;
        };
        expect(observe()).toMatchObject({
          state: "completed",
          outcome: "pass",
          authority: "unverified",
        });
        expect(removedDuringRead).toBe(true);
        expect(readFileSync(terminalFile)).toEqual(completedBytes);
      }
    } finally {
      publicationHooks.beforeRead = undefined;
      if (existsSync(pending)) unlinkSync(pending);
      writeFileSync(terminalFile, completedBytes);
    }
  }, 30_000);

  it("reads the old complete heartbeat while atomic pathname replacement follows its opened read", async () => {
    const fixture = nativeFixture();
    const operation = await started(fixture);
    await terminal(operation);
    const directory = dirname(operation.operationFile);
    const terminalFile = join(directory, "terminal.json");
    const terminalBytes = readFileSync(terminalFile);
    const stateFile = join(directory, "worker-state.json");
    const stateBytes = readFileSync(stateFile);
    const pending = stateFile + ".owned-replacement.pending";
    try {
      unlinkSync(terminalFile);
      const oldState = {
        ...JSON.parse(stateBytes.toString("utf8")),
        updatedAt: new Date().toISOString(),
        state: "running",
      };
      const newState = { ...oldState, state: "cancel_requested" };
      writeFileSync(stateFile, JSON.stringify(oldState));
      writeFileSync(pending, JSON.stringify(newState));
      let replacedDuringRead = false;
      publicationHooks.afterClose = (file) => {
        if (file !== stateFile) return;
        publicationHooks.afterClose = undefined;
        renameSync(pending, stateFile);
        replacedDuringRead = true;
      };
      expect(service.status(operation)).toMatchObject({
        state: "running",
        lastReportedState: "running",
        authority: "unverified",
      });
      expect(replacedDuringRead).toBe(true);
      expect(service.status(operation)).toMatchObject({
        state: "cancel_requested",
        lastReportedState: "cancel_requested",
      });
    } finally {
      publicationHooks.beforeRead = undefined;
      publicationHooks.afterClose = undefined;
      if (existsSync(pending)) unlinkSync(pending);
      writeFileSync(stateFile, stateBytes);
      writeFileSync(terminalFile, terminalBytes);
    }
  }, 30_000);

  it("retains declared gate order while applying substring policy blocks without inventing receipts", async () => {
    const fixture = nativeFixture();
    const plan = JSON.parse(readFileSync(fixture.planFile, "utf8"));
    const command = plan.items[0].gates[0];
    plan.items[0].gates = [
      { ...command, name: "zeta-denied" },
      { ...command, name: "alpha-executed" },
    ];
    plan.policy.requiredGates = ["zeta-denied", "alpha-executed"];
    plan.policy.blockOn = ["eta"];
    writeFileSync(fixture.planFile, JSON.stringify(plan));
    const operation = await started(fixture);
    expect(await terminal(operation)).toMatchObject({
      state: "completed",
      outcome: "fail",
      authority: "unverified",
      result: {
        allGreen: false,
        items: [
          {
            name: "first",
            status: "blocked",
            gates: [
              { name: "zeta-denied", status: "blocked" },
              { name: "alpha-executed", status: "pass" },
            ],
          },
        ],
      },
    });
    expect(markerLines(fixture)).toEqual(["first:started", "first:finished"]);
    const manifest = JSON.parse(
      readFileSync(join(dirname(operation.operationFile), "gate-evidence-manifest.json"), "utf8")
    );
    expect(manifest.entries.map((entry: { gate: string }) => entry.gate)).toEqual([
      "alpha-executed",
    ]);
  }, 30_000);

  it("rejects unsupported selected runtimes and the special vulnerability gate before admission", async () => {
    const fixture = nativeFixture();
    const original = JSON.parse(readFileSync(fixture.planFile, "utf8"));
    for (const runtime of ["ci-service", "container", "vuln"]) {
      const plan = structuredClone(original);
      const gate = plan.items[0].gates[0];
      if (runtime === "vuln") {
        gate.name = "vuln";
        plan.policy.requiredGates = ["vuln"];
      } else gate.runtime = runtime;
      if (runtime === "container") gate.container = { image: "fixture.invalid/never:latest" };
      writeFileSync(fixture.planFile, JSON.stringify(plan));
      await expect(service.start(fixture.input)).rejects.toMatchObject({
        code: "GATE_OPERATION_RUNTIME_UNSUPPORTED",
      });
      expect(markerLines(fixture)).toEqual([]);
    }
  }, 30_000);

  it("refuses selected pre-execution input validators before an operation is admitted", async () => {
    const fixture = nativeFixture();
    const plan = JSON.parse(readFileSync(fixture.planFile, "utf8"));
    plan.items[0].gates[0].input = {};
    writeFileSync(fixture.planFile, JSON.stringify(plan));
    await expect(service.start(fixture.input)).rejects.toMatchObject({
      code: "GATE_OPERATION_INPUT_UNSUPPORTED",
    });
    expect(markerLines(fixture)).toEqual([]);
  }, 30_000);

  it("rejects oversized and nonregular operation descriptors before decoding or root acquisition", () => {
    const fixture = nativeFixture();
    const operationFile = join(fixture.root, "invalid-operation.json");
    const handle = {
      repoRoot: fixture.a,
      operationFile,
      operationSha256: `sha256:${"0".repeat(64)}`,
    };
    writeFileSync(operationFile, Buffer.alloc(4 * 1024 * 1024 + 1));
    expect(() => service.status(handle)).toThrow("bounded regular file");
    rmSync(operationFile);
    mkdirSync(operationFile);
    expect(() => service.status(handle)).toThrow("bounded regular file");
    expect(markerLines(fixture)).toEqual([]);
  });

  it("observes a selected dependent with an omitted prerequisite as blocked without inventing a command receipt", async () => {
    const fixture = nativeFixture({ later: true });
    fixture.input.onlyItem = "later";
    const operation = await started(fixture);
    expect(await terminal(operation)).toMatchObject({
      state: "completed",
      outcome: "fail",
      authority: "unverified",
      result: { allGreen: false, items: [{ name: "later", status: "blocked", gates: [] }] },
    });
    expect(markerLines(fixture)).toEqual([]);
    const manifest = JSON.parse(
      readFileSync(join(dirname(operation.operationFile), "gate-evidence-manifest.json"), "utf8")
    );
    expect(manifest.entries).toEqual([]);
  }, 30_000);

  it("observes policy-blocked gates and dependents without local execution receipts", async () => {
    const fixture = nativeFixture({ later: true });
    const plan = JSON.parse(readFileSync(fixture.planFile, "utf8"));
    plan.policy.blockOn = ["probe"];
    writeFileSync(fixture.planFile, JSON.stringify(plan));
    const operation = await started(fixture);
    expect(await terminal(operation)).toMatchObject({
      state: "completed",
      outcome: "fail",
      authority: "unverified",
      result: {
        allGreen: false,
        items: [
          { name: "first", status: "blocked", gates: [{ name: "probe", status: "blocked" }] },
          { name: "later", status: "blocked", gates: [] },
        ],
      },
    });
    expect(markerLines(fixture)).toEqual([]);
    const manifest = JSON.parse(
      readFileSync(join(dirname(operation.operationFile), "gate-evidence-manifest.json"), "utf8")
    );
    expect(manifest.entries).toEqual([]);
  }, 30_000);

  it.each([0, 7])(
    "returns an acknowledgement before a held gate and eventually reports exit %i without merge authority",
    async (exitCode) => {
      const fixture = nativeFixture({ held: true, exitCode, later: true });
      const began = Date.now();
      const operation = await started(fixture);
      expect(Date.now() - began).toBeLessThan(4_000);
      expect(existsSync(join(dirname(operation.operationFile), "terminal.json"))).toBe(false);
      await until(() => (markerLines(fixture).includes("first:started") ? true : undefined));
      expect(service.status(operation)).toMatchObject({
        state: "running",
        authority: "unverified",
        cancellationMode: "after-active-gates",
      });
      writeFileSync(fixture.releaseFile, "release\n");
      const observed = await terminal(operation);
      expect(observed).toMatchObject({
        state: "completed",
        outcome: exitCode === 0 ? "pass" : "fail",
        authority: "unverified",
        result: { allGreen: exitCode === 0 },
      });
      expect(markerLines(fixture)).toEqual(
        exitCode === 0
          ? ["first:started", "first:finished", "later:started", "later:finished"]
          : ["first:started", "first:finished"]
      );
      expect(observed).not.toHaveProperty("mergeEligibility");
    },
    30_000
  );

  it("reuses an active and completed key without duplicate commands, but refuses a changed bound input", async () => {
    const fixture = nativeFixture({ held: true });
    const operation = await started(fixture);
    await until(() => (markerLines(fixture).includes("first:started") ? true : undefined));
    const concurrentReplay = await Promise.all([
      new GateOperationService().start(fixture.input),
      new GateOperationService().start(fixture.input),
    ]);
    for (const replay of concurrentReplay)
      expect(replay).toMatchObject({ operation, reused: true });
    await expect(service.start({ ...fixture.input, timeoutMs: 14_999 })).rejects.toMatchObject({
      code: "GATE_OPERATION_IDEMPOTENCY_CONFLICT",
    });
    expect(markerLines(fixture)).toEqual(["first:started"]);
    writeFileSync(fixture.releaseFile, "release\n");
    expect(await terminal(operation)).toMatchObject({ state: "completed", outcome: "pass" });
    expect(await new GateOperationService().start(fixture.input)).toMatchObject({
      operation,
      reused: true,
    });
    expect(markerLines(fixture)).toEqual(["first:started", "first:finished"]);
  }, 30_000);

  it("recovers a lost observer with only a durable handle in a fresh service instance", async () => {
    const fixture = nativeFixture({ held: true });
    const operation = await started(fixture);
    const recovered = JSON.parse(JSON.stringify(operation)) as GateOperationHandle;
    await until(() => (markerLines(fixture).includes("first:started") ? true : undefined));
    expect(new GateOperationService().status(recovered)).toMatchObject({
      state: "running",
      authority: "unverified",
    });
    writeFileSync(fixture.releaseFile, "release\n");
    expect(await terminal(recovered)).toMatchObject({
      state: "completed",
      outcome: "pass",
      authority: "unverified",
    });
    expect(markerLines(fixture)).toEqual(["first:started", "first:finished"]);
  }, 30_000);

  it("refuses wrong repo selectors, request digest tampering and descriptor edits even when their file hash is resealed", async () => {
    const fixture = nativeFixture();
    const operation = await started(fixture);
    await terminal(operation);
    await expect(service.start({ ...fixture.input, onlyItem: "missing" })).rejects.toThrow();
    expect(() => service.status({ ...operation, repoRoot: fixture.b })).toThrow(
      "repository or request binding"
    );
    expect(() =>
      service.status({ ...operation, operationSha256: `sha256:${"0".repeat(64)}` })
    ).toThrow("descriptor digest");
    const original = readFileSync(operation.operationFile);
    try {
      const changed = JSON.parse(original.toString("utf8"));
      changed.timeoutMs = 14_999;
      const bytes = canonicalJSONStringify(changed);
      writeFileSync(operation.operationFile, bytes);
      expect(() => service.status(operation)).toThrow("descriptor digest");
      expect(() => service.status({ ...operation, operationSha256: prefixedHash(bytes) })).toThrow(
        "repository or request binding"
      );
    } finally {
      writeFileSync(operation.operationFile, original);
    }
  }, 30_000);

  it.each(["result", "manifest", "receipt"] as const)(
    "reports tampered %s as unknown instead of a passing execution",
    async (target) => {
      const fixture = nativeFixture();
      const operation = await started(fixture);
      await terminal(operation);
      const directory = dirname(operation.operationFile);
      const terminalFile = join(directory, "terminal.json");
      const completed = JSON.parse(readFileSync(terminalFile, "utf8"));
      const manifestRef = completed.result.artifactRefs.find(
        (entry: { kind: string }) => entry.kind === "gate-evidence-manifest"
      );
      const manifest = JSON.parse(readFileSync(manifestRef.path, "utf8"));
      const file =
        target === "result"
          ? terminalFile
          : target === "manifest"
            ? manifestRef.path
            : join(directory, manifest.entries[0].receipt.path);
      const original = readFileSync(file);
      try {
        if (target === "result") {
          completed.result.allGreen = false;
          writeFileSync(file, JSON.stringify(completed));
        } else writeFileSync(file, Buffer.concat([original, Buffer.from("\n")]));
        expect(service.status(operation)).toMatchObject({
          state: "unknown",
          lastReportedState: "completed",
          errorCode: "GATE_OPERATION_EVIDENCE_INVALID",
          authority: "unverified",
        });
      } finally {
        writeFileSync(file, original);
      }
      expect(service.status(operation)).toMatchObject({ state: "completed", outcome: "pass" });
    },
    30_000
  );

  it.each(["onlyItem", "onlyGate"] as const)(
    "refuses a resealed manifest with a different %s selection from the admitted request",
    async (selector) => {
      const fixture = nativeFixture();
      const operation = await started(fixture);
      await terminal(operation);
      const terminalFile = join(dirname(operation.operationFile), "terminal.json");
      const terminalBytes = readFileSync(terminalFile);
      const completed = JSON.parse(terminalBytes.toString("utf8"));
      const reference = completed.result.artifactRefs.find(
        (entry: { kind: string }) => entry.kind === "gate-evidence-manifest"
      );
      const manifestBytes = readFileSync(reference.path);
      try {
        const manifest = JSON.parse(manifestBytes.toString("utf8"));
        manifest.selection[selector] = selector === "onlyItem" ? "first" : "probe";
        const changed = canonicalJSONStringify(manifest);
        writeFileSync(reference.path, changed);
        reference.sha256 = prefixedHash(changed);
        writeFileSync(terminalFile, JSON.stringify(completed));
        expect(service.status(operation)).toMatchObject({
          state: "unknown",
          lastReportedState: "completed",
          errorCode: "GATE_OPERATION_EVIDENCE_INVALID",
          authority: "unverified",
        });
      } finally {
        writeFileSync(reference.path, manifestBytes);
        writeFileSync(terminalFile, terminalBytes);
      }
    },
    30_000
  );

  it("keeps a stale worker observation unknown and never respawns it on same-key replay", async () => {
    const fixture = nativeFixture();
    const operation = await started(fixture);
    await terminal(operation);
    const directory = dirname(operation.operationFile);
    const terminalFile = join(directory, "terminal.json");
    const terminalBytes = readFileSync(terminalFile);
    const stateFile = join(directory, "worker-state.json");
    const stateBytes = readFileSync(stateFile);
    const claim = readFileSync(join(directory, "worker-claim.json"));
    try {
      rmSync(terminalFile);
      const state = JSON.parse(stateBytes.toString("utf8"));
      state.updatedAt = new Date(Date.now() - 60_000).toISOString();
      writeFileSync(stateFile, JSON.stringify(state));
      expect(new GateOperationService().status(operation)).toMatchObject({
        state: "unknown",
        lastReportedState: "running",
        authority: "unverified",
      });
      expect(await new GateOperationService().start(fixture.input)).toMatchObject({
        operation,
        reused: true,
      });
      expect(readFileSync(join(directory, "worker-claim.json"))).toEqual(claim);
      expect(markerLines(fixture)).toEqual(["first:started", "first:finished"]);
      expect(existsSync(terminalFile)).toBe(false);
    } finally {
      writeFileSync(stateFile, stateBytes);
      writeFileSync(terminalFile, terminalBytes);
    }
  }, 30_000);

  it("does not execute an accidentally duplicated native worker admission", async () => {
    const fixture = nativeFixture({ held: true });
    const operation = await started(fixture);
    await until(() => (markerLines(fixture).includes("first:started") ? true : undefined));
    const claimFile = join(dirname(operation.operationFile), "worker-claim.json");
    const claim = readFileSync(claimFile);
    await runGateOperationWorker(operation.operationFile, operation.operationSha256);
    expect(readFileSync(claimFile)).toEqual(claim);
    expect(markerLines(fixture)).toEqual(["first:started"]);
    writeFileSync(fixture.releaseFile, "release\n");
    expect(await terminal(operation)).toMatchObject({ state: "completed", outcome: "pass" });
  }, 30_000);

  it("requests cancellation cooperatively, lets the active gate finish and prevents the dependent command", async () => {
    const fixture = nativeFixture({ held: true, later: true });
    const operation = await started(fixture);
    await until(() => (markerLines(fixture).includes("first:started") ? true : undefined));
    const cancelled = new GateOperationService().cancel(operation);
    expect(cancelled).toMatchObject({
      contract: "gate-operation-cancel-request/v1",
      cancelRequested: true,
      cancellationMode: "after-active-gates",
      terminalAcknowledged: false,
    });
    const cancelFile = join(dirname(operation.operationFile), "cancel.json");
    const firstRequest = readFileSync(cancelFile);
    expect(service.cancel(operation)).toMatchObject({
      cancelRequested: true,
      terminalAcknowledged: false,
    });
    expect(readFileSync(cancelFile)).toEqual(firstRequest);
    expect(service.status(operation)).toMatchObject({
      cancelRequested: true,
      authority: "unverified",
    });
    expect(markerLines(fixture)).toEqual(["first:started"]);
    writeFileSync(fixture.releaseFile, "release\n");
    expect(await terminal(operation)).toMatchObject({
      state: "cancelled",
      authority: "unverified",
    });
    expect(markerLines(fixture)).toEqual(["first:started", "first:finished"]);
    expect(service.cancel(operation)).toMatchObject({ state: "cancelled" });
  }, 30_000);

  it("preserves a completed result when cancellation arrives afterwards", async () => {
    const fixture = nativeFixture();
    const operation = await started(fixture);
    await terminal(operation);
    const terminalFile = join(dirname(operation.operationFile), "terminal.json");
    const original = readFileSync(terminalFile);
    expect(new GateOperationService().cancel(operation)).toMatchObject({
      state: "completed",
      outcome: "pass",
    });
    expect(existsSync(join(dirname(operation.operationFile), "cancel.json"))).toBe(false);
    expect(readFileSync(terminalFile)).toEqual(original);
  }, 30_000);

  it("leaves incomplete admission unknown and refuses a same-key relaunch", async () => {
    const fixture = nativeFixture();
    const keyHash = createHash("sha256").update(fixture.input.idempotencyKey).digest("hex");
    const directory = join(fixture.artifacts, "gate-operation-" + keyHash);
    mkdirSync(directory);
    await expect(service.start(fixture.input)).rejects.toMatchObject({
      code: "GATE_OPERATION_ADMISSION_UNCERTAIN",
    });
    expect(markerLines(fixture)).toEqual([]);
    expect(existsSync(join(directory, "worker-claim.json"))).toBe(false);
  }, 30_000);

  it("refuses an admission candidate changed before the worker executes any commands", async () => {
    const fixture = nativeFixture();
    const original = await started(fixture);
    await terminal(original);
    const descriptor = JSON.parse(readFileSync(original.operationFile, "utf8"));
    descriptor.idempotencyKey = "fresh-before-command-candidate-test";
    descriptor.operationId = createHash("sha256").update(descriptor.idempotencyKey).digest("hex");
    descriptor.directory = join(fixture.artifacts, "gate-operation-" + descriptor.operationId);
    descriptor.createdAt = new Date().toISOString();
    descriptor.requestDigest = prefixedHash(
      canonicalJSONStringify({
        idempotencyKey: descriptor.idempotencyKey,
        directory: descriptor.directory,
        candidate: descriptor.candidate,
        plan: loadPlan(canonicalJSONStringify(descriptor.plan)),
        onlyItem: descriptor.onlyItem,
        onlyGate: descriptor.onlyGate,
        timeoutMs: descriptor.timeoutMs,
        worker: descriptor.worker,
        node: descriptor.node,
      })
    );
    mkdirSync(descriptor.directory);
    const operationFile = join(descriptor.directory, "operation.json");
    const bytes = canonicalJSONStringify(descriptor);
    writeFileSync(operationFile, bytes);
    writeFileSync(join(fixture.a, "candidate.txt"), "changed before admission worker\n");
    const markerBytes = readFileSync(fixture.markers);
    await runGateOperationWorker(operationFile, prefixedHash(bytes));
    expect(
      JSON.parse(readFileSync(join(descriptor.directory, "terminal.json"), "utf8"))
    ).toMatchObject({
      state: "failed",
      errorCode: "GATE_CANDIDATE_CHANGED",
    });
    expect(readFileSync(fixture.markers)).toEqual(markerBytes);
    expect(existsSync(join(descriptor.directory, "gate-evidence-manifest.json"))).toBe(false);
    expect(statSync(join(descriptor.directory, "worker-claim.json")).isFile()).toBe(true);
  }, 30_000);
});
