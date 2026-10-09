import { CodexProviderIngressSession } from "../../src/runs/codex-provider-ingress-session.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import type { ClientRequest, IncomingMessage, IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexProviderHumanAnswerObserver } from "../../src/runs/codex-provider-human-answer-observer.js";
import {
  CodexHumanAnswerOutputEvidence,
  recordRetainedCodexHumanAnswerOutput,
} from "../../src/runs/codex-human-answer-evidence.js";
import { ProtectedEvidenceCaptureSession } from "../../src/runs/governed-attempt-evidence.js";
import type { GovernedAttemptEvidenceCapture } from "../../src/runs/governed-attempt-evidence.js";
import { LocalProtectedEvidenceStore } from "../../src/store/local-protected-evidence-store.js";
import { LocalProtectedEvidenceVerifier } from "../../src/store/local-protected-evidence-verifier.js";
import { computeCanonicalHash } from "../../src/schemas/task-contract.js";
import { hashWorkerHumanInput } from "../../src/schemas/worker-human-input.js";
import { humanActionSummary } from "../../src/runs/agent-work-human-action-service.js";
import { canonicalJSONStringify } from "../../src/util/canonicalJson.js";
import { humanAnswerFixture } from "../store/worker-human-answer-fixture.js";

type Fixture = Awaited<ReturnType<typeof humanAnswerFixture>>;
type ObserverResult = Awaited<ReturnType<CodexProviderHumanAnswerObserver["observe"]>>;
type AppendInput = Parameters<GovernedAttemptEvidenceCapture["append"]>[0];
type AppendResult = Awaited<ReturnType<GovernedAttemptEvidenceCapture["append"]>>;
const fixtures: Fixture[] = [];
const DIGEST = "sha256:" + "a".repeat(64);
const PROMPT_CANARY = "private-unrelated-prompt-canary";
const HEADER_CANARY = "private-header-canary";
const SECRET_ERROR = "protected-path-or-secret-error-canary";
const ingressSessions: CodexProviderIngressSession[] = [];

afterEach(async () => {
  for (const session of ingressSessions.splice(0)) session.revoke();
  for (const f of fixtures.splice(0)) await f.cleanup();
});

async function prepared(
  kind: "memory" | "sqlite" = "memory",
  freeText = false,
  connectionId?: string
) {
  const f = await humanAnswerFixture(kind);
  fixtures.push(f);
  f.session.workerRuntime = "codex-native";
  f.session.workerId = "thread";
  const nativeRequest = {
    id: 7,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId: "question-call",
      questions: [
        {
          id: "choice",
          header: "Candidate",
          question: "Which candidate?",
          isOther: false,
          options: freeText
            ? null
            : [
                { label: "A", description: "Candidate A" },
                { label: "B", description: "Candidate B" },
              ],
        },
      ],
    },
  };
  const capture = {
    ...f.capture(),
    ...(connectionId ? { connectionId, observationId: `${connectionId}:1` } : {}),
    requestJson: JSON.stringify(nativeRequest),
    providerRequestId: 7,
  };
  if (freeText) capture.questions[0]!.options = null;
  capture.requestHash = hashWorkerHumanInput(capture.requestJson);
  const requestId = await f.record(capture);
  const value = freeText ? "  café\n猫 e\u0301  " : "A";
  const answer = f.signed(await f.challenge(requestId), {
    answers: [{ questionId: "choice", value }],
  });
  expect(
    await f.service.admitWorkerAnswer({ ...(await f.mutation("answer")), answer })
  ).toMatchObject({ ok: true });
  const claimId = randomUUID();
  expect(
    await f.service.claimWorkerAnswerDelivery({
      ...(await f.mutation("claim")),
      requestId,
      claimId,
    })
  ).toMatchObject({ ok: true, newlyClaimed: true });
  expect(
    await f.service.recordWorkerAnswerWrite({
      ...(await f.mutation("write")),
      requestId,
      claimId,
      disposition: "written",
    })
  ).toMatchObject({ ok: true });
  const output = {
    type: "function_call_output" as const,
    call_id: "question-call",
    // Authored result fixtures are independent of the observer's projection.
    output: freeText
      ? '{"answers":{"choice":{"answers":["  café\\n猫 é  "]}}}'
      : '{"answers":{"choice":{"answers":["A"]}}}',
  };
  const binding = { runId: "run", requestId, claimId, capture, answer };
  return { f, binding, output };
}

