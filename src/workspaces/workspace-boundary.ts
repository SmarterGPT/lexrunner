import { z } from "zod";

import { boundedStrictObject } from "../schemas/bounded-strict-object.js";
import { computeCanonicalHash, SHA256Hash } from "../schemas/task-contract.js";
import type { CommandResult } from "./command-runner.js";

export const WORKSPACE_BOUNDARY_CONTRACT_VERSION = "1.0.0" as const;

const MAX_IDENTIFIER_LENGTH = 4_096;
const MAX_PATH_LENGTH = 32_768;
const MAX_MESSAGE_LENGTH = 4_096;

const BoundedIdentifier = z
  .string()
  .min(1)
  .max(MAX_IDENTIFIER_LENGTH)
  .refine((value) => !value.includes("\0"), { message: "must not contain NUL bytes" });
const BoundedPath = z
  .string()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .refine((value) => !value.includes("\0"), { message: "must not contain NUL bytes" });
const Timestamp = z.string().max(64).datetime({ offset: true });
const DecimalIdentity = z
  .string()
  .max(32)
  .regex(/^(?:0|[1-9][0-9]*)$/u, "must be a decimal integer");
const HexIdentity = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-f0-9]+$/u, "must be lowercase hexadecimal");

export const WorkspaceBoundaryBackendKind = z.enum([
  "linux-native",
  "windows-native",
  "native-wsl-projection",
]);
export type WorkspaceBoundaryBackendKind = z.infer<typeof WorkspaceBoundaryBackendKind>;

export const WorkspaceBoundarySelectionRequest_v1 = z.union([
  boundedStrictObject({ mode: z.literal("native") }),
  boundedStrictObject({
    mode: z.literal("explicit_projection"),
    profile_id: BoundedIdentifier,
  }),
]);
export type WorkspaceBoundarySelectionRequest_v1 = z.infer<
  typeof WorkspaceBoundarySelectionRequest_v1
>;

const BoundaryClaims = boundedStrictObject({
  held_directory_identity: z.boolean(),
  no_follow_open: z.boolean(),
  final_path_from_handle: z.boolean(),
  held_ancestor_chain: z.boolean(),
  replacement_resistant_process_binding: z.boolean(),
  rename_delete_exclusion: z.boolean(),
  durable_directory_mutation: z.boolean(),
});

const InProcessBackend = boundedStrictObject({
  transport: z.literal("in_process"),
  implementation: BoundedIdentifier,
  implementation_version: BoundedIdentifier,
});
const NativeHelperBackend = boundedStrictObject({
  transport: z.literal("native_helper"),
  implementation: BoundedIdentifier,
  implementation_version: BoundedIdentifier,
  protocol_version: BoundedIdentifier,
  artifact_digest: SHA256Hash.optional(),
  signature: z.union([
    boundedStrictObject({
      status: z.literal("verified"),
      signer_identity: BoundedIdentifier,
    }),
    boundedStrictObject({
      status: z.literal("development_unverified"),
    }),
    boundedStrictObject({
      status: z.literal("not_available"),
    }),
  ]),
});

const CapabilityDecisionShape = {
  schema_version: z.literal(WORKSPACE_BOUNDARY_CONTRACT_VERSION),
  decision_id: BoundedIdentifier,
  selection: WorkspaceBoundarySelectionRequest_v1,
  backend_kind: WorkspaceBoundaryBackendKind,
  state: z.enum(["ready", "unavailable", "unsupported"]),
  reason_code: z.enum([
    "native_backend_ready",
    "explicit_projection_ready",
    "unsupported_host",
    "unsupported_filesystem",
    "backend_unavailable",
    "helper_missing",
    "helper_integrity_failure",
    "helper_protocol_mismatch",
    "helper_signature_unverified",
    "projection_not_requested",
    "projection_unavailable",
  ]),
  host: boundedStrictObject({
    platform: z.enum(["linux", "windows", "other"]),
    architecture: BoundedIdentifier,
    path_comparison: z.enum(["case-sensitive", "case-insensitive"]),
  }),
  backend: z.union([InProcessBackend, NativeHelperBackend]),
  claims: BoundaryClaims,
  observed_at: Timestamp,
} as const;
const CapabilityDecisionBody = boundedStrictObject(CapabilityDecisionShape).superRefine(
  requireValidCapabilityDecision
);

