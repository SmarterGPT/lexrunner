import { z } from "zod";

import {
  HumanActionRequest_v1,
  HumanActionReceipt_v1,
  validateHumanActionReceiptBinding,
} from "../schemas/agent-work.js";
import {
  computeCanonicalHash,
  computeCanonicalHashFromCompactJSON,
  SHA256Hash,
} from "../schemas/task-contract.js";
import { WorkerHumanInputCapture } from "../schemas/worker-human-input.js";
import {
  SignedWorkerHumanAnswer,
  WorkerHumanAnswerChallenge,
  WorkerHumanAnswerDelivery,
  WorkerHumanAnswerObservation,
  workerHumanAnswerBindingHash,
  workerHumanAnswersMatch,
} from "../schemas/worker-human-answer.js";
import {
  WorkerHumanPresentation,
  WorkerHumanPresentationHistory,
} from "../schemas/worker-human-presentation.js";
import { TrustedHumanAnswerVerifier } from "./trusted-human-answer-verifier.js";
import type {
  CoordinationStore,
  ControllerLeaseCredential,
  JsonValue,
} from "../store/coordination-store.js";
import type {
  WorkspaceLifecycleStore,
  WorkerSessionStore,
  WorkspaceObservation,
} from "../store/workspace-lifecycle-store.js";

import {
  WorkerHumanInputEvent,
  WorkerHumanInputEventRecord,
  WorkerHumanInputSource,
  hashWorkerHumanInputEvent,
} from "../schemas/worker-human-input-event.js";

const KEY = "agentWorkHumanActions";
const entrySchema = z
  .object({
    request: HumanActionRequest_v1,
    contextHash: z.string(),
    receipt: HumanActionReceipt_v1.nullable(),
    supersededBy: z.string().optional(),
    replacesRequestId: z.string().optional(),
    workerInput: WorkerHumanInputCapture.optional(),
    answerChallenge: WorkerHumanAnswerChallenge.optional(),
    workerAnswer: SignedWorkerHumanAnswer.optional(),
    answerDelivery: WorkerHumanAnswerDelivery.optional(),
    answerObservations: z.array(WorkerHumanAnswerObservation).min(1).max(16).optional(),
    presentations: WorkerHumanPresentationHistory.optional(),
    inputEvents: z.array(WorkerHumanInputEventRecord).min(1).max(16).optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (
      entry.inputEvents &&
      (!entry.workerInput ||
        new Set(entry.inputEvents.map((v) => v.event.input.presentation.presentationId)).size !==
          entry.inputEvents.length ||
        entry.inputEvents.some(({ event, recordedAt, reservation }) => {
          const captured = event.input;
          const historical = entry.presentations?.find(
            (v) => v.presentationId === captured.presentation.presentationId
          );
          return (
            !historical ||
            captured.presentation.challenge.runId !== entry.request.run_id ||
            captured.presentation.challenge.requestId !== entry.request.request_id ||
            computeCanonicalHash(captured.capture) !== computeCanonicalHash(entry.workerInput) ||
            computeCanonicalHash(captured.presentation.challenge) !==
              computeCanonicalHash(historical.challenge) ||
            captured.presentation.previousPresentationId !== historical.previousPresentationId ||
            (historical.closedAt !== undefined &&
              (Date.parse(recordedAt) > Date.parse(historical.closedAt) ||
                (reservation !== undefined &&
                  Date.parse(reservation.reservedAt) > Date.parse(historical.closedAt))))
          );
        }))
    )
      ctx.addIssue({ code: "custom", message: "Invalid retained input-event references" });
    if (entry.answerObservations) {
      if (
        !entry.workerInput ||
        !entry.workerAnswer ||
        !entry.answerDelivery ||
        new Set(entry.answerObservations.map((v) => v.observationId)).size !==
          entry.answerObservations.length ||
        entry.answerObservations.some(
          (v) =>
            v.runId !== entry.request.run_id ||
            v.requestId !== entry.request.request_id ||
            v.claimId !== entry.answerDelivery?.claimId ||
            v.answerHash !== entry.answerDelivery?.answerHash ||
            v.captureHash !== computeCanonicalHash(entry.workerInput) ||
            Date.parse(v.observedAt) < Date.parse(entry.answerDelivery.claimedAt)
        )
      )
        ctx.addIssue({ code: "custom", message: "Invalid answer observation binding" });
    }
    if (entry.presentations) {
      const current = entry.presentations[entry.presentations.length - 1];
      if (
        !entry.answerChallenge ||
        computeCanonicalHash(current.challenge) !== computeCanonicalHash(entry.answerChallenge) ||
        Boolean(entry.workerAnswer) !== (current.disposition === "answered") ||
        (entry.workerAnswer &&
          Date.parse(current.closedAt!) < Date.parse(entry.workerAnswer.payload.answeredAt))
      )
        ctx.addIssue({ code: "custom", message: "Invalid presentation answer binding" });
    }
    if (
      entry.workerInput &&
      (entry.request.action !== "other" ||
        entry.request.request_id !== `worker-input:${entry.workerInput.observationId}` ||
        entry.request.requested_at !== entry.workerInput.observedAt ||
        entry.receipt?.outcome === "completed")
    )
      ctx.addIssue({ code: "custom", message: "Invalid worker question hold" });
    if (
      (entry.answerChallenge &&
        (!entry.workerInput ||
          entry.answerChallenge.runId !== entry.request.run_id ||
          entry.answerChallenge.requestId !== entry.request.request_id ||
          entry.answerChallenge.bindingHash !==
            workerHumanAnswerBindingHash(entry.request, entry.contextHash, entry.workerInput))) ||
      (entry.workerAnswer &&
        (!entry.answerChallenge ||
          !entry.workerInput ||
          computeCanonicalHash(entry.workerAnswer.payload.challenge) !==
            computeCanonicalHash(entry.answerChallenge) ||
          Date.parse(entry.workerAnswer.payload.answeredAt) <
            Date.parse(entry.answerChallenge.issuedAt) ||
          Date.parse(entry.workerAnswer.payload.answeredAt) >=
            Date.parse(entry.answerChallenge.expiresAt) ||
          !workerHumanAnswersMatch(entry.workerInput, entry.workerAnswer.payload))) ||
      (entry.answerDelivery &&
        (!entry.workerAnswer ||
          !entry.answerChallenge ||
          entry.answerDelivery.answerHash !== computeCanonicalHash(entry.workerAnswer) ||
          Date.parse(entry.answerDelivery.claimedAt) <
            Date.parse(entry.workerAnswer.payload.answeredAt) ||
          Date.parse(entry.answerDelivery.deadlineAt) >
            Date.parse(entry.answerChallenge!.expiresAt) ||
          Date.parse(entry.answerDelivery.deadlineAt) - Date.parse(entry.answerDelivery.claimedAt) >
            30_000))
    )
      ctx.addIssue({ code: "custom", message: "Invalid worker answer state" });
  });
