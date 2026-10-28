import { createHash } from "node:crypto";
import path from "node:path";

import { z } from "zod";

import {
  probeDirectoryIdentityBoundarySupport,
  probeDirectoryIdentityPath,
  type DirectoryIdentityBoundarySupport,
  type DirectoryIdentityPathProbe,
} from "../workspaces/linux-directory-identity.js";

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_ISSUES = 20;
const MAX_IDENTIFIER_BYTES = 4_096;
const MAX_PATH_BYTES = 16_384;

const boundedIdentifier = z
  .string()
  .min(1)
  .max(MAX_IDENTIFIER_BYTES)
  .refine((value) => !value.includes("\0"), { message: "must not contain NUL bytes" });
const boundedPath = z
  .string()
  .min(1)
  .max(MAX_PATH_BYTES)
  .refine((value) => !value.includes("\0"), { message: "must not contain NUL bytes" });

export const AgentWorkContainmentPreflightRequestSchema = z
  .object({
    runtime: z
      .object({
        repositoryId: boundedIdentifier,
        repositoryRoot: boundedPath,
        worktreeRoot: boundedPath,
        gitRuntime: boundedIdentifier,
        pathComparison: z.enum(["case-sensitive", "case-insensitive"]),
      })
      .strict(),
  })
  .strict();

export const AgentWorkContainmentPreflightRequestJsonSchema = z.toJSONSchema(
  AgentWorkContainmentPreflightRequestSchema,
  { target: "draft-7" }
);

export type AgentWorkContainmentPreflightRequest = z.infer<
  typeof AgentWorkContainmentPreflightRequestSchema
>;

export type AgentWorkContainmentCapabilityState =
  "native_ready" | "broker_required" | "unsupported";

export type AgentWorkContainmentReasonCode =
  | "native_linux_ready"
  | "windows_native_boundary_unavailable"
  /** Legacy v1 reason retained for persisted result compatibility. */
  | "windows_requires_native_wsl_broker"
  | "macos_unsupported"
  | "unsupported_platform"
  | "case_insensitive_runtime"
  | "procfs_unavailable"
  | "repository_root_invalid"
  | "worktree_root_invalid"
  | "path_roots_overlap"
  | "repository_root_wsl_drvfs_9p"
  | "repository_git_wsl_drvfs_9p"
  | "worktree_root_wsl_drvfs_9p"
  | "repository_root_unavailable"
  | "repository_git_directory_unavailable"
  | "worktree_root_unavailable"
  | "repository_root_filesystem_unverified"
  | "repository_git_filesystem_unverified"
  | "worktree_root_filesystem_unverified";

export type AgentWorkContainmentNextAction =
  | "construct_attempt_packet"
  | "install_native_windows_boundary"
  | "review_windows_boundary_status"
  | "use_external_worker_workflow"
  | "provision_native_wsl_projection"
  | "select_native_case_sensitive_linux_runtime"
  | "correct_declared_paths"
  | "rerun_containment_preflight";

export interface AgentWorkContainmentPathStatus {
  readonly inspection:
    "identity_verified" | "filesystem_verified" | "syntactic_only" | "unverified" | "not_checked";
  readonly filesystem: "native_linux" | "wsl_drvfs_9p" | "unknown";
}

export interface AgentWorkContainmentPreflightResult {
  readonly schemaVersion: "1.0.0";
  readonly operation: "agent-work.containment.preflight";
  readonly bindingDigest: `sha256:${string}`;
  readonly state: AgentWorkContainmentCapabilityState;
  readonly reasonCode: AgentWorkContainmentReasonCode;
  readonly physicalContainmentAvailable: boolean;
  readonly projectionRequired: boolean;
  readonly runtime: {
    readonly platform: "linux" | "windows" | "macos" | "other";
    readonly pathComparison: "case-sensitive" | "case-insensitive";
  };
  readonly paths: {
    readonly repositoryRoot: AgentWorkContainmentPathStatus;
    readonly repositoryGitDirectory: AgentWorkContainmentPathStatus;
    readonly worktreeRoot: AgentWorkContainmentPathStatus;
  };
  readonly nextActions: readonly AgentWorkContainmentNextAction[];
  readonly prerequisite?: {
    readonly component: string;
    readonly status: "production_integration_pending";
    readonly setupProcedure: "unavailable_in_this_release";
    readonly message: string;
    readonly documentation: string;
    readonly alternativeWorkflow: string;
  };
}

export interface AgentWorkContainmentPreflightInputError {
  readonly code: "invalid_input";
  readonly message: "Invalid containment preflight input";
  readonly issues: ReadonlyArray<{ readonly path: string; readonly message: string }>;
}

export type AgentWorkContainmentPreflightHandlerResult =
  | { readonly ok: true; readonly result: AgentWorkContainmentPreflightResult }
  | { readonly ok: false; readonly error: AgentWorkContainmentPreflightInputError };

