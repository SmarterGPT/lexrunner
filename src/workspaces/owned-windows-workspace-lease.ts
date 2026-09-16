import { randomUUID } from "node:crypto";
import type { CommandResult } from "./command-runner.js";
import type {
  OwnedWindowsDirectoryScope,
  OwnedWindowsDirectoryIdentity,
  OwnedWindowsBoundaryHandshakeOptions,
} from "./owned-windows-boundary-handshake.js";
import { acquireOwnedWindowsRootSession } from "./owned-windows-root-session.js";
import { projectOwnedWindowsFileCreationReceipt } from "./owned-windows-file-receipt.js";
import { projectOwnedWindowsProcessReceipt } from "./owned-windows-process-receipt.js";
import { windowsCommandEnvironment } from "./windows-command-environment.js";
import {
  createWorkspaceBoundaryDirectoryIdentity,
  createWorkspaceBoundaryLeaseReceipt,
  createWorkspaceBoundaryOperationReceipt,
  workspaceBoundaryLeaseBrand,
  type WorkspaceBoundaryAcquireRequest,
  type WorkspaceBoundaryDirectoryCapability,
  type WorkspaceBoundaryDirectoryIdentity_v1,
  type WorkspaceBoundaryLease,
  type WorkspaceBoundaryLeaseReceipt_v1,
  type WorkspaceBoundaryOperationKind,
  type WorkspaceBoundaryResult,
  type WorkspaceBoundaryReadFileRequest,
  type WorkspaceBoundaryWriteFileRequest,
  type WorkspaceBoundaryProcessRequest,
} from "./workspace-boundary.js";

type RootSession = Extract<
  Awaited<ReturnType<typeof acquireOwnedWindowsRootSession>>,
  { ok: true }
>;
export interface OwnedWindowsOperationAssociation {
  readonly operationId: string;
  readonly nativeOperations: readonly {
    readonly requestId: string;
    readonly operationId: string;
    readonly requestDigest: string;
    readonly acknowledged: boolean;
  }[];
}

/**
 * Development composition of live native scopes with the portable lease API.
 * The supplied decision digest is association data, not verified provisioning.
 * This factory is deliberately absent from production resolution.
 */
export async function acquireOwnedWindowsWorkspaceLease(
  options: OwnedWindowsBoundaryHandshakeOptions,
  request: WorkspaceBoundaryAcquireRequest,
  capabilityDecisionDigest: string,
  directory: { workTimeoutMs: number; deadlineGraceMs?: number }
) {
  const input = structuredClone(request);
  const abort = new AbortController();
  // Validate association before opening any native resources.
  const seed = createWorkspaceBoundaryLeaseReceipt({
    schema_version: "1.0.0",
    lease_id: randomUUID(),
    orchestration_lease_id: input.orchestrationLeaseId,
    orchestration_lease_revision: input.orchestrationLeaseRevision,
    owner_id: input.ownerId,
    backend_kind: "windows-native",
    capability_decision_digest: capabilityDecisionDigest,
    root_identity_digests: [capabilityDecisionDigest],
    phase: "acquired",
    observed_at: new Date().toISOString(),
  });
  requireOperationId(input.operationId);
  const acquired = await acquireOwnedWindowsRootSession(
    options,
    directory,
    input.roots,
    1,
    abort.signal
  );
  if (!acquired.ok) return acquired;
  try {
    return { ok: true as const, lease: new OwnedWindowsWorkspaceLease(acquired, seed, abort) };
  } catch (error) {
    await acquired.session.close();
    throw error;
  }
}

export class OwnedWindowsWorkspaceLease implements WorkspaceBoundaryLease {
  readonly [workspaceBoundaryLeaseBrand] = true as const;
  readonly acquired: WorkspaceBoundaryLeaseReceipt_v1;
  readonly completion: RootSession["session"]["completion"];
  private readonly scopes = new Map<
    WorkspaceBoundaryDirectoryCapability,
    OwnedWindowsDirectoryScope
  >();
  private readonly roots = new Map<string, WorkspaceBoundaryDirectoryCapability>();
  private readonly associations: OwnedWindowsOperationAssociation[] = [];
  private readonly usedIds = new Set<string>();
  private busy = false;
  private ended = false;
  private closing?: Promise<WorkspaceBoundaryLeaseReceipt_v1>;

