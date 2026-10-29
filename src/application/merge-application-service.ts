import { createGitOperations } from "../git/operations.js";
import { join } from "node:path";
import { FrozenGitInputError } from "../git/frozen-inputs.js";
import { computeMergeOrder } from "../mergeOrder.js";
import type { Plan } from "../schema.js";
import { unsupportedForgeExecutionReason } from "../forge/execution-scope.js";
import { assertSingleRepositoryPlan } from "./repository-binding.js";
import {
  createLocalResumeCheckpoint,
  LocalWeaveResumeDriver,
} from "../weave/local-resume-driver.js";
import { loadCheckpoint, saveCheckpoint } from "../weave/checkpoint/storage.js";
import type { ResumeOperation } from "../weave/checkpoint/types.js";
import { resumePersistedWeave, type ResumeWeaveResult } from "../weave/resume-service.js";

const MAX_OPERATIONS = 256;
const MAX_LABEL_BYTES = 512;
const MAX_RESULT_BYTES = 256 * 1024;

export type MergeApplicationFailureCode =
  | "MERGE_MUTATION_DENIED"
  | "MERGE_STALE_INPUT"
  | "MERGE_CONFLICT"
  | "MERGE_MULTI_REPO_UNSUPPORTED"
  | "MERGE_FORGE_UNSUPPORTED"
  | "MERGE_APPLICATION_FAILED";

export class MergeApplicationServiceError extends Error {
  constructor(
    readonly code: MergeApplicationFailureCode,
    message: string
  ) {
    super(message);
    this.name = "MergeApplicationServiceError";
  }
}

export interface BoundedMergeApplicationResult {
  contract: "bounded-ax-v1";
  mode: "dry-run" | "execute";
  /** Compatibility projection retained for existing CLI/MCP JSON consumers. */
  dryRun: boolean;
  ok: boolean;
  status: "preview" | "completed" | "paused" | "failed";
  totalItems: number;
  gitInputBinding: "frozen" | "legacy-unbound";
  levels?: string[][];
  maxParallelism?: number;
  runId?: string;
  operations?: Array<{
    id: string;
    phase: string;
    item: string;
    status: string;
    evidenceRef?: string;
  }>;
  artifactRefs: Array<{ kind: "weave-checkpoint"; id: string }>;
  failureCode?: MergeApplicationFailureCode;
}

export interface MergeApplicationExecution {
  result: ResumeWeaveResult;
  operations: ResumeOperation[];
}

export interface MergeApplicationRuntime {
  isClean(workingDir: string): Promise<boolean>;
  prepare(plan: Plan, workingDir: string): Promise<string>;
  resume(runId: string, workingDir: string): Promise<MergeApplicationExecution>;
}

export class MergeApplicationService {
  constructor(
    private readonly runtime: MergeApplicationRuntime = new LocalMergeApplicationRuntime()
  ) {}

  async run(input: {
    plan: Plan;
    workingDir: string;
    dryRun: boolean;
    mutationAuthorized: boolean;
  }): Promise<{ summary: BoundedMergeApplicationResult; execution?: MergeApplicationExecution }> {
    if (!input.dryRun) assertSupportedExecution(input.plan);
    try {
      assertSingleRepositoryPlan(input.plan);
    } catch {
      throw new MergeApplicationServiceError(
        "MERGE_MULTI_REPO_UNSUPPORTED",
        "Multi-repository plans cannot be applied in a single repository worktree"
      );
    }
    const levels = computeMergeOrder(input.plan);
    assertBounded(input.plan, levels);
    if (input.dryRun) {
      return boundedResult({
        summary: {
          contract: "bounded-ax-v1",
          mode: "dry-run",
          dryRun: true,
          ok: true,
          status: "preview",
          totalItems: input.plan.items.length,
          gitInputBinding: input.plan.gitInputs ? "frozen" : "legacy-unbound",
          levels,
          maxParallelism:
            levels.length === 0 ? 0 : Math.max(...levels.map((level) => level.length)),
          artifactRefs: [],
        },
      });
    }
    if (!input.mutationAuthorized) {
      throw new MergeApplicationServiceError(
        "MERGE_MUTATION_DENIED",
        "Merge mutation requires explicit execute authority"
      );
    }
    if (!(await this.runtime.isClean(input.workingDir))) {
      throw new MergeApplicationServiceError(
        "MERGE_STALE_INPUT",
        "Merge input is stale because the working tree is not clean"
      );
    }
    let runId: string;
    try {
      runId = await this.runtime.prepare(input.plan, input.workingDir);
    } catch (error) {
      throw new MergeApplicationServiceError(
        "MERGE_STALE_INPUT",
        error instanceof FrozenGitInputError
          ? error.message
          : "Merge input could not be bound to current source and target heads"
      );
    }
    return this.executePrepared({ plan: input.plan, workingDir: input.workingDir, runId });
  }

