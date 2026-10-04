import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";

import { ExecutionState } from "../executionState.js";
import {
  GATE_EXECUTION_RECEIPT_SCHEMA_VERSION,
  parseLocalGateExecutionReceipt,
} from "../gates/execution-receipt.js";
import { loadPlan, type GateResult, type Plan } from "../schema.js";
import { computeCanonicalHash } from "../schemas/task-contract.js";
import { canonicalJSONStringify } from "../util/canonicalJson.js";
import { sha256, sha256FileRaw } from "../util/hash.js";
import {
  captureGateCandidateIdentity,
  GateCandidateIdentitySchema,
  sameGateCandidate,
  type GateCandidateIdentity,
} from "./gate-candidate-identity.js";
import {
  RetainedGateEvidenceSession,
  type RetainedGateEvidenceAdditionalReference,
  type RetainedGateEvidenceReport,
} from "./retained-gate-evidence.js";

export const GATE_EVIDENCE_MANIFEST_SCHEMA_VERSION = "lexrunner-gate-evidence-manifest/v1" as const;
const MANIFEST_FILE_NAME = "gate-evidence-manifest.json";
const MAX_EVIDENCE_REFERENCE_BYTES = 4_096;
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;

const GateEvidenceEntrySchema = z
  .object({
    item: z.string().min(1).max(512),
    gate: z.string().min(1).max(512),
    declaredGateDigest: z.string().regex(SHA256_PATTERN),
    result: z
      .object({
        status: z.enum(["pass", "fail", "blocked", "skipped", "retrying"]),
        exitCode: z.number().optional(),
        duration: z.number().nonnegative().optional(),
        timeoutMs: z.number().int().positive().optional(),
        failureKind: z
          .enum(["nonzero_exit", "spawn_error", "timeout", "evidence_error"])
          .optional(),
        attempts: z.number().int().nonnegative(),
        lastAttempt: z.string().optional(),
      })
      .strict(),
    receipt: z
      .object({
        path: z.string().min(1).max(MAX_EVIDENCE_REFERENCE_BYTES),
        sha256: z.string().regex(SHA256_PATTERN),
      })
      .strict(),
  })
  .strict();

const GateEvidenceManifestSchema = z
  .object({
    schemaVersion: z.literal(GATE_EVIDENCE_MANIFEST_SCHEMA_VERSION),
    createdAt: z.string(),
    plan: z
      .object({
        digest: z.string().regex(SHA256_PATTERN),
        schemaVersion: z.string(),
        target: z.string(),
        itemCount: z.number().int().nonnegative(),
      })
      .strict(),
    candidate: GateCandidateIdentitySchema,
    selection: z
      .object({
        onlyItem: z.string().nullable(),
        onlyGate: z.string().nullable(),
      })
      .strict(),
    entries: z.array(GateEvidenceEntrySchema).max(16_384),
  })
  .strict();

export type GateEvidenceManifest = z.infer<typeof GateEvidenceManifestSchema>;

export interface GateEvidenceArtifactReference {
  kind: "gate-evidence-manifest";
  path: string;
  sha256: string;
}

export class GateEvidenceServiceError extends Error {
  constructor(
    readonly code:
      | "GATE_EVIDENCE_REFERENCE_INVALID"
      | "GATE_EVIDENCE_UNREADABLE"
      | "GATE_EVIDENCE_DIGEST_MISMATCH"
      | "GATE_EVIDENCE_PLAN_MISMATCH"
      | "GATE_EVIDENCE_ENTRY_MISMATCH",
    message: string
  ) {
    super(message);
    this.name = "GateEvidenceServiceError";
  }
}

