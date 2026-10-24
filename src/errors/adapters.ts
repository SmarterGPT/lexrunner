/**
 * AXError Adapters for LexRunner Errors
 *
 * Converts existing LexRunner error types to AX-compliant format
 * with appropriate nextActions for agent recovery.
 *
 * Extends with governance fields for Disciplined Failure pattern:
 * - reversibility: How reversible is the action/error?
 * - confidence: Agent confidence before action
 * - rollbackPath: Instructions for rollback
 *
 * @module errors/adapters
 * @see docs/DISCIPLINED_FAILURE.md
 */

import { createAXError, type AXError } from "@smartergpt/lex/errors";
import { ErrorCodes } from "./index.js";
import type { GovernanceContext, ReversibilityLevel, ConfidenceLevel } from "../receipts/schema.js";

// =============================================================================
// Governance Context Support
// =============================================================================

/**
 * Base governance fields that can be added to any error context
 *
 * @see docs/DISCIPLINED_FAILURE.md
 */
export interface WithGovernance {
  /** How reversible is this action/error condition? */
  reversibility?: ReversibilityLevel;
  /** Rollback instructions (human-readable) */
  rollbackPath?: string;
  /** Actual command to execute for rollback */
  rollbackCommand?: string;
  /** Agent confidence before the action was taken */
  confidence?: ConfidenceLevel;
  /** Source uncertainties that may have contributed */
  uncertaintyNotes?: string[];
}

/**
 * Re-export GovernanceContext for external use
 */
export type { GovernanceContext };

// =============================================================================
// Gate Error Adapters
// =============================================================================

export interface GateFailureContext extends WithGovernance {
  gate: string;
  item?: string;
  pr?: number;
  exitCode?: number;
  artifactPath?: string;
}

/**
 * Create an AXError for a gate failure
 *
 * Gate failures are typically reversible since gates don't mutate state.
 * If no reversibility is specified, defaults to 'reversible'.
 */
export function gateFailedError(ctx: GateFailureContext): AXError {
  const nextActions: string[] = [];

  if (ctx.artifactPath) {
    nextActions.push(`Check gate output in ${ctx.artifactPath}`);
  }

  // Gate-specific suggestions
  switch (ctx.gate) {
    case "lint":
      nextActions.push("Run 'npm run lint' locally to reproduce");
      nextActions.push("Fix lint errors and push again");
      break;
    case "typecheck":
      nextActions.push("Run 'npm run typecheck' locally to reproduce");
      nextActions.push("Fix TypeScript errors and push again");
      break;
    case "test":
      nextActions.push("Run 'npm test' locally to reproduce");
      nextActions.push("Check for flaky tests or missing test fixtures");
      break;
    default:
      nextActions.push(`Run the '${ctx.gate}' gate locally to reproduce`);
  }

  if (nextActions.length === 0) {
    nextActions.push("Review the gate failure output for details");
  }

  return createAXError(
    ErrorCodes.GATE_FAILED,
    `Gate '${ctx.gate}'${ctx.item ? ` failed for ${ctx.item}` : " failed"}`,
    nextActions,
    {
      ...ctx,
      // Default gates to reversible since they don't mutate state
      reversibility: ctx.reversibility ?? "reversible",
    }
  );
}

// =============================================================================
// Merge Error Adapters
// =============================================================================

export interface MergeConflictContext extends WithGovernance {
  item?: string;
  pr?: number;
  files?: string[];
  targetBranch?: string;
}

/**
 * Create an AXError for a merge conflict
 *
 * Merge conflicts are typically reversible via git merge --abort or reset.
 */
export function mergeConflictError(ctx: MergeConflictContext): AXError {
  const nextActions: string[] = ["Resolve conflicts manually in the affected files"];

  if (ctx.targetBranch) {
    nextActions.push(`Rebase ${ctx.item || "the PR"} on ${ctx.targetBranch}`);
  } else {
    nextActions.push("Rebase on the latest target branch");
  }

  if (ctx.files && ctx.files.length > 0) {
    nextActions.push(`Affected files: ${ctx.files.join(", ")}`);
  }

  return createAXError(
    ErrorCodes.MERGE_CONFLICT,
    `Merge conflict${ctx.item ? ` for ${ctx.item}` : ""}`,
    nextActions,
    {
      ...ctx,
      // Merges are reversible via git reset or merge --abort
      reversibility: ctx.reversibility ?? "reversible",
      rollbackPath: ctx.rollbackPath ?? "git merge --abort or git reset --hard HEAD~1",
    }
  );
}

