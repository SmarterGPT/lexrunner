import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ZodType } from "zod";
import { canonicalJSONStringify } from "../../util/canonicalJson.js";
import { computeCanonicalHash } from "../../schemas/task-contract.js";
import { evaluateStrictAgentWorkFanIn } from "../../agent-work-fanin-policy.js";
import {
  AgentWorkFanInDecision_v1,
  AgentWorkFanoutPlan_v1,
  AgentEngineVerification_v2,
  AgentTaskPacket_v1,
  AgentTaskReceipt_v2,
  AttemptRetryDelta_v1,
  FanoutAttemptBinding_v1,
  computeFanInEvidenceSetHash,
  EngineVerificationTrustGapReason_v2 as EngineVerificationTrustGapReasonV2Schema,
  validateAgentEngineVerificationV2PacketReferences,
  validateAgentTaskReceiptV2PacketReferences,
} from "../../schemas/agent-work.js";
import { calculateExpiry, cloneJsonValue, parseInstant } from "../coordination-store.js";
import type { JsonValue } from "../coordination-store.js";
import {
  AgentTaskReceiptOutcome as AgentTaskReceiptOutcomeSchema,
  AttemptReceiptDisposition as AttemptReceiptDispositionSchema,
  AttemptReceiptEventType as AttemptReceiptEventTypeSchema,
  AttemptVerificationEventType as AttemptVerificationEventTypeSchema,
  AttemptStatus as AttemptStatusSchema,
  VerificationOutcome as VerificationOutcomeSchema,
  WorkerSessionBackend as WorkerSessionBackendSchema,
  WorkerAuthorityDecision as WorkerAuthorityDecisionSchema,
  WorkerAuthorityDimension as WorkerAuthorityDimensionSchema,
  WorkerAuthorityEnforcement as WorkerAuthorityEnforcementSchema,
  WorkerAuthorityReason as WorkerAuthorityReasonSchema,
  WorkerSessionEventType as WorkerSessionEventTypeSchema,
  WorkerSessionStatus as WorkerSessionStatusSchema,
  WorkspaceCleanupDisposition as WorkspaceCleanupDispositionSchema,
  WorkspaceLifecycleEventType as WorkspaceLifecycleEventTypeSchema,
  WorkspaceLifecycleLeaseStatus as WorkspaceLifecycleLeaseStatusSchema,
  WorkspaceObservation as WorkspaceObservationSchema,
  INITIAL_ATTEMPT_RECEIPT_EVENT_TYPES,
  LIVE_ATTEMPT_STATUSES,
  LIVE_WORKSPACE_LEASE_STATUSES,
  NONTERMINAL_WORKER_SESSION_STATUSES,
  attemptStatusRequiresReceipt,
  attemptStatusRequiresVerification,
  canTransitionAttempt,
  isLiveAttemptStatus,
  isTerminalAttemptStatus,
  isTerminalWorkerSession,
  requiresDurableReceipt,
  requiresLiveWorkspace,
} from "../workspace-lifecycle-domains.js";
import type {
  FinishedWorkspaceLeaseStatus,
  WorkspaceCleanupDisposition,
} from "../workspace-lifecycle-domains.js";
import type {
  AcquireWorkspaceInput,
  AgentWorkFanoutStore,
  ApplyAttemptAcceptanceInput,
  AttachWorkerSessionInput,
  AttemptRecord,
  AttemptRetryDeltaRecord,
  AttemptReceiptEvent,
  AttemptReceiptEventType,
  AttemptReceiptFailureReason,
  AttemptReceiptRecord,
  AttemptReceiptSubmissionResult,
  AttemptVerificationEvent,
  AttemptVerificationEventType,
  AttemptVerificationFailureReason,
  AttemptVerificationAuthorizationRecord,
  AttemptVerificationBeginResult,
  AttemptVerificationRecord,
  AttemptVerificationStore,
  AttemptVerificationSubmissionResult,
  AttemptAcceptanceStore,
  BindLaunchEnvelopeInput,
  BeginAttemptVerificationInput,
  CommitFanInDecisionInput,
  CreateAttemptInput,
  CreateFanoutPlanInput,
  EndWorkerSessionInput,
  FanInDecisionMutationResult,
  FanInDecisionRecord,
  FanoutAttemptBindingRecord,
  FanoutPlanMutationResult,
  FanoutPlanRecord,
  HeartbeatWorkerSessionInput,
  LaunchEnvelopeBindingRecord,
  LaunchEnvelopeBindingResult,
  LaunchEnvelopeBindingStore,
  TaskPacketBindingRecord,
  TaskPacketBindingStore,
  HeartbeatWorkspaceInput,
  QuarantineWorkspaceInput,
  ReconcileIncompleteLaunchInput,
  ReconcileWorkspaceInput,
  ReleaseWorkspaceInput,
  SubmitAttemptReceiptInput,
  SubmitAttemptVerificationInput,
  TransitionAttemptInput,
  WorkspaceIdentity,
  WorkspaceLifecycleLeaseRecord,
  WorkspaceLifecycleEvent,
  WorkspaceLifecycleEventType,
  WorkspaceLifecycleStore,
  WorkspaceMutationFailureReason,
  WorkspaceMutationResult,
  WorkspaceObservation,
  WorkerSessionEvent,
  WorkerSessionEventType,
  WorkerSessionMutationFailureReason,
  WorkerSessionMutationResult,
  WorkerSessionRecord,
  WorkerSessionStore,
  WorkerAdapterBindingRecord,
  RecordWorkerAuthorityDecisionInput,
  WorkerAuthorityDecisionResult,
  WorkerAuthorityDecisionStore,
  WorkerAuthorityEventRecord,
} from "../workspace-lifecycle-store.js";
import {
  STRICT_ATTEMPT_ACCEPTANCE_POLICY_ID,
  STRICT_ATTEMPT_ACCEPTANCE_POLICY_VERSION,
} from "../workspace-lifecycle-store.js";
import {
  validateCanonicalEnvelope,
  validatePersistedCanonicalEnvelope,
} from "../workspace-lifecycle-evidence.js";
import {
  SqliteCoordinationStore,
  type SqliteCoordinationStoreOptions,
} from "./coordination-store.js";

type MutationInput =
  | CreateAttemptInput
  | TransitionAttemptInput
  | ApplyAttemptAcceptanceInput
  | AcquireWorkspaceInput
  | HeartbeatWorkspaceInput
  | ReleaseWorkspaceInput
  | ReconcileWorkspaceInput
  | ReconcileIncompleteLaunchInput
  | QuarantineWorkspaceInput;
type Success = Extract<WorkspaceMutationResult, { updated: true }>;
type JsonRecord = { [key: string]: JsonValue };

function sqlEnumValues(values: readonly string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(",");
}

// Kept inline because published bundles do not necessarily contain standalone SQL assets.
// The source migration remains the reviewable/canonical deployment artifact.
// CHECK constraints protect new tables. Existing versioned tables are not rebuilt;
// runtime row validation is their fail-closed compatibility boundary.
const INLINE_WORKSPACE_MIGRATION = `
CREATE TABLE IF NOT EXISTS attempts (
 attemptId TEXT PRIMARY KEY, runId TEXT NOT NULL, runRevision INTEGER NOT NULL CHECK(runRevision>=0),
 workItemId TEXT NOT NULL,
 workItemRevision INTEGER NOT NULL CHECK(workItemRevision>=0), packetId TEXT NOT NULL,
 packetHash TEXT NOT NULL, baseSha TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 status TEXT NOT NULL CHECK(status IN (${sqlEnumValues(AttemptStatusSchema.options)})),
 receiptId TEXT, verificationId TEXT, workspaceLeaseId TEXT,
 createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, completedAt TEXT,
 FOREIGN KEY(runId) REFERENCES run_coordination(runId) ON DELETE CASCADE);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_one_live_work_item ON attempts(runId,workItemId)
 WHERE status IN (${sqlEnumValues(LIVE_ATTEMPT_STATUSES)});
CREATE TABLE IF NOT EXISTS workspace_leases (
 leaseId TEXT PRIMARY KEY, runId TEXT NOT NULL, runRevision INTEGER NOT NULL CHECK(runRevision>=0),
 workItemId TEXT NOT NULL,
 workItemRevision INTEGER NOT NULL CHECK(workItemRevision>=0), packetId TEXT NOT NULL,
 packetHash TEXT NOT NULL, attemptId TEXT NOT NULL UNIQUE,
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0), controllerId TEXT NOT NULL,
 controllerLeaseId TEXT NOT NULL, fencingToken INTEGER NOT NULL CHECK(fencingToken>0),
 repositoryId TEXT NOT NULL, hostId TEXT NOT NULL, gitRuntime TEXT NOT NULL, projectRoot TEXT NOT NULL,
 branch TEXT NOT NULL, worktreePath TEXT NOT NULL, baseSha TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN (${sqlEnumValues(WorkspaceLifecycleLeaseStatusSchema.options)})),
 acquiredAt TEXT NOT NULL, heartbeatAt TEXT NOT NULL, expiresAt TEXT NOT NULL, releasedAt TEXT,
 cleanupDisposition TEXT CHECK(cleanupDisposition IS NULL OR cleanupDisposition IN
 (${sqlEnumValues(WorkspaceCleanupDispositionSchema.options)})), lastObservationJson TEXT,
 FOREIGN KEY(runId) REFERENCES run_coordination(runId) ON DELETE CASCADE,
 FOREIGN KEY(attemptId) REFERENCES attempts(attemptId) ON DELETE CASCADE);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_leases_live_branch ON workspace_leases(repositoryId,branch)
 WHERE status IN (${sqlEnumValues(LIVE_WORKSPACE_LEASE_STATUSES)});
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_leases_live_worktree ON workspace_leases(hostId,gitRuntime,worktreePath)
 WHERE status IN (${sqlEnumValues(LIVE_WORKSPACE_LEASE_STATUSES)});
CREATE INDEX IF NOT EXISTS idx_workspace_leases_expiry ON workspace_leases(expiresAt)
 WHERE status IN (${sqlEnumValues(LIVE_WORKSPACE_LEASE_STATUSES)});
CREATE TABLE IF NOT EXISTS workspace_lifecycle_events (
 runId TEXT NOT NULL, attemptId TEXT NOT NULL, mutationId TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence>0), attemptRevision INTEGER NOT NULL CHECK(attemptRevision>=0),
 workspaceLeaseRevision INTEGER, controllerId TEXT NOT NULL, controllerLeaseId TEXT NOT NULL,
 fencingToken INTEGER NOT NULL CHECK(fencingToken>0),
 type TEXT NOT NULL CHECK(type IN (${sqlEnumValues(WorkspaceLifecycleEventTypeSchema.options)})),
 payloadJson TEXT NOT NULL,
 createdAt TEXT NOT NULL, PRIMARY KEY(runId,mutationId), UNIQUE(runId,sequence),
 FOREIGN KEY(runId) REFERENCES run_coordination(runId) ON DELETE CASCADE,
 FOREIGN KEY(attemptId) REFERENCES attempts(attemptId) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS workspace_lifecycle_mutations (
 runId TEXT NOT NULL, mutationId TEXT NOT NULL, fingerprint TEXT NOT NULL, resultJson TEXT NOT NULL,
 PRIMARY KEY(runId,mutationId), FOREIGN KEY(runId,mutationId)
 REFERENCES workspace_lifecycle_events(runId,mutationId) ON DELETE CASCADE);
INSERT OR IGNORE INTO coordination_schema_migrations(version,name,appliedAt)
 VALUES(2,'attempt-workspace-lifecycle',datetime('now'));
CREATE TABLE IF NOT EXISTS worker_sessions (
 sessionId TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 runId TEXT NOT NULL, attemptId TEXT NOT NULL, packetId TEXT NOT NULL, packetHash TEXT NOT NULL,
 workspaceLeaseId TEXT NOT NULL, workspaceLeaseRevision INTEGER NOT NULL CHECK(workspaceLeaseRevision>=0),
 executionEnvelopeId TEXT NOT NULL, executionEnvelopeHash TEXT NOT NULL,
 hostId TEXT NOT NULL, workerRuntime TEXT NOT NULL,
 gitRuntime TEXT NOT NULL,
 backend TEXT NOT NULL CHECK(backend IN (${sqlEnumValues(WorkerSessionBackendSchema.options)})),
 workerId TEXT NOT NULL, model TEXT,
 status TEXT NOT NULL CHECK(status IN (${sqlEnumValues(WorkerSessionStatusSchema.options)})),
 startedAt TEXT NOT NULL, heartbeatAt TEXT NOT NULL, endedAt TEXT,
 exitReason TEXT, exitCode INTEGER, exitSummary TEXT,
 FOREIGN KEY(runId) REFERENCES run_coordination(runId) ON DELETE CASCADE,
 FOREIGN KEY(attemptId) REFERENCES attempts(attemptId) ON DELETE CASCADE,
 FOREIGN KEY(workspaceLeaseId) REFERENCES workspace_leases(leaseId) ON DELETE RESTRICT);
CREATE TABLE IF NOT EXISTS launch_envelope_bindings (
 attemptId TEXT PRIMARY KEY, runId TEXT NOT NULL, workspaceLeaseId TEXT NOT NULL,
 attemptRevision INTEGER NOT NULL CHECK(attemptRevision>=0),
 workspaceLeaseRevision INTEGER NOT NULL CHECK(workspaceLeaseRevision>=0),
 authorizationMutationId TEXT NOT NULL, envelopeId TEXT NOT NULL UNIQUE,
 envelopeHash TEXT NOT NULL, envelopeJson TEXT NOT NULL, controllerId TEXT NOT NULL,
 controllerLeaseId TEXT NOT NULL, fencingToken INTEGER NOT NULL CHECK(fencingToken>0),
 createdAt TEXT NOT NULL,
 FOREIGN KEY(attemptId) REFERENCES attempts(attemptId) ON DELETE CASCADE,
 FOREIGN KEY(workspaceLeaseId) REFERENCES workspace_leases(leaseId) ON DELETE RESTRICT,
 FOREIGN KEY(runId,authorizationMutationId)
 REFERENCES workspace_lifecycle_events(runId,mutationId) ON DELETE RESTRICT);
CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_sessions_one_nonterminal_attempt ON worker_sessions(attemptId)
 WHERE status IN (${sqlEnumValues(NONTERMINAL_WORKER_SESSION_STATUSES)});
CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_sessions_one_live_native_identity
 ON worker_sessions(hostId,backend,workerId)
 WHERE status IN (${sqlEnumValues(NONTERMINAL_WORKER_SESSION_STATUSES)});
CREATE TABLE IF NOT EXISTS worker_session_events (
 runId TEXT NOT NULL, attemptId TEXT NOT NULL, sessionId TEXT NOT NULL, mutationId TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence>0), attemptRevision INTEGER NOT NULL CHECK(attemptRevision>=0),
 workspaceLeaseRevision INTEGER NOT NULL CHECK(workspaceLeaseRevision>=0),
 sessionRevision INTEGER NOT NULL CHECK(sessionRevision>=0), controllerId TEXT NOT NULL,
 controllerLeaseId TEXT NOT NULL, fencingToken INTEGER NOT NULL CHECK(fencingToken>0),
 type TEXT NOT NULL CHECK(type IN (${sqlEnumValues(WorkerSessionEventTypeSchema.options)})),
 payloadJson TEXT NOT NULL, createdAt TEXT NOT NULL,
 PRIMARY KEY(runId,mutationId), UNIQUE(runId,sequence),
 FOREIGN KEY(runId) REFERENCES run_coordination(runId) ON DELETE CASCADE,
 FOREIGN KEY(attemptId) REFERENCES attempts(attemptId) ON DELETE CASCADE,
 FOREIGN KEY(sessionId) REFERENCES worker_sessions(sessionId) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS worker_session_mutations (
 runId TEXT NOT NULL, mutationId TEXT NOT NULL, fingerprint TEXT NOT NULL, resultJson TEXT NOT NULL,
 PRIMARY KEY(runId,mutationId), FOREIGN KEY(runId,mutationId)
 REFERENCES worker_session_events(runId,mutationId) ON DELETE CASCADE);
INSERT OR IGNORE INTO coordination_schema_migrations(version,name,appliedAt)
 VALUES(3,'worker-session-lifecycle',datetime('now'));
CREATE TABLE IF NOT EXISTS attempt_receipts (
 receiptId TEXT PRIMARY KEY, receiptHash TEXT NOT NULL UNIQUE, receiptJson TEXT NOT NULL,
 runId TEXT NOT NULL, workItemId TEXT NOT NULL, workItemRevision INTEGER NOT NULL,
 attemptId TEXT NOT NULL UNIQUE, packetId TEXT NOT NULL, packetHash TEXT NOT NULL,
 workspaceLeaseId TEXT NOT NULL, workspaceLeaseRevision INTEGER NOT NULL,
 workerSessionId TEXT NOT NULL, workerSessionRevision INTEGER NOT NULL, workerRuntime TEXT NOT NULL,
 observedBaseSha TEXT NOT NULL, finalHeadSha TEXT, patchHash TEXT,
 outcome TEXT NOT NULL CHECK(outcome IN (${sqlEnumValues(AgentTaskReceiptOutcomeSchema.options)})),
 disposition TEXT NOT NULL CHECK(disposition IN (${sqlEnumValues(AttemptReceiptDispositionSchema.options)})),
 submittedAt TEXT NOT NULL, recordedAt TEXT NOT NULL,
 controllerId TEXT NOT NULL, controllerLeaseId TEXT NOT NULL, fencingToken INTEGER NOT NULL,
 resultingAttemptRevision INTEGER NOT NULL,
 resultingAttemptStatus TEXT NOT NULL CHECK(resultingAttemptStatus IN
 (${sqlEnumValues(AttemptStatusSchema.options)})),
 FOREIGN KEY(runId) REFERENCES run_coordination(runId) ON DELETE CASCADE,
 FOREIGN KEY(attemptId) REFERENCES attempts(attemptId) ON DELETE CASCADE,
 FOREIGN KEY(workspaceLeaseId) REFERENCES workspace_leases(leaseId) ON DELETE RESTRICT,
 FOREIGN KEY(workerSessionId) REFERENCES worker_sessions(sessionId) ON DELETE RESTRICT);
CREATE TABLE IF NOT EXISTS attempt_receipt_events (
 runId TEXT NOT NULL, attemptId TEXT NOT NULL, receiptId TEXT NOT NULL, receiptHash TEXT NOT NULL,
 mutationId TEXT NOT NULL, sequence INTEGER NOT NULL, attemptRevision INTEGER NOT NULL,
 workspaceLeaseRevision INTEGER NOT NULL, workerSessionRevision INTEGER NOT NULL,
 controllerId TEXT NOT NULL, controllerLeaseId TEXT NOT NULL, fencingToken INTEGER NOT NULL,
 type TEXT NOT NULL CHECK(type IN (${sqlEnumValues(AttemptReceiptEventTypeSchema.options)})),
 disposition TEXT NOT NULL CHECK(disposition IN (${sqlEnumValues(AttemptReceiptDispositionSchema.options)})),
 outcome TEXT NOT NULL CHECK(outcome IN (${sqlEnumValues(AgentTaskReceiptOutcomeSchema.options)})),
 createdAt TEXT NOT NULL,
 PRIMARY KEY(runId,mutationId), UNIQUE(runId,sequence),
 FOREIGN KEY(receiptId) REFERENCES attempt_receipts(receiptId) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS attempt_receipt_mutations (
 runId TEXT NOT NULL, mutationId TEXT NOT NULL, fingerprint TEXT NOT NULL, resultJson TEXT NOT NULL,
 PRIMARY KEY(runId,mutationId), FOREIGN KEY(runId,mutationId)
 REFERENCES attempt_receipt_events(runId,mutationId) ON DELETE CASCADE);
INSERT OR IGNORE INTO coordination_schema_migrations(version,name,appliedAt)
 VALUES(4,'attempt-receipt-persistence',datetime('now'));
CREATE TABLE IF NOT EXISTS task_packet_bindings (
 attemptId TEXT PRIMARY KEY, runId TEXT NOT NULL, workItemId TEXT NOT NULL,
 workItemRevision INTEGER NOT NULL CHECK(workItemRevision>=0), packetId TEXT NOT NULL,
 packetHash TEXT NOT NULL, packetJson TEXT NOT NULL, createdAt TEXT NOT NULL,
 FOREIGN KEY(runId) REFERENCES run_coordination(runId) ON DELETE CASCADE,
 FOREIGN KEY(attemptId) REFERENCES attempts(attemptId) ON DELETE CASCADE);
INSERT OR IGNORE INTO coordination_schema_migrations(version,name,appliedAt)
 VALUES(5,'task-packet-snapshot-persistence',datetime('now'));
CREATE TABLE IF NOT EXISTS attempt_verification_authorizations (
 verificationId TEXT PRIMARY KEY, runId TEXT NOT NULL, attemptId TEXT NOT NULL UNIQUE,
 attemptRevision INTEGER NOT NULL CHECK(attemptRevision>=0), workspaceLeaseId TEXT NOT NULL,
 workspaceLeaseRevision INTEGER NOT NULL CHECK(workspaceLeaseRevision>=0),
 workerSessionId TEXT NOT NULL, workerSessionRevision INTEGER NOT NULL CHECK(workerSessionRevision>=0),
 receiptId TEXT NOT NULL UNIQUE, receiptHash TEXT NOT NULL, controllerId TEXT NOT NULL,
 controllerLeaseId TEXT NOT NULL, fencingToken INTEGER NOT NULL CHECK(fencingToken>0),
 startedAt TEXT NOT NULL,
 FOREIGN KEY(runId) REFERENCES run_coordination(runId) ON DELETE CASCADE,
 FOREIGN KEY(attemptId) REFERENCES attempts(attemptId) ON DELETE CASCADE,
 FOREIGN KEY(workspaceLeaseId) REFERENCES workspace_leases(leaseId) ON DELETE RESTRICT,
 FOREIGN KEY(workerSessionId) REFERENCES worker_sessions(sessionId) ON DELETE RESTRICT,
 FOREIGN KEY(receiptId) REFERENCES attempt_receipts(receiptId) ON DELETE RESTRICT);
CREATE TABLE IF NOT EXISTS attempt_verifications (
 verificationId TEXT PRIMARY KEY, verificationHash TEXT NOT NULL UNIQUE,
 verificationJson TEXT NOT NULL, runId TEXT NOT NULL, workItemId TEXT NOT NULL,
 workItemRevision INTEGER NOT NULL CHECK(workItemRevision>=0), attemptId TEXT NOT NULL UNIQUE,
 packetId TEXT NOT NULL, packetHash TEXT NOT NULL, workspaceLeaseId TEXT NOT NULL,
 workspaceLeaseRevision INTEGER NOT NULL CHECK(workspaceLeaseRevision>=0),
 workerSessionId TEXT NOT NULL, workerSessionRevision INTEGER NOT NULL CHECK(workerSessionRevision>=0),
 receiptId TEXT NOT NULL UNIQUE, receiptHash TEXT NOT NULL, observedBaseSha TEXT NOT NULL,
 verifiedHeadSha TEXT, verifiedPatchHash TEXT, workspaceObservationHash TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN (${sqlEnumValues(VerificationOutcomeSchema.options)})),
 trustGapReasonsJson TEXT NOT NULL, verifierId TEXT NOT NULL, verifierVersion TEXT NOT NULL,
 startedAt TEXT NOT NULL, completedAt TEXT NOT NULL, recordedAt TEXT NOT NULL,
 controllerId TEXT NOT NULL, controllerLeaseId TEXT NOT NULL,
 fencingToken INTEGER NOT NULL CHECK(fencingToken>0), resultingAttemptRevision INTEGER NOT NULL,
 resultingAttemptStatus TEXT NOT NULL CHECK(resultingAttemptStatus IN
 (${sqlEnumValues(AttemptStatusSchema.options)})),
 FOREIGN KEY(runId) REFERENCES run_coordination(runId) ON DELETE CASCADE,
 FOREIGN KEY(attemptId) REFERENCES attempts(attemptId) ON DELETE CASCADE,
 FOREIGN KEY(workspaceLeaseId) REFERENCES workspace_leases(leaseId) ON DELETE RESTRICT,
 FOREIGN KEY(workerSessionId) REFERENCES worker_sessions(sessionId) ON DELETE RESTRICT,
 FOREIGN KEY(receiptId) REFERENCES attempt_receipts(receiptId) ON DELETE RESTRICT,
 FOREIGN KEY(verificationId) REFERENCES attempt_verification_authorizations(verificationId)
 ON DELETE RESTRICT);
CREATE TABLE IF NOT EXISTS attempt_verification_events (
 runId TEXT NOT NULL, attemptId TEXT NOT NULL, verificationId TEXT NOT NULL,
 verificationHash TEXT, receiptId TEXT NOT NULL, receiptHash TEXT NOT NULL,
 mutationId TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>0),
 attemptRevision INTEGER NOT NULL CHECK(attemptRevision>=0),
 workspaceLeaseRevision INTEGER NOT NULL CHECK(workspaceLeaseRevision>=0),
 workerSessionRevision INTEGER NOT NULL CHECK(workerSessionRevision>=0),
 controllerId TEXT NOT NULL, controllerLeaseId TEXT NOT NULL,
 fencingToken INTEGER NOT NULL CHECK(fencingToken>0),
 type TEXT NOT NULL CHECK(type IN (${sqlEnumValues(AttemptVerificationEventTypeSchema.options)})),
 outcome TEXT CHECK(outcome IN (${sqlEnumValues(VerificationOutcomeSchema.options)})),
 resultingAttemptStatus TEXT NOT NULL CHECK(resultingAttemptStatus IN
 (${sqlEnumValues(AttemptStatusSchema.options)})), createdAt TEXT NOT NULL,
 PRIMARY KEY(runId,mutationId), UNIQUE(runId,sequence),
 FOREIGN KEY(verificationId) REFERENCES attempt_verification_authorizations(verificationId)
 ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS attempt_verification_begin_mutations (
 runId TEXT NOT NULL, mutationId TEXT NOT NULL, fingerprint TEXT NOT NULL, resultJson TEXT NOT NULL,
 PRIMARY KEY(runId,mutationId), FOREIGN KEY(runId,mutationId)
 REFERENCES attempt_verification_events(runId,mutationId) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS attempt_verification_mutations (
 runId TEXT NOT NULL, mutationId TEXT NOT NULL, fingerprint TEXT NOT NULL, resultJson TEXT NOT NULL,
 PRIMARY KEY(runId,mutationId), FOREIGN KEY(runId,mutationId)
 REFERENCES attempt_verification_events(runId,mutationId) ON DELETE CASCADE);
INSERT OR IGNORE INTO coordination_schema_migrations(version,name,appliedAt)
 VALUES(6,'attempt-engine-verification-persistence',datetime('now'));
`;

