import { randomUUID } from "node:crypto";
import { sameWorkspaceBoundaryIdentity } from "./workspace-boundary-identity.js";
import path from "node:path";

import type { WorkspaceObservation } from "../store/workspace-lifecycle-store.js";
import { type CommandRequest, type CommandResult, type CommandRunner } from "./command-runner.js";
import type {
  BrokerCommandEvidence,
  BrokerFailure,
  BrokerFailureReason,
  BrokerOperation,
  BrokerOperationOptions,
  CreateWorktreeResult,
  GitWorktreeBroker,
  ObserveWorktreeResult,
  RemoveWorktreeResult,
  WorktreePreservationReason,
  WorktreeTarget,
} from "./git-worktree-broker.js";
import {
  parseGitStatusPorcelainV1Z,
  parseGitWorktreePorcelainZ,
  type GitWorktreePorcelainRecord,
} from "./git-worktree-porcelain.js";
import {
  DirectoryBoundaryError,
  captureDirectoryIdentity,
  identityOf,
  openChildDirectory,
  reopenDirectoryIdentity,
  type DirectoryIdentity,
} from "./linux-directory-identity.js";
import { resolveWorkspaceBoundary } from "./workspace-boundary-resolver.js";
import {
  createWorkspaceBoundaryDirectoryIdentity,
  type WorkspaceBoundaryDirectoryIdentity_v1,
  type WorkspaceBoundary,
  type WorkspaceBoundaryDirectoryCapability,
  type WorkspaceBoundaryLease,
  type WorkspaceBoundaryProcessArgument,
} from "./workspace-boundary.js";

const FULL_GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_DIRTY_PATHS = 200;
const EVIDENCE_TAIL_BYTES = 4_096;
const ATTEMPT_MARKER_FILE = "lexrunner-attempt.json";
const MAX_ATTEMPT_MARKER_BYTES = 64 * 1024;
const MAX_GITDIR_FILE_BYTES = 16 * 1024;

export interface NodeGitWorktreeBrokerOptions {
  repositoryId: string;
  repositoryRoot: string;
  worktreeRoot: string;
  hostId: string;
  gitRuntime: string;
  /** Native comparison behavior of the declared Git runtime. */
  pathComparison: "case-sensitive" | "case-insensitive";
  gitExecutable?: string;
  runner?: CommandRunner;
  defaultTimeoutMs?: number;
  maxDirtyPaths?: number;
  /** Enables synthetic lineage only for direct broker tests outside the coordinator. */
  testOnlyAllowUnboundBoundaryAuthority?: boolean;
}

interface GitExecutionSuccess {
  ok: true;
  exitCode: number;
  stdout: string;
  stderr: string;
  executable: string;
  args: string[];
  cwd: string;
}

interface AttemptMarker {
  schemaVersion: 1;
  repositoryId: string;
  attemptId: string;
  hostId: string;
  gitRuntime: string;
  projectRoot: string;
  worktreePath: string;
  branch: string;
  baseSha: string;
}

type GitExecutionResult = GitExecutionSuccess | BrokerFailure;

interface OperationBoundary {
  lease: WorkspaceBoundaryLease;
  repository: WorkspaceBoundaryDirectoryCapability;
  repositoryGit: WorkspaceBoundaryDirectoryCapability;
  targetParent: WorkspaceBoundaryDirectoryCapability;
  targetName: string;
  target: WorkspaceBoundaryDirectoryCapability | null;
  operationId: string;
  operationSequence: number;
}

const brokerBootstrapToken = Symbol("broker-bootstrap");
interface BrokerBootstrap {
  readonly token: typeof brokerBootstrapToken;
  readonly boundary: WorkspaceBoundary;
  readonly repository: WorkspaceBoundaryDirectoryIdentity_v1;
  readonly allocation: WorkspaceBoundaryDirectoryIdentity_v1;
  readonly git: WorkspaceBoundaryDirectoryIdentity_v1;
}
/**
 * Node implementation of the STFC worktree safety contract.
 * One instance is bound to one repository, host, and Git runtime. It never
 * rewrites paths between runtimes and never force-removes a worktree.
 */
export class NodeGitWorktreeBroker implements GitWorktreeBroker {
  private readonly repositoryId: string;
  private readonly repositoryRoot: string;
  private readonly worktreeRoot: string;
  private readonly hostId: string;
  private readonly gitRuntime: string;
  private readonly pathComparison: NodeGitWorktreeBrokerOptions["pathComparison"];
  private readonly gitExecutable: string;
  private readonly boundary: WorkspaceBoundary;
  private readonly defaultTimeoutMs: number;
  private readonly maxDirtyPaths: number;
  private readonly testOnlyAllowUnboundBoundaryAuthority: boolean;
  private readonly repositoryIdentity: WorkspaceBoundaryDirectoryIdentity_v1;
  private readonly repositoryGitIdentity: WorkspaceBoundaryDirectoryIdentity_v1;
  private readonly worktreeRootIdentity: WorkspaceBoundaryDirectoryIdentity_v1;

