import { describe, expect, it, vi } from "vitest";

import type { ControllerLeaseCredential } from "../../src/store/coordination-store.js";
import type {
  AttemptRecord,
  WorkspaceLifecycleEvent,
  WorkspaceLifecycleLeaseRecord,
  WorkspaceLifecycleStore,
  WorkspaceMutationResult,
  WorkspaceObservation,
} from "../../src/store/workspace-lifecycle-store.js";
import type { GitWorktreeBroker } from "../../src/workspaces/git-worktree-broker.js";
import {
  type AllocateWorkspaceInput,
  type HeartbeatCoordinatedWorkspaceInput,
  type ReleaseCoordinatedWorkspaceInput,
  type ResumeCoordinatedWorkspaceInput,
  WorkspaceCoordinator,
} from "../../src/workspaces/workspace-coordinator.js";

const T0 = "2026-07-11T20:00:00.000Z";
const T1 = "2026-07-11T20:00:01.000Z";
const T2 = "2026-07-11T20:00:02.000Z";
const T3 = "2026-07-11T20:00:03.000Z";

describe("WorkspaceCoordinator", () => {
  it("reserves durably before broker creation and activates the exact observation", async () => {
    const sequence: string[] = [];
    const ports = fakePorts();
    ports.store.acquireWorkspace.mockImplementation(async () => {
      sequence.push("reserve");
      ports.durable.attempt = attempt(1);
      ports.durable.lease = lease(0, "reserved");
      return success(ports.durable.attempt, ports.durable.lease, "workspace_acquired", "reserve");
    });
    ports.broker.create.mockImplementation(async (_target, options) => {
      sequence.push("create");
      expect(options?.boundaryAuthority).toEqual({
        operationId: "allocate-reserve",
        orchestrationLeaseId: "workspace-1",
        orchestrationLeaseRevision: 0,
        ownerId: "controller-1",
      });
      return { ok: true, outcome: "created", observation: observation() };
    });
    ports.store.heartbeatWorkspace.mockImplementation(async (input) => {
      sequence.push("activate");
      expect(input).toMatchObject({
        expectedAttemptRevision: 1,
        expectedWorkspaceLeaseRevision: 0,
        mutationId: "allocate-activate",
      });
      ports.durable.attempt = attempt(2);
      ports.durable.lease = lease(1, "active", input.observation);
      return success(
        ports.durable.attempt,
        ports.durable.lease,
        "workspace_heartbeat",
        input.mutationId
      );
    });

    const result = await new WorkspaceCoordinator(ports.store, ports.broker).allocate(
      allocateInput()
    );

    expect(sequence).toEqual(["reserve", "create", "activate"]);
    expect(result).toMatchObject({
      ok: true,
      outcome: "active",
      attempt: { revision: 2 },
      workspaceLease: { revision: 1, status: "active" },
    });
  });

  it("never calls the broker when reservation is rejected", async () => {
    const ports = fakePorts();
    ports.store.acquireWorkspace.mockResolvedValue(failure("branch_conflict", 0));

    const result = await new WorkspaceCoordinator(ports.store, ports.broker).allocate(
      allocateInput()
    );

    expect(result).toMatchObject({
      ok: false,
      phase: "reserve",
      reason: "store_rejected",
      storeResult: { reason: "branch_conflict" },
    });
    expect(ports.broker.create).not.toHaveBeenCalled();
    expect(ports.broker.observe).not.toHaveBeenCalled();
    expect(ports.broker.remove).not.toHaveBeenCalled();
  });

  it("recovers an already-completed allocation without replaying Git", async () => {
    const ports = fakePorts();
    ports.durable.attempt = attempt(2);
    ports.durable.lease = lease(1, "active", observation());
    ports.durable.events = [
      event("workspace_heartbeat", "allocate-activate", ports.durable.attempt, ports.durable.lease),
    ];
    ports.store.acquireWorkspace.mockResolvedValue({
      ...success(attempt(1), lease(0, "reserved"), "workspace_acquired", "allocate-reserve"),
      idempotentReplay: true,
    });

    const result = await new WorkspaceCoordinator(ports.store, ports.broker).allocate(
      allocateInput()
    );

    expect(result).toMatchObject({
      ok: true,
      outcome: "active",
      idempotentReplay: true,
      attempt: { revision: 2 },
      workspaceLease: { revision: 1 },
    });
    expect(ports.store.acquireWorkspace).toHaveBeenCalledOnce();
    expect(ports.broker.create).not.toHaveBeenCalled();
  });

  it("quarantines a broker creation failure with the reserved revisions", async () => {
    const ports = reservedPorts();
    const brokerObservation = observation({
      exists: false,
      registered: false,
      repositoryId: null,
      projectRoot: null,
      branch: null,
      attemptId: null,
      headSha: null,
      reason: "creation timed out",
    });
    ports.broker.create.mockResolvedValue({
      ok: false,
      operation: "create",
      reason: "timeout",
      message: "git may have completed",
      observation: brokerObservation,
    });
    ports.store.quarantineWorkspace.mockImplementation(async (input) => {
      expect(input).toMatchObject({
        expectedAttemptRevision: 1,
        expectedWorkspaceLeaseRevision: 0,
        observation: brokerObservation,
      });
      ports.durable.attempt = attempt(2, "quarantined");
      ports.durable.lease = lease(1, "quarantined", input.observation);
      return success(
        ports.durable.attempt,
        ports.durable.lease,
        "workspace_quarantined",
        input.mutationId
      );
    });

    const result = await new WorkspaceCoordinator(ports.store, ports.broker).allocate(
      allocateInput()
    );

    expect(result).toMatchObject({
      ok: false,
      reason: "unsafe_observation",
      brokerFailure: { reason: "timeout" },
      workspaceLease: { status: "quarantined" },
    });
    expect(ports.store.heartbeatWorkspace).not.toHaveBeenCalled();
  });

  it("fails closed when a broker throws an ambiguous creation error", async () => {
    const ports = reservedPorts();
    ports.broker.create.mockRejectedValue(new Error("transport disappeared after spawn"));
    ports.store.quarantineWorkspace.mockImplementation(async (input) => {
      ports.durable.attempt = attempt(2, "quarantined");
      ports.durable.lease = lease(1, "quarantined", input.observation);
      return success(
        ports.durable.attempt,
        ports.durable.lease,
        "workspace_quarantined",
        input.mutationId
      );
    });

    const result = await new WorkspaceCoordinator(ports.store, ports.broker).allocate(
      allocateInput()
    );

    expect(result).toMatchObject({
      ok: false,
      phase: "quarantine",
      reason: "unsafe_observation",
      brokerFailure: { operation: "create", reason: "command_failed" },
      observation: { exists: false, registered: false, cleanliness: "dirty" },
      quarantineAttempted: true,
    });
    const quarantine = ports.store.quarantineWorkspace.mock.calls[0]?.[0];
    expect(quarantine?.reason).toContain('"operation":"create"');
    expect(Buffer.byteLength(quarantine?.reason ?? "", "utf8")).toBeLessThanOrEqual(1_024);
  });

  it("returns reconciliation_required when exact creation cannot activate stale authority", async () => {
    const ports = reservedPorts();
    ports.broker.create.mockResolvedValue({
      ok: true,
      outcome: "created",
      observation: observation(),
    });
    ports.store.heartbeatWorkspace.mockResolvedValue(failure("stale_fence", 1, 0));

    const result = await new WorkspaceCoordinator(ports.store, ports.broker).allocate(
      allocateInput()
    );

    expect(result).toMatchObject({
      ok: false,
      phase: "activate",
      reason: "reconciliation_required",
      storeResult: { reason: "stale_fence" },
      quarantineAttempted: false,
    });
    expect(ports.store.quarantineWorkspace).not.toHaveBeenCalled();
    expect(ports.broker.remove).not.toHaveBeenCalled();
  });

  it("quarantines a dirty allocation postcondition instead of activating it", async () => {
    const ports = reservedPorts();
    ports.broker.create.mockResolvedValue({
      ok: true,
      outcome: "created",
      observation: observation({ cleanliness: "dirty", dirtyPaths: ["unfinished.ts"] }),
    });
    ports.store.quarantineWorkspace.mockImplementation(async (input) => {
      ports.durable.attempt = attempt(2, "quarantined");
      ports.durable.lease = lease(1, "quarantined", input.observation);
      return success(
        ports.durable.attempt,
        ports.durable.lease,
        "workspace_quarantined",
        input.mutationId
      );
    });

    const result = await new WorkspaceCoordinator(ports.store, ports.broker).allocate(
      allocateInput()
    );

    expect(result).toMatchObject({
      ok: false,
      phase: "quarantine",
      reason: "unsafe_observation",
      workspaceLease: { status: "quarantined" },
    });
    expect(ports.store.heartbeatWorkspace).not.toHaveBeenCalled();
    expect(ports.store.quarantineWorkspace).toHaveBeenCalledOnce();
  });

  it("records a marker-owned dirty heartbeat as active work", async () => {
    const ports = activePorts();
    const dirty = observation({ cleanliness: "dirty", dirtyPaths: ["src/change.ts"] });
    ports.broker.observe.mockResolvedValue({ ok: true, outcome: "observed", observation: dirty });
    ports.store.heartbeatWorkspace.mockImplementation(async (input) => {
      expect(input.observation).toEqual(dirty);
      ports.durable.attempt = attempt(3);
      ports.durable.lease = lease(2, "active", dirty);
      return success(
        ports.durable.attempt,
        ports.durable.lease,
        "workspace_heartbeat",
        input.mutationId
      );
    });

    const result = await new WorkspaceCoordinator(ports.store, ports.broker).heartbeat(
      heartbeatInput()
    );

    expect(result).toMatchObject({
      ok: true,
      outcome: "active",
      workspaceLease: { status: "active", lastObservation: { cleanliness: "dirty" } },
    });
    expect(ports.store.quarantineWorkspace).not.toHaveBeenCalled();
  });

  it("rejects a mismatched Attempt and lease before broker access", async () => {
    const ports = activePorts();
    ports.durable.lease = { ...ports.durable.lease!, attemptId: "attempt-other" };

    const result = await new WorkspaceCoordinator(ports.store, ports.broker).heartbeat(
      heartbeatInput()
    );

    expect(result).toMatchObject({ ok: false, reason: "reconciliation_required" });
    expect(ports.broker.observe).not.toHaveBeenCalled();
  });

  it("lets the store fingerprint validate a one-revision heartbeat retry", async () => {
    const ports = activePorts();
    ports.durable.attempt = attempt(3);
    ports.durable.lease = lease(2, "active", observation());
    ports.broker.observe.mockResolvedValue({
      ok: true,
      outcome: "observed",
      observation: observation(),
    });
    ports.store.heartbeatWorkspace.mockResolvedValue({
      ...success(ports.durable.attempt, ports.durable.lease, "workspace_heartbeat", "heartbeat"),
      idempotentReplay: true,
    });

    const result = await new WorkspaceCoordinator(ports.store, ports.broker).heartbeat(
      heartbeatInput()
    );

    expect(result).toMatchObject({ ok: true, outcome: "active", idempotentReplay: true });
    expect(ports.store.heartbeatWorkspace).toHaveBeenCalledOnce();
  });

  it("does not let a stale one-revision heartbeat quarantine concurrent work", async () => {
    const ports = activePorts();
    ports.durable.attempt = attempt(3);
    ports.durable.lease = lease(2, "active", observation());
    ports.broker.observe.mockResolvedValue({
      ok: true,
      outcome: "observed",
      observation: observation({ reason: "ownership became ambiguous" }),
    });

    const result = await new WorkspaceCoordinator(ports.store, ports.broker).heartbeat(
      heartbeatInput()
    );

    expect(result).toMatchObject({ ok: false, reason: "reconciliation_required" });
    expect(ports.store.heartbeatWorkspace).not.toHaveBeenCalled();
    expect(ports.store.quarantineWorkspace).not.toHaveBeenCalled();
  });

  it("resumes exact takeover observations but lets the store quarantine unsafe ones", async () => {
    const exactPorts = activePorts();
    exactPorts.durable.lease = {
      ...exactPorts.durable.lease!,
      controllerId: "controller-old",
      controllerLeaseId: "controller-lease-old",
      fencingToken: 1,
    };
    const takeoverController = {
      ...controller,
      controllerId: "controller-new",
      leaseId: "controller-lease-new",
      fencingToken: 2,
    };
    exactPorts.broker.observe.mockResolvedValue({
      ok: true,
      outcome: "observed",
      observation: observation(),
    });
    exactPorts.store.reconcileWorkspace.mockImplementation(async (input) => {
      expect(input.action).toBe("resume");
      expect(input.controller).toEqual(takeoverController);
      exactPorts.durable.attempt = attempt(3);
      exactPorts.durable.lease = {
        ...lease(2, "active", input.observation),
        controllerId: takeoverController.controllerId,
        controllerLeaseId: takeoverController.leaseId,
        fencingToken: takeoverController.fencingToken,
      };
      return success(
        exactPorts.durable.attempt,
        exactPorts.durable.lease,
        "workspace_reconciled",
        input.mutationId
      );
    });
    const exact = await new WorkspaceCoordinator(exactPorts.store, exactPorts.broker).resume({
      ...resumeInput(),
      controller: takeoverController,
    });
    expect(exact).toMatchObject({ ok: true, outcome: "resumed" });

    const unsafePorts = activePorts();
    const unsafe = observation({ reason: "marker ownership is ambiguous" });
    unsafePorts.broker.observe.mockResolvedValue({
      ok: true,
      outcome: "observed",
      observation: unsafe,
    });
    unsafePorts.store.reconcileWorkspace.mockImplementation(async (input) => {
      expect(input.observation).toMatchObject({ exists: false, registered: false });
      unsafePorts.durable.attempt = attempt(3, "quarantined");
      unsafePorts.durable.lease = lease(2, "quarantined", input.observation);
      return success(
        unsafePorts.durable.attempt,
        unsafePorts.durable.lease,
        "workspace_quarantined",
        input.mutationId
      );
    });
    const quarantined = await new WorkspaceCoordinator(
      unsafePorts.store,
      unsafePorts.broker
    ).resume(resumeInput());
    expect(quarantined).toMatchObject({
      ok: false,
      phase: "resume",
      reason: "unsafe_observation",
      workspaceLease: { status: "quarantined" },
      quarantineAttempted: true,
    });
    expect(unsafePorts.broker.create).not.toHaveBeenCalled();
  });

  it("releases in observe, durable prepare, remove, durable finalize order", async () => {
    const sequence: string[] = [];
    const ports = activePorts();
    ports.broker.observe.mockImplementation(async () => {
      sequence.push("observe");
      return { ok: true, outcome: "observed", observation: observation() };
    });
    ports.store.heartbeatWorkspace.mockImplementation(async (input) => {
      sequence.push("prepare");
      ports.durable.attempt = attempt(3);
      ports.durable.lease = lease(2, "active", input.observation);
      return success(
        ports.durable.attempt,
        ports.durable.lease,
        "workspace_heartbeat",
        input.mutationId
      );
    });
    ports.broker.remove.mockImplementation(async () => {
      sequence.push("remove");
      return {
        ok: true,
        outcome: "removed",
        observation: observation({
          exists: false,
          registered: false,
          repositoryId: null,
          projectRoot: null,
          branch: null,
          attemptId: null,
          headSha: null,
          reason: "removed",
        }),
      };
    });
    ports.store.releaseWorkspace.mockImplementation(async (input) => {
      sequence.push("finalize");
      expect(input).toMatchObject({
        expectedAttemptRevision: 3,
        expectedWorkspaceLeaseRevision: 2,
        observation: { exists: true, registered: true, cleanliness: "clean" },
      });
      ports.durable.attempt = attempt(4);
      ports.durable.lease = lease(3, "released", input.observation);
      return success(
        ports.durable.attempt,
        ports.durable.lease,
        "workspace_released",
        input.mutationId
      );
    });

    const result = await new WorkspaceCoordinator(ports.store, ports.broker).release(
      releaseInput()
    );

    expect(sequence).toEqual(["observe", "prepare", "remove", "finalize"]);
    expect(result).toMatchObject({
      ok: true,
      outcome: "released",
      workspaceLease: { status: "released" },
    });
  });

  it.each(["stale_workspace_revision", "removal_operation_pending"] as const)(
    "does not remove when release preparation returns %s",
    async (reason) => {
      const ports = activePorts();
      ports.broker.observe.mockResolvedValue({
        ok: true,
        outcome: "observed",
        observation: observation(),
      });
      ports.store.heartbeatWorkspace.mockResolvedValue(failure(reason, 2, 1));

      const result = await new WorkspaceCoordinator(ports.store, ports.broker).release(
        releaseInput()
      );

      expect(result).toMatchObject({
        ok: false,
        phase: "release_prepare",
        reason:
          reason === "removal_operation_pending" ? "reconciliation_required" : "store_rejected",
      });
      expect(ports.broker.remove).not.toHaveBeenCalled();
      expect(ports.store.releaseWorkspace).not.toHaveBeenCalled();
    }
  );

  it("continues a stable release retry only after the store validates its fingerprint", async () => {
    const ports = activePorts();
    ports.durable.attempt = attempt(3);
    ports.durable.lease = lease(2, "active", observation());
    ports.durable.events = [
      event("workspace_heartbeat", "release-prepare", ports.durable.attempt, ports.durable.lease),
    ];
    ports.broker.observe.mockResolvedValue({
      ok: true,
      outcome: "observed",
      observation: observation(),
    });
    ports.store.heartbeatWorkspace.mockResolvedValue({
      ...success(
        ports.durable.attempt,
        ports.durable.lease,
        "workspace_heartbeat",
        "release-prepare"
      ),
      idempotentReplay: true,
    });
    ports.broker.remove.mockResolvedValue({
      ok: true,
      outcome: "removed",
      observation: observation({ exists: false, registered: false, reason: "removed" }),
    });
    ports.store.releaseWorkspace.mockImplementation(async (input) => {
      ports.durable.attempt = attempt(4);
      ports.durable.lease = lease(3, "released", input.observation);
      return success(
        ports.durable.attempt,
        ports.durable.lease,
        "workspace_released",
        input.mutationId
      );
    });

    const result = await new WorkspaceCoordinator(ports.store, ports.broker).release(
      releaseInput()
    );

    expect(result).toMatchObject({ ok: true, outcome: "released", idempotentReplay: false });
    expect(ports.broker.observe).toHaveBeenCalledOnce();
    expect(ports.store.heartbeatWorkspace).toHaveBeenCalledOnce();
    expect(ports.broker.remove).toHaveBeenCalledOnce();
    expect(ports.store.releaseWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ expectedAttemptRevision: 3, expectedWorkspaceLeaseRevision: 2 })
    );
  });

  it("does not treat a matching event ID as proof of release preparation", async () => {
    const ports = activePorts();
    ports.durable.attempt = attempt(3);
    ports.durable.lease = lease(2, "active", observation());
    ports.durable.events = [
      event("workspace_heartbeat", "release-prepare", ports.durable.attempt, ports.durable.lease),
    ];
    ports.broker.observe.mockResolvedValue({
      ok: true,
      outcome: "observed",
      observation: observation(),
    });
    ports.store.heartbeatWorkspace.mockResolvedValue(failure("mutation_conflict", 3, 2));

    const result = await new WorkspaceCoordinator(ports.store, ports.broker).release(
      releaseInput()
    );

    expect(result).toMatchObject({ ok: false, reason: "reconciliation_required" });
    expect(ports.broker.remove).not.toHaveBeenCalled();
  });

  it("quarantines a missing worktree after authenticating a prepared release retry", async () => {
    const ports = activePorts();
    ports.durable.attempt = attempt(3);
    ports.durable.lease = lease(2, "active", observation());
    ports.store.heartbeatWorkspace.mockResolvedValue({
      ...success(
        ports.durable.attempt,
        ports.durable.lease,
        "workspace_heartbeat",
        "release-prepare"
      ),
      idempotentReplay: true,
    });
    const missing = observation({
      exists: false,
      registered: false,
      repositoryId: null,
      projectRoot: null,
      branch: null,
      attemptId: null,
      headSha: null,
      reason: "worktree missing after prior removal",
    });
    ports.broker.observe.mockResolvedValue({
      ok: false,
      operation: "observe",
      reason: "identity_mismatch",
      message: "worktree missing",
      observation: missing,
    });
    ports.store.quarantineWorkspace.mockImplementation(async (input) => {
      ports.durable.attempt = attempt(4, "quarantined");
      ports.durable.lease = lease(3, "quarantined", input.observation);
      return success(
        ports.durable.attempt,
        ports.durable.lease,
        "workspace_quarantined",
        input.mutationId
      );
    });

    const result = await new WorkspaceCoordinator(ports.store, ports.broker).release(
      releaseInput()
    );

    expect(result).toMatchObject({
      ok: false,
      phase: "quarantine",
      workspaceLease: { status: "quarantined" },
    });
    expect(ports.store.heartbeatWorkspace).toHaveBeenCalledOnce();
    expect(ports.store.quarantineWorkspace).toHaveBeenCalledOnce();
    expect(ports.broker.remove).not.toHaveBeenCalled();
  });

  it("does not let a stale one-revision release quarantine concurrent work", async () => {
    const ports = activePorts();
    ports.durable.attempt = attempt(3);
    ports.durable.lease = lease(2, "active", observation());
    ports.broker.observe.mockResolvedValue({
      ok: true,
      outcome: "observed",
      observation: observation({ cleanliness: "dirty", dirtyPaths: ["concurrent.ts"] }),
    });
    ports.store.heartbeatWorkspace.mockResolvedValue(failure("mutation_conflict", 3, 2));

    const result = await new WorkspaceCoordinator(ports.store, ports.broker).release(
      releaseInput()
    );

    expect(result).toMatchObject({ ok: false, reason: "reconciliation_required" });
    expect(ports.store.heartbeatWorkspace).toHaveBeenCalledOnce();
    expect(ports.store.quarantineWorkspace).not.toHaveBeenCalled();
    expect(ports.broker.remove).not.toHaveBeenCalled();
  });

  it("quarantines a broker-preserved removal outcome", async () => {
    const ports = preparedReleasePorts();
    const dirty = observation({ cleanliness: "dirty", dirtyPaths: ["late-change.ts"] });
    ports.broker.remove.mockResolvedValue({
      ok: true,
      outcome: "preserved",
      preservationReason: "dirty",
      observation: dirty,
    });
    ports.store.quarantineWorkspace.mockImplementation(async (input) => {
      ports.durable.attempt = attempt(4, "quarantined");
      ports.durable.lease = lease(3, "quarantined", input.observation);
      return success(
        ports.durable.attempt,
        ports.durable.lease,
        "workspace_quarantined",
        input.mutationId
      );
    });

    const result = await new WorkspaceCoordinator(ports.store, ports.broker).release(
      releaseInput()
    );

    expect(result).toMatchObject({
      ok: false,
      phase: "quarantine",
      reason: "unsafe_observation",
      observation: { cleanliness: "dirty" },
    });
    expect(ports.store.releaseWorkspace).not.toHaveBeenCalled();
  });

  it("quarantines a false removed postcondition instead of finalizing", async () => {
    const ports = preparedReleasePorts();
    ports.broker.remove.mockResolvedValue({
      ok: true,
      outcome: "removed",
      observation: observation(),
    });
    ports.store.quarantineWorkspace.mockImplementation(async (input) => {
      ports.durable.attempt = attempt(4, "quarantined");
      ports.durable.lease = lease(3, "quarantined", input.observation);
      return success(
        ports.durable.attempt,
        ports.durable.lease,
        "workspace_quarantined",
        input.mutationId
      );
    });

    const result = await new WorkspaceCoordinator(ports.store, ports.broker).release(
      releaseInput()
    );

    expect(result).toMatchObject({ ok: false, phase: "quarantine" });
    expect(ports.store.releaseWorkspace).not.toHaveBeenCalled();
  });

  it("reports reconciliation_required when removal succeeded but finalization lost authority", async () => {
    const ports = preparedReleasePorts();
    ports.broker.remove.mockResolvedValue({
      ok: true,
      outcome: "removed",
      observation: observation({
        exists: false,
        registered: false,
        repositoryId: null,
        projectRoot: null,
        branch: null,
        attemptId: null,
        headSha: null,
        reason: "removed",
      }),
    });
    ports.store.releaseWorkspace.mockResolvedValue(failure("stale_fence", 3, 2));
    ports.store.quarantineWorkspace.mockResolvedValue(failure("stale_fence", 3, 2));

    const result = await new WorkspaceCoordinator(ports.store, ports.broker).release(
      releaseInput()
    );

    expect(result).toMatchObject({
      ok: false,
      phase: "release_finalize",
      reason: "reconciliation_required",
      storeResult: { reason: "stale_fence" },
      quarantineAttempted: true,
    });
    expect(ports.broker.remove).toHaveBeenCalledOnce();
    expect(ports.store.quarantineWorkspace).toHaveBeenCalledOnce();
  });
});

