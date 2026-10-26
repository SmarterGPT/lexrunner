import {
  SqliteRemovalOperationStore,
  type RemovalAdmissionInput,
  type RemovalAdmissionResult,
} from "./removal-operation-store.js";
import type { SqliteCoordinationStoreOptions } from "./coordination-store.js";
import {
  WindowsRemovalBinding,
  windowsRemovalSlot,
  windowsRemovalMarkerSha256,
} from "../../workspaces/windows-removal-binding.js";
import { win32 } from "node:path";
import type { WorkspaceIdentity } from "../workspace-lifecycle-store.js";
import { parseRemovalIntentBytes } from "../../workspaces/workspace-removal-evidence.js";
import { canonicalJSONStringify } from "../../util/canonicalJson.js";
import { computeCanonicalHash } from "../../schemas/task-contract.js";

/** Internal opt-in development connection. No CLI/MCP/resolver activates it.
 * Immutable metadata associates native selections with the existing journal;
 * it does not authenticate provisioning, code loading or a supplied identity. */
export class SqliteWindowsRemovalStore extends SqliteRemovalOperationStore {
  constructor(path: string, options: SqliteCoordinationStoreOptions = {}) {
    super(path, options);
    try {
      if (!options.readOnly)
        this.immediateTransaction(() => {
          this.db.exec(`CREATE TABLE IF NOT EXISTS windows_removal_bindings (
          operationId TEXT PRIMARY KEY, bindingJson TEXT NOT NULL, bindingDigest TEXT NOT NULL,
          FOREIGN KEY(operationId) REFERENCES removal_intents(operationId) ON DELETE RESTRICT
        );
        INSERT OR IGNORE INTO coordination_schema_migrations(version,name,appliedAt)
          VALUES(25,'windows-removal-native-binding',datetime('now'));`);
        });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  recordWindowsBinding(value: WindowsRemovalBinding): void {
    const binding = WindowsRemovalBinding.parse(value);
    this.immediateTransaction(() => {
      const old = this.readWindowsBinding(binding.operationId);
      if (old) {
        if (canonicalJSONStringify(old) !== canonicalJSONStringify(binding))
          throw new Error("Native removal binding conflict");
        return;
      }
      const intent = parseRemovalIntentBytes(
        this.readEvidence(binding.operationId, `sha256:${"0".repeat(64)}`).intentBytes
      );
      const slot = windowsRemovalSlot(binding.workspaceLeaseId);
      if (
        intent.intent_digest !== binding.intentDigest ||
        intent.lease_id !== binding.workspaceLeaseId ||
        intent.root_identity_digest !== computeCanonicalHash(binding.root) ||
        intent.registration_digest !== computeCanonicalHash(binding.registration) ||
        intent.preservation_digest !== binding.selectionSha256 ||
        binding.slotComponent !== slot.component ||
        binding.slotContentSha256 !== slot.contentSha256 ||
        !this.matchesStoredWorkspace(binding)
      )
        throw new Error("Native removal binding mismatch");
      this.db
        .prepare(
          "INSERT INTO windows_removal_bindings(operationId,bindingJson,bindingDigest) VALUES(?,?,?)"
        )
        .run(binding.operationId, canonicalJSONStringify(binding), computeCanonicalHash(binding));
    });
  }

  readWindowsBinding(operationId: string): WindowsRemovalBinding | null {
    if (!operationId || operationId.length > 128) throw new Error("Invalid removal operation");
    const row = this.db
      .prepare(
        "SELECT substr(bindingJson,1,32769) AS bytes,bindingDigest FROM windows_removal_bindings WHERE operationId=?"
      )
      .get(operationId) as { bytes: string; bindingDigest: string } | undefined;
    if (!row) return null;
    if (Buffer.byteLength(row.bytes, "utf8") > 32768)
      throw new Error("Native removal binding budget");
    const binding = WindowsRemovalBinding.parse(JSON.parse(row.bytes));
    if (
      canonicalJSONStringify(binding) !== row.bytes ||
      computeCanonicalHash(binding) !== row.bindingDigest ||
      binding.operationId !== operationId
    )
      throw new Error("Corrupt native removal binding");
    return binding;
  }

  private matchesStoredWorkspace(binding: WindowsRemovalBinding): boolean {
    const lease = this.db
      .prepare(
        `SELECT repositoryId,attemptId,hostId,gitRuntime,projectRoot,
      worktreePath,branch,baseSha FROM workspace_leases WHERE leaseId=?`
      )
      .get(binding.workspaceLeaseId) as (WorkspaceIdentity & { baseSha: string }) | undefined;
    return (
      !!lease &&
      lease.worktreePath === binding.root.path &&
      binding.rootParent.path === win32.dirname(lease.worktreePath) &&
      binding.rootComponent === win32.basename(lease.worktreePath) &&
      binding.registrationParent.path === win32.join(lease.projectRoot, ".git", "worktrees") &&
      binding.registration.path ===
        win32.join(binding.registrationParent.path, binding.registrationComponent) &&
      binding.markerSha256 === windowsRemovalMarkerSha256(lease)
    );
  }

  override admitRemoval(input: RemovalAdmissionInput): RemovalAdmissionResult {
    // Same writer transaction as admission: the binding cannot be swapped between
    // this association check and the existing controller/worker/revision fences.
    return this.immediateTransaction(() => {
      if (this.readOperation(input.operationId)) return super.admitRemoval(input);
      const binding = this.readWindowsBinding(input.operationId);
      if (
        !binding ||
        binding.intentDigest !== input.intentDigest ||
        binding.executorId !== input.executorId ||
        !this.matchesStoredWorkspace(binding)
      )
        return { kind: "rejected", reason: "native_binding_mismatch" };
      return super.admitRemoval(input);
    });
  }
}
