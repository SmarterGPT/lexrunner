/**
 * Weave command group - Unified merge-weave workflow interface
 *
 * This provides the canonical `lex-pr weave` command group that orchestrates
 * the complete merge-weave workflow: discover → plan → apply
 *
 * ALN-003 Phase 2: Extended with additional subcommands (status, report, order)
 * to support full category-action pattern while maintaining PR #590 core workflow.
 */

import { Command } from "commander";
import { throwExit } from "../cli/exitHandler.js";
import { createGitHubAPI, GitHubAPI } from "../github/api.js";
import { loadPlan } from "../schema.js";
import { canonicalJSONStringify } from "../util/canonicalJson.js";
import { createGitOperations } from "../git/operations.js";
import { ExecutionState } from "../executionState.js";
import { executeGatesWithPolicy } from "../gates.js";
import { registerStatusCommand } from "./status.js";
import { registerReportCommand } from "./report.js";
import { registerMergeOrderCommand } from "./mergeOrder.js";
import { registerPolicyCommands } from "./weave-policy.js";
import { registerFanoutCommands } from "./weave-fanout.js";
import { registerCheckpointCommands } from "./weave-checkpoints.js";
import { loadCheckpoint, getLatestCheckpoint } from "../weave/checkpoint/storage.js";
import { LocalWeaveResumeDriver } from "../weave/local-resume-driver.js";
import { resumePersistedWeave } from "../weave/resume-service.js";
import fs from "fs";
import path from "path";
import { DiscoveryQueryService } from "../application/integration-query-services.js";
import {
  PlanCreationOperationService,
  writePlanCreationArtifacts,
} from "../application/plan-creation-operation-service.js";
import {
  MergeApplicationService,
  MergeApplicationServiceError,
} from "../application/merge-application-service.js";
import { mcpToolError } from "../errors/index.js";

export interface WeaveCommandDeps {
  jsonModeActive: () => boolean;
  getProgramOpts: () => any;
  mergeApplicationService?: Pick<MergeApplicationService, "run">;
  executeGates?: typeof executeGatesWithPolicy;
}

export interface WeaveApplyOptions {
  plan: string;
  dryRun?: boolean;
  execute?: boolean;
  constraints?: boolean;
  skipGates?: boolean;
  json?: boolean;
}

/**
 * Register the weave command group with subcommands
 */