export interface CycleDetectedContext {
  cycle: string[];
}

/**
 * Create an AXError for a cycle in the dependency graph
 */
export function cycleDetectedError(ctx: CycleDetectedContext): AXError {
  return createAXError(
    ErrorCodes.PLAN_CYCLE_DETECTED,
    `Dependency cycle detected: ${ctx.cycle.join(" → ")}`,
    [
      "Review the dependency declarations in the affected PRs",
      "Remove or restructure dependencies to break the cycle",
      `Cycle path: ${ctx.cycle.join(" → ")}`,
    ],
    { ...ctx }
  );
}

export interface UnknownDependencyContext {
  item: string;
  dependency: string;
  availableItems?: string[];
}

/**
 * Create an AXError for an unknown dependency
 */
export function unknownDependencyError(ctx: UnknownDependencyContext): AXError {
  const nextActions: string[] = [
    `Check that '${ctx.dependency}' is included in the plan`,
    `Verify the dependency reference in '${ctx.item}'`,
  ];

  if (ctx.availableItems && ctx.availableItems.length > 0) {
    nextActions.push(`Available items: ${ctx.availableItems.join(", ")}`);
  }

  return createAXError(
    ErrorCodes.UNKNOWN_DEPENDENCY,
    `Item '${ctx.item}' depends on unknown item '${ctx.dependency}'`,
    nextActions,
    { ...ctx }
  );
}

// =============================================================================
// GitHub Error Adapters
// =============================================================================

export interface GitHubErrorContext {
  status?: number;
  endpoint?: string;
  message?: string;
  retryAfter?: number;
}

/**
 * Create an AXError for GitHub API errors
 */
export function githubApiError(ctx: GitHubErrorContext): AXError {
  const nextActions: string[] = [];

  if (ctx.status === 401 || ctx.status === 403) {
    return createAXError(
      ErrorCodes.GITHUB_AUTH_ERROR,
      ctx.message || "GitHub authentication failed",
      [
        "Check that GITHUB_TOKEN is set and valid",
        "Verify the token has required permissions",
        "Try: gh auth status",
      ],
      { ...ctx }
    );
  }

  if (ctx.status === 429 || ctx.retryAfter) {
    const waitTime = ctx.retryAfter ? `${ctx.retryAfter} seconds` : "a few minutes";
    return createAXError(
      ErrorCodes.GITHUB_RATE_LIMIT,
      "GitHub API rate limit exceeded",
      [
        `Wait ${waitTime} before retrying`,
        "Consider using a GitHub App token for higher limits",
        "Reduce API call frequency",
      ],
      { ...ctx }
    );
  }

  nextActions.push("Check the GitHub API status page");
  if (ctx.endpoint) {
    nextActions.push(`Failed endpoint: ${ctx.endpoint}`);
  }
  nextActions.push("Retry the operation after a brief wait");

  return createAXError(
    ErrorCodes.GITHUB_API_ERROR,
    ctx.message || "GitHub API request failed",
    nextActions,
    { ...ctx }
  );
}

// =============================================================================
// Git Operation Error Adapters
// =============================================================================

export interface GitOperationContext {
  operation: string;
  message?: string;
  command?: string;
}

/**
 * Create an AXError for git operation failures
 */
export function gitOperationError(ctx: GitOperationContext): AXError {
  return createAXError(
    ErrorCodes.GIT_OPERATION_FAILED,
    ctx.message || `Git ${ctx.operation} failed`,
    [
      "Check git status for uncommitted changes",
      "Ensure you're on the correct branch",
      ctx.command ? `Command that failed: ${ctx.command}` : "Review git output for details",
    ],
    { ...ctx }
  );
}

// =============================================================================
// Plan Error Adapters
// =============================================================================

export interface PlanValidationContext {
  errors: string[];
  planPath?: string;
  errorCount?: number;
  errorsTruncated?: boolean;
}

/**
 * Create an AXError for plan validation failures
 */
export function planValidationError(ctx: PlanValidationContext): AXError {
  const nextActions: string[] = ["Review the plan file for schema violations"];
  const errorCount = ctx.errorCount ?? ctx.errors.length;

  if (ctx.planPath) {
    nextActions.push(`Plan file: ${ctx.planPath}`);
  }

  if (ctx.errors.length > 0) {
    nextActions.push(`Errors: ${ctx.errors.join("; ")}`);
  }
  if (ctx.errorsTruncated) {
    nextActions.push(
      `Only the first ${ctx.errors.length} of ${errorCount} validation errors are included`
    );
  }

  return createAXError(
    ErrorCodes.PLAN_VALIDATION_FAILED,
    `Plan validation failed with ${errorCount} error(s)`,
    nextActions,
    { ...ctx, errorCount, errorsTruncated: ctx.errorsTruncated ?? false }
  );
}

