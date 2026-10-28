import { z } from "zod";

import { AgentTaskPacket_v1, AuthorityEnvelope } from "../schemas/agent-work.js";
import { computeCanonicalHash } from "../schemas/task-contract.js";

export const WINDOWS_COORDINATOR_ADMISSION_VERSION = "windows-attempt-admission/1";
export const WINDOWS_COORDINATOR_ENROLLMENT_VERSION = "windows-coordinator-enrollment/1";
export const WINDOWS_COORDINATOR_INTENT_VERSION = "windows-attempt-intent/1";

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const sid = z
  .string()
  .min(7)
  .max(184)
  .regex(/^S-1-(?:[0-9]+-){1,14}[0-9]+$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const instant = z.string().datetime({ offset: true });
const revision = z.number().int().nonnegative().safe();
const volumeProfile = z.enum(["NTFS", "ReFS"]);

/**
 * Protected provisioning data, once an installed service exists. A caller can
 * construct matching bytes in a source fixture; that is not authentication.
 */
export const WindowsCoordinatorEnrollmentBody_v1 = z
  .object({
    schema_version: z.literal(WINDOWS_COORDINATOR_ENROLLMENT_VERSION),
    enrollment_id: id,
    policy_revision: revision.min(1),
    status: z.enum(["active", "revoked"]),
    client_sid: sid,
    repository_id: z.string().min(1).max(256),
    repository_identity_digest: digest,
    allocation_root_identity_digest: digest,
    volume_profile: volumeProfile,
    allowed_operation_classes: z.array(z.literal("attempt.prepare")).min(1).max(1),
    authority_ceiling: AuthorityEnvelope,
    allowed_packet_effects_digest: digest,
    helper_generation_digest: digest,
    git_profile_digest: digest,
    updated_at: instant,
  })
  .strict();

export const WindowsCoordinatorEnrollment_v1 = WindowsCoordinatorEnrollmentBody_v1.extend({
  enrollment_digest: digest,
})
  .strict()
  .superRefine((record, context) => {
    const { enrollment_digest: _digest, ...body } = record;
    if (computeCanonicalHash(body) !== record.enrollment_digest)
      context.addIssue({ code: "custom", path: ["enrollment_digest"], message: "digest mismatch" });
  });
export type WindowsCoordinatorEnrollment_v1 = z.infer<typeof WindowsCoordinatorEnrollment_v1>;

/** Exact approved effect profile; never derive an approved value from a client request. */
export function windowsPacketEffectsDigest(packet: z.infer<typeof AgentTaskPacket_v1>): string {
  return computeCanonicalHash({
    scope: packet.scope,
    authority: packet.authority,
    preparation: packet.preparation ?? null,
    verification: packet.verification,
    budget: packet.budget,
  });
}

export const WindowsCoordinatorReservationInput_v1 = z
  .object({
    enrollment_id: id,
    /** Test fixtures supply this value synthetically. Only a future protected host may obtain it from a client token. */
    observed_client_sid: sid,
    client_idempotency_key: id,
    packet: AgentTaskPacket_v1,
    expected_policy_revision: revision.min(1),
    observed_repository_identity_digest: digest,
    observed_allocation_root_identity_digest: digest,
    observed_volume_profile: volumeProfile,
    /** The service obtains this lease from its protected coordination store, not from the client frame. */
    controller: z
      .object({
        run_id: id,
        controller_id: id,
        lease_id: id,
        fencing_token: revision.min(1),
        expected_run_revision: revision,
      })
      .strict(),
    now: instant,
  })
  .strict();
export type WindowsCoordinatorReservationInput_v1 = z.infer<
  typeof WindowsCoordinatorReservationInput_v1
>;

export const WindowsAttemptAdmissionBody_v1 = z
  .object({
    schema_version: z.literal(WINDOWS_COORDINATOR_ADMISSION_VERSION),
    operation_id: z.string().uuid(),
    enrollment_id: id,
    enrollment_digest: digest,
    policy_revision: revision.min(1),
    client_sid: sid,
    client_idempotency_key: id,
    request_digest: digest,
    packet_hash: digest,
    packet_snapshot_digest: digest,
    requested_run_id: id,
    requested_attempt_id: id,
    repository_id: z.string().min(1).max(256),
    base_sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
    repository_identity_digest: digest,
    allocation_root_identity_digest: digest,
    volume_profile: volumeProfile,
    packet_effects_digest: digest,
    helper_generation_digest: digest,
    git_profile_digest: digest,
    controller: WindowsCoordinatorReservationInput_v1.shape.controller,
    controller_expires_at: instant,
    created_at: instant,
    disposition: z.literal("source_only_candidate"),
    effect_state: z.literal("no_effect"),
    authorizes_execution: z.literal(false),
  })
  .strict();

export const WindowsAttemptAdmission_v1 = WindowsAttemptAdmissionBody_v1.extend({
  admission_digest: digest,
})
  .strict()
  .superRefine((record, context) => {
    const { admission_digest: _digest, ...body } = record;
    if (computeCanonicalHash(body) !== record.admission_digest)
      context.addIssue({ code: "custom", path: ["admission_digest"], message: "digest mismatch" });
  });
export type WindowsAttemptAdmission_v1 = z.infer<typeof WindowsAttemptAdmission_v1>;

export const WindowsAttemptIntentBody_v1 = z
  .object({
    schema_version: z.literal(WINDOWS_COORDINATOR_INTENT_VERSION),
    operation_id: z.string().uuid(),
    admission_digest: digest,
    revision,
    status: z.enum(["candidate", "indeterminate"]),
    effect_state: z.enum(["no_effect", "effect_unknown"]),
    authorizes_execution: z.literal(false),
    created_at: instant,
    updated_at: instant,
  })
  .strict()
  .superRefine((record, context) => {
    if (
      (record.status === "candidate" &&
        (record.revision !== 0 || record.effect_state !== "no_effect")) ||
      (record.status === "indeterminate" &&
        (record.revision !== 1 || record.effect_state !== "effect_unknown"))
    )
      context.addIssue({ code: "custom", message: "intent state mismatch" });
  });

export const WindowsAttemptIntent_v1 = WindowsAttemptIntentBody_v1.safeExtend({
  intent_digest: digest,
}).superRefine((record, context) => {
  const { intent_digest: _digest, ...body } = record;
  if (computeCanonicalHash(body) !== record.intent_digest)
    context.addIssue({ code: "custom", path: ["intent_digest"], message: "digest mismatch" });
});
export type WindowsAttemptIntent_v1 = z.infer<typeof WindowsAttemptIntent_v1>;
