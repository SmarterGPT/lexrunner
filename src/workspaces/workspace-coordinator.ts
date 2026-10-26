import { Buffer } from "node:buffer";

import type { ControllerLeaseCredential } from "../store/coordination-store.js";
import type {
  AcquireWorkspaceInput,
  AttemptRecord,
  WorkspaceLifecycleLeaseRecord,
  WorkspaceLifecycleStore,
  WorkspaceMutationResult,
  WorkspaceObservation,
} from "../store/workspace-lifecycle-store.js";
import {
  withBrokerBoundaryAuthority,
  type BrokerFailure,
  type BrokerOperationOptions,
  type CreateWorktreeResult,
  type GitWorktreeBroker,
  type ObserveWorktreeResult,
  type RemoveWorktreeResult,
  type WorktreeTarget,
} from "./git-worktree-broker.js";

const MAX_REASON_LENGTH = 1_024;
const MAX_DIRTY_PATHS = 200;

export interface WorkspaceMutationStep {
  mutationId: string;
  now: string;
}

export interface WorkspaceCoordinatorAuthority {
  runId: string;
  expectedRunRevision: number;
  controller: ControllerLeaseCredential;
}

export type WorkspaceCoordinatorAuth = WorkspaceCoordinatorAuthority;
export type WorkspaceCoordinatorBrokerOptions = BrokerOperationOptions;

export interface AllocateWorkspaceInput extends WorkspaceCoordinatorAuthority {
  reservation: Omit<
    AcquireWorkspaceInput,
    "runId" | "expectedRunRevision" | "controller" | "mutationId" | "now" | "observation" | "ttlMs"
  >;
  ttlMs: number;
  mutations: {
    reserve: WorkspaceMutationStep;
    activate: WorkspaceMutationStep;
    quarantine: WorkspaceMutationStep;
  };
  broker?: BrokerOperationOptions;
}

interface ExistingWorkspaceInput extends WorkspaceCoordinatorAuthority {
  attemptId: string;
  workspaceLeaseId: string;
  expectedAttemptRevision: number;
  expectedWorkspaceLeaseRevision: number;
  broker?: BrokerOperationOptions;
}

export interface HeartbeatCoordinatedWorkspaceInput extends ExistingWorkspaceInput {
  ttlMs: number;
  mutations: {
    heartbeat: WorkspaceMutationStep;
    quarantine: WorkspaceMutationStep;
  };
}

export interface ResumeCoordinatedWorkspaceInput extends ExistingWorkspaceInput {
  ttlMs: number;
  mutation: WorkspaceMutationStep;
}

export type ResumeWorkspaceInput = ResumeCoordinatedWorkspaceInput;

export interface ReleaseCoordinatedWorkspaceInput extends ExistingWorkspaceInput {
  disposition: "integrated" | "discarded";
  prepareTtlMs: number;
  mutations: {
    prepare: WorkspaceMutationStep;
    finalize: WorkspaceMutationStep;
    quarantine: WorkspaceMutationStep;
  };
}

export type WorkspaceCoordinatorPhase =
  | "reserve"
  | "create"
  | "activate"
  | "observe"
  | "heartbeat"
  | "resume"
  | "release_prepare"
  | "remove"
  | "release_finalize"
  | "quarantine";

export interface WorkspaceCoordinatorSuccess {
  ok: true;
  outcome: "active" | "resumed" | "released";
  attempt: AttemptRecord;
  workspaceLease: WorkspaceLifecycleLeaseRecord;
  observation: WorkspaceObservation;
  idempotentReplay: boolean;
}

export type WorkspaceCoordinatorSuccessOutcome = WorkspaceCoordinatorSuccess["outcome"];

export interface WorkspaceCoordinatorFailure {
  ok: false;
  phase: WorkspaceCoordinatorPhase;
  reason: "store_rejected" | "broker_rejected" | "unsafe_observation" | "reconciliation_required";
  storeResult?: WorkspaceMutationResult;
  brokerFailure?: BrokerFailure;
  observation?: WorkspaceObservation;
  attempt?: AttemptRecord;
  workspaceLease?: WorkspaceLifecycleLeaseRecord;
  quarantineAttempted: boolean;
}