export interface AgentWorkContainmentPreflightHandler {
  preflight(request: unknown): Promise<AgentWorkContainmentPreflightHandlerResult>;
}

export interface AgentWorkContainmentCapabilityDependencies {
  runtimeProbe?: (
    pathComparison: "case-sensitive" | "case-insensitive"
  ) => DirectoryIdentityBoundarySupport;
  pathProbe?: (absolutePath: string, label: string) => DirectoryIdentityPathProbe;
}

interface EvaluatedPath {
  readonly status: AgentWorkContainmentPathStatus;
  readonly reasonCode: DirectoryIdentityPathProbe["reasonCode"] | "not_checked";
}

/** Stateless, read-only capability owner shared by CLI and MCP adapters. */
export class AgentWorkContainmentCapabilityService {
  private readonly runtimeProbe: NonNullable<
    AgentWorkContainmentCapabilityDependencies["runtimeProbe"]
  >;
  private readonly pathProbe: NonNullable<AgentWorkContainmentCapabilityDependencies["pathProbe"]>;

  constructor(dependencies: AgentWorkContainmentCapabilityDependencies = {}) {
    this.runtimeProbe = dependencies.runtimeProbe ?? probeDirectoryIdentityBoundarySupport;
    this.pathProbe = dependencies.pathProbe ?? probeDirectoryIdentityPath;
  }

  preflight(request: AgentWorkContainmentPreflightRequest): AgentWorkContainmentPreflightResult {
    const { runtime } = request;
    const support = this.runtimeProbe(runtime.pathComparison);
    const runtimePlatform = publicPlatform(support.platform);
    const bindingDigest = digestBinding(runtime);
    const syntacticPaths = {
      repositoryRoot: syntaxStatus(support.platform, runtime.repositoryRoot),
      repositoryGitDirectory: notCheckedPath(),
      worktreeRoot: syntaxStatus(support.platform, runtime.worktreeRoot),
    };

    if (syntacticPaths.repositoryRoot.inspection !== "syntactic_only") {
      return capabilityResult({
        bindingDigest,
        support,
        paths: syntacticPaths,
        state: "unsupported",
        reasonCode: "repository_root_invalid",
        nextActions: ["correct_declared_paths", "rerun_containment_preflight"],
      });
    }
    if (syntacticPaths.worktreeRoot.inspection !== "syntactic_only") {
      return capabilityResult({
        bindingDigest,
        support,
        paths: syntacticPaths,
        state: "unsupported",
        reasonCode: "worktree_root_invalid",
        nextActions: ["correct_declared_paths", "rerun_containment_preflight"],
      });
    }
    if (
      nativePathsOverlap(
        support.platform,
        runtime.repositoryRoot,
        runtime.worktreeRoot,
        runtime.pathComparison
      )
    ) {
      return capabilityResult({
        bindingDigest,
        support,
        paths: syntacticPaths,
        state: "unsupported",
        reasonCode: "path_roots_overlap",
        nextActions: ["correct_declared_paths", "rerun_containment_preflight"],
      });
    }

    if (!support.supported) {
      const brokerRequired = support.reasonCode === "windows_native_boundary_unavailable";
      return capabilityResult({
        bindingDigest,
        support,
        paths: syntacticPaths,
        state: brokerRequired ? "broker_required" : "unsupported",
        reasonCode: support.reasonCode,
        nextActions: brokerRequired
          ? ["review_windows_boundary_status", "use_external_worker_workflow"]
          : ["select_native_case_sensitive_linux_runtime", "rerun_containment_preflight"],
      });
    }

    const repositoryRoot = evaluatePath(this.pathProbe(runtime.repositoryRoot, "repositoryRoot"));
    const worktreeRoot = evaluatePath(this.pathProbe(runtime.worktreeRoot, "worktreeRoot"));
    const repositoryGitDirectory =
      repositoryRoot.status.inspection === "identity_verified"
        ? evaluatePath(
            this.pathProbe(
              nativePathApi(support.platform).join(runtime.repositoryRoot, ".git"),
              "repositoryGitDirectory"
            )
          )
        : notCheckedEvaluatedPath();
    const paths = {
      repositoryRoot: repositoryRoot.status,
      repositoryGitDirectory: repositoryGitDirectory.status,
      worktreeRoot: worktreeRoot.status,
    };

    const wslReason = firstWslReason(repositoryRoot, repositoryGitDirectory, worktreeRoot);
    if (wslReason) {
      return capabilityResult({
        bindingDigest,
        support,
        paths,
        state: "broker_required",
        reasonCode: wslReason,
        nextActions: ["provision_native_wsl_projection", "rerun_containment_preflight"],
        projectionRequired: true,
      });
    }

    const pathFailure = firstPathFailure(repositoryRoot, repositoryGitDirectory, worktreeRoot);
    if (pathFailure) {
      return capabilityResult({
        bindingDigest,
        support,
        paths,
        state: "unsupported",
        reasonCode: pathFailure,
        nextActions: ["correct_declared_paths", "rerun_containment_preflight"],
      });
    }

    return {
      schemaVersion: "1.0.0",
      operation: "agent-work.containment.preflight",
      bindingDigest,
      state: "native_ready",
      reasonCode: "native_linux_ready",
      physicalContainmentAvailable: true,
      projectionRequired: false,
      runtime: { platform: runtimePlatform, pathComparison: runtime.pathComparison },
      paths,
      nextActions: ["construct_attempt_packet"],
    };
  }
}