/** Write one explicit, plan-bound index over the strong local execution receipts. */
export function writeGateEvidenceManifest(input: {
  plan: Plan;
  executionState: ExecutionState;
  artifactDir: string;
  onlyItem?: string;
  onlyGate?: string;
  candidate: GateCandidateIdentity;
}): GateEvidenceArtifactReference {
  const plan = canonicalPlan(input.plan);
  const artifactDir = path.resolve(input.artifactDir);
  fs.mkdirSync(artifactDir, { recursive: true });
  const entries: GateEvidenceManifest["entries"] = [];

  for (const [itemName, nodeResult] of input.executionState.getResults()) {
    if (input.onlyItem && itemName !== input.onlyItem) continue;
    const item = plan.items.find(({ name }) => name === itemName);
    if (!item) continue;
    for (const result of nodeResult.gates) {
      if (input.onlyGate && result.gate !== input.onlyGate) continue;
      const gate = item.gates.find(({ name }) => name === result.gate);
      const receiptPath = findFinalReceipt(result, artifactDir);
      if (!gate || !receiptPath) continue;
      entries.push({
        item: itemName,
        gate: result.gate,
        declaredGateDigest: computeCanonicalHash(gate),
        result: {
          status: result.status,
          ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
          ...(result.duration !== undefined ? { duration: result.duration } : {}),
          ...(result.timeoutMs !== undefined ? { timeoutMs: result.timeoutMs } : {}),
          ...(result.failureKind ? { failureKind: result.failureKind } : {}),
          attempts: result.attempts,
          ...(result.lastAttempt ? { lastAttempt: result.lastAttempt } : {}),
        },
        receipt: {
          path: portableRelativePath(artifactDir, receiptPath),
          sha256: prefixedFileHash(receiptPath),
        },
      });
    }
  }

  const manifest: GateEvidenceManifest = {
    schemaVersion: GATE_EVIDENCE_MANIFEST_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    plan: {
      digest: computeCanonicalHash(plan),
      schemaVersion: plan.schemaVersion,
      target: plan.target,
      itemCount: plan.items.length,
    },
    candidate: input.candidate,
    selection: {
      onlyItem: input.onlyItem ?? null,
      onlyGate: input.onlyGate ?? null,
    },
    entries,
  };
  const manifestPath = path.join(artifactDir, MANIFEST_FILE_NAME);
  const temporaryPath = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, canonicalJSONStringify(manifest), "utf8");
  fs.renameSync(temporaryPath, manifestPath);
  return {
    kind: "gate-evidence-manifest",
    path: manifestPath,
    sha256: prefixedFileHash(manifestPath),
  };
}

