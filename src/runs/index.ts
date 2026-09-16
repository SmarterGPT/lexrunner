/**
 * Runs Module - Public API
 *
 * Re-exports all public types and classes from the runs module.
 */

// Types
export type {
  RunState,
  CreateRunParams,
  RunFilter,
  RunIndexEntry,
  RunIndex,
  StartRunInput,
  GetStatusInput,
  RunStateFile,
} from "./types.js";

export {
  RunStateSchema,
  parseRunState,
  safeParseRunState,
  StartRunInputSchema,
  GetStatusInputSchema,
  RunNotFoundError,
} from "./types.js";

// Status builder
export { buildStatusResponse, getDefaultNextOptions } from "./statusBuilder.js";

// Storage utilities
export {
  getRunsDir,
  ensureRunsDir,
  getRunStatePath,
  getRunDir,
  getIndexPath,
  writeRunState,
  readRunState,
  deleteRunState,
  readIndex,
  writeIndex,
  upsertIndexEntry,
  removeIndexEntry,
  ensureRunDir,
  appendToRunLog,
  readRunLog,
  writeAttributions,
} from "./storage.js";

// Manager
export { RunManager, createRunManager } from "./manager.js";
export type { RunManagerOptions } from "./manager.js";

// Lease-fenced coordinated run application service
export {
  CoordinatedRunManager,
  FileRunProjection,
  InvalidProcedureTransitionError,
  ProcedureUnavailableError,
} from "./coordinated-manager.js";

