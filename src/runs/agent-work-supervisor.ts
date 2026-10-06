import { z } from "zod";

import {
  AgentTaskPacket_v1,
  AgentTaskReceipt_v2,
  ExecutionEnvelope_v1,
  type HumanActionRequest_v1,
  isTerminalAttemptStatus,
  type AgentTaskReceipt_v2 as AgentTaskReceipt,
} from "../schemas/agent-work.js";
import { computeCanonicalHash } from "../schemas/task-contract.js";
import type {
  ControllerLeaseCredential,
  CoordinationStore,
  JsonValue,
} from "../store/coordination-store.js";
import type {
  AttemptAcceptanceStore,
  AttemptReceiptRecord,
  AttemptReceiptStore,
  AttemptVerificationRecord,
  AttemptVerificationStore,
  LaunchEnvelopeBindingRecord,
  LaunchEnvelopeBindingStore,
  TaskPacketBindingRecord,
  TaskPacketBindingStore,
  WorkerAuthorityDecisionStore,
  WorkerSessionRecord,
  WorkerSessionStore,
  WorkspaceLifecycleLeaseRecord,
  WorkspaceLifecycleStore,
  WorkspaceObservation,
} from "../store/workspace-lifecycle-store.js";
import { AgentWorkAttemptReceiptService } from "./agent-work-attempt-receipt-service.js";
import type { AttemptVerificationRuntime } from "./agent-work-attempt-verification-runtime.js";
import {
  AgentWorkAttemptAcceptanceService,
  AgentWorkAttemptVerificationService,
} from "./agent-work-attempt-verification-service.js";
import { AgentWorkWorkerSessionService } from "./agent-work-worker-session-service.js";
import {
  AgentWorkHumanActionService,
  humanActionSummary,
  readHumanActionState,
} from "./agent-work-human-action-service.js";
import {
  AgentWorkWorkerAdapterNegotiator,
  WorkerAdapterSelection_v1,
} from "./agent-work-worker-runtime.js";

const instant = z.string().datetime({ offset: true });

export const HeadlessSupervisorConfig = z
  .object({
    controllerTtlMs: z
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60 * 1_000),
    workspaceTtlMs: z
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60 * 1_000),
    heartbeatTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60 * 1_000),
    maxAttemptsPerWorkItem: z.number().int().positive().max(100),
    maxConcurrency: z.number().int().positive().max(16),
    retryBaseDelayMs: z
      .number()
      .int()
      .nonnegative()
      .max(24 * 60 * 60 * 1_000),
    retryMaxDelayMs: z
      .number()
      .int()
      .nonnegative()
      .max(7 * 24 * 60 * 60 * 1_000),
  })
  .strict()
  .refine((value) => value.retryMaxDelayMs >= value.retryBaseDelayMs, {
    message: "retryMaxDelayMs must be at least retryBaseDelayMs",
  });
export type HeadlessSupervisorConfig = z.infer<typeof HeadlessSupervisorConfig>;

export const DEFAULT_HEADLESS_SUPERVISOR_CONFIG: HeadlessSupervisorConfig = {
  controllerTtlMs: 60_000,
  workspaceTtlMs: 60_000,
  heartbeatTimeoutMs: 30_000,
  maxAttemptsPerWorkItem: 3,
  maxConcurrency: 2,
  retryBaseDelayMs: 5_000,
  retryMaxDelayMs: 5 * 60_000,
};

export type SupervisorAttemptAction =
  | "await_workspace"
  | "await_human"
  | "await_launch"
  | "launch_worker"
  | "resume_workspace"
  | "reconcile_launch"
  | "heartbeat_worker"
  | "collect_receipt"
  | "verify"
  | "accept"
  | "cancel_attempt"
  | "cancel_worker"
  | "mark_worker_lost"
  | "terminal"
  | "retry_backoff"
  | "await_retry_delta"
  | "retry_exhausted"
  | "reconciliation_required";

export interface SupervisorAttemptSnapshot {
  attempt: Awaited<ReturnType<WorkspaceLifecycleStore["getAttempt"]>> & {};
  lease: WorkspaceLifecycleLeaseRecord | null;
  session: WorkerSessionRecord | null;
  launch: LaunchEnvelopeBindingRecord | null;
  packet: TaskPacketBindingRecord | null;
  receipt: AttemptReceiptRecord | null;
  verification: AttemptVerificationRecord | null;
  attemptOrdinal: number;
}

export interface SupervisorAttemptPlan {
  attemptId: string;
  action: SupervisorAttemptAction;
  reason: string;
  nextEligibleAt?: string;
}

export interface SupervisorWorkerObservation {
  state: "running" | "awaiting_human" | "completed" | "failed" | "cancelled" | "lost";
  exitCode?: number;
  summary?: string;
  /** Full request data, persisted before the host displays a question. */
  humanActionRequest?: HumanActionRequest_v1;
}

export interface SupervisorWorkerLaunchResult {
  sessionId: string;
  workerId: string;
  backend: WorkerSessionRecord["backend"];
  startedAt: string;
  model?: string;
}

/** Provider-specific headless controls. Stable operation IDs make uncertain re-delivery idempotent. */
export interface HeadlessSupervisorWorkerControl {
  readonly selection: WorkerAdapterSelection_v1;
  launch(input: {
    operationId: string;
    packet: AgentTaskPacket_v1;
    envelope: ExecutionEnvelope_v1;
  }): Promise<SupervisorWorkerLaunchResult>;
  observe(session: WorkerSessionRecord): Promise<SupervisorWorkerObservation>;
  cancel(input: {
    operationId: string;
    session: WorkerSessionRecord;
    reason: string;
  }): Promise<void>;
  collectReceipt(session: WorkerSessionRecord): Promise<AgentTaskReceipt>;
}

