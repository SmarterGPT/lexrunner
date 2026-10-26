import { z } from "zod";

import {
  AgentTaskReceiptOutcome,
  AttemptStatus,
  VerificationOutcome,
  WorkerSessionBackend,
  WorkerSessionStatus,
  WorkspaceCleanupDisposition,
  attemptStatusRequiresReceipt,
  attemptStatusRequiresVerification,
  isTerminalAttemptStatus,
} from "../schemas/agent-work.js";

export {
  AgentTaskReceiptOutcome,
  AttemptStatus,
  VerificationOutcome,
  WorkerSessionBackend,
  WorkerSessionStatus,
  WorkspaceCleanupDisposition,
  attemptStatusRequiresReceipt,
  attemptStatusRequiresVerification,
  isTerminalAttemptStatus,
};

export const WorkspaceLifecycleLeaseStatus = z.enum([
  "reserved",
  "active",
  "released",
  "preserved",
  "abandoned",
  "quarantined",
]);
export type WorkspaceLifecycleLeaseStatus = z.infer<typeof WorkspaceLifecycleLeaseStatus>;

export const FinishedWorkspaceLeaseStatus = WorkspaceLifecycleLeaseStatus.extract([
  "released",
  "preserved",
  "abandoned",
]);
export type FinishedWorkspaceLeaseStatus = z.infer<typeof FinishedWorkspaceLeaseStatus>;

export const ReleaseWorkspaceDisposition = WorkspaceCleanupDisposition.extract([
  "integrated",
  "discarded",
]);
export type ReleaseWorkspaceDisposition = z.infer<typeof ReleaseWorkspaceDisposition>;

export const WorkspaceReconciliationAction = z.enum(["resume", "release", "preserve", "abandon"]);
export type WorkspaceReconciliationAction = z.infer<typeof WorkspaceReconciliationAction>;

export const WorkspaceLifecycleEventType = z.enum([
  "attempt_created",
  "attempt_transitioned",
  "workspace_acquired",
  "workspace_heartbeat",
  "workspace_released",
  "workspace_reconciled",
  "workspace_quarantined",
]);
export type WorkspaceLifecycleEventType = z.infer<typeof WorkspaceLifecycleEventType>;

export const WorkerSessionEventType = z.enum([
  "worker_session_attached",
  "worker_session_heartbeat",
  "worker_session_ended",
]);
export type WorkerSessionEventType = z.infer<typeof WorkerSessionEventType>;

export const AttemptReceiptDisposition = z.enum(["verification_pending", "retained_late"]);
export type AttemptReceiptDisposition = z.infer<typeof AttemptReceiptDisposition>;

export const AttemptReceiptEventType = z.enum([
  "attempt_receipt_submitted",
  "attempt_receipt_retained_late",
  "attempt_receipt_replayed",
]);
export type AttemptReceiptEventType = z.infer<typeof AttemptReceiptEventType>;

export const AttemptVerificationEventType = z.enum([
  "attempt_verification_started",
  "attempt_verification_recorded",
  "attempt_verification_replayed",
]);
export type AttemptVerificationEventType = z.infer<typeof AttemptVerificationEventType>;

export const WorkerAuthorityDimension = z.enum([
  "edit",
  "git_write",
  "github_write",
  "external_runtime",
  "secrets",
  "signing",
  "release",
]);
export type WorkerAuthorityDimension = z.infer<typeof WorkerAuthorityDimension>;

export const WorkerAuthorityDecision = z.enum(["allowed", "denied", "deviation"]);
export type WorkerAuthorityDecision = z.infer<typeof WorkerAuthorityDecision>;

export const WorkerAuthorityEnforcement = z.enum(["enforced", "brokered", "unenforced"]);
export type WorkerAuthorityEnforcement = z.infer<typeof WorkerAuthorityEnforcement>;

export const WorkerAuthorityReason = z.enum([
  "packet_granted",
  "packet_denied",
  "backend_unenforceable",
  "observed_after_execution",
]);
export type WorkerAuthorityReason = z.infer<typeof WorkerAuthorityReason>;

export const WorkspaceMutationFailureReason = z.enum([
  "not_found",
  "no_active_lease",
  "lease_mismatch",
  "stale_fence",
  "lease_expired",
  "stale_run_revision",
  "workspace_expired",
  "invalid_time",
  "stale_attempt_revision",
  "stale_workspace_revision",
  "attempt_not_live",
  "workspace_not_active",
  "live_attempt_conflict",
  "branch_conflict",
  "worktree_conflict",
  "identity_mismatch",
  "dirty_workspace",
  "mutation_conflict",
  "invalid_reconciliation",
  "invalid_attempt_transition",
  "evidence_mismatch",
  "retry_delta_required",
  "retry_delta_invalid",
  "fanout_invalid",
  "removal_operation_pending",
]);
export type WorkspaceMutationFailureReason = z.infer<typeof WorkspaceMutationFailureReason>;