function body(output: unknown, prefix: unknown[] = []) {
  return Buffer.from(
    JSON.stringify({
      model: "synthetic-no-inference",
      input: [{ type: "message", role: "user", content: PROMPT_CANARY }, ...prefix, output],
      store: false,
    }),
    "utf8"
  );
}

function sink(captureId = "provider-capture-1") {
  const frames: AppendInput[] = [];
  const append = vi.fn(async (input: AppendInput): Promise<AppendResult> => {
    frames.push({ ...input, bytes: Uint8Array.from(input.bytes) });
    return { captureId, sequence: frames.length, evidenceRef: DIGEST };
  });
  return { captureId, frames, append };
}

function assertCompact(result: ObserverResult) {
  const compact = JSON.stringify(result);
  for (const canary of [
    PROMPT_CANARY,
    HEADER_CANARY,
    SECRET_ERROR,
    '"answers"',
    '"signature"',
    '"authorization"',
    '"output"',
  ])
    expect(compact).not.toContain(canary);
}

type DeliveryOptions = {
  bytes?: Uint8Array;
  parts?: readonly Uint8Array[];
  method?: string;
  path?: string;
  headers?: IncomingHttpHeaders;
  timeoutMs?: number;
  controller?: AbortController;
  leaveOpen?: boolean;
  abortClient?: boolean;
  cancelAfterWrite?: boolean;
  beforeObserve?: (request: IncomingMessage) => void | Promise<void>;
  afterStarted?: () => void | Promise<void>;
};

