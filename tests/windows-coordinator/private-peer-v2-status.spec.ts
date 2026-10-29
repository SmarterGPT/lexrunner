import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  encodePrivatePeerV2UnknownStatusReply,
  parsePrivatePeerV2StatusRequest,
  parsePrivatePeerV2UnknownStatusReply,
  PRIVATE_PEER_V2_MAX_STATUS_REPLY_BYTES,
  PRIVATE_PEER_V2_MAX_STATUS_REQUEST_BYTES,
} from "../../src/windows-coordinator/private-peer-v2-status.js";

const nonce = Buffer.alloc(16, 0x37);
const sid = "S-1-5-21-1000-1001-1002-1003";
const canonicalRequest =
  "{\n" +
  '  "attempt_id": "attempt-1",\n' +
  '  "request_id": "request-1",\n' +
  '  "run_id": "run-1",\n' +
  '  "schema_version": "1.0.0",\n' +
  '  "verb": "attempt.status"\n' +
  "}\n";
const canonicalUnknown =
  "{\n" +
  '  "attempt_id": "attempt-1",\n' +
  '  "authorizes_execution": false,\n' +
  '  "effect_state": "effect_unknown",\n' +
  '  "kind": "status",\n' +
  '  "reason_code": "protected_store_unavailable",\n' +
  '  "request_id": "request-1",\n' +
  '  "run_id": "run-1",\n' +
  '  "schema_version": "2.0.0",\n' +
  '  "state": "indeterminate"\n' +
  "}\n";

function clientFrame(payload: Uint8Array = Buffer.from(canonicalRequest, "utf8")): Buffer {
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  Buffer.from(payload).copy(frame, 4);
  return frame;
}

function privateRequest(
  options: {
    payload?: Uint8Array;
    observedSid?: string;
    verb?: number;
    nonce?: Uint8Array;
  } = {}
): Buffer {
  const peer = Buffer.from(options.observedSid ?? sid, "utf8");
  const frame = clientFrame(options.payload);
  const envelope = Buffer.alloc(8 + 16 + 1 + 2 + peer.length + 4 + frame.length);
  let offset = envelope.write("LXNPEER2", 0, "ascii");
  Buffer.from(options.nonce ?? nonce).copy(envelope, offset);
  offset += 16;
  envelope[offset++] = options.verb ?? 1;
  envelope.writeUInt16LE(peer.length, offset);
  offset += 2;
  peer.copy(envelope, offset);
  offset += peer.length;
  envelope.writeUInt32LE(frame.length, offset);
  frame.copy(envelope, offset + 4);
  return envelope;
}

function expectRequestRefusal(bytes: Uint8Array): void {
  expect(() => parsePrivatePeerV2StatusRequest(bytes)).toThrow("invalid_private_status_request");
}

