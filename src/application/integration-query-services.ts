import { generatePlanFromGitHub } from "../core/githubPlan.js";
import type { InputConfig } from "../core/inputs.js";
import { generateEmptyPlan, generatePlan } from "../core/plan.js";
import { generateMultiRepoPlan, type RepoTarget } from "../core/multiRepoPlan.js";
import { ExecutionState } from "../executionState.js";
import type { GitHubAPI, GitHubPullRequest } from "../github/api.js";
import type { GitHubClient } from "../github/client.js";
import { MergeEligibilityEvaluator } from "../mergeEligibility.js";
import { computeMergeOrder } from "../mergeOrder.js";
import { loadPlan, type Plan } from "../schema.js";
import type { TierOverride } from "../tiers/schema.js";
import { canonicalJSONStringify } from "../util/canonicalJson.js";
import { createFileAnalyzer } from "../planner/fileAnalysis.js";
import { loadGateEvidence, type GateEvidenceArtifactReference } from "./gate-evidence-service.js";
import type { RetainedGateEvidenceReport } from "./retained-gate-evidence.js";

const MAX_COLLECTION = 256;
const MAX_LABEL_BYTES = 512;
const MAX_RESULT_BYTES = 256 * 1024;

export class IntegrationQueryServiceError extends Error {
  constructor(
    readonly code: "QUERY_RESULT_LIMIT_EXCEEDED" | "PLAN_GENERATION_FAILED",
    message: string
  ) {
    super(message);
    this.name = "IntegrationQueryServiceError";
  }
}

export interface BoundedDiscoveryResult {
  contract: "bounded-ax-v1";
  pullRequests: Array<Omit<GitHubPullRequest, "body">>;
  suggestions?: unknown[];
  total: number;
  suggestionsCount?: number;
  authenticated: boolean;
  user?: string;
}

export class DiscoveryQueryService {
  async run(input: {
    github: GitHubAPI;
    state: "open" | "closed" | "all";
    suggest?: boolean;
  }): Promise<BoundedDiscoveryResult> {
    const auth = await input.github.checkAuth();
    const discovered = await input.github.discoverPullRequests(input.state);
    assertCollection(discovered, "pull requests");
    const pullRequests = discovered.map(({ body: _body, ...pullRequest }) => ({
      ...pullRequest,
      title: bounded(pullRequest.title),
      branch: bounded(pullRequest.branch),
      sha: bounded(pullRequest.sha),
      author: bounded(pullRequest.author),
      baseBranch: bounded(pullRequest.baseBranch),
      labels: boundedStrings(pullRequest.labels),
    }));
    let suggestions: unknown[] | undefined;
    if (input.suggest) {
      const analyzer = createFileAnalyzer(
        input.github.getOctokit(),
        input.github.config.owner,
        input.github.config.repo
      );
      suggestions = await analyzer.suggestDependenciesWithHeuristics(
        pullRequests.map(({ number, sha }) => ({ number, name: `PR-${number}`, sha }))
      );
      assertCollection(suggestions, "dependency suggestions");
    }
    return boundedResult({
      contract: "bounded-ax-v1",
      pullRequests,
      ...(suggestions ? { suggestions, suggestionsCount: suggestions.length } : {}),
      total: pullRequests.length,
      authenticated: auth.authenticated,
      ...(auth.user ? { user: bounded(auth.user) } : {}),
    });
  }
}

type GitHubPlanOptions = Parameters<typeof generatePlanFromGitHub>[1];
type MultiRepoPlanOptions = Parameters<typeof generateMultiRepoPlan>[1];

export class PlanCreationService {
  async fromGitHub(client: GitHubClient, options: GitHubPlanOptions): Promise<Plan> {
    return validateBoundedPlan(await generatePlanFromGitHub(client, options));
  }

  async fromMultipleRepositories(
    repositories: RepoTarget[],
    options: MultiRepoPlanOptions
  ): Promise<Plan> {
    assertCollection(repositories, "repositories");
    return validateBoundedPlan(await generateMultiRepoPlan(repositories, options));
  }

  fromInputs(
    inputs: InputConfig,
    options?: { tierOverrides?: TierOverride[]; preserveEmptyPlan?: boolean }
  ): Plan {
    const plan =
      inputs.items.length > 0 || !options?.preserveEmptyPlan
        ? generatePlan(inputs, { tierOverrides: options?.tierOverrides })
        : generateEmptyPlan(inputs.target);
    return validateBoundedPlan(plan);
  }
}