export interface HeadlessSupervisorWorkspaceObserver {
  observe(lease: WorkspaceLifecycleLeaseRecord): Promise<WorkspaceObservation>;
}

type SupervisorStore = WorkspaceLifecycleStore &
  LaunchEnvelopeBindingStore &
  TaskPacketBindingStore &
  WorkerSessionStore &
  WorkerAuthorityDecisionStore &
  AttemptReceiptStore &
  AttemptVerificationStore &
  AttemptAcceptanceStore;

export interface ReconcileHeadlessRunInput {
  runId: string;
  initialRunState: JsonValue;
  controllerId: string;
  controllerLeaseId: string;
  now: string;
  config?: Partial<HeadlessSupervisorConfig>;
  cancelAttemptIds?: string[];
  diagnostics?: boolean;
}

export interface SupervisorAttemptResult {
  attemptId: string;
  action: SupervisorAttemptAction;
  outcome: "applied" | "observed" | "deferred" | "failed";
  status: string;
  retryDeltaPresent: boolean;
  nextEligibleAt?: string;
  diagnostics?: { reason: string; storeReason?: string };
}

export type ReconcileHeadlessRunResult =
  | {
      ok: true;
      runId: string;
      fencingToken: number;
      attempts: SupervisorAttemptResult[];
      counts: Record<SupervisorAttemptResult["outcome"], number>;
      humanActions?: ReturnType<typeof humanActionSummary>;
      humanActionCount?: number;
    }
  | {
      ok: false;
      runId: string;
      reason: "controller_held" | "invalid_input" | "human_action_reconciliation_required";
    };

/** Pure deterministic planner used by the live supervisor and fault-injection tests. */
export function planSupervisorAttempt(
  snapshot: SupervisorAttemptSnapshot,
  now: string,
  config: HeadlessSupervisorConfig,
  cancellationRequested = false
): SupervisorAttemptPlan {
  const attempt = snapshot.attempt;
  if (!attempt) {
    return { attemptId: "unknown", action: "reconciliation_required", reason: "attempt_missing" };
  }
  if (isTerminalAttemptStatus(attempt.status)) {
    if (attempt.status === "accepted") {
      return { attemptId: attempt.attemptId, action: "terminal", reason: "accepted" };
    }
    if (snapshot.attemptOrdinal >= config.maxAttemptsPerWorkItem) {
      return {
        attemptId: attempt.attemptId,
        action: "retry_exhausted",
        reason: "attempt_budget_exhausted",
      };
    }
    const nextEligibleAt = retryEligibleAt(
      attempt.completedAt ?? attempt.updatedAt,
      snapshot.attemptOrdinal,
      config
    );
    if (Date.parse(now) < Date.parse(nextEligibleAt)) {
      return {
        attemptId: attempt.attemptId,
        action: "retry_backoff",
        reason: "bounded_retry_backoff",
        nextEligibleAt,
      };
    }
    return {
      attemptId: attempt.attemptId,
      action: "await_retry_delta",
      reason: "new_attempt_requires_delta",
      nextEligibleAt,
    };
  }
  if (cancellationRequested) {
    return snapshot.session
      ? {
          attemptId: attempt.attemptId,
          action: "cancel_worker",
          reason: "explicit_cancellation",
        }
      : {
          attemptId: attempt.attemptId,
          action: "cancel_attempt",
          reason: "explicit_cancellation_before_attachment",
        };
  }
  if (attempt.status === "prepared") {
    return {
      attemptId: attempt.attemptId,
      action: "await_workspace",
      reason: "workspace_not_leased",
    };
  }
  if (!snapshot.lease) {
    return {
      attemptId: attempt.attemptId,
      action: "reconciliation_required",
      reason: "workspace_binding_missing",
    };
  }
  if (attempt.status === "leased") {
    return {
      attemptId: attempt.attemptId,
      action: "await_launch",
      reason: "launch_not_authorized",
    };
  }
  if (attempt.status === "launching") {
    if (!snapshot.launch || !snapshot.packet) {
      return {
        attemptId: attempt.attemptId,
        action: "reconcile_launch",
        reason: "durable_launch_binding_missing",
      };
    }
    return snapshot.session
      ? { attemptId: attempt.attemptId, action: "heartbeat_worker", reason: "worker_attached" }
      : { attemptId: attempt.attemptId, action: "launch_worker", reason: "launch_binding_ready" };
  }
  if (attempt.status === "running") {
    if (!snapshot.session) {
      return {
        attemptId: attempt.attemptId,
        action: "reconciliation_required",
        reason: "running_worker_missing",
      };
    }
    if (snapshot.session.status === "completed") {
      return { attemptId: attempt.attemptId, action: "collect_receipt", reason: "receipt_missing" };
    }
    if (["failed", "cancelled", "lost"].includes(snapshot.session.status)) {
      return {
        attemptId: attempt.attemptId,
        action: "reconciliation_required",
        reason: "attempt_worker_terminal_mismatch",
      };
    }
    if (Date.parse(now) - Date.parse(snapshot.session.heartbeatAt) >= config.heartbeatTimeoutMs) {
      return {
        attemptId: attempt.attemptId,
        action: "mark_worker_lost",
        reason: "heartbeat_expired",
      };
    }
    return { attemptId: attempt.attemptId, action: "heartbeat_worker", reason: "worker_live" };
  }
  if (attempt.status === "receipt_submitted" || attempt.status === "verifying") {
    return snapshot.verification
      ? { attemptId: attempt.attemptId, action: "accept", reason: "verification_recorded" }
      : { attemptId: attempt.attemptId, action: "verify", reason: "verification_pending" };
  }
  if (attempt.status === "verified") {
    return { attemptId: attempt.attemptId, action: "accept", reason: "policy_pending" };
  }
  return {
    attemptId: attempt.attemptId,
    action: "reconciliation_required",
    reason: `unsupported_state:${attempt.status}`,
  };
}

