/**
 * Execute command - Execute plan with policy-aware gate running and status tracking
 */

import { Command } from "commander";
import { loadPlan } from "../schema.js";
import { computeMergeOrder } from "../mergeOrder.js";
import {
  assertGateSelectionExists,
  GateExecutionService,
  GateExecutionServiceError,
} from "../application/gate-execution-service.js";
import {
  applyGateImpactSelection,
  GateImpactService,
  type GateImpactSelection,
  writeGateImpactReceipt,
} from "../application/gate-impact-service.js";
import { ExecutionState } from "../executionState.js";
import { MergeEligibilityEvaluator } from "../mergeEligibility.js";
import {
  parseAutopilotConfig,
  AutopilotConfigError,
  getAutopilotLevelDescription,
  AutopilotLevel,
} from "../autopilot/index.js";
import { ProgressReporter } from "../util/progress.js";
import { writeJsonOutput } from "../cli/output.js";
import { mcpToolError } from "../errors/index.js";
import { throwExit, CLIExitSignal } from "../cli/exitHandler.js";
import {
  initAuditEmitter,
  emitEvent,
  AuditEmitter,
  AuditOptions,
  EVENT_TYPES,
} from "../audit/index.js";
import { sha256 } from "../util/hash.js";
import { getStatusIcon, formatStatusTable } from "../cli/formatters.js";
import { BudgetTracker, BudgetExceededError } from "../budget/index.js";
import { purgeCache } from "../cli/runnerLifecycle.js";
import {
  parseTierOverrides,
  suggestTiersForPlan,
  calculateTierMetrics,
  formatTierMetrics,
  tierMetricsToJSON,
} from "../tiers/index.js";
import { createTurnCostTracker } from "../metrics/turncost.js";
import * as fs from "fs";
import * as path from "path";

// Guarded finalize: ensure HIPAA-prefixed errors rethrow (to map to exit 2),
// while non-HIPAA finalize errors are logged and ignored.
async function finalizeAuditGuard(emitter: AuditEmitter, status?: string): Promise<void> {
  try {
    const { finalizeAudit } = await import("../audit/index.js");
    await finalizeAudit(emitter, status);
  } catch (e) {
    if (e instanceof Error && typeof e.message === "string" && e.message.startsWith("HIPAA:")) {
      throw e; // let top-level handler map to exit code 2
    }
    console.warn("[lexrunner] audit: finalize failed (ignored)", String(e));
  }
}

interface ExecuteCommandDeps {
  jsonModeActive: () => boolean;
  exitWith: (e: unknown) => void;
  getProgramOpts: () => any;
}

interface ExecuteCommandRegistration {
  commandName?: "run" | "execute";
  canonicalOutput?: boolean;
}

/**
 * Register the execute command with the CLI program
 */