/** Real IncomingMessage ingress on an ephemeral loopback port; no provider or inference. */
async function deliver(
  observer: CodexProviderHumanAnswerObserver,
  options: DeliveryOptions
): Promise<ObserverResult> {
  let resolveResult!: (result: ObserverResult) => void;
  let rejectResult!: (error: unknown) => void;
  const observed = new Promise<ObserverResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const controller = options.controller ?? new AbortController();
  const server = createServer((incoming, response) => {
    start();
    void (async () => {
      try {
        await options.beforeObserve?.(incoming);
        const result = await observer.observe(incoming, {
          signal: controller.signal,
          timeoutMs: options.timeoutMs ?? 1000,
        });
        resolveResult(result);
      } catch (error) {
        rejectResult(error);
      } finally {
        response.end();
      }
    })();
  });
  let client: ClientRequest | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    client = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "POST",
        path: options.path ?? "/v1/responses",
        headers: Object.fromEntries(
          Object.entries({
            "content-type": "application/json",
            authorization: "Bearer " + HEADER_CANARY,
            "x-observer-test": HEADER_CANARY,
            ...options.headers,
          }).filter(([, value]) => value !== undefined)
        ),
      },
      (response) => response.resume()
    );
    client.on("error", () => undefined);
    client.flushHeaders();
    await started;
    await options.afterStarted?.();
    for (const part of options.parts ?? [options.bytes ?? Buffer.from("{}")]) client.write(part);
    if (options.cancelAfterWrite) controller.abort();
    if (options.abortClient) {
      // Permit the partial bytes to reach the server before terminating the connection.
      await new Promise<void>((resolve) => setImmediate(resolve));
      client.destroy();
    } else if (!options.leaveOpen) client.end();
    return await observed;
  } finally {
    client?.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("bounded provider answer-request observation", () => {
  it.each(["application/json", "application/json; charset=utf-8"])(
    "captures an exact split request using %s without retaining prompts or headers",
    async (contentType) => {
      const p = await prepared();
      const evidence = sink();
      const observer = new CodexProviderHumanAnswerObserver(evidence, p.binding, () => p.f.time);
      const bytes = body(p.output);
      const result = await deliver(observer, {
        parts: [bytes.subarray(0, 9), bytes.subarray(9, 61), bytes.subarray(61)],
        headers: { "content-type": contentType },
      });
      expect(result).toMatchObject({
        status: "captured",
        captureId: evidence.captureId,
        frameSequence: 1,
        frameHash: DIGEST,
        requestHash: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
        sourceAuthenticated: false,
        consumptionQualified: false,
        resendAllowed: false,
      });
      if (result.status !== "captured") throw new Error("capture fixture failed");
      expect(result.observationId).toMatch(/^[A-Za-z0-9._:-]+$/u);
      expect(evidence.append).toHaveBeenCalledTimes(1);
      expect(evidence.frames[0]!.frameClass).toBe("control_evidence");
      const raw = Buffer.from(evidence.frames[0]!.bytes).toString("utf8");
      const frame = CodexHumanAnswerOutputEvidence.parse(JSON.parse(raw));
      expect(raw).toBe(canonicalJSONStringify(frame));
      expect(frame).toMatchObject({
        runId: "run",
        requestId: p.binding.requestId,
        claimId: p.binding.claimId,
        captureHash: computeCanonicalHash(p.binding.capture),
        answerHash: computeCanonicalHash(p.binding.answer),
        observationId: result.observationId,
        output: p.output,
        providerRequest: {
          requestSequence: 1,
          requestBytes: bytes.byteLength,
          requestHash: result.requestHash,
          method: "POST",
          path: "/v1/responses",
        },
      });
      expect(frame.providerRequest!.observerId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
      );
      expect(raw).not.toContain(PROMPT_CANARY);
      expect(raw).not.toContain(HEADER_CANARY);
      expect(raw).not.toContain(p.binding.answer.signature);
      assertCompact(result);
    }
  );

  it("preserves authored Unicode, whitespace and decomposed text across split UTF-8 bytes", async () => {
    const p = await prepared("memory", true);
    const evidence = sink();
    const observer = new CodexProviderHumanAnswerObserver(evidence, p.binding, () => p.f.time);
    const bytes = body(p.output);
    const unicode = bytes.indexOf(Buffer.from("猫"));
    const result = await deliver(observer, {
      parts: [
        bytes.subarray(0, unicode + 1),
        bytes.subarray(unicode + 1, unicode + 2),
        bytes.subarray(unicode + 2),
      ],
    });
    expect(result).toMatchObject({ status: "captured" });
    const frame = JSON.parse(Buffer.from(evidence.frames[0]!.bytes).toString("utf8"));
    expect(frame.output.output).toBe(p.output.output);
    expect(frame.output.output).toContain("e\u0301");
  });

  it("accepts noncanonical provider JSON while retaining a canonical selected envelope", async () => {
    const p = await prepared();
    const evidence = sink();
    const observer = new CodexProviderHumanAnswerObserver(evidence, p.binding, () => p.f.time);
    const bytes = Buffer.from(
      " \n" + JSON.stringify(JSON.parse(body(p.output).toString()), null, 4)
    );
    const result = await deliver(observer, { bytes });
    expect(result).toMatchObject({ status: "captured" });
    const retained = Buffer.from(evidence.frames[0]!.bytes).toString();
    expect(retained).toBe(canonicalJSONStringify(JSON.parse(retained)));
  });

  it("snapshots the host's capture and admitted answer before caller mutation", async () => {
    const p = await prepared();
    const evidence = sink();
    const binding = structuredClone(p.binding);
    const original = structuredClone(binding);
    const observer = new CodexProviderHumanAnswerObserver(evidence, binding, () => p.f.time);
    binding.runId = "changed";
    binding.requestId = "changed";
    binding.claimId = randomUUID();
    binding.capture.workerId = "changed";
    binding.capture.requestJson = "{}";
    binding.answer.payload.answers[0]!.value = "B";
    expect(await deliver(observer, { bytes: body(p.output) })).toMatchObject({
      status: "captured",
    });
    const frame = JSON.parse(Buffer.from(evidence.frames[0]!.bytes).toString("utf8"));
    expect(frame).toMatchObject({
      runId: original.runId,
      requestId: original.requestId,
      claimId: original.claimId,
      captureHash: computeCanonicalHash(original.capture),
      answerHash: computeCanonicalHash(original.answer),
    });
  });

  it("assigns separate observation identities and sequences without resend authority", async () => {
    const p = await prepared();
    const evidence = sink();
    const observer = new CodexProviderHumanAnswerObserver(evidence, p.binding, () => p.f.time);
    const first = await deliver(observer, { bytes: body(p.output) });
    const second = await deliver(observer, { bytes: body(p.output) });
    expect(first).toMatchObject({ status: "captured", resendAllowed: false });
    expect(second).toMatchObject({ status: "captured", resendAllowed: false });
    const frames = evidence.frames.map((f) => JSON.parse(Buffer.from(f.bytes).toString("utf8")));
    expect(frames[0].observationId).not.toBe(frames[1].observationId);
    expect(frames[0].providerRequest.observerId).toBe(frames[1].providerRequest.observerId);
    expect(frames.map((f) => f.providerRequest.requestSequence)).toEqual([1, 2]);
  });

  it("counts failed requests toward the finite observation budget", async () => {
    const p = await prepared();
    const evidence = sink();
    const observer = new CodexProviderHumanAnswerObserver(evidence, p.binding, () => p.f.time);
    for (let sequence = 1; sequence < 128; sequence++)
      expect(await deliver(observer, { bytes: Buffer.from("{}") })).toMatchObject({
        status: "blocked",
      });
    expect(await deliver(observer, { bytes: body(p.output) })).toMatchObject({
      status: "captured",
    });
    const frame = JSON.parse(Buffer.from(evidence.frames[0]!.bytes).toString("utf8"));
    expect(frame.providerRequest.requestSequence).toBe(128);
    expect(await deliver(observer, { bytes: body(p.output) })).toMatchObject({ status: "blocked" });
    expect(evidence.append).toHaveBeenCalledTimes(1);
  });

  it.each(["runId", "requestId", "claimId", "capture", "answer"] as const)(
    "rejects an invalid constructor binding %s without capture",
    async (field) => {
      const p = await prepared();
      const evidence = sink();
      const invalid = { ...p.binding, [field]: field === "claimId" ? "not-uuid" : null };
      expect(
        () => new CodexProviderHumanAnswerObserver(evidence, invalid as never, () => p.f.time)
      ).toThrow();
      expect(evidence.append).not.toHaveBeenCalled();
    }
  );
});

describe("provider source refusal", () => {
  it.each([
    { method: "GET" },
    { path: "/v1/responses?continue=1" },
    { path: "/v1/chat/completions" },
    { headers: { "content-type": "text/plain" } },
    { headers: { "content-type": "application/json; charset=latin1" } },
    { headers: { "content-type": undefined } },
    { headers: { "content-encoding": "gzip" } },
    { headers: { "content-encoding": "identity, gzip" } },
  ])("refuses unsupported request metadata %j", async (options) => {
    const p = await prepared();
    const evidence = sink();
    const observer = new CodexProviderHumanAnswerObserver(evidence, p.binding, () => p.f.time);
    const result = await deliver(observer, { bytes: body(p.output), ...options });
    expect(result).toMatchObject({ status: "blocked" });
    expect(evidence.append).not.toHaveBeenCalled();
    assertCompact(result);
  });

  it("permits explicit identity encoding", async () => {
    const p = await prepared();
    const evidence = sink();
    const observer = new CodexProviderHumanAnswerObserver(evidence, p.binding, () => p.f.time);
    expect(
      await deliver(observer, {
        bytes: body(p.output),
        headers: { "content-encoding": "identity" },
      })
    ).toMatchObject({ status: "captured" });
  });

  it.each(["encoded", "already-read", "destroyed"] as const)(
    "refuses a %s IncomingMessage",
    async (state) => {
      const p = await prepared();
      const evidence = sink();
      const observer = new CodexProviderHumanAnswerObserver(evidence, p.binding, () => p.f.time);
      const result = await deliver(observer, {
        bytes: body(p.output),
        beforeObserve(incoming) {
          if (state === "encoded") incoming.setEncoding("utf8");
          else if (state === "destroyed") incoming.destroy();
          else
            return new Promise<void>((resolve) => {
              incoming.once("end", resolve);
              incoming.resume();
            });
        },
      });
      expect(result).toMatchObject({ status: "blocked" });
      expect(evidence.append).not.toHaveBeenCalled();
    }
  );

  it.each([
    "duplicate-root",
    "duplicate-nested",
    "escaped-key",
    "invalid-utf8",
    "too-deep",
  ] as const)("refuses %s anywhere in the provider body", async (failure) => {
    const p = await prepared();
    const evidence = sink();
    const observer = new CodexProviderHumanAnswerObserver(evidence, p.binding, () => p.f.time);
    let bytes = body(p.output);
    if (failure === "duplicate-root")
      bytes = Buffer.from('{"input":[],"input":[' + JSON.stringify(p.output) + "]}");
    else if (failure === "duplicate-nested")
      bytes = Buffer.from(
        '{"input":[{"type":"message","content":{"x":0,"x":1}},' + JSON.stringify(p.output) + "]}"
      );
    else if (failure === "escaped-key")
      bytes = Buffer.from('{"in\\u0070ut":[],"input":[' + JSON.stringify(p.output) + "]}");
    else if (failure === "invalid-utf8") bytes[bytes.indexOf(PROMPT_CANARY)] = 0xff;
    else {
      let nested: unknown = 0;
      for (let depth = 0; depth < 70; depth++) nested = { nested };
      bytes = Buffer.from(JSON.stringify({ input: [p.output], metadata: nested }));
    }
    const result = await deliver(observer, { bytes });
    expect(result).toMatchObject({ status: "blocked" });
    expect(evidence.append).not.toHaveBeenCalled();
    assertCompact(result);
  });

  it.each([
    "wrong-call",
    "wrong-body",
    "extra-field",
    "duplicate-target",
    "absent",
    "invalid-input",
  ])("refuses %s selected answer content", async (failure) => {
    const p = await prepared();
    const evidence = sink();
    const observer = new CodexProviderHumanAnswerObserver(evidence, p.binding, () => p.f.time);
    let output: unknown = p.output;
    if (failure === "wrong-call") output = { ...p.output, call_id: "another-question" };
    else if (failure === "wrong-body")
      output = { ...p.output, output: '{"answers":{"choice":{"answers":["B"]}}}' };
    else if (failure === "extra-field") output = { ...p.output, id: "unrequested-metadata" };
    const bytes =
      failure === "absent"
        ? Buffer.from('{"input":[]}')
        : failure === "invalid-input"
          ? Buffer.from('{"input":"not-an-array"}')
          : body(output, failure === "duplicate-target" ? [p.output] : []);
    const result = await deliver(observer, { bytes });
    expect(result).toMatchObject({ status: "blocked" });
    expect(evidence.append).not.toHaveBeenCalled();
    assertCompact(result);
  });

  it.each([0, 1])("enforces the actual chunked one-MiB boundary plus %s bytes", async (excess) => {
    const p = await prepared();
    const evidence = sink();
    const observer = new CodexProviderHumanAnswerObserver(evidence, p.binding, () => p.f.time);
    const prefix = { type: "message", role: "user", content: "" };
    const empty = body(p.output, [prefix]);
    const bytes = body(p.output, [
      { ...prefix, content: "x".repeat(1024 * 1024 + excess - empty.byteLength) },
    ]);
    expect(bytes.byteLength).toBe(1024 * 1024 + excess);
    // Both bodies are otherwise valid JSON with the exact applicable answer.
    // A parser failure cannot stand in for enforcement of the byte limit.
    expect(JSON.parse(bytes.toString("utf8")).input[2]).toEqual(p.output);
    const parts = [];
    for (let offset = 0; offset < bytes.length; offset += 65536)
      parts.push(bytes.subarray(offset, offset + 65536));
    const result = await deliver(observer, { parts });
    expect(result).toMatchObject({ status: excess ? "blocked" : "captured" });
    expect(evidence.append).toHaveBeenCalledTimes(excess ? 0 : 1);
    assertCompact(result);
  });
});

describe("observation window and append uncertainty", () => {
  it.each(["cancelled", "timed-out", "partial-abort", "partial-close"] as const)(
    "leaves no capture on a %s incomplete request",
    async (failure) => {
      const p = await prepared();
      const evidence = sink();
      const observer = new CodexProviderHumanAnswerObserver(evidence, p.binding, () => p.f.time);
      const result = await deliver(observer, {
        bytes: Buffer.from('{"input":['),
        timeoutMs: 30,
        leaveOpen: failure === "timed-out" || failure === "cancelled",
        abortClient: failure === "partial-abort",
        cancelAfterWrite: failure === "cancelled",
      });
      expect(result).toMatchObject({ status: "blocked" });
      expect(evidence.append).not.toHaveBeenCalled();
      assertCompact(result);
    }
  );

  it.each([0, 30001, Number.NaN])("refuses invalid deadline %s", async (timeoutMs) => {
    const p = await prepared();
    const evidence = sink();
    const observer = new CodexProviderHumanAnswerObserver(evidence, p.binding, () => p.f.time);
    expect(await deliver(observer, { bytes: body(p.output), timeoutMs })).toMatchObject({
      status: "blocked",
    });
    expect(evidence.append).not.toHaveBeenCalled();
  });

  it("refuses an already-aborted observation window", async () => {
    const p = await prepared();
    const evidence = sink();
    const observer = new CodexProviderHumanAnswerObserver(evidence, p.binding, () => p.f.time);
    const controller = new AbortController();
    controller.abort();
    expect(await deliver(observer, { bytes: body(p.output), controller })).toMatchObject({
      status: "blocked",
    });
    expect(evidence.append).not.toHaveBeenCalled();
  });

  it("blocks concurrent ingress while a previous request is unresolved", async () => {
    const p = await prepared();
    const evidence = sink();
    const observer = new CodexProviderHumanAnswerObserver(evidence, p.binding, () => p.f.time);
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const first = deliver(observer, {
      bytes: Buffer.from('{"input":['),
      leaveOpen: true,
      timeoutMs: 60,
      afterStarted: firstStarted,
    });
    await started;
    const second = await deliver(observer, { bytes: body(p.output) });
    expect(second).toMatchObject({ status: "blocked" });
    expect(await first).toMatchObject({ status: "blocked" });
    expect(evidence.append).not.toHaveBeenCalled();
  });

  it.each(["lost-ack", "wrong-capture", "wrong-sequence", "wrong-hash"] as const)(
    "blocks future observations after %s",
    async (failure) => {
      const p = await prepared();
      const evidence = sink();
      evidence.append.mockImplementation(async (input) => {
        evidence.frames.push({ ...input, bytes: Uint8Array.from(input.bytes) });
        if (failure === "lost-ack") throw new Error(SECRET_ERROR);
        return {
          captureId: failure === "wrong-capture" ? "different-capture" : evidence.captureId,
          sequence: failure === "wrong-sequence" ? 0 : 1,
          evidenceRef: failure === "wrong-hash" ? "invalid-hash" : DIGEST,
        };
      });
      const observer = new CodexProviderHumanAnswerObserver(evidence, p.binding, () => p.f.time);
      const first = await deliver(observer, { bytes: body(p.output) });
      expect(first).toMatchObject({ status: "blocked" });
      assertCompact(first);
      const second = await deliver(observer, { bytes: body(p.output) });
      expect(second).toMatchObject({ status: "blocked" });
      expect(evidence.append).toHaveBeenCalledTimes(1);
    }
  );

  it("bounds a pending append and never retries after an eventual late acknowledgement", async () => {
    const p = await prepared();
    const evidence = sink();
    let acknowledge!: (result: AppendResult) => void;
    evidence.append.mockImplementation(
      async () =>
        new Promise<AppendResult>((resolve) => {
          acknowledge = resolve;
        })
    );
    const observer = new CodexProviderHumanAnswerObserver(evidence, p.binding, () => p.f.time);
    expect(await deliver(observer, { bytes: body(p.output), timeoutMs: 30 })).toMatchObject({
      status: "blocked",
    });
    acknowledge({ captureId: evidence.captureId, sequence: 1, evidenceRef: DIGEST });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await deliver(observer, { bytes: body(p.output) })).toMatchObject({ status: "blocked" });
    expect(evidence.append).toHaveBeenCalledTimes(1);
  });

  it("retains uncertain history when cancellation happens during a possible append", async () => {
    const p = await prepared();
    const evidence = sink();
    const controller = new AbortController();
    evidence.append.mockImplementation(async (input) => {
      evidence.frames.push({ ...input, bytes: Uint8Array.from(input.bytes) });
      controller.abort();
      return { captureId: evidence.captureId, sequence: 1, evidenceRef: DIGEST };
    });
    const observer = new CodexProviderHumanAnswerObserver(evidence, p.binding, () => p.f.time);
    expect(await deliver(observer, { bytes: body(p.output), controller })).toMatchObject({
      status: "blocked",
    });
    expect(await deliver(observer, { bytes: body(p.output) })).toMatchObject({ status: "blocked" });
    expect(evidence.append).toHaveBeenCalledTimes(1);
  });
});

