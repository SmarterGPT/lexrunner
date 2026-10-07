import { createHash } from "node:crypto";
import { z } from "zod";
import {
  WorkerObservationInput_v1,
  type WorkerObservationResult,
} from "./worker-observation-store.js";

export const MAX_TURN_EVIDENCE_BYTES = 1024 * 1024;
export const MAX_SESSION_EVIDENCE_BYTES = 8 * MAX_TURN_EVIDENCE_BYTES;
export const TerminalTurnNotification = z
  .object({
    method: z.literal("turn/completed"),
    // Native notification timing is diagnostic data, not our observation clock.
    emittedAtMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    params: z
      .object({
        threadId: z.string().min(1),
        turn: z
          .object({
            id: z.string().min(1),
            status: z.enum(["completed", "failed", "interrupted"]),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .strict();
const Capture = WorkerObservationInput_v1.pick({
  sessionId: true,
  claimId: true,
  requestHash: true,
  workerId: true,
  observationId: true,
  observerId: true,
  observedAt: true,
})
  .extend({
    notificationJson: z.string().max(MAX_TURN_EVIDENCE_BYTES),
  })
  .strict();
export type WorkerTurnCaptureInput = z.infer<typeof Capture>;
export type WorkerTurnCaptureResult =
  WorkerObservationResult | { recorded: false; reason: "evidence_limit" };
export interface WorkerTurnEvidenceStore {
  recordWorkerTurnEvidence(
    input: WorkerTurnCaptureInput,
    recordedAt: string
  ): Promise<WorkerTurnCaptureResult>;
  getWorkerTurnEvidence(sessionId: string, observationId: string): Promise<string | null>;
}
export function parseTurnEvidence(input: WorkerTurnCaptureInput) {
  const { notificationJson, ...binding } = Capture.parse(input);
  const bytes = Buffer.byteLength(notificationJson, "utf8");
  if (bytes > MAX_TURN_EVIDENCE_BYTES) throw new Error("turn_evidence_limit");
  const event = TerminalTurnNotification.parse(JSON.parse(notificationJson));
  if (event.params.threadId !== binding.workerId) throw new Error("thread_mismatch");
  return {
    notificationJson,
    bytes,
    observation: {
      ...binding,
      turnId: event.params.turn.id,
      kind: event.params.turn.status,
      evidenceHash: turnEvidenceHash(notificationJson),
      summary: `Codex reported ${event.params.turn.status}; verification pending.`,
    },
  };
}
export function turnEvidenceHash(value: string) {
  return "sha256:" + createHash("sha256").update(value, "utf8").digest("hex");
}
