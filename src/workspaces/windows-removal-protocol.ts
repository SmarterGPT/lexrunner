import { z } from "zod";

/** Additive opt-in feature. The v2 hello alone does not imply removal support. */
export const WINDOWS_REMOVAL_VERSION = "1.0.0" as const;
const token = z.string().regex(/^[a-f0-9]{64}$/u);
export const WindowsRemovalDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const WindowsRemovalIdentity = z.strictObject({
  path: z.string().min(3).max(1024),
  file_id: z.string().regex(/^[a-f0-9]{32}$/u),
  volume_serial_number: z.string().regex(/^[a-f0-9]{16}$/u),
  filesystem: z.enum(["NTFS", "ReFS"]),
});
export const WindowsRemovalExecutorId = z
  .string()
  .regex(/^windows:[1-9][0-9]{0,9}:[a-f0-9]{16}:[a-f0-9]{32}$/u);
const component = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (s) => !/[\u0000-\u001f<>:"/\\|?*]/u.test(s) && !/[. ]$/u.test(s) && s !== "." && s !== ".."
  );
const selection = {
  root_parent_token: token,
  registration_parent_token: token,
  slot_parent_token: token,
  root_component: component,
  registration_component: component,
  slot_component: component,
  root_identity: WindowsRemovalIdentity,
  registration_identity: WindowsRemovalIdentity,
  slot_identity: WindowsRemovalIdentity,
  slot_content_sha256: WindowsRemovalDigest,
};
export const WindowsRemovalPrepare = z.strictObject({
  ...selection,
  operation: z.literal("prepare"),
  marker_sha256: WindowsRemovalDigest,
  git_executable: z.string().min(3).max(1024),
});
export const WindowsRemovalRecover = z.strictObject({
  ...selection,
  operation: z.literal("recover"),
  previous_executor_id: WindowsRemovalExecutorId,
});
export const WindowsRemovalPayload = z.discriminatedUnion("operation", [
  WindowsRemovalPrepare,
  WindowsRemovalRecover,
  z.strictObject({
    operation: z.literal("commit"),
    removal_token: token,
    admission_digest: WindowsRemovalDigest,
    timeout_ms: z.number().int().min(1).max(30_000),
    maximum_deletes: z.number().int().min(1).max(4096),
  }),
  z.strictObject({ operation: z.literal("release"), removal_token: token }),
]);
const treeOutcome = z.enum([
  "selected_tree_removed",
  "budget_exhausted",
  "disposition_rejected",
  "effect_unknown",
]);
export const WindowsRemovalCleanGit = z.strictObject({
  executable: z.string().min(3).max(1024),
  cwd: z.string().min(3).max(1024),
  arguments: z.array(z.string().max(2048)).max(64),
  process_id: z.number().int().positive().max(0xffffffff),
  duration_ms: z.number().int().nonnegative().safe(),
  exit_code: z.literal(0),
  job_empty: z.literal(true),
  stdout_sha256: WindowsRemovalDigest,
  stderr_sha256: WindowsRemovalDigest,
});
export const WindowsRemovalResultPayload = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("prepare"),
    status: z.literal("prepared"),
    removal_token: token,
    executor_id: WindowsRemovalExecutorId,
    clean_git: WindowsRemovalCleanGit,
    root_identity: WindowsRemovalIdentity,
    registration_identity: WindowsRemovalIdentity,
    root_entries: z.number().int().min(1).max(4096),
    registration_entries: z.number().int().min(1).max(256),
    root_inventory_sha256: WindowsRemovalDigest,
    registration_inventory_sha256: WindowsRemovalDigest,
    selection_sha256: WindowsRemovalDigest,
  }),
  z.strictObject({
    operation: z.literal("commit"),
    status: z.enum(["selected_trees_removed", "partial"]),
    removal_token: token,
    admission_digest: WindowsRemovalDigest,
    root_deleted: z.number().int().min(0).max(4096),
    registration_deleted: z.number().int().min(0).max(256),
    root_native_error: z.number().int().min(0).max(0xffffffff).nullable(),
    registration_native_error: z.number().int().min(0).max(0xffffffff).nullable(),
    root_outcome: treeOutcome,
    registration_outcome: z.union([treeOutcome, z.literal("not_started")]),
  }),
  z.strictObject({
    operation: z.literal("recover"),
    status: z.literal("observed"),
    removal_token: token,
    executor_state: z.enum(["gone", "alive", "unknown"]),
    root_identity: WindowsRemovalIdentity.nullable(),
    registration_identity: WindowsRemovalIdentity.nullable(),
    contents: z.enum(["remaining", "empty", "unknown"]),
    registration_locked: z.boolean(),
  }),
  z.strictObject({
    operation: z.literal("release"),
    status: z.literal("released"),
    removal_token: token,
  }),
]);
export type WindowsRemovalPayload = z.infer<typeof WindowsRemovalPayload>;
export type WindowsRemovalResultPayload = z.infer<typeof WindowsRemovalResultPayload>;
export type WindowsRemovalIdentity = z.infer<typeof WindowsRemovalIdentity>;
