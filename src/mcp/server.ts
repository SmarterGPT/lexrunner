#!/usr/bin/env node

/**
 * MCP server adapter for lexrunner
 * Exposes read-only tools for plan creation, gate execution, and merge operations
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import packageMetadata from "../../package.json" with { type: "json" };

import { loadInputs, detectGitHubMode } from "../core/inputs.js";
import { generateSnapshot, generateGitHubSnapshot } from "../core/snapshot.js";
import { canonicalJSONStringify } from "../util/canonicalJson.js";
import {
  GateExecutionService,
  GateExecutionServiceError,
} from "../application/gate-execution-service.js";
import { GateEvidenceServiceError } from "../application/gate-evidence-service.js";
import {
  GateOperationService,
  GateOperationStartArgs,
  GateOperationObserveArgs,
  GateOperationStatusArgs,
  GateOperationStartJsonSchema,
  GateOperationObserveJsonSchema,
  GateOperationStatusJsonSchema,
} from "../application/gate-operation-service.js";
import { resolveGateRepositoryRoot } from "../application/gate-candidate-identity.js";
import {
  DiscoveryQueryService,
  IntegrationQueryServiceError,
  IntegrationStatusQueryService,
  MergeOrderQueryService,
  PlanCreationService,
} from "../application/integration-query-services.js";
import {
  MergeApplicationService,
  MergeApplicationServiceError,
} from "../application/merge-application-service.js";
import {
  PlanArtifactService,
  PlanArtifactServiceError,
} from "../application/plan-artifact-service.js";
import {
  ConfigurationQueryService,
  WorkspaceConfigServiceError,
  WorkspaceDiagnosticsService,
  WorkspaceInitializationService,
} from "../application/workspace-config-services.js";
import { ExecutionState } from "../executionState.js";
import { MergeEligibilityEvaluator } from "../mergeEligibility.js";
import { computeMergeOrder, CycleError, UnknownDependencyError } from "../mergeOrder.js";
import {
  asPlanValidationFailure,
  formatPlanValidationFailure,
  loadPlan,
  SchemaValidationError,
  validatePlan,
} from "../schema.js";
import { createGitHubClient } from "../github/index.js";
import { createGitHubAPI, GitHubAPI, GitHubAPIError } from "../github/api.js";
import { createGitOperations } from "../git/operations.js";
import {
  getMCPEnvironment,
  PlanCreateArgs,
  GatesRunArgs,
  MergeApplyArgs,
  InitLocalArgs,
  ProfileResolveArgs,
  PlanCreateResult,
  GatesRunResult,
  InitLocalResult,
  ProfileResolveResult,
  WorkflowGuideArgs,
  PrListArgs,
  PrListResult,
  PlanValidateArgs,
  PlanValidateResult,
  PlanAnalyzeArgs,
  PlanAnalyzeResult,
  CreateTaskSnapshotArgs,
  SubmitTaskReceiptArgs,
  GetTaskStatusArgs,
  ListPendingTasksArgs,
  CreateTaskSnapshotResult,
  SubmitTaskReceiptResult,
  GetTaskStatusResult,
  ListPendingTasksResult,
  FanoutHarvestArgs,
  FanoutAnalyzeArgs,
  FanoutHarvestResult,
  FanoutAnalyzeResult,
  StatusArgs,
} from "./types.js";
import {
  resolveProfile,
  validateWriteOperation,
  WriteProtectionError,
} from "../config/profileResolver.js";
import { getCIMutationPolicy, validateCIEnvironment } from "../util/envUtils.js";

// Governance metrics imports
import { getGlobalMetricsCollector, METRIC_DEFINITIONS } from "../metrics/export.js";

// AXError imports for structured error responses
import {
  type AXError,
  mcpToolError,
  planNotFoundError,
  writeProtectionError,
  githubApiError,
  toAXError,
  ErrorCodes,
  cycleDetectedError,
  unknownDependencyError,
  AXErrorException,
  isAXErrorException,
  type CycleDetectedContext,
  type UnknownDependencyContext,
} from "../errors/index.js";

import * as fs from "fs";
import * as path from "path";

// Hostility scoring imports
import { runEnvironmentQualityCheck } from "../hostility/index.js";

// Governance integration imports
import { buildGovernanceStatus, governanceStatusToJSON } from "../governance/index.js";

// Tier metrics imports
import { suggestTiersForPlan, calculateTierMetrics } from "../tiers/index.js";

// Senior Dev executor imports
import {
  prepareReviewContext,
  recallSeniorDevContext,
  captureSeniorDevFrame,
  EXECUTOR_MODES,
} from "../executors/seniorDev/index.js";
import type {
  PrepareContextInput,
  RecallContextInput,
  CaptureFrameInput,
  RecallQueryType,
  Severity,
} from "../executors/seniorDev/index.js";

// Run manager imports
import {
  createRunManager,
  StartRunInput,
  StartRunInputSchema,
  GetStatusInput,
  GetStatusInputSchema,
  RunNotFoundError,
  SubmitDecisionInput,
  SubmitDecisionInputSchema,
  submitDecision,
} from "../runs/index.js";

// RunStore imports
import { createRunStore, type RunStore, type ListRunsOptions } from "../store/index.js";
import { ulid } from "ulid";
import * as crypto from "crypto";

// Workflow guidance imports
import { createWorkflowGuide, type WorkflowPhase } from "./workflow/state-machine.js";
import type { WorkflowGuide } from "./types/guided-response.js";

// Task Snapshot Contract imports (ADR-007)
import { SnapshotBuilder } from "../snapshot/index.js";
import { EngineVerifier } from "../verification/index.js";
import { parseTaskReceipt, TaskSnapshot_v1, TaskReceipt_v1 } from "../schemas/task-contract.js";

// =============================================================================
// AXError MCP Helper
// =============================================================================

/**
 * Create an McpError with AXError-structured content in the message.
 *
 * Per AX-CONTRACT.md v0.1, Guarantee 2.3: All MCP tool failures should
 * return structured errors that agents can parse for recovery actions.
 *
 * The error message is JSON-serialized AXError for machine readability,
 * while remaining compatible with MCP's error format.
 */
function throwMcpAXError(mcpErrorCode: ErrorCode, axError: AXError): never {
  // Serialize the AXError as JSON in the message for structured parsing
  const structuredMessage = JSON.stringify(axError);
  throw new McpError(mcpErrorCode, structuredMessage);
}

/**
 * Create an McpError from a caught error, converting to AXError format.
 *
 * @param mcpErrorCode - The MCP error code to use (e.g., ErrorCode.InternalError)
 * @param tool - The MCP tool name
 * @param error - The caught error
 * @param operation - Optional operation description
 * @param axErrorCode - Optional AXError code (defaults to INTERNAL_ERROR)
 */
function throwMcpToolError(
  mcpErrorCode: ErrorCode,
  tool: string,
  error: unknown,
  operation?: string,
  axErrorCode: string = ErrorCodes.INTERNAL_ERROR
): never {
  const message = error instanceof Error ? error.message : String(error);
  const axError = mcpToolError(axErrorCode, `${tool} failed: ${message}`, {
    tool,
    operation,
  });
  throwMcpAXError(mcpErrorCode, axError);
}

type McpTextToolResult = { content: [{ type: "text"; text: string }] };

function planValidationToolResult(error: unknown): McpTextToolResult | undefined {
  const failure = asPlanValidationFailure(error);
  if (!failure) return undefined;

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(failure, null, 2),
      },
    ],
  };
}

function throwPlanArtifactError(tool: string, error: PlanArtifactServiceError): never {
  throwMcpAXError(
    error.code === "PLAN_UNREADABLE" ? ErrorCode.InternalError : ErrorCode.InvalidParams,
    mcpToolError(error.code, error.message, {
      tool,
      operation: "resolve plan artifact",
      details: error.source ? { source: error.source } : undefined,
    })
  );
}

/**
 * Options for creating the MCP server.
 */
export interface McpServerOptions {
  /**
   * RunStore instance for persisting run lifecycle data.
   * If not provided, a default SqliteRunStore will be created.
   */
  runStore?: RunStore;
}

/**
 * Input schema for lexrunner.listRuns tool
 */
const ListRunsInputSchema = z.object({
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
  state: z.enum(["pending", "running", "completed", "failed", "aborted"]).optional(),
});
type ListRunsInput = z.infer<typeof ListRunsInputSchema>;

/**
 * Create and configure the MCP server
 */
