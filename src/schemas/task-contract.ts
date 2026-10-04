/**
 * Task Snapshot Contract - Zod Schemas
 *
 * Implements ADR-007: Task Snapshot Contract
 * Defines the handoff contract between deterministic engine and stochastic agents.
 *
 * Core principle: Snapshot = hints, Receipt = claims, Engine = verifier
 *
 * @see docs/adr/ADR-007-task-snapshot-contract.md
 * @module
 */

import { createHash } from "crypto";
import { z } from "zod";

// =============================================================================
// SCHEMA VERSION
// =============================================================================

export const TASK_CONTRACT_VERSION = "1.0.0" as const;

// =============================================================================
// CANONICAL HASH HELPER
// =============================================================================

/**
 * Versioned name for the existing compact JSON SHA256 representation.
 * The label is metadata; it is not added to the hashed bytes.
 */
export const COMPACT_JSON_HASH_PROFILE = "lexrunner.compact-json.sha256.v1" as const;

/**
 * Compute the existing compact JSON hash of a schema-validated plain JSON value.
 *
 * Used to bind receipts to snapshots and verify integrity.
 * The preimage is UTF-8 JSON.stringify with the existing sorted-key replacer,
 * without indentation, a trailing newline, or a domain prefix. Array order and
 * JavaScript JSON number/string serialization are preserved. This is not JCS.
 *
 * This helper does not validate input or make arbitrary JavaScript objects safe.
 * Existing JSON.stringify and replacer quirks remain unchanged for compatibility,
 * including toJSON/accessor behavior and special-key handling. Existing record
 * schemas may admit __proto__, so schema validation alone is not a safety bound.
 * This export reproduces known contract hashes, not arbitrary data authentication.
 * See docs/evidence-verification.md before using it outside an existing contract.
 *
 * @param obj - Value validated against its owning JSON contract
 * @returns SHA256 hash prefixed with "sha256:"
 */
export function computeCanonicalHash(obj: unknown): string {
  const canonical = JSON.stringify(obj, sortedReplacer);
  return computeCanonicalHashFromCompactJSON(canonical);
}

/**
 * Hash an already-canonical compact JSON representation.
 *
 * Callers must establish canonical key ordering before using this lower-level
 * helper. It exists for validation paths that already paid that cost and can
 * avoid recursively sorting the parsed value a second time.
 */
export function computeCanonicalHashFromCompactJSON(canonical: string): string {
  const hash = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `sha256:${hash}`;
}

/**
 * JSON replacer that sorts object keys for deterministic serialization.
 */
function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce(
        (sorted, key) => {
          sorted[key] = (value as Record<string, unknown>)[key];
          return sorted;
        },
        {} as Record<string, unknown>
      );
  }
  return value;
}

/**
 * Verify that a receipt's snapshot_hash matches the snapshot.
 *
 * @param snapshot - The original snapshot (without snapshot_hash field)
 * @param receiptSnapshotHash - The hash claimed by the receipt
 * @returns true if hashes match
 */
export function verifySnapshotBinding(
  snapshot: TaskSnapshot_v1,
  receiptSnapshotHash: string
): boolean {
  return snapshot.snapshot_hash === receiptSnapshotHash;
}

/**
 * Compute snapshot hash, excluding the snapshot_hash field itself.
 * This creates the hash that will be stored in snapshot_hash.
 */
export function computeSnapshotHash(
  snapshotWithoutHash: Omit<TaskSnapshot_v1, "snapshot_hash">
): string {
  return computeCanonicalHash(snapshotWithoutHash);
}

// =============================================================================
// SHARED ENUMS
// =============================================================================

/**
 * Determinism level for tasks
 * - D1: Deterministic, script-safe
 * - D2: Semi-deterministic, needs junior model
 * - D3: Non-deterministic, needs frontier model
 */
export const DeterminismLevel = z.enum(["D1", "D2", "D3"]);
export type DeterminismLevel = z.infer<typeof DeterminismLevel>;

/**
 * Confidence level for agent claims
 */
export const ConfidenceLevel = z.enum(["high", "medium", "low"]);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevel>;

/**
 * Source of truth kind
 */
export const SourceOfTruthKind = z.enum(["symbol", "file", "registry"]);
export type SourceOfTruthKind = z.infer<typeof SourceOfTruthKind>;

/**
 * Assumption type for structured learning
 */
export const AssumptionType = z.enum(["scope", "codebase", "env", "intent", "dependency", "test"]);
export type AssumptionType = z.infer<typeof AssumptionType>;

// =============================================================================
// REPO-RELATIVE PATH VALIDATION
// =============================================================================

/**
 * Repo-relative path (no leading slash, no absolute paths)
 */
