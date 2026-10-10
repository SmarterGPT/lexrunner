import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { computeCanonicalHash, SHA256Hash } from "../schemas/task-contract.js";
import { WorkerHumanInputCapture } from "../schemas/worker-human-input.js";
import { WorkerHumanPresentation } from "../schemas/worker-human-presentation.js";
import {
  SignedWorkerHumanAnswer,
  WorkerHumanAnswerPayload,
  workerHumanAnswersMatch,
} from "../schemas/worker-human-answer.js";
import { canonicalJSONStringify } from "../util/canonicalJson.js";
import {
  TrustedHumanAnswerVerifier,
  type HumanAnswerHostTrust,
} from "./trusted-human-answer-verifier.js";

const instant = z.string().datetime({ offset: true });
const id = z.string().min(1).max(512);
const maximumAttempts = 128;
export const WorkerHumanAdmissionInput = z
  .object({
    presentation: WorkerHumanPresentation,
    capture: WorkerHumanInputCapture,
    answers: z
      .array(z.object({ questionId: id, value: z.string().min(1).max(4096) }).strict())
      .min(1)
      .max(8),
    observedAt: instant,
  })
  .strict();
export type WorkerHumanAdmissionInput = z.infer<typeof WorkerHumanAdmissionInput>;

export interface WorkerHumanAdmissionWindow {
  timeoutMs: number;
  /** Opaque live input connection; reconnect must replace this object. */
  sourceConnection: object;
}
export interface WorkerHumanAdmissionPort {
  admitInput(
    input: WorkerHumanAdmissionInput,
    signal: AbortSignal,
    window: WorkerHumanAdmissionWindow
  ): Promise<SignedWorkerHumanAnswer | null>;
}

export const QualifiedWorkerHumanInput = z
  .object({
    inputId: z.string().uuid(),
    bindingHash: SHA256Hash,
    actorId: id,
    authenticationEventId: id,
    qualifiedAt: instant,
  })
  .strict();
export type QualifiedWorkerHumanInput = z.infer<typeof QualifiedWorkerHumanInput>;
export interface QualifiedWorkerHumanInputSource {
  connection(): object | null;
  /**
   * Independently qualify this exact fresh input, atomically consume its event,
   * and durably retain event-to-input/binding/connection evidence across restart.
   * Schema-valid UI responses, logged-in actors and credentials are insufficient.
   * This class does not supply that protected qualification implementation.
   */
  qualify(
    input: WorkerHumanAdmissionInput,
    window: WorkerHumanAdmissionWindow & {
      inputId: string;
      bindingHash: string;
      signal: AbortSignal;
    }
  ): Promise<unknown>;
}
export interface WorkerHumanAnswerSigner {
  /** Fixed-purpose signer selected by the protected host, never answer input. */
  sign(
    input: { canonicalPayload: Uint8Array; qualification: QualifiedWorkerHumanInput },
    window: WorkerHumanAdmissionWindow & { signal: AbortSignal }
  ): Promise<unknown>;
}

class WindowEnded extends Error {}

/** Bound nonconforming capabilities; late resolution cannot enter the next stage. */
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
        return operation(controller.signal, remaining);
      }),
      ended,
    ]);
  } finally {
    clearTimeout(timer!);
    signal.removeEventListener("abort", aborted!);
    controller.abort();
  }
}

/**
 * SDK-free, source-only composition of independently supplied protected ports.
 * Local binding/signature checks do not qualify genuine input or signing custody.
 * Durable admission, delivery and hold settlement remain in their existing layers.
 */
export class WorkerHumanAdmissionHost implements WorkerHumanAdmissionPort {
  private readonly trust: HumanAnswerHostTrust;
  private readonly verifier: TrustedHumanAnswerVerifier;
  private readonly actors: ReadonlySet<string>;
  private readonly connection: QualifiedWorkerHumanInputSource["connection"];
  private readonly qualify: QualifiedWorkerHumanInputSource["qualify"];
  private readonly sign: WorkerHumanAnswerSigner["sign"];
  private readonly usedEvents = new Set<string>();
  private busy = false;
  private state: "ready" | "signing_unconfirmed" | "attempt_limit" = "ready";
  private attempts = 0;
  private qualifiedInputs = 0;
  private verifiedAnswers = 0;
  private lastFailure: string | null = null;

  constructor(
    trust: HumanAnswerHostTrust,
    source: QualifiedWorkerHumanInputSource,
    signer: WorkerHumanAnswerSigner,
    private readonly clock: () => string = () => new Date().toISOString()
  ) {
    this.trust = structuredClone(trust);
    this.verifier = new TrustedHumanAnswerVerifier([this.trust]);
    this.actors = new Set(this.trust.actorIds);
    this.connection = source.connection.bind(source);
    this.qualify = source.qualify.bind(source);
    this.sign = signer.sign.bind(signer);
  }

  /** Bounded diagnostics; no answer text, keys, actor/event IDs or raw errors. */
  snapshot() {
    return {
      state: this.state,
      inFlight: this.busy,
      attempts: this.attempts,
      qualifiedInputs: this.qualifiedInputs,
      verifiedAnswers: this.verifiedAnswers,
      lastFailure: this.lastFailure,
    };
  }

