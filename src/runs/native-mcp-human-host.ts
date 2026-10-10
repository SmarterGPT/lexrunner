import { performance } from "node:perf_hooks";
import type { WorkerHumanAdmissionPort } from "./worker-human-admission-host.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type {
  AgentWorkHumanActionService,
  HumanActionMutationInput,
} from "../runs/agent-work-human-action-service.js";
import type { CoordinationStore } from "../store/coordination-store.js";
import { WorkerHumanInputCapture } from "../schemas/worker-human-input.js";
import { WorkerHumanPresentation } from "../schemas/worker-human-presentation.js";
import { SignedWorkerHumanAnswer } from "../schemas/worker-human-answer.js";
import { computeCanonicalHash } from "../schemas/task-contract.js";

type ClaimInput = Parameters<AgentWorkHumanActionService["claimWorkerQuestionPresentation"]>[0];
type Service = Pick<
  AgentWorkHumanActionService,
  | "claimWorkerQuestionPresentation"
  | "closeWorkerQuestionPresentation"
  | "getWorkerQuestionPresentation"
  | "admitWorkerAnswer"
>;
type Mode = "form" | "openai/form";
export interface NativeHumanForm {
  message: string;
  requestedSchema: {
    type: "object";
    properties: Record<
      string,
      {
        type: "string";
        title: string;
        description: string;
        enum?: string[];
        minLength?: number;
        maxLength?: number;
      }
    >;
    required: string[];
    additionalProperties: false;
  };
}
export interface NativeHumanFormChannel {
  /** Opaque connection identity; reconnect must return a different object. */
  connection(): object | null;
  capabilities(): unknown;
  request(
    form: NativeHumanForm & { mode: Mode },
    window: { signal: AbortSignal; timeoutMs: number; connection: object }
  ): Promise<unknown>;
}
export type NativeHumanAdmissionPort = WorkerHumanAdmissionPort;

/** The SDK stays in this adapter; the portable core has no MCP/UI dependency. */
export function mcpHumanFormChannel(
  server: Pick<Server, "getClientCapabilities" | "request" | "transport">
): NativeHumanFormChannel {
  return {
    connection: () => server.transport ?? null,
    capabilities: () => server.getClientCapabilities(),
    request: (form, window) => {
      // SDK request dispatch is synchronous up to transport.send. No await may
      // separate this identity check from that call.
      if (server.transport !== window.connection || window.signal.aborted)
        return Promise.reject(new WindowEnded());
      return server.request(
        { method: "elicitation/create", params: { ...form } },
        ElicitResultSchema,
        {
          signal: window.signal,
          timeout: window.timeoutMs,
          maxTotalTimeout: window.timeoutMs,
          resetTimeoutOnProgress: false,
        }
      );
    },
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function modeFor(value: unknown): Mode | null {
  if (!object(value) || !object(value.elicitation)) return null;
  const extension =
    object(value.extensions) &&
    (object(value.extensions["openai/form"]) ||
      (object(value.extensions["openai/elicitation"]) &&
        object(value.extensions["openai/elicitation"].form)));
  // The tested Codex extension may accompany the older empty elicitation capability.
  if (extension && (object(value.elicitation.form) || Object.keys(value.elicitation).length === 0))
    return "openai/form";
  return object(value.elicitation.form) ? "form" : null;
}

/** Safe generated field names keep authored question IDs as values, including __proto__. */
export function projectNativeHumanForm(
  input: WorkerHumanInputCapture,
  expiresAt: string
): NativeHumanForm {
  const capture = WorkerHumanInputCapture.parse(input);
  const properties: NativeHumanForm["requestedSchema"]["properties"] = {};
  capture.questions.forEach((question, index) => {
    const labels = question.options?.map((option) => option.label);
    if (labels && new Set(labels).size !== labels.length)
      throw new Error("ambiguous_option_labels");
    const description = [
      question.question,
      ...(question.options?.map((option) => `${option.label}: ${option.description}`) ?? []),
      ...(question.allowOther ? ["You may enter another answer in your own words."] : []),
    ].join("\n\n");
    properties[`q${index}`] = {
      type: "string",
      title: question.header,
      description,
      ...(labels && !question.allowOther ? { enum: labels } : { minLength: 1, maxLength: 4096 }),
    };
  });
  const form: NativeHumanForm = {
    message: `Pending worker decision. This presentation expires at ${expiresAt}. Skip or dismissal leaves the decision pending. After expiry, request a fresh presentation; an old visible form cannot answer it.`,
    requestedSchema: {
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    },
  };
  if (Buffer.byteLength(JSON.stringify(form), "utf8") > 64 * 1024)
    throw new Error("form_too_large");
  return form;
}

function answersFrom(result: unknown, capture: WorkerHumanInputCapture) {
  // SDK schemas may strip fields: independently validate the raw response at the port.
  const response = z
    .object({
      action: z.enum(["accept", "decline", "cancel"]),
      content: z.unknown().optional(),
      _meta: z.record(z.string(), z.unknown()).optional(),
    })
    .strict()
    .parse(result);
  if (response.action !== "accept") {
    if (
      response.content !== undefined &&
      response.content !== null &&
      (!object(response.content) || Object.keys(response.content).length !== 0)
    )
      throw new Error("invalid_dismissal_content");
    return { action: response.action, answers: null };
  }
  if (
    !object(response.content) ||
    Object.keys(response.content).length !== capture.questions.length
  )
    throw new Error("invalid_answer_fields");
  const content = response.content;
  const answers = capture.questions.map((question, index) => {
    const field = `q${index}`;
    if (!Object.prototype.hasOwnProperty.call(content, field))
      throw new Error("missing_answer_field");
    const value = z.string().min(1).max(4096).parse(content[field]);
    if (
      question.options &&
      !question.allowOther &&
      !question.options.some((option) => option.label === value)
    )
      throw new Error("invalid_option");
    return { questionId: question.id, value };
  });
  return { action: response.action, answers };
}

class WindowEnded extends Error {}
/** Also bound nonconforming ports. Late resolution cannot call a later stage. */
async function bounded<T>(
  operation: (signal: AbortSignal, timeoutMs: number) => Promise<T>,
  signal: AbortSignal,
  remaining: number
): Promise<T> {
  if (signal.aborted || !Number.isFinite(remaining) || remaining <= 0) throw new WindowEnded();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let aborted: () => void;
  const ended = new Promise<never>((_resolve, reject) => {
    aborted = () => {
      controller.abort();
      reject(new WindowEnded());
    };
    signal.addEventListener("abort", aborted, { once: true });
    timer = setTimeout(aborted, Math.ceil(remaining));
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (signal.aborted || controller.signal.aborted) throw new WindowEnded();
        return operation(controller.signal, Math.ceil(remaining));
      }),
      ended,
    ]);
  } finally {
    clearTimeout(timer!);
    signal.removeEventListener("abort", aborted!);
    controller.abort();
  }
}