function createServer(options?: McpServerOptions): Server {
  // Initialize RunStore (use provided or create default)
  const runStore = options?.runStore ?? createRunStore();
  const server = new Server(
    {
      name: "lexrunner",
      version: packageMetadata.version,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "plan_create",
          description:
            "Create a plan from configuration files or auto-discover from GitHub PRs. Requires GITHUB_TOKEN environment variable when using fromGithub mode.",
          inputSchema: {
            type: "object",
            properties: {
              json: {
                type: "boolean",
                description: "Output plan as JSON to stdout",
                default: false,
              },
              outDir: {
                type: "string",
                description: "Output directory for plan artifacts",
              },
              fromGithub: {
                type: "boolean",
                description: "Auto-discover PRs from GitHub API",
                default: false,
              },
              query: {
                type: "string",
                description: "GitHub search query (e.g., 'is:open label:stack:*')",
              },
              labels: {
                type: "array",
                description: "Filter PRs by labels",
                items: {
                  type: "string",
                },
              },
              includeDrafts: {
                type: "boolean",
                description: "Include draft PRs in the plan",
                default: true,
              },
              excludePRs: {
                type: "array",
                description: "Exclude specific PRs by number",
                items: {
                  type: "number",
                },
              },
              githubToken: {
                type: "string",
                description: "GitHub API token (or use GITHUB_TOKEN env var)",
              },
              owner: {
                type: "string",
                description: "GitHub repository owner (auto-detected from git remote)",
              },
              repo: {
                type: "string",
                description: "GitHub repository name (auto-detected from git remote)",
              },
              repos: {
                type: "array",
                description:
                  "Multi-repo mode: array of repositories to discover PRs from. Overrides owner/repo if provided.",
                items: {
                  type: "object",
                  properties: {
                    owner: { type: "string", description: "Repository owner" },
                    repo: { type: "string", description: "Repository name" },
                    priority: {
                      type: "number",
                      description: "Priority for merge ordering (default: 1, lower = earlier)",
                    },
                  },
                  required: ["owner", "repo"],
                },
              },
              requiredGates: {
                type: "array",
                description: "List of required gates (default: lint,typecheck,test)",
                items: {
                  type: "string",
                },
              },
              maxWorkers: {
                type: "number",
                description: "Maximum parallel workers for execution (default: 2)",
              },
              target: {
                type: "string",
                description: "Target branch for merging PRs (default: repo default branch)",
              },
            },
          },
        },
        {
          name: "pr_list",
          description:
            "List pull requests from GitHub without creating a plan. Useful for discovering PRs before plan generation.",
          inputSchema: {
            type: "object",
            properties: {
              owner: {
                type: "string",
                description:
                  "GitHub repository owner (auto-detected from git remote if not provided)",
              },
              repo: {
                type: "string",
                description:
                  "GitHub repository name (auto-detected from git remote if not provided)",
              },
              query: {
                type: "string",
                description: "GitHub search query (e.g., 'is:open label:stack:*')",
              },
              labels: {
                type: "array",
                description: "Filter PRs by labels",
                items: {
                  type: "string",
                },
              },
              includeDrafts: {
                type: "boolean",
                description: "Include draft PRs in results",
                default: true,
              },
              excludePRs: {
                type: "array",
                description: "Exclude specific PRs by number",
                items: {
                  type: "number",
                },
              },
              githubToken: {
                type: "string",
                description: "GitHub API token (or use GITHUB_TOKEN env var)",
              },
              state: {
                type: "string",
                description: "PR state filter (default: open)",
                enum: ["open", "closed", "all"],
                default: "open",
              },
            },
          },
        },
        {
          name: "plan_validate",
          description:
            "Validate a plan.json file without executing it. Checks schema compliance and logical consistency.",
          inputSchema: {
            type: "object",
            properties: {
              planFile: {
                type: "string",
                description: "Path to plan.json file (default: <profile>/runner/plan.json)",
              },
              planContent: {
                type: "string",
                description: "JSON string of plan content to validate (alternative to planFile)",
              },
            },
          },
        },
        {
          name: "plan_analyze",
          description:
            "Analyze a plan for potential conflicts and dependency issues. Performs dry-run dependency resolution and conflict detection.",
          inputSchema: {
            type: "object",
            properties: {
              planFile: {
                type: "string",
                description: "Path to plan.json file (default: <profile>/runner/plan.json)",
              },
            },
          },
        },
        {
          name: "gates_run",
          description:
            "Execute short gates synchronously; use gates_start for long or reconnectable work",
          inputSchema: {
            type: "object",
            properties: {
              planFile: {
                type: "string",
                description:
                  "Explicit plan.json path (default: repository plan.json, then profile runner fallback)",
              },
              repoRoot: {
                type: "string",
                minLength: 1,
                maxLength: 4096,
                description: "Explicit candidate repository root (default: server startup cwd)",
              },
              onlyItem: {
                type: "string",
                minLength: 1,
                description: "Run gates for specific item only",
              },
              onlyGate: {
                type: "string",
                minLength: 1,
                description: "Run specific gate only",
              },
              outDir: {
                type: "string",
                description: "Output directory for gate results",
              },
              timeoutMs: {
                type: "integer",
                minimum: 1,
                maximum: 86400000,
                description:
                  "Operation-default gate timeout in milliseconds; a plan gate timeoutMs overrides it exactly",
              },
            },
          },
        },
        {
          name: "gates_start",
          description:
            "Start durable gate execution; reuse the same idempotency key after a lost acknowledgement",
          inputSchema: { ...GateOperationStartJsonSchema, type: "object" },
        },
        {
          name: "gates_status",
          description:
            "Observe one explicit gate operation without restarting commands or granting merge authority",
          inputSchema: { ...GateOperationStatusJsonSchema, type: "object" },
        },
        {
          name: "gates_cancel",
          description:
            "Request cancellation after active gates settle; stops future command admission",
          inputSchema: { ...GateOperationObserveJsonSchema, type: "object" },
        },
        {
          name: "merge_apply",
          description: "Apply merge operations (requires ALLOW_MUTATIONS=true)",
          inputSchema: {
            type: "object",
            properties: {
              planFile: {
                type: "string",
                description:
                  "Explicit plan.json path (default: repository plan.json, then profile runner fallback)",
              },
              dryRun: {
                type: "boolean",
                description: "Simulate merge without making changes",
                default: true,
              },
            },
          },
        },
        {
          name: "local_init",
          description:
            "Initialize local overlay directory with auto-detected project configuration",
          inputSchema: {
            type: "object",
            properties: {
              force: {
                type: "boolean",
                description: "Force recreation even if local overlay exists",
                default: false,
              },
            },
          },
        },
        {
          name: "profile_resolve",
          description:
            "Resolve profile directory using precedence chain (--profile-dir → LEX_PR_PROFILE_DIR → .smartergpt.local/ → .smartergpt/)",
          inputSchema: {
            type: "object",
            properties: {
              profileDir: {
                type: "string",
                description: "Optional profile directory override",
              },
            },
          },
        },
        {
          name: "health",
          description:
            "DEPRECATED: use doctor. Compatibility alias scheduled for removal in 3.0.0.",
          inputSchema: {
            type: "object",
            properties: {
              includeMetrics: {
                type: "boolean",
                description: "Include detailed metrics in response",
                default: false,
              },
            },
          },
        },
        // ─────────────────────────────────────────────────────────────────
        // Senior Dev Executor Tools
        // ─────────────────────────────────────────────────────────────────
        {
          name: "executor_prepare_context",
          description:
            "Phase 1: Gather deterministic artifacts for code review (lint, typecheck, tests, diff, PR metadata)",
          inputSchema: {
            type: "object",
            properties: {
              pr_number: {
                type: "string",
                description: "PR number to prepare context for",
              },
              base_branch: {
                type: "string",
                description: "Base branch for diff (default: main)",
                default: "main",
              },
              output_dir: {
                type: "string",
                description: "Output directory for artifacts (default: /tmp/senior-dev-review-...)",
              },
              skip_tests: {
                type: "boolean",
                description: "Skip running tests",
                default: false,
              },
              skip_lint: {
                type: "boolean",
                description: "Skip running lint",
                default: false,
              },
              skip_typecheck: {
                type: "boolean",
                description: "Skip running typecheck",
                default: false,
              },
            },
            required: ["pr_number"],
          },
        },
        {
          name: "executor_recall_context",
          description:
            "Phase 1: Recall relevant Frames from Lex memory (module reviews, developer history, patterns). " +
            "This tool delegates to the Lex CLI (`lex recall`) to query the Lex memory system. " +
            "For direct access to Lex memory, use the Lex MCP server's `mcp_lex_frame_recall` tool instead. " +
            "This executor-specific tool provides Senior Dev workflow integration.",
          inputSchema: {
            type: "object",
            properties: {
              query_type: {
                type: "string",
                enum: ["module", "developer", "pattern", "pr"],
                description: "Type of query: module, developer, pattern, or pr",
              },
              query: {
                type: "string",
                description:
                  "Query value (required for module, developer, pr; optional for pattern)",
              },
              limit: {
                type: "number",
                description: "Maximum frames to return (default: 10)",
                default: 10,
              },
            },
            required: ["query_type"],
          },
        },
        {
          name: "executor_capture_frame",
          description: "Phase 4: Capture review session as a Frame in Lex memory (the receipt)",
          inputSchema: {
            type: "object",
            properties: {
              pr_number: {
                type: "string",
                description: "PR number being reviewed",
              },
              module: {
                type: "string",
                description: "Primary module (must match lexmap.policy.json)",
              },
              summary: {
                type: "string",
                description: "One-line summary of review findings",
              },
              next_action: {
                type: "string",
                description: "Follow-up action required",
              },
              developer: {
                type: "string",
                description: "Developer name for tracking (default: unknown)",
                default: "unknown",
              },
              severity: {
                type: "string",
                enum: ["blocker", "must-fix", "should-fix", "nit", "praise", "review"],
                description: "Highest severity level (default: review)",
                default: "review",
              },
              jira: {
                type: "string",
                description: "Jira ticket ID if applicable",
              },
              blockers: {
                type: "array",
                items: { type: "string" },
                description: "List of blockers",
              },
            },
            required: ["pr_number", "module", "summary", "next_action"],
          },
        },
        {
          name: "executor_modes",
          description:
            "List available executor modes (triage, deep_review, pattern_mining, mentorship)",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        // ─────────────────────────────────────────────────────────────────
        // LexRunner Run Management Tools
        // ─────────────────────────────────────────────────────────────────
        {
          name: "start_run",
          description: "Start a new LexRunner procedure run and return a runId",
          inputSchema: {
            type: "object",
            properties: {
              mode: {
                type: "string",
                description: "Persona mode (e.g., 'senior-dev', 'eager-pm')",
              },
              procedure: {
                type: "string",
                description: "Procedure identifier (e.g., 'merge-weave-main', 'pr-review')",
              },
              repo: {
                type: "string",
                description: "Repository in 'owner/repo' format",
              },
              task: {
                type: "string",
                description: "Human-readable task description",
              },
              params: {
                type: "object",
                description: "Procedure-specific parameters",
              },
            },
            required: ["mode", "procedure", "repo"],
          },
        },
        {
          name: "get_status",
          description: "Get current run state, summary, and next available actions",
          inputSchema: {
            type: "object",
            properties: {
              runId: {
                type: "string",
                description: "Unique run identifier",
              },
            },
            required: ["runId"],
          },
        },
        {
          name: "list_artifacts",
          description: "List runs from the store with optional filtering",
          inputSchema: {
            type: "object",
            properties: {
              limit: {
                type: "number",
                description: "Maximum number of runs to return",
              },
              offset: {
                type: "number",
                description: "Number of runs to skip (for pagination)",
              },
              state: {
                type: "string",
                enum: ["pending", "running", "completed", "failed", "aborted"],
                description: "Filter by run state",
              },
            },
          },
        },
        {
          name: "run_decision",
          description: "Submit an LLM decision for a pending action in a run",
          inputSchema: {
            type: "object",
            properties: {
              runId: {
                type: "string",
                description: "Unique run identifier",
              },
              action: {
                type: "string",
                description: "Action to submit (must match a nextOptions[x].action)",
              },
              response: {
                description: "Response data (validated against nextOptions[x].responseSchema)",
              },
              rationale: {
                type: "string",
                description: "Optional rationale for audit trail",
              },
            },
            required: ["runId", "action", "response"],
          },
        },
        // ─────────────────────────────────────────────────────────────────
        // MCP/CLI Parity Tools (AX-004)
        // ─────────────────────────────────────────────────────────────────
        {
          name: "discover",
          description:
            "Discover open pull requests from GitHub with optional dependency suggestions. Requires GITHUB_TOKEN environment variable.",
          inputSchema: {
            type: "object",
            properties: {
              owner: {
                type: "string",
                description: "GitHub repository owner",
              },
              repo: {
                type: "string",
                description: "GitHub repository name",
              },
              state: {
                type: "string",
                enum: ["open", "closed", "all"],
                description: "PR state filter (default: open)",
                default: "open",
              },
              suggest: {
                type: "boolean",
                description: "Generate dependency suggestions using heuristics",
                default: false,
              },
            },
          },
        },
        {
          name: "weave_status",
          description: "Show current execution status and merge eligibility for a plan",
          inputSchema: {
            type: "object",
            properties: {
              planFile: {
                type: "string",
                description:
                  "Explicit plan.json path (default: repository plan.json, then profile runner fallback)",
              },
              repoRoot: {
                type: "string",
                minLength: 1,
                maxLength: 4096,
                description:
                  "Explicit candidate repository root (default: server current directory)",
              },
              evidenceFile: {
                type: "string",
                minLength: 1,
                maxLength: 4096,
                description: "Explicit gate evidence manifest returned by gates_run",
              },
              evidenceSha256: {
                type: "string",
                pattern: "^sha256:[a-f0-9]{64}$",
                description: "Expected SHA-256 returned with the gate evidence manifest",
              },
              verifyArtifacts: {
                type: "boolean",
                description:
                  "Read back referenced artifact bytes; requires explicit evidenceFile and evidenceSha256",
              },
            },
          },
        },
        {
          name: "doctor",
          description:
            "Run environment and configuration sanity checks with optional hostility scoring",
          inputSchema: {
            type: "object",
            properties: {
              environmentQuality: {
                type: "boolean",
                description: "Include environmental hostility scoring in the check",
                default: false,
              },
            },
          },
        },
        {
          name: "merge_order",
          description: "Compute dependency levels and merge order using Kahn's algorithm",
          inputSchema: {
            type: "object",
            properties: {
              planFile: {
                type: "string",
                description:
                  "Explicit plan.json path (default: repository plan.json, then profile runner fallback)",
              },
            },
          },
        },
        {
          name: "config_show",
          description: "Display configuration with precedence chain and provenance",
          inputSchema: {
            type: "object",
            properties: {
              key: {
                type: "string",
                description: "Show specific configuration key",
              },
            },
          },
        },
        // ─────────────────────────────────────────────────────────────────
        // Workflow Guidance Tools (LPR-037)
        // ─────────────────────────────────────────────────────────────────
        {
          name: "workflow_guide",
          description:
            "Get context-aware workflow guidance for the current phase. " +
            "Provides next steps, common issues, and recommendations.",
          inputSchema: {
            type: "object",
            properties: {
              phase: {
                type: "string",
                enum: [
                  "initial",
                  "post-plan-creation",
                  "post-gates-run",
                  "pre-merge",
                  "post-merge",
                  "error-recovery",
                ],
                description: "Current workflow phase to get guidance for",
              },
            },
            required: ["phase"],
          },
        },
        // ─────────────────────────────────────────────────────────────────
        // Governance Metrics Tools (Wave 3)
        // ─────────────────────────────────────────────────────────────────
        {
          name: "metrics",
          description: "Get current governance metrics snapshot for observability dashboards",
          inputSchema: {
            type: "object",
            properties: {
              filter: {
                type: "string",
                description: "Filter metrics by name pattern (e.g., 'turn_cost', 'tier')",
              },
              format: {
                type: "string",
                enum: ["json", "prometheus"],
                description: "Output format (default: json)",
                default: "json",
              },
            },
          },
        },
        // ─────────────────────────────────────────────────────────────────
        // Task Handoff Tools (ADR-007)
        // ─────────────────────────────────────────────────────────────────
        {
          name: "create_task_snapshot",
          description:
            "Create a task snapshot for agent handoff (ADR-007). Prepares work for external agent with failure info, target files, and verification command.",
          inputSchema: {
            type: "object",
            properties: {
              taskId: {
                type: "string",
                description: "Optional task ID (auto-generated if not provided)",
              },
              procedure: {
                type: "string",
                description: "Procedure identifier (e.g., 'post-merge-fix', 'fanout-issue')",
              },
              determinism: {
                type: "string",
                enum: ["D1", "D2", "D3"],
                description: "Determinism level (default: D1)",
                default: "D1",
              },
              failureMessage: {
                type: "string",
                description: "Short error description",
              },
              failureFileRel: {
                type: "string",
                description: "Repo-relative path to failed file",
              },
              failureLine: {
                type: "number",
                description: "Line number if available",
              },
              runnerOutputSnip: {
                type: "string",
                description: "Actual test runner output snippet",
              },
              failureExcerpt: {
                type: "string",
                description: "Code context around failure",
              },
              targetFiles: {
                type: "array",
                items: { type: "string" },
                description: "Repo-relative paths of files to modify",
              },
              verificationCmd: {
                type: "string",
                description: "Command to run for verification",
              },
              expectedExitCode: {
                type: "number",
                description: "Expected exit code (default: 0)",
                default: 0,
              },
              repoRoot: {
                type: "string",
                description: "Absolute path to repo root (auto-detected if not provided)",
              },
              repoId: {
                type: "string",
                description:
                  "Repository identifier in owner/repo format (auto-detected if not provided)",
              },
              commitSha: {
                type: "string",
                description: "Git commit SHA (auto-detected if not provided)",
              },
            },
            required: [
              "procedure",
              "failureMessage",
              "failureFileRel",
              "runnerOutputSnip",
              "targetFiles",
              "verificationCmd",
            ],
          },
        },
        {
          name: "submit_task_receipt",
          description:
            "Submit a task receipt after agent completes work (ADR-007). Returns acknowledgment and engine verification status.",
          inputSchema: {
            type: "object",
            properties: {
              receipt: {
                type: "object",
                description: "TaskReceipt_v1 JSON object",
              },
            },
            required: ["receipt"],
          },
        },
        {
          name: "get_task_status",
          description:
            "Get current task state (ADR-007). Returns snapshot, receipt, and verification info.",
          inputSchema: {
            type: "object",
            properties: {
              taskId: {
                type: "string",
                description: "Unique task identifier",
              },
            },
            required: ["taskId"],
          },
        },
        {
          name: "list_pending_tasks",
          description: "List pending task snapshots (ADR-007). Used by PM agent to see work queue.",
          inputSchema: {
            type: "object",
            properties: {
              procedure: {
                type: "string",
                description: "Filter by procedure identifier",
              },
              determinism: {
                type: "string",
                enum: ["D1", "D2", "D3"],
                description: "Filter by determinism level",
              },
              limit: {
                type: "number",
                description: "Maximum tasks to return",
              },
            },
          },
        },
        // ─────────────────────────────────────────────────────────────────
        // Fanout AX Tools — D0/D1 Pipeline (Epic #654 Layer 2)
        // ─────────────────────────────────────────────────────────────────
        {
          name: "fanout_harvest",
          description:
            "D0: Harvest external state from GitHub into a deterministic, replayable HarvestBundle. " +
            "Fetches PRs, issues, CI status, review status, and pins all SHAs at fetch time. " +
            "Requires GITHUB_TOKEN environment variable.",
          inputSchema: {
            type: "object",
            properties: {
              owner: {
                type: "string",
                description:
                  "GitHub repository owner (auto-detected from git remote if not provided)",
              },
              repo: {
                type: "string",
                description:
                  "GitHub repository name (auto-detected from git remote if not provided)",
              },
              state: {
                type: "string",
                enum: ["open", "closed", "all"],
                description: "PR state filter (default: open)",
                default: "open",
              },
              includeIssues: {
                type: "boolean",
                description: "Include issues in harvest (default: false)",
                default: false,
              },
              maxBody: {
                type: "number",
                description: "Max body length before truncation (default: 4096)",
                default: 4096,
              },
              githubToken: {
                type: "string",
                description: "GitHub API token (or use GITHUB_TOKEN env var)",
              },
            },
          },
        },
        {
          name: "fanout_analyze",
          description:
            "D1: Analyze a HarvestBundle into a deterministic AnalysisPool with evidence IDs. " +
            "Pure computation with no side effects. Same input → identical output. " +
            "Extracts entities, relations, conflicts, and blockers.",
          inputSchema: {
            type: "object",
            properties: {
              harvestBundle: {
                type: "object",
                description: "HarvestBundle JSON object from fanout_harvest (preferred)",
              },
              fromFile: {
                type: "string",
                description:
                  "Path to harvest bundle JSON file (alternative to harvestBundle object)",
              },
            },
          },
        },
      ],
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      // Plan tools
      case "plan_create":
        return await handlePlanCreate(args as PlanCreateArgs);

      case "pr_list":
        return await handlePrList(args as PrListArgs);

      case "plan_validate":
        return await handlePlanValidate(args as PlanValidateArgs);

      case "plan_analyze":
        return await handlePlanAnalyze(args as PlanAnalyzeArgs);

      // Gate tools
      case "gates_run":
        return await handleGatesRun(args as GatesRunArgs);
      case "gates_start":
      case "gates_status":
      case "gates_cancel":
        return await handleGateOperation(name, args);

      // Weave tools
      case "merge_apply":
        return await handleMergeApply(args as MergeApplyArgs);

      case "discover":
        return await handleDiscover(
          args as {
            owner?: string;
            repo?: string;
            state?: string;
            suggest?: boolean;
          }
        );

      case "weave_status":
        return await handleStatus(StatusArgs.parse(args));

      case "merge_order":
        return await handleMergeOrder(args as { planFile?: string });

      // Workspace tools
      case "local_init":
        return await handleLocalInit(args as InitLocalArgs);

      case "profile_resolve":
        return await handleProfileResolve(args as ProfileResolveArgs);

      case "doctor":
        return await handleDoctor(args as { environmentQuality?: boolean });

      // Core tools
      case "health":
        return await handleHealth(args as { includeMetrics?: boolean });

      case "config_show":
        return await handleConfigShow(args as { key?: string });

      case "workflow_guide":
        return await handleWorkflowGuide(args as WorkflowGuideArgs);

      case "metrics":
        return await handleMetrics(args as { filter?: string; format?: string });

      // Executor tools (Senior Dev)
      case "executor_prepare_context":
        return await handleSeniorDevPrepareContext(args as unknown as PrepareContextInput);

      case "executor_recall_context":
        return await handleSeniorDevRecallContext(args as unknown as RecallContextInput);

      case "executor_capture_frame":
        return await handleSeniorDevCaptureFrame(args as unknown as CaptureFrameInput);

      case "executor_modes":
        return await handleSeniorDevModes();

      // Run management tools
      case "start_run":
        return await handleStartRun(args as unknown as StartRunInput, runStore);

      case "get_status":
        return await handleGetStatus(args as unknown as GetStatusInput, runStore);

      case "list_artifacts":
        return await handleListRuns(args as unknown as ListRunsInput, runStore);

      case "run_decision":
        return await handleSubmitDecision(args as unknown as SubmitDecisionInput);

      // Task Handoff tools (ADR-007)
      case "create_task_snapshot":
        return await handleCreateTaskSnapshot(args as unknown as CreateTaskSnapshotArgs);

      case "submit_task_receipt":
        return await handleSubmitTaskReceipt(args as unknown as SubmitTaskReceiptArgs);

      case "get_task_status":
        return await handleGetTaskStatus(args as unknown as GetTaskStatusArgs);

      case "list_pending_tasks":
        return await handleListPendingTasks(args as unknown as ListPendingTasksArgs);

      // Fanout AX tools (Epic #654 Layer 2)
      case "fanout_harvest":
        return await handleFanoutHarvest(args as unknown as FanoutHarvestArgs);

      case "fanout_analyze":
        return await handleFanoutAnalyze(args as unknown as FanoutAnalyzeArgs);

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  });

  return server;
}

