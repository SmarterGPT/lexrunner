import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { resolveGateRepositoryRoot } from "./gate-candidate-identity.js";
import { repositoryIdentity } from "../git/input-schema.js";
import type { Gate, Plan } from "../schema.js";

const MAX_PATH_BYTES = 4096;

export type RepositoryIdentity = Readonly<{ owner: string; repo: string }>;

export interface RepositoryBindingObservation {
  repositoryRoot: string;
  remote: string;
  identity: RepositoryIdentity;
}

export class RepositoryBindingError extends Error {
  constructor(
    readonly code:
      | "PLAN_REPOSITORY_ROOT_INVALID"
      | "PLAN_REPOSITORY_REMOTE_UNAVAILABLE"
      | "PLAN_REPOSITORY_MISMATCH"
      | "PLAN_REPOSITORY_ARGUMENTS_INVALID"
      | "PLAN_MULTI_REPO_EXECUTION_UNSUPPORTED",
    message: string
  ) {
    super(message);
    this.name = "RepositoryBindingError";
  }
}

/**
 * Read the local repository identity without authentication or network access.
 * Returned remote text is normalized and never contains userinfo or credentials.
 */
export function observeRepositoryBinding(
  requestedRoot: string,
  remoteName = "origin"
): RepositoryBindingObservation {
  if (
    typeof requestedRoot !== "string" ||
    requestedRoot.trim().length === 0 ||
    requestedRoot.includes("\0") ||
    Buffer.byteLength(requestedRoot, "utf8") > MAX_PATH_BYTES
  ) {
    throw new RepositoryBindingError(
      "PLAN_REPOSITORY_ROOT_INVALID",
      "The repository root argument is invalid"
    );
  }

  let repositoryRoot: string;
  try {
    repositoryRoot = realpathSync(resolveGateRepositoryRoot(requestedRoot));
  } catch {
    throw new RepositoryBindingError(
      "PLAN_REPOSITORY_ROOT_INVALID",
      "The requested repository root is not an available Git worktree"
    );
  }

  const remoteUrl = readRemote(repositoryRoot, remoteName);
  const identity = remoteUrl ? parseObservedGitHubRemote(remoteUrl) : undefined;
  if (!identity) {
    throw new RepositoryBindingError(
      "PLAN_REPOSITORY_REMOTE_UNAVAILABLE",
      "The repository has no parseable GitHub remote identity"
    );
  }

  return {
    repositoryRoot,
    remote: `https://github.com/${identity.owner}/${identity.repo}.git`,
    identity,
  };
}