export const WorkspaceBoundaryCapabilityDecision_v1 = boundedStrictObject({
  ...CapabilityDecisionShape,
  decision_digest: SHA256Hash,
})
  .superRefine(requireValidCapabilityDecision)
  .superRefine((decision, context) => {
    const { decision_digest: _digest, ...body } = decision;
    requireDigest(
      decision.decision_digest,
      boundaryHash("capability-decision", body),
      "decision_digest",
      context
    );
  });
export type WorkspaceBoundaryCapabilityDecision_v1 = z.infer<
  typeof WorkspaceBoundaryCapabilityDecision_v1
>;

export function createWorkspaceBoundaryCapabilityDecision(
  input: z.input<z.ZodObject<typeof CapabilityDecisionShape>>
): WorkspaceBoundaryCapabilityDecision_v1 {
  const body = CapabilityDecisionBody.parse(input);
  return WorkspaceBoundaryCapabilityDecision_v1.parse({
    ...body,
    decision_digest: boundaryHash("capability-decision", body),
  });
}

const DirectoryIdentityCommon = {
  schema_version: z.literal(WORKSPACE_BOUNDARY_CONTRACT_VERSION),
  backend_kind: WorkspaceBoundaryBackendKind,
  canonical_path: BoundedPath,
  path_comparison: z.enum(["case-sensitive", "case-insensitive"]),
} as const;
const LinuxDirectoryIdentityShape = {
  ...DirectoryIdentityCommon,
  identity_kind: z.literal("linux-device-inode"),
  device: DecimalIdentity,
  inode: DecimalIdentity,
} as const;
const WindowsDirectoryIdentityShape = {
  ...DirectoryIdentityCommon,
  identity_kind: z.literal("windows-volume-file-id"),
  volume_serial_number: HexIdentity,
  file_id: HexIdentity,
} as const;

const LinuxDirectoryIdentityBody = boundedStrictObject(LinuxDirectoryIdentityShape).superRefine(
  (identity, context) => {
    if (identity.backend_kind === "windows-native") {
      addIssue(context, ["backend_kind"], "Windows native identities require a Windows file ID");
    }
    if (identity.path_comparison !== "case-sensitive") {
      addIssue(context, ["path_comparison"], "Linux directory identities are case-sensitive");
    }
    if (!identity.canonical_path.startsWith("/") || identity.canonical_path.startsWith("//")) {
      addIssue(context, ["canonical_path"], "Linux identities require an absolute native path");
    }
  }
);
const WindowsDirectoryIdentityBody = boundedStrictObject(WindowsDirectoryIdentityShape).superRefine(
  (identity, context) => {
    if (identity.backend_kind !== "windows-native") {
      addIssue(context, ["backend_kind"], "Windows file IDs require the Windows native backend");
    }
    if (identity.path_comparison !== "case-insensitive") {
      addIssue(context, ["path_comparison"], "Windows directory identities are case-insensitive");
    }
    if (!isWindowsAbsolutePath(identity.canonical_path)) {
      addIssue(context, ["canonical_path"], "Windows identities require an absolute native path");
    }
  }
);

export const WorkspaceBoundaryDirectoryIdentity_v1 = z.union([
  boundedStrictObject({
    ...LinuxDirectoryIdentityShape,
    identity_digest: SHA256Hash,
  }).superRefine((identity, context) => {
    const { identity_digest: _digest, ...body } = identity;
    const parsed = LinuxDirectoryIdentityBody.safeParse(body);
    copyIssues(parsed, context);
    requireDigest(
      identity.identity_digest,
      boundaryHash("directory-identity", body),
      "identity_digest",
      context
    );
  }),
  boundedStrictObject({
    ...WindowsDirectoryIdentityShape,
    identity_digest: SHA256Hash,
  }).superRefine((identity, context) => {
    const { identity_digest: _digest, ...body } = identity;
    const parsed = WindowsDirectoryIdentityBody.safeParse(body);
    copyIssues(parsed, context);
    requireDigest(
      identity.identity_digest,
      boundaryHash("directory-identity", body),
      "identity_digest",
      context
    );
  }),
]);
export type WorkspaceBoundaryDirectoryIdentity_v1 = z.infer<
  typeof WorkspaceBoundaryDirectoryIdentity_v1
>;