/** First production-shaped restart supervisor over the durable ADR-010 stores. */
export class AgentWorkHeadlessSupervisor {
  private readonly receipts: AgentWorkAttemptReceiptService;
  private readonly configDefaults: HeadlessSupervisorConfig;

  constructor(
    private readonly coordination: CoordinationStore,
    private readonly store: SupervisorStore,
    private readonly workerSessions: AgentWorkWorkerSessionService,
    private readonly workerAdapters: AgentWorkWorkerAdapterNegotiator,
    private readonly verification: AgentWorkAttemptVerificationService,
    private readonly workspaceObserver: HeadlessSupervisorWorkspaceObserver,
    private readonly workerControl: HeadlessSupervisorWorkerControl,
    defaults: HeadlessSupervisorConfig = DEFAULT_HEADLESS_SUPERVISOR_CONFIG
  ) {
    this.configDefaults = HeadlessSupervisorConfig.parse(defaults);
    this.receipts = new AgentWorkAttemptReceiptService(store);
  }

  static withVerificationRuntime(input: {
    coordination: CoordinationStore;
    store: SupervisorStore;
    workerSessions: AgentWorkWorkerSessionService;
    workerAdapters: AgentWorkWorkerAdapterNegotiator;
    verificationRuntime: AttemptVerificationRuntime;
    workspaceObserver: HeadlessSupervisorWorkspaceObserver;
    workerControl: HeadlessSupervisorWorkerControl;
    now?: () => string;
    defaults?: HeadlessSupervisorConfig;
  }): AgentWorkHeadlessSupervisor {
    return new AgentWorkHeadlessSupervisor(
      input.coordination,
      input.store,
      input.workerSessions,
      input.workerAdapters,
      new AgentWorkAttemptVerificationService(input.store, input.verificationRuntime, input.now),
      input.workspaceObserver,
      input.workerControl,
      input.defaults
    );
  }