export type WorkspaceCoordinatorResult = WorkspaceCoordinatorSuccess | WorkspaceCoordinatorFailure;

/**
 * Application saga joining durable fencing with the Git side-effect port.
 * Every Git target is reconstructed from the accepted lease; caller input is
 * never reused after reservation.
 */
export class WorkspaceCoordinator {
  constructor(
    private readonly store: WorkspaceLifecycleStore,
    private readonly broker: GitWorktreeBroker
  ) {}

  async allocate(input: AllocateWorkspaceInput): Promise<WorkspaceCoordinatorResult> {
    let reserved: WorkspaceMutationResult;
    try {
      reserved = await this.store.acquireWorkspace({
        ...input.reservation,
        ttlMs: input.ttlMs,
        runId: input.runId,
        expectedRunRevision: input.expectedRunRevision,
        controller: input.controller,
        ...input.mutations.reserve,
      });
    } catch {
      return reconciliation("reserve", { attempt: null, lease: null });
    }
    if (!reserved.updated || !reserved.workspaceLease) {
      return storeFailure("reserve", reserved);
    }

    const current = reserved.idempotentReplay
      ? await this.readCurrent(reserved.attempt.attemptId, reserved.workspaceLease.leaseId)
      : { attempt: reserved.attempt, lease: reserved.workspaceLease };
    if (!current.attempt || !current.lease || !boundPair(current.attempt, current.lease)) {
      return reconciliation("reserve", current);
    }
    if (current.lease.status === "active" && current.attempt.status !== "quarantined") {
      const observation = current.lease.lastObservation;
      if (observation && ownedObservation(current.lease, observation)) {
        return success("active", current.attempt, current.lease, observation, true);
      }
    }
    if (current.lease.status !== "reserved" || current.attempt.status !== "leased") {
      return reconciliation("reserve", current);
    }

    const target = targetFrom(current.lease);
    const created = await this.create(
      target,
      boundaryBrokerOptions(
        input.broker,
        current.lease,
        input.mutations.reserve.mutationId,
        input.controller.controllerId
      )
    );
    if (!created.ok) {
      return this.quarantineAfterFailure(
        input,
        "create",
        current.attempt,
        current.lease,
        created,
        created.observation ?? syntheticObservation(target, created)
      );
    }
    if (!activationObservation(current.lease, created.observation)) {
      return this.quarantineUnsafe(
        input,
        "activate",
        current.attempt,
        current.lease,
        created.observation,
        "unsafe activation observation"
      );
    }

    let activated: WorkspaceMutationResult;
    try {
      activated = await this.store.heartbeatWorkspace({
        runId: input.runId,
        expectedRunRevision: input.expectedRunRevision,
        controller: input.controller,
        attemptId: current.attempt.attemptId,
        workspaceLeaseId: current.lease.leaseId,
        expectedAttemptRevision: current.attempt.revision,
        expectedWorkspaceLeaseRevision: current.lease.revision,
        ttlMs: input.ttlMs,
        observation: created.observation,
        ...input.mutations.activate,
      });
    } catch {
      return {
        ...reconciliation("activate", current),
        observation: created.observation,
      };
    }
    if (!activated.updated || !activated.workspaceLease) {
      return {
        ...storeFailure("activate", activated),
        reason: "reconciliation_required",
        observation: created.observation,
      };
    }
    return success(
      "active",
      activated.attempt,
      activated.workspaceLease,
      created.observation,
      activated.idempotentReplay
    );
  }

