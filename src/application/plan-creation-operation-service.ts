import { spawnSync } from "node:child_process";
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
  resolveExecutionRoot,
  type RepositoryBindingObservation,
} from "./repository-binding.js";

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
        repositoryRoot = resolveExecutionRoot(requestedRoot, false);
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
    const requestedOutDir = planFile
      ? path.dirname(planFile)
      : args.outDir
        ? path.resolve(repositoryRoot, args.outDir)
        : path.join(resolvedProfile.path, "runner");
    const outDir = resolvePhysicalDirectoryCandidate(requestedOutDir);
    const physicalProfileRoot = resolvePhysicalDirectoryCandidate(resolvedProfile.path);
    if ((!args.planFile && !args.outDir) || isWithin(resolvedProfile.path, requestedOutDir)) {
      assertPhysicalContainment(physicalProfileRoot, outDir);
    }
    const files = {
      plan: path.join(outDir, planFile ? path.basename(planFile) : "plan.json"),
      snapshot: path.join(outDir, "snapshot.md"),
      routingReceipt: path.join(outDir, "routing-receipt.json"),
    };
    assertOutputFilesWithinRoot(outDir, assertDistinctOutputPaths(Object.values(files)));

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
  const output = path.resolve(result.routing.output.root);
  const observedOutput = resolvePhysicalDirectoryCandidate(output);
  if (!samePhysicalPath(output, observedOutput)) {
    throw invalidPhysicalOutput();
  }
  const physicalProfileRoot = resolvePhysicalDirectoryCandidate(profile.root);
  const outputIsWithinProfile = isWithin(physicalProfileRoot, observedOutput);
  if (result.routing.output.source === "profile-default") {
    assertPhysicalContainment(physicalProfileRoot, observedOutput);
  }
  if (outputIsWithinProfile) {
    const resolved = resolveProfile(profile.root, result.routing.resolvedRepository.root);
    validateWriteOperation(resolved.path, resolved.manifest.role, "write plan artifacts");
  }
  // Reobserve aliases immediately before the first mutation. A caller may have
  // created links after planning; never let sequential writes overwrite one
  // artifact through another physical file.
  assertOutputFilesWithinRoot(output, assertDistinctOutputPaths(Object.values(result.files)));
  fs.mkdirSync(output, { recursive: true });
  // mkdir may make a previously missing output path observable, or an
  // untrusted peer may have populated the directory while it was created.
  // Recheck after directory creation and immediately before the first write.
  const reobservedOutput = resolvePhysicalDirectoryCandidate(output);
  if (!samePhysicalPath(output, reobservedOutput)) {
    throw invalidPhysicalOutput();
  }
  const outputIdentity = observeDirectoryIdentity(output);
  const destinations = assertOutputFilesWithinRoot(
    output,
    assertDistinctOutputPaths(Object.values(result.files))
  );
  const artifacts = [
    { destination: destinations[0]!.writePath, content: canonicalJSONStringify(result.plan) },
    { destination: destinations[1]!.writePath, content: result.snapshot },
    {
      destination: destinations[2]!.writePath,
      content: canonicalJSONStringify(result.routing),
    },
  ];
  writeArtifactsFromPinnedDirectory(output, outputIdentity, artifacts);
  const finalOutput = resolvePhysicalDirectoryCandidate(output);
  if (
    !samePhysicalPath(output, finalOutput) ||
    !sameDirectoryIdentity(outputIdentity, observeDirectoryIdentity(output))
  ) {
    throw invalidPhysicalOutput();
  }
  assertOutputFilesWithinRoot(output, assertDistinctOutputPaths(Object.values(result.files)));
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

interface OutputPathObservation {
  canonicalPath: string;
  writePath: string;
  identity?: string;
}

interface DirectoryIdentity {
  canonicalPath: string;
  device: string;
  inode: string;
}

interface PinnedArtifact {
  destination: string;
  content: string;
}

