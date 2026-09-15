import type { CommandResult } from "./command-runner.js";
import type {
  OwnedWindowsProcessAttempt,
  OwnedWindowsProcessResult,
} from "./owned-windows-boundary-handshake.js";
import {
  createWorkspaceBoundaryDirectoryIdentity,
  createWorkspaceBoundaryOperationReceipt,
  WORKSPACE_BOUNDARY_CONTRACT_VERSION,
  type WorkspaceBoundaryResult,
} from "./workspace-boundary.js";

/** Pure development projection. Caller supplies lease/time association; no authority or persistence. */
export function projectOwnedWindowsProcessReceipt(
  context: { leaseId: string; startedAt: string; completedAt: string },
  attempt: OwnedWindowsProcessAttempt,
  result?: OwnedWindowsProcessResult
): WorkspaceBoundaryResult<CommandResult> {
  if (attempt.acknowledged !== Boolean(result)) throw new Error("Acknowledgment/result mismatch");
  const cwd = createWorkspaceBoundaryDirectoryIdentity({
    schema_version: WORKSPACE_BOUNDARY_CONTRACT_VERSION,
    backend_kind: "windows-native",
    canonical_path: attempt.cwd.path,
    path_comparison: "case-insensitive",
    identity_kind: "windows-volume-file-id",
    file_id: attempt.cwd.file_id,
    volume_serial_number: attempt.cwd.volume_serial_number,
  });
  const common = {
    schema_version: WORKSPACE_BOUNDARY_CONTRACT_VERSION,
    operation_id: attempt.operationId,
    lease_id: context.leaseId,
    backend_kind: "windows-native" as const,
    operation: "spawn-process" as const,
    mutation: false,
    durability: "not_applicable" as const,
    identity_digests: [cwd.identity_digest],
    started_at: context.startedAt,
    completed_at: context.completedAt,
  };
  if (!result) {
    const error = {
      schema_version: WORKSPACE_BOUNDARY_CONTRACT_VERSION,
      code: "operation_failed" as const,
      message: "Process was dispatched without a validated completion acknowledgment",
      retryable: false,
      effect_state: "effect_unknown" as const,
      operation_id: attempt.operationId,
    };
    return {
      ok: false,
      error,
      receipt: createWorkspaceBoundaryOperationReceipt({
        ...common,
        outcome: "indeterminate",
        error,
      }),
    };
  }
  if (
    result.requestId !== attempt.requestId ||
    result.operationId !== attempt.operationId ||
    result.requestDigest !== attempt.requestDigest ||
    result.status !== attempt.status
  )
    throw new Error("Process result does not match recorded attempt");
  if (
    !["exited", "nonzero_exit", "timeout", "output_limit"].includes(result.status) ||
    !Number.isSafeInteger(result.exitCode) ||
    result.exitCode < 0 ||
    result.exitCode > 0xffffffff ||
    !Number.isSafeInteger(result.durationMs) ||
    result.durationMs < 0 ||
    !(result.stdout instanceof Uint8Array) ||
    !(result.stderr instanceof Uint8Array) ||
    result.stdout.length > 256 * 1024 ||
    result.stderr.length > 256 * 1024 ||
    typeof result.stdoutTruncated !== "boolean" ||
    typeof result.stderrTruncated !== "boolean" ||
    (result.status === "exited" && result.exitCode !== 0) ||
    (result.status === "nonzero_exit" && result.exitCode === 0) ||
    (result.status === "output_limit") !== (result.stdoutTruncated || result.stderrTruncated)
  )
    throw new Error("Inconsistent process outcome");
  // These bytes came from the validated owned transport. Preserve newline and UTF-8
  // replacement semantics of the existing text CommandResult boundary.
  const output = {
    stdout: Buffer.from(result.stdout).toString("utf8"),
    stderr: Buffer.from(result.stderr).toString("utf8"),
    durationMs: result.durationMs,
  };
  const value: CommandResult =
    result.status === "exited"
      ? { ...output, ok: true, exitCode: 0 }
      : {
          ...output,
          ok: false,
          kind: result.status,
          exitCode: result.exitCode,
          message: `Native command ended with ${result.status}`,
        };
  return {
    ok: true,
    value,
    receipt: createWorkspaceBoundaryOperationReceipt({ ...common, outcome: "completed" }),
  };
}