  async heartbeat(input: HeartbeatCoordinatedWorkspaceInput): Promise<WorkspaceCoordinatorResult> {
    const records = await this.readExpected(input, false, true);
    if (!records.ok) return records.failure;
    const target = targetFrom(records.lease);
    const observed = await this.observe(
      target,
      boundaryBrokerOptions(
        input.broker,
        records.lease,
        input.mutations.heartbeat.mutationId,
        input.controller.controllerId
      )
    );
    if (!observed.ok) {
      if (records.replayCandidate) {
        return {
          ...reconciliation("heartbeat", records),
          brokerFailure: observed,
          observation: observed.observation ?? syntheticObservation(target, observed),
        };
      }
      return this.quarantineAfterFailure(
        input,
        "observe",
        records.attempt,
        records.lease,
        observed,
        observed.observation ?? syntheticObservation(target, observed)
      );
    }
    if (!ownedObservation(records.lease, observed.observation)) {
      if (records.replayCandidate) {
        return {
          ...reconciliation("heartbeat", records),
          observation: observed.observation,
        };
      }
      return this.quarantineUnsafe(
        input,
        "heartbeat",
        records.attempt,
        records.lease,
        observed.observation,
        "unsafe heartbeat observation"
      );
    }
    let result: WorkspaceMutationResult;
    try {
      result = await this.store.heartbeatWorkspace({
        ...authority(input),
        attemptId: input.attemptId,
        workspaceLeaseId: input.workspaceLeaseId,
        expectedAttemptRevision: input.expectedAttemptRevision,
        expectedWorkspaceLeaseRevision: input.expectedWorkspaceLeaseRevision,
        ttlMs: input.ttlMs,
        observation: observed.observation,
        ...input.mutations.heartbeat,
      });
    } catch {
      return {
        ...reconciliation("heartbeat", records),
        observation: observed.observation,
      };
    }
    return mutationSuccess("active", "heartbeat", result, observed.observation);
  }

  async resume(input: ResumeCoordinatedWorkspaceInput): Promise<WorkspaceCoordinatorResult> {
    const records = await this.readExpected(input, true, true);
    if (!records.ok) return records.failure;
    const target = targetFrom(records.lease);
    const observed = await this.observe(
      target,
      boundaryBrokerOptions(
        input.broker,
        records.lease,
        input.mutation.mutationId,
        input.controller.controllerId
      )
    );
    const observation = observed.ok
      ? observed.observation
      : (observed.observation ?? syntheticObservation(target, observed));
    const safeResume =
      observed.ok &&
      ownedObservation(records.lease, observation) &&
      observation.cleanliness === "clean";
    if (!safeResume && records.replayCandidate) {
      return {
        ...reconciliation("resume", records),
        ...(!observed.ok ? { brokerFailure: observed } : {}),
        observation,
      };
    }
    const reconciliationObservation = safeResume
      ? observation
      : {
          ...observation,
          exists: false,
          registered: false,
          reason: observation.reason ?? "unsafe resume observation",
        };
    let result: WorkspaceMutationResult;
    try {
      result = await this.store.reconcileWorkspace({
        ...authority(input),
        attemptId: input.attemptId,
        workspaceLeaseId: input.workspaceLeaseId,
        expectedAttemptRevision: input.expectedAttemptRevision,
        expectedWorkspaceLeaseRevision: input.expectedWorkspaceLeaseRevision,
        action: "resume",
        ttlMs: input.ttlMs,
        observation: boundedObservation(reconciliationObservation),
        ...input.mutation,
      });
    } catch {
      return {
        ...reconciliation("resume", records),
        ...(!observed.ok ? { brokerFailure: observed } : {}),
        observation,
      };
    }
    if (!result.updated || !result.workspaceLease) {
      return {
        ...storeFailure("resume", result),
        ...(observed.ok ? {} : { brokerFailure: observed }),
        observation,
      };
    }
    if (result.workspaceLease.status !== "active") {
      return {
        ok: false,
        phase: "resume",
        reason: "unsafe_observation",
        observation,
        attempt: result.attempt,
        workspaceLease: result.workspaceLease,
        quarantineAttempted: true,
        ...(observed.ok ? {} : { brokerFailure: observed }),
      };
    }
    return success(
      "resumed",
      result.attempt,
      result.workspaceLease,
      observation,
      result.idempotentReplay
    );
  }