function fakePorts() {
  const durable: {
    attempt: AttemptRecord | null;
    lease: WorkspaceLifecycleLeaseRecord | null;
    events: WorkspaceLifecycleEvent[];
  } = { attempt: attempt(0, "prepared"), lease: null, events: [] };

  const store = {
    createAttempt: vi.fn<WorkspaceLifecycleStore["createAttempt"]>(),
    transitionAttempt: vi.fn<WorkspaceLifecycleStore["transitionAttempt"]>(),
    acquireWorkspace: vi.fn<WorkspaceLifecycleStore["acquireWorkspace"]>(),
    heartbeatWorkspace: vi.fn<WorkspaceLifecycleStore["heartbeatWorkspace"]>(),
    releaseWorkspace: vi.fn<WorkspaceLifecycleStore["releaseWorkspace"]>(),
    reconcileWorkspace: vi.fn<WorkspaceLifecycleStore["reconcileWorkspace"]>(),
    quarantineWorkspace: vi.fn<WorkspaceLifecycleStore["quarantineWorkspace"]>(),
    getAttempt: vi.fn<WorkspaceLifecycleStore["getAttempt"]>(async () => durable.attempt),
    listAttempts: vi.fn<WorkspaceLifecycleStore["listAttempts"]>(async () =>
      durable.attempt ? [durable.attempt] : []
    ),
    getAttemptRetryDelta: vi.fn<WorkspaceLifecycleStore["getAttemptRetryDelta"]>(async () => null),
    listWorkspaceLeases: vi.fn<WorkspaceLifecycleStore["listWorkspaceLeases"]>(async () =>
      durable.lease ? [durable.lease] : []
    ),
    getWorkspaceLease: vi.fn<WorkspaceLifecycleStore["getWorkspaceLease"]>(
      async () => durable.lease
    ),
    listWorkspaceLifecycleEvents: vi.fn<WorkspaceLifecycleStore["listWorkspaceLifecycleEvents"]>(
      async () => durable.events
    ),
  } satisfies WorkspaceLifecycleStore;

  const broker = {
    create: vi.fn<GitWorktreeBroker["create"]>(),
    observe: vi.fn<GitWorktreeBroker["observe"]>(),
    remove: vi.fn<GitWorktreeBroker["remove"]>(),
  } satisfies GitWorktreeBroker;
  return { store, broker, durable };
}

