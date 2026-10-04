#!/usr/bin/env node
import "dotenv/config";
/**
 * lexrunner MCP Server
 *
 * A Model Context Protocol (MCP) server for merge pyramid orchestration.
 * Speaks MCP over stdio, aligned with LexBrain and LexMap architecture.
 *
 * Usage:
 *   lexrunner-mcp
 *   npx -y /srv/lex-mcp/lexrunner
 *
 * Environment variables:
 *   GITHUB_TOKEN         - GitHub API token for authentication
 *   LEX_PR_PROFILE_DIR   - Path to profile directory (default: auto-resolve)
 *   ALLOW_MUTATIONS      - Enable write operations (default: false, use with caution)
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import packageMetadata from "./package.json" with { type: "json" };

const __dirname = dirname(fileURLToPath(import.meta.url));

// Configuration from environment
const config = {
  profileDir: process.env.LEX_PR_PROFILE_DIR,
  allowMutations: process.env.ALLOW_MUTATIONS === "true",
};

console.error(`[lexrunner] Starting MCP server`);
console.error(
  `[lexrunner] Mutations: ${config.allowMutations ? "ENABLED" : "disabled (read-only)"}`
);

// Import core functionality from built dist
let core;
try {
  core = await import("./dist/cli.js");
  console.error(`[lexrunner] Core module loaded successfully`);
} catch (err) {
  console.error(`[lexrunner] ERROR: Failed to load core module: ${err.message}`);
  console.error(`[lexrunner] Hint: Run 'npm run build' to compile TypeScript sources`);
  process.exit(1);
}

const attemptLifecycleHandlers = core.createAttemptLifecycleHandlers();
const containmentPreflightHandler = core.createAgentWorkContainmentPreflightHandler();
const projectionLifecycleHandlers = core.createNativeWslProjectionLifecycleHandlers();
const attemptWorkerHandlers = core.createAttemptWorkerHandlers();
const attemptReceiptHandlers = core.createAttemptReceiptHandlers();
const attemptVerificationHandlers = core.createAttemptVerificationHandlers();

function sharedServiceError(error, tool, fallbackCode) {
  if (error && typeof error === "object" && typeof error.code === "string") {
    const planArtifactContext =
      error.name === "PlanArtifactServiceError"
        ? {
            operation: "resolve plan artifact",
            details: error.source ? { source: error.source } : undefined,
          }
        : {};
    return new Error(
      core.canonicalJSONStringify(
        core.mcpToolError(error.code, error.message || "Shared service failed", {
          tool,
          ...planArtifactContext,
        })
      )
    );
  }
  return new Error(
    core.canonicalJSONStringify(
      core.mcpToolError(fallbackCode, error instanceof Error ? error.message : String(error), {
        tool,
      })
    )
  );
}

// MCP Tool implementations
const tools = {
  ...Object.fromEntries(
    ["start", "status", "cancel"].map((operation) => [
      "gates." + operation,
      {
        description:
          operation === "start"
            ? "Start durable gate work; reuse the same idempotency key after a lost acknowledgement"
            : operation === "cancel"
              ? "Request cancellation after active gates settle; stops future command admission"
              : "Observe an explicit gate operation without restarting commands or granting merge authority",
        inputSchema:
          operation === "start"
            ? core.GateOperationStartJsonSchema
            : core.GateOperationObserveJsonSchema,
        call: async (args) => {
          try {
            const result = await new core.GateOperationService()[operation](args);
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
          } catch (error) {
            throw sharedServiceError(error, "gates." + operation, "GATE_OPERATION_FAILED");
          }
        },
      },
    ])
  ),
  preflight_attempt_containment: {
    description:
      "Read physical-containment capability before constructing an agent-work Attempt packet",
    inputSchema: core.AgentWorkContainmentPreflightRequestJsonSchema,
    call: async (args) => canonicalToolResult(await containmentPreflightHandler.preflight(args)),
  },

  prepare_native_wsl_projection: {
    description: "Prepare or exactly reuse an identity-anchored native WSL projection",
    inputSchema: core.NativeWslProjectionPrepareRequestJsonSchema,
    call: async (args) =>
      mutationToolCall("prepare a native WSL projection", () =>
        projectionLifecycleHandlers.prepare(args)
      ),
  },

  get_native_wsl_projection_status: {
    description: "Read bounded native WSL projection status without creating state",
    inputSchema: core.NativeWslProjectionStatusRequestJsonSchema,
    call: async (args) => canonicalToolResult(await projectionLifecycleHandlers.status(args)),
  },

  cleanup_native_wsl_projection: {
    description: "Remove exact idle native WSL projection and quarantine state",
    inputSchema: core.NativeWslProjectionCleanupRequestJsonSchema,
    call: async (args) =>
      mutationToolCall("clean up a native WSL projection", () =>
        projectionLifecycleHandlers.cleanup(args)
      ),
  },

  inspect_native_wsl_projection_quarantine: {
    description: "Inspect privacy-bounded native WSL projection quarantine state",
    inputSchema: core.NativeWslProjectionQuarantineRequestJsonSchema,
    call: async (args) => canonicalToolResult(await projectionLifecycleHandlers.quarantine(args)),
  },

  verify_attempt: {
    description: "Run packet-declared engine verification for one fenced Attempt",
    inputSchema: core.AttemptVerificationRunRequestJsonSchema,
    call: async (args) =>
      mutationToolCall("verify an Attempt", () => attemptVerificationHandlers.run(args)),
  },

  get_attempt_verification: {
    description: "Get compact verification status, with explicit optional diagnostics",
    inputSchema: core.AttemptVerificationStatusRequestJsonSchema,
    call: async (args) => canonicalToolResult(await attemptVerificationHandlers.status(args)),
  },

  accept_attempt: {
    description: "Apply LexRunner's strict acceptance policy to verified evidence",
    inputSchema: core.AttemptAcceptanceApplyRequestJsonSchema,
    call: async (args) =>
      mutationToolCall("accept an Attempt", () =>
        attemptVerificationHandlers.applyAcceptance(args)
      ),
  },

  get_attempt_acceptance: {
    description: "Get bounded policy-acceptance status for one Attempt",
    inputSchema: core.AttemptAcceptanceStatusRequestJsonSchema,
    call: async (args) =>
      canonicalToolResult(await attemptVerificationHandlers.acceptanceStatus(args)),
  },

  submit_attempt_receipt: {
    description: "Persist one bounded AgentTaskReceipt v2 claim for an Attempt",
    inputSchema: core.AttemptReceiptSubmitRequestJsonSchema,
    call: async (args) =>
      mutationToolCall("submit an Attempt receipt", () => attemptReceiptHandlers.submit(args)),
  },

  get_attempt_receipt: {
    description: "Get bounded, read-only status for one persisted Attempt receipt",
    inputSchema: core.AttemptReceiptStatusRequestJsonSchema,
    call: async (args) => canonicalToolResult(await attemptReceiptHandlers.status(args)),
  },

  attach_attempt_worker: {
    description: "Attach a native worker session to an authorized Attempt",
    inputSchema: core.AttemptWorkerAttachRequestJsonSchema,
    call: async (args) =>
      mutationToolCall("attach an Attempt worker", () => attemptWorkerHandlers.attach(args)),
  },

  heartbeat_attempt_worker: {
    description: "Record a fenced heartbeat for an attached Attempt worker",
    inputSchema: core.AttemptWorkerHeartbeatRequestJsonSchema,
    call: async (args) =>
      mutationToolCall("heartbeat an Attempt worker", () => attemptWorkerHandlers.heartbeat(args)),
  },

  end_attempt_worker: {
    description: "End an attached Attempt worker session",
    inputSchema: core.AttemptWorkerEndRequestJsonSchema,
    call: async (args) =>
      mutationToolCall("end an Attempt worker", () => attemptWorkerHandlers.end(args)),
  },

  get_attempt_worker: {
    description: "Get bounded, read-only status for an attached Attempt worker",
    inputSchema: core.AttemptWorkerStatusRequestJsonSchema,
    call: async (args) => {
      const result = await attemptWorkerHandlers.status(args);
      return canonicalToolResult(result);
    },
  },

  materialize_attempt_input: {
    description:
      "Construct selected-work preparation input and correspondence without resources, network or dispatch",
    inputSchema: core.SelectedWorkInputJsonSchema,
    call: async (args) => canonicalToolResult(core.materializeAttemptInput(args)),
  },

  prepare_attempt: {
    description:
      "Prepare an ADR-010 assisted launch packet and envelope (requires ALLOW_MUTATIONS=true)",
    inputSchema: core.AttemptPrepareRequestJsonSchema,
    call: async (args) => {
      if (!config.allowMutations) {
        return {
          content: [
            {
              type: "text",
              text: core.canonicalJSONStringify({
                ok: false,
                error: {
                  code: "mutations_disabled",
                  message: "Mutations not allowed. Set ALLOW_MUTATIONS=true to prepare an Attempt.",
                },
              }),
            },
          ],
        };
      }
      const result = await attemptLifecycleHandlers.prepare(args);
      return {
        content: [{ type: "text", text: core.canonicalJSONStringify(result) }],
      };
    },
  },

  start_attempt: {
    description:
      "Start or safely resume an ADR-010 agent-work Attempt (requires ALLOW_MUTATIONS=true)",
    inputSchema: core.AttemptStartRequestJsonSchema,
    call: async (args) => {
      if (!config.allowMutations) {
        return {
          content: [
            {
              type: "text",
              text: core.canonicalJSONStringify({
                ok: false,
                error: {
                  code: "mutations_disabled",
                  message: "Mutations not allowed. Set ALLOW_MUTATIONS=true to start an Attempt.",
                },
              }),
            },
          ],
        };
      }
      const result = await attemptLifecycleHandlers.start(args);
      return {
        content: [{ type: "text", text: core.canonicalJSONStringify(result) }],
      };
    },
  },

  get_attempt_status: {
    description: "Get bounded, read-only status for an ADR-010 agent-work Attempt",
    inputSchema: core.AttemptStatusInputJsonSchema,
    call: async (args) => {
      const result = await attemptLifecycleHandlers.status(args);
      return {
        content: [{ type: "text", text: core.canonicalJSONStringify(result) }],
      };
    },
  },

  "plan.create": {
    description: "Create a plan from configuration files or auto-discover from GitHub PRs",
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
    call: async (args) => {
      try {
        // Resolve profile directory
        const { resolveProfile } = await import("./dist/cli.js");
        const resolved = resolveProfile(config.profileDir, process.cwd());
        const profilePath = resolved.path;
        const role = resolved.manifest.role;

        // Check write permissions
        if (role === "workspace-template") {
          throw new Error(
            "Cannot write to workspace-template profile. Initialize local overlay first."
          );
        }

        let plan;
        let inputs = null;

        if (args.fromGithub) {
          // GitHub mode: auto-discover PRs
          const { createGitHubClient, PlanCreationService } = await import("./dist/cli.js");

          const client = await createGitHubClient({
            token: args.githubToken,
            owner: args.owner,
            repo: args.repo,
          });

          // Parse required gates if provided
          const requiredGates = args.requiredGates || ["lint", "typecheck", "test"];

          // Parse max workers if provided
          const maxWorkers = args.maxWorkers || 2;

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
        } else {
          // Traditional mode: load from configuration files
          const { loadInputs, PlanCreationService } = await import("./dist/cli.js");
          inputs = loadInputs(profilePath);
          plan = new PlanCreationService().fromInputs(inputs);
        }

        // Determine output directory
        const outDir = args.outDir || resolve(profilePath, "runner");

        // Ensure output directory exists
        if (!existsSync(outDir)) {
          mkdirSync(outDir, { recursive: true });
        }

        // Write plan.json
        const { canonicalJSONStringify } = await import("./dist/cli.js");
        const planPath = resolve(outDir, "plan.json");
        const planJson = canonicalJSONStringify(plan);
        writeFileSync(planPath, planJson + "\n");

        // Generate snapshot - use GitHub snapshot for GitHub mode
        const { generateSnapshot, generateGitHubSnapshot } = await import("./dist/cli.js");
        let snapshot;
        if (args.fromGithub) {
          snapshot = generateGitHubSnapshot(plan);
        } else {
          // In traditional mode, inputs is guaranteed to be set
          if (!inputs) {
            throw new Error("Internal error: inputs not loaded in traditional mode");
          }
          snapshot = generateSnapshot(plan, inputs);
        }
        const snapshotPath = resolve(outDir, "snapshot.md");
        writeFileSync(snapshotPath, snapshot);

        const result = {
          contract: "bounded-ax-v1",
          plan: plan,
          outDir: outDir,
          files: {
            plan: planPath,
            snapshot: snapshotPath,
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
        throw new Error(`Failed to create plan: ${error.message}`);
      }
    },
  },

  "gates.run": {
    description:
      "Execute short gates synchronously; use gates.start for long or reconnectable work",
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
    call: async (args) => {
      try {
        if (
          args.timeoutMs !== undefined &&
          (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 1 || args.timeoutMs > 86400000)
        ) {
          throw new Error("timeoutMs must be an integer from 1 through 86400000 milliseconds");
        }
        const artifact = new core.PlanArtifactService().resolve({
          planFile: args.planFile,
          workingDir: process.cwd(),
          profileDir: config.profileDir,
        });

        // Determine output directory
        const outDir = args.outDir || resolve(dirname(artifact.filePath), "gates");

        const summary = (
          await new core.GateExecutionService().run({
            plan: artifact.plan,
            repoRoot: args.repoRoot,
            artifactDir: outDir,
            timeoutMs: args.timeoutMs,
            onlyItem: args.onlyItem,
            onlyGate: args.onlyGate,
            options: { emitReceipt: false, suppressStdout: true },
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
        throw sharedServiceError(error, "gates.run", "GATE_EXECUTION_FAILED");
      }
    },
  },

  "merge.apply": {
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
    call: async (args) => {
      try {
        const artifact = new core.PlanArtifactService().resolve({
          planFile: args.planFile,
          workingDir: process.cwd(),
          profileDir: config.profileDir,
        });

        const summary = (
          await new core.MergeApplicationService().run({
            plan: artifact.plan,
            workingDir: process.cwd(),
            dryRun: args.dryRun ?? true,
            mutationAuthorized: config.allowMutations,
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
        if (error?.name === "MergeApplicationServiceError" && typeof error.code === "string") {
          const { mcpToolError } = await import("./dist/errors/index.js");
          throw new Error(
            core.canonicalJSONStringify(
              mcpToolError(error.code, error.message, { tool: "merge.apply" })
            )
          );
        }
        throw sharedServiceError(error, "merge.apply", "MERGE_APPLICATION_FAILED");
      }
    },
  },

  "local.init": {
    description: "Initialize local overlay directory with auto-detected project configuration",
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
    call: async (args) => {
      try {
        const output = new core.WorkspaceInitializationService().run({
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
        throw sharedServiceError(error, "local.init", "WORKSPACE_INIT_FAILED");
      }
    },
  },

  "profile.resolve": {
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
    call: async (args) => {
      try {
        const output = new core.ConfigurationQueryService().resolveProfile({
          baseDir: process.cwd(),
          profileDir: args.profileDir || config.profileDir,
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
        throw sharedServiceError(error, "profile.resolve", "PROFILE_RESOLUTION_FAILED");
      }
    },
  },

  health: {
    description: "DEPRECATED: use doctor. Compatibility alias scheduled for removal in 3.0.0.",
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
    call: async (args) => {
      try {
        const doctor = await new core.WorkspaceDiagnosticsService().run({
          baseDir: process.cwd(),
          environmentQuality: args.includeMetrics,
        });
        const health = {
          ...doctor,
          deprecation: { tool: "health", replacement: "doctor", removeIn: "3.0.0" },
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(health, null, 2),
            },
          ],
        };
      } catch (error) {
        throw sharedServiceError(error, "health", "WORKSPACE_DIAGNOSTICS_FAILED");
      }
    },
  },

  "lexrunner.startRun": {
    description: `DEPRECATED IntegrationRun record adapter; not ADR-010 orchestration authority. Use ${core.INTEGRATION_RECORD_REPLACEMENTS["lexrunner.startRun"]}. Remove in ${core.INTEGRATION_RECORD_REMOVAL_VERSION}.`,
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          maxLength: 1024,
          description: "Persona mode (e.g., 'senior-dev', 'eager-pm')",
        },
        procedure: {
          type: "string",
          maxLength: 1024,
          description: "Procedure identifier (e.g., 'merge-weave-main', 'pr-review')",
        },
        repo: {
          type: "string",
          maxLength: 1024,
          description: "Repository in 'owner/repo' format",
        },
        task: {
          type: "string",
          maxLength: 1024,
          description: "Human-readable task description",
        },
        params: {
          type: "object",
          description: "Procedure-specific parameters",
        },
      },
      required: ["mode", "procedure", "repo"],
    },
    call: async (args) => {
      try {
        const result = new core.IntegrationRecordCompatibilityService(process.cwd()).start(args);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        throw sharedServiceError(
          error,
          "lexrunner.startRun",
          "INTEGRATION_RECORD_OPERATION_FAILED"
        );
      }
    },
  },

  "lexrunner.getStatus": {
    description: `DEPRECATED bounded IntegrationRun record status; not ADR-010 Run status. Use ${core.INTEGRATION_RECORD_REPLACEMENTS["lexrunner.getStatus"]}. Remove in ${core.INTEGRATION_RECORD_REMOVAL_VERSION}.`,
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          maxLength: 1024,
          description: "Unique run identifier",
        },
      },
      required: ["runId"],
    },
    call: async (args) => {
      try {
        const status = new core.IntegrationRecordCompatibilityService(process.cwd()).getStatus(
          args
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(status, null, 2),
            },
          ],
        };
      } catch (error) {
        throw sharedServiceError(
          error,
          "lexrunner.getStatus",
          "INTEGRATION_RECORD_OPERATION_FAILED"
        );
      }
    },
  },

  "lexrunner.listArtifacts": {
    description: `DEPRECATED bounded IntegrationRun artifact metadata; never ADR-010 evidence authority. Use ${core.INTEGRATION_RECORD_REPLACEMENTS["lexrunner.listArtifacts"]}. Remove in ${core.INTEGRATION_RECORD_REMOVAL_VERSION}.`,
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          maxLength: 1024,
          description: "Unique run identifier",
        },
        type: {
          type: "string",
          description: 'Filter by type: "plan", "decision", "failure", "gate", "report", "log"',
          enum: ["plan", "decision", "failure", "gate", "report", "log"],
        },
        path: {
          type: "string",
          maxLength: 1024,
          description: "Filter by path pattern (supports * and ** wildcards)",
        },
        latestOnly: {
          type: "boolean",
          description: "Only return the most recent artifact of each type",
        },
        inline: {
          type: "boolean",
          description: "Deprecated and ignored; compatibility responses never inline content",
        },
      },
      required: ["runId"],
    },
    call: async (args) => {
      try {
        const result = new core.IntegrationRecordCompatibilityService(process.cwd()).listArtifacts(
          args
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
        throw sharedServiceError(
          error,
          "lexrunner.listArtifacts",
          "INTEGRATION_RECORD_OPERATION_FAILED"
        );
      }
    },
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // MCP/CLI Parity Tools (AX-004)
  // ─────────────────────────────────────────────────────────────────────────────

  discover: {
    description: "Discover open pull requests from GitHub with optional dependency suggestions",
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
    call: async (args) => {
      try {
        const { createGitHubAPI, GitHubAPI, DiscoveryQueryService } = await import("./dist/cli.js");

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
          throw new Error(
            "Could not detect GitHub repository. Provide owner and repo parameters or run from a git repository with GitHub remote."
          );
        }

        const result = await new DiscoveryQueryService().run({
          github: githubAPI,
          state: args.state || "open",
          suggest: args.suggest,
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
        throw new Error(`Failed to discover PRs: ${error.message}`);
      }
    },
  },

  status: {
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
          description: "Explicit candidate repository root (default: server current directory)",
        },
        evidenceFile: {
          type: "string",
          minLength: 1,
          maxLength: 4096,
          description: "Explicit gate evidence manifest returned by gates.run",
        },
        evidenceSha256: {
          type: "string",
          pattern: "^sha256:[a-f0-9]{64}$",
          description: "Expected SHA-256 returned with the gate evidence manifest",
        },
      },
    },
    call: async (args) => {
      try {
        if (
          args.repoRoot !== undefined &&
          (typeof args.repoRoot !== "string" ||
            args.repoRoot.length < 1 ||
            Buffer.byteLength(args.repoRoot, "utf8") > 4096)
        ) {
          throw new Error("repoRoot is invalid");
        }
        const repoRoot =
          args.repoRoot === undefined
            ? process.cwd()
            : core.resolveGateRepositoryRoot(args.repoRoot);
        const hasEvidenceFile = args.evidenceFile !== undefined;
        const hasEvidenceDigest = args.evidenceSha256 !== undefined;
        if (hasEvidenceFile !== hasEvidenceDigest) {
          throw new Error("evidenceFile and evidenceSha256 must be supplied together");
        }
        if (
          hasEvidenceFile &&
          (typeof args.evidenceFile !== "string" ||
            args.evidenceFile.length < 1 ||
            Buffer.byteLength(args.evidenceFile, "utf8") > 4096 ||
            typeof args.evidenceSha256 !== "string" ||
            !/^sha256:[a-f0-9]{64}$/u.test(args.evidenceSha256))
        ) {
          throw new Error("evidenceFile or evidenceSha256 is invalid");
        }
        const artifact = new core.PlanArtifactService().resolve({
          planFile: args.planFile,
          workingDir: repoRoot,
          profileDir: config.profileDir,
        });
        const result = {
          ...new core.IntegrationStatusQueryService().run(
            artifact.plan,
            args.evidenceFile
              ? {
                  evidenceFile: resolve(repoRoot, args.evidenceFile),
                  evidenceSha256: args.evidenceSha256,
                  repoRoot,
                }
              : undefined
          ),
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
        throw sharedServiceError(error, "status", "INTEGRATION_STATUS_FAILED");
      }
    },
  },

  doctor: {
    description: "Run environment and configuration sanity checks",
    inputSchema: {
      type: "object",
      properties: {},
    },
    call: async (args) => {
      try {
        const checks = await new core.WorkspaceDiagnosticsService().run({
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
        throw sharedServiceError(error, "doctor", "WORKSPACE_DIAGNOSTICS_FAILED");
      }
    },
  },

  "merge-order": {
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
    call: async (args) => {
      try {
        const artifact = new core.PlanArtifactService().resolve({
          planFile: args.planFile,
          workingDir: process.cwd(),
          profileDir: config.profileDir,
        });
        const result = {
          ...new core.MergeOrderQueryService().run(artifact.plan),
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
        throw sharedServiceError(error, "merge-order", "MERGE_ORDER_FAILED");
      }
    },
  },

  "config.show": {
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
    call: async (args) => {
      try {
        const result = new core.ConfigurationQueryService().show({
          baseDir: process.cwd(),
          key: args.key,
        });
        const output = args.key
          ? { contract: result.contract, ...result.configuration[0] }
          : result;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(output, null, 2),
            },
          ],
        };
      } catch (error) {
        throw sharedServiceError(error, "config.show", "WORKSPACE_DIAGNOSTICS_FAILED");
      }
    },
  },

  "workflow.guide": {
    description:
      "Get context-aware workflow guidance for the current phase. Provides next steps, common issues, and recommendations.",
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
    call: async (args) => {
      try {
        const { createWorkflowGuide } = await import("./dist/cli.js");
        const guide = createWorkflowGuide(args.phase);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(guide, null, 2),
            },
          ],
        };
      } catch (error) {
        throw new Error(`Failed to get workflow guide: ${error.message}`);
      }
    },
  },
};

function canonicalToolResult(result) {
  return {
    content: [{ type: "text", text: core.canonicalJSONStringify(result) }],
  };
}

function planValidationToolResult(error) {
  const failure = core.asPlanValidationFailure(error);
  return failure ? canonicalToolResult(failure) : null;
}

async function mutationToolCall(action, call) {
  if (!config.allowMutations) {
    return canonicalToolResult({
      ok: false,
      error: {
        code: "mutations_disabled",
        message: `Mutations not allowed. Set ALLOW_MUTATIONS=true to ${action}.`,
      },
    });
  }
  return canonicalToolResult(await call());
}

// MCP Protocol handler - JSON-RPC 2.0 over stdio
async function handleRequest(request) {
  const { id, method, params } = request;

  try {
    // MCP initialization handshake
    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "lexrunner",
            version: packageMetadata.version,
          },
        },
      };
    }

    // After initialization, client sends initialized notification
    if (method === "notifications/initialized") {
      // No response needed for notifications
      return null;
    }

    // Tool listing
    if (method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: Object.entries(tools).map(([name, spec]) => ({
            name,
            description: spec.description,
            inputSchema: spec.inputSchema,
          })),
        },
      };
    }

    // Tool execution
    if (method === "tools/call") {
      const { name, arguments: args } = params;
      const tool = tools[name];

      if (!tool) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Unknown tool: ${name}`,
          },
        };
      }

      try {
        const result = await tool.call(args);
        return {
          jsonrpc: "2.0",
          id,
          result,
        };
      } catch (error) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32603,
            message: error.message,
          },
        };
      }
    }

    // Unknown method
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Method not found: ${method}`,
      },
    };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: error.message,
      },
    };
  }
}

// Stdio message loop - line-delimited JSON
let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() || ""; // Keep incomplete line in buffer

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const request = JSON.parse(line);
      const response = await handleRequest(request);

      // Only send response for requests (not notifications)
      if (response) {
        console.log(JSON.stringify(response));
      }
    } catch (error) {
      console.log(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32700,
            message: `Parse error: ${error.message}`,
          },
        })
      );
    }
  }
});

process.stdin.on("end", () => {
  console.error("[lexrunner] Shutting down...");
  process.exit(0);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.error("[lexrunner] Shutting down...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.error("[lexrunner] Shutting down...");
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  console.error(`[lexrunner] Uncaught exception: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
});
