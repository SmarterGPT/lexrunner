/**
 * Multi-Repo Plan Generation
 *
 * Extends GitHub plan generation to support multiple repositories.
 * This enables merge-weave operations across repos like lex, lexsona, and lexrunner.
 *
 * @module
 */

import { Plan, PlanItem, Gate } from "../schema.js";
import { GitHubClient, createGitHubClient, PullRequestDetails } from "../github/index.js";
import { stableSort } from "../util/canonicalJson.js";
import { createTierAssignment } from "../tiers/suggest.js";
import type { TierOverride } from "../tiers/schema.js";
import { getStandardGateCommand } from "./standardGateCommands.js";

const STANDARD_TEST_GATE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Repository target for multi-repo discovery
 */
export interface RepoTarget {
  owner: string;
  repo: string;
  /** Priority for merge ordering (lower = earlier). Default: 1 */
  priority?: number;
}

/**
 * Options for multi-repo plan generation
 */
export interface MultiRepoPlanOptions {
  query?: string;
  labels?: string[];
  excludePRs?: number[];
  includeDrafts?: boolean;
  target?: string;
  policy?: {
    requiredGates?: string[];
    maxWorkers?: number;
  };
  tierOverrides?: TierOverride[];
  /** GitHub token for authentication */
  githubToken?: string;
}

/**
 * PR with repository context
 */
interface PRWithRepo extends PullRequestDetails {
  repoOwner: string;
  repoName: string;
  repoPriority: number;
}

/**
 * Generate plan from multiple GitHub repositories
 *
 * This function:
 * 1. Discovers PRs from each repository
 * 2. Resolves cross-repo dependencies (owner/repo#123 format)
 * 3. Combines into a single plan with proper ordering
 *
 * @example
 * ```typescript
 * const plan = await generateMultiRepoPlan([
 *   { owner: "Guffawaffle", repo: "lex", priority: 1 },
 *   { owner: "Guffawaffle", repo: "lexsona", priority: 2 },
 *   { owner: "Guffawaffle", repo: "lexrunner", priority: 3 },
 * ], {
 *   labels: ["ready-to-merge"],
 *   policy: { requiredGates: ["lint", "test"] }
 * });
 * ```
 */
