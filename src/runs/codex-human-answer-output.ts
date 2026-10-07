import { z } from "zod";
import { CodexHumanInputCapture, CodexHumanInputRequest } from "../schemas/codex-human-input.js";
import {
  SignedWorkerHumanAnswer,
  workerHumanAnswersMatch,
} from "../schemas/worker-human-answer.js";
import { computeCanonicalHash } from "../schemas/task-contract.js";
import type {
  AgentWorkHumanActionService,
  HumanActionMutationInput,
} from "./agent-work-human-action-service.js";

const id = z.string().min(1).max(512);
const Output = z
  .object({
    type: z.literal("function_call_output"),
    call_id: id,
    output: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 16 * 1024),
  })
  .strict();
const Binding = z
  .object({
    runId: id,
    requestId: id,
    capture: CodexHumanInputCapture,
    answer: SignedWorkerHumanAnswer,
    output: Output,
  })
  .strict();

/** Content conformance only. Caller-supplied bytes cannot authenticate their source. */
export function matchCodexHumanAnswerOutput(input: unknown) {
  const parsed = Binding.safeParse(input);
  if (!parsed.success) return { matched: false as const, reason: "invalid_answer_output_evidence" };
  const { runId, requestId, capture, answer, output } = parsed.data;
  if (
    requestId !== `worker-input:${capture.observationId}` ||
    answer.payload.challenge.runId !== runId ||
    answer.payload.challenge.requestId !== requestId ||
    !workerHumanAnswersMatch(capture, answer.payload)
  )
    return { matched: false as const, reason: "answer_output_binding_mismatch" };
  const request = CodexHumanInputRequest.parse(JSON.parse(capture.requestJson));
  if (output.call_id !== request.params.itemId)
    return { matched: false as const, reason: "answer_output_call_mismatch" };
  // Compare the exact result bytes produced by the owned adapter. Never parse and
  // normalize the answer body: that could hide duplicate keys or change authored text.
  const expected = JSON.stringify({
    answers: Object.fromEntries(
      answer.payload.answers.map((value) => [value.questionId, { answers: [value.value] }])
    ),
  });
  if (output.output !== expected)
    return { matched: false as const, reason: "answer_output_body_mismatch" };
  return {
    matched: true as const,
    runId,
    requestId,
    captureHash: computeCanonicalHash(capture),
    answerHash: computeCanonicalHash(answer),
    evidenceHash: computeCanonicalHash(output),
    sourceAuthenticated: false as const,
    consumptionQualified: false as const,
    resendAllowed: false as const,
  };
}

/** Protected source-only composition. It records history, never sends or releases a hold. */
export async function recordCodexHumanAnswerOutput(
  service: Pick<
    AgentWorkHumanActionService,
    "getWorkerAnswer" | "inspectWorkerAnswerDelivery" | "recordWorkerAnswerObservation"
  >,
  input: HumanActionMutationInput & {
    requestId: string;
    observationId: string;
    observedAt: string;
    output: z.infer<typeof Output>;
  }
) {
  input = structuredClone(input);
  const evidence = z
    .object({
      requestId: id,
      observationId: id,
      observedAt: z.string().datetime({ offset: true }),
      output: Output,
    })
    .strict()
    .safeParse({
      requestId: input.requestId,
      observationId: input.observationId,
      observedAt: input.observedAt,
      output: input.output,
    });
  if (!evidence.success) return { ok: false as const, reason: "invalid_answer_output_evidence" };
  const stored = await service.getWorkerAnswer(input.controller.runId, input.requestId);
  if (!stored) return { ok: false as const, reason: "authenticated_worker_answer_missing" };
  // Match synchronously before the next await, so injected ports cannot mutate the
  // capture or admitted answer while another read is pending.
  const match = matchCodexHumanAnswerOutput({
    runId: input.controller.runId,
    requestId: input.requestId,
    ...stored,
    output: evidence.data.output,
  });
  if (!match.matched) return { ok: false as const, reason: match.reason };
  const report = await service.inspectWorkerAnswerDelivery(input.controller.runId, input.requestId);
  if (!report?.delivery || report.delivery.answerHash !== match.answerHash)
    return { ok: false as const, reason: "answer_output_delivery_mismatch" };
  const result = await service.recordWorkerAnswerObservation({
    controller: input.controller,
    expectedRunRevision: input.expectedRunRevision,
    mutationId: input.mutationId,
    now: input.now,
    observation: {
      version: 1,
      domain: "lexrunner.worker-answer-observation/v1",
      observationId: evidence.data.observationId,
      runId: match.runId,
      requestId: match.requestId,
      claimId: report.delivery.claimId,
      captureHash: match.captureHash,
      answerHash: match.answerHash,
      evidenceHash: match.evidenceHash,
      kind: "matching_answer_output",
      observedAt: evidence.data.observedAt,
    },
  });
  return result.ok
    ? {
        ...result,
        contentMatched: true as const,
        sourceAuthenticated: false as const,
        consumptionQualified: false as const,
        resendAllowed: false as const,
      }
    : result;
}
