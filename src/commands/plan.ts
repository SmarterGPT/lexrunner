/**
 * Plan command - Generate plan from configuration sources or GitHub PRs
 */

import { Command } from "commander";
import { Plan, loadPlan, SchemaValidationError, formatPlanValidationFailure } from "../schema.js";
import { computeMergeOrder, CycleError, UnknownDependencyError } from "../mergeOrder.js";
import { generatePlanSummary } from "../core/snapshot.js";
import { createGitHubClient } from "../github/index.js";
import { canonicalJSONStringify } from "../util/canonicalJson.js";
import { throwExit } from "../cli/exitHandler.js";
import { writeJsonOutput } from "../cli/output.js";
import { MergeOrderQueryService } from "../application/integration-query-services.js";
import { AXErrorException } from "../errors/index.js";
import { FileAnalyzer } from "../planner/fileAnalysis.js";
import { scoreDependencies } from "../planner/dependencyScoring.js";
import { formatSuggestions, type SuggestionFormat } from "../cli/formatSuggestions.js";
import { parseTierOverrides, calculateTierMetrics, formatTierMetrics } from "../tiers/index.js";
import * as fs from "fs";
import {
  PlanCreationOperationService,
  writePlanCreationArtifacts,
} from "../application/plan-creation-operation-service.js";
import { runBitbucketPlan } from "../forge/commands.js";

interface PlanCommandDeps {
  jsonModeActive: () => boolean;
  setJsonMode: (active: boolean) => void;
  exitWith: (e: unknown) => void;
}

/**
 * Register the plan command
 */
export function registerPlanCommand(program: Command, deps: PlanCommandDeps): void {
  const planCommand = program
    .command("plan")
    .description(
      "Generate plan from configuration sources or GitHub PRs (canonical: lexrunner weave plan)"
    )
    .option("--out <dir>", "Output directory for artifacts (default: <profile>/runner)")
    .option("--repo-root <dir>", "Repository worktree to bind discovery, gates, and artifacts")
    .option("--profile-dir <dir>", "Explicit profile directory resolved from the repository root")
    .option("--json", "Output canonical plan JSON to stdout only")
    .option("--dry-run", "Validate inputs and show what would be written")
    .option("--from-github", "Auto-discover PRs from GitHub API")
    .option("--from-bitbucket", "Freeze a read-only Bitbucket Cloud plan (apply unsupported)")
    .option("--query <query>", "GitHub search query (e.g., 'is:open label:stack:*')")
    .option("--labels <labels>", "Filter PRs by comma-separated labels")
    .option("--include-drafts", "Include draft PRs in the plan")
    .option("--exclude-prs <numbers>", "Exclude specific PRs by comma-separated PR numbers")
    .option("--github-token <token>", "GitHub API token (or use GITHUB_TOKEN env var)")
    .option("--owner <owner>", "GitHub repository owner (auto-detected from git remote)")
    .option("--repo <repo>", "GitHub repository name (auto-detected from git remote)")
    .option(
      "--required-gates <gates>",
      "Comma-separated list of required gates (default: lint,typecheck,test)"
    )
    .option("--max-workers <n>", "Maximum parallel workers for execution (default: 2)", parseInt)
    .option("--target <branch>", "Target branch for merging PRs (default: repo default branch)")
    .option("--validate-cycles", "Enable dependency cycle detection (default: true)")
    .option("--optimize", "Optimize plan for parallel execution")
    .option(
      "--suggest-deps",
      "Output dependency suggestions for review (does not generate plan.json)"
    )
    .option(
      "--threshold <number>",
      "Filter suggestions below this score (default: 0.3)",
      parseFloat
    )
    .option("--format <format>", "Output format: table|json|markdown (default: table)")
    .option("--output <file>", "Write suggestions to file instead of stdout")
    .option(
      "--tier-override <overrides>",
      "Override tier for specific items (format: item=tier, comma-separated)"
    )
    .option("--show-tiers", "Show suggested tiers for plan items")
    .addHelpText(
      "after",
      `
Examples:
  $ lexrunner plan --from-github --json > plan.json    # Generate plan from GitHub PRs
  $ lexrunner plan --dry-run                           # Preview plan without writing
  $ lexrunner plan --labels "feature,bugfix"           # Filter by labels
  $ lexrunner plan --exclude-prs 123,456               # Exclude specific PRs
  $ lexrunner plan --target staging                    # Target different branch
  $ lexrunner plan --required-gates lint,test,e2e      # Custom gate requirements
  $ lexrunner plan --from-github --suggest-deps        # Review dependency suggestions
  $ lexrunner plan --from-github --suggest-deps --format=json  # JSON suggestions for tooling
  $ lexrunner plan --from-github --suggest-deps --threshold=0.7  # High-confidence only

Common Issues:
  • GitHub API errors: Set GITHUB_TOKEN environment variable
  • Cycle detection failures: Review dependencies in scope.yml or PR descriptions
  • Missing configuration: Run 'lexrunner init' to set up workspace`
    )
    .action(async (opts) => {
      const previousJsonMode = deps.jsonModeActive();
      // jsonModeActive is already set by preAction hook from global --json
      // Command-level --json flag also sets it for backwards compatibility
      if (opts.json) {
        deps.setJsonMode(true);
      }
      try {
        await executePlan(opts, deps);
      } catch (error) {
        deps.exitWith(error);
      } finally {
        deps.setJsonMode(previousJsonMode);
      }
    });

  planCommand
    .command("levels")
    .description("Validate a hand-authored plan and report dependency levels offline")
    .requiredOption("--plan <file>", "Path to a plan.json containing PRs, tickets or tasks")
    .option("--json", "Output dependency levels as JSON")
    .addHelpText(
      "after",
      "\nReads only the supplied plan. Requires no Git checkout, forge token or profile; executes no gates.\n"
    )
    .action((opts, command: Command) => {
      const previousJsonMode = deps.jsonModeActive();
      const json = Boolean(command.optsWithGlobals().json || previousJsonMode);
      deps.setJsonMode(json);
      try {
        const plan = loadPlan(fs.readFileSync(opts.plan, "utf8"));
        const result = new MergeOrderQueryService().run(plan);
        if (json) {
          writeJsonOutput(result);
        } else {
          console.log(`Dependency levels for ${result.totalItems} work items:`);
          result.levels.forEach((level, index) => {
            console.log(`Level ${index + 1}: [${level.join(", ")}]`);
          });
        }
      } catch (error) {
        if (json) {
          writeJsonOutput(
            error instanceof SchemaValidationError
              ? formatPlanValidationFailure(error)
              : error instanceof AXErrorException
                ? error.axError
                : {
                    code: "PLAN_LEVELS_FAILED",
                    message: "Unable to read the plan or compute dependency levels.",
                    nextActions: [
                      "Check the supplied plan file and its schema, names and dependencies",
                    ],
                  }
          );
        }
        deps.exitWith(error);
      } finally {
        deps.setJsonMode(previousJsonMode);
      }
    });
}