function reservedPorts() {
  const ports = fakePorts();
  ports.store.acquireWorkspace.mockImplementation(async (input) => {
    ports.durable.attempt = attempt(1);
    ports.durable.lease = lease(0, "reserved");
    return success(
      ports.durable.attempt,
      ports.durable.lease,
      "workspace_acquired",
      input.mutationId
    );
  });
  return ports;
}

function activePorts() {
  const ports = fakePorts();
  ports.durable.attempt = attempt(2);
  ports.durable.lease = lease(1, "active", observation());
  return ports;
}

function preparedReleasePorts() {
  const ports = activePorts();
  ports.broker.observe.mockResolvedValue({
    ok: true,
    outcome: "observed",
    observation: observation(),
  });
  ports.store.heartbeatWorkspace.mockImplementation(async (input) => {
    ports.durable.attempt = attempt(3);
    ports.durable.lease = lease(2, "active", input.observation);
    return success(
      ports.durable.attempt,
      ports.durable.lease,
      "workspace_heartbeat",
      input.mutationId
    );
  });
  return ports;
}

function allocateInput(): AllocateWorkspaceInput {
  return {
    ...auth,
    ttlMs: 10_000,
    reservation: {
      attemptId: "attempt-1",
      workspaceLeaseId: "workspace-1",
      workItemId: "work-1",
      expectedAttemptRevision: 0,
      repositoryId: "repo-1",
      hostId: "host-1",
      gitRuntime: "git-linux",
      projectRoot: "/repo",
      branch: "agent/work-1",
      worktreePath: "/trees/work-1",
      baseSha: "a".repeat(40),
    },
    mutations: {
      reserve: { mutationId: "allocate-reserve", now: T0 },
      activate: { mutationId: "allocate-activate", now: T1 },
      quarantine: { mutationId: "allocate-quarantine", now: T1 },
    },
  };
}