const INLINE_WORKER_AUTHORITY_MIGRATION = `
CREATE TABLE IF NOT EXISTS worker_authority_events (
 runId TEXT NOT NULL, attemptId TEXT NOT NULL, workerSessionId TEXT NOT NULL,
 mutationId TEXT NOT NULL, fingerprint TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence > 0),
 attemptRevision INTEGER NOT NULL CHECK(attemptRevision >= 0),
 workspaceLeaseId TEXT NOT NULL,
 workspaceLeaseRevision INTEGER NOT NULL CHECK(workspaceLeaseRevision >= 0),
 workerSessionRevision INTEGER NOT NULL CHECK(workerSessionRevision >= 0),
 packetId TEXT NOT NULL, packetHash TEXT NOT NULL,
 dimension TEXT NOT NULL CHECK(dimension IN
  ('edit','git_write','github_write','external_runtime','secrets','signing','release')),
 decision TEXT NOT NULL CHECK(decision IN ('allowed','denied','deviation')),
 enforcement TEXT NOT NULL CHECK(enforcement IN ('enforced','brokered','unenforced')),
 actionClass TEXT NOT NULL CHECK(length(actionClass) BETWEEN 1 AND 128),
 actionHash TEXT NOT NULL,
 backendId TEXT NOT NULL CHECK(length(backendId) BETWEEN 1 AND 128),
 backendVersion TEXT NOT NULL CHECK(length(backendVersion) BETWEEN 1 AND 128),
 reason TEXT NOT NULL CHECK(reason IN
  ('packet_granted','packet_denied','backend_unenforceable','observed_after_execution')),
 controllerId TEXT NOT NULL, controllerLeaseId TEXT NOT NULL,
 fencingToken INTEGER NOT NULL CHECK(fencingToken > 0), createdAt TEXT NOT NULL,
 PRIMARY KEY(runId,mutationId), UNIQUE(runId,sequence),
 FOREIGN KEY(runId) REFERENCES run_coordination(runId) ON DELETE CASCADE,
 FOREIGN KEY(attemptId) REFERENCES attempts(attemptId) ON DELETE CASCADE,
 FOREIGN KEY(workspaceLeaseId) REFERENCES workspace_leases(leaseId) ON DELETE RESTRICT,
 FOREIGN KEY(workerSessionId) REFERENCES worker_sessions(sessionId) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_worker_authority_events_attempt
ON worker_authority_events(runId,attemptId,sequence);
INSERT OR IGNORE INTO coordination_schema_migrations(version,name,appliedAt)
VALUES(7,'worker-authority-events',datetime('now'));
`;

const INLINE_WORKER_ADAPTER_MIGRATION = `
CREATE TABLE IF NOT EXISTS worker_adapter_bindings (
 sessionId TEXT PRIMARY KEY,
 adapterId TEXT NOT NULL CHECK(length(adapterId) BETWEEN 1 AND 128),
 adapterVersion TEXT NOT NULL CHECK(length(adapterVersion) BETWEEN 1 AND 128),
 enforcementSummaryHash TEXT NOT NULL,
 trustGapDimensionsJson TEXT NOT NULL CHECK(length(trustGapDimensionsJson) <= 4096),
 createdAt TEXT NOT NULL,
 FOREIGN KEY(sessionId) REFERENCES worker_sessions(sessionId) ON DELETE CASCADE
);
INSERT OR IGNORE INTO coordination_schema_migrations(version,name,appliedAt)
VALUES(8,'worker-adapter-bindings',datetime('now'));
`;

const INLINE_ATTEMPT_RETRY_DELTA_MIGRATION = `
CREATE TABLE IF NOT EXISTS attempt_retry_deltas (
 attemptId TEXT PRIMARY KEY, previousAttemptId TEXT NOT NULL,
 deltaHash TEXT NOT NULL, deltaJson TEXT NOT NULL CHECK(length(deltaJson) <= 262144),
 createdAt TEXT NOT NULL,
 FOREIGN KEY(attemptId) REFERENCES attempts(attemptId) ON DELETE CASCADE,
 FOREIGN KEY(previousAttemptId) REFERENCES attempts(attemptId) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attempt_retry_deltas_previous
ON attempt_retry_deltas(previousAttemptId,attemptId);
INSERT OR IGNORE INTO coordination_schema_migrations(version,name,appliedAt)
VALUES(9,'attempt-retry-deltas',datetime('now'));
`;

const INLINE_AGENT_WORK_FANOUT_MIGRATION = `
DROP INDEX IF EXISTS idx_attempts_one_live_work_item;
CREATE INDEX IF NOT EXISTS idx_attempts_live_work_item
ON attempts(runId,workItemId) WHERE status IN
('prepared','leased','launching','running','receipt_submitted','verifying','verified');
CREATE TABLE IF NOT EXISTS agent_work_fanout_plans (
 fanoutId TEXT PRIMARY KEY, runId TEXT NOT NULL, workItemId TEXT NOT NULL,
 workItemRevision INTEGER NOT NULL CHECK(workItemRevision>=0), planHash TEXT NOT NULL,
 planJson TEXT NOT NULL CHECK(length(planJson)<=262144), controllerId TEXT NOT NULL,
 controllerLeaseId TEXT NOT NULL, fencingToken INTEGER NOT NULL CHECK(fencingToken>0),
 createdAt TEXT NOT NULL,
 FOREIGN KEY(runId) REFERENCES run_coordination(runId) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS agent_work_fanout_attempts (
 attemptId TEXT PRIMARY KEY, fanoutId TEXT NOT NULL, premiseId TEXT NOT NULL,
 premiseHash TEXT NOT NULL, planHash TEXT NOT NULL, createdAt TEXT NOT NULL,
 UNIQUE(fanoutId,premiseId),
 FOREIGN KEY(fanoutId) REFERENCES agent_work_fanout_plans(fanoutId) ON DELETE RESTRICT,
 FOREIGN KEY(attemptId) REFERENCES attempts(attemptId) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS agent_work_fanin_decisions (
 decisionId TEXT PRIMARY KEY, fanoutId TEXT NOT NULL UNIQUE, runId TEXT NOT NULL,
 workItemId TEXT NOT NULL, workItemRevision INTEGER NOT NULL CHECK(workItemRevision>=0),
 decisionHash TEXT NOT NULL, decisionJson TEXT NOT NULL CHECK(length(decisionJson)<=262144),
 selectedAttemptId TEXT, outcome TEXT NOT NULL CHECK(outcome IN
 ('selected','escalated','no_viable_candidate')), controllerId TEXT NOT NULL,
 controllerLeaseId TEXT NOT NULL, fencingToken INTEGER NOT NULL CHECK(fencingToken>0),
 createdAt TEXT NOT NULL,
 FOREIGN KEY(fanoutId) REFERENCES agent_work_fanout_plans(fanoutId) ON DELETE RESTRICT,
 FOREIGN KEY(runId) REFERENCES run_coordination(runId) ON DELETE CASCADE,
 FOREIGN KEY(selectedAttemptId) REFERENCES attempts(attemptId) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS agent_work_fanout_mutations (
 runId TEXT NOT NULL, mutationId TEXT NOT NULL, fingerprint TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('plan','decision')), recordId TEXT NOT NULL,
 PRIMARY KEY(runId,mutationId),
 FOREIGN KEY(runId) REFERENCES run_coordination(runId) ON DELETE CASCADE
);
INSERT OR IGNORE INTO coordination_schema_migrations(version,name,appliedAt)
VALUES(10,'agent-work-fanout-fanin',datetime('now'));
`;

interface AttemptRow extends Omit<AttemptRecord, "workspaceLeaseId" | "status"> {
  workspaceLeaseId: string | null;
  status: string;
}

interface LeaseRow {
  leaseId: string;
  runId: string;
  runRevision: number;
  workItemId: string;
  workItemRevision: number;
  packetId: string;
  packetHash: string;
  attemptId: string;
  revision: number;
  controllerId: string;
  controllerLeaseId: string;
  fencingToken: number;
  repositoryId: string;
  hostId: string;
  gitRuntime: string;
  projectRoot: string;
  branch: string;
  worktreePath: string;
  baseSha: string;
  status: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  releasedAt: string | null;
  cleanupDisposition: string | null;
  lastObservationJson: string | null;
}

interface EventRow {
  runId: string;
  attemptId: string;
  mutationId: string;
  sequence: number;
  attemptRevision: number;
  workspaceLeaseRevision: number | null;
  controllerId: string;
  controllerLeaseId: string;
  fencingToken: number;
  type: string;
  payloadJson: string;
  createdAt: string;
}

interface WorkerSessionRow extends Omit<
  WorkerSessionRecord,
  "backend" | "status" | "model" | "endedAt" | "exitReason" | "exitCode" | "exitSummary"
> {
  backend: string;
  status: string;
  model: string | null;
  endedAt: string | null;
  exitReason: string | null;
  exitCode: number | null;
  exitSummary: string | null;
}

interface WorkerEventRow extends Omit<WorkerSessionEvent, "payload" | "type"> {
  type: string;
  payloadJson: string;
}

interface WorkerAdapterBindingRow extends Omit<WorkerAdapterBindingRecord, "trustGapDimensions"> {
  trustGapDimensionsJson: string;
}

interface WorkerAuthorityEventRow extends Omit<
  WorkerAuthorityEventRecord,
  "dimension" | "decision" | "enforcement" | "reason"
> {
  dimension: string;
  decision: string;
  enforcement: string;
  reason: string;
  fingerprint: string;
}

interface AttemptReceiptRow extends Omit<
  AttemptReceiptRecord,
  "outcome" | "disposition" | "resultingAttemptStatus" | "finalHeadSha" | "patchHash"
> {
  outcome: string;
  disposition: string;
  resultingAttemptStatus: string;
  finalHeadSha: string | null;
  patchHash: string | null;
}

interface AttemptReceiptEventRow extends Omit<
  AttemptReceiptEvent,
  "type" | "disposition" | "outcome"
> {
  type: string;
  disposition: string;
  outcome: string;
}

interface AttemptVerificationRow extends Omit<
  AttemptVerificationRecord,
  "outcome" | "resultingAttemptStatus" | "verifiedHeadSha" | "verifiedPatchHash" | "trustGapReasons"
> {
  outcome: string;
  resultingAttemptStatus: string;
  verifiedHeadSha: string | null;
  verifiedPatchHash: string | null;
  trustGapReasonsJson: string;
}

interface AttemptVerificationEventRow extends Omit<
  AttemptVerificationEvent,
  "type" | "outcome" | "resultingAttemptStatus"
> {
  type: string;
  outcome: string | null;
  resultingAttemptStatus: string;
}