  constructor(options: NodeGitWorktreeBrokerOptions, bootstrap?: BrokerBootstrap) {
    validateBrokerOptions(options);
    if (bootstrap && bootstrap.token !== brokerBootstrapToken)
      throw new Error("Invalid broker bootstrap");
    const resolution = bootstrap
      ? { ok: true as const, boundary: bootstrap.boundary }
      : resolveWorkspaceBoundary(
          { mode: "native" },
          options.runner ? { runner: options.runner } : {}
        );
    if (!resolution.ok) {
      throw new DirectoryBoundaryError(
        "unsupported_platform",
        `Native workspace boundary is unavailable (${resolution.decision.reason_code})`
      );
    }
    if (resolution.boundary.capability.host.path_comparison !== options.pathComparison) {
      throw new DirectoryBoundaryError(
        "unsupported_platform",
        "Physical worktree containment currently requires a case-sensitive Linux Git runtime"
      );
    }
    this.boundary = resolution.boundary;
    if (bootstrap) {
      this.repositoryIdentity = bootstrap.repository;
      this.worktreeRootIdentity = bootstrap.allocation;
      this.repositoryGitIdentity = bootstrap.git;
    } else {
      const repositoryIdentity = captureDirectoryIdentity(options.repositoryRoot, "repositoryRoot");
      this.repositoryIdentity = portableLinuxIdentity(repositoryIdentity);
      this.worktreeRootIdentity = portableLinuxIdentity(
        captureDirectoryIdentity(options.worktreeRoot, "worktreeRoot")
      );
      const repository = reopenDirectoryIdentity(repositoryIdentity, "repositoryRoot");
      try {
        const repositoryGit = openChildDirectory(repository, ".git", "repository Git directory");
        try {
          this.repositoryGitIdentity = portableLinuxIdentity(identityOf(repositoryGit));
        } finally {
          repositoryGit.close();
        }
      } finally {
        repository.close();
      }
    }

    this.repositoryId = options.repositoryId;
    this.repositoryRoot = this.repositoryIdentity.canonical_path;
    this.worktreeRoot = this.worktreeRootIdentity.canonical_path;
    this.hostId = options.hostId;
    this.gitRuntime = options.gitRuntime;
    this.pathComparison = options.pathComparison;
    this.gitExecutable = options.gitExecutable ?? "git";
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxDirtyPaths = options.maxDirtyPaths ?? DEFAULT_MAX_DIRTY_PATHS;
    this.testOnlyAllowUnboundBoundaryAuthority =
      options.testOnlyAllowUnboundBoundaryAuthority ?? false;
  }