export function registerExecuteCommand(
  program: Command,
  deps: ExecuteCommandDeps,
  registration: ExecuteCommandRegistration = {}
): void {
  program
    .command(registration.commandName ?? "execute")
    .description("Execute plan with policy-aware gate running and status tracking")
    .option("--plan <file>", "Path to plan.json file")
    .argument("[file]", "Path to plan.json file (alternative to --plan)")
    .option("--repo-root <dir>", "Explicit repository candidate root (default: current directory)")
    .option("--only-item <name>", "Run only the selected plan item; dependencies must already pass")
    .option("--only-gate <name>", "Run only the selected gate; omitted gates remain unqualified")
    .option("--artifact-dir <dir>", "Output directory for artifacts", "./artifacts")
    .option("--timeout <ms>", "Gate timeout in milliseconds", "30000")
    .option("--dry-run", "Validate plan and show execution order without running gates")
    .option("--json", "Output results in JSON format")
    .option("--status-table", "Generate status table for PR comments")
    .option("--keep-cache", "Keep existing cache (do not purge on start)")
    .option("--profile-dir <dir>", "Profile directory (default: auto-detect)")
    .option("--skip-input-validation", "Skip gate input schema validation (not recommended)")
    .option("--max-level <level>", "Maximum autopilot level (0-4)", "0")
    .option("--open-pr", "Open pull requests for integration branches (Level 3+)")
    .option("--close-superseded", "Close superseded PRs after integration (Level 4)")
    .option("--comment-template <path>", "Path to PR comment template (Level 2+)")
    .option("--branch-prefix <prefix>", "Prefix for integration branch names", "integration/")
    .option("--audit <profile>", "Audit profile: off|basic|soc2|hipaa-strict", "off")
    .option("--audit-dir <path>", "Audit output directory (default: <deliverables>/audit)")
    .option("--audit-format <format>", "Audit format (reserved for future)", "jsonl")
    .option("--audit-include-env <keys>", "Comma-separated env keys to include")
    .option("--audit-redact <regex>", "Custom redaction regex pattern")
    .option("--audit-hash-paths", "Hash file paths in audit events")
    .option("--audit-signer <provider:keyref>", "Signature method: kms:<ARN> or gpg:<FINGERPRINT>")
    .option("--audit-retain-days <days>", "Retention hint in days")
    .option("--audit-context <types>", "Context blocks: git,ci,os")
    .option("--audit-sample <percent>", "Sampling percentage for noisy gates", "100")
    .option("--audit-sarif", "Generate SARIF output for vulnerability findings")
    .option(
      "--tier-override <overrides>",
      "Override tier for specific items (format: item=tier, comma-separated)"
    )
    .option("--show-tiers", "Show suggested and actual tiers for plan items")
    .option("--track-turncost", "Track Turn Cost metrics during execution (coordination overhead)")
    .option("--implementation-base <sha>", "Select implementation tests from this base SHA")
    .option("--implementation-head <sha>", "Select implementation tests through this head SHA")
    .addHelpText(
      "after",
      `
Examples:
  $ lexrunner execute plan.json                    # Run all gates in plan
  $ lexrunner execute --dry-run                    # Validate plan without running gates
  $ lexrunner execute --json > results.json        # JSON output for CI/CD integration
  $ lexrunner execute --status-table               # Generate PR comment-ready status table
  $ lexrunner execute --timeout 60000              # Increase timeout to 60 seconds
  $ lexrunner execute --artifact-dir ./build       # Custom artifact location

Common Issues:
  • Gates timing out: Increase --timeout or check gate commands
  • Missing dependencies: Run 'lexrunner merge-order' to verify plan structure
  • Permission errors: Ensure artifact directory is writable`
    )
    .action(async (file: string | undefined, opts) => {
      const planFile = opts.plan ?? file ?? "plan.json";
      let auditEmitter: AuditEmitter | null = null;

      try {
        // Purge cache unless --keep-cache is specified
        if (!(opts.json || deps.jsonModeActive())) {
          purgeCache(opts.profileDir, opts.keepCache);
        }

        // Initialize budget tracker from global options
        const programOpts = deps.getProgramOpts();
        const budgetTracker = new BudgetTracker({
          tokenBudget: parseInt(programOpts.tokenBudget || "5000", 10),
          maxPrompts: parseInt(programOpts.maxPrompts || "3", 10),
        });

        // Parse and validate autopilot configuration
        let autopilotConfig;
        try {
          autopilotConfig = parseAutopilotConfig({
            maxLevel: parseInt(opts.maxLevel),
            dryRun: opts.dryRun,
            openPr: opts.openPr,
            closeSuperseded: opts.closeSuperseded,
            commentTemplate: opts.commentTemplate,
            branchPrefix: opts.branchPrefix,
          });
        } catch (error) {
          if (error instanceof AutopilotConfigError) {
            console.error(`Configuration Error: ${error.message}`);
            throwExit(2);
          }
          throw error;
        }

        // Show autopilot configuration if not in JSON mode
        if (
          !(opts.json || deps.jsonModeActive()) &&
          autopilotConfig.maxLevel > AutopilotLevel.ReportOnly
        ) {
          console.log(
            `🤖 Autopilot Level ${autopilotConfig.maxLevel}: ${getAutopilotLevelDescription(
              autopilotConfig.maxLevel
            )}`
          );
          if (autopilotConfig.dryRun) {
            console.log("   Mode: Dry run (preview only)");
          }
          console.log("");
        }

        const planContent = fs.readFileSync(planFile, "utf-8");
        let plan = loadPlan(planContent);
        const repoRoot = opts.repoRoot ?? process.cwd();
        const timeoutMs = Number(opts.timeout);
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) {
          throw new Error("--timeout must be an integer from 1 through 86400000 milliseconds");
        }
        let impactSelection: GateImpactSelection | undefined;
        let impactReceiptPath: string | undefined;
        if (opts.implementationBase || opts.implementationHead) {
          if (!opts.implementationBase || !opts.implementationHead) {
            throw new Error(
              "--implementation-base and --implementation-head must be supplied together"
            );
          }
          impactSelection = await new GateImpactService().select({
            repoRoot,
            baseSha: opts.implementationBase,
            headSha: opts.implementationHead,
          });
          plan = applyGateImpactSelection(plan, impactSelection);
          if (!opts.dryRun) {
            impactReceiptPath = writeGateImpactReceipt(impactSelection, opts.artifactDir);
          }
        }

        assertGateSelectionExists({ plan, onlyItem: opts.onlyItem, onlyGate: opts.onlyGate });

        // Parse tier overrides from CLI
        const tierOverrides = opts.tierOverride ? parseTierOverrides(opts.tierOverride) : [];

        // Calculate tier assignments for all plan items
        const tierAssignments = suggestTiersForPlan(plan.items, tierOverrides);
        const tierMetrics = calculateTierMetrics(tierAssignments);

        // Show tier information if --show-tiers is specified
        if (opts.showTiers && !(opts.json || deps.jsonModeActive())) {
          console.log("\n🏷️  Capability Tier Assignments");
          console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
          for (const [itemName, assignment] of tierAssignments) {
            const actual = assignment.actual || assignment.suggested;
            const marker = assignment.mismatch ? " (overridden)" : "";
            const escalatedMarker = assignment.escalated ? " ⬆️" : "";
            console.log(`  ${itemName}: ${actual}${marker}${escalatedMarker}`);
          }
          console.log("");
          console.log(formatTierMetrics(tierMetrics));
          console.log("");
        }

        // Record initial prompt (plan loading)
        try {
          budgetTracker.recordPrompt(planContent);
        } catch (error) {
          if (error instanceof BudgetExceededError) {
            if (opts.json || deps.jsonModeActive()) {
              const output = {
                error: "Budget exceeded",
                type: error.type,
                current: error.current,
                limit: error.limit,
                budget: budgetTracker.formatJSON(),
              };
              writeJsonOutput(output);
            } else {
              console.error(`\n❌ ${error.message}\n`);
              console.log(budgetTracker.formatHuman());
            }
            throwExit(1);
          }
          throw error;
        }

        // Initialize audit emitter if profile is not 'off'
        if (opts.audit && opts.audit !== "off") {
          const auditDir = opts.auditDir || path.join(opts.artifactDir, "audit");
          const programOpts = deps.getProgramOpts();
          const cliKey = programOpts.auditKey as string | undefined;
          const envKey = process.env.LEX_AUDIT_KEY_HEX;
          const keyToUse = cliKey || envKey;
          const phiFlag = opts.audit === "hipaa-strict" || process.env.LEX_AUDIT_PHI === "1";
          const auditOptions: AuditOptions = {
            profile: opts.audit as "basic" | "soc2" | "hipaa-strict",
            dir: auditDir,
            format: opts.auditFormat,
            includeEnv: opts.auditIncludeEnv ? opts.auditIncludeEnv.split(",") : undefined,
            redactRegex: opts.auditRedact,
            hashPaths: opts.auditHashPaths,
            context: opts.auditContext
              ? (opts.auditContext.split(",") as ("git" | "ci" | "os")[])
              : undefined,
            signer: opts.auditSigner,
            retainDays: opts.auditRetainDays ? parseInt(opts.auditRetainDays) : undefined,
            sample: opts.auditSample ? parseInt(opts.auditSample) : undefined,
            phiRedaction: phiFlag,
            encryptionKeyHex: keyToUse,
            sarif: opts.auditSarif || false,
          };

          auditEmitter = await initAuditEmitter(auditOptions);

          // Emit command invocation event
          await emitEvent(auditEmitter, EVENT_TYPES.COMMAND_INVOCATION, {
            argv: process.argv.slice(2),
            cwd: process.cwd(),
          });

          // Emit plan discovered event
          const planHash = sha256(planContent);
          await emitEvent(auditEmitter, EVENT_TYPES.PLAN_DISCOVERED, {
            pr_ids: plan.items.map((item) => item.name),
            base: "main",
            head: plan.target,
            plan_hash: planHash,
          });

          // Emit plan validated event
          await emitEvent(auditEmitter, EVENT_TYPES.PLAN_VALIDATED, {
            schema_version: plan.schemaVersion,
            warnings: [],
          });
        }

        // Create execution state
        const executionState = new ExecutionState(plan);
        const evaluator = new MergeEligibilityEvaluator(plan, executionState);

        // Validate and show execution order
        const levels = computeMergeOrder(plan);

        // Emit merge order computed event
        if (auditEmitter) {
          await emitEvent(auditEmitter, EVENT_TYPES.MERGE_ORDER_COMPUTED, {
            levels: levels.length,
            items_per_level: levels.map((level) => level.length),
          });
        }

        if (opts.dryRun) {
          if (opts.json || deps.jsonModeActive()) {
            const tierAssignmentEntries = Object.fromEntries(
              Array.from(tierAssignments.entries()).map(([name, assignment]) => [
                name,
                {
                  suggested: assignment.suggested,
                  actual: assignment.actual,
                  escalated: assignment.escalated,
                  mismatch: assignment.mismatch,
                },
              ])
            );
            const output = {
              dryRun: true,
              selection: { onlyItem: opts.onlyItem ?? null, onlyGate: opts.onlyGate ?? null },
              plan: {
                schemaVersion: plan.schemaVersion,
                target: plan.target,
                itemCount: plan.items.length,
              },
              execution: {
                levels: levels.map((level, index) => ({
                  level: index + 1,
                  items: level,
                })),
                policy: plan.policy
                  ? {
                      maxWorkers: plan.policy.maxWorkers,
                      retryConfigs: Object.keys(plan.policy.retries).length,
                    }
                  : undefined,
              },
              tiers: {
                assignments: tierAssignmentEntries,
                metrics: tierMetricsToJSON(tierMetrics),
              },
              budget: budgetTracker.formatJSON(),
              ...(impactSelection && { impactSelection }),
            };
            writeJsonOutput(output);
          } else {
            console.log("Dry run - Plan validation successful");
            console.log(`Plan contains ${plan.items.length} items in ${levels.length} levels:`);
            levels.forEach((level: string[], index: number) => {
              console.log(`  Level ${index + 1}: [${level.join(", ")}]`);
            });

            if (plan.policy) {
              console.log(
                `Policy: ${plan.policy.maxWorkers} max workers, ${
                  Object.keys(plan.policy.retries).length
                } retry configs`
              );
            }

            // Print budget summary
            console.log(budgetTracker.formatHuman());
          }

          // Finalize audit emitter on dry-run so background tasks run and optional
          // at-rest encryption can occur when an encryption key is provided.
          if (auditEmitter) {
            try {
              await finalizeAuditGuard(auditEmitter, "dry-run");
            } catch (e) {
              if (
                e instanceof Error &&
                typeof e.message === "string" &&
                e.message.startsWith("HIPAA:")
              ) {
                // Surface HIPAA failures as fatal
                deps.exitWith(e as Error);
              }
              console.warn("[lexrunner] audit: finalize on dry-run failed (ignored)", String(e));
            }
          }

          return;
        }

        if (!(opts.json || deps.jsonModeActive())) {
          console.log(`Executing plan: ${plan.items.length} items, ${levels.length} levels`);
          if (impactSelection) {
            console.log(
              `Implementation selection: ${impactSelection.mode} (${impactSelection.selectedTests.length} tests)`
            );
          }
        }

        // Check for input validation skip flag
        const skipValidation = opts.skipInputValidation ?? false;
        if (skipValidation && !(opts.json || deps.jsonModeActive())) {
          console.warn("⚠️  Gate input validation disabled - use at your own risk");
        }

        // Create progress reporter (disabled in JSON mode)
        const progressReporter = new ProgressReporter({
          enabled: !(opts.json || deps.jsonModeActive()),
        });

        // Initialize Turn Cost tracker if enabled
        const turnCostTracker = opts.trackTurncost ? createTurnCostTracker() : undefined;

        // Execute gates with policy
        const gateExecution = await new GateExecutionService().run({
          plan,
          executionState,
          artifactDir: opts.artifactDir,
          timeoutMs,
          progressReporter,
          skipValidation,
          repoRoot,
          onlyItem: opts.onlyItem,
          onlyGate: opts.onlyGate,
          options: { turnCostTracker, suppressStdout: Boolean(opts.json || deps.jsonModeActive()) },
        });

        // Get final results
        const results = executionState.getResults();
        const mergeSummary = evaluator.getMergeSummary();

        if (opts.json || deps.jsonModeActive()) {
          if (registration.canonicalOutput) {
            writeJsonOutput({
              ...gateExecution.summary,
              ...(impactSelection && {
                impactSelection: {
                  mode: impactSelection.mode,
                  changedFiles: impactSelection.changedFiles,
                  selectedTests: impactSelection.selectedTests,
                  fallbackReason: impactSelection.fallbackReason,
                  receipt: impactReceiptPath,
                },
              }),
            });
          } else {
            // Preserve the compatibility output while canonical gate run stays bounded.
            const tierAssignmentEntries = Object.fromEntries(
              Array.from(tierAssignments.entries()).map(([name, assignment]) => [
                name,
                {
                  suggested: assignment.suggested,
                  actual: assignment.actual,
                  escalated: assignment.escalated,
                  mismatch: assignment.mismatch,
                },
              ])
            );
            const output = {
              plan: {
                schemaVersion: plan.schemaVersion,
                target: plan.target,
                itemCount: plan.items.length,
              },
              execution: {
                results: Object.fromEntries(results),
                mergeSummary,
                artifactDir: opts.artifactDir,
              },
              tiers: {
                assignments: tierAssignmentEntries,
                metrics: tierMetricsToJSON(tierMetrics),
              },
              budget: budgetTracker.formatJSON(),
              ...(turnCostTracker && { turnCost: turnCostTracker.toJSON() }),
            };
            writeJsonOutput(output);
          }
        } else if (opts.statusTable) {
          // Generate status table for PR comments
          console.log(formatStatusTable(results, mergeSummary));
        } else {
          // Human-readable output
          console.log("\n=== Execution Results ===");
          for (const [name, result] of results) {
            const statusIcon = getStatusIcon(result.status);
            console.log(`${statusIcon} ${name}: ${result.status}`);

            if (result.gates.length > 0) {
              for (const gate of result.gates) {
                const gateIcon = getStatusIcon(gate.status);
                const duration = gate.duration ? ` (${gate.duration}ms)` : "";
                console.log(`  ${gateIcon} ${gate.gate}${duration}`);
              }
            }
          }

          console.log("\n=== Merge Summary ===");
          console.log(
            `Eligible: ${mergeSummary.eligible.length} - [${mergeSummary.eligible.join(", ")}]`
          );
          console.log(
            `Pending: ${mergeSummary.pending.length} - [${mergeSummary.pending.join(", ")}]`
          );
          console.log(
            `Blocked: ${mergeSummary.blocked.length} - [${mergeSummary.blocked.join(", ")}]`
          );
          console.log(
            `Failed: ${mergeSummary.failed.length} - [${mergeSummary.failed.join(", ")}]`
          );

          // Print Turn Cost summary if tracked
          if (turnCostTracker) {
            const turnCostSummary = turnCostTracker.toJSON();
            console.log("\n=== Turn Cost ===");
            console.log(`Weighted Score: ${turnCostSummary.weightedScore.toFixed(2)}`);
            console.log(`Latency: ${(turnCostSummary.components.latencyMs / 1000).toFixed(2)}s`);
            console.log(`Renegotiations: ${turnCostSummary.components.renegotiationCount}`);
            console.log(`Attention Switches: ${turnCostSummary.components.attentionSwitchCount}`);
            if (turnCostSummary.improvement) {
              console.log(`vs Prior Run: ${turnCostSummary.improvement}`);
            }
          }

          // Print budget summary
          console.log(budgetTracker.formatHuman());
        }

        // Exit with appropriate code
        const hasFailures = mergeSummary.failed.length > 0 || mergeSummary.blocked.length > 0;

        // Emit run summary if audit is enabled
        if (auditEmitter) {
          const totalGates = Array.from(results.values()).reduce(
            (sum, r) => sum + r.gates.length,
            0
          );
          const passedGates = Array.from(results.values()).reduce(
            (sum, r) => sum + r.gates.filter((g) => g.status === "pass").length,
            0
          );
          const failedGates = Array.from(results.values()).reduce(
            (sum, r) => sum + r.gates.filter((g) => g.status === "fail").length,
            0
          );

          // Build pass/fail matrix
          const passFailMatrix: Record<string, Record<string, string>> = {};
          for (const [name, result] of results) {
            passFailMatrix[name] = {};
            for (const gate of result.gates) {
              passFailMatrix[name][gate.gate] = gate.status;
            }
          }

          await emitEvent(auditEmitter, EVENT_TYPES.RUN_SUMMARY, {
            totals: {
              items: plan.items.length,
              gates: totalGates,
              passed: passedGates,
              failed: failedGates,
            },
            pass_fail_matrix: passFailMatrix,
            final_status: hasFailures ? "failed" : "success",
          });

          // Finalize audit
          await finalizeAuditGuard(auditEmitter, hasFailures ? "failed" : "success");
        }

        if (hasFailures) {
          throwExit(1);
        }
        return;
      } catch (error) {
        // Re-throw CLIExitSignal to preserve exit code
        if (error instanceof CLIExitSignal) {
          throw error;
        }

        // Finalize audit on error and delegate exit mapping to exitWith
        if (auditEmitter) {
          await emitEvent(
            auditEmitter,
            EVENT_TYPES.ERROR,
            {
              code: "EXECUTION_ERROR",
              message: error instanceof Error ? error.message : String(error),
              where: "execute_command",
            },
            "error"
          );
          await finalizeAuditGuard(auditEmitter, "error");
        }

        if (registration.canonicalOutput && error instanceof GateExecutionServiceError) {
          if (opts.json || deps.jsonModeActive()) {
            writeJsonOutput(mcpToolError(error.code, error.message, { tool: "gates.run" }));
          } else {
            console.error(`${error.code}: ${error.message}`);
          }
          throwExit(1);
        }
        deps.exitWith(error);
      }
    });
}
