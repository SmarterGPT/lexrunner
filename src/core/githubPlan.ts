/**
 * GitHub-powered plan generation
 * Auto-discovers PRs and generates plan.json from GitHub metadata
 */

import { Plan, PlanItem, Gate } from "../schema.js";
import { GitHubClient, PullRequestDetails } from "../github/index.js";
import { stableSort } from "../util/canonicalJson.js";
import { createFileAnalyzer, FileAnalysisResult } from "../planner/index.js";
import { createTierAssignment } from "../tiers/suggest.js";
import type { TierOverride } from "../tiers/schema.js";
import { getStandardGateCommand } from "./standardGateCommands.js";

const STANDARD_TEST_GATE_TIMEOUT_MS = 5 * 60 * 1000;

export interface GitHubPlanOptions {
  query?: string; // GitHub search query
  labels?: string[]; // Filter by specific labels
  excludePRs?: number[]; // Exclude specific PR numbers
  includeDrafts?: boolean; // Include draft PRs
  target?: string; // Target branch (defaults to repo default)
  gitAcquisition?: "local-only" | "fetch";
  policy?: {
    requiredGates?: string[];
    maxWorkers?: number;
  };
  tierOverrides?: TierOverride[]; // Tier overrides for plan items
}

/**
 * Generate plan from GitHub PRs with automatic dependency resolution
 */
export async function generatePlanFromGitHub(
  client: GitHubClient,
  options: GitHubPlanOptions = {}
): Promise<Plan> {
  // Validate repository access
  const repoInfo = await client.validateRepository();
  const target = options.target || repoInfo.defaultBranch;
  const targetCommit = await client.getBranchHead(target);
  const gitInputs: NonNullable<Plan["gitInputs"]> = {
    schemaVersion: "1.0.0",
    repository: `${repoInfo.url.replace(/\/$/, "").replace(/\.git$/, "")}.git`,
    checkoutRemote: "origin",
    acquisition: options.gitAcquisition ?? "fetch",
    target: { ref: `refs/heads/${target}`, commit: targetCommit },
    sources: [],
  };

  // Discover PRs based on query/filters
  const prs = await client.listOpenPRs({
    state: "open",
    base: target,
    labels: options.labels,
    // If no specific query, find PRs with stack labels or open PRs
    ...(options.query ? { query: options.query } : {}),
  });

  // Default behavior: include drafts (align with `gh pr list`) unless explicitly disabled
  const includeDrafts = options.includeDrafts === undefined ? true : Boolean(options.includeDrafts);
  const filteredPRs = includeDrafts ? prs : prs.filter((pr) => !pr.draft);

  // Exclude specific PRs if requested
  const excludePRs = options.excludePRs || [];
  const finalPRs =
    excludePRs.length > 0
      ? filteredPRs.filter((pr) => !excludePRs.includes(pr.number))
      : filteredPRs;

  if (finalPRs.length === 0) {
    // Return empty plan if no PRs found
    const emptyPlan: Plan = {
      schemaVersion: "1.0.1",
      target,
      gitInputs,
      items: [],
    };

    // Add policy if specified
    if (options.policy) {
      emptyPlan.policy = {
        requiredGates: options.policy.requiredGates || [],
        optionalGates: [],
        maxWorkers: options.policy.maxWorkers || 1,
        retries: {},
        overrides: {},
        blockOn: [],
        mergeRule: { type: "strict-required" },
      };
    }

    return Plan.parse(emptyPlan);
  }

  // Get detailed information for each PR
  const prDetails = await Promise.all(finalPRs.map((pr) => client.getPRDetails(pr.number)));
  if (prDetails.some((pr) => pr.base.ref !== target)) {
    throw new Error(
      "Selected PR targets a different branch; refresh discovery for the intended target"
    );
  }

  // Transform PRs to plan items
  const planItems = prDetails.map((pr) =>
    transformPRToPlanItem(pr, options, `${repoInfo.owner}/${repoInfo.repo}`)
  );
  gitInputs.sources = prDetails
    .map((pr) => ({
      item: `PR-${pr.number}`,
      ref: `refs/pull/${pr.number}/head`,
      commit: pr.head.sha,
    }))
    .sort((a, b) => a.item.localeCompare(b.item));

  // Sort items by name for deterministic ordering
  planItems.sort((a, b) => a.name.localeCompare(b.name));

  // Validate dependencies exist within the PR set
  validateGitHubDependencies(planItems, prDetails);

  // Build the plan
  const plan: Plan = {
    schemaVersion: "1.0.1",
    target,
    gitInputs,
    items: planItems,
  };

  // Add policy if specified
  if (options.policy) {
    plan.policy = {
      requiredGates: options.policy.requiredGates || [],
      optionalGates: [],
      maxWorkers: options.policy.maxWorkers || 1,
      retries: {},
      overrides: {},
      blockOn: [],
      mergeRule: { type: "strict-required" },
    };
  }

  return Plan.parse(plan);
}

