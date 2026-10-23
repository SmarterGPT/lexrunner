import * as fs from "node:fs";
import * as path from "node:path";

import { z } from "zod";

import { resolveProfile, validateWriteOperation } from "../config/profileResolver.js";
import {
  detectGitHubModeFromProfile,
  loadInputsFromProfile,
  type InputConfig,
} from "../core/inputs.js";
import { generateGitHubSnapshot, generateSnapshot } from "../core/snapshot.js";
import { buildRepositoryBoundPullRequestQuery, createGitHubClient } from "../github/client.js";
import type { Plan } from "../schema.js";
import type { TierOverride } from "../tiers/schema.js";
import { canonicalJSONStringify } from "../util/canonicalJson.js";
import { PlanCreationService } from "./integration-query-services.js";
import {
  assertPlanRepositoryBinding,
  assertRequestedRepositoryBinding,
  RepositoryBindingError,
  type RepositoryBindingObservation,
} from "./repository-binding.js";
import { resolveGateRepositoryRoot } from "./gate-candidate-identity.js";

const pathArgument = z.string().min(1).max(4096);
const boundedLabel = z.string().min(1).max(512);
const repositoryName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_.-]+$/u);

export const PlanCreationOperationArgsSchema = z
  .object({
    json: z.boolean().optional(),
    outDir: pathArgument.optional(),
    planFile: pathArgument.optional(),
    repoRoot: pathArgument.optional(),
    profileDir: pathArgument.optional(),
    fromGithub: z.boolean().optional(),
    query: z.string().min(1).max(4096).optional(),
    labels: z.array(boundedLabel).max(128).optional(),
    includeDrafts: z.boolean().optional(),
    excludePRs: z.array(z.number().int().positive()).max(256).optional(),
    githubToken: z.string().min(1).max(8192).optional(),
    owner: repositoryName.optional(),
    repo: repositoryName.optional(),
    repos: z
      .array(
        z
          .object({
            owner: repositoryName,
            repo: repositoryName,
            priority: z.number().int().optional(),
          })
          .strict()
      )
      .max(32)
      .optional(),
    requiredGates: z.array(boundedLabel).max(64).optional(),
    maxWorkers: z.number().int().min(1).max(256).optional(),
    target: boundedLabel.optional(),
  })
  .strict()
  .refine((value) => Boolean(value.owner) === Boolean(value.repo), {
    message: "owner and repo must be supplied together",
  });

export type PlanCreationOperationArgs = z.infer<typeof PlanCreationOperationArgsSchema>;

export interface PlanRoutingReceipt {
  contract: "lexrunner-plan-routing-v1";
  authority: "unverified";
  authorizesExecution: false;
  authorizesMerge: false;
  requestedRepository?: { owner: string; repo: string };
  resolvedRepository: {
    root: string;
    remote?: string;
    owner?: string;
    repo?: string;
  };
  profile: {
    root: string;
    source: string;
    precedence: "explicit" | "repository-local" | "environment-or-local";
  };
  discovery: {
    mode: "github" | "configuration";
    query?: string;
    querySource: "explicit" | "profile" | "none";
    target?: string;
    targetSource: "explicit" | "profile" | "repository-default";
  };
  output: { root: string; source: "explicit" | "profile-default" };
  gate: { cwd: "."; repositoryRoot: string };
}

export interface PlanCreationOperationResult {
  plan: Plan;
  inputs?: InputConfig;
  snapshot: string;
  routing: PlanRoutingReceipt;
  files: { plan: string; snapshot: string; routingReceipt: string };
}

export class PlanCreationOperationError extends Error {
  constructor(
    readonly code:
      | "PLAN_CREATION_ARGUMENTS_INVALID"
      | "PLAN_CREATION_MULTI_REPO_UNSUPPORTED"
      | "PLAN_CREATION_AUTH_REQUIRED"
      | "PLAN_CREATION_FAILED",
    message: string
  ) {
    super(message);
    this.name = "PlanCreationOperationError";
  }
}

interface PlanCreationOperationRequest {
  args: unknown;
  startupDir: string;
  requireGitHubToken?: boolean;
  tierOverrides?: TierOverride[];
}

