import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { createAgentTaskPacket } from "../../src/schemas/agent-work.js";
import {
  encodeWindowsCoordinatorClientFrame,
  parseWindowsCoordinatorClientFrame,
  WINDOWS_COORDINATOR_CLIENT_PROTOCOL_VERSION,
  WINDOWS_COORDINATOR_MAX_FRAME_BYTES,
} from "../../src/windows-coordinator/client-protocol.js";
import {
  dispatchWindowsCoordinatorFrame,
  WindowsCoordinatorDenial_v1,
} from "../../src/windows-coordinator/deny-first-dispatcher.js";

function packet() {
  return createAgentTaskPacket({
    schema_version: "1.0.0",
    packet_id: "packet-1",
    run_id: "run-1",
    work_item: { work_item_id: "work-1", revision: 1 },
    attempt_id: "attempt-1",
    repository: { id: "owner/repo", base_sha: "a".repeat(40) },
    objective: "Prove the coordinator refuses before admission",
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

function prepareRequest() {
  return {
    schema_version: WINDOWS_COORDINATOR_CLIENT_PROTOCOL_VERSION,
    verb: "attempt.prepare" as const,
    request_id: "request-1",
    client_idempotency_key: "client-key-1",
    packet: packet(),
  };
}

function rawFrame(payload: Uint8Array): Uint8Array {
  const frame = Buffer.alloc(4 + payload.byteLength);
  frame.writeUInt32LE(payload.byteLength, 0);
  Buffer.from(payload).copy(frame, 4);
  return frame;
}

describe("Windows coordinator client protocol, source-only", () => {
  it("parses a canonical bounded packet request and still refuses every effect", () => {
    const request = prepareRequest();
    const frame = encodeWindowsCoordinatorClientFrame(request);
    expect(parseWindowsCoordinatorClientFrame(frame)).toEqual({
      ok: true,
      request,
    });
    expect(dispatchWindowsCoordinatorFrame(frame)).toEqual({
      schema_version: "1.0.0",
      kind: "denial",
      request_id: "request-1",
      reason_code: "admission_unavailable",
      effect_state: "no_effect",
      authorizes_execution: false,
    });
  });

  it("returns the same no-effect refusal for a bounded status request", () => {
    const frame = encodeWindowsCoordinatorClientFrame({
      schema_version: "1.0.0",
      verb: "attempt.status",
      request_id: "request-2",
      run_id: "run-1",
      attempt_id: "attempt-1",
    });
    expect(WindowsCoordinatorDenial_v1.parse(dispatchWindowsCoordinatorFrame(frame))).toMatchObject(
      {
        request_id: "request-2",
        reason_code: "admission_unavailable",
        effect_state: "no_effect",
        authorizes_execution: false,
      }
    );
  });

  it("rejects a client-chosen durable operation ID beside the idempotency key", () => {
    const request = { ...prepareRequest(), operation_id: "client-picked-operation" };
    expect(() => encodeWindowsCoordinatorClientFrame(request)).toThrow();
    expect(
      dispatchWindowsCoordinatorFrame(rawFrame(Buffer.from(JSON.stringify(request))))
    ).toMatchObject({
      request_id: null,
      reason_code: "invalid_request",
      effect_state: "no_effect",
      authorizes_execution: false,
    });
  });
  it.each(["runtime", "databasePath", "gitExecutable", "workspace", "controller", "helperPath"])(
    "rejects client-supplied %s authority or path fields",
    (field) => {
      const request = { ...prepareRequest(), [field]: "D:\\untrusted" };
      expect(() => encodeWindowsCoordinatorClientFrame(request)).toThrow();
      const frame = rawFrame(Buffer.from(JSON.stringify(request), "utf8"));
      expect(dispatchWindowsCoordinatorFrame(frame)).toMatchObject({
        request_id: null,
        reason_code: "invalid_request",
        effect_state: "no_effect",
      });
    }
  );

  it("refuses unknown protocol versions and verbs", () => {
    for (const request of [
      { ...prepareRequest(), schema_version: "2.0.0" },
      { ...prepareRequest(), verb: "git.run" },
    ]) {
      expect(() => encodeWindowsCoordinatorClientFrame(request)).toThrow();
      expect(
        dispatchWindowsCoordinatorFrame(rawFrame(Buffer.from(JSON.stringify(request))))
      ).toMatchObject({ request_id: null, reason_code: "invalid_request" });
    }
  });

  it("refuses malformed, ambiguous and oversized frames before dispatch", () => {
    const good = Buffer.from(encodeWindowsCoordinatorClientFrame(prepareRequest()));
    const wrongLength = Buffer.from(good);
    wrongLength.writeUInt32LE(good.byteLength, 0);
    const duplicate = Buffer.from(good.subarray(4))
      .toString("utf8")
      .replace(
        '"request_id": "request-1",',
        '"request_id": "request-1",\n  "request_id": "request-2",'
      );
    expect(duplicate).toContain('"request_id": "request-2"');

    for (const frame of [
      Buffer.alloc(0),
      wrongLength,
      Buffer.concat([good, Buffer.from([0])]),
      rawFrame(Buffer.from([0xc3, 0x28])),
      rawFrame(Buffer.from("{")),
      rawFrame(Buffer.from(duplicate)),
      rawFrame(Buffer.alloc(WINDOWS_COORDINATOR_MAX_FRAME_BYTES + 1)),
    ]) {
      expect(dispatchWindowsCoordinatorFrame(frame)).toMatchObject({
        request_id: null,
        reason_code: "invalid_frame",
        effect_state: "no_effect",
        authorizes_execution: false,
      });
    }
  });
});