/**
 * Check if GitHub token is available and throw helpful error if not
 */
function ensureGitHubToken(providedToken?: string): void {
  const token = providedToken || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

  if (!token) {
    const axError = githubApiError({
      status: 401,
      message:
        "GitHub authentication required. Set GITHUB_TOKEN environment variable.\n" +
        "\n" +
        "To fix:\n" +
        "  export GITHUB_TOKEN=ghp_...\n" +
        "\n" +
        "See: https://github.com/Guffawaffle/lexrunner#authentication",
    });
    throwMcpAXError(ErrorCode.InvalidRequest, axError);
  }
}

/**
 * Handle plan.create tool
 */
async function handlePlanCreate(
  args: PlanCreateArgs
): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    const env = getMCPEnvironment();

    // Resolve profile and validate write permissions
    const resolved = resolveProfile(undefined, process.cwd());
    const profilePath = resolved.path;
    const role = resolved.manifest.role;

    let plan;
    let inputs = null;
    let autoDetectedGitHubMode = false;

    // Auto-detect GitHub mode from scope.yml if fromGithub not explicitly set
    if (!args.fromGithub) {
      const detection = detectGitHubMode(profilePath);
      if (detection.shouldUseGitHub) {
        autoDetectedGitHubMode = true;
        // Merge scope.yml filters with args (args take precedence)
        args.fromGithub = true;
        if (!args.query && detection.scopeConfig?.query) {
          args.query = detection.scopeConfig.query;
        }
        if (
          !args.labels &&
          detection.scopeConfig?.labels &&
          detection.scopeConfig.labels.length > 0
        ) {
          args.labels = detection.scopeConfig.labels;
        }
        if (!args.target && detection.scopeConfig?.target) {
          args.target = detection.scopeConfig.target;
        }

        console.error("[mcp:plan.create] Auto-detected GitHub mode from scope.yml filters");
      }
    }

    if (args.fromGithub) {
      // Check for GitHub authentication before making API calls
      ensureGitHubToken(args.githubToken);

      // Parse required gates if provided
      const requiredGates = args.requiredGates || ["lint", "typecheck", "test"];

      // Parse max workers if provided
      const maxWorkers = args.maxWorkers || 2;

      // Check for multi-repo mode (issue #677)
      if (args.repos && args.repos.length > 0) {
        // Multi-repo mode: discover PRs from multiple repositories
        console.error(`[mcp:plan.create] Multi-repo mode: ${args.repos.length} repositories`);

        plan = await new PlanCreationService().fromMultipleRepositories(args.repos, {
          query: args.query,
          labels: args.labels,
          excludePRs: args.excludePRs,
          includeDrafts: args.includeDrafts,
          target: args.target,
          githubToken: args.githubToken,
          policy: {
            requiredGates,
            maxWorkers,
          },
        });

        // Log discovery results to stderr
        const repoList = args.repos.map((r) => `${r.owner}/${r.repo}`).join(", ");
        const filterInfo = args.labels ? ` labels=${args.labels.join(",")}` : "";
        console.error(
          `[mcp:plan.create] repos=[${repoList}]${filterInfo} discovered=${plan.items.length} PRs`
        );

        if (plan.items.length === 0) {
          console.error(
            `[mcp:plan.create] Warning: No PRs found matching criteria. Check filters and repository state.`
          );
        } else {
          const prNames = plan.items.map((item) => item.name).join(", ");
          console.error(`[mcp:plan.create] PRs included: ${prNames}`);
        }
      } else {
        // Single-repo mode (backward compatible)
        const client = await createGitHubClient({
          token: args.githubToken,
          owner: args.owner,
          repo: args.repo,
        });

        // Generate plan from GitHub
        plan = await new PlanCreationService().fromGitHub(client, {
          query: args.query,
          labels: args.labels,
          excludePRs: args.excludePRs,
          includeDrafts: args.includeDrafts,
          target: args.target,
          policy: {
            requiredGates,
            maxWorkers,
          },
        });

        // Log discovery results to stderr
        const repoDiag = `${client.getOwner()}/${client.getRepo()}`;
        const filterInfo = args.labels ? ` labels=${args.labels.join(",")}` : "";
        const queryInfo = args.query ? ` query="${args.query}"` : "";
        console.error(
          `[mcp:plan.create] repo=${repoDiag}${filterInfo}${queryInfo} discovered=${plan.items.length} PRs`
        );

        if (plan.items.length === 0) {
          console.error(
            `[mcp:plan.create] Warning: No PRs found matching criteria. Check filters and repository state.`
          );
        } else {
          const prNumbers = plan.items.map((item) => item.name).join(", ");
          console.error(`[mcp:plan.create] PRs included: ${prNumbers}`);
        }
      }
    } else {
      // Traditional mode: load from configuration files
      inputs = loadInputs(profilePath);
      plan = new PlanCreationService().fromInputs(inputs);
    }

    // Determine output directory
    const outDir = args.outDir || path.join(profilePath, "runner");

    // Validate write operation is allowed
    validateWriteOperation(profilePath, role, "write plan artifacts");

    // Ensure output directory exists
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    // Write plan.json
    const planPath = path.join(outDir, "plan.json");
    const planJson = canonicalJSONStringify(plan);
    fs.writeFileSync(planPath, planJson + "\n");

    // Generate snapshot - use GitHub snapshot for GitHub mode
    let snapshot: string;
    if (args.fromGithub) {
      snapshot = generateGitHubSnapshot(plan);
    } else {
      // In traditional mode, inputs is guaranteed to be set
      if (!inputs) {
        const axError = mcpToolError(
          ErrorCodes.INTERNAL_ERROR,
          "Internal error: inputs not loaded in traditional mode",
          { tool: "plan.create", operation: "generate snapshot" }
        );
        throwMcpAXError(ErrorCode.InternalError, axError);
      }
      snapshot = generateSnapshot(plan, inputs);
    }
    const snapshotPath = path.join(outDir, "snapshot.md");
    fs.writeFileSync(snapshotPath, snapshot);

    const result: PlanCreateResult = {
      plan: plan,
      outDir: outDir,
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    if (error instanceof WriteProtectionError) {
      const axError = writeProtectionError(error.message, "plan.create");
      throwMcpAXError(ErrorCode.InvalidRequest, axError);
    }
    throwMcpToolError(ErrorCode.InternalError, "plan.create", error, "create plan");
  }
}