export function parseRepositoryIdentity(value: string): RepositoryIdentity | undefined {
  const observed = parseObservedGitHubRemote(value);
  if (observed) return observed;

  const short = /^([^\s/#]+)\/([^\s/#]+?)(?:\.git)?$/u.exec(value.trim());
  return short ? normalizeIdentity(short[1]!, short[2]!) : undefined;
}

export function assertRequestedRepositoryBinding(input: {
  repoRoot: string;
  owner?: string;
  repo?: string;
}): RepositoryBindingObservation {
  if (Boolean(input.owner) !== Boolean(input.repo)) {
    throw new RepositoryBindingError(
      "PLAN_REPOSITORY_ARGUMENTS_INVALID",
      "Repository owner and name must be supplied together"
    );
  }
  const observation = observeRepositoryBinding(input.repoRoot);
  if (
    input.owner &&
    input.repo &&
    !sameRepository(observation.identity, normalizeIdentity(input.owner, input.repo))
  ) {
    throw new RepositoryBindingError(
      "PLAN_REPOSITORY_MISMATCH",
      "The requested GitHub repository does not match the selected local worktree"
    );
  }
  return observation;
}

/** Reject a plan/worktree mismatch before any gate artifacts or commands are admitted. */
export function assertPlanRepositoryBinding(
  plan: Pick<Plan, "items" | "gitInputs">,
  repoRoot: string
): RepositoryBindingObservation | undefined {
  assertSingleRepositoryPlan(plan);
  if (!plan.gitInputs) return undefined;

  let repositoryRoot: string;
  try {
    repositoryRoot = realpathSync(resolveGateRepositoryRoot(repoRoot));
  } catch {
    throw new RepositoryBindingError(
      "PLAN_REPOSITORY_ROOT_INVALID",
      "The gate execution worktree is unavailable"
    );
  }
  const remoteUrl = readRemote(repositoryRoot, plan.gitInputs.checkoutRemote);
  if (!remoteUrl) {
    throw new RepositoryBindingError(
      "PLAN_REPOSITORY_REMOTE_UNAVAILABLE",
      "The plan checkout remote is unavailable in the gate execution worktree"
    );
  }
  const expected = parseRepositoryIdentity(plan.gitInputs.repository);
  const observedIdentity = parseObservedGitHubRemote(remoteUrl);
  const matches =
    expected && observedIdentity
      ? sameRepository(expected, observedIdentity)
      : sameRepositoryLocator(plan.gitInputs.repository, remoteUrl);
  if (!matches) {
    throw new RepositoryBindingError(
      "PLAN_REPOSITORY_MISMATCH",
      "The plan repository does not match the gate execution worktree"
    );
  }
  return observedIdentity
    ? {
        repositoryRoot,
        remote: `https://github.com/${observedIdentity.owner}/${observedIdentity.repo}.git`,
        identity: observedIdentity,
      }
    : undefined;
}

export function assertSingleRepositoryPlan(plan: Pick<Plan, "items">): void {
  if (plan.items.some(({ name }) => /^[^/]+\/[^#]+#PR-[1-9][0-9]*$/u.test(name))) {
    throw new RepositoryBindingError(
      "PLAN_MULTI_REPO_EXECUTION_UNSUPPORTED",
      "Multi-repository plans cannot be executed in a single repository worktree"
    );
  }
}

export function bindPlanGateWorkingDirectories(
  plan: Pick<Plan, "items" | "gitInputs">,
  requestedRoot: string,
  selection: { onlyItem?: string; onlyGate?: string } = {}
): { repositoryRoot: string; workingDirectories: Readonly<Record<string, string>> } {
  const requireGitRepository = plan.gitInputs !== undefined;
  const repositoryRoot = resolveExecutionRoot(requestedRoot, requireGitRepository);
  const workingDirectories: Record<string, string> = Object.create(null);
  for (const item of plan.items) {
    if (selection.onlyItem && item.name !== selection.onlyItem) continue;
    for (const gate of item.gates) {
      if (selection.onlyGate && gate.name !== selection.onlyGate) continue;
      if (gate.runtime && gate.runtime !== "local") continue;
      const { workingDirectory: directory } = bindLocalGateWorkingDirectory(gate, repositoryRoot, {
        requireGitRepository,
        enforceContainment: true,
        rootIsCanonical: true,
      });
      workingDirectories[JSON.stringify([item.name, gate.name])] = directory;
    }
  }
  return { repositoryRoot, workingDirectories: Object.freeze(workingDirectories) };
}

export function bindLocalGateWorkingDirectory(
  gate: Pick<Gate, "cwd">,
  requestedRoot: string,
  options: {
    requireGitRepository?: boolean;
    enforceContainment?: boolean;
    rootIsCanonical?: boolean;
  } = {}
): { repositoryRoot: string; workingDirectory: string } {
  let repositoryRoot: string;
  let workingDirectory: string;
  try {
    repositoryRoot = options.rootIsCanonical
      ? availableDirectory(requestedRoot)
      : resolveExecutionRoot(requestedRoot, options.requireGitRepository ?? false);
    const reference = gate.cwd ?? ".";
    if (reference.includes("\0") || Buffer.byteLength(reference, "utf8") > MAX_PATH_BYTES) {
      throw new Error("invalid gate cwd");
    }
    workingDirectory = realpathSync(resolve(repositoryRoot, reference));
    if (!statSync(workingDirectory).isDirectory()) throw new Error("gate cwd is not a directory");
  } catch {
    throw new RepositoryBindingError(
      "PLAN_REPOSITORY_ROOT_INVALID",
      "A selected local gate working directory is unavailable"
    );
  }
  const child = relative(repositoryRoot, workingDirectory);
  if (
    options.enforceContainment &&
    (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
  ) {
    throw new RepositoryBindingError(
      "PLAN_REPOSITORY_MISMATCH",
      "A selected local gate working directory belongs to another repository"
    );
  }
  if (options.requireGitRepository) {
    let gateRepository: string;
    try {
      gateRepository = realpathSync(resolveGateRepositoryRoot(workingDirectory));
    } catch {
      throw new RepositoryBindingError(
        "PLAN_REPOSITORY_MISMATCH",
        "A selected local gate working directory belongs to another repository"
      );
    }
    if (gateRepository !== repositoryRoot) {
      throw new RepositoryBindingError(
        "PLAN_REPOSITORY_MISMATCH",
        "A selected local gate working directory belongs to another repository"
      );
    }
  }
  return { repositoryRoot, workingDirectory };
}

/**
 * Git-bound plans use the physical worktree root. Configuration-only plans keep
 * the same anchoring when invoked inside Git, but retain the public raw-gate
 * contract for ordinary canonical filesystem directories.
 */
export function resolveExecutionRoot(requestedRoot: string, requireGitRepository: boolean): string {
  if (
    typeof requestedRoot !== "string" ||
    requestedRoot.trim().length === 0 ||
    requestedRoot.includes("\0") ||
    Buffer.byteLength(requestedRoot, "utf8") > MAX_PATH_BYTES
  ) {
    throw new RepositoryBindingError(
      "PLAN_REPOSITORY_ROOT_INVALID",
      "The gate execution worktree is unavailable"
    );
  }
  try {
    return realpathSync(resolveGateRepositoryRoot(requestedRoot));
  } catch {
    if (requireGitRepository) {
      throw new RepositoryBindingError(
        "PLAN_REPOSITORY_ROOT_INVALID",
        "The gate execution worktree is unavailable"
      );
    }
  }
  try {
    return availableDirectory(requestedRoot);
  } catch {
    throw new RepositoryBindingError(
      "PLAN_REPOSITORY_ROOT_INVALID",
      "The gate execution worktree is unavailable"
    );
  }
}

function availableDirectory(reference: string): string {
  const directory = realpathSync(resolve(reference));
  if (!statSync(directory).isDirectory()) throw new Error("not a directory");
  return directory;
}

function readRemote(repositoryRoot: string, name: string): string | undefined {
  if (!/^[A-Za-z0-9._-]{1,255}$/u.test(name)) return undefined;
  try {
    const value = runGit(repositoryRoot, ["remote", "get-url", name]).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function runGit(cwd: string, args: string[]): string {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase().startsWith("GIT_")) delete environment[key];
  }
  return execFileSync("git", ["--no-optional-locks", ...args], {
    cwd,
    env: environment,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function normalizeIdentity(owner: string, repo: string): RepositoryIdentity {
  return { owner: owner.trim(), repo: repo.trim().replace(/\.git$/iu, "") };
}

function parseObservedGitHubRemote(value: string): RepositoryIdentity | undefined {
  const remote = value.trim();
  const scp = /^git@github\.com:([^/]+)\/([^/]+)$/iu.exec(remote);
  if (scp) return validatedIdentity(scp[1]!, scp[2]!);

  try {
    const parsed = new URL(remote);
    if (parsed.hostname.toLowerCase() !== "github.com" || parsed.search || parsed.hash) {
      return undefined;
    }
    if (!["http:", "https:", "git:", "ssh:"].includes(parsed.protocol)) return undefined;
    if (
      parsed.password ||
      (parsed.protocol === "ssh:" ? parsed.username !== "git" : Boolean(parsed.username))
    ) {
      return undefined;
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    return segments.length === 2 ? validatedIdentity(segments[0]!, segments[1]!) : undefined;
  } catch {
    return undefined;
  }
}

function validatedIdentity(owner: string, repo: string): RepositoryIdentity | undefined {
  const normalized = normalizeIdentity(owner, repo);
  return /^[A-Za-z0-9_.-]{1,255}$/u.test(normalized.owner) &&
    /^[A-Za-z0-9_.-]{1,255}$/u.test(normalized.repo)
    ? normalized
    : undefined;
}

function sameRepository(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase()
  );
}

function sameRepositoryLocator(left: string, right: string): boolean {
  try {
    return repositoryIdentity(left) === repositoryIdentity(right);
  } catch {
    return false;
  }
}