  async release(input: ReleaseCoordinatedWorkspaceInput): Promise<WorkspaceCoordinatorResult> {
    const current = await this.readCurrent(input.attemptId, input.workspaceLeaseId);
    if (
      !current.attempt ||
      !current.lease ||
      current.attempt.runId !== input.runId ||
      !boundPair(current.attempt, current.lease) ||
      !controlledBy(current.lease, input.controller)
    ) {
      return reconciliation("release_prepare", current);
    }
    const target = targetFrom(current.lease);
    if (current.lease.status === "released" && current.lease.lastObservation) {
      let replayed: WorkspaceMutationResult;
      try {
        replayed = await this.store.releaseWorkspace({
          ...authority(input),
          attemptId: input.attemptId,
          workspaceLeaseId: input.workspaceLeaseId,
          expectedAttemptRevision: current.attempt.revision - 1,
          expectedWorkspaceLeaseRevision: current.lease.revision - 1,
          disposition: input.disposition,
          observation: current.lease.lastObservation,
          ...input.mutations.finalize,
        });
      } catch {
        return reconciliation("release_finalize", current);
      }
      return replayed.updated && replayed.workspaceLease && replayed.idempotentReplay
        ? success(
            "released",
            replayed.attempt,
            replayed.workspaceLease,
            current.lease.lastObservation,
            true
          )
        : reconciliation("release_finalize", current);
    }

    const initialRevisions =
      current.attempt.revision === input.expectedAttemptRevision &&
      current.lease.revision === input.expectedWorkspaceLeaseRevision;
    const preparedRevisions =
      current.attempt.revision === input.expectedAttemptRevision + 1 &&
      current.lease.revision === input.expectedWorkspaceLeaseRevision + 1 &&
      current.lease.status === "active";
    if (!initialRevisions && !preparedRevisions) {
      return reconciliation("release_prepare", current);
    }

    let prepared: WorkspaceMutationResult | undefined;
    if (preparedRevisions) {
      if (
        !current.lease.lastObservation ||
        !releaseObservation(current.lease, current.lease.lastObservation)
      ) {
        return reconciliation("release_prepare", current);
      }
      try {
        prepared = await this.store.heartbeatWorkspace({
          ...authority(input),
          attemptId: input.attemptId,
          workspaceLeaseId: input.workspaceLeaseId,
          expectedAttemptRevision: input.expectedAttemptRevision,
          expectedWorkspaceLeaseRevision: input.expectedWorkspaceLeaseRevision,
          ttlMs: input.prepareTtlMs,
          observation: current.lease.lastObservation,
          ...input.mutations.prepare,
        });
      } catch {
        return reconciliation("release_prepare", current);
      }
      if (
        !prepared ||
        !prepared.updated ||
        !prepared.workspaceLease ||
        !prepared.idempotentReplay
      ) {
        return reconciliation("release_prepare", current);
      }
    }

    const observed = await this.observe(
      target,
      boundaryBrokerOptions(
        input.broker,
        current.lease,
        input.mutations.prepare.mutationId,
        input.controller.controllerId
      )
    );
    if (!observed.ok) {
      return this.quarantineAfterFailure(
        input,
        "observe",
        current.attempt,
        current.lease,
        observed,
        observed.observation ?? syntheticObservation(target, observed)
      );
    }
    if (!releaseObservation(current.lease, observed.observation)) {
      return this.quarantineUnsafe(
        input,
        "release_prepare",
        current.attempt,
        current.lease,
        observed.observation,
        "unsafe release observation"
      );
    }
    if (initialRevisions) {
      try {
        prepared = await this.store.heartbeatWorkspace({
          ...authority(input),
          attemptId: input.attemptId,
          workspaceLeaseId: input.workspaceLeaseId,
          expectedAttemptRevision: input.expectedAttemptRevision,
          expectedWorkspaceLeaseRevision: input.expectedWorkspaceLeaseRevision,
          ttlMs: input.prepareTtlMs,
          observation: observed.observation,
          ...input.mutations.prepare,
        });
      } catch {
        return { ...reconciliation("release_prepare", current), observation: observed.observation };
      }
      if (!prepared.updated || !prepared.workspaceLease) {
        return storeFailure("release_prepare", prepared);
      }
    }
    if (!prepared?.updated || !prepared.workspaceLease) {
      return reconciliation("release_prepare", current);
    }
    const preparedAttempt = preparedRevisions ? current.attempt : prepared.attempt;
    const preparedLease = preparedRevisions ? current.lease : prepared.workspaceLease;
    const releaseEvidence = preparedRevisions
      ? (current.lease.lastObservation ?? observed.observation)
      : observed.observation;

    const removed = await this.remove(
      target,
      boundaryBrokerOptions(
        input.broker,
        preparedLease,
        input.mutations.finalize.mutationId,
        input.controller.controllerId
      )
    );
    if (!removed.ok || removed.outcome === "preserved") {
      const failure = removed.ok ? undefined : removed;
      const observation = removed.ok
        ? removed.observation
        : (removed.observation ?? syntheticObservation(target, removed));
      return this.quarantineWithRecords(
        input,
        "remove",
        preparedAttempt,
        preparedLease,
        observation,
        failure,
        removed.ok
          ? `worktree preserved: ${removed.preservationReason ?? "unknown"}`
          : brokerEvidence(removed)
      );
    }
    if (removed.observation.exists || removed.observation.registered) {
      return this.quarantineWithRecords(
        input,
        "remove",
        preparedAttempt,
        preparedLease,
        removed.observation,
        undefined,
        "broker reported removal without an absent, unregistered postcondition"
      );
    }

    let finalized: WorkspaceMutationResult;
    try {
      finalized = await this.store.releaseWorkspace({
        ...authority(input),
        attemptId: input.attemptId,
        workspaceLeaseId: input.workspaceLeaseId,
        expectedAttemptRevision: preparedAttempt.revision,
        expectedWorkspaceLeaseRevision: preparedLease.revision,
        disposition: input.disposition,
        observation: releaseEvidence,
        ...input.mutations.finalize,
      });
    } catch {
      return this.quarantineWithRecords(
        input,
        "release_finalize",
        preparedAttempt,
        preparedLease,
        removed.observation,
        undefined,
        "release finalization threw after worktree removal"
      );
    }
    if (!finalized.updated || !finalized.workspaceLease) {
      const quarantined = await this.quarantineWithRecords(
        input,
        "release_finalize",
        preparedAttempt,
        preparedLease,
        removed.observation,
        undefined,
        `release finalization failed: ${finalized.updated ? "missing workspace lease" : finalized.reason}`
      );
      return quarantined.reason === "reconciliation_required"
        ? { ...quarantined, storeResult: finalized }
        : quarantined;
    }
    return success(
      "released",
      finalized.attempt,
      finalized.workspaceLease,
      removed.observation,
      finalized.idempotentReplay
    );
  }