export function registerWeaveCommand(program: Command, deps: WeaveCommandDeps): void {
  const weave = program
    .command("weave")
    .description("Merge-weave workflow: discover → plan → apply")
    .addHelpText(
      "after",
      `
Examples:
  # Complete workflow
  $ lex-pr weave discover                  # Find open PRs
  $ lex-pr weave plan --from-github        # Generate merge plan
  $ lex-pr weave apply --dry-run           # Preview merge execution
  $ lex-pr weave apply --execute           # Execute merge

  # One-liner workflow
  $ lex-pr weave discover && lex-pr weave plan --from-github --output plan.json && lex-pr weave apply --execute

  # Resume from checkpoint (after interruption)
  $ lex-pr weave resume --latest           # Resume most recent run
  $ lex-pr weave resume --run-id <id>      # Resume specific run

  # Checkpoint management
  $ lex-pr weave checkpoints list          # List all checkpoints
  $ lex-pr weave checkpoints show <id>     # Show checkpoint details
  $ lex-pr weave checkpoints clean         # Clean up old checkpoints

Subcommands:
  discover     Find open PRs from GitHub
  plan         Generate merge plan from PRs
  apply        Execute merge pyramid with gates
  resume       Resume from checkpoint after interruption
  checkpoints  Manage execution checkpoints
`
    );

  // weave discover - Find open PRs
  weave
    .command("discover")
    .description("Discover open pull requests from GitHub")
    .option("--owner <owner>", "GitHub repository owner")
    .option("--repo <repo>", "GitHub repository name")
    .option("--state <state>", "PR state filter (open|closed|all)", "open")
    .option("--suggest", "Generate dependency/grouping suggestions using heuristics")
    .option("--json", "Output JSON format")
    .option("--output <file>", "Write output to file")
    .action(async (opts) => {
      try {
        let githubAPI = await createGitHubAPI();

        // Override with command line options if provided
        if (opts.owner && opts.repo) {
          githubAPI = new GitHubAPI({
            owner: opts.owner,
            repo: opts.repo,
            token: process.env.GITHUB_TOKEN,
          });
        }

        if (!githubAPI) {
          console.error("\n❌ Error: Could not detect GitHub repository\n");
          console.error("Solutions:");
          console.error("  1. Run from a Git repository with GitHub remote");
          console.error("  2. Specify repository explicitly:");
          console.error("     lex-pr weave discover --owner <owner> --repo <repo>\n");
          throwExit(1);
        }

        const result = await new DiscoveryQueryService().run({
          github: githubAPI,
          state: opts.state as "open" | "closed" | "all",
          suggest: opts.suggest,
        });
        if (!result.authenticated) {
          console.warn(
            "⚠️  Warning: GitHub API not authenticated. Set GITHUB_TOKEN for better rate limits.\n"
          );
        }
        const pullRequests = result.pullRequests;

        // Output results
        const jsonOutput = canonicalJSONStringify(result);

        if (opts.output) {
          fs.writeFileSync(opts.output, jsonOutput + "\n");
          if (!opts.json && !deps.jsonModeActive()) {
            console.log(`✅ Results written to ${opts.output}`);
            console.log(`   Found ${result.total} pull request(s)`);
          }
        } else if (opts.json || deps.jsonModeActive()) {
          console.log(jsonOutput);
        } else {
          // Human-readable output
          console.log(`\n📋 Discovered ${result.total} Pull Request(s)\n`);

          if (result.total === 0) {
            console.log("No pull requests found.");
            console.log("\n💡 Try adjusting filters or check repository permissions.\n");
            return;
          }

          for (const pr of pullRequests) {
            const status = pr.state === "open" ? "🟢 OPEN" : "🔴 CLOSED";
            console.log(`${status} #${pr.number}: ${pr.title}`);
            console.log(`       Branch: ${pr.branch}`);
            if (pr.labels && pr.labels.length > 0) {
              console.log(`       Labels: ${pr.labels.join(", ")}`);
            }
            console.log("");
          }

          if (opts.suggest && result.suggestions) {
            console.log(`\n💡 Generated ${result.suggestionsCount} dependency suggestion(s)\n`);
          }

          console.log("Next step:");
          console.log("  lex-pr weave plan --from-github --output plan.json\n");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`\n❌ Discovery failed: ${message}\n`);
        throwExit(1);
      }
    });

  // weave plan - Generate merge plan
  weave
    .command("plan")
    .description("Generate merge plan from GitHub PRs or config files")
    .option("--from-github", "Auto-discover PRs from GitHub API")
    .option("--owner <owner>", "GitHub repository owner")
    .option("--repo <repo>", "GitHub repository name")
    .option("--repo-root <dir>", "Repository worktree to bind discovery, gates, and artifacts")
    .option("--profile-dir <dir>", "Explicit profile directory resolved from the repository root")
    .option("--query <query>", "GitHub search query")
    .option("--labels <labels...>", "Filter PRs by labels")
    .option("--include-drafts", "Include draft PRs", true)
    .option("--exclude-prs <numbers...>", "Exclude specific PR numbers")
    .option("--target <branch>", "Target branch (default: repo default)")
    .option("--output <file>", "Output file path", "plan.json")
    .option("--json", "Output JSON format")
    .action(async (opts) => {
      try {
        if (!opts.fromGithub) {
          console.error("\n❌ Error: --from-github is required for weave plan\n");
          console.error("Example:");
          console.error("  lex-pr weave plan --from-github --output plan.json\n");
          throwExit(1);
        }

        const operation = await new PlanCreationOperationService().run({
          startupDir: process.cwd(),
          args: {
            fromGithub: true,
            planFile: opts.output,
            ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}),
            ...(opts.profileDir ? { profileDir: opts.profileDir } : {}),
            ...(opts.owner ? { owner: opts.owner } : {}),
            ...(opts.repo ? { repo: opts.repo } : {}),
            ...(opts.query ? { query: opts.query } : {}),
            ...(opts.labels ? { labels: opts.labels } : {}),
            ...(opts.excludePrs
              ? {
                  excludePRs: opts.excludePrs
                    .map((number: string) => parseInt(number, 10))
                    .filter((number: number) => Number.isInteger(number) && number > 0),
                }
              : {}),
            includeDrafts: opts.includeDrafts,
            ...(opts.target ? { target: opts.target } : {}),
            requiredGates: ["lint", "typecheck", "test"],
            maxWorkers: 2,
          },
        });
        writePlanCreationArtifacts(operation);
        const plan = operation.plan;

        if (opts.json || deps.jsonModeActive()) {
          console.log(
            canonicalJSONStringify({
              success: true,
              planFile: operation.files.plan,
              routingReceipt: operation.files.routingReceipt,
              items: plan.items?.length || 0,
            })
          );
        } else {
          console.log(`\n✅ Plan generated successfully\n`);
          console.log(`   File: ${operation.files.plan}`);
          console.log(`   Routing: ${operation.files.routingReceipt}`);
          console.log(`   Items: ${plan.items?.length || 0}`);
          console.log(`   Target: ${plan.target || "default branch"}`);
          console.log("");
          console.log("Next steps:");
          console.log(`  1. Review: lex-pr plan-review ${opts.output}`);
          console.log(`  2. Dry-run: lex-pr weave apply --plan ${opts.output} --dry-run`);
          console.log(`  3. Execute: lex-pr weave apply --plan ${opts.output} --execute\n`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`\n❌ Plan generation failed: ${message}\n`);
        throwExit(1);
      }
    });

  // weave apply - Execute merge pyramid
  weave
    .command("apply")
    .description("Execute merge pyramid with gates and merging")
    .option("--plan <file>", "Path to plan.json file", "plan.json")
    .option("--dry-run", "Show what would happen without executing")
    .option("--execute", "Apply merges through the persisted merge service")
    .option("--no-constraints", "Skip constraint preview in dry-run mode")
    .option("--skip-gates", "Skip gate execution (not recommended)")
    .option("--json", "Output JSON format")
    .action(async (opts) => runWeaveApply(opts as WeaveApplyOptions, deps));

  // ALN-003 Phase 2: Add additional weave subcommands for full category coverage
  // These were originally intended to be added by PR #584
  // Note: discover, plan, and apply are implemented inline above.
  // We only add status, report, and order here.

  // weave status - Show execution status
  registerStatusCommand(weave, deps.jsonModeActive);

  // weave report - Generate gate reports
  registerReportCommand(weave, { jsonModeActive: deps.jsonModeActive });

  // weave order - Compute merge order (alias for merge-order)
  registerMergeOrderCommand(weave, deps.jsonModeActive, (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n❌ Error: ${message}\n`);
    throwExit(1);
  });

  // weave policy - Policy-based merge-weave execution
  registerPolicyCommands(weave, { jsonModeActive: deps.jsonModeActive });

  // weave fanout - Fanout templates for follow-up issue creation
  registerFanoutCommands(weave);

  // weave resume - Resume from checkpoint
  weave
    .command("resume")
    .description("Resume merge-weave execution from a checkpoint")
    .option("--run-id <id>", "Resume from specific run ID")
    .option("--latest", "Resume from most recent checkpoint")
    .option("--json", "Output JSON format")
    .action(async (opts) => {
      try {
        // Determine which checkpoint to load
        let checkpoint;
        let runId: string;

        if (opts.runId) {
          runId = opts.runId;
          checkpoint = await loadCheckpoint(runId, { validatePlanHash: false });
        } else if (opts.latest) {
          checkpoint = await getLatestCheckpoint();
          if (!checkpoint) {
            console.error("\n❌ No checkpoints found\n");
            console.error("Start a new weave execution with:");
            console.error("  lex-pr weave apply --plan plan.json\n");
            throwExit(1);
          }
          runId = checkpoint.runId;
        } else {
          console.error("\n❌ Error: Must specify either --run-id or --latest\n");
          console.error("Examples:");
          console.error("  lex-pr weave resume --latest");
          console.error("  lex-pr weave resume --run-id <run-id>\n");
          throwExit(1);
        }

        if (!(opts.json || deps.jsonModeActive())) {
          console.log("\n🔄 Resuming merge-weave execution\n");
          console.log(`Run ID: ${runId}`);
          console.log(`Phase: ${checkpoint.phase}`);
        }
        const result = await resumePersistedWeave({
          runId,
          driver: new LocalWeaveResumeDriver(process.cwd()),
        });
        if (opts.json || deps.jsonModeActive()) {
          console.log(canonicalJSONStringify({ action: "resume", ...result }));
        } else if (result.ok) {
          console.log(
            `✅ ${result.outcome === "completed" ? "Execution completed" : "Execution paused"}`
          );
          console.log(
            `Completed: ${result.completed} | Pending: ${result.pending} | Failed: ${result.failed}\n`
          );
        } else {
          console.error(`\n❌ Cannot resume: ${result.reason}\n`);
          throwExit(1);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`\n❌ Resume failed: ${message}\n`);
        throwExit(1);
      }
    });

  // weave checkpoints - Checkpoint management
  registerCheckpointCommands(weave, { jsonModeActive: deps.jsonModeActive });
}

/** Shared canonical CLI adapter used by `weave apply` and its `merge` compatibility alias. */
export async function runWeaveApply(
  opts: WeaveApplyOptions,
  deps: WeaveCommandDeps
): Promise<void> {
  const json = Boolean(opts.json || deps.jsonModeActive());
  const service = deps.mergeApplicationService ?? new MergeApplicationService();
  try {
    if (!fs.existsSync(opts.plan)) {
      console.error(`\n❌ Error: Plan file not found: ${opts.plan}\n`);
      console.error("Generate a plan first:");
      console.error("  lex-pr weave plan --from-github --output plan.json\n");
      throwExit(1);
    }

    const plan = loadPlan(fs.readFileSync(opts.plan, "utf-8"));
    const preview = await service.run({
      plan,
      workingDir: process.cwd(),
      dryRun: true,
      mutationAuthorized: false,
    });
    const levels = preview.summary.levels ?? [];

    if (opts.dryRun) {
      const showConstraints = opts.constraints !== false;
      if (json) {
        const output: Record<string, unknown> = { ...preview.summary };
        if (showConstraints) {
          const { previewConstraints } = await import("../preview/constraints.js");
          output.constraints = await previewConstraints(plan);
        }
        console.log(canonicalJSONStringify(output));
        return;
      }

      console.log(`\n🔍 Merge-Weave Dry Run\n`);
      if (showConstraints) {
        const { previewConstraints, formatConstraintPreview } =
          await import("../preview/constraints.js");
        console.log(formatConstraintPreview(await previewConstraints(plan)));
      }
      console.log(`Plan: ${opts.plan}`);
      console.log(`Items: ${plan.items.length}`);
      console.log(`Target: ${plan.target}\n`);
      console.log(
        `Git inputs: ${preview.summary.gitInputBinding}${plan.gitInputs ? `; acquisition: ${plan.gitInputs.acquisition}` : ""}\n`
      );
      console.log("📦 Execution Plan\n");
      console.log("Execution Order (topological):\n");
      levels.forEach((level, index) => {
        console.log(`  Level ${index + 1}:`);
        level.forEach((item) => console.log(`    - ${item}`));
      });
      console.log("\nGates to run:");
      for (const gate of plan.policy?.requiredGates ?? ["lint", "typecheck", "test"]) {
        console.log(`  - ${gate}`);
      }
      console.log("\nTo execute:");
      console.log(`  lex-pr weave apply --plan ${opts.plan} --execute\n`);
      return;
    }

    if (!json) {
      console.log(`\n🚀 Executing Merge-Weave\n`);
      console.log(`Plan: ${opts.plan}`);
      console.log(`Items: ${plan.items.length}\n`);
    }

    // Bound execution runs gates on frozen commits inside the shared service.
    // Running them first on the caller's checkout would test different input.
    if (!opts.skipGates && !(opts.execute && plan.gitInputs)) {
      if (!json) console.log("Running gates...\n");
      const executionState = new ExecutionState(plan);
      const gatesDir = path.join(process.cwd(), ".smartergpt", "runner", "gates");
      await (deps.executeGates ?? executeGatesWithPolicy)(plan, executionState, gatesDir);
      const results = executionState.getResults();
      const allPassed = [...results.values()].every(({ status }) => status === "pass");
      if (!json) {
        for (const [itemName, result] of results) {
          console.log(`${result.status === "pass" ? "✅" : "❌"} ${itemName}: ${result.status}`);
        }
      }
      if (!allPassed) {
        console.error("\n❌ Some gates failed. Fix issues before merging.\n");
        throwExit(1);
      }
      if (!json) console.log("\n✅ All gates passed!\n");
    }

    if (!opts.execute) {
      if (json) {
        console.log(
          canonicalJSONStringify({
            contract: "bounded-ax-v1",
            mode: "gates-only",
            ok: true,
            gatesCompleted: !opts.skipGates,
            readyToMerge: true,
          })
        );
      } else {
        console.log("Merge pyramid ready to execute.");
        console.log("\nNext step:");
        console.log(`  lex-pr weave apply --plan ${opts.plan} --execute\n`);
      }
      return;
    }

    const application = await service.run({
      plan,
      workingDir: process.cwd(),
      dryRun: false,
      mutationAuthorized: true,
    });
    if (json) {
      console.log(canonicalJSONStringify(application.summary));
    } else {
      console.log(
        application.summary.ok
          ? `✅ Merge application completed (${application.summary.runId})`
          : `❌ Merge application stopped (${application.summary.failureCode})`
      );
    }
    if (!application.summary.ok) throwExit(1);
  } catch (error) {
    if (error instanceof MergeApplicationServiceError && json) {
      console.error(
        canonicalJSONStringify(mcpToolError(error.code, error.message, { tool: "merge.apply" }))
      );
    } else {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\n❌ Apply failed: ${message}\n`);
    }
    throwExit(1);
  }
}