/** Source-only protected-host composition. No answer arguments or automatic retries. */
export class NativeMcpHumanPresentationHost {
  private busy = false;
  constructor(
    private readonly service: Service,
    private readonly coordination: Pick<CoordinationStore, "getRunCoordination">,
    private readonly channel: NativeHumanFormChannel,
    private readonly admission: NativeHumanAdmissionPort,
    private readonly clock: () => string = () => new Date().toISOString()
  ) {}

  async present(input: ClaimInput, signal: AbortSignal) {
    input = structuredClone(input);
    if (this.busy) return { status: "blocked" as const, reason: "presentation_in_progress" };
    if (signal.aborted) return { status: "pending" as const, reason: "cancelled_before_claim" };
    const connection = this.channel.connection();
    if (!connection) return { status: "blocked" as const, reason: "human_channel_disconnected" };
    const mode = modeFor(this.channel.capabilities());
    if (!mode) return { status: "blocked" as const, reason: "form_capability_unavailable" };
    this.busy = true;
    let claimed: WorkerHumanPresentation | undefined;
    let monotonicDeadline = 0;
    let admissionAttempted = false;
    let boundary:
      | "persistence"
      | "form_projection"
      | "presentation_binding"
      | "transport"
      | "result_validation"
      | "host_admission" = "persistence";
    const now = () => z.string().datetime({ offset: true }).parse(this.clock());
    const mutation = async (suffix: string): Promise<HumanActionMutationInput> => {
      const record = await this.coordination.getRunCoordination(input.controller.runId);
      if (!record) throw new Error("run_missing");
      return {
        controller: input.controller,
        expectedRunRevision: record.revision,
        mutationId: `${input.mutationId}:${suffix}`,
        now: now(),
      };
    };
    const wallRemaining = () => Date.parse(claimed!.challenge.expiresAt) - Date.parse(now());
    const remaining = () => Math.min(wallRemaining(), monotonicDeadline - performance.now());
    const canCommit = () =>
      !signal.aborted && remaining() > 0 && this.channel.connection() === connection;
    const applicable = async () => {
      boundary = "presentation_binding";
      if (signal.aborted || remaining() <= 0 || this.channel.connection() !== connection)
        throw new WindowEnded();
      const current = await this.service.getWorkerQuestionPresentation(
        input.controller.runId,
        input.requestId,
        now()
      );
      if (
        !current ||
        current.presentationId !== claimed!.presentationId ||
        current.disposition !== "active"
      )
        throw new WindowEnded();
      if (signal.aborted || remaining() <= 0 || this.channel.connection() !== connection)
        throw new WindowEnded();
    };
    const close = async (disposition: "declined" | "cancelled" | "expired" | "failed") => {
      const result = await this.service.closeWorkerQuestionPresentation({
        ...(await mutation("close")),
        requestId: input.requestId,
        presentationId: claimed!.presentationId,
        disposition,
      });
      return result.ok
        ? { status: "pending" as const, reason: disposition }
        : { status: "reconciliation_required" as const, reason: result.reason };
    };
    try {
      const result = await this.service.claimWorkerQuestionPresentation({ ...input, now: now() });
      if (!result.ok) return { status: "blocked" as const, reason: result.reason };
      if (!result.newlyClaimed || result.replay)
        return {
          status: "reconciliation_required" as const,
          reason: "presentation_already_claimed",
        };
      claimed = WorkerHumanPresentation.parse(result.presentation);
      // One process-local budget across display and admission; wall-clock rollback cannot extend it.
      monotonicDeadline = performance.now() + Math.min(15 * 60_000, wallRemaining());
      const capture = WorkerHumanInputCapture.parse(result.capture);
      boundary = "form_projection";
      const form = projectNativeHumanForm(capture, claimed.challenge.expiresAt);
      await applicable();
      boundary = "transport";
      const raw = await bounded(
        (inner, timeoutMs) => {
          if (!canCommit()) throw new WindowEnded();
          return this.channel.request({ ...form, mode }, { signal: inner, timeoutMs, connection });
        },
        signal,
        remaining()
      );
      boundary = "result_validation";
      const response = answersFrom(structuredClone(raw), capture);
      await applicable();
      if (!response.answers)
        return await close(response.action === "decline" ? "declined" : "cancelled");
      const observedAt = now();
      boundary = "host_admission";
      const attestation = await bounded(
        (inner, timeoutMs) =>
          this.admission.admitInput(
            structuredClone({
              presentation: claimed!,
              capture,
              answers: response.answers!,
              observedAt,
            }),
            inner,
            { timeoutMs, sourceConnection: connection }
          ),
        signal,
        remaining()
      );
      if (!attestation) return { ...(await close("failed")), boundary };
      const answer = SignedWorkerHumanAnswer.parse(structuredClone(attestation));
      if (
        computeCanonicalHash(answer.payload.challenge) !==
          computeCanonicalHash(claimed.challenge) ||
        computeCanonicalHash(answer.payload.answers) !== computeCanonicalHash(response.answers) ||
        answer.payload.answeredAt !== observedAt
      )
        throw new Error("host_attestation_binding_mismatch");
      await applicable();
      const admissionInput = { ...(await mutation("admit")), answer };
      if (signal.aborted || remaining() <= 0 || this.channel.connection() !== connection)
        throw new WindowEnded();
      boundary = "persistence";
      admissionAttempted = true;
      const admitted = await bounded(
        (inner) =>
          this.service.admitWorkerAnswer(admissionInput, () => !inner.aborted && canCommit()),
        signal,
        remaining()
      );
      return admitted.ok
        ? { status: "admitted_hold_pending" as const, replay: admitted.replay }
        : { status: "reconciliation_required" as const, reason: admitted.reason };
    } catch {
      // A lost claim/admission ACK may have committed: never redisplay or invent a failure receipt.
      if (!claimed || admissionAttempted)
        return {
          status: "reconciliation_required" as const,
          reason: "persistence_or_admission_uncertain",
          boundary,
        };
      try {
        return {
          ...(await close(
            wallRemaining() <= 0 ? "expired" : signal.aborted ? "cancelled" : "failed"
          )),
          boundary,
        };
      } catch {
        return {
          status: "reconciliation_required" as const,
          reason: "presentation_observation_uncertain",
          boundary,
        };
      }
    } finally {
      this.busy = false;
    }
  }
}