  async reconcileRun(input: ReconcileHeadlessRunInput): Promise<ReconcileHeadlessRunResult> {
    if (!instant.safeParse(input.now).success) {
      return { ok: false, runId: input.runId, reason: "invalid_input" };
    }
    let config: HeadlessSupervisorConfig;
    try {
      config = HeadlessSupervisorConfig.parse({ ...this.configDefaults, ...input.config });
    } catch {
      return { ok: false, runId: input.runId, reason: "invalid_input" };
    }
    const acquired = await this.coordination.acquireControllerLease({
      runId: input.runId,
      controllerId: input.controllerId,
      leaseId: input.controllerLeaseId,
      now: input.now,
      ttlMs: config.controllerTtlMs,
      initialState: input.initialRunState,
    });
    if (!acquired.acquired) return { ok: false, runId: input.runId, reason: "controller_held" };
    const controller = credential(acquired.lease);
    const attempts = await this.store.listAttempts(input.runId);
    const ordinals = attemptOrdinals(attempts);
    const cancellation = new Set(input.cancelAttemptIds ?? []);
    const results: SupervisorAttemptResult[] = [];
    const workerObservations = new Map<string, SupervisorWorkerObservation>();

    // Observe live workers before launching any sibling. A durable hold survives
    // a fresh controller and prevents completion/acceptance from hiding a question.
    // This controls supervisor progress; the adapter must enforce worker suspension.
    try {
      let record = acquired.record;
      let holds = humanActionSummary(record.state, input.now);
      if (!holds.length) {
        const humans = new AgentWorkHumanActionService(
          this.coordination,
          this.store,
          this.workspaceObserver
        );
        for (const attempt of attempts) {
          const session = await this.store.getWorkerSessionForAttempt(attempt.attemptId);
          if (!session || !["running", "awaiting_human"].includes(session.status)) continue;
          const observed = await this.workerControl.observe(session);
          workerObservations.set(session.sessionId, observed);
          if (observed.state !== "awaiting_human") continue;
          record = (await this.coordination.getRunCoordination(input.runId))!;
          const lease = await this.store.getWorkspaceLease(session.workspaceLeaseId);
          if (!lease)
            return {
              ok: false,
              runId: input.runId,
              reason: "human_action_reconciliation_required",
            };
          const workspace = await this.workspaceObserver.observe(lease);
          if (!workspace.headSha)
            return {
              ok: false,
              runId: input.runId,
              reason: "human_action_reconciliation_required",
            };
          const fallbackId = `human:${session.sessionId}:${session.revision}`;
          const prior = readHumanActionState(record.state).entries.find(
            (entry) => entry.request.request_id === fallbackId
          );
          const request = observed.humanActionRequest ??
            prior?.request ?? {
              schema_version: "1.0.0" as const,
              request_id: fallbackId,
              run_id: input.runId,
              attempt_id: attempt.attemptId,
              workspace_lease_id: lease.leaseId,
              worker_session_id: session.sessionId,
              action: "other" as const,
              summary: observed.summary ?? "Worker requires a human decision.",
              instructions: [
                "Resolve this request through the host's human-response channel before continuing.",
              ],
              suggested_commands: [],
              preconditions: {
                run_revision: record.revision,
                workspace_lease_revision: lease.revision,
                expected_head_sha: workspace.headSha,
              },
              requested_at: input.now,
            };
          const existing = readHumanActionState(record.state).entries.find(
            (entry) => entry.request.request_id === request.request_id
          );
          if (existing?.supersededBy || existing?.receipt?.outcome === "completed")
            return {
              ok: false,
              runId: input.runId,
              reason: "human_action_reconciliation_required",
            };
          if (
            request.run_id !== input.runId ||
            request.attempt_id !== attempt.attemptId ||
            request.worker_session_id !== session.sessionId ||
            request.workspace_lease_id !== lease.leaseId
          )
            return {
              ok: false,
              runId: input.runId,
              reason: "human_action_reconciliation_required",
            };
          const stored = await humans.request({
            controller,
            expectedRunRevision: record.revision,
            mutationId: `human-request:${request.request_id}`,
            now: input.now,
            request,
          });
          if (!stored.ok)
            return {
              ok: false,
              runId: input.runId,
              reason: "human_action_reconciliation_required",
            };
        }
        record = (await this.coordination.getRunCoordination(input.runId))!;
        holds = humanActionSummary(record.state, input.now);
      }
      if (holds.length) {
        // Explicit cancellation remains available while held. No receipt,
        // verification, acceptance or new launch is allowed to advance the run.
        for (const attempt of attempts) {
          if (cancellation.has(attempt.attemptId)) {
            results.push(
              await this.reconcileAttempt({
                attemptId: attempt.attemptId,
                runRevision: record.revision,
                controller,
                now: input.now,
                config,
                attemptOrdinal: ordinals.get(attempt.attemptId) ?? 1,
                cancellationRequested: true,
                diagnostics: input.diagnostics ?? false,
              })
            );
          } else
            results.push({
              attemptId: attempt.attemptId,
              action: "await_human",
              outcome: "deferred",
              status: attempt.status,
              retryDeltaPresent: false,
            });
        }
        return {
          ok: true,
          runId: input.runId,
          fencingToken: acquired.lease.fencingToken,
          attempts: results,
          counts: countResults(results),
          humanActions: holds.slice(0, 8),
          humanActionCount: holds.length,
        };
      }
      acquired.record = record;
    } catch {
      return { ok: false, runId: input.runId, reason: "human_action_reconciliation_required" };
    }

    for (let offset = 0; offset < attempts.length; offset += config.maxConcurrency) {
      const slice = attempts.slice(offset, offset + config.maxConcurrency);
      const settled = await Promise.all(
        slice.map((attempt) =>
          this.reconcileAttempt({
            attemptId: attempt.attemptId,
            runRevision: acquired.record.revision,
            controller,
            now: input.now,
            config,
            attemptOrdinal: ordinals.get(attempt.attemptId) ?? 1,
            cancellationRequested: cancellation.has(attempt.attemptId),
            diagnostics: input.diagnostics ?? false,
            workerObservations,
          })
        )
      );
      results.push(...settled);
    }
    results.sort((left, right) => left.attemptId.localeCompare(right.attemptId));
    return {
      ok: true,
      runId: input.runId,
      fencingToken: acquired.lease.fencingToken,
      attempts: results,
      counts: countResults(results),
    };
  }

