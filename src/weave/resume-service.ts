import { canonicalJSONStringify } from "../util/canonicalJson.js";
import { sha256 } from "../util/hash.js";
import { computeMergeOrder } from "../mergeOrder.js";
import { Plan, type Plan as PlanContract } from "../schema.js";
import { WeaveState } from "./types.js";
import { z } from "zod";
import {
  acquireCheckpointExecutionLease,
  loadCheckpoint,
  saveCheckpoint,
} from "./checkpoint/storage.js";
import type {
  ResumeOperation,
  WeaveCheckpoint,
  WeaveResumeJournal_v1,
} from "./checkpoint/types.js";

export type ResumeObservation =
  | { state: "pending" }
  | { state: "completed"; externalId?: string }
  | { state: "ambiguous"; reason: string };

export type ResumeExecutionResult =
  { completed: true; externalId?: string } | { completed: false; reason: string };

/** Side-effect adapter used by the one canonical resume application service. */
export interface WeaveResumeDriver {
  /**
   * Read-only local binding check run before the checkpoint execution lease is acquired.
   * Drivers that can validate their execution root without external acquisition should expose it
   * here so an invalid invocation cannot create runner state in the selected working directory.
   */
  preflight?(
    checkpoint: Readonly<WeaveCheckpoint>
  ):
    | { valid: true }
    | { valid: false; reason: string }
    | Promise<{ valid: true } | { valid: false; reason: string }>;
  /**
   * Complete validation, repeated while holding the execution lease. For compatibility, drivers
   * without `preflight` are also validated before lease acquisition and must keep this method
   * read-only. Drivers whose complete validation performs acquisition must expose its read-only
   * local subset through `preflight`.
   */
  validate(
    checkpoint: WeaveCheckpoint
  ): Promise<{ valid: true } | { valid: false; reason: string }>;
  observe(
    operation: Readonly<ResumeOperation>,
    checkpoint: Readonly<WeaveCheckpoint>
  ): Promise<ResumeObservation>;
  execute(
    operation: Readonly<ResumeOperation>,
    checkpoint: Readonly<WeaveCheckpoint>
  ): Promise<ResumeExecutionResult>;
}

export interface ResumeWeaveInput {
  runId: string;
  driver: WeaveResumeDriver;
  checkpointDir?: string;
  /** Bounded test/operator pause. Omit to continue through every eligible operation. */
  maxOperations?: number;
  now?: () => string;
}

export type ResumeWeaveResult =
  | {
      ok: true;
      outcome: "completed" | "paused";
      runId: string;
      revision: number;
      completed: number;
      pending: number;
      failed: number;
    }
  | {
      ok: false;
      code:
        | "checkpoint_busy"
        | "checkpoint_invalid"
        | "external_state_mismatch"
        | "ambiguous_external_state"
        | "operation_failed";
      runId: string;
      reason: string;
      operationId?: string;
    };

/**
 * Continue one persisted operation journal. Every side effect is fenced by a durable
 * `in_progress` write and every successful observation/execution is persisted before advancing.
 */
