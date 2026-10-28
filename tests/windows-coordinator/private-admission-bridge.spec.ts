import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import { createAgentTaskPacket } from "../../src/schemas/agent-work.js";
import {
  handlePrivateAdmissionObservation,
  PrivateAdmissionFixtureConfig_v1,
} from "../../src/windows-coordinator/private-admission-bridge.js";
import {
  encodeWindowsCoordinatorClientFrame,
  WINDOWS_COORDINATOR_MAX_FRAME_BYTES,
} from "../../src/windows-coordinator/client-protocol.js";
import {
  encodePrivatePeerDenial,
  parsePrivatePeerDenial,
  parsePrivatePeerObservation,
  PRIVATE_PEER_MAX_REQUEST_BYTES,
} from "../../src/windows-coordinator/private-peer-protocol.js";
import type { SqliteWindowsCoordinatorAdmissionStore } from "../../src/windows-coordinator/sqlite-admission-store.js";

const SID = "S-1-5-21-1000-1001-1002-1003";
const nonce = Buffer.alloc(16, 0x37);
const digest = (character: string) => `sha256:${character.repeat(64)}`;

function packet(objective = "Private no-effect candidate fixture") {
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
    created_at: "2026-10-28T12:00:00.000Z",
  });
}

function prepare(taskPacket = packet()) {
  return {
    schema_version: "1.0.0",
    verb: "attempt.prepare" as const,
    request_id: "request-1",
    client_idempotency_key: "retry-1",
    packet: taskPacket,
  };
}

function fixture() {
  return PrivateAdmissionFixtureConfig_v1.parse({
    schema_version: "windows-private-admission-fixture/1",
    database_path: "D:\\fixture\\store.db",
    reservation_context: {
      enrollment_id: "enrollment-1",
      expected_policy_revision: 1,
      observed_repository_identity_digest: digest("1"),
      observed_allocation_root_identity_digest: digest("2"),
      observed_volume_profile: "ReFS",
      controller: {
        run_id: "run-1",
        controller_id: "service-controller",
        lease_id: "service-lease",
        fencing_token: 1,
        expected_run_revision: 0,
      },
      now: "2026-10-28T12:00:01.000Z",
    },
  });
}

function privateRequest(clientFrame: Uint8Array, observedSid = SID) {
  const sid = Buffer.from(observedSid, "ascii");
  const frame = Buffer.from(clientFrame);
  const bytes = Buffer.alloc(8 + 16 + 2 + sid.length + 4 + frame.length);
  let offset = bytes.write("LXNPEER1", 0, "ascii");
  nonce.copy(bytes, offset);
  offset += nonce.length;
  bytes.writeUInt16LE(sid.length, offset);
  offset += 2;
  sid.copy(bytes, offset);
  offset += sid.length;
  bytes.writeUInt32LE(frame.length, offset);
  offset += 4;
  frame.copy(bytes, offset);
  return bytes;
}

function fakeStore(result: unknown) {
  const recordCandidate = vi.fn().mockReturnValue(result);
  return {
    store: { recordCandidate } as unknown as SqliteWindowsCoordinatorAdmissionStore,
    recordCandidate,
  };
}