// =============================================================================
// Generic Error Adapter
// =============================================================================

/**
 * Convert any Error to an AXError with generic recovery suggestions.
 * Use specific adapters when possible for better nextActions.
 */
export function toAXError(
  error: Error,
  code: string = ErrorCodes.INTERNAL_ERROR,
  nextActions?: string[]
): AXError {
  return createAXError(
    code,
    error.message,
    nextActions || ["Review the error details and retry", "Check logs for more context"],
    {
      originalError: error.name,
      stack: error.stack?.split("\n").slice(0, 3),
    }
  );
}

// =============================================================================
// MCP-Specific Error Adapters
// =============================================================================

export interface MCPErrorContext {
  tool: string;
  operation?: string;
  details?: Record<string, unknown>;
}

/**
 * Create an AXError for MCP tool failures.
 * This provides structured errors for MCP clients including AI agents.
 *
 * @param code - Error code (should be from ErrorCodes for type safety, but string is accepted for extensibility)
 * @param message - Human-readable error message
 * @param ctx - MCP error context containing tool name and optional details
 * @param nextActions - Optional array of recovery actions; if not provided, tool-specific defaults are used
 */
export function mcpToolError(
  code: string,
  message: string,
  ctx: MCPErrorContext,
  nextActions?: string[]
): AXError {
  const actions: string[] = nextActions || [];

  // Add tool-specific recovery suggestions if none provided
  if (actions.length === 0) {
    switch (ctx.tool) {
      case "plan.create":
        actions.push("Check if configuration files exist in the profile directory");
        actions.push("Run 'local.init' to create missing configuration");
        break;
      case "gates.run":
        actions.push("Ensure plan.json exists - run 'plan.create' first");
        actions.push("Check gate commands are valid and available");
        break;
      case "merge.apply":
        actions.push("Set ALLOW_MUTATIONS=true to enable merge operations");
        actions.push("Use dryRun=true to preview without mutations");
        break;
      case "discover":
        actions.push("Check GITHUB_TOKEN is set and valid");
        actions.push("Provide owner and repo parameters explicitly");
        break;
      case "status":
        actions.push("Ensure plan.json exists");
        actions.push("Run 'plan.create' to generate a plan");
        break;
      case "merge-order":
        actions.push("Ensure plan.json exists and is valid");
        actions.push("Check for dependency cycles in the plan");
        break;
      default:
        actions.push("Review the error details and retry");
        actions.push("Check MCP server logs for more context");
    }
  }

  return createAXError(code, message, actions, {
    tool: ctx.tool,
    operation: ctx.operation,
    ...ctx.details,
  });
}

/**
 * Create an AXError for plan not found errors
 */
export function planNotFoundError(planFile?: string): AXError {
  return createAXError(
    ErrorCodes.PLAN_NOT_FOUND,
    planFile ? `Plan file not found: ${planFile}` : "No plan found. Run plan.create first.",
    [
      "Run 'plan.create' to generate a plan",
      planFile
        ? `Check if ${planFile} exists and is accessible`
        : "Ensure plan.json exists in the profile runner directory",
    ],
    { planFile }
  );
}

/**
 * Create an AXError for profile not found errors
 */
export function profileNotFoundError(profileDir?: string): AXError {
  return createAXError(
    ErrorCodes.PROFILE_NOT_FOUND,
    profileDir ? `Profile directory not found: ${profileDir}` : "No profile directory found",
    [
      "Run 'local.init' to create a local profile",
      "Set LEX_PR_PROFILE_DIR environment variable",
      "Ensure .smartergpt/ or .smartergpt.local/ exists",
    ],
    { profileDir }
  );
}

/**
 * Create an AXError for configuration errors
 */
export function configInvalidError(message: string, details?: Record<string, unknown>): AXError {
  return createAXError(
    ErrorCodes.CONFIG_INVALID,
    message,
    [
      "Check configuration file syntax",
      "Ensure all required fields are present",
      "Validate against the schema with 'lex-pr schema validate'",
    ],
    details
  );
}

