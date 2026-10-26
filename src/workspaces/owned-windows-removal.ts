import { win32 } from "node:path";
import { createHash } from "node:crypto";
import type { WorkspaceLifecycleLeaseRecord } from "../store/workspace-lifecycle-store.js";
import type {
  RemovalAdmissionInput,
  RemovalResolutionInput,
} from "../store/sqlite/removal-operation-store.js";
import type { SqliteWindowsRemovalStore } from "../store/sqlite/windows-removal-store.js";
import { canonicalJSONStringify } from "../util/canonicalJson.js";
import { computeCanonicalHash } from "../schemas/task-contract.js";
import { createRemovalIntent, createRemovalObservation } from "./workspace-removal-evidence.js";
import type { OwnedWindowsDirectoryScope } from "./owned-windows-boundary-handshake.js";
import { windowsRemovalChannel } from "./windows-removal-channel.js";
import {
  windowsRemovalSlot,
  windowsRemovalMarkerSha256,
  type WindowsRemovalBinding,
} from "./windows-removal-binding.js";
import { WindowsRemovalIdentity, type WindowsRemovalPayload } from "./windows-removal-protocol.js";
import { windowsRemovalGitEnvironment } from "./windows-removal-git-environment.js";

interface Parents {
  root: OwnedWindowsDirectoryScope;
  registration: OwnedWindowsDirectoryScope;
  slot: OwnedWindowsDirectoryScope;
}
const identity = (scope: OwnedWindowsDirectoryScope) => {
  const { chain_length: _chain, ...value } = scope.identity;
  return WindowsRemovalIdentity.parse(value);
};
const same = (a: unknown, b: unknown) => canonicalJSONStringify(a) === canonicalJSONStringify(b);

/** Explicit development executor. The caller runs this inside one owned session.
 * Only fresh durable admission dispatches. Lost replies preserve the journal;
 * no retry, reservation release or production capability is inferred. */
export async function executeOwnedWindowsRemoval(input: {
  store: SqliteWindowsRemovalStore;
  parents: Parents;
  lease: WorkspaceLifecycleLeaseRecord;
  rootIdentity: WindowsRemovalIdentity;
  registrationIdentity: WindowsRemovalIdentity;
  slotIdentity: WindowsRemovalIdentity;
  registrationComponent: string;
  gitExecutable: string;
  admission: Omit<RemovalAdmissionInput, "intentDigest" | "observationDigest" | "executorId">;
  now(): string;
  timeoutMs?: number;
  maximumDeletes?: number;
}) {
  input = {
    ...input,
    lease: structuredClone(input.lease),
    admission: structuredClone(input.admission),
    parents: { ...input.parents },
  };
  const { store, lease, parents } = input;
  const prior = store.readOperation(input.admission.operationId);
  if (prior) return { kind: "replay" as const, operation: prior };
  const channel = windowsRemovalChannel(parents.root, parents.registration, parents.slot);
  const root = WindowsRemovalIdentity.parse(input.rootIdentity);
  const registration = WindowsRemovalIdentity.parse(input.registrationIdentity);
  const slot = WindowsRemovalIdentity.parse(input.slotIdentity);
  const selectedSlot = windowsRemovalSlot(lease.leaseId);
  const rootComponent = win32.basename(lease.worktreePath);
  if (
    root.path !== lease.worktreePath ||
    win32.join(parents.root.identity.path, rootComponent) !== root.path ||
    parents.registration.identity.path !== win32.join(lease.projectRoot, ".git", "worktrees") ||
    win32.join(parents.registration.identity.path, input.registrationComponent) !==
      registration.path ||
    win32.join(parents.slot.identity.path, selectedSlot.component) !== slot.path
  )
    throw new Error("Native removal paths do not match the retained lease");
  const gitEnvironment = windowsRemovalGitEnvironment();
  const prepared = await channel.invoke({
    ...channel.tokens,
    operation: "prepare",
    root_component: rootComponent,
    registration_component: input.registrationComponent,
    slot_component: selectedSlot.component,
    root_identity: root,
    registration_identity: registration,
    slot_identity: slot,
    slot_content_sha256: selectedSlot.contentSha256,
    marker_sha256: windowsRemovalMarkerSha256(lease),
    git_executable: input.gitExecutable,
    git_environment: gitEnvironment,
  });
  if (
    prepared.operation !== "prepare" ||
    !same(prepared.root_identity, root) ||
    !same(prepared.registration_identity, registration)
  )
    throw new Error("Native removal preparation mismatch");
  try {
    if (
      prepared.clean_git.environment_sha256 !==
      `sha256:${createHash("sha256")
        .update(canonicalJSONStringify({ git_environment: gitEnvironment }))
        .digest("hex")}`
    )
      throw new Error("Native removal Git environment mismatch");
    if (
      `sha256:${createHash("sha256")
        .update(
          canonicalJSONStringify({
            clean_git: prepared.clean_git,
            executor_id: prepared.executor_id,
            marker_sha256: windowsRemovalMarkerSha256(lease),
            registration_inventory_sha256: prepared.registration_inventory_sha256,
            root_inventory_sha256: prepared.root_inventory_sha256,
            slot_file_id: slot.file_id,
            slot_volume: slot.volume_serial_number,
          })
        )
        .digest("hex")}` !== prepared.selection_sha256
    )
      throw new Error("Native removal selection digest mismatch");
    const now = input.now();
    const intent = createRemovalIntent({
      schema_version: "workspace-removal-intent/1",
      operation_id: input.admission.operationId,
      attempt_id: lease.attemptId,
      lease_id: lease.leaseId,
      lease_revision: lease.revision,
      root_identity_digest: computeCanonicalHash(root),
      registration_digest: computeCanonicalHash(registration),
      preservation_digest: prepared.selection_sha256,
      created_at: now,
    });
    const observation = createRemovalObservation({
      schema_version: "workspace-removal-observation/1",
      intent_digest: intent.intent_digest,
      observed_at: now,
      root_state: "present",
      root_identity_digest: intent.root_identity_digest,
      contents: prepared.root_entries > 1 ? "remaining" : "empty",
      registration_state: "present",
      registration_digest: intent.registration_digest,
    });
    const binding: WindowsRemovalBinding = {
      schemaVersion: "windows-removal-binding/1",
      operationId: intent.operation_id,
      intentDigest: intent.intent_digest,
      workspaceLeaseId: lease.leaseId,
      executorId: prepared.executor_id,
      selectionSha256: prepared.selection_sha256,
      rootParent: identity(parents.root),
      registrationParent: identity(parents.registration),
      slotParent: identity(parents.slot),
      root,
      registration,
      slot,
      rootComponent,
      registrationComponent: input.registrationComponent,
      slotComponent: selectedSlot.component,
      slotContentSha256: selectedSlot.contentSha256,
      markerSha256: windowsRemovalMarkerSha256(lease),
      cleanGit: prepared.clean_git,
    };
    if (!store.appendIntent(canonicalJSONStringify(intent)).recorded)
      throw new Error("Removal intent conflict");
    store.recordWindowsBinding(binding);
    if (
      !store.appendObservation(canonicalJSONStringify(observation)).recorded ||
      !store.selectObservation(
        intent.operation_id,
        intent.intent_digest,
        observation.observation_digest,
        null
      )
    )
      throw new Error("Removal selection conflict");
    const admission = store.admitRemoval({
      ...input.admission,
      now: input.now(),
      intentDigest: intent.intent_digest,
      observationDigest: observation.observation_digest,
      executorId: prepared.executor_id,
    });
    if (admission.kind !== "admitted") return admission;
    // No await or external callback between fresh admission and dispatch.
    const result = await channel.invoke({
      operation: "commit",
      removal_token: prepared.removal_token,
      admission_digest: admission.operation.admission.admissionDigest,
      timeout_ms: input.timeoutMs ?? 30000,
      maximum_deletes: input.maximumDeletes ?? 4096,
    });
    if (result.operation !== "commit") throw new Error("Native removal commit mismatch");
    const { removal_token: _token, ...effect } = result;
    return { kind: "executed" as const, operation: admission.operation, effect };
  } finally {
    // Failure here remains uncertainty. The owner must establish child termination
    // before a new session can use the recovery path; never silently retry commit.
    await channel.invoke({ operation: "release", removal_token: prepared.removal_token });
  }
}