export const RepoRelativePath = z
  .string()
  .refine((p) => !p.startsWith("/"), {
    message: "Path must be repo-relative (no leading slash)",
  })
  .refine((p) => !p.includes(":\\") && !p.includes(":/"), {
    message: "Path must not be absolute (no drive letters)",
  })
  .refine((p) => !p.startsWith(".."), {
    message: "Path must not escape repo root",
  });
export type RepoRelativePath = z.infer<typeof RepoRelativePath>;

/**
 * Glob pattern (repo-relative)
 */
export const GlobPattern = z.string().min(1);
export type GlobPattern = z.infer<typeof GlobPattern>;

/**
 * SHA256 hash string
 */
export const SHA256Hash = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, "Must be sha256:<64-hex-chars>");
export type SHA256Hash = z.infer<typeof SHA256Hash>;

/**
 * Placeholder hash for examples/tests (allows ...PLACEHOLDER suffix)
 */
export const SHA256HashOrPlaceholder = z.string().refine((h) => h.startsWith("sha256:"), {
  message: "Must start with sha256:",
});

// =============================================================================
// TASK SNAPSHOT SCHEMA (v1)
// =============================================================================

/**
 * Repository provenance
 */
export const RepoProvenance = z.object({
  /** Repository identifier (owner/name) */
  id: z.string().regex(/^[^/]+\/[^/]+$/, "Must be owner/repo format"),
  /** Absolute path to repo root (engine-local, for resolution) */
  root: z.string(),
  /** Pinned commit SHA */
  commit_sha: z.string().min(7),
});
export type RepoProvenance = z.infer<typeof RepoProvenance>;

/**
 * Scope boundary for agent operations
 */
export const ScopeBoundary = z.object({
  /** Globs for files agent can read */
  read_globs: z.array(GlobPattern),
  /** Globs for files agent can modify */
  write_globs: z.array(GlobPattern),
  /** Globs for files explicitly denied (always applied) */
  deny_globs: z.array(GlobPattern),
  /** Whether cross-repo operations are permitted */
  cross_repo_allowed: z.boolean(),
});
export type ScopeBoundary = z.infer<typeof ScopeBoundary>;

/**
 * Failure evidence from test runner
 */
export const FailureEvidence = z.object({
  /** Short error description */
  message: z.string(),
  /** Repo-relative path to failed file */
  file_rel: RepoRelativePath,
  /** Line number if available */
  line: z.number().int().positive().optional(),
  /** Actual test runner output snippet */
  runner_output_snip: z.string(),
  /** Code context around failure */
  excerpt: z.string().optional(),
});
export type FailureEvidence = z.infer<typeof FailureEvidence>;

/**
 * Hint edit suggestion (find/replace)
 */
export const HintEdit = z.object({
  find: z.string(),
  replace: z.string(),
});
export type HintEdit = z.infer<typeof HintEdit>;

/**
 * Target file with anchored hunk
 */
export const Target = z.object({
  /** Repo-relative file path */
  path_rel: RepoRelativePath,
  /** Anchored code context (±N lines) */
  hunk: z.string(),
  /** SHA256 of hunk for drift detection */
  hunk_sha256: SHA256HashOrPlaceholder,
  /** Optional find/replace suggestion */
  hint_edit: HintEdit.optional(),
});
export type Target = z.infer<typeof Target>;

/**
 * Introducing change reference
 */
export const IntroducingChange = z.object({
  commit_sha: z.string().min(7),
  diff_hunk: z.string(),
});
export type IntroducingChange = z.infer<typeof IntroducingChange>;

/**
 * Source of truth reference
 */
export const SourceOfTruth = z.object({
  /** Kind of source */
  kind: SourceOfTruthKind,
  /** Repo-relative path */
  path_rel: RepoRelativePath,
  /** Repository ID (defaults to snapshot repo if omitted) */
  repo_id: z.string().optional(),
  /** Commit SHA (defaults to snapshot commit if omitted) */
  commit_sha: z.string().optional(),
  /** Canonical excerpt */
  excerpt: z.string(),
  /** Lexmap module ID if applicable */
  lexmap_module_id: z.string().optional(),
  /** Change that introduced this */
  introducing_change: IntroducingChange.optional(),
});
export type SourceOfTruth = z.infer<typeof SourceOfTruth>;

/**
 * Verification expectations
 */
export const VerificationExpectations = z.object({
  /** Command to run */
  cmd: z.string(),
  /** Expected results */
  expect: z.object({
    /** Expected exit code (usually 0) */
    exit_code: z.number().int(),
    /** Strings that must appear in output */
    must_include: z.array(z.string()).optional(),
    /** Strings that must not appear */
    must_not_include: z.array(z.string()).optional(),
  }),
});
export type VerificationExpectations = z.infer<typeof VerificationExpectations>;