  constructor(
    private readonly native: RootSession,
    seed: WorkspaceBoundaryLeaseReceipt_v1,
    private readonly abort: AbortController
  ) {
    for (const root of native.plan.roots)
      this.roots.set(root.role, this.register(native.root(root.role), seed.lease_id));
    const { receipt_digest: _digest, ...body } = seed;
    this.acquired = Object.freeze(
      createWorkspaceBoundaryLeaseReceipt({
        ...body,
        root_identity_digests: [...this.roots.values()].map(
          (root) => root.identity.identity_digest
        ),
        observed_at: new Date().toISOString(),
      })
    );
    this.completion = native.session.completion;
    void this.completion.then(() => {
      this.ended = true;
    });
  }

  snapshotAssociations(): readonly OwnedWindowsOperationAssociation[] {
    return structuredClone(this.associations);
  }

  root(role: string): WorkspaceBoundaryDirectoryCapability {
    if (this.ended || this.closing) throw new Error("workspace_lease_closed");
    const value = this.roots.get(role);
    if (!value) throw new Error("unknown_root_role");
    return value;
  }

  openChild(parent: WorkspaceBoundaryDirectoryCapability, component: string, operationId: string) {
    return this.perform("open-child", operationId, [parent], false, async () =>
      this.register(await this.scope(parent).openChild(component))
    );
  }

  tryOpenChild(
    parent: WorkspaceBoundaryDirectoryCapability,
    component: string,
    operationId: string
  ) {
    return this.perform("open-child", operationId, [parent], false, async () => {
      const child = await this.scope(parent).tryOpenChild(component);
      return child ? this.register(child) : null;
    });
  }

  createChild(
    parent: WorkspaceBoundaryDirectoryCapability,
    component: string,
    operationId: string
  ) {
    return this.perform("create-child", operationId, [parent], true, async () =>
      this.register(await this.scope(parent).createChild(component))
    );
  }

  assertCurrent(directories: readonly WorkspaceBoundaryDirectoryCapability[], operationId: string) {
    const selected = [...directories];
    return this.perform("assert-current", operationId, selected, false, async () => {
      if (!selected.length) throw new Error("empty_assertion");
      const identities: WorkspaceBoundaryDirectoryIdentity_v1[] = [];
      for (const capability of selected)
        identities.push(identity(await this.scope(capability).assertCurrent()));
      return identities;
    });
  }

  readFile(request: WorkspaceBoundaryReadFileRequest) {
    const { directory, component, maxBytes, operationId } = request;
    return this.perform(
      "read-owned-file",
      operationId,
      [directory],
      false,
      async () => (await this.scope(directory).readFile(component, maxBytes)).bytes
    );
  }

  writeFile(request: WorkspaceBoundaryWriteFileRequest): Promise<WorkspaceBoundaryResult<void>> {
    const { directory, component, operationId, mode, exclusive } = request;
    const content = Buffer.from(request.content);
    return this.perform(
      "write-owned-file",
      operationId,
      [directory],
      true,
      async () => {
        const result = await this.scope(directory).createFile(component, content);
        const attempt = this.native.session
          .snapshotFileCreations()
          .find((item) => item.requestId === result.requestId);
        if (!attempt) throw new Error("missing_creation_evidence");
        // Validate the native acknowledgment without replacing its native operation identity.
        projectOwnedWindowsFileCreationReceipt(
          {
            leaseId: this.acquired.lease_id,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          },
          attempt,
          result
        );
      },
      () => {
        if (mode !== undefined || exclusive !== true) throw new Error("unsupported_write_options");
      }
    );
  }