  /** Capture native identity observations before opening the lifecycle store. */
  static async open(input: NodeGitWorktreeBrokerOptions): Promise<NodeGitWorktreeBroker> {
    const options = { ...input };
    validateBrokerOptions(options);
    const resolution = resolveWorkspaceBoundary(
      { mode: "native" },
      options.runner ? { runner: options.runner } : {}
    );
    if (!resolution.ok)
      throw new DirectoryBoundaryError(
        "unsupported_platform",
        `Native workspace boundary is unavailable (${resolution.decision.reason_code})`
      );
    const boundary = resolution.boundary;
    if (boundary.capability.host.path_comparison !== options.pathComparison)
      throw new DirectoryBoundaryError(
        "unsupported_platform",
        "Boundary path comparison does not match the declared Git runtime"
      );
    const bootstrapId = `broker-bootstrap:${randomUUID()}`;
    // Discovery lease lineage identifies this read-only capture, never a worker execution grant.
    const acquired = await boundary.acquire({
      operationId: bootstrapId,
      orchestrationLeaseId: bootstrapId,
      orchestrationLeaseRevision: 0,
      ownerId: options.hostId,
      roots: [
        { role: "repository", absolutePath: options.repositoryRoot },
        { role: "allocation", absolutePath: options.worktreeRoot },
      ],
    });
    if (!acquired.ok) throw new Error(`Broker bootstrap failed: ${acquired.error.code}`);
    const lease = acquired.lease;
    let bootstrap: BrokerBootstrap;
    try {
      const repository = lease.root("repository");
      const allocation = lease.root("allocation");
      const git = await lease.openChild(repository, ".git", `${bootstrapId}:git`);
      if (!git.ok) throw new Error(`Broker Git bootstrap failed: ${git.error.code}`);
      const current = await lease.assertCurrent(
        [repository, allocation, git.value],
        `${bootstrapId}:assert`
      );
      if (!current.ok) throw new Error(`Broker bootstrap assertion failed: ${current.error.code}`);
      bootstrap = {
        token: brokerBootstrapToken,
        boundary,
        repository: structuredClone(repository.identity),
        allocation: structuredClone(allocation.identity),
        git: structuredClone(git.value.identity),
      };
    } finally {
      const closed = await lease.close("completed");
      if (closed.phase !== "released") throw new Error("Broker bootstrap release unconfirmed");
    }
    return new NodeGitWorktreeBroker(options, bootstrap);
  }
  async create(
    target: WorktreeTarget,
    options: BrokerOperationOptions = {}
  ): Promise<CreateWorktreeResult> {
    const runtimeFailure = this.runtimeFailure(target, "create");
    if (runtimeFailure) return runtimeFailure;
    if (!FULL_GIT_OBJECT_ID.test(target.baseSha)) {
      return this.failure(
        "create",
        "invalid_base_sha",
        "baseSha must be a lowercase full SHA-1 or SHA-256 object ID"
      );
    }

    const boundary = await this.openOperationBoundary(target, "create", options);
    if ("ok" in boundary) return boundary;
    try {
      const branchValidation = await this.gitMain(
        boundary,
        "create",
        ["check-ref-format", "--branch", target.branch],
        options
      );
      if (!branchValidation.ok) {
        if (
          branchValidation.reason === "command_failed" &&
          branchValidation.command?.exitCode !== null
        ) {
          return { ...branchValidation, reason: "invalid_branch" };
        }
        return branchValidation;
      }

      const commit = await this.gitMain(
        boundary,
        "create",
        ["rev-parse", "--verify", `${target.baseSha}^{commit}`],
        options
      );
      if (!commit.ok) {
        if (commit.reason === "command_failed" && commit.command?.exitCode !== null) {
          return { ...commit, reason: "invalid_base_sha" };
        }
        return commit;
      }
      if (commit.stdout.trim() !== target.baseSha) {
        return this.failure(
          "create",
          "invalid_base_sha",
          "baseSha did not resolve to the exact supplied commit",
          commit
        );
      }

      const before = await this.observeAnchored(target, boundary, options);
      if (!before.ok) return { ...before, operation: "create" };
      const observation = before.observation;
      if (observation.registered) {
        if (
          observation.exists &&
          observation.repositoryId === target.repositoryId &&
          observation.branch === target.branch &&
          observation.headSha === target.baseSha &&
          observation.attemptId === target.attemptId
        ) {
          if (observation.cleanliness === "dirty") {
            return this.failure(
              "create",
              "dirty_workspace",
              "An existing matching worktree is dirty and requires explicit reconciliation",
              undefined,
              observation
            );
          }
          return { ok: true, outcome: "reused", observation };
        }
        return this.failure(
          "create",
          "identity_mismatch",
          "A registered worktree at the target path does not match the requested identity",
          undefined,
          observation
        );
      }
      if (observation.exists) {
        return this.failure(
          "create",
          "path_conflict",
          "The target path already exists but is not the requested registered worktree",
          undefined,
          observation
        );
      }

      const branch = await this.gitMain(
        boundary,
        "create",
        ["show-ref", "--verify", "--quiet", `refs/heads/${target.branch}`],
        options,
        [1]
      );
      if (!branch.ok) return branch;
      if (branch.exitCode === 0) {
        return this.failure(
          "create",
          "branch_conflict",
          `Local branch '${target.branch}' already exists`,
          branch
        );
      }

      try {
        const targetDirectory = await boundary.lease.createChild(
          boundary.targetParent,
          boundary.targetName,
          nextBoundaryOperationId(boundary, "create-target")
        );
        if (!targetDirectory.ok) return this.containmentFailure("create", targetDirectory.error);
        boundary.target = targetDirectory.value;
      } catch (error) {
        return this.containmentFailure("create", error);
      }
      const targetDirectory = boundary.target;
      if (!targetDirectory) {
        return this.failure(
          "create",
          "containment_violation",
          "The reserved worktree target directory identity is unavailable"
        );
      }

      const created = await this.gitMain(
        boundary,
        "create",
        [
          { kind: "literal", value: "worktree" },
          { kind: "literal", value: "add" },
          { kind: "literal", value: "-b" },
          { kind: "literal", value: target.branch },
          { kind: "directory", directory: targetDirectory },
          { kind: "literal", value: target.baseSha },
        ],
        options
      );
      if (!created.ok) {
        // A command can be interrupted after Git commits the registry mutation.
        // Without a successfully written Attempt marker ownership is ambiguous,
        // so fail closed while attaching the observed postcondition for reconciliation.
        const recovered = await this.observeAnchored(target, boundary, options);
        return recovered.ok ? { ...created, observation: recovered.observation } : created;
      }

      const markerFailure = await this.writeAttemptMarker(target, boundary);
      if (markerFailure) return markerFailure;

      const after = await this.observeAnchored(target, boundary, options);
      if (!after.ok) return { ...after, operation: "create" };
      if (!this.isExactCreatedObservation(target, after.observation)) {
        return this.failure(
          "create",
          "identity_mismatch",
          "Git reported success but the registered worktree postcondition did not match",
          created,
          after.observation
        );
      }
      return { ok: true, outcome: "created", observation: after.observation };
    } finally {
      await closeOperationBoundary(boundary);
    }
  }

  async observe(
    target: WorktreeTarget,
    options: BrokerOperationOptions = {}
  ): Promise<ObserveWorktreeResult> {
    const runtimeFailure = this.runtimeFailure(target, "observe");
    if (runtimeFailure) return runtimeFailure;

    const boundary = await this.openOperationBoundary(target, "observe", options);
    if ("ok" in boundary) return boundary;
    try {
      return await this.observeAnchored(target, boundary, options);
    } finally {
      await closeOperationBoundary(boundary);
    }
  }