/**
 * Budget and truncation tracking
 */
export const Budget = z.object({
  /** Token budget hint in bytes */
  max_bytes: z.number().int().positive().optional(),
  /** Fields that were truncated (empty if none) */
  truncated_fields: z.array(z.string()),
});
export type Budget = z.infer<typeof Budget>;

/**
 * Task Snapshot v1 - Complete schema
 *
 * The contract handed from engine to agent.
 * Contains all context needed for bounded work.
 */
export const TaskSnapshot_v1 = z.object({
  // Schema version
  schema_version: z.literal(TASK_CONTRACT_VERSION),

  // Identity
  task_id: z.string().min(1),
  procedure: z.string().min(1),
  determinism: DeterminismLevel,
  snapshot_hash: SHA256HashOrPlaceholder,

  // Provenance (MUST)
  repo: RepoProvenance,

  // Scope boundary (MUST)
  scope: ScopeBoundary,

  // Failure evidence (MUST)
  failure: FailureEvidence,

  // Invariants (SHOULD) - anti-brittleness constraints
  invariants: z.array(z.string()).optional(),

  // Targets (MUST, array)
  targets: z.array(Target).min(1),

  // Source of truth (SHOULD)
  source_of_truth: SourceOfTruth.optional(),

  // Verification expectations (MUST)
  verification: VerificationExpectations,

  // Budget/truncation (MUST)
  budget: Budget,

  // Output contract
  receipt_schema_id: z.string(),
});
export type TaskSnapshot_v1 = z.infer<typeof TaskSnapshot_v1>;

// =============================================================================
// TASK RECEIPT SCHEMA (v1)
// =============================================================================

/**
 * Structured assumption for learning
 */
export const StructuredAssumption = z.object({
  /** Type of assumption */
  type: AssumptionType,
  /** Assumption text */
  text: z.string(),
  /** Whether it was validated */
  validated: z.boolean().optional(),
  /** Evidence supporting validation */
  evidence: z.string().optional(),
});
export type StructuredAssumption = z.infer<typeof StructuredAssumption>;

/**
 * Agent claims about work done
 */
export const AgentClaims = z.object({
  /** Whether the task succeeded */
  success: z.boolean(),
  /** Unified diff patch */
  patch: z.string().optional(),
  /** Files touched (repo-relative) */
  files_touched: z.array(RepoRelativePath),
  /** Rationale for the fix */
  rationale: z.string(),
  /** Confidence level */
  confidence: ConfidenceLevel,
  /** Which invariants were respected */
  invariants_respected: z.array(z.string()).optional(),
  /** Structured assumptions made */
  assumptions_made: z.array(StructuredAssumption),
});
export type AgentClaims = z.infer<typeof AgentClaims>;

/**
 * Search activity record
 */
export const SearchActivity = z.object({
  /** Search query */
  query: z.string(),
  /** Search method used */
  method: z.string().optional(),
  /** Roots searched (repo-relative) */
  roots: z.array(z.string()),
  /** Number of results found */
  results_count: z.number().int().nonnegative().optional(),
  /** Time taken in milliseconds */
  time_ms: z.number().nonnegative().optional(),
});
export type SearchActivity = z.infer<typeof SearchActivity>;

/**
 * Token usage tracking
 */
export const TokenUsage = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

/**
 * Cost tracking
 */
export const CostTracking = z.object({
  /** Token usage breakdown */
  token_usage: TokenUsage.optional(),
  /** Number of tool calls made */
  tool_calls_count: z.number().int().nonnegative().optional(),
  /** Elapsed time in milliseconds */
  elapsed_ms: z.number().nonnegative().optional(),
});
export type CostTracking = z.infer<typeof CostTracking>;

/**
 * Agent's own verification attempt (still a claim)
 */
export const AgentVerification = z.object({
  /** Whether verification command was run */
  cmd_ran: z.boolean(),
  /** Exit code if run */
  exit_code: z.number().int().optional(),
  /** Output snippet */
  output_snip: z.string().optional(),
});
export type AgentVerification = z.infer<typeof AgentVerification>;

/**
 * Task Receipt v1 - Complete schema
 *
 * What agent claims it did. NOT truth - the engine verifies.
 */
export const TaskReceipt_v1 = z.object({
  // Schema version
  schema_version: z.literal(TASK_CONTRACT_VERSION),

  // Identity (echo from snapshot)
  task_id: z.string().min(1),
  snapshot_hash: SHA256HashOrPlaceholder,

  // Claims (what agent says it did)
  claims: AgentClaims,

  // Search activity (if agent searched)
  search_activity: z.array(SearchActivity),

  // Cost tracking
  cost: CostTracking,

  // Agent's verification attempt (still a claim)
  agent_verification: AgentVerification.optional(),

  // Blockers (if not successful)
  blockers: z.array(z.string()),
});
export type TaskReceipt_v1 = z.infer<typeof TaskReceipt_v1>;

