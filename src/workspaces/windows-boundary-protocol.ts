import { TextDecoder } from "node:util";
import { z } from "zod";

import { canonicalJSONStringify } from "../util/canonicalJson.js";

/** Negotiation only. Parsing these messages never qualifies a production helper. */
export const WINDOWS_BOUNDARY_PROTOCOL_VERSION = "1.0.0" as const;
export const WINDOWS_BOUNDARY_CONTROL_BYTES = 4_096;
export const WINDOWS_BOUNDARY_NEGOTIATION_FRAMES = 16;
const MAX_STREAM_BYTES = WINDOWS_BOUNDARY_NEGOTIATION_FRAMES * (4 + WINDOWS_BOUNDARY_CONTROL_BYTES);
const Nonce = z.string().regex(/^[a-f0-9]{64}$/u);
const RequestId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/u);
const Common = {
  protocol_version: z.literal(WINDOWS_BOUNDARY_PROTOCOL_VERSION),
  request_id: RequestId,
  client_nonce: Nonce,
};
export const WindowsBoundaryHello = z.strictObject({
  ...Common,
  kind: z.literal("hello"),
});
export const WindowsBoundaryHelloResult = z.strictObject({
  ...Common,
  kind: z.literal("hello_result"),
  session_nonce: Nonce,
  helper: z.strictObject({
    artifact_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    architecture: z.enum(["x64", "arm64"]),
    process_id: z.number().int().positive().max(0xffffffff),
  }),
});
const Message = z.discriminatedUnion("kind", [WindowsBoundaryHello, WindowsBoundaryHelloResult]);
export type WindowsBoundaryControlMessage = z.infer<typeof Message>;
const OperationCommon = {
  ...Common,
  session_nonce: Nonce,
  operation_id: RequestId,
  request_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
};
export const WindowsBoundaryStatusRequest = z.strictObject({
  ...OperationCommon,
  kind: z.literal("session_request"),
  operation: z.literal("session-status"),
});
export const WindowsBoundaryStatusResult = z.strictObject({
  ...OperationCommon,
  kind: z.literal("session_result"),
  status: z.literal("alive"),
});
const SessionMessage = z.discriminatedUnion("kind", [
  WindowsBoundaryHello,
  WindowsBoundaryHelloResult,
  WindowsBoundaryStatusRequest,
  WindowsBoundaryStatusResult,
]);
type SessionMessage = z.infer<typeof SessionMessage>;

export class WindowsBoundaryProtocolError extends Error {
  constructor(
    readonly code: "invalid_frame" | "stream_limit" | "truncated_stream" | "stream_closed"
  ) {
    super(`Windows boundary negotiation: ${code}`);
    this.name = "WindowsBoundaryProtocolError";
  }
}

/** Four-byte unsigned big-endian UTF-8 byte length, then exact canonical JSON. */
export function encodeWindowsBoundaryControl(value: unknown): Buffer {
  return encodeFrame(value, false);
}

/** Explicit bounded development session profile; negotiation stays strict by default. */
export function encodeWindowsBoundarySession(value: unknown): Buffer {
  return encodeFrame(value, true);
}

function encodeFrame(value: unknown, sessionMode: boolean): Buffer {
  const parsed = (sessionMode ? SessionMessage : Message).safeParse(value);
  if (!parsed.success) throw new WindowsBoundaryProtocolError("invalid_frame");
  const bytes = Buffer.from(canonicalJSONStringify(parsed.data), "utf8");
  if (bytes.length === 0 || bytes.length > WINDOWS_BOUNDARY_CONTROL_BYTES) {
    throw new WindowsBoundaryProtocolError("invalid_frame");
  }
  const frame = Buffer.alloc(4 + bytes.length);
  frame.writeUInt32BE(bytes.length);
  bytes.copy(frame, 4);
  return frame;
}