const PINNED_ARTIFACT_WRITER_SOURCE = String.raw`
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const missing = (error) => error && typeof error === "object" && error.code === "ENOENT";
const identity = () => {
  const value = fs.statSync(".", { bigint: true });
  if (!value.isDirectory()) throw new Error("invalid output directory");
  const resolved = path.normalize(path.resolve(fs.realpathSync(".")));
  return {
    canonicalPath: process.platform === "win32" ? resolved.toLowerCase() : resolved,
    device: value.dev.toString(),
    inode: value.ino.toString(),
  };
};
const sameIdentity = (left, right) =>
  left.canonicalPath === right.canonicalPath &&
  left.device === right.device &&
  left.inode === right.inode;
try {
  const payload = JSON.parse(fs.readFileSync(0, "utf8"));
  if (!sameIdentity(identity(), payload.identity) || !Array.isArray(payload.artifacts)) {
    throw new Error("output directory identity changed");
  }
  const names = new Set();
  for (const artifact of payload.artifacts) {
    if (
      !artifact ||
      typeof artifact.name !== "string" ||
      typeof artifact.content !== "string" ||
      artifact.name === "." ||
      artifact.name === ".." ||
      path.basename(artifact.name) !== artifact.name ||
      names.has(artifact.name)
    ) {
      throw new Error("invalid artifact");
    }
    names.add(artifact.name);
    let entry;
    try {
      entry = fs.lstatSync(artifact.name, { bigint: true });
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (entry && (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1n)) {
      throw new Error("unsafe output target");
    }
  }
  const staged = [];
  try {
    for (const artifact of payload.artifacts) {
      const temporary = "." + artifact.name + ".lexrunner-" + randomUUID() + ".tmp";
      fs.writeFileSync(temporary, artifact.content, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
      staged.push(temporary);
    }
    if (!sameIdentity(identity(), payload.identity)) {
      throw new Error("output directory identity changed");
    }
    for (let index = 0; index < payload.artifacts.length; index += 1) {
      fs.renameSync(staged[index], payload.artifacts[index].name);
      staged[index] = "";
    }
  } finally {
    for (const temporary of staged) {
      if (!temporary) continue;
      try {
        fs.unlinkSync(temporary);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
  }
  if (!sameIdentity(identity(), payload.identity)) {
    throw new Error("output directory identity changed");
  }
} catch {
  process.exitCode = 71;
}
`;