/**
 * Create an AXError for write protection errors
 */
export function writeProtectionError(message: string, operation?: string): AXError {
  return createAXError(
    ErrorCodes.WRITE_PROTECTION_ERROR,
    message,
    [
      "Use a local overlay profile (.smartergpt.local/) for write operations",
      "Set role to 'local' or 'ci' in profile.yml",
      "Run 'local.init' to create a writable profile",
    ],
    { operation }
  );
}

// =============================================================================
// Run Lifecycle Error Adapters
// =============================================================================

export interface RunNotFoundContext {
  runId: string;
}

/**
 * Create an AXError for run not found errors
 */
export function runNotFoundError(ctx: RunNotFoundContext): AXError {
  return createAXError(
    ErrorCodes.RUN_NOT_FOUND,
    `Run not found: ${ctx.runId}`,
    [
      "List available runs with: lex-pr runs list",
      "Check .lexrunner/runs/ directory for artifacts",
    ],
    { runId: ctx.runId }
  );
}

// =============================================================================
// Helper for throwing AXErrors
// =============================================================================

import { AXErrorException } from "@smartergpt/lex/errors";

/**
 * Throw an AXError as an exception
 *
 * @param axError - The AXError to throw
 * @throws AXErrorException with the AXError data
 */
export function throwAXError(axError: AXError): never {
  throw new AXErrorException(axError.code, axError.message, axError.nextActions, axError.context);
}

// =============================================================================
// Weave Error Adapters
// =============================================================================

export interface WeaveLockConflictContext extends WithGovernance {
  lockFile?: string;
  expectedVersion?: string;
  actualVersion?: string;
  originalError?: string;
}

/**
 * Create an AXError for weave lock file conflicts
 *
 * Lock conflicts are reversible by removing the stale lock file.
 */
export function weaveLockConflictError(ctx: WeaveLockConflictContext): AXError {
  const nextActions: string[] = [];

  const lockFilePath = ctx.lockFile || "weave-lock.json";
  if (ctx.lockFile) {
    nextActions.push(`Remove stale lock with: rm ${ctx.lockFile}`);
  } else {
    nextActions.push("Remove stale lock file: rm weave-lock.json");
  }

  nextActions.push("Wait for other weave operation to complete");
  nextActions.push("Verify no concurrent weave processes are running");

  return createAXError(
    ErrorCodes.WEAVE_LOCK_CONFLICT,
    ctx.originalError || "Lock file conflict detected",
    nextActions,
    {
      ...ctx,
      reversibility: ctx.reversibility ?? "reversible",
      rollbackPath: ctx.rollbackPath ?? `rm ${lockFilePath}`,
    }
  );
}

export interface WeaveStateInvalidContext extends WithGovernance {
  currentState: string;
  event: string;
  availableEvents?: string[];
}

/**
 * Create an AXError for invalid weave state transitions
 *
 * State errors are reversible by using the 'reset' event.
 */
export function weaveStateInvalidError(ctx: WeaveStateInvalidContext): AXError {
  const nextActions: string[] = [
    `Check current weave state: '${ctx.currentState}'`,
    "Review available transitions for current state",
  ];

  if (ctx.availableEvents && ctx.availableEvents.length > 0) {
    nextActions.push(`Valid events for current state: ${ctx.availableEvents.join(", ")}`);
  }

  nextActions.push("Use 'reset' event to return to idle state if stuck");

  return createAXError(
    ErrorCodes.WEAVE_STATE_INVALID,
    `Invalid transition: cannot apply event '${ctx.event}' in state '${ctx.currentState}'`,
    nextActions,
    {
      ...ctx,
      reversibility: ctx.reversibility ?? "reversible",
      rollbackPath: ctx.rollbackPath ?? "Apply 'reset' event to return to idle state",
    }
  );
}

export interface WeavePreflightFailedContext extends WithGovernance {
  itemBranch: string;
  targetBranch?: string;
  originalError?: string;
}

/**
 * Create an AXError for preflight merge simulation failures
 *
 * Preflight failures are reversible - no state was actually changed.
 */