/**
 * Handle pr_list tool
 * Lists pull requests from GitHub without creating a plan
 */
async function handlePrList(
  args: PrListArgs
): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    // Check for GitHub authentication early
    ensureGitHubToken(args.githubToken);

    // Create GitHub client
    const client = await createGitHubClient({
      token: args.githubToken,
      owner: args.owner,
      repo: args.repo,
    });

    // Validate repository access
    const repoInfo = await client.validateRepository();

    // Get state parameter (default to "open")
    const state = args.state || "open";

    // Discover PRs based on query/filters
    const prs = await client.listOpenPRs({
      state,
      labels: args.labels,
      ...(args.query ? { query: args.query } : {}),
    });

    // Default behavior: include drafts unless explicitly disabled
    const includeDrafts = args.includeDrafts === undefined ? true : Boolean(args.includeDrafts);
    const filteredPRs = includeDrafts ? prs : prs.filter((pr) => !pr.draft);

    // Exclude specific PRs if requested
    const excludePRs = args.excludePRs || [];
    const finalPRs =
      excludePRs.length > 0
        ? filteredPRs.filter((pr) => !excludePRs.includes(pr.number))
        : filteredPRs;

    // Transform to result format
    const result: PrListResult = {
      pullRequests: finalPRs.map((pr) => ({
        number: pr.number,
        title: pr.title,
        branch: pr.head.ref,
        author: pr.user.login,
        labels: pr.labels.map((l) => l.name),
        sha: pr.head.sha,
        draft: pr.draft,
      })),
      total: prs.length,
      filtered: finalPRs.length,
      owner: client.getOwner(),
      repo: client.getRepo(),
    };

    // Log discovery results to stderr
    const repoDiag = `${client.getOwner()}/${client.getRepo()}`;
    const filterInfo = args.labels ? ` labels=${args.labels.join(",")}` : "";
    const queryInfo = args.query ? ` query="${args.query}"` : "";
    console.error(
      `[mcp:pr_list] repo=${repoDiag}${filterInfo}${queryInfo} found=${result.filtered}/${result.total} PRs`
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    if (error instanceof GitHubAPIError) {
      const axError = githubApiError({
        message: error.message,
      });
      throwMcpAXError(ErrorCode.InternalError, axError);
    }
    throwMcpToolError(ErrorCode.InternalError, "pr_list", error, "list pull requests");
  }
}

/**
 * Handle plan_validate tool
 * Validates a plan.json file for schema compliance and logical consistency
 */
async function handlePlanValidate(
  args: PlanValidateArgs
): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    let planContent: string;
    let planPath: string | undefined;

    // Get plan content either from file or direct content
    if (args.planContent) {
      planContent = args.planContent;
    } else {
      // Resolve plan file path
      if (args.planFile) {
        planPath = args.planFile;
      } else {
        const resolved = resolveProfile(undefined, process.cwd());
        planPath = path.join(resolved.path, "runner", "plan.json");
      }

      // Check if plan file exists
      if (!fs.existsSync(planPath)) {
        throwMcpAXError(ErrorCode.InvalidParams, planNotFoundError(planPath));
      }

      planContent = fs.readFileSync(planPath, "utf-8");
    }

    // Try to validate the plan
    const result: PlanValidateResult = {
      contract: "bounded-ax-v1",
      valid: true,
      warnings: [],
    };

    try {
      const plan = loadPlan(planContent);

      // Basic validation passed
      result.plan = {
        schemaVersion: plan.schemaVersion,
        target: plan.target,
        itemCount: plan.items.length,
      };

      // Additional logical validations
      if (plan.items.length === 0) {
        result.warnings?.push("Plan contains no items");
      }

      // Check for duplicate item names
      const names = new Set<string>();
      const duplicates: string[] = [];
      for (const item of plan.items) {
        if (names.has(item.name)) {
          duplicates.push(item.name);
        }
        names.add(item.name);
      }
      if (duplicates.length > 0) {
        result.valid = false;
        result.code = ErrorCodes.PLAN_VALIDATION_FAILED;
        result.message = "Plan validation failed with 1 error(s)";
        result.errorCount = 1;
        result.errors = [
          {
            path: "items",
            message: "Plan item names must be unique",
            code: "DUPLICATE_NAMES",
          },
        ];
        result.errorsTruncated = false;
        result.nextActions = ["Give each plan item a unique name"];
        result.context = { errorCount: 1, errorsTruncated: false };
      }

      console.error(
        `[mcp:plan_validate] validated plan with ${plan.items.length} items, valid=${result.valid}`
      );
    } catch (error) {
      if (error instanceof SchemaValidationError) {
        Object.assign(result, formatPlanValidationFailure(error));
      } else if (error instanceof AXErrorException) {
        result.valid = false;
        result.code = error.axError.code;
        result.message = error.message;
        result.errorCount = 1;
        result.errors = [
          {
            path: "root",
            message: error.message,
            code: error.axError.code,
          },
        ];
        result.errorsTruncated = false;
        result.nextActions = error.axError.nextActions;
        result.context = { errorCount: 1, errorsTruncated: false };
      } else if (error instanceof Error) {
        result.valid = false;
        result.message = error.message;
        result.errorCount = 1;
        result.errors = [{ path: "root", message: error.message }];
        result.errorsTruncated = false;
        result.context = { errorCount: 1, errorsTruncated: false };
      }

      console.error(`[mcp:plan_validate] validation failed: ${error}`);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    throwMcpToolError(ErrorCode.InternalError, "plan_validate", error, "validate plan");
  }
}