  private async observeAnchored(
    target: WorktreeTarget,
    boundary: OperationBoundary,
    options: BrokerOperationOptions
  ): Promise<ObserveWorktreeResult> {
    const listed = await this.gitMain(
      boundary,
      "observe",
      ["worktree", "list", "--porcelain", "-z"],
      options
    );
    if (!listed.ok) return listed;

    let records: GitWorktreePorcelainRecord[];
    try {
      records = parseGitWorktreePorcelainZ(listed.stdout);
    } catch (error) {
      return this.failure(
        "observe",
        "identity_mismatch",
        error instanceof Error ? error.message : String(error),
        listed
      );
    }

    const pathMatches = records.filter((record) =>
      this.sameNativePath(record.worktree, target.worktreePath)
    );
    const exists = boundary.target !== null;
    if (pathMatches.length !== 1) {
      return {
        ok: true,
        outcome: "observed",
        observation: this.unverifiedObservation(
          target,
          exists,
          pathMatches.length > 1
            ? "multiple registered worktrees matched the runtime-native path"
            : exists
              ? "path exists but is not registered in the declared repository"
              : "worktree path is missing"
        ),
      };
    }

    const record = pathMatches[0];
    const observedBranch = branchName(record.branch);
    let cleanliness: WorkspaceObservation["cleanliness"] = "clean";
    let dirtyPaths: string[] | undefined;
    let reason: string | undefined;
    let markerVerified = false;
    let markerReason = "worktree attempt marker is unavailable";
    if (exists) {
      const worktreeGit = await this.openWorktreeGitDirectory(boundary, "observe");
      if ("ok" in worktreeGit) return worktreeGit;
      try {
        const status = await this.gitWorktree(
          boundary,
          worktreeGit,
          "observe",
          ["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all"],
          options
        );
        if (!status.ok) return status;
        try {
          const entries = parseGitStatusPorcelainV1Z(status.stdout);
          const allPaths = entries.flatMap((entry) =>
            entry.originalPath ? [entry.path, entry.originalPath] : [entry.path]
          );
          const uniquePaths = [...new Set(allPaths)];
          cleanliness = uniquePaths.length === 0 ? "clean" : "dirty";
          if (uniquePaths.length > 0) dirtyPaths = uniquePaths.slice(0, this.maxDirtyPaths);
          if (uniquePaths.length > this.maxDirtyPaths) {
            reason = `dirty path evidence truncated to ${this.maxDirtyPaths} entries`;
          }
        } catch (error) {
          return this.failure(
            "observe",
            "identity_mismatch",
            error instanceof Error ? error.message : String(error),
            status
          );
        }

        const marker = await this.readAttemptMarker(target, worktreeGit, boundary);
        markerVerified = marker.matches;
        markerReason = marker.reason ?? markerReason;
      } finally {
        // The lease owns the capability and closes it with the operation boundary.
      }
    }

    const identityVerified =
      exists &&
      !record.bare &&
      !record.detached &&
      !record.locked &&
      !record.prunable &&
      observedBranch === target.branch &&
      markerVerified;
    const ambiguousReason =
      reason ??
      (record.bare
        ? "registered entry is bare"
        : record.detached
          ? "registered worktree is detached"
          : record.locked
            ? (record.lockedReason ?? "registered worktree is locked")
            : record.prunable
              ? (record.prunableReason ?? "registered worktree is prunable")
              : observedBranch !== target.branch
                ? "registered worktree branch does not match"
                : !markerVerified
                  ? markerReason
                  : undefined);

    return {
      ok: true,
      outcome: "observed",
      observation: {
        exists,
        registered: true,
        repositoryId: this.repositoryId,
        hostId: this.hostId,
        gitRuntime: this.gitRuntime,
        projectRoot: target.projectRoot,
        branch: observedBranch,
        worktreePath: target.worktreePath,
        attemptId: identityVerified ? target.attemptId : null,
        headSha: record.head ?? null,
        cleanliness,
        ...(dirtyPaths ? { dirtyPaths } : {}),
        ...(ambiguousReason ? { reason: ambiguousReason } : {}),
      },
    };
  }

  async remove(
    target: WorktreeTarget,
    options: BrokerOperationOptions = {}
  ): Promise<RemoveWorktreeResult> {
    const runtimeFailure = this.runtimeFailure(target, "remove");
    if (runtimeFailure) return runtimeFailure;

    const boundary = await this.openOperationBoundary(target, "remove", options);
    if ("ok" in boundary) return boundary;
    try {
      const observed = await this.observeAnchored(target, boundary, options);
      if (!observed.ok) return { ...observed, operation: "remove" };
      const observation = observed.observation;

      const preservationReason = this.preservationReason(target, observation);
      if (preservationReason) {
        return { ok: true, outcome: "preserved", preservationReason, observation };
      }

      const targetDirectory = boundary.target;
      if (!targetDirectory) {
        return { ok: true, outcome: "preserved", preservationReason: "missing", observation };
      }
      const removed = await this.gitMain(
        boundary,
        "remove",
        [
          { kind: "literal", value: "worktree" },
          { kind: "literal", value: "remove" },
          { kind: "directory", directory: targetDirectory },
        ],
        options
      );
      if (!removed.ok) return removed;

      boundary.target = null;
      const reopened = await boundary.lease.tryOpenChild(
        boundary.targetParent,
        boundary.targetName,
        nextBoundaryOperationId(boundary, "reopen-removed-target")
      );
      if (!reopened.ok) return this.containmentFailure("remove", reopened.error);
      boundary.target = reopened.value;

      const after = await this.observeAnchored(target, boundary, options);
      if (!after.ok) return { ...after, operation: "remove" };
      if (after.observation.registered || after.observation.exists) {
        return this.failure(
          "remove",
          "identity_mismatch",
          "Git reported removal but the worktree path or registration remains",
          removed,
          after.observation
        );
      }
      return { ok: true, outcome: "removed", observation: after.observation };
    } finally {
      await closeOperationBoundary(boundary);
    }
  }

  private runtimeFailure(target: WorktreeTarget, operation: BrokerOperation): BrokerFailure | null {
    if (
      target.repositoryId !== this.repositoryId ||
      target.hostId !== this.hostId ||
      target.gitRuntime !== this.gitRuntime
    ) {
      return this.failure(
        operation,
        "runtime_mismatch",
        "Target repository, host, and Git runtime must match the broker binding"
      );
    }
    if (
      !path.isAbsolute(target.projectRoot) ||
      !path.isAbsolute(target.worktreePath) ||
      target.projectRoot.includes("\0") ||
      target.worktreePath.includes("\0")
    ) {
      return this.failure(
        operation,
        "invalid_path",
        "projectRoot and worktreePath must be runtime-native absolute paths"
      );
    }
    if (!this.sameNativePath(target.projectRoot, this.repositoryRoot)) {
      return this.failure(
        operation,
        "runtime_mismatch",
        "Target project root must match the broker repository root"
      );
    }
    if (!this.isStrictlyUnderRoot(target.worktreePath, this.worktreeRoot)) {
      return this.failure(
        operation,
        "invalid_path",
        "worktreePath must be a strict descendant of the broker worktreeRoot"
      );
    }
    return null;
  }

