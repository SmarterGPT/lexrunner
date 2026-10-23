import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { simpleGit, type SimpleGit } from "simple-git";
import { ulid } from "ulid";

import { executeGate } from "../gates.js";
import {
  assertSingleRepositoryPlan,
  bindPlanGateWorkingDirectories,
} from "../application/repository-binding.js";
import { GitOperations } from "../git/operations.js";
import { computeMergeOrder } from "../mergeOrder.js";
import { Policy, Plan, type Gate } from "../schema.js";
import { verifyFrozenGitInputs } from "../git/frozen-inputs.js";
import { canonicalJSONStringify } from "../util/canonicalJson.js";
import { sha256 } from "../util/hash.js";
import { WeaveState } from "./types.js";
import {
  createResumeJournal,
  planResumeOperations,
  type WeaveResumeDriver,
} from "./resume-service.js";
import type { ResumeOperation, WeaveCheckpoint } from "./checkpoint/types.js";

export async function createLocalResumeCheckpoint(input: {
  plan: Plan;
  workingDir?: string;
  runId?: string;
  now?: string;
}): Promise<WeaveCheckpoint> {
  Plan.parse(input.plan);
  assertSingleRepositoryPlan(input.plan);
  const workingDir = input.workingDir ?? process.cwd();
  bindPlanGateWorkingDirectories(input.plan, workingDir);
  const git = simpleGit(workingDir);
  const runId = input.runId ?? ulid();
  const at = input.now ?? new Date().toISOString();
  const levels = computeMergeOrder(input.plan);
  const sourceHeads: Record<string, string> = Object.create(null);
  let targetHeadSha: string;
  if (input.plan.gitInputs) {
    const status = await git.status();
    if (status.files.some(isUnexpectedBoundChange)) {
      throw new Error("Working tree must be clean before acquiring frozen Git inputs");
    }
    const verified = await verifyFrozenGitInputs(git, input.plan.gitInputs);
    Object.assign(sourceHeads, verified.sourceHeads);
    targetHeadSha = verified.targetHeadSha;
  } else {
    for (const item of input.plan.items)
      sourceHeads[item.name] = await exactRefHead(git, item.name);
    targetHeadSha = await exactRefHead(git, input.plan.target);
  }
  const integrationBranch = `weave/resume-${runId.toLowerCase()}`;
  const operations = planResumeOperations(input.plan);
  const planHash = sha256(Buffer.from(canonicalJSONStringify(input.plan)));

  return {
    runId,
    timestamp: at,
    phase: operations[0]?.phase === "gate" ? "gates" : "merge",
    state: WeaveState.READY,
    planHash,
    plan: input.plan,
    completedItems: [],
    pendingItems: operations.map((operation) => operation.id),
    failedItems: [],
    currentBatchIndex: 0,
    totalBatches: levels.length,
    successfulMerges: 0,
    failedMerges: 0,
    startedAt: at,
    lastUpdatedAt: at,
    metadata: {
      target: input.plan.target,
      warnings: input.plan.gitInputs
        ? []
        : ["Legacy unbound plan: Git heads are selected at preparation, not frozen at synthesis"],
      resume: createResumeJournal({
        operations,
        target: input.plan.target,
        targetHeadSha,
        integrationBranch,
        sourceHeads,
      }),
    },
  };
}

/** Local Git/gate adapter for the canonical resume service. */
export class LocalWeaveResumeDriver implements WeaveResumeDriver {
  private readonly git: SimpleGit;
  private readonly operations: GitOperations;

  constructor(private readonly workingDir: string = process.cwd()) {
    this.git = simpleGit(workingDir);
    this.operations = new GitOperations(workingDir);
  }

  preflight(
    checkpoint: Readonly<WeaveCheckpoint>
  ): { valid: true } | { valid: false; reason: string } {
    try {
      assertSingleRepositoryPlan(checkpoint.plan);
    } catch {
      return {
        valid: false,
        reason: "multi-repository checkpoints cannot resume in a single repository worktree",
      };
    }
    try {
      bindPlanGateWorkingDirectories(checkpoint.plan, this.workingDir);
    } catch {
      return {
        valid: false,
        reason: "checkpoint gate working directories are not bound to this repository",
      };
    }
    return { valid: true };
  }

