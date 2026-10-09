import { z } from "zod";
import { computeCanonicalHash, SHA256Hash } from "./task-contract.js";
import type { HumanActionRequest_v1 } from "./agent-work.js";
import type { WorkerHumanInputCapture } from "./worker-human-input.js";

const id = z.string().min(1).max(512);
const instant = z.string().datetime({ offset: true });
export const WorkerHumanAnswerChallenge = z
  .object({
    version: z.literal(1),
    domain: z.literal("lexrunner.worker-human-answer/v1"),
    runId: id,
    requestId: id,
    challengeId: z.string().uuid(),
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    bindingHash: SHA256Hash,
    issuedAt: instant,
    expiresAt: instant,
  })
  .strict()
  .refine(({ issuedAt, expiresAt }) => {
    const duration = Date.parse(expiresAt) - Date.parse(issuedAt);
    return duration > 0 && duration <= 15 * 60_000;
  }, "Challenge lifetime must be positive and at most fifteen minutes");
export type WorkerHumanAnswerChallenge = z.infer<typeof WorkerHumanAnswerChallenge>;

export const WorkerHumanAnswerPayload = z
  .object({
    version: z.literal(1),
    challenge: WorkerHumanAnswerChallenge,
    hostId: id,
    keyId: id,
    actorId: id,
    authenticationEventId: id,
    answeredAt: instant,
    answers: z
      .array(z.object({ questionId: id, value: z.string().min(1).max(4096) }).strict())
      .min(1)
      .max(8),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.answers.map((answer) => answer.questionId)).size === value.answers.length &&
      Buffer.byteLength(JSON.stringify(value), "utf8") <= 16 * 1024,
    "Duplicate question IDs or oversized answer"
  );
export type WorkerHumanAnswerPayload = z.infer<typeof WorkerHumanAnswerPayload>;
export const SignedWorkerHumanAnswer = z
  .object({
    payload: WorkerHumanAnswerPayload,
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/u),
  })
  .strict();
export type SignedWorkerHumanAnswer = z.infer<typeof SignedWorkerHumanAnswer>;

export const WorkerHumanAnswerDelivery = z
  .object({
    claimId: z.string().uuid(),
    answerHash: SHA256Hash,
    controllerId: id,
    controllerLeaseId: id,
    fencingToken: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    claimedAt: instant,
    deadlineAt: instant,
    disposition: z.enum(["claimed", "written", "not_sent", "uncertain"]),
    observedAt: instant.optional(),
  })
  .strict()
  .refine(
    (value) =>
      Date.parse(value.deadlineAt) > Date.parse(value.claimedAt) &&
      (value.disposition === "claimed"
        ? value.observedAt === undefined
        : value.observedAt !== undefined &&
          Date.parse(value.observedAt) >= Date.parse(value.claimedAt))
  );
export type WorkerHumanAnswerDelivery = z.infer<typeof WorkerHumanAnswerDelivery>;

/** Opaque retained-source locator. Integrity and origin must be checked by the host. */
export const WorkerHumanAnswerSourceEvidence = z
  .object({
    captureId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
    captureRoot: SHA256Hash,
    frameSequence: z.number().int().positive().max(65_536),
    frameHash: SHA256Hash,
  })
  .strict();
export type WorkerHumanAnswerSourceEvidence = z.infer<typeof WorkerHumanAnswerSourceEvidence>;

/** Host observations only: neither a consumption certificate nor action authority. */
export const WorkerHumanAnswerObservation = z
  .object({
    version: z.literal(1),
    domain: z.literal("lexrunner.worker-answer-observation/v1"),
    observationId: id,
    runId: id,
    requestId: id,
    claimId: z.string().uuid(),
    captureHash: SHA256Hash,
    answerHash: SHA256Hash,
    evidenceHash: SHA256Hash,
    kind: z.enum(["request_cleared", "matching_answer_output", "delivery_uncertain"]),
    observedAt: instant,
    sourceEvidence: WorkerHumanAnswerSourceEvidence.optional(),
  })
  .strict()
  .refine((value) => !value.sourceEvidence || value.kind === "matching_answer_output")
  .refine((value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 4096);
export type WorkerHumanAnswerObservation = z.infer<typeof WorkerHumanAnswerObservation>;

export function workerHumanAnswerBindingHash(
  request: HumanActionRequest_v1,
  contextHash: string,
  capture: WorkerHumanInputCapture
): string {
  return computeCanonicalHash({ request, contextHash, capture });
}

/** Preserve authored answer bytes and require exactly one answer per captured question. */
export function workerHumanAnswersMatch(
  capture: WorkerHumanInputCapture,
  payload: WorkerHumanAnswerPayload
): boolean {
  return (
    capture.questions.length === payload.answers.length &&
    capture.questions.every((question) => {
      const answer = payload.answers.find((value) => value.questionId === question.id);
      return (
        answer !== undefined &&
        (question.options === null ||
          question.allowOther ||
          question.options.some((option) => option.label === answer.value))
      );
    })
  );
}
