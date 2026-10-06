import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAgentTaskPacket, ExecutionEnvelope_v1 } from "../../src/schemas/agent-work.js";
import { createNativeExecutionPathMapping } from "../../src/schemas/agent-work-projection.js";
import { computeCanonicalHash } from "../../src/schemas/task-contract.js";
import {
  AgentWorkHeadlessSupervisor,
  type HeadlessSupervisorWorkerControl,
  type SupervisorWorkerLaunchResult,
} from "../../src/runs/agent-work-supervisor.js";
import { AgentWorkAttemptVerificationService } from "../../src/runs/agent-work-attempt-verification-service.js";
import type { AttemptVerificationRuntime } from "../../src/runs/agent-work-attempt-verification-runtime.js";
import { AgentWorkWorkerSessionService } from "../../src/runs/agent-work-worker-session-service.js";
import {
  AgentWorkHumanActionService,
  readHumanActionState,
} from "../../src/runs/agent-work-human-action-service.js";
import {
  AgentWorkWorkerAdapterNegotiator,
  HOST_ASSISTED_ADAPTER_MANIFEST,
  WorkerAdapterManifest_v1,
  WorkerAdapterRegistry,
} from "../../src/runs/agent-work-worker-runtime.js";
import { InMemoryWorkspaceLifecycleStore } from "../../src/store/inmemory/workspace-lifecycle-store.js";
import type { ControllerLeaseCredential, WorkspaceObservation } from "../../src/store/index.js";
import { canonicalJSONStringify } from "../../src/util/canonicalJson.js";
import { captureDirectoryIdentity } from "../../src/workspaces/linux-directory-identity.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("headless supervisor restart reconciliation", () => {
  it("blocks a prepared sibling after restart and permits explicit cancellation while held", async () => {
    const store = new InMemoryWorkspaceLifecycleStore();
    const setup = await store.acquireControllerLease({
      runId: "run-supervisor",
      controllerId: "supervisor-1",
      leaseId: "supervisor-lease-1",
      now: "2026-07-19T12:00:00.000Z",
      ttlMs: 60000,
      initialState: {
        metadata: {
          agentWorkHumanActions: {
            version: 1,
            entries: [
              {
                contextHash: `sha256:${"a".repeat(64)}`,
                receipt: null,
                request: {
                  schema_version: "1.0.0",
                  request_id: "retained-question",
                  run_id: "run-supervisor",
                  attempt_id: "previous-attempt",
                  workspace_lease_id: "previous-workspace",
                  worker_session_id: "previous-worker",
                  action: "other",
                  summary: "Resolve the retained human decision.",
                  instructions: ["Use the host human channel."],
                  suggested_commands: [],
                  requested_at: "2026-07-19T11:59:00.000Z",
                  preconditions: {
                    run_revision: 0,
                    workspace_lease_revision: 0,
                    expected_head_sha: "a".repeat(40),
                  },
                },
              },
            ],
          },
        },
      },
    });
    if (!setup.acquired) throw new Error("expected controller setup");
    await store.createAttempt({
      runId: "run-supervisor",
      expectedRunRevision: 0,
      controller: credential(setup.lease),
      mutationId: "create-held-sibling",
      now: "2026-07-19T12:00:00.000Z",
      attemptId: "attempt-supervisor",
      workItemId: "work-supervisor",
      workItemRevision: 1,
      packetId: "packet-supervisor",
      packetHash: `sha256:${"a".repeat(64)}`,
      baseSha: "a".repeat(40),
    });
    const control = new IdempotentLaunchControl();
    const observed = observation("/unused/worktree", "/unused/project");
    expect(
      await makeSupervisor(store, control, observed).reconcileRun(
        reconcileInput("2026-07-19T12:00:00.100Z")
      )
    ).toMatchObject({
      ok: true,
      humanActionCount: 1,
      attempts: [{ action: "await_human", outcome: "deferred", status: "prepared" }],
    });
    expect(control.launchEffects).toBe(0);
    expect(
      await makeSupervisor(store, control, observed).reconcileRun({
        ...reconcileInput("2026-07-19T12:00:00.200Z"),
        cancelAttemptIds: ["attempt-supervisor"],
      })
    ).toMatchObject({
      ok: true,
      humanActionCount: 1,
      attempts: [{ action: "cancel_attempt", outcome: "applied", status: "cancelled" }],
    });
    expect(control.launchEffects).toBe(0);
  });

  it("cancels durable work before a worker is attached", async () => {
    const store = new InMemoryWorkspaceLifecycleStore();
    const setup = await store.acquireControllerLease({
      runId: "run-supervisor",
      controllerId: "supervisor-1",
      leaseId: "supervisor-lease-1",
      now: "2026-07-19T12:00:00.000Z",
      ttlMs: 60_000,
      initialState: {},
    });
    if (!setup.acquired) throw new Error("expected controller setup");
    await store.createAttempt({
      runId: "run-supervisor",
      expectedRunRevision: 0,
      controller: credential(setup.lease),
      mutationId: "create-cancelled-attempt",
      now: "2026-07-19T12:00:00.000Z",
      attemptId: "attempt-supervisor",
      workItemId: "work-supervisor",
      workItemRevision: 1,
      packetId: "packet-supervisor",
      packetHash: `sha256:${"a".repeat(64)}`,
      baseSha: "a".repeat(40),
    });
    const observed = observation("/unused/worktree", "/unused/project");
    const result = await makeSupervisor(
      store,
      new IdempotentLaunchControl(),
      observed
    ).reconcileRun({
      ...reconcileInput("2026-07-19T12:00:00.100Z"),
      cancelAttemptIds: ["attempt-supervisor"],
      diagnostics: false,
    });
    if (result.ok) expect(result.attempts[0]).not.toHaveProperty("diagnostics");
    expect(result).toMatchObject({
      ok: true,
      attempts: [{ action: "cancel_attempt", outcome: "applied", status: "cancelled" }],
    });
    await expect(store.getAttempt("attempt-supervisor")).resolves.toMatchObject({
      status: "cancelled",
      completedAt: "2026-07-19T12:00:00.100Z",
    });
  });

  it.each(["resume", "cancel"])("recovers with %s after a human hold", async (recovery) => {
    const root = await mkdtemp(join(tmpdir(), "lexrunner-supervisor-"));
    roots.push(root);
    const repositoryRoot = join(root, "repository");
    const allocationRoot = join(root, "worktrees");
    const worktreePath = join(allocationRoot, "worktree");
    const projectRoot = join(worktreePath, "project");
    await Promise.all([
      mkdir(repositoryRoot, { recursive: true }),
      mkdir(projectRoot, { recursive: true }),
    ]);

    const store = new InMemoryWorkspaceLifecycleStore();
    const setup = await store.acquireControllerLease({
      runId: "run-supervisor",
      controllerId: "supervisor-1",
      leaseId: "supervisor-lease-1",
      now: "2026-07-19T12:00:00.000Z",
      ttlMs: 60_000,
      initialState: {},
    });
    if (!setup.acquired) throw new Error("expected controller setup");
    const controller = credential(setup.lease);
    const packet = createAgentTaskPacket({
      schema_version: "1.0.0",
      packet_id: "packet-supervisor",
      run_id: "run-supervisor",
      work_item: { work_item_id: "work-supervisor", revision: 1 },
      attempt_id: "attempt-supervisor",
      repository: { id: "owner/repo", base_sha: "a".repeat(40) },
      objective: "Prove restart-safe launch",
      acceptance_criteria: [],
      instructions: [],
      scope: {
        read_globs: ["**"],
        write_globs: ["project/**"],
        deny_globs: [],
        cross_repo_allowed: false,
      },
      authority: {
        edit: true,
        git_write: false,
        github_write: false,
        external_runtime: false,
        secrets: false,
        signing: false,
        release: false,
      },
      verification: [],
      budget: {},
      created_at: "2026-07-19T12:00:00.000Z",
    });
    await store.createAttempt({
      runId: "run-supervisor",
      expectedRunRevision: 0,
      controller,
      mutationId: "create-supervisor-attempt",
      now: "2026-07-19T12:00:00.000Z",
      attemptId: "attempt-supervisor",
      workItemId: "work-supervisor",
      workItemRevision: 1,
      packetId: packet.packet_id,
      packetHash: packet.packet_hash,
      baseSha: "a".repeat(40),
    });
    const observed = observation(worktreePath, repositoryRoot);
    await store.acquireWorkspace({
      runId: "run-supervisor",
      expectedRunRevision: 0,
      controller,
      mutationId: "acquire-supervisor-workspace",
      now: "2026-07-19T12:00:00.100Z",
      attemptId: "attempt-supervisor",
      expectedAttemptRevision: 0,
      workspaceLeaseId: "workspace-supervisor",
      workItemId: "work-supervisor",
      baseSha: "a".repeat(40),
      ttlMs: 60_000,
      repositoryId: "owner/repo",
      hostId: "host-supervisor",
      gitRuntime: "git-fixture",
      projectRoot: repositoryRoot,
      branch: "agent/supervisor",
      worktreePath,
      observation: observed,
    });
    await store.transitionAttempt({
      runId: "run-supervisor",
      expectedRunRevision: 0,
      controller,
      mutationId: "authorize-supervisor-launch",
      now: "2026-07-19T12:00:00.200Z",
      attemptId: "attempt-supervisor",
      expectedAttemptRevision: 1,
      status: "launching",
    });
    const envelope = ExecutionEnvelope_v1.parse({
      schema_version: "1.0.0",
      envelope_id: "envelope-supervisor",
      run_id: "run-supervisor",
      attempt_id: "attempt-supervisor",
      packet_id: packet.packet_id,
      packet_hash: packet.packet_hash,
      workspace_lease_id: "workspace-supervisor",
      workspace_lease_revision: 0,
      expected_head_sha: "a".repeat(40),
      branch: "agent/supervisor",
      runtime: {
        host_id: "host-supervisor",
        os: "linux",
        architecture: "x64",
        worker_runtime: "controlled-subprocess",
        git_runtime: "git-fixture",
      },
      paths: {
        project_root: projectRoot,
        execution_root: projectRoot,
        allocation_root: allocationRoot,
        worktree_root: worktreePath,
      },
      path_mappings: [
        createNativeExecutionPathMapping({
          schema_version: "1.0.0",
          mapping_kind: "native_linux",
          repository_id: "owner/repo",
          base_sha: "a".repeat(40),
          native_host_id: "host-supervisor",
          git_runtime: "git-fixture",
          roots: {
            native_repository: verifiedRoot("git-fixture", repositoryRoot),
            native_allocation_root: verifiedRoot("git-fixture", allocationRoot),
            native_worktree: verifiedRoot("git-fixture", worktreePath),
          },
        }),
      ],
      exposed_environment_keys: [],
      created_at: "2026-07-19T12:00:00.300Z",
    });
    await store.bindLaunchEnvelope({
      runId: "run-supervisor",
      attemptId: "attempt-supervisor",
      workspaceLeaseId: "workspace-supervisor",
      expectedRunRevision: 0,
      expectedAttemptRevision: 2,
      expectedWorkspaceLeaseRevision: 0,
      controller,
      authorizationMutationId: "authorize-supervisor-launch",
      envelopeId: envelope.envelope_id,
      envelopeHash: computeCanonicalHash(envelope),
      envelopeJson: canonicalJSONStringify(envelope),
      packetJson: canonicalJSONStringify(packet),
      createdAt: envelope.created_at,
    });

    const control = new IdempotentLaunchControl();
    const supervisor = makeSupervisor(store, control, observed);
    const first = await supervisor.reconcileRun(reconcileInput("2026-07-19T12:00:00.500Z"));
    expect(first).toMatchObject({
      ok: true,
      attempts: [{ action: "reconciliation_required", outcome: "failed" }],
    });
    expect(control.launchEffects).toBe(1);

    const restarted = makeSupervisor(store, control, observed);
    const second = await restarted.reconcileRun(reconcileInput("2026-07-19T12:00:00.600Z"));
    expect(second).toMatchObject({
      ok: true,
      attempts: [{ action: "launch_worker", outcome: "applied", status: "running" }],
    });
    expect(control.launchEffects).toBe(1);
    expect(new Set(control.operationIds).size).toBe(1);

    const heartbeat = await makeSupervisor(store, control, observed).reconcileRun(
      reconcileInput("2026-07-19T12:00:01.000Z")
    );
    expect(heartbeat).toMatchObject({
      ok: true,
      attempts: [{ action: "heartbeat_worker", outcome: "applied", status: "running" }],
    });
    expect(control.launchEffects).toBe(1);
    await expect(store.getWorkerSessionForAttempt("attempt-supervisor")).resolves.toMatchObject({
      revision: 1,
      heartbeatAt: "2026-07-19T12:00:01.000Z",
    });

    control.state = "awaiting_human";
    const held = await makeSupervisor(store, control, observed).reconcileRun(
      reconcileInput("2026-07-19T12:00:01.100Z")
    );
    expect(held).toMatchObject({
      ok: true,
      humanActionCount: 1,
      attempts: [{ action: "await_human", outcome: "deferred" }],
    });
    const pending = (await store.getRunCoordination("run-supervisor"))!;
    const request = readHumanActionState(pending.state).entries[0].request;
    // The provider can report completion later, but that cannot swallow a durable
    // question. A replacement supervisor must still stop before receipt/acceptance.
    control.state = "completed";
    expect(
      await makeSupervisor(store, control, observed).reconcileRun(
        reconcileInput("2026-07-19T12:00:01.200Z")
      )
    ).toMatchObject({
      ok: true,
      humanActionCount: 1,
      attempts: [{ action: "await_human", outcome: "deferred" }],
    });
    if (recovery === "cancel") {
      expect(
        await makeSupervisor(store, control, observed).reconcileRun({
          ...reconcileInput("2026-07-19T12:00:01.250Z"),
          cancelAttemptIds: ["attempt-supervisor"],
        })
      ).toMatchObject({
        ok: true,
        cancellationOnly: true,
        humanActionCount: 1,
        attempts: [{ action: "cancel_worker", outcome: "applied", status: "cancelled" }],
      });
      expect((await store.getWorkerSessionForAttempt("attempt-supervisor"))!.status).toBe(
        "cancelled"
      );
      return;
    }
    const humans = new AgentWorkHumanActionService(store, store, {
      async observe() {
        return observed;
      },
    });
    expect(
      await humans.settle({
        controller,
        expectedRunRevision: pending.revision,
        mutationId: "human-answer",
        now: "2026-07-19T12:00:01.300Z",
        receipt: {
          schema_version: "1.0.0",
          receipt_id: "human-answer",
          request_id: request.request_id,
          run_id: request.run_id,
          attempt_id: request.attempt_id,
          workspace_lease_id: request.workspace_lease_id,
          worker_session_id: request.worker_session_id,
          observed_preconditions: request.preconditions,
          outcome: "completed",
          actor_id: "controlled-human-channel",
          summary: "Proceed with the compared approach.",
          completed_at: "2026-07-19T12:00:01.300Z",
        },
      })
    ).toMatchObject({ ok: true });

    control.state = "completed";
    const completed = await makeSupervisor(store, control, observed).reconcileRun(
      reconcileInput("2026-07-19T12:00:02.000Z")
    );
    expect(completed).toMatchObject({
      ok: true,
      attempts: [{ action: "collect_receipt", outcome: "applied", status: "receipt_submitted" }],
    });

    const verified = await makeSupervisor(
      store,
      control,
      observed,
      "2026-07-19T12:00:02.500Z"
    ).reconcileRun(reconcileInput("2026-07-19T12:00:02.500Z"));
    if (verified.ok && verified.attempts[0]?.outcome !== "applied") {
      throw new Error(`verification failed: ${JSON.stringify(verified)}`);
    }
    expect(verified).toMatchObject({
      ok: true,
      attempts: [{ action: "verify", outcome: "applied", status: "verified" }],
    });
    const accepted = await makeSupervisor(
      store,
      control,
      observed,
      "2026-07-19T12:00:03.000Z"
    ).reconcileRun(reconcileInput("2026-07-19T12:00:03.000Z"));
    expect(accepted).toMatchObject({
      ok: true,
      attempts: [{ action: "accept", outcome: "applied", status: "accepted" }],
    });
    expect(control.launchEffects).toBe(1);
    await expect(store.getAttempt("attempt-supervisor")).resolves.toMatchObject({
      status: "accepted",
      receiptId: "receipt-supervisor",
      verificationId: "verification:attempt-supervisor",
    });
  });
});