/** Project only explicitly referenced, fully bound execution evidence into a fresh state. */
export function loadGateEvidence(input: {
  plan: Plan;
  evidenceFile: string;
  evidenceSha256: string;
  repoRoot?: string;
  verifyArtifacts?: boolean;
  /** Internal operation-status pins, not arbitrary artifact discovery. Ignored by default. */
  additionalReferences?: readonly RetainedGateEvidenceAdditionalReference[];
}): {
  executionState: ExecutionState;
  reference: GateEvidenceArtifactReference;
  applied: number;
  observations: { passed: string[]; failed: string[]; other: string[] };
  artifactVerification?: RetainedGateEvidenceReport;
} {
  if (input.verifyArtifacts !== undefined && typeof input.verifyArtifacts !== "boolean") {
    throw evidenceError(
      "GATE_EVIDENCE_REFERENCE_INVALID",
      "Artifact verification selection is invalid"
    );
  }
  const plan = canonicalPlan(input.plan);
  const evidenceFile = resolveEvidenceReference(input.evidenceFile);
  if (!SHA256_PATTERN.test(input.evidenceSha256)) {
    throw evidenceError("GATE_EVIDENCE_REFERENCE_INVALID", "Evidence SHA-256 is invalid");
  }
  let retained: RetainedGateEvidenceSession | undefined;
  if (input.verifyArtifacts === true) {
    try {
      retained = new RetainedGateEvidenceSession(input.evidenceFile);
    } catch {
      throw evidenceError("GATE_EVIDENCE_REFERENCE_INVALID", "Evidence reference is invalid");
    }
  }
  try {
    const manifestBytes = readEvidenceBytes(
      retained,
      "manifest",
      evidenceFile,
      input.evidenceSha256,
      "Evidence manifest could not be read"
    );
    const actualManifestHash = prefixedBytesHash(manifestBytes);
    if (actualManifestHash !== input.evidenceSha256) {
      throw evidenceError(
        "GATE_EVIDENCE_DIGEST_MISMATCH",
        "Evidence manifest digest does not match"
      );
    }

    let manifest: GateEvidenceManifest;
    try {
      manifest = GateEvidenceManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
    } catch {
      throw evidenceError("GATE_EVIDENCE_UNREADABLE", "Evidence manifest is not valid or bounded");
    }
    if (
      manifest.plan.digest !== computeCanonicalHash(plan) ||
      manifest.plan.schemaVersion !== plan.schemaVersion ||
      manifest.plan.target !== plan.target ||
      manifest.plan.itemCount !== plan.items.length
    ) {
      throw evidenceError(
        "GATE_EVIDENCE_PLAN_MISMATCH",
        "Evidence manifest belongs to another plan"
      );
    }
    const currentCandidate = captureGateCandidateIdentity(
      input.repoRoot ?? process.cwd(),
      path.dirname(evidenceFile)
    );
    if (!sameGateCandidate(manifest.candidate, currentCandidate)) {
      throw evidenceError(
        "GATE_EVIDENCE_PLAN_MISMATCH",
        "Gate evidence belongs to a stale or different repository candidate"
      );
    }
    retained?.observeAdditionalReferences(input.additionalReferences ?? []);

    const executionState = new ExecutionState(plan);
    const appliedEntries: GateEvidenceManifest["entries"] = [];
    const seen = new Set<string>();
    for (const entry of manifest.entries) {
      const identity = `${entry.item}\0${entry.gate}`;
      if (seen.has(identity)) {
        throw evidenceError(
          "GATE_EVIDENCE_ENTRY_MISMATCH",
          "Evidence contains a duplicate gate identity"
        );
      }
      seen.add(identity);
      const item = plan.items.find(({ name }) => name === entry.item);
      const gate = item?.gates.find(({ name }) => name === entry.gate);
      if (!item || !gate || computeCanonicalHash(gate) !== entry.declaredGateDigest) {
        throw evidenceError(
          "GATE_EVIDENCE_ENTRY_MISMATCH",
          "Evidence does not match a declared plan gate"
        );
      }
      if (retained && !retained.canReadReference()) continue;
      const receiptPath = resolveContainedReceipt(evidenceFile, entry.receipt.path);
      let receiptBytes: Buffer;
      try {
        receiptBytes = retained
          ? retained.readMetadata("execution-receipt", entry.receipt.path, entry.receipt.sha256)
          : readBoundedBytes(receiptPath, "Gate receipt could not be read");
      } catch (error) {
        if (retained?.isReadLimitFailure(error)) continue;
        throw evidenceError("GATE_EVIDENCE_UNREADABLE", "Gate receipt could not be read");
      }
      if (prefixedBytesHash(receiptBytes) !== entry.receipt.sha256) {
        throw evidenceError("GATE_EVIDENCE_DIGEST_MISMATCH", "Gate receipt digest does not match");
      }
      const receipt = validateReceipt(receiptBytes, entry, manifest.candidate.worktreeDigest);
      retained?.observeReceipt(receipt, gate, receiptPath, currentCandidate.repositoryRoot);
      executionState.updateGateResult(entry.item, {
        gate: entry.gate,
        ...entry.result,
        artifacts: [receiptPath],
      });
      appliedEntries.push(entry);
    }
    executionState.propagateBlockedStatus();
    const artifactVerification = retained?.finish(() => {
      try {
        const after = captureGateCandidateIdentity(
          input.repoRoot ?? process.cwd(),
          path.dirname(evidenceFile)
        );
        if (!sameGateCandidate(currentCandidate, after)) retained!.mark("CANDIDATE_CHANGED");
      } catch {
        retained!.mark("CANDIDATE_UNAVAILABLE");
      }
    });
    return {
      executionState,
      reference: {
        kind: "gate-evidence-manifest",
        path: evidenceFile,
        sha256: actualManifestHash,
      },
      applied: appliedEntries.length,
      observations: {
        passed: appliedEntries
          .filter(({ result }) => result.status === "pass")
          .map(({ item, gate }) => `${item}/${gate}`),
        failed: appliedEntries
          .filter(({ result }) => result.status === "fail")
          .map(({ item, gate }) => `${item}/${gate}`),
        other: appliedEntries
          .filter(({ result }) => result.status !== "pass" && result.status !== "fail")
          .map(({ item, gate }) => `${item}/${gate}`),
      },
      ...(artifactVerification ? { artifactVerification } : {}),
    };
  } finally {
    retained?.close();
  }
}

function readEvidenceBytes(
  retained: RetainedGateEvidenceSession | undefined,
  kind: "manifest" | "execution-receipt",
  file: string,
  expectedHash: string,
  message: string
): Buffer {
  if (!retained) return readBoundedBytes(file, message);
  try {
    return retained.readMetadata(kind, file, expectedHash);
  } catch {
    throw evidenceError("GATE_EVIDENCE_UNREADABLE", message);
  }
}

function findFinalReceipt(result: GateResult, artifactDir: string): string | undefined {
  return [...(result.artifacts ?? [])]
    .reverse()
    .map((candidate) => path.resolve(candidate))
    .filter((candidate) =>
      /^gate-execution-receipt\.attempt-\d+\.json$/u.test(path.basename(candidate))
    )
    .map((candidate) => containedRegularFile(artifactDir, candidate))
    .find((candidate): candidate is string => candidate !== undefined);
}

function portableRelativePath(base: string, candidate: string): string {
  if (!isContained(base, candidate)) {
    throw evidenceError(
      "GATE_EVIDENCE_ENTRY_MISMATCH",
      "Gate receipt is outside the artifact root"
    );
  }
  return path.relative(base, candidate).split(path.sep).join("/");
}