export function createAgentWorkContainmentPreflightHandler(
  service = new AgentWorkContainmentCapabilityService()
): AgentWorkContainmentPreflightHandler {
  return {
    async preflight(request) {
      const parsed = parseBoundedRequest(request);
      if (!parsed.success) return { ok: false, error: parsed.error };
      return { ok: true, result: service.preflight(parsed.data) };
    },
  };
}

function capabilityResult(input: {
  bindingDigest: `sha256:${string}`;
  support: DirectoryIdentityBoundarySupport;
  paths: AgentWorkContainmentPreflightResult["paths"];
  state: Exclude<AgentWorkContainmentCapabilityState, "native_ready">;
  reasonCode: Exclude<AgentWorkContainmentReasonCode, "native_linux_ready">;
  nextActions: AgentWorkContainmentNextAction[];
  projectionRequired?: boolean;
}): AgentWorkContainmentPreflightResult {
  return {
    schemaVersion: "1.0.0",
    operation: "agent-work.containment.preflight",
    bindingDigest: input.bindingDigest,
    state: input.state,
    reasonCode: input.reasonCode,
    physicalContainmentAvailable: false,
    projectionRequired: input.projectionRequired ?? false,
    runtime: {
      platform: publicPlatform(input.support.platform),
      pathComparison: input.support.pathComparison,
    },
    paths: input.paths,
    nextActions: input.nextActions,
    ...(input.reasonCode === "windows_native_boundary_unavailable"
      ? {
          prerequisite: {
            component: "LexRunner native Windows WorkspaceBoundary helper and production broker",
            status: "production_integration_pending" as const,
            setupProcedure: "unavailable_in_this_release" as const,
            message:
              "This release has no supported installation or configuration procedure for native Windows Attempt execution. " +
              "Optional helper installation alone does not enable the production boundary. " +
              "Keep the containment refusal; external workers can use the separate planning and verification workflow.",
            documentation: "docs/architecture/windows-production-activation.md",
            alternativeWorkflow: "docs/workflows/external-workers.md",
          },
        }
      : {}),
  };
}

function evaluatePath(probe: DirectoryIdentityPathProbe): EvaluatedPath {
  if (probe.verified) {
    return {
      status: { inspection: "identity_verified", filesystem: "native_linux" },
      reasonCode: "directory_verified",
    };
  }
  if (probe.reasonCode === "wsl_drvfs_9p") {
    return {
      status: { inspection: "filesystem_verified", filesystem: "wsl_drvfs_9p" },
      reasonCode: probe.reasonCode,
    };
  }
  return {
    status: { inspection: "unverified", filesystem: "unknown" },
    reasonCode: probe.reasonCode,
  };
}

function firstWslReason(
  repositoryRoot: EvaluatedPath,
  repositoryGitDirectory: EvaluatedPath,
  worktreeRoot: EvaluatedPath
):
  | "repository_root_wsl_drvfs_9p"
  | "repository_git_wsl_drvfs_9p"
  | "worktree_root_wsl_drvfs_9p"
  | undefined {
  if (repositoryRoot.reasonCode === "wsl_drvfs_9p") {
    return "repository_root_wsl_drvfs_9p";
  }
  if (repositoryGitDirectory.reasonCode === "wsl_drvfs_9p") {
    return "repository_git_wsl_drvfs_9p";
  }
  if (worktreeRoot.reasonCode === "wsl_drvfs_9p") {
    return "worktree_root_wsl_drvfs_9p";
  }
  return undefined;
}