function heartbeatInput(): HeartbeatCoordinatedWorkspaceInput {
  return {
    ...auth,
    attemptId: "attempt-1",
    workspaceLeaseId: "workspace-1",
    expectedAttemptRevision: 2,
    expectedWorkspaceLeaseRevision: 1,
    ttlMs: 10_000,
    mutations: {
      heartbeat: { mutationId: "heartbeat", now: T2 },
      quarantine: { mutationId: "heartbeat-quarantine", now: T2 },
    },
  };
}

function resumeInput(): ResumeCoordinatedWorkspaceInput {
  return {
    ...auth,
    attemptId: "attempt-1",
    workspaceLeaseId: "workspace-1",
    expectedAttemptRevision: 2,
    expectedWorkspaceLeaseRevision: 1,
    ttlMs: 10_000,
    mutation: { mutationId: "resume", now: T2 },
  };
}

function releaseInput(): ReleaseCoordinatedWorkspaceInput {
  return {
    ...auth,
    attemptId: "attempt-1",
    workspaceLeaseId: "workspace-1",
    expectedAttemptRevision: 2,
    expectedWorkspaceLeaseRevision: 1,
    disposition: "integrated",
    prepareTtlMs: 10_000,
    mutations: {
      prepare: { mutationId: "release-prepare", now: T2 },
      finalize: { mutationId: "release-finalize", now: T3 },
      quarantine: { mutationId: "release-quarantine", now: T3 },
    },
  };
}