  private async openOperationBoundary(
    target: WorktreeTarget,
    operation: BrokerOperation,
    options: BrokerOperationOptions
  ): Promise<OperationBoundary | BrokerFailure> {
    const authority = this.boundaryAuthority(target, operation, options);
    if (!authority) {
      return this.failure(
        operation,
        "containment_violation",
        "Workspace boundary authority lineage is required"
      );
    }
    const acquired = await this.boundary.acquire({
      operationId: authority.operationId,
      orchestrationLeaseId: authority.orchestrationLeaseId,
      orchestrationLeaseRevision: authority.orchestrationLeaseRevision,
      ownerId: authority.ownerId,
      roots: [
        { role: "repository", absolutePath: this.repositoryRoot },
        { role: "allocation", absolutePath: this.worktreeRoot },
      ],
    });
    if (!acquired.ok) return this.containmentFailure(operation, acquired.error);

    const lease = acquired.lease;
    const boundary: OperationBoundary = {
      lease,
      repository: lease.root("repository"),
      repositoryGit: lease.root("repository"),
      targetParent: lease.root("allocation"),
      targetName: "",
      target: null,
      operationId: authority.operationId,
      operationSequence: 0,
    };
    try {
      if (!sameBoundaryIdentity(boundary.repository, this.repositoryIdentity)) {
        throw new DirectoryBoundaryError(
          "identity_changed",
          "The repository root was replaced after broker initialization"
        );
      }
      const repositoryGit = await lease.openChild(
        boundary.repository,
        ".git",
        nextBoundaryOperationId(boundary, "open-repository-git")
      );
      if (!repositoryGit.ok) throw new Error(repositoryGit.error.message);
      boundary.repositoryGit = repositoryGit.value;
      if (!sameBoundaryIdentity(boundary.repositoryGit, this.repositoryGitIdentity)) {
        throw new DirectoryBoundaryError(
          "identity_changed",
          "The repository Git directory was replaced after broker initialization"
        );
      }

      if (!sameBoundaryIdentity(boundary.targetParent, this.worktreeRootIdentity)) {
        throw new DirectoryBoundaryError(
          "identity_changed",
          "The worktree root was replaced after broker initialization"
        );
      }
      const relative = path.relative(this.worktreeRoot, path.resolve(target.worktreePath));
      const components = relative.split(path.sep);
      const targetName = components.pop();
      if (!targetName) {
        throw new DirectoryBoundaryError("invalid_path", "The worktree target has no basename");
      }

      boundary.targetName = targetName;
      for (const component of components) {
        const child = await lease.openChild(
          boundary.targetParent,
          component,
          nextBoundaryOperationId(boundary, "open-target-ancestor")
        );
        if (!child.ok) throw new Error(child.error.message);
        boundary.targetParent = child.value;
      }
      const targetDirectory = await lease.tryOpenChild(
        boundary.targetParent,
        targetName,
        nextBoundaryOperationId(boundary, "open-target")
      );
      if (!targetDirectory.ok) throw new Error(targetDirectory.error.message);
      boundary.target = targetDirectory.value;
      return boundary;
    } catch (error) {
      await lease.close("cancelled");
      return this.containmentFailure(operation, error);
    }
  }

  private boundaryAuthority(
    target: WorktreeTarget,
    operation: BrokerOperation,
    options: BrokerOperationOptions
  ) {
    if (options.boundaryAuthority) return options.boundaryAuthority;
    if (!this.testOnlyAllowUnboundBoundaryAuthority) return null;
    return {
      operationId: `test-${target.attemptId}-${operation}`,
      orchestrationLeaseId: `test-${target.attemptId}`,
      orchestrationLeaseRevision: 0,
      ownerId: `test-${target.hostId}`,
    };
  }

  private containmentFailure(operation: BrokerOperation, error: unknown): BrokerFailure {
    const message =
      error instanceof DirectoryBoundaryError
        ? error.message
        : `Directory identity containment failed: ${errorMessage(error)}`;
    return this.failure(operation, "containment_violation", message);
  }

  private gitMain(
    boundary: OperationBoundary,
    operation: BrokerOperation,
    args: readonly (string | WorkspaceBoundaryProcessArgument)[],
    options: BrokerOperationOptions,
    allowedNonzeroExitCodes: readonly number[] = []
  ): Promise<GitExecutionResult> {
    // Git persists its resolved Git directory in linked-worktree metadata. Bind
    // that directory as cwd so `.` is replacement-resistant without persisting
    // an ephemeral procfs capability path.
    const boundaryArgs: WorkspaceBoundaryProcessArgument[] = [
      {
        kind: "directory",
        directory: boundary.repositoryGit,
        prefix: "--git-dir=",
        relativeToCwd: true,
      },
      { kind: "directory", directory: boundary.repository, prefix: "--work-tree=" },
      ...args.map(boundaryArgument),
    ];
    const evidenceArgs = [
      `--git-dir=${this.repositoryGitIdentity.canonical_path}`,
      `--work-tree=${this.repositoryRoot}`,
      ...args.map(evidenceArgument),
    ];
    return this.git(
      boundary,
      operation,
      boundaryArgs,
      boundary.repositoryGit,
      options,
      allowedNonzeroExitCodes,
      { args: evidenceArgs, cwd: this.repositoryRoot }
    );
  }

