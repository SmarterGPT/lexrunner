import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { resolveLocalGateShell } from "../gates.js";
import type { LocalGateExecutionReceipt } from "../gates/execution-receipt.js";
import type { Gate } from "../schema.js";

export const RETAINED_GATE_EVIDENCE_LIMITS = Object.freeze({
  maxReferences: 256,
  maxMetadataBytes: 4 * 1024 * 1024,
  maxArtifactBytes: 32 * 1024 * 1024,
  // Counts actual bytes read, including the final rehash, not just unique file sizes.
  maxTotalBytes: 128 * 1024 * 1024,
  maxReportBytes: 256 * 1024,
});

export type RetainedGateEvidenceReferenceKind =
  | "manifest"
  | "execution-receipt"
  | "retained-artifact"
  | "operation-descriptor"
  | "operation-terminal";
export type RetainedGateEvidenceOutcome =
  | "complete"
  | "changed"
  | "missing"
  | "mismatched"
  | "unsupported"
  | "unreadable"
  | "limit_exceeded";
export type RetainedGateEvidenceReasonCode =
  | "REFERENCE_INVALID"
  | "REFERENCE_DUPLICATE"
  | "FILESYSTEM_UNSUPPORTED"
  | "FILE_MISSING"
  | "FILE_UNREADABLE"
  | "FILE_CHANGED"
  | "DIGEST_MISMATCH"
  | "SIZE_MISMATCH"
  | "SOURCE_METADATA_MISMATCH"
  | "COLLECTION_INCOMPLETE"
  | "GATE_MISMATCH"
  | "CWD_MISMATCH"
  | "SHELL_MISMATCH"
  | "REFERENCE_LIMIT"
  | "METADATA_LIMIT"
  | "ARTIFACT_LIMIT"
  | "TOTAL_BYTE_LIMIT"
  | "REPORT_LIMIT"
  | "CLEANUP_UNCERTAIN"
  | "CANDIDATE_CHANGED"
  | "CANDIDATE_UNAVAILABLE";

export interface RetainedGateEvidenceAdditionalReference {
  kind: "operation-descriptor" | "operation-terminal";
  path: string;
  sha256: string;
}
export interface RetainedGateEvidenceReference {
  kind: RetainedGateEvidenceReferenceKind;
  /** Omitted for an unsafe/unconfined input; never echoes a historical absolute path. */
  path?: string;
  sha256?: string;
  bytes?: number;
  outcome: RetainedGateEvidenceOutcome;
}
export interface RetainedGateEvidenceReport {
  contract: "lexrunner-retained-gate-evidence/v1";
  status: "complete" | "incomplete";
  authority: "unverified";
  scope: "referenced-evidence-closure";
  limits: typeof RETAINED_GATE_EVIDENCE_LIMITS;
  reasonCodes: RetainedGateEvidenceReasonCode[];
  references: RetainedGateEvidenceReference[];
}

interface PathEntry {
  absolute: string;
  stats: fs.BigIntStats;
  leaf: boolean;
}
interface AcquiredReference {
  fd: number;
  absolute: string;
  before: fs.BigIntStats;
  ancestry: PathEntry[];
  reference: RetainedGateEvidenceReference;
  expectedHash: string;
  expectedBytes: number;
}
class AcquisitionFailure extends Error {
  constructor(
    readonly outcome: Exclude<RetainedGateEvidenceOutcome, "complete">,
    readonly reason: RetainedGateEvidenceReasonCode
  ) {
    super(reason);
  }
}
const HASH = /^sha256:[a-f0-9]{64}$/u;
const CHUNK_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 4096;
const MAX_SEGMENTS = 32;

/**
 * Portable, race-detected byte observation only. Node does not expose all Windows
 * reparse tags; these checks reject observed links/junctions and namespace escapes,
 * not arbitrary filesystem drivers or concurrent adversarial namespace changes.
 * No historical collection source, shell executable, or mutable latest file is opened.
 */
export class RetainedGateEvidenceSession {
  private readonly root: string;
  private readonly references: RetainedGateEvidenceReference[] = [];
  private readonly reasons = new Set<RetainedGateEvidenceReasonCode>();
  private readonly acquired: AcquiredReference[] = [];
  private readonly selectedPaths = new Set<string>();
  private readonly openedIdentities = new Set<string>();
  private bytesRead = 0;
  private closed = false;

  constructor(manifestPath: string) {
    validateLexicalPath(manifestPath);
    this.root = path.dirname(path.resolve(manifestPath));
  }