  private async readExpected(
    input: ExistingWorkspaceInput,
    allowFenceTakeover = false,
    allowSingleReplay = false
  ): Promise<
    | {
        ok: true;
        attempt: AttemptRecord;
        lease: WorkspaceLifecycleLeaseRecord;
        replayCandidate: boolean;
      }
    | { ok: false; failure: WorkspaceCoordinatorFailure }
  > {
    const current = await this.readCurrent(input.attemptId, input.workspaceLeaseId);
    const exactRevisions =
      current.attempt?.revision === input.expectedAttemptRevision &&
      current.lease?.revision === input.expectedWorkspaceLeaseRevision;
    const replayCandidate =
      allowSingleReplay &&
      current.attempt?.revision === input.expectedAttemptRevision + 1 &&
      current.lease?.revision === input.expectedWorkspaceLeaseRevision + 1;
    if (
      !current.attempt ||
      !current.lease ||
      current.attempt.runId !== input.runId ||
      current.lease.runId !== input.runId ||
      !boundPair(current.attempt, current.lease) ||
      (!exactRevisions && !replayCandidate) ||
      (!allowFenceTakeover && !controlledBy(current.lease, input.controller))
    ) {
      return { ok: false, failure: reconciliation("observe", current) };
    }
    return { ok: true, attempt: current.attempt, lease: current.lease, replayCandidate };
  }