  private gitWorktree(
    boundary: OperationBoundary,
    worktreeGit: WorkspaceBoundaryDirectoryCapability,
    operation: BrokerOperation,
    args: readonly string[],
    options: BrokerOperationOptions
  ): Promise<GitExecutionResult> {
    if (!boundary.target) {
      return Promise.resolve(
        this.failure(
          operation,
          "containment_violation",
          "The worktree target directory identity is unavailable"
        )
      );
    }
    const boundaryArgs: WorkspaceBoundaryProcessArgument[] = [
      { kind: "directory", directory: worktreeGit, prefix: "--git-dir=" },
      { kind: "directory", directory: boundary.target, prefix: "--work-tree=" },
      ...args.map(boundaryArgument),
    ];
    const evidenceArgs = [
      `--git-dir=${path.join(
        this.repositoryGitIdentity.canonical_path,
        "worktrees",
        path.basename(boundary.target.identity.canonical_path)
      )}`,
      `--work-tree=${boundary.target.identity.canonical_path}`,
      ...args,
    ];
    return this.git(boundary, operation, boundaryArgs, boundary.target, options, [], {
      args: evidenceArgs,
      cwd: boundary.target.identity.canonical_path,
    });
  }

  private async writeAttemptMarker(
    target: WorktreeTarget,
    boundary: OperationBoundary
  ): Promise<BrokerFailure | null> {
    const gitDirectory = await this.openWorktreeGitDirectory(boundary, "create");
    if ("ok" in gitDirectory) return gitDirectory;
    const marker: AttemptMarker = {
      schemaVersion: 1,
      repositoryId: this.repositoryId,
      attemptId: target.attemptId,
      hostId: this.hostId,
      gitRuntime: this.gitRuntime,
      projectRoot: target.projectRoot,
      worktreePath: target.worktreePath,
      branch: target.branch,
      baseSha: target.baseSha,
    };
    try {
      const written = await boundary.lease.writeFile({
        operationId: nextBoundaryOperationId(boundary, "write-attempt-marker"),
        directory: gitDirectory,
        component: ATTEMPT_MARKER_FILE,
        content: Buffer.from(`${JSON.stringify(marker)}\n`, "utf8"),
        // Identity metadata uses the backend's creation permissions, not a secrecy policy.
        exclusive: true,
      });
      if (!written.ok) throw new Error(written.error.message);
      return null;
    } catch (error) {
      return this.failure(
        "create",
        "containment_violation",
        `Worktree was created but its Attempt marker could not be written: ${errorMessage(error)}`
      );
    }
  }

  private async readAttemptMarker(
    target: WorktreeTarget,
    gitDirectory: WorkspaceBoundaryDirectoryCapability,
    boundary: OperationBoundary
  ): Promise<{ matches: boolean; reason?: string }> {
    let marker: AttemptMarker;
    try {
      const read = await boundary.lease.readFile({
        operationId: nextBoundaryOperationId(boundary, "read-attempt-marker"),
        directory: gitDirectory,
        component: ATTEMPT_MARKER_FILE,
        maxBytes: MAX_ATTEMPT_MARKER_BYTES,
      });
      if (!read.ok) {
        if (read.error.code === "invalid_path") {
          return { matches: false, reason: "worktree Attempt marker is missing" };
        }
        return {
          matches: false,
          reason: `worktree Attempt marker is unreadable: ${read.error.message}`,
        };
      }
      const parsed: unknown = JSON.parse(Buffer.from(read.value).toString("utf8"));
      if (!isAttemptMarker(parsed)) {
        return { matches: false, reason: "worktree Attempt marker is malformed" };
      }
      marker = parsed;
    } catch (error) {
      return {
        matches: false,
        reason: `worktree Attempt marker is unreadable: ${errorMessage(error)}`,
      };
    }

    const matches =
      marker.schemaVersion === 1 &&
      marker.repositoryId === this.repositoryId &&
      marker.attemptId === target.attemptId &&
      marker.hostId === this.hostId &&
      marker.gitRuntime === this.gitRuntime &&
      this.sameNativePath(marker.projectRoot, target.projectRoot) &&
      this.sameNativePath(marker.worktreePath, target.worktreePath) &&
      marker.branch === target.branch &&
      marker.baseSha === target.baseSha;
    return {
      matches,
      ...(matches ? {} : { reason: "worktree Attempt marker does not match the target identity" }),
    };
  }

