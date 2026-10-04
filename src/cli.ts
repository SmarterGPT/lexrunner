#!/usr/bin/env node
import "dotenv/config";
import packageMetadata from "../package.json" with { type: "json" };
import { Command, CommanderError } from "commander";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import chalk from "chalk";
import {
  asPlanValidationFailure,
  formatPlanValidationFailure,
  formatPlanValidationFailureText,
  Plan,
  loadPlan,
  SchemaValidationError,
} from "./schema.js";
import { computeMergeOrder, CycleError, UnknownDependencyError } from "./mergeOrder.js";
import { executeGatesWithPolicy } from "./gates.js";
import { ExecutionState } from "./executionState.js";
import { MergeEligibilityEvaluator } from "./mergeEligibility.js";
import { loadInputs } from "./core/inputs.js";
import { generatePlan } from "./core/plan.js";
import { generateSnapshot } from "./core/snapshot.js";
import { canonicalJSONStringify } from "./util/canonicalJson.js";
import { createGitHubAPI, GitHubAPI, GitHubAPIError } from "./github/api.js";
import { createGitOperations, GitOperationError } from "./git/operations.js";
import {
  bootstrapWorkspace,
  createMinimalWorkspace,
  detectProjectType,
  getEnvironmentSuggestions,
} from "./core/bootstrap.js";
import { initLocalOverlay, hasLocalOverlay } from "./config/localOverlay.js";
import {
  WriteProtectionError,
  resolveProfile,
  validateWriteOperation,
} from "./config/profileResolver.js";
import {
  parseAutopilotConfig,
  AutopilotConfigError,
  getAutopilotLevelDescription,
  AutopilotLevel,
} from "./autopilot/index.js";
import { createLogger, Logger, generateCorrelationId, healthChecker } from "./monitoring/index.js";
import { runInit } from "./commands/init.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerReportCommand } from "./commands/report.js";
import { registerRetryCommand } from "./commands/retry.js";
import { registerGateReportCommand } from "./commands/gateReport.js";
import { registerGateAttestCommand } from "./commands/gateAttest.js";
import { registerGateImportCommand } from "./commands/gateImport.js";
import { registerGateImportChecksCommand } from "./commands/gateImportChecks.js";
import { registerGateSelectCommand } from "./commands/gate-select.js";
import { registerGateOperationCommands } from "./commands/gate-operation.js";
import { registerGateTestCommand } from "./cli/commands/gate/test.js";
import { registerGovernanceReportCommand } from "./commands/governanceReport.js";
import { registerGovernanceCleanupCommand } from "./commands/governanceCleanup.js";
import { registerSecurityCommands } from "./cli-security.js";
import { registerAuditCommands } from "./cli-audit.js";
import { registerCompletionCommand } from "./commands/completion.js";
import { registerMergeOrderCommand } from "./commands/mergeOrder.js";
import { registerMergeCommand } from "./commands/merge.js";
import { registerPreviewConstraintsCommand } from "./commands/preview-constraints.js";
import { registerQueryCommand } from "./commands/query.js";
import { registerPlanDiffCommand } from "./commands/planDiff.js";
import { registerPlanCommand } from "./commands/plan.js";
import { registerSchemaCommand } from "./commands/schema.js";
import { registerAutopilotCommand } from "./commands/autopilot.js";
import { registerExecuteCommand } from "./commands/execute.js";
import { registerDiscoverCommand } from "./commands/discover.js";
import { registerPlanReviewCommand } from "./commands/planReview.js";
import { registerPlanBatchCommand } from "./commands/orchestrate/plan-batch.js";
import { registerPinToolchainCommand } from "./commands/orchestrate/pinToolchain.js";
import { registerPredictConflictsCommand } from "./commands/orchestrate/predict-conflicts.js";
import { registerGenerateDeliverablesCommand } from "./commands/orchestrate/generate-deliverables.js";
import { registerAssignBatchCommand } from "./commands/orchestrate/assign-batch.js";
import { registerAnalyzeIssuesCommand } from "./commands/orchestrate/analyze-issues.js";
import { registerHarvestCommand } from "./commands/fanout-harvest.js";
import { registerAnalyzeCommand } from "./commands/fanout-analyze.js";
import { registerMonitorCommand } from "./commands/fanout-monitor.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerConfigValidateCommand } from "./commands/config/validate.js";
import { registerIdeaCommand } from "./commands/idea.js";
import { registerCreateProjectCommand } from "./commands/create-project.js";
import { registerSeniorDevCommand } from "./commands/seniorDev.js";
import { registerIssuesCommand } from "./commands/issues.js";
import { registerBudgetCommand } from "./commands/budget.js";
import { registerMetricsCommand } from "./commands/metrics.js";
import { registerTokenReportCommand } from "./commands/tokenReport.js";
import { registerCounterExamplesCommand } from "./commands/counterExamples.js";
import { registerAttemptCommand } from "./commands/attempt.js";
import { runMigrateProfile } from "./commands/migrateProfile.js";
import { ProgressReporter } from "./util/progress.js";
import { initColorControl, isColorDisabled } from "./util/colorControl.js";
import { parseGlobalFlags, validateFlagCombinations } from "./cli/flags.js";
import { writeJsonOutput } from "./cli/output.js";
import {
  collectRegisteredCliSurface,
  type RegisteredCliCommand,
} from "./cli/registered-surface.js";
import { emitAliasWarning } from "./cli/alias-policy.js";
import { configureProgressiveHelp } from "./cli/progressive-help.js";
import { registerWeaveCommand } from "./commands/weave.js";
import { registerExplainCommand } from "./commands/explain.js";
import {
  WorkspaceConfigServiceError as WorkspaceConfigServiceFailure,
  WorkspaceInitializationService,
} from "./application/workspace-config-services.js";
import { setFrameEmissionEnabled } from "./frames/controller.js";
import {
  CLIExitSignal,
  throwExit,
  installSignalHandlers,
  installUnhandledRejectionHandler,
} from "./cli/exitHandler.js";
import { getStatusIcon, formatStatusTable, formatQueryResult } from "./cli/formatters.js";
import {
  initAuditEmitter,
  emitEvent,
  finalizeAudit,
  AuditEmitter,
  AuditOptions,
  EVENT_TYPES,
} from "./audit/index.js";
import { AUDIT_SCHEMA_VERSION } from "./audit/schema/events.js";
import { sha256 } from "./util/hash.js";
import { validatePlan as validatePlanDeps, formatValidationResult } from "./planner/validation.js";
import * as fs from "fs";
import * as path from "path";