const stateSchema = z
  .object({ version: z.literal(1), entries: z.array(entrySchema).max(128) })
  .strict()
  .refine((state) => {
    const retained = state.entries.flatMap((v) => v.inputEvents ?? []);
    const reservations = retained.flatMap((v) =>
      v.reservation ? [v.reservation.reservationId] : []
    );
    return (
      retained.length <= 128 &&
      Buffer.byteLength(JSON.stringify(retained), "utf8") <= 1024 * 1024 &&
      new Set(retained.map((v) => v.event.eventId)).size === retained.length &&
      new Set(retained.map((v) => v.event.input.presentation.presentationId)).size ===
        retained.length &&
      new Set(reservations).size === reservations.length
    );
  }, "Invalid Run input-event journal capacity or identities");
type HumanState = z.infer<typeof stateSchema>;

export interface HumanActionMutationInput {
  controller: ControllerLeaseCredential;
  expectedRunRevision: number;
  mutationId: string;
  now: string;
}

export type HumanActionMutationResult =
  { ok: true; revision: number; replay: boolean } | { ok: false; reason: string };

/** Fail closed on corrupt state. Receipts remain data, never execution authority. */
export function readHumanActionState(state: JsonValue): HumanState {
  const metadata = rootObject(state).metadata;
  if (metadata === undefined) return { version: 1, entries: [] };
  const value = rootObject(metadata)[KEY];
  return value === undefined ? { version: 1, entries: [] } : stateSchema.parse(value);
}

/** Historical data only; never a qualification or processing permission. */
export function readWorkerHumanInputJournal(state: JsonValue) {
  return {
    version: 1 as const,
    entries: readHumanActionState(state).entries.flatMap((v) => v.inputEvents ?? []),
  };
}

export function humanActionSummary(state: JsonValue, now: string) {
  return readHumanActionState(state)
    .entries.filter((entry) => !entry.supersededBy && entry.receipt?.outcome !== "completed")
    .map(({ request, receipt }) => ({
      requestId: request.request_id,
      attemptId: request.attempt_id,
      summary: [...request.summary].slice(0, 240).join(""),
      summaryTruncated: [...request.summary].length > 240,
      disposition:
        receipt?.outcome ??
        (request.expires_at && Date.parse(now) >= Date.parse(request.expires_at)
          ? "expired"
          : "pending"),
    }));
}

/**
 * Source-only ADR-010 service. Commit before presenting the request to a human.
 * The host must admit receipts through its authenticated human channel; actor_id
 * and a matching hash do not authenticate an agent-supplied answer.
 */
export class AgentWorkHumanActionService {
  constructor(
    private readonly coordination: CoordinationStore,
    private readonly workspace: Pick<WorkspaceLifecycleStore, "getAttempt" | "getWorkspaceLease"> &
      Pick<WorkerSessionStore, "getWorkerSession">,
    private readonly observer: {
      observe(
        lease: Awaited<ReturnType<WorkspaceLifecycleStore["getWorkspaceLease"]>> & {}
      ): Promise<WorkspaceObservation>;
    },
    private readonly humanAnswerVerifier?: TrustedHumanAnswerVerifier
  ) {}

