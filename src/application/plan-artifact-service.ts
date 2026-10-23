import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { resolveProfile } from "../config/profileResolver.js";
import { loadPlan, type Plan } from "../schema.js";
import { computeCanonicalHash } from "../schemas/task-contract.js";
import { canonicalJSONStringify } from "../util/canonicalJson.js";
import {
  EXECUTION_PLAN_ARTIFACT_CONTRACT,
  EXECUTION_PLAN_CANONICALIZATION_PROFILE,
  EXECUTION_PLAN_HASH_PROFILE,
  MAX_PLAN_ARTIFACT_BYTES,
  MAX_PLAN_RETRIEVAL_REFERENCE_BYTES,
  PLAN_ARTIFACT_REFERENCE_CONTRACT,
  PlanArtifactReference_v1Schema,
  PlanArtifactScope_v1Schema,
  computeExecutionPlanArtifactDigest,
  type ExecutionPlanArtifact_v1,
  type ExecutionPlanArtifactIdentity_v1,
  type PlanArtifactReference_v1,
  type PlanArtifactScope_v1,
} from "./execution-plan-artifact.js";

const MAX_PLAN_ITEMS = 256;
const MAX_GATES_PER_ITEM = 64;
const MAX_IDENTITY_LABEL_BYTES = 512;

export type PlanArtifactSource = "explicit" | "repository-root" | "profile-runner";

/** Backward-compatible public projection retained while ADR-012 adapters migrate. */
export interface PlanArtifactIdentity {
  contract: "plan-artifact-identity-v1";
  kind: "execution-plan";
  schema: "lexrunner.execution-plan";
  schemaVersion: string;
  digest: string;
  target: string;
  itemCount: number;
}

export interface ResolvedPlanArtifact {
  plan: Plan;
  identity: PlanArtifactIdentity;
  artifact: ExecutionPlanArtifact_v1;
  reference: PlanArtifactReference_v1;
  acquisition: PlanArtifactAcquisition;
  source: PlanArtifactSource;
  /** Adapter-only location. It is deliberately excluded from semantic identity and diagnostics. */
  filePath: string;
}

/**
 * Portable Node acquisition is integrity evidence, not filesystem authority.
 * A future native stable-handle reader must use a distinct assurance value.
 */
export interface PlanArtifactAcquisition {
  contract: "lexrunner.plan-artifact-acquisition.v1";
  assurance: "portable-race-detection";
  authority: "unverified";
}

export type PlanArtifactFailureCode =
  | "PLAN_REFERENCE_INVALID"
  | "PLAN_REFERENCE_MISMATCH"
  | "PLAN_NOT_FOUND"
  | "PLAN_UNREADABLE"
  | "PLAN_FILESYSTEM_UNSAFE"
  | "PLAN_ARTIFACT_LIMIT_EXCEEDED";

export class PlanArtifactServiceError extends Error {
  constructor(
    readonly code: PlanArtifactFailureCode,
    message: string,
    readonly source?: PlanArtifactSource
  ) {
    super(message);
    this.name = "PlanArtifactServiceError";
  }
}

/** @internal Deterministic source-test seams. Not exported by the package entrypoint. */
export interface PlanArtifactImportHooks {
  /** Deterministic hostile-test seams; production callers should not provide hooks. */
  afterInitialPathSnapshot?(): void;
  afterOpen?(): void;
  afterRead?(): void;
  beforeFinalPathSnapshot?(): void;
}

/** @internal */
export interface PlanArtifactServiceOptions {
  importHooks?: PlanArtifactImportHooks;
}

export interface ResolvePlanArtifactInput {
  planFile?: string;
  planReference?: PlanArtifactReference_v1;
  workingDir?: string;
  profileDir?: string;
  scope?: PlanArtifactScope_v1;
  /**
   * Preserve the legacy profile runner fallback by default. Explicit repository
   * routing disables it so ambient profile state cannot supply a foreign plan.
   */
  allowProfileFallback?: boolean;
}

/**
 * Resolve one exact content-addressed plan snapshot without creating mutable
 * "active plan" state. The portable reader detects observed races but does not
 * provide native stable-handle filesystem authority.
 *
 * Precedence is an expected-identity reference, an explicit path, repository-root
 * plan.json, then the legacy profile runner plan. Explicit inputs are authoritative:
 * a bad reference never falls through to another plan.
 */
export class PlanArtifactService {
  readonly #hooks: PlanArtifactImportHooks;