  private async reconcileAttempt(input: {
    attemptId: string;
    runRevision: number;
    controller: ControllerLeaseCredential;
    now: string;
    config: HeadlessSupervisorConfig;
    attemptOrdinal: number;
    cancellationRequested: boolean;
    diagnostics: boolean;
    workerObservations?: Map<string, SupervisorWorkerObservation>;
  }): Promise<SupervisorAttemptResult> {
    try {
      // Recheck after asynchronous preparation/other controller activity.
      const current = await this.coordination.getRunCoordination(input.controller.runId);
      if (
        !current ||
        (!input.cancellationRequested && humanActionSummary(current.state, input.now).length)
      )
        return {
          attemptId: input.attemptId,
          action: "await_human",
          outcome: "deferred",
          status: "held",
          retryDeltaPresent: false,
        };
      if (current.revision !== input.runRevision)
        return failureResult(input, "reconciliation_required", "stale_run_revision");
      let snapshot = await this.snapshot(input.attemptId, input.attemptOrdinal);
      if (!snapshot?.attempt)
        return failureResult(input, "reconciliation_required", "attempt_missing");
      if (
        !isTerminalAttemptStatus(snapshot.attempt.status) &&
        snapshot.lease &&
        needsLeaseReconciliation(snapshot.lease, input.controller, input.now)
      ) {
        const observation = await this.workspaceObserver.observe(snapshot.lease);
        const resumed = await this.store.reconcileWorkspace({
          runId: snapshot.attempt.runId,
          expectedRunRevision: input.runRevision,
          controller: input.controller,
          mutationId: operationId(
            snapshot.attempt.attemptId,
            "workspace-resume",
            snapshot.lease.revision
          ),
          now: input.now,
          attemptId: snapshot.attempt.attemptId,
          workspaceLeaseId: snapshot.lease.leaseId,
          expectedAttemptRevision: snapshot.attempt.revision,
          expectedWorkspaceLeaseRevision: snapshot.lease.revision,
          action: "resume",
          ttlMs: input.config.workspaceTtlMs,
          observation,
        });
        return mutationResult(
          input,
          snapshot.attempt.attemptId,
          "resume_workspace",
          resumed,
          "workspace_reconciled"
        );
      }

      const plan = planSupervisorAttempt(
        snapshot,
        input.now,
        input.config,
        input.cancellationRequested
      );
      if (
        [
          "await_workspace",
          "await_launch",
          "terminal",
          "retry_backoff",
          "await_retry_delta",
          "retry_exhausted",
          "reconciliation_required",
        ].includes(plan.action)
      ) {
        const delta = await this.store.getAttemptRetryDelta(plan.attemptId);
        return {
          attemptId: plan.attemptId,
          action: plan.action,
          outcome: plan.action === "reconciliation_required" ? "failed" : "deferred",
          status: snapshot.attempt.status,
          retryDeltaPresent: Boolean(delta),
          ...(plan.nextEligibleAt ? { nextEligibleAt: plan.nextEligibleAt } : {}),
          ...(input.diagnostics ? { diagnostics: { reason: plan.reason } } : {}),
        };
      }

      if (plan.action === "reconcile_launch") {
        const result = await this.store.reconcileIncompleteLaunch({
          runId: snapshot.attempt.runId,
          expectedRunRevision: input.runRevision,
          controller: input.controller,
          mutationId: operationId(
            snapshot.attempt.attemptId,
            "launch-reconcile",
            snapshot.attempt.revision
          ),
          now: input.now,
          attemptId: snapshot.attempt.attemptId,
          workspaceLeaseId: snapshot.lease!.leaseId,
          expectedAttemptRevision: snapshot.attempt.revision,
          expectedWorkspaceLeaseRevision: snapshot.lease!.revision,
        });
        return mutationResult(input, plan.attemptId, plan.action, result, plan.reason);
      }

      if (plan.action === "launch_worker") {
        return await this.launchWorker(snapshot, input, plan);
      }

      if (plan.action === "cancel_attempt") {
        const result = await this.store.transitionAttempt({
          runId: snapshot.attempt.runId,
          expectedRunRevision: input.runRevision,
          controller: input.controller,
          mutationId: operationId(plan.attemptId, "cancel-attempt", snapshot.attempt.revision),
          now: input.now,
          attemptId: plan.attemptId,
          expectedAttemptRevision: snapshot.attempt.revision,
          status: "cancelled",
          details: { reason: "supervisor_cancelled_before_worker_attachment" },
        });
        return mutationResult(input, plan.attemptId, plan.action, result, plan.reason);
      }

      if (plan.action === "cancel_worker") {
        await this.workerControl.cancel({
          operationId: operationId(plan.attemptId, "cancel", snapshot.session!.revision),
          session: snapshot.session!,
          reason: "Supervisor cancellation requested",
        });
        const result = await this.endWorker(snapshot, input, "cancelled", "supervisor_cancelled");
        return workerMutationResult(input, plan, result);
      }

      if (plan.action === "mark_worker_lost") {
        const observed =
          input.workerObservations?.get(snapshot.session!.sessionId) ??
          (await this.workerControl.observe(snapshot.session!));
        if (observed.state === "running" || observed.state === "awaiting_human") {
          return await this.heartbeatWorker(snapshot, input, observed.state, plan);
        }
        const result = await this.endWorker(
          snapshot,
          input,
          observed.state === "completed" ? "completed" : observed.state,
          "heartbeat_reconciliation",
          observed
        );
        return workerMutationResult(input, plan, result);
      }

      if (plan.action === "heartbeat_worker") {
        const observed =
          input.workerObservations?.get(snapshot.session!.sessionId) ??
          (await this.workerControl.observe(snapshot.session!));
        if (observed.state === "running" || observed.state === "awaiting_human") {
          return await this.heartbeatWorker(snapshot, input, observed.state, plan);
        }
        const ended = await this.endWorker(
          snapshot,
          input,
          observed.state === "completed" ? "completed" : observed.state,
          "worker_observation",
          observed
        );
        if (!ended.updated || observed.state !== "completed") {
          return workerMutationResult(input, plan, ended);
        }
        snapshot = (await this.snapshot(plan.attemptId, input.attemptOrdinal))!;
        return await this.collectReceipt(snapshot, input, { ...plan, action: "collect_receipt" });
      }

      if (plan.action === "collect_receipt")
        return await this.collectReceipt(snapshot, input, plan);
      if (plan.action === "verify") return await this.verifyAttempt(snapshot, input, plan);
      if (plan.action === "accept") return await this.acceptAttempt(snapshot, input, plan);
      return failureResult(input, plan.action, "unsupported_supervisor_action");
    } catch {
      return failureResult(input, "reconciliation_required", "supervisor_infrastructure_failure");
    }
  }