/**
 * Handle plan_analyze tool
 * Analyzes a plan for conflicts and dependency issues (dry-run)
 */
async function handlePlanAnalyze(
  args: PlanAnalyzeArgs
): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    let planPath: string;

    // Resolve plan file path
    if (args.planFile) {
      planPath = args.planFile;
    } else {
      const resolved = resolveProfile(undefined, process.cwd());
      planPath = path.join(resolved.path, "runner", "plan.json");
    }

    // Check if plan file exists
    if (!fs.existsSync(planPath)) {
      throwMcpAXError(ErrorCode.InvalidParams, planNotFoundError(planPath));
    }

    // Load and validate plan
    const planContent = fs.readFileSync(planPath, "utf-8");
    const plan = loadPlan(planContent);

    const result: PlanAnalyzeResult = {
      valid: true,
      conflicts: [],
      dependencies: {
        total: 0,
      },
      summary: {
        totalItems: plan.items.length,
        maxParallelism: 0,
        hasIssues: false,
      },
    };

    // Count dependencies
    for (const item of plan.items) {
      if (item.deps && item.deps.length > 0) {
        result.dependencies!.total += item.deps.length;
      }
    }

    // Try to compute merge order (will detect cycles and unknown deps)
    try {
      const levels = computeMergeOrder(plan);
      result.mergeOrder = levels;
      const levelSizes = levels.map((l) => l.length);
      result.summary.maxParallelism = levelSizes.length > 0 ? Math.max(0, ...levelSizes) : 0;

      console.error(
        `[mcp:plan_analyze] analyzed plan: ${plan.items.length} items, ${levels.length} levels, max parallelism=${result.summary.maxParallelism}`
      );
    } catch (error) {
      result.valid = false;
      result.summary.hasIssues = true;

      if (error instanceof CycleError) {
        const cycle = (error.axError.context as unknown as CycleDetectedContext).cycle;
        result.dependencies!.cycles = [[...cycle]];
        result.conflicts?.push({
          type: "cycle",
          message: `Dependency cycle detected: ${cycle.join(" -> ")}`,
          items: cycle,
        });
        console.error(`[mcp:plan_analyze] cycle detected: ${cycle.join(" -> ")}`);
      } else if (error instanceof UnknownDependencyError) {
        const ctx = error.axError.context as unknown as UnknownDependencyContext;
        result.dependencies!.unknown = [ctx.dependency];
        result.conflicts?.push({
          type: "unknown_dependency",
          message: `Unknown dependency: ${ctx.dependency} referenced by ${ctx.item}`,
          items: [ctx.item, ctx.dependency],
        });
        console.error(`[mcp:plan_analyze] unknown dependency: ${ctx.dependency}`);
      } else {
        result.conflicts?.push({
          type: "analysis_error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    const validationFailure = planValidationToolResult(error);
    if (validationFailure) return validationFailure;

    throwMcpToolError(ErrorCode.InternalError, "plan_analyze", error, "analyze plan");
  }
}

/**
 * Handle gates.run tool
 */
async function handleGatesRun(
  args: GatesRunArgs
): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    const validatedArgs = GatesRunArgs.parse(args);
    const env = getMCPEnvironment();
    const artifact = new PlanArtifactService().resolve({
      planFile: validatedArgs.planFile,
      workingDir: process.cwd(),
      profileDir: env.LEX_PR_PROFILE_DIR,
    });

    // Determine output directory
    const outDir = validatedArgs.outDir || path.join(path.dirname(artifact.filePath), "gates");

    const summary = (
      await new GateExecutionService().run({
        plan: artifact.plan,
        repoRoot: validatedArgs.repoRoot,
        artifactDir: outDir,
        timeoutMs: validatedArgs.timeoutMs,
        onlyItem: validatedArgs.onlyItem,
        onlyGate: validatedArgs.onlyGate,
        options: { emitReceipt: false, suppressStdout: true },
      })
    ).summary;
    const result: GatesRunResult = { ...summary, planArtifact: artifact.identity };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    const validationFailure = planValidationToolResult(error);
    if (validationFailure) return validationFailure;

    if (error instanceof GateExecutionServiceError) {
      throwMcpAXError(
        ErrorCode.InternalError,
        mcpToolError(error.code, error.message, { tool: "gates.run" })
      );
    }
    if (error instanceof PlanArtifactServiceError) {
      throwPlanArtifactError("gates.run", error);
    }
    if (error instanceof McpError) {
      throw error;
    }
    throwMcpToolError(ErrorCode.InternalError, "gates.run", error, "run gates");
  }
}

async function handleGateOperation(name: string, args: unknown) {
  try {
    const service = new GateOperationService();
    const result =
      name === "gates_start"
        ? await service.start(GateOperationStartArgs.parse(args))
        : name === "gates_cancel"
          ? service.cancel(GateOperationObserveArgs.parse(args))
          : service.status(GateOperationStatusArgs.parse(args));
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
      throwMcpAXError(
        ErrorCode.InternalError,
        mcpToolError(error.code, error instanceof Error ? error.message : "Gate operation failed", {
          tool: name,
        })
      );
    }
    throwMcpToolError(ErrorCode.InternalError, name, error, "observe gate operation");
  }
}

/**
 * Handle merge.apply tool
 */
async function handleMergeApply(
  args: MergeApplyArgs
): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    const env = getMCPEnvironment();
    const artifact = new PlanArtifactService().resolve({
      planFile: args.planFile,
      workingDir: process.cwd(),
      profileDir: env.LEX_PR_PROFILE_DIR,
    });

    let allowMutations = false;
    if (args.dryRun === false) {
      const resolved = resolveProfile(env.LEX_PR_PROFILE_DIR, process.cwd());
      validateCIEnvironment(resolved.manifest);
      allowMutations = getCIMutationPolicy(resolved.manifest);
    }

    const summary = (
      await new MergeApplicationService().run({
        plan: artifact.plan,
        workingDir: process.cwd(),
        dryRun: args.dryRun ?? true,
        mutationAuthorized: allowMutations,
      })
    ).summary;
    const result = { ...summary, planArtifact: artifact.identity };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    const validationFailure = planValidationToolResult(error);
    if (validationFailure) return validationFailure;

    if (error instanceof MergeApplicationServiceError) {
      throwMcpAXError(
        error.code === "MERGE_MUTATION_DENIED" ? ErrorCode.InvalidRequest : ErrorCode.InternalError,
        mcpToolError(error.code, error.message, { tool: "merge.apply" })
      );
    }
    if (error instanceof PlanArtifactServiceError) {
      throwPlanArtifactError("merge.apply", error);
    }
    if (error instanceof McpError) {
      throw error;
    }
    throwMcpToolError(ErrorCode.InternalError, "merge.apply", error, "apply merge");
  }
}

/**
 * Handle local.init tool
 */
async function handleLocalInit(
  args: InitLocalArgs
): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    const output = new WorkspaceInitializationService().run({
      baseDir: process.cwd(),
      force: args.force,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(output, null, 2),
        },
      ],
    };
  } catch (error) {
    if (error instanceof WorkspaceConfigServiceError) {
      throwMcpAXError(
        ErrorCode.InternalError,
        mcpToolError(error.code, error.message, { tool: "local.init" })
      );
    }
    throwMcpToolError(ErrorCode.InternalError, "local.init", error, "initialize local overlay");
  }
}

/**
 * Handle profile.resolve tool
 */
async function handleProfileResolve(
  args: ProfileResolveArgs
): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    const env = getMCPEnvironment();
    const output = new ConfigurationQueryService().resolveProfile({
      baseDir: process.cwd(),
      profileDir: args.profileDir || env.LEX_PR_PROFILE_DIR,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(output, null, 2),
        },
      ],
    };
  } catch (error) {
    if (error instanceof WorkspaceConfigServiceError) {
      throwMcpAXError(
        ErrorCode.InvalidParams,
        mcpToolError(error.code, error.message, { tool: "profile.resolve" })
      );
    }
    throwMcpToolError(ErrorCode.InternalError, "profile.resolve", error, "resolve profile");
  }
}

/**
 * Handle health check
 */
async function handleHealth(args: {
  includeMetrics?: boolean;
}): Promise<{ content: [{ type: "text"; text: string }] }> {
  const doctor = await new WorkspaceDiagnosticsService().run({
    baseDir: process.cwd(),
    environmentQuality: args.includeMetrics,
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            ...doctor,
            deprecation: {
              tool: "health",
              replacement: "doctor",
              removeIn: "3.0.0",
            },
          },
          null,
          2
        ),
      },
    ],
  };
}

/**
 * Main server startup
 */
async function main() {
  // Create RunStore (will be closed on shutdown)
  const runStore = createRunStore();
  const server = createServer({ runStore });
  const transport = new StdioServerTransport();

  // Connect the server to stdio transport
  await server.connect(transport);

  // Log to stderr so it doesn't interfere with MCP protocol
  console.error("MCP server started for lexrunner");

  // Keep the process alive by setting up event handlers
  // The event loop will keep running while the stdio transport is active
  process.stdin.resume();

  // Handle graceful shutdown when stdin closes
  process.stdin.on("end", async () => {
    console.error("MCP server shutting down");
    try {
      await runStore.close();
    } catch (error) {
      console.error("Error closing RunStore:", error);
    }
    process.exit(0);
  });

  // Never return - let the event loop handle everything
  await new Promise<void>(() => {
    // This promise never resolves, keeping the process alive
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Senior Dev Executor Handlers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handle senior-dev.prepare-context tool
 */
async function handleSeniorDevPrepareContext(
  args: PrepareContextInput
): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    const result = await prepareReviewContext(args);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    throwMcpToolError(
      ErrorCode.InternalError,
      "senior-dev.prepare-context",
      error,
      "prepare review context"
    );
  }
}

/**
 * Handle senior-dev.recall-context tool
 */
async function handleSeniorDevRecallContext(
  args: RecallContextInput
): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    const result = await recallSeniorDevContext(args);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    throwMcpToolError(
      ErrorCode.InternalError,
      "senior-dev.recall-context",
      error,
      "recall context"
    );
  }
}

/**
 * Handle senior-dev.capture-frame tool
 */
async function handleSeniorDevCaptureFrame(
  args: CaptureFrameInput
): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    const result = await captureSeniorDevFrame(args);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    throwMcpToolError(ErrorCode.InternalError, "senior-dev.capture-frame", error, "capture frame");
  }
}

/**
 * Handle senior-dev.modes tool
 */
async function handleSeniorDevModes(): Promise<{
  content: [{ type: "text"; text: string }];
}> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(EXECUTOR_MODES, null, 2),
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LexRunner Run Management Handlers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a plan hash from run parameters for RunRecord storage.
 */
function generatePlanHash(input: StartRunInput): string {
  const hashContent = JSON.stringify({
    mode: input.mode,
    procedure: input.procedure,
    repo: input.repo,
    params: input.params,
  });
  return "sha256:" + crypto.createHash("sha256").update(hashContent).digest("hex");
}

