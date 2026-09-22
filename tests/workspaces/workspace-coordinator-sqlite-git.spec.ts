import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ControllerLeaseCredential } from "../../src/store/coordination-store.js";
import { SqliteWorkspaceLifecycleStore } from "../../src/store/sqlite/workspace-lifecycle-store.js";
import { NodeGitWorktreeBroker } from "../../src/workspaces/node-git-worktree-broker.js";
import { WorkspaceCoordinator } from "../../src/workspaces/workspace-coordinator.js";

const RUN_ID = "run-integration";
const ATTEMPT_ID = "attempt-integration";
const LEASE_ID = "workspace-integration";
const T0 = "2026-07-11T20:00:00.000Z";
const T1 = "2026-07-11T20:00:01.000Z";
const T2 = "2026-07-11T20:00:02.000Z";
const T3 = "2026-07-11T20:00:03.000Z";
const T4 = "2026-07-11T20:00:04.000Z";

describe("WorkspaceCoordinator SQLite and real Git integration", () => {
  let sandbox: string;
  let repositoryRoot: string;
  let worktreeRoot: string;
  let worktreePath: string;
  let baseSha: string;
  let store: SqliteWorkspaceLifecycleStore;
  let coordinator: WorkspaceCoordinator;
  let controller: ControllerLeaseCredential;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "lexrunner coordinator "));
    repositoryRoot = join(sandbox, "repository");
    worktreeRoot = join(sandbox, "worktrees");
    worktreePath = join(worktreeRoot, "attempt workspace");
    await mkdir(repositoryRoot);
    await mkdir(worktreeRoot);
    await git(repositoryRoot, "init", "-b", "main");
    await git(repositoryRoot, "config", "user.name", "LexRunner Integration");
    await git(repositoryRoot, "config", "user.email", "lexrunner@example.invalid");
    await git(repositoryRoot, "config", "commit.gpgsign", "false");
    await writeFile(join(repositoryRoot, "tracked.txt"), "base\n", "utf8");
    await git(repositoryRoot, "add", "tracked.txt");
    await git(repositoryRoot, "commit", "-m", "initial");
    baseSha = await gitStdout(repositoryRoot, "rev-parse", "HEAD");

    store = new SqliteWorkspaceLifecycleStore(join(sandbox, "coordinator.db"));
    const acquired = await store.acquireControllerLease({
      runId: RUN_ID,
      controllerId: "controller-integration",
      leaseId: "controller-lease-integration",
      now: T0,
      ttlMs: 60_000,
      initialState: {},
    });
    if (!acquired.acquired) throw new Error("controller setup failed");
    controller = {
      runId: RUN_ID,
      controllerId: acquired.lease.controllerId,
      leaseId: acquired.lease.leaseId,
      fencingToken: acquired.lease.fencingToken,
    };
    const created = await store.createAttempt({
      runId: RUN_ID,
      expectedRunRevision: 0,
      controller,
      mutationId: "attempt-create",
      now: T0,
      attemptId: ATTEMPT_ID,
      workItemId: "work-integration",
      workItemRevision: 1,
      packetId: "packet-integration",
      packetHash: `sha256:${"b".repeat(64)}`,
      baseSha,
    });
    if (!created.updated) throw new Error(`attempt setup failed: ${created.reason}`);

    coordinator = new WorkspaceCoordinator(
      store,
      new NodeGitWorktreeBroker({
        repositoryId: "repo-integration",
        repositoryRoot,
        worktreeRoot,
        hostId: "host-integration",
        gitRuntime: "git-linux-integration",
        pathComparison: "case-sensitive",
      })
    );
  });

  afterEach(async () => {
    await store.close();
    await rm(sandbox, { recursive: true, force: true });
  });

  it("allocates and releases through durable phase boundaries", async () => {
    const allocated = await allocate(
      coordinator,
      controller,
      baseSha,
      repositoryRoot,
      worktreePath
    );
    expect(allocated).toMatchObject({
      ok: true,
      outcome: "active",
      attempt: { revision: 2 },
      workspaceLease: { revision: 1, status: "active" },
    });
    expect(await readFile(join(worktreePath, "tracked.txt"), "utf8")).toBe("base\n");

    const released = await coordinator.release({
      runId: RUN_ID,
      expectedRunRevision: 0,
      controller,
      attemptId: ATTEMPT_ID,
      workspaceLeaseId: LEASE_ID,
      expectedAttemptRevision: 2,
      expectedWorkspaceLeaseRevision: 1,
      disposition: "integrated",
      prepareTtlMs: 10_000,
      mutations: {
        prepare: { mutationId: "release-prepare", now: T3 },
        finalize: { mutationId: "release-finalize", now: T4 },
        quarantine: { mutationId: "release-quarantine", now: T4 },
      },
    });

    expect(released).toMatchObject({
      ok: true,
      outcome: "released",
      attempt: { revision: 4 },
      workspaceLease: { revision: 3, status: "released" },
    });
    await expect(stat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await gitStdout(repositoryRoot, "rev-parse", "agent/integration")).toBe(baseSha);
    expect((await store.listWorkspaceLifecycleEvents(RUN_ID)).map((event) => event.type)).toEqual([
      "attempt_created",
      "workspace_acquired",
      "workspace_heartbeat",
      "workspace_heartbeat",
      "workspace_released",
    ]);
  });

  it("keeps dirty active work and quarantines rather than removing it", async () => {
    const allocated = await allocate(
      coordinator,
      controller,
      baseSha,
      repositoryRoot,
      worktreePath
    );
    if (!allocated.ok) throw new Error("allocation failed");
    await writeFile(join(worktreePath, "unfinished.txt"), "keep me\n", "utf8");

    const heartbeat = await coordinator.heartbeat({
      runId: RUN_ID,
      expectedRunRevision: 0,
      controller,
      attemptId: ATTEMPT_ID,
      workspaceLeaseId: LEASE_ID,
      expectedAttemptRevision: 2,
      expectedWorkspaceLeaseRevision: 1,
      ttlMs: 10_000,
      mutations: {
        heartbeat: { mutationId: "dirty-heartbeat", now: T3 },
        quarantine: { mutationId: "dirty-heartbeat-quarantine", now: T3 },
      },
    });
    expect(heartbeat).toMatchObject({
      ok: true,
      outcome: "active",
      workspaceLease: { status: "active", lastObservation: { cleanliness: "dirty" } },
    });

    const released = await coordinator.release({
      runId: RUN_ID,
      expectedRunRevision: 0,
      controller,
      attemptId: ATTEMPT_ID,
      workspaceLeaseId: LEASE_ID,
      expectedAttemptRevision: 3,
      expectedWorkspaceLeaseRevision: 2,
      disposition: "discarded",
      prepareTtlMs: 10_000,
      mutations: {
        prepare: { mutationId: "dirty-release-prepare", now: T4 },
        finalize: { mutationId: "dirty-release-finalize", now: T4 },
        quarantine: { mutationId: "dirty-release-quarantine", now: T4 },
      },
    });

    expect(released).toMatchObject({
      ok: false,
      phase: "quarantine",
      reason: "unsafe_observation",
      attempt: { status: "quarantined" },
      workspaceLease: { status: "quarantined", cleanupDisposition: "preserved" },
    });
    expect(await readFile(join(worktreePath, "unfinished.txt"), "utf8")).toBe("keep me\n");
    expect(await gitStdout(repositoryRoot, "worktree", "list", "--porcelain")).toContain(
      worktreePath
    );
  });

  it("continues release after a persisted prepare using store fingerprint replay", async () => {
    const allocated = await allocate(
      coordinator,
      controller,
      baseSha,
      repositoryRoot,
      worktreePath
    );
    if (!allocated.ok) throw new Error("allocation failed");
    const releaseInput = {
      runId: RUN_ID,
      expectedRunRevision: 0,
      controller,
      attemptId: ATTEMPT_ID,
      workspaceLeaseId: LEASE_ID,
      expectedAttemptRevision: 2,
      expectedWorkspaceLeaseRevision: 1,
      disposition: "integrated" as const,
      prepareTtlMs: 10_000,
      mutations: {
        prepare: { mutationId: "retry-release-prepare", now: T3 },
        finalize: { mutationId: "retry-release-finalize", now: T4 },
        quarantine: { mutationId: "retry-release-quarantine", now: T4 },
      },
    };
    const prepared = await store.heartbeatWorkspace({
      runId: RUN_ID,
      expectedRunRevision: 0,
      controller,
      attemptId: ATTEMPT_ID,
      workspaceLeaseId: LEASE_ID,
      expectedAttemptRevision: 2,
      expectedWorkspaceLeaseRevision: 1,
      ttlMs: 10_000,
      observation: allocated.observation,
      ...releaseInput.mutations.prepare,
    });
    expect(prepared).toMatchObject({ updated: true, idempotentReplay: false });

    const released = await coordinator.release(releaseInput);

    expect(released).toMatchObject({ ok: true, outcome: "released" });
    await expect(stat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    const prepareEvents = (await store.listWorkspaceLifecycleEvents(RUN_ID)).filter(
      (event) => event.mutationId === "retry-release-prepare"
    );
    expect(prepareEvents).toHaveLength(1);
  });

  it.each(["before", "after"] as const)(
    "retains allocation across coordinator exit %s Git removal and reopened recovery",
    async (phase) => {
      const allocated = await allocate(
        coordinator,
        controller,
        baseSha,
        repositoryRoot,
        worktreePath
      );
      if (!allocated.ok) throw new Error("allocation failed");
      const release = {
        runId: RUN_ID,
        expectedRunRevision: 0,
        controller,
        attemptId: ATTEMPT_ID,
        workspaceLeaseId: LEASE_ID,
        expectedAttemptRevision: 2,
        expectedWorkspaceLeaseRevision: 1,
        disposition: "discarded" as const,
        prepareTtlMs: 10_000,
        mutations: {
          prepare: { mutationId: "exit-prepare", now: T3 },
          finalize: { mutationId: "exit-finalize", now: T4 },
          quarantine: { mutationId: "exit-quarantine", now: T4 },
        },
      };
      const broker = {
        repositoryId: "repo-integration",
        repositoryRoot,
        worktreeRoot,
        hostId: "host-integration",
        gitRuntime: "git-linux-integration",
        pathComparison: "case-sensitive" as const,
      };
      const database = join(sandbox, "coordinator.db");
      const request = join(sandbox, "exit-request.json");
      await writeFile(request, JSON.stringify({ phase, database, broker, release }));
      await store.close();
      const child = await execa(
        process.execPath,
        ["--import", "tsx", "tests/fixtures/coordinator-removal-exit.ts", request],
        { reject: false, timeout: 20_000 }
      );
      // Reopen even if the child failed so teardown owns a live connection.
      store = new SqliteWorkspaceLifecycleStore(database);
      expect(child.stderr).toBe("");
      expect(child.exitCode).toBe(73);
      expect(await store.getWorkspaceLease(LEASE_ID)).toMatchObject({
        status: "active",
        revision: 2,
      });
      expect((await store.listWorkspaceLifecycleEvents(RUN_ID)).map((e) => e.type)).toEqual([
        "attempt_created",
        "workspace_acquired",
        "workspace_heartbeat",
        "workspace_heartbeat",
      ]);
      const created = await store.createAttempt({
        runId: RUN_ID,
        expectedRunRevision: 0,
        controller,
        mutationId: "competitor-create",
        now: T4,
        attemptId: "competitor",
        workItemId: "competitor-work",
        workItemRevision: 1,
        packetId: "competitor-packet",
        packetHash: `sha256:${"c".repeat(64)}`,
        baseSha,
      });
      expect(created.updated).toBe(true);
      const reservation = {
        runId: RUN_ID,
        expectedRunRevision: 0,
        controller,
        now: T4,
        attemptId: "competitor",
        workItemId: "competitor-work",
        expectedAttemptRevision: 0,
        workspaceLeaseId: "competitor-lease",
        ttlMs: 10_000,
        baseSha,
        repositoryId: broker.repositoryId,
        hostId: broker.hostId,
        gitRuntime: broker.gitRuntime,
        projectRoot: repositoryRoot,
        branch: "agent/integration",
        worktreePath,
      };
      async function assertReserved(prefix: string) {
        expect(
          await store.acquireWorkspace({
            ...reservation,
            mutationId: `${prefix}-branch`,
            worktreePath: join(worktreeRoot, "other"),
          })
        ).toMatchObject({ updated: false, reason: "branch_conflict" });
        expect(
          await store.acquireWorkspace({
            ...reservation,
            mutationId: `${prefix}-path`,
            branch: "agent/other",
          })
        ).toMatchObject({ updated: false, reason: "worktree_conflict" });
      }
      await assertReserved("restart");
      coordinator = new WorkspaceCoordinator(store, new NodeGitWorktreeBroker(broker));
      const recovered = await coordinator.release(release);
      expect(recovered).toMatchObject(
        phase === "before"
          ? { ok: true, outcome: "released", workspaceLease: { status: "released" } }
          : { ok: false, phase: "quarantine", workspaceLease: { status: "quarantined" } }
      );
      await expect(stat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
      await store.close();
      store = new SqliteWorkspaceLifecycleStore(database);
      if (phase === "after") await assertReserved("quarantine-reopened");
      else
        expect(
          await store.acquireWorkspace({
            ...reservation,
            mutationId: "reconciled-reuse",
          })
        ).toMatchObject({ updated: true });
      expect(
        (await store.listWorkspaceLifecycleEvents(RUN_ID)).filter(
          (e) => e.mutationId === "exit-prepare"
        )
      ).toHaveLength(1);
    },
    30_000
  );

  it("quarantines a prepared release when recovery finds the worktree already removed", async () => {
    const allocated = await allocate(
      coordinator,
      controller,
      baseSha,
      repositoryRoot,
      worktreePath
    );
    if (!allocated.ok) throw new Error("allocation failed");
    const mutations = {
      prepare: { mutationId: "crash-release-prepare", now: T3 },
      finalize: { mutationId: "crash-release-finalize", now: T4 },
      quarantine: { mutationId: "crash-release-quarantine", now: T4 },
    };
    const prepared = await store.heartbeatWorkspace({
      runId: RUN_ID,
      expectedRunRevision: 0,
      controller,
      attemptId: ATTEMPT_ID,
      workspaceLeaseId: LEASE_ID,
      expectedAttemptRevision: 2,
      expectedWorkspaceLeaseRevision: 1,
      ttlMs: 10_000,
      observation: allocated.observation,
      ...mutations.prepare,
    });
    expect(prepared).toMatchObject({ updated: true });
    await git(repositoryRoot, "worktree", "remove", worktreePath);

    const recovered = await coordinator.release({
      runId: RUN_ID,
      expectedRunRevision: 0,
      controller,
      attemptId: ATTEMPT_ID,
      workspaceLeaseId: LEASE_ID,
      expectedAttemptRevision: 2,
      expectedWorkspaceLeaseRevision: 1,
      disposition: "discarded",
      prepareTtlMs: 10_000,
      mutations,
    });

    expect(recovered).toMatchObject({
      ok: false,
      phase: "quarantine",
      attempt: { status: "quarantined" },
      workspaceLease: { status: "quarantined", cleanupDisposition: "preserved" },
    });
    await expect(stat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function allocate(
  coordinator: WorkspaceCoordinator,
  controller: ControllerLeaseCredential,
  baseSha: string,
  repositoryRoot: string,
  worktreePath: string
) {
  return coordinator.allocate({
    runId: RUN_ID,
    expectedRunRevision: 0,
    controller,
    ttlMs: 10_000,
    reservation: {
      attemptId: ATTEMPT_ID,
      workspaceLeaseId: LEASE_ID,
      workItemId: "work-integration",
      expectedAttemptRevision: 0,
      repositoryId: "repo-integration",
      hostId: "host-integration",
      gitRuntime: "git-linux-integration",
      projectRoot: repositoryRoot,
      branch: "agent/integration",
      worktreePath,
      baseSha,
    },
    mutations: {
      reserve: { mutationId: "allocate-reserve", now: T1 },
      activate: { mutationId: "allocate-activate", now: T2 },
      quarantine: { mutationId: "allocate-quarantine", now: T2 },
    },
  });
}

async function git(cwd: string, ...args: string[]) {
  await execa("git", args, { cwd });
}

async function gitStdout(cwd: string, ...args: string[]) {
  return (await execa("git", args, { cwd })).stdout.trim();
}
