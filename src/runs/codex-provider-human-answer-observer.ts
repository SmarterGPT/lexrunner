import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { performance } from "node:perf_hooks";
import { TextDecoder } from "node:util";
import { z } from "zod";
import { CodexHumanInputCapture, CodexHumanInputRequest } from "../schemas/codex-human-input.js";
import { SHA256Hash } from "../schemas/task-contract.js";
import { SignedWorkerHumanAnswer } from "../schemas/worker-human-answer.js";
import { canonicalJSONStringify } from "../util/canonicalJson.js";
import type { GovernedAttemptEvidenceCapture } from "./governed-attempt-evidence.js";
import {
  CodexHumanAnswerOutput,
  matchCodexHumanAnswerOutput,
} from "./codex-human-answer-output.js";
import { CodexHumanAnswerOutputEvidence } from "./codex-human-answer-evidence.js";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_REQUESTS = 128;
const Binding = z
  .object({
    runId: z.string().min(1).max(512),
    requestId: z.string().min(1).max(512),
    claimId: z.string().uuid(),
    capture: CodexHumanInputCapture,
    answer: SignedWorkerHumanAnswer,
  })
  .strict();
type Binding = z.infer<typeof Binding>;
const Frame = z
  .object({
    captureId: z.string().min(1).max(128),
    sequence: z.number().int().min(1).max(65536),
    evidenceRef: SHA256Hash,
  })
  .strict();
const Window = z.object({ timeoutMs: z.number().int().min(1).max(30000) }).strict();
class IngressError extends Error {}

/** Bounded JSON, retaining authored strings and refusing ambiguous object keys. */
function parseRequest(bytes: Buffer): unknown {
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const stack: Array<Set<string> | null> = [];
  // Scan string tokens before JSON.parse can erase duplicate keys. The JSON parser
  // still validates all syntax; no object/value normalization is performed.
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') {
      const start = i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === "\\") i++;
        i++;
      }
      if (i >= source.length) throw new IngressError("invalid_provider_request_json");
      let next = i + 1;
      while (/[\t\n\r ]/u.test(source[next] ?? "") && next < source.length) next++;
      if (source[next] === ":") {
        const keys = stack[stack.length - 1];
        if (!keys) throw new IngressError("invalid_provider_request_json");
        const key: string = JSON.parse(source.slice(start, i + 1));
        if (keys.has(key)) throw new IngressError("ambiguous_provider_request_json");
        keys.add(key);
      }
    } else if (char === "{" || char === "[") {
      stack.push(char === "{" ? new Set() : null);
      if (stack.length > 64) throw new IngressError("provider_request_depth_limit");
    } else if (char === "}" || char === "]") {
      if (!stack.length || (stack[stack.length - 1] === null) !== (char === "]"))
        throw new IngressError("invalid_provider_request_json");
      stack.pop();
    }
  }
  return JSON.parse(source);
}

/** Only consumes the supplied ingress request. Cancellation closes that request. */
function readBody(request: IncomingMessage, signal: AbortSignal, timeoutMs: number) {
  return new Promise<Buffer>((resolve, reject) => {
    const buffer = Buffer.allocUnsafe(MAX_BODY_BYTES);
    let used = 0;
    let finished = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancelled);
      request.removeListener("data", data);
      request.removeListener("end", ended);
      request.removeListener("error", incomplete);
      request.removeListener("aborted", incomplete);
      request.removeListener("close", closed);
    };
    const finish = (reason?: string) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (reason) {
        // A peer abort can emit an error after its aborted event. Keep a terminal
        // error handler on this destroyed request, without exposing its message.
        request.once("error", () => undefined);
        request.destroy();
        reject(new IngressError(reason));
      } else resolve(buffer.subarray(0, used));
    };
    const data = (chunk: unknown) => {
      if (!Buffer.isBuffer(chunk)) return finish("invalid_provider_request_bytes");
      if (used + chunk.length > MAX_BODY_BYTES) return finish("provider_request_byte_limit");
      chunk.copy(buffer, used);
      used += chunk.length;
    };
    const ended = () =>
      finish(
        request.complete && !request.aborted && used > 0 ? undefined : "provider_request_incomplete"
      );
    const incomplete = () => finish("provider_request_incomplete");
    const closed = () => {
      if (!request.readableEnded) incomplete();
    };
    const cancelled = () => finish("provider_request_cancelled");
    const timer = setTimeout(() => finish("provider_request_window_expired"), timeoutMs);
    signal.addEventListener("abort", cancelled, { once: true });
    request.on("data", data);
    request.once("end", ended);
    request.once("error", incomplete);
    request.once("aborted", incomplete);
    request.once("close", closed);
    if (signal.aborted) cancelled();
  });
}