/**
 * Handle lexrunner.startRun tool
 *
 * Creates a run record in both the RunStore (for persistence) and RunManager
 * (for orchestration state).
 */
async function handleStartRun(
  args: StartRunInput,
  runStore: RunStore
): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    // Validate input
    const validated = StartRunInputSchema.parse(args);

    // Create run manager and start the run (for orchestration state)
    const manager = createRunManager();
    const result = manager.startRun(validated);

    // Also create a record in the RunStore for persistence
    const now = new Date().toISOString();
    await runStore.createRun({
      runId: result.runId,
      planHash: generatePlanHash(validated),
      state: "pending", // RunStore uses its own state machine
      startedAt: now,
      metadata: {
        mode: validated.mode,
        procedure: validated.procedure,
        repo: validated.repo,
        task: validated.task,
      },
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") {
      const axError = mcpToolError(
        ErrorCodes.INVALID_INPUT,
        `Invalid startRun parameters: ${error.message}`,
        { tool: "lexrunner.startRun", operation: "validate parameters" }
      );
      throwMcpAXError(ErrorCode.InvalidParams, axError);
    }
    throwMcpToolError(ErrorCode.InternalError, "lexrunner.startRun", error, "start run");
  }
}

/**
 * Handle lexrunner.getStatus tool
 *
 * Queries run state from RunManager, and also fetches step/receipt data
 * from RunStore for enhanced status reporting.
 */
async function handleGetStatus(
  args: GetStatusInput,
  runStore: RunStore
): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    // Validate input
    const validated = GetStatusInputSchema.parse(args);

    // Get orchestration status from run manager
    const manager = createRunManager();
    const status = manager.getStatus(validated);

    // Fetch additional data from RunStore if available
    const runRecord = await runStore.getRun(validated.runId);
    const steps = await runStore.getStepsForRun(validated.runId);
    const receipts = await runStore.getReceiptsForRun(validated.runId);

    // Enhance status with store data
    const enhancedStatus = {
      ...status,
      store: runRecord
        ? {
            runRecord,
            steps,
            receipts,
          }
        : null,
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(enhancedStatus, null, 2),
        },
      ],
    };
  } catch (error) {
    if (error instanceof RunNotFoundError) {
      const axError = mcpToolError(
        ErrorCodes.INTERNAL_ERROR,
        error.message,
        { tool: "lexrunner.getStatus" },
        ["Check that runId is valid", "List available runs with 'lexrunner.listRuns'"]
      );
      throwMcpAXError(ErrorCode.InvalidParams, axError);
    }
    if (error instanceof Error && error.name === "ZodError") {
      const axError = mcpToolError(
        ErrorCodes.INVALID_INPUT,
        `Invalid getStatus parameters: ${error.message}`,
        {
          tool: "lexrunner.getStatus",
          operation: "validate parameters",
        }
      );
      throwMcpAXError(ErrorCode.InvalidParams, axError);
    }
    throwMcpToolError(ErrorCode.InternalError, "lexrunner.getStatus", error, "get status");
  }
}

/**
 * Handle lexrunner.listRuns tool
 *
 * Queries the RunStore for run records with optional filtering and pagination.
 */
async function handleListRuns(
  args: ListRunsInput,
  runStore: RunStore
): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    // Validate input
    const validated = ListRunsInputSchema.parse(args);

    // Query runs from the store
    const options: ListRunsOptions = {};
    if (validated.limit !== undefined) {
      options.limit = validated.limit;
    }
    if (validated.offset !== undefined) {
      options.offset = validated.offset;
    }
    if (validated.state !== undefined) {
      options.state = validated.state;
    }

    const runs = await runStore.listRuns(options);
    const count = await runStore.getRunCount(validated.state);

    const result = {
      runs,
      total: count,
      limit: validated.limit,
      offset: validated.offset ?? 0,
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") {
      const axError = mcpToolError(
        ErrorCodes.INVALID_INPUT,
        `Invalid listRuns parameters: ${error.message}`,
        { tool: "lexrunner.listRuns", operation: "validate parameters" }
      );
      throwMcpAXError(ErrorCode.InvalidParams, axError);
    }
    throwMcpToolError(ErrorCode.InternalError, "lexrunner.listRuns", error, "list runs");
  }
}

/**
 * Handle lexrunner.submitDecision tool
 *
 * Validates and submits an LLM decision for a pending action in a run.
 */
async function handleSubmitDecision(
  args: SubmitDecisionInput
): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    // Validate input
    const validated = SubmitDecisionInputSchema.parse(args);

    // Submit the decision (uses process.cwd() as baseDir)
    const result = submitDecision(validated);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") {
      const axError = mcpToolError(
        ErrorCodes.INVALID_INPUT,
        `Invalid submitDecision parameters: ${error.message}`,
        {
          tool: "lexrunner.submitDecision",
          operation: "validate parameters",
        }
      );
      throwMcpAXError(ErrorCode.InvalidParams, axError);
    }
    throwMcpToolError(
      ErrorCode.InternalError,
      "lexrunner.submitDecision",
      error,
      "submit decision"
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP/CLI Parity Handlers (AX-004)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handle discover tool - Discover open pull requests from GitHub
 */
async function handleDiscover(args: {
  owner?: string;
  repo?: string;
  state?: string;
  suggest?: boolean;
}): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    // Check for GitHub authentication early
    ensureGitHubToken();

    let githubAPI = await createGitHubAPI();

    // Override with arguments if provided
    if (args.owner && args.repo) {
      githubAPI = new GitHubAPI({
        owner: args.owner,
        repo: args.repo,
        token: process.env.GITHUB_TOKEN,
      });
    }

    if (!githubAPI) {
      const axError = githubApiError({
        message:
          "Could not detect GitHub repository. Provide owner and repo parameters or run from a git repository with GitHub remote.",
      });
      throwMcpAXError(ErrorCode.InvalidRequest, axError);
    }

    const result = await new DiscoveryQueryService().run({
      github: githubAPI,
      state: (args.state || "open") as "open" | "closed" | "all",
      suggest: args.suggest,
    });
    if (!result.authenticated) {
      // Log warning to stderr for MCP clients to surface
      console.error(
        "[mcp:discover] Warning: GitHub API not authenticated. Private repos will not be accessible.\n" +
          "To fix: Add GITHUB_TOKEN to your MCP server config env block.\n" +
          "See: README.mcp.md#github-authentication"
      );
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    if (error instanceof IntegrationQueryServiceError) {
      throwMcpAXError(
        ErrorCode.InvalidParams,
        mcpToolError(error.code, error.message, { tool: "discover" })
      );
    }
    // Handle GitHub API errors specifically with status code context
    if (error instanceof GitHubAPIError) {
      const axError = githubApiError({
        status: error.status,
        message: error.message,
      });
      throwMcpAXError(ErrorCode.InternalError, axError);
    }
    throwMcpToolError(ErrorCode.InternalError, "discover", error, "discover PRs");
  }
}

/**
 * Handle status tool - Show execution status and merge eligibility
 */
async function handleStatus(args: {
  planFile?: string;
  repoRoot?: string;
  evidenceFile?: string;
  evidenceSha256?: string;
  verifyArtifacts?: boolean;
}): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    const repoRoot =
      args.repoRoot === undefined ? process.cwd() : resolveGateRepositoryRoot(args.repoRoot);
    const artifact = new PlanArtifactService().resolve({
      planFile: args.planFile,
      workingDir: repoRoot,
      profileDir: getMCPEnvironment().LEX_PR_PROFILE_DIR,
    });
    const status = new IntegrationStatusQueryService().run(
      artifact.plan,
      args.evidenceFile && args.evidenceSha256
        ? {
            evidenceFile: path.resolve(repoRoot, args.evidenceFile),
            evidenceSha256: args.evidenceSha256,
            repoRoot,
            verifyArtifacts: args.verifyArtifacts,
          }
        : undefined
    );

    // Calculate tier metrics from plan items
    const tierAssignments = suggestTiersForPlan(artifact.plan.items);
    const tierMetrics = calculateTierMetrics(tierAssignments);

    // Run environment quality check for hostility score
    const hostilityScore = runEnvironmentQualityCheck();

    // Build governance status
    const governanceStatus = buildGovernanceStatus(
      tierMetrics,
      undefined, // Turn cost tracked during actual runs
      hostilityScore
    );

    const result = {
      ...status,
      planArtifact: artifact.identity,
      governance: governanceStatusToJSON(governanceStatus),
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    const validationFailure = planValidationToolResult(error);
    if (validationFailure) return validationFailure;

    if (error instanceof McpError) {
      throw error;
    }
    if (error instanceof PlanArtifactServiceError) {
      throwPlanArtifactError("status", error);
    }
    if (error instanceof GateEvidenceServiceError) {
      throwMcpAXError(
        ErrorCode.InvalidParams,
        mcpToolError(error.code, error.message, { tool: "status" })
      );
    }
    throwMcpToolError(ErrorCode.InternalError, "status", error, "get status");
  }
}

/**
 * Handle doctor tool - Environment and configuration sanity checks
 */
async function handleDoctor(args: {
  environmentQuality?: boolean;
}): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    const checks = await new WorkspaceDiagnosticsService().run({
      baseDir: process.cwd(),
      environmentQuality: args.environmentQuality,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(checks, null, 2),
        },
      ],
    };
  } catch (error) {
    if (error instanceof WorkspaceConfigServiceError) {
      throwMcpAXError(
        ErrorCode.InternalError,
        mcpToolError(error.code, error.message, { tool: "doctor" })
      );
    }
    throwMcpToolError(ErrorCode.InternalError, "doctor", error, "run doctor");
  }
}

/**
 * Handle merge-order tool - Compute dependency levels and merge order
 */
async function handleMergeOrder(args: {
  planFile?: string;
}): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    const artifact = new PlanArtifactService().resolve({
      planFile: args.planFile,
      workingDir: process.cwd(),
      profileDir: getMCPEnvironment().LEX_PR_PROFILE_DIR,
    });
    const result = {
      ...new MergeOrderQueryService().run(artifact.plan),
      planArtifact: artifact.identity,
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    const validationFailure = planValidationToolResult(error);
    if (validationFailure) return validationFailure;

    if (error instanceof McpError) {
      throw error;
    }
    if (error instanceof IntegrationQueryServiceError) {
      throwMcpAXError(
        ErrorCode.InvalidParams,
        mcpToolError(error.code, error.message, { tool: "merge-order" })
      );
    }
    if (error instanceof PlanArtifactServiceError) {
      throwPlanArtifactError("merge-order", error);
    }
    // Handle AXErrorException instances (including CycleError, UnknownDependencyError)
    if (isAXErrorException(error)) {
      const axError = error.toAXError();
      throwMcpAXError(ErrorCode.InvalidParams, axError);
    }
    throwMcpToolError(ErrorCode.InternalError, "merge-order", error, "compute merge order");
  }
}

/**
 * Handle config.show tool - Display configuration with precedence chain
 */