export function createWorkspaceBoundaryDirectoryIdentity(
  input:
    | z.input<z.ZodObject<typeof LinuxDirectoryIdentityShape>>
    | z.input<z.ZodObject<typeof WindowsDirectoryIdentityShape>>
): WorkspaceBoundaryDirectoryIdentity_v1 {
  const body =
    input.identity_kind === "linux-device-inode"
      ? LinuxDirectoryIdentityBody.parse(input)
      : WindowsDirectoryIdentityBody.parse(input);
  return WorkspaceBoundaryDirectoryIdentity_v1.parse({
    ...body,
    identity_digest: boundaryHash("directory-identity", body),
  });
}

export const WorkspaceBoundaryError_v1 = boundedStrictObject({
  schema_version: z.literal(WORKSPACE_BOUNDARY_CONTRACT_VERSION),
  code: z.enum([
    "unsupported_host",
    "unsupported_filesystem",
    "backend_unavailable",
    "helper_integrity_failure",
    "helper_protocol_mismatch",
    "invalid_path",
    "reparse_point_rejected",
    "identity_changed",
    "lease_stale",
    "containment_violation",
    "sharing_violation",
    "operation_failed",
    "durability_indeterminate",
  ]),
  message: z.string().min(1).max(MAX_MESSAGE_LENGTH),
  retryable: z.boolean(),
  effect_state: z.enum(["no_effect", "effect_recorded", "effect_unknown"]),
  operation_id: BoundedIdentifier.optional(),
});
export type WorkspaceBoundaryError_v1 = z.infer<typeof WorkspaceBoundaryError_v1>;

const LeaseReceiptShape = {
  schema_version: z.literal(WORKSPACE_BOUNDARY_CONTRACT_VERSION),
  lease_id: BoundedIdentifier,
  orchestration_lease_id: BoundedIdentifier,
  orchestration_lease_revision: z.number().int().nonnegative(),
  owner_id: BoundedIdentifier,
  backend_kind: WorkspaceBoundaryBackendKind,
  capability_decision_digest: SHA256Hash,
  root_identity_digests: z.array(SHA256Hash).min(1).max(16),
  phase: z.enum(["acquired", "released", "expired", "reconciled"]),
  observed_at: Timestamp,
} as const;
const LeaseReceiptBody = boundedStrictObject(LeaseReceiptShape);

export const WorkspaceBoundaryLeaseReceipt_v1 = boundedStrictObject({
  ...LeaseReceiptShape,
  receipt_digest: SHA256Hash,
}).superRefine((receipt, context) => {
  const { receipt_digest: _digest, ...body } = receipt;
  requireDigest(
    receipt.receipt_digest,
    boundaryHash("lease-receipt", body),
    "receipt_digest",
    context
  );
});
export type WorkspaceBoundaryLeaseReceipt_v1 = z.infer<typeof WorkspaceBoundaryLeaseReceipt_v1>;

export function createWorkspaceBoundaryLeaseReceipt(
  input: z.input<z.ZodObject<typeof LeaseReceiptShape>>
): WorkspaceBoundaryLeaseReceipt_v1 {
  const parsed = LeaseReceiptBody.parse(input);
  const body = LeaseReceiptBody.parse({
    ...parsed,
    root_identity_digests: canonicalDigestSet(parsed.root_identity_digests),
  });
  return WorkspaceBoundaryLeaseReceipt_v1.parse({
    ...body,
    receipt_digest: boundaryHash("lease-receipt", body),
  });
}

export const WorkspaceBoundaryOperationKind = z.enum([
  "capture-root",
  "open-child",
  "create-child",
  "assert-current",
  "read-owned-file",
  "write-owned-file",
  "rename-owned",
  "remove-owned",
  "sync-directory",
  "spawn-process",
]);
export type WorkspaceBoundaryOperationKind = z.infer<typeof WorkspaceBoundaryOperationKind>;

const OperationReceiptShape = {
  schema_version: z.literal(WORKSPACE_BOUNDARY_CONTRACT_VERSION),
  operation_id: BoundedIdentifier,
  lease_id: BoundedIdentifier,
  backend_kind: WorkspaceBoundaryBackendKind,
  operation: WorkspaceBoundaryOperationKind,
  mutation: z.boolean(),
  outcome: z.enum(["completed", "rejected", "indeterminate"]),
  durability: z.enum(["not_applicable", "not_requested", "committed", "indeterminate"]),
  identity_digests: z.array(SHA256Hash).min(1).max(32),
  started_at: Timestamp,
  completed_at: Timestamp,
  error: WorkspaceBoundaryError_v1.optional(),
} as const;
const OperationReceiptBody = boundedStrictObject(OperationReceiptShape).superRefine(
  requireValidOperationReceipt
);