async function executePlan(opts: any, deps: PlanCommandDeps): Promise<void> {
  if (opts.fromBitbucket) {
    if (opts.fromGithub) throw new Error("Select exactly one forge for plan creation");
    await runBitbucketPlan(opts, deps.jsonModeActive());
    return;
  }
  // Parse tier overrides from CLI
  const tierOverrides = opts.tierOverride ? parseTierOverrides(opts.tierOverride) : undefined;
  const labels = opts.labels
    ? opts.labels.split(",").map((label: string) => label.trim())
    : undefined;
  const excludePRs = opts.excludePrs
    ? opts.excludePrs
        .split(",")
        .map((number: string) => parseInt(number.trim(), 10))
        .filter((number: number) => Number.isInteger(number) && number > 0)
    : undefined;
  const operation = await new PlanCreationOperationService().run({
    startupDir: process.cwd(),
    tierOverrides,
    args: {
      ...(opts.out ? { outDir: opts.out } : {}),
      ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}),
      ...(opts.profileDir ? { profileDir: opts.profileDir } : {}),
      ...(opts.fromGithub ? { fromGithub: true } : {}),
      ...(opts.query ? { query: opts.query } : {}),
      ...(labels ? { labels } : {}),
      ...(opts.includeDrafts !== undefined ? { includeDrafts: opts.includeDrafts } : {}),
      ...(excludePRs ? { excludePRs } : {}),
      ...(opts.githubToken ? { githubToken: opts.githubToken } : {}),
      ...(opts.owner ? { owner: opts.owner } : {}),
      ...(opts.repo ? { repo: opts.repo } : {}),
      ...(opts.requiredGates
        ? { requiredGates: opts.requiredGates.split(",").map((gate: string) => gate.trim()) }
        : {}),
      ...(opts.maxWorkers ? { maxWorkers: opts.maxWorkers } : {}),
      ...(opts.target ? { target: opts.target } : {}),
    },
  });
  const plan: Plan = operation.plan;
  const githubMode = operation.routing.discovery.mode === "github";
  const autoDetectedGitHubMode = githubMode && !opts.fromGithub;

  if (opts.suggestDeps) {
    if (!githubMode) throw new Error("Dependency suggestions require GitHub discovery mode");
    const client = await createGitHubClient({
      token: opts.githubToken,
      owner: operation.routing.resolvedRepository.owner,
      repo: operation.routing.resolvedRepository.repo,
    });
    const prNumbers = plan.items
      .map(({ name }) => /^PR-([1-9][0-9]*)$/u.exec(name)?.[1])
      .filter((number): number is string => Boolean(number))
      .map(Number);
    if (prNumbers.length === 0) {
      console.log("No PRs found matching the criteria.");
      return;
    }
    const prDetails = await Promise.all(prNumbers.map((number) => client.getPRDetails(number)));

    // Create file analyzer
    const fileAnalyzer = new FileAnalyzer(client.getOctokit(), client.getOwner(), client.getRepo());

    // Score dependencies
    const threshold = opts.threshold ?? 0.3;
    const scores = await scoreDependencies(
      prDetails.map((pr) => ({
        number: pr.number,
        name: `PR-${pr.number}`,
        body: pr.body,
        sha: pr.head.sha,
      })),
      fileAnalyzer,
      { threshold }
    );

    // Format output
    const format = (opts.format as SuggestionFormat) || "table";
    const output = formatSuggestions(scores, format, threshold);

    // Write to stdout or file
    if (opts.output) {
      fs.writeFileSync(opts.output, output, "utf-8");
      if (!deps.jsonModeActive()) {
        console.log(`✓ Suggestions written to ${opts.output}`);
      }
    } else {
      console.log(output);
    }

    // Exit without generating plan.json
    return;
  }

  if (githubMode) {
    if (deps.jsonModeActive()) {
      const repoDiag = `${operation.routing.resolvedRepository.owner}/${operation.routing.resolvedRepository.repo}`;
      const filterInfo = labels ? ` labels=${labels.join(",")}` : "";
      const queryInfo = operation.routing.discovery.query
        ? ` query="${operation.routing.discovery.query}"`
        : "";
      console.error(
        `[from-github] repo=${repoDiag}${filterInfo}${queryInfo} discovered=${plan.items.length}`
      );
    } else {
      const modeLabel = autoDetectedGitHubMode ? "Auto-detected and discovered" : "Auto-discovered";
      console.log(`✓ ${modeLabel} ${plan.items.length} PRs from GitHub`);
      if (labels && labels.length > 0) {
        console.log(`  Filtered by labels: ${labels.join(", ")}`);
      }
      if (operation.routing.discovery.query) {
        console.log(`  Using query: ${operation.routing.discovery.query}`);
      }
      if (plan.items.length === 0) {
        console.log(`\n⚠️  No PRs found matching the criteria.`);
        console.log(`    Try adjusting filters or check that PRs exist in the repository.`);
      }
    }
  }

  // Validate plan structure
  const validatedPlan = loadPlan(canonicalJSONStringify(plan));

  // Validate dependencies and detect cycles (default: enabled)
  if (opts.validateCycles !== false && validatedPlan.items.length > 0) {
    try {
      computeMergeOrder(validatedPlan);
      if (!deps.jsonModeActive()) {
        console.log(`✓ Dependency validation passed (no cycles detected)`);
      }
    } catch (error) {
      if (error instanceof CycleError) {
        const prefix = deps.jsonModeActive() ? "[lexrunner]" : "❌";
        console.error(`\n${prefix} Plan validation failed: ${error.message}`);
        throwExit(1);
      } else if (error instanceof UnknownDependencyError) {
        const prefix = deps.jsonModeActive() ? "[lexrunner]" : "❌";
        console.error(`\n${prefix} Plan validation failed: ${error.message}`);
        throwExit(1);
      }
      throw error;
    }
  }

  // Optimize plan if requested
  if (opts.optimize && validatedPlan.items.length > 0) {
    // Plan is already optimized by computeMergeOrder - just show info
    const levels = computeMergeOrder(validatedPlan);
    if (!deps.jsonModeActive()) {
      console.log(`✓ Plan optimized for parallel execution: ${levels.length} levels`);
      levels.forEach((level, idx) => {
        console.log(`  Level ${idx + 1}: ${level.join(", ")}`);
      });
    }
  }

  // Show tier information if requested
  if (opts.showTiers && validatedPlan.items.length > 0 && !deps.jsonModeActive()) {
    // Collect tier assignments from plan items
    const tierAssignments = new Map();
    for (const item of validatedPlan.items) {
      if (item.tier) {
        tierAssignments.set(item.name, item.tier);
      }
    }

    if (tierAssignments.size > 0) {
      const tierMetrics = calculateTierMetrics(tierAssignments);

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
  }

  if (deps.jsonModeActive()) {
    // JSON mode: output only canonical plan to stdout, write nothing else
    // canonicalJSONStringify already includes trailing newline
    process.stdout.write(canonicalJSONStringify(validatedPlan));
    return;
  }

  // Generate artifacts
  const planJSON = canonicalJSONStringify(validatedPlan);
  const snapshot = operation.snapshot;

  if (opts.dryRun) {
    console.log("Dry run - would generate:");
    console.log(`📁 ${operation.files.plan} (${planJSON.length} bytes)`);
    console.log(`📁 ${operation.files.snapshot} (${snapshot.length} bytes)`);
    console.log(`📁 ${operation.files.routingReceipt} (non-authorizing routing receipt)`);
    console.log("");
    console.log(generatePlanSummary(validatedPlan));
    return;
  }

  writePlanCreationArtifacts(operation);

  console.log(`✓ Generated plan artifacts:`);
  console.log(`  📁 ${operation.files.plan}`);
  console.log(`  📁 ${operation.files.snapshot}`);
  console.log(`  📁 ${operation.files.routingReceipt}`);
  console.log("");
  console.log(generatePlanSummary(validatedPlan));

  return;
}