function writeArtifactsFromPinnedDirectory(
  output: string,
  identity: DirectoryIdentity,
  artifacts: PinnedArtifact[]
): void {
  const payload = JSON.stringify({
    identity,
    artifacts: artifacts.map(({ destination, content }) => ({
      name: path.basename(destination),
      content,
    })),
  });
  const completed = spawnSync(process.execPath, ["--eval", PINNED_ARTIFACT_WRITER_SOURCE], {
    cwd: output,
    input: payload,
    encoding: "utf8",
    // The helper needs only the absolute Node executable and built-ins. An
    // empty environment prevents NODE_OPTIONS preloads, coverage writers and
    // other caller-controlled startup hooks from crossing this boundary.
    env: {},
    timeout: 60_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  if (completed.error || completed.signal || completed.status !== 0) {
    throw invalidPhysicalOutput();
  }
}

function observeDirectoryIdentity(value: string): DirectoryIdentity {
  try {
    const info = fs.statSync(value, { bigint: true });
    if (!info.isDirectory()) throw invalidPhysicalOutput();
    return {
      canonicalPath: normalizePhysicalPath(fs.realpathSync(value)),
      device: info.dev.toString(),
      inode: info.ino.toString(),
    };
  } catch (error) {
    if (error instanceof PlanCreationOperationError) throw error;
    throw invalidPhysicalOutput();
  }
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return (
    left.canonicalPath === right.canonicalPath &&
    left.device === right.device &&
    left.inode === right.inode
  );
}

function assertPhysicalContainment(parent: string, child: string): void {
  if (!isWithin(parent, child)) throw invalidPhysicalOutput();
}

function assertOutputFilesWithinRoot(
  outputRoot: string,
  observations: OutputPathObservation[]
): OutputPathObservation[] {
  const canonicalRoot = normalizePhysicalPath(outputRoot);
  if (
    observations.some(
      ({ writePath }) => normalizePhysicalPath(path.dirname(writePath)) !== canonicalRoot
    )
  ) {
    throw invalidPhysicalOutput();
  }
  return observations;
}

function invalidPhysicalOutput(): PlanCreationOperationError {
  return new PlanCreationOperationError(
    "PLAN_CREATION_ARGUMENTS_INVALID",
    "Plan artifact outputs must remain within the reported physical output root"
  );
}

function assertDistinctOutputPaths(paths: string[]): OutputPathObservation[] {
  try {
    const observations = paths.map(observeOutputPath);
    const canonicalPaths = observations.map(({ canonicalPath }) => canonicalPath);
    const existingIdentities = observations
      .map(({ identity }) => identity)
      .filter((identity): identity is string => identity !== undefined);
    if (
      new Set(canonicalPaths).size !== canonicalPaths.length ||
      new Set(existingIdentities).size !== existingIdentities.length
    ) {
      throw new Error("output alias collision");
    }
    return observations;
  } catch {
    throw new PlanCreationOperationError(
      "PLAN_CREATION_ARGUMENTS_INVALID",
      "Plan, snapshot and routing receipt outputs must use distinct physical paths"
    );
  }
}

function observeOutputPath(value: string): OutputPathObservation {
  const absolute = path.resolve(value);
  let entry: fs.BigIntStats | undefined;
  try {
    entry = fs.lstatSync(absolute, { bigint: true });
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  if (entry) {
    // Artifact writes must never follow a link or mutate a file shared with an
    // external path. Requiring an ordinary single-link file also excludes
    // directories, devices and other non-file targets.
    if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1n) {
      throw new Error("unsafe output target");
    }
    const writePath = fs.realpathSync(absolute);
    const canonicalPath = normalizePhysicalPath(writePath);
    const info = fs.statSync(writePath, { bigint: true });
    if (!info.isFile() || info.nlink !== 1n) {
      throw new Error("unsafe output target");
    }
    return {
      canonicalPath,
      writePath,
      identity: `${info.dev.toString()}:${info.ino.toString()}`,
    };
  }

  const remaining: string[] = [];
  let ancestor = absolute;
  for (;;) {
    try {
      fs.lstatSync(ancestor);
      break;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      remaining.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
  const writePath = path.join(fs.realpathSync(ancestor), ...remaining);
  return { canonicalPath: normalizePhysicalPath(writePath), writePath };
}

function resolvePhysicalDirectoryCandidate(value: string): string {
  const absolute = path.resolve(value);
  const remaining: string[] = [];
  let ancestor = absolute;
  for (;;) {
    try {
      fs.lstatSync(ancestor);
    } catch (error) {
      if (!isMissingPathError(error)) throw invalidPhysicalOutput();
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw invalidPhysicalOutput();
      remaining.unshift(path.basename(ancestor));
      ancestor = parent;
      continue;
    }
    try {
      const physicalAncestor = fs.realpathSync(ancestor);
      if (!fs.statSync(physicalAncestor).isDirectory()) throw invalidPhysicalOutput();
      return path.join(physicalAncestor, ...remaining);
    } catch (error) {
      if (error instanceof PlanCreationOperationError) throw error;
      throw invalidPhysicalOutput();
    }
  }
}

function samePhysicalPath(left: string, right: string): boolean {
  return normalizePhysicalPath(left) === normalizePhysicalPath(right);
}

function normalizePhysicalPath(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isMissingPathError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
