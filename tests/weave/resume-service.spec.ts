import { existsSync } from "node:fs";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalJSONStringify } from "../../src/util/canonicalJson.js";
import { sha256 } from "../../src/util/hash.js";
import {
  createResumeJournal,
  resumePersistedWeave,
  type WeaveResumeDriver,
} from "../../src/weave/resume-service.js";
import {
  acquireCheckpointExecutionLease,
  loadCheckpoint,
  saveCheckpoint,
} from "../../src/weave/checkpoint/storage.js";
import type { WeaveCheckpoint } from "../../src/weave/checkpoint/types.js";
import { WeaveState } from "../../src/weave/types.js";
import {
  createLocalResumeCheckpoint,
  LocalWeaveResumeDriver,
} from "../../src/weave/local-resume-driver.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("persisted merge-weave resume service", () => {
  it("refuses a retained Bitbucket checkpoint before driver calls, lease writes or local execution", async () => {
    const checkpointDir = await sandbox();
    const value = checkpoint();
    value.plan.gitInputs = {
      schemaVersion: "1.0.0",
      repository: "https://bitbucket.org/team/project.git",
      checkoutRemote: "origin",
      acquisition: "fetch",
      target: { ref: "refs/heads/main", commit: "a".repeat(40) },
      sources: [{ item: "item-a", ref: "refs/heads/feature", commit: "b".repeat(40) }],
    };
    value.metadata!.resume!.repository.targetHeadSha = "a".repeat(40);
    value.metadata!.resume!.repository.sourceHeads["item-a"] = "b".repeat(40);
    value.planHash = sha256(Buffer.from(canonicalJSONStringify(value.plan)));
    await saveCheckpoint(value, { checkpointDir, skipCleanup: true });
    const beforeFiles = await readdir(checkpointDir);
    const beforeBytes = await readFile(join(checkpointDir, "run-resume.json"));
    const driver = { preflight: vi.fn(), validate: vi.fn(), observe: vi.fn(), execute: vi.fn() };
    await expect(
      resumePersistedWeave({ runId: value.runId, checkpointDir, driver })
    ).resolves.toMatchObject({
      ok: false,
      code: "external_state_mismatch",
      reason: expect.stringContaining("planning only"),
    });
    for (const method of Object.values(driver)) expect(method).not.toHaveBeenCalled();
    const local = new LocalWeaveResumeDriver(checkpointDir);
    expect(local.preflight(value)).toMatchObject({
      valid: false,
      reason: expect.stringContaining("planning only"),
    });
    await expect(local.execute(value.metadata!.resume!.operations[0]!, value)).rejects.toThrow(
      "planning only"
    );
    await expect(
      createLocalResumeCheckpoint({ plan: value.plan, workingDir: checkpointDir })
    ).rejects.toThrow("planning only");
    expect(await readdir(checkpointDir)).toEqual(beforeFiles);
    expect(await readFile(join(checkpointDir, "run-resume.json"))).toEqual(beforeBytes);
  });

  it("does not create a missing checkpoint directory during preflight", async () => {
    const root = await sandbox();
    const checkpointDir = join(root, ".lexrunner", "checkpoints");
    const validate = vi.fn(async () => ({ valid: true as const }));

    await expect(
      resumePersistedWeave({
        runId: "missing-run",
        checkpointDir,
        driver: {
          validate,
          observe: async () => ({ state: "pending" }),
          execute: async () => ({ completed: true }),
        },
      })
    ).resolves.toMatchObject({ ok: false, code: "checkpoint_invalid" });

    expect(validate).not.toHaveBeenCalled();
    expect(existsSync(checkpointDir)).toBe(false);
  });

  it("uses legacy driver validation before creating an execution lease", async () => {
    const checkpointDir = await sandbox();
    await saveCheckpoint(checkpoint(), { checkpointDir, skipCleanup: true });
    const lockPath = join(checkpointDir, "run-resume.json.resume.lock");
    const validate = vi.fn(async () => {
      expect(existsSync(lockPath)).toBe(false);
      return { valid: false as const, reason: "legacy driver rejected the checkpoint" };
    });
    const driver: WeaveResumeDriver = {
      validate,
      observe: async () => ({ state: "pending" }),
      execute: async () => ({ completed: true }),
    };

    await expect(
      resumePersistedWeave({ runId: "run-resume", checkpointDir, driver })
    ).resolves.toEqual({
      ok: false,
      code: "external_state_mismatch",
      runId: "run-resume",
      reason: "legacy driver rejected the checkpoint",
    });

    expect(validate).toHaveBeenCalledTimes(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("repeats legacy driver validation after the guarded reload", async () => {
    const checkpointDir = await sandbox();
    await saveCheckpoint(checkpoint(), { checkpointDir, skipCleanup: true });
    const lockPath = join(checkpointDir, "run-resume.json.resume.lock");
    const lockStates: boolean[] = [];
    const validate = vi.fn(async () => {
      lockStates.push(existsSync(lockPath));
      return { valid: true as const };
    });
    const driver: WeaveResumeDriver = {
      validate,
      observe: async () => ({ state: "pending" }),
      execute: async () => ({ completed: true }),
    };

    await expect(
      resumePersistedWeave({
        runId: "run-resume",
        checkpointDir,
        driver,
        maxOperations: 0,
      })
    ).resolves.toMatchObject({ ok: true, outcome: "paused" });

    expect(validate).toHaveBeenCalledTimes(2);
    expect(lockStates).toEqual([false, true]);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("continues gate, merge, and post-check operations and persists every boundary", async () => {
    const checkpointDir = await sandbox();
    await saveCheckpoint(checkpoint(), { checkpointDir, skipCleanup: true });
    const executed: string[] = [];
    const driver = passingDriver(executed);

    await expect(
      resumePersistedWeave({ runId: "run-resume", checkpointDir, driver })
    ).resolves.toMatchObject({
      ok: true,
      outcome: "completed",
      completed: 3,
      pending: 0,
      failed: 0,
    });

    expect(executed).toEqual(["gate:item-a:test", "merge:item-a", "post_check:test"]);
    const persisted = await loadCheckpoint("run-resume", {
      checkpointDir,
      validatePlanHash: false,
    });
    expect(persisted).toMatchObject({
      phase: "complete",
      state: WeaveState.COMPLETED,
      completedItems: ["gate:item-a:test", "merge:item-a", "post_check:test"],
      metadata: { resume: { revision: 7 } },
    });
  });

  it("pauses at an exact boundary and does not repeat completed work", async () => {
    const checkpointDir = await sandbox();
    await saveCheckpoint(checkpoint(), { checkpointDir, skipCleanup: true });
    const executed: string[] = [];
    const driver = passingDriver(executed);

    await expect(
      resumePersistedWeave({
        runId: "run-resume",
        checkpointDir,
        driver,
        maxOperations: 1,
      })
    ).resolves.toMatchObject({ ok: true, outcome: "paused", completed: 1, pending: 2 });
    await expect(
      resumePersistedWeave({ runId: "run-resume", checkpointDir, driver })
    ).resolves.toMatchObject({ ok: true, outcome: "completed", completed: 3 });

    expect(executed).toEqual(["gate:item-a:test", "merge:item-a", "post_check:test"]);
  });

  it("rejects a local preflight mismatch before creating an execution lease", async () => {
    const checkpointDir = await sandbox();
    await saveCheckpoint(checkpoint(), { checkpointDir, skipCleanup: true });
    const lockPath = join(checkpointDir, "run-resume.json.resume.lock");
    const validate = vi.fn(async () => ({ valid: true as const }));
    const preflight = vi.fn(async () => {
      expect(existsSync(lockPath)).toBe(false);
      return { valid: false as const, reason: "checkpoint is bound to another repository" };
    });
    const driver: WeaveResumeDriver = {
      preflight,
      validate,
      observe: async () => ({ state: "pending" }),
      execute: async () => ({ completed: true }),
    };

    await expect(
      resumePersistedWeave({ runId: "run-resume", checkpointDir, driver })
    ).resolves.toEqual({
      ok: false,
      code: "external_state_mismatch",
      runId: "run-resume",
      reason: "checkpoint is bound to another repository",
    });

    expect(preflight).toHaveBeenCalledTimes(1);
    expect(validate).not.toHaveBeenCalled();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("re-reads and revalidates the checkpoint after acquiring the lease", async () => {
    const checkpointDir = await sandbox();
    await saveCheckpoint(checkpoint(), { checkpointDir, skipCleanup: true });
    const lockPath = join(checkpointDir, "run-resume.json.resume.lock");
    const validate = vi.fn(async () => ({ valid: true as const }));
    const preflight = vi.fn(async () => {
      const changed = checkpoint();
      changed.planHash = "changed-between-preflight-and-lease";
      await saveCheckpoint(changed, { checkpointDir, skipCleanup: true });
      return { valid: true as const };
    });
    const driver: WeaveResumeDriver = {
      preflight,
      validate,
      observe: async () => ({ state: "pending" }),
      execute: async () => ({ completed: true }),
    };

    await expect(
      resumePersistedWeave({ runId: "run-resume", checkpointDir, driver })
    ).resolves.toMatchObject({ ok: false, code: "checkpoint_invalid" });

    expect(preflight).toHaveBeenCalledTimes(1);
    expect(validate).not.toHaveBeenCalled();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("observes a merge completed between side effect and checkpoint write", async () => {
    const checkpointDir = await sandbox();
    const value = checkpoint();
    const operations = value.metadata!.resume!.operations;
    operations[0].status = "completed";
    operations[0].result = { outcome: "executed", externalId: "gate-receipt" };
    operations[1].status = "in_progress";
    operations[1].attempts = 1;
    await saveCheckpoint(value, { checkpointDir, skipCleanup: true });
    const execute = vi.fn();
    const driver: WeaveResumeDriver = {
      validate: async () => ({ valid: true }),
      observe: async (operation) =>
        operation.id === "merge:item-a"
          ? { state: "completed", externalId: "merge-sha" }
          : { state: "pending" },
      execute: async (operation) => {
        execute(operation.id);
        return { completed: true, externalId: `${operation.id}-receipt` };
      },
    };

    await expect(
      resumePersistedWeave({ runId: "run-resume", checkpointDir, driver })
    ).resolves.toMatchObject({ ok: true, outcome: "completed" });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith("post_check:test");
    const persisted = await loadCheckpoint("run-resume", {
      checkpointDir,
      validatePlanHash: false,
    });
    expect(persisted.metadata?.resume?.operations[1].result).toEqual({
      outcome: "observed",
      externalId: "merge-sha",
    });
  });

  it("fails closed when an interrupted operation cannot be reconciled", async () => {
    const checkpointDir = await sandbox();
    const value = checkpoint();
    value.metadata!.resume!.operations[0].status = "in_progress";
    await saveCheckpoint(value, { checkpointDir, skipCleanup: true });
    const driver: WeaveResumeDriver = {
      validate: async () => ({ valid: true }),
      observe: async () => ({ state: "ambiguous", reason: "gate result was not persisted" }),
      execute: async () => ({ completed: true }),
    };

    await expect(
      resumePersistedWeave({ runId: "run-resume", checkpointDir, driver })
    ).resolves.toEqual({
      ok: false,
      code: "ambiguous_external_state",
      runId: "run-resume",
      operationId: "gate:item-a:test",
      reason: "gate result was not persisted",
    });
  });

  it("retries only after observing that a failed side effect is still pending", async () => {
    const checkpointDir = await sandbox();
    const value = checkpoint();
    value.metadata!.resume!.operations[0].status = "failed";
    value.metadata!.resume!.operations[0].attempts = 1;
    value.metadata!.resume!.operations[0].error = "transient failure";
    await saveCheckpoint(value, { checkpointDir, skipCleanup: true });
    const executed: string[] = [];
    const driver = passingDriver(executed);

    await expect(
      resumePersistedWeave({ runId: "run-resume", checkpointDir, driver })
    ).resolves.toMatchObject({ ok: true, outcome: "completed" });

    const persisted = await loadCheckpoint("run-resume", {
      checkpointDir,
      validatePlanHash: false,
    });
    expect(persisted.metadata?.resume?.operations[0]).toMatchObject({
      status: "completed",
      attempts: 2,
    });
  });

  it("rejects corrupt plan identity and concurrent resume processes", async () => {
    const checkpointDir = await sandbox();
    const value = checkpoint();
    value.planHash = "wrong";
    await saveCheckpoint(value, { checkpointDir, skipCleanup: true });

    await expect(
      resumePersistedWeave({
        runId: "run-resume",
        checkpointDir,
        driver: passingDriver([]),
      })
    ).resolves.toMatchObject({ ok: false, code: "checkpoint_invalid" });

    value.planHash = sha256(Buffer.from(canonicalJSONStringify(value.plan)));
    await saveCheckpoint(value, { checkpointDir, skipCleanup: true });
    const lease = acquireCheckpointExecutionLease("run-resume", checkpointDir);
    if (!lease) throw new Error("expected test lease");
    try {
      await expect(
        resumePersistedWeave({
          runId: "run-resume",
          checkpointDir,
          driver: passingDriver([]),
        })
      ).resolves.toMatchObject({ ok: false, code: "checkpoint_busy" });
    } finally {
      lease.release();
    }
  });
});

function passingDriver(executed: string[]): WeaveResumeDriver {
  return {
    validate: async () => ({ valid: true }),
    observe: async () => ({ state: "pending" }),
    execute: async (operation) => {
      executed.push(operation.id);
      return { completed: true, externalId: `${operation.id}-receipt` };
    },
  };
}

function checkpoint(): WeaveCheckpoint {
  const plan = {
    schemaVersion: "1.0.0" as const,
    target: "main",
    policy: {
      requiredGates: ["test"],
      optionalGates: [],
      maxWorkers: 1,
      retries: {},
      overrides: {},
      blockOn: [],
      mergeRule: { type: "strict-required" as const },
    },
    items: [
      {
        name: "item-a",
        deps: [],
        gates: [
          { name: "test", run: "npm test", env: {}, runtime: "local" as const, artifacts: [] },
        ],
      },
    ],
  };
  const at = "2026-07-19T12:00:00.000Z";
  return {
    runId: "run-resume",
    timestamp: at,
    phase: "gates",
    state: WeaveState.PAUSED,
    planHash: sha256(Buffer.from(canonicalJSONStringify(plan))),
    plan,
    completedItems: [],
    pendingItems: ["gate:item-a:test", "merge:item-a", "post_check:test"],
    failedItems: [],
    currentBatchIndex: 0,
    totalBatches: 1,
    successfulMerges: 0,
    failedMerges: 0,
    startedAt: at,
    lastUpdatedAt: at,
    metadata: {
      target: "main",
      resume: createResumeJournal({
        operations: [
          { id: "gate:item-a:test", phase: "gate", item: "item-a" },
          { id: "merge:item-a", phase: "merge", item: "item-a" },
          { id: "post_check:test", phase: "post_check", item: "item-a" },
        ],
        target: "main",
        targetHeadSha: "base-sha",
        integrationBranch: "weave/resume-run-resume",
        sourceHeads: { "item-a": "source-sha" },
      }),
    },
  };
}

async function sandbox(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lexrunner-resume-service-"));
  roots.push(root);
  return root;
}