export const WorkspaceBoundaryOperationReceipt_v1 = boundedStrictObject({
  ...OperationReceiptShape,
  receipt_digest: SHA256Hash,
})
  .superRefine(requireValidOperationReceipt)
  .superRefine((receipt, context) => {
    const { receipt_digest: _digest, ...body } = receipt;
    requireDigest(
      receipt.receipt_digest,
      boundaryHash("operation-receipt", body),
      "receipt_digest",
      context
    );
  });
export type WorkspaceBoundaryOperationReceipt_v1 = z.infer<
  typeof WorkspaceBoundaryOperationReceipt_v1
>;

export function createWorkspaceBoundaryOperationReceipt(
  input: z.input<z.ZodObject<typeof OperationReceiptShape>>
): WorkspaceBoundaryOperationReceipt_v1 {
  const parsed = OperationReceiptBody.parse(input);
  const body = OperationReceiptBody.parse({
    ...parsed,
    identity_digests: canonicalDigestSet(parsed.identity_digests),
  });
  return WorkspaceBoundaryOperationReceipt_v1.parse({
    ...body,
    receipt_digest: boundaryHash("operation-receipt", body),
  });
}

function canonicalDigestSet(digests: readonly string[]): string[] {
  return [...new Set(digests)].sort();
}

declare const directoryCapabilityBrand: unique symbol;
export const workspaceBoundaryLeaseBrand: unique symbol = Symbol("WorkspaceBoundaryLease");

/** Live authority is intentionally opaque and is never reconstructed from a receipt or path. */
export interface WorkspaceBoundaryDirectoryCapability {
  readonly [directoryCapabilityBrand]: true;
  readonly leaseId: string;
  readonly identity: WorkspaceBoundaryDirectoryIdentity_v1;
}

export type WorkspaceBoundaryProcessArgument =
  | { readonly kind: "literal"; readonly value: string }
  | {
      readonly kind: "directory";
      readonly directory: WorkspaceBoundaryDirectoryCapability;
      readonly components?: readonly string[];
      readonly prefix?: string;
      /** Render `.` only when this exact capability is also the process cwd. */
      readonly relativeToCwd?: boolean;
      readonly suffix?: string;
    };

export interface WorkspaceBoundaryReadFileRequest {
  readonly operationId: string;
  readonly directory: WorkspaceBoundaryDirectoryCapability;
  readonly component: string;
  readonly maxBytes: number;
}

export interface WorkspaceBoundaryWriteFileRequest {
  readonly operationId: string;
  readonly directory: WorkspaceBoundaryDirectoryCapability;
  readonly component: string;
  readonly content: Uint8Array;
  /**
   * Explicit POSIX creation mode, where supported; not a portable ACL or secrecy claim.
   * Omission uses the backend's documented creation defaults. A backend that cannot
   * honor an explicit mode must reject it rather than silently treating it as a default.
   */
  readonly mode?: number;
  readonly exclusive?: boolean;
}

export interface WorkspaceBoundaryProcessRequest {
  readonly operationId: string;
  readonly executable: string;
  readonly args: readonly WorkspaceBoundaryProcessArgument[];
  readonly cwd: WorkspaceBoundaryDirectoryCapability;
  readonly env?: Readonly<Record<string, string>>;
  readonly extendEnv?: boolean;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly maxOutputBytes?: number;
}

export type WorkspaceBoundaryResult<T> =
  | { readonly ok: true; readonly value: T; readonly receipt: WorkspaceBoundaryOperationReceipt_v1 }
  | {
      readonly ok: false;
      readonly error: WorkspaceBoundaryError_v1;
      readonly receipt: WorkspaceBoundaryOperationReceipt_v1;
    };