  private async launchWorker(
    snapshot: SupervisorAttemptSnapshot,
    input: Parameters<AgentWorkHeadlessSupervisor["reconcileAttempt"]>[0],
    plan: SupervisorAttemptPlan
  ): Promise<SupervisorAttemptResult> {
    if (
      snapshot.launch!.attemptRevision !== snapshot.attempt!.revision ||
      snapshot.launch!.workspaceLeaseRevision !== snapshot.lease!.revision ||
      snapshot.launch!.controllerId !== input.controller.controllerId ||
      snapshot.launch!.controllerLeaseId !== input.controller.leaseId ||
      snapshot.launch!.fencingToken !== input.controller.fencingToken
    ) {
      const result = await this.store.transitionAttempt({
        runId: snapshot.attempt!.runId,
        expectedRunRevision: input.runRevision,
        controller: input.controller,
        mutationId: operationId(
          snapshot.attempt!.attemptId,
          "stale-launch-authority",
          snapshot.attempt!.revision
        ),
        now: input.now,
        attemptId: snapshot.attempt!.attemptId,
        expectedAttemptRevision: snapshot.attempt!.revision,
        status: "launch_failed",
        details: { reason: "stale_launch_authority" },
      });
      return mutationResult(input, plan.attemptId, plan.action, result, "stale_launch_authority");
    }
    const packet = AgentTaskPacket_v1.parse(JSON.parse(snapshot.packet!.packetJson));
    const envelope = ExecutionEnvelope_v1.parse(JSON.parse(snapshot.launch!.envelopeJson));
    const selection = WorkerAdapterSelection_v1.parse(this.workerControl.selection);
    const negotiated = await this.workerAdapters.negotiate(snapshot.attempt!.attemptId, selection);
    if (!negotiated.go) {
      const result = await this.store.transitionAttempt({
        runId: snapshot.attempt!.runId,
        expectedRunRevision: input.runRevision,
        controller: input.controller,
        mutationId: operationId(
          snapshot.attempt!.attemptId,
          "launch-denied",
          snapshot.attempt!.revision
        ),
        now: input.now,
        attemptId: snapshot.attempt!.attemptId,
        expectedAttemptRevision: snapshot.attempt!.revision,
        status: "launch_failed",
        details: {
          reason: negotiated.reason,
          blockedDimensionCount: negotiated.blockedDimensions.length,
        },
      });
      return mutationResult(
        input,
        plan.attemptId,
        plan.action,
        result,
        "adapter_negotiation_denied"
      );
    }
    const current = await this.coordination.getRunCoordination(input.controller.runId);
    const lease = current?.lease;
    if (
      !current ||
      current.revision !== input.runRevision ||
      humanActionSummary(current.state, input.now).length ||
      !lease ||
      lease.fencingToken !== input.controller.fencingToken ||
      lease.controllerId !== input.controller.controllerId ||
      lease.leaseId !== input.controller.leaseId ||
      Date.parse(lease.expiresAt) <= Date.parse(input.now)
    )
      return failureResult(input, "reconciliation_required", "dispatch_admission_changed");
    const launched = await this.workerControl.launch({
      operationId: operationId(plan.attemptId, "launch", snapshot.attempt!.revision),
      packet,
      envelope,
    });
    if (launched.backend !== negotiated.adapter.session_backend) {
      throw new Error("Headless provider returned a mismatched backend identity");
    }
    const attached = await this.workerSessions.attach({
      runId: snapshot.attempt!.runId,
      expectedRunRevision: input.runRevision,
      controller: input.controller,
      attemptId: snapshot.attempt!.attemptId,
      expectedAttemptRevision: snapshot.attempt!.revision,
      workspaceLeaseId: snapshot.lease!.leaseId,
      expectedWorkspaceLeaseRevision: snapshot.lease!.revision,
      sessionId: launched.sessionId,
      envelope,
      backend: launched.backend,
      workerId: launched.workerId,
      ...(launched.model ? { model: launched.model } : {}),
      startedAt: launched.startedAt,
      adapter: {
        adapterId: negotiated.adapter.id,
        adapterVersion: negotiated.adapter.version,
        enforcementSummaryHash: negotiated.enforcementSummaryHash,
        trustGapDimensions: negotiated.trustGaps,
      },
      mutationId: operationId(plan.attemptId, "worker-attach", snapshot.attempt!.revision),
      now: input.now,
    });
    return workerMutationResult(input, plan, attached);
  }

  private async heartbeatWorker(
    snapshot: SupervisorAttemptSnapshot,
    input: Parameters<AgentWorkHeadlessSupervisor["reconcileAttempt"]>[0],
    state: "running" | "awaiting_human",
    plan: SupervisorAttemptPlan
  ): Promise<SupervisorAttemptResult> {
    const observation = await this.workspaceObserver.observe(snapshot.lease!);
    const workspace = await this.store.heartbeatWorkspace({
      runId: snapshot.attempt!.runId,
      expectedRunRevision: input.runRevision,
      controller: input.controller,
      mutationId: operationId(plan.attemptId, "workspace-heartbeat", snapshot.lease!.revision),
      now: input.now,
      attemptId: plan.attemptId,
      workspaceLeaseId: snapshot.lease!.leaseId,
      expectedAttemptRevision: snapshot.attempt!.revision,
      expectedWorkspaceLeaseRevision: snapshot.lease!.revision,
      ttlMs: input.config.workspaceTtlMs,
      observation,
    });
    if (!workspace.updated)
      return mutationResult(input, plan.attemptId, plan.action, workspace, plan.reason);
    const worker = await this.store.heartbeatWorkerSession({
      runId: snapshot.attempt!.runId,
      expectedRunRevision: input.runRevision,
      controller: input.controller,
      mutationId: operationId(plan.attemptId, "worker-heartbeat", snapshot.session!.revision),
      now: input.now,
      attemptId: plan.attemptId,
      expectedAttemptRevision: workspace.attempt.revision,
      workspaceLeaseId: workspace.workspaceLease!.leaseId,
      expectedWorkspaceLeaseRevision: workspace.workspaceLease!.revision,
      sessionId: snapshot.session!.sessionId,
      expectedSessionRevision: snapshot.session!.revision,
      status: state,
    });
    return workerMutationResult(input, plan, worker);
  }