// =============================================================================
// ENGINE VERIFICATION SCHEMA (v1)
// =============================================================================

/**
 * Detected failure record
 */
export const DetectedFailure = z.object({
  type: z.string(),
  message: z.string(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
});
export type DetectedFailure = z.infer<typeof DetectedFailure>;

/**
 * Engine Verification v1 - Complete schema
 *
 * Separate from receipt - this is the engine's proof.
 * The source of truth for whether the task actually succeeded.
 */
export const EngineVerification_v1 = z.object({
  // Identity
  task_id: z.string().min(1),
  timestamp: z.string().datetime(),

  // Hash binding (audit trail)
  snapshot_hash: SHA256HashOrPlaceholder,
  receipt_hash: SHA256HashOrPlaceholder,

  // Verification result
  verified: z.boolean(),

  // What engine ran
  cmd_ran: z.string(),
  exit_code: z.number().int(),
  stdout_snip: z.string(),
  stderr_snip: z.string(),

  // Patch verification
  patch_hash: SHA256HashOrPlaceholder.optional(),
  patch_applied: z.boolean(),

  // Comparison with agent claim
  agent_claimed: z.boolean(),
  trust_gap: z.boolean(),

  // Failures detected
  failures: z.array(DetectedFailure),
});
export type EngineVerification_v1 = z.infer<typeof EngineVerification_v1>;

// =============================================================================
// VALIDATION HELPERS
// =============================================================================

/**
 * Parse and validate a TaskSnapshot_v1
 */
export function parseTaskSnapshot(data: unknown): TaskSnapshot_v1 {
  return TaskSnapshot_v1.parse(data);
}

/**
 * Parse and validate a TaskReceipt_v1
 */
export function parseTaskReceipt(data: unknown): TaskReceipt_v1 {
  return TaskReceipt_v1.parse(data);
}

/**
 * Parse and validate an EngineVerification_v1
 */
export function parseEngineVerification(data: unknown): EngineVerification_v1 {
  return EngineVerification_v1.parse(data);
}

/**
 * Safe parse with result type
 */
export function safeParseTaskSnapshot(data: unknown) {
  return TaskSnapshot_v1.safeParse(data);
}

export function safeParseTaskReceipt(data: unknown) {
  return TaskReceipt_v1.safeParse(data);
}

export function safeParseEngineVerification(data: unknown) {
  return EngineVerification_v1.safeParse(data);
}

// =============================================================================
// BINDING VALIDATION
// =============================================================================

/**
 * Validate that receipt properly binds to snapshot
 */
export function validateReceiptBinding(
  snapshot: TaskSnapshot_v1,
  receipt: TaskReceipt_v1
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Task ID must match
  if (snapshot.task_id !== receipt.task_id) {
    errors.push(`Task ID mismatch: snapshot=${snapshot.task_id}, receipt=${receipt.task_id}`);
  }

  // Snapshot hash must match
  if (snapshot.snapshot_hash !== receipt.snapshot_hash) {
    errors.push(
      `Snapshot hash mismatch: prevents floating receipts. ` +
        `snapshot=${snapshot.snapshot_hash}, receipt=${receipt.snapshot_hash}`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate that engine verification properly binds to snapshot and receipt
 */
export function validateVerificationBinding(
  snapshot: TaskSnapshot_v1,
  receipt: TaskReceipt_v1,
  verification: EngineVerification_v1
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Task ID must match
  if (snapshot.task_id !== verification.task_id) {
    errors.push(
      `Task ID mismatch: snapshot=${snapshot.task_id}, verification=${verification.task_id}`
    );
  }

  // Snapshot hash must match
  if (snapshot.snapshot_hash !== verification.snapshot_hash) {
    errors.push(
      `Snapshot hash mismatch in verification: ` +
        `snapshot=${snapshot.snapshot_hash}, verification=${verification.snapshot_hash}`
    );
  }

  // Receipt hash must be computed from receipt
  const computedReceiptHash = computeCanonicalHash(receipt);
  if (verification.receipt_hash !== computedReceiptHash) {
    errors.push(
      `Receipt hash mismatch: expected=${computedReceiptHash}, verification=${verification.receipt_hash}`
    );
  }

  // Trust gap should be correctly computed
  const expectedTrustGap = receipt.claims.success !== verification.verified;
  if (verification.trust_gap !== expectedTrustGap) {
    errors.push(
      `Trust gap incorrectly computed: ` +
        `agent_claimed=${receipt.claims.success}, verified=${verification.verified}, ` +
        `expected_trust_gap=${expectedTrustGap}, actual=${verification.trust_gap}`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