  async validate(
    checkpoint: WeaveCheckpoint
  ): Promise<{ valid: true } | { valid: false; reason: string }> {
    const preflight = this.preflight(checkpoint);
    if (!preflight.valid) return preflight;
    const journal = checkpoint.metadata?.resume;
    if (!journal) return { valid: false, reason: "resume journal is missing" };
    try {
      const status = await this.git.status();
      const unexpectedChanges = status.files.filter(
        checkpoint.plan.gitInputs
          ? isUnexpectedBoundChange
          : (file) => !isRunnerStatePath(file.path)
      );
      if (unexpectedChanges.length > 0) {
        return {
          valid: false,
          reason: "working tree is not clean; resolve or abort the interrupted operation first",
        };
      }
      if (checkpoint.plan.gitInputs) {
        const verified = await verifyFrozenGitInputs(this.git, checkpoint.plan.gitInputs);
        if (
          verified.targetHeadSha !== journal.repository.targetHeadSha ||
          Object.entries(verified.sourceHeads).some(
            ([name, commit]) => journal.repository.sourceHeads[name] !== commit
          )
        ) {
          return { valid: false, reason: "Journal commit evidence differs from frozen Git inputs" };
        }
      } else {
        const targetHead = await exactRefHead(this.git, journal.repository.target);
        if (targetHead !== journal.repository.targetHeadSha) {
          return { valid: false, reason: "target branch changed after the checkpoint was created" };
        }
        for (const [name, expected] of Object.entries(journal.repository.sourceHeads)) {
          if ((await exactRefHead(this.git, name)) !== expected) {
            return {
              valid: false,
              reason: `source branch ${name} changed after checkpoint creation`,
            };
          }
        }
      }
      const integrationHead = await localBranchHead(this.git, journal.repository.integrationBranch);
      if (integrationHead) {
        const expected =
          lastCompletedMergeSha(journal.operations) ?? journal.repository.targetHeadSha;
        const interrupted = journal.operations.find(
          (operation) => operation.status === "in_progress" || operation.status === "failed"
        );
        const interruptedSource = interrupted
          ? journal.repository.sourceHeads[interrupted.item]
          : undefined;
        const interruptedMergeCompleted =
          interrupted?.phase === "merge" &&
          !!interruptedSource &&
          (await isAncestor(this.git, interruptedSource, integrationHead));
        if (integrationHead !== expected && !interruptedMergeCompleted) {
          return {
            valid: false,
            reason: "integration branch does not match the last persisted merge boundary",
          };
        }
      }
      return { valid: true };
    } catch (error) {
      return { valid: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async observe(operation: Readonly<ResumeOperation>, checkpoint: Readonly<WeaveCheckpoint>) {
    if (operation.phase !== "merge") {
      if (operation.status === "failed") return { state: "pending" as const };
      return {
        state: "ambiguous" as const,
        reason: `${operation.phase} execution was interrupted without a durable result`,
      };
    }
    const journal = checkpoint.metadata!.resume!;
    const integration = journal.repository.integrationBranch;
    const integrationHead = await localBranchHead(this.git, integration);
    if (!integrationHead) return { state: "pending" as const };
    const sourceHead = journal.repository.sourceHeads[operation.item];
    if (!sourceHead) {
      return { state: "ambiguous" as const, reason: "source head evidence is missing" };
    }
    if (await isAncestor(this.git, sourceHead, integrationHead)) {
      return { state: "completed" as const, externalId: integrationHead };
    }
    const expected = lastCompletedMergeSha(journal.operations) ?? journal.repository.targetHeadSha;
    if (integrationHead === expected) return { state: "pending" as const };
    return {
      state: "ambiguous" as const,
      reason: "integration branch changed without proving the interrupted merge",
    };
  }

  async execute(operation: Readonly<ResumeOperation>, checkpoint: Readonly<WeaveCheckpoint>) {
    try {
      bindPlanGateWorkingDirectories(checkpoint.plan, this.workingDir);
    } catch {
      return {
        completed: false as const,
        reason: "checkpoint gate working directories are not bound to this repository",
      };
    }
    const journal = checkpoint.metadata!.resume!;
    const bound = !!checkpoint.plan.gitInputs;
    const expectedIntegration =
      lastCompletedMergeSha(journal.operations) ?? journal.repository.targetHeadSha;
    if (bound) {
      const stateError = await this.boundStateError();
      if (stateError) return { completed: false as const, reason: stateError };
      const integrationHead = await localBranchHead(this.git, journal.repository.integrationBranch);
      if (
        (integrationHead && integrationHead !== expectedIntegration) ||
        (!integrationHead && lastCompletedMergeSha(journal.operations))
      ) {
        return {
          completed: false as const,
          reason: "Frozen integration branch changed before operation; preserve and inspect it",
        };
      }
    }
    await this.ensureIntegrationBranch(
      journal.repository.integrationBranch,
      journal.repository.targetHeadSha
    );

    if (operation.phase === "merge") {
      await this.git.checkout(journal.repository.integrationBranch);
      if (bound) {
        const stateError = await this.boundStateError(expectedIntegration);
        if (stateError) return { completed: false as const, reason: stateError };
      }
      const item = checkpoint.plan.items.find((candidate) => candidate.name === operation.item);
      if (!item) return { completed: false as const, reason: "plan item is missing" };
      const result = await this.operations.executeMergeOperation({
        item,
        targetBranch: journal.repository.integrationBranch,
        strategy: "merge-weave",
        ...(checkpoint.plan.gitInputs
          ? { sourceCommit: journal.repository.sourceHeads[operation.item] }
          : {}),
      });
      if (bound && result.success && result.sha) {
        const stateError = await this.boundStateError(result.sha);
        if (stateError) return { completed: false as const, reason: stateError };
      }
      return result.success && result.sha
        ? { completed: true as const, externalId: result.sha }
        : { completed: false as const, reason: result.message ?? "merge failed" };
    }

    const gate = gateForOperation(checkpoint.plan, operation);
    if (!gate) return { completed: false as const, reason: "gate definition is missing" };
    if (operation.phase === "gate") {
      if (checkpoint.plan.gitInputs) {
        await this.git.checkout(["--detach", journal.repository.sourceHeads[operation.item]]);
      } else {
        await this.git
          .checkout(`origin/${operation.item}`)
          .catch(() => this.git.checkout(operation.item));
      }
    } else {
      await this.git.checkout(journal.repository.integrationBranch);
    }
    const expectedGateHead =
      operation.phase === "gate"
        ? journal.repository.sourceHeads[operation.item]
        : expectedIntegration;
    if (bound) {
      const stateError = await this.boundStateError(expectedGateHead);
      if (stateError) return { completed: false as const, reason: stateError };
    }
    const artifactDir = join(
      this.workingDir,
      ".lexrunner",
      "runs",
      checkpoint.runId,
      operation.phase
    );
    await mkdir(artifactDir, { recursive: true });
    const policy = Policy.parse(checkpoint.plan.policy ?? {});
    const result = await executeGate(
      gate,
      policy,
      artifactDir,
      300_000,
      operation.item,
      false,
      this.workingDir
    );
    if (bound) {
      const stateError = await this.boundStateError(expectedGateHead);
      if (stateError) return { completed: false as const, reason: stateError };
      if (
        (await localBranchHead(this.git, journal.repository.integrationBranch)) !==
        expectedIntegration
      ) {
        return {
          completed: false as const,
          reason: "Gate changed the frozen integration branch; preserve and inspect it",
        };
      }
    }
    const receipt = result.artifacts?.find((path) =>
      /gate-execution-receipt\.attempt-\d+\.json$/.test(path)
    );
    return result.status === "pass"
      ? {
          completed: true as const,
          externalId: receipt ?? `${gate.name}:${result.lastAttempt ?? "pass"}`,
        }
      : { completed: false as const, reason: result.stderr || `gate ${gate.name} failed` };
  }

  private async ensureIntegrationBranch(branch: string, targetHeadSha: string): Promise<void> {
    if (await localBranchHead(this.git, branch)) return;
    await this.git.checkoutBranch(branch, targetHeadSha);
  }

  private async boundStateError(expectedHead?: string): Promise<string | null> {
    if (expectedHead && (await this.git.revparse(["HEAD"])).trim() !== expectedHead) {
      return "Frozen checkout HEAD changed during the operation; preserve and inspect the new commit";
    }
    const status = await this.git.status();
    if (status.files.some(isUnexpectedBoundChange)) {
      return "Frozen checkout index or working tree changed; preserve and inspect the modifications before continuing";
    }
    return null;
  }
}

function gateForOperation(plan: Plan, operation: Readonly<ResumeOperation>): Gate | undefined {
  const parts = operation.id.split(":");
  const gateName = parts[parts.length - 1];
  if (!gateName) return undefined;
  if (operation.phase === "gate") {
    return plan.items
      .find((item) => item.name === operation.item)
      ?.gates.find((gate) => gate.name === gateName);
  }
  return plan.items.flatMap((item) => item.gates).find((gate) => gate.name === gateName);
}

async function exactRefHead(git: SimpleGit, ref: string): Promise<string> {
  try {
    await git.fetch("origin", ref);
    return (await git.revparse([`origin/${ref}`])).trim();
  } catch {
    try {
      return (await git.revparse([ref])).trim();
    } catch {
      throw new Error(`branch ${ref} is unavailable`);
    }
  }
}

async function localBranchHead(git: SimpleGit, branch: string): Promise<string | null> {
  try {
    return (await git.revparse([`refs/heads/${branch}`])).trim();
  } catch {
    return null;
  }
}

async function isAncestor(git: SimpleGit, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git.raw(["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

function lastCompletedMergeSha(operations: ResumeOperation[]): string | undefined {
  return [...operations]
    .reverse()
    .find(
      (operation) =>
        operation.phase === "merge" &&
        operation.status === "completed" &&
        operation.result?.externalId
    )?.result?.externalId;
}

function isRunnerStatePath(path: string): boolean {
  return (
    path === ".lexrunner" ||
    path.startsWith(".lexrunner/") ||
    path === "weave-lock.json" ||
    path.endsWith("/weave-lock.json")
  );
}

function isUnexpectedBoundChange(file: {
  path: string;
  index: string;
  working_dir: string;
}): boolean {
  return !(file.index === "?" && file.working_dir === "?" && isRunnerStatePath(file.path));
}