describe("protected retained evidence composition", () => {
  it("seals, independently reads and reconciles the observed request while holding dependent work", async () => {
    const p = await prepared("sqlite", false, randomUUID());
    const ingress = new CodexProviderIngressSession({ runId: "run" }, { ttlMs: 60000 });
    ingressSessions.push(ingress);
    const credential = ingress.claimChildEnvironment(
      p.binding.capture.connectionId
    ).LEXRUNNER_PROVIDER_SESSION;
    const root = join(p.f.root, "provider-output-evidence");
    await mkdir(root);
    // Synthetic attestation/sync ports do not establish production ACL protection,
    // actual Codex origin, user presence, remote receipt, or worker consumption.
    const store = new LocalProtectedEvidenceStore(root, {
      attestRoot: async () => true,
      syncDirectory: async () => undefined,
      now: () => p.f.time,
    });
    const session = await ProtectedEvidenceCaptureSession.open({
      store,
      reservation: {
        capture_id: "provider-output-capture",
        attempt_id: "attempt",
        delegation_id: "provider-observer",
        authorization_binding_digest: DIGEST,
        executor_binding_digest: DIGEST,
        environment_binding_digest: DIGEST,
        workspace_binding_digest: DIGEST,
        reserved_bytes: 128 * 1024,
        reserved_frames: 10,
        reserved_events: 10,
        max_duration_ms: 60000,
      },
      openedAt: p.f.time,
    });
    const revision = (await p.f.store.getRunCoordination("run"))!.revision;
    const observer = new CodexProviderHumanAnswerObserver(
      session,
      p.binding,
      () => p.f.time,
      ingress
    );
    const result = await deliver(observer, {
      bytes: body(p.output),
      headers: { "x-lexrunner-provider-session": credential },
    });
    expect(result).toMatchObject({ status: "captured", consumptionQualified: false });
    if (result.status !== "captured") throw new Error("capture fixture failed");
    // Observation itself has no journal or send port and leaves coordination untouched.
    expect((await p.f.store.getRunCoordination("run"))!.revision).toBe(revision);
    const reference = await session.sealAndVerify({ sealedAt: p.f.time, indexedAt: p.f.time });
    const reader = new LocalProtectedEvidenceVerifier(root, { attestRoot: async () => true });
    const verified = await reader.readVerifiedCapture(result.captureId);
    expect(verified.frames).toHaveLength(1);
    const frame = CodexHumanAnswerOutputEvidence.parse(
      JSON.parse(Buffer.from(verified.frames[0]!.bytes).toString("utf8"))
    );
    expect(frame.providerRequest).toMatchObject({
      requestHash: result.requestHash,
      session: {
        sessionId: ingress.snapshot().sessionId,
        bindingHash: ingress.snapshot().bindingHash,
        credentialPossessionVerified: true,
      },
    });
    expect(Buffer.from(verified.frames[0]!.bytes).toString("utf8")).not.toContain(credential);
    const sourceEvidence = {
      captureId: result.captureId,
      captureRoot: reference.capture_root!,
      frameSequence: result.frameSequence,
      frameHash: result.frameHash,
    };
    const input = {
      ...(await p.f.mutation("retained-provider-output")),
      requestId: p.binding.requestId,
      sourceEvidence,
    };
    expect(await recordRetainedCodexHumanAnswerOutput(p.f.service, reader, input)).toMatchObject({
      ok: true,
      contentMatched: true,
      sourceEvidenceVerified: true,
      sourceAuthenticated: false,
      consumptionQualified: false,
      resendAllowed: false,
    });
    await p.f.reopen();
    expect(await recordRetainedCodexHumanAnswerOutput(p.f.service, reader, input)).toMatchObject({
      ok: true,
      replay: true,
    });
    const report = await p.f.service.inspectWorkerAnswerDelivery("run", p.binding.requestId);
    expect(report).toMatchObject({
      holdPending: true,
      observations: [{ kind: "matching_answer_output", sourceEvidence }],
      consumptionQualified: false,
      resendAllowed: false,
    });
    expect(report!.observations).toHaveLength(1);
    expect(
      humanActionSummary((await p.f.store.getRunCoordination("run"))!.state, p.f.time)
    ).toHaveLength(1);
    const compact = JSON.stringify(report);
    expect(compact).not.toContain(PROMPT_CANARY);
    expect(compact).not.toContain(HEADER_CANARY);
    expect(compact).not.toContain(p.binding.answer.signature);
    expect(compact).not.toContain('"output"');
  });
});

