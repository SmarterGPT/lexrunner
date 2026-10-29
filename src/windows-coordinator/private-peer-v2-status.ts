import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";

// Source-only LXNPEER2 status grammar. Parsing an envelope does not establish
// its origin or grant a store, service, workspace, or execution lease.
const requestMagic = Buffer.from("LXNPEER2", "ascii");
const replyMagic = Buffer.from("LXNREPL2", "ascii");
const nonceBytes = 16;
const maximumSidBytes = 184;
const maximumClientFrameBytes = 2048;
const maximumStatusFrameBytes = 4096 + 4;

export const PRIVATE_PEER_V2_MAX_STATUS_REQUEST_BYTES =
  requestMagic.length + nonceBytes + 1 + 2 + maximumSidBytes + 4 + maximumClientFrameBytes;
export const PRIVATE_PEER_V2_MAX_STATUS_REPLY_BYTES =
  replyMagic.length + nonceBytes + 4 + maximumStatusFrameBytes;

export interface PrivatePeerV2StatusRequest {
  readonly nonce: Buffer;
  readonly observedClientSid: string;
  readonly requestId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly clientFrame: Buffer;
}

const opaqueId = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const sid = /^S-1-(?:[0-9]+-){1,14}[0-9]+$/u;

function validOpaque(value: unknown): value is string {
  return (
    typeof value === "string" && value.length >= 1 && value.length <= 128 && opaqueId.test(value)
  );
}

function invalidRequest(): never {
  throw new Error("invalid_private_status_request");
}

function canonicalStatusRequest(requestId: string, runId: string, attemptId: string): string {
  return (
    "{\n" +
    `  "attempt_id": "${attemptId}",\n` +
    `  "request_id": "${requestId}",\n` +
    `  "run_id": "${runId}",\n` +
    '  "schema_version": "1.0.0",\n' +
    '  "verb": "attempt.status"\n' +
    "}\n"
  );
}

/** Parse one copied private status request; no caller path or authority input. */
export function parsePrivatePeerV2StatusRequest(input: Uint8Array): PrivatePeerV2StatusRequest {
  if (!(input instanceof Uint8Array) || input.byteLength > PRIVATE_PEER_V2_MAX_STATUS_REQUEST_BYTES)
    invalidRequest();
  const bytes = Buffer.from(input);
  if (
    bytes.length < requestMagic.length + nonceBytes + 1 + 2 + 4 + 5 ||
    !bytes.subarray(0, requestMagic.length).equals(requestMagic)
  )
    invalidRequest();

  let offset = requestMagic.length;
  const nonce = Buffer.from(bytes.subarray(offset, offset + nonceBytes));
  offset += nonceBytes;
  if (bytes[offset++] !== 1) invalidRequest(); // Status is the sole accepted verb.
  const sidLength = bytes.readUInt16LE(offset);
  offset += 2;
  if (sidLength < 7 || sidLength > maximumSidBytes || bytes.length - offset < sidLength + 4 + 5)
    invalidRequest();
  const sidBytes = bytes.subarray(offset, offset + sidLength);
  offset += sidLength;
  if (sidBytes.some((byte) => byte > 0x7f)) invalidRequest();
  const observedClientSid = sidBytes.toString("ascii");
  if (!sid.test(observedClientSid)) invalidRequest();

  const frameLength = bytes.readUInt32LE(offset);
  offset += 4;
  if (
    frameLength < 5 ||
    frameLength > maximumClientFrameBytes ||
    frameLength !== bytes.length - offset
  )
    invalidRequest();
  const clientFrame = Buffer.from(bytes.subarray(offset));
  if (clientFrame.readUInt32LE(0) !== frameLength - 4) invalidRequest();

  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(clientFrame.subarray(4));
    parsed = JSON.parse(text);
  } catch {
    invalidRequest();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) invalidRequest();
  const fields = parsed as Record<string, unknown>;
  if (
    Object.keys(fields).length !== 5 ||
    !validOpaque(fields.request_id) ||
    !validOpaque(fields.run_id) ||
    !validOpaque(fields.attempt_id) ||
    fields.schema_version !== "1.0.0" ||
    fields.verb !== "attempt.status" ||
    text !== canonicalStatusRequest(fields.request_id, fields.run_id, fields.attempt_id)
  )
    invalidRequest();

  return {
    nonce,
    observedClientSid,
    requestId: fields.request_id,
    runId: fields.run_id,
    attemptId: fields.attempt_id,
    clientFrame,
  };
}

function canonicalUnknownStatus(requestId: string, runId: string, attemptId: string): string {
  return (
    "{\n" +
    `  "attempt_id": "${attemptId}",\n` +
    '  "authorizes_execution": false,\n' +
    '  "effect_state": "effect_unknown",\n' +
    '  "kind": "status",\n' +
    '  "reason_code": "protected_store_unavailable",\n' +
    `  "request_id": "${requestId}",\n` +
    `  "run_id": "${runId}",\n` +
    '  "schema_version": "2.0.0",\n' +
    '  "state": "indeterminate"\n' +
    "}\n"
  );
}

/** Encode only the existing conservative reply. No no-effect variant exists. */
export function encodePrivatePeerV2UnknownStatusReply(request: PrivatePeerV2StatusRequest): Buffer {
  if (
    !(request.nonce instanceof Uint8Array) ||
    request.nonce.byteLength !== nonceBytes ||
    !validOpaque(request.requestId) ||
    !validOpaque(request.runId) ||
    !validOpaque(request.attemptId)
  )
    throw new Error("invalid_private_status_reply_input");
  const payload = Buffer.from(
    canonicalUnknownStatus(request.requestId, request.runId, request.attemptId),
    "utf8"
  );
  if (payload.length === 0 || payload.length > maximumStatusFrameBytes - 4)
    throw new Error("invalid_private_status_reply_bound");
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  const reply = Buffer.alloc(replyMagic.length + nonceBytes + 4 + frame.length);
  let offset = replyMagic.copy(reply, 0);
  Buffer.from(request.nonce).copy(reply, offset);
  offset += nonceBytes;
  reply.writeUInt32LE(frame.length, offset);
  frame.copy(reply, offset + 4);
  return reply;
}

/** Validate a conservative reply for one expected request. No status authority follows. */
export function parsePrivatePeerV2UnknownStatusReply(
  input: Uint8Array,
  expected: PrivatePeerV2StatusRequest
): { readonly effectState: "effect_unknown"; readonly authorizesExecution: false } {
  if (!(input instanceof Uint8Array) || input.byteLength > PRIVATE_PEER_V2_MAX_STATUS_REPLY_BYTES)
    throw new Error("invalid_private_status_reply");
  const bytes = Buffer.from(input);
  if (
    bytes.length < replyMagic.length + nonceBytes + 4 + 5 ||
    !bytes.subarray(0, replyMagic.length).equals(replyMagic) ||
    !bytes
      .subarray(replyMagic.length, replyMagic.length + nonceBytes)
      .equals(Buffer.from(expected.nonce))
  )
    throw new Error("invalid_private_status_reply");
  const frameLength = bytes.readUInt32LE(replyMagic.length + nonceBytes);
  const frame = bytes.subarray(replyMagic.length + nonceBytes + 4);
  if (
    frameLength < 5 ||
    frameLength > maximumStatusFrameBytes ||
    frameLength !== frame.length ||
    frame.readUInt32LE(0) !== frame.length - 4 ||
    !bytes.equals(encodePrivatePeerV2UnknownStatusReply(expected))
  )
    throw new Error("invalid_private_status_reply");
  return { effectState: "effect_unknown", authorizesExecution: false };
}
