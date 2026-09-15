import type {
  OwnedWindowsFileCreationAttempt,
  OwnedWindowsFileCreated,
} from "./owned-windows-boundary-handshake.js";
import {
  createWorkspaceBoundaryDirectoryIdentity,
  createWorkspaceBoundaryOperationReceipt,
  WORKSPACE_BOUNDARY_CONTRACT_VERSION,
  type WorkspaceBoundaryResult,
} from "./workspace-boundary.js";

/** Pure observation projection; caller supplies lease/time association. No authority or persistence. */
export function projectOwnedWindowsFileCreationReceipt(
  context: { leaseId: string; startedAt: string; completedAt: string },
  attempt: OwnedWindowsFileCreationAttempt,
  result?: OwnedWindowsFileCreated
): WorkspaceBoundaryResult<void> {
  if (attempt.acknowledged !== Boolean(result)) throw new Error("Acknowledgment/result mismatch");
  const parent = createWorkspaceBoundaryDirectoryIdentity({
    schema_version: WORKSPACE_BOUNDARY_CONTRACT_VERSION,
    backend_kind: "windows-native",
    canonical_path: attempt.parent.path,
    path_comparison: "case-insensitive",
    identity_kind: "windows-volume-file-id",
    file_id: attempt.parent.file_id,
    volume_serial_number: attempt.parent.volume_serial_number,
  });
  const common = {
    schema_version: WORKSPACE_BOUNDARY_CONTRACT_VERSION,
    operation_id: attempt.operationId,
    lease_id: context.leaseId,
    backend_kind: "windows-native" as const,
    operation: "write-owned-file" as const,
    mutation: true,
    identity_digests: [parent.identity_digest],
    started_at: context.startedAt,
    completed_at: context.completedAt,
  };
  if (!result) {
    const error = {
      schema_version: WORKSPACE_BOUNDARY_CONTRACT_VERSION,
      code: "operation_failed" as const,
      message:
        "File creation has no validated acknowledgment; dispatch and effects are unconfirmed",
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
        durability: "indeterminate",
        error,
      }),
    };
  }
  if (
    result.kind !== "file_created" ||
    result.requestId !== attempt.requestId ||
    result.operationId !== attempt.operationId ||
    result.requestDigest !== attempt.requestDigest ||
    result.byteLength !== attempt.byteLength ||
    result.contentSha256 !== attempt.contentSha256 ||
    result.fileId !== attempt.fileId ||
    result.volumeSerialNumber !== attempt.parent.volume_serial_number ||
    !Number.isSafeInteger(result.byteLength) ||
    result.byteLength < 0 ||
    result.byteLength > 65_536 ||
    !/^sha256:[a-f0-9]{64}$/u.test(result.contentSha256) ||
    !/^[a-f0-9]{32}$/u.test(result.fileId)
  )
    throw new Error("File creation result does not match recorded attempt");
  // Successful flush/readback is an observation, not qualified crash durability.
  return {
    ok: true,
    value: undefined,
    receipt: createWorkspaceBoundaryOperationReceipt({
      ...common,
      outcome: "completed",
      durability: "not_requested",
    }),
  };
}