const controller: ControllerLeaseCredential = {
  runId: "run-1",
  controllerId: "controller-1",
  leaseId: "controller-lease-1",
  fencingToken: 1,
};

const auth = { runId: "run-1", controller, expectedRunRevision: 0 } as const;

function attempt(revision: number, status: AttemptRecord["status"] = "leased"): AttemptRecord {
  return {
    attemptId: "attempt-1",
    runId: "run-1",
    runRevision: 0,
    workItemId: "work-1",
    workItemRevision: 1,
    packetId: "packet-1",
    packetHash: `sha256:${"b".repeat(64)}`,
    baseSha: "a".repeat(40),
    revision,
    status,
    workspaceLeaseId: status === "prepared" ? null : "workspace-1",
    receiptId: null,
    verificationId: null,
    createdAt: T0,
    updatedAt: T1,
    completedAt: status === "quarantined" ? T2 : null,
  };
}

function lease(
  revision: number,
  status: WorkspaceLifecycleLeaseRecord["status"],
  lastObservation?: WorkspaceObservation
): WorkspaceLifecycleLeaseRecord {
  return {
    leaseId: "workspace-1",
    attemptId: "attempt-1",
    runId: "run-1",
    runRevision: 0,
    workItemId: "work-1",
    workItemRevision: 1,
    packetId: "packet-1",
    packetHash: `sha256:${"b".repeat(64)}`,
    revision,
    controllerId: "controller-1",
    controllerLeaseId: "controller-lease-1",
    fencingToken: 1,
    repositoryId: "repo-1",
    hostId: "host-1",
    gitRuntime: "git-linux",
    projectRoot: "/repo",
    branch: "agent/work-1",
    worktreePath: "/trees/work-1",
    baseSha: "a".repeat(40),
    status,
    acquiredAt: T0,
    heartbeatAt: T1,
    expiresAt: T3,
    ...(status === "released" || status === "quarantined"
      ? {
          releasedAt: T3,
          cleanupDisposition:
            status === "released" ? ("integrated" as const) : ("preserved" as const),
        }
      : {}),
    ...(lastObservation ? { lastObservation } : {}),
  };
}