  async executePrepared(input: {
    plan: Plan;
    workingDir: string;
    runId: string;
  }): Promise<{ summary: BoundedMergeApplicationResult; execution: MergeApplicationExecution }> {
    assertSupportedExecution(input.plan);
    let execution: MergeApplicationExecution;
    try {
      execution = await this.runtime.resume(input.runId, input.workingDir);
    } catch {
      throw new MergeApplicationServiceError(
        "MERGE_APPLICATION_FAILED",
        "Merge application failed; inspect the checkpoint artifact"
      );
    }
    if (execution.operations.length > MAX_OPERATIONS) {
      throw new MergeApplicationServiceError(
        "MERGE_APPLICATION_FAILED",
        `Merge application exceeds the ${MAX_OPERATIONS}-operation result limit`
      );
    }
    const failureCode = classifyFailure(execution);
    const completed = execution.result.ok && execution.result.outcome === "completed";
    const summary: BoundedMergeApplicationResult = {
      contract: "bounded-ax-v1",
      mode: "execute",
      dryRun: false,
      ok: completed,
      status: execution.result.ok ? execution.result.outcome : "failed",
      totalItems: input.plan.items.length,
      gitInputBinding: input.plan.gitInputs ? "frozen" : "legacy-unbound",
      runId: bound(input.runId),
      operations: execution.operations.map((operation) => ({
        id: bound(operation.id),
        phase: bound(operation.phase),
        item: bound(operation.item),
        status: bound(operation.status),
        ...(operation.result?.externalId
          ? { evidenceRef: bound(operation.result.externalId) }
          : {}),
      })),
      artifactRefs: [{ kind: "weave-checkpoint", id: bound(input.runId) }],
      ...(failureCode ? { failureCode } : {}),
    };
    return { summary: boundedResult(summary), execution };
  }
}

class LocalMergeApplicationRuntime implements MergeApplicationRuntime {
  async isClean(workingDir: string): Promise<boolean> {
    return createGitOperations(workingDir).isClean();
  }

  async prepare(plan: Plan, workingDir: string): Promise<string> {
    const checkpoint = await createLocalResumeCheckpoint({ plan, workingDir });
    await saveCheckpoint(checkpoint, {
      checkpointDir: join(workingDir, ".lexrunner", "checkpoints"),
      skipCleanup: true,
    });
    return checkpoint.runId;
  }

  async resume(runId: string, workingDir: string): Promise<MergeApplicationExecution> {
    const result = await resumePersistedWeave({
      runId,
      checkpointDir: join(workingDir, ".lexrunner", "checkpoints"),
      driver: new LocalWeaveResumeDriver(workingDir),
    });
    const checkpoint = await loadCheckpoint(runId, {
      checkpointDir: join(workingDir, ".lexrunner", "checkpoints"),
      validatePlanHash: false,
    });
    return { result, operations: checkpoint.metadata?.resume?.operations ?? [] };
  }
}

function assertBounded(plan: Plan, levels: string[][]): void {
  if (plan.items.length > MAX_OPERATIONS || levels.flat().length > MAX_OPERATIONS) {
    throw new MergeApplicationServiceError(
      "MERGE_APPLICATION_FAILED",
      `Merge plan exceeds the ${MAX_OPERATIONS}-item application limit`
    );
  }
}

function assertSupportedExecution(plan: Plan): void {
  const reason = unsupportedForgeExecutionReason(plan);
  if (reason) throw new MergeApplicationServiceError("MERGE_FORGE_UNSUPPORTED", reason);
}

function classifyFailure(execution: MergeApplicationExecution): MergeApplicationFailureCode | null {
  if (execution.result.ok && execution.result.outcome === "completed") return null;
  if (!execution.result.ok && execution.result.code === "external_state_mismatch") {
    return "MERGE_STALE_INPUT";
  }
  if (execution.operations.some(({ error }) => error?.toLowerCase().includes("conflict"))) {
    return "MERGE_CONFLICT";
  }
  return "MERGE_APPLICATION_FAILED";
}

function bound(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_LABEL_BYTES) return value;
  let prefix = "";
  for (const character of value) {
    if (Buffer.byteLength(`${prefix}${character}...`, "utf8") > MAX_LABEL_BYTES) break;
    prefix += character;
  }
  return `${prefix}...`;
}

function boundedResult<T>(result: T): T {
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_RESULT_BYTES) {
    throw new MergeApplicationServiceError(
      "MERGE_APPLICATION_FAILED",
      `Merge application result exceeds the ${MAX_RESULT_BYTES}-byte limit`
    );
  }
  return result;
}