/** SQLite attempt/workspace store sharing the authoritative controller transaction. */
export class SqliteWorkspaceLifecycleStore
  extends SqliteCoordinationStore
  implements
    WorkspaceLifecycleStore,
    LaunchEnvelopeBindingStore,
    TaskPacketBindingStore,
    WorkerSessionStore,
    WorkerAuthorityDecisionStore,
    AttemptVerificationStore,
    AttemptAcceptanceStore,
    AgentWorkFanoutStore
{
  constructor(dbPath: string, options: SqliteCoordinationStoreOptions = {}) {
    super(dbPath, options);
    if (!options.readOnly) {
      try {
        this.applyWorkspaceMigration();
      } catch (error) {
        this.db.close();
        throw error;
      }
    }
  }

  async createAttempt(input: CreateAttemptInput): Promise<WorkspaceMutationResult> {
    return this.mutate(input, () => {
      if (this.attempt(input.attemptId)) return this.failure("live_attempt_conflict");
      const fanout = this.validateFanoutBinding(input);
      if (!fanout.valid) return this.failure("fanout_invalid");
      const conflict = fanout.record
        ? this.db
            .prepare(
              `SELECT 1 FROM attempts AS a
               LEFT JOIN agent_work_fanout_attempts AS f ON f.attemptId = a.attemptId
               WHERE a.runId = ? AND a.workItemId = ?
                 AND a.status IN (${sqlEnumValues(LIVE_ATTEMPT_STATUSES)})
                 AND (f.fanoutId IS NULL OR f.fanoutId != ?) LIMIT 1`
            )
            .get(input.runId, input.workItemId, fanout.record.fanoutId)
        : this.db
            .prepare(
              `SELECT 1 FROM attempts WHERE runId = ? AND workItemId = ?
               AND status IN (${sqlEnumValues(LIVE_ATTEMPT_STATUSES)}) LIMIT 1`
            )
            .get(input.runId, input.workItemId);
      if (conflict) return this.failure("live_attempt_conflict");
      const retry = this.validateRetryDelta(input, fanout.record?.fanoutId);
      if (!retry.valid) return this.failure(retry.reason);
      const now = instant(input.now);
      this.db
        .prepare(
          `INSERT INTO attempts (attemptId, runId, runRevision, workItemId, workItemRevision, packetId,
           packetHash, baseSha, revision, status, workspaceLeaseId, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'prepared', NULL, ?, ?)`
        )
        .run(
          input.attemptId,
          input.runId,
          input.expectedRunRevision,
          input.workItemId,
          input.workItemRevision,
          input.packetId,
          input.packetHash,
          input.baseSha,
          now,
          now
        );
      if (retry.record) {
        this.db
          .prepare(
            `INSERT INTO attempt_retry_deltas
             (attemptId, previousAttemptId, deltaHash, deltaJson, createdAt)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(
            retry.record.attemptId,
            retry.record.previousAttemptId,
            retry.record.deltaHash,
            retry.record.deltaJson,
            retry.record.createdAt
          );
      }
      if (fanout.record) {
        this.db
          .prepare(
            `INSERT INTO agent_work_fanout_attempts
             (attemptId,fanoutId,premiseId,premiseHash,planHash,createdAt)
             VALUES (?,?,?,?,?,?)`
          )
          .run(
            fanout.record.attemptId,
            fanout.record.fanoutId,
            fanout.record.premiseId,
            fanout.record.premiseHash,
            fanout.record.planHash,
            fanout.record.createdAt
          );
      }
      return this.record(input, this.requireAttempt(input.attemptId), null, "attempt_created", {
        fanoutId: fanout.record?.fanoutId ?? null,
        premiseId: fanout.record?.premiseId ?? null,
        workItemId: input.workItemId,
        retryDeltaHash: retry.record?.deltaHash ?? null,
      });
    });
  }

  async transitionAttempt(input: TransitionAttemptInput): Promise<WorkspaceMutationResult> {
    return this.mutate(input, () => {
      const attempt = this.attempt(input.attemptId);
      const failure = this.validateAttempt(attempt, input.runId, input.expectedAttemptRevision);
      if (failure) return failure;
      if (!canTransitionAttempt(attempt!.status, input.status)) {
        return this.failure("invalid_attempt_transition", attempt!);
      }
      if (
        (attempt!.status === "receipt_submitted" ||
          attempt!.status === "verifying" ||
          attempt!.status === "verified") &&
        input.status !== "quarantined"
      ) {
        return this.failure("evidence_mismatch", attempt!);
      }
      if (input.status === "receipt_submitted") {
        return this.failure("evidence_mismatch", attempt!);
      }
      if (input.receiptId !== undefined) {
        const durableReceipt = this.getReceiptForAttempt(attempt!.attemptId);
        if (
          !durableReceipt ||
          durableReceipt.receiptId !== input.receiptId ||
          attempt!.receiptId !== input.receiptId ||
          durableReceipt.attemptId !== attempt!.attemptId ||
          durableReceipt.disposition !== "verification_pending"
        ) {
          return this.failure("evidence_mismatch", attempt!);
        }
      }
      if (requiresDurableReceipt(input.status)) {
        const receipt = this.getReceiptForAttempt(attempt!.attemptId);
        if (
          !receipt ||
          receipt.receiptId !== attempt!.receiptId ||
          receipt.attemptId !== attempt!.attemptId ||
          receipt.disposition !== "verification_pending"
        ) {
          return this.failure("evidence_mismatch", attempt!);
        }
      }
      if (parseInstant(input.now, "now") < parseInstant(attempt!.updatedAt, "updatedAt")) {
        return this.failure("invalid_time", attempt!);
      }
      if (requiresLiveWorkspace(input.status)) {
        const lease = attempt!.workspaceLeaseId ? this.lease(attempt!.workspaceLeaseId) : null;
        if (!lease || lease.status !== "active") {
          return this.failure("workspace_not_active", attempt!, lease ?? undefined);
        }
        if (
          lease.controllerId !== input.controller.controllerId ||
          lease.controllerLeaseId !== input.controller.leaseId ||
          lease.fencingToken !== input.controller.fencingToken
        ) {
          return this.failure("stale_fence", attempt!, lease);
        }
        if (parseInstant(lease.expiresAt, "expiresAt") <= parseInstant(input.now, "now")) {
          return this.failure("workspace_expired", attempt!, lease);
        }
        if (input.status === "launching" && !isLaunchReadyWorkspace(lease)) {
          return this.failure("evidence_mismatch", attempt!, lease);
        }
      }
      const evidence = bindEvidence(attempt!, input);
      if (!evidence) return this.failure("evidence_mismatch", attempt!);
      this.db
        .prepare(
          `UPDATE attempts SET revision = revision + 1, status = ?, updatedAt = ?, completedAt = ?,
           receiptId = COALESCE(?, receiptId), verificationId = COALESCE(?, verificationId)
           WHERE attemptId = ?`
        )
        .run(
          input.status,
          instant(input.now),
          isTerminalAttemptStatus(input.status) ? instant(input.now) : null,
          evidence.receiptId,
          evidence.verificationId,
          input.attemptId
        );
      const updated = this.requireAttempt(input.attemptId);
      const lease = updated.workspaceLeaseId ? this.lease(updated.workspaceLeaseId) : null;
      return this.record(input, updated, lease, "attempt_transitioned", {
        status: input.status,
        receiptId: updated.receiptId,
        verificationId: updated.verificationId,
        details: input.details ?? null,
      });
    });
  }

  async acquireWorkspace(input: AcquireWorkspaceInput): Promise<WorkspaceMutationResult> {
    return this.mutate(input, () => {
      const attempt = this.attempt(input.attemptId);
      const failure = this.validateAttempt(attempt, input.runId, input.expectedAttemptRevision);
      if (failure) return failure;
      if (parseInstant(input.now, "now") < parseInstant(attempt!.updatedAt, "updatedAt"))
        return this.failure("invalid_time", attempt!);
      if (!validTtl(input.ttlMs)) return this.failure("invalid_time", attempt!);
      if (!isLiveAttemptStatus(attempt!.status)) return this.failure("attempt_not_live", attempt!);
      if (attempt!.workspaceLeaseId || this.lease(input.workspaceLeaseId))
        return this.failure("live_attempt_conflict", attempt!);
      if (attempt!.workItemId !== input.workItemId || attempt!.baseSha !== input.baseSha)
        return this.failure("identity_mismatch", attempt!);
      if (
        input.observation?.exists &&
        (!input.observation.registered || !sameIdentity(input, input.observation))
      )
        return this.failure("identity_mismatch", attempt!);
      if (input.observation?.exists && input.observation.cleanliness === "dirty")
        return this.failure("dirty_workspace", attempt!);
      const branch = this.db
        .prepare(
          `SELECT 1 FROM workspace_leases WHERE repositoryId = ? AND branch = ?
           AND (status IN (${sqlEnumValues(LIVE_WORKSPACE_LEASE_STATUSES)}) OR status = 'quarantined')`
        )
        .get(input.repositoryId, input.branch);
      if (branch) return this.failure("branch_conflict", attempt!);
      const tree = this.db
        .prepare(
          `SELECT 1 FROM workspace_leases WHERE hostId = ? AND gitRuntime = ? AND worktreePath = ?
           AND (status IN (${sqlEnumValues(LIVE_WORKSPACE_LEASE_STATUSES)}) OR status = 'quarantined')`
        )
        .get(input.hostId, input.gitRuntime, input.worktreePath);
      if (tree) return this.failure("worktree_conflict", attempt!);

      const now = instant(input.now);
      this.db
        .prepare(
          `INSERT INTO workspace_leases (leaseId, runId, runRevision, workItemId, workItemRevision,
           packetId, packetHash, attemptId, revision,
           controllerId, controllerLeaseId, fencingToken, repositoryId, hostId, gitRuntime,
           projectRoot, branch, worktreePath, baseSha, status, acquiredAt, heartbeatAt, expiresAt,
           lastObservationJson)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.workspaceLeaseId,
          input.runId,
          attempt!.runRevision,
          input.workItemId,
          attempt!.workItemRevision,
          attempt!.packetId,
          attempt!.packetHash,
          input.attemptId,
          input.controller.controllerId,
          input.controller.leaseId,
          input.controller.fencingToken,
          input.repositoryId,
          input.hostId,
          input.gitRuntime,
          input.projectRoot,
          input.branch,
          input.worktreePath,
          input.baseSha,
          input.observation?.exists && input.observation.registered ? "active" : "reserved",
          now,
          now,
          calculateExpiry(now, input.ttlMs),
          input.observation ? json(input.observation) : null
        );
      this.db
        .prepare(
          `UPDATE attempts SET workspaceLeaseId = ?, revision = revision + 1,
           status = 'leased', updatedAt = ? WHERE attemptId = ?`
        )
        .run(input.workspaceLeaseId, now, input.attemptId);
      const lease = this.requireLease(input.workspaceLeaseId);
      return this.record(input, this.requireAttempt(input.attemptId), lease, "workspace_acquired", {
        repositoryId: lease.repositoryId,
        branch: lease.branch,
        worktreePath: lease.worktreePath,
      });
    });
  }

  async heartbeatWorkspace(input: HeartbeatWorkspaceInput): Promise<WorkspaceMutationResult> {
    return this.mutateWorkspace(input, false, (attempt, lease) => {
      if (!validTtl(input.ttlMs)) return this.failure("invalid_time", attempt, lease);
      if (parseInstant(lease.expiresAt, "expiresAt") <= parseInstant(input.now, "now"))
        return this.failure("workspace_expired", attempt, lease);
      if (
        !sameIdentity(lease, input.observation) ||
        !input.observation.exists ||
        !input.observation.registered
      )
        return this.quarantine(input, attempt, lease, "identity_mismatch", input.observation);
      const now = instant(input.now);
      this.bumpAttempt(attempt.attemptId, now);
      this.db
        .prepare(
          `UPDATE workspace_leases SET revision = revision + 1, status = 'active', heartbeatAt = ?,
           expiresAt = ?, lastObservationJson = ? WHERE leaseId = ?`
        )
        .run(now, calculateExpiry(now, input.ttlMs), json(input.observation), lease.leaseId);
      return this.record(
        input,
        this.requireAttempt(attempt.attemptId),
        this.requireLease(lease.leaseId),
        "workspace_heartbeat",
        { cleanliness: input.observation.cleanliness, headSha: input.observation.headSha }
      );
    });
  }

  async releaseWorkspace(input: ReleaseWorkspaceInput): Promise<WorkspaceMutationResult> {
    return this.mutateWorkspace(input, false, (attempt, lease) => {
      if (parseInstant(lease.expiresAt, "expiresAt") <= parseInstant(input.now, "now"))
        return this.failure("workspace_expired", attempt, lease);
      if (
        !sameIdentity(lease, input.observation) ||
        !input.observation.exists ||
        !input.observation.registered
      )
        return this.quarantine(input, attempt, lease, "identity_mismatch", input.observation);
      if (input.observation.cleanliness === "dirty")
        return this.quarantine(input, attempt, lease, "dirty_workspace", input.observation);
      return this.finish(
        input,
        attempt,
        lease,
        "released",
        input.disposition,
        "workspace_released"
      );
    });
  }

  async reconcileWorkspace(input: ReconcileWorkspaceInput): Promise<WorkspaceMutationResult> {
    return this.mutateWorkspace(input, true, (attempt, lease) => {
      if (
        !sameIdentity(lease, input.observation) ||
        !input.observation.exists ||
        !input.observation.registered
      )
        return this.quarantine(input, attempt, lease, "identity_mismatch", input.observation);
      if (input.action === "resume") {
        if (input.observation.cleanliness === "dirty")
          return this.quarantine(input, attempt, lease, "dirty_workspace", input.observation);
        if (!input.ttlMs || !validTtl(input.ttlMs))
          return this.failure("invalid_reconciliation", attempt, lease);
        const now = instant(input.now);
        this.bumpAttempt(attempt.attemptId, now);
        this.db
          .prepare(
            `UPDATE workspace_leases SET revision = revision + 1, status = 'active', controllerId = ?,
             controllerLeaseId = ?, fencingToken = ?, heartbeatAt = ?, expiresAt = ?,
             lastObservationJson = ? WHERE leaseId = ?`
          )
          .run(
            input.controller.controllerId,
            input.controller.leaseId,
            input.controller.fencingToken,
            now,
            calculateExpiry(now, input.ttlMs),
            json(input.observation),
            lease.leaseId
          );
        return this.record(
          input,
          this.requireAttempt(attempt.attemptId),
          this.requireLease(lease.leaseId),
          "workspace_reconciled",
          { action: "resume" }
        );
      }
      if (input.action === "preserve")
        return this.finish(input, attempt, lease, "preserved", "preserved", "workspace_reconciled");
      if (input.observation.cleanliness === "dirty")
        return this.quarantine(input, attempt, lease, "dirty_workspace", input.observation);
      return this.finish(
        input,
        attempt,
        lease,
        input.action === "release" ? "released" : "abandoned",
        input.action === "release" ? "discarded" : "abandoned",
        "workspace_reconciled"
      );
    });
  }

  async quarantineWorkspace(input: QuarantineWorkspaceInput): Promise<WorkspaceMutationResult> {
    return this.mutateWorkspace(input, false, (attempt, lease) =>
      this.quarantine(input, attempt, lease, input.reason, input.observation)
    );
  }

  async getAttempt(attemptId: string): Promise<AttemptRecord | null> {
    return this.attempt(attemptId);
  }

  async listAttempts(runId: string): Promise<AttemptRecord[]> {
    const rows = this.db
      .prepare(`SELECT * FROM attempts WHERE runId = ? ORDER BY rowid`)
      .all(runId) as AttemptRow[];
    return rows.flatMap((row) => {
      const status = AttemptStatusSchema.safeParse(row.status);
      return status.success ? [{ ...row, status: status.data }] : [];
    });
  }

  async createFanoutPlan(input: CreateFanoutPlanInput): Promise<FanoutPlanMutationResult> {
    return this.withFanoutAuthority<FanoutPlanMutationResult>(
      input,
      (reason, currentRunRevision) => ({
        created: false,
        reason,
        ...(currentRunRevision !== undefined ? { currentRunRevision } : {}),
      }),
      () => {
        const parsed = AgentWorkFanoutPlan_v1.safeParse(input.plan);
        if (
          !parsed.success ||
          parsed.data.run_id !== input.runId ||
          instant(parsed.data.created_at) !== instant(input.now)
        ) {
          return { created: false, reason: "fanout_invalid" };
        }
        const fingerprint = canonicalJSONStringify(input as unknown as JsonRecord);
        const prior = this.fanoutMutation(input.runId, input.mutationId);
        if (prior) {
          const record = prior.kind === "plan" ? this.fanoutPlan(prior.recordId) : null;
          return prior.fingerprint === fingerprint && record
            ? { created: true, plan: record, idempotentReplay: true }
            : { created: false, reason: "mutation_conflict" };
        }
        if (this.nonFanoutMutationClaim(input.runId, input.mutationId)) {
          return { created: false, reason: "mutation_conflict" };
        }
        const planJson = canonicalJSONStringify(parsed.data);
        const planHash = computeCanonicalHash(parsed.data);
        const existing = this.fanoutPlan(parsed.data.fanout_id);
        if (existing) {
          if (existing.planHash !== planHash || existing.planJson !== planJson) {
            return { created: false, reason: "fanout_conflict" };
          }
          this.insertFanoutMutation(input, fingerprint, "plan", existing.fanoutId);
          return { created: true, plan: existing, idempotentReplay: true };
        }
        const occupied = parsed.data.premises.some(({ attempt_id }) =>
          Boolean(
            this.db
              .prepare(
                `SELECT 1 FROM attempts WHERE attemptId = ?
                 UNION ALL SELECT 1 FROM agent_work_fanout_attempts WHERE attemptId = ?`
              )
              .get(attempt_id, attempt_id)
          )
        );
        if (occupied) return { created: false, reason: "fanout_conflict" };
        this.db
          .prepare(
            `INSERT INTO agent_work_fanout_plans
             (fanoutId,runId,workItemId,workItemRevision,planHash,planJson,controllerId,
              controllerLeaseId,fencingToken,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)`
          )
          .run(
            parsed.data.fanout_id,
            parsed.data.run_id,
            parsed.data.work_item_id,
            parsed.data.work_item_revision,
            planHash,
            planJson,
            input.controller.controllerId,
            input.controller.leaseId,
            input.controller.fencingToken,
            instant(input.now)
          );
        this.insertFanoutMutation(input, fingerprint, "plan", parsed.data.fanout_id);
        return {
          created: true,
          plan: this.fanoutPlan(parsed.data.fanout_id)!,
          idempotentReplay: false,
        };
      }
    );
  }

  async getFanoutPlan(fanoutId: string): Promise<FanoutPlanRecord | null> {
    return this.hasTable("agent_work_fanout_plans") ? this.fanoutPlan(fanoutId) : null;
  }

  async getAttemptFanoutBinding(attemptId: string): Promise<FanoutAttemptBindingRecord | null> {
    return this.hasTable("agent_work_fanout_attempts") ? this.fanoutBinding(attemptId) : null;
  }

  async listFanoutAttemptBindings(fanoutId: string): Promise<FanoutAttemptBindingRecord[]> {
    if (!this.hasTable("agent_work_fanout_attempts")) return [];
    return this.db
      .prepare(
        `SELECT fanoutId,attemptId,premiseId,premiseHash,planHash,createdAt
         FROM agent_work_fanout_attempts WHERE fanoutId = ? ORDER BY attemptId`
      )
      .all(fanoutId) as FanoutAttemptBindingRecord[];
  }

  async commitFanInDecision(input: CommitFanInDecisionInput): Promise<FanInDecisionMutationResult> {
    return this.withFanoutAuthority<FanInDecisionMutationResult>(
      input,
      (reason, currentRunRevision) => ({
        recorded: false,
        reason,
        ...(currentRunRevision !== undefined ? { currentRunRevision } : {}),
      }),
      () => {
        const parsed = AgentWorkFanInDecision_v1.safeParse(input.decision);
        if (
          !parsed.success ||
          parsed.data.run_id !== input.runId ||
          instant(parsed.data.created_at) !== instant(input.now)
        ) {
          return { recorded: false, reason: "fanout_evidence_mismatch" };
        }
        const fingerprint = canonicalJSONStringify(input as unknown as JsonRecord);
        const prior = this.fanoutMutation(input.runId, input.mutationId);
        if (prior) {
          const record = prior.kind === "decision" ? this.fanInDecision(prior.recordId) : null;
          return prior.fingerprint === fingerprint && record
            ? { recorded: true, decision: record, idempotentReplay: true }
            : { recorded: false, reason: "mutation_conflict" };
        }
        if (this.nonFanoutMutationClaim(input.runId, input.mutationId)) {
          return { recorded: false, reason: "mutation_conflict" };
        }
        const plan = this.fanoutPlan(parsed.data.fanout_id);
        if (!plan) return { recorded: false, reason: "fanout_not_found" };
        if (!this.validFanInDecision(parsed.data, plan)) {
          return { recorded: false, reason: "fanout_evidence_mismatch" };
        }
        const decisionJson = canonicalJSONStringify(parsed.data);
        const decisionHash = computeCanonicalHash(parsed.data);
        const existing =
          this.fanInDecision(parsed.data.decision_id) ??
          this.fanInDecisionForFanout(parsed.data.fanout_id);
        if (existing) {
          if (existing.decisionHash !== decisionHash || existing.decisionJson !== decisionJson) {
            return { recorded: false, reason: "fanout_conflict" };
          }
          this.insertFanoutMutation(input, fingerprint, "decision", existing.decisionId);
          return { recorded: true, decision: existing, idempotentReplay: true };
        }
        this.db
          .prepare(
            `INSERT INTO agent_work_fanin_decisions
             (decisionId,fanoutId,runId,workItemId,workItemRevision,decisionHash,decisionJson,
              selectedAttemptId,outcome,controllerId,controllerLeaseId,fencingToken,createdAt)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
          )
          .run(
            parsed.data.decision_id,
            parsed.data.fanout_id,
            parsed.data.run_id,
            parsed.data.work_item_id,
            parsed.data.work_item_revision,
            decisionHash,
            decisionJson,
            parsed.data.selected_attempt_id ?? null,
            parsed.data.decision,
            input.controller.controllerId,
            input.controller.leaseId,
            input.controller.fencingToken,
            instant(input.now)
          );
        this.insertFanoutMutation(input, fingerprint, "decision", parsed.data.decision_id);
        return {
          recorded: true,
          decision: this.fanInDecision(parsed.data.decision_id)!,
          idempotentReplay: false,
        };
      }
    );
  }

  async getFanInDecision(decisionId: string): Promise<FanInDecisionRecord | null> {
    return this.hasTable("agent_work_fanin_decisions") ? this.fanInDecision(decisionId) : null;
  }

  async getFanInDecisionForFanout(fanoutId: string): Promise<FanInDecisionRecord | null> {
    return this.hasTable("agent_work_fanin_decisions")
      ? this.fanInDecisionForFanout(fanoutId)
      : null;
  }

  async getAttemptRetryDelta(attemptId: string): Promise<AttemptRetryDeltaRecord | null> {
    if (!this.hasTable("attempt_retry_deltas")) return null;
    const row = this.db
      .prepare(`SELECT * FROM attempt_retry_deltas WHERE attemptId = ?`)
      .get(attemptId) as AttemptRetryDeltaRecord | undefined;
    if (!row) return null;
    try {
      const parsed = AttemptRetryDelta_v1.safeParse(JSON.parse(row.deltaJson));
      return parsed.success &&
        canonicalJSONStringify(parsed.data) === row.deltaJson &&
        computeCanonicalHash(parsed.data) === row.deltaHash &&
        parsed.data.next_attempt_id === row.attemptId &&
        parsed.data.previous_attempt_id === row.previousAttemptId &&
        parsed.data.created_at === row.createdAt
        ? { ...row }
        : null;
    } catch {
      return null;
    }
  }

  async getWorkspaceLease(leaseId: string): Promise<WorkspaceLifecycleLeaseRecord | null> {
    return this.lease(leaseId);
  }

  async listWorkspaceLeases(runId: string): Promise<WorkspaceLifecycleLeaseRecord[]> {
    const rows = this.db
      .prepare(`SELECT leaseId FROM workspace_leases WHERE runId = ? ORDER BY rowid`)
      .all(runId) as Array<{ leaseId: string }>;
    return rows.flatMap(({ leaseId }) => {
      const lease = this.lease(leaseId);
      return lease ? [lease] : [];
    });
  }

  async listWorkspaceLifecycleEvents(runId: string): Promise<WorkspaceLifecycleEvent[]> {
    const rows = this.db
      .prepare(`SELECT * FROM workspace_lifecycle_events WHERE runId = ? ORDER BY sequence`)
      .all(runId) as EventRow[];
    return rows.map(toEvent);
  }

  async bindLaunchEnvelope(input: BindLaunchEnvelopeInput): Promise<LaunchEnvelopeBindingResult> {
    if (!Number.isFinite(Date.parse(input.createdAt)))
      return { bound: false, reason: "invalid_time" };
    if (input.controller.runId !== input.runId) return { bound: false, reason: "lease_mismatch" };
    return this.immediateTransaction(() => {
      const coordination = this.db
        .prepare(
          `SELECT revision, controllerId, leaseId, fencingToken, expiresAt
           FROM run_coordination WHERE runId = ?`
        )
        .get(input.runId) as
        | {
            revision: number;
            controllerId: string | null;
            leaseId: string | null;
            fencingToken: number;
            expiresAt: string | null;
          }
        | undefined;
      if (!coordination?.controllerId) return sqliteLaunchFailure("no_active_lease");
      if (coordination.fencingToken !== input.controller.fencingToken) {
        return sqliteLaunchFailure("stale_fence");
      }
      if (
        coordination.controllerId !== input.controller.controllerId ||
        coordination.leaseId !== input.controller.leaseId
      ) {
        return sqliteLaunchFailure("lease_mismatch");
      }
      if (coordination.revision !== input.expectedRunRevision) {
        return {
          ...sqliteLaunchFailure("stale_run_revision"),
          currentRunRevision: coordination.revision,
        };
      }
      if (
        parseInstant(coordination.expiresAt!, "expiresAt") <=
        parseInstant(input.createdAt, "createdAt")
      ) {
        return sqliteLaunchFailure("lease_expired");
      }
      const attempt = this.attempt(input.attemptId);
      const lease = this.lease(input.workspaceLeaseId);
      const existing = this.launchEnvelopeBinding(input.attemptId);
      if (existing) {
        return sameLaunchBinding(existing, input) &&
          sameTaskPacketBinding(this.taskPacketBinding(input.attemptId), input.packetJson, attempt)
          ? { bound: true, binding: existing, idempotentReplay: true }
          : sqliteLaunchFailure("mutation_conflict", attempt ?? undefined, lease ?? undefined);
      }
      const failure = sqliteLaunchBindingFailure(input, attempt, lease);
      if (failure) return failure;
      const envelopeIdConflict = this.db
        .prepare(`SELECT 1 FROM launch_envelope_bindings WHERE envelopeId = ?`)
        .get(input.envelopeId);
      if (envelopeIdConflict) {
        return sqliteLaunchFailure("mutation_conflict", attempt!, lease!);
      }
      const eventRow = this.db
        .prepare(`SELECT * FROM workspace_lifecycle_events WHERE runId = ? AND mutationId = ?`)
        .get(input.runId, input.authorizationMutationId) as EventRow | undefined;
      const event = eventRow ? toEvent(eventRow) : undefined;
      if (!isMatchingLaunchAuthorization(event, input)) {
        return sqliteLaunchFailure("evidence_mismatch", attempt!, lease!);
      }
      if (!validateCanonicalEnvelope(input, attempt!, lease!)) {
        return sqliteLaunchFailure("evidence_mismatch", attempt!, lease!);
      }
      // A packet snapshot is mandatory for every new binding.  The optional
      // input remains only so an already-persisted pre-snapshot envelope can
      // be replayed exactly during compatibility migration.
      if (
        input.packetJson === undefined ||
        !validateCanonicalTaskPacket(input.packetJson, attempt!)
      ) {
        return sqliteLaunchFailure("evidence_mismatch", attempt!, lease!);
      }
      const createdAt = instant(input.createdAt);
      this.db
        .prepare(
          `INSERT INTO launch_envelope_bindings (attemptId, runId, workspaceLeaseId,
           attemptRevision, workspaceLeaseRevision, authorizationMutationId, envelopeId,
           envelopeHash, envelopeJson, controllerId, controllerLeaseId, fencingToken, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.attemptId,
          input.runId,
          input.workspaceLeaseId,
          input.expectedAttemptRevision,
          input.expectedWorkspaceLeaseRevision,
          input.authorizationMutationId,
          input.envelopeId,
          input.envelopeHash,
          input.envelopeJson,
          input.controller.controllerId,
          input.controller.leaseId,
          input.controller.fencingToken,
          createdAt
        );
      this.db
        .prepare(
          `INSERT INTO task_packet_bindings (attemptId, runId, workItemId, workItemRevision,
           packetId, packetHash, packetJson, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.attemptId,
          input.runId,
          attempt!.workItemId,
          attempt!.workItemRevision,
          attempt!.packetId,
          attempt!.packetHash,
          input.packetJson,
          createdAt
        );
      return {
        bound: true,
        binding: this.requireLaunchEnvelopeBinding(input.attemptId),
        idempotentReplay: false,
      };
    });
  }

  async getLaunchEnvelopeBinding(attemptId: string): Promise<LaunchEnvelopeBindingRecord | null> {
    return this.hasTable("launch_envelope_bindings") ? this.launchEnvelopeBinding(attemptId) : null;
  }

  async reconcileIncompleteLaunch(
    input: ReconcileIncompleteLaunchInput
  ): Promise<WorkspaceMutationResult> {
    return this.mutate(input, () => {
      const attempt = this.attempt(input.attemptId);
      const attemptFailure = this.validateAttempt(
        attempt,
        input.runId,
        input.expectedAttemptRevision
      );
      if (attemptFailure) return attemptFailure;
      const lease = this.lease(input.workspaceLeaseId);
      if (!lease || lease.attemptId !== attempt!.attemptId) {
        return this.failure("not_found", attempt!);
      }
      if (lease.revision !== input.expectedWorkspaceLeaseRevision) {
        return this.failure("stale_workspace_revision", attempt!, lease);
      }
      if (attempt!.status !== "launching") {
        return this.failure("invalid_reconciliation", attempt!, lease);
      }
      if (lease.status !== "active") {
        return this.failure("workspace_not_active", attempt!, lease);
      }
      if (
        lease.controllerId !== input.controller.controllerId ||
        lease.controllerLeaseId !== input.controller.leaseId ||
        lease.fencingToken !== input.controller.fencingToken
      ) {
        return this.failure("stale_fence", attempt!, lease);
      }
      if (parseInstant(lease.expiresAt, "expiresAt") <= parseInstant(input.now, "now")) {
        return this.failure("workspace_expired", attempt!, lease);
      }
      const durableLaunchEvidence = this.db
        .prepare(
          `SELECT 1 FROM launch_envelope_bindings WHERE attemptId = ?
           UNION ALL SELECT 1 FROM task_packet_bindings WHERE attemptId = ?
           UNION ALL SELECT 1 FROM worker_sessions WHERE attemptId = ? LIMIT 1`
        )
        .get(input.attemptId, input.attemptId, input.attemptId);
      if (durableLaunchEvidence) return this.failure("evidence_mismatch", attempt!, lease);
      const authorizationRow = this.db
        .prepare(
          `SELECT * FROM workspace_lifecycle_events
           WHERE runId = ? AND attemptId = ? AND type = 'attempt_transitioned'
           ORDER BY sequence DESC`
        )
        .all(input.runId, input.attemptId)
        .map((row) => toEvent(row as EventRow))
        .find((event) => isLaunchAuthorizationForAttempt(event, attempt!, lease));
      if (!authorizationRow) return this.failure("evidence_mismatch", attempt!, lease);
      if (parseInstant(input.now, "now") < parseInstant(attempt!.updatedAt, "updatedAt")) {
        return this.failure("invalid_time", attempt!, lease);
      }
      const now = instant(input.now);
      this.db
        .prepare(
          `UPDATE attempts SET revision = revision + 1, status = 'launch_failed',
           updatedAt = ?, completedAt = ? WHERE attemptId = ?`
        )
        .run(now, now, input.attemptId);
      return this.record(
        input,
        this.requireAttempt(input.attemptId),
        lease,
        "attempt_transitioned",
        {
          status: "launch_failed",
          receiptId: null,
          verificationId: null,
          details: {
            reconciliation: "missing_launch_envelope",
            authorizationMutationId: authorizationRow.mutationId,
          },
        }
      );
    });
  }

  async getTaskPacketBinding(attemptId: string): Promise<TaskPacketBindingRecord | null> {
    if (!this.hasTable("task_packet_bindings")) return null;
    const binding = this.taskPacketBinding(attemptId);
    const attempt = this.attempt(attemptId);
    return binding && attempt && validateTaskPacketBinding(binding, attempt) ? binding : null;
  }

  async attachWorkerSession(input: AttachWorkerSessionInput): Promise<WorkerSessionMutationResult> {
    return this.mutateWorker(input, () => {
      const validated = this.validateWorkerBinding(input);
      if (!validated.valid) return validated.failure;
      const { attempt, lease } = validated;
      const existing = this.workerSessionForAttempt(input.attemptId, false);
      if (existing || this.workerSession(input.sessionId)) {
        return this.workerFailure("worker_session_conflict", attempt, lease, existing ?? undefined);
      }
      const nativeIdentityConflict = this.workerSessionForNativeIdentity(
        input.hostId,
        input.backend,
        input.workerId
      );
      if (nativeIdentityConflict) {
        return this.workerFailure(
          "worker_session_conflict",
          attempt,
          lease,
          nativeIdentityConflict
        );
      }
      if (attempt.status !== "launching") {
        return this.workerFailure("invalid_attempt_transition", attempt, lease);
      }
      if (input.packetId !== attempt.packetId || input.packetHash !== attempt.packetHash) {
        return this.workerFailure("identity_mismatch", attempt, lease);
      }
      const envelope = this.launchEnvelopeBinding(input.attemptId);
      if (
        !envelope ||
        envelope.envelopeId !== input.executionEnvelopeId ||
        envelope.envelopeHash !== input.executionEnvelopeHash
      ) {
        return this.workerFailure("identity_mismatch", attempt, lease);
      }
      if (boundWorkerRuntime(envelope) !== input.workerRuntime) {
        return this.workerFailure("identity_mismatch", attempt, lease);
      }
      if (input.hostId !== lease.hostId || input.gitRuntime !== lease.gitRuntime) {
        return this.workerFailure("identity_mismatch", attempt, lease);
      }
      if (!Number.isFinite(Date.parse(input.startedAt))) {
        return this.workerFailure("invalid_time", attempt, lease);
      }
      if (input.adapter && !validWorkerAdapterBinding(input.adapter)) {
        return this.workerFailure("evidence_mismatch", attempt, lease);
      }
      const now = instant(input.now);
      const startedAt = instant(input.startedAt);
      if (
        parseInstant(startedAt, "startedAt") <
          parseInstant(envelope.createdAt, "envelope.createdAt") ||
        parseInstant(startedAt, "startedAt") > parseInstant(now, "now")
      ) {
        return this.workerFailure("invalid_time", attempt, lease);
      }
      this.db
        .prepare(
          `INSERT INTO worker_sessions (sessionId, revision, runId, attemptId, packetId, packetHash,
           workspaceLeaseId, workspaceLeaseRevision, executionEnvelopeId, executionEnvelopeHash,
           hostId, workerRuntime,
           gitRuntime, backend, workerId, model, status, startedAt, heartbeatAt)
           VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`
        )
        .run(
          input.sessionId,
          input.runId,
          input.attemptId,
          input.packetId,
          input.packetHash,
          input.workspaceLeaseId,
          input.expectedWorkspaceLeaseRevision,
          input.executionEnvelopeId,
          input.executionEnvelopeHash,
          input.hostId,
          input.workerRuntime,
          input.gitRuntime,
          input.backend,
          input.workerId,
          input.model ?? null,
          startedAt,
          now
        );
      if (input.adapter) {
        this.db
          .prepare(
            `INSERT INTO worker_adapter_bindings
             (sessionId, adapterId, adapterVersion, enforcementSummaryHash,
              trustGapDimensionsJson, createdAt)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            input.sessionId,
            input.adapter.adapterId,
            input.adapter.adapterVersion,
            input.adapter.enforcementSummaryHash,
            json(input.adapter.trustGapDimensions),
            now
          );
      }
      this.db
        .prepare(
          `UPDATE attempts SET revision = revision + 1, status = 'running', updatedAt = ?
           WHERE attemptId = ?`
        )
        .run(now, input.attemptId);
      const session = this.requireWorkerSession(input.sessionId);
      return this.recordWorker(
        input,
        this.requireAttempt(input.attemptId),
        lease,
        session,
        "worker_session_attached",
        {
          backend: session.backend,
          workerId: session.workerId,
          executionEnvelopeId: session.executionEnvelopeId,
          ...(input.adapter
            ? {
                adapter: {
                  id: input.adapter.adapterId,
                  version: input.adapter.adapterVersion,
                  enforcementSummaryHash: input.adapter.enforcementSummaryHash,
                  trustGapDimensions: input.adapter.trustGapDimensions,
                },
              }
            : {}),
        }
      );
    });
  }

  async heartbeatWorkerSession(
    input: HeartbeatWorkerSessionInput
  ): Promise<WorkerSessionMutationResult> {
    return this.mutateWorker(input, () => {
      const validated = this.validateWorkerBinding(input);
      if (!validated.valid) return validated.failure;
      const { attempt, lease } = validated;
      const session = this.workerSession(input.sessionId);
      const failure = this.validateSession(session, input, attempt, lease);
      if (failure) return failure;
      const now = instant(input.now);
      if (parseInstant(now, "now") < parseInstant(session!.heartbeatAt, "heartbeatAt")) {
        return this.workerFailure("invalid_time", attempt, lease, session!);
      }
      this.db
        .prepare(
          `UPDATE worker_sessions SET revision = revision + 1, status = ?, heartbeatAt = ?
           WHERE sessionId = ?`
        )
        .run(input.status ?? session!.status, now, input.sessionId);
      return this.recordWorker(
        input,
        attempt,
        lease,
        this.requireWorkerSession(input.sessionId),
        "worker_session_heartbeat",
        { status: input.status ?? session!.status }
      );
    });
  }

  async endWorkerSession(input: EndWorkerSessionInput): Promise<WorkerSessionMutationResult> {
    return this.mutateWorker(input, () => {
      const validated = this.validateWorkerBinding(input);
      if (!validated.valid) return validated.failure;
      const { attempt, lease } = validated;
      const session = this.workerSession(input.sessionId);
      const failure = this.validateSession(session, input, attempt, lease);
      if (failure) return failure;
      if (!validExitMetadata(input)) {
        return this.workerFailure("evidence_mismatch", attempt, lease, session!);
      }
      const now = instant(input.now);
      if (parseInstant(now, "now") < parseInstant(session!.heartbeatAt, "heartbeatAt")) {
        return this.workerFailure("invalid_time", attempt, lease, session!);
      }
      this.db
        .prepare(
          `UPDATE worker_sessions SET revision = revision + 1, status = ?, heartbeatAt = ?, endedAt = ?,
           exitReason = ?, exitCode = ?, exitSummary = ? WHERE sessionId = ?`
        )
        .run(
          input.status,
          now,
          now,
          input.exitReason ?? null,
          input.exitCode ?? null,
          input.exitSummary ?? null,
          input.sessionId
        );
      if (input.status !== "completed") {
        this.db
          .prepare(
            `UPDATE attempts SET revision = revision + 1, status = ?, updatedAt = ?, completedAt = ?
             WHERE attemptId = ?`
          )
          .run(input.status === "cancelled" ? "cancelled" : "failed", now, now, input.attemptId);
      }
      return this.recordWorker(
        input,
        this.requireAttempt(input.attemptId),
        lease,
        this.requireWorkerSession(input.sessionId),
        "worker_session_ended",
        {
          status: input.status,
          exitReason: input.exitReason ?? null,
          exitCode: input.exitCode ?? null,
          exitSummary: input.exitSummary ?? null,
        }
      );
    });
  }

  /** Authentication, live binding and additive mutation share one SQLite transaction. */
  protected withLiveWorkerSession<T>(
    input: HeartbeatWorkerSessionInput,
    action: (session: WorkerSessionRecord) => T
  ): T | Extract<WorkerSessionMutationResult, { updated: false }> {
    const denied = (reason: WorkerSessionMutationFailureReason) => ({
      updated: false as const,
      reason,
    });
    if (!Number.isFinite(Date.parse(input.now))) return denied("invalid_time");
    if (input.controller.runId !== input.runId) return denied("lease_mismatch");
    return this.immediateTransaction(() => {
      const controller = this.db
        .prepare(
          "SELECT revision, controllerId, leaseId, fencingToken, expiresAt FROM run_coordination WHERE runId = ?"
        )
        .get(input.runId) as
        | {
            revision: number;
            controllerId: string | null;
            leaseId: string | null;
            fencingToken: number;
            expiresAt: string | null;
          }
        | undefined;
      if (!controller?.controllerId) return denied("no_active_lease");
      if (controller.fencingToken !== input.controller.fencingToken) return denied("stale_fence");
      if (
        controller.controllerId !== input.controller.controllerId ||
        controller.leaseId !== input.controller.leaseId
      )
        return denied("lease_mismatch");
      if (controller.revision !== input.expectedRunRevision) return denied("stale_run_revision");
      if (!controller.expiresAt || Date.parse(controller.expiresAt) <= Date.parse(input.now))
        return denied("lease_expired");
      const binding = this.validateWorkerBinding(input);
      if (!binding.valid) {
        if (binding.failure.updated) throw new Error("Expected failed worker binding");
        return binding.failure;
      }
      const session = this.workerSession(input.sessionId);
      const failure = this.validateSession(session, input, binding.attempt, binding.lease);
      if (failure) {
        if (failure.updated) throw new Error("Expected failed worker session");
        return failure;
      }
      if (Date.parse(input.now) < Date.parse(session!.heartbeatAt)) return denied("invalid_time");
      return action({ ...session! });
    });
  }

  async getWorkerSession(sessionId: string): Promise<WorkerSessionRecord | null> {
    return this.hasTable("worker_sessions") ? this.workerSession(sessionId) : null;
  }

  async getWorkerSessionForAttempt(attemptId: string): Promise<WorkerSessionRecord | null> {
    return this.hasTable("worker_sessions") ? this.workerSessionForAttempt(attemptId, false) : null;
  }

  async getWorkerAdapterBinding(sessionId: string): Promise<WorkerAdapterBindingRecord | null> {
    if (!this.hasTable("worker_adapter_bindings")) return null;
    const row = this.db
      .prepare(`SELECT * FROM worker_adapter_bindings WHERE sessionId = ?`)
      .get(sessionId) as WorkerAdapterBindingRow | undefined;
    if (!row) return null;
    try {
      const trustGapDimensions = JSON.parse(row.trustGapDimensionsJson) as unknown;
      if (
        !Array.isArray(trustGapDimensions) ||
        !trustGapDimensions.every((value) => typeof value === "string")
      ) {
        return null;
      }
      const binding = {
        sessionId: row.sessionId,
        adapterId: row.adapterId,
        adapterVersion: row.adapterVersion,
        enforcementSummaryHash: row.enforcementSummaryHash,
        trustGapDimensions,
        createdAt: row.createdAt,
      };
      return validPersistedWorkerAdapterBinding(binding) ? binding : null;
    } catch {
      return null;
    }
  }

  async listWorkerSessionEvents(runId: string): Promise<WorkerSessionEvent[]> {
    if (!this.hasTable("worker_session_events")) return [];
    const rows = this.db
      .prepare(`SELECT * FROM worker_session_events WHERE runId = ? ORDER BY sequence`)
      .all(runId) as WorkerEventRow[];
    return rows.map(toWorkerEvent);
  }

  async recordWorkerAuthorityDecision(
    input: RecordWorkerAuthorityDecisionInput
  ): Promise<WorkerAuthorityDecisionResult> {
    if (!Number.isFinite(Date.parse(input.now))) return this.authorityFailure("invalid_time");
    if (input.controller.runId !== input.runId) return this.authorityFailure("lease_mismatch");
    return this.immediateTransaction(() => {
      const coordination = this.db
        .prepare(
          `SELECT revision, controllerId, leaseId, fencingToken, expiresAt
           FROM run_coordination WHERE runId = ?`
        )
        .get(input.runId) as
        | {
            revision: number;
            controllerId: string | null;
            leaseId: string | null;
            fencingToken: number;
            expiresAt: string | null;
          }
        | undefined;
      if (!coordination?.controllerId) return this.authorityFailure("no_active_lease");
      if (coordination.fencingToken !== input.controller.fencingToken) {
        return this.authorityFailure("stale_fence");
      }
      if (
        coordination.controllerId !== input.controller.controllerId ||
        coordination.leaseId !== input.controller.leaseId
      ) {
        return this.authorityFailure("lease_mismatch");
      }
      if (coordination.revision !== input.expectedRunRevision) {
        return this.authorityFailure(
          "stale_run_revision",
          undefined,
          undefined,
          undefined,
          coordination.revision
        );
      }
      if (parseInstant(coordination.expiresAt!, "expiresAt") <= parseInstant(input.now, "now")) {
        return this.authorityFailure("lease_expired");
      }
      const fingerprint = authorityDecisionFingerprint(input);
      const namespaceClaim = this.db
        .prepare(
          `SELECT 1 FROM workspace_lifecycle_mutations WHERE runId = ? AND mutationId = ?
           UNION ALL SELECT 1 FROM worker_session_mutations WHERE runId = ? AND mutationId = ?
           UNION ALL SELECT 1 FROM attempt_receipt_mutations WHERE runId = ? AND mutationId = ?
           UNION ALL SELECT 1 FROM attempt_verification_mutations WHERE runId = ? AND mutationId = ?
           UNION ALL SELECT 1 FROM attempt_verification_begin_mutations
           WHERE runId = ? AND mutationId = ?`
        )
        .get(
          input.runId,
          input.mutationId,
          input.runId,
          input.mutationId,
          input.runId,
          input.mutationId,
          input.runId,
          input.mutationId,
          input.runId,
          input.mutationId
        );
      if (namespaceClaim || this.fanoutMutation(input.runId, input.mutationId)) {
        return this.authorityFailure("mutation_conflict");
      }
      const prior = this.db
        .prepare(`SELECT * FROM worker_authority_events WHERE runId = ? AND mutationId = ?`)
        .get(input.runId, input.mutationId) as WorkerAuthorityEventRow | undefined;
      if (prior) {
        if (prior.fingerprint !== fingerprint) return this.authorityFailure("mutation_conflict");
        const event = toWorkerAuthorityEvent(prior);
        return event
          ? { recorded: true, event, idempotentReplay: true }
          : this.authorityFailure("evidence_mismatch");
      }
      const attempt = this.attempt(input.attemptId);
      const lease = this.lease(input.workspaceLeaseId);
      const session = this.workerSession(input.workerSessionId);
      const packetBinding = this.taskPacketBinding(input.attemptId);
      if (!attempt || !lease || !session || !packetBinding) {
        return this.authorityFailure(
          "not_found",
          attempt ?? undefined,
          lease ?? undefined,
          session ?? undefined
        );
      }
      if (attempt.revision !== input.expectedAttemptRevision) {
        return this.authorityFailure("stale_attempt_revision", attempt, lease, session);
      }
      if (lease.revision !== input.expectedWorkspaceLeaseRevision) {
        return this.authorityFailure("stale_workspace_revision", attempt, lease, session);
      }
      if (session.revision !== input.expectedWorkerSessionRevision) {
        return this.authorityFailure("stale_session_revision", attempt, lease, session);
      }
      if (
        lease.status !== "active" ||
        lease.attemptId !== input.attemptId ||
        lease.controllerId !== input.controller.controllerId ||
        lease.controllerLeaseId !== input.controller.leaseId ||
        lease.fencingToken !== input.controller.fencingToken
      ) {
        return this.authorityFailure("stale_fence", attempt, lease, session);
      }
      if (parseInstant(lease.expiresAt, "expiresAt") <= parseInstant(input.now, "now")) {
        return this.authorityFailure("workspace_expired", attempt, lease, session);
      }
      if (
        session.runId !== input.runId ||
        session.attemptId !== input.attemptId ||
        session.workspaceLeaseId !== input.workspaceLeaseId ||
        session.packetId !== attempt.packetId ||
        session.packetHash !== attempt.packetHash
      ) {
        return this.authorityFailure("identity_mismatch", attempt, lease, session);
      }
      let packet: AgentTaskPacket_v1;
      try {
        packet = AgentTaskPacket_v1.parse(JSON.parse(packetBinding.packetJson) as unknown);
      } catch {
        return this.authorityFailure("evidence_mismatch", attempt, lease, session);
      }
      if (!validAuthorityDecision(input, packet.authority)) {
        return this.authorityFailure("evidence_mismatch", attempt, lease, session);
      }
      const sequence = (
        this.db
          .prepare(
            `SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM worker_authority_events
             WHERE runId = ?`
          )
          .get(input.runId) as { value: number }
      ).value;
      this.db
        .prepare(
          `INSERT INTO worker_authority_events (
           runId, attemptId, workerSessionId, mutationId, fingerprint, sequence, attemptRevision,
           workspaceLeaseId, workspaceLeaseRevision, workerSessionRevision, packetId, packetHash,
           dimension, decision, enforcement, actionClass, actionHash, backendId, backendVersion,
           reason, controllerId, controllerLeaseId, fencingToken, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.runId,
          input.attemptId,
          input.workerSessionId,
          input.mutationId,
          fingerprint,
          sequence,
          attempt.revision,
          input.workspaceLeaseId,
          lease.revision,
          session.revision,
          attempt.packetId,
          attempt.packetHash,
          input.dimension,
          input.decision,
          input.enforcement,
          input.actionClass,
          input.actionHash,
          input.backendId,
          input.backendVersion,
          input.reason,
          input.controller.controllerId,
          input.controller.leaseId,
          input.controller.fencingToken,
          instant(input.now)
        );
      const event = toWorkerAuthorityEvent(
        this.db
          .prepare(`SELECT * FROM worker_authority_events WHERE runId = ? AND mutationId = ?`)
          .get(input.runId, input.mutationId) as WorkerAuthorityEventRow
      );
      return event
        ? { recorded: true, event, idempotentReplay: false }
        : this.authorityFailure("evidence_mismatch", attempt, lease, session);
    });
  }

  async listWorkerAuthorityEvents(runId: string): Promise<WorkerAuthorityEventRecord[]> {
    if (!this.hasTable("worker_authority_events")) return [];
    const rows = this.db
      .prepare(`SELECT * FROM worker_authority_events WHERE runId = ? ORDER BY sequence`)
      .all(runId) as WorkerAuthorityEventRow[];
    const events = rows.map(toWorkerAuthorityEvent);
    if (events.some((event) => event === null)) {
      throw new Error("Corrupt worker authority event");
    }
    return events as WorkerAuthorityEventRecord[];
  }

  async submitAttemptReceipt(
    input: SubmitAttemptReceiptInput
  ): Promise<AttemptReceiptSubmissionResult> {
    if (!Number.isFinite(Date.parse(input.now))) return this.receiptFailure("invalid_time");
    if (input.controller.runId !== input.runId) return this.receiptFailure("lease_mismatch");
    const parsed = AgentTaskReceipt_v2.safeParse(input.receipt);
    if (!parsed.success) return this.receiptFailure("evidence_mismatch");
    const receiptJson = canonicalJSONStringify(parsed.data);
    const receiptHash = computeCanonicalHash(parsed.data);
    return this.immediateTransaction(() => {
      const coordination = this.db
        .prepare(
          `SELECT revision, controllerId, leaseId, fencingToken, expiresAt
           FROM run_coordination WHERE runId = ?`
        )
        .get(input.runId) as
        | {
            revision: number;
            controllerId: string | null;
            leaseId: string | null;
            fencingToken: number;
            expiresAt: string | null;
          }
        | undefined;
      if (!coordination?.controllerId) return this.receiptFailure("no_active_lease");
      if (coordination.fencingToken !== input.controller.fencingToken) {
        return this.receiptFailure("stale_fence");
      }
      if (
        coordination.controllerId !== input.controller.controllerId ||
        coordination.leaseId !== input.controller.leaseId
      ) {
        return this.receiptFailure("lease_mismatch");
      }
      if (coordination.revision !== input.expectedRunRevision) {
        return this.receiptFailure(
          "stale_run_revision",
          undefined,
          undefined,
          undefined,
          coordination.revision
        );
      }
      if (parseInstant(coordination.expiresAt!, "expiresAt") <= parseInstant(input.now, "now")) {
        return this.receiptFailure("lease_expired");
      }
      const fingerprint = canonicalJSONStringify({
        ...input,
        receipt: parsed.data,
      } as unknown as JsonValue);
      if (
        this.db
          .prepare(
            `SELECT 1 FROM workspace_lifecycle_mutations WHERE runId = ? AND mutationId = ?
             UNION ALL SELECT 1 FROM worker_session_mutations WHERE runId = ? AND mutationId = ?
             UNION ALL SELECT 1 FROM attempt_verification_mutations
             WHERE runId = ? AND mutationId = ?
             UNION ALL SELECT 1 FROM attempt_verification_begin_mutations
             WHERE runId = ? AND mutationId = ?
             UNION ALL SELECT 1 FROM worker_authority_events
             WHERE runId = ? AND mutationId = ?`
          )
          .get(
            input.runId,
            input.mutationId,
            input.runId,
            input.mutationId,
            input.runId,
            input.mutationId,
            input.runId,
            input.mutationId,
            input.runId,
            input.mutationId
          ) ||
        this.fanoutMutation(input.runId, input.mutationId)
      ) {
        return this.receiptFailure("mutation_conflict");
      }
      const packetAttempt = this.attempt(input.attemptId);
      const packetBinding = this.hasTable("task_packet_bindings")
        ? this.taskPacketBinding(input.attemptId)
        : null;
      if (
        packetAttempt &&
        (!packetBinding || !validateTaskPacketBinding(packetBinding, packetAttempt))
      ) {
        return this.receiptFailure("evidence_mismatch", packetAttempt);
      }
      const prior = this.db
        .prepare(
          `SELECT fingerprint, resultJson FROM attempt_receipt_mutations
           WHERE runId = ? AND mutationId = ?`
        )
        .get(input.runId, input.mutationId) as
        { fingerprint: string; resultJson: string } | undefined;
      if (prior) {
        if (prior.fingerprint !== fingerprint) return this.receiptFailure("mutation_conflict");
        const replay = parseReceiptMutationSuccess(prior.resultJson);
        return replay
          ? { ...replay, idempotentReplay: true }
          : this.receiptFailure("evidence_mismatch");
      }
      const hashReceipt = this.attemptReceiptByHash(receiptHash);
      if (hashReceipt) {
        if (
          hashReceipt.receiptJson !== receiptJson ||
          hashReceipt.runId !== input.runId ||
          hashReceipt.attemptId !== input.attemptId ||
          hashReceipt.workspaceLeaseId !== input.workspaceLeaseId ||
          hashReceipt.workerSessionId !== input.workerSessionId
        ) {
          return this.receiptFailure("receipt_conflict");
        }
        const attempt = this.requireAttempt(hashReceipt.attemptId);
        const lease = this.requireLease(hashReceipt.workspaceLeaseId);
        const session = this.requireWorkerSession(hashReceipt.workerSessionId);
        const committed = this.committedReceiptResult(hashReceipt);
        if (!committed) {
          throw new Error(
            `Attempt receipt '${hashReceipt.receiptId}' is missing its committed submission result`
          );
        }
        const replay = this.recordReceiptEvent(
          input,
          attempt,
          lease,
          session,
          hashReceipt,
          "attempt_receipt_replayed"
        );
        const result = {
          submitted: true as const,
          receipt: committed.receipt,
          attempt: committed.attempt,
          event: replay.event,
          idempotentReplay: true,
        };
        this.storeReceiptMutation(input, fingerprint, result);
        return result;
      }
      const result = this.submitNewReceipt(input, parsed.data, receiptJson, receiptHash);
      if (result.submitted) this.storeReceiptMutation(input, fingerprint, result);
      return result;
    });
  }

  async getAttemptReceipt(receiptId: string): Promise<AttemptReceiptRecord | null> {
    return this.hasTable("attempt_receipts") ? this.attemptReceipt(receiptId) : null;
  }

  async getAttemptReceiptForAttempt(attemptId: string): Promise<AttemptReceiptRecord | null> {
    if (!this.hasTable("attempt_receipts")) return null;
    const row = this.db
      .prepare(`SELECT * FROM attempt_receipts WHERE attemptId = ?`)
      .get(attemptId) as AttemptReceiptRow | undefined;
    return row ? toAttemptReceipt(row) : null;
  }

  async getAttemptReceiptByHash(receiptHash: string): Promise<AttemptReceiptRecord | null> {
    return this.hasTable("attempt_receipts") ? this.attemptReceiptByHash(receiptHash) : null;
  }

  async listAttemptReceiptEvents(runId: string): Promise<AttemptReceiptEvent[]> {
    if (!this.hasTable("attempt_receipt_events")) return [];
    const rows = this.db
      .prepare(`SELECT * FROM attempt_receipt_events WHERE runId = ? ORDER BY sequence`)
      .all(runId) as AttemptReceiptEventRow[];
    return rows.map(toAttemptReceiptEvent);
  }

  async beginAttemptVerification(
    input: BeginAttemptVerificationInput
  ): Promise<AttemptVerificationBeginResult> {
    if (!Number.isFinite(Date.parse(input.now)))
      return this.verificationBeginFailure("invalid_time");
    if (input.controller.runId !== input.runId) {
      return this.verificationBeginFailure("lease_mismatch");
    }
    return this.immediateTransaction(() => {
      const coordination = this.db
        .prepare(
          `SELECT revision, controllerId, leaseId, fencingToken, expiresAt
           FROM run_coordination WHERE runId = ?`
        )
        .get(input.runId) as
        | {
            revision: number;
            controllerId: string | null;
            leaseId: string | null;
            fencingToken: number;
            expiresAt: string | null;
          }
        | undefined;
      if (!coordination?.controllerId) return this.verificationBeginFailure("no_active_lease");
      if (coordination.fencingToken !== input.controller.fencingToken) {
        return this.verificationBeginFailure("stale_fence");
      }
      if (
        coordination.controllerId !== input.controller.controllerId ||
        coordination.leaseId !== input.controller.leaseId
      ) {
        return this.verificationBeginFailure("lease_mismatch");
      }
      if (coordination.revision !== input.expectedRunRevision) {
        return this.verificationBeginFailure(
          "stale_run_revision",
          undefined,
          undefined,
          undefined,
          coordination.revision
        );
      }
      if (parseInstant(coordination.expiresAt!, "expiresAt") <= parseInstant(input.now, "now")) {
        return this.verificationBeginFailure("lease_expired");
      }
      const fingerprint = canonicalJSONStringify(input as unknown as JsonValue);
      if (
        this.db
          .prepare(
            `SELECT 1 FROM workspace_lifecycle_mutations WHERE runId = ? AND mutationId = ?
             UNION ALL SELECT 1 FROM worker_session_mutations WHERE runId = ? AND mutationId = ?
             UNION ALL SELECT 1 FROM attempt_receipt_mutations WHERE runId = ? AND mutationId = ?
             UNION ALL SELECT 1 FROM attempt_verification_mutations
             WHERE runId = ? AND mutationId = ?
             UNION ALL SELECT 1 FROM worker_authority_events
             WHERE runId = ? AND mutationId = ?`
          )
          .get(
            input.runId,
            input.mutationId,
            input.runId,
            input.mutationId,
            input.runId,
            input.mutationId,
            input.runId,
            input.mutationId,
            input.runId,
            input.mutationId
          ) ||
        this.fanoutMutation(input.runId, input.mutationId)
      ) {
        return this.verificationBeginFailure("mutation_conflict");
      }
      const prior = this.db
        .prepare(
          `SELECT fingerprint, resultJson FROM attempt_verification_begin_mutations
           WHERE runId = ? AND mutationId = ?`
        )
        .get(input.runId, input.mutationId) as
        { fingerprint: string; resultJson: string } | undefined;
      if (prior) {
        if (prior.fingerprint !== fingerprint) {
          return this.verificationBeginFailure("mutation_conflict");
        }
        const replay = parseVerificationBeginSuccess(prior.resultJson);
        return replay
          ? { ...replay, idempotentReplay: true }
          : this.verificationBeginFailure("evidence_mismatch");
      }
      const attempt = this.attempt(input.attemptId);
      const lease = this.lease(input.workspaceLeaseId);
      const session = this.workerSession(input.workerSessionId);
      const receipt = this.attemptReceipt(input.receiptId);
      if (!attempt || attempt.runId !== input.runId || !lease || !session || !receipt) {
        return this.verificationBeginFailure(
          "not_found",
          attempt ?? undefined,
          lease ?? undefined,
          session ?? undefined
        );
      }
      if (attempt.revision !== input.expectedAttemptRevision) {
        return this.verificationBeginFailure("stale_attempt_revision", attempt, lease, session);
      }
      if (lease.revision !== input.expectedWorkspaceLeaseRevision) {
        return this.verificationBeginFailure("stale_workspace_revision", attempt, lease, session);
      }
      if (session.revision !== input.expectedWorkerSessionRevision) {
        return this.verificationBeginFailure("stale_session_revision", attempt, lease, session);
      }
      if (
        input.verificationId.length === 0 ||
        this.verificationAuthorization(input.verificationId) ||
        this.verificationAuthorizationForAttempt(input.attemptId)
      ) {
        return this.verificationBeginFailure("verification_conflict", attempt, lease, session);
      }
      if (
        attempt.status !== "receipt_submitted" ||
        attempt.receiptId !== input.receiptId ||
        receipt.attemptId !== input.attemptId ||
        receipt.receiptHash !== input.receiptHash ||
        receipt.disposition !== "verification_pending"
      ) {
        return this.verificationBeginFailure("invalid_attempt_transition", attempt, lease, session);
      }
      if (
        lease.status !== "active" ||
        lease.attemptId !== attempt.attemptId ||
        lease.controllerId !== input.controller.controllerId ||
        lease.controllerLeaseId !== input.controller.leaseId ||
        lease.fencingToken !== input.controller.fencingToken
      ) {
        return this.verificationBeginFailure("stale_fence", attempt, lease, session);
      }
      if (parseInstant(lease.expiresAt, "expiresAt") <= parseInstant(input.now, "now")) {
        return this.verificationBeginFailure("workspace_expired", attempt, lease, session);
      }
      if (
        session.runId !== input.runId ||
        session.attemptId !== input.attemptId ||
        session.workspaceLeaseId !== input.workspaceLeaseId
      ) {
        return this.verificationBeginFailure("evidence_mismatch", attempt, lease, session);
      }
      const now = instant(input.now);
      this.db
        .prepare(
          `UPDATE attempts SET revision = revision + 1, status = 'verifying', updatedAt = ?,
           completedAt = NULL WHERE attemptId = ?`
        )
        .run(now, input.attemptId);
      const updatedAttempt = this.requireAttempt(input.attemptId);
      this.db
        .prepare(
          `INSERT INTO attempt_verification_authorizations (verificationId, runId, attemptId,
           attemptRevision, workspaceLeaseId, workspaceLeaseRevision, workerSessionId,
           workerSessionRevision, receiptId, receiptHash, controllerId, controllerLeaseId,
           fencingToken, startedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.verificationId,
          input.runId,
          input.attemptId,
          updatedAttempt.revision,
          input.workspaceLeaseId,
          lease.revision,
          input.workerSessionId,
          session.revision,
          input.receiptId,
          input.receiptHash,
          input.controller.controllerId,
          input.controller.leaseId,
          input.controller.fencingToken,
          now
        );
      const authorization = this.requireVerificationAuthorization(input.verificationId);
      const result = this.recordVerificationStartedEvent(
        input,
        updatedAttempt,
        lease,
        session,
        authorization
      );
      this.db
        .prepare(
          `INSERT INTO attempt_verification_begin_mutations
           (runId, mutationId, fingerprint, resultJson) VALUES (?, ?, ?, ?)`
        )
        .run(input.runId, input.mutationId, fingerprint, json(result));
      return result;
    });
  }

  async submitAttemptVerification(
    input: SubmitAttemptVerificationInput
  ): Promise<AttemptVerificationSubmissionResult> {
    if (!Number.isFinite(Date.parse(input.now))) return this.verificationFailure("invalid_time");
    if (input.controller.runId !== input.runId) {
      return this.verificationFailure("lease_mismatch");
    }
    const parsed = AgentEngineVerification_v2.safeParse(input.verification);
    if (!parsed.success) return this.verificationFailure("evidence_mismatch");
    const verificationJson = canonicalJSONStringify(parsed.data);
    if (Buffer.byteLength(verificationJson, "utf8") > 256 * 1_024) {
      return this.verificationFailure("evidence_mismatch");
    }
    const verificationHash = computeCanonicalHash(parsed.data);
    return this.immediateTransaction(() => {
      const coordination = this.db
        .prepare(
          `SELECT revision, controllerId, leaseId, fencingToken, expiresAt
           FROM run_coordination WHERE runId = ?`
        )
        .get(input.runId) as
        | {
            revision: number;
            controllerId: string | null;
            leaseId: string | null;
            fencingToken: number;
            expiresAt: string | null;
          }
        | undefined;
      if (!coordination?.controllerId) return this.verificationFailure("no_active_lease");
      if (coordination.fencingToken !== input.controller.fencingToken) {
        return this.verificationFailure("stale_fence");
      }
      if (
        coordination.controllerId !== input.controller.controllerId ||
        coordination.leaseId !== input.controller.leaseId
      ) {
        return this.verificationFailure("lease_mismatch");
      }
      if (coordination.revision !== input.expectedRunRevision) {
        return this.verificationFailure(
          "stale_run_revision",
          undefined,
          undefined,
          undefined,
          coordination.revision
        );
      }
      if (parseInstant(coordination.expiresAt!, "expiresAt") <= parseInstant(input.now, "now")) {
        return this.verificationFailure("lease_expired");
      }
      const fingerprint = canonicalJSONStringify({
        ...input,
        verification: parsed.data,
      } as unknown as JsonValue);
      if (
        this.db
          .prepare(
            `SELECT 1 FROM workspace_lifecycle_mutations WHERE runId = ? AND mutationId = ?
             UNION ALL SELECT 1 FROM worker_session_mutations WHERE runId = ? AND mutationId = ?
             UNION ALL SELECT 1 FROM attempt_receipt_mutations WHERE runId = ? AND mutationId = ?
             UNION ALL SELECT 1 FROM attempt_verification_begin_mutations
             WHERE runId = ? AND mutationId = ?
             UNION ALL SELECT 1 FROM worker_authority_events
             WHERE runId = ? AND mutationId = ?`
          )
          .get(
            input.runId,
            input.mutationId,
            input.runId,
            input.mutationId,
            input.runId,
            input.mutationId,
            input.runId,
            input.mutationId,
            input.runId,
            input.mutationId
          ) ||
        this.fanoutMutation(input.runId, input.mutationId)
      ) {
        return this.verificationFailure("mutation_conflict");
      }
      const prior = this.db
        .prepare(
          `SELECT fingerprint, resultJson FROM attempt_verification_mutations
           WHERE runId = ? AND mutationId = ?`
        )
        .get(input.runId, input.mutationId) as
        { fingerprint: string; resultJson: string } | undefined;
      if (prior) {
        if (prior.fingerprint !== fingerprint) {
          return this.verificationFailure("mutation_conflict");
        }
        const replay = parseVerificationMutationSuccess(prior.resultJson);
        return replay
          ? { ...replay, idempotentReplay: true }
          : this.verificationFailure("evidence_mismatch");
      }
      const hashVerification = this.attemptVerificationByHash(verificationHash);
      if (hashVerification) {
        if (
          hashVerification.verificationJson !== verificationJson ||
          hashVerification.runId !== input.runId ||
          hashVerification.attemptId !== input.attemptId ||
          hashVerification.workspaceLeaseId !== input.workspaceLeaseId ||
          hashVerification.workerSessionId !== input.workerSessionId ||
          hashVerification.receiptId !== input.receiptId
        ) {
          return this.verificationFailure("verification_conflict");
        }
        const attempt = this.requireAttempt(hashVerification.attemptId);
        const lease = this.requireLease(hashVerification.workspaceLeaseId);
        const session = this.requireWorkerSession(hashVerification.workerSessionId);
        const committed = this.committedVerificationResult(hashVerification);
        if (!committed) return this.verificationFailure("evidence_mismatch");
        const replay = this.recordVerificationEvent(
          input,
          attempt,
          lease,
          session,
          hashVerification,
          "attempt_verification_replayed"
        );
        const result = {
          recorded: true as const,
          verification: committed.verification,
          attempt: committed.attempt,
          event: replay.event,
          idempotentReplay: true,
        };
        this.storeVerificationMutation(input, fingerprint, result);
        return result;
      }
      const result = this.submitNewVerification(
        input,
        parsed.data,
        verificationJson,
        verificationHash
      );
      if (result.recorded) this.storeVerificationMutation(input, fingerprint, result);
      return result;
    });
  }

  async getAttemptVerification(verificationId: string): Promise<AttemptVerificationRecord | null> {
    return this.hasTable("attempt_verifications") ? this.attemptVerification(verificationId) : null;
  }

  async getAttemptVerificationForAttempt(
    attemptId: string
  ): Promise<AttemptVerificationRecord | null> {
    if (!this.hasTable("attempt_verifications")) return null;
    const row = this.db
      .prepare(`SELECT * FROM attempt_verifications WHERE attemptId = ?`)
      .get(attemptId) as AttemptVerificationRow | undefined;
    return row ? toAttemptVerification(row) : null;
  }

  async getAttemptVerificationByHash(
    verificationHash: string
  ): Promise<AttemptVerificationRecord | null> {
    return this.hasTable("attempt_verifications")
      ? this.attemptVerificationByHash(verificationHash)
      : null;
  }

  async listAttemptVerificationEvents(runId: string): Promise<AttemptVerificationEvent[]> {
    if (!this.hasTable("attempt_verification_events")) return [];
    const rows = this.db
      .prepare(`SELECT * FROM attempt_verification_events WHERE runId = ? ORDER BY sequence`)
      .all(runId) as AttemptVerificationEventRow[];
    return rows.map(toAttemptVerificationEvent);
  }

  async getAttemptVerificationAuthorization(
    verificationId: string
  ): Promise<AttemptVerificationAuthorizationRecord | null> {
    if (!this.hasTable("attempt_verification_authorizations")) return null;
    return this.verificationAuthorization(verificationId);
  }

  async getAttemptVerificationAuthorizationForAttempt(
    attemptId: string
  ): Promise<AttemptVerificationAuthorizationRecord | null> {
    if (!this.hasTable("attempt_verification_authorizations")) return null;
    return this.verificationAuthorizationForAttempt(attemptId);
  }

  async applyAttemptAcceptance(
    input: ApplyAttemptAcceptanceInput
  ): Promise<WorkspaceMutationResult> {
    return this.mutate(input, () => {
      const attempt = this.attempt(input.attemptId);
      const revisionFailure = this.validateAttempt(
        attempt,
        input.runId,
        input.expectedAttemptRevision
      );
      if (revisionFailure) return revisionFailure;
      const lease = this.lease(input.workspaceLeaseId);
      const session = this.workerSession(input.workerSessionId);
      const receipt = this.attemptReceipt(input.receiptId);
      const verification = this.attemptVerification(input.verificationId);
      if (!lease || !session || !receipt || !verification) {
        return this.failure("not_found", attempt!);
      }
      const envelopeBinding = this.launchEnvelopeBinding(input.attemptId);
      if (
        !envelopeBinding ||
        !validatePersistedCanonicalEnvelope(envelopeBinding, attempt!, lease) ||
        session.executionEnvelopeId !== envelopeBinding.envelopeId ||
        session.executionEnvelopeHash !== envelopeBinding.envelopeHash
      ) {
        return this.failure("evidence_mismatch", attempt!, lease);
      }
      if (lease.revision !== input.expectedWorkspaceLeaseRevision) {
        return this.failure("stale_workspace_revision", attempt!, lease);
      }
      if (
        session.revision !== input.expectedWorkerSessionRevision ||
        session.runId !== input.runId ||
        session.attemptId !== input.attemptId ||
        session.workspaceLeaseId !== input.workspaceLeaseId ||
        receipt.attemptId !== input.attemptId ||
        receipt.receiptHash !== input.receiptHash ||
        verification.attemptId !== input.attemptId ||
        verification.verificationHash !== input.verificationHash ||
        verification.receiptId !== input.receiptId ||
        verification.receiptHash !== input.receiptHash
      ) {
        return this.failure("evidence_mismatch", attempt!, lease);
      }
      if (
        attempt!.status !== "verified" ||
        attempt!.receiptId !== input.receiptId ||
        attempt!.verificationId !== input.verificationId ||
        verification.outcome !== "pass"
      ) {
        return this.failure("invalid_attempt_transition", attempt!, lease);
      }
      if (
        lease.status !== "active" ||
        lease.attemptId !== attempt!.attemptId ||
        lease.controllerId !== input.controller.controllerId ||
        lease.controllerLeaseId !== input.controller.leaseId ||
        lease.fencingToken !== input.controller.fencingToken
      ) {
        return this.failure("stale_fence", attempt!, lease);
      }
      if (parseInstant(lease.expiresAt, "expiresAt") <= parseInstant(input.now, "now")) {
        return this.failure("workspace_expired", attempt!, lease);
      }
      if (parseInstant(input.now, "now") < parseInstant(attempt!.updatedAt, "updatedAt")) {
        return this.failure("invalid_time", attempt!, lease);
      }
      const reasonCodes = verification.trustGapReasons.map((reason) => `trust_gap:${reason}`);
      const status = reasonCodes.length === 0 ? "accepted" : "rejected";
      const now = instant(input.now);
      this.db
        .prepare(
          `UPDATE attempts SET revision = revision + 1, status = ?, updatedAt = ?, completedAt = ?
           WHERE attemptId = ?`
        )
        .run(status, now, now, input.attemptId);
      return this.record(
        input,
        this.requireAttempt(input.attemptId),
        lease,
        "attempt_transitioned",
        {
          status,
          receiptId: input.receiptId,
          verificationId: input.verificationId,
          details: {
            policyId: STRICT_ATTEMPT_ACCEPTANCE_POLICY_ID,
            policyVersion: STRICT_ATTEMPT_ACCEPTANCE_POLICY_VERSION,
            decision: status,
            reasonCodes,
          },
        }
      );
    });
  }

  private submitNewVerification(
    input: SubmitAttemptVerificationInput,
    evidence: import("../../schemas/agent-work.js").AgentEngineVerification_v2,
    verificationJson: string,
    verificationHash: string
  ): AttemptVerificationSubmissionResult {
    const attempt = this.attempt(input.attemptId);
    const lease = this.lease(input.workspaceLeaseId);
    const session = this.workerSession(input.workerSessionId);
    const receipt = this.attemptReceipt(input.receiptId);
    const authorization = this.verificationAuthorization(evidence.verification_id);
    if (
      !attempt ||
      attempt.runId !== input.runId ||
      !lease ||
      !session ||
      !receipt ||
      !authorization
    ) {
      return this.verificationFailure(
        "not_found",
        attempt ?? undefined,
        lease ?? undefined,
        session ?? undefined
      );
    }
    if (attempt.revision !== input.expectedAttemptRevision) {
      return this.verificationFailure("stale_attempt_revision", attempt, lease, session);
    }
    if (lease.revision !== input.expectedWorkspaceLeaseRevision) {
      return this.verificationFailure("stale_workspace_revision", attempt, lease, session);
    }
    if (session.revision !== input.expectedWorkerSessionRevision) {
      return this.verificationFailure("stale_session_revision", attempt, lease, session);
    }
    if (
      this.attemptVerification(evidence.verification_id) ||
      this.getVerificationForAttempt(input.attemptId)
    ) {
      return this.verificationFailure("verification_conflict", attempt, lease, session);
    }
    const packetBinding = this.taskPacketBinding(input.attemptId);
    const packet = packetBinding
      ? validateCanonicalTaskPacket(packetBinding.packetJson, attempt)
      : null;
    const parsedReceipt = parseStoredReceipt(receipt);
    if (
      !packet ||
      !parsedReceipt ||
      !validVerificationAuthorization(authorization, input, attempt, lease, session, receipt) ||
      !validateAgentEngineVerificationV2PacketReferences(packet, evidence).valid ||
      !validVerificationBinding(evidence, input, attempt, lease, session, receipt) ||
      !hasRequiredTrustGaps(
        evidence,
        parsedReceipt,
        this.hasTable("worker_authority_events") &&
          Boolean(
            this.db
              .prepare(
                `SELECT 1 FROM worker_authority_events
                 WHERE runId = ? AND attemptId = ? AND workerSessionId = ?
                   AND decision = 'deviation' LIMIT 1`
              )
              .get(input.runId, input.attemptId, input.workerSessionId)
          )
      )
    ) {
      return this.verificationFailure("evidence_mismatch", attempt, lease, session);
    }
    if (
      attempt.status !== "verifying" ||
      attempt.receiptId !== receipt.receiptId ||
      receipt.attemptId !== attempt.attemptId ||
      receipt.receiptHash !== input.receiptHash ||
      receipt.disposition !== "verification_pending"
    ) {
      return this.verificationFailure("invalid_attempt_transition", attempt, lease, session);
    }
    if (
      lease.status !== "active" ||
      lease.controllerId !== input.controller.controllerId ||
      lease.controllerLeaseId !== input.controller.leaseId ||
      lease.fencingToken !== input.controller.fencingToken
    ) {
      return this.verificationFailure("stale_fence", attempt, lease, session);
    }
    if (parseInstant(lease.expiresAt, "expiresAt") <= parseInstant(input.now, "now")) {
      return this.verificationFailure("workspace_expired", attempt, lease, session);
    }
    if (
      parseInstant(evidence.started_at, "verification.started_at") <
        parseInstant(authorization.startedAt, "authorization.startedAt") ||
      parseInstant(evidence.completed_at, "verification.completed_at") >
        parseInstant(input.now, "now")
    ) {
      return this.verificationFailure("invalid_time", attempt, lease, session);
    }

    const status = verificationAttemptStatus(evidence.outcome);
    this.db
      .prepare(
        `UPDATE attempts SET revision = revision + 1, status = ?, verificationId = ?, updatedAt = ?,
         completedAt = ? WHERE attemptId = ?`
      )
      .run(
        status,
        evidence.verification_id,
        instant(input.now),
        isTerminalAttemptStatus(status) ? instant(input.now) : null,
        input.attemptId
      );
    const updatedAttempt = this.requireAttempt(input.attemptId);
    this.db
      .prepare(
        `INSERT INTO attempt_verifications (verificationId, verificationHash, verificationJson,
         runId, workItemId, workItemRevision, attemptId, packetId, packetHash, workspaceLeaseId,
         workspaceLeaseRevision, workerSessionId, workerSessionRevision, receiptId, receiptHash,
         observedBaseSha, verifiedHeadSha, verifiedPatchHash, workspaceObservationHash, outcome,
         trustGapReasonsJson, verifierId, verifierVersion, startedAt, completedAt, recordedAt,
         controllerId, controllerLeaseId, fencingToken, resultingAttemptRevision,
         resultingAttemptStatus) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        evidence.verification_id,
        verificationHash,
        verificationJson,
        input.runId,
        evidence.work_item_id,
        evidence.work_item_revision,
        input.attemptId,
        evidence.packet_id,
        evidence.packet_hash,
        input.workspaceLeaseId,
        evidence.workspace_lease_revision,
        input.workerSessionId,
        evidence.worker_session_revision,
        input.receiptId,
        input.receiptHash,
        evidence.observed_base_sha,
        evidence.verified_head_sha ?? null,
        evidence.verified_patch_hash ?? null,
        evidence.workspace_observation_hash,
        evidence.outcome,
        canonicalJSONStringify(evidence.trust_gap_reasons),
        evidence.verifier_id,
        evidence.verifier_version,
        instant(evidence.started_at),
        instant(evidence.completed_at),
        instant(input.now),
        input.controller.controllerId,
        input.controller.leaseId,
        input.controller.fencingToken,
        updatedAttempt.revision,
        status
      );
    const record = this.requireAttemptVerification(evidence.verification_id);
    return this.recordVerificationEvent(
      input,
      updatedAttempt,
      lease,
      session,
      record,
      "attempt_verification_recorded"
    );
  }

  private recordVerificationEvent(
    input: SubmitAttemptVerificationInput,
    attempt: AttemptRecord,
    lease: WorkspaceLifecycleLeaseRecord,
    session: WorkerSessionRecord,
    verification: AttemptVerificationRecord,
    type: AttemptVerificationEventType
  ): Extract<AttemptVerificationSubmissionResult, { recorded: true }> {
    const sequence = (
      this.db
        .prepare(
          `SELECT COALESCE(MAX(sequence), 0) + 1 AS value
           FROM attempt_verification_events WHERE runId = ?`
        )
        .get(input.runId) as { value: number }
    ).value;
    this.db
      .prepare(
        `INSERT INTO attempt_verification_events (runId, attemptId, verificationId,
         verificationHash, receiptId, receiptHash, mutationId, sequence, attemptRevision,
         workspaceLeaseRevision, workerSessionRevision, controllerId, controllerLeaseId,
         fencingToken, type, outcome, resultingAttemptStatus, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.runId,
        attempt.attemptId,
        verification.verificationId,
        verification.verificationHash,
        verification.receiptId,
        verification.receiptHash,
        input.mutationId,
        sequence,
        attempt.revision,
        lease.revision,
        session.revision,
        input.controller.controllerId,
        input.controller.leaseId,
        input.controller.fencingToken,
        type,
        verification.outcome,
        verification.resultingAttemptStatus,
        instant(input.now)
      );
    const event = toAttemptVerificationEvent(
      this.db
        .prepare(`SELECT * FROM attempt_verification_events WHERE runId = ? AND mutationId = ?`)
        .get(input.runId, input.mutationId) as AttemptVerificationEventRow
    );
    return {
      recorded: true,
      verification,
      attempt,
      event,
      idempotentReplay: false,
    };
  }

  private recordVerificationStartedEvent(
    input: BeginAttemptVerificationInput,
    attempt: AttemptRecord,
    lease: WorkspaceLifecycleLeaseRecord,
    session: WorkerSessionRecord,
    authorization: AttemptVerificationAuthorizationRecord
  ): Extract<AttemptVerificationBeginResult, { started: true }> {
    const sequence = (
      this.db
        .prepare(
          `SELECT COALESCE(MAX(sequence), 0) + 1 AS value
           FROM attempt_verification_events WHERE runId = ?`
        )
        .get(input.runId) as { value: number }
    ).value;
    this.db
      .prepare(
        `INSERT INTO attempt_verification_events (runId, attemptId, verificationId,
         verificationHash, receiptId, receiptHash, mutationId, sequence, attemptRevision,
         workspaceLeaseRevision, workerSessionRevision, controllerId, controllerLeaseId,
         fencingToken, type, outcome, resultingAttemptStatus, createdAt)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'attempt_verification_started',
         NULL, 'verifying', ?)`
      )
      .run(
        input.runId,
        attempt.attemptId,
        authorization.verificationId,
        authorization.receiptId,
        authorization.receiptHash,
        input.mutationId,
        sequence,
        attempt.revision,
        lease.revision,
        session.revision,
        input.controller.controllerId,
        input.controller.leaseId,
        input.controller.fencingToken,
        instant(input.now)
      );
    const event = toAttemptVerificationEvent(
      this.db
        .prepare(`SELECT * FROM attempt_verification_events WHERE runId = ? AND mutationId = ?`)
        .get(input.runId, input.mutationId) as AttemptVerificationEventRow
    );
    return {
      started: true,
      authorization,
      attempt,
      event,
      idempotentReplay: false,
    };
  }

  private storeVerificationMutation(
    input: SubmitAttemptVerificationInput,
    fingerprint: string,
    result: Extract<AttemptVerificationSubmissionResult, { recorded: true }>
  ): void {
    this.db
      .prepare(
        `INSERT INTO attempt_verification_mutations (runId, mutationId, fingerprint, resultJson)
         VALUES (?, ?, ?, ?)`
      )
      .run(
        input.runId,
        input.mutationId,
        fingerprint,
        canonicalJSONStringify(result as unknown as JsonValue)
      );
  }

  private verificationFailure(
    reason: AttemptVerificationFailureReason,
    attempt?: AttemptRecord,
    lease?: WorkspaceLifecycleLeaseRecord,
    session?: WorkerSessionRecord,
    currentRunRevision?: number
  ): AttemptVerificationSubmissionResult {
    return {
      recorded: false,
      reason,
      ...(attempt ? { currentAttemptRevision: attempt.revision } : {}),
      ...(lease ? { currentWorkspaceLeaseRevision: lease.revision } : {}),
      ...(session ? { currentSessionRevision: session.revision } : {}),
      ...(currentRunRevision !== undefined ? { currentRunRevision } : {}),
    };
  }

  private verificationBeginFailure(
    reason: AttemptVerificationFailureReason,
    attempt?: AttemptRecord,
    lease?: WorkspaceLifecycleLeaseRecord,
    session?: WorkerSessionRecord,
    currentRunRevision?: number
  ): AttemptVerificationBeginResult {
    return {
      started: false,
      reason,
      ...(attempt ? { currentAttemptRevision: attempt.revision } : {}),
      ...(lease ? { currentWorkspaceLeaseRevision: lease.revision } : {}),
      ...(session ? { currentSessionRevision: session.revision } : {}),
      ...(currentRunRevision !== undefined ? { currentRunRevision } : {}),
    };
  }

  private submitNewReceipt(
    input: SubmitAttemptReceiptInput,
    claim: import("../../schemas/agent-work.js").AgentTaskReceipt_v2,
    receiptJson: string,
    receiptHash: string
  ): AttemptReceiptSubmissionResult {
    const attempt = this.attempt(input.attemptId);
    const lease = this.lease(input.workspaceLeaseId);
    const session = this.workerSession(input.workerSessionId);
    if (!attempt || attempt.runId !== input.runId || !lease || !session) {
      return this.receiptFailure(
        "not_found",
        attempt ?? undefined,
        lease ?? undefined,
        session ?? undefined
      );
    }
    if (attempt.revision !== input.expectedAttemptRevision) {
      return this.receiptFailure("stale_attempt_revision", attempt, lease, session);
    }
    if (lease.revision !== input.expectedWorkspaceLeaseRevision) {
      return this.receiptFailure("stale_workspace_revision", attempt, lease, session);
    }
    if (session.revision !== input.expectedWorkerSessionRevision) {
      return this.receiptFailure("stale_session_revision", attempt, lease, session);
    }
    if (this.attemptReceipt(claim.receipt_id) || this.getReceiptForAttempt(input.attemptId)) {
      return this.receiptFailure("receipt_conflict", attempt, lease, session);
    }
    const envelopeBinding = this.launchEnvelopeBinding(input.attemptId);
    if (
      !envelopeBinding ||
      !validatePersistedCanonicalEnvelope(envelopeBinding, attempt, lease) ||
      session.executionEnvelopeId !== envelopeBinding.envelopeId ||
      session.executionEnvelopeHash !== envelopeBinding.envelopeHash
    ) {
      return this.receiptFailure("evidence_mismatch", attempt, lease, session);
    }
    const packetBinding = this.taskPacketBinding(input.attemptId);
    const packet = packetBinding
      ? validateCanonicalTaskPacket(packetBinding.packetJson, attempt)
      : null;
    if (!packet || !validateAgentTaskReceiptV2PacketReferences(packet, claim).valid) {
      return this.receiptFailure("evidence_mismatch", attempt, lease, session);
    }
    if (!validReceiptBinding(claim, input, attempt, lease, session)) {
      return this.receiptFailure("evidence_mismatch", attempt, lease, session);
    }
    if (!isTerminalWorkerSession(session.status) || !session.endedAt) {
      return this.receiptFailure("worker_session_not_active", attempt, lease, session);
    }
    const active =
      attempt.status === "running" &&
      session.status === "completed" &&
      lease.status === "active" &&
      lease.controllerId === input.controller.controllerId &&
      lease.controllerLeaseId === input.controller.leaseId &&
      lease.fencingToken === input.controller.fencingToken &&
      parseInstant(lease.expiresAt, "expiresAt") > parseInstant(input.now, "now");
    if (!active && attempt.status !== "running" && !isTerminalAttemptStatus(attempt.status)) {
      return this.receiptFailure("invalid_attempt_transition", attempt, lease, session);
    }
    const disposition = active ? "verification_pending" : "retained_late";
    if (active) {
      const status: AttemptRecord["status"] =
        claim.outcome === "completed" ? "receipt_submitted" : claim.outcome;
      this.db
        .prepare(
          `UPDATE attempts SET revision = revision + 1, status = ?, receiptId = ?, updatedAt = ?,
           completedAt = ? WHERE attemptId = ?`
        )
        .run(
          status,
          claim.receipt_id,
          instant(input.now),
          status === "receipt_submitted" ? null : instant(input.now),
          input.attemptId
        );
    }
    const updatedAttempt = this.requireAttempt(input.attemptId);
    this.db
      .prepare(
        `INSERT INTO attempt_receipts (receiptId, receiptHash, receiptJson, runId, workItemId,
         workItemRevision, attemptId, packetId, packetHash, workspaceLeaseId,
         workspaceLeaseRevision, workerSessionId, workerSessionRevision, workerRuntime,
         observedBaseSha, finalHeadSha, patchHash, outcome, disposition, submittedAt, recordedAt,
         controllerId, controllerLeaseId, fencingToken, resultingAttemptRevision,
         resultingAttemptStatus) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        claim.receipt_id,
        receiptHash,
        receiptJson,
        input.runId,
        claim.work_item_id,
        claim.work_item_revision,
        input.attemptId,
        claim.packet_id,
        claim.packet_hash,
        input.workspaceLeaseId,
        claim.workspace_lease_revision,
        input.workerSessionId,
        session.revision,
        claim.worker_runtime,
        claim.observed_base_sha,
        claim.final_head_sha ?? null,
        claim.patch_hash ?? null,
        claim.outcome,
        disposition,
        instant(claim.submitted_at),
        instant(input.now),
        input.controller.controllerId,
        input.controller.leaseId,
        input.controller.fencingToken,
        updatedAttempt.revision,
        updatedAttempt.status
      );
    const record = this.requireAttemptReceipt(claim.receipt_id);
    return this.recordReceiptEvent(
      input,
      updatedAttempt,
      lease,
      session,
      record,
      active ? "attempt_receipt_submitted" : "attempt_receipt_retained_late"
    );
  }

  private recordReceiptEvent(
    input: SubmitAttemptReceiptInput,
    attempt: AttemptRecord,
    lease: WorkspaceLifecycleLeaseRecord,
    session: WorkerSessionRecord,
    receipt: AttemptReceiptRecord,
    type: AttemptReceiptEventType
  ): Extract<AttemptReceiptSubmissionResult, { submitted: true }> {
    const sequence = (
      this.db
        .prepare(
          `SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM attempt_receipt_events WHERE runId = ?`
        )
        .get(input.runId) as { value: number }
    ).value;
    this.db
      .prepare(
        `INSERT INTO attempt_receipt_events (runId, attemptId, receiptId, receiptHash, mutationId,
         sequence, attemptRevision, workspaceLeaseRevision, workerSessionRevision, controllerId,
         controllerLeaseId, fencingToken, type, disposition, outcome, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.runId,
        attempt.attemptId,
        receipt.receiptId,
        receipt.receiptHash,
        input.mutationId,
        sequence,
        attempt.revision,
        lease.revision,
        session.revision,
        input.controller.controllerId,
        input.controller.leaseId,
        input.controller.fencingToken,
        type,
        receipt.disposition,
        receipt.outcome,
        instant(input.now)
      );
    const event = toAttemptReceiptEvent(
      this.db
        .prepare(`SELECT * FROM attempt_receipt_events WHERE runId = ? AND mutationId = ?`)
        .get(input.runId, input.mutationId) as AttemptReceiptEventRow
    );
    return {
      submitted: true,
      receipt,
      attempt,
      event,
      idempotentReplay: false,
    };
  }

  private storeReceiptMutation(
    input: SubmitAttemptReceiptInput,
    fingerprint: string,
    result: Extract<AttemptReceiptSubmissionResult, { submitted: true }>
  ): void {
    this.db
      .prepare(
        `INSERT INTO attempt_receipt_mutations (runId, mutationId, fingerprint, resultJson)
         VALUES (?, ?, ?, ?)`
      )
      .run(input.runId, input.mutationId, fingerprint, json(result));
  }

  private receiptFailure(
    reason: AttemptReceiptFailureReason,
    attempt?: AttemptRecord,
    lease?: WorkspaceLifecycleLeaseRecord,
    session?: WorkerSessionRecord,
    currentRunRevision?: number
  ): AttemptReceiptSubmissionResult {
    return {
      submitted: false,
      reason,
      ...(attempt ? { currentAttemptRevision: attempt.revision } : {}),
      ...(lease ? { currentWorkspaceLeaseRevision: lease.revision } : {}),
      ...(session ? { currentSessionRevision: session.revision } : {}),
      ...(currentRunRevision !== undefined ? { currentRunRevision } : {}),
    };
  }

  private committedReceiptResult(
    receipt: AttemptReceiptRecord
  ): Extract<AttemptReceiptSubmissionResult, { submitted: true }> | null {
    const row = this.db
      .prepare(
        `SELECT mutation.resultJson FROM attempt_receipt_mutations AS mutation
         JOIN attempt_receipt_events AS event
           ON event.runId = mutation.runId AND event.mutationId = mutation.mutationId
         WHERE event.runId = ? AND event.receiptId = ?
           AND event.type IN (${sqlEnumValues(INITIAL_ATTEMPT_RECEIPT_EVENT_TYPES)})
         LIMIT 1`
      )
      .get(receipt.runId, receipt.receiptId) as { resultJson: string } | undefined;
    return row ? parseReceiptMutationSuccess(row.resultJson) : null;
  }

  private committedVerificationResult(
    verification: AttemptVerificationRecord
  ): Extract<AttemptVerificationSubmissionResult, { recorded: true }> | null {
    const row = this.db
      .prepare(
        `SELECT mutation.resultJson FROM attempt_verification_mutations AS mutation
         JOIN attempt_verification_events AS event
           ON event.runId = mutation.runId AND event.mutationId = mutation.mutationId
         WHERE event.runId = ? AND event.verificationId = ?
           AND event.type = 'attempt_verification_recorded' LIMIT 1`
      )
      .get(verification.runId, verification.verificationId) as { resultJson: string } | undefined;
    return row ? parseVerificationMutationSuccess(row.resultJson) : null;
  }

  private mutateWorker(
    input: AttachWorkerSessionInput | HeartbeatWorkerSessionInput | EndWorkerSessionInput,
    action: () => WorkerSessionMutationResult
  ): WorkerSessionMutationResult {
    if (!Number.isFinite(Date.parse(input.now))) return this.workerFailure("invalid_time");
    if (input.controller.runId !== input.runId) return this.workerFailure("lease_mismatch");
    return this.immediateTransaction(() => {
      const coordination = this.db
        .prepare(
          `SELECT revision, controllerId, leaseId, fencingToken, expiresAt
           FROM run_coordination WHERE runId = ?`
        )
        .get(input.runId) as
        | {
            revision: number;
            controllerId: string | null;
            leaseId: string | null;
            fencingToken: number;
            expiresAt: string | null;
          }
        | undefined;
      if (!coordination?.controllerId) return this.workerFailure("no_active_lease");
      if (coordination.fencingToken !== input.controller.fencingToken) {
        return this.workerFailure("stale_fence");
      }
      if (
        coordination.controllerId !== input.controller.controllerId ||
        coordination.leaseId !== input.controller.leaseId
      ) {
        return this.workerFailure("lease_mismatch");
      }
      if (coordination.revision !== input.expectedRunRevision) {
        return this.workerFailure(
          "stale_run_revision",
          undefined,
          undefined,
          undefined,
          coordination.revision
        );
      }
      if (parseInstant(coordination.expiresAt!, "expiresAt") <= parseInstant(input.now, "now")) {
        return this.workerFailure("lease_expired");
      }

      const fingerprint = canonicalJSONStringify(input as unknown as JsonValue);
      const workspaceClaim = this.db
        .prepare(
          `SELECT 1 FROM workspace_lifecycle_mutations WHERE runId = ? AND mutationId = ?
           UNION ALL SELECT 1 FROM attempt_receipt_mutations WHERE runId = ? AND mutationId = ?
           UNION ALL SELECT 1 FROM attempt_verification_mutations
           WHERE runId = ? AND mutationId = ?
           UNION ALL SELECT 1 FROM attempt_verification_begin_mutations
           WHERE runId = ? AND mutationId = ?
           UNION ALL SELECT 1 FROM worker_authority_events
           WHERE runId = ? AND mutationId = ?`
        )
        .get(
          input.runId,
          input.mutationId,
          input.runId,
          input.mutationId,
          input.runId,
          input.mutationId,
          input.runId,
          input.mutationId,
          input.runId,
          input.mutationId
        );
      if (workspaceClaim || this.fanoutMutation(input.runId, input.mutationId)) {
        return this.workerFailure("mutation_conflict");
      }
      const prior = this.db
        .prepare(
          `SELECT fingerprint, resultJson FROM worker_session_mutations
           WHERE runId = ? AND mutationId = ?`
        )
        .get(input.runId, input.mutationId) as
        { fingerprint: string; resultJson: string } | undefined;
      if (prior) {
        if (prior.fingerprint !== fingerprint) return this.workerFailure("mutation_conflict");
        const replay = parseWorkerMutationSuccess(prior.resultJson);
        return replay
          ? { ...replay, idempotentReplay: true }
          : this.workerFailure("evidence_mismatch");
      }
      const result = action();
      if (result.updated) {
        this.db
          .prepare(
            `INSERT INTO worker_session_mutations (runId, mutationId, fingerprint, resultJson)
             VALUES (?, ?, ?, ?)`
          )
          .run(input.runId, input.mutationId, fingerprint, json(result));
      }
      return result;
    });
  }

  private validateWorkerBinding(
    input: AttachWorkerSessionInput | HeartbeatWorkerSessionInput | EndWorkerSessionInput
  ):
    | { valid: true; attempt: AttemptRecord; lease: WorkspaceLifecycleLeaseRecord }
    | { valid: false; failure: WorkerSessionMutationResult } {
    const attempt = this.attempt(input.attemptId);
    if (!attempt || attempt.runId !== input.runId) {
      return { valid: false, failure: this.workerFailure("not_found") };
    }
    const lease = this.lease(input.workspaceLeaseId);
    if (!lease || lease.attemptId !== attempt.attemptId) {
      return { valid: false, failure: this.workerFailure("not_found", attempt) };
    }
    if (attempt.revision !== input.expectedAttemptRevision) {
      return {
        valid: false,
        failure: this.workerFailure("stale_attempt_revision", attempt, lease),
      };
    }
    if (lease.revision !== input.expectedWorkspaceLeaseRevision) {
      return {
        valid: false,
        failure: this.workerFailure("stale_workspace_revision", attempt, lease),
      };
    }
    if (lease.status !== "active") {
      return { valid: false, failure: this.workerFailure("workspace_not_active", attempt, lease) };
    }
    if (
      lease.controllerId !== input.controller.controllerId ||
      lease.controllerLeaseId !== input.controller.leaseId ||
      lease.fencingToken !== input.controller.fencingToken
    ) {
      return { valid: false, failure: this.workerFailure("stale_fence", attempt, lease) };
    }
    if (parseInstant(lease.expiresAt, "expiresAt") <= parseInstant(input.now, "now")) {
      return { valid: false, failure: this.workerFailure("workspace_expired", attempt, lease) };
    }
    if (
      parseInstant(input.now, "now") < parseInstant(attempt.updatedAt, "attempt.updatedAt") ||
      parseInstant(input.now, "now") < parseInstant(lease.heartbeatAt, "lease.heartbeatAt")
    ) {
      return { valid: false, failure: this.workerFailure("invalid_time", attempt, lease) };
    }
    return { valid: true, attempt, lease };
  }

  private validateSession(
    session: WorkerSessionRecord | null,
    input: HeartbeatWorkerSessionInput | EndWorkerSessionInput,
    attempt: AttemptRecord,
    lease: WorkspaceLifecycleLeaseRecord
  ): WorkerSessionMutationResult | null {
    if (attempt.status !== "running") {
      return this.workerFailure("invalid_attempt_transition", attempt, lease, session ?? undefined);
    }
    if (
      !session ||
      session.runId !== input.runId ||
      session.attemptId !== input.attemptId ||
      session.workspaceLeaseId !== input.workspaceLeaseId
    ) {
      return this.workerFailure("not_found", attempt, lease);
    }
    if (session.revision !== input.expectedSessionRevision) {
      return this.workerFailure("stale_session_revision", attempt, lease, session);
    }
    if (isTerminalWorkerSession(session.status)) {
      return this.workerFailure("worker_session_not_active", attempt, lease, session);
    }
    return null;
  }

  private recordWorker(
    input: AttachWorkerSessionInput | HeartbeatWorkerSessionInput | EndWorkerSessionInput,
    attempt: AttemptRecord,
    lease: WorkspaceLifecycleLeaseRecord,
    session: WorkerSessionRecord,
    type: WorkerSessionEventType,
    payload: JsonRecord
  ): WorkerSessionMutationResult {
    const sequence = (
      this.db
        .prepare(
          `SELECT COALESCE(MAX(sequence), 0) + 1 AS value
           FROM worker_session_events WHERE runId = ?`
        )
        .get(input.runId) as { value: number }
    ).value;
    this.db
      .prepare(
        `INSERT INTO worker_session_events (runId, attemptId, sessionId, mutationId, sequence,
         attemptRevision, workspaceLeaseRevision, sessionRevision, controllerId,
         controllerLeaseId, fencingToken, type, payloadJson, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.runId,
        attempt.attemptId,
        session.sessionId,
        input.mutationId,
        sequence,
        attempt.revision,
        lease.revision,
        session.revision,
        input.controller.controllerId,
        input.controller.leaseId,
        input.controller.fencingToken,
        type,
        json(payload),
        instant(input.now)
      );
    const event = toWorkerEvent(
      this.db
        .prepare(`SELECT * FROM worker_session_events WHERE runId = ? AND mutationId = ?`)
        .get(input.runId, input.mutationId) as WorkerEventRow
    );
    return { updated: true, attempt, workerSession: session, event, idempotentReplay: false };
  }

  private workerFailure(
    reason: WorkerSessionMutationFailureReason,
    attempt?: AttemptRecord,
    lease?: WorkspaceLifecycleLeaseRecord,
    session?: WorkerSessionRecord,
    currentRunRevision?: number
  ): WorkerSessionMutationResult {
    return {
      updated: false,
      reason,
      ...(attempt ? { currentAttemptRevision: attempt.revision } : {}),
      ...(lease ? { currentWorkspaceLeaseRevision: lease.revision } : {}),
      ...(session ? { currentSessionRevision: session.revision } : {}),
      ...(currentRunRevision !== undefined ? { currentRunRevision } : {}),
    };
  }

  private authorityFailure(
    reason: WorkerSessionMutationFailureReason,
    attempt?: AttemptRecord,
    lease?: WorkspaceLifecycleLeaseRecord,
    session?: WorkerSessionRecord,
    currentRunRevision?: number
  ): WorkerAuthorityDecisionResult {
    return {
      recorded: false,
      reason,
      ...(attempt ? { currentAttemptRevision: attempt.revision } : {}),
      ...(lease ? { currentWorkspaceLeaseRevision: lease.revision } : {}),
      ...(session ? { currentSessionRevision: session.revision } : {}),
      ...(currentRunRevision !== undefined ? { currentRunRevision } : {}),
    };
  }

  private mutate(
    input: MutationInput,
    action: () => WorkspaceMutationResult
  ): WorkspaceMutationResult {
    if (!Number.isFinite(Date.parse(input.now))) return this.failure("invalid_time");
    if (input.controller.runId !== input.runId) return this.failure("lease_mismatch");
    return this.immediateTransaction(() => {
      const coordination = this.db
        .prepare(
          `SELECT revision, controllerId, leaseId, fencingToken, expiresAt FROM run_coordination WHERE runId = ?`
        )
        .get(input.runId) as
        | {
            revision: number;
            controllerId: string | null;
            leaseId: string | null;
            fencingToken: number;
            expiresAt: string | null;
          }
        | undefined;
      if (!coordination?.controllerId) return this.failure("no_active_lease");
      if (coordination.fencingToken !== input.controller.fencingToken)
        return this.failure("stale_fence");
      if (
        coordination.controllerId !== input.controller.controllerId ||
        coordination.leaseId !== input.controller.leaseId
      )
        return this.failure("lease_mismatch");
      if (coordination.revision !== input.expectedRunRevision)
        return this.failure("stale_run_revision", undefined, undefined, coordination.revision);
      if (parseInstant(coordination.expiresAt!, "expiresAt") <= parseInstant(input.now, "now"))
        return this.failure("lease_expired");

      const fingerprint = canonicalJSONStringify(input as unknown as JsonValue);
      const workerClaim = this.db
        .prepare(
          `SELECT 1 FROM worker_session_mutations WHERE runId = ? AND mutationId = ?
           UNION ALL SELECT 1 FROM attempt_receipt_mutations WHERE runId = ? AND mutationId = ?
           UNION ALL SELECT 1 FROM attempt_verification_mutations
           WHERE runId = ? AND mutationId = ?
           UNION ALL SELECT 1 FROM attempt_verification_begin_mutations
           WHERE runId = ? AND mutationId = ?
           UNION ALL SELECT 1 FROM worker_authority_events
           WHERE runId = ? AND mutationId = ?`
        )
        .get(
          input.runId,
          input.mutationId,
          input.runId,
          input.mutationId,
          input.runId,
          input.mutationId,
          input.runId,
          input.mutationId,
          input.runId,
          input.mutationId
        );
      if (workerClaim || this.fanoutMutation(input.runId, input.mutationId)) {
        return this.failure("mutation_conflict");
      }
      const prior = this.db
        .prepare(
          `SELECT fingerprint, resultJson FROM workspace_lifecycle_mutations WHERE runId = ? AND mutationId = ?`
        )
        .get(input.runId, input.mutationId) as
        { fingerprint: string; resultJson: string } | undefined;
      if (prior) {
        if (prior.fingerprint !== fingerprint) return this.failure("mutation_conflict");
        const replay = parseWorkspaceMutationSuccess(prior.resultJson);
        return replay ? { ...replay, idempotentReplay: true } : this.failure("evidence_mismatch");
      }
      const result = action();
      if (result.updated) {
        this.db
          .prepare(
            `INSERT INTO workspace_lifecycle_mutations (runId, mutationId, fingerprint, resultJson) VALUES (?, ?, ?, ?)`
          )
          .run(input.runId, input.mutationId, fingerprint, json(result));
      }
      return result;
    });
  }

  private mutateWorkspace(
    input:
      | HeartbeatWorkspaceInput
      | ReleaseWorkspaceInput
      | ReconcileWorkspaceInput
      | QuarantineWorkspaceInput,
    allowFenceTakeover: boolean,
    action: (
      attempt: AttemptRecord,
      lease: WorkspaceLifecycleLeaseRecord
    ) => WorkspaceMutationResult
  ): WorkspaceMutationResult {
    return this.mutate(input, () => {
      const attempt = this.attempt(input.attemptId);
      const failure = this.validateAttempt(attempt, input.runId, input.expectedAttemptRevision);
      if (failure) return failure;
      const lease = this.lease(input.workspaceLeaseId);
      if (!lease || lease.attemptId !== attempt!.attemptId)
        return this.failure("not_found", attempt!);
      if (lease.revision !== input.expectedWorkspaceLeaseRevision)
        return this.failure("stale_workspace_revision", attempt!, lease);
      if (lease.status !== "active" && lease.status !== "reserved")
        return this.failure("workspace_not_active", attempt!, lease);
      if (
        input.controller.fencingToken !== lease.fencingToken ||
        input.controller.controllerId !== lease.controllerId ||
        input.controller.leaseId !== lease.controllerLeaseId
      ) {
        if (!allowFenceTakeover) return this.failure("stale_fence", attempt!, lease);
      }
      if (
        parseInstant(input.now, "now") < parseInstant(attempt!.updatedAt, "attempt.updatedAt") ||
        parseInstant(input.now, "now") < parseInstant(lease.heartbeatAt, "lease.heartbeatAt")
      )
        return this.failure("invalid_time", attempt!, lease);
      return action(attempt!, lease);
    });
  }

  private validateAttempt(
    attempt: AttemptRecord | null,
    runId: string,
    revision: number
  ): WorkspaceMutationResult | null {
    if (!attempt || attempt.runId !== runId) return this.failure("not_found");
    if (attempt.revision !== revision) return this.failure("stale_attempt_revision", attempt);
    return null;
  }

  private finish(
    input: MutationInput,
    attempt: AttemptRecord,
    lease: WorkspaceLifecycleLeaseRecord,
    status: FinishedWorkspaceLeaseStatus,
    disposition: WorkspaceCleanupDisposition,
    type: WorkspaceLifecycleEventType
  ): WorkspaceMutationResult {
    const now = instant(input.now);
    this.bumpAttempt(attempt.attemptId, now);
    const observation = "observation" in input ? input.observation : undefined;
    this.db
      .prepare(
        `UPDATE workspace_leases SET revision = revision + 1, status = ?, cleanupDisposition = ?,
         releasedAt = ?, lastObservationJson = COALESCE(?, lastObservationJson) WHERE leaseId = ?`
      )
      .run(status, disposition, now, observation ? json(observation) : null, lease.leaseId);
    return this.record(
      input,
      this.requireAttempt(attempt.attemptId),
      this.requireLease(lease.leaseId),
      type,
      { action: status, disposition }
    );
  }

  private quarantine(
    input: MutationInput,
    attempt: AttemptRecord,
    lease: WorkspaceLifecycleLeaseRecord,
    reason: string,
    observation: WorkspaceObservation
  ): WorkspaceMutationResult {
    const now = instant(input.now);
    this.db
      .prepare(
        `UPDATE attempts SET revision = revision + 1, status = 'quarantined', updatedAt = ?,
         completedAt = ? WHERE attemptId = ?`
      )
      .run(now, now, attempt.attemptId);
    this.db
      .prepare(
        `UPDATE workspace_leases SET revision = revision + 1, status = 'quarantined',
         cleanupDisposition = 'preserved', releasedAt = ?, lastObservationJson = ? WHERE leaseId = ?`
      )
      .run(now, json(observation), lease.leaseId);
    return this.record(
      input,
      this.requireAttempt(attempt.attemptId),
      this.requireLease(lease.leaseId),
      "workspace_quarantined",
      { reason }
    );
  }

  private record(
    input: MutationInput,
    attempt: AttemptRecord,
    lease: WorkspaceLifecycleLeaseRecord | null,
    type: WorkspaceLifecycleEventType,
    payload: JsonRecord
  ): WorkspaceMutationResult {
    const sequence = (
      this.db
        .prepare(
          `SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM workspace_lifecycle_events WHERE runId = ?`
        )
        .get(input.runId) as { value: number }
    ).value;
    this.db
      .prepare(
        `INSERT INTO workspace_lifecycle_events (runId, attemptId, mutationId, sequence,
         attemptRevision, workspaceLeaseRevision, controllerId, controllerLeaseId,
         fencingToken, type, payloadJson, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.runId,
        attempt.attemptId,
        input.mutationId,
        sequence,
        attempt.revision,
        lease?.revision ?? null,
        input.controller.controllerId,
        input.controller.leaseId,
        input.controller.fencingToken,
        type,
        json(payload),
        instant(input.now)
      );
    const event = toEvent(
      this.db
        .prepare(`SELECT * FROM workspace_lifecycle_events WHERE runId = ? AND mutationId = ?`)
        .get(input.runId, input.mutationId) as EventRow
    );
    return { updated: true, attempt, workspaceLease: lease, event, idempotentReplay: false };
  }

  private failure(
    reason: WorkspaceMutationFailureReason,
    attempt?: AttemptRecord,
    lease?: WorkspaceLifecycleLeaseRecord,
    currentRunRevision?: number
  ): WorkspaceMutationResult {
    return {
      updated: false,
      reason,
      ...(attempt ? { currentAttemptRevision: attempt.revision } : {}),
      ...(lease ? { currentWorkspaceLeaseRevision: lease.revision } : {}),
      ...(currentRunRevision !== undefined ? { currentRunRevision } : {}),
    };
  }

  private attempt(id: string): AttemptRecord | null {
    const row = this.db.prepare(`SELECT * FROM attempts WHERE attemptId = ?`).get(id) as
      AttemptRow | undefined;
    if (!row) return null;
    const status = AttemptStatusSchema.safeParse(row.status);
    return status.success ? { ...row, status: status.data } : null;
  }

  private requireAttempt(id: string): AttemptRecord {
    const value = this.attempt(id);
    if (!value) throw new Error(`Attempt '${id}' disappeared`);
    return value;
  }

  private lease(id: string): WorkspaceLifecycleLeaseRecord | null {
    const row = this.db.prepare(`SELECT * FROM workspace_leases WHERE leaseId = ?`).get(id) as
      LeaseRow | undefined;
    if (!row) return null;
    const status = WorkspaceLifecycleLeaseStatusSchema.safeParse(row.status);
    const cleanupDisposition =
      row.cleanupDisposition === null
        ? null
        : WorkspaceCleanupDispositionSchema.safeParse(row.cleanupDisposition);
    if (!status.success || (cleanupDisposition && !cleanupDisposition.success)) return null;
    let lastObservation: WorkspaceObservation | undefined;
    if (row.lastObservationJson !== null) {
      try {
        const parsed = WorkspaceObservationSchema.safeParse(JSON.parse(row.lastObservationJson));
        if (!parsed.success) return null;
        lastObservation = parsed.data;
      } catch {
        return null;
      }
    }
    return {
      leaseId: row.leaseId,
      runId: row.runId,
      runRevision: row.runRevision,
      workItemId: row.workItemId,
      workItemRevision: row.workItemRevision,
      packetId: row.packetId,
      packetHash: row.packetHash,
      attemptId: row.attemptId,
      revision: row.revision,
      controllerId: row.controllerId,
      controllerLeaseId: row.controllerLeaseId,
      fencingToken: row.fencingToken,
      repositoryId: row.repositoryId,
      hostId: row.hostId,
      gitRuntime: row.gitRuntime,
      projectRoot: row.projectRoot,
      branch: row.branch,
      worktreePath: row.worktreePath,
      baseSha: row.baseSha,
      status: status.data,
      acquiredAt: row.acquiredAt,
      heartbeatAt: row.heartbeatAt,
      expiresAt: row.expiresAt,
      ...(row.releasedAt ? { releasedAt: row.releasedAt } : {}),
      ...(cleanupDisposition?.success ? { cleanupDisposition: cleanupDisposition.data } : {}),
      ...(lastObservation ? { lastObservation } : {}),
    };
  }

  private requireLease(id: string): WorkspaceLifecycleLeaseRecord {
    const value = this.lease(id);
    if (!value) throw new Error(`Workspace lease '${id}' disappeared`);
    return value;
  }

  private workerSession(id: string): WorkerSessionRecord | null {
    const row = this.db.prepare(`SELECT * FROM worker_sessions WHERE sessionId = ?`).get(id) as
      WorkerSessionRow | undefined;
    return row ? toWorkerSession(row) : null;
  }

  private launchEnvelopeBinding(attemptId: string): LaunchEnvelopeBindingRecord | null {
    return (
      (this.db
        .prepare(`SELECT * FROM launch_envelope_bindings WHERE attemptId = ?`)
        .get(attemptId) as LaunchEnvelopeBindingRecord | undefined) ?? null
    );
  }

  private taskPacketBinding(attemptId: string): TaskPacketBindingRecord | null {
    return (
      (this.db.prepare(`SELECT * FROM task_packet_bindings WHERE attemptId = ?`).get(attemptId) as
        TaskPacketBindingRecord | undefined) ?? null
    );
  }

  private attemptReceipt(receiptId: string): AttemptReceiptRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM attempt_receipts WHERE receiptId = ?`)
      .get(receiptId) as AttemptReceiptRow | undefined;
    return row ? toAttemptReceipt(row) : null;
  }

  private requireAttemptReceipt(receiptId: string): AttemptReceiptRecord {
    const receipt = this.attemptReceipt(receiptId);
    if (!receipt) throw new Error(`Attempt receipt '${receiptId}' disappeared`);
    return receipt;
  }

  private attemptReceiptByHash(receiptHash: string): AttemptReceiptRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM attempt_receipts WHERE receiptHash = ?`)
      .get(receiptHash) as AttemptReceiptRow | undefined;
    return row ? toAttemptReceipt(row) : null;
  }

  private getReceiptForAttempt(attemptId: string): AttemptReceiptRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM attempt_receipts WHERE attemptId = ?`)
      .get(attemptId) as AttemptReceiptRow | undefined;
    return row ? toAttemptReceipt(row) : null;
  }

  private attemptVerification(verificationId: string): AttemptVerificationRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM attempt_verifications WHERE verificationId = ?`)
      .get(verificationId) as AttemptVerificationRow | undefined;
    return row ? toAttemptVerification(row) : null;
  }

  private verificationAuthorization(
    verificationId: string
  ): AttemptVerificationAuthorizationRecord | null {
    return (
      (this.db
        .prepare(`SELECT * FROM attempt_verification_authorizations WHERE verificationId = ?`)
        .get(verificationId) as AttemptVerificationAuthorizationRecord | undefined) ?? null
    );
  }

  private requireVerificationAuthorization(
    verificationId: string
  ): AttemptVerificationAuthorizationRecord {
    const authorization = this.verificationAuthorization(verificationId);
    if (!authorization) {
      throw new Error(`Attempt verification authorization '${verificationId}' disappeared`);
    }
    return authorization;
  }

  private verificationAuthorizationForAttempt(
    attemptId: string
  ): AttemptVerificationAuthorizationRecord | null {
    return (
      (this.db
        .prepare(`SELECT * FROM attempt_verification_authorizations WHERE attemptId = ?`)
        .get(attemptId) as AttemptVerificationAuthorizationRecord | undefined) ?? null
    );
  }

  private requireAttemptVerification(verificationId: string): AttemptVerificationRecord {
    const verification = this.attemptVerification(verificationId);
    if (!verification) throw new Error(`Attempt verification '${verificationId}' disappeared`);
    return verification;
  }

  private attemptVerificationByHash(verificationHash: string): AttemptVerificationRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM attempt_verifications WHERE verificationHash = ?`)
      .get(verificationHash) as AttemptVerificationRow | undefined;
    return row ? toAttemptVerification(row) : null;
  }

  private getVerificationForAttempt(attemptId: string): AttemptVerificationRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM attempt_verifications WHERE attemptId = ?`)
      .get(attemptId) as AttemptVerificationRow | undefined;
    return row ? toAttemptVerification(row) : null;
  }

  private requireLaunchEnvelopeBinding(attemptId: string): LaunchEnvelopeBindingRecord {
    const binding = this.launchEnvelopeBinding(attemptId);
    if (!binding) throw new Error(`Launch envelope binding for Attempt '${attemptId}' disappeared`);
    return binding;
  }

  private hasTable(name: string): boolean {
    return Boolean(
      this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name)
    );
  }

  private requireWorkerSession(id: string): WorkerSessionRecord {
    const session = this.workerSession(id);
    if (!session) throw new Error(`Worker session '${id}' disappeared`);
    return session;
  }

  private workerSessionForAttempt(
    attemptId: string,
    nonterminalOnly: boolean
  ): WorkerSessionRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM worker_sessions WHERE attemptId = ?
         ${nonterminalOnly ? `AND status IN (${sqlEnumValues(NONTERMINAL_WORKER_SESSION_STATUSES)})` : ""}
         ORDER BY startedAt DESC, sessionId DESC LIMIT 1`
      )
      .get(attemptId) as WorkerSessionRow | undefined;
    return row ? toWorkerSession(row) : null;
  }

  private workerSessionForNativeIdentity(
    hostId: string,
    backend: WorkerSessionRecord["backend"],
    workerId: string
  ): WorkerSessionRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM worker_sessions WHERE hostId = ? AND backend = ? AND workerId = ?
         AND status IN (${sqlEnumValues(NONTERMINAL_WORKER_SESSION_STATUSES)}) LIMIT 1`
      )
      .get(hostId, backend, workerId) as WorkerSessionRow | undefined;
    return row ? toWorkerSession(row) : null;
  }

  private bumpAttempt(id: string, now: string): void {
    this.db
      .prepare(`UPDATE attempts SET revision = revision + 1, updatedAt = ? WHERE attemptId = ?`)
      .run(now, id);
  }

  private withFanoutAuthority<T>(
    input: {
      runId: string;
      expectedRunRevision: number;
      controller: import("../coordination-store.js").ControllerLeaseCredential;
      now: string;
    },
    failure: (reason: WorkspaceMutationFailureReason, currentRunRevision?: number) => T,
    action: () => T
  ): T {
    if (!Number.isFinite(Date.parse(input.now))) return failure("invalid_time");
    if (input.controller.runId !== input.runId) return failure("lease_mismatch");
    return this.immediateTransaction(() => {
      const coordination = this.db
        .prepare(
          `SELECT revision,controllerId,leaseId,fencingToken,expiresAt
           FROM run_coordination WHERE runId = ?`
        )
        .get(input.runId) as
        | {
            revision: number;
            controllerId: string | null;
            leaseId: string | null;
            fencingToken: number;
            expiresAt: string | null;
          }
        | undefined;
      if (!coordination?.controllerId) return failure("no_active_lease");
      if (coordination.fencingToken !== input.controller.fencingToken)
        return failure("stale_fence");
      if (
        coordination.controllerId !== input.controller.controllerId ||
        coordination.leaseId !== input.controller.leaseId
      ) {
        return failure("lease_mismatch");
      }
      if (coordination.revision !== input.expectedRunRevision) {
        return failure("stale_run_revision", coordination.revision);
      }
      if (parseInstant(coordination.expiresAt!, "expiresAt") <= parseInstant(input.now, "now")) {
        return failure("lease_expired");
      }
      return action();
    });
  }

  private fanoutPlan(fanoutId: string): FanoutPlanRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM agent_work_fanout_plans WHERE fanoutId = ?`)
      .get(fanoutId) as FanoutPlanRecord | undefined;
    if (!row) return null;
    try {
      const parsed = AgentWorkFanoutPlan_v1.safeParse(JSON.parse(row.planJson) as unknown);
      return parsed.success &&
        parsed.data.fanout_id === row.fanoutId &&
        parsed.data.run_id === row.runId &&
        parsed.data.work_item_id === row.workItemId &&
        parsed.data.work_item_revision === row.workItemRevision &&
        parsed.data.created_at === row.createdAt &&
        canonicalJSONStringify(parsed.data) === row.planJson &&
        computeCanonicalHash(parsed.data) === row.planHash
        ? { ...row }
        : null;
    } catch {
      return null;
    }
  }

  private fanoutBinding(attemptId: string): FanoutAttemptBindingRecord | null {
    const row = this.db
      .prepare(
        `SELECT fanoutId,attemptId,premiseId,premiseHash,planHash,createdAt
         FROM agent_work_fanout_attempts WHERE attemptId = ?`
      )
      .get(attemptId) as FanoutAttemptBindingRecord | undefined;
    return row ? { ...row } : null;
  }

  private fanInDecision(decisionId: string): FanInDecisionRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM agent_work_fanin_decisions WHERE decisionId = ?`)
      .get(decisionId) as FanInDecisionRecord | undefined;
    return row ? this.validateFanInDecisionRow(row) : null;
  }

  private fanInDecisionForFanout(fanoutId: string): FanInDecisionRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM agent_work_fanin_decisions WHERE fanoutId = ?`)
      .get(fanoutId) as FanInDecisionRecord | undefined;
    return row ? this.validateFanInDecisionRow(row) : null;
  }

  private validateFanInDecisionRow(row: FanInDecisionRecord): FanInDecisionRecord | null {
    try {
      const parsed = AgentWorkFanInDecision_v1.safeParse(JSON.parse(row.decisionJson) as unknown);
      return parsed.success &&
        parsed.data.decision_id === row.decisionId &&
        parsed.data.fanout_id === row.fanoutId &&
        parsed.data.run_id === row.runId &&
        parsed.data.work_item_id === row.workItemId &&
        parsed.data.work_item_revision === row.workItemRevision &&
        (parsed.data.selected_attempt_id ?? null) === row.selectedAttemptId &&
        parsed.data.decision === row.outcome &&
        parsed.data.created_at === row.createdAt &&
        canonicalJSONStringify(parsed.data) === row.decisionJson &&
        computeCanonicalHash(parsed.data) === row.decisionHash
        ? { ...row }
        : null;
    } catch {
      return null;
    }
  }

  private fanoutMutation(
    runId: string,
    mutationId: string
  ): {
    fingerprint: string;
    kind: "plan" | "decision";
    recordId: string;
  } | null {
    const row = this.db
      .prepare(
        `SELECT fingerprint,kind,recordId FROM agent_work_fanout_mutations
         WHERE runId = ? AND mutationId = ?`
      )
      .get(runId, mutationId) as
      { fingerprint: string; kind: "plan" | "decision"; recordId: string } | undefined;
    return row ?? null;
  }

  private insertFanoutMutation(
    input: { runId: string; mutationId: string },
    fingerprint: string,
    kind: "plan" | "decision",
    recordId: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO agent_work_fanout_mutations
         (runId,mutationId,fingerprint,kind,recordId) VALUES (?,?,?,?,?)`
      )
      .run(input.runId, input.mutationId, fingerprint, kind, recordId);
  }

  private nonFanoutMutationClaim(runId: string, mutationId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM workspace_lifecycle_mutations WHERE runId = ? AND mutationId = ?
           UNION ALL SELECT 1 FROM worker_session_mutations WHERE runId = ? AND mutationId = ?
           UNION ALL SELECT 1 FROM attempt_receipt_mutations WHERE runId = ? AND mutationId = ?
           UNION ALL SELECT 1 FROM attempt_verification_mutations WHERE runId = ? AND mutationId = ?
           UNION ALL SELECT 1 FROM attempt_verification_begin_mutations
             WHERE runId = ? AND mutationId = ?
           UNION ALL SELECT 1 FROM worker_authority_events WHERE runId = ? AND mutationId = ?`
        )
        .get(
          runId,
          mutationId,
          runId,
          mutationId,
          runId,
          mutationId,
          runId,
          mutationId,
          runId,
          mutationId,
          runId,
          mutationId
        )
    );
  }

  private validateFanoutBinding(
    input: CreateAttemptInput
  ): { valid: true; record?: FanoutAttemptBindingRecord } | { valid: false } {
    if (!input.fanout) return { valid: true };
    const binding = FanoutAttemptBinding_v1.safeParse(input.fanout);
    if (!binding.success || binding.data.attempt_id !== input.attemptId) return { valid: false };
    const planRecord = this.fanoutPlan(binding.data.fanout_id);
    if (!planRecord || planRecord.planHash !== binding.data.fanout_plan_hash) {
      return { valid: false };
    }
    const plan = AgentWorkFanoutPlan_v1.safeParse(JSON.parse(planRecord.planJson) as unknown);
    const premise = plan.success
      ? plan.data.premises.find(({ premise_id }) => premise_id === binding.data.premise_id)
      : undefined;
    const occupied = this.db
      .prepare(`SELECT 1 FROM agent_work_fanout_attempts WHERE fanoutId = ? AND premiseId = ?`)
      .get(binding.data.fanout_id, binding.data.premise_id);
    if (
      !plan.success ||
      plan.data.run_id !== input.runId ||
      plan.data.work_item_id !== input.workItemId ||
      plan.data.work_item_revision !== input.workItemRevision ||
      !premise ||
      premise.attempt_id !== input.attemptId ||
      computeCanonicalHash(premise) !== binding.data.premise_hash ||
      occupied
    ) {
      return { valid: false };
    }
    return {
      valid: true,
      record: {
        fanoutId: binding.data.fanout_id,
        attemptId: binding.data.attempt_id,
        premiseId: binding.data.premise_id,
        premiseHash: binding.data.premise_hash,
        planHash: binding.data.fanout_plan_hash,
        createdAt: instant(input.now),
      },
    };
  }

  private validFanInDecision(
    decision: import("../../schemas/agent-work.js").AgentWorkFanInDecision_v1,
    planRecord: FanoutPlanRecord
  ): boolean {
    let plan: import("../../schemas/agent-work.js").AgentWorkFanoutPlan_v1;
    try {
      plan = AgentWorkFanoutPlan_v1.parse(JSON.parse(planRecord.planJson) as unknown);
    } catch {
      return false;
    }
    if (
      decision.fanout_plan_hash !== planRecord.planHash ||
      decision.run_id !== plan.run_id ||
      decision.work_item_id !== plan.work_item_id ||
      decision.work_item_revision !== plan.work_item_revision ||
      canonicalJSONStringify(decision.selection_criteria) !==
        canonicalJSONStringify(plan.selection_criteria) ||
      decision.candidates.length !== plan.premises.length ||
      decision.evidence_set_hash !== computeFanInEvidenceSetHash(decision.candidates)
    ) {
      return false;
    }
    for (const premise of plan.premises) {
      const binding = this.fanoutBinding(premise.attempt_id);
      const attempt = this.attempt(premise.attempt_id);
      const candidate = decision.candidates.find(
        ({ attempt_id }) => attempt_id === premise.attempt_id
      );
      if (
        !binding ||
        binding.fanoutId !== plan.fanout_id ||
        binding.premiseId !== premise.premise_id ||
        !attempt ||
        !isTerminalAttemptStatus(attempt.status) ||
        !candidate ||
        candidate.premise_id !== premise.premise_id ||
        candidate.attempt_status !== attempt.status
      ) {
        return false;
      }
      const receipt = this.getReceiptForAttempt(attempt.attemptId);
      if (
        candidate.receipt_id !== receipt?.receiptId ||
        candidate.receipt_hash !== receipt?.receiptHash
      ) {
        return false;
      }
      const verification = this.getVerificationForAttempt(attempt.attemptId);
      if (
        candidate.verification_id !== verification?.verificationId ||
        candidate.verification_hash !== verification?.verificationHash ||
        candidate.verification_outcome !== verification?.outcome ||
        candidate.trust_gap_count !== (verification?.trustGapReasons.length ?? 0) ||
        candidate.verified_result_identity !==
          (verification?.verifiedPatchHash ?? verification?.verifiedHeadSha)
      ) {
        return false;
      }
      const artifacts = verification ? verificationArtifactRefs(verification) : [];
      if (canonicalJSONStringify(candidate.artifact_refs) !== canonicalJSONStringify(artifacts)) {
        return false;
      }
    }
    const expected = evaluateStrictAgentWorkFanIn(
      decision.candidates.map(
        ({ conclusion: _conclusion, reason_codes: _reasonCodes, ...evidence }) => evidence
      )
    );
    return (
      decision.decision === expected.outcome &&
      decision.selected_attempt_id === expected.selectedAttemptId &&
      canonicalJSONStringify(decision.candidates) === canonicalJSONStringify(expected.candidates) &&
      canonicalJSONStringify(decision.conflicts) === canonicalJSONStringify(expected.conflicts) &&
      canonicalJSONStringify(decision.uncertainty) === canonicalJSONStringify(expected.uncertainty)
    );
  }

  private validateRetryDelta(
    input: CreateAttemptInput,
    currentFanoutId?: string
  ):
    | { valid: true; record?: AttemptRetryDeltaRecord }
    | { valid: false; reason: "retry_delta_required" | "retry_delta_invalid" } {
    const row = this.db
      .prepare(
        `SELECT a.attemptId FROM attempts AS a
         WHERE a.runId = ? AND a.workItemId = ? AND a.workItemRevision = ?
           AND (? IS NULL OR NOT EXISTS (
             SELECT 1 FROM agent_work_fanout_attempts AS f
             WHERE f.attemptId = a.attemptId AND f.fanoutId = ?
           ))
         ORDER BY rowid DESC LIMIT 1`
      )
      .get(
        input.runId,
        input.workItemId,
        input.workItemRevision,
        currentFanoutId ?? null,
        currentFanoutId ?? null
      ) as { attemptId: string } | undefined;
    if (!row) {
      return input.retry ? { valid: false, reason: "retry_delta_invalid" } : { valid: true };
    }
    if (!input.retry) return { valid: false, reason: "retry_delta_required" };
    const prior = this.attempt(row.attemptId);
    const parsed = AttemptRetryDelta_v1.safeParse(input.retry);
    if (
      !prior ||
      !parsed.success ||
      !isTerminalAttemptStatus(prior.status) ||
      parsed.data.previous_attempt_id !== prior.attemptId ||
      parsed.data.next_attempt_id !== input.attemptId ||
      parsed.data.work_item_id !== input.workItemId ||
      parsed.data.work_item_revision !== input.workItemRevision ||
      instant(parsed.data.created_at) !== instant(input.now) ||
      !this.validInheritedRetryEvidence(prior, parsed.data.inherited_evidence)
    ) {
      return { valid: false, reason: "retry_delta_invalid" };
    }
    const deltaJson = canonicalJSONStringify(parsed.data);
    return {
      valid: true,
      record: {
        attemptId: input.attemptId,
        previousAttemptId: prior.attemptId,
        deltaHash: computeCanonicalHash(parsed.data),
        deltaJson,
        createdAt: instant(input.now),
      },
    };
  }

  private validInheritedRetryEvidence(
    prior: AttemptRecord,
    references: import("../../schemas/agent-work.js").AttemptRetryDelta_v1["inherited_evidence"]
  ): boolean {
    return references.every((reference) => {
      if (reference.kind === "receipt") {
        const receipt = this.attemptReceipt(reference.id);
        return receipt?.attemptId === prior.attemptId && receipt.receiptHash === reference.hash;
      }
      if (reference.kind === "verification") {
        const verification = this.attemptVerification(reference.id);
        return (
          verification?.attemptId === prior.attemptId &&
          verification.verificationHash === reference.hash
        );
      }
      if (reference.kind === "fan_in_decision") {
        const decision = this.fanInDecision(reference.id);
        return decision?.decisionHash === reference.hash;
      }
      // Reserved evidence kinds fail closed until backed by a canonical store
      // whose identity and content hash can be verified here.
      return false;
    });
  }

  private applyWorkspaceMigration(): void {
    let sql = `${INLINE_WORKSPACE_MIGRATION}\n${INLINE_WORKER_AUTHORITY_MIGRATION}\n${INLINE_WORKER_ADAPTER_MIGRATION}\n${INLINE_ATTEMPT_RETRY_DELTA_MIGRATION}\n${INLINE_AGENT_WORK_FANOUT_MIGRATION}`;
    try {
      const workspacePath = fileURLToPath(
        new URL("./migrations/002-attempt-workspace-lifecycle.sql", import.meta.url)
      );
      const workerPath = fileURLToPath(
        new URL("./migrations/003-worker-session-lifecycle.sql", import.meta.url)
      );
      const receiptPath = fileURLToPath(
        new URL("./migrations/004-attempt-receipt-persistence.sql", import.meta.url)
      );
      const packetPath = fileURLToPath(
        new URL("./migrations/005-task-packet-snapshot-persistence.sql", import.meta.url)
      );
      const verificationPath = fileURLToPath(
        new URL("./migrations/006-attempt-engine-verification-persistence.sql", import.meta.url)
      );
      const authorityPath = fileURLToPath(
        new URL("./migrations/007-worker-authority-events.sql", import.meta.url)
      );
      const adapterPath = fileURLToPath(
        new URL("./migrations/008-worker-adapter-bindings.sql", import.meta.url)
      );
      const retryDeltaPath = fileURLToPath(
        new URL("./migrations/009-attempt-retry-deltas.sql", import.meta.url)
      );
      const fanoutPath = fileURLToPath(
        new URL("./migrations/010-agent-work-fanout-fanin.sql", import.meta.url)
      );
      sql = `${readFileSync(workspacePath, "utf8")}\n${readFileSync(workerPath, "utf8")}\n${readFileSync(receiptPath, "utf8")}\n${readFileSync(packetPath, "utf8")}\n${readFileSync(verificationPath, "utf8")}\n${readFileSync(authorityPath, "utf8")}\n${readFileSync(adapterPath, "utf8")}\n${readFileSync(retryDeltaPath, "utf8")}\n${readFileSync(fanoutPath, "utf8")}`;
    } catch {
      // Published bundles use the equivalent inline migration above.
    }
    this.db.exec(sql);
  }
}

function instant(value: string): string {
  return new Date(parseInstant(value, "now")).toISOString();
}

function validTtl(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function sameIdentity(expected: WorkspaceIdentity, observed: WorkspaceObservation): boolean {
  return (
    expected.repositoryId === observed.repositoryId &&
    expected.hostId === observed.hostId &&
    expected.gitRuntime === observed.gitRuntime &&
    expected.projectRoot === observed.projectRoot &&
    expected.branch === observed.branch &&
    expected.worktreePath === observed.worktreePath &&
    expected.attemptId === observed.attemptId
  );
}

function isLaunchReadyWorkspace(lease: WorkspaceLifecycleLeaseRecord): boolean {
  const observed = lease.lastObservation;
  return Boolean(
    observed &&
    observed.exists &&
    observed.registered &&
    sameIdentity(lease, observed) &&
    observed.cleanliness === "clean" &&
    observed.headSha === lease.baseSha &&
    observed.reason === undefined
  );
}

function bindEvidence(
  attempt: AttemptRecord,
  input: TransitionAttemptInput
): { receiptId: string | null; verificationId: string | null } | null {
  let receiptId = attempt.receiptId;
  let verificationId = attempt.verificationId;
  if (input.receiptId !== undefined) {
    if (input.receiptId.length === 0 || (receiptId !== null && receiptId !== input.receiptId))
      return null;
    receiptId = input.receiptId;
  }
  if (input.verificationId !== undefined) {
    if (
      input.verificationId.length === 0 ||
      (verificationId !== null && verificationId !== input.verificationId)
    )
      return null;
    verificationId = input.verificationId;
  }
  if (attemptStatusRequiresReceipt(input.status) && receiptId === null) return null;
  if (attemptStatusRequiresVerification(input.status) && verificationId === null) return null;
  return { receiptId, verificationId };
}

function json(value: unknown): string {
  return canonicalJSONStringify(cloneJsonValue(value as JsonValue));
}

function toEvent(row: EventRow): WorkspaceLifecycleEvent {
  const type = requireDurableDomain(
    WorkspaceLifecycleEventTypeSchema,
    row.type,
    "workspace_lifecycle_events.type"
  );
  return {
    runId: row.runId,
    attemptId: row.attemptId,
    mutationId: row.mutationId,
    sequence: row.sequence,
    attemptRevision: row.attemptRevision,
    workspaceLeaseRevision: row.workspaceLeaseRevision,
    controllerId: row.controllerId,
    controllerLeaseId: row.controllerLeaseId,
    fencingToken: row.fencingToken,
    type,
    payload: JSON.parse(row.payloadJson) as JsonValue,
    createdAt: row.createdAt,
  };
}

function toWorkerSession(row: WorkerSessionRow): WorkerSessionRecord | null {
  const backend = WorkerSessionBackendSchema.safeParse(row.backend);
  const status = WorkerSessionStatusSchema.safeParse(row.status);
  if (!backend.success || !status.success) return null;
  return {
    sessionId: row.sessionId,
    revision: row.revision,
    runId: row.runId,
    attemptId: row.attemptId,
    packetId: row.packetId,
    packetHash: row.packetHash,
    workspaceLeaseId: row.workspaceLeaseId,
    workspaceLeaseRevision: row.workspaceLeaseRevision,
    executionEnvelopeId: row.executionEnvelopeId,
    executionEnvelopeHash: row.executionEnvelopeHash,
    hostId: row.hostId,
    workerRuntime: row.workerRuntime,
    gitRuntime: row.gitRuntime,
    backend: backend.data,
    workerId: row.workerId,
    ...(row.model ? { model: row.model } : {}),
    status: status.data,
    startedAt: row.startedAt,
    heartbeatAt: row.heartbeatAt,
    ...(row.endedAt ? { endedAt: row.endedAt } : {}),
    ...(row.exitReason ? { exitReason: row.exitReason } : {}),
    ...(row.exitCode !== null ? { exitCode: row.exitCode } : {}),
    ...(row.exitSummary ? { exitSummary: row.exitSummary } : {}),
  };
}

function toWorkerEvent(row: WorkerEventRow): WorkerSessionEvent {
  const type = requireDurableDomain(
    WorkerSessionEventTypeSchema,
    row.type,
    "worker_session_events.type"
  );
  return {
    runId: row.runId,
    attemptId: row.attemptId,
    sessionId: row.sessionId,
    mutationId: row.mutationId,
    sequence: row.sequence,
    attemptRevision: row.attemptRevision,
    workspaceLeaseRevision: row.workspaceLeaseRevision,
    sessionRevision: row.sessionRevision,
    controllerId: row.controllerId,
    controllerLeaseId: row.controllerLeaseId,
    fencingToken: row.fencingToken,
    type,
    payload: JSON.parse(row.payloadJson) as JsonValue,
    createdAt: row.createdAt,
  };
}

function toWorkerAuthorityEvent(row: WorkerAuthorityEventRow): WorkerAuthorityEventRecord | null {
  const dimension = WorkerAuthorityDimensionSchema.safeParse(row.dimension);
  const decision = WorkerAuthorityDecisionSchema.safeParse(row.decision);
  const enforcement = WorkerAuthorityEnforcementSchema.safeParse(row.enforcement);
  const reason = WorkerAuthorityReasonSchema.safeParse(row.reason);
  if (
    !dimension.success ||
    !decision.success ||
    !enforcement.success ||
    !reason.success ||
    row.sequence <= 0 ||
    row.attemptRevision < 0 ||
    row.workspaceLeaseRevision < 0 ||
    row.workerSessionRevision < 0 ||
    row.fencingToken <= 0 ||
    !Number.isFinite(Date.parse(row.createdAt)) ||
    row.actionClass.length === 0 ||
    row.actionClass.length > 128 ||
    row.backendId.length === 0 ||
    row.backendId.length > 128 ||
    row.backendVersion.length === 0 ||
    row.backendVersion.length > 128 ||
    !/^sha256:[a-f0-9]{64}$/.test(row.actionHash)
  ) {
    return null;
  }
  return {
    runId: row.runId,
    attemptId: row.attemptId,
    workerSessionId: row.workerSessionId,
    mutationId: row.mutationId,
    sequence: row.sequence,
    attemptRevision: row.attemptRevision,
    workspaceLeaseId: row.workspaceLeaseId,
    workspaceLeaseRevision: row.workspaceLeaseRevision,
    workerSessionRevision: row.workerSessionRevision,
    packetId: row.packetId,
    packetHash: row.packetHash,
    dimension: dimension.data,
    decision: decision.data,
    enforcement: enforcement.data,
    actionClass: row.actionClass,
    actionHash: row.actionHash,
    backendId: row.backendId,
    backendVersion: row.backendVersion,
    reason: reason.data,
    controllerId: row.controllerId,
    controllerLeaseId: row.controllerLeaseId,
    fencingToken: row.fencingToken,
    createdAt: row.createdAt,
  };
}

function parseStoredReceipt(record: AttemptReceiptRecord): AgentTaskReceipt_v2 | null {
  try {
    const value = JSON.parse(record.receiptJson) as unknown;
    const parsed = AgentTaskReceipt_v2.safeParse(value);
    return parsed.success &&
      canonicalJSONStringify(parsed.data) === record.receiptJson &&
      computeCanonicalHash(parsed.data) === record.receiptHash
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}

function verificationArtifactRefs(record: AttemptVerificationRecord): string[] {
  try {
    const parsed = AgentEngineVerification_v2.safeParse(
      JSON.parse(record.verificationJson) as unknown
    );
    if (!parsed.success) return [];
    return [...new Set(parsed.data.checks.flatMap(({ artifact_refs }) => artifact_refs))].sort();
  } catch {
    return [];
  }
}

function validVerificationBinding(
  verification: import("../../schemas/agent-work.js").AgentEngineVerification_v2,
  input: SubmitAttemptVerificationInput,
  attempt: AttemptRecord,
  lease: WorkspaceLifecycleLeaseRecord,
  session: WorkerSessionRecord,
  receipt: AttemptReceiptRecord
): boolean {
  return (
    verification.run_id === input.runId &&
    verification.attempt_id === input.attemptId &&
    verification.work_item_id === attempt.workItemId &&
    verification.work_item_revision === attempt.workItemRevision &&
    verification.packet_id === attempt.packetId &&
    verification.packet_hash === attempt.packetHash &&
    verification.workspace_lease_id === input.workspaceLeaseId &&
    verification.workspace_lease_revision === lease.revision &&
    lease.attemptId === attempt.attemptId &&
    verification.worker_session_id === input.workerSessionId &&
    verification.worker_session_revision === session.revision &&
    session.runId === input.runId &&
    session.attemptId === input.attemptId &&
    session.workspaceLeaseId === input.workspaceLeaseId &&
    verification.receipt_id === input.receiptId &&
    verification.receipt_hash === input.receiptHash &&
    receipt.receiptId === input.receiptId &&
    receipt.receiptHash === input.receiptHash &&
    verification.observed_base_sha === attempt.baseSha.toLowerCase()
  );
}

function validVerificationAuthorization(
  authorization: AttemptVerificationAuthorizationRecord,
  input: SubmitAttemptVerificationInput,
  attempt: AttemptRecord,
  lease: WorkspaceLifecycleLeaseRecord,
  session: WorkerSessionRecord,
  receipt: AttemptReceiptRecord
): boolean {
  return (
    authorization.runId === input.runId &&
    authorization.attemptId === input.attemptId &&
    authorization.attemptRevision === attempt.revision &&
    authorization.workspaceLeaseId === input.workspaceLeaseId &&
    authorization.workspaceLeaseRevision === lease.revision &&
    authorization.workerSessionId === input.workerSessionId &&
    authorization.workerSessionRevision === session.revision &&
    authorization.receiptId === input.receiptId &&
    authorization.receiptHash === input.receiptHash &&
    authorization.controllerId === input.controller.controllerId &&
    authorization.controllerLeaseId === input.controller.leaseId &&
    authorization.fencingToken === input.controller.fencingToken &&
    receipt.receiptId === authorization.receiptId
  );
}

function validAuthorityDecision(
  input: RecordWorkerAuthorityDecisionInput,
  authority: AgentTaskPacket_v1["authority"]
): boolean {
  if (
    input.actionClass.length === 0 ||
    input.actionClass.length > 128 ||
    input.backendId.length === 0 ||
    input.backendId.length > 128 ||
    input.backendVersion.length === 0 ||
    input.backendVersion.length > 128 ||
    !/^sha256:[a-f0-9]{64}$/.test(input.actionHash)
  ) {
    return false;
  }
  const granted = authority[input.dimension];
  if (input.decision === "allowed") {
    return granted && input.reason === "packet_granted" && input.enforcement !== "unenforced";
  }
  if (input.decision === "deviation") {
    return !granted && input.reason === "observed_after_execution";
  }
  return (
    (!granted && input.reason === "packet_denied" && input.enforcement !== "unenforced") ||
    (input.reason === "backend_unenforceable" && input.enforcement === "unenforced")
  );
}

function authorityDecisionFingerprint(input: RecordWorkerAuthorityDecisionInput): string {
  const { now: _observedAt, ...semanticInput } = input;
  return canonicalJSONStringify(semanticInput as unknown as JsonValue);
}

function hasRequiredTrustGaps(
  verification: import("../../schemas/agent-work.js").AgentEngineVerification_v2,
  receipt: AgentTaskReceipt_v2,
  authorityDeviation = false
): boolean {
  const required = new Set<
    import("../../schemas/agent-work.js").EngineVerificationTrustGapReason_v2
  >();
  if ((receipt.outcome === "completed") !== (verification.outcome === "pass")) {
    required.add("worker_outcome_disagrees");
  }
  if (
    receipt.final_head_sha !== undefined &&
    receipt.final_head_sha !== verification.verified_head_sha
  ) {
    required.add("head_identity_disagrees");
  }
  if (receipt.patch_hash !== undefined && receipt.patch_hash !== verification.verified_patch_hash) {
    required.add("patch_identity_disagrees");
  }
  const observedChecks = new Map(
    verification.checks
      .filter(({ source }) => source === "packet")
      .map((check) => [check.id, check.outcome] as const)
  );
  const claimAgrees = receipt.claimed_checks.every((claim) => {
    const observed = observedChecks.get(claim.id);
    return (
      observed === undefined ||
      (claim.outcome === "pass" && observed === "pass") ||
      (claim.outcome === "fail" && observed === "fail") ||
      (claim.outcome === "not_run" && observed !== "pass" && observed !== "fail")
    );
  });
  if (!claimAgrees) required.add("claimed_check_disagrees");
  if (authorityDeviation) required.add("authority_deviation");
  const declared = new Set(verification.trust_gap_reasons);
  return [...required].every((reason) => declared.has(reason));
}

function verificationAttemptStatus(
  outcome: import("../../schemas/agent-work.js").VerificationOutcome
): AttemptRecord["status"] {
  if (outcome === "pass") return "verified";
  if (outcome === "fail") return "rejected";
  return "inconclusive";
}

function toAttemptReceipt(row: AttemptReceiptRow): AttemptReceiptRecord | null {
  const outcome = AgentTaskReceiptOutcomeSchema.safeParse(row.outcome);
  const disposition = AttemptReceiptDispositionSchema.safeParse(row.disposition);
  const resultingAttemptStatus = AttemptStatusSchema.safeParse(row.resultingAttemptStatus);
  if (!outcome.success || !disposition.success || !resultingAttemptStatus.success) return null;
  return {
    receiptId: row.receiptId,
    receiptHash: row.receiptHash,
    receiptJson: row.receiptJson,
    runId: row.runId,
    workItemId: row.workItemId,
    workItemRevision: row.workItemRevision,
    attemptId: row.attemptId,
    packetId: row.packetId,
    packetHash: row.packetHash,
    workspaceLeaseId: row.workspaceLeaseId,
    workspaceLeaseRevision: row.workspaceLeaseRevision,
    workerSessionId: row.workerSessionId,
    workerSessionRevision: row.workerSessionRevision,
    workerRuntime: row.workerRuntime,
    observedBaseSha: row.observedBaseSha,
    ...(row.finalHeadSha ? { finalHeadSha: row.finalHeadSha } : {}),
    ...(row.patchHash ? { patchHash: row.patchHash } : {}),
    outcome: outcome.data,
    disposition: disposition.data,
    submittedAt: row.submittedAt,
    recordedAt: row.recordedAt,
    controllerId: row.controllerId,
    controllerLeaseId: row.controllerLeaseId,
    fencingToken: row.fencingToken,
    resultingAttemptRevision: row.resultingAttemptRevision,
    resultingAttemptStatus: resultingAttemptStatus.data,
  };
}

function toAttemptReceiptEvent(row: AttemptReceiptEventRow): AttemptReceiptEvent {
  const type = requireDurableDomain(
    AttemptReceiptEventTypeSchema,
    row.type,
    "attempt_receipt_events.type"
  );
  const disposition = requireDurableDomain(
    AttemptReceiptDispositionSchema,
    row.disposition,
    "attempt_receipt_events.disposition"
  );
  const outcome = requireDurableDomain(
    AgentTaskReceiptOutcomeSchema,
    row.outcome,
    "attempt_receipt_events.outcome"
  );
  return {
    runId: row.runId,
    attemptId: row.attemptId,
    receiptId: row.receiptId,
    receiptHash: row.receiptHash,
    mutationId: row.mutationId,
    sequence: row.sequence,
    attemptRevision: row.attemptRevision,
    workspaceLeaseRevision: row.workspaceLeaseRevision,
    workerSessionRevision: row.workerSessionRevision,
    controllerId: row.controllerId,
    controllerLeaseId: row.controllerLeaseId,
    fencingToken: row.fencingToken,
    type,
    disposition,
    outcome,
    createdAt: row.createdAt,
  };
}

function toAttemptVerification(row: AttemptVerificationRow): AttemptVerificationRecord | null {
  const outcome = VerificationOutcomeSchema.safeParse(row.outcome);
  const resultingAttemptStatus = AttemptStatusSchema.safeParse(row.resultingAttemptStatus);
  let trustGapReasons: unknown;
  try {
    trustGapReasons = JSON.parse(row.trustGapReasonsJson) as unknown;
  } catch {
    return null;
  }
  const parsedReasons = EngineVerificationTrustGapReasonV2Schema.array().safeParse(trustGapReasons);
  if (!outcome.success || !resultingAttemptStatus.success || !parsedReasons.success) return null;
  return {
    verificationId: row.verificationId,
    verificationHash: row.verificationHash,
    verificationJson: row.verificationJson,
    runId: row.runId,
    workItemId: row.workItemId,
    workItemRevision: row.workItemRevision,
    attemptId: row.attemptId,
    packetId: row.packetId,
    packetHash: row.packetHash,
    workspaceLeaseId: row.workspaceLeaseId,
    workspaceLeaseRevision: row.workspaceLeaseRevision,
    workerSessionId: row.workerSessionId,
    workerSessionRevision: row.workerSessionRevision,
    receiptId: row.receiptId,
    receiptHash: row.receiptHash,
    observedBaseSha: row.observedBaseSha,
    ...(row.verifiedHeadSha ? { verifiedHeadSha: row.verifiedHeadSha } : {}),
    ...(row.verifiedPatchHash ? { verifiedPatchHash: row.verifiedPatchHash } : {}),
    workspaceObservationHash: row.workspaceObservationHash,
    outcome: outcome.data,
    trustGapReasons: parsedReasons.data,
    verifierId: row.verifierId,
    verifierVersion: row.verifierVersion,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    recordedAt: row.recordedAt,
    controllerId: row.controllerId,
    controllerLeaseId: row.controllerLeaseId,
    fencingToken: row.fencingToken,
    resultingAttemptRevision: row.resultingAttemptRevision,
    resultingAttemptStatus: resultingAttemptStatus.data,
  };
}

function toAttemptVerificationEvent(row: AttemptVerificationEventRow): AttemptVerificationEvent {
  return {
    runId: row.runId,
    attemptId: row.attemptId,
    verificationId: row.verificationId,
    verificationHash: row.verificationHash,
    receiptId: row.receiptId,
    receiptHash: row.receiptHash,
    mutationId: row.mutationId,
    sequence: row.sequence,
    attemptRevision: row.attemptRevision,
    workspaceLeaseRevision: row.workspaceLeaseRevision,
    workerSessionRevision: row.workerSessionRevision,
    controllerId: row.controllerId,
    controllerLeaseId: row.controllerLeaseId,
    fencingToken: row.fencingToken,
    type: requireDurableDomain(
      AttemptVerificationEventTypeSchema,
      row.type,
      "attempt_verification_events.type"
    ),
    outcome:
      row.outcome === null
        ? null
        : requireDurableDomain(
            VerificationOutcomeSchema,
            row.outcome,
            "attempt_verification_events.outcome"
          ),
    resultingAttemptStatus: requireDurableDomain(
      AttemptStatusSchema,
      row.resultingAttemptStatus,
      "attempt_verification_events.resultingAttemptStatus"
    ),
    createdAt: row.createdAt,
  };
}

function requireDurableDomain<T>(schema: ZodType<T>, value: unknown, field: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid durable categorical value in ${field}`);
  return parsed.data;
}

