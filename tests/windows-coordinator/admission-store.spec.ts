import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAgentTaskPacket } from "../../src/schemas/agent-work.js";
import { computeCanonicalHash } from "../../src/schemas/task-contract.js";
import { canonicalJSONStringify } from "../../src/util/canonicalJson.js";
import {
  WindowsAttemptIntentBody_v1,
  WindowsAttemptIntent_v1,
  WindowsCoordinatorEnrollmentBody_v1,
  WindowsCoordinatorEnrollment_v1,
  windowsPacketEffectsDigest,
  type WindowsCoordinatorReservationInput_v1,
} from "../../src/windows-coordinator/admission-contract.js";
import { SqliteWindowsCoordinatorAdmissionStore } from "../../src/windows-coordinator/sqlite-admission-store.js";

const T0 = "2026-10-28T12:00:00.000Z";
const T1 = "2026-10-28T12:00:01.000Z";
const SID = "S-1-5-21-1000-1001-1002-1003";
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const PREFIX = "lexrunner-admission-store-";

function packet(objective = "Source-only attempt preparation", writeGlobs = ["src/**"]) {
  return createAgentTaskPacket({
    schema_version: "1.0.0",
    packet_id: "packet-1",
    run_id: "run-1",
    work_item: { work_item_id: "work-1", revision: 1 },
    attempt_id: "attempt-1",
    repository: { id: "owner/repo", base_sha: "a".repeat(40) },
    objective,
    acceptance_criteria: [],
    instructions: [],
    scope: {
      read_globs: ["**"],
      write_globs: writeGlobs,
      deny_globs: [],
      cross_repo_allowed: false,
    },
    authority: {
      edit: true,
      git_write: false,
      github_write: false,
      external_runtime: false,
      secrets: false,
      signing: false,
      release: false,
    },
    verification: [],
    budget: {},
    created_at: T0,
  });
}