  private async readCurrent(attemptId: string, leaseId: string) {
    try {
      const [attempt, lease] = await Promise.all([
        this.store.getAttempt(attemptId),
        this.store.getWorkspaceLease(leaseId),
      ]);
      return { attempt, lease };
    } catch {
      return { attempt: null, lease: null };
    }
  }

  private async create(
    target: WorktreeTarget,
    options?: BrokerOperationOptions
  ): Promise<CreateWorktreeResult> {
    try {
      const result = await this.broker.create(target, options);
      if (!result || typeof result.ok !== "boolean") throw new Error("invalid create result");
      return result;
    } catch (error) {
      return thrownBrokerFailure("create", error);
    }
  }

  private async observe(
    target: WorktreeTarget,
    options?: BrokerOperationOptions
  ): Promise<ObserveWorktreeResult> {
    try {
      const result = await this.broker.observe(target, options);
      if (!result || typeof result.ok !== "boolean") throw new Error("invalid observe result");
      return result;
    } catch (error) {
      return thrownBrokerFailure("observe", error);
    }
  }

  private async remove(
    target: WorktreeTarget,
    options?: BrokerOperationOptions
  ): Promise<RemoveWorktreeResult> {
    try {
      const result = await this.broker.remove(target, options);
      if (!result || typeof result.ok !== "boolean") throw new Error("invalid remove result");
      return result;
    } catch (error) {
      return thrownBrokerFailure("remove", error);
    }
  }

  private quarantineAfterFailure(
    input:
      | AllocateWorkspaceInput
      | HeartbeatCoordinatedWorkspaceInput
      | ReleaseCoordinatedWorkspaceInput,
    phase: WorkspaceCoordinatorPhase,
    attempt: AttemptRecord,
    lease: WorkspaceLifecycleLeaseRecord,
    failure: BrokerFailure,
    observation: WorkspaceObservation
  ) {
    return this.quarantineWithRecords(
      input,
      phase,
      attempt,
      lease,
      boundedObservation(observation),
      failure,
      brokerEvidence(failure)
    );
  }

  private quarantineUnsafe(
    input:
      | AllocateWorkspaceInput
      | HeartbeatCoordinatedWorkspaceInput
      | ReleaseCoordinatedWorkspaceInput,
    phase: WorkspaceCoordinatorPhase,
    attempt: AttemptRecord,
    lease: WorkspaceLifecycleLeaseRecord,
    observation: WorkspaceObservation,
    reason: string
  ) {
    return this.quarantineWithRecords(input, phase, attempt, lease, observation, undefined, reason);
  }