function parseWorkspaceMutationSuccess(resultJson: string): Success | null {
  const value = parseDurableJsonRecord(resultJson);
  if (
    !value ||
    value.updated !== true ||
    typeof value.idempotentReplay !== "boolean" ||
    !validAttemptCategories(value.attempt) ||
    !validWorkspaceEventCategories(value.event) ||
    (value.workspaceLease !== null && !validLeaseCategories(value.workspaceLease))
  ) {
    return null;
  }
  return value as unknown as Success;
}

function parseWorkerMutationSuccess(
  resultJson: string
): Extract<WorkerSessionMutationResult, { updated: true }> | null {
  const value = parseDurableJsonRecord(resultJson);
  if (
    !value ||
    value.updated !== true ||
    typeof value.idempotentReplay !== "boolean" ||
    !validAttemptCategories(value.attempt) ||
    !validWorkerSessionCategories(value.workerSession) ||
    !validWorkerEventCategories(value.event)
  ) {
    return null;
  }
  return value as unknown as Extract<WorkerSessionMutationResult, { updated: true }>;
}

function parseReceiptMutationSuccess(
  resultJson: string
): Extract<AttemptReceiptSubmissionResult, { submitted: true }> | null {
  const value = parseDurableJsonRecord(resultJson);
  if (
    !value ||
    value.submitted !== true ||
    typeof value.idempotentReplay !== "boolean" ||
    !validAttemptCategories(value.attempt) ||
    !validReceiptCategories(value.receipt) ||
    !validReceiptEventCategories(value.event)
  ) {
    return null;
  }
  return value as unknown as Extract<AttemptReceiptSubmissionResult, { submitted: true }>;
}

