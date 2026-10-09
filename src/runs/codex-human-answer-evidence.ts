import { z } from "zod";
import { SHA256Hash } from "../schemas/task-contract.js";
import { WorkerHumanAnswerSourceEvidence } from "../schemas/worker-human-answer.js";
import { ProtectedEvidenceReference_v1 } from "../store/protected-evidence-store.js";
import { canonicalJSONStringify } from "../util/canonicalJson.js";
import type { ProtectedEvidenceIndependentReader } from "./governed-attempt-verification.js";
import {
  CodexHumanAnswerOutput,
  recordCodexHumanAnswerOutput,
} from "./codex-human-answer-output.js";

const id = z.string().min(1).max(512);
const MAX_FRAME_BYTES = 32 * 1024;

/** Retain this canonical envelope with the existing write-only evidence capture. */
export const CodexHumanAnswerOutputEvidence = z
  .object({
    version: z.literal(1),
    domain: z.literal("lexrunner.codex-human-answer-output-evidence/v1"),
    observationId: id,
    runId: id,
    requestId: id,
    claimId: z.string().uuid(),
    captureHash: SHA256Hash,
    answerHash: SHA256Hash,
    observedAt: z.string().datetime({ offset: true }),
    output: CodexHumanAnswerOutput,
    // Selected-item projection observed at HTTP ingress, not sender authentication
    // or full raw-request retention. The request digest alone cannot replay it.
    providerRequest: z
      .object({
        observerId: z.string().uuid(),
        requestSequence: z.number().int().min(1).max(128),
        requestHash: SHA256Hash,
        requestBytes: z
          .number()
          .int()
          .min(1)
          .max(1024 * 1024),
        method: z.literal("POST"),
        path: z.literal("/v1/responses"),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => Buffer.byteLength(canonicalJSONStringify(value), "utf8") <= MAX_FRAME_BYTES);

type RecordInput = Parameters<typeof recordCodexHumanAnswerOutput>[1];
const Selector = z
  .object({
    requestId: id,
    now: z.string().datetime({ offset: true }),
    sourceEvidence: WorkerHumanAnswerSourceEvidence,
  })
  .strict();

/**
 * Fresh integrity read before journal mutation. The injected reader is host-owned;
 * a sealed artifact does not authenticate its producer or certify consumption.
 */
export async function recordRetainedCodexHumanAnswerOutput(
  service: Parameters<typeof recordCodexHumanAnswerOutput>[0],
  reader: ProtectedEvidenceIndependentReader,
  input: Omit<RecordInput, "observationId" | "observedAt" | "output" | "deliveryBinding"> & {
    sourceEvidence: WorkerHumanAnswerSourceEvidence;
  }
) {
  input = structuredClone(input);
  const selected = Selector.safeParse({
    requestId: input.requestId,
    now: input.now,
    sourceEvidence: input.sourceEvidence,
  });
  if (!selected.success) return { ok: false as const, reason: "invalid_answer_source_evidence" };
  const source = selected.data.sourceEvidence;
  let frame;
  try {
    const retained = await reader.readVerifiedCapture(source.captureId);
    const reference = ProtectedEvidenceReference_v1.parse(retained.reference);
    if (
      reference.capture_id !== source.captureId ||
      reference.capture_root !== source.captureRoot ||
      reference.status !== "complete" ||
      Date.parse(reference.retention_expires_at) <= Date.parse(input.now) ||
      Date.parse(reference.indexed_at!) > Date.parse(input.now)
    )
      return { ok: false as const, reason: "answer_source_capture_mismatch" };
    const candidates = retained.frames.filter((value) => value.sequence === source.frameSequence);
    if (
      source.frameSequence > reference.frame_count ||
      candidates.length !== 1 ||
      candidates[0]!.frameClass !== "control_evidence" ||
      candidates[0]!.evidenceRef !== source.frameHash ||
      candidates[0]!.bytes.byteLength > MAX_FRAME_BYTES
    )
      return { ok: false as const, reason: "answer_source_frame_mismatch" };
    const bytes = Buffer.from(candidates[0]!.bytes);
    frame = CodexHumanAnswerOutputEvidence.parse(JSON.parse(bytes.toString("utf8")));
    // Reject duplicate keys, invalid UTF-8 and alternate rendering in the envelope.
    // The nested output string remains exact authored adapter bytes.
    if (
      !bytes.equals(Buffer.from(canonicalJSONStringify(frame), "utf8")) ||
      Date.parse(frame.observedAt) !== Date.parse(candidates[0]!.observedAt)
    )
      return { ok: false as const, reason: "invalid_answer_source_frame" };
  } catch {
    // Reader errors may contain protected paths or source bodies. Keep reports bounded.
    return { ok: false as const, reason: "answer_source_verification_failed" };
  }
  if (frame.runId !== input.controller.runId || frame.requestId !== input.requestId)
    return { ok: false as const, reason: "answer_source_binding_mismatch" };
  const result = await recordCodexHumanAnswerOutput(service, {
    controller: input.controller,
    expectedRunRevision: input.expectedRunRevision,
    mutationId: input.mutationId,
    now: input.now,
    requestId: frame.requestId,
    observationId: frame.observationId,
    observedAt: frame.observedAt,
    output: frame.output,
    sourceEvidence: source,
    deliveryBinding: {
      claimId: frame.claimId,
      captureHash: frame.captureHash,
      answerHash: frame.answerHash,
    },
  });
  return result.ok ? { ...result, sourceEvidenceVerified: true as const } : result;
}