class IdempotentLaunchControl implements HeadlessSupervisorWorkerControl {
  readonly selection = {
    schema_version: "1.0.0" as const,
    adapter_id: "lexrunner.controlled-subprocess",
    adapter_version: "1.0.0",
    mode: "launch" as const,
    accepted_trust_gaps: [],
  };
  launchEffects = 0;
  operationIds: string[] = [];
  state: "running" | "awaiting_human" | "completed" = "running";
  private failResponseOnce = true;
  private readonly launched = new Map<string, SupervisorWorkerLaunchResult>();

  async launch(input: { operationId: string }): Promise<SupervisorWorkerLaunchResult> {
    this.operationIds.push(input.operationId);
    let result = this.launched.get(input.operationId);
    if (!result) {
      this.launchEffects += 1;
      result = {
        sessionId: "session-supervisor",
        workerId: "worker-supervisor",
        backend: "codex-cli",
        startedAt: "2026-07-19T12:00:00.400Z",
      };
      this.launched.set(input.operationId, result);
    }
    if (this.failResponseOnce) {
      this.failResponseOnce = false;
      throw new Error("simulated controller termination after process launch");
    }
    return result;
  }

  async observe() {
    return { state: this.state };
  }

  async cancel(): Promise<void> {}

  async collectReceipt(session: {
    runId: string;
    attemptId: string;
    packetId: string;
    packetHash: string;
    workspaceLeaseId: string;
    workspaceLeaseRevision: number;
    workerRuntime: string;
    sessionId: string;
    startedAt: string;
  }) {
    return {
      schema_version: "2.0.0" as const,
      receipt_id: "receipt-supervisor",
      run_id: session.runId,
      work_item_id: "work-supervisor",
      work_item_revision: 1,
      attempt_id: session.attemptId,
      packet_id: session.packetId,
      packet_hash: session.packetHash,
      workspace_lease_id: session.workspaceLeaseId,
      workspace_lease_revision: session.workspaceLeaseRevision,
      worker_runtime: session.workerRuntime,
      worker_session_id: session.sessionId,
      observed_base_sha: "a".repeat(40),
      patch_hash: `sha256:${"d".repeat(64)}`,
      outcome: "completed" as const,
      exit_reason: "work_complete",
      summary: "The controlled worker completed and left durable evidence.",
      files_touched: [],
      commits: [],
      acceptance_criteria_addressed: [],
      claimed_checks: [],
      assumptions: [],
      blockers: [],
      human_action_request_ids: [],
      cost: { tool_calls: 1, elapsed_ms: 1_000 },
      worker_started_at: session.startedAt,
      worker_completed_at: "2026-07-19T12:00:01.900Z",
      submitted_at: "2026-07-19T12:00:01.950Z",
    };
  }
}

