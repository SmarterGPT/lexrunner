import { win32 } from "node:path";
import type { WorkspaceLifecycleStore } from "../store/workspace-lifecycle-store.js";
import type {
  OwnedWindowsProcessAttempt,
  OwnedWindowsProcessResult,
} from "./owned-windows-boundary-handshake.js";
import { projectOwnedWindowsProcessReceipt } from "./owned-windows-process-receipt.js";

export interface OwnedProcessLeaseReference {
  readonly leaseId: string;
  readonly revision: number;
  readonly attemptId: string;
  readonly hostId: string;
}
/** Read-only lifecycle association, never a grant to execute or a persistence receipt. */
export async function bindOwnedWindowsProcessObservation(
  store: Pick<WorkspaceLifecycleStore, "getWorkspaceLease">,
  expected: OwnedProcessLeaseReference,
  attempt: OwnedWindowsProcessAttempt,
  result?: OwnedWindowsProcessResult,
  clock: () => Date = () => new Date()
) {
  // Snapshot before the asynchronous store read; callers cannot swap an observation in flight.
  const reference = structuredClone(expected);
  const observation = structuredClone({ attempt, result });
  const unbound = (
    reason:
      | "lookup_failed"
      | "lease_missing"
      | "lease_mismatch"
      | "lease_inactive"
      | "observation_invalid"
  ) => ({ bound: false as const, reason, observation });
  let lease;
  try {
    lease = await store.getWorkspaceLease(reference.leaseId);
  } catch {
    return unbound("lookup_failed");
  }
  if (!lease) return unbound("lease_missing");
  lease = structuredClone(lease);
  const seen = observation.attempt;
  if (
    lease.leaseId !== reference.leaseId ||
    lease.revision !== reference.revision ||
    lease.attemptId !== reference.attemptId ||
    lease.hostId !== reference.hostId ||
    !win32.isAbsolute(lease.worktreePath) ||
    win32.normalize(lease.worktreePath).toLowerCase() !==
      win32.normalize(seen.cwd.path).toLowerCase()
  )
    return unbound("lease_mismatch");
  let boundAt: string;
  try {
    boundAt = clock().toISOString();
  } catch {
    return unbound("observation_invalid");
  }
  const times = [lease.acquiredAt, lease.expiresAt, seen.startedAt, seen.observedAt, boundAt].map(
    (value) => Date.parse(value ?? "")
  );
  if (times.some((value) => !Number.isFinite(value)) || times[3] < times[2] || times[4] < times[3])
    return unbound("observation_invalid");
  if (
    lease.status !== "active" ||
    times[0] > times[2] ||
    times[1] <= times[3] ||
    times[1] <= times[4]
  )
    return unbound("lease_inactive");
  try {
    const projected = projectOwnedWindowsProcessReceipt(
      { leaseId: seen.boundaryLeaseId, startedAt: seen.startedAt, completedAt: seen.observedAt! },
      seen,
      observation.result
    );
    return {
      bound: true as const,
      observation,
      projected,
      binding: {
        boundaryLeaseId: seen.boundaryLeaseId,
        workspaceLeaseId: lease.leaseId,
        workspaceLeaseRevision: lease.revision,
        attemptId: lease.attemptId,
        hostId: lease.hostId,
        runId: lease.runId,
        packetHash: lease.packetHash,
        controllerId: lease.controllerId,
        controllerLeaseId: lease.controllerLeaseId,
        fencingToken: lease.fencingToken,
        boundAt,
      },
    };
  } catch {
    return unbound("observation_invalid");
  }
}