export interface WorkspaceBoundaryLease {
  readonly [workspaceBoundaryLeaseBrand]: true;
  readonly acquired: WorkspaceBoundaryLeaseReceipt_v1;
  root(role: string): WorkspaceBoundaryDirectoryCapability;
  openChild(
    parent: WorkspaceBoundaryDirectoryCapability,
    component: string,
    operationId: string
  ): Promise<WorkspaceBoundaryResult<WorkspaceBoundaryDirectoryCapability>>;
  tryOpenChild(
    parent: WorkspaceBoundaryDirectoryCapability,
    component: string,
    operationId: string
  ): Promise<WorkspaceBoundaryResult<WorkspaceBoundaryDirectoryCapability | null>>;
  createChild(
    parent: WorkspaceBoundaryDirectoryCapability,
    component: string,
    operationId: string
  ): Promise<WorkspaceBoundaryResult<WorkspaceBoundaryDirectoryCapability>>;
  assertCurrent(
    directories: readonly WorkspaceBoundaryDirectoryCapability[],
    operationId: string
  ): Promise<WorkspaceBoundaryResult<readonly WorkspaceBoundaryDirectoryIdentity_v1[]>>;
  readFile(request: WorkspaceBoundaryReadFileRequest): Promise<WorkspaceBoundaryResult<Uint8Array>>;
  writeFile(request: WorkspaceBoundaryWriteFileRequest): Promise<WorkspaceBoundaryResult<void>>;
  runProcess(
    request: WorkspaceBoundaryProcessRequest
  ): Promise<WorkspaceBoundaryResult<CommandResult>>;
  close(
    reason: "completed" | "cancelled" | "expired" | "reconcile"
  ): Promise<WorkspaceBoundaryLeaseReceipt_v1>;
}

export interface WorkspaceBoundaryAcquireRequest {
  readonly operationId: string;
  readonly orchestrationLeaseId: string;
  readonly orchestrationLeaseRevision: number;
  readonly ownerId: string;
  readonly roots: ReadonlyArray<{ readonly role: string; readonly absolutePath: string }>;
}

export interface WorkspaceBoundary {
  readonly capability: WorkspaceBoundaryCapabilityDecision_v1;
  acquire(
    request: WorkspaceBoundaryAcquireRequest
  ): Promise<
    | { readonly ok: true; readonly lease: WorkspaceBoundaryLease }
    | { readonly ok: false; readonly error: WorkspaceBoundaryError_v1 }
  >;
}

/**
 * Production selection accepts only native capability discovery or an explicit
 * projection profile. It deliberately has no platform/backend override.
 */
export interface WorkspaceBoundaryResolver {
  resolve(
    request: WorkspaceBoundarySelectionRequest_v1
  ): Promise<
    | { readonly ok: true; readonly boundary: WorkspaceBoundary }
    | { readonly ok: false; readonly decision: WorkspaceBoundaryCapabilityDecision_v1 }
  >;
}

function requireValidCapabilityDecision(
  decision: z.output<z.ZodObject<typeof CapabilityDecisionShape>>,
  context: z.RefinementCtx
): void {
  const readyReason =
    decision.reason_code === "native_backend_ready" ||
    decision.reason_code === "explicit_projection_ready";
  if ((decision.state === "ready") !== readyReason) {
    addIssue(context, ["reason_code"], "ready state and reason code must agree");
  }
  if (
    decision.state === "ready" &&
    decision.selection.mode === "native" &&
    decision.reason_code !== "native_backend_ready"
  ) {
    addIssue(context, ["reason_code"], "native selection requires the native ready reason");
  }
  if (
    decision.state === "ready" &&
    decision.selection.mode === "explicit_projection" &&
    decision.reason_code !== "explicit_projection_ready"
  ) {
    addIssue(context, ["reason_code"], "projection selection requires the projection ready reason");
  }
  if (decision.selection.mode === "explicit_projection") {
    if (decision.backend_kind !== "native-wsl-projection") {
      addIssue(context, ["backend_kind"], "explicit projection must select the projection backend");
    }
  } else if (decision.backend_kind === "native-wsl-projection") {
    addIssue(context, ["backend_kind"], "projection selection must be explicit");
  }
  if (decision.state === "ready" && decision.backend_kind === "linux-native") {
    if (decision.host.platform !== "linux") {
      addIssue(context, ["host", "platform"], "Linux native requires a Linux host probe");
    }
    if (decision.host.path_comparison !== "case-sensitive") {
      addIssue(context, ["host", "path_comparison"], "Linux native requires case-sensitive paths");
    }
    if (decision.backend.transport !== "in_process") {
      addIssue(context, ["backend", "transport"], "Linux native uses the in-process boundary");
    }
  }
  if (decision.state === "ready" && decision.backend_kind === "windows-native") {
    if (decision.host.platform !== "windows") {
      addIssue(context, ["host", "platform"], "Windows native requires a Windows host probe");
    }
    if (decision.host.path_comparison !== "case-insensitive") {
      addIssue(
        context,
        ["host", "path_comparison"],
        "Windows native requires case-insensitive paths"
      );
    }
    if (decision.backend.transport !== "native_helper") {
      addIssue(context, ["backend", "transport"], "Windows native requires the native helper");
    }
  }
  if (decision.state === "ready") {
    const requiredClaims: Array<keyof z.output<typeof BoundaryClaims>> = [
      "held_directory_identity",
      "no_follow_open",
      "final_path_from_handle",
      "held_ancestor_chain",
      "replacement_resistant_process_binding",
    ];
    for (const claim of requiredClaims) {
      if (!decision.claims[claim]) {
        addIssue(context, ["claims", claim], "ready backends must enforce this claim");
      }
    }
  }
  if (
    decision.state === "ready" &&
    decision.backend.transport === "native_helper" &&
    (decision.backend.signature.status !== "verified" || !decision.backend.artifact_digest)
  ) {
    addIssue(
      context,
      ["backend", "signature"],
      "a ready native helper must have a verified signature and artifact digest"
    );
  }
}