async function handleConfigShow(args: {
  key?: string;
}): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    const output = new ConfigurationQueryService().show({
      baseDir: process.cwd(),
      key: args.key,
    });
    const projected = args.key ? { contract: output.contract, ...output.configuration[0] } : output;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(projected, null, 2),
        },
      ],
    };
  } catch (error) {
    if (error instanceof WorkspaceConfigServiceError) {
      throwMcpAXError(
        error.code === "CONFIG_KEY_NOT_FOUND" ? ErrorCode.InvalidParams : ErrorCode.InternalError,
        mcpToolError(error.code, error.message, { tool: "config.show" })
      );
    }
    throwMcpToolError(ErrorCode.InternalError, "config.show", error, "show config");
  }
}

/**
 * Handle metrics tool - Get governance metrics snapshot
 */
async function handleMetrics(args: {
  filter?: string;
  format?: string;
}): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    const collector = getGlobalMetricsCollector();

    // Get snapshot, optionally filtered
    const snapshot = args.filter
      ? collector.getMetricsByName(args.filter)
      : collector.getSnapshot();

    // Format output
    let output: string;
    if (args.format === "prometheus") {
      output = collector.exportPrometheus();
    } else {
      output = JSON.stringify(snapshot, null, 2);
    }

    return {
      content: [
        {
          type: "text",
          text: output,
        },
      ],
    };
  } catch (error) {
    throwMcpToolError(ErrorCode.InternalError, "metrics", error, "get metrics");
  }
}

/**
 * Handle workflow.guide tool - Get context-aware workflow guidance
 */