  /**
   * Protected host composition only. Commit before display; replay must never display.
   * Recovery names the previous presentation following explicit human return intent.
   * These caller fields record intent, not independent proof of human identity.
   */
  async claimWorkerQuestionPresentation(
    input: HumanActionMutationInput & {
      requestId: string;
      presentationId: string;
      challengeId: string;
      expiresAt: string;
      previousPresentationId?: string;
    }
  ) {
    input = structuredClone(input);
    const loaded = await this.loadWorkerQuestion(input, input.requestId);
    if (!loaded.ok) return loaded;
    const { record, state, entry } = loaded;
    const history = entry.presentations ?? [];
    const replay = history.find((value) => value.presentationId === input.presentationId);
    if (replay) {
      if (
        replay.challenge.challengeId !== input.challengeId ||
        replay.challenge.expiresAt !== input.expiresAt ||
        replay.previousPresentationId !== input.previousPresentationId
      )
        return { ok: false as const, reason: "presentation_conflict" };
      return {
        ok: true as const,
        revision: record.revision,
        replay: true,
        newlyClaimed: false,
        presentation: replay,
        capture: entry.workerInput!,
      };
    }
    if (entry.workerAnswer) return { ok: false as const, reason: "answer_already_admitted" };
    if (history.length === 16) return { ok: false as const, reason: "presentation_capacity" };
    const previous = history[history.length - 1];
    if (previous) {
      if (input.previousPresentationId !== previous.presentationId)
        return { ok: false as const, reason: "explicit_presentation_recovery_required" };
      if (
        previous.disposition === "active" &&
        Date.parse(input.now) < Date.parse(previous.challenge.expiresAt)
      )
        return { ok: false as const, reason: "presentation_already_active" };
      if (Date.parse(input.now) < Date.parse(previous.closedAt ?? previous.challenge.issuedAt))
        return { ok: false as const, reason: "invalid_time" };
    } else if (input.previousPresentationId || entry.answerChallenge) {
      return { ok: false as const, reason: "presentation_history_missing" };
    }
    const stale = await this.workerQuestionFreshness(input, loaded);
    if (stale) return { ok: false as const, reason: stale };
    const challenge = WorkerHumanAnswerChallenge.parse({
      version: 1,
      domain: "lexrunner.worker-human-answer/v1",
      runId: entry.request.run_id,
      requestId: entry.request.request_id,
      challengeId: input.challengeId,
      generation: (entry.answerChallenge?.generation ?? 0) + 1,
      bindingHash: workerHumanAnswerBindingHash(
        entry.request,
        entry.contextHash,
        entry.workerInput!
      ),
      issuedAt: input.now,
      expiresAt: input.expiresAt,
    });
    if (
      entry.request.expires_at &&
      Date.parse(challenge.expiresAt) > Date.parse(entry.request.expires_at)
    )
      return { ok: false as const, reason: "challenge_exceeds_request_expiry" };
    if (history.some((value) => value.challenge.challengeId === challenge.challengeId))
      return { ok: false as const, reason: "challenge_conflict" };
    const presentation = WorkerHumanPresentation.parse({
      presentationId: input.presentationId,
      ...(input.previousPresentationId
        ? { previousPresentationId: input.previousPresentationId }
        : {}),
      challenge,
      disposition: "active",
    });
    // Lost expiry observations are recovered atomically with the new claim: no unheld interval.
    if (previous?.disposition === "active") {
      previous.disposition = "expired";
      previous.closedAt = input.now;
    }
    entry.answerChallenge = challenge;
    entry.presentations = [...history, presentation];
    const result = await this.commit(
      input,
      record.state,
      state,
      "worker_question_presentation_claimed",
      input.requestId
    );
    return result.ok
      ? { ...result, newlyClaimed: !result.replay, presentation, capture: entry.workerInput! }
      : result;
  }

  /** Close only the display. Skip/cancel/expiry/failure cannot settle the question. */
  async closeWorkerQuestionPresentation(
    input: HumanActionMutationInput & {
      requestId: string;
      presentationId: string;
      disposition: "declined" | "cancelled" | "expired" | "failed";
    }
  ): Promise<HumanActionMutationResult> {
    input = structuredClone(input);
    const loaded = await this.loadWorkerQuestion(input, input.requestId);
    if (!loaded.ok) return loaded;
    const { record, state, entry } = loaded;
    const presentation = entry.presentations?.[entry.presentations.length - 1];
    if (!presentation || presentation.presentationId !== input.presentationId)
      return { ok: false, reason: "presentation_binding_mismatch" };
    if (presentation.disposition !== "active")
      return presentation.disposition === input.disposition
        ? { ok: true, revision: record.revision, replay: true }
        : { ok: false, reason: "presentation_outcome_conflict" };
    if (record.revision !== input.expectedRunRevision)
      return { ok: false, reason: "stale_run_revision" };
    // Parse before mutation; an early timeout or invalid outcome is rejected.
    z.enum(["declined", "cancelled", "expired", "failed"]).parse(input.disposition);
    const closed = WorkerHumanPresentation.parse({
      ...presentation,
      disposition: input.disposition,
      closedAt: input.now,
    });
    entry.presentations![entry.presentations!.length - 1] = closed;
    return this.commit(
      input,
      record.state,
      state,
      "worker_question_presentation_closed",
      input.requestId
    );
  }

  /** Bounded read. A deadline expires a presentation, never the durable hold. */
  async getWorkerQuestionPresentation(runId: string, requestId: string, now: string) {
    z.string().datetime({ offset: true }).parse(now);
    const record = await this.coordination.getRunCoordination(runId);
    if (!record) return null;
    const entry = readHumanActionState(record.state).entries.find(
      (value) => value.request.request_id === requestId
    );
    if (!entry?.workerInput || entry.supersededBy || entry.receipt) return null;
    const current = entry.presentations?.[entry.presentations.length - 1];
    return {
      requestId,
      holdPending: true,
      answerAdmitted: Boolean(entry.workerAnswer),
      presentationCount: entry.presentations?.length ?? 0,
      presentationId: current?.presentationId ?? null,
      disposition:
        current?.disposition === "active" &&
        Date.parse(now) >= Date.parse(current.challenge.expiresAt)
          ? "expired"
          : (current?.disposition ?? "not_presented"),
    };
  }