export interface BoundedIntegrationStatus {
  contract: "bounded-ax-v1";
  plan: {
    schemaVersion: string;
    target: string;
    itemCount: number;
    gitInputBinding: "frozen" | "legacy-unbound";
    policy?: Plan["policy"];
  };
  mergeSummary: ReturnType<MergeEligibilityEvaluator["getMergeSummary"]>;
  evidence?: GateEvidenceArtifactReference & {
    applied: number;
    authority: "unverified";
    observations: { passed: string[]; failed: string[]; other: string[] };
    artifactVerification?: RetainedGateEvidenceReport;
  };
}

export class IntegrationStatusQueryService {
  run(
    plan: Plan,
    evidence?: {
      evidenceFile: string;
      evidenceSha256: string;
      repoRoot?: string;
      verifyArtifacts?: boolean;
    }
  ): BoundedIntegrationStatus {
    const validated = validateBoundedPlan(plan);
    const projection = evidence ? loadGateEvidence({ plan: validated, ...evidence }) : undefined;
    // Integrity-valid caller evidence is observable but cannot mint merge authority.
    const evaluator = new MergeEligibilityEvaluator(validated, new ExecutionState(validated));
    return boundedResult({
      contract: "bounded-ax-v1",
      plan: {
        schemaVersion: validated.schemaVersion,
        target: bounded(validated.target),
        itemCount: validated.items.length,
        gitInputBinding: validated.gitInputs ? "frozen" : "legacy-unbound",
        ...(validated.policy ? { policy: validated.policy } : {}),
      },
      mergeSummary: evaluator.getMergeSummary(),
      ...(projection
        ? {
            evidence: {
              ...projection.reference,
              applied: projection.applied,
              authority: "unverified" as const,
              observations: projection.observations,
              ...(projection.artifactVerification
                ? { artifactVerification: projection.artifactVerification }
                : {}),
            },
          }
        : {}),
    });
  }
}

export interface BoundedMergeOrderResult {
  contract: "bounded-ax-v1";
  levels: string[][];
  totalItems: number;
  maxParallelism: number;
}

export class MergeOrderQueryService {
  run(plan: Plan): BoundedMergeOrderResult {
    const validated = validateBoundedPlan(plan);
    const levels = computeMergeOrder(validated).map((level) => boundedStrings(level));
    return boundedResult({
      contract: "bounded-ax-v1",
      levels,
      totalItems: validated.items.length,
      maxParallelism: levels.length === 0 ? 0 : Math.max(...levels.map((level) => level.length)),
    });
  }
}

function validateBoundedPlan(plan: Plan): Plan {
  let validated: Plan;
  try {
    validated = loadPlan(canonicalJSONStringify(plan));
  } catch {
    throw new IntegrationQueryServiceError(
      "PLAN_GENERATION_FAILED",
      "Generated plan does not satisfy the canonical Plan contract"
    );
  }
  assertCollection(validated.items, "plan items");
  for (const item of validated.items) {
    bounded(item.name);
    assertCollection(item.deps, "plan dependencies");
    assertCollection(item.gates, "plan gates");
  }
  return boundedResult(validated);
}

function boundedStrings(values: string[]): string[] {
  assertCollection(values, "string values");
  return values.map((value) => bounded(value));
}

function bounded(value: string): string {
  if (Buffer.byteLength(value, "utf8") > MAX_LABEL_BYTES) {
    throw new IntegrationQueryServiceError(
      "QUERY_RESULT_LIMIT_EXCEEDED",
      `Query label exceeds ${MAX_LABEL_BYTES} bytes`
    );
  }
  return value;
}

function assertCollection(values: readonly unknown[], name: string): void {
  if (values.length > MAX_COLLECTION) {
    throw new IntegrationQueryServiceError(
      "QUERY_RESULT_LIMIT_EXCEEDED",
      `${name} exceeds the ${MAX_COLLECTION}-entry result limit`
    );
  }
}

function boundedResult<T>(value: T): T {
  if (Buffer.byteLength(canonicalJSONStringify(value), "utf8") > MAX_RESULT_BYTES) {
    throw new IntegrationQueryServiceError(
      "QUERY_RESULT_LIMIT_EXCEEDED",
      `Query result exceeds ${MAX_RESULT_BYTES} bytes`
    );
  }
  return value;
}
