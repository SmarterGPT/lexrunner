import { z } from "zod";
import { WorkerHumanInputCapture } from "./worker-human-input.js";

const id = z.string().min(1).max(512);
const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const CodexServerRequestId = z.union([
  id,
  z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
]);
const option = z.object({ label: id, description: z.string().max(2048) }).strict();
const question = z
  .object({
    id,
    header: z.string().min(1).max(128),
    question: z.string().min(1).max(4096),
    isOther: z.boolean().optional(),
    // Secret-marked input belongs to a separately qualified secret channel.
    isSecret: z.literal(false).optional(),
    options: z.array(option).min(1).max(16).nullable().optional(),
  })
  .strict();

/** Bounded source projection, not authentication or native action authority. */
export const CodexHumanInputRequest = z
  .object({
    id: CodexServerRequestId,
    method: z.literal("item/tool/requestUserInput"),
    params: z
      .object({
        threadId: id,
        turnId: id,
        itemId: id,
        questions: z.array(question).min(1).max(8),
        // This pilot never automatically resolves an unanswered question.
        autoResolutionMs: z.null().optional(),
      })
      .strict(),
    emittedAtMs: safeInteger.optional(),
  })
  .strict()
  .refine(
    ({ params }) =>
      new Set(params.questions.map((value) => value.id)).size === params.questions.length,
    "Duplicate question IDs"
  );
export type CodexHumanInputRequest = z.infer<typeof CodexHumanInputRequest>;

export const CodexHumanInputCapture = WorkerHumanInputCapture.superRefine((capture, ctx) => {
  let request: CodexHumanInputRequest;
  try {
    request = CodexHumanInputRequest.parse(JSON.parse(capture.requestJson));
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid request JSON" });
    return;
  }
  if (
    capture.workerRuntime !== "codex-native" ||
    capture.workerId !== request.params.threadId ||
    capture.turnId !== request.params.turnId ||
    capture.providerRequestId !== request.id ||
    JSON.stringify(capture.questions) !==
      JSON.stringify(
        request.params.questions.map((q) => ({
          id: q.id,
          header: q.header,
          question: q.question,
          allowOther: q.isOther ?? false,
          options: q.options ?? null,
        }))
      )
  )
    ctx.addIssue({ code: "custom", message: "Invalid native question capture" });
});
export type CodexHumanInputCapture = z.infer<typeof CodexHumanInputCapture>;

export const CodexServerRequestResolved = z
  .object({
    method: z.literal("serverRequest/resolved"),
    params: z.object({ threadId: id, requestId: CodexServerRequestId }).strict(),
    emittedAtMs: safeInteger.optional(),
  })
  .strict();