  /** Host issues this only after persisting the exact question, before presenting it. */
  async issueWorkerAnswerChallenge(
    input: HumanActionMutationInput & { requestId: string; challengeId: string; expiresAt: string }
  ) {
    input = structuredClone(input);
    const loaded = await this.loadWorkerQuestion(input, input.requestId);
    if (!loaded.ok) return loaded;
    const { record, state, entry } = loaded;
    if (entry.workerAnswer) return { ok: false as const, reason: "answer_already_admitted" };
    if (entry.presentations)
      return { ok: false as const, reason: "presentation_managed_challenge" };
    if (entry.answerChallenge?.challengeId === input.challengeId) {
      if (entry.answerChallenge.expiresAt !== input.expiresAt)
        return { ok: false as const, reason: "challenge_conflict" };
      return {
        ok: true as const,
        revision: record.revision,
        replay: true,
        challenge: entry.answerChallenge,
      };
    }
    if (
      entry.answerChallenge &&
      Date.parse(entry.answerChallenge.expiresAt) > Date.parse(input.now)
    )
      return { ok: false as const, reason: "challenge_already_active" };
    const stale = await this.workerQuestionFreshness(input, loaded);
    if (stale) return { ok: false as const, reason: stale };
    const challenge = WorkerHumanAnswerChallenge.parse({
      version: 1,
      domain: "lexrunner.worker-human-answer/v1",
      runId: entry.request.run_id,
      requestId: entry.request.request_id,
      challengeId: input.challengeId,
      generation: (entry.answerChallenge?.generation ?? 0) + 1,
      bindingHash: workerHumanAnswerBindingHash(
        entry.request,
        entry.contextHash,
        entry.workerInput!
      ),
      issuedAt: input.now,
      expiresAt: input.expiresAt,
    });
    if (
      entry.request.expires_at &&
      Date.parse(challenge.expiresAt) > Date.parse(entry.request.expires_at)
    )
      return { ok: false as const, reason: "challenge_exceeds_request_expiry" };
    entry.answerChallenge = challenge;
    const result = await this.commit(
      input,
      record.state,
      state,
      "worker_answer_challenged",
      input.requestId
    );
    return result.ok ? { ...result, challenge } : result;
  }

  /** No caller-supplied trust keys. The configured host attests its own human admission. */
  async admitWorkerAnswer(
    input: HumanActionMutationInput & { answer: SignedWorkerHumanAnswer },
    /** Protected process-local veto; cannot authenticate or weaken core checks. */
    commitGuard?: () => boolean
  ): Promise<HumanActionMutationResult> {
    input = structuredClone(input);
    const answer = SignedWorkerHumanAnswer.parse(input.answer);
    if (!this.humanAnswerVerifier?.verify(answer))
      return { ok: false, reason: "human_host_authentication_failed" };
    const loaded = await this.loadWorkerQuestion(input, answer.payload.challenge.requestId);
    if (!loaded.ok) return loaded;
    const { record, state, entry } = loaded;
    if (entry.workerAnswer)
      return computeCanonicalHash(entry.workerAnswer) === computeCanonicalHash(answer)
        ? { ok: true, revision: record.revision, replay: true }
        : { ok: false, reason: "worker_answer_conflict" };
    const stale = await this.workerQuestionFreshness(input, loaded);
    if (stale) return { ok: false, reason: stale };
    if (
      !entry.answerChallenge ||
      computeCanonicalHash(entry.answerChallenge) !==
        computeCanonicalHash(answer.payload.challenge) ||
      !workerHumanAnswersMatch(entry.workerInput!, answer.payload)
    )
      return { ok: false, reason: "worker_answer_binding_mismatch" };
    if (
      Date.parse(answer.payload.answeredAt) < Date.parse(entry.answerChallenge.issuedAt) ||
      Date.parse(answer.payload.answeredAt) > Date.parse(input.now) ||
      Date.parse(input.now) >= Date.parse(entry.answerChallenge.expiresAt)
    )
      return { ok: false, reason: "worker_answer_expired_or_invalid_time" };
    const presentation = entry.presentations?.[entry.presentations.length - 1];
    if (presentation && presentation.disposition !== "active")
      return { ok: false, reason: "presentation_not_active" };
    if (presentation) {
      presentation.disposition = "answered";
      presentation.closedAt = input.now;
    }
    entry.workerAnswer = answer;
    return this.commit(
      input,
      record.state,
      state,
      "worker_answer_admitted",
      entry.request.request_id,
      commitGuard
    );
  }

  /** Protected host read surface, not a worker-facing CLI/MCP route. */
  async getWorkerAnswer(runId: string, requestId: string) {
    const record = await this.coordination.getRunCoordination(runId);
    if (!record) return null;
    const entry = readHumanActionState(record.state).entries.find(
      (value) => value.request.request_id === requestId
    );
    if (!entry || entry.supersededBy || entry.receipt || !entry.workerInput || !entry.workerAnswer)
      return null;
    return { capture: entry.workerInput, answer: entry.workerAnswer };
  }

  /** One persisted send slot. Replay is inspection only and must never send again. */
  async claimWorkerAnswerDelivery(
    input: HumanActionMutationInput & { requestId: string; claimId: string }
  ) {
    input = structuredClone(input);
    const loaded = await this.loadWorkerQuestion(input, input.requestId);
    if (!loaded.ok) return loaded;
    const { record, state, entry } = loaded;
    if (!entry.workerAnswer || !this.humanAnswerVerifier?.verify(entry.workerAnswer))
      return { ok: false as const, reason: "authenticated_worker_answer_missing" };
    if (entry.answerDelivery)
      return {
        ok: true as const,
        revision: record.revision,
        replay: true,
        newlyClaimed: false,
        delivery: entry.answerDelivery,
      };
    const stale = await this.workerQuestionFreshness(input, loaded);
    if (stale) return { ok: false as const, reason: stale };
    if (Date.parse(input.now) >= Date.parse(entry.answerChallenge!.expiresAt))
      return { ok: false as const, reason: "answer_delivery_window_expired" };
    const lease = await this.coordination.getControllerLease(input.controller.runId);
    if (!lease) return { ok: false as const, reason: "no_active_lease" };
    const delivery = WorkerHumanAnswerDelivery.parse({
      claimId: input.claimId,
      answerHash: computeCanonicalHash(entry.workerAnswer),
      controllerId: input.controller.controllerId,
      controllerLeaseId: input.controller.leaseId,
      fencingToken: input.controller.fencingToken,
      claimedAt: input.now,
      deadlineAt: new Date(
        Math.min(
          Date.parse(lease.expiresAt),
          Date.parse(entry.answerChallenge!.expiresAt),
          Date.parse(input.now) + 30_000
        )
      ).toISOString(),
      disposition: "claimed",
    });
    entry.answerDelivery = delivery;
    const result = await this.commit(
      input,
      record.state,
      state,
      "worker_answer_send_claimed",
      input.requestId
    );
    return result.ok ? { ...result, newlyClaimed: !result.replay, delivery } : result;
  }

