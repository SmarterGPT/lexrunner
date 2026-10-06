import { describe, expect, it, vi } from "vitest";
import { AgentWorkHeadlessSupervisor } from "../../src/runs/agent-work-supervisor.js";
import { InMemoryWorkspaceLifecycleStore } from "../../src/store/inmemory/workspace-lifecycle-store.js";
import type { HumanActionRequest_v1 } from "../../src/schemas/agent-work.js";
import type {
  WorkerSessionRecord,
  WorkspaceLifecycleLeaseRecord,
} from "../../src/store/workspace-lifecycle-store.js";

describe("human hold observation reconciliation", () => {
  it("blocks an old worker question after its replacement was completed, before reconciling siblings", async () => {
    const now = "2026-10-06T12:00:00.000Z";
    const question: HumanActionRequest_v1 = {
      schema_version: "1.0.0",
      request_id: "Q1",
      run_id: "run",
      attempt_id: "worker-attempt",
      workspace_lease_id: "workspace",
      worker_session_id: "worker",
      action: "other",
      summary: "Original question",
      instructions: ["Resolve this tradeoff"],
      suggested_commands: [],
      requested_at: now,
      preconditions: {
        run_revision: 0,
        workspace_lease_revision: 0,
        expected_head_sha: "a".repeat(40),
      },
    };
    const replacement = { ...question, request_id: "Q2", summary: "Replacement question" };
    const store = new InMemoryWorkspaceLifecycleStore();
    const acquired = await store.acquireControllerLease({
      runId: "run",
      controllerId: "controller",
      leaseId: "controller-lease",
      now,
      ttlMs: 60000,
      initialState: {
        metadata: {
          agentWorkHumanActions: {
            version: 1,
            entries: [
              { request: question, contextHash: "retained", receipt: null, supersededBy: "Q2" },
              {
                request: replacement,
                contextHash: "retained",
                replacesRequestId: "Q1",
                receipt: {
                  schema_version: "1.0.0",
                  receipt_id: "answer-Q2",
                  request_id: "Q2",
                  run_id: "run",
                  attempt_id: "worker-attempt",
                  workspace_lease_id: "workspace",
                  worker_session_id: "worker",
                  observed_preconditions: replacement.preconditions,
                  outcome: "completed",
                  actor_id: "human-channel",
                  summary: "Replacement answered",
                  completed_at: now,
                },
              },
            ],
          },
        },
      },
    });
    if (!acquired.acquired) throw new Error("fixture lease missing");
    const controller = {
      runId: "run",
      controllerId: "controller",
      leaseId: "controller-lease",
      fencingToken: acquired.lease.fencingToken,
    };
    for (const attemptId of ["worker-attempt", "sibling-attempt"]) {
      await store.createAttempt({
        runId: "run",
        expectedRunRevision: 0,
        controller,
        mutationId: `create:${attemptId}`,
        now,
        attemptId,
        workItemId: `work:${attemptId}`,
        workItemRevision: 1,
        packetId: `packet:${attemptId}`,
        packetHash: `sha256:${"a".repeat(64)}`,
        baseSha: "a".repeat(40),
      });
    }
    // Controlled observation port: the persisted questions and supervisor are
    // real; no native workspace, authenticated actor or worker stop is claimed.
    const session = {
      sessionId: "worker",
      runId: "run",
      attemptId: "worker-attempt",
      workspaceLeaseId: "workspace",
      revision: 0,
      status: "awaiting_human",
    } as WorkerSessionRecord;
    const lease = {
      leaseId: "workspace",
      runId: "run",
      attemptId: "worker-attempt",
      revision: 0,
    } as WorkspaceLifecycleLeaseRecord;
    const workerLookup = vi
      .spyOn(store, "getWorkerSessionForAttempt")
      .mockImplementation(async (id) => (id === "worker-attempt" ? session : null));
    const workspaceLookup = vi.spyOn(store, "getWorkspaceLease").mockResolvedValue(lease);
    const observe = vi.fn(async () => ({
      state: "awaiting_human" as const,
      humanActionRequest: question,
    }));
    const launch = vi.fn(),
      cancel = vi.fn(),
      collectReceipt = vi.fn();
    const supervisor = AgentWorkHeadlessSupervisor.withVerificationRuntime({
      coordination: store,
      store,
      workerSessions: {} as never,
      workerAdapters: {} as never,
      verificationRuntime: {} as never,
      workspaceObserver: {
        async observe() {
          return {
            exists: true,
            registered: true,
            repositoryId: null,
            hostId: "controlled",
            gitRuntime: "git",
            projectRoot: null,
            branch: null,
            worktreePath: "/controlled",
            attemptId: "worker-attempt",
            headSha: "a".repeat(40),
            cleanliness: "clean" as const,
          };
        },
      },
      workerControl: { selection: {} as never, observe, launch, cancel, collectReceipt },
    });
    try {
      expect(
        await supervisor.reconcileRun({
          runId: "run",
          initialRunState: {},
          controllerId: "controller",
          controllerLeaseId: "controller-lease",
          now,
        })
      ).toEqual({ ok: false, runId: "run", reason: "human_action_reconciliation_required" });
      expect(observe).toHaveBeenCalledOnce();
      expect(launch).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(collectReceipt).not.toHaveBeenCalled();
      expect((await store.getAttempt("sibling-attempt"))!.revision).toBe(0);
    } finally {
      workerLookup.mockRestore();
      workspaceLookup.mockRestore();
    }
  });
});