  readMetadata(
    kind: Exclude<RetainedGateEvidenceReferenceKind, "retained-artifact">,
    file: string,
    expectedHash: string
  ): Buffer {
    return this.acquire(kind, file, expectedHash, undefined, true).bytes!;
  }

  observeAdditionalReferences(
    references: readonly RetainedGateEvidenceAdditionalReference[]
  ): void {
    if (references.length > 2) {
      this.mark("REFERENCE_LIMIT");
      return;
    }
    for (const reference of references) {
      if (reference.kind !== "operation-descriptor" && reference.kind !== "operation-terminal") {
        this.mark("REFERENCE_INVALID");
        continue;
      }
      try {
        this.readMetadata(reference.kind, reference.path, reference.sha256);
      } catch (error) {
        this.markFailure(error);
      }
    }
  }

  observeReceipt(
    receipt: LocalGateExecutionReceipt,
    gate: Gate,
    receiptPath: string,
    repoRoot: string
  ): void {
    if (
      receipt.artifacts.length >
      RETAINED_GATE_EVIDENCE_LIMITS.maxReferences - this.references.length
    ) {
      this.mark("REFERENCE_LIMIT");
      return;
    }
    const declared = receipt.declaredGate;
    if (
      declared.name !== gate.name ||
      declared.run !== gate.run ||
      declared.cwd !== (gate.cwd ?? null) ||
      declared.runtime !== gate.runtime ||
      JSON.stringify(declared.artifacts) !== JSON.stringify(gate.artifacts ?? []) ||
      receipt.artifacts.length !== (gate.artifacts ?? []).length ||
      receipt.artifacts.some((artifact, index) => artifact.declaredPath !== gate.artifacts[index])
    ) {
      this.mark("GATE_MISMATCH");
      return;
    }
    let workingDirectory: string;
    try {
      workingDirectory = fs.realpathSync(path.resolve(repoRoot, gate.cwd ?? "."));
      if (!samePath(workingDirectory, receipt.execution.cwd)) {
        this.mark("CWD_MISMATCH");
        return;
      }
    } catch {
      this.mark("CWD_MISMATCH");
      return;
    }
    // The recorded enum selects one of the executor's two closed invocation shapes.
    // This compares the claim, not the current bytes or identity of that executable.
    const shell = resolveLocalGateShell(
      gate.run,
      receipt.execution.shell.command === "pwsh" ? "win32" : "linux"
    );
    if (JSON.stringify(shell.arguments) !== JSON.stringify(receipt.execution.shell.argv)) {
      this.mark("SHELL_MISMATCH");
      return;
    }
    for (const artifact of receipt.artifacts) {
      const referencesBefore = this.references.length;
      if (artifact.status !== "collected") {
        this.mark("COLLECTION_INCOMPLETE");
        this.failedArtifact(
          artifact.retainedPath,
          artifact.status === "missing" ? "missing" : "unsupported"
        );
        continue;
      }
      if (!artifact.source || !artifact.retained || !artifact.retainedPath) {
        this.mark("COLLECTION_INCOMPLETE");
        this.failedArtifact(artifact.retainedPath, "missing");
        continue;
      }
      const source = artifact.source;
      const retained = artifact.retained;
      if (
        !Number.isSafeInteger(source.bytes) ||
        !Number.isSafeInteger(retained.bytes) ||
        source.bytes !== retained.bytes ||
        source.sha256 !== retained.sha256 ||
        !samePath(artifact.resolvedPath, path.resolve(workingDirectory, artifact.declaredPath)) ||
        !samePath(source.path, artifact.resolvedPath)
      ) {
        this.mark("SOURCE_METADATA_MISMATCH");
        this.failedArtifact(artifact.retainedPath, "mismatched");
        continue;
      }
      try {
        // Existing v2 collectors retain direct siblings of this exact execution receipt.
        // Accept their absolute same-host references; never relocate them automatically.
        const selected = this.absoluteReference(artifact.retainedPath);
        if (
          !samePath(path.dirname(selected), path.dirname(receiptPath)) ||
          !samePath(this.absoluteReference(retained.path), selected) ||
          !samePath(this.absoluteReference(retained.realPath), selected)
        ) {
          throw new AcquisitionFailure("mismatched", "REFERENCE_INVALID");
        }
        this.acquire("retained-artifact", selected, retained.sha256, retained.bytes, false);
      } catch (error) {
        this.markFailure(error);
        // acquire already registered a reference; failures before it still need a bounded outcome.
        if (this.references.length === referencesBefore) {
          this.failedArtifact(artifact.retainedPath, asFailure(error).outcome);
        }
      }
    }
  }