export { AgentWorkLifecycleService, readAgentWorkStatus } from "./agent-work-lifecycle-service.js";
export {
  AgentWorkContainmentCapabilityService,
  AgentWorkContainmentPreflightRequestJsonSchema,
  AgentWorkContainmentPreflightRequestSchema,
  createAgentWorkContainmentPreflightHandler,
} from "./agent-work-containment-preflight.js";
export type {
  AgentWorkContainmentCapabilityDependencies,
  AgentWorkContainmentCapabilityState,
  AgentWorkContainmentNextAction,
  AgentWorkContainmentPathStatus,
  AgentWorkContainmentPreflightHandler,
  AgentWorkContainmentPreflightHandlerResult,
  AgentWorkContainmentPreflightInputError,
  AgentWorkContainmentPreflightRequest,
  AgentWorkContainmentPreflightResult,
  AgentWorkContainmentReasonCode,
} from "./agent-work-containment-preflight.js";
export * from "./agent-work-projection-planner.js";
export {
  NativeWslProjectionCleanupRequestJsonSchema,
  NativeWslProjectionCleanupRequestSchema,
  NativeWslProjectionPrepareRequestJsonSchema,
  NativeWslProjectionPrepareRequestSchema,
  NativeWslProjectionQuarantineRequestJsonSchema,
  NativeWslProjectionQuarantineRequestSchema,
  NativeWslProjectionStatusRequestJsonSchema,
  NativeWslProjectionStatusRequestSchema,
  createNativeWslProjectionLifecycleHandlers,
} from "./agent-work-projection-lifecycle.js";
export type {
  NativeWslProjectionCleanupPublicResult,
  NativeWslProjectionCleanupRequest,
  NativeWslProjectionLifecycleHandlers,
  NativeWslProjectionPrepareRequest,
  NativeWslProjectionPrepareResult,
  NativeWslProjectionPublicNextAction,
  NativeWslProjectionQuarantineResult,
  NativeWslProjectionStatusRequest,
  NativeWslProjectionStatusResult,
  ProjectionLifecycleEngine,
} from "./agent-work-projection-lifecycle.js";
export {
  createAttemptExecutionPathMapping,
  verifyAttemptExecutionPathMapping,
} from "./agent-work-path-mapping.js";
export type {
  CreateAttemptExecutionPathMappingInput,
  NativeWslProjectionLaunchSelection,
} from "./agent-work-path-mapping.js";
export type {
  AgentWorkLifecycleFailure,
  AgentWorkLifecycleResult,
  AgentWorkLifecycleSuccess,
  AgentWorkLaunchReconciliationResult,
  AgentWorkStatus,
  BoundedAttemptStatus,
  BoundedLaunchStatus,
  BoundedRunStatus,
  BoundedWorkspaceStatus,
  LifecycleFailureReason,
  LifecyclePhase,
  StartAttemptInput,
} from "./agent-work-lifecycle-service.js";
export {
  AttemptPrepareRequestJsonSchema,
  AttemptPrepareRequestSchema,
  AttemptStartInputSchema,
  AttemptStartRequestJsonSchema,
  AttemptStartRequestSchema,
  AttemptStatusInputJsonSchema,
  AttemptStatusInputSchema,
  createAttemptLifecycleHandlers,
} from "./agent-work-adapters.js";
export type {
  AdapterInputError,
  AdapterOperationError,
  AdapterError,
  AgentWorkHandlerResult,
  AgentWorkRuntimeBinding,
  AttemptLifecycleHandlers,
  AttemptPreparationHandler,
  AttemptPrepareRequest,
  AttemptStartHandlerInput,
  AttemptStartRequest,
  AttemptStatusHandlerInput,
} from "./agent-work-adapters.js";
export type {
  AttemptLaunchBundleResult,
  AttemptLaunchBundleSuccess,
  AttemptLaunchEnvelopePolicy,
  AttemptLaunchPacketPolicy,
  PrepareAttemptLaunchInput,
} from "./agent-work-launch-bundle.js";
export {
  AttemptWorkerAttachRequestJsonSchema,
  AttemptWorkerAttachRequestSchema,
  AttemptWorkerEndRequestJsonSchema,
  AttemptWorkerEndRequestSchema,
  AttemptWorkerHeartbeatRequestJsonSchema,
  AttemptWorkerHeartbeatRequestSchema,
  AttemptWorkerStatusRequestJsonSchema,
  AttemptWorkerStatusRequestSchema,
  createAttemptWorkerHandlers,
} from "./agent-work-worker-adapters.js";
export type { AttemptWorkerHandlers } from "./agent-work-worker-adapters.js";
export { AgentWorkWorkerSessionService } from "./agent-work-worker-session-service.js";
export type {
  AttachAttemptWorkerInput,
  BoundedWorkerAdapterStatus,
  WorkerSessionStatusResult,
} from "./agent-work-worker-session-service.js";
export {
  AgentWorkWorkerAdapterNegotiator,
  HOST_ASSISTED_ADAPTER_MANIFEST,
  PortBackedWorkerRuntimeAdapter,
  WorkerAdapterAuthorityDimension,
  WorkerAdapterEnforcement,
  WorkerAdapterManifest_v1,
  WorkerAdapterRegistry,
  WorkerAdapterSelection_v1,
  WorkerRuntimeArtifactSchema,
  WorkerRuntimeSignalSchema,
  WORKER_ADAPTER_CONTRACT_VERSION,
} from "./agent-work-worker-runtime.js";
export {
  AgentWorkHeadlessSupervisor,
  DEFAULT_HEADLESS_SUPERVISOR_CONFIG,
  HeadlessSupervisorConfig,
  planSupervisorAttempt,
} from "./agent-work-supervisor.js";
export {
  AgentWorkFanoutService,
  STRICT_FANIN_POLICY_ID,
  STRICT_FANIN_POLICY_VERSION,
} from "./agent-work-fanout-service.js";
export type {
  AgentWorkFanInResult,
  CreateAgentWorkFanoutInput,
  DecideAgentWorkFanInInput,
} from "./agent-work-fanout-service.js";
export {
  executeAgentWorkPreparation,
  orderAgentWorkPreparationSteps,
} from "./agent-work-preparation-service.js";
export type {
  AgentWorkPreparationCommandResult,
  AgentWorkPreparationCommandRunner,
  AgentWorkPreparationResult,
  ExecuteAgentWorkPreparationInput,
} from "./agent-work-preparation-service.js";
export type {
  HeadlessSupervisorConfig as HeadlessSupervisorConfiguration,
  HeadlessSupervisorWorkerControl,
  HeadlessSupervisorWorkspaceObserver,
  ReconcileHeadlessRunInput,
  ReconcileHeadlessRunResult,
  SupervisorAttemptAction,
  SupervisorAttemptPlan,
  SupervisorAttemptResult,
  SupervisorAttemptSnapshot,
  SupervisorWorkerLaunchResult,
  SupervisorWorkerObservation,
} from "./agent-work-supervisor.js";
export type {
  WorkerAdapterManifest_v1 as WorkerAdapterManifest,
  WorkerAdapterNegotiationDimension,
  WorkerAdapterNegotiationResult,
  WorkerAdapterSelection_v1 as WorkerAdapterSelection,
  WorkerRuntimeAdapter,
  WorkerRuntimeArtifact,
  WorkerRuntimePort,
  WorkerRuntimeSignal,
} from "./agent-work-worker-runtime.js";
export * from "./governed-attempt-protocol.js";
export * from "./governed-task.js";
export * from "./governed-review-task-profile.js";
export * from "./governed-workspace-mutation-task-profile.js";
export * from "./governed-attempt-executor.js";
export * from "./governed-attempt-evidence.js";
export * from "./governed-attempt-async-supervisor.js";
export * from "./qualified-wsl2-codex-executor.js";
export * from "./external-wsl2-codex-provider-bridge.js";
export * from "./governed-attempt-operation-adapters.js";
export * from "./governed-attempt-operation-service.js";
export * from "./governed-attempt-verification.js";
export * from "./governed-attempt-independent-verifier.js";
export * from "./governed-attempt-verification-service.js";
export * from "./governed-attempt-verification-adapters.js";
export * from "./governed-review-runtime.js";
export * from "./governed-review-repository-corpus.js";
export * from "./external-wsl2-repository-corpus-source.js";
export * from "./governed-review-persistent-supervisor.js";
export * from "./governed-review-runtime-adapters.js";
export * from "./governed-delegation-service.js";
export * from "./governed-delegation-adapters.js";
export * from "./attempt-awaitable-contract.js";
export * from "./attempt-awaitable-supervisor.js";
export * from "./axf-attempt-awaitable-observer.js";
export {
  AttemptReceiptStatusRequestJsonSchema,
  AttemptReceiptStatusRequestSchema,
  AttemptReceiptSubmitRequestJsonSchema,
  AttemptReceiptSubmitRequestSchema,
  createAttemptReceiptHandlers,
} from "./agent-work-attempt-receipt-adapters.js";
export type { AttemptReceiptHandlers } from "./agent-work-attempt-receipt-adapters.js";
export { AgentWorkAttemptReceiptService } from "./agent-work-attempt-receipt-service.js";
export type {
  AttemptReceiptSubmissionAcknowledgement,
  AttemptReceiptStatusProjection,
  AttemptReceiptStatusResult,
} from "./agent-work-attempt-receipt-service.js";
export {
  AttemptAcceptanceApplyRequestJsonSchema,
  AttemptAcceptanceApplyRequestSchema,
  AttemptAcceptanceStatusRequestJsonSchema,
  AttemptAcceptanceStatusRequestSchema,
  AttemptVerificationRunRequestJsonSchema,
  AttemptVerificationRunRequestSchema,
  AttemptVerificationStatusRequestJsonSchema,
  AttemptVerificationStatusRequestSchema,
  createAttemptVerificationHandlers,
} from "./agent-work-attempt-verification-adapters.js";
export type {
  AttemptVerificationHandlerOptions,
  AttemptVerificationHandlers,
} from "./agent-work-attempt-verification-adapters.js";
export {
  AgentWorkAttemptAcceptanceService,
  AgentWorkAttemptVerificationService,
  ATTEMPT_VERIFIER_ID,
  ATTEMPT_VERIFIER_VERSION,
} from "./agent-work-attempt-verification-service.js";
export type {
  ApplyAttemptAcceptanceRequest,
  AttemptAcceptanceResult,
  AttemptAcceptanceStatusResult,
  AttemptVerificationRunResult,
  AttemptVerificationStatusResult,
  RunAttemptVerificationInput,
} from "./agent-work-attempt-verification-service.js";
export { LocalAttemptVerificationRuntime } from "./agent-work-attempt-verification-runtime.js";
export type {
  AttemptVerificationRuntime,
  VerificationCommandFailureKind,
  VerificationCommandResult,
  VerificationWorkspaceObservation,
} from "./agent-work-attempt-verification-runtime.js";
export {
  AgentWorkAuthorityService,
  classifyWorkerAuthorityAction,
  LocalWorkerAuthorityCommandExecutor,
  WorkerAuthorityCommandBroker,
  WORKER_AUTHORITY_BROKER_ID,
  WORKER_AUTHORITY_BROKER_VERSION,
} from "./agent-work-authority-service.js";
export type {
  ClassifiedWorkerAuthorityAction,
  WorkerAuthorityAuthorizationResult,
  WorkerAuthorityBinding,
  WorkerAuthorityCommandExecutor,
} from "./agent-work-authority-service.js";
export {
  AgentWorkRuntimeConfigSchema,
  createAgentWorkRuntime,
  openAgentWorkRuntime,
} from "./agent-work-runtime.js";
export type { AgentWorkRuntime, AgentWorkRuntimeConfig } from "./agent-work-runtime.js";
export type {
  RunProjection,
  ProcedureResolver,
  CoordinatedRunManagerOptions,
  AcquireCoordinatedRunInput,
  RenewCoordinatedRunInput,
  AdvanceCoordinatedRunInput,
  ProjectionResult,
  AdvanceCoordinatedRunResult,
  RebuildProjectionResult,
} from "./coordinated-manager.js";