/**
 * Transform GitHub PR to plan item
 */
function transformPRToPlanItem(
  pr: PullRequestDetails,
  options: GitHubPlanOptions,
  repository: string
): PlanItem {
  // Generate item name from PR - use PR number as identifier
  const name = `PR-${pr.number}`;

  // Extract dependencies from GitHub dependencies
  // Filter to only include dependencies that are PRs in the same repo
  const deps = pr.dependencies
    .filter((dep: string) => {
      // Only include same-repo dependencies for now
      // Dependencies like "testowner/testrepo#123" or just "#123"
      const match = /^(?:([^#]+))?#([1-9][0-9]*)$/.exec(dep);
      if (!match || (match[1] && match[1].toLowerCase() !== repository.toLowerCase())) {
        throw new Error(
          `Dependency ${JSON.stringify(dep)} is outside this single-repository plan; declare a valid repository-bound dependency`
        );
      }
      return true;
    })
    .map((dep: string) => {
      // Convert dependency references to plan item names
      const prNumber = dep.includes("#") ? dep.split("#")[1] : dep;
      return `PR-${prNumber}`;
    });

  // Generate gates from PR metadata
  const gates = generateGatesFromPR(pr, options);

  const planItem: PlanItem = {
    name,
    deps: stableSort(deps),
    gates,
  };

  // Add tier assignment
  planItem.tier = createTierAssignment(planItem, options.tierOverrides);

  return planItem;
}

/**
 * Generate gates configuration from PR metadata
 */
function generateGatesFromPR(pr: PullRequestDetails, options: GitHubPlanOptions): Gate[] {
  const gates: Gate[] = [];

  // Use required gates from PR if specified, otherwise use policy defaults
  const requiredGates =
    pr.requiredGates.length > 0
      ? pr.requiredGates
      : options.policy?.requiredGates || ["lint", "test"];

  // Generate standard gates
  for (const gateName of requiredGates) {
    gates.push(createStandardGate(gateName, pr));
  }

  // Sort gates by name for deterministic output
  gates.sort((a, b) => a.name.localeCompare(b.name));

  return gates;
}

/**
 * Create standard gate configuration
 */
function createStandardGate(gateName: string, pr: PullRequestDetails): Gate {
  const baseGate: Gate = {
    name: gateName,
    run: getStandardGateCommand(gateName),
    cwd: ".",
    env: {
      PR_NUMBER: pr.number.toString(),
      PR_BRANCH: pr.head.ref,
      PR_SHA: pr.head.sha,
    },
    runtime: "local",
    artifacts: [],
  };

  // A standard command does not imply project-specific output files.
  // Execution receipts capture stdout/stderr; authored artifact requirements stay explicit.
  return gateName === "test" || gateName === "unit"
    ? { ...baseGate, timeoutMs: STANDARD_TEST_GATE_TIMEOUT_MS }
    : baseGate;
}

/**
 * Validate that GitHub dependencies reference PRs that exist in the plan
 */
function validateGitHubDependencies(planItems: PlanItem[], prDetails: PullRequestDetails[]): void {
  const itemNames = new Set(planItems.map((item) => item.name));
  const prNumbers = new Set(prDetails.map((pr) => `PR-${pr.number}`));

  for (const item of planItems) {
    for (const dep of item.deps) {
      if (!itemNames.has(dep)) {
        // Check if it's a PR reference that might exist but not in our current set
        if (dep.startsWith("PR-")) {
          const prNumber = dep.substring(3);
          console.warn(
            `Warning: Dependency ${dep} not found in current PR set. PR #${prNumber} may be closed or not match filters.`
          );
        } else {
          throw new Error(`Unknown dependency '${dep}' for item '${item.name}'`);
        }
      }
    }
  }
}

/**
 * Analyze file changes across PRs to detect potential conflicts and dependencies
 */
export async function analyzeGitHubPRFiles(
  client: GitHubClient,
  prs: PullRequestDetails[]
): Promise<FileAnalysisResult> {
  const octokit = client.getOctokit();
  const owner = client.getOwner();
  const repo = client.getRepo();

  const analyzer = createFileAnalyzer(octokit, owner, repo);

  const prInfo = prs.map((pr) => ({
    number: pr.number,
    name: `PR-${pr.number}`,
    sha: pr.head.sha,
  }));

  return await analyzer.analyzeFiles(prInfo);
}