  constructor(options: PlanArtifactServiceOptions = {}) {
    this.#hooks = options.importHooks ?? {};
  }

  resolve(input: ResolvePlanArtifactInput = {}): ResolvedPlanArtifact {
    const workingDir = path.resolve(input.workingDir ?? process.cwd());
    const scope = parseScope(input.scope);
    if (input.planReference !== undefined && input.planFile !== undefined) {
      throw new PlanArtifactServiceError(
        "PLAN_REFERENCE_INVALID",
        "Provide either an immutable plan reference or an explicit plan path, not both",
        "explicit"
      );
    }
    if (input.planReference !== undefined && input.scope !== undefined) {
      throw new PlanArtifactServiceError(
        "PLAN_REFERENCE_INVALID",
        "A separately supplied scope cannot override an immutable plan reference",
        "explicit"
      );
    }

    if (input.planReference !== undefined) {
      const reference = parseReference(input.planReference);
      const explicitPath = resolveExplicitReference(reference.retrieval.reference, workingDir);
      return readArtifact(explicitPath, "explicit", this.#hooks, reference);
    }

    if (input.planFile !== undefined) {
      const explicitPath = resolveExplicitReference(input.planFile, workingDir);
      return readArtifact(explicitPath, "explicit", this.#hooks, undefined, scope);
    }

    const repositoryPlan = path.join(workingDir, "plan.json");
    if (pathEntryExists(repositoryPlan)) {
      return readArtifact(repositoryPlan, "repository-root", this.#hooks, undefined, scope);
    }

    if (input.allowProfileFallback !== false) {
      let profilePlan: string | undefined;
      try {
        const profile = resolveProfile(input.profileDir, workingDir);
        profilePlan = path.join(profile.path, "runner", "plan.json");
      } catch {
        // A profile is only the backward-compatible final fallback. Keep failure
        // diagnostics about the plan reference bounded and independent of host paths.
      }
      if (profilePlan && pathEntryExists(profilePlan)) {
        return readArtifact(profilePlan, "profile-runner", this.#hooks, undefined, scope);
      }
    }

    throw new PlanArtifactServiceError(
      "PLAN_NOT_FOUND",
      "No integration plan was found in the repository root or profile runner"
    );
  }
}

function parseReference(reference: PlanArtifactReference_v1): PlanArtifactReference_v1 {
  const parsed = PlanArtifactReference_v1Schema.safeParse(reference);
  if (!parsed.success) {
    throw new PlanArtifactServiceError(
      "PLAN_REFERENCE_INVALID",
      "The immutable plan reference does not satisfy the bounded transport contract",
      "explicit"
    );
  }
  return parsed.data;
}

function parseScope(scope: PlanArtifactScope_v1 | undefined): PlanArtifactScope_v1 | undefined {
  if (scope === undefined) return undefined;
  const parsed = PlanArtifactScope_v1Schema.safeParse(scope);
  if (!parsed.success) {
    throw new PlanArtifactServiceError(
      "PLAN_REFERENCE_INVALID",
      "The plan scope does not satisfy the bounded transport contract",
      "explicit"
    );
  }
  return parsed.data;
}

function resolveExplicitReference(reference: string, workingDir: string): string {
  if (
    reference.length === 0 ||
    reference.includes("\0") ||
    Buffer.byteLength(reference, "utf8") > MAX_PLAN_RETRIEVAL_REFERENCE_BYTES
  ) {
    throw new PlanArtifactServiceError(
      "PLAN_REFERENCE_INVALID",
      "The explicit plan reference is empty, overlong, or contains an invalid character",
      "explicit"
    );
  }
  return path.isAbsolute(reference)
    ? path.normalize(reference)
    : path.resolve(workingDir, reference);
}

function readArtifact(
  filePath: string,
  source: PlanArtifactSource,
  hooks: PlanArtifactImportHooks,
  expected?: PlanArtifactReference_v1,
  scope?: PlanArtifactScope_v1
): ResolvedPlanArtifact {
  const content = readPortableRaceDetectedFile(filePath, source, hooks);
  const plan = loadPlan(content);
  assertBoundedArtifact(plan, source);

  const canonicalBytes = canonicalJSONStringify(plan);
  const canonicalByteLength = Buffer.byteLength(canonicalBytes, "utf8");
  if (canonicalByteLength > MAX_PLAN_ARTIFACT_BYTES) {
    throw new PlanArtifactServiceError(
      "PLAN_ARTIFACT_LIMIT_EXCEEDED",
      "The canonical integration plan exceeds the artifact byte limit",
      source
    );
  }

  const artifactIdentity: ExecutionPlanArtifactIdentity_v1 = {
    contract: EXECUTION_PLAN_ARTIFACT_CONTRACT,
    kind: "execution-plan",
    planSchema: "lexrunner.execution-plan",
    planSchemaVersion: plan.schemaVersion,
    canonicalizationProfile: EXECUTION_PLAN_CANONICALIZATION_PROFILE,
    hashProfile: EXECUTION_PLAN_HASH_PROFILE,
    digestAlgorithm: "sha256",
    digest: computeExecutionPlanArtifactDigest(canonicalBytes),
    canonicalByteLength,
    target: plan.target,
    summary: {
      itemCount: plan.items.length,
      gateCount: plan.items.reduce((count, item) => count + item.gates.length, 0),
    },
  };
  const artifact: ExecutionPlanArtifact_v1 = { identity: artifactIdentity, canonicalBytes };

  if (expected && !isDeepStrictEqual(expected.artifact, artifactIdentity)) {
    throw new PlanArtifactServiceError(
      "PLAN_REFERENCE_MISMATCH",
      "The retrieved integration plan does not match the immutable reference",
      source
    );
  }

  const reference: PlanArtifactReference_v1 =
    expected ??
    parseReference({
      contract: PLAN_ARTIFACT_REFERENCE_CONTRACT,
      artifact: artifactIdentity,
      expectedDigest: artifactIdentity.digest,
      expectedCanonicalByteLength: artifactIdentity.canonicalByteLength,
      retrieval: { kind: "file", reference: filePath },
      ...(scope ? { scope } : {}),
    });

  return {
    plan,
    identity: {
      contract: "plan-artifact-identity-v1",
      kind: "execution-plan",
      schema: "lexrunner.execution-plan",
      schemaVersion: plan.schemaVersion,
      digest: computeCanonicalHash(plan),
      target: plan.target,
      itemCount: plan.items.length,
    },
    artifact,
    reference,
    acquisition: {
      contract: "lexrunner.plan-artifact-acquisition.v1",
      assurance: "portable-race-detection",
      authority: "unverified",
    },
    source,
    filePath,
  };
}

function readPortableRaceDetectedFile(
  filePath: string,
  source: PlanArtifactSource,
  hooks: PlanArtifactImportHooks
): string {
  const initialPath = snapshotPath(filePath, source);
  hooks.afterInitialPathSnapshot?.();

  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    throw importError(error, source);
  }

  let bytes: Buffer;
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    assertOpenedIdentity(initialPath[initialPath.length - 1]!.stats, before, source);
    hooks.afterOpen?.();

    if (before.size > BigInt(MAX_PLAN_ARTIFACT_BYTES)) {
      throw new PlanArtifactServiceError(
        "PLAN_ARTIFACT_LIMIT_EXCEEDED",
        "The referenced integration plan exceeds the artifact byte limit",
        source
      );
    }

    bytes = readAtMost(descriptor, MAX_PLAN_ARTIFACT_BYTES + 1);
    hooks.afterRead?.();
    const after = fs.fstatSync(descriptor, { bigint: true });
    assertStableOpenedFile(before, after, bytes.length, source);
  } finally {
    fs.closeSync(descriptor);
  }

  hooks.beforeFinalPathSnapshot?.();
  const finalPath = snapshotPath(filePath, source);
  assertStablePath(initialPath, finalPath, source);

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PlanArtifactServiceError(
      "PLAN_UNREADABLE",
      "The referenced integration plan is not valid UTF-8",
      source
    );
  }
}

interface PathSnapshotEntry {
  stats: fs.BigIntStats;
  leaf: boolean;
}

function snapshotPath(filePath: string, source: PlanArtifactSource): PathSnapshotEntry[] {
  const absolute = path.resolve(filePath);
  const root = path.parse(absolute).root;
  const relative = path.relative(root, absolute);
  const segments = relative.length === 0 ? [] : relative.split(path.sep);
  const candidates = [root];
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    candidates.push(current);
  }

