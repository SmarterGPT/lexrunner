import { describe, expect, it, vi } from "vitest";

import {
  MergeApplicationService,
  type MergeApplicationRuntime,
} from "../../src/application/merge-application-service.js";
import type { Plan } from "../../src/schema.js";
import {
  createLocalResumeCheckpoint,
  LocalWeaveResumeDriver,
} from "../../src/weave/local-resume-driver.js";

describe("MergeApplicationService", () => {
  it("proves dry-run cannot observe, prepare, or mutate the runtime", async () => {
    const runtime = mockedRuntime();
    const result = await new MergeApplicationService(runtime).run({
      plan: fixturePlan(),
      workingDir: "/repo",
      dryRun: true,
      mutationAuthorized: false,
    });
    expect(result.summary).toMatchObject({
      contract: "bounded-ax-v1",
      mode: "dry-run",
      dryRun: true,
      ok: true,
      status: "preview",
      levels: [["one"], ["two"]],
    });
    expect(runtime.isClean).not.toHaveBeenCalled();
    expect(runtime.prepare).not.toHaveBeenCalled();
    expect(runtime.resume).not.toHaveBeenCalled();
  });

  it("rejects mutation without explicit authority", async () => {
    const runtime = mockedRuntime();
    await expect(
      new MergeApplicationService(runtime).run({
        plan: fixturePlan(),
        workingDir: "/repo",
        dryRun: false,
        mutationAuthorized: false,
      })
    ).rejects.toMatchObject({ code: "MERGE_MUTATION_DENIED" });
    expect(runtime.prepare).not.toHaveBeenCalled();
  });

  it("rejects multi-repository plans before runtime or persisted-resume admission", async () => {
    const runtime = mockedRuntime();
    const plan = fixturePlan();
    plan.items[0]!.name = "SmarterGPT/lex#PR-1";

    await expect(
      new MergeApplicationService(runtime).run({
        plan,
        workingDir: "/repo",
        dryRun: false,
        mutationAuthorized: true,
      })
    ).rejects.toMatchObject({ code: "MERGE_MULTI_REPO_UNSUPPORTED" });
    expect(runtime.isClean).not.toHaveBeenCalled();
    expect(runtime.prepare).not.toHaveBeenCalled();
    expect(runtime.resume).not.toHaveBeenCalled();

    await expect(
      createLocalResumeCheckpoint({ plan, workingDir: "/missing-repository" })
    ).rejects.toMatchObject({ code: "PLAN_MULTI_REPO_EXECUTION_UNSUPPORTED" });
    await expect(
      new LocalWeaveResumeDriver(process.cwd()).validate({ plan } as any)
    ).resolves.toMatchObject({ valid: false, reason: expect.stringContaining("multi-repository") });
  });

  it("returns bounded operation evidence from the shared executor", async () => {
    const runtime = mockedRuntime();
    const result = await new MergeApplicationService(runtime).run({
      plan: fixturePlan(),
      workingDir: "/repo",
      dryRun: false,
      mutationAuthorized: true,
    });
    expect(result.summary).toMatchObject({
      mode: "execute",
      dryRun: false,
      ok: true,
      status: "completed",
      runId: "run-1",
      artifactRefs: [{ kind: "weave-checkpoint", id: "run-1" }],
      operations: [{ status: "completed", evidenceRef: "abc123" }],
    });
  });

  it("maps stale inputs and conflict evidence to stable codes", async () => {
    const dirty = mockedRuntime();
    vi.mocked(dirty.isClean).mockResolvedValue(false);
    await expect(
      new MergeApplicationService(dirty).run({
        plan: fixturePlan(),
        workingDir: "/repo",
        dryRun: false,
        mutationAuthorized: true,
      })
    ).rejects.toMatchObject({ code: "MERGE_STALE_INPUT" });

    const conflict = mockedRuntime();
    vi.mocked(conflict.resume).mockResolvedValue({
      result: { ok: false, code: "operation_failed", runId: "run-1", reason: "failed" },
      operations: [operation("failed", "merge conflict in app.ts")],
    });
    const result = await new MergeApplicationService(conflict).run({
      plan: fixturePlan(),
      workingDir: "/repo",
      dryRun: false,
      mutationAuthorized: true,
    });
    expect(result.summary).toMatchObject({ ok: false, failureCode: "MERGE_CONFLICT" });
  });
});

function mockedRuntime(): MergeApplicationRuntime {
  return {
    isClean: vi.fn(async () => true),
    prepare: vi.fn(async () => "run-1"),
    resume: vi.fn(async () => ({
      result: {
        ok: true as const,
        outcome: "completed" as const,
        runId: "run-1",
        revision: 1,
        completed: 1,
        pending: 0,
        failed: 0,
      },
      operations: [operation("completed")],
    })),
  };
}

function operation(status: "completed" | "failed", error?: string) {
  return {
    id: "merge-one",
    phase: "merge" as const,
    item: "one",
    level: 0,
    dependsOn: [],
    status,
    attempts: 1,
    ...(error ? { error } : {}),
    ...(status === "completed" ? { result: { externalId: "abc123" } } : {}),
  };
}

function fixturePlan(): Plan {
  return {
    schemaVersion: "1.0.0",
    target: "main",
    items: [
      { name: "one", deps: [], gates: [] },
      { name: "two", deps: ["one"], gates: [] },
    ],
  };
}