// Enforcement
export {
  ViolationType,
  ViolationSeverity,
  EnforcementMode,
  ViolationEntrySchema,
  DEFAULT_ENFORCEMENT_CONFIG,
  requiresEnforcement,
  detectGitViolation,
  detectGhViolation,
  detectCiConfigViolation,
  getViolationSeverity,
  logViolation,
  getViolations,
  countViolationsBySeverity,
  generateViolationRiskFlags,
  checkAndLogViolation,
} from "./enforcement.js";

export type { ViolationEntry, EnforcementConfig } from "./enforcement.js";

// Failures - LR-064
export {
  FailureErrorCode,
  isRetryableErrorCode,
  FailureErrorSchema,
  RecommendedActionSchema,
  FailureRecordSchema,
  FailureHandlingPayloadSchema,
  classifyGateError,
  buildRecommendedActions,
  wrapGateFailure,
  logGateFailure,
  getGateFailures,
  toNextOptions,
} from "./failures.js";

export type {
  FailureError,
  RecommendedAction,
  FailureRecord,
  FailureHandlingPayload,
} from "./failures.js";

// Artifacts
export {
  ARTIFACT_TYPES,
  ListArtifactsInputSchema,
  ArtifactDescriptorSchema,
  ListArtifactsOutputSchema,
  getArtifactType,
  matchesPattern,
  listArtifacts,
  getArtifact,
} from "./artifacts.js";