export const WorkerSessionMutationFailureReason = z.enum([
  ...WorkspaceMutationFailureReason.options,
  "stale_session_revision",
  "worker_session_not_active",
  "worker_session_conflict",
]);
export type WorkerSessionMutationFailureReason = z.infer<typeof WorkerSessionMutationFailureReason>;

export const AttemptReceiptFailureReason = z.enum([
  ...WorkspaceMutationFailureReason.options,
  "stale_session_revision",
  "worker_session_not_active",
  "receipt_conflict",
]);
export type AttemptReceiptFailureReason = z.infer<typeof AttemptReceiptFailureReason>;

export const AttemptVerificationFailureReason = z.enum([
  ...WorkspaceMutationFailureReason.options,
  "stale_session_revision",
  "verification_conflict",
]);
export type AttemptVerificationFailureReason = z.infer<typeof AttemptVerificationFailureReason>;

export const WorkspaceObservationCleanliness = z.enum(["clean", "dirty"]);
export type WorkspaceObservationCleanliness = z.infer<typeof WorkspaceObservationCleanliness>;

export const WorkspaceObservation = z
  .object({
    exists: z.boolean(),
    registered: z.boolean(),
    repositoryId: z.string().nullable(),
    hostId: z.string(),
    gitRuntime: z.string(),
    projectRoot: z.string().nullable(),
    branch: z.string().nullable(),
    worktreePath: z.string(),
    attemptId: z.string().nullable(),
    headSha: z.string().nullable(),
    cleanliness: WorkspaceObservationCleanliness,
    dirtyPaths: z.array(z.string()).optional(),
    reason: z.string().optional(),
  })
  .strict();
export type WorkspaceObservation = z.infer<typeof WorkspaceObservation>;

export const ATTEMPT_TRANSITIONS = {
  prepared: ["cancelled"],
  leased: ["launching", "cancelled", "quarantined"],
  launching: ["running", "launch_failed", "failed", "cancelled", "quarantined"],
  running: ["receipt_submitted", "blocked", "failed", "cancelled", "quarantined"],
  receipt_submitted: ["verifying", "quarantined"],
  verifying: ["verified", "rejected", "inconclusive", "failed", "quarantined"],
  verified: ["accepted", "rejected", "inconclusive", "quarantined"],
  accepted: [],
  rejected: [],
  inconclusive: [],
  blocked: [],
  launch_failed: [],
  failed: [],
  cancelled: [],
  quarantined: [],
} as const satisfies Record<AttemptStatus, readonly AttemptStatus[]>;

const ATTEMPT_STATUSES_WITHOUT_LIVE_WORKSPACE = new Set<AttemptStatus>([
  "prepared",
  "leased",
  "cancelled",
  "quarantined",
]);

export const LIVE_ATTEMPT_STATUSES = AttemptStatus.options.filter(isLiveAttemptStatus);

export const LIVE_WORKSPACE_LEASE_STATUSES = [
  "reserved",
  "active",
] as const satisfies readonly (typeof WorkspaceLifecycleLeaseStatus.options)[number][];

export const NONTERMINAL_WORKER_SESSION_STATUSES = [
  "starting",
  "running",
  "awaiting_human",
] as const satisfies readonly (typeof WorkerSessionStatus.options)[number][];

export const HeartbeatWorkerSessionStatus = WorkerSessionStatus.extract([
  "running",
  "awaiting_human",
]);
export type HeartbeatWorkerSessionStatus = z.infer<typeof HeartbeatWorkerSessionStatus>;

export const EndWorkerSessionStatus = WorkerSessionStatus.extract([
  "completed",
  "failed",
  "cancelled",
  "lost",
]);
export type EndWorkerSessionStatus = z.infer<typeof EndWorkerSessionStatus>;

export const INITIAL_ATTEMPT_RECEIPT_EVENT_TYPES = [
  "attempt_receipt_submitted",
  "attempt_receipt_retained_late",
] as const satisfies readonly (typeof AttemptReceiptEventType.options)[number][];

const TERMINAL_WORKER_SESSION_STATUSES = new Set<WorkerSessionStatus>(
  EndWorkerSessionStatus.options
);

export function canTransitionAttempt(from: AttemptStatus, to: AttemptStatus): boolean {
  return (ATTEMPT_TRANSITIONS[from] as readonly AttemptStatus[]).includes(to);
}

export function isLiveAttemptStatus(status: AttemptStatus): boolean {
  return !isTerminalAttemptStatus(status);
}

export function requiresLiveWorkspace(status: AttemptStatus): boolean {
  return !ATTEMPT_STATUSES_WITHOUT_LIVE_WORKSPACE.has(status);
}

export function requiresDurableReceipt(status: AttemptStatus): boolean {
  return status !== "receipt_submitted" && attemptStatusRequiresReceipt(status);
}

export function isTerminalWorkerSession(status: WorkerSessionStatus): boolean {
  return TERMINAL_WORKER_SESSION_STATUSES.has(status);
}