export async function resumePersistedWeave(input: ResumeWeaveInput): Promise<ResumeWeaveResult> {
  const preflight = await inspectCheckpoint(input, false);
  if (!preflight.ok) return preflight.result;

  const lease = acquireCheckpointExecutionLease(input.runId, input.checkpointDir);
  if (!lease) {
    return {
      ok: false,
      code: "checkpoint_busy",
      runId: input.runId,
      reason: "another process holds the checkpoint execution lease",
    };
  }

  try {
    const guarded = await inspectCheckpoint(input, true);
    if (!guarded.ok) return guarded.result;
    let checkpoint = guarded.checkpoint;

    const now = input.now ?? (() => new Date().toISOString());
    const limit = input.maxOperations ?? Number.POSITIVE_INFINITY;
    let executed = 0;

    while (true) {
      const journal = checkpoint.metadata!.resume!;
      const operation = nextOperation(journal.operations);
      if (!operation) {
        checkpoint.phase = "complete";
        checkpoint.state = WeaveState.COMPLETED;
        checkpoint.lastUpdatedAt = now();
        checkpoint.timestamp = checkpoint.lastUpdatedAt;
        checkpoint = await persist(checkpoint, input.checkpointDir);
        return summary(checkpoint, "completed");
      }

      if (executed >= limit) {
        checkpoint.state = WeaveState.PAUSED;
        checkpoint.lastUpdatedAt = now();
        checkpoint.timestamp = checkpoint.lastUpdatedAt;
        checkpoint = await persist(checkpoint, input.checkpointDir);
        return summary(checkpoint, "paused");
      }

      if (operation.status === "in_progress" || operation.status === "failed") {
        const observation = await input.driver.observe(operation, checkpoint);
        if (observation.state === "ambiguous") {
          return {
            ok: false,
            code: "ambiguous_external_state",
            runId: input.runId,
            operationId: operation.id,
            reason: observation.reason,
          };
        }
        if (observation.state === "completed") {
          const at = now();
          complete(operation, "observed", observation.externalId, at);
          checkpoint.lastUpdatedAt = checkpoint.timestamp = at;
          checkpoint = await persist(checkpoint, input.checkpointDir);
          continue;
        }
        operation.status = "pending";
        operation.error = undefined;
        operation.startedAt = undefined;
        checkpoint.lastUpdatedAt = checkpoint.timestamp = now();
        checkpoint = await persist(checkpoint, input.checkpointDir);
      }

      operation.status = "in_progress";
      operation.attempts += 1;
      operation.startedAt = now();
      operation.error = undefined;
      checkpoint.phase = checkpointPhase(operation);
      checkpoint.state = stateFor(operation);
      checkpoint.lastUpdatedAt = operation.startedAt;
      checkpoint.timestamp = operation.startedAt;
      checkpoint = await persist(checkpoint, input.checkpointDir);

      const active = checkpoint.metadata!.resume!.operations.find(
        (candidate) => candidate.id === operation.id
      )!;
      const result = await input.driver.execute(active, checkpoint);
      if (!result.completed) {
        active.status = "failed";
        active.error = bound(result.reason);
        active.completedAt = now();
        checkpoint.state = WeaveState.PAUSED;
        checkpoint.lastUpdatedAt = checkpoint.timestamp = active.completedAt;
        checkpoint = await persist(checkpoint, input.checkpointDir);
        return {
          ok: false,
          code: "operation_failed",
          runId: input.runId,
          operationId: active.id,
          reason: active.error,
        };
      }

      const completedAt = now();
      complete(active, "executed", result.externalId, completedAt);
      checkpoint.lastUpdatedAt = checkpoint.timestamp = completedAt;
      checkpoint = await persist(checkpoint, input.checkpointDir);
      executed += 1;
    }
  } finally {
    lease.release();
  }
}

type CheckpointInspection =
  | { ok: true; checkpoint: WeaveCheckpoint }
  | { ok: false; result: Extract<ResumeWeaveResult, { ok: false }> };

/**
 * Load and validate without writing. The first pass rejects malformed checkpoints and local
 * repository/cwd mismatches before lease acquisition. The guarded pass repeats every check from
 * the persisted file while holding the lease, then performs the driver's external validation.
 */
async function inspectCheckpoint(
  input: ResumeWeaveInput,
  validateExternal: boolean
): Promise<CheckpointInspection> {
  let checkpoint: WeaveCheckpoint;
  try {
    checkpoint = await loadCheckpoint(input.runId, {
      checkpointDir: input.checkpointDir,
      validatePlanHash: false,
    });
  } catch (error) {
    return {
      ok: false,
      result: invalid(input.runId, error instanceof Error ? error.message : String(error)),
    };
  }

  const validation = validateResumeJournal(checkpoint);
  if (!validation.valid) {
    return { ok: false, result: invalid(input.runId, validation.reason) };
  }

  if (input.driver.preflight) {
    const local = await input.driver.preflight(checkpoint);
    if (!local.valid) return { ok: false, result: externalMismatch(input.runId, local.reason) };
  } else if (!validateExternal) {
    const legacy = await input.driver.validate(checkpoint);
    if (!legacy.valid) {
      return { ok: false, result: externalMismatch(input.runId, legacy.reason) };
    }
  }

  if (validateExternal) {
    const external = await input.driver.validate(checkpoint);
    if (!external.valid) {
      return { ok: false, result: externalMismatch(input.runId, external.reason) };
    }
  }

  return { ok: true, checkpoint };
}