function makeSupervisor(
  store: InMemoryWorkspaceLifecycleStore,
  control: IdempotentLaunchControl,
  observed: WorkspaceObservation,
  verificationNow = "2026-07-19T12:00:00.500Z"
) {
  const manifest = WorkerAdapterManifest_v1.parse({
    ...HOST_ASSISTED_ADAPTER_MANIFEST,
    adapter: {
      id: "lexrunner.controlled-subprocess",
      version: "1.0.0",
      kind: "subprocess",
      session_backend: "codex-cli",
    },
    lifecycle: {
      ...HOST_ASSISTED_ADAPTER_MANIFEST.lifecycle,
      launch: true,
      assisted_attach: false,
    },
    authority: Object.fromEntries(
      Object.keys(HOST_ASSISTED_ADAPTER_MANIFEST.authority).map((key) => [key, "enforced"])
    ),
    reproducibility: { backend_identity: "controlled-fixture", backend_version: "1.0.0" },
  });
  const workerSessions = new AgentWorkWorkerSessionService(store, {
    config: { worktreeRoot: dirname(observed.worktreePath) } as never,
    observeWorkspace: async () => ({ ok: true as const, observation: observed }),
  });
  return new AgentWorkHeadlessSupervisor(
    store,
    store,
    workerSessions,
    new AgentWorkWorkerAdapterNegotiator(store, new WorkerAdapterRegistry([manifest])),
    new AgentWorkAttemptVerificationService(
      store,
      new FixtureVerificationRuntime(),
      () => verificationNow
    ),
    { observe: async () => observed },
    control
  );
}