export function weavePreflightFailedError(ctx: WeavePreflightFailedContext): AXError {
  const nextActions: string[] = [`Verify branch '${ctx.itemBranch}' exists locally or on remote`];

  if (ctx.targetBranch) {
    nextActions.push(`Verify target branch '${ctx.targetBranch}' exists`);
  }

  nextActions.push("Run 'git fetch' to update remote references");
  nextActions.push("Check git repository status with 'git status'");

  return createAXError(
    ErrorCodes.WEAVE_PREFLIGHT_FAILED,
    `Failed to simulate merge for ${ctx.itemBranch}${
      ctx.originalError ? `: ${ctx.originalError}` : ""
    }`,
    nextActions,
    {
      ...ctx,
      // Preflight doesn't change state, so always reversible
      reversibility: ctx.reversibility ?? "reversible",
    }
  );
}

// =============================================================================
// Security Error Adapters
// =============================================================================

export interface SecurityAuthContext {
  method?: string;
  user?: string;
  reason?: string;
}

/**
 * Create an AXError for authentication failures
 */
export function securityAuthFailedError(message: string, ctx?: SecurityAuthContext): AXError {
  return createAXError(
    ErrorCodes.SECURITY_AUTH_FAILED,
    message,
    [
      "Check that GITHUB_TOKEN is set and valid",
      "Verify the token has required permissions",
      "Try: gh auth status",
    ],
    { ...ctx }
  );
}

export interface SecurityUnauthorizedContext {
  user?: string;
  permission?: string;
  roles?: string[];
  level?: number;
  maxLevel?: number;
}

/**
 * Create an AXError for authorization failures
 */
export function securityUnauthorizedError(
  message: string,
  ctx?: SecurityUnauthorizedContext
): AXError {
  const nextActions: string[] = [];

  if (ctx?.permission) {
    nextActions.push(`Request '${ctx.permission}' permission from an administrator`);
  }

  if (ctx?.roles && ctx.roles.length > 0) {
    nextActions.push(`Current roles: ${ctx.roles.join(", ")}`);
  }

  if (ctx?.level !== undefined && ctx?.maxLevel !== undefined) {
    nextActions.push(`Maximum allowed level: ${ctx.maxLevel}`);
  }

  if (nextActions.length === 0) {
    nextActions.push("Contact an administrator to request access");
  }

  nextActions.push("Review role definitions in authorization policy");

  return createAXError(ErrorCodes.SECURITY_UNAUTHORIZED, message, nextActions, { ...ctx });
}

export interface SecurityCommandBlockedContext {
  command: string;
  reason:
    | "not_whitelisted"
    | "dangerous_args"
    | "shell_operators"
    | "too_long"
    | "hallucination_threshold";
  hallucinationCount?: number;
  threshold?: number;
}

/**
 * Create an AXError for blocked commands
 */
export function securityCommandBlockedError(
  message: string,
  ctx: SecurityCommandBlockedContext
): AXError {
  const nextActions: string[] = [];

  switch (ctx.reason) {
    case "not_whitelisted":
      nextActions.push("Add command to .smartergpt/allowed-commands.json if legitimate");
      nextActions.push("Verify the command is safe and necessary");
      break;
    case "dangerous_args":
      nextActions.push("Remove dangerous arguments from the command");
      nextActions.push("Review allowed-commands.json deny_args list");
      break;
    case "shell_operators":
      nextActions.push("Shell operators (|, >, <, &&, ||) are not allowed");
      nextActions.push("Split the command into separate operations");
      break;
    case "too_long":
      nextActions.push("Shorten the command to meet the length limit");
      nextActions.push("Consider using configuration files for long arguments");
      break;
    case "hallucination_threshold":
      nextActions.push(`Hallucination threshold (${ctx.threshold}) reached`);
      nextActions.push("Human review required before resuming");
      nextActions.push("Resume with: lex-pr resume --plan plan.json");
      break;
  }

  return createAXError(ErrorCodes.SECURITY_COMMAND_BLOCKED, message, nextActions, { ...ctx });
}

export interface SecurityComplianceViolationContext {
  operation?: string;
  requirement?: string;
}

/**
 * Create an AXError for compliance violations
 */
export function securityComplianceViolationError(
  message: string,
  ctx?: SecurityComplianceViolationContext
): AXError {
  return createAXError(
    ErrorCodes.SECURITY_COMPLIANCE_VIOLATION,
    message,
    [
      "Review the compliance requirement documentation",
      "Ensure signing key is configured if required",
      "Contact security team for guidance",
    ],
    { ...ctx }
  );
}

export interface SecuritySecretDetectedContext {
  secretId?: string;
  location?: string;
}

/**
 * Create an AXError for detected secrets
 */
