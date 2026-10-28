import { Buffer } from "node:buffer";

import type { Database } from "better-sqlite3-multiple-ciphers";
import { z } from "zod";

import { AgentTaskPacket_v1 } from "../../src/schemas/agent-work.js";
import { computeCanonicalHash } from "../../src/schemas/task-contract.js";
import { canonicalJSONStringify } from "../../src/util/canonicalJson.js";
import {
  WindowsAttemptAdmission_v1,
  WindowsAttemptIntentBody_v1,
  WindowsAttemptIntent_v1,
  WindowsCoordinatorEnrollment_v1,
  windowsPacketEffectsDigest,
  type WindowsAttemptIntent_v1 as Intent,
} from "../../src/windows-coordinator/admission-contract.js";

const MAX_RECORD_BYTES = 65_536;
const latchInput = z.strictObject({
  operation_id: z.string().uuid(),
  admission_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  now: z.string().datetime({ offset: true }),
});

export type SyntheticUncertaintyLatchResult = {
  readonly kind: "effect_unknown_latched" | "historical_effect_unknown";
  readonly intent: Intent;
  readonly authorizes_execution: false;
};

function verifiedRecord<T>(schema: z.ZodType<T>, bytes: string): T {
  if (Buffer.byteLength(bytes, "utf8") > MAX_RECORD_BYTES)
    throw new Error("synthetic_admission_corrupt_record");
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new Error("synthetic_admission_corrupt_record");
  }
  const record = schema.parse(value);
  if (canonicalJSONStringify(record) !== bytes)
    throw new Error("synthetic_admission_corrupt_record");
  return record;
}

/**
 * Source-only transaction exercise over the #1077 fixture schema. The caller
 * supplies the SQLite connection and clock; neither is protected here. This
 * function never dispatches or returns an execution grant. An unknown-effect
 * intent must be committed before any future effectful phase begins.
 */