  private async quarantineWithRecords(
    input:
      | AllocateWorkspaceInput
      | HeartbeatCoordinatedWorkspaceInput
      | ReleaseCoordinatedWorkspaceInput,
    phase: WorkspaceCoordinatorPhase,
    attempt: AttemptRecord,
    lease: WorkspaceLifecycleLeaseRecord,
    observation: WorkspaceObservation,
    brokerFailure: BrokerFailure | undefined,
    reason: string
  ): Promise<WorkspaceCoordinatorFailure> {
    let quarantined: WorkspaceMutationResult;
    try {
      quarantined = await this.store.quarantineWorkspace({
        ...authority(input),
        attemptId: attempt.attemptId,
        workspaceLeaseId: lease.leaseId,
        expectedAttemptRevision: attempt.revision,
        expectedWorkspaceLeaseRevision: lease.revision,
        reason: bounded(reason),
        observation: boundedObservation(observation),
        ...input.mutations.quarantine,
      });
    } catch {
      return {
        ok: false,
        phase,
        reason: "reconciliation_required",
        ...(brokerFailure ? { brokerFailure } : {}),
        observation: boundedObservation(observation),
        attempt,
        workspaceLease: lease,
        quarantineAttempted: true,
      };
    }
    return {
      ok: false,
      phase: quarantined.updated ? "quarantine" : phase,
      reason: quarantined.updated ? "unsafe_observation" : "reconciliation_required",
      storeResult: quarantined,
      ...(brokerFailure ? { brokerFailure } : {}),
      observation: boundedObservation(observation),
      ...(quarantined.updated
        ? { attempt: quarantined.attempt, workspaceLease: quarantined.workspaceLease ?? lease }
        : { attempt, workspaceLease: lease }),
      quarantineAttempted: true,
    };
  }
}

function authority(input: WorkspaceCoordinatorAuthority) {
  return {
    runId: input.runId,
    expectedRunRevision: input.expectedRunRevision,
    controller: input.controller,
  };
}

function targetFrom(lease: WorkspaceLifecycleLeaseRecord): WorktreeTarget {
  return {
    repositoryId: lease.repositoryId,
    hostId: lease.hostId,
    gitRuntime: lease.gitRuntime,
    projectRoot: lease.projectRoot,
    branch: lease.branch,
    worktreePath: lease.worktreePath,
    attemptId: lease.attemptId,
    baseSha: lease.baseSha,
  };
}

function boundaryBrokerOptions(
  options: BrokerOperationOptions | undefined,
  lease: WorkspaceLifecycleLeaseRecord,
  operationId: string,
  ownerId: string
): BrokerOperationOptions {
  return withBrokerBoundaryAuthority(options, {
    operationId,
    orchestrationLeaseId: lease.leaseId,
    orchestrationLeaseRevision: lease.revision,
    ownerId,
  });
}

function boundPair(attempt: AttemptRecord, lease: WorkspaceLifecycleLeaseRecord) {
  return attempt.attemptId === lease.attemptId && attempt.workspaceLeaseId === lease.leaseId;
}

function controlledBy(lease: WorkspaceLifecycleLeaseRecord, controller: ControllerLeaseCredential) {
  return (
    lease.controllerId === controller.controllerId &&
    lease.controllerLeaseId === controller.leaseId &&
    lease.fencingToken === controller.fencingToken
  );
}

function sameIdentity(lease: WorkspaceLifecycleLeaseRecord, observation: WorkspaceObservation) {
  return (
    observation.repositoryId === lease.repositoryId &&
    observation.hostId === lease.hostId &&
    observation.gitRuntime === lease.gitRuntime &&
    observation.projectRoot === lease.projectRoot &&
    observation.branch === lease.branch &&
    observation.worktreePath === lease.worktreePath &&
    observation.attemptId === lease.attemptId
  );
}

function ownedObservation(lease: WorkspaceLifecycleLeaseRecord, observation: WorkspaceObservation) {
  return (
    observation.exists &&
    observation.registered &&
    !observation.reason &&
    sameIdentity(lease, observation)
  );
}

function activationObservation(
  lease: WorkspaceLifecycleLeaseRecord,
  observation: WorkspaceObservation
) {
  return (
    ownedObservation(lease, observation) &&
    observation.cleanliness === "clean" &&
    observation.headSha === lease.baseSha
  );
}

function releaseObservation(
  lease: WorkspaceLifecycleLeaseRecord,
  observation: WorkspaceObservation
) {
  return ownedObservation(lease, observation) && observation.cleanliness === "clean";
}