export async function generateMultiRepoPlan(
  repos: RepoTarget[],
  options: MultiRepoPlanOptions = {}
): Promise<Plan> {
  if (repos.length === 0) {
    throw new Error("At least one repository is required");
  }

  // Discover PRs from all repos in parallel
  const repoResults = await Promise.all(
    repos.map(async (repo) => {
      const client = await createGitHubClient({
        token: options.githubToken,
        owner: repo.owner,
        repo: repo.repo,
      });

      const prs = await discoverRepoPRs(client, repo, options);
      return { repo, client, prs };
    })
  );

  // Flatten all PRs with repo context
  const allPRs: PRWithRepo[] = [];
  let target = options.target;

  for (const { repo, client, prs } of repoResults) {
    // Use first repo's default branch as target if not specified
    if (!target) {
      const repoInfo = await client.validateRepository();
      target = repoInfo.defaultBranch;
    }

    for (const pr of prs) {
      allPRs.push({
        ...pr,
        repoOwner: repo.owner,
        repoName: repo.repo,
        repoPriority: repo.priority ?? 1,
      });
    }
  }

  if (allPRs.length === 0) {
    return createEmptyPlan(target || "main", options);
  }

  // Transform PRs to plan items with full repo context
  const planItems = allPRs.map((pr) => transformMultiRepoPRToPlanItem(pr, allPRs, options));

  // Sort by repo priority, then by PR number for deterministic ordering
  planItems.sort((a, b) => {
    const prA = allPRs.find((p) => a.name === generateMultiRepoItemName(p));
    const prB = allPRs.find((p) => b.name === generateMultiRepoItemName(p));

    if (!prA || !prB) return a.name.localeCompare(b.name);

    // Sort by repo priority first
    if (prA.repoPriority !== prB.repoPriority) {
      return prA.repoPriority - prB.repoPriority;
    }

    // Then by PR number
    return prA.number - prB.number;
  });

  // Build the plan
  const plan: Plan = {
    schemaVersion: "1.0.0",
    target: target || "main",
    items: planItems,
    // Note: Multi-repo metadata is logged but not stored in plan due to strict schema
    // Use generateMultiRepoSnapshot() to preserve repo context
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

  return plan;
}

/**
 * Discover PRs from a single repository
 */
async function discoverRepoPRs(
  client: GitHubClient,
  repo: RepoTarget,
  options: MultiRepoPlanOptions
): Promise<PullRequestDetails[]> {
  const prs = await client.listOpenPRs({
    state: "open",
    labels: options.labels,
    ...(options.query ? { query: options.query } : {}),
  });

  // Filter drafts
  const includeDrafts = options.includeDrafts === undefined ? true : Boolean(options.includeDrafts);
  const filteredPRs = includeDrafts ? prs : prs.filter((pr) => !pr.draft);

  // Exclude specific PRs
  const excludePRs = options.excludePRs || [];
  const finalPRs =
    excludePRs.length > 0
      ? filteredPRs.filter((pr) => !excludePRs.includes(pr.number))
      : filteredPRs;

  // Get detailed information for each PR
  return Promise.all(finalPRs.map((pr) => client.getPRDetails(pr.number)));
}

/**
 * Generate item name for multi-repo PR
 * Format: owner/repo#PR-123
 */
function generateMultiRepoItemName(pr: PRWithRepo): string {
  return `${pr.repoOwner}/${pr.repoName}#PR-${pr.number}`;
}

/**
 * Transform a PR to a plan item with cross-repo dependency resolution
 */
function transformMultiRepoPRToPlanItem(
  pr: PRWithRepo,
  allPRs: PRWithRepo[],
  options: MultiRepoPlanOptions
): PlanItem {
  const name = generateMultiRepoItemName(pr);

  // Resolve dependencies, including cross-repo references
  const deps = resolveCrossRepoDependencies(pr, allPRs);

  // Generate gates
  const gates = generateGatesForMultiRepoPR(pr, options);

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
 * Resolve dependencies including cross-repo references
 */
function resolveCrossRepoDependencies(pr: PRWithRepo, allPRs: PRWithRepo[]): string[] {
  const deps: string[] = [];
  const allItemNames = new Set(allPRs.map(generateMultiRepoItemName));

  for (const dep of pr.dependencies) {
    // Parse dependency format: owner/repo#123 or #123 (same repo)
    const crossRepoMatch = dep.match(/^([^\/]+)\/([^#]+)#(\d+)$/);
    const sameRepoMatch = dep.match(/^#?(\d+)$/);

    if (crossRepoMatch) {
      // Cross-repo dependency: owner/repo#123
      const [, depOwner, depRepo, prNumber] = crossRepoMatch;
      const itemName = `${depOwner}/${depRepo}#PR-${prNumber}`;

      if (allItemNames.has(itemName)) {
        deps.push(itemName);
      } else {
        console.warn(
          `Cross-repo dependency ${itemName} not found in plan set (from ${generateMultiRepoItemName(pr)})`
        );
      }
    } else if (sameRepoMatch) {
      // Same-repo dependency: #123 or just 123
      const [, prNumber] = sameRepoMatch;
      const itemName = `${pr.repoOwner}/${pr.repoName}#PR-${prNumber}`;

      if (allItemNames.has(itemName)) {
        deps.push(itemName);
      } else {
        console.warn(
          `Same-repo dependency ${itemName} not found in plan set (from ${generateMultiRepoItemName(pr)})`
        );
      }
    }
  }

  return deps;
}

/**
 * Generate gates for a multi-repo PR
 */
function generateGatesForMultiRepoPR(pr: PRWithRepo, options: MultiRepoPlanOptions): Gate[] {
  const gates: Gate[] = [];

  const requiredGates =
    pr.requiredGates.length > 0
      ? pr.requiredGates
      : options.policy?.requiredGates || ["lint", "test"];

  for (const gateName of requiredGates) {
    gates.push({
      name: gateName,
      run: getStandardGateCommand(gateName),
      cwd: ".",
      env: {
        PR_NUMBER: pr.number.toString(),
        PR_BRANCH: pr.head.ref,
        PR_SHA: pr.head.sha,
        REPO_OWNER: pr.repoOwner,
        REPO_NAME: pr.repoName,
      },
      runtime: "local",
      artifacts: [],
      ...(isStandardTestGate(gateName) ? { timeoutMs: STANDARD_TEST_GATE_TIMEOUT_MS } : {}),
    });
  }

  // Sort gates by name for deterministic output
  gates.sort((a, b) => a.name.localeCompare(b.name));

  return gates;
}

function isStandardTestGate(gateName: string): boolean {
  return gateName === "test" || gateName === "unit";
}

/**
 * Create an empty plan
 */
function createEmptyPlan(target: string, options: MultiRepoPlanOptions): Plan {
  const plan: Plan = {
    schemaVersion: "1.0.0",
    target,
    items: [],
  };

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

  return plan;
}