/** Fixed storage; malformed input and budget exhaustion permanently close the decoder. */
export class WindowsBoundaryControlDecoder {
  constructor(private readonly sessionMode = false) {}
  private readonly header = Buffer.alloc(4);
  private readonly payload = Buffer.alloc(WINDOWS_BOUNDARY_CONTROL_BYTES);
  private headerUsed = 0;
  private payloadUsed = 0;
  private payloadLength = 0;
  private streamBytes = 0;
  private frames = 0;
  private closed = false;

  push(chunk: Uint8Array): SessionMessage[] {
    if (this.closed) throw new WindowsBoundaryProtocolError("stream_closed");
    if (chunk.byteLength > MAX_STREAM_BYTES - this.streamBytes) return this.fail("stream_limit");
    this.streamBytes += chunk.byteLength;
    const messages: SessionMessage[] = [];
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (this.headerUsed < 4) {
        const count = Math.min(4 - this.headerUsed, chunk.byteLength - offset);
        this.header.set(chunk.subarray(offset, offset + count), this.headerUsed);
        this.headerUsed += count;
        offset += count;
        if (this.headerUsed < 4) continue;
        this.payloadLength = this.header.readUInt32BE();
        if (this.payloadLength === 0 || this.payloadLength > WINDOWS_BOUNDARY_CONTROL_BYTES) {
          return this.fail("invalid_frame");
        }
        if (this.frames >= WINDOWS_BOUNDARY_NEGOTIATION_FRAMES) return this.fail("stream_limit");
      }
      const count = Math.min(this.payloadLength - this.payloadUsed, chunk.byteLength - offset);
      this.payload.set(chunk.subarray(offset, offset + count), this.payloadUsed);
      this.payloadUsed += count;
      offset += count;
      if (this.payloadUsed !== this.payloadLength) continue;
      try {
        const bytes = this.payload.subarray(0, this.payloadLength);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const parsed = (this.sessionMode ? SessionMessage : Message).parse(JSON.parse(text));
        // Reject duplicate keys, alternate encodings/BOM and noncanonical JSON on the wire.
        if (!bytes.equals(Buffer.from(canonicalJSONStringify(parsed), "utf8"))) {
          return this.fail("invalid_frame");
        }
        messages.push(parsed);
      } catch {
        return this.fail("invalid_frame");
      }
      this.frames++;
      this.headerUsed = this.payloadUsed = this.payloadLength = 0;
    }
    return messages;
  }

  end(): void {
    if (this.closed) throw new WindowsBoundaryProtocolError("stream_closed");
    if (this.headerUsed !== 0 || this.payloadUsed !== 0) return this.fail("truncated_stream");
    this.closed = true;
    this.payload.fill(0);
  }

  private fail(code: WindowsBoundaryProtocolError["code"]): never {
    this.closed = true;
    this.header.fill(0);
    this.payload.fill(0);
    throw new WindowsBoundaryProtocolError(code);
  }
}

/** Compare reported metadata to a specific launch; this is not executable authentication. */
export function assessWindowsBoundaryHello(
  request: z.infer<typeof WindowsBoundaryHello>,
  response: z.infer<typeof WindowsBoundaryHelloResult>,
  launched: z.infer<typeof WindowsBoundaryHelloResult>["helper"]
): { matched: boolean; verification: "not_performed" } {
  const input = WindowsBoundaryHello.safeParse(request);
  const output = WindowsBoundaryHelloResult.safeParse(response);
  const expected = WindowsBoundaryHelloResult.shape.helper.safeParse(launched);
  return {
    matched:
      input.success &&
      output.success &&
      expected.success &&
      input.data.request_id === output.data.request_id &&
      input.data.client_nonce === output.data.client_nonce &&
      output.data.helper.process_id === expected.data.process_id &&
      output.data.helper.architecture === expected.data.architecture &&
      output.data.helper.artifact_sha256 === expected.data.artifact_sha256,
    verification: "not_performed",
  };
}