function requireValidOperationReceipt(
  receipt: z.output<z.ZodObject<typeof OperationReceiptShape>>,
  context: z.RefinementCtx
): void {
  if ((receipt.outcome === "completed") === Boolean(receipt.error)) {
    addIssue(context, ["error"], "completed operations omit errors; other outcomes require one");
  }
  if (
    receipt.error?.operation_id !== undefined &&
    receipt.error.operation_id !== receipt.operation_id
  ) {
    addIssue(
      context,
      ["error", "operation_id"],
      "error operation_id must match receipt operation_id"
    );
  }
  if (!receipt.mutation && receipt.durability !== "not_applicable") {
    addIssue(context, ["durability"], "read-only operations use not_applicable durability");
  }
  if (receipt.outcome === "indeterminate" && receipt.durability !== "indeterminate") {
    addIssue(context, ["durability"], "indeterminate operations require indeterminate durability");
  }
  if (receipt.outcome === "completed" && receipt.durability === "indeterminate") {
    addIssue(context, ["durability"], "completed operations cannot have indeterminate durability");
  }
  if (receipt.outcome === "rejected" && receipt.error?.effect_state !== "no_effect") {
    addIssue(context, ["error", "effect_state"], "rejected operations must report no effect");
  }
  if (Date.parse(receipt.completed_at) < Date.parse(receipt.started_at)) {
    addIssue(context, ["completed_at"], "completed_at must not precede started_at");
  }
  if (receipt.mutation !== isMutationOperation(receipt.operation)) {
    addIssue(context, ["mutation"], "mutation must match the operation kind");
  }
}

function isMutationOperation(operation: WorkspaceBoundaryOperationKind): boolean {
  return (
    operation === "create-child" ||
    operation === "write-owned-file" ||
    operation === "rename-owned" ||
    operation === "remove-owned" ||
    operation === "sync-directory"
  );
}

function isWindowsAbsolutePath(value: string): boolean {
  return (
    /^[a-z]:[\\/]/iu.test(value) ||
    /^\\\\[^\\/\0]+[\\/][^\\/\0]+(?:[\\/]|$)/u.test(value) ||
    /^\\\\\?\\/u.test(value)
  );
}

function boundaryHash(domain: string, body: unknown): string {
  return computeCanonicalHash(["lexrunner-workspace-boundary-v1", domain, body]);
}

function requireDigest(
  actual: string,
  expected: string,
  field: string,
  context: z.RefinementCtx
): void {
  if (actual !== expected) addIssue(context, [field], `${field} does not match canonical content`);
}

function copyIssues(result: z.ZodSafeParseResult<unknown>, context: z.RefinementCtx): void {
  if (result.success) return;
  for (const issue of result.error.issues) {
    context.addIssue({ code: "custom", path: issue.path, message: issue.message });
  }
}

function addIssue(context: z.RefinementCtx, path: PropertyKey[], message: string): void {
  context.addIssue({ code: "custom", path, message });
}