export type {
  ArtifactType,
  ListArtifactsInput,
  ArtifactDescriptor,
  ListArtifactsOutput,
} from "./artifacts.js";

// Decisions - LR-062
export {
  DecisionErrorCodes,
  SubmitDecisionInputSchema,
  SubmitDecisionOutputSchema,
  submitDecision,
  getDecisions,
} from "./decisions.js";

export type { SubmitDecisionInput, SubmitDecisionOutput, DecisionLogEntry } from "./decisions.js";

// Attribution - LR-TSF-001
export type {
  ConstraintSource,
  ConstraintAttribution,
  AttributionLogEntry,
  FrameAttribution,
} from "./attribution.js";

export { AttributionTracker, createAttributionTracker } from "./attribution.js";

// Context - LR-TSF-001
export type { ExecutionContext } from "./context.js";
export { createExecutionContext, logAttribution } from "./context.js";

export {
  materializeAttemptInput,
  SelectedWorkInputJsonSchema,
} from "./selected-work-materialization.js";

export { CodexWorkerDispatcher } from "./codex-worker-dispatch.js";
export type {
  AttachedCodexTransport,
  CodexTurnStartParams,
  CodexWorkerDispatchResult,
  DispatchAttachedCodexWorkerInput,
} from "./codex-worker-dispatch.js";