let jsonModeActive = false;

// Guarded finalize: ensure HIPAA-prefixed errors rethrow (to map to exit 2),
// while non-HIPAA finalize errors are logged and ignored.
async function finalizeAuditGuard(emitter: AuditEmitter, status?: string): Promise<void> {
  try {
    await finalizeAudit(emitter, status);
  } catch (e) {
    if (e instanceof Error && typeof e.message === "string" && e.message.startsWith("HIPAA:")) {
      throw e; // let top-level handler map to exit code 2
    }
    console.warn("[lexrunner] audit: finalize failed (ignored)", String(e));
  }
}

/**
 * CLI exit discipline with proper error codes
 */
function exitWith(e: unknown, schemaCode = "ESCHEMA") {
  // Let CLIExitSignal propagate - don't treat it as an error
  if (e instanceof CLIExitSignal) {
    throw e;
  }

  const err: any = e;
  if (err?.code === schemaCode && Array.isArray(err.issues)) {
    console.log(JSON.stringify({ errors: err.issues }, null, 2));
    if (!jsonModeActive) {
      console.error(err.message);
    }
    process.exitCode = 2;
    throwExit(2);
  }
  if (
    e instanceof SchemaValidationError ||
    e instanceof CycleError ||
    e instanceof UnknownDependencyError ||
    e instanceof WriteProtectionError ||
    e instanceof AutopilotConfigError
  ) {
    const prefix = jsonModeActive ? "[lexrunner]" : "❌";
    if (e instanceof SchemaValidationError && !jsonModeActive) {
      console.error(
        `\n${prefix} Error:\n${formatPlanValidationFailureText(formatPlanValidationFailure(e))}\n`
      );
    } else {
      console.error(`\n${prefix} Error: ${String(err?.message ?? e)}\n`);
    }

    // Add helpful suggestions based on error type (suppress in JSON mode)
    if (!jsonModeActive) {
      if (e instanceof WriteProtectionError) {
        console.error("💡 Tip: Use a local profile directory for development:");
        console.error("   lexrunner init --profile-dir .smartergpt.local\n");
      } else if (e instanceof CycleError) {
        console.error("💡 Tip: Check your dependency declarations in PR descriptions");
        console.error("   Look for circular dependencies like: A→B→C→A\n");
      } else if (e instanceof UnknownDependencyError) {
        console.error("💡 Tip: Ensure all referenced PRs exist and are included in your plan");
        console.error("   Run 'lexrunner discover' to find available PRs\n");
      } else if (e instanceof SchemaValidationError) {
        console.error("💡 Tip: Validate your configuration files:");
        console.error("   lexrunner schema validate plan.json\n");
      }
    }

    process.exitCode = 2;
    throwExit(2); // Validation errors
  }
  // HIPAA fail-closed errors are surfaced as Error messages prefixed with 'HIPAA:'
  if (e instanceof Error && typeof e.message === "string" && e.message.startsWith("HIPAA:")) {
    const prefix = jsonModeActive ? "[lexrunner]" : "❌";
    console.error(`\n${prefix} ${e.message.replace(/^HIPAA:\s*/, "")}\n`);
    process.exitCode = 2;
    throwExit(2);
  }
  const prefix = jsonModeActive ? "[lexrunner]" : "❌";
  console.error(`\n${prefix} Unexpected error: ${String(err?.message ?? e)}\n`);
  if (!jsonModeActive) {
    console.error("💡 Tip: Run 'lexrunner doctor' to check your environment\n");
  }
  throwExit(1); // Unexpected failures
}

// Global logger instance
let logger: Logger;

const program = new Command();

// Intercept all Commander exits centrally - no brittle message filtering needed
program.exitOverride((err: CommanderError) => {
  // Help/version often exit with code 0; normalize through CLIExitSignal
  throw new CLIExitSignal(err.exitCode ?? 1, err.message);
});

// Configure output streams explicitly for JSON purity
program.configureOutput({
  writeOut: (str) => process.stdout.write(str),
  writeErr: (str) => process.stderr.write(str),
});

program
  .name("lexrunner")
  .description(
    "LexRunner - Fan-out PRs, compute merge pyramid, run gates, and weave merges cleanly"
  )
  .version(`LexRunner ${packageMetadata.version} (lexrunner)`)
  .option("--no-color", "Disable ANSI color codes in output")
  .option("--audit-profile <profile>", "Audit logging profile: off|basic|soc2|hipaa-strict", "off")
  .option("--audit-key <hex>", "Audit encryption key (64 hex chars) - overrides LEX_AUDIT_KEY_HEX")
  .option("--json", "Enable JSON output mode (implies --no-color)")
  .option(
    "--log-format <format>",
    "Log output format: 'json' or 'human'",
    process.env.LOG_FORMAT || "human"
  )
  .option("--token-budget <number>", "Maximum token budget for operations (default: 5000)", "5000")
  .option("--max-prompts <number>", "Maximum number of prompts allowed (default: 3)", "3")
  .option(
    "--emit-frames",
    "Emit Frames to Lex memory during fanout/merge-weave operations (default: true, env: LEX_PR_EMIT_FRAMES)"
  )
  .option("--no-emit-frames", "Disable Frame emission")
  .hook("preAction", (thisCommand, actionCommand) => {
    // Initialize color control based on global flags
    const opts = thisCommand.optsWithGlobals();
    const jsonMode = opts.json || false;
    const noColor = opts.noColor || false;

    // Set global JSON mode
    jsonModeActive = jsonMode;

    // Initialize color control (--json implies --no-color)
    initColorControl({ noColor, jsonMode });

    // Parse global flags and set frame emission enabled state
    const globalFlags = parseGlobalFlags(opts);
    if (globalFlags.emitFrames !== undefined) {
      setFrameEmissionEnabled(globalFlags.emitFrames);
    }
    emitAliasWarning(actionCommand);
  });

configureProgressiveHelp(program);

// Gate report validation command - modular implementation
registerGateReportCommand(program);