function firstPathFailure(
  repositoryRoot: EvaluatedPath,
  repositoryGitDirectory: EvaluatedPath,
  worktreeRoot: EvaluatedPath
):
  | Exclude<
      AgentWorkContainmentReasonCode,
      | "native_linux_ready"
      | "windows_native_boundary_unavailable"
      | "windows_requires_native_wsl_broker"
      | "macos_unsupported"
      | "unsupported_platform"
      | "case_insensitive_runtime"
      | "procfs_unavailable"
      | "repository_root_invalid"
      | "worktree_root_invalid"
      | "path_roots_overlap"
      | "repository_root_wsl_drvfs_9p"
      | "repository_git_wsl_drvfs_9p"
      | "worktree_root_wsl_drvfs_9p"
    >
  | undefined {
  if (repositoryRoot.status.inspection !== "identity_verified") {
    return repositoryRoot.reasonCode === "filesystem_unverified"
      ? "repository_root_filesystem_unverified"
      : "repository_root_unavailable";
  }
  if (repositoryGitDirectory.status.inspection !== "identity_verified") {
    return repositoryGitDirectory.reasonCode === "filesystem_unverified"
      ? "repository_git_filesystem_unverified"
      : "repository_git_directory_unavailable";
  }
  if (worktreeRoot.status.inspection !== "identity_verified") {
    return worktreeRoot.reasonCode === "filesystem_unverified"
      ? "worktree_root_filesystem_unverified"
      : "worktree_root_unavailable";
  }
  return undefined;
}

function syntaxStatus(
  runtimePlatform: NodeJS.Platform,
  value: string
): AgentWorkContainmentPathStatus {
  return nativePathApi(runtimePlatform).isAbsolute(value)
    ? { inspection: "syntactic_only", filesystem: "unknown" }
    : { inspection: "unverified", filesystem: "unknown" };
}

function notCheckedPath(): AgentWorkContainmentPathStatus {
  return { inspection: "not_checked", filesystem: "unknown" };
}

function notCheckedEvaluatedPath(): EvaluatedPath {
  return { status: notCheckedPath(), reasonCode: "not_checked" };
}

function nativePathApi(runtimePlatform: NodeJS.Platform): path.PlatformPath {
  return runtimePlatform === "win32" ? path.win32 : path.posix;
}

function nativePathsOverlap(
  runtimePlatform: NodeJS.Platform,
  left: string,
  right: string,
  comparison: "case-sensitive" | "case-insensitive"
): boolean {
  const api = nativePathApi(runtimePlatform);
  const normalize = (value: string): string => {
    const resolved = api.resolve(value);
    return comparison === "case-insensitive" ? resolved.toLocaleLowerCase("en-US") : resolved;
  };
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  if (normalizedLeft === normalizedRight) return true;
  if (api.parse(normalizedLeft).root !== api.parse(normalizedRight).root) return false;
  const relativeLeft = api.relative(normalizedLeft, normalizedRight);
  const relativeRight = api.relative(normalizedRight, normalizedLeft);
  const isDescendant = (relative: string): boolean =>
    relative.length > 0 && relative !== ".." && !relative.startsWith(`..${api.sep}`);
  return isDescendant(relativeLeft) || isDescendant(relativeRight);
}

function digestBinding(
  runtime: AgentWorkContainmentPreflightRequest["runtime"]
): `sha256:${string}` {
  const encoded = JSON.stringify([
    "agent-work-containment-preflight-v1",
    runtime.repositoryId,
    runtime.repositoryRoot,
    runtime.worktreeRoot,
    runtime.gitRuntime,
    runtime.pathComparison,
  ]);
  return `sha256:${createHash("sha256").update(encoded).digest("hex")}`;
}

function publicPlatform(
  runtimePlatform: NodeJS.Platform
): AgentWorkContainmentPreflightResult["runtime"]["platform"] {
  if (runtimePlatform === "win32") return "windows";
  if (runtimePlatform === "darwin") return "macos";
  if (runtimePlatform === "linux") return "linux";
  return "other";
}

function parseBoundedRequest(
  input: unknown
):
  | { success: true; data: AgentWorkContainmentPreflightRequest }
  | { success: false; error: AgentWorkContainmentPreflightInputError } {
  if (!isJsonSafe(input)) {
    return {
      success: false,
      error: invalidInput([{ path: "", message: "input must be JSON-safe" }]),
    };
  }
  const encoded = JSON.stringify(input);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_INPUT_BYTES) {
    return {
      success: false,
      error: invalidInput([{ path: "", message: `input exceeds ${MAX_INPUT_BYTES} bytes` }]),
    };
  }
  const parsed = AgentWorkContainmentPreflightRequestSchema.safeParse(input);
  if (parsed.success) return { success: true, data: parsed.data };
  return {
    success: false,
    error: invalidInput(
      parsed.error.issues.slice(0, MAX_ISSUES).map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message.slice(0, 256),
      }))
    ),
  };
}

function invalidInput(
  issues: AgentWorkContainmentPreflightInputError["issues"]
): AgentWorkContainmentPreflightInputError {
  return { code: "invalid_input", message: "Invalid containment preflight input", issues };
}

function isJsonSafe(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (depth > 20) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
    return false;
  }
  const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  const safe = entries.every((entry) => isJsonSafe(entry, seen, depth + 1));
  seen.delete(value);
  return safe;
}