  return candidates.map((candidate, index) => {
    let stats: fs.BigIntStats;
    try {
      stats = fs.lstatSync(candidate, { bigint: true });
    } catch (error) {
      throw importError(error, source);
    }
    const leaf = index === candidates.length - 1;
    if (stats.isSymbolicLink()) {
      throw new PlanArtifactServiceError(
        "PLAN_FILESYSTEM_UNSAFE",
        "The integration plan path contains an unsafe filesystem object",
        source
      );
    }
    if (leaf ? !stats.isFile() : !stats.isDirectory()) {
      throw new PlanArtifactServiceError(
        "PLAN_UNREADABLE",
        "The referenced integration plan is not a readable bounded file",
        source
      );
    }
    if (leaf && stats.nlink !== 1n) {
      throw new PlanArtifactServiceError(
        "PLAN_FILESYSTEM_UNSAFE",
        "The integration plan file has an ambiguous filesystem identity",
        source
      );
    }
    return { stats, leaf };
  });
}

function assertOpenedIdentity(
  pathStats: fs.BigIntStats,
  openedStats: fs.BigIntStats,
  source: PlanArtifactSource
): void {
  if (
    !openedStats.isFile() ||
    openedStats.nlink !== 1n ||
    !sameObject(pathStats, openedStats) ||
    pathStats.size !== openedStats.size ||
    pathStats.mtimeNs !== openedStats.mtimeNs ||
    pathStats.ctimeNs !== openedStats.ctimeNs
  ) {
    throw new PlanArtifactServiceError(
      "PLAN_FILESYSTEM_UNSAFE",
      "The integration plan filesystem identity changed during acquisition",
      source
    );
  }
}

