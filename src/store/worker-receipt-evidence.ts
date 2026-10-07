import { z } from "zod";
import { computeCanonicalHash } from "../schemas/task-contract.js";
import { WorkerObservationInput_v1 } from "./worker-observation-store.js";
import type { WorkerDispatchRecord } from "./worker-dispatch-store.js";
import type { WorkerEvidenceSnapshot } from "./worker-evidence-snapshot.js";
import {
  MAX_TURN_EVIDENCE_BYTES,
  MAX_SESSION_EVIDENCE_BYTES,
  turnEvidenceHash,
} from "./worker-turn-evidence.js";

export const FinalAgentMessage = z
  .object({
    method: z.literal("item/completed"),
    emittedAtMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    params: z
      .object({
        threadId: z.string().min(1),
        turnId: z.string().min(1),
        item: z
          .object({
            type: z.literal("agentMessage"),
            id: z.string().min(1),
            phase: z.literal("final_answer"),
            text: z.string(),
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
  .extend({ notificationJson: z.string().max(MAX_TURN_EVIDENCE_BYTES) })
  .strict();
export type WorkerReceiptCapture = z.infer<typeof Capture>;
export interface WorkerReceiptEvidence extends WorkerReceiptCapture {
  recordedAt: string;
  sourceHash: string;
  recordHash: string;
  attemptId: string;
  runId: string;
  packetHash: string;
  envelopeHash: string;
}
export type WorkerReceiptCaptureResult =
  | { recorded: true; replay: boolean; record: WorkerReceiptEvidence }
  | { recorded: false; reason: string };
export interface WorkerReceiptSnapshot {
  turn: WorkerEvidenceSnapshot;
  receipts: WorkerReceiptEvidence[];
}
export interface WorkerReceiptEvidenceStore {
  recordWorkerReceiptEvidence(
    input: WorkerReceiptCapture,
    recordedAt: string
  ): Promise<WorkerReceiptCaptureResult>;
  getWorkerReceiptSnapshot(sessionId: string): Promise<WorkerReceiptSnapshot | null>;
}

export function reduceWorkerReceiptEvidence(
  input: WorkerReceiptCapture,
  recordedAt: string,
  dispatch: WorkerDispatchRecord | null,
  prior: WorkerReceiptEvidence[]
): WorkerReceiptCaptureResult {
  const parsed = Capture.safeParse(input);
  if (!parsed.success) return { recorded: false, reason: "invalid_receipt_capture" };
  input = parsed.data;
  if (Buffer.byteLength(input.notificationJson, "utf8") > MAX_TURN_EVIDENCE_BYTES)
    return { recorded: false, reason: "evidence_limit" };
  let event;
  try {
    event = FinalAgentMessage.parse(JSON.parse(input.notificationJson));
  } catch {
    return { recorded: false, reason: "invalid_receipt_event" };
  }
  if (
    !dispatch ||
    ["sessionId", "claimId", "requestHash", "workerId"].some(
      (key) =>
        input[key as keyof WorkerReceiptCapture] !== dispatch[key as keyof WorkerDispatchRecord]
    ) ||
    event.params.threadId !== dispatch.workerId
  )
    return { recorded: false, reason: "receipt_binding_mismatch" };
  if (
    !Number.isFinite(Date.parse(recordedAt)) ||
    Date.parse(recordedAt) < Date.parse(input.observedAt) ||
    Date.parse(input.observedAt) < Date.parse(dispatch.claimedAt)
  )
    return { recorded: false, reason: "invalid_time" };
  const existing = prior.find((record) => record.observationId === input.observationId);
  if (existing) {
    const { recordHash: expected, ...body } = existing;
    if (
      computeCanonicalHash(body) !== expected ||
      turnEvidenceHash(existing.notificationJson) !== existing.sourceHash
    )
      throw new Error("receipt_provenance_mismatch");
    const {
      recordedAt: _,
      sourceHash: _s,
      recordHash: _r,
      attemptId: _a,
      runId: _run,
      packetHash: _p,
      envelopeHash: _e,
      ...original
    } = existing;
    return computeCanonicalHash(original) === computeCanonicalHash(input)
      ? { recorded: true, replay: true, record: structuredClone(existing) }
      : { recorded: false, reason: "receipt_capture_conflict" };
  }
  if (
    prior.length >= 128 ||
    prior.reduce((n, r) => n + Buffer.byteLength(r.notificationJson, "utf8"), 0) +
      Buffer.byteLength(input.notificationJson, "utf8") >
      MAX_SESSION_EVIDENCE_BYTES
  )
    return { recorded: false, reason: "evidence_limit" };
  const record = {
    ...input,
    recordedAt,
    sourceHash: turnEvidenceHash(input.notificationJson),
    attemptId: dispatch.attemptId,
    runId: dispatch.runId,
    packetHash: dispatch.packetHash,
    envelopeHash: dispatch.envelopeHash,
  };
  return {
    recorded: true,
    replay: false,
    record: { ...record, recordHash: computeCanonicalHash(record) },
  };
}