  /** Written is a local pipe observation, never worker consumption or hold release. */
  async recordWorkerAnswerWrite(
    input: HumanActionMutationInput & {
      requestId: string;
      claimId: string;
      disposition: "written" | "not_sent" | "uncertain";
    }
  ): Promise<HumanActionMutationResult> {
    input = structuredClone(input);
    const loaded = await this.loadWorkerQuestion(input, input.requestId);
    if (!loaded.ok) return loaded;
    const { record, state, entry } = loaded;
    if (!entry.answerDelivery || entry.answerDelivery.claimId !== input.claimId)
      return { ok: false, reason: "answer_delivery_claim_mismatch" };
    if (entry.answerDelivery.disposition !== "claimed")
      return entry.answerDelivery.disposition === input.disposition
        ? { ok: true, revision: record.revision, replay: true }
        : { ok: false, reason: "answer_write_conflict" };
    if (
      record.revision !== input.expectedRunRevision ||
      Date.parse(input.now) < Date.parse(entry.answerDelivery.claimedAt)
    )
      return { ok: false, reason: "stale_answer_write_observation" };
    entry.answerDelivery = WorkerHumanAnswerDelivery.parse({
      ...entry.answerDelivery,
      disposition: input.disposition,
      observedAt: input.now,
    });
    return this.commit(input, record.state, state, "worker_answer_write_observed", input.requestId);
  }

  /** Retain bounded host evidence, including post-deadline reconciliation; never release a hold. */
  async recordWorkerAnswerObservation(
    input: HumanActionMutationInput & { observation: WorkerHumanAnswerObservation }
  ): Promise<HumanActionMutationResult> {
    input = structuredClone(input);
    const observation = WorkerHumanAnswerObservation.parse(input.observation);
    const loaded = await this.loadWorkerQuestion(input, observation.requestId);
    if (!loaded.ok) return loaded;
    const { record, state, entry } = loaded;
    const delivery = entry.answerDelivery;
    if (
      !entry.workerAnswer ||
      !delivery ||
      observation.runId !== input.controller.runId ||
      observation.claimId !== delivery.claimId ||
      observation.answerHash !== delivery.answerHash ||
      observation.captureHash !== computeCanonicalHash(entry.workerInput)
    )
      return { ok: false, reason: "answer_observation_binding_mismatch" };
    const prior = entry.answerObservations?.find(
      (v) => v.observationId === observation.observationId
    );
    if (prior)
      return computeCanonicalHash(prior) === computeCanonicalHash(observation)
        ? { ok: true, revision: record.revision, replay: true }
        : { ok: false, reason: "answer_observation_conflict" };
    if (record.revision !== input.expectedRunRevision)
      return { ok: false, reason: "stale_run_revision" };
    if (delivery.disposition === "not_sent") return { ok: false, reason: "answer_not_sent" };
    if (
      Date.parse(observation.observedAt) < Date.parse(delivery.claimedAt) ||
      Date.parse(observation.observedAt) > Date.parse(input.now)
    )
      return { ok: false, reason: "invalid_answer_observation_time" };
    if ((entry.answerObservations?.length ?? 0) >= 16)
      return { ok: false, reason: "answer_observation_capacity" };
    entry.answerObservations = [...(entry.answerObservations ?? []), observation];
    return this.commit(
      input,
      record.state,
      state,
      "worker_answer_observation_recorded",
      observation.requestId
    );
  }

  /** Compact protected host read; hashes bind observations, not their truth or provenance. */
  async inspectWorkerAnswerDelivery(runId: string, requestId: string) {
    const record = await this.coordination.getRunCoordination(runId);
    if (!record) return null;
    const entry = readHumanActionState(record.state).entries.find(
      (v) => v.request.request_id === requestId
    );
    if (!entry?.workerInput || entry.supersededBy || entry.receipt) return null;
    return {
      requestId,
      holdPending: true,
      answerAdmitted: Boolean(entry.workerAnswer),
      delivery: entry.answerDelivery
        ? {
            claimId: entry.answerDelivery.claimId,
            answerHash: entry.answerDelivery.answerHash,
            disposition: entry.answerDelivery.disposition,
          }
        : null,
      observations: entry.answerObservations ?? [],
      consumptionQualified: false,
      resendAllowed: false,
    };
  }

