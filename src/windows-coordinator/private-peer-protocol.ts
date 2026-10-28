import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";

import { canonicalJSONStringify } from "../util/canonicalJson.js";
import { WINDOWS_COORDINATOR_MAX_FRAME_BYTES } from "./client-protocol.js";
import { WindowsCoordinatorDenial_v1 } from "./deny-first-dispatcher.js";

// Private, one-shot NativeAOT-host/Node-fixture stdio protocol. A syntactically
// valid envelope is not proof of peer origin when this worker is launched alone.
const requestMagic = Buffer.from("LXNPEER1", "ascii");
const replyMagic = Buffer.from("LXNREPL1", "ascii");
const nonceBytes = 16;
const maximumSidBytes = 184;
const maximumClientFrameBytes = WINDOWS_COORDINATOR_MAX_FRAME_BYTES + 4;
const maximumDenialFrameBytes = 4096;

export const PRIVATE_PEER_MAX_REQUEST_BYTES =
  requestMagic.length + nonceBytes + 2 + maximumSidBytes + 4 + maximumClientFrameBytes;
export const PRIVATE_PEER_MAX_REPLY_BYTES =
  replyMagic.length + nonceBytes + 4 + maximumDenialFrameBytes;

export interface PrivatePeerObservation {
  readonly nonce: Buffer;
  readonly observedClientSid: string;
  readonly clientFrame: Buffer;
}

export function parsePrivatePeerObservation(input: Uint8Array): PrivatePeerObservation {
  if (!(input instanceof Uint8Array) || input.byteLength > PRIVATE_PEER_MAX_REQUEST_BYTES)
    throw new Error("invalid_private_peer_frame");
  const bytes = Buffer.from(input);
  let offset = 0;
  if (
    bytes.length < requestMagic.length + nonceBytes + 2 + 4 ||
    !bytes.subarray(0, requestMagic.length).equals(requestMagic)
  )
    throw new Error("invalid_private_peer_frame");
  offset += requestMagic.length;
  const nonce = Buffer.from(bytes.subarray(offset, offset + nonceBytes));
  offset += nonceBytes;
  const sidLength = bytes.readUInt16LE(offset);
  offset += 2;
  if (sidLength < 7 || sidLength > maximumSidBytes || bytes.length - offset < sidLength + 4)
    throw new Error("invalid_private_peer_frame");
  const sidBytes = bytes.subarray(offset, offset + sidLength);
  offset += sidLength;
  if (sidBytes.some((byte) => byte > 0x7f)) throw new Error("invalid_private_peer_frame");
  const observedClientSid = new TextDecoder("ascii", { fatal: true }).decode(sidBytes);
  if (!/^S-1-(?:[0-9]+-){1,14}[0-9]+$/u.test(observedClientSid))
    throw new Error("invalid_private_peer_frame");
  const frameLength = bytes.readUInt32LE(offset);
  offset += 4;
  if (
    frameLength < 4 ||
    frameLength > maximumClientFrameBytes ||
    frameLength !== bytes.length - offset
  )
    throw new Error("invalid_private_peer_frame");
  return {
    nonce,
    observedClientSid,
    clientFrame: Buffer.from(bytes.subarray(offset)),
  };
}

export function encodePrivatePeerDenial(nonce: Uint8Array, denialValue: unknown): Buffer {
  if (!(nonce instanceof Uint8Array) || nonce.byteLength !== nonceBytes)
    throw new Error("invalid_private_peer_nonce");
  const denial = WindowsCoordinatorDenial_v1.parse(denialValue);
  const payload = Buffer.from(canonicalJSONStringify(denial), "utf8");
  if (payload.length + 4 > maximumDenialFrameBytes)
    throw new Error("invalid_private_peer_denial_bound");
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  const reply = Buffer.alloc(replyMagic.length + nonceBytes + 4 + frame.length);
  let offset = 0;
  replyMagic.copy(reply, offset);
  offset += replyMagic.length;
  Buffer.from(nonce).copy(reply, offset);
  offset += nonceBytes;
  reply.writeUInt32LE(frame.length, offset);
  offset += 4;
  frame.copy(reply, offset);
  return reply;
}

export function parsePrivatePeerDenial(input: Uint8Array, expectedNonce: Uint8Array) {
  if (
    !(input instanceof Uint8Array) ||
    input.byteLength > PRIVATE_PEER_MAX_REPLY_BYTES ||
    !(expectedNonce instanceof Uint8Array) ||
    expectedNonce.byteLength !== nonceBytes
  )
    throw new Error("invalid_private_peer_reply");
  const bytes = Buffer.from(input);
  if (
    bytes.length < replyMagic.length + nonceBytes + 4 + 5 ||
    !bytes.subarray(0, replyMagic.length).equals(replyMagic) ||
    !bytes
      .subarray(replyMagic.length, replyMagic.length + nonceBytes)
      .equals(Buffer.from(expectedNonce))
  )
    throw new Error("invalid_private_peer_reply");
  const offset = replyMagic.length + nonceBytes;
  const frameLength = bytes.readUInt32LE(offset);
  const frame = bytes.subarray(offset + 4);
  if (
    frameLength < 5 ||
    frameLength > maximumDenialFrameBytes ||
    frameLength !== frame.length ||
    frame.readUInt32LE(0) !== frame.length - 4
  )
    throw new Error("invalid_private_peer_reply");
  let json: string;
  let parsed: unknown;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(4));
    parsed = JSON.parse(json);
  } catch {
    throw new Error("invalid_private_peer_reply");
  }
  const denial = WindowsCoordinatorDenial_v1.parse(parsed);
  if (!frame.subarray(4).equals(Buffer.from(canonicalJSONStringify(denial), "utf8")))
    throw new Error("invalid_private_peer_reply");
  return denial;
}
