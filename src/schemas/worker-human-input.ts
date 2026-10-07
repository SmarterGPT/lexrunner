import { createHash } from "node:crypto";
import { z } from "zod";

const id = z.string().min(1).max(512);
export const WorkerHumanQuestion = z
  .object({
    id,
    header: z.string().min(1).max(128),
    question: z.string().min(1).max(4096),
    allowOther: z.boolean(),
    options: z
      .array(z.object({ label: id, description: z.string().max(2048) }).strict())
      .min(1)
      .max(16)
      .nullable(),
  })
  .strict();

/** Adapter-supplied evidence only. Neither a human identity nor delivery authority. */
export const WorkerHumanInputCapture = z
  .object({
    version: z.literal(1),
    connectionId: z.string().uuid(),
    observationId: id,
    observedAt: z.string().datetime({ offset: true }),
    workerRuntime: id,
    workerId: id,
    turnId: id,
    providerRequestId: z.union([
      id,
      z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    ]),
    questions: z.array(WorkerHumanQuestion).min(1).max(8),
    requestJson: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 16 * 1024),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()
  .superRefine((capture, ctx) => {
    if (
      capture.requestHash !== hashWorkerHumanInput(capture.requestJson) ||
      !capture.observationId.startsWith(`${capture.connectionId}:`) ||
      new Set(capture.questions.map((value) => value.id)).size !== capture.questions.length ||
      Buffer.byteLength(JSON.stringify(capture), "utf8") > 32 * 1024
    )
      ctx.addIssue({ code: "custom", message: "Invalid worker question capture" });
  });
export type WorkerHumanInputCapture = z.infer<typeof WorkerHumanInputCapture>;

export function hashWorkerHumanInput(requestJson: string): string {
  return createHash("sha256").update(requestJson, "utf8").digest("hex");
}
