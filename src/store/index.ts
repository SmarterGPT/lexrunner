/**
 * Store Layer — Persistence abstraction for run lifecycle.
 *
 * This module exports the RunStore interface and available implementations.
 *
 * @module store
 */

import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import type { RunStore } from "./run-store.js";
import { SqliteRunStore } from "./sqlite/index.js";

// Interface and types
export type {
  RunStore,
  RunRecord,
  StepOutcome,
  Receipt,
  RunState,
  StepStatus,
  ListRunsOptions,
} from "./run-store.js";

export {
  RunRecordSchema,
  StepOutcomeSchema,
  ReceiptSchema,
  RunStateSchema,
  StepStatusSchema,
  parseRunRecord,
  safeParseRunRecord,
  parseStepOutcome,
  safeParseStepOutcome,
  parseReceipt,
  safeParseReceipt,
} from "./run-store.js";

// Implementations
export { InMemoryRunStore } from "./inmemory/index.js";
export type { InMemoryRunStoreOptions } from "./inmemory/index.js";
export { SqliteRunStore } from "./sqlite/index.js";

// Controller coordination is intentionally separate from the frozen RunStore contract.
export type {
  JsonPrimitive,
  JsonValue,
  ControllerLease,
  ControllerLeaseCredential,
  RunCoordinationRecord,
  AcquireControllerLeaseInput,
  RenewControllerLeaseInput,
  ReleaseControllerLeaseInput,
  CompareAndSetRunStateInput,
  RunCoordinationEventInput,
  RunCoordinationEvent,
  LeaseFailureReason,
  AcquireControllerLeaseResult,
  RenewControllerLeaseResult,
  ReleaseControllerLeaseResult,
  CompareAndSetRunStateResult,
  CoordinationStore,
} from "./coordination-store.js";
export { InMemoryCoordinationStore } from "./inmemory/index.js";
export { SqliteCoordinationStore, SqliteWorkspaceLifecycleStore } from "./sqlite/index.js";