describe("source-only LXNPEER2 status grammar", () => {
  it("matches the current C# conservative request and response bytes", () => {
    const observed = parsePrivatePeerV2StatusRequest(privateRequest());
    expect(observed).toMatchObject({
      observedClientSid: sid,
      requestId: "request-1",
      runId: "run-1",
      attemptId: "attempt-1",
    });
    expect(observed.nonce).toEqual(nonce);
    expect(observed.clientFrame).toEqual(clientFrame());
    const reply = encodePrivatePeerV2UnknownStatusReply(observed);
    expect(reply.subarray(0, 8).toString("ascii")).toBe("LXNREPL2");
    expect(reply.subarray(8, 24)).toEqual(nonce);
    expect(reply.readUInt32LE(24)).toBe(reply.length - 28);
    expect(reply.subarray(32).toString("utf8")).toBe(canonicalUnknown);
    expect(parsePrivatePeerV2UnknownStatusReply(reply, observed)).toEqual({
      effectState: "effect_unknown",
      authorizesExecution: false,
    });
  });

  it("copies input before returning nonce and canonical client frame", () => {
    const input = privateRequest();
    const observed = parsePrivatePeerV2StatusRequest(input);
    input.fill(0);
    expect(observed.nonce).toEqual(nonce);
    expect(observed.clientFrame).toEqual(clientFrame());
  });

  it("refuses private framing, verb, SID and length deviations", () => {
    const wrongMagic = privateRequest();
    wrongMagic[0] ^= 1;
    const wrongVerb = privateRequest({ verb: 2 });
    const truncated = privateRequest().subarray(0, -1);
    const trailing = Buffer.concat([privateRequest(), Buffer.from([0])]);
    const wrongSidLength = privateRequest();
    wrongSidLength.writeUInt16LE(185, 25);
    const wrongFrameLength = privateRequest();
    wrongFrameLength.writeUInt32LE(1, 27 + Buffer.byteLength(sid));
    const wrongInnerLength = privateRequest();
    wrongInnerLength.writeUInt32LE(0, 31 + Buffer.byteLength(sid));
    for (const input of [
      wrongMagic,
      wrongVerb,
      truncated,
      trailing,
      wrongSidLength,
      wrongFrameLength,
      wrongInnerLength,
      privateRequest({ observedSid: "S-1-5-x" }),
      privateRequest({ observedSid: "S-1-5-é" }),
      Buffer.alloc(PRIVATE_PEER_V2_MAX_STATUS_REQUEST_BYTES + 1),
    ])
      expectRequestRefusal(input);
  });

  it("refuses noncanonical, duplicate, extra, invalid and effectful public requests", () => {
    const cases = [
      canonicalRequest.replace('"verb": "attempt.status"', '"verb": "attempt.prepare"'),
      canonicalRequest.replace(
        '  "run_id": "run-1",\n',
        '  "run_id": "run-1",\n  "run_id": "run-2",\n'
      ),
      canonicalRequest.replace('  "run_id": "run-1",\n', '  "other": "x",\n  "run_id": "run-1",\n'),
      canonicalRequest.replace('"request-1"', '"request/1"'),
      JSON.stringify(JSON.parse(canonicalRequest)),
    ];
    for (const json of cases) expectRequestRefusal(privateRequest({ payload: Buffer.from(json) }));
    expectRequestRefusal(privateRequest({ payload: Buffer.from([0xff]) }));
  });

  it("refuses no-effect, execution, nonce and correlation spoofing in replies", () => {
    const observed = parsePrivatePeerV2StatusRequest(privateRequest());
    const reply = encodePrivatePeerV2UnknownStatusReply(observed);
    const wrongMagic = Buffer.from(reply);
    wrongMagic[0] ^= 1;
    const wrongNonce = Buffer.from(reply);
    wrongNonce[8] ^= 1;
    const wrongLength = Buffer.from(reply);
    wrongLength.writeUInt32LE(1, 24);
    const wrongInner = Buffer.from(reply);
    wrongInner.writeUInt32LE(1, 28);
    const noEffect = Buffer.from(reply);
    noEffect.write("no_effect     ", noEffect.indexOf("effect_unknown"), "ascii");
    const execution = Buffer.from(reply);
    execution.write("true ", execution.indexOf("false"), "ascii");
    const wrongId = Buffer.from(reply);
    wrongId.write("request-2", wrongId.indexOf("request-1"), "ascii");
    for (const candidate of [
      wrongMagic,
      wrongNonce,
      wrongLength,
      wrongInner,
      noEffect,
      execution,
      wrongId,
      Buffer.concat([reply, Buffer.from([0])]),
      Buffer.alloc(PRIVATE_PEER_V2_MAX_STATUS_REPLY_BYTES + 1),
    ])
      expect(() => parsePrivatePeerV2UnknownStatusReply(candidate, observed)).toThrow(
        "invalid_private_status_reply"
      );
  });

  it("rejects forged encoder fields instead of producing a no-effect authority claim", () => {
    const observed = parsePrivatePeerV2StatusRequest(privateRequest());
    expect(() => encodePrivatePeerV2UnknownStatusReply({ ...observed, runId: "run/evil" })).toThrow(
      "invalid_private_status_reply_input"
    );
    expect(() =>
      encodePrivatePeerV2UnknownStatusReply({ ...observed, nonce: Buffer.alloc(15) })
    ).toThrow("invalid_private_status_reply_input");
  });
});