  mark(reason: RetainedGateEvidenceReasonCode): void {
    this.reasons.add(reason);
  }

  canReadReference(): boolean {
    if (this.references.length < RETAINED_GATE_EVIDENCE_LIMITS.maxReferences) return true;
    this.mark("REFERENCE_LIMIT");
    return false;
  }

  /** New bounded-read limits are incomplete observations, not invalid outer evidence. */
  isReadLimitFailure(error: unknown): boolean {
    return (
      error instanceof AcquisitionFailure &&
      (error.reason === "REFERENCE_LIMIT" || error.reason === "TOTAL_BYTE_LIMIT")
    );
  }

  finish(afterReadBack?: () => void): RetainedGateEvidenceReport {
    for (const acquired of this.acquired) {
      if (acquired.reference.outcome !== "complete") continue;
      try {
        const before = fs.fstatSync(acquired.fd, { bigint: true });
        if (!stableFile(acquired.before, before))
          throw new AcquisitionFailure("changed", "FILE_CHANGED");
        const result = this.readOpened(acquired.fd, acquired.expectedBytes, false);
        const after = fs.fstatSync(acquired.fd, { bigint: true });
        if (!stableFile(before, after) || result.length !== acquired.expectedBytes) {
          throw new AcquisitionFailure("changed", "FILE_CHANGED");
        }
        if (result.sha256 !== acquired.expectedHash)
          throw new AcquisitionFailure("changed", "FILE_CHANGED");
        const finalPath = this.snapshot(acquired.absolute);
        if (!sameAncestry(acquired.ancestry, finalPath))
          throw new AcquisitionFailure("changed", "FILE_CHANGED");
      } catch (error) {
        const failure = asFailure(error);
        acquired.reference.outcome = failure.outcome;
        this.mark(failure.reason);
      }
    }
    afterReadBack?.();
    // Candidate capture can take time. Fence every still-complete observation
    // once more after it, while the descriptors are still held.
    for (const acquired of this.acquired) {
      if (acquired.reference.outcome !== "complete") continue;
      try {
        if (
          !stableFile(acquired.before, fs.fstatSync(acquired.fd, { bigint: true })) ||
          !sameAncestry(acquired.ancestry, this.snapshot(acquired.absolute))
        ) {
          throw new AcquisitionFailure("changed", "FILE_CHANGED");
        }
      } catch (error) {
        const failure = asFailure(error);
        acquired.reference.outcome = failure.outcome;
        this.mark(failure.reason);
      }
    }
    this.close();
    const report: RetainedGateEvidenceReport = {
      contract: "lexrunner-retained-gate-evidence/v1",
      status: this.reasons.size ? "incomplete" : "complete",
      authority: "unverified",
      scope: "referenced-evidence-closure",
      limits: RETAINED_GATE_EVIDENCE_LIMITS,
      reasonCodes: [...this.reasons].sort(),
      references: this.references.map((reference) => ({ ...reference })),
    };
    if (
      Buffer.byteLength(JSON.stringify(report), "utf8") >
      RETAINED_GATE_EVIDENCE_LIMITS.maxReportBytes
    ) {
      report.status = "incomplete";
      report.reasonCodes = [...new Set([...report.reasonCodes, "REPORT_LIMIT" as const])].sort();
      report.references = [];
    }
    return report;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const acquired of this.acquired) {
      try {
        fs.closeSync(acquired.fd);
      } catch {
        acquired.reference.outcome = "unreadable";
        this.mark("CLEANUP_UNCERTAIN");
      }
    }
  }

  private acquire(
    kind: RetainedGateEvidenceReferenceKind,
    file: string,
    expectedHash: string,
    expectedBytes: number | undefined,
    metadata: boolean
  ): { bytes?: Buffer } {
    if (this.closed) throw new AcquisitionFailure("unreadable", "FILE_UNREADABLE");
    if (this.references.length >= RETAINED_GATE_EVIDENCE_LIMITS.maxReferences) {
      this.mark("REFERENCE_LIMIT");
      throw new AcquisitionFailure("limit_exceeded", "REFERENCE_LIMIT");
    }
    const reference: RetainedGateEvidenceReference = { kind, outcome: "unreadable" };
    this.references.push(reference);
    let fd: number | undefined;
    try {
      const absolute = this.absoluteReference(file);
      reference.path = path.relative(this.root, absolute).split(path.sep).join("/");
      if (!HASH.test(expectedHash)) throw new AcquisitionFailure("mismatched", "DIGEST_MISMATCH");
      const selectedKey = normalizedPath(absolute);
      if (this.selectedPaths.has(selectedKey))
        throw new AcquisitionFailure("mismatched", "REFERENCE_DUPLICATE");
      this.selectedPaths.add(selectedKey);
      const ancestry = this.snapshot(absolute);
      const pathStat = ancestry[ancestry.length - 1]!.stats;
      const limit = metadata
        ? RETAINED_GATE_EVIDENCE_LIMITS.maxMetadataBytes
        : RETAINED_GATE_EVIDENCE_LIMITS.maxArtifactBytes;
      if (pathStat.size > BigInt(limit)) {
        throw new AcquisitionFailure(
          "limit_exceeded",
          metadata ? "METADATA_LIMIT" : "ARTIFACT_LIMIT"
        );
      }
      // POSIX nonblocking open prevents a raced FIFO from blocking before fstat.
      // Neither flag establishes Windows native reparse or namespace exclusion.
      const flags =
        fs.constants.O_RDONLY |
        (fs.constants.O_NOFOLLOW || 0) |
        (process.platform === "win32" ? 0 : fs.constants.O_NONBLOCK || 0);
      fd = fs.openSync(absolute, flags);
      const before = fs.fstatSync(fd, { bigint: true });
      if (!stableFile(pathStat, before)) throw new AcquisitionFailure("changed", "FILE_CHANGED");
      const identityKey = `${before.dev}:${before.ino}`;
      if (this.openedIdentities.has(identityKey))
        throw new AcquisitionFailure("mismatched", "REFERENCE_DUPLICATE");
      this.openedIdentities.add(identityKey);
      const size = Number(before.size);
      if (expectedBytes !== undefined && expectedBytes !== size)
        throw new AcquisitionFailure("mismatched", "SIZE_MISMATCH");
      const result = this.readOpened(fd, size, metadata);
      const after = fs.fstatSync(fd, { bigint: true });
      if (
        !stableFile(before, after) ||
        result.length !== size ||
        !sameAncestry(ancestry, this.snapshot(absolute))
      ) {
        throw new AcquisitionFailure("changed", "FILE_CHANGED");
      }
      reference.sha256 = result.sha256;
      reference.bytes = size;
      reference.outcome = result.sha256 === expectedHash ? "complete" : "mismatched";
      if (reference.outcome !== "complete") this.mark("DIGEST_MISMATCH");
      this.acquired.push({
        fd,
        absolute,
        before,
        ancestry,
        reference,
        expectedHash,
        expectedBytes: size,
      });
      fd = undefined;
      return { bytes: result.bytes };
    } catch (error) {
      const failure = asFailure(error);
      reference.outcome = failure.outcome;
      this.mark(failure.reason);
      throw failure;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          this.mark("CLEANUP_UNCERTAIN");
        }
      }
    }
  }

  private readOpened(
    fd: number,
    size: number,
    collect: boolean
  ): { length: number; sha256: string; bytes?: Buffer } {
    if (size + 1 > RETAINED_GATE_EVIDENCE_LIMITS.maxTotalBytes - this.bytesRead) {
      throw new AcquisitionFailure("limit_exceeded", "TOTAL_BYTE_LIMIT");
    }
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, size + 1));
    const pieces: Buffer[] = [];
    let length = 0;
    while (length <= size) {
      const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size + 1 - length), length);
      if (count === 0) break;
      length += count;
      this.bytesRead += count;
      hash.update(chunk.subarray(0, count));
      if (collect) pieces.push(Buffer.from(chunk.subarray(0, count)));
    }
    return {
      length,
      sha256: `sha256:${hash.digest("hex")}`,
      ...(collect ? { bytes: Buffer.concat(pieces, length) } : {}),
    };
  }

  private absoluteReference(file: string): string {
    validateLexicalPath(file);
    const absolute = path.isAbsolute(file)
      ? path.resolve(file)
      : path.resolve(this.root, safeRelative(file));
    const relative = path.relative(this.root, absolute);
    safeRelative(relative);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
      throw new AcquisitionFailure("unsupported", "REFERENCE_INVALID");
    }
    return absolute;
  }

  private snapshot(absolute: string): PathEntry[] {
    const filesystemRoot = path.parse(absolute).root;
    if (process.platform === "win32" && !/^[a-z]:[\\/]$/iu.test(filesystemRoot)) {
      throw new AcquisitionFailure("unsupported", "FILESYSTEM_UNSUPPORTED");
    }
    const segments = path.relative(filesystemRoot, absolute).split(path.sep);
    if (segments.length > MAX_SEGMENTS)
      throw new AcquisitionFailure("unsupported", "REFERENCE_INVALID");
    let current = filesystemRoot;
    const candidates = [current];
    for (const segment of segments) {
      safeRelative(segment);
      current = path.join(current, segment);
      candidates.push(current);
    }
    return candidates.map((candidate, index) => {
      const stats = fs.lstatSync(candidate, { bigint: true });
      const leaf = index === candidates.length - 1;
      if (
        stats.isSymbolicLink() ||
        (leaf ? !stats.isFile() || stats.nlink !== 1n : !stats.isDirectory()) ||
        stats.ino === 0n
      ) {
        throw new AcquisitionFailure("unsupported", "FILESYSTEM_UNSUPPORTED");
      }
      if (!samePath(fs.realpathSync(candidate), candidate))
        throw new AcquisitionFailure("unsupported", "FILESYSTEM_UNSUPPORTED");
      return { absolute: candidate, stats, leaf };
    });
  }

  private markFailure(error: unknown): void {
    this.mark(asFailure(error).reason);
  }

  private relativeForReport(file: string | undefined): string | undefined {
    try {
      return file === undefined
        ? undefined
        : path.relative(this.root, this.absoluteReference(file)).split(path.sep).join("/");
    } catch {
      return undefined;
    }
  }

  private failedArtifact(file: string | undefined, outcome: RetainedGateEvidenceOutcome): void {
    if (this.references.length >= RETAINED_GATE_EVIDENCE_LIMITS.maxReferences) {
      this.mark("REFERENCE_LIMIT");
      return;
    }
    const relative = this.relativeForReport(file);
    this.references.push({
      kind: "retained-artifact",
      ...(relative ? { path: relative } : {}),
      outcome,
    });
  }
}

