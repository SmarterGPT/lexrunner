import { describe, expect, it } from "vitest";
import { canonicalJSONStringify } from "../../src/util/canonicalJson.js";
import {
  assessWindowsBoundaryHello,
  encodeWindowsBoundaryControl,
  encodeWindowsBoundarySession,
  WINDOWS_BOUNDARY_CONTROL_BYTES,
  WINDOWS_BOUNDARY_NEGOTIATION_FRAMES,
  WindowsBoundaryControlDecoder,
  WindowsBoundaryProtocolError,
} from "../../src/workspaces/windows-boundary-protocol.js";

it("requires explicit session decoding and keeps negotiation closed to operations", () => {
  const operation = {
    kind: "session_result",
    protocol_version: "1.0.0",
    request_id: "r1",
    client_nonce: "a".repeat(64),
    session_nonce: "b".repeat(64),
    operation_id: "op1",
    request_digest: `sha256:${"c".repeat(64)}`,
    status: "alive",
  };
  const frame = encodeWindowsBoundarySession(operation);
  expect(() => encodeWindowsBoundaryControl(operation)).toThrow();
  expect(() => new WindowsBoundaryControlDecoder().push(frame)).toThrow();
  expect(new WindowsBoundaryControlDecoder(true).push(frame)).toEqual([operation]);
});

const request = {
  kind: "hello" as const,
  protocol_version: "1.0.0" as const,
  request_id: "request-1",
  client_nonce: "a".repeat(64),
};
const response = {
  ...request,
  kind: "hello_result" as const,
  session_nonce: "b".repeat(64),
  helper: {
    artifact_sha256: `sha256:${"c".repeat(64)}`,
    architecture: "x64" as const,
    process_id: 42,
  },
};
function raw(text: string | Buffer): Buffer {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text);
  const frame = Buffer.alloc(bytes.length + 4);
  frame.writeUInt32BE(bytes.length);
  bytes.copy(frame, 4);
  return frame;
}
function expectTerminalFailure(frame: Uint8Array, code = "invalid_frame") {
  const decoder = new WindowsBoundaryControlDecoder();
  expect(() => decoder.push(frame)).toThrow(expect.objectContaining({ code }));
  expect(() => decoder.push(encodeWindowsBoundaryControl(request))).toThrow(
    expect.objectContaining({ code: "stream_closed" })
  );
  expect(() => decoder.end()).toThrow(WindowsBoundaryProtocolError);
}