function assertStableOpenedFile(
  before: fs.BigIntStats,
  after: fs.BigIntStats,
  bytesRead: number,
  source: PlanArtifactSource
): void {
  if (bytesRead > MAX_PLAN_ARTIFACT_BYTES) {
    throw new PlanArtifactServiceError(
      "PLAN_ARTIFACT_LIMIT_EXCEEDED",
      "The referenced integration plan exceeds the artifact byte limit",
      source
    );
  }
  if (
    !after.isFile() ||
    after.nlink !== 1n ||
    !sameObject(before, after) ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    BigInt(bytesRead) !== before.size
  ) {
    throw new PlanArtifactServiceError(
      "PLAN_FILESYSTEM_UNSAFE",
      "The integration plan changed while its bytes were being acquired",
      source
    );
  }
}

function assertStablePath(
  before: PathSnapshotEntry[],
  after: PathSnapshotEntry[],
  source: PlanArtifactSource
): void {
  if (
    before.length !== after.length ||
    before.some((entry, index) => {
      const current = after[index];
      return (
        !current ||
        entry.leaf !== current.leaf ||
        !sameObject(entry.stats, current.stats) ||
        (entry.leaf &&
          (entry.stats.size !== current.stats.size ||
            entry.stats.mtimeNs !== current.stats.mtimeNs ||
            entry.stats.ctimeNs !== current.stats.ctimeNs ||
            current.stats.nlink !== 1n))
      );
    })
  ) {
    throw new PlanArtifactServiceError(
      "PLAN_FILESYSTEM_UNSAFE",
      "The integration plan path changed while its bytes were being acquired",
      source
    );
  }
}

function sameObject(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function readAtMost(descriptor: number, maximumBytes: number): Buffer {
  const buffer = Buffer.allocUnsafe(maximumBytes);
  let offset = 0;
  while (offset < maximumBytes) {
    const count = fs.readSync(descriptor, buffer, offset, maximumBytes - offset, null);
    if (count === 0) break;
    offset += count;
  }
  return buffer.subarray(0, offset);
}

function importError(error: unknown, source: PlanArtifactSource): PlanArtifactServiceError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new PlanArtifactServiceError(
      "PLAN_NOT_FOUND",
      "The referenced integration plan does not exist",
      source
    );
  }
  return new PlanArtifactServiceError(
    "PLAN_UNREADABLE",
    "The referenced integration plan could not be safely read",
    source
  );
}

function assertBoundedArtifact(plan: Plan, source: PlanArtifactSource): void {
  const labels = [
    plan.schemaVersion,
    plan.target,
    ...plan.items.flatMap((item) => [item.name, ...item.gates.map((gate) => gate.name)]),
  ];
  if (
    plan.items.length > MAX_PLAN_ITEMS ||
    plan.items.some(({ gates }) => gates.length > MAX_GATES_PER_ITEM) ||
    labels.some((label) => Buffer.byteLength(label, "utf8") > MAX_IDENTITY_LABEL_BYTES)
  ) {
    throw new PlanArtifactServiceError(
      "PLAN_ARTIFACT_LIMIT_EXCEEDED",
      "The integration plan exceeds bounded item, gate, or identity-label limits",
      source
    );
  }
}

function pathEntryExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    return true;
  }
}