  private async endWorker(
    snapshot: SupervisorAttemptSnapshot,
    input: Parameters<AgentWorkHeadlessSupervisor["reconcileAttempt"]>[0],
    status: "completed" | "failed" | "cancelled" | "lost",
    reason: string,
    observed?: SupervisorWorkerObservation
  ) {
    return this.store.endWorkerSession({
      runId: snapshot.attempt!.runId,
      expectedRunRevision: input.runRevision,
      controller: input.controller,
      mutationId: operationId(
        snapshot.attempt!.attemptId,
        `worker-end-${status}`,
        snapshot.session!.revision
      ),
      now: input.now,
      attemptId: snapshot.attempt!.attemptId,
      expectedAttemptRevision: snapshot.attempt!.revision,
      workspaceLeaseId: snapshot.lease!.leaseId,
      expectedWorkspaceLeaseRevision: snapshot.lease!.revision,
      sessionId: snapshot.session!.sessionId,
      expectedSessionRevision: snapshot.session!.revision,
      status,
      exitReason: reason,
      ...(observed?.exitCode !== undefined ? { exitCode: observed.exitCode } : {}),
      ...(observed?.summary ? { exitSummary: observed.summary } : {}),
    });
  }

  private async collectReceipt(
    snapshot: SupervisorAttemptSnapshot,
    input: Parameters<AgentWorkHeadlessSupervisor["reconcileAttempt"]>[0],
    plan: SupervisorAttemptPlan
  ): Promise<SupervisorAttemptResult> {
    let session = snapshot.session!;
    if (session.status !== "completed") {
      const ended = await this.endWorker(snapshot, input, "completed", "receipt_collection");
      if (!ended.updated) return workerMutationResult(input, plan, ended);
      session = ended.workerSession;
      snapshot = (await this.snapshot(plan.attemptId, input.attemptOrdinal))!;
    }
    const receipt = AgentTaskReceipt_v2.parse(await this.workerControl.collectReceipt(session));
    const submitted = await this.receipts.submit({
      runId: snapshot.attempt!.runId,
      expectedRunRevision: input.runRevision,
      controller: input.controller,
      mutationId: operationId(plan.attemptId, "receipt-submit", session.revision),
      now: input.now,
      attemptId: plan.attemptId,
      expectedAttemptRevision: snapshot.attempt!.revision,
      workspaceLeaseId: snapshot.lease!.leaseId,
      expectedWorkspaceLeaseRevision: snapshot.lease!.revision,
      workerSessionId: session.sessionId,
      expectedWorkerSessionRevision: session.revision,
      receipt,
    });
    return {
      attemptId: plan.attemptId,
      action: plan.action,
      outcome: submitted.submitted ? "applied" : "failed",
      status: submitted.submitted ? submitted.attemptStatus : snapshot.attempt!.status,
      retryDeltaPresent: false,
      ...(input.diagnostics
        ? {
            diagnostics: {
              reason: submitted.submitted ? plan.reason : submitted.reason,
            },
          }
        : {}),
    };
  }

  private async verifyAttempt(
    snapshot: SupervisorAttemptSnapshot,
    input: Parameters<AgentWorkHeadlessSupervisor["reconcileAttempt"]>[0],
    plan: SupervisorAttemptPlan
  ): Promise<SupervisorAttemptResult> {
    const receipt = snapshot.receipt!;
    const session = snapshot.session!;
    const verificationId = `verification:${plan.attemptId}`;
    const result = await this.verification.run({
      runId: snapshot.attempt!.runId,
      expectedRunRevision: input.runRevision,
      controller: input.controller,
      verificationId,
      attemptId: plan.attemptId,
      expectedAttemptRevision: snapshot.attempt!.revision,
      workspaceLeaseId: snapshot.lease!.leaseId,
      expectedWorkspaceLeaseRevision: snapshot.lease!.revision,
      workerSessionId: session.sessionId,
      expectedWorkerSessionRevision: session.revision,
      receiptId: receipt.receiptId,
      receiptHash: receipt.receiptHash,
      beginMutationId: operationId(
        plan.attemptId,
        "verification-begin",
        snapshot.attempt!.revision
      ),
      completeMutationId: operationId(
        plan.attemptId,
        "verification-complete",
        snapshot.attempt!.revision
      ),
    });
    return {
      attemptId: plan.attemptId,
      action: plan.action,
      outcome: result.recorded ? "applied" : "failed",
      status: result.recorded ? result.attemptStatus : snapshot.attempt!.status,
      retryDeltaPresent: false,
      ...(input.diagnostics
        ? { diagnostics: { reason: result.recorded ? plan.reason : result.reason } }
        : {}),
    };
  }