async function appendWithinWindow<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  remaining: number
): Promise<T> {
  if (signal.aborted || remaining <= 0) throw new IngressError("provider_capture_uncertain");
  let timer: ReturnType<typeof setTimeout>;
  let aborted: () => void;
  const ended = new Promise<never>((_resolve, reject) => {
    aborted = () => reject(new IngressError("provider_capture_uncertain"));
    signal.addEventListener("abort", aborted, { once: true });
    timer = setTimeout(aborted, Math.ceil(remaining));
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (signal.aborted) throw new IngressError("provider_capture_uncertain");
        return operation();
      }),
      ended,
    ]);
  } finally {
    clearTimeout(timer!);
    signal.removeEventListener("abort", aborted!);
  }
}

/**
 * Source-only observer at a host-owned Responses ingress, not a proxy or sender
 * authenticator. It retains a selected item and request digest, not the full body.
 * The host supplies persisted admission/claim context and owns capture sealing.
 */
export class CodexProviderHumanAnswerObserver {
  private readonly observerId = randomUUID();
  private readonly binding: Binding;
  private readonly captureId: string;
  private readonly itemId: string;
  private sequence = 0;
  private busy = false;
  private uncertain = false;

  constructor(
    private readonly evidence: Pick<GovernedAttemptEvidenceCapture, "captureId" | "append">,
    binding: Binding,
    private readonly clock: () => string = () => new Date().toISOString()
  ) {
    try {
      this.binding = Binding.parse(structuredClone(binding));
      this.captureId = z.string().min(1).max(128).parse(evidence.captureId);
      const request = CodexHumanInputRequest.parse(JSON.parse(this.binding.capture.requestJson));
      this.itemId = request.params.itemId;
      const expected = JSON.stringify({
        answers: Object.fromEntries(
          this.binding.answer.payload.answers.map((value) => [
            value.questionId,
            { answers: [value.value] },
          ])
        ),
      });
      if (
        !matchCodexHumanAnswerOutput({
          runId: this.binding.runId,
          requestId: this.binding.requestId,
          capture: this.binding.capture,
          answer: this.binding.answer,
          output: { type: "function_call_output", call_id: this.itemId, output: expected },
        }).matched
      )
        throw new Error();
    } catch {
      throw new TypeError("invalid_provider_answer_binding");
    }
  }

  snapshot() {
    return {
      observerId: this.observerId,
      captureId: this.captureId,
      requestsObserved: this.sequence,
      busy: this.busy,
      failure: this.uncertain ? "provider_capture_uncertain" : null,
      sourceAuthenticated: false as const,
      consumptionQualified: false as const,
      resendAllowed: false as const,
    };
  }

