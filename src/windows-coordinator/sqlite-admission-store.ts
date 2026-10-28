import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { AgentTaskPacket_v1 } from "../schemas/agent-work.js";
import { computeCanonicalHash } from "../schemas/task-contract.js";
import type { SqliteCoordinationStoreOptions } from "../store/sqlite/coordination-store.js";
import { SqliteWorkspaceLifecycleStore } from "../store/sqlite/workspace-lifecycle-store.js";
import { canonicalJSONStringify } from "../util/canonicalJson.js";
import {
  WindowsAttemptAdmissionBody_v1,
  WindowsAttemptAdmission_v1,
  WindowsAttemptIntentBody_v1,
  WindowsAttemptIntent_v1,
  WindowsCoordinatorEnrollment_v1,
  WindowsCoordinatorReservationInput_v1,
  windowsPacketEffectsDigest,
  type WindowsAttemptAdmission_v1 as Admission,
  type WindowsAttemptIntent_v1 as Intent,
} from "./admission-contract.js";
import { WINDOWS_COORDINATOR_MAX_FRAME_BYTES } from "./client-protocol.js";

const MAX_RECORD_BYTES = 65_536;

const MIGRATION = `
CREATE TABLE IF NOT EXISTS windows_coordinator_enrollments (
 enrollmentId TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0),
 status TEXT NOT NULL CHECK(status IN ('active','revoked')), clientSid TEXT NOT NULL,
 enrollmentJson TEXT NOT NULL CHECK(length(enrollmentJson)<=65536), enrollmentDigest TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS windows_attempt_admissions (
 operationId TEXT PRIMARY KEY, enrollmentId TEXT NOT NULL, clientSid TEXT NOT NULL,
 clientIdempotencyKey TEXT NOT NULL, requestedAttemptId TEXT NOT NULL UNIQUE, requestDigest TEXT NOT NULL,
 packetJson TEXT NOT NULL CHECK(length(packetJson)<=65536),
 admissionJson TEXT NOT NULL CHECK(length(admissionJson)<=65536), admissionDigest TEXT NOT NULL,
 UNIQUE(enrollmentId,clientSid,clientIdempotencyKey),
 FOREIGN KEY(enrollmentId) REFERENCES windows_coordinator_enrollments(enrollmentId) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS windows_attempt_intents (
 operationId TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>=0),
 status TEXT NOT NULL CHECK(status IN ('candidate','indeterminate')),
 intentJson TEXT NOT NULL CHECK(length(intentJson)<=65536), intentDigest TEXT NOT NULL,
 FOREIGN KEY(operationId) REFERENCES windows_attempt_admissions(operationId) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS windows_attempt_intent_events (
 operationId TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0),
 intentJson TEXT NOT NULL CHECK(length(intentJson)<=65536), intentDigest TEXT NOT NULL,
 PRIMARY KEY(operationId,revision),
 FOREIGN KEY(operationId) REFERENCES windows_attempt_intents(operationId) ON DELETE RESTRICT
);
`;

interface EnrollmentRow {
  enrollmentJson: string;
  enrollmentDigest: string;
  revision: number;
  status: string;
  clientSid: string;
}

interface OperationRow {
  operationId: string;
  enrollmentId: string;
  clientSid: string;
  clientIdempotencyKey: string;
  requestedAttemptId: string;
  requestDigest: string;
  packetJson: string;
  admissionJson: string;
  admissionDigest: string;
  intentJson: string | null;
  intentDigest: string | null;
  status: string | null;
  revision: number | null;
}

export type WindowsAdmissionReservationResult =
  | {
      kind: "candidate_recorded" | "historical_replay";
      admission: Admission;
      intent: Intent;
      authorizes_execution: false;
    }
  | {
      kind: "rejected";
      reason:
        | "invalid_input"
        | "store_read_only"
        | "missing_enrollment"
        | "stale_policy"
        | "policy_revoked"
        | "client_sid_mismatch"
        | "repository_mismatch"
        | "root_identity_mismatch"
        | "unsupported_volume"
        | "packet_effects_mismatch"
        | "authority_ceiling_exceeded"
        | "controller_missing"
        | "controller_mismatch"
        | "stale_fence"
        | "stale_run_revision"
        | "controller_expired"
        | "attempt_binding_mismatch"
        | "attempt_already_recorded"
        | "changed_input_replay";
      authorizes_execution: false;
    };

