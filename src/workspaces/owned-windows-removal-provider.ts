import { win32 } from "node:path";

import type { CoordinationStore } from "../store/coordination-store.js";
import type {
  AttemptRecord,
  WorkspaceLifecycleLeaseRecord,
  WorkspaceLifecycleStore,
} from "../store/workspace-lifecycle-store.js";
import type { SqliteWindowsRemovalStore } from "../store/sqlite/windows-removal-store.js";
import type { RemovalOperation } from "../store/sqlite/removal-operation-store.js";
import type { NativeWorktreeRemovalTransition } from "./node-git-worktree-broker.js";
import type { WindowsRemovalBinding } from "./windows-removal-binding.js";
import { windowsRemovalMarkerSha256, windowsRemovalSlot } from "./windows-removal-binding.js";
import { recoverOwnedWindowsRemoval } from "./owned-windows-removal.js";
import type { acquireOwnedWindowsRootSession } from "./owned-windows-root-session.js";

type AcquiredRoots = Awaited<ReturnType<typeof acquireOwnedWindowsRootSession>>;
type LifecycleRead = Pick<WorkspaceLifecycleStore, "getAttempt" | "getWorkspaceLease"> &
  Pick<CoordinationStore, "getRunCoordination">;

export interface DurableWindowsRemovalProviderOptions {
  store: SqliteWindowsRemovalStore;
  lifecycle: LifecycleRead;
  /** The owner is supplied by a separately qualified launch boundary. This
   * interface does not select or authenticate a helper or activate discovery. */
  openRoots(
    roots: readonly { readonly role: string; readonly absolutePath: string }[],
    signal?: AbortSignal
  ): Promise<AcquiredRoots>;
  now(): string;
}

/** Per-operation recovery from a durable admission and immutable native binding.
 * Fresh deletion is deliberately unavailable until protected first-dispatch
 * selection and slot provisioning have a qualified producer. In particular a
 * new observation of a slot is never promoted into an expected identity here. */
export function createDurableWindowsRemovalProvider(
  input: DurableWindowsRemovalProviderOptions
): NativeWorktreeRemovalTransition & {
  recover(
    operationId: string,
    signal?: AbortSignal
  ): Promise<
    Awaited<ReturnType<typeof recoverOwnedWindowsRemoval>> | { kind: "rejected"; reason: string }
  >;
} {
  const source = { ...input };
  return {
    async remove(_target, _selection, options) {
      const operationId = options.boundaryAuthority?.operationId;
      let prior: RemovalOperation | null = null;
      try {
        prior = operationId ? source.store.readOperation(operationId) : null;
      } catch {
        return {
          ok: false,
          operation: "remove",
          reason: "containment_violation",
          message: "Native removal journal selection is invalid; reconciliation required",
        };
      }
      return {
        ok: false,
        operation: "remove",
        reason: "containment_violation",
        message: prior
          ? "Native removal is already admitted; use explicit durable recovery without another commit"
          : "Native removal requires a protected first-dispatch selection and provisioned slot",
      };
    },
    async recover(operationId, signal) {
      const operation = source.store.readOperation(operationId);
      const binding = source.store.readWindowsBinding(operationId);
      if (!operation || !binding)
        return { kind: "rejected", reason: "durable_native_binding_missing" };
      const lease = await source.lifecycle.getWorkspaceLease(binding.workspaceLeaseId);
      if (!lease) return { kind: "rejected", reason: "workspace_lease_missing" };
      const [attempt, run] = await Promise.all([
        source.lifecycle.getAttempt(lease.attemptId),
        source.lifecycle.getRunCoordination(lease.runId),
      ]);
      if (!matchesDurableRecovery(operation, binding, lease, attempt))
        return { kind: "rejected", reason: "durable_native_binding_mismatch" };
      if (operation.resolution) return { kind: "replay", operation };
      const controller = run?.lease;
      if (!run || run.runId !== lease.runId || !controller || controller.runId !== lease.runId)
        return { kind: "rejected", reason: "current_controller_missing" };

      const roots = await source.openRoots(
        [
          { role: "root", absolutePath: binding.rootParent.path },
          { role: "registration", absolutePath: binding.registrationParent.path },
          { role: "slot", absolutePath: binding.slotParent.path },
        ],
        signal
      );
      if (!roots.ok) return { kind: "rejected", reason: "native_parent_acquisition_failed" };
      try {
        return await roots.session.run(() =>
          recoverOwnedWindowsRemoval({
            store: source.store,
            parents: {
              root: roots.root("root"),
              registration: roots.root("registration"),
              slot: roots.root("slot"),
            },
            resolution: {
              operationId,
              controller: {
                runId: lease.runId,
                controllerId: controller.controllerId,
                leaseId: controller.leaseId,
                fencingToken: controller.fencingToken,
              },
              expectedRunRevision: run.revision,
              now: source.now(),
              maxObservationAgeMs: 30_000,
            },
            now: source.now,
          })
        );
      } finally {
        const report = await roots.session.close();
        if (
          report.outcome !== "matched" ||
          !report.cleanup.processExited ||
          report.cleanup.disposition !== "closed"
        )
          throw new Error("Native recovery owner release unconfirmed; reconciliation required");
      }
    },
  };
}

function matchesDurableRecovery(
  operation: RemovalOperation,
  binding: WindowsRemovalBinding,
  lease: WorkspaceLifecycleLeaseRecord,
  attempt: AttemptRecord | null
): boolean {
  const slot = windowsRemovalSlot(lease.leaseId);
  return (
    !!attempt &&
    attempt.attemptId === lease.attemptId &&
    attempt.workspaceLeaseId === lease.leaseId &&
    attempt.runId === lease.runId &&
    operation.admission.operationId === binding.operationId &&
    operation.admission.workspaceLeaseId === lease.leaseId &&
    binding.workspaceLeaseId === lease.leaseId &&
    operation.admission.controller.runId === lease.runId &&
    operation.admission.intentDigest === binding.intentDigest &&
    operation.admission.executorId === binding.executorId &&
    binding.root.path === lease.worktreePath &&
    binding.rootParent.path === win32.dirname(lease.worktreePath) &&
    binding.rootComponent === win32.basename(lease.worktreePath) &&
    binding.registrationParent.path === win32.join(lease.projectRoot, ".git", "worktrees") &&
    binding.registration.path ===
      win32.join(binding.registrationParent.path, binding.registrationComponent) &&
    binding.slot.path === win32.join(binding.slotParent.path, slot.component) &&
    binding.slotComponent === slot.component &&
    binding.slotContentSha256 === slot.contentSha256 &&
    binding.markerSha256 === windowsRemovalMarkerSha256(lease)
  );
}