  /** Source-only protocol recording. No qualification, signature, answer or hold settlement. */
  async recordWorkerInputEvent(
    input: HumanActionMutationInput & { event: WorkerHumanInputEvent },
    commitGuard: () => boolean
  ) {
    input = structuredClone(input);
    const event = WorkerHumanInputEvent.parse(input.event);
    const eventHash = hashWorkerHumanInputEvent(event);
    const loaded = await this.loadWorkerInputJournal(input);
    if (!loaded.ok) return loaded;
    const { record, state } = loaded;
    const retained = state.entries.flatMap((v) => v.inputEvents ?? []);
    const prior = retained.find((v) => v.event.eventId === event.eventId);
    if (prior)
      return prior.eventHash === eventHash
        ? {
            ok: true as const,
            revision: record.revision,
            replay: true,
            newlyRecorded: false,
            eventHash,
          }
        : { ok: false as const, reason: "input_event_conflict" };
    if (
      retained.some(
        (v) => v.event.input.presentation.presentationId === event.input.presentation.presentationId
      )
    )
      return { ok: false as const, reason: "presentation_input_already_recorded" };
    if (retained.length === 128) return { ok: false as const, reason: "input_event_capacity" };
    const entry = state.entries.find(
      (v) => v.request.request_id === event.input.presentation.challenge.requestId
    );
    if (!entry?.workerInput || entry.supersededBy || entry.receipt)
      return { ok: false as const, reason: "worker_question_not_pending" };
    const applicable = this.inputEventApplicable(input, event, entry);
    if (applicable) return { ok: false as const, reason: applicable };
    const stale = await this.workerQuestionFreshness(input, { ...loaded, entry });
    if (stale) return { ok: false as const, reason: stale };
    if ((entry.inputEvents?.length ?? 0) === 16)
      return { ok: false as const, reason: "input_event_capacity" };
    if (typeof commitGuard !== "function")
      return { ok: false as const, reason: "input_event_guard_required" };
    const retainedEvent = WorkerHumanInputEventRecord.parse({
      event,
      eventHash,
      recordedAt: input.now,
    });
    entry.inputEvents = [...(entry.inputEvents ?? []), retainedEvent];
    if (
      Buffer.byteLength(JSON.stringify(state.entries.flatMap((v) => v.inputEvents ?? [])), "utf8") >
      1024 * 1024
    )
      return { ok: false as const, reason: "input_event_byte_capacity" };
    const result = await this.commit(
      input,
      record.state,
      state,
      "worker_input_event_recorded",
      entry.request.request_id,
      commitGuard
    );
    return result.ok ? { ...result, newlyRecorded: !result.replay, eventHash } : result;
  }

  /** Reserve once for local processing. Replay confirms history, never authorizes a new operation. */
  async reserveWorkerInputEvent(
    input: HumanActionMutationInput & {
      eventId: string;
      eventHash: string;
      reservationId: string;
      source: WorkerHumanInputSource;
    },
    commitGuard: () => boolean
  ) {
    input = structuredClone(input);
    z.string().uuid().parse(input.eventId);
    z.string().uuid().parse(input.reservationId);
    SHA256Hash.parse(input.eventHash);
    const source = WorkerHumanInputSource.parse(input.source);
    const loaded = await this.loadWorkerInputJournal(input);
    if (!loaded.ok) return loaded;
    const { record, state } = loaded;
    const entry = state.entries.find((v) =>
      v.inputEvents?.some((e) => e.event.eventId === input.eventId)
    );
    const retained = entry?.inputEvents?.find((v) => v.event.eventId === input.eventId);
    if (!retained || !entry) return { ok: false as const, reason: "input_event_not_found" };
    if (
      retained.eventHash !== input.eventHash ||
      computeCanonicalHash(retained.event.source) !== computeCanonicalHash(source)
    )
      return { ok: false as const, reason: "input_event_conflict" };
    if (retained.reservation)
      return retained.reservation.reservationId === input.reservationId
        ? {
            ok: true as const,
            revision: record.revision,
            replay: true,
            newlyReserved: false,
            eventHash: retained.eventHash,
          }
        : { ok: false as const, reason: "input_event_already_reserved" };
    if (
      state.entries
        .flatMap((v) => v.inputEvents ?? [])
        .some((v) => v.reservation?.reservationId === input.reservationId)
    )
      return { ok: false as const, reason: "input_reservation_conflict" };
    if (!entry.workerInput || entry.supersededBy || entry.receipt)
      return { ok: false as const, reason: "worker_question_not_pending" };
    const applicable = this.inputEventApplicable(input, retained.event, entry);
    if (applicable || Date.parse(input.now) < Date.parse(retained.recordedAt))
      return { ok: false as const, reason: applicable ?? "invalid_time" };
    const stale = await this.workerQuestionFreshness(input, { ...loaded, entry });
    if (stale) return { ok: false as const, reason: stale };
    if (typeof commitGuard !== "function")
      return { ok: false as const, reason: "input_event_guard_required" };
    retained.reservation = { reservationId: input.reservationId, reservedAt: input.now };
    if (
      Buffer.byteLength(JSON.stringify(state.entries.flatMap((v) => v.inputEvents ?? [])), "utf8") >
      1024 * 1024
    )
      return { ok: false as const, reason: "input_event_byte_capacity" };
    const result = await this.commit(
      input,
      record.state,
      state,
      "worker_input_event_reserved",
      entry.request.request_id,
      commitGuard
    );
    return result.ok
      ? { ...result, newlyReserved: !result.replay, eventHash: retained.eventHash }
      : result;
  }

  private async loadWorkerInputJournal(input: HumanActionMutationInput) {
    if (!z.string().datetime({ offset: true }).safeParse(input.now).success)
      return { ok: false as const, reason: "invalid_time" };
    const record = await this.coordination.getRunCoordination(input.controller.runId);
    if (!record) return { ok: false as const, reason: "not_found" };
    return { ok: true as const, record, state: readHumanActionState(record.state) };
  }

  private inputEventApplicable(
    input: HumanActionMutationInput,
    event: WorkerHumanInputEvent,
    entry: HumanState["entries"][number]
  ) {
    const history = entry.presentations ?? [];
    const current = history[history.length - 1];
    if (
      entry.workerAnswer ||
      !current ||
      current.disposition !== "active" ||
      computeCanonicalHash(current) !== computeCanonicalHash(event.input.presentation) ||
      computeCanonicalHash(entry.workerInput) !== computeCanonicalHash(event.input.capture) ||
      event.input.presentation.challenge.runId !== input.controller.runId ||
      Date.parse(input.now) < Date.parse(event.input.observedAt) ||
      Date.parse(input.now) >= Date.parse(current.challenge.expiresAt)
    )
      return "input_event_not_applicable";
    return null;
  }