function syntheticObservation(
  target: WorktreeTarget,
  failure: BrokerFailure
): WorkspaceObservation {
  return {
    exists: false,
    registered: false,
    repositoryId: target.repositoryId,
    hostId: target.hostId,
    gitRuntime: target.gitRuntime,
    projectRoot: target.projectRoot,
    branch: target.branch,
    worktreePath: target.worktreePath,
    attemptId: target.attemptId,
    headSha: null,
    cleanliness: "dirty",
    reason: brokerEvidence(failure),
  };
}

function bounded(value: string) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= MAX_REASON_LENGTH) return value;
  let end = MAX_REASON_LENGTH - 3;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return Buffer.concat([encoded.subarray(0, end), Buffer.from("…")]).toString("utf8");
}

function boundedObservation(observation: WorkspaceObservation): WorkspaceObservation {
  return {
    ...observation,
    ...(observation.reason ? { reason: bounded(observation.reason) } : {}),
    ...(observation.dirtyPaths
      ? { dirtyPaths: observation.dirtyPaths.slice(0, MAX_DIRTY_PATHS).map(bounded) }
      : {}),
  };
}

function brokerEvidence(failure: BrokerFailure): string {
  return bounded(
    JSON.stringify({
      operation: failure.operation,
      reason: failure.reason,
      message: failure.message,
      ...(failure.command
        ? {
            command: {
              executable: failure.command.executable,
              args: failure.command.args,
              cwd: failure.command.cwd,
              exitCode: failure.command.exitCode,
              stdoutTail: bounded(failure.command.stdoutTail),
              stderrTail: bounded(failure.command.stderrTail),
            },
          }
        : {}),
    })
  );
}

function thrownBrokerFailure(operation: BrokerFailure["operation"], error: unknown): BrokerFailure {
  return {
    ok: false,
    operation,
    reason: "command_failed",
    message: bounded(error instanceof Error ? error.message : String(error)),
  };
}

function success(
  outcome: WorkspaceCoordinatorSuccess["outcome"],
  attempt: AttemptRecord,
  workspaceLease: WorkspaceLifecycleLeaseRecord,
  observation: WorkspaceObservation,
  idempotentReplay: boolean
): WorkspaceCoordinatorSuccess {
  return { ok: true, outcome, attempt, workspaceLease, observation, idempotentReplay };
}

function storeFailure(
  phase: WorkspaceCoordinatorPhase,
  result: WorkspaceMutationResult
): WorkspaceCoordinatorFailure {
  return {
    ok: false,
    phase,
    reason:
      !result.updated && result.reason === "removal_operation_pending"
        ? "reconciliation_required"
        : "store_rejected",
    storeResult: result,
    quarantineAttempted: false,
  };
}

function mutationSuccess(
  outcome: WorkspaceCoordinatorSuccess["outcome"],
  phase: WorkspaceCoordinatorPhase,
  result: WorkspaceMutationResult,
  observation: WorkspaceObservation
): WorkspaceCoordinatorResult {
  if (!result.updated || !result.workspaceLease) return storeFailure(phase, result);
  if (
    result.workspaceLease.status !== "active" ||
    !boundPair(result.attempt, result.workspaceLease)
  ) {
    return {
      ok: false,
      phase,
      reason: "reconciliation_required",
      storeResult: result,
      attempt: result.attempt,
      workspaceLease: result.workspaceLease,
      quarantineAttempted: result.workspaceLease.status === "quarantined",
    };
  }
  return success(
    outcome,
    result.attempt,
    result.workspaceLease,
    observation,
    result.idempotentReplay
  );
}

function reconciliation(
  phase: WorkspaceCoordinatorPhase,
  current: { attempt: AttemptRecord | null; lease: WorkspaceLifecycleLeaseRecord | null }
): WorkspaceCoordinatorFailure {
  return {
    ok: false,
    phase,
    reason: "reconciliation_required",
    ...(current.attempt ? { attempt: current.attempt } : {}),
    ...(current.lease ? { workspaceLease: current.lease } : {}),
    quarantineAttempted: false,
  };
}