const rejected = (
  reason: Extract<WindowsAdmissionReservationResult, { kind: "rejected" }>["reason"]
): WindowsAdmissionReservationResult => ({ kind: "rejected", reason, authorizes_execution: false });

/**
 * Source-only SQLite consistency fixture. Its path, enrollment bytes, observed SID,
 * and identity digests are supplied data, not protected provisioning or an OS
 * attestation. No public adapter, resolver, transport, broker, or child launches
 * through this class. A future installed service must protect the complete DB
 * and ancestor chain and obtain the peer SID from the actual client token.
 */
export class SqliteWindowsCoordinatorAdmissionStore extends SqliteWorkspaceLifecycleStore {
  private readonly readOnly: boolean;

  constructor(path: string, options: SqliteCoordinationStoreOptions = {}) {
    super(path, options);
    this.readOnly = options.readOnly ?? false;
    if (!this.readOnly) {
      try {
        this.immediateTransaction(() => this.db.exec(MIGRATION));
      } catch (error) {
        this.db.close();
        throw error;
      }
    }
  }

  /** Atomically record an incomplete candidate and no-effect intent, never a dispatch grant. */
  recordCandidate(inputValue: unknown): WindowsAdmissionReservationResult {
    if (this.readOnly) return rejected("store_read_only");
    let input: z.infer<typeof WindowsCoordinatorReservationInput_v1>;
    try {
      input = WindowsCoordinatorReservationInput_v1.parse(inputValue);
      if (
        Buffer.byteLength(canonicalJSONStringify(input.packet), "utf8") >
        Math.min(WINDOWS_COORDINATOR_MAX_FRAME_BYTES, MAX_RECORD_BYTES)
      )
        return rejected("invalid_input");
    } catch {
      return rejected("invalid_input");
    }
    // The client request is stable across retries; controller credentials and
    // expected policy revision are service-side observations, not replay keys.
    const requestDigest = computeCanonicalHash({
      enrollment_id: input.enrollment_id,
      observed_client_sid: input.observed_client_sid,
      client_idempotency_key: input.client_idempotency_key,
      packet: input.packet,
      observed_repository_identity_digest: input.observed_repository_identity_digest,
      observed_allocation_root_identity_digest: input.observed_allocation_root_identity_digest,
      observed_volume_profile: input.observed_volume_profile,
    });

    return this.immediateTransaction(() => {
      const prior = this.operationByKey(
        input.enrollment_id,
        input.observed_client_sid,
        input.client_idempotency_key
      );
      if (prior) {
        if (prior.row.requestDigest !== requestDigest) return rejected("changed_input_replay");
        return {
          kind: "historical_replay",
          admission: prior.admission,
          intent: prior.intent,
          authorizes_execution: false,
        };
      }

      if (this.operationByAttempt(input.packet.attempt_id))
        return rejected("attempt_already_recorded");

      const enrollment = this.enrollment(input.enrollment_id);
      if (!enrollment) return rejected("missing_enrollment");
      if (enrollment.policy_revision !== input.expected_policy_revision)
        return rejected("stale_policy");
      if (enrollment.status !== "active") return rejected("policy_revoked");
      if (enrollment.client_sid !== input.observed_client_sid)
        return rejected("client_sid_mismatch");
      if (enrollment.repository_id !== input.packet.repository.id)
        return rejected("repository_mismatch");
      if (
        enrollment.repository_identity_digest !== input.observed_repository_identity_digest ||
        enrollment.allocation_root_identity_digest !==
          input.observed_allocation_root_identity_digest
      )
        return rejected("root_identity_mismatch");
      if (enrollment.volume_profile !== input.observed_volume_profile)
        return rejected("unsupported_volume");
      if (enrollment.allowed_packet_effects_digest !== windowsPacketEffectsDigest(input.packet))
        return rejected("packet_effects_mismatch");
      if (
        Object.entries(input.packet.authority).some(
          ([name, granted]) =>
            granted &&
            !enrollment.authority_ceiling[name as keyof typeof enrollment.authority_ceiling]
        )
      )
        return rejected("authority_ceiling_exceeded");
      const controller = this.db
        .prepare(
          `SELECT revision,controllerId,leaseId,fencingToken,expiresAt
           FROM run_coordination WHERE runId=?`
        )
        .get(input.controller.run_id) as
        | {
            revision: number;
            controllerId: string | null;
            leaseId: string | null;
            fencingToken: number;
            expiresAt: string | null;
          }
        | undefined;
      if (!controller) return rejected("controller_missing");
      if (input.controller.run_id !== input.packet.run_id) return rejected("controller_mismatch");
      if (controller.fencingToken !== input.controller.fencing_token)
        return rejected("stale_fence");
      if (
        controller.controllerId !== input.controller.controller_id ||
        controller.leaseId !== input.controller.lease_id
      )
        return rejected("controller_mismatch");
      if (controller.revision !== input.controller.expected_run_revision)
        return rejected("stale_run_revision");
      if (
        !controller.expiresAt ||
        !Number.isFinite(Date.parse(controller.expiresAt)) ||
        Date.parse(controller.expiresAt) <= Date.parse(input.now)
      )
        return rejected("controller_expired");

      // An existing lifecycle Attempt must already have an exact immutable
      // packet snapshot. A first candidate can precede Attempt creation;
      // its own exact snapshot is inserted with the candidate below.
      const attempt = this.db
        .prepare(
          `SELECT runId,workItemId,workItemRevision,packetId,packetHash,baseSha
           FROM attempts WHERE attemptId=?`
        )
        .get(input.packet.attempt_id) as
        | {
            runId: string;
            workItemId: string;
            workItemRevision: number;
            packetId: string;
            packetHash: string;
            baseSha: string;
          }
        | undefined;
      if (attempt) {
        const binding = this.db
          .prepare(
            `SELECT runId,workItemId,workItemRevision,packetId,packetHash,
                    substr(packetJson,1,65537) AS packetJson
             FROM task_packet_bindings WHERE attemptId=?`
          )
          .get(input.packet.attempt_id) as
          | {
              runId: string;
              workItemId: string;
              workItemRevision: number;
              packetId: string;
              packetHash: string;
              packetJson: string;
            }
          | undefined;
        if (
          attempt.runId !== input.packet.run_id ||
          attempt.workItemId !== input.packet.work_item.work_item_id ||
          attempt.workItemRevision !== input.packet.work_item.revision ||
          attempt.packetId !== input.packet.packet_id ||
          attempt.packetHash !== input.packet.packet_hash ||
          attempt.baseSha !== input.packet.repository.base_sha ||
          !binding ||
          binding.runId !== attempt.runId ||
          binding.workItemId !== attempt.workItemId ||
          binding.workItemRevision !== attempt.workItemRevision ||
          binding.packetId !== attempt.packetId ||
          binding.packetHash !== attempt.packetHash ||
          binding.packetJson !== canonicalJSONStringify(input.packet)
        )
          return rejected("attempt_binding_mismatch");
      }

      const body = WindowsAttemptAdmissionBody_v1.parse({
        schema_version: "windows-attempt-admission/1",
        operation_id: randomUUID(),
        enrollment_id: enrollment.enrollment_id,
        enrollment_digest: enrollment.enrollment_digest,
        policy_revision: enrollment.policy_revision,
        client_sid: input.observed_client_sid,
        client_idempotency_key: input.client_idempotency_key,
        request_digest: requestDigest,
        packet_hash: input.packet.packet_hash,
        packet_snapshot_digest: computeCanonicalHash(input.packet),
        requested_run_id: input.packet.run_id,
        requested_attempt_id: input.packet.attempt_id,
        repository_id: input.packet.repository.id,
        base_sha: input.packet.repository.base_sha,
        repository_identity_digest: input.observed_repository_identity_digest,
        allocation_root_identity_digest: input.observed_allocation_root_identity_digest,
        volume_profile: input.observed_volume_profile,
        packet_effects_digest: windowsPacketEffectsDigest(input.packet),
        helper_generation_digest: enrollment.helper_generation_digest,
        git_profile_digest: enrollment.git_profile_digest,
        controller: input.controller,
        controller_expires_at: controller.expiresAt,
        created_at: input.now,
        disposition: "source_only_candidate",
        effect_state: "no_effect",
        authorizes_execution: false,
      });
      const admission = WindowsAttemptAdmission_v1.parse({
        ...body,
        admission_digest: computeCanonicalHash(body),
      });
      const intentBody = WindowsAttemptIntentBody_v1.parse({
        schema_version: "windows-attempt-intent/1",
        operation_id: admission.operation_id,
        admission_digest: admission.admission_digest,
        revision: 0,
        status: "candidate",
        effect_state: "no_effect",
        authorizes_execution: false,
        created_at: input.now,
        updated_at: input.now,
      });
      const intent = WindowsAttemptIntent_v1.parse({
        ...intentBody,
        intent_digest: computeCanonicalHash(intentBody),
      });
      this.db
        .prepare(
          `INSERT INTO windows_attempt_admissions
           (operationId,enrollmentId,clientSid,clientIdempotencyKey,requestedAttemptId,requestDigest,packetJson,admissionJson,admissionDigest)
           VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(
          admission.operation_id,
          admission.enrollment_id,
          admission.client_sid,
          admission.client_idempotency_key,
          admission.requested_attempt_id,
          admission.request_digest,
          canonicalJSONStringify(input.packet),
          canonicalJSONStringify(admission),
          admission.admission_digest
        );
      this.db
        .prepare(
          `INSERT INTO windows_attempt_intents
           (operationId,revision,status,intentJson,intentDigest) VALUES (?,?,?,?,?)`
        )
        .run(
          intent.operation_id,
          intent.revision,
          intent.status,
          canonicalJSONStringify(intent),
          intent.intent_digest
        );
      this.db
        .prepare(
          `INSERT INTO windows_attempt_intent_events
           (operationId,revision,intentJson,intentDigest) VALUES (?,?,?,?)`
        )
        .run(intent.operation_id, 0, canonicalJSONStringify(intent), intent.intent_digest);
      return { kind: "candidate_recorded", admission, intent, authorizes_execution: false };
    });
  }

  private enrollment(enrollmentId: string): z.infer<typeof WindowsCoordinatorEnrollment_v1> | null {
    const row = this.db
      .prepare(
        `SELECT substr(enrollmentJson,1,65537) AS enrollmentJson,enrollmentDigest,revision,status,clientSid
         FROM windows_coordinator_enrollments WHERE enrollmentId=?`
      )
      .get(enrollmentId) as EnrollmentRow | undefined;
    if (!row) return null;
    const record = parseRecord(WindowsCoordinatorEnrollment_v1, row.enrollmentJson);
    if (
      record.enrollment_id !== enrollmentId ||
      record.enrollment_digest !== row.enrollmentDigest ||
      record.policy_revision !== row.revision ||
      record.status !== row.status ||
      record.client_sid !== row.clientSid
    )
      throw new Error("Corrupt Windows coordinator enrollment");
    return record;
  }

  private operationByKey(enrollmentId: string, clientSid: string, key: string) {
    const row = this.db
      .prepare(
        `SELECT a.operationId,a.enrollmentId,a.clientSid,a.clientIdempotencyKey,a.requestedAttemptId,a.requestDigest,
                substr(a.packetJson,1,65537) AS packetJson,
                substr(a.admissionJson,1,65537) AS admissionJson,a.admissionDigest,
                substr(i.intentJson,1,65537) AS intentJson,i.intentDigest,i.status,i.revision
         FROM windows_attempt_admissions AS a
         LEFT JOIN windows_attempt_intents AS i ON i.operationId=a.operationId
         WHERE a.enrollmentId=? AND a.clientSid=? AND a.clientIdempotencyKey=?`
      )
      .get(enrollmentId, clientSid, key) as OperationRow | undefined;
    return row ? this.parseOperation(row) : null;
  }

  private operationById(operationId: string) {
    const row = this.db
      .prepare(
        `SELECT a.operationId,a.enrollmentId,a.clientSid,a.clientIdempotencyKey,a.requestedAttemptId,a.requestDigest,
                substr(a.packetJson,1,65537) AS packetJson,
                substr(a.admissionJson,1,65537) AS admissionJson,a.admissionDigest,
                substr(i.intentJson,1,65537) AS intentJson,i.intentDigest,i.status,i.revision
         FROM windows_attempt_admissions AS a
         LEFT JOIN windows_attempt_intents AS i ON i.operationId=a.operationId
         WHERE a.operationId=?`
      )
      .get(operationId) as OperationRow | undefined;
    return row ? this.parseOperation(row) : null;
  }

  private operationByAttempt(attemptId: string) {
    const row = this.db
      .prepare(`SELECT operationId FROM windows_attempt_admissions WHERE requestedAttemptId=?`)
      .get(attemptId) as { operationId: string } | undefined;
    return row ? this.operationById(row.operationId) : null;
  }

  private parseOperation(row: OperationRow): {
    row: OperationRow;
    admission: Admission;
    intent: Intent;
  } {
    const admission = parseRecord(WindowsAttemptAdmission_v1, row.admissionJson);
    const packet = parseRecord(AgentTaskPacket_v1, row.packetJson);
    if (!row.intentJson || !row.intentDigest || row.revision === null || !row.status)
      throw new Error("Corrupt Windows coordinator operation");
    const intent = parseRecord(WindowsAttemptIntent_v1, row.intentJson);
    const events = this.db
      .prepare(
        `SELECT revision,substr(intentJson,1,65537) AS intentJson,intentDigest
         FROM windows_attempt_intent_events WHERE operationId=? ORDER BY revision LIMIT 3`
      )
      .all(row.operationId) as Array<{
      revision: number;
      intentJson: string;
      intentDigest: string;
    }>;
    if (
      admission.operation_id !== row.operationId ||
      admission.enrollment_id !== row.enrollmentId ||
      admission.client_sid !== row.clientSid ||
      admission.client_idempotency_key !== row.clientIdempotencyKey ||
      admission.requested_attempt_id !== row.requestedAttemptId ||
      admission.request_digest !== row.requestDigest ||
      admission.admission_digest !== row.admissionDigest ||
      packet.packet_hash !== admission.packet_hash ||
      computeCanonicalHash(packet) !== admission.packet_snapshot_digest ||
      packet.run_id !== admission.requested_run_id ||
      packet.attempt_id !== admission.requested_attempt_id ||
      packet.repository.id !== admission.repository_id ||
      packet.repository.base_sha !== admission.base_sha ||
      windowsPacketEffectsDigest(packet) !== admission.packet_effects_digest ||
      intent.operation_id !== row.operationId ||
      intent.admission_digest !== admission.admission_digest ||
      intent.revision !== row.revision ||
      intent.status !== row.status ||
      intent.intent_digest !== row.intentDigest ||
      events.length !== intent.revision + 1 ||
      events[events.length - 1]?.intentJson !== row.intentJson ||
      events[events.length - 1]?.intentDigest !== row.intentDigest
    )
      throw new Error("Corrupt Windows coordinator operation");
    let previous: Intent | null = null;
    for (const [index, event] of events.entries()) {
      const historical = parseRecord(WindowsAttemptIntent_v1, event.intentJson);
      if (
        event.revision !== index ||
        historical.revision !== index ||
        historical.operation_id !== row.operationId ||
        historical.admission_digest !== admission.admission_digest ||
        historical.intent_digest !== event.intentDigest ||
        historical.created_at !== intent.created_at ||
        (previous && Date.parse(historical.updated_at) < Date.parse(previous.updated_at))
      )
        throw new Error("Corrupt Windows coordinator intent history");
      previous = historical;
    }
    return { row, admission, intent };
  }
}

function parseRecord<T>(schema: z.ZodType<T>, bytes: string): T {
  if (Buffer.byteLength(bytes, "utf8") > MAX_RECORD_BYTES)
    throw new Error("Corrupt Windows coordinator record bound");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new Error("Corrupt Windows coordinator record JSON");
  }
  const record = schema.parse(parsed);
  if (canonicalJSONStringify(record) !== bytes)
    throw new Error("Corrupt Windows coordinator record canonical bytes");
  return record;
}