  private async loadWorkerQuestion(input: HumanActionMutationInput, requestId: string) {
    if (!z.string().datetime({ offset: true }).safeParse(input.now).success)
      return { ok: false as const, reason: "invalid_time" };
    const record = await this.coordination.getRunCoordination(input.controller.runId);
    if (!record) return { ok: false as const, reason: "not_found" };
    const state = readHumanActionState(record.state);
    const entry = state.entries.find((value) => value.request.request_id === requestId);
    if (!entry?.workerInput || entry.supersededBy || entry.receipt)
      return { ok: false as const, reason: "worker_question_not_pending" };
    return { ok: true as const, record, state, entry };
  }

  private async workerQuestionFreshness(
    input: HumanActionMutationInput,
    loaded: Extract<
      Awaited<ReturnType<AgentWorkHumanActionService["loadWorkerQuestion"]>>,
      { ok: true }
    >
  ): Promise<string | null> {
    const { record, entry } = loaded;
    if (record.revision !== input.expectedRunRevision) return "stale_run_revision";
    if (
      entry.workerAnswer &&
      Date.parse(input.now) < Date.parse(entry.workerAnswer.payload.answeredAt)
    )
      return "invalid_time";
    if (entry.contextHash !== contextHash(record.state)) return "request_context_changed";
    if (
      Date.parse(input.now) < Date.parse(entry.request.requested_at) ||
      (entry.request.expires_at && Date.parse(input.now) >= Date.parse(entry.request.expires_at))
    )
      return "request_expired_or_invalid_time";
    if (
      !(await this.matchesWorkspace(entry.request, entry.request.preconditions.expected_head_sha))
    )
      return "stale_workspace_binding";
    const session = await this.workspace.getWorkerSession(entry.request.worker_session_id);
    if (
      session?.workerId !== entry.workerInput!.workerId ||
      session.workerRuntime !== entry.workerInput!.workerRuntime
    )
      return "worker_input_session_mismatch";
    if (!["running", "awaiting_human"].includes(session.status)) return "worker_session_not_live";
    return null;
  }

  async request(
    input: HumanActionMutationInput & {
      request: HumanActionRequest_v1;
      replacesRequestId?: string;
      workerInput?: WorkerHumanInputCapture;
    }
  ): Promise<HumanActionMutationResult> {
    input = structuredClone(input);
    if (!z.string().datetime({ offset: true }).safeParse(input.now).success)
      return { ok: false, reason: "invalid_time" };
    const request = HumanActionRequest_v1.parse(input.request);
    const workerInput =
      input.workerInput === undefined
        ? undefined
        : WorkerHumanInputCapture.parse(input.workerInput);
    if (
      workerInput &&
      (request.action !== "other" ||
        request.requested_at !== workerInput.observedAt ||
        request.request_id !== `worker-input:${workerInput.observationId}`)
    )
      return { ok: false, reason: "invalid_worker_input_binding" };
    if (
      Buffer.byteLength(JSON.stringify(request), "utf8") > 16 * 1024 ||
      request.summary.length > 2048
    )
      return { ok: false, reason: "request_too_large" };
    const record = await this.coordination.getRunCoordination(input.controller.runId);
    if (!record) return { ok: false, reason: "not_found" };
    const state = readHumanActionState(record.state);
    const prior = state.entries.find((entry) => entry.request.request_id === request.request_id);
    if (prior) {
      if (prior.supersededBy) return { ok: false, reason: "request_superseded" };
      if (
        computeCanonicalHash(prior.request) !== computeCanonicalHash(request) ||
        prior.replacesRequestId !== input.replacesRequestId ||
        computeCanonicalHash(prior.workerInput ?? null) !==
          computeCanonicalHash(workerInput ?? null)
      )
        return { ok: false, reason: "request_conflict" };
      return { ok: true, revision: record.revision, replay: true };
    }
    if (
      record.revision !== input.expectedRunRevision ||
      request.preconditions.run_revision !== record.revision
    )
      return { ok: false, reason: "stale_run_revision" };
    if (
      request.run_id !== input.controller.runId ||
      Date.parse(request.requested_at) > Date.parse(input.now) ||
      (request.expires_at && Date.parse(request.expires_at) <= Date.parse(request.requested_at))
    )
      return { ok: false, reason: "invalid_request_binding" };
    if (!(await this.matchesWorkspace(request, request.preconditions.expected_head_sha)))
      return { ok: false, reason: "stale_workspace_binding" };
    if (workerInput) {
      const session = await this.workspace.getWorkerSession(request.worker_session_id);
      if (
        session?.workerRuntime !== workerInput.workerRuntime ||
        session.workerId !== workerInput.workerId
      )
        return { ok: false, reason: "worker_input_session_mismatch" };
      if (
        state.entries.some(
          (entry) =>
            entry.workerInput &&
            entry.workerInput.connectionId === workerInput.connectionId &&
            entry.workerInput.providerRequestId === workerInput.providerRequestId
        )
      )
        return { ok: false, reason: "worker_request_already_bound" };
    }
    if (state.entries.length === 128) return { ok: false, reason: "human_action_capacity" };
    if (input.replacesRequestId) {
      const replaced = state.entries.find(
        (entry) => entry.request.request_id === input.replacesRequestId
      );
      if (!replaced || replaced.supersededBy || replaced.receipt?.outcome === "completed")
        return { ok: false, reason: "replacement_not_pending" };
      if (replaced.workerInput && !workerInput)
        return { ok: false, reason: "worker_input_replacement_required" };
      replaced.supersededBy = request.request_id;
    }
    state.entries.push({
      request,
      contextHash: contextHash(record.state),
      receipt: null,
      ...(input.replacesRequestId ? { replacesRequestId: input.replacesRequestId } : {}),
      ...(workerInput ? { workerInput } : {}),
    });
    return this.commit(input, record.state, state, "human_action_requested", request.request_id);
  }