export function latchSyntheticEffectUnknown(
  db: Database,
  inputValue: unknown
): SyntheticUncertaintyLatchResult {
  const input = latchInput.parse(inputValue);
  return db
    .transaction(() => {
      const operation = db
        .prepare(
          "SELECT operationId,admissionDigest,substr(admissionJson,1,65537) AS admissionJson,substr(packetJson,1,65537) AS packetJson FROM windows_attempt_admissions WHERE operationId=?"
        )
        .get(input.operation_id) as
        | {
            operationId: string;
            admissionDigest: string;
            admissionJson: string;
            packetJson: string;
          }
        | undefined;
      // An absent or ambiguous record has no safe public no_effect result.
      if (!operation) throw new Error("synthetic_admission_operation_unverified");
      const admission = verifiedRecord(WindowsAttemptAdmission_v1, operation.admissionJson);
      const packet = verifiedRecord(AgentTaskPacket_v1, operation.packetJson);
      if (
        operation.operationId !== admission.operation_id ||
        operation.admissionDigest !== admission.admission_digest ||
        input.admission_digest !== admission.admission_digest ||
        packet.packet_hash !== admission.packet_hash ||
        computeCanonicalHash(packet) !== admission.packet_snapshot_digest ||
        windowsPacketEffectsDigest(packet) !== admission.packet_effects_digest ||
        packet.run_id !== admission.requested_run_id ||
        packet.attempt_id !== admission.requested_attempt_id ||
        packet.repository.id !== admission.repository_id ||
        packet.repository.base_sha !== admission.base_sha
      )
        throw new Error("synthetic_admission_operation_unverified");

      const current = db
        .prepare(
          "SELECT revision,status,intentDigest,substr(intentJson,1,65537) AS intentJson FROM windows_attempt_intents WHERE operationId=?"
        )
        .get(input.operation_id) as
        { revision: number; status: string; intentDigest: string; intentJson: string } | undefined;
      if (!current) throw new Error("synthetic_admission_intent_unverified");
      const intent = verifiedRecord(WindowsAttemptIntent_v1, current.intentJson);
      const events = db
        .prepare(
          "SELECT revision,intentDigest,substr(intentJson,1,65537) AS intentJson FROM windows_attempt_intent_events WHERE operationId=? ORDER BY revision LIMIT 3"
        )
        .all(input.operation_id) as Array<{
        revision: number;
        intentDigest: string;
        intentJson: string;
      }>;
      if (
        intent.operation_id !== admission.operation_id ||
        intent.admission_digest !== admission.admission_digest ||
        intent.revision !== current.revision ||
        intent.status !== current.status ||
        intent.intent_digest !== current.intentDigest ||
        events.length !== intent.revision + 1 ||
        events[events.length - 1]?.intentJson !== current.intentJson ||
        events[events.length - 1]?.intentDigest !== current.intentDigest
      )
        throw new Error("synthetic_admission_intent_unverified");
      let prior: Intent | undefined;
      for (const [revision, event] of events.entries()) {
        const observed = verifiedRecord(WindowsAttemptIntent_v1, event.intentJson);
        if (
          event.revision !== revision ||
          event.intentDigest !== observed.intent_digest ||
          observed.revision !== revision ||
          observed.operation_id !== admission.operation_id ||
          observed.admission_digest !== admission.admission_digest ||
          observed.created_at !== intent.created_at ||
          (prior && Date.parse(observed.updated_at) < Date.parse(prior.updated_at))
        )
          throw new Error("synthetic_admission_intent_unverified");
        prior = observed;
      }
      if (intent.status === "indeterminate")
        return {
          kind: "historical_effect_unknown" as const,
          intent,
          authorizes_execution: false as const,
        };
      if (intent.status !== "candidate" || Date.parse(input.now) < Date.parse(intent.updated_at))
        throw new Error("synthetic_admission_intent_unverified");

      const policyRow = db
        .prepare(
          "SELECT revision,status,clientSid,enrollmentDigest,substr(enrollmentJson,1,65537) AS enrollmentJson FROM windows_coordinator_enrollments WHERE enrollmentId=?"
        )
        .get(admission.enrollment_id) as
        | {
            revision: number;
            status: string;
            clientSid: string;
            enrollmentDigest: string;
            enrollmentJson: string;
          }
        | undefined;
      if (!policyRow) throw new Error("synthetic_admission_policy_unverified");
      const policy = verifiedRecord(WindowsCoordinatorEnrollment_v1, policyRow.enrollmentJson);
      if (
        policy.enrollment_id !== admission.enrollment_id ||
        policy.enrollment_digest !== admission.enrollment_digest ||
        policyRow.enrollmentDigest !== policy.enrollment_digest ||
        policyRow.revision !== policy.policy_revision ||
        policyRow.status !== policy.status ||
        policyRow.clientSid !== policy.client_sid ||
        policy.status !== "active" ||
        policy.policy_revision !== admission.policy_revision ||
        policy.client_sid !== admission.client_sid ||
        policy.repository_id !== admission.repository_id ||
        policy.repository_identity_digest !== admission.repository_identity_digest ||
        policy.allocation_root_identity_digest !== admission.allocation_root_identity_digest ||
        policy.volume_profile !== admission.volume_profile ||
        policy.allowed_packet_effects_digest !== admission.packet_effects_digest ||
        policy.helper_generation_digest !== admission.helper_generation_digest ||
        policy.git_profile_digest !== admission.git_profile_digest
      )
        throw new Error("synthetic_admission_policy_unverified");

      const fence = db
        .prepare(
          "SELECT revision,controllerId,leaseId,fencingToken,expiresAt FROM run_coordination WHERE runId=?"
        )
        .get(admission.requested_run_id) as
        | {
            revision: number;
            controllerId: string | null;
            leaseId: string | null;
            fencingToken: number;
            expiresAt: string | null;
          }
        | undefined;
      if (
        !fence ||
        admission.controller.run_id !== admission.requested_run_id ||
        fence.revision !== admission.controller.expected_run_revision ||
        fence.controllerId !== admission.controller.controller_id ||
        fence.leaseId !== admission.controller.lease_id ||
        fence.fencingToken !== admission.controller.fencing_token ||
        !fence.expiresAt ||
        !Number.isFinite(Date.parse(fence.expiresAt)) ||
        Date.parse(fence.expiresAt) <= Date.parse(input.now)
      )
        throw new Error("synthetic_admission_fence_unverified");

      const body = WindowsAttemptIntentBody_v1.parse({
        schema_version: "windows-attempt-intent/1",
        operation_id: admission.operation_id,
        admission_digest: admission.admission_digest,
        revision: 1,
        status: "indeterminate",
        effect_state: "effect_unknown",
        authorizes_execution: false,
        created_at: intent.created_at,
        updated_at: input.now,
      });
      const next = WindowsAttemptIntent_v1.parse({
        ...body,
        intent_digest: computeCanonicalHash(body),
      });
      db.prepare(
        "INSERT INTO windows_attempt_intent_events (operationId,revision,intentJson,intentDigest) VALUES (?,?,?,?)"
      ).run(next.operation_id, 1, canonicalJSONStringify(next), next.intent_digest);
      const updated = db
        .prepare(
          "UPDATE windows_attempt_intents SET revision=1,status='indeterminate',intentJson=?,intentDigest=? WHERE operationId=? AND revision=0 AND intentDigest=?"
        )
        .run(
          canonicalJSONStringify(next),
          next.intent_digest,
          next.operation_id,
          intent.intent_digest
        );
      if (updated.changes !== 1) throw new Error("synthetic_admission_intent_unverified");
      return {
        kind: "effect_unknown_latched" as const,
        intent: next,
        authorizes_execution: false as const,
      };
    })
    .immediate();
}