  async observe(request: IncomingMessage, window: { signal: AbortSignal; timeoutMs: number }) {
    if (this.uncertain) return { status: "blocked" as const, reason: "provider_capture_uncertain" };
    if (this.busy)
      return { status: "blocked" as const, reason: "provider_observation_in_progress" };
    if (this.sequence >= MAX_REQUESTS)
      return { status: "blocked" as const, reason: "provider_observation_limit" };
    const selectedWindow = Window.safeParse({ timeoutMs: window.timeoutMs });
    if (!selectedWindow.success)
      return { status: "blocked" as const, reason: "invalid_provider_observation_window" };
    const signal = window.signal;
    const timeoutMs = selectedWindow.data.timeoutMs;
    const sequence = ++this.sequence;
    this.busy = true;
    const deadline = performance.now() + timeoutMs;
    let appending = false;
    try {
      if (signal.aborted) throw new IngressError("provider_request_cancelled");
      if (request.method !== "POST" || request.url !== "/v1/responses")
        throw new IngressError("provider_request_route_mismatch");
      const contentType = request.headers["content-type"];
      if (
        typeof contentType !== "string" ||
        !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(contentType)
      )
        throw new IngressError("provider_request_content_type");
      const encoding = request.headers["content-encoding"];
      if (encoding !== undefined && encoding !== "identity")
        throw new IngressError("provider_request_content_encoding");
      const length = request.headers["content-length"];
      if (
        length !== undefined &&
        (typeof length !== "string" ||
          !/^(0|[1-9][0-9]*)$/u.test(length) ||
          Number(length) > MAX_BODY_BYTES)
      )
        throw new IngressError("provider_request_byte_limit");
      if (
        request.destroyed ||
        request.readableEnded ||
        request.readableDidRead ||
        request.readableEncoding !== null ||
        request.readableFlowing !== null ||
        request.listenerCount("data") !== 0 ||
        request.listenerCount("readable") !== 0
      )
        throw new IngressError("provider_request_already_consumed");
      const bytes = await readBody(
        request,
        signal,
        Math.max(1, Math.ceil(deadline - performance.now()))
      );
      if (length !== undefined && Number(length) !== bytes.length)
        throw new IngressError("provider_request_incomplete");
      const parsed = z.object({ input: z.array(z.unknown()).max(4096) }).parse(parseRequest(bytes));
      const candidates = parsed.input.filter(
        (item) =>
          item !== null &&
          typeof item === "object" &&
          (item as Record<string, unknown>).type === "function_call_output" &&
          (item as Record<string, unknown>).call_id === this.itemId
      );
      if (candidates.length !== 1) throw new IngressError("provider_answer_target_mismatch");
      const selected = CodexHumanAnswerOutput.safeParse(candidates[0]);
      if (!selected.success) throw new IngressError("invalid_provider_answer_output");
      const match = matchCodexHumanAnswerOutput({
        runId: this.binding.runId,
        requestId: this.binding.requestId,
        capture: this.binding.capture,
        answer: this.binding.answer,
        output: selected.data,
      });
      if (!match.matched) throw new IngressError(match.reason);
      const observedAt = z.string().datetime({ offset: true }).parse(this.clock());
      const requestHash = "sha256:" + createHash("sha256").update(bytes).digest("hex");
      const envelope = CodexHumanAnswerOutputEvidence.parse({
        version: 1,
        domain: "lexrunner.codex-human-answer-output-evidence/v1",
        observationId: this.observerId + ":provider:" + sequence,
        runId: this.binding.runId,
        requestId: this.binding.requestId,
        claimId: this.binding.claimId,
        captureHash: match.captureHash,
        answerHash: match.answerHash,
        observedAt,
        output: selected.data,
        providerRequest: {
          observerId: this.observerId,
          requestSequence: sequence,
          requestHash,
          requestBytes: bytes.length,
          method: "POST",
          path: "/v1/responses",
        },
      });
      if (signal.aborted || deadline <= performance.now())
        throw new IngressError("provider_request_window_expired");
      if (this.evidence.captureId !== this.captureId)
        throw new IngressError("provider_capture_binding_mismatch");
      appending = true;
      const frame = Frame.parse(
        await appendWithinWindow(
          () =>
            this.evidence.append({
              frameClass: "control_evidence",
              bytes: Buffer.from(canonicalJSONStringify(envelope), "utf8"),
              observedAt,
            }),
          signal,
          deadline - performance.now()
        )
      );
      if (frame.captureId !== this.captureId || signal.aborted || deadline <= performance.now())
        throw new IngressError("provider_capture_uncertain");
      return {
        status: "captured" as const,
        captureId: frame.captureId,
        frameSequence: frame.sequence,
        frameHash: frame.evidenceRef,
        observationId: envelope.observationId,
        requestHash,
        sourceAuthenticated: false as const,
        consumptionQualified: false as const,
        resendAllowed: false as const,
      };
    } catch (error) {
      if (appending) this.uncertain = true;
      return {
        status: "blocked" as const,
        reason: appending
          ? "provider_capture_uncertain"
          : error instanceof IngressError
            ? error.message
            : "invalid_provider_request",
      };
    } finally {
      this.busy = false;
    }
  }
}
