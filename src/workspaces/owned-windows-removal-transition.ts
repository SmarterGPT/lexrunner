import { win32 } from "node:path";
import type { WorkspaceLifecycleLeaseRecord } from "../store/workspace-lifecycle-store.js";
import type { SqliteWindowsRemovalStore } from "../store/sqlite/windows-removal-store.js";
import type {
  RemovalAdmissionInput,
  RemovalResolutionInput,
} from "../store/sqlite/removal-operation-store.js";
import type { NativeWorktreeRemovalTransition } from "./node-git-worktree-broker.js";
import type {
  OwnedWindowsBoundaryHandshakeOptions,
  WindowsBoundaryHandshakeReport,
} from "./owned-windows-boundary-handshake.js";
import type { WorkspaceBoundaryDirectoryIdentity_v1 } from "./workspace-boundary.js";
import { acquireOwnedWindowsRootSession } from "./owned-windows-root-session.js";
import { executeOwnedWindowsRemoval, recoverOwnedWindowsRemoval } from "./owned-windows-removal.js";
import { WindowsRemovalIdentity } from "./windows-removal-protocol.js";

function matches(portable: WorkspaceBoundaryDirectoryIdentity_v1, native: WindowsRemovalIdentity) {
  return (
    portable.identity_kind === "windows-volume-file-id" &&
    portable.canonical_path === native.path &&
    portable.file_id === native.file_id &&
    portable.volume_serial_number === native.volume_serial_number
  );
}

/** Development connection to the real broker, absent from production discovery.
 * Uses an already selected lease/slot, never provisions a helper or new trust root.
 * The operation ID is fixed: subsequent calls remain historical status only. */
export function createOwnedWindowsRemovalTransition(input: {
  helper: OwnedWindowsBoundaryHandshakeOptions;
  store: SqliteWindowsRemovalStore;
  lease: WorkspaceLifecycleLeaseRecord;
  rootIdentity: WindowsRemovalIdentity;
  registrationIdentity: WindowsRemovalIdentity;
  slotIdentity: WindowsRemovalIdentity;
  gitExecutable: string;
  admission: Omit<RemovalAdmissionInput, "intentDigest" | "observationDigest" | "executorId">;
  resolution: Omit<RemovalResolutionInput, "admissionDigest" | "observationDigest">;
  now(): string;
}): NativeWorktreeRemovalTransition & {
  recover(): Promise<Awaited<ReturnType<typeof recoverOwnedWindowsRemoval>>>;
  snapshotOwners(): readonly WindowsBoundaryHandshakeReport[];
} {
  // Snapshot mutable caller inputs before any await; callbacks supply time only.
  const options = {
    ...structuredClone({ ...input, store: undefined, now: undefined }),
    store: input.store,
    now: input.now,
  };
  if (
    options.admission.operationId !== options.resolution.operationId ||
    options.admission.controller.runId !== options.lease.runId ||
    options.resolution.controller.runId !== options.lease.runId
  )
    throw new Error("Native removal transition operation/run mismatch");
  const owners: WindowsBoundaryHandshakeReport[] = [];
  const open = async (signal?: AbortSignal) => {
    if (owners.length >= 128) throw new Error("Native removal owner history budget exceeded");
    const session = await acquireOwnedWindowsRootSession(
      options.helper,
      { workTimeoutMs: 120000 },
      [
        { role: "root", absolutePath: win32.dirname(options.rootIdentity.path) },
        { role: "registration", absolutePath: win32.dirname(options.registrationIdentity.path) },
        { role: "slot", absolutePath: win32.dirname(options.slotIdentity.path) },
        { role: "repositoryGit", absolutePath: win32.join(options.lease.projectRoot, ".git") },
      ],
      16,
      signal
    );
    if (!session.ok) {
      if (session.report) owners.push(structuredClone(session.report));
      throw new Error("Native removal parent acquisition failed");
    }
    return session;
  };
  const parents = (session: Awaited<ReturnType<typeof open>>) => ({
    root: session.root("root"),
    registration: session.root("registration"),
    slot: session.root("slot"),
  });
  const close = async (session: Awaited<ReturnType<typeof open>>) => {
    const report = await session.session.close();
    owners.push(structuredClone(report));
    if (
      report.outcome !== "matched" ||
      !report.cleanup.processExited ||
      report.cleanup.disposition !== "closed"
    )
      throw new Error("Native removal owner release unconfirmed; reconciliation required");
  };
  const recover = async () => {
    const session = await open();
    try {
      return await session.session.run(() =>
        recoverOwnedWindowsRemoval({
          store: options.store,
          parents: parents(session),
          resolution: options.resolution,
          now: options.now,
        })
      );
    } finally {
      await close(session);
    }
  };
  return {
    recover,
    snapshotOwners: () => structuredClone(owners),
    async remove(target, selection, operationOptions) {
      const fail = (message: string) => ({
        ok: false as const,
        operation: "remove" as const,
        reason: "containment_violation" as const,
        message,
      });
      for (const key of [
        "repositoryId",
        "hostId",
        "gitRuntime",
        "projectRoot",
        "worktreePath",
        "attemptId",
        "branch",
        "baseSha",
      ] as const)
        if (target[key] !== options.lease[key])
          return fail("Native removal target differs from the retained lease");
      if (!matches(selection.root, options.rootIdentity))
        return fail("Native removal selected root identity changed");
      try {
        const session = await open(operationOptions.signal);
        let result: Awaited<ReturnType<typeof executeOwnedWindowsRemoval>>;
        try {
          const git = session.root("repositoryGit").identity;
          if (
            !matches(selection.repositoryGit, {
              path: git.path,
              file_id: git.file_id,
              volume_serial_number: git.volume_serial_number,
              filesystem: git.filesystem,
            })
          )
            return fail("Native removal repository identity changed");
          result = await session.session.run(() =>
            executeOwnedWindowsRemoval({
              store: options.store,
              parents: parents(session),
              lease: options.lease,
              rootIdentity: options.rootIdentity,
              registrationIdentity: options.registrationIdentity,
              slotIdentity: options.slotIdentity,
              registrationComponent: win32.basename(options.registrationIdentity.path),
              gitExecutable: options.gitExecutable,
              admission: options.admission,
              now: options.now,
            })
          );
        } finally {
          await close(session);
        }
        if (result.kind === "rejected")
          return fail(`Native removal admission rejected: ${result.reason}`);
        if (result.kind === "replay")
          return fail(
            "Native removal already admitted; inspect or explicitly recover the recorded operation"
          );
        const recovery = await recover();
        if (
          recovery.kind !== "rejected" &&
          recovery.operation.resolution?.observedState === "absence_observed"
        )
          return { ok: true };
        return fail(
          "Native removal has partial or unresolved effects; reservation retained for reconciliation"
        );
      } catch {
        return fail(
          "Native removal did not complete with confirmed ownership and fresh absence; inspect the durable operation before recovery"
        );
      }
    },
  };
}
