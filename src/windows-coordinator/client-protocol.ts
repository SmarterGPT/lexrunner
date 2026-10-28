import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";

import { z } from "zod";

import { AgentTaskPacket_v1 } from "../schemas/agent-work.js";
import { canonicalJSONStringify } from "../util/canonicalJson.js";

export const WINDOWS_COORDINATOR_CLIENT_PROTOCOL_VERSION = "1.0.0";
export const WINDOWS_COORDINATOR_MAX_FRAME_BYTES = 1024 * 1024;

const opaqueId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

const requestBase = z.object({
  schema_version: z.literal(WINDOWS_COORDINATOR_CLIENT_PROTOCOL_VERSION),
  request_id: opaqueId,
});

const prepareRequest = requestBase
  .extend({
    verb: z.literal("attempt.prepare"),
    /** Untrusted retry correlation only; the service mints its own operation ID and fence. */
    client_idempotency_key: opaqueId,
    packet: AgentTaskPacket_v1,
  })
  .strict();

const statusRequest = requestBase
  .extend({
    verb: z.literal("attempt.status"),
    run_id: opaqueId,
    attempt_id: opaqueId,
  })
  .strict();

/**
 * Client intent only. The protected coordinator must derive admission, policy,
 * repository identity, allocation paths, controller fence and operation effects
 * from its own protected state. No client field in this schema grants authority.
 */
export const WindowsCoordinatorClientRequest_v1 = z.discriminatedUnion("verb", [
  prepareRequest,
  statusRequest,
]);

export type WindowsCoordinatorClientRequest_v1 = z.infer<typeof WindowsCoordinatorClientRequest_v1>;

export type WindowsCoordinatorClientFrameParse =
  | { readonly ok: true; readonly request: WindowsCoordinatorClientRequest_v1 }
  | { readonly ok: false; readonly reason: "invalid_frame" | "invalid_request" };

const invalidFrame = (): WindowsCoordinatorClientFrameParse => ({
  ok: false,
  reason: "invalid_frame",
});
const invalidRequest = (): WindowsCoordinatorClientFrameParse => ({
  ok: false,
  reason: "invalid_request",
});

/** Parse exactly one canonical UTF-8 JSON request in a bounded LE32 frame. */
export function parseWindowsCoordinatorClientFrame(
  input: Uint8Array
): WindowsCoordinatorClientFrameParse {
  if (
    !(input instanceof Uint8Array) ||
    input.byteLength < 5 ||
    input.byteLength > WINDOWS_COORDINATOR_MAX_FRAME_BYTES + 4
  ) {
    return invalidFrame();
  }

  // Keep the length and payload from one snapshot if the caller owns a mutable view.
  const frame = Buffer.from(input);
  const length = frame.readUInt32LE(0);
  if (
    length === 0 ||
    length > WINDOWS_COORDINATOR_MAX_FRAME_BYTES ||
    length !== frame.byteLength - 4
  ) {
    return invalidFrame();
  }

  let json: string;
  let parsed: unknown;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(4));
    parsed = JSON.parse(json);
  } catch {
    return invalidFrame();
  }
  try {
    const result = WindowsCoordinatorClientRequest_v1.safeParse(parsed);
    if (!result.success) return invalidRequest();

    // Canonical bytes rule out duplicate keys and parser-dependent encodings.
    if (canonicalJSONStringify(result.data) !== json) return invalidFrame();
    return { ok: true, request: result.data };
  } catch {
    // Hostile nesting must be a denial, never an uncaught parser failure.
    return invalidRequest();
  }
}

/** Produce the only accepted client frame encoding; this does not send it. */
export function encodeWindowsCoordinatorClientFrame(input: unknown): Uint8Array {
  const request = WindowsCoordinatorClientRequest_v1.parse(input);
  const payload = Buffer.from(canonicalJSONStringify(request), "utf8");
  if (payload.byteLength > WINDOWS_COORDINATOR_MAX_FRAME_BYTES) {
    throw new RangeError("Windows coordinator request exceeds frame limit");
  }
  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32LE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}
