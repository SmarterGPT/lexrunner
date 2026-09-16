import { WINDOWS_BOUNDARY_PROTOCOL_VERSION } from "./windows-boundary-protocol.js";
import { randomUUID } from "node:crypto";
import { arch, platform } from "node:os";

import type { CommandRunner } from "./command-runner.js";
import { probeDirectoryIdentityBoundarySupport } from "./linux-directory-identity.js";
import { LinuxWorkspaceBoundary } from "./linux-workspace-boundary.js";
import {
  WORKSPACE_BOUNDARY_CONTRACT_VERSION,
  WorkspaceBoundarySelectionRequest_v1,
  createWorkspaceBoundaryCapabilityDecision,
  type WorkspaceBoundary,
  type WorkspaceBoundaryCapabilityDecision_v1,
  type WorkspaceBoundaryResolver,
} from "./workspace-boundary.js";

const EMPTY_CLAIMS = Object.freeze({
  held_directory_identity: false,
  no_follow_open: false,
  final_path_from_handle: false,
  held_ancestor_chain: false,
  replacement_resistant_process_binding: false,
  rename_delete_exclusion: false,
  durable_directory_mutation: false,
});

const LINUX_CLAIMS = Object.freeze({
  held_directory_identity: true,
  no_follow_open: true,
  final_path_from_handle: true,
  held_ancestor_chain: true,
  replacement_resistant_process_binding: true,
  rename_delete_exclusion: false,
  durable_directory_mutation: false,
});

export type WorkspaceBoundaryResolution =
  | { readonly ok: true; readonly boundary: WorkspaceBoundary }
  | { readonly ok: false; readonly decision: WorkspaceBoundaryCapabilityDecision_v1 };

export interface WorkspaceBoundaryResolverOptions {
  readonly runner?: CommandRunner;
}

/** Production resolution reads the actual host. It accepts no platform or backend override. */
export function resolveWorkspaceBoundary(
  request: WorkspaceBoundarySelectionRequest_v1,
  options: WorkspaceBoundaryResolverOptions = {}
): WorkspaceBoundaryResolution {
  const selection = WorkspaceBoundarySelectionRequest_v1.parse(request);
  const runtimePlatform = platform();
  const observedAt = new Date().toISOString();
  const decisionId = randomUUID();

  if (selection.mode === "explicit_projection") {
    return {
      ok: false,
      decision: createWorkspaceBoundaryCapabilityDecision({
        schema_version: WORKSPACE_BOUNDARY_CONTRACT_VERSION,
        decision_id: decisionId,
        selection,
        backend_kind: "native-wsl-projection",
        state: "unavailable",
        reason_code: "projection_unavailable",
        host: host(runtimePlatform),
        backend: {
          transport: "in_process",
          implementation: "native-wsl-projection",
          implementation_version: WORKSPACE_BOUNDARY_CONTRACT_VERSION,
        },
        claims: EMPTY_CLAIMS,
        observed_at: observedAt,
      }),
    };
  }

  if (runtimePlatform === "linux") {
    const support = probeDirectoryIdentityBoundarySupport("case-sensitive");
    const capability = createWorkspaceBoundaryCapabilityDecision({
      schema_version: WORKSPACE_BOUNDARY_CONTRACT_VERSION,
      decision_id: decisionId,
      selection,
      backend_kind: "linux-native",
      state: support.supported ? "ready" : "unavailable",
      reason_code: support.supported ? "native_backend_ready" : "backend_unavailable",
      host: host(runtimePlatform),
      backend: {
        transport: "in_process",
        implementation: "linux-directory-identity",
        implementation_version: WORKSPACE_BOUNDARY_CONTRACT_VERSION,
      },
      claims: support.supported ? LINUX_CLAIMS : EMPTY_CLAIMS,
      observed_at: observedAt,
    });
    return support.supported
      ? {
          ok: true,
          boundary: new LinuxWorkspaceBoundary({
            capability,
            ...(options.runner ? { runner: options.runner } : {}),
          }),
        }
      : { ok: false, decision: capability };
  }

  if (runtimePlatform === "win32") {
    return {
      ok: false,
      decision: createWorkspaceBoundaryCapabilityDecision({
        schema_version: WORKSPACE_BOUNDARY_CONTRACT_VERSION,
        decision_id: decisionId,
        selection,
        backend_kind: "windows-native",
        state: "unavailable",
        reason_code: "helper_missing",
        host: host(runtimePlatform),
        backend: {
          transport: "native_helper",
          implementation: "windows-workspace-boundary",
          implementation_version: WORKSPACE_BOUNDARY_CONTRACT_VERSION,
          protocol_version: WINDOWS_BOUNDARY_PROTOCOL_VERSION,
          signature: { status: "not_available" },
        },
        claims: EMPTY_CLAIMS,
        observed_at: observedAt,
      }),
    };
  }

  return {
    ok: false,
    decision: createWorkspaceBoundaryCapabilityDecision({
      schema_version: WORKSPACE_BOUNDARY_CONTRACT_VERSION,
      decision_id: decisionId,
      selection,
      backend_kind: "linux-native",
      state: "unsupported",
      reason_code: "unsupported_host",
      host: host(runtimePlatform),
      backend: {
        transport: "in_process",
        implementation: "linux-directory-identity",
        implementation_version: WORKSPACE_BOUNDARY_CONTRACT_VERSION,
      },
      claims: EMPTY_CLAIMS,
      observed_at: observedAt,
    }),
  };
}

export class NativeWorkspaceBoundaryResolver implements WorkspaceBoundaryResolver {
  constructor(private readonly options: WorkspaceBoundaryResolverOptions = {}) {}

  async resolve(
    request: WorkspaceBoundarySelectionRequest_v1
  ): Promise<WorkspaceBoundaryResolution> {
    return resolveWorkspaceBoundary(request, this.options);
  }
}

function host(runtimePlatform: NodeJS.Platform) {
  return {
    platform:
      runtimePlatform === "linux" ? "linux" : runtimePlatform === "win32" ? "windows" : "other",
    architecture: arch(),
    path_comparison: runtimePlatform === "win32" ? "case-insensitive" : "case-sensitive",
  } as const;
}