// Governance report command (QOL-004) - modular implementation
registerGovernanceReportCommand(program);

// Governance cleanup command (QOL-002) - modular implementation
registerGovernanceCleanupCommand(program);

// Config inspect command
program
  .command("config:inspect")
  .description("Display merged configuration with provenance map")
  .option("--json", "Output canonical JSON format")
  .action((opts) => {
    try {
      // Load configuration with provenance tracking
      const config = loadInputs();

      // Check both command-level and global JSON mode
      if (opts.json || jsonModeActive) {
        // Output deterministic JSON with sorted keys
        const output = {
          config: {
            items: config.items,
            target: config.target,
            version: config.version,
          },
          provenance: config.provenance || {},
          sources: config.sources.map((s) => ({
            exists: s.exists,
            file: s.file,
          })),
        };
        writeJsonOutput(output);
      } else {
        // Human-readable output
        console.log(chalk.bold("\n📋 Configuration Inspection\n"));

        console.log(chalk.cyan("Configuration:"));
        console.log(`  Version: ${config.version}`);
        console.log(`  Target: ${config.target}`);
        console.log(`  Items: ${config.items.length}\n`);

        if (config.provenance) {
          console.log(chalk.cyan("Provenance Map:"));
          const sortedKeys = Object.keys(config.provenance).sort();
          for (const key of sortedKeys) {
            console.log(`  ${key}: ${chalk.green(config.provenance[key])}`);
          }
          console.log("");
        }

        console.log(chalk.cyan("Configuration Sources:"));
        for (const source of config.sources) {
          const status = source.exists ? chalk.green("✓") : chalk.gray("✗");
          console.log(`  ${status} ${source.file}`);
        }
        console.log("");
      }

      process.exit(0);
    } catch (error) {
      exitWith(error);
    } finally {
      // no audit finalization here
    }
  });

// Plan review command - Interactive plan validation and editing
registerPlanReviewCommand(program, {
  exitWith,
  getProgramOpts: () => program.opts(),
});

// Plan diff command - modular implementation
registerPlanDiffCommand(program, {
  jsonModeActive: () => jsonModeActive,
  exitWith,
});

// Autopilot command - modular implementation
registerAutopilotCommand(program, {
  jsonModeActive: () => jsonModeActive,
  exitWith,
  getAuditProfile: () => program.opts().auditProfile as string | undefined,
  getAuditKey: () => program.opts().auditKey as string | undefined,
  finalizeAuditGuard,
});

// Schema command - modularized in Phase 3.3
registerSchemaCommand(program, {
  jsonModeActive: () => jsonModeActive,
});

// ============================================================================
// Category-Action Pattern Commands (ALN-003 Phase 2)
// ============================================================================

// Weave command group - Unified merge-weave workflow interface
// This is the primary interface for merge-weave operations
registerWeaveCommand(program, {
  jsonModeActive: () => jsonModeActive,
  getProgramOpts: () => program.opts(),
});

// Explain command - LR-TSF-001: Query constraint attributions
registerExplainCommand(program);

// Workspace category - Local workspace management
const workspaceCmd = program
  .command("workspace")
  .description("Workspace and profile configuration");