describe("private Windows coordinator peer and admission fixture", () => {
  it("keeps the native SID separate from the canonical client frame and correlates a no-effect reply", () => {
    const frame = encodeWindowsCoordinatorClientFrame(prepare());
    const observation = parsePrivatePeerObservation(privateRequest(frame));
    expect(observation.observedClientSid).toBe(SID);
    expect(observation.clientFrame).toEqual(Buffer.from(frame));
    const { store, recordCandidate } = fakeStore({
      kind: "candidate_recorded",
      authorizes_execution: false,
      intent: { effect_state: "no_effect" },
    });
    const denial = handlePrivateAdmissionObservation(observation, fixture(), store);
    expect(recordCandidate).toHaveBeenCalledWith({
      ...fixture().reservation_context,
      observed_client_sid: SID,
      client_idempotency_key: "retry-1",
      packet: prepare().packet,
    });
    expect(denial).toEqual({
      schema_version: "1.0.0",
      kind: "denial",
      request_id: "request-1",
      reason_code: "admission_unavailable",
      effect_state: "no_effect",
      authorizes_execution: false,
    });
    expect(
      parsePrivatePeerDenial(encodePrivatePeerDenial(observation.nonce, denial), nonce)
    ).toEqual(denial);
  });

  it("rejects private transport ambiguity before a candidate", () => {
    const good = privateRequest(encodeWindowsCoordinatorClientFrame(prepare()));
    const wrongMagic = Buffer.from(good);
    wrongMagic[0] = 0;
    const wrongLength = Buffer.from(good);
    wrongLength.writeUInt32LE(
      wrongLength.readUInt32LE(8 + 16 + 2 + SID.length) + 1,
      8 + 16 + 2 + SID.length
    );
    for (const invalid of [
      wrongMagic,
      wrongLength,
      Buffer.concat([good, Buffer.from([0])]),
      privateRequest(encodeWindowsCoordinatorClientFrame(prepare()), "S-1-5-21-\u00e9"),
      Buffer.alloc(PRIVATE_PEER_MAX_REQUEST_BYTES + 1),
    ])
      expect(() => parsePrivatePeerObservation(invalid)).toThrow("invalid_private_peer_frame");
    const parsed = parsePrivatePeerObservation(good);
    const denial = handlePrivateAdmissionObservation(
      parsed,
      fixture(),
      fakeStore({
        kind: "historical_replay",
        intent: { effect_state: "no_effect" },
        authorizes_execution: false,
      }).store
    );
    expect(() =>
      parsePrivatePeerDenial(encodePrivatePeerDenial(nonce, denial), Buffer.alloc(16))
    ).toThrow("invalid_private_peer_reply");
  });

  it("never reads a client-supplied SID or other authority field", () => {
    const request = { ...prepare(), observed_client_sid: "S-1-5-32-544" };
    const payload = Buffer.from(JSON.stringify(request), "utf8");
    const frame = Buffer.alloc(4 + payload.length);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    const { store, recordCandidate } = fakeStore({ kind: "candidate_recorded" });
    expect(
      handlePrivateAdmissionObservation(
        parsePrivatePeerObservation(privateRequest(frame)),
        fixture(),
        store
      )
    ).toMatchObject({
      request_id: null,
      reason_code: "invalid_request",
      effect_state: "no_effect",
    });
    expect(recordCandidate).not.toHaveBeenCalled();
    expect(() =>
      PrivateAdmissionFixtureConfig_v1.parse({
        ...fixture(),
        reservation_context: { ...fixture().reservation_context, observed_client_sid: SID },
      })
    ).toThrow();
  });

  it("refuses every store rejection and historical unknown effect without asserting no effect", () => {
    const observation = parsePrivatePeerObservation(
      privateRequest(encodeWindowsCoordinatorClientFrame(prepare()))
    );
    for (const result of [
      { kind: "rejected", reason: "changed_input_replay", authorizes_execution: false },
      { kind: "rejected", reason: "attempt_already_recorded", authorizes_execution: false },
      { kind: "rejected", reason: "stale_fence", authorizes_execution: false },
      { kind: "rejected", reason: "store_read_only", authorizes_execution: false },
      { kind: "rejected", reason: "invalid_input", authorizes_execution: false },
      {
        kind: "historical_replay",
        intent: { effect_state: "effect_unknown" },
        authorizes_execution: false,
      },
    ])
      expect(() =>
        handlePrivateAdmissionObservation(observation, fixture(), fakeStore(result).store)
      ).toThrow();
  });

  it("closes when an oversized changed packet masks a historical replay as invalid input", () => {
    const changed = prepare(packet("x".repeat(70_000)));
    const frame = encodeWindowsCoordinatorClientFrame(changed);
    expect(frame.byteLength).toBeGreaterThan(65_536);
    const { store, recordCandidate } = fakeStore({
      kind: "rejected",
      reason: "invalid_input",
      authorizes_execution: false,
    });
    expect(() =>
      handlePrivateAdmissionObservation(
        parsePrivatePeerObservation(privateRequest(frame)),
        fixture(),
        store
      )
    ).toThrow("private_admission_historical_state_unverified");
    expect(recordCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ client_idempotency_key: "retry-1", packet: changed.packet })
    );
  });

  it("does not reach admission for status, invalid client frames, or overlarge client framing", () => {
    const { store, recordCandidate } = fakeStore({ kind: "candidate_recorded" });
    const status = encodeWindowsCoordinatorClientFrame({
      schema_version: "1.0.0",
      verb: "attempt.status",
      request_id: "status-1",
      run_id: "run-1",
      attempt_id: "attempt-1",
    });
    expect(
      handlePrivateAdmissionObservation(
        parsePrivatePeerObservation(privateRequest(status)),
        fixture(),
        store
      )
    ).toMatchObject({
      request_id: "status-1",
      reason_code: "admission_unavailable",
      effect_state: "no_effect",
    });
    expect(
      handlePrivateAdmissionObservation(
        parsePrivatePeerObservation(privateRequest(Buffer.alloc(4))),
        fixture(),
        store
      )
    ).toMatchObject({
      request_id: null,
      reason_code: "invalid_frame",
      effect_state: "no_effect",
    });
    const canonical = Buffer.from(encodeWindowsCoordinatorClientFrame(prepare()));
    const bomPayload = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canonical.subarray(4)]);
    const bomFrame = Buffer.alloc(4 + bomPayload.length);
    bomFrame.writeUInt32LE(bomPayload.length, 0);
    bomPayload.copy(bomFrame, 4);
    expect(
      handlePrivateAdmissionObservation(
        parsePrivatePeerObservation(privateRequest(bomFrame)),
        fixture(),
        store
      )
    ).toMatchObject({ request_id: null, reason_code: "invalid_frame" });
    expect(() =>
      parsePrivatePeerObservation(
        privateRequest(Buffer.alloc(WINDOWS_COORDINATOR_MAX_FRAME_BYTES + 5))
      )
    ).toThrow();
    expect(recordCandidate).not.toHaveBeenCalled();
  });
});
