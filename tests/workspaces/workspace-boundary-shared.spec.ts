import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach } from "vitest";

import { acquireOwnedWindowsWorkspaceLease } from "../../src/workspaces/owned-windows-workspace-lease.js";
import {
  createWorkspaceBoundaryCapabilityDecision,
  type WorkspaceBoundary,
  type WorkspaceBoundaryLease,
} from "../../src/workspaces/workspace-boundary.js";
import { resolveWorkspaceBoundary } from "../../src/workspaces/workspace-boundary-resolver.js";
import { workspaceBoundaryConformance } from "./workspace-boundary-conformance.js";

const leases = new Set<WorkspaceBoundaryLease>();

afterEach(async () => {
  const failures: unknown[] = [];
  for (const lease of leases) {
    try {
      const receipt = await lease.close("completed");
      if (receipt.phase !== "released")
        throw new Error(`Shared boundary lease ended in ${receipt.phase}`);
    } catch (error) {
      failures.push(error);
    }
  }
  leases.clear();
  if (failures.length) throw new AggregateError(failures, "Shared boundary release unconfirmed");
});

if (process.platform === "linux") {
  const resolution = resolveWorkspaceBoundary({ mode: "native" });
  if (!resolution.ok || resolution.boundary.capability.backend_kind !== "linux-native")
    throw new Error("Native Linux workspace boundary is unavailable for shared conformance");
  workspaceBoundaryConformance("shared native workspace boundary", () => resolution.boundary, {
    backendKind: "linux-native",
    identityKind: "linux-device-inode",
  });
} else if (process.platform === "win32") {
  const helper = process.env.LEXRUNNER_TEST_NATIVE_HELPER;
  if (!helper) throw new Error("LEXRUNNER_TEST_NATIVE_HELPER is required for shared conformance");
  const executable = path.resolve(helper);
  const digest = `sha256:${createHash("sha256").update(readFileSync(executable)).digest("hex")}`;
  const capability = createWorkspaceBoundaryCapabilityDecision({
    schema_version: "1.0.0",
    decision_id: "shared-boundary-development-fixture",
    selection: { mode: "native" },
    backend_kind: "windows-native",
    state: "unavailable",
    reason_code: "helper_signature_unverified",
    host: { platform: "windows", architecture: "x64", path_comparison: "case-insensitive" },
    backend: {
      transport: "native_helper",
      implementation: "shared-boundary-development-fixture",
      implementation_version: "1.0.0",
      protocol_version: "2.2.0",
      artifact_digest: digest,
      signature: { status: "development_unverified" },
    },
    claims: {
      held_directory_identity: true,
      no_follow_open: true,
      final_path_from_handle: true,
      held_ancestor_chain: true,
      replacement_resistant_process_binding: true,
      rename_delete_exclusion: true,
      durable_directory_mutation: false,
    },
    observed_at: new Date().toISOString(),
  });
  const boundary: WorkspaceBoundary = {
    capability,
    async acquire(request) {
      const acquired = await acquireOwnedWindowsWorkspaceLease(
        {
          executable,
          cwd: path.dirname(executable),
          architecture: "x64",
          expectedArtifactSha256: digest,
        },
        request,
        capability.decision_digest,
        { workTimeoutMs: 120_000 }
      );
      if (!acquired.ok)
        throw new Error(`Development Windows boundary acquisition failed: ${acquired.reason}`);
      leases.add(acquired.lease);
      return acquired;
    },
  };
  workspaceBoundaryConformance("shared native workspace boundary", () => boundary, {
    backendKind: "windows-native",
    identityKind: "windows-volume-file-id",
  });
} else {
  throw new Error("Shared native workspace boundary requires Linux or Windows");
}