describe("session-gated provider answer ingress", () => {
  async function bound() {
    const p = await prepared("memory", false, randomUUID());
    const session = new CodexProviderIngressSession({ runId: "run" }, { ttlMs: 60000 });
    ingressSessions.push(session);
    const credential = session.claimChildEnvironment(
      p.binding.capture.connectionId
    ).LEXRUNNER_PROVIDER_SESSION;
    const evidence = sink();
    const observer = new CodexProviderHumanAnswerObserver(
      evidence,
      p.binding,
      () => p.f.time,
      session
    );
    return { p, session, credential, evidence, observer };
  }

  it.each(["missing", "wrong", "duplicate"])(
    "refuses %s credentials before reading or capturing",
    async (kind) => {
      const b = await bound();
      let on: ReturnType<typeof vi.spyOn> | undefined;
      const headers =
        kind === "missing"
          ? {}
          : {
              "x-lexrunner-provider-session":
                kind === "wrong" ? "x".repeat(43) : [b.credential, b.credential],
            };
      const result = await deliver(b.observer, {
        bytes: body(b.p.output),
        headers,
        beforeObserve: (request) => {
          on = vi.spyOn(request, "on");
        },
      });
      expect(result).toEqual({ status: "blocked", reason: "provider_session_not_authorized" });
      expect(on!.mock.calls.filter(([event]) => event === "data")).toHaveLength(0);
      expect(b.evidence.append).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain(b.credential);
    }
  );

  it("retains the nonsecret session binding without source or human authentication", async () => {
    const b = await bound();
    const result = await deliver(b.observer, {
      bytes: body(b.p.output),
      headers: { "x-lexrunner-provider-session": b.credential },
    });
    expect(result).toMatchObject({
      status: "captured",
      sourceAuthenticated: false,
      consumptionQualified: false,
      resendAllowed: false,
    });
    const raw = Buffer.from(b.evidence.frames[0]!.bytes).toString("utf8");
    expect(CodexHumanAnswerOutputEvidence.parse(JSON.parse(raw)).providerRequest!.session).toEqual({
      sessionId: b.session.snapshot().sessionId,
      bindingHash: computeCanonicalHash({
        runId: "run",
        connectionId: b.p.binding.capture.connectionId,
      }),
      credentialPossessionVerified: true,
    });
    expect(raw).not.toContain(b.credential);
    expect(raw).not.toContain(createHash("sha256").update(b.credential).digest("hex"));
    expect(raw).not.toContain("x-lexrunner-provider-session");
  });

  it.each(["run", "connection"])("refuses a mismatched %s transport binding", async (kind) => {
    const b = await bound();
    const other = new CodexProviderIngressSession(
      { runId: kind === "run" ? "other" : "run" },
      { ttlMs: 60000 }
    );
    ingressSessions.push(other);
    other.claimChildEnvironment(
      kind === "connection" ? randomUUID() : b.p.binding.capture.connectionId
    );
    expect(
      () => new CodexProviderHumanAnswerObserver(b.evidence, b.p.binding, () => b.p.f.time, other)
    ).toThrow("invalid_provider_answer_binding");
  });

  it("revocation aborts a partial body and prevents append", async () => {
    const b = await bound();
    const result = await deliver(b.observer, {
      bytes: Buffer.from('{"input":['),
      leaveOpen: true,
      headers: { "x-lexrunner-provider-session": b.credential },
      afterStarted: () => {
        setTimeout(() => b.session.revoke(), 15);
      },
    });
    expect(result).toMatchObject({ status: "blocked", reason: "provider_request_cancelled" });
    expect(b.evidence.append).not.toHaveBeenCalled();
    expect(b.session.signal.aborted).toBe(true);
  });

  it("revocation during a possible append retains uncertainty and refuses another capture", async () => {
    const b = await bound();
    b.evidence.append.mockImplementation(async () => {
      b.session.revoke();
      return { captureId: b.evidence.captureId, sequence: 1, evidenceRef: DIGEST };
    });
    expect(
      await deliver(b.observer, {
        bytes: body(b.p.output),
        headers: { "x-lexrunner-provider-session": b.credential },
      })
    ).toEqual({ status: "blocked", reason: "provider_capture_uncertain" });
    expect(
      await deliver(b.observer, {
        bytes: body(b.p.output),
        headers: { "x-lexrunner-provider-session": b.credential },
      })
    ).toEqual({ status: "blocked", reason: "provider_capture_uncertain" });
    expect(b.evidence.append).toHaveBeenCalledTimes(1);
  });
});