export function validateResumeJournal(
  checkpoint: WeaveCheckpoint
): { valid: true } | { valid: false; reason: string } {
  const parsedPlan = Plan.safeParse(checkpoint.plan);
  if (!parsedPlan.success) {
    return { valid: false, reason: "checkpoint contains an invalid plan" };
  }
  const parsedJournal = ResumeJournalSchema.safeParse(checkpoint.metadata?.resume);
  if (!parsedJournal.success) {
    return {
      valid: false,
      reason:
        "checkpoint predates the operation journal and cannot be resumed safely; start a fresh execution",
    };
  }
  const journal = checkpoint.metadata!.resume!;
  const planHash = sha256(Buffer.from(canonicalJSONStringify(checkpoint.plan)));
  if (checkpoint.planHash !== planHash) {
    return { valid: false, reason: "checkpoint plan hash does not match its canonical plan" };
  }
  if (!Number.isSafeInteger(journal.revision) || journal.revision < 0) {
    return { valid: false, reason: "checkpoint journal revision is invalid" };
  }
  if (journal.repository.target !== parsedPlan.data.target) {
    return { valid: false, reason: "checkpoint repository target does not match its frozen plan" };
  }
  const sourceNames = Object.keys(journal.repository.sourceHeads).sort();
  const planNames = parsedPlan.data.items.map((item) => item.name).sort();
  if (canonicalJSONStringify(sourceNames) !== canonicalJSONStringify(planNames)) {
    return {
      valid: false,
      reason: "checkpoint source-head evidence does not match its frozen plan",
    };
  }
  const ids = new Set<string>();
  const inputs = parsedPlan.data.gitInputs;
  if (
    inputs &&
    journal.repository.integrationBranch !== `weave/resume-${checkpoint.runId.toLowerCase()}`
  ) {
    return { valid: false, reason: "checkpoint integration branch does not match its bound run" };
  }
  if (
    inputs &&
    (inputs.target.commit !== journal.repository.targetHeadSha ||
      inputs.sources.some(
        (source) => source.commit !== journal.repository.sourceHeads[source.item]
      ))
  ) {
    return { valid: false, reason: "checkpoint commits do not match the plan's frozen Git inputs" };
  }
  let seenIncomplete = false;
  for (const operation of journal.operations) {
    if (!operation.id || ids.has(operation.id)) {
      return { valid: false, reason: "checkpoint operation identities are empty or duplicated" };
    }
    ids.add(operation.id);
    if (!Number.isSafeInteger(operation.attempts) || operation.attempts < 0) {
      return { valid: false, reason: `checkpoint operation ${operation.id} has invalid attempts` };
    }
    if (operation.status === "completed") {
      if (seenIncomplete) {
        return {
          valid: false,
          reason: "checkpoint completes an operation after an incomplete one",
        };
      }
    } else {
      seenIncomplete = true;
    }
  }
  let expected: Array<Pick<ResumeOperation, "id" | "phase" | "item">>;
  try {
    expected = planResumeOperations(parsedPlan.data);
  } catch {
    return { valid: false, reason: "checkpoint plan does not define a valid dependency order" };
  }
  if (
    canonicalJSONStringify(
      journal.operations.map(({ id, phase, item }) => ({ id, phase, item }))
    ) !== canonicalJSONStringify(expected)
  ) {
    return { valid: false, reason: "checkpoint operation journal does not match its frozen plan" };
  }
  return { valid: true };
}

export function planResumeOperations(
  plan: PlanContract
): Array<Pick<ResumeOperation, "id" | "phase" | "item">> {
  const orderedItems = computeMergeOrder(plan).flat();
  const operations: Array<Pick<ResumeOperation, "id" | "phase" | "item">> = [];
  for (const name of orderedItems) {
    const item = plan.items.find((candidate) => candidate.name === name)!;
    for (const gate of item.gates) {
      operations.push({ id: `gate:${name}:${gate.name}`, phase: "gate", item: name });
    }
    operations.push({ id: `merge:${name}`, phase: "merge", item: name });
  }
  const required = new Set(plan.policy?.requiredGates ?? []);
  for (const gateName of required) {
    const owner = plan.items.find((item) => item.gates.some((gate) => gate.name === gateName));
    if (owner) {
      operations.push({
        id: `post_check:${gateName}`,
        phase: "post_check",
        item: owner.name,
      });
    }
  }
  return operations;
}

export function createResumeJournal(input: {
  operations: Array<Pick<ResumeOperation, "id" | "phase" | "item">>;
  target: string;
  targetHeadSha: string;
  integrationBranch: string;
  sourceHeads: Record<string, string>;
}): WeaveResumeJournal_v1 {
  return {
    schemaVersion: "1.0.0",
    revision: 0,
    operations: input.operations.map((operation) => ({
      ...operation,
      status: "pending",
      attempts: 0,
    })),
    repository: {
      target: input.target,
      targetHeadSha: input.targetHeadSha,
      integrationBranch: input.integrationBranch,
      sourceHeads: { ...input.sourceHeads },
    },
  };
}

