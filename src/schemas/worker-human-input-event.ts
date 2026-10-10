import { createHash } from "node:crypto";
import { z } from "zod";
import { SHA256Hash } from "./task-contract.js";
import { WorkerHumanInputCapture } from "./worker-human-input.js";
import { WorkerHumanPresentation } from "./worker-human-presentation.js";
import { canonicalJSONStringify } from "../util/canonicalJson.js";

const instant = z.string().datetime({ offset: true });
const id = z.string().min(1).max(512);

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

/** Supplied observation pins, never authenticated origin, protected loading or human presence. */
export const WorkerHumanInputSource = z
  .object({
    hostSessionId: z.string().uuid(),
    /** Human-form connection, distinct from the captured worker connection. */
    connectionId: z.string().uuid(),
    profileId: id,
    profileHash: SHA256Hash,
    runtimeHash: SHA256Hash,
  })
  .strict();
export type WorkerHumanInputSource = z.infer<typeof WorkerHumanInputSource>;

/** Non-authorizing exact protocol observation; preserves authored response bytes. */
export const WorkerHumanInputEvent = z
  .object({
    version: z.literal(1),
    eventId: z.string().uuid(),
    source: WorkerHumanInputSource,
    input: WorkerHumanAdmissionInput,
  })
  .strict()
  .superRefine((event, ctx) => {
    const { presentation, capture, answers, observedAt } = event.input;
    const observed = Date.parse(observedAt);
    if (
      presentation.disposition !== "active" ||
      presentation.challenge.requestId !== `worker-input:${capture.observationId}` ||
      observed < Date.parse(capture.observedAt) ||
      observed < Date.parse(presentation.challenge.issuedAt) ||
      observed >= Date.parse(presentation.challenge.expiresAt) ||
      new Set(answers.map((v) => v.questionId)).size !== answers.length ||
      answers.length !== capture.questions.length ||
      !capture.questions.every((q) => {
        const a = answers.find((v) => v.questionId === q.id);
        return (
          a && (q.options === null || q.allowOther || q.options.some((o) => o.label === a.value))
        );
      }) ||
      Buffer.byteLength(JSON.stringify(event), "utf8") > 64 * 1024
    )
      ctx.addIssue({ code: "custom", message: "Invalid input-event binding or size" });
  });
export type WorkerHumanInputEvent = z.infer<typeof WorkerHumanInputEvent>;

export function hashWorkerHumanInputEvent(event: WorkerHumanInputEvent): string {
  return `sha256:${createHash("sha256")
    .update("lexrunner.worker-human-input-event/v1\n", "utf8")
    .update(canonicalJSONStringify(WorkerHumanInputEvent.parse(event)), "utf8")
    .digest("hex")}`;
}

export const WorkerHumanInputEventRecord = z
  .object({
    event: WorkerHumanInputEvent,
    eventHash: SHA256Hash,
    recordedAt: instant,
    /** One-time local processing reservation, NOT authenticated event consumption. */
    reservation: z
      .object({ reservationId: z.string().uuid(), reservedAt: instant })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (record) =>
      record.eventHash === hashWorkerHumanInputEvent(record.event) &&
      Date.parse(record.recordedAt) >= Date.parse(record.event.input.observedAt) &&
      Date.parse(record.recordedAt) <
        Date.parse(record.event.input.presentation.challenge.expiresAt) &&
      (!record.reservation ||
        (Date.parse(record.reservation.reservedAt) >= Date.parse(record.recordedAt) &&
          Date.parse(record.reservation.reservedAt) <
            Date.parse(record.event.input.presentation.challenge.expiresAt))),
    "Invalid retained input-event hash or time"
  );
export type WorkerHumanInputEventRecord = z.infer<typeof WorkerHumanInputEventRecord>;
