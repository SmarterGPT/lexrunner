import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAgentTaskPacket } from "../../src/schemas/agent-work.js";
import { computeCanonicalHash } from "../../src/schemas/task-contract.js";
import { canonicalJSONStringify } from "../../src/util/canonicalJson.js";
import {
  WindowsCoordinatorEnrollmentBody_v1,
  WindowsCoordinatorEnrollment_v1,
  windowsPacketEffectsDigest,
  type WindowsCoordinatorReservationInput_v1,
} from "../../src/windows-coordinator/admission-contract.js";
import { SqliteWindowsCoordinatorAdmissionStore } from "../../src/windows-coordinator/sqlite-admission-store.js";
import { latchSyntheticEffectUnknown } from "./synthetic-uncertainty-journal.js";

const T0 = "2026-10-28T12:00:00.000Z";
const T1 = "2026-10-28T12:00:01.000Z";
const T2 = "2026-10-28T12:00:02.000Z";
const SID = "S-1-5-21-1000-1001-1002-1003";
const PREFIX = "lexrunner-synthetic-uncertainty-";
const digest = (character: string) => "sha256:" + character.repeat(64);

describe("source-only Windows admission uncertainty journal", () => {
  let directory: string;
  let path: string;
  let store: SqliteWindowsCoordinatorAdmissionStore;
  let db: Database.Database;
  let input: WindowsCoordinatorReservationInput_v1;
  let operationId: string;
  let admissionDigest: string;

  const count = () =>
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM windows_attempt_intent_events WHERE operationId=?")
        .get(operationId) as { count: number }
    ).count;

  const latchNow = () =>
    latchSyntheticEffectUnknown(store, {
      operation_id: operationId,
      admission_digest: admissionDigest,
      observed_repository_identity_digest: input.observed_repository_identity_digest,
      observed_allocation_root_identity_digest: input.observed_allocation_root_identity_digest,
      observed_volume_profile: input.observed_volume_profile,
      selected_helper_generation_digest: digest("3"),
      selected_git_profile_digest: digest("4"),
      now: T2,
    });

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), PREFIX));
    path = join(directory, "store.db");
    store = new SqliteWindowsCoordinatorAdmissionStore(path);
    db = new Database(path);
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    const packet = createAgentTaskPacket({
      schema_version: "1.0.0",
      packet_id: "packet-1",
      run_id: "run-1",
      work_item: { work_item_id: "work-1", revision: 1 },
      attempt_id: "attempt-1",
      repository: { id: "owner/repo", base_sha: "a".repeat(40) },
      objective: "Synthetic admission interruption",
      acceptance_criteria: [],
      instructions: [],
      scope: {
        read_globs: ["**"],
        write_globs: ["src/**"],
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
    const lease = await store.acquireControllerLease({
      runId: packet.run_id,
      controllerId: "service-controller",
      leaseId: "service-lease",
      now: T0,
      ttlMs: 60_000,
      initialState: {},
    });
    if (!lease.acquired) throw new Error("synthetic controller fixture failed");
    input = {
      enrollment_id: "enrollment-1",
      observed_client_sid: SID,
      client_idempotency_key: "retry-key-1",
      packet,
      expected_policy_revision: 1,
      observed_repository_identity_digest: digest("1"),
      observed_allocation_root_identity_digest: digest("2"),
      observed_volume_profile: "ReFS",
      controller: {
        run_id: packet.run_id,
        controller_id: lease.lease.controllerId,
        lease_id: lease.lease.leaseId,
        fencing_token: lease.lease.fencingToken,
        expected_run_revision: lease.record.revision,
      },
      now: T1,
    };
    const body = WindowsCoordinatorEnrollmentBody_v1.parse({
      schema_version: "windows-coordinator-enrollment/1",
      enrollment_id: input.enrollment_id,
      policy_revision: 1,
      status: "active",
      client_sid: SID,
      repository_id: packet.repository.id,
      repository_identity_digest: input.observed_repository_identity_digest,
      allocation_root_identity_digest: input.observed_allocation_root_identity_digest,
      volume_profile: input.observed_volume_profile,
      allowed_operation_classes: ["attempt.prepare"],
      authority_ceiling: packet.authority,
      allowed_packet_effects_digest: windowsPacketEffectsDigest(packet),
      helper_generation_digest: digest("3"),
      git_profile_digest: digest("4"),
      updated_at: T0,
    });
    const enrollment = WindowsCoordinatorEnrollment_v1.parse({
      ...body,
      enrollment_digest: computeCanonicalHash(body),
    });
    db.prepare(
      "INSERT INTO windows_coordinator_enrollments (enrollmentId,revision,status,clientSid,enrollmentJson,enrollmentDigest) VALUES (?,?,?,?,?,?)"
    ).run(
      enrollment.enrollment_id,
      enrollment.policy_revision,
      enrollment.status,
      enrollment.client_sid,
      canonicalJSONStringify(enrollment),
      enrollment.enrollment_digest
    );
    const candidate = store.recordCandidate(input);
    if (candidate.kind !== "candidate_recorded") throw new Error("synthetic candidate failed");
    operationId = candidate.admission.operation_id;
    admissionDigest = candidate.admission.admission_digest;
  });

  afterEach(async () => {
    await store.close();
    db.close();
    const root = resolve(tmpdir());
    const target = resolve(directory);
    if (!target.startsWith(root + sep) || !basename(target).startsWith(PREFIX))
      throw new Error("unsafe synthetic cleanup target");
    if (
      !lstatSync(target).isDirectory() ||
      lstatSync(target).isSymbolicLink() ||
      dirname(realpathSync.native(target)).toLowerCase() !== realpathSync.native(root).toLowerCase()
    )
      throw new Error("unsafe synthetic cleanup identity");
    rmSync(target, { recursive: true, force: true });
  });

  it("commits unknown effect before a lost reply and replays it after restart", async () => {
    const first = latchNow();
    expect(first).toMatchObject({
      kind: "effect_unknown_latched",
      intent: { status: "indeterminate", effect_state: "effect_unknown" },
      authorizes_execution: false,
    });
    expect(count()).toBe(2);
    await store.close();
    db.close();
    store = new SqliteWindowsCoordinatorAdmissionStore(path);
    db = new Database(path);
    db.pragma("foreign_keys = ON");
    expect(store.recordCandidate(input)).toMatchObject({
      kind: "historical_replay",
      intent: { effect_state: "effect_unknown" },
      authorizes_execution: false,
    });
    db.prepare("UPDATE windows_coordinator_enrollments SET status='revoked'").run();
    db.prepare("UPDATE run_coordination SET expiresAt=?").run(T1);
    expect(latchNow()).toMatchObject({
      kind: "historical_effect_unknown",
      intent: { effect_state: "effect_unknown" },
      authorizes_execution: false,
    });
    expect(count()).toBe(2);
  });

  it("rolls back the event if the current-row update is interrupted", () => {
    db.exec(
      "CREATE TRIGGER injected_intent_failure BEFORE UPDATE ON windows_attempt_intents BEGIN SELECT RAISE(ABORT, 'injected interruption'); END"
    );
    expect(latchNow).toThrow("injected interruption");
    expect(count()).toBe(1);
    expect(store.recordCandidate(input)).toMatchObject({
      kind: "historical_replay",
      intent: { status: "candidate", effect_state: "no_effect" },
    });
    db.exec("DROP TRIGGER injected_intent_failure");
    expect(latchNow().intent.effect_state).toBe("effect_unknown");
    expect(count()).toBe(2);
  });

  it("refuses changed policy, lost fence and corrupt history without an effect claim", () => {
    db.prepare("UPDATE run_coordination SET fencingToken=fencingToken+1 WHERE runId=?").run(
      input.packet.run_id
    );
    expect(latchNow).toThrow("synthetic_admission_fence_unavailable");
    expect(count()).toBe(1);
    db.prepare("UPDATE run_coordination SET fencingToken=? WHERE runId=?").run(
      input.controller.fencing_token,
      input.packet.run_id
    );
    db.prepare("UPDATE windows_coordinator_enrollments SET status='revoked'").run();
    expect(latchNow).toThrow("Corrupt Windows coordinator enrollment");
    expect(count()).toBe(1);
    db.prepare("UPDATE windows_coordinator_enrollments SET status='active'").run();
    db.prepare("DELETE FROM windows_attempt_intent_events WHERE operationId=?").run(operationId);
    expect(latchNow).toThrow("Corrupt Windows coordinator operation");
  });
});