  async admitInput(
    input: WorkerHumanAdmissionInput,
    signal: AbortSignal,
    window: WorkerHumanAdmissionWindow
  ): Promise<SignedWorkerHumanAnswer | null> {
    if (this.busy || this.state !== "ready") return null;
    const operationStarted = performance.now();
    this.busy = true;
    this.lastFailure = null;
    let signingAttempted = false;
    let succeeded = false;
    let boundary = "input_invalid";
    try {
      const captured = WorkerHumanAdmissionInput.parse(structuredClone(input));
      // Retain the opaque identity outside cloning and snapshot the caller's budget.
      const sourceConnection = window.sourceConnection;
      const timeoutMs = window.timeoutMs;
      const now = () => instant.parse(this.clock());
      const startedAt = now();
      const challenge = captured.presentation.challenge;
      const expires = Date.parse(challenge.expiresAt);
      boundary = "input_inapplicable";
      if (
        captured.presentation.disposition !== "active" ||
        challenge.runId !== this.trust.runId ||
        challenge.requestId !== `worker-input:${captured.capture.observationId}` ||
        Date.parse(captured.observedAt) < Date.parse(challenge.issuedAt) ||
        Date.parse(captured.observedAt) < Date.parse(captured.capture.observedAt) ||
        Date.parse(captured.observedAt) > Date.parse(startedAt) ||
        !Number.isFinite(timeoutMs) ||
        timeoutMs <= 0 ||
        sourceConnection === null ||
        typeof sourceConnection !== "object"
      )
        return null;
      const monotonicDeadline =
        operationStarted + Math.min(timeoutMs, expires - Date.parse(startedAt), 15 * 60_000);
      const remaining = () =>
        Math.min(expires - Date.parse(now()), monotonicDeadline - performance.now());
      const applicable = () =>
        !signal.aborted && remaining() > 0 && this.connection() === sourceConnection;
      if (!applicable()) return null;
      // Validate payload size, uniqueness and authored option matching before qualification.
      const template = WorkerHumanAnswerPayload.parse({
        version: 1,
        challenge,
        hostId: this.trust.hostId,
        keyId: this.trust.keyId,
        actorId: this.trust.actorIds[0],
        authenticationEventId: "pending",
        answeredAt: captured.observedAt,
        answers: captured.answers,
      });
      if (!workerHumanAnswersMatch(captured.capture, template)) return null;
      if (this.attempts >= maximumAttempts) {
        this.state = "attempt_limit";
        return null;
      }
      this.attempts++;
      const inputId = randomUUID();
      const bindingHash = computeCanonicalHash({
        domain: "lexrunner.worker-human-admission-input/v1",
        inputId,
        host: { runId: this.trust.runId, hostId: this.trust.hostId, keyId: this.trust.keyId },
        input: captured,
      });
      boundary = "qualification_failed";
      const raw = await bounded(
        (inner, budget) => {
          if (inner.aborted || !applicable()) throw new WindowEnded();
          return this.qualify(structuredClone(captured), {
            inputId,
            bindingHash,
            sourceConnection,
            signal: inner,
            timeoutMs: budget,
          });
        },
        signal,
        remaining()
      );
      boundary = "qualification_invalid";
      if (!applicable()) throw new WindowEnded();
      const qualification = QualifiedWorkerHumanInput.parse(structuredClone(raw));
      if (
        qualification.inputId !== inputId ||
        qualification.bindingHash !== bindingHash ||
        !this.actors.has(qualification.actorId) ||
        Date.parse(qualification.qualifiedAt) < Date.parse(startedAt) ||
        Date.parse(qualification.qualifiedAt) < Date.parse(captured.observedAt) ||
        Date.parse(qualification.qualifiedAt) > Date.parse(now()) ||
        Date.parse(qualification.qualifiedAt) >= expires
      )
        return null;
      if (this.usedEvents.has(qualification.authenticationEventId)) {
        boundary = "authentication_event_reused";
        return null;
      }
      // Reserve synchronously before signing; never evict. Protected source owns
      // durable event consumption and immutable binding evidence across restart.
      this.usedEvents.add(qualification.authenticationEventId);
      this.qualifiedInputs++;
      const payload = WorkerHumanAnswerPayload.parse({
        ...template,
        actorId: qualification.actorId,
        authenticationEventId: qualification.authenticationEventId,
      });
      boundary = "signing_unconfirmed";
      const signature = await bounded(
        (inner, budget) => {
          if (inner.aborted || !applicable()) throw new WindowEnded();
          signingAttempted = true;
          return this.sign(
            {
              canonicalPayload: Buffer.from(canonicalJSONStringify(payload), "utf8"),
              qualification: structuredClone(qualification),
            },
            { sourceConnection, signal: inner, timeoutMs: budget }
          );
        },
        signal,
        remaining()
      );
      if (!applicable()) throw new WindowEnded();
      const answer = SignedWorkerHumanAnswer.parse({ payload, signature });
      if (!this.verifier.verify(answer)) throw new Error("signature_invalid");
      if (!applicable()) throw new WindowEnded();
      this.verifiedAnswers++;
      succeeded = true;
      return answer;
    } catch {
      if (signingAttempted) this.state = "signing_unconfirmed";
      return null;
    } finally {
      this.busy = false;
      this.lastFailure = succeeded ? null : boundary;
    }
  }
}