/** Read fresh physical state under the original stable slot. The native peer
 * checks PID + creation time using a process handle; active/unknown is refused.
 * Resolution records observed partial effects and never authorizes more deletion. */
export async function recoverOwnedWindowsRemoval(input: {
  store: SqliteWindowsRemovalStore;
  parents: Parents;
  resolution: Omit<RemovalResolutionInput, "admissionDigest" | "observationDigest">;
  now(): string;
}) {
  input = {
    ...input,
    resolution: structuredClone(input.resolution),
    parents: { ...input.parents },
  };
  const { store, parents } = input;
  const operation = store.readOperation(input.resolution.operationId);
  const binding = store.readWindowsBinding(input.resolution.operationId);
  if (
    !operation ||
    !binding ||
    binding.intentDigest !== operation.admission.intentDigest ||
    binding.executorId !== operation.admission.executorId
  )
    throw new Error("Native removal recovery binding missing");
  if (operation.resolution) return { kind: "replay" as const, operation };
  if (
    !same(identity(parents.root), binding.rootParent) ||
    !same(identity(parents.registration), binding.registrationParent) ||
    !same(identity(parents.slot), binding.slotParent)
  )
    throw new Error("Native removal recovery parent changed");
  const channel = windowsRemovalChannel(parents.root, parents.registration, parents.slot);
  const request: WindowsRemovalPayload = {
    ...channel.tokens,
    operation: "recover",
    root_component: binding.rootComponent,
    registration_component: binding.registrationComponent,
    slot_component: binding.slotComponent,
    root_identity: binding.root,
    registration_identity: binding.registration,
    slot_identity: binding.slot,
    slot_content_sha256: binding.slotContentSha256,
    previous_executor_id: binding.executorId,
  };
  const result = await channel.invoke(request);
  if (result.operation !== "recover") throw new Error("Native recovery response mismatch");
  try {
    if (result.executor_state !== "gone")
      return { kind: "rejected" as const, reason: "executor_not_quiescent" };
    const observation = createRemovalObservation({
      schema_version: "workspace-removal-observation/1",
      intent_digest: binding.intentDigest,
      observed_at: input.now(),
      root_state: result.root_identity ? "present" : "absent",
      root_identity_digest: result.root_identity
        ? computeCanonicalHash(result.root_identity)
        : null,
      contents: result.contents,
      registration_state: result.registration_identity
        ? result.registration_locked
          ? "locked"
          : "present"
        : "absent",
      registration_digest: result.registration_identity
        ? computeCanonicalHash(result.registration_identity)
        : null,
    });
    if (!store.appendObservation(canonicalJSONStringify(observation)).recorded)
      throw new Error("Native recovery observation conflict");
    return store.resolveRemoval({
      ...input.resolution,
      now: input.now(),
      admissionDigest: operation.admission.admissionDigest,
      observationDigest: observation.observation_digest,
    });
  } finally {
    await channel.invoke({ operation: "release", removal_token: result.removal_token });
  }
}
