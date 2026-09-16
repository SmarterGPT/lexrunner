import type { WorkspaceBoundaryDirectoryIdentity_v1 } from "./workspace-boundary.js";

/** Compare already-validated observations, never reconstruct a live directory capability. */
export function sameWorkspaceBoundaryIdentity(
  left: WorkspaceBoundaryDirectoryIdentity_v1,
  right: WorkspaceBoundaryDirectoryIdentity_v1
): boolean {
  if (left.backend_kind !== right.backend_kind || left.path_comparison !== right.path_comparison)
    return false;
  if (left.identity_kind === "linux-device-inode" && right.identity_kind === "linux-device-inode")
    return left.device === right.device && left.inode === right.inode;
  if (
    left.identity_kind === "windows-volume-file-id" &&
    right.identity_kind === "windows-volume-file-id"
  )
    return (
      left.volume_serial_number === right.volume_serial_number && left.file_id === right.file_id
    );
  return false;
}