describe("Windows coordinator source-only admission store", () => {
  let directory: string;
  let path: string;
  let store: SqliteWindowsCoordinatorAdmissionStore;
  let raw: Database.Database;
  let input: WindowsCoordinatorReservationInput_v1;

  function enrollment(overrides: Record<string, unknown> = {}) {
    const body = WindowsCoordinatorEnrollmentBody_v1.parse({
      schema_version: "windows-coordinator-enrollment/1",
      enrollment_id: "enrollment-1",
      policy_revision: 1,
      status: "active",
      client_sid: SID,
      repository_id: "owner/repo",
      repository_identity_digest: digest("1"),
      allocation_root_identity_digest: digest("2"),
      volume_profile: "ReFS",
      allowed_operation_classes: ["attempt.prepare"],
      authority_ceiling: input.packet.authority,
      allowed_packet_effects_digest: windowsPacketEffectsDigest(input.packet),
      helper_generation_digest: digest("3"),
      git_profile_digest: digest("4"),
      updated_at: T0,
      ...overrides,
    });
    return WindowsCoordinatorEnrollment_v1.parse({
      ...body,
      enrollment_digest: computeCanonicalHash(body),
    });
  }

  function seedEnrollment(overrides: Record<string, unknown> = {}) {
    const record = enrollment(overrides);
    raw
      .prepare(
        `INSERT OR REPLACE INTO windows_coordinator_enrollments
         (enrollmentId,revision,status,clientSid,enrollmentJson,enrollmentDigest)
         VALUES (?,?,?,?,?,?)`
      )
      .run(
        record.enrollment_id,
        record.policy_revision,
        record.status,
        record.client_sid,
        canonicalJSONStringify(record),
        record.enrollment_digest
      );
  }

  function count(table: string): number {
    const allowed = [
      "windows_attempt_admissions",
      "windows_attempt_intents",
      "windows_attempt_intent_events",
      "attempts",
      "workspace_leases",
      "launch_envelope_bindings",
    ];
    if (!allowed.includes(table)) throw new Error("unexpected table");
    return (raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), PREFIX));
    path = join(directory, "store.db");
    store = new SqliteWindowsCoordinatorAdmissionStore(path);
    raw = new Database(path);
    raw.pragma("foreign_keys = ON");
    const lease = await store.acquireControllerLease({
      runId: "run-1",
      controllerId: "service-controller",
      leaseId: "service-lease",
      now: T0,
      ttlMs: 60_000,
      initialState: {},
    });
    if (!lease.acquired) throw new Error("controller fixture failed");
    input = {
      enrollment_id: "enrollment-1",
      // Synthetic fixture data. No client token or installed service is involved.
      observed_client_sid: SID,
      client_idempotency_key: "retry-key-1",
      packet: packet(),
      expected_policy_revision: 1,
      observed_repository_identity_digest: digest("1"),
      observed_allocation_root_identity_digest: digest("2"),
      observed_volume_profile: "ReFS",
      controller: {
        run_id: "run-1",
        controller_id: lease.lease.controllerId,
        lease_id: lease.lease.leaseId,
        fencing_token: lease.lease.fencingToken,
        expected_run_revision: lease.record.revision,
      },
      now: T1,
    };
    seedEnrollment();
  });

  afterEach(async () => {
    await store.close();
    raw.close();
    const root = resolve(tmpdir());
    const target = resolve(directory);
    if (!target.startsWith(root + sep) || !basename(target).startsWith(PREFIX))
      throw new Error("unsafe test cleanup target");
    const targetStat = lstatSync(target);
    const physicalParent = realpathSync.native(root);
    const physicalTarget = realpathSync.native(target);
    if (
      !targetStat.isDirectory() ||
      targetStat.isSymbolicLink() ||
      dirname(physicalTarget).toLowerCase() !== physicalParent.toLowerCase() ||
      basename(physicalTarget) !== basename(target)
    )
      throw new Error("reparse or escaped test cleanup target");
    rmSync(target, { recursive: true, force: true });
  });

  it("atomically records a packet-bound candidate and replays after reopen without effects", async () => {
    const first = store.recordCandidate(input);
    expect(first.kind).toBe("candidate_recorded");
    if (first.kind !== "candidate_recorded") throw new Error("candidate fixture failed");
    expect(first.authorizes_execution).toBe(false);
    expect(first.admission).toMatchObject({
      disposition: "source_only_candidate",
      effect_state: "no_effect",
      packet_snapshot_digest: computeCanonicalHash(input.packet),
      authorizes_execution: false,
    });
    expect(first.intent).toMatchObject({ status: "candidate", effect_state: "no_effect" });
    expect(count("windows_attempt_admissions")).toBe(1);
    expect(count("windows_attempt_intents")).toBe(1);
    expect(count("windows_attempt_intent_events")).toBe(1);
    expect(count("attempts")).toBe(0);
    expect(count("workspace_leases")).toBe(0);
    expect(count("launch_envelope_bindings")).toBe(0);

    await store.close();
    store = new SqliteWindowsCoordinatorAdmissionStore(path);
    const replay = store.recordCandidate({
      ...input,
      expected_policy_revision: 99,
      controller: { ...input.controller, fencing_token: 99 },
    });
    expect(replay).toMatchObject({
      kind: "historical_replay",
      authorizes_execution: false,
      admission: { operation_id: first.admission.operation_id },
      intent: { effect_state: "no_effect" },
    });
    expect(count("windows_attempt_admissions")).toBe(1);
    expect(count("windows_attempt_intent_events")).toBe(1);
    expect(store.recordCandidate({ ...input, packet: packet("Changed objective") })).toEqual({
      kind: "rejected",
      reason: "changed_input_replay",
      authorizes_execution: false,
    });
  });

  it("rejects missing or stale policy, stale fences, and unapproved effects without a candidate", () => {
    raw.prepare("DELETE FROM windows_coordinator_enrollments").run();
    expect(store.recordCandidate(input)).toMatchObject({ reason: "missing_enrollment" });
    seedEnrollment();
    expect(store.recordCandidate({ ...input, expected_policy_revision: 2 })).toMatchObject({
      reason: "stale_policy",
    });
    seedEnrollment({ status: "revoked" });
    expect(store.recordCandidate(input)).toMatchObject({ reason: "policy_revoked" });
    seedEnrollment();
    expect(
      store.recordCandidate({
        ...input,
        controller: { ...input.controller, fencing_token: input.controller.fencing_token + 1 },
      })
    ).toMatchObject({ reason: "stale_fence" });
    expect(
      store.recordCandidate({ ...input, packet: packet("New objective", ["other/**"]) })
    ).toMatchObject({
      reason: "packet_effects_mismatch",
    });
    expect(count("windows_attempt_admissions")).toBe(0);
  });

  it("requires an existing Attempt to have an exact packet/base snapshot", async () => {
    const result = await store.createAttempt({
      runId: "run-1",
      controller: {
        runId: "run-1",
        controllerId: input.controller.controller_id,
        leaseId: input.controller.lease_id,
        fencingToken: input.controller.fencing_token,
      },
      expectedRunRevision: 0,
      mutationId: "create-attempt-1",
      now: T0,
      attemptId: input.packet.attempt_id,
      workItemId: input.packet.work_item.work_item_id,
      workItemRevision: input.packet.work_item.revision,
      packetId: input.packet.packet_id,
      packetHash: input.packet.packet_hash,
      baseSha: input.packet.repository.base_sha,
    });
    expect(result).toMatchObject({ updated: true });
    expect(store.recordCandidate(input)).toMatchObject({ reason: "attempt_binding_mismatch" });
    raw
      .prepare(
        `INSERT INTO task_packet_bindings
         (attemptId,runId,workItemId,workItemRevision,packetId,packetHash,packetJson,createdAt)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        input.packet.attempt_id,
        input.packet.run_id,
        input.packet.work_item.work_item_id,
        input.packet.work_item.revision,
        input.packet.packet_id,
        input.packet.packet_hash,
        canonicalJSONStringify(input.packet),
        T0
      );
    expect(store.recordCandidate(input).kind).toBe("candidate_recorded");
  });

  it("fails closed on corrupt enrollment and operation rows", () => {
    raw.prepare("UPDATE windows_coordinator_enrollments SET enrollmentJson='{}'").run();
    expect(() => store.recordCandidate(input)).toThrow();
    seedEnrollment();
    const first = store.recordCandidate(input);
    expect(first.kind).toBe("candidate_recorded");
    raw.prepare("UPDATE windows_attempt_admissions SET packetJson='{}'").run();
    expect(() => store.recordCandidate(input)).toThrow();
    expect(count("windows_attempt_admissions")).toBe(1);
  });

  it("rolls back admission when the no-effect intent insert fails", () => {
    raw
      .prepare(
        `CREATE TRIGGER reject_intent BEFORE INSERT ON windows_attempt_intents
         BEGIN SELECT RAISE(ABORT, 'injected intent failure'); END`
      )
      .run();
    expect(() => store.recordCandidate(input)).toThrow("injected intent failure");
    expect(count("windows_attempt_admissions")).toBe(0);
    expect(count("windows_attempt_intents")).toBe(0);
    expect(count("windows_attempt_intent_events")).toBe(0);
  });

  it("rejects an oversized packet, malformed controller expiry, and a second key for one Attempt", () => {
    expect(store.recordCandidate({ ...input, packet: packet("x".repeat(70_000)) })).toMatchObject({
      reason: "invalid_input",
      authorizes_execution: false,
    });
    raw.prepare("UPDATE run_coordination SET expiresAt='not-a-date' WHERE runId='run-1'").run();
    expect(store.recordCandidate(input)).toMatchObject({ reason: "controller_expired" });
    expect(count("windows_attempt_admissions")).toBe(0);
    raw
      .prepare(
        "UPDATE run_coordination SET expiresAt='2026-10-28T12:01:00.000Z' WHERE runId='run-1'"
      )
      .run();
    expect(store.recordCandidate(input).kind).toBe("candidate_recorded");
    expect(store.recordCandidate({ ...input, client_idempotency_key: "second-key" })).toMatchObject(
      { reason: "attempt_already_recorded", authorizes_execution: false }
    );
    expect(count("windows_attempt_admissions")).toBe(1);
  });

  it("only reads a synthetic historical unknown effect; no source API can create or retry it", async () => {
    const first = store.recordCandidate(input);
    if (first.kind !== "candidate_recorded") throw new Error("candidate fixture failed");
    // Fixture-only prior state. Source-only code exposes no dispatch or unknown-effect transition.
    const { intent_digest: _priorDigest, ...priorBody } = first.intent;
    const body = WindowsAttemptIntentBody_v1.parse({
      ...priorBody,
      revision: 1,
      status: "indeterminate",
      effect_state: "effect_unknown",
      updated_at: "2026-10-28T12:00:02.000Z",
    });
    const historical = WindowsAttemptIntent_v1.parse({
      ...body,
      intent_digest: computeCanonicalHash(body),
    });
    raw
      .prepare(
        `INSERT INTO windows_attempt_intent_events (operationId,revision,intentJson,intentDigest)
         VALUES (?,?,?,?)`
      )
      .run(
        first.admission.operation_id,
        historical.revision,
        canonicalJSONStringify(historical),
        historical.intent_digest
      );
    // A later event without a matching current row must not replay as no-effect.
    expect(() => store.recordCandidate(input)).toThrow("Corrupt Windows coordinator operation");
    raw
      .prepare(
        `UPDATE windows_attempt_intents SET revision=?,status=?,intentJson=?,intentDigest=?
         WHERE operationId=?`
      )
      .run(
        historical.revision,
        historical.status,
        canonicalJSONStringify(historical),
        historical.intent_digest,
        first.admission.operation_id
      );
    await store.close();
    store = new SqliteWindowsCoordinatorAdmissionStore(path);
    expect(store.recordCandidate(input)).toMatchObject({
      kind: "historical_replay",
      authorizes_execution: false,
      intent: { status: "indeterminate", effect_state: "effect_unknown" },
    });
    expect(count("windows_attempt_admissions")).toBe(1);
    expect(count("windows_attempt_intent_events")).toBe(2);
    raw
      .prepare("DELETE FROM windows_attempt_intent_events WHERE operationId=? AND revision=0")
      .run(first.admission.operation_id);
    expect(() => store.recordCandidate(input)).toThrow("Corrupt Windows coordinator operation");
  });
});