  private async acceptAttempt(
    snapshot: SupervisorAttemptSnapshot,
    input: Parameters<AgentWorkHeadlessSupervisor["reconcileAttempt"]>[0],
    plan: SupervisorAttemptPlan
  ): Promise<SupervisorAttemptResult> {
    const verification = snapshot.verification!;
    const receipt = snapshot.receipt!;
    const session = snapshot.session!;
    const result = await new AgentWorkAttemptAcceptanceService(this.store, () => input.now).apply({
      runId: snapshot.attempt!.runId,
      expectedRunRevision: input.runRevision,
      controller: input.controller,
      mutationId: operationId(plan.attemptId, "acceptance", snapshot.attempt!.revision),
      attemptId: plan.attemptId,
      expectedAttemptRevision: snapshot.attempt!.revision,
      workspaceLeaseId: snapshot.lease!.leaseId,
      expectedWorkspaceLeaseRevision: snapshot.lease!.revision,
      workerSessionId: session.sessionId,
      expectedWorkerSessionRevision: session.revision,
      receiptId: receipt.receiptId,
      receiptHash: receipt.receiptHash,
      verificationId: verification.verificationId,
      verificationHash: verification.verificationHash,
    });
    return {
      attemptId: plan.attemptId,
      action: plan.action,
      outcome: result.applied ? "applied" : "failed",
      status: result.applied ? result.decision : snapshot.attempt!.status,
      retryDeltaPresent: false,
      ...(input.diagnostics
        ? { diagnostics: { reason: result.applied ? plan.reason : result.reason } }
        : {}),
    };
  }

  private async snapshot(
    attemptId: string,
    attemptOrdinal: number
  ): Promise<SupervisorAttemptSnapshot | null> {
    const attempt = await this.store.getAttempt(attemptId);
    if (!attempt) return null;
    const [lease, session, launch, packet, receipt, verification] = await Promise.all([
      attempt.workspaceLeaseId ? this.store.getWorkspaceLease(attempt.workspaceLeaseId) : null,
      this.store.getWorkerSessionForAttempt(attemptId),
      this.store.getLaunchEnvelopeBinding(attemptId),
      this.store.getTaskPacketBinding(attemptId),
      this.store.getAttemptReceiptForAttempt(attemptId),
      this.store.getAttemptVerificationForAttempt(attemptId),
    ]);
    return { attempt, lease, session, launch, packet, receipt, verification, attemptOrdinal };
  }
}

function attemptOrdinals(
  attempts: NonNullable<SupervisorAttemptSnapshot["attempt"]>[]
): Map<string, number> {
  const counts = new Map<string, number>();
  const ordinals = new Map<string, number>();
  for (const attempt of attempts) {
    const key = `${attempt.workItemId}\u0000${attempt.workItemRevision}`;
    const ordinal = (counts.get(key) ?? 0) + 1;
    counts.set(key, ordinal);
    ordinals.set(attempt.attemptId, ordinal);
  }
  return ordinals;
}

function retryEligibleAt(
  completedAt: string,
  ordinal: number,
  config: HeadlessSupervisorConfig
): string {
  const exponent = Math.max(0, ordinal - 1);
  const delay = Math.min(config.retryMaxDelayMs, config.retryBaseDelayMs * 2 ** exponent);
  return new Date(Date.parse(completedAt) + delay).toISOString();
}

function needsLeaseReconciliation(
  lease: WorkspaceLifecycleLeaseRecord,
  controller: ControllerLeaseCredential,
  now: string
): boolean {
  return (
    Date.parse(lease.expiresAt) <= Date.parse(now) ||
    lease.controllerId !== controller.controllerId ||
    lease.controllerLeaseId !== controller.leaseId ||
    lease.fencingToken !== controller.fencingToken
  );
}

function operationId(attemptId: string, action: string, revision: number): string {
  return `supervisor:${computeCanonicalHash({ attemptId, action, revision }).slice(7, 39)}`;
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

function countResults(
  results: SupervisorAttemptResult[]
): Record<SupervisorAttemptResult["outcome"], number> {
  const counts = { applied: 0, observed: 0, deferred: 0, failed: 0 };
  for (const result of results) counts[result.outcome] += 1;
  return counts;
}

function failureResult(
  input: { attemptId: string; diagnostics: boolean },
  action: SupervisorAttemptAction,
  reason: string
): SupervisorAttemptResult {
  return {
    attemptId: input.attemptId,
    action,
    outcome: "failed",
    status: "unknown",
    retryDeltaPresent: false,
    ...(input.diagnostics ? { diagnostics: { reason } } : {}),
  };
}

function mutationResult(
  input: { diagnostics: boolean },
  attemptId: string,
  action: SupervisorAttemptAction,
  result: Awaited<ReturnType<WorkspaceLifecycleStore["transitionAttempt"]>>,
  reason: string
): SupervisorAttemptResult {
  return {
    attemptId,
    action,
    outcome: result.updated ? "applied" : "failed",
    status: result.updated ? result.attempt.status : "unknown",
    retryDeltaPresent: false,
    ...(input.diagnostics
      ? { diagnostics: { reason, ...(!result.updated ? { storeReason: result.reason } : {}) } }
      : {}),
  };
}

function workerMutationResult(
  input: { diagnostics: boolean },
  plan: SupervisorAttemptPlan,
  result: Awaited<ReturnType<WorkerSessionStore["endWorkerSession"]>>
): SupervisorAttemptResult {
  return {
    attemptId: plan.attemptId,
    action: plan.action,
    outcome: result.updated ? "applied" : "failed",
    status: result.updated ? result.attempt.status : "unknown",
    retryDeltaPresent: false,
    ...(input.diagnostics
      ? {
          diagnostics: {
            reason: plan.reason,
            ...(!result.updated ? { storeReason: result.reason } : {}),
          },
        }
      : {}),
  };
}