describe("Windows boundary negotiation codec", () => {
  it("matches the fixed v1 wire vector independently of the decoder", () => {
    const payload =
      '{\n  "client_nonce": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",\n  "kind": "hello",\n  "protocol_version": "1.0.0",\n  "request_id": "request-1"\n}\n';
    const vector = Buffer.concat([Buffer.from([0, 0, 0, 168]), Buffer.from(payload, "utf8")]);
    expect(encodeWindowsBoundaryControl(request)).toEqual(vector);
    expect(new WindowsBoundaryControlDecoder().push(vector)).toEqual([request]);
  });
  it("round trips coalesced frames and each possible split without changing bytes", () => {
    const frames = Buffer.concat([
      encodeWindowsBoundaryControl(request),
      encodeWindowsBoundaryControl(response),
    ]);
    for (let split = 0; split <= frames.length; split++) {
      const decoder = new WindowsBoundaryControlDecoder();
      expect([
        ...decoder.push(frames.subarray(0, split)),
        ...decoder.push(frames.subarray(split)),
      ]).toEqual([request, response]);
      decoder.end();
    }
  });
  it("handles byte-at-a-time input without retaining caller-owned buffers", () => {
    const decoder = new WindowsBoundaryControlDecoder();
    const messages = [];
    for (const byte of encodeWindowsBoundaryControl(response)) {
      const part = Buffer.from([byte]);
      messages.push(...decoder.push(part));
      part[0] = 0;
    }
    expect(messages).toEqual([response]);
    decoder.end();
  });
  it("rejects every incomplete prefix at EOF and cannot resume after EOF", () => {
    const frame = encodeWindowsBoundaryControl(response);
    for (let length = 1; length < frame.length; length++) {
      const decoder = new WindowsBoundaryControlDecoder();
      expect(decoder.push(frame.subarray(0, length))).toEqual([]);
      expect(() => decoder.end()).toThrow(expect.objectContaining({ code: "truncated_stream" }));
      expect(() => decoder.push(frame)).toThrow(expect.objectContaining({ code: "stream_closed" }));
    }
  });
  it("closes a complete or empty stream without admitting later input", () => {
    const decoder = new WindowsBoundaryControlDecoder();
    decoder.end();
    expect(() => decoder.push(new Uint8Array())).toThrow(
      expect.objectContaining({ code: "stream_closed" })
    );
  });
  it.each([0, WINDOWS_BOUNDARY_CONTROL_BYTES + 1, 0xffffffff])(
    "rejects length %i from the header alone",
    (length) => {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(length);
      expectTerminalFailure(header);
    }
  );
  it.each([
    Buffer.from([0xc3, 0x28]),
    Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from(JSON.stringify(request))]),
    Buffer.from('{"kind":"hello","kind":"hello"}'),
    Buffer.from(JSON.stringify(request)),
    Buffer.from("null"),
    Buffer.from("[]"),
    Buffer.from("{"),
  ])("rejects malformed, ambiguous or noncanonical bytes", (bytes) => {
    expectTerminalFailure(raw(bytes));
  });
  it.each([
    { ...request, protocol_version: "2.0.0" },
    { ...request, kind: "execute" },
    { ...request, request_id: "bad\nidentifier" },
    { ...request, client_nonce: "a" },
    { ...request, authority: "ready" },
    { ...response, helper: { ...response.helper, authority: true } },
    { ...response, helper: { ...response.helper, process_id: -1 } },
    { ...response, helper: { ...response.helper, architecture: "ia32" } },
  ])("rejects unknown fields and incompatible message values", (message) => {
    expect(() => encodeWindowsBoundaryControl(message)).toThrow(
      expect.objectContaining({ code: "invalid_frame" })
    );
    expectTerminalFailure(raw(canonicalJSONStringify(message)));
  });
  it("enforces frame and byte budgets across fragmented calls", () => {
    const decoder = new WindowsBoundaryControlDecoder();
    const frame = encodeWindowsBoundaryControl(request);
    for (let i = 0; i < WINDOWS_BOUNDARY_NEGOTIATION_FRAMES; i++) {
      expect(decoder.push(frame)).toEqual([request]);
    }
    expect(() => decoder.push(frame.subarray(0, 4))).toThrow(
      expect.objectContaining({ code: "stream_limit" })
    );
    expectTerminalFailure(
      new Uint8Array(
        (WINDOWS_BOUNDARY_CONTROL_BYTES + 4) * WINDOWS_BOUNDARY_NEGOTIATION_FRAMES + 1
      ),
      "stream_limit"
    );
  });
  it("rejects a malformed coalesced batch without returning its valid prefix", () => {
    expectTerminalFailure(
      Buffer.concat([encodeWindowsBoundaryControl(request), raw("bad private payload")])
    );
    try {
      new WindowsBoundaryControlDecoder().push(raw("bad private payload"));
    } catch (error) {
      expect(String(error)).not.toContain("private payload");
    }
  });
});

describe("reported hello binding", () => {
  it("matches a specific launch without claiming executable verification", () => {
    expect(assessWindowsBoundaryHello(request, response, response.helper)).toEqual({
      matched: true,
      verification: "not_performed",
    });
  });
  it.each([
    { ...response, request_id: "another-request" },
    { ...response, client_nonce: "d".repeat(64) },
    { ...response, helper: { ...response.helper, process_id: 43 } },
    { ...response, helper: { ...response.helper, architecture: "arm64" as const } },
    { ...response, helper: { ...response.helper, artifact_sha256: `sha256:${"e".repeat(64)}` } },
  ])("rejects another launch's reported metadata", (other) => {
    expect(assessWindowsBoundaryHello(request, other, response.helper)).toEqual({
      matched: false,
      verification: "not_performed",
    });
  });
});