  private async openWorktreeGitDirectory(
    boundary: OperationBoundary,
    operation: BrokerOperation
  ): Promise<WorkspaceBoundaryDirectoryCapability | BrokerFailure> {
    if (!boundary.target) {
      return this.failure(
        operation,
        "containment_violation",
        "The worktree target directory identity is unavailable"
      );
    }

    let gitFile: string;
    try {
      const read = await boundary.lease.readFile({
        operationId: nextBoundaryOperationId(boundary, "read-worktree-git-file"),
        directory: boundary.target,
        component: ".git",
        maxBytes: MAX_GITDIR_FILE_BYTES,
      });
      if (!read.ok) throw new Error(read.error.message);
      gitFile = Buffer.from(read.value).toString("utf8");
    } catch (error) {
      return this.containmentFailure(operation, error);
    }
    const line = gitFile.endsWith("\n") ? gitFile.slice(0, -1) : gitFile;
    if (!line.startsWith("gitdir: ") || line.includes("\n") || line.includes("\r")) {
      return this.failure(
        operation,
        "containment_violation",
        "The worktree .git file is malformed or ambiguous"
      );
    }
    const gitDirectoryPath = line.slice("gitdir: ".length);
    if (!path.isAbsolute(gitDirectoryPath) || gitDirectoryPath.includes("\0")) {
      return this.failure(
        operation,
        "containment_violation",
        "The worktree Git directory must be an absolute path inside the anchored repository"
      );
    }
    const normalized = path.resolve(gitDirectoryPath);
    const relative = path.relative(this.repositoryGitIdentity.canonical_path, normalized);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`)) {
      return this.failure(
        operation,
        "containment_violation",
        "The worktree Git directory is outside the anchored repository Git directory"
      );
    }

    let current: WorkspaceBoundaryDirectoryCapability | null = null;
    try {
      for (const component of relative.split(path.sep)) {
        const child = await boundary.lease.openChild(
          current ?? boundary.repositoryGit,
          component,
          nextBoundaryOperationId(boundary, "open-worktree-git-directory")
        );
        if (!child.ok) throw new Error(child.error.message);
        current = child.value;
      }
      if (!current) throw new DirectoryBoundaryError("invalid_path", "Missing worktree Git path");
      return current;
    } catch (error) {
      return this.containmentFailure(operation, error);
    }
  }

  private preservationReason(
    target: WorktreeTarget,
    observation: WorkspaceObservation
  ): WorktreePreservationReason | null {
    if (!observation.exists) return "missing";
    if (!observation.registered) return "unregistered";
    if (observation.repositoryId !== target.repositoryId) return "wrong_repository";
    if (observation.branch !== target.branch) return "wrong_branch";
    if (observation.reason) return "identity_ambiguous";
    if (observation.attemptId !== target.attemptId) return "identity_ambiguous";
    if (observation.cleanliness === "dirty") return "dirty";
    return null;
  }

  private isExactCreatedObservation(
    target: WorktreeTarget,
    observation: WorkspaceObservation
  ): boolean {
    return (
      observation.exists &&
      observation.registered &&
      observation.repositoryId === target.repositoryId &&
      observation.branch === target.branch &&
      observation.attemptId === target.attemptId &&
      observation.headSha === target.baseSha &&
      observation.cleanliness === "clean" &&
      !observation.reason
    );
  }

  private unverifiedObservation(
    target: WorktreeTarget,
    exists: boolean,
    reason: string
  ): WorkspaceObservation {
    return {
      exists,
      registered: false,
      repositoryId: null,
      hostId: this.hostId,
      gitRuntime: this.gitRuntime,
      projectRoot: null,
      branch: null,
      worktreePath: target.worktreePath,
      attemptId: null,
      headSha: null,
      cleanliness: "clean",
      reason,
    };
  }

  private sameNativePath(left: string, right: string): boolean {
    const normalizedLeft = path.resolve(left);
    const normalizedRight = path.resolve(right);
    return this.pathComparison === "case-insensitive"
      ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
      : normalizedLeft === normalizedRight;
  }

  private isStrictlyUnderRoot(candidate: string, root: string): boolean {
    const normalizedCandidate = path.resolve(candidate);
    const normalizedRoot = path.resolve(root);
    const comparedCandidate =
      this.pathComparison === "case-insensitive"
        ? normalizedCandidate.toLocaleLowerCase("en-US")
        : normalizedCandidate;
    const comparedRoot =
      this.pathComparison === "case-insensitive"
        ? normalizedRoot.toLocaleLowerCase("en-US")
        : normalizedRoot;
    const relative = path.relative(comparedRoot, comparedCandidate);
    return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`);
  }

  private async git(
    boundary: OperationBoundary,
    operation: BrokerOperation,
    args: readonly WorkspaceBoundaryProcessArgument[],
    cwd: WorkspaceBoundaryDirectoryCapability,
    options: BrokerOperationOptions,
    allowedNonzeroExitCodes: readonly number[] = [],
    evidence?: { args: readonly string[]; cwd: string }
  ): Promise<GitExecutionResult> {
    const result = await boundary.lease.runProcess({
      operationId: nextBoundaryOperationId(boundary, "run-git"),
      executable: this.gitExecutable,
      args,
      cwd,
      timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!result.ok) return this.containmentFailure(operation, result.error);
    const commandResult = result.value;
    const commandEvidence: CommandRequest = {
      executable: this.gitExecutable,
      args: evidence?.args ?? args.map(evidenceArgument),
      cwd: evidence?.cwd ?? cwd.identity.canonical_path,
      timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    };
    if (
      commandResult.ok ||
      (commandResult.kind === "nonzero_exit" &&
        commandResult.exitCode !== null &&
        allowedNonzeroExitCodes.includes(commandResult.exitCode))
    ) {
      return {
        ok: true,
        exitCode: commandResult.exitCode ?? 0,
        stdout: commandResult.stdout,
        stderr: commandResult.stderr,
        executable: commandEvidence.executable,
        args: [...commandEvidence.args],
        cwd: commandEvidence.cwd,
      };
    }
    return this.commandFailure(operation, commandEvidence, commandResult);
  }

  private commandFailure(
    operation: BrokerOperation,
    request: CommandRequest,
    result: Exclude<CommandResult, { ok: true }>
  ): BrokerFailure {
    if (result.kind === "preflight_error") {
      return this.failure(operation, "containment_violation", result.message);
    }
    const reason: BrokerFailureReason =
      result.kind === "timeout"
        ? "timeout"
        : result.kind === "aborted"
          ? "aborted"
          : "command_failed";
    return this.failure(operation, reason, result.message, {
      ok: true,
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout,
      stderr: result.stderr,
      executable: request.executable,
      args: [...request.args],
      cwd: request.cwd,
      actualExitCode: result.exitCode,
    });
  }

  private failure(
    operation: BrokerOperation,
    reason: BrokerFailureReason,
    message: string,
    command?: GitExecutionSuccess & { actualExitCode?: number | null },
    observation?: WorkspaceObservation
  ): BrokerFailure {
    let evidence: BrokerCommandEvidence | undefined;
    if (command) {
      evidence = {
        executable: command.executable,
        args: command.args,
        cwd: command.cwd,
        exitCode: "actualExitCode" in command ? (command.actualExitCode ?? null) : command.exitCode,
        stdoutTail: tail(command.stdout, EVIDENCE_TAIL_BYTES),
        stderrTail: tail(command.stderr, EVIDENCE_TAIL_BYTES),
      };
    }
    return {
      ok: false,
      operation,
      reason,
      message,
      ...(evidence ? { command: evidence } : {}),
      ...(observation ? { observation } : {}),
    };
  }
}