async function persist(
  checkpoint: WeaveCheckpoint,
  checkpointDir?: string
): Promise<WeaveCheckpoint> {
  const journal = checkpoint.metadata!.resume!;
  journal.revision += 1;
  projectLegacyProgress(checkpoint, journal);
  await saveCheckpoint(checkpoint, { checkpointDir, skipCleanup: true });
  return checkpoint;
}

function projectLegacyProgress(checkpoint: WeaveCheckpoint, journal: WeaveResumeJournal_v1): void {
  checkpoint.completedItems = journal.operations
    .filter((operation) => operation.status === "completed")
    .map((operation) => operation.id);
  checkpoint.pendingItems = journal.operations
    .filter((operation) => operation.status === "pending" || operation.status === "in_progress")
    .map((operation) => operation.id);
  checkpoint.failedItems = journal.operations
    .filter((operation) => operation.status === "failed")
    .map((operation) => operation.id);
  checkpoint.successfulMerges = journal.operations.filter(
    (operation) => operation.phase === "merge" && operation.status === "completed"
  ).length;
  checkpoint.failedMerges = journal.operations.filter(
    (operation) => operation.phase === "merge" && operation.status === "failed"
  ).length;
}

function nextOperation(operations: ResumeOperation[]): ResumeOperation | undefined {
  return operations.find((operation) => operation.status !== "completed");
}

function complete(
  operation: ResumeOperation,
  outcome: "executed" | "observed",
  externalId: string | undefined,
  at: string
): void {
  operation.status = "completed";
  operation.completedAt = at;
  operation.error = undefined;
  operation.result = { outcome, ...(externalId ? { externalId: bound(externalId) } : {}) };
}

function checkpointPhase(operation: ResumeOperation): WeaveCheckpoint["phase"] {
  if (operation.phase === "gate") return "gates";
  if (operation.phase === "post_check") return "post_checks";
  return "merge";
}

function stateFor(operation: ResumeOperation): WeaveState {
  if (operation.phase === "gate" || operation.phase === "post_check") {
    return WeaveState.VALIDATING;
  }
  return WeaveState.MERGING;
}

function summary(
  checkpoint: WeaveCheckpoint,
  outcome: "completed" | "paused"
): Extract<ResumeWeaveResult, { ok: true }> {
  const operations = checkpoint.metadata!.resume!.operations;
  return {
    ok: true,
    outcome,
    runId: checkpoint.runId,
    revision: checkpoint.metadata!.resume!.revision,
    completed: operations.filter((operation) => operation.status === "completed").length,
    pending: operations.filter(
      (operation) => operation.status === "pending" || operation.status === "in_progress"
    ).length,
    failed: operations.filter((operation) => operation.status === "failed").length,
  };
}

function invalid(runId: string, reason: string): Extract<ResumeWeaveResult, { ok: false }> {
  return { ok: false, code: "checkpoint_invalid", runId, reason: bound(reason) };
}

function externalMismatch(
  runId: string,
  reason: string
): Extract<ResumeWeaveResult, { ok: false }> {
  return { ok: false, code: "external_state_mismatch", runId, reason: bound(reason) };
}

function bound(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 512);
}

const ResumeJournalSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    revision: z.number().int().nonnegative(),
    operations: z.array(
      z
        .object({
          id: z.string().min(1).max(256),
          phase: z.enum(["gate", "merge", "post_check"]),
          item: z.string().min(1).max(256),
          status: z.enum(["pending", "in_progress", "completed", "failed"]),
          attempts: z.number().int().nonnegative(),
          startedAt: z.string().max(64).optional(),
          completedAt: z.string().max(64).optional(),
          result: z
            .object({
              outcome: z.enum(["executed", "observed"]),
              externalId: z.string().max(512).optional(),
            })
            .strict()
            .optional(),
          error: z.string().max(512).optional(),
        })
        .strict()
    ),
    repository: z
      .object({
        target: z.string().min(1).max(256),
        targetHeadSha: z.string().min(1).max(128),
        integrationBranch: z.string().min(1).max(256),
        sourceHeads: z.record(z.string(), z.string().min(1).max(128)),
      })
      .strict(),
  })
  .strict();