function verifiedRoot(runtimeId: string, path: string) {
  const identity = captureDirectoryIdentity(path, "supervisor fixture path");
  return {
    runtime_id: runtimeId,
    path,
    verification: "directory_identity" as const,
    directory_identity: {
      device: identity.device.toString(10),
      inode: identity.inode.toString(10),
    },
  };
}

class FixtureVerificationRuntime implements AttemptVerificationRuntime {
  resolveEnvironment(): Readonly<Record<string, string>> {
    return {};
  }

  async observe() {
    return {
      headSha: "a".repeat(40),
      patchHash: `sha256:${"d".repeat(64)}`,
      observationHash: `sha256:${"e".repeat(64)}`,
    };
  }

  async runCheck() {
    return { ok: true, exitCode: 0, durationMs: 1 };
  }

  async resolveCheckCwd(worktreePath: string): Promise<string> {
    return worktreePath;
  }
}

function reconcileInput(now: string) {
  return {
    runId: "run-supervisor",
    initialRunState: {},
    controllerId: "supervisor-1",
    controllerLeaseId: "supervisor-lease-1",
    now,
    diagnostics: true,
  };
}

function observation(worktreePath: string, projectRoot: string): WorkspaceObservation {
  return {
    exists: true,
    registered: true,
    repositoryId: "owner/repo",
    hostId: "host-supervisor",
    gitRuntime: "git-fixture",
    projectRoot,
    branch: "agent/supervisor",
    worktreePath,
    attemptId: "attempt-supervisor",
    headSha: "a".repeat(40),
    cleanliness: "clean",
  };
}

function credential(lease: {
  runId: string;
  controllerId: string;
  leaseId: string;
  fencingToken: number;
}): ControllerLeaseCredential {
  return {
    runId: lease.runId,
    controllerId: lease.controllerId,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
  };
}