async function handleWorkflowGuide(
  args: WorkflowGuideArgs
): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    // Validate phase is a valid WorkflowPhase
    const validPhases: WorkflowPhase[] = [
      "initial",
      "post-plan-creation",
      "post-gates-run",
      "pre-merge",
      "post-merge",
      "error-recovery",
    ];

    const phase = args.phase as WorkflowPhase;
    if (!validPhases.includes(phase)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid workflow phase: ${args.phase}. Valid phases: ${validPhases.join(", ")}`
      );
    }

    // Create workflow guide for the requested phase
    const guide: WorkflowGuide = createWorkflowGuide(phase);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(guide, null, 2),
        },
      ],
    };
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throwMcpToolError(ErrorCode.InternalError, "workflow.guide", error, "get workflow guide");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Task Handoff Tool Handlers (ADR-007)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * In-memory task store for MCP session
 * In production, this should use RunStore or a dedicated task store
 */
const taskStore = new Map<
  string,
  {
    snapshot: TaskSnapshot_v1;
    receipt?: TaskReceipt_v1;
    verification?: any;
    state: "pending" | "in_progress" | "completed" | "verified" | "failed";
  }
>();

/**
 * Handle create_task_snapshot tool
 */
async function handleCreateTaskSnapshot(
  args: CreateTaskSnapshotArgs
): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    // Validate args
    const validated = CreateTaskSnapshotArgs.parse(args);

    // Auto-detect git info if not provided
    const gitOps = createGitOperations();
    const repoRoot = validated.repoRoot || process.cwd();
    const commitSha = validated.commitSha || (await gitOps.getCurrentHead());

    // Auto-detect repoId if not provided
    let repoId = validated.repoId;
    if (!repoId) {
      try {
        const githubAPI = await createGitHubAPI();
        if (githubAPI) {
          repoId = `${githubAPI.config.owner}/${githubAPI.config.repo}`;
        } else {
          repoId = "unknown/unknown";
        }
      } catch {
        repoId = "unknown/unknown";
      }
    }

    // Generate task ID if not provided
    const taskId = validated.taskId || ulid();

    // Build snapshot using SnapshotBuilder
    const builder = new SnapshotBuilder({
      repoRoot,
      repoId,
    });

    const snapshot = await builder.buildSnapshot({
      taskId,
      procedure: validated.procedure,
      determinism: validated.determinism as "D1" | "D2" | "D3" | undefined,
      targetFiles: validated.targetFiles,
      failure: {
        message: validated.failureMessage,
        fileRel: validated.failureFileRel,
        line: validated.failureLine,
        runnerOutputSnip: validated.runnerOutputSnip,
        excerpt: validated.failureExcerpt,
      },
      commitSha,
      verificationCmd: validated.verificationCmd,
      expectedExitCode: validated.expectedExitCode,
    });

    // Store snapshot in task store
    taskStore.set(taskId, {
      snapshot,
      state: "pending",
    });

    const result: CreateTaskSnapshotResult = {
      snapshot,
      taskId,
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") {
      const axError = mcpToolError(
        ErrorCodes.INVALID_INPUT,
        `Invalid create_task_snapshot parameters: ${error.message}`,
        {
          tool: "create_task_snapshot",
          operation: "validate parameters",
        }
      );
      throwMcpAXError(ErrorCode.InvalidParams, axError);
    }
    throwMcpToolError(
      ErrorCode.InternalError,
      "create_task_snapshot",
      error,
      "create task snapshot"
    );
  }
}

/**
 * Handle submit_task_receipt tool
 */
async function handleSubmitTaskReceipt(
  args: SubmitTaskReceiptArgs
): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    // Validate args
    const validated = SubmitTaskReceiptArgs.parse(args);

    // Parse and validate receipt
    const receipt = parseTaskReceipt(validated.receipt);

    // Find corresponding snapshot
    const taskData = taskStore.get(receipt.task_id);
    if (!taskData) {
      const axError = mcpToolError(
        ErrorCodes.INTERNAL_ERROR,
        `Task not found: ${receipt.task_id}. Create snapshot first using create_task_snapshot.`,
        {
          tool: "submit_task_receipt",
          details: { taskId: receipt.task_id },
        }
      );
      throwMcpAXError(ErrorCode.InvalidParams, axError);
    }

    // Update state
    taskData.state = "in_progress";
    taskData.receipt = receipt;

    // Run engine verification
    const verifier = new EngineVerifier();
    const verificationResult = await verifier.verify({
      snapshot: taskData.snapshot,
      receipt,
      workingDir: taskData.snapshot.repo.root,
      applyPatch: true,
    });

    // Update task with verification
    taskData.verification = verificationResult.verification;
    taskData.state = verificationResult.verification.verified ? "verified" : "failed";

    const result: SubmitTaskReceiptResult = {
      acknowledged: true,
      taskId: receipt.task_id,
      verification: {
        verified: verificationResult.verification.verified,
        trustGap: verificationResult.trustGap,
        patchApplied: verificationResult.patchApplied,
      },
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") {
      const axError = mcpToolError(
        ErrorCodes.INVALID_INPUT,
        `Invalid submit_task_receipt parameters: ${error.message}`,
        {
          tool: "submit_task_receipt",
          operation: "validate parameters",
        }
      );
      throwMcpAXError(ErrorCode.InvalidParams, axError);
    }
    throwMcpToolError(ErrorCode.InternalError, "submit_task_receipt", error, "submit task receipt");
  }
}

/**
 * Handle get_task_status tool
 */
async function handleGetTaskStatus(
  args: GetTaskStatusArgs
): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    // Validate args
    const validated = GetTaskStatusArgs.parse(args);

    // Find task
    const taskData = taskStore.get(validated.taskId);
    if (!taskData) {
      const axError = mcpToolError(
        ErrorCodes.INTERNAL_ERROR,
        `Task not found: ${validated.taskId}`,
        {
          tool: "get_task_status",
          details: { taskId: validated.taskId },
        }
      );
      throwMcpAXError(ErrorCode.InvalidParams, axError);
    }

    const result: GetTaskStatusResult = {
      taskId: validated.taskId,
      state: taskData.state,
      snapshot: taskData.snapshot,
      receipt: taskData.receipt,
      verification: taskData.verification,
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") {
      const axError = mcpToolError(
        ErrorCodes.INVALID_INPUT,
        `Invalid get_task_status parameters: ${error.message}`,
        { tool: "get_task_status", operation: "validate parameters" }
      );
      throwMcpAXError(ErrorCode.InvalidParams, axError);
    }
    throwMcpToolError(ErrorCode.InternalError, "get_task_status", error, "get task status");
  }
}

/**
 * Handle list_pending_tasks tool
 */
async function handleListPendingTasks(
  args: ListPendingTasksArgs
): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    // Validate args
    const validated = ListPendingTasksArgs.parse(args);

    // Filter tasks
    const tasks: ListPendingTasksResult["tasks"] = [];
    for (const [taskId, taskData] of taskStore.entries()) {
      // Apply filters
      if (validated.procedure && taskData.snapshot.procedure !== validated.procedure) {
        continue;
      }
      if (validated.determinism && taskData.snapshot.determinism !== validated.determinism) {
        continue;
      }

      tasks.push({
        taskId,
        procedure: taskData.snapshot.procedure,
        determinism: taskData.snapshot.determinism,
        state: taskData.state,
        snapshot: taskData.snapshot,
      });

      // Apply limit
      if (validated.limit && tasks.length >= validated.limit) {
        break;
      }
    }

    const result: ListPendingTasksResult = {
      tasks,
      total: tasks.length,
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") {
      const axError = mcpToolError(
        ErrorCodes.INVALID_INPUT,
        `Invalid list_pending_tasks parameters: ${error.message}`,
        { tool: "list_pending_tasks", operation: "validate parameters" }
      );
      throwMcpAXError(ErrorCode.InvalidParams, axError);
    }
    throwMcpToolError(ErrorCode.InternalError, "list_pending_tasks", error, "list pending tasks");
  }
}

// =============================================================================
// Fanout AX Handlers (Epic #654 Layer 2)
// =============================================================================

/**
 * Handle fanout_harvest tool
 * D0: Harvest external state from GitHub into a deterministic, replayable HarvestBundle
 */
async function handleFanoutHarvest(
  args: FanoutHarvestArgs
): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    // Validate args
    const validated = FanoutHarvestArgs.parse(args);

    // Check for GitHub authentication
    ensureGitHubToken(validated.githubToken);

    // Create GitHub API
    let githubAPI = await createGitHubAPI();

    // Override with arguments if provided
    if (validated.owner && validated.repo) {
      githubAPI = new GitHubAPI({
        owner: validated.owner,
        repo: validated.repo,
        token: validated.githubToken || process.env.GITHUB_TOKEN,
      });
    }

    if (!githubAPI) {
      const axError = githubApiError({
        message:
          "Could not detect GitHub repository. Provide owner and repo parameters or run from a git repository with GitHub remote.",
      });
      throwMcpAXError(ErrorCode.InvalidRequest, axError);
    }

    const timestamp = new Date().toISOString();
    const state = validated.state || "open";
    const maxBody = validated.maxBody || 4096;
    const includeIssues = validated.includeIssues ?? false;

    // Compute input digest for replay verification
    const inputDigest = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          owner: githubAPI.config.owner,
          repo: githubAPI.config.repo,
          state,
          timestamp,
        })
      )
      .digest("hex");

    // Fetch repository info
    const repoInfo = await githubAPI.getRepository();
    const defaultBranch = repoInfo.default_branch;
    const defaultBranchRef = await githubAPI.getRef(`heads/${defaultBranch}`);

    const repository = {
      owner: githubAPI.config.owner,
      name: githubAPI.config.repo,
      defaultBranch,
      defaultBranchSha: defaultBranchRef.object.sha,
    };

    // Fetch pull requests
    const rawPRs = await githubAPI.discoverPullRequests(state);
    const pullRequests = await Promise.all(
      rawPRs.map(async (pr: any) => {
        // Get merge base SHA
        let mergeBaseSha: string | "unknown" | "unavailable" = "unknown";
        try {
          const comparison = await githubAPI.compare(pr.baseBranch, pr.sha);
          mergeBaseSha = comparison.merge_base_commit?.sha ?? "unavailable";
        } catch {
          mergeBaseSha = "unavailable";
        }

        // Determine CI status
        let ciStatus: "pass" | "fail" | "pending" | "unknown" | "unavailable" = "unknown";
        try {
          const checks = await githubAPI.getCheckRuns(pr.sha);
          if (checks.total_count === 0) {
            ciStatus = "pending";
          } else {
            const allComplete = checks.check_runs.every((c: any) => c.status === "completed");
            if (!allComplete) {
              ciStatus = "pending";
            } else {
              const anyFailed = checks.check_runs.some(
                (c: any) => c.conclusion !== "success" && c.conclusion !== "skipped"
              );
              ciStatus = anyFailed ? "fail" : "pass";
            }
          }
        } catch {
          ciStatus = "unavailable";
        }

        // Determine review status
        let reviewStatus:
          "approved" | "changes_requested" | "pending" | "none" | "unknown" | "unavailable" =
          "unknown";
        try {
          const reviews = await githubAPI.getReviews(pr.number);
          const latestByUser = new Map<string, string>();
          for (const review of reviews) {
            if (review.state !== "COMMENTED" && review.user?.login) {
              latestByUser.set(review.user.login, review.state);
            }
          }
          const states = Array.from(latestByUser.values());
          if (states.includes("CHANGES_REQUESTED")) {
            reviewStatus = "changes_requested";
          } else if (states.includes("APPROVED")) {
            reviewStatus = "approved";
          } else if (states.length > 0) {
            reviewStatus = "pending";
          } else {
            reviewStatus = "none";
          }
        } catch {
          reviewStatus = "unavailable";
        }

        // Determine conflict status
        let conflictStatus: "clean" | "conflicted" | "unknown" | "unavailable" = "unknown";
        if (pr.mergeable === true) {
          conflictStatus = "clean";
        } else if (pr.mergeable === false) {
          conflictStatus = "conflicted";
        }

        return {
          number: pr.number,
          title: pr.title,
          state: pr.state,
          draft: false,
          headSha: pr.sha,
          baseSha: "unavailable",
          mergeBaseSha,
          author: pr.author,
          labels: pr.labels,
          ciStatus,
          reviewStatus,
          conflictStatus,
          updatedAt: pr.updatedAt,
          body: "",
          changedFiles: "unknown",
          additions: "unknown",
          deletions: "unknown",
        };
      })
    );

    // Fetch issues if requested
    let issues: Array<object> = [];
    if (includeIssues) {
      try {
        const rawIssues = await githubAPI.listIssues({ state });
        issues = rawIssues
          .filter((i: any) => !i.pull_request)
          .map((i: any) => {
            let body: string | "truncated" = i.body ?? "";
            if (body.length > maxBody) {
              body = "truncated";
            }
            return {
              number: i.number,
              title: i.title,
              state: i.state,
              author: i.user.login,
              labels: i.labels.map((l: any) => l.name),
              updatedAt: i.updated_at,
              body,
              assignees: i.assignees?.map((a: any) => a.login) ?? [],
            };
          });
      } catch {
        // Issues not critical - continue without them
      }
    }

    const bundle = {
      repository,
      pullRequests,
      issues,
      harvestedAt: timestamp,
    };

    const outputDigest = crypto.createHash("sha256").update(JSON.stringify(bundle)).digest("hex");

    const result: FanoutHarvestResult = {
      schemaVersion: "1.0.0",
      phase: "D0",
      timestamp,
      inputDigest: `sha256:${inputDigest}`,
      bundle,
      outputDigest: `sha256:${outputDigest}`,
    };

    console.error(
      `[mcp:fanout_harvest] harvested ${pullRequests.length} PRs, ${issues.length} issues from ${repository.owner}/${repository.name}`
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") {
      const axError = mcpToolError(
        ErrorCodes.INVALID_INPUT,
        `Invalid fanout_harvest parameters: ${error.message}`,
        { tool: "fanout_harvest", operation: "validate parameters" }
      );
      throwMcpAXError(ErrorCode.InvalidParams, axError);
    }
    if (error instanceof GitHubAPIError) {
      const axError = githubApiError({
        message: error.message,
      });
      throwMcpAXError(ErrorCode.InternalError, axError);
    }
    throwMcpToolError(ErrorCode.InternalError, "fanout_harvest", error, "harvest from GitHub");
  }
}

/**
 * Handle fanout_analyze tool
 * D1: Analyze a HarvestBundle into a deterministic AnalysisPool with evidence IDs
 */
async function handleFanoutAnalyze(
  args: FanoutAnalyzeArgs
): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    // Validate args
    const validated = FanoutAnalyzeArgs.parse(args);

    let harvest: any;

    // Get harvest bundle from args or file
    if (validated.harvestBundle) {
      harvest = validated.harvestBundle;
    } else if (validated.fromFile) {
      if (!fs.existsSync(validated.fromFile)) {
        const axError = mcpToolError(
          ErrorCodes.PLAN_NOT_FOUND,
          `Harvest bundle file not found: ${validated.fromFile}`,
          { tool: "fanout_analyze", operation: "load harvest bundle" }
        );
        throwMcpAXError(ErrorCode.InvalidParams, axError);
      }
      const content = fs.readFileSync(validated.fromFile, "utf-8");
      try {
        harvest = JSON.parse(content);
      } catch {
        const axError = mcpToolError(
          ErrorCodes.INVALID_INPUT,
          `Invalid JSON in harvest bundle file: ${validated.fromFile}`,
          { tool: "fanout_analyze", operation: "parse harvest bundle" }
        );
        throwMcpAXError(ErrorCode.InvalidParams, axError);
      }
    } else {
      const axError = mcpToolError(
        ErrorCodes.INVALID_INPUT,
        "Either harvestBundle or fromFile must be provided",
        { tool: "fanout_analyze", operation: "validate input" }
      );
      throwMcpAXError(ErrorCode.InvalidParams, axError);
    }

    // Validate harvest bundle structure
    if (harvest.phase !== "D0") {
      const axError = mcpToolError(
        ErrorCodes.INVALID_INPUT,
        `Invalid input phase: ${harvest.phase}. Expected: D0 (HarvestBundle)`,
        { tool: "fanout_analyze", operation: "validate phase" }
      );
      throwMcpAXError(ErrorCode.InvalidParams, axError);
    }

    const timestamp = new Date().toISOString();
    const inputDigest = harvest.outputDigest;

    // Deterministic analysis
    const entities: Array<object> = [];
    const relations: Array<object> = [];
    const conflicts: Array<object> = [];
    const blockers: Array<object> = [];

    // Track PRs by number
    const prByNumber = new Map<number, any>();

    // Process pull requests
    for (const pr of harvest.bundle.pullRequests) {
      prByNumber.set(pr.number, pr);
      const eid = `PR:${pr.number}`;

      // Build facts
      const facts: Array<object> = [
        { key: "title", value: pr.title, source: "api", confidence: "known" },
        { key: "state", value: pr.state, source: "api", confidence: "known" },
        { key: "author", value: pr.author, source: "api", confidence: "known" },
        { key: "labels", value: pr.labels, source: "api", confidence: "known" },
        { key: "head_sha", value: pr.headSha, source: "api", confidence: "known" },
        { key: "updated_at", value: pr.updatedAt, source: "api", confidence: "known" },
      ];

      // CI status
      const ciConfidence = ["unknown", "unavailable"].includes(pr.ciStatus) ? pr.ciStatus : "known";
      facts.push({ key: "ci_status", value: pr.ciStatus, source: "api", confidence: ciConfidence });

      // Review status
      const reviewConfidence = ["unknown", "unavailable"].includes(pr.reviewStatus)
        ? pr.reviewStatus
        : "known";
      facts.push({
        key: "review_status",
        value: pr.reviewStatus,
        source: "api",
        confidence: reviewConfidence,
      });

      // Conflict status
      const conflictConfidence = ["unknown", "unavailable"].includes(pr.conflictStatus)
        ? pr.conflictStatus
        : "known";
      facts.push({
        key: "conflict_status",
        value: pr.conflictStatus,
        source: "api",
        confidence: conflictConfidence,
      });

      entities.push({
        eid,
        type: "pull_request",
        ref: `#${pr.number}`,
        facts,
      });

      // Detect blockers
      if (pr.ciStatus === "fail") {
        blockers.push({
          type: "ci_failed",
          entity: eid,
          reason: "CI checks failed",
        });
      }

      if (pr.reviewStatus === "changes_requested") {
        blockers.push({
          type: "review_rejected",
          entity: eid,
          reason: "Changes requested in review",
        });
      }

      if (pr.conflictStatus === "conflicted") {
        conflicts.push({
          type: "merge_conflict",
          entities: [eid],
          resolution: "requires_rebase",
        });
      }

      if (pr.draft) {
        blockers.push({
          type: "draft",
          entity: eid,
          reason: "PR is in draft state",
        });
      }
    }

    // Process issues
    for (const issue of harvest.bundle.issues) {
      const eid = `ISSUE:${issue.number}`;

      const facts: Array<object> = [
        { key: "title", value: issue.title, source: "api", confidence: "known" },
        { key: "state", value: issue.state, source: "api", confidence: "known" },
        { key: "author", value: issue.author, source: "api", confidence: "known" },
        { key: "labels", value: issue.labels, source: "api", confidence: "known" },
        { key: "updated_at", value: issue.updatedAt, source: "api", confidence: "known" },
      ];

      entities.push({
        eid,
        type: "issue",
        ref: `#${issue.number}`,
        facts,
      });
    }

    const pool = {
      entities,
      relations,
      conflicts,
      blockers,
    };

    const outputDigest = crypto.createHash("sha256").update(JSON.stringify(pool)).digest("hex");

    const result: FanoutAnalyzeResult = {
      schemaVersion: "1.0.0",
      phase: "D1",
      timestamp,
      inputDigest,
      pool,
      outputDigest: `sha256:${outputDigest}`,
    };

    console.error(
      `[mcp:fanout_analyze] analyzed ${entities.length} entities, ${relations.length} relations, ${conflicts.length} conflicts, ${blockers.length} blockers`
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") {
      const axError = mcpToolError(
        ErrorCodes.INVALID_INPUT,
        `Invalid fanout_analyze parameters: ${error.message}`,
        { tool: "fanout_analyze", operation: "validate parameters" }
      );
      throwMcpAXError(ErrorCode.InvalidParams, axError);
    }
    throwMcpToolError(ErrorCode.InternalError, "fanout_analyze", error, "analyze harvest bundle");
  }
}

// Handle uncaught errors
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled rejection at:", promise, "reason:", reason);
  process.exit(1);
});

// Start the server if run directly (ESM-only)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("Failed to start MCP server:", error);
    process.exit(1);
  });
}

export { createServer, main };