// workspace init - Already registered as top-level, need to create wrapper
workspaceCmd
  .command("init")
  .description("Initialize lexrunner workspace with interactive setup wizard")
  .option("--force", "Overwrite existing configuration files")
  .option("--non-interactive", "Run without prompts (use environment variables)")
  .option("--github-token <token>", "GitHub token for authentication")
  .option("--profile-dir <dir>", "Profile directory (default: .smartergpt.local)")
  .option("--json", "Output JSON format")
  .option("--enterprise", "Enable enterprise setup with audit and compliance features")
  .option(
    "--enterprise-audit-profile <profile>",
    "Audit profile for enterprise setup: off|basic|soc2|hipaa-strict",
    "soc2"
  )
  .option(
    "--policy-template <template>",
    "Policy template for enterprise setup: basic|enterprise-standard|strict",
    "enterprise-standard"
  )
  .action(async (opts) => {
    // Delegate to the init command handler (imported from runInit)
    const isJsonMode = opts.json || jsonModeActive;

    try {
      if (opts.nonInteractive && !opts.enterprise && !opts.profileDir) {
        const initialized = new WorkspaceInitializationService().run({
          baseDir: process.cwd(),
          force: opts.force,
        });
        if (isJsonMode) {
          const { writeSuccessEnvelope } = await import("./cli/jsonEnvelope.js");
          writeSuccessEnvelope("lex-pr workspace init", initialized);
        } else {
          console.log(
            initialized.created
              ? `Workspace initialized at ${initialized.path}`
              : `Workspace already initialized at ${initialized.path}`
          );
        }
        return;
      }

      const result = await runInit({
        force: opts.force,
        nonInteractive: opts.nonInteractive,
        githubToken: opts.githubToken,
        profileDir: opts.profileDir,
        jsonMode: isJsonMode,
        enterprise: opts.enterprise,
        auditProfile: opts.enterpriseAuditProfile,
        policyTemplate: opts.policyTemplate,
      });

      if (isJsonMode) {
        const { writeSuccessEnvelope, writeErrorEnvelope } = await import("./cli/jsonEnvelope.js");
        if (result.success) {
          writeSuccessEnvelope("lex-pr workspace init", {
            profileDir: result.profileDir,
            message: result.message,
          });
          return;
        } else {
          writeErrorEnvelope("lex-pr workspace init", {
            code: "EINIT",
            message: result.message,
            details: { profileDir: result.profileDir },
          });
          throwExit(1);
        }
      }

      if (!result.success) {
        console.error(`\n❌ ${result.message}\n`);
        throwExit(1);
      }

      return;
    } catch (error) {
      if (error instanceof CLIExitSignal) {
        throw error;
      }

      if (isJsonMode) {
        const { writeErrorEnvelope, errorToJsonError } = await import("./cli/jsonEnvelope.js");
        if (error instanceof WorkspaceConfigServiceFailure) {
          writeErrorEnvelope("lex-pr workspace init", {
            code: error.code,
            message: error.message,
          });
          throwExit(1);
        }
        if (error instanceof WriteProtectionError) {
          writeErrorEnvelope("lex-pr workspace init", {
            code: "EWRITE_PROTECTED",
            message: error.message,
          });
          throwExit(2);
        }
        writeErrorEnvelope("lex-pr workspace init", errorToJsonError(error, "EINIT_FAILED"));
        throwExit(1);
      }

      if (error instanceof WriteProtectionError) {
        console.error(`\n❌ ${error.message}\n`);
        throwExit(2);
      }
      console.error(
        `\n❌ Initialization failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
      throwExit(1);
    }
  });

// workspace doctor - Environment validation
registerDoctorCommand(workspaceCmd, () => jsonModeActive);

// Fanout category - Issue discovery, analysis, and planning
const fanoutCmd = program.command("fanout").description("Issue discovery, analysis, and planning");

// Register D0 (harvest) and D1 (analyze) commands
registerHarvestCommand(fanoutCmd);
registerAnalyzeCommand(fanoutCmd);
registerMonitorCommand(fanoutCmd);

// Gate category - Quality gate execution
const gateCmd = program.command("gate").description("Quality gate execution");
registerGateOperationCommands(gateCmd);

registerExecuteCommand(
  gateCmd,
  {
    jsonModeActive: () => jsonModeActive,
    exitWith,
    getProgramOpts: () => program.opts(),
  },
  { commandName: "run", canonicalOutput: true }
);
registerExecuteCommand(gateCmd, {
  jsonModeActive: () => jsonModeActive,
  exitWith,
  getProgramOpts: () => program.opts(),
});
registerGateTestCommand(gateCmd);
registerGateAttestCommand(gateCmd);
registerGateImportCommand(gateCmd);
registerGateImportChecksCommand(gateCmd);
registerGateSelectCommand(gateCmd, () => jsonModeActive);

// ============================================================================
// Legacy Commands (Deprecated - ALN-003 Phase 2)
// ============================================================================
// These commands are maintained for backward compatibility but show
// deprecation warnings directing users to the canonical category-action forms.
// The deprecation warnings are built into the command implementations themselves
// by checking the parent program name (top-level) vs a category name.

// Note: We DON'T re-register weave subcommands (discover, plan, status, report, merge-order)
// as top-level commands because that would create duplicate command errors.
// Instead, users can still use the old top-level commands if we register them separately.
// However, since the register functions check the parent program name, we just register them
// once and the commands themselves will show the deprecation warning.

// Legacy commands that need explicit registration (not part of weave):
// - execute -> gate run (already registered above on gateCmd)
// - doctor -> workspace doctor (already registered above on workspaceCmd)

// But we DO need top-level discover, plan, status, report, merge-order for backward compat
// Let's register them separately with deprecation built-in:

registerDiscoverCommand(program, { jsonModeActive: () => jsonModeActive });
registerPlanCommand(program, {
  jsonModeActive: () => jsonModeActive,
  setJsonMode: (active: boolean) => {
    jsonModeActive = active;
  },
  exitWith,
});
registerStatusCommand(program, () => jsonModeActive);
registerReportCommand(program, { jsonModeActive: () => jsonModeActive });
registerMergeOrderCommand(program, () => jsonModeActive, exitWith);
registerExecuteCommand(program, {
  jsonModeActive: () => jsonModeActive,
  exitWith,
  getProgramOpts: () => program.opts(),
});
registerDoctorCommand(program, () => jsonModeActive);

// ============================================================================
// Other Commands (Not Part of Category-Action Pattern)
// ============================================================================

// Merge command - Execute merge pyramid with git operations
registerMergeCommand(
  program,
  () => jsonModeActive,
  () => program.opts()
);

// Preview Constraints command - Preview constraints for a plan
registerPreviewConstraintsCommand(program, { jsonModeActive: () => jsonModeActive });

// Config command - configuration inspection and debugging
registerConfigCommand(program, { jsonModeActive: () => jsonModeActive });

// Config validate command - configuration validation
registerConfigValidateCommand(program, () => jsonModeActive);

// Idea command - feature idea capture
registerIdeaCommand(program);

// Issues command - Check status of GitHub issues
registerIssuesCommand(program);

// Senior Dev executor commands
registerSeniorDevCommand(program, () => jsonModeActive);

// Budget command - governance budget management
registerBudgetCommand(program, () => jsonModeActive);

// Init command - Interactive workspace setup
program
  .command("init")
  .description("Initialize lexrunner workspace with interactive setup wizard")
  .option("--force", "Overwrite existing configuration files")
  .option("--non-interactive", "Run without prompts (use environment variables)")
  .option("--github-token <token>", "GitHub token for authentication")
  .option("--profile-dir <dir>", "Profile directory (default: .smartergpt.local)")
  .option("--json", "Output JSON format")
  .action(async (opts) => {
    // Check both command-level and global JSON mode
    const isJsonMode = opts.json || jsonModeActive;

    try {
      const result = await runInit({
        force: opts.force,
        nonInteractive: opts.nonInteractive,
        githubToken: opts.githubToken,
        profileDir: opts.profileDir,
        jsonMode: isJsonMode,
      });

      if (isJsonMode) {
        const { writeSuccessEnvelope, writeErrorEnvelope, errorToJsonError } =
          await import("./cli/jsonEnvelope.js");
        if (result.success) {
          writeSuccessEnvelope("lex-pr init", {
            profileDir: result.profileDir,
            message: result.message,
          });
          return;
        } else {
          writeErrorEnvelope("lex-pr init", {
            code: "EINIT",
            message: result.message,
            details: { profileDir: result.profileDir },
          });
          throwExit(1);
        }
      }

      if (!result.success) {
        console.error(`\n❌ ${result.message}\n`);
        throwExit(1);
      }

      return;
    } catch (error) {
      // Skip CLIExitSignal in JSON mode to avoid duplicate output
      if (error instanceof CLIExitSignal) {
        throw error;
      }

      if (isJsonMode) {
        const { writeErrorEnvelope, errorToJsonError } = await import("./cli/jsonEnvelope.js");
        if (error instanceof WriteProtectionError) {
          writeErrorEnvelope("lex-pr init", {
            code: "EWRITE_PROTECTED",
            message: error.message,
          });
          throwExit(2);
        }
        writeErrorEnvelope("lex-pr init", errorToJsonError(error, "EINIT_FAILED"));
        throwExit(1);
      }

      if (error instanceof WriteProtectionError) {
        console.error(`\n❌ ${error.message}\n`);
        throwExit(2);
      }
      console.error(
        `\n❌ Initialization failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
      throwExit(1);
    }
  });

// Bootstrap command
program
  .command("bootstrap")
  .description("Create minimal workspace configuration")
  .option("--force", "Overwrite existing configuration files")
  .option("--json", "Output JSON format")
  .action(async (opts) => {
    try {
      const bootstrap = bootstrapWorkspace();
      const projectType = detectProjectType();

      if (opts.json) {
        if (bootstrap.hasConfiguration && !opts.force) {
          console.log(
            canonicalJSONStringify({
              status: "exists",
              message: "Configuration already exists",
              bootstrap,
              projectType,
            })
          );
        } else {
          createMinimalWorkspace();
          console.log(
            canonicalJSONStringify({
              status: "created",
              message: "Minimal configuration created",
              projectType,
              filesCreated: bootstrap.missingFiles,
            })
          );
        }
      } else {
        console.log("🚀 Bootstrapping workspace configuration");
        console.log(`📁 Project type detected: ${projectType}`);
        console.log("");

        if (bootstrap.hasConfiguration && !opts.force) {
          console.log("✓ Configuration already exists");
          console.log(`  ${bootstrap.profileDir}/`);
          console.log("");
          console.log("Use --force to overwrite existing files");
        } else {
          createMinimalWorkspace();
          console.log("✓ Created minimal configuration:");
          console.log(`  ${bootstrap.profileDir}/intent.md`);
          console.log(`  ${bootstrap.profileDir}/scope.yml`);
          console.log(`  ${bootstrap.profileDir}/deps.yml`);
          console.log(`  ${bootstrap.profileDir}/gates.yml`);
          console.log("");
          console.log("Next steps:");
          console.log("1. Edit .smartergpt/intent.md to describe your project goals");
          console.log("2. Update .smartergpt/scope.yml for PR discovery rules");
          console.log("3. Configure .smartergpt/gates.yml for quality gates");
          console.log("4. Run 'lexrunner doctor' to verify configuration");
        }
      }
    } catch (error) {
      if (error instanceof WriteProtectionError) {
        console.error(`Error bootstrapping workspace: ${error.message}`);
        throwExit(2); // Validation/config error
      }
      console.error(
        `Error bootstrapping workspace: ${error instanceof Error ? error.message : String(error)}`
      );
      throwExit(1);
    }
  });

program
  .command("init-local")
  .description("Initialize local overlay directory with auto-detected project configuration")
  .option("--force", "Force recreation even if local overlay exists")
  .option("--json", "Output JSON format")
  .action(async (opts) => {
    try {
      const result = initLocalOverlay(process.cwd(), opts.force);

      if (opts.json || jsonModeActive) {
        console.log(
          canonicalJSONStringify({
            created: result.created,
            path: result.path,
            config: result.config,
            copiedFiles: result.copiedFiles,
          })
        );
      } else {
        if (result.created) {
          console.log("🎉 Local overlay initialized successfully");
          console.log("");
          console.log(`📁 Created: ${result.path}/`);
          console.log(`🔧 Project type: ${result.config.projectType}`);
          console.log(`👤 Role: ${result.config.role}`);
          console.log("");

          if (result.copiedFiles.length > 0) {
            console.log("📋 Copied files from .smartergpt/:");
            result.copiedFiles.forEach((file) => {
              console.log(`  • ${file}`);
            });
            console.log("");
          }

          console.log("Next steps:");
          console.log("1. Edit .smartergpt.local/ files to customize for local development");
          console.log("2. .smartergpt.local/ is gitignored and won't be committed");
          console.log("3. Run commands normally - local overlay takes precedence");
        } else {
          console.log("ℹ️  Local overlay already exists");
          console.log("");
          console.log(`📁 Location: ${result.path}/`);
          console.log(`🔧 Project type: ${result.config.projectType}`);
          console.log(`👤 Role: ${result.config.role}`);
          console.log("");
          console.log("Use --force to recreate");
        }
      }
    } catch (error) {
      console.error(
        `Error initializing local overlay: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      throwExit(1);
    }
  });

// Migrate profile command
program
  .command("migrate-profile")
  .description("Migrate profile configuration structure (canonical: lexrunner workspace migrate)")
  .option("--from-flat", "Migrate from flat structure to runner/ subdirectory")
  .option("--dry-run", "Show what would be migrated without making changes")
  .option("--profile-dir <path>", "Profile directory to migrate (default: auto-detect)")
  .action(async (opts) => {
    try {
      const result = await runMigrateProfile({
        fromFlat: opts.fromFlat,
        dryRun: opts.dryRun,
        profileDir: opts.profileDir,
      });

      if (opts.json || jsonModeActive) {
        console.log(
          canonicalJSONStringify({
            success: result.success,
            message: result.message,
            migratedFiles: result.migratedFiles,
            backupPath: result.backupPath,
            skippedFiles: result.skippedFiles,
          })
        );
      } else {
        if (result.success) {
          if (result.migratedFiles.length > 0) {
            console.log("✅ Migration successful!");
            console.log("");
            console.log(`📦 Migrated ${result.migratedFiles.length} file(s):`);
            result.migratedFiles.forEach((file) => {
              console.log(`  ✓ ${file}`);
            });
            if (result.backupPath) {
              console.log("");
              console.log(`💾 Backup created: ${result.backupPath}`);
            }
            if (result.skippedFiles.length > 0) {
              console.log("");
              console.log("ℹ️  Skipped files:");
              result.skippedFiles.forEach((file) => {
                console.log(`  • ${file}`);
              });
            }
          } else {
            console.log("ℹ️  " + result.message);
          }
        } else {
          console.log("❌ Migration failed");
          console.log("");
          console.log(result.message);
        }
      }

      if (!result.success) {
        throwExit(1);
      }
    } catch (error) {
      console.error(
        `Error during migration: ${error instanceof Error ? error.message : String(error)}`
      );
      throwExit(1);
    }
  });

// Interactive plan viewer command
program
  .command("view")
  .description("Interactive plan viewer with navigation and filtering")
  .option("--plan <file>", "Path to plan.json file")
  .argument("[file]", "Path to plan.json file (alternative to --plan)")
  .option("--filter <text>", "Initial filter text")
  .option("--no-deps", "Hide dependencies by default")
  .option("--no-gates", "Hide gates by default")
  .action(async (file: string | undefined, opts) => {
    const planFile = opts.plan || file;
    if (!planFile) {
      console.error("Error: plan file is required (use --plan <file> or provide as argument)");
      throwExit(1);
    }

    try {
      const { InteractivePlanViewer } = await import("./commands/planViewer.js");
      const planContent = fs.readFileSync(planFile, "utf-8");
      const plan = loadPlan(planContent);

      const viewer = new InteractivePlanViewer(plan, {
        filter: opts.filter,
        showDeps: opts.deps,
        showGates: opts.gates,
      });

      await viewer.start();
      return;
    } catch (error) {
      exitWith(error);
    }
  });

// Deliverables list command
program
  .command("deliverables:list")
  .description("List all autopilot deliverables with metadata")
  .option("--profile-dir <dir>", "Profile directory (default: .smartergpt)")
  .option("--json", "Output JSON format")
  .action(async (opts) => {
    try {
      const profile = resolveProfile(opts.profileDir);
      const { DeliverablesManager } = await import("./autopilot/index.js");
      const manager = new DeliverablesManager(profile.path);
      const deliverables = await manager.listDeliverables();

      if (opts.json) {
        writeJsonOutput(deliverables);
      } else {
        if (deliverables.length === 0) {
          console.log("No deliverables found");
          return;
        }

        console.log(`\n📦 Deliverables in ${manager.getDeliverablesRoot()}\n`);

        deliverables.forEach((d, idx) => {
          console.log(`${idx + 1}. ${d.timestamp}`);
          console.log(`   Level: ${d.levelExecuted}`);
          console.log(`   Plan Hash: ${d.planHash.substring(0, 12)}...`);
          console.log(`   Artifacts: ${d.artifacts.length}`);
          console.log(`   Environment: ${d.executionContext.environment}`);
          if (d.executionContext.actor) {
            console.log(`   Actor: ${d.executionContext.actor}`);
          }
          console.log("");
        });

        const latest = manager.getLatestPath();
        if (latest) {
          console.log(`📍 Latest: ${path.basename(latest)}`);
        }
      }
    } catch (error) {
      console.error(
        `Error listing deliverables: ${error instanceof Error ? error.message : String(error)}`
      );
      throwExit(1);
    }
  });

// Deliverables cleanup command
program
  .command("deliverables:cleanup")
  .description("Clean up old deliverables based on retention policy")
  .option("--profile-dir <dir>", "Profile directory (default: .smartergpt)")
  .option("--max-age <days>", "Maximum age in days (deletes older deliverables)")
  .option("--max-count <count>", "Maximum number of deliverables to keep")
  .option("--keep-latest", "Always keep the latest deliverables (default: true)", true)
  .option("--dry-run", "Preview cleanup without deleting")
  .option("--json", "Output JSON format")
  .action(async (opts) => {
    try {
      const profile = resolveProfile(opts.profileDir);
      const { DeliverablesManager } = await import("./autopilot/index.js");
      const manager = new DeliverablesManager(profile.path);

      const policy = {
        maxAge: opts.maxAge ? parseInt(opts.maxAge) : undefined,
        maxCount: opts.maxCount ? parseInt(opts.maxCount) : undefined,
        keepLatest: opts.keepLatest,
      };

      if (opts.dryRun) {
        // Preview mode - show what would be deleted
        const deliverables = await manager.listDeliverables();
        let toKeep = deliverables;

        if (policy.maxCount !== undefined && policy.maxCount > 0) {
          toKeep = toKeep.slice(0, policy.maxCount);
        }

        if (policy.maxAge !== undefined && policy.maxAge > 0) {
          const cutoffDate = new Date();
          cutoffDate.setDate(cutoffDate.getDate() - policy.maxAge);
          toKeep = toKeep.filter((d) => new Date(d.timestamp) > cutoffDate);
        }

        if (policy.keepLatest && deliverables.length > 0 && !toKeep.includes(deliverables[0])) {
          toKeep = [deliverables[0], ...toKeep];
        }

        const keepSet = new Set(toKeep.map((d) => d.timestamp));
        const toRemove = deliverables.filter((d) => !keepSet.has(d.timestamp));

        if (opts.json) {
          console.log(
            canonicalJSONStringify({
              dryRun: true,
              policy,
              toKeep: toKeep.length,
              toRemove: toRemove.length,
              deliverables: toRemove,
            })
          );
        } else {
          console.log("\n🔍 Cleanup Preview (dry-run)\n");
          console.log(
            `Policy: ${policy.maxAge ? `max-age=${policy.maxAge}d` : ""} ${
              policy.maxCount ? `max-count=${policy.maxCount}` : ""
            } keep-latest=${policy.keepLatest}`
          );
          console.log("");
          console.log(`Would keep: ${toKeep.length} deliverables`);
          console.log(`Would remove: ${toRemove.length} deliverables`);

          if (toRemove.length > 0) {
            console.log("\nTo be removed:");
            toRemove.forEach((d) => {
              const dirName = `weave-${d.timestamp.replace(/[:.]/g, "-").replace("Z", "")}`;
              console.log(`  - ${dirName} (${d.timestamp})`);
            });
          }

          console.log("\nRun without --dry-run to apply changes");
        }
      } else {
        // Actual cleanup
        const result = await manager.cleanup(policy);

        if (opts.json) {
          writeJsonOutput(result);
        } else {
          console.log("\n🧹 Cleanup Complete\n");
          console.log(`Removed: ${result.removed.length} deliverables`);
          console.log(`Kept: ${result.kept.length} deliverables`);
          console.log(`Freed space: ${(result.freedSpace / 1024).toFixed(2)} KB`);

          if (result.removed.length > 0) {
            console.log("\nRemoved:");
            result.removed.forEach((path) => {
              console.log(`  - ${path}`);
            });
          }
        }
      }
    } catch (error) {
      console.error(
        `Error cleaning up deliverables: ${error instanceof Error ? error.message : String(error)}`
      );
      throwExit(1);
    }
  });

// Query command - modular implementation
registerQueryCommand(program, {
  exitWith,
  jsonModeActive: () => jsonModeActive,
});

// Retry command
registerRetryCommand(program, () => jsonModeActive, exitWith);

// Completion command
registerCompletionCommand(program, throwExit, exitWith);

// Counter-examples command
registerCounterExamplesCommand(program);

// ADR-010 Stage 2 agent-work Attempt lifecycle.
registerAttemptCommand(program, { jsonModeActive: () => jsonModeActive });

// Security operations command
// Register security subcommands once (modular implementation)
registerSecurityCommands(program);

// ============================================================================
// Legacy Orchestration Commands (Deprecated - ALN-003 Phase 2)
// ============================================================================
// orchestrate:analyze-issues and orchestrate:assign-batch are deprecated
// in favor of fanout analyze and fanout assign (registered above).
// We still register them here on the main program for backward compatibility
// but they show deprecation warnings.
registerAnalyzeIssuesCommand(program, () => jsonModeActive);
registerAssignBatchCommand(program);

// Keep other orchestrate commands that don't have category equivalents yet
registerPlanBatchCommand(program, () => jsonModeActive);
registerPinToolchainCommand(program);
registerPredictConflictsCommand(program, () => jsonModeActive);
registerGenerateDeliverablesCommand(program);

// Audit operations command
registerAuditCommands(program);

// Create project command
registerCreateProjectCommand(program);

// Metrics command for governance observability
registerMetricsCommand(program, { jsonModeActive: () => jsonModeActive });

// Token usage tracking and reporting
registerTokenReportCommand(program, { jsonModeActive: () => jsonModeActive });

/** Architecture-test hook; returns metadata only and never executes a command. */
export function inspectRegisteredCliSurface(): RegisteredCliCommand[] {
  return collectRegisteredCliSurface(program);
}

export async function main(argv: string[] = process.argv): Promise<void> {
  try {
    await program.parseAsync(argv);
    if (process.exitCode === undefined || process.exitCode === null) {
      process.exitCode = 0;
    }
  } catch (error) {
    if (error instanceof CLIExitSignal) {
      process.exitCode = error.exitCode;
      // Don't output error message for successful exits
      if (error.exitCode !== 0) {
        // Only output custom messages, not the default "CLI exited with code N"
        if (error.message && !error.message.startsWith("CLI exited with code")) {
          process.stderr.write(`${error.message}\n`);
        }
      }
      return;
    }
    if (error instanceof CommanderError) {
      // Already intercepted by exitOverride and converted to CLIExitSignal
      // This branch should never execute, but handle defensively
      const exitCode = typeof error.exitCode === "number" ? error.exitCode : 1;
      process.exitCode = exitCode;
      if (exitCode !== 0 && error.message) {
        process.stderr.write(`${error.message}\n`);
      }
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const prefix = jsonModeActive ? "[lexrunner]" : "❌";
    process.stderr.write(`${prefix} ${message}\n`);
    process.exitCode = 1;
  }
}

// ============================================================================
// Entry point detection (ESM/CJS compatible, cross-platform)
// ============================================================================
// CRITICAL: This must work in both ESM (.js) and CJS (.cjs) builds, and handle
// Windows paths, symlinks, and URL encoding correctly.
//
// - ESM build: import.meta is available and we check import.meta.url
// - CJS build: import.meta.url will be undefined/empty (tsup warning is expected)
//
// Comparing real paths ensures:
// 1. Windows paths are normalized through resolve + realpath
// 2. Symlinks are resolved consistently
// 3. Module URL encoding is decoded (spaces, special chars)
//
// tsup will emit a warning about import.meta in CJS, but that's acceptable since:
// 1. The check prevents execution in CJS context
// 2. The warning is cosmetic and doesn't affect runtime behavior
// 3. Config-based suppression (tsup.config.ts) silences the noise
//
// DO NOT REFACTOR to simple string comparison - it breaks on Windows/symlinks.
// ============================================================================
const isDirectExec = (() => {
  try {
    if (typeof import.meta === "undefined") return false;
    if (!process.argv[1] || !import.meta.url) return false;
    const invokedPath = fs.realpathSync(resolve(process.argv[1]));
    const modulePath = fs.realpathSync(fileURLToPath(import.meta.url));
    return invokedPath === modulePath;
  } catch {
    return false;
  }
})();

if (isDirectExec) {
  // Install global handlers before running main
  installSignalHandlers();
  installUnhandledRejectionHandler();

  void main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[lexrunner] fatal: ${message}\n`);
    process.exitCode = process.exitCode ?? 1;
  });
}

// ============================================================================
// MCP Server Exports
// ============================================================================
// These exports are used by mcp-server.mjs for the aligned stdio protocol.
// Keep functionality intact - only the protocol layer changes.
export {
  // Core functionality
  loadInputs,
  generatePlan,
  generateSnapshot,
  loadPlan,
  asPlanValidationFailure,
  formatPlanValidationFailure,
  formatPlanValidationFailureText,

  // Execution
  executeGatesWithPolicy,
  ExecutionState,
  MergeEligibilityEvaluator,

  // Configuration
  initLocalOverlay,
  resolveProfile,

  // Utilities
  canonicalJSONStringify,

  // Monitoring
  healthChecker,
};

// Run management exports for MCP tools
export { createRunManager } from "./runs/index.js";
export {
  AgentWorkContainmentPreflightRequestJsonSchema,
  createAgentWorkContainmentPreflightHandler,
} from "./runs/index.js";
export {
  NativeWslProjectionCleanupRequestJsonSchema,
  NativeWslProjectionPrepareRequestJsonSchema,
  NativeWslProjectionQuarantineRequestJsonSchema,
  NativeWslProjectionStatusRequestJsonSchema,
  createNativeWslProjectionLifecycleHandlers,
} from "./runs/index.js";
export {
  AttemptPrepareRequestJsonSchema,
  AttemptStartRequestJsonSchema,
  AttemptStatusInputJsonSchema,
  createAttemptLifecycleHandlers,
} from "./runs/index.js";
export {
  AttemptReceiptStatusRequestJsonSchema,
  AttemptReceiptSubmitRequestJsonSchema,
  createAttemptReceiptHandlers,
} from "./runs/index.js";
export {
  AttemptAcceptanceApplyRequestJsonSchema,
  AttemptAcceptanceStatusRequestJsonSchema,
  AttemptVerificationRunRequestJsonSchema,
  AttemptVerificationStatusRequestJsonSchema,
  createAttemptVerificationHandlers,
} from "./runs/index.js";
export {
  AttemptWorkerAttachRequestJsonSchema,
  AttemptWorkerEndRequestJsonSchema,
  AttemptWorkerHeartbeatRequestJsonSchema,
  AttemptWorkerStatusRequestJsonSchema,
  createAttemptWorkerHandlers,
} from "./runs/index.js";
export {
  AgentWorkFanoutService,
  executeAgentWorkPreparation,
  orderAgentWorkPreparationSteps,
} from "./runs/index.js";
export type {
  AgentWorkFanInResult,
  AgentWorkPreparationCommandResult,
  AgentWorkPreparationCommandRunner,
  AgentWorkPreparationResult,
  CreateAgentWorkFanoutInput,
  DecideAgentWorkFanInInput,
  ExecuteAgentWorkPreparationInput,
} from "./runs/index.js";
export * from "./runs/attempt-awaitable-contract.js";
export * from "./runs/attempt-awaitable-supervisor.js";
export * from "./runs/axf-attempt-awaitable-observer.js";
export * from "./store/attempt-awaitable-store.js";
export { InMemoryAttemptAwaitableStore } from "./store/inmemory/attempt-awaitable-store.js";
export { SqliteAttemptAwaitableStore } from "./store/sqlite/attempt-awaitable-store.js";

// AX-004: MCP/CLI parity exports
export { resolveGateRepositoryRoot } from "./application/gate-candidate-identity.js";
export {
  GateOperationService,
  GateOperationServiceError,
  GateOperationStartJsonSchema,
  GateOperationObserveJsonSchema,
} from "./application/gate-operation-service.js";
export { computeMergeOrder } from "./mergeOrder.js";
export { createGitHubAPI, GitHubAPI } from "./github/api.js";
export { createGitHubClient } from "./github/client.js";
export { generatePlanFromGitHub } from "./core/githubPlan.js";
export { generateMultiRepoPlan } from "./core/multiRepoPlan.js";
export type { RepoTarget, MultiRepoPlanOptions } from "./core/multiRepoPlan.js";
export { generateGitHubSnapshot } from "./core/snapshot.js";
export { createGitOperations } from "./git/operations.js";
export {
  bootstrapWorkspace,
  detectProjectType,
  getEnvironmentSuggestions,
} from "./core/bootstrap.js";
export { createFileAnalyzer } from "./planner/fileAnalysis.js";
export {
  GateExecutionService,
  GateExecutionServiceError,
} from "./application/gate-execution-service.js";
export {
  GATE_IMPACT_MODEL,
  GateImpactService,
  GateImpactServiceError,
  applyGateImpactSelection,
  writeGateImpactReceipt,
} from "./application/gate-impact-service.js";
export type {
  BoundedGateRunResult,
  GateExecutionServiceInput,
  GateExecutionServiceResult,
} from "./application/gate-execution-service.js";
export {
  DiscoveryQueryService,
  IntegrationQueryServiceError,
  IntegrationStatusQueryService,
  MergeOrderQueryService,
  PlanCreationService,
} from "./application/integration-query-services.js";
export type {
  BoundedDiscoveryResult,
  BoundedIntegrationStatus,
  BoundedMergeOrderResult,
} from "./application/integration-query-services.js";
export {
  MergeApplicationService,
  MergeApplicationServiceError,
} from "./application/merge-application-service.js";
export {
  PlanArtifactService,
  PlanArtifactServiceError,
} from "./application/plan-artifact-service.js";
export type {
  PlanArtifactAcquisition,
  PlanArtifactFailureCode,
  PlanArtifactIdentity,
  PlanArtifactSource,
  ResolvedPlanArtifact,
  ResolvePlanArtifactInput,
} from "./application/plan-artifact-service.js";
export {
  EXECUTION_PLAN_ARTIFACT_CONTRACT,
  EXECUTION_PLAN_CANONICALIZATION_PROFILE,
  EXECUTION_PLAN_HASH_DOMAIN,
  EXECUTION_PLAN_HASH_PROFILE,
  PLAN_ARTIFACT_REFERENCE_CONTRACT,
  ExecutionPlanArtifactIdentity_v1Schema,
  ExecutionPlanArtifact_v1Schema,
  PlanArtifactReference_v1Schema,
  PlanArtifactScope_v1Schema,
  computeExecutionPlanArtifactDigest,
} from "./application/execution-plan-artifact.js";
export type {
  ExecutionPlanArtifactIdentity_v1,
  ExecutionPlanArtifact_v1,
  PlanArtifactReference_v1,
  PlanArtifactScope_v1,
} from "./application/execution-plan-artifact.js";
export {
  PlanArtifactRegistrationError,
  PlanArtifactRegistrationService,
} from "./application/plan-artifact-registration-service.js";
export type {
  PlanArtifactRegistrationFailureCode,
  RegisterPlanArtifactInput,
  RegisteredPlanArtifact,
} from "./application/plan-artifact-registration-service.js";
export type {
  BoundedMergeApplicationResult,
  MergeApplicationExecution,
  MergeApplicationFailureCode,
  MergeApplicationRuntime,
} from "./application/merge-application-service.js";
export {
  ConfigurationQueryService,
  WorkspaceConfigServiceError,
  WorkspaceDiagnosticsService,
  WorkspaceInitializationService,
} from "./application/workspace-config-services.js";
export {
  INTEGRATION_RECORD_REMOVAL_VERSION,
  INTEGRATION_RECORD_REPLACEMENTS,
  IntegrationRecordCompatibilityError,
  IntegrationRecordCompatibilityService,
} from "./application/integration-record-compatibility-service.js";
export { mcpToolError } from "./errors/index.js";

// LPR-037: Workflow guidance exports for MCP
export { createWorkflowGuide } from "./mcp/workflow/state-machine.js";

// Portable agent-work protocol contracts for orchestrators and worker runtimes.
export * from "./schemas/agent-work.js";
export * from "./schemas/agent-work-projection.js";
export * from "./runs/agent-work-projection-planner.js";

export {
  materializeAttemptInput,
  SelectedWorkInputJsonSchema,
} from "./runs/selected-work-materialization.js";