function parseVerificationMutationSuccess(
  resultJson: string
): Extract<AttemptVerificationSubmissionResult, { recorded: true }> | null {
  const value = parseDurableJsonRecord(resultJson);
  if (
    !value ||
    value.recorded !== true ||
    typeof value.idempotentReplay !== "boolean" ||
    !validAttemptCategories(value.attempt) ||
    !validVerificationCategories(value.verification) ||
    !validVerificationEventCategories(value.event)
  ) {
    return null;
  }
  return value as unknown as Extract<AttemptVerificationSubmissionResult, { recorded: true }>;
}

function parseVerificationBeginSuccess(
  resultJson: string
): Extract<AttemptVerificationBeginResult, { started: true }> | null {
  const value = parseDurableJsonRecord(resultJson);
  if (
    !value ||
    value.started !== true ||
    typeof value.idempotentReplay !== "boolean" ||
    !isJsonRecord(value.authorization) ||
    !validAttemptCategories(value.attempt) ||
    !validVerificationEventCategories(value.event)
  ) {
    return null;
  }
  return value as unknown as Extract<AttemptVerificationBeginResult, { started: true }>;
}

function parseDurableJsonRecord(value: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isJsonRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function validAttemptCategories(value: unknown): boolean {
  return isJsonRecord(value) && AttemptStatusSchema.safeParse(value.status).success;
}

function validVerificationCategories(value: unknown): boolean {
  return (
    isJsonRecord(value) &&
    VerificationOutcomeSchema.safeParse(value.outcome).success &&
    AttemptStatusSchema.safeParse(value.resultingAttemptStatus).success &&
    EngineVerificationTrustGapReasonV2Schema.array().safeParse(value.trustGapReasons).success
  );
}

function validVerificationEventCategories(value: unknown): boolean {
  if (!isJsonRecord(value)) return false;
  const type = AttemptVerificationEventTypeSchema.safeParse(value.type);
  if (!type.success || !AttemptStatusSchema.safeParse(value.resultingAttemptStatus).success) {
    return false;
  }
  return type.data === "attempt_verification_started"
    ? value.outcome === null && value.verificationHash === null
    : VerificationOutcomeSchema.safeParse(value.outcome).success &&
        typeof value.verificationHash === "string";
}

function validLeaseCategories(value: unknown): boolean {
  return (
    isJsonRecord(value) &&
    WorkspaceLifecycleLeaseStatusSchema.safeParse(value.status).success &&
    (value.cleanupDisposition === undefined ||
      WorkspaceCleanupDispositionSchema.safeParse(value.cleanupDisposition).success) &&
    (value.lastObservation === undefined ||
      WorkspaceObservationSchema.safeParse(value.lastObservation).success)
  );
}

function validWorkspaceEventCategories(value: unknown): boolean {
  return isJsonRecord(value) && WorkspaceLifecycleEventTypeSchema.safeParse(value.type).success;
}

function validWorkerSessionCategories(value: unknown): boolean {
  return (
    isJsonRecord(value) &&
    WorkerSessionBackendSchema.safeParse(value.backend).success &&
    WorkerSessionStatusSchema.safeParse(value.status).success
  );
}

function validWorkerEventCategories(value: unknown): boolean {
  return isJsonRecord(value) && WorkerSessionEventTypeSchema.safeParse(value.type).success;
}

function validReceiptCategories(value: unknown): boolean {
  return (
    isJsonRecord(value) &&
    AgentTaskReceiptOutcomeSchema.safeParse(value.outcome).success &&
    AttemptReceiptDispositionSchema.safeParse(value.disposition).success &&
    AttemptStatusSchema.safeParse(value.resultingAttemptStatus).success
  );
}

function validReceiptEventCategories(value: unknown): boolean {
  return (
    isJsonRecord(value) &&
    AttemptReceiptEventTypeSchema.safeParse(value.type).success &&
    AttemptReceiptDispositionSchema.safeParse(value.disposition).success &&
    AgentTaskReceiptOutcomeSchema.safeParse(value.outcome).success
  );
}

function validWorkerAdapterBinding(
  input: NonNullable<AttachWorkerSessionInput["adapter"]>
): boolean {
  return (
    input.adapterId.length > 0 &&
    input.adapterId.length <= 128 &&
    input.adapterVersion.length > 0 &&
    input.adapterVersion.length <= 128 &&
    /^sha256:[0-9a-f]{64}$/u.test(input.enforcementSummaryHash) &&
    input.trustGapDimensions.length <= 16 &&
    new Set(input.trustGapDimensions).size === input.trustGapDimensions.length &&
    input.trustGapDimensions.every((value) => value.length > 0 && value.length <= 128)
  );
}

function validPersistedWorkerAdapterBinding(input: WorkerAdapterBindingRecord): boolean {
  return (
    validWorkerAdapterBinding(input) &&
    input.sessionId.length > 0 &&
    input.sessionId.length <= 128 &&
    Number.isFinite(Date.parse(input.createdAt))
  );
}

function validExitMetadata(input: EndWorkerSessionInput): boolean {
  return (
    (input.exitReason === undefined || Buffer.byteLength(input.exitReason, "utf8") <= 128) &&
    (input.exitSummary === undefined || Buffer.byteLength(input.exitSummary, "utf8") <= 4_096) &&
    (input.exitCode === undefined || Number.isSafeInteger(input.exitCode))
  );
}

function sqliteLaunchBindingFailure(
  input: BindLaunchEnvelopeInput,
  attempt: AttemptRecord | null,
  lease: WorkspaceLifecycleLeaseRecord | null
): LaunchEnvelopeBindingResult | null {
  if (
    !attempt ||
    attempt.runId !== input.runId ||
    !lease ||
    lease.attemptId !== attempt.attemptId
  ) {
    return sqliteLaunchFailure("not_found", attempt ?? undefined, lease ?? undefined);
  }
  if (attempt.revision !== input.expectedAttemptRevision) {
    return sqliteLaunchFailure("stale_attempt_revision", attempt, lease);
  }
  if (lease.revision !== input.expectedWorkspaceLeaseRevision) {
    return sqliteLaunchFailure("stale_workspace_revision", attempt, lease);
  }
  if (attempt.status !== "launching") {
    return sqliteLaunchFailure("invalid_attempt_transition", attempt, lease);
  }
  if (lease.status !== "active") {
    return sqliteLaunchFailure("workspace_not_active", attempt, lease);
  }
  if (
    lease.controllerId !== input.controller.controllerId ||
    lease.controllerLeaseId !== input.controller.leaseId ||
    lease.fencingToken !== input.controller.fencingToken
  ) {
    return sqliteLaunchFailure("stale_fence", attempt, lease);
  }
  if (parseInstant(lease.expiresAt, "expiresAt") <= parseInstant(input.createdAt, "createdAt")) {
    return sqliteLaunchFailure("workspace_expired", attempt, lease);
  }
  return null;
}

function sqliteLaunchFailure(
  reason: WorkspaceMutationFailureReason,
  attempt?: AttemptRecord,
  lease?: WorkspaceLifecycleLeaseRecord
): LaunchEnvelopeBindingResult {
  return {
    bound: false,
    reason,
    ...(attempt ? { currentAttemptRevision: attempt.revision } : {}),
    ...(lease ? { currentWorkspaceLeaseRevision: lease.revision } : {}),
  };
}

function isMatchingLaunchAuthorization(
  event: WorkspaceLifecycleEvent | undefined,
  input: BindLaunchEnvelopeInput
): boolean {
  if (!event || !isJsonRecord(event.payload)) return false;
  return (
    event.runId === input.runId &&
    event.attemptId === input.attemptId &&
    event.type === "attempt_transitioned" &&
    event.attemptRevision === input.expectedAttemptRevision &&
    event.workspaceLeaseRevision === input.expectedWorkspaceLeaseRevision &&
    event.controllerId === input.controller.controllerId &&
    event.controllerLeaseId === input.controller.leaseId &&
    event.fencingToken === input.controller.fencingToken &&
    event.payload.status === "launching" &&
    parseInstant(event.createdAt, "authorization.createdAt") <=
      parseInstant(input.createdAt, "createdAt")
  );
}

function isLaunchAuthorizationForAttempt(
  event: WorkspaceLifecycleEvent,
  attempt: AttemptRecord,
  lease: WorkspaceLifecycleLeaseRecord
): boolean {
  return (
    event.runId === attempt.runId &&
    event.attemptId === attempt.attemptId &&
    event.type === "attempt_transitioned" &&
    event.attemptRevision > 0 &&
    event.attemptRevision <= attempt.revision &&
    event.workspaceLeaseRevision !== null &&
    event.workspaceLeaseRevision <= lease.revision &&
    parseInstant(event.createdAt, "authorization.createdAt") <=
      parseInstant(attempt.updatedAt, "attempt.updatedAt") &&
    isJsonRecord(event.payload) &&
    event.payload.status === "launching"
  );
}

function validateCanonicalTaskPacket(
  packetJson: string,
  attempt: AttemptRecord
): AgentTaskPacket_v1 | null {
  if (Buffer.byteLength(packetJson, "utf8") > 256 * 1024) return null;
  let value: unknown;
  try {
    value = JSON.parse(packetJson);
  } catch {
    return null;
  }
  if (!isJsonRecord(value) || canonicalJSONStringify(value) !== packetJson) return null;
  const parsed = AgentTaskPacket_v1.safeParse(value);
  if (!parsed.success) return null;
  const packet = parsed.data;
  return packet.run_id === attempt.runId &&
    packet.attempt_id === attempt.attemptId &&
    packet.work_item.work_item_id === attempt.workItemId &&
    packet.work_item.revision === attempt.workItemRevision &&
    packet.packet_id === attempt.packetId &&
    packet.packet_hash === attempt.packetHash &&
    packet.repository.base_sha === attempt.baseSha
    ? packet
    : null;
}

function sameTaskPacketBinding(
  existing: TaskPacketBindingRecord | null,
  packetJson: string | undefined,
  attempt: AttemptRecord | null
): boolean {
  if (!attempt) return false;
  return existing
    ? packetJson !== undefined &&
        existing.packetJson === packetJson &&
        validateTaskPacketBinding(existing, attempt)
    : packetJson === undefined;
}

function validateTaskPacketBinding(
  binding: TaskPacketBindingRecord,
  attempt: AttemptRecord
): boolean {
  return (
    binding.runId === attempt.runId &&
    binding.attemptId === attempt.attemptId &&
    binding.workItemId === attempt.workItemId &&
    binding.workItemRevision === attempt.workItemRevision &&
    binding.packetId === attempt.packetId &&
    binding.packetHash === attempt.packetHash &&
    Number.isFinite(Date.parse(binding.createdAt)) &&
    validateCanonicalTaskPacket(binding.packetJson, attempt) !== null
  );
}

function sameLaunchBinding(
  existing: LaunchEnvelopeBindingRecord,
  input: BindLaunchEnvelopeInput
): boolean {
  return (
    existing.runId === input.runId &&
    existing.workspaceLeaseId === input.workspaceLeaseId &&
    existing.attemptRevision === input.expectedAttemptRevision &&
    existing.workspaceLeaseRevision === input.expectedWorkspaceLeaseRevision &&
    existing.authorizationMutationId === input.authorizationMutationId &&
    existing.envelopeId === input.envelopeId &&
    existing.envelopeHash === input.envelopeHash &&
    existing.envelopeJson === input.envelopeJson &&
    existing.controllerId === input.controller.controllerId &&
    existing.controllerLeaseId === input.controller.leaseId &&
    existing.fencingToken === input.controller.fencingToken &&
    existing.createdAt === instant(input.createdAt)
  );
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundWorkerRuntime(binding: LaunchEnvelopeBindingRecord): string | null {
  try {
    const envelope = JSON.parse(binding.envelopeJson) as unknown;
    if (!isJsonRecord(envelope) || !isJsonRecord(envelope.runtime)) return null;
    return typeof envelope.runtime.worker_runtime === "string"
      ? envelope.runtime.worker_runtime
      : null;
  } catch {
    return null;
  }
}

function validReceiptBinding(
  receipt: import("../../schemas/agent-work.js").AgentTaskReceipt_v2,
  input: SubmitAttemptReceiptInput,
  attempt: AttemptRecord,
  lease: WorkspaceLifecycleLeaseRecord,
  session: WorkerSessionRecord
): boolean {
  const started = parseInstant(receipt.worker_started_at, "worker_started_at");
  const completed = parseInstant(receipt.worker_completed_at, "worker_completed_at");
  return (
    receipt.run_id === input.runId &&
    receipt.attempt_id === input.attemptId &&
    receipt.work_item_id === attempt.workItemId &&
    receipt.work_item_revision === attempt.workItemRevision &&
    receipt.packet_id === attempt.packetId &&
    receipt.packet_hash === attempt.packetHash &&
    receipt.workspace_lease_id === input.workspaceLeaseId &&
    lease.attemptId === attempt.attemptId &&
    receipt.workspace_lease_revision === session.workspaceLeaseRevision &&
    receipt.worker_session_id === input.workerSessionId &&
    session.runId === input.runId &&
    session.attemptId === input.attemptId &&
    session.packetId === attempt.packetId &&
    session.packetHash === attempt.packetHash &&
    session.workspaceLeaseId === input.workspaceLeaseId &&
    receipt.worker_runtime === session.workerRuntime &&
    receipt.observed_base_sha === attempt.baseSha.toLowerCase() &&
    started >= parseInstant(session.startedAt, "session.startedAt") &&
    Boolean(session.endedAt) &&
    completed <= parseInstant(session.endedAt!, "session.endedAt") &&
    parseInstant(receipt.submitted_at, "submitted_at") <= parseInstant(input.now, "now")
  );
}