function observation(overrides: Partial<WorkspaceObservation> = {}): WorkspaceObservation {
  return {
    exists: true,
    registered: true,
    repositoryId: "repo-1",
    hostId: "host-1",
    gitRuntime: "git-linux",
    projectRoot: "/repo",
    branch: "agent/work-1",
    worktreePath: "/trees/work-1",
    attemptId: "attempt-1",
    headSha: "a".repeat(40),
    cleanliness: "clean",
    ...overrides,
  };
}

function event(
  type: WorkspaceLifecycleEvent["type"],
  mutationId: string,
  currentAttempt: AttemptRecord,
  currentLease: WorkspaceLifecycleLeaseRecord
): WorkspaceLifecycleEvent {
  return {
    runId: "run-1",
    attemptId: currentAttempt.attemptId,
    mutationId,
    sequence: 1,
    attemptRevision: currentAttempt.revision,
    workspaceLeaseRevision: currentLease.revision,
    controllerId: "controller-1",
    controllerLeaseId: "controller-lease-1",
    fencingToken: 1,
    type,
    payload: {},
    createdAt: T1,
  };
}

function success(
  currentAttempt: AttemptRecord,
  currentLease: WorkspaceLifecycleLeaseRecord,
  type: WorkspaceLifecycleEvent["type"],
  mutationId: string
): Extract<WorkspaceMutationResult, { updated: true }> {
  return {
    updated: true,
    attempt: currentAttempt,
    workspaceLease: currentLease,
    event: event(type, mutationId, currentAttempt, currentLease),
    idempotentReplay: false,
  };
}

function failure(
  reason: Extract<WorkspaceMutationResult, { updated: false }>["reason"],
  currentAttemptRevision?: number,
  currentWorkspaceLeaseRevision?: number
): Extract<WorkspaceMutationResult, { updated: false }> {
  return {
    updated: false,
    reason,
    ...(currentAttemptRevision === undefined ? {} : { currentAttemptRevision }),
    ...(currentWorkspaceLeaseRevision === undefined ? {} : { currentWorkspaceLeaseRevision }),
  };
}