type ClientFactory = typeof createGitHubClient;

/** One transport-neutral owner for plan routing, discovery and plan synthesis. */
export class PlanCreationOperationService {
  constructor(
    private readonly createClient: ClientFactory = createGitHubClient,
    private readonly plans = new PlanCreationService()
  ) {}

  async run(request: PlanCreationOperationRequest): Promise<PlanCreationOperationResult> {
    const parsed = PlanCreationOperationArgsSchema.safeParse(request.args);
    if (!parsed.success) {
      throw new PlanCreationOperationError(
        "PLAN_CREATION_ARGUMENTS_INVALID",
        "Plan creation arguments do not satisfy the bounded routing contract"
      );
    }
    const args = { ...parsed.data };
    if (args.repos && args.repos.length > 0) {
      throw new PlanCreationOperationError(
        "PLAN_CREATION_MULTI_REPO_UNSUPPORTED",
        "Multi-repository plan creation is not executable safely; create one repository-bound plan per worktree"
      );
    }

    // Local binding is deliberately first: no token lookup, API call, or write may
    // occur before an explicit repository mismatch has failed closed.
    const requestedRoot = args.repoRoot
      ? path.resolve(request.startupDir, args.repoRoot)
      : request.startupDir;
    const explicitRepositoryRouting = Boolean(args.repoRoot || args.owner || args.repo);
    let repository: RepositoryBindingObservation | undefined;
    let repositoryRoot: string;
    try {
      if (args.fromGithub || args.owner || args.repo) {
        repository = assertRequestedRepositoryBinding({
          repoRoot: requestedRoot,
          owner: args.owner,
          repo: args.repo,
        });
        repositoryRoot = repository.repositoryRoot;
      } else {
        repositoryRoot = resolveGateRepositoryRoot(requestedRoot);
        try {
          repository = assertRequestedRepositoryBinding({ repoRoot: repositoryRoot });
        } catch (error) {
          if (!(error instanceof RepositoryBindingError)) throw error;
          // Configuration-only legacy repositories may intentionally have no
          // GitHub remote. If profile discovery selects GitHub below, the
          // missing binding becomes a hard failure before network or writes.
        }
      }
    } catch (error) {
      if (error instanceof RepositoryBindingError) throw error;
      throw new PlanCreationOperationError(
        "PLAN_CREATION_FAILED",
        "Repository routing could not be established"
      );
    }

    const resolvedProfile = resolveProfile(args.profileDir, repositoryRoot, {
      ignoreEnvironment: explicitRepositoryRouting && !args.profileDir,
    });
    const detected = detectGitHubModeFromProfile(resolvedProfile.path);
    const autoDetectedGitHub = !args.fromGithub && detected.shouldUseGitHub;
    const fromGithub = Boolean(args.fromGithub || autoDetectedGitHub);
    if (fromGithub && !repository) {
      repository = assertRequestedRepositoryBinding({ repoRoot: repositoryRoot });
    }
    const query = args.query ?? detected.scopeConfig?.query;
    const labels = args.labels ?? detected.scopeConfig?.labels;
    const target = args.target ?? detected.scopeConfig?.target;
    if (fromGithub && repository) {
      // Validate the caller/profile query and interpolated routing fields before
      // token lookup, client construction, network access or writes.
      buildRepositoryBoundPullRequestQuery({
        query,
        owner: repository.identity.owner,
        repo: repository.identity.repo,
        base: target,
        state: "open",
      });
    }
    const planFile = args.planFile ? path.resolve(repositoryRoot, args.planFile) : undefined;
    const outDir = planFile
      ? path.dirname(planFile)
      : args.outDir
        ? path.resolve(repositoryRoot, args.outDir)
        : path.join(resolvedProfile.path, "runner");
    const files = {
      plan: planFile ?? path.join(outDir, "plan.json"),
      snapshot: path.join(outDir, "snapshot.md"),
      routingReceipt: path.join(outDir, "routing-receipt.json"),
    };
    if (!distinctOutputPaths(Object.values(files))) {
      throw new PlanCreationOperationError(
        "PLAN_CREATION_ARGUMENTS_INVALID",
        "Plan, snapshot and routing receipt outputs must use distinct paths"
      );
    }

    if (fromGithub && request.requireGitHubToken) {
      const token = args.githubToken || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      if (!token) {
        throw new PlanCreationOperationError(
          "PLAN_CREATION_AUTH_REQUIRED",
          "GitHub authentication is required for this plan creation surface"
        );
      }
    }

    let plan: Plan;
    let inputs: InputConfig | undefined;
    let exactQuery: string | undefined;
    if (fromGithub) {
      if (!repository) {
        throw new PlanCreationOperationError(
          "PLAN_CREATION_FAILED",
          "GitHub discovery requires a repository-bound GitHub remote"
        );
      }
      const client = await this.createClient({
        token: args.githubToken,
        owner: repository.identity.owner,
        repo: repository.identity.repo,
      });
      plan = await this.plans.fromGitHub(client, {
        query,
        labels,
        excludePRs: args.excludePRs,
        includeDrafts: args.includeDrafts,
        target,
        policy: {
          requiredGates: args.requiredGates ?? ["lint", "typecheck", "test"],
          maxWorkers: args.maxWorkers ?? 2,
        },
        tierOverrides: request.tierOverrides,
      });
      assertPlanRepositoryBinding(plan, repositoryRoot);
      if (query) {
        exactQuery = buildRepositoryBoundPullRequestQuery({
          query,
          owner: client.getOwner(),
          repo: client.getRepo(),
          base: plan.target,
          state: "open",
        });
      }
    } else {
      inputs = loadInputsFromProfile(resolvedProfile.path);
      plan = this.plans.fromInputs(inputs, {
        tierOverrides: request.tierOverrides,
        preserveEmptyPlan: true,
      });
    }
    const routing: PlanRoutingReceipt = {
      contract: "lexrunner-plan-routing-v1",
      authority: "unverified",
      authorizesExecution: false,
      authorizesMerge: false,
      ...(args.owner && args.repo
        ? { requestedRepository: { owner: args.owner, repo: args.repo } }
        : {}),
      resolvedRepository: {
        root: repositoryRoot,
        ...(repository
          ? {
              remote: repository.remote,
              owner: repository.identity.owner,
              repo: repository.identity.repo,
            }
          : {}),
      },
      profile: {
        root: resolvedProfile.path,
        source: resolvedProfile.source,
        precedence: args.profileDir
          ? "explicit"
          : explicitRepositoryRouting
            ? "repository-local"
            : "environment-or-local",
      },
      discovery: {
        mode: fromGithub ? "github" : "configuration",
        ...(fromGithub
          ? {
              query: exactQuery,
            }
          : {}),
        querySource: args.query ? "explicit" : detected.scopeConfig?.query ? "profile" : "none",
        ...(fromGithub ? { target: plan.target } : target ? { target } : {}),
        targetSource: args.target
          ? "explicit"
          : detected.scopeConfig?.target
            ? "profile"
            : "repository-default",
      },
      output: {
        root: outDir,
        source: args.planFile || args.outDir ? "explicit" : "profile-default",
      },
      gate: { cwd: ".", repositoryRoot },
    };

    return {
      plan,
      ...(inputs ? { inputs } : {}),
      snapshot: fromGithub ? generateGitHubSnapshot(plan) : generateSnapshot(plan, inputs!),
      routing,
      files,
    };
  }
}

export function writePlanCreationArtifacts(result: PlanCreationOperationResult): void {
  const profile = result.routing.profile;
  const output = result.routing.output.root;
  if (isWithin(profile.root, output)) {
    const resolved = resolveProfile(profile.root, result.routing.resolvedRepository.root);
    validateWriteOperation(resolved.path, resolved.manifest.role, "write plan artifacts");
  }
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(result.files.plan, canonicalJSONStringify(result.plan));
  fs.writeFileSync(result.files.snapshot, result.snapshot);
  fs.writeFileSync(result.files.routingReceipt, canonicalJSONStringify(result.routing));
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function distinctOutputPaths(paths: string[]): boolean {
  const normalized = paths.map((value) => {
    const absolute = path.normalize(path.resolve(value));
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  });
  return new Set(normalized).size === normalized.length;
}