// Attempt/workspace persistence is additive and does not modify the frozen RunStore.
export {
  AgentTaskReceiptOutcome,
  AttemptReceiptFailureReason,
  AttemptReceiptDisposition,
  AttemptReceiptEventType,
  AttemptVerificationEventType,
  AttemptVerificationFailureReason,
  AttemptStatus,
  VerificationOutcome,
  EndWorkerSessionStatus,
  FinishedWorkspaceLeaseStatus,
  HeartbeatWorkerSessionStatus,
  ReleaseWorkspaceDisposition,
  WorkerSessionBackend,
  WorkerSessionEventType,
  WorkerSessionMutationFailureReason,
  WorkerSessionStatus,
  WorkerAuthorityDecision,
  WorkerAuthorityDimension,
  WorkerAuthorityEnforcement,
  WorkerAuthorityReason,
  WorkspaceCleanupDisposition,
  WorkspaceLifecycleEventType,
  WorkspaceLifecycleLeaseStatus,
  WorkspaceMutationFailureReason,
  WorkspaceObservation,
  WorkspaceObservationCleanliness,
  WorkspaceReconciliationAction,
} from "./workspace-lifecycle-domains.js";
export type {
  AttemptRecord,
  AttemptRetryDeltaRecord,
  WorkspaceIdentity,
  WorkspaceLifecycleLeaseRecord,
  WorkspaceLifecycleEvent,
  WorkerSessionRecord,
  WorkerSessionEvent,
  LaunchEnvelopeBindingRecord,
  TaskPacketBindingRecord,
  AttemptReceiptRecord,
  AttemptReceiptEvent,
  AttemptVerificationAuthorizationRecord,
  AttemptVerificationEvent,
  AttemptVerificationRecord,
  CreateAttemptInput,
  TransitionAttemptInput,
  AcquireWorkspaceInput,
  HeartbeatWorkspaceInput,
  ReleaseWorkspaceInput,
  ReconcileWorkspaceInput,
  QuarantineWorkspaceInput,
  AttachWorkerSessionInput,
  HeartbeatWorkerSessionInput,
  EndWorkerSessionInput,
  BindLaunchEnvelopeInput,
  ReconcileIncompleteLaunchInput,
  SubmitAttemptReceiptInput,
  BeginAttemptVerificationInput,
  SubmitAttemptVerificationInput,
  ApplyAttemptAcceptanceInput,
  WorkspaceMutationResult,
  WorkerSessionMutationResult,
  LaunchEnvelopeBindingResult,
  AttemptReceiptSubmissionResult,
  AttemptVerificationBeginResult,
  AttemptVerificationSubmissionResult,
  WorkspaceLifecycleStore,
  LaunchEnvelopeBindingStore,
  TaskPacketBindingStore,
  WorkerSessionStore,
  AttemptReceiptStore,
  AttemptVerificationStore,
  AttemptAcceptanceStore,
  RecordWorkerAuthorityDecisionInput,
  WorkerAuthorityDecisionResult,
  WorkerAuthorityDecisionStore,
  WorkerAuthorityEventRecord,
} from "./workspace-lifecycle-store.js";
export {
  STRICT_ATTEMPT_ACCEPTANCE_POLICY_ID,
  STRICT_ATTEMPT_ACCEPTANCE_POLICY_VERSION,
} from "./workspace-lifecycle-store.js";
export { InMemoryWorkspaceLifecycleStore } from "./inmemory/index.js";
export { toAttemptContract } from "./workspace-lifecycle-store.js";
export * from "./protected-evidence-store.js";
export * from "./local-protected-evidence-store.js";
export * from "./local-protected-evidence-verifier.js";
export * from "./windows-protected-evidence-authority.js";
export * from "./governed-delegation-store.js";
export { InMemoryGovernedDelegationStore } from "./inmemory/governed-delegation-store.js";
export { SqliteGovernedDelegationStore } from "./sqlite/governed-delegation-store.js";
export * from "./governed-attempt-operation-store.js";
export { InMemoryGovernedAttemptOperationStore } from "./inmemory/governed-attempt-operation-store.js";
export { SqliteGovernedAttemptOperationStore } from "./sqlite/governed-attempt-operation-store.js";
export * from "./attempt-awaitable-store.js";
export * from "./worker-dispatch-store.js";
export { InMemoryWorkerDispatchStore } from "./inmemory/worker-dispatch-store.js";
export { SqliteWorkerDispatchStore } from "./sqlite/worker-dispatch-store.js";
export { InMemoryAttemptAwaitableStore } from "./inmemory/attempt-awaitable-store.js";
export { SqliteAttemptAwaitableStore } from "./sqlite/attempt-awaitable-store.js";

/**
 * Default database path relative to baseDir.
 * Runtime artifacts live under .smartergpt/runner/.
 */
const DEFAULT_DB_PATH = ".smartergpt/runner/.lexrunner/runs.db";

/**
 * Options for creating a RunStore.
 */
export interface CreateRunStoreOptions {
  /**
   * Path to SQLite database file.
   * Defaults to `.smartergpt/runner/.lexrunner/runs.db` relative to baseDir.
   */
  dbPath?: string;

  /**
   * Base directory for run storage.
   * Defaults to current working directory.
   */
  baseDir?: string;
}

/**
 * Create a RunStore instance with default configuration.
 *
 * Uses SqliteRunStore by default with a database at `.smartergpt/runner/.lexrunner/runs.db`.
 * Ensures the parent directory exists before creating the store.
 *
 * @param options - Optional configuration
 * @returns A configured RunStore instance
 *
 * @example
 * ```typescript
 * // Default configuration
 * const store = createRunStore();
 *
 * // Custom database path
 * const store = createRunStore({ dbPath: "/path/to/custom.db" });
 *
 * // Custom base directory
 * const store = createRunStore({ baseDir: "/my/project" });
 * ```
 */
export function createRunStore(options: CreateRunStoreOptions = {}): RunStore {
  const baseDir = options.baseDir ?? process.cwd();
  const dbPath = options.dbPath ?? path.join(baseDir, DEFAULT_DB_PATH);

  // Ensure parent directory exists
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  return new SqliteRunStore(dbPath);
}