async function closeOperationBoundary(boundary: OperationBoundary): Promise<void> {
  await boundary.lease.close("completed");
}

function nextBoundaryOperationId(boundary: OperationBoundary, label: string): string {
  boundary.operationSequence += 1;
  const suffix = `:${boundary.operationSequence}:${label}`;
  return `${boundary.operationId.slice(0, 4_096 - suffix.length)}${suffix}`;
}

function boundaryArgument(
  argument: string | WorkspaceBoundaryProcessArgument
): WorkspaceBoundaryProcessArgument {
  return typeof argument === "string" ? { kind: "literal", value: argument } : argument;
}

function evidenceArgument(argument: string | WorkspaceBoundaryProcessArgument): string {
  if (typeof argument === "string") return argument;
  if (argument.kind === "literal") return argument.value;
  const rendered = path.join(
    argument.directory.identity.canonical_path,
    ...(argument.components ?? [])
  );
  return `${argument.prefix ?? ""}${rendered}${argument.suffix ?? ""}`;
}

function portableLinuxIdentity(identity: DirectoryIdentity): WorkspaceBoundaryDirectoryIdentity_v1 {
  return createWorkspaceBoundaryDirectoryIdentity({
    schema_version: "1.0.0",
    backend_kind: "linux-native",
    identity_kind: "linux-device-inode",
    canonical_path: identity.path,
    path_comparison: "case-sensitive",
    device: identity.device.toString(10),
    inode: identity.inode.toString(10),
  });
}

function sameBoundaryIdentity(
  capability: WorkspaceBoundaryDirectoryCapability,
  identity: WorkspaceBoundaryDirectoryIdentity_v1
): boolean {
  return sameWorkspaceBoundaryIdentity(capability.identity, identity);
}
function nativePathsOverlap(
  left: string,
  right: string,
  comparison: NodeGitWorktreeBrokerOptions["pathComparison"]
): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return comparison === "case-insensitive" ? resolved.toLocaleLowerCase("en-US") : resolved;
  };
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  if (normalizedLeft === normalizedRight) return true;
  const relativeLeft = path.relative(normalizedLeft, normalizedRight);
  const relativeRight = path.relative(normalizedRight, normalizedLeft);
  const isDescendant = (relative: string): boolean =>
    relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`);
  return isDescendant(relativeLeft) || isDescendant(relativeRight);
}

function branchName(ref: string | undefined): string | null {
  if (!ref) return null;
  const prefix = "refs/heads/";
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

function isAttemptMarker(value: unknown): value is AttemptMarker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  return (
    marker.schemaVersion === 1 &&
    typeof marker.repositoryId === "string" &&
    typeof marker.attemptId === "string" &&
    typeof marker.hostId === "string" &&
    typeof marker.gitRuntime === "string" &&
    typeof marker.projectRoot === "string" &&
    typeof marker.worktreePath === "string" &&
    typeof marker.branch === "string" &&
    typeof marker.baseSha === "string"
  );
}

function tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  return bytes.subarray(bytes.byteLength - maxBytes).toString("utf8");
}

function validateBrokerOptions(options: NodeGitWorktreeBrokerOptions): void {
  if (
    !options.repositoryId ||
    !options.repositoryRoot ||
    !options.worktreeRoot ||
    !options.hostId ||
    !options.gitRuntime
  ) {
    throw new Error(
      "repositoryId, repositoryRoot, worktreeRoot, hostId, and gitRuntime are required"
    );
  }
  if (
    !path.isAbsolute(options.repositoryRoot) ||
    !path.isAbsolute(options.worktreeRoot) ||
    options.repositoryRoot.includes("\0") ||
    options.worktreeRoot.includes("\0")
  ) {
    throw new Error("repositoryRoot and worktreeRoot must be runtime-native absolute paths");
  }
  if (!Number.isSafeInteger(options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS)) {
    throw new Error("defaultTimeoutMs must be a positive safe integer");
  }
  if ((options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS) <= 0) {
    throw new Error("defaultTimeoutMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(options.maxDirtyPaths ?? DEFAULT_MAX_DIRTY_PATHS)) {
    throw new Error("maxDirtyPaths must be a positive safe integer");
  }
  if ((options.maxDirtyPaths ?? DEFAULT_MAX_DIRTY_PATHS) <= 0) {
    throw new Error("maxDirtyPaths must be a positive safe integer");
  }
  if (nativePathsOverlap(options.repositoryRoot, options.worktreeRoot, options.pathComparison)) {
    throw new Error("repositoryRoot and worktreeRoot must not overlap");
  }
}