  runProcess(
    request: WorkspaceBoundaryProcessRequest
  ): Promise<WorkspaceBoundaryResult<CommandResult>> {
    const { operationId, executable, cwd, timeoutMs, maxOutputBytes, signal } = request;
    const args = request.args.map((arg) => ({
      ...arg,
      ...(arg.kind === "directory" && arg.components ? { components: [...arg.components] } : {}),
    }));
    // Environment is captured before the first asynchronous boundary.
    let env: Record<string, string>;
    try {
      env = windowsCommandEnvironment(request);
    } catch (error) {
      return this.perform(
        "spawn-process",
        operationId,
        [cwd],
        false,
        async () => {
          throw error;
        },
        () => {
          throw error;
        }
      );
    }
    const directories = [
      cwd,
      ...args.flatMap((arg) => (arg.kind === "directory" ? [arg.directory] : [])),
    ];
    return this.perform(
      "spawn-process",
      operationId,
      directories,
      false,
      async () => {
        if (signal?.aborted) throw new Error("command_aborted_before_dispatch");
        const nativeArgs = args.map((arg) => {
          if (arg.kind === "literal") return arg;
          if (arg.components?.length || arg.suffix !== undefined)
            throw new Error("unsupported_directory_argument");
          return {
            kind: "directory" as const,
            directory: this.scope(arg.directory),
            prefix: arg.prefix ?? "",
            relativeToCwd: arg.relativeToCwd ?? false,
          };
        });
        const cancel = () => this.abort.abort();
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          const result = await this.scope(cwd).runProcess({
            executable,
            args: nativeArgs,
            environment: "replace",
            env,
            timeoutMs,
            maxOutputBytes: maxOutputBytes ?? 256 * 1024,
          });
          const attempt = this.native.session
            .snapshotProcessAttempts()
            .find((item) => item.requestId === result.requestId);
          if (!attempt?.observedAt) throw new Error("missing_process_evidence");
          const projected = projectOwnedWindowsProcessReceipt(
            {
              leaseId: this.acquired.lease_id,
              startedAt: attempt.startedAt,
              completedAt: attempt.observedAt,
            },
            attempt,
            result
          );
          if (!projected.ok) throw new Error("invalid_process_completion");
          return projected.value;
        } finally {
          signal?.removeEventListener("abort", cancel);
        }
      },
      () => {
        if (signal?.aborted) throw new Error("command_aborted_before_dispatch");
        if (
          args.some(
            (arg) =>
              arg.kind === "directory" && (arg.components?.length || arg.suffix !== undefined)
          )
        )
          throw new Error("unsupported_directory_argument");
      }
    );
  }

  close(reason: "completed" | "cancelled" | "expired" | "reconcile") {
    if (!this.closing)
      this.closing = (async () => {
        this.ended = true;
        const report = await this.native.session.close();
        if (
          report.cleanup.disposition !== "closed" ||
          !report.directory?.releaseAcknowledged ||
          report.directory.childrenAcquired !== report.directory.childrenReleased
        )
          throw new Error("workspace_release_unconfirmed");
        const { receipt_digest: _digest, ...body } = this.acquired;
        return createWorkspaceBoundaryLeaseReceipt({
          ...body,
          phase: reason === "expired" || report.reason === "work_timeout" ? "expired" : "released",
          observed_at: new Date().toISOString(),
        });
      })();
    return this.closing;
  }

  private scope(capability: WorkspaceBoundaryDirectoryCapability) {
    const value = this.scopes.get(capability);
    if (!value) throw new Error("foreign_directory_capability");
    return value;
  }

  private register(scope: OwnedWindowsDirectoryScope, leaseId = this.acquired.lease_id) {
    const capability = Object.freeze({
      leaseId,
      identity: Object.freeze(identity(scope.identity)),
    }) as WorkspaceBoundaryDirectoryCapability;
    this.scopes.set(capability, scope);
    return capability;
  }

  private async perform<T>(
    operation: WorkspaceBoundaryOperationKind,
    operationId: string,
    directories: readonly WorkspaceBoundaryDirectoryCapability[],
    mutation: boolean,
    work: () => Promise<T>,
    validate?: () => void
  ): Promise<WorkspaceBoundaryResult<T>> {
    requireOperationId(operationId);
    const startedAt = new Date().toISOString();
    const knownIdentities = [
      ...new Set(
        directories
          .filter((item) => this.scopes.has(item))
          .map((item) => item.identity.identity_digest)
      ),
    ];
    const common = {
      schema_version: "1.0.0" as const,
      operation_id: operationId,
      lease_id: this.acquired.lease_id,
      backend_kind: "windows-native" as const,
      operation,
      mutation,
      identity_digests:
        knownIdentities.length && knownIdentities.length <= 32
          ? knownIdentities
          : this.acquired.root_identity_digests,
      started_at: startedAt,
    };
    let entered = false;
    const beforeDirectory = this.native.session.snapshotDirectoryAttempts().length;
    const beforeProcess = this.native.session.snapshotProcessAttempts().length;
    try {
      if (this.ended || this.closing || this.busy || this.usedIds.has(operationId))
        throw new Error("workspace_operation_unavailable");
      directories.forEach((item) => this.scope(item));
      if (knownIdentities.length > 32) throw new Error("too_many_directory_identities");
      validate?.();
      this.usedIds.add(operationId);
      this.busy = true;
      entered = true;
      const value = await this.native.session.run(work);
      return {
        ok: true,
        value,
        receipt: createWorkspaceBoundaryOperationReceipt({
          ...common,
          completed_at: new Date().toISOString(),
          outcome: "completed",
          durability: mutation ? "not_requested" : "not_applicable",
        }),
      };
    } catch (cause) {
      const dispatched =
        entered &&
        (this.native.session
          .snapshotDirectoryAttempts()
          .slice(beforeDirectory)
          .some((item) => item.operation !== "release") ||
          this.native.session.snapshotProcessAttempts().length > beforeProcess);
      const unknown = dispatched && (mutation || operation === "spawn-process");
      const error = {
        schema_version: "1.0.0" as const,
        code: "operation_failed" as const,
        message: (cause instanceof Error ? cause.message : "workspace_operation_failed").slice(
          0,
          4096
        ),
        retryable: false,
        effect_state: unknown ? ("effect_unknown" as const) : ("no_effect" as const),
        operation_id: operationId,
      };
      return {
        ok: false,
        error,
        receipt: createWorkspaceBoundaryOperationReceipt({
          ...common,
          completed_at: new Date().toISOString(),
          outcome: unknown ? "indeterminate" : "rejected",
          durability: mutation ? (unknown ? "indeterminate" : "not_requested") : "not_applicable",
          error,
        }),
      };
    } finally {
      if (entered) {
        this.associations.push(
          Object.freeze({
            operationId,
            nativeOperations: Object.freeze(
              [
                ...this.native.session
                  .snapshotDirectoryAttempts()
                  .slice(beforeDirectory)
                  .filter((item) => item.operation !== "release"),
                ...this.native.session.snapshotProcessAttempts().slice(beforeProcess),
              ].map(({ requestId, operationId, requestDigest, acknowledged }) =>
                Object.freeze({ requestId, operationId, requestDigest, acknowledged })
              )
            ),
          })
        );
        this.busy = false;
      }
    }
  }
}

function requireOperationId(value: string) {
  if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\0"))
    throw new Error("invalid_operation_id");
}
function identity(value: OwnedWindowsDirectoryIdentity) {
  return createWorkspaceBoundaryDirectoryIdentity({
    schema_version: "1.0.0",
    backend_kind: "windows-native",
    canonical_path: value.path,
    path_comparison: "case-insensitive",
    identity_kind: "windows-volume-file-id",
    file_id: value.file_id,
    volume_serial_number: value.volume_serial_number,
  });
}
