import { z } from "zod";
import { WorkerHumanAnswerChallenge } from "./worker-human-answer.js";

/** A display claim, not proof of display, human input, consumption or permission. */
export const WorkerHumanPresentation = z
  .object({
    presentationId: z.string().uuid(),
    previousPresentationId: z.string().uuid().optional(),
    challenge: WorkerHumanAnswerChallenge,
    disposition: z.enum(["active", "declined", "cancelled", "expired", "failed", "answered"]),
    closedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .refine(
    ({ disposition, closedAt, challenge }) =>
      disposition === "active"
        ? closedAt === undefined
        : closedAt !== undefined &&
          Date.parse(closedAt) >= Date.parse(challenge.issuedAt) &&
          (disposition !== "expired" || Date.parse(closedAt) >= Date.parse(challenge.expiresAt)) &&
          (disposition !== "answered" || Date.parse(closedAt) < Date.parse(challenge.expiresAt)),
    "Invalid presentation observation time"
  );
export type WorkerHumanPresentation = z.infer<typeof WorkerHumanPresentation>;

/** Retain every presentation; capacity refuses new displays rather than evicting history. */
export const WorkerHumanPresentationHistory = z
  .array(WorkerHumanPresentation)
  .min(1)
  .max(16)
  .superRefine((history, ctx) => {
    const invalid =
      new Set(history.map((entry) => entry.presentationId)).size !== history.length ||
      new Set(history.map((entry) => entry.challenge.challengeId)).size !== history.length ||
      history.some((entry, index) => {
        const previous = history[index - 1];
        return previous
          ? entry.previousPresentationId !== previous.presentationId ||
              previous.disposition === "active" ||
              previous.disposition === "answered" ||
              entry.challenge.generation !== previous.challenge.generation + 1 ||
              entry.challenge.bindingHash !== previous.challenge.bindingHash ||
              entry.challenge.runId !== previous.challenge.runId ||
              entry.challenge.requestId !== previous.challenge.requestId ||
              Date.parse(entry.challenge.issuedAt) < Date.parse(previous.closedAt!)
          : entry.previousPresentationId !== undefined || entry.challenge.generation !== 1;
      });
    if (invalid) ctx.addIssue({ code: "custom", message: "Invalid presentation history" });
  });