function resolveEvidenceReference(reference: string): string {
  if (
    !reference ||
    reference.includes("\0") ||
    Buffer.byteLength(reference, "utf8") > MAX_EVIDENCE_REFERENCE_BYTES
  ) {
    throw evidenceError("GATE_EVIDENCE_REFERENCE_INVALID", "Evidence reference is invalid");
  }
  const resolved = path.resolve(reference);
  if (!isBoundedFile(resolved)) {
    throw evidenceError(
      "GATE_EVIDENCE_UNREADABLE",
      "Evidence manifest is not a readable bounded file"
    );
  }
  return resolved;
}

function resolveContainedReceipt(manifestPath: string, reference: string): string {
  if (path.isAbsolute(reference) || reference.includes("\0")) {
    throw evidenceError("GATE_EVIDENCE_ENTRY_MISMATCH", "Gate receipt reference is not relative");
  }
  const root = path.dirname(manifestPath);
  const resolved = path.resolve(root, reference);
  if (!isContained(root, resolved)) {
    throw evidenceError(
      "GATE_EVIDENCE_ENTRY_MISMATCH",
      "Gate receipt reference escapes evidence root"
    );
  }
  try {
    const contained = containedRegularFile(root, resolved);
    if (!contained) throw new Error("untrusted receipt identity");
    return contained;
  } catch {
    throw evidenceError(
      "GATE_EVIDENCE_ENTRY_MISMATCH",
      "Gate receipt is not a contained regular file"
    );
  }
}

function validateReceipt(
  receiptBytes: Buffer,
  entry: GateEvidenceManifest["entries"][number],
  candidateDigest: string
): ReturnType<typeof parseLocalGateExecutionReceipt> {
  let receipt: ReturnType<typeof parseLocalGateExecutionReceipt>;
  try {
    receipt = parseLocalGateExecutionReceipt(JSON.parse(receiptBytes.toString("utf8")));
  } catch {
    throw evidenceError("GATE_EVIDENCE_UNREADABLE", "Gate receipt is not valid bounded evidence");
  }
  if (
    receipt.schemaVersion !== GATE_EXECUTION_RECEIPT_SCHEMA_VERSION ||
    receipt.binding.item !== entry.item ||
    receipt.binding.declaredGateDigest !== entry.declaredGateDigest ||
    receipt.binding.candidateDigest !== candidateDigest ||
    receipt.binding.timeoutMs !== entry.result.timeoutMs ||
    receipt.declaredGate.name !== entry.gate ||
    receipt.declaredGate.runtime !== "local" ||
    receipt.attempt !== entry.result.attempts ||
    receipt.execution.startedAt !== entry.result.lastAttempt ||
    receipt.execution.durationMs !== entry.result.duration ||
    receipt.outcome.status !== entry.result.status ||
    receipt.outcome.exitCode !== (entry.result.exitCode ?? null) ||
    receipt.outcome.failureKind !== (entry.result.failureKind ?? null) ||
    (entry.result.status === "pass" &&
      (receipt.outcome.evidenceComplete !== true || receipt.outcome.exitCode !== 0))
  ) {
    throw evidenceError(
      "GATE_EVIDENCE_ENTRY_MISMATCH",
      "Gate receipt outcome does not match evidence"
    );
  }
  return receipt;
}

function readBoundedBytes(filePath: string, message: string): Buffer {
  try {
    const bytes = fs.readFileSync(filePath);
    if (bytes.byteLength > MAX_EVIDENCE_BYTES) throw new Error("file exceeds evidence bound");
    return bytes;
  } catch {
    throw evidenceError("GATE_EVIDENCE_UNREADABLE", message);
  }
}

function prefixedFileHash(filePath: string): string {
  return `sha256:${sha256FileRaw(filePath)}`;
}

function prefixedBytesHash(bytes: Buffer): string {
  return `sha256:${sha256(bytes)}`;
}

function isBoundedFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size <= MAX_EVIDENCE_BYTES;
  } catch {
    return false;
  }
}

function containedRegularFile(root: string, candidate: string): string | undefined {
  try {
    const directStat = fs.lstatSync(candidate);
    const realRoot = fs.realpathSync(root);
    const realCandidate = fs.realpathSync(candidate);
    return directStat.isFile() &&
      !directStat.isSymbolicLink() &&
      isContained(realRoot, realCandidate) &&
      isBoundedFile(realCandidate)
      ? realCandidate
      : undefined;
  } catch {
    return undefined;
  }
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function evidenceError(
  code: GateEvidenceServiceError["code"],
  message: string
): GateEvidenceServiceError {
  return new GateEvidenceServiceError(code, message);
}

function canonicalPlan(plan: Plan): Plan {
  return loadPlan(canonicalJSONStringify(plan));
}