export function securitySecretDetectedError(
  message: string,
  ctx?: SecuritySecretDetectedContext
): AXError {
  return createAXError(
    ErrorCodes.SECURITY_SECRET_DETECTED,
    message,
    [
      "Remove or rotate the exposed secret immediately",
      "Use environment variables or a secrets manager instead",
      "Never commit secrets to source control",
    ],
    { ...ctx }
  );
}

export interface SecuritySecretNotFoundContext {
  secretId?: string;
  source?: string;
}

/**
 * Create an AXError for missing required secrets
 */
export function securitySecretNotFoundError(
  message: string,
  ctx?: SecuritySecretNotFoundContext
): AXError {
  const nextActions: string[] = [];

  if (ctx?.secretId) {
    nextActions.push(`Set the '${ctx.secretId}' secret in your environment or secrets manager`);
  }

  nextActions.push("Check that required environment variables are configured");
  nextActions.push("Verify your secrets manager connection if using one");
  nextActions.push("Review the secrets configuration documentation");

  return createAXError(ErrorCodes.SECURITY_SECRET_NOT_FOUND, message, nextActions, { ...ctx });
}

export interface SecuritySarifParseErrorContext {
  parseError?: string;
}

/**
 * Create an AXError for SARIF parsing failures
 */
export function securitySarifParseError(
  message: string,
  ctx?: SecuritySarifParseErrorContext
): AXError {
  return createAXError(
    ErrorCodes.SECURITY_SARIF_PARSE_ERROR,
    message,
    [
      "Verify the SARIF file is valid JSON",
      "Ensure the file follows SARIF 2.1.0 specification",
      "Check scanner configuration for correct output format",
    ],
    { ...ctx }
  );
}

export interface SecurityScanFailedContext {
  scanner?: string;
  directory?: string;
  originalError?: string;
}

/**
 * Create an AXError for security scan failures
 */
export function securityScanFailedError(message: string, ctx?: SecurityScanFailedContext): AXError {
  const nextActions: string[] = [];

  if (ctx?.scanner === "npm-audit") {
    nextActions.push("Run 'npm audit' locally to reproduce");
    nextActions.push("Check if package-lock.json is up to date");
  } else {
    nextActions.push("Verify the scanner is installed and configured correctly");
  }

  if (ctx?.directory) {
    nextActions.push(`Check that directory exists: ${ctx.directory}`);
  }

  nextActions.push("Review scanner logs for more details");

  return createAXError(ErrorCodes.SECURITY_SCAN_FAILED, message, nextActions, { ...ctx });
}

// =============================================================================
// Tool Budget Error Adapters
// =============================================================================

export interface ToolBudgetExceededContext {
  tool?: string;
  violation: "tool_denied" | "tool_not_allowed" | "max_calls_exceeded" | "max_tokens_exceeded";
  limit?: number;
  current?: number;
  allowed?: string[];
  denied?: string[];
}

/**
 * Create an AXError for tool budget violations
 */
export function toolBudgetExceededError(message: string, ctx: ToolBudgetExceededContext): AXError {
  const nextActions: string[] = [];

  switch (ctx.violation) {
    case "tool_denied":
      nextActions.push(`Tool '${ctx.tool}' is explicitly denied in the executor's tool budget`);
      nextActions.push("Review the executor manifest's toolBudget.denied list");
      if (ctx.denied && ctx.denied.length > 0) {
        nextActions.push(`Denied tools: ${ctx.denied.join(", ")}`);
      }
      break;
    case "tool_not_allowed":
      nextActions.push(`Tool '${ctx.tool}' is not in the executor's allowed tool list`);
      nextActions.push("Add the tool to toolBudget.allowed in the executor manifest");
      if (ctx.allowed && ctx.allowed.length > 0) {
        nextActions.push(`Allowed tools: ${ctx.allowed.join(", ")}`);
      }
      break;
    case "max_calls_exceeded":
      nextActions.push(`Maximum tool calls limit (${ctx.limit}) has been reached`);
      nextActions.push(`Current calls: ${ctx.current}`);
      nextActions.push("Increase toolBudget.limits.maxToolCalls in the executor manifest");
      break;
    case "max_tokens_exceeded":
      nextActions.push(`Maximum token output limit (${ctx.limit}) would be exceeded`);
      nextActions.push(`Current tokens: ${ctx.current}`);
      nextActions.push("Increase toolBudget.limits.maxTokensOut in the executor manifest");
      break;
  }

  return createAXError(ErrorCodes.TOOL_BUDGET_EXCEEDED, message, nextActions, { ...ctx });
}