function validateLexicalPath(file: string): void {
  if (
    typeof file !== "string" ||
    !file ||
    file.includes("\0") ||
    Buffer.byteLength(file, "utf8") > MAX_PATH_BYTES
  ) {
    throw new AcquisitionFailure("unsupported", "REFERENCE_INVALID");
  }
  if (path.isAbsolute(file)) {
    const root = path.parse(file).root;
    if (process.platform === "win32" && !/^[a-z]:[\\/]$/iu.test(root)) {
      throw new AcquisitionFailure("unsupported", "FILESYSTEM_UNSUPPORTED");
    }
    safeRelative(file.slice(root.length));
  } else {
    safeRelative(file);
  }
}

function safeRelative(reference: string): string {
  if (path.isAbsolute(reference) || path.win32.parse(reference).root)
    throw new AcquisitionFailure("unsupported", "REFERENCE_INVALID");
  const segments = reference.split("\\").join("/").split("/");
  if (
    segments.length > MAX_SEGMENTS ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        /[\x00-\x1f:*?"<>|]/u.test(segment) ||
        /[. ]$/u.test(segment) ||
        /^(?:con|conin\$|conout\$|clock\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(
          segment
        )
    )
  ) {
    throw new AcquisitionFailure("unsupported", "REFERENCE_INVALID");
  }
  return segments.join(path.sep);
}
function normalizedPath(reference: string): string {
  const resolved = path.resolve(reference);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function samePath(left: string, right: string): boolean {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    !left.includes("\0") &&
    !right.includes("\0") &&
    normalizedPath(left) === normalizedPath(right)
  );
}
function sameObject(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function stableFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    right.isFile() &&
    right.nlink === 1n &&
    sameObject(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode
  );
}
function sameAncestry(left: PathEntry[], right: PathEntry[]): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const after = right[index];
      return (
        after &&
        entry.leaf === after.leaf &&
        sameObject(entry.stats, after.stats) &&
        (!entry.leaf || stableFile(entry.stats, after.stats))
      );
    })
  );
}
function asFailure(error: unknown): AcquisitionFailure {
  if (error instanceof AcquisitionFailure) return error;
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
    return new AcquisitionFailure("missing", "FILE_MISSING");
  return new AcquisitionFailure("unreadable", "FILE_UNREADABLE");
}