  async settle(
    input: HumanActionMutationInput & { receipt: HumanActionReceipt_v1 }
  ): Promise<HumanActionMutationResult> {
    input = structuredClone(input);
    if (!z.string().datetime({ offset: true }).safeParse(input.now).success)
      return { ok: false, reason: "invalid_time" };
    const receipt = HumanActionReceipt_v1.parse(input.receipt);
    if (Buffer.byteLength(JSON.stringify(receipt), "utf8") > 16 * 1024)
      return { ok: false, reason: "receipt_too_large" };
    const record = await this.coordination.getRunCoordination(input.controller.runId);
    if (!record) return { ok: false, reason: "not_found" };
    const state = readHumanActionState(record.state);
    const entry = state.entries.find((item) => item.request.request_id === receipt.request_id);
    if (!entry) return { ok: false, reason: "request_not_found" };
    if (entry.supersededBy) return { ok: false, reason: "request_superseded" };
    if (entry.receipt) {
      return computeCanonicalHash(entry.receipt) === computeCanonicalHash(receipt)
        ? { ok: true, revision: record.revision, replay: true }
        : { ok: false, reason: "receipt_conflict" };
    }
    if (record.revision !== input.expectedRunRevision)
      return { ok: false, reason: "stale_run_revision" };
    const request = entry.request;
    if (
      !validateHumanActionReceiptBinding(request, receipt).valid ||
      Date.parse(receipt.completed_at) < Date.parse(request.requested_at) ||
      Date.parse(receipt.completed_at) > Date.parse(input.now)
    )
      return { ok: false, reason: "invalid_receipt_binding" };
    if (receipt.outcome === "completed") {
      // No source caller can turn a captured worker question into an answered
      // hold before authenticated admission and fenced worker delivery exist.
      if (entry.workerInput) return { ok: false, reason: "worker_answer_delivery_not_qualified" };
      if (
        request.expires_at &&
        (Date.parse(input.now) >= Date.parse(request.expires_at) ||
          Date.parse(receipt.completed_at) >= Date.parse(request.expires_at))
      )
        return { ok: false, reason: "request_expired" };
      if (entry.contextHash !== contextHash(record.state))
        return { ok: false, reason: "request_context_changed" };
      // Source pilot deliberately forbids head-changing approvals. Signing and
      // other mutations need their own independently observed admission boundary.
      if (
        receipt.resulting_head_sha &&
        receipt.resulting_head_sha !== request.preconditions.expected_head_sha
      )
        return { ok: false, reason: "head_changing_action_not_supported" };
      if (!(await this.matchesWorkspace(request, request.preconditions.expected_head_sha)))
        return { ok: false, reason: "stale_workspace_binding" };
    }
    entry.receipt = receipt;
    return this.commit(input, record.state, state, "human_action_settled", request.request_id);
  }

  private async matchesWorkspace(request: HumanActionRequest_v1, head: string): Promise<boolean> {
    const [attempt, lease, session] = await Promise.all([
      this.workspace.getAttempt(request.attempt_id),
      this.workspace.getWorkspaceLease(request.workspace_lease_id),
      this.workspace.getWorkerSession(request.worker_session_id),
    ]);
    if (
      !attempt ||
      !lease ||
      !session ||
      attempt.runId !== request.run_id ||
      attempt.workspaceLeaseId !== lease.leaseId ||
      lease.runId !== request.run_id ||
      lease.attemptId !== attempt.attemptId ||
      lease.revision !== request.preconditions.workspace_lease_revision ||
      session.runId !== request.run_id ||
      session.attemptId !== attempt.attemptId ||
      session.workspaceLeaseId !== lease.leaseId
    )
      return false;
    const observed = await this.observer.observe(lease);
    return (
      observed.exists &&
      observed.registered &&
      observed.repositoryId === lease.repositoryId &&
      observed.hostId === lease.hostId &&
      observed.gitRuntime === lease.gitRuntime &&
      observed.projectRoot === lease.projectRoot &&
      observed.worktreePath === lease.worktreePath &&
      observed.branch === lease.branch &&
      observed.attemptId === lease.attemptId &&
      observed.headSha === head
    );
  }

  private async commit(
    input: HumanActionMutationInput,
    original: JsonValue,
    state: HumanState,
    type: string,
    requestId: string,
    commitGuard?: () => boolean
  ): Promise<HumanActionMutationResult> {
    const root = rootObject(original);
    const result = await this.coordination.compareAndSetRunState({
      ...input.controller,
      expectedRevision: input.expectedRunRevision,
      mutationId: input.mutationId,
      state: {
        ...root,
        metadata: {
          ...rootObject(root.metadata ?? {}),
          [KEY]: JSON.parse(JSON.stringify(stateSchema.parse(state))) as JsonValue,
        },
      },
      event: { type, payload: { requestId } },
      now: input.now,
      ...(commitGuard ? { commitGuard } : {}),
    });
    return result.updated
      ? { ok: true, revision: result.record.revision, replay: result.idempotentReplay }
      : { ok: false, reason: result.reason };
  }
}

function contextHash(state: JsonValue): string {
  const root = rootObject(state);
  const { [KEY]: _holds, ...metadata } = rootObject(root.metadata ?? {});
  // Retain special JSON keys as own data properties. The historical general
  // hash helper has a documented __proto__ setter quirk; it is not suitable for
  // authenticating arbitrary Run context. Ordinary compact hashes stay stable.
  const canonical = JSON.stringify({ ...root, metadata }, (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, (value as Record<string, unknown>)[key]])
        )
      : value
  );
  return computeCanonicalHashFromCompactJSON(canonical);
}

function rootObject(value: JsonValue): { [key: string]: JsonValue } {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Human actions require an object coordination state/metadata");
  return value;
}
