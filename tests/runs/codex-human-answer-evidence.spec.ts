import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { humanAnswerFixture } from "../store/worker-human-answer-fixture.js";
import {
  CodexHumanAnswerOutputEvidence,
  recordRetainedCodexHumanAnswerOutput,
} from "../../src/runs/codex-human-answer-evidence.js";
import { ProtectedEvidenceCaptureSession } from "../../src/runs/governed-attempt-evidence.js";
import type { ProtectedEvidenceIndependentReader } from "../../src/runs/governed-attempt-verification.js";
import { LocalProtectedEvidenceStore } from "../../src/store/local-protected-evidence-store.js";
import { LocalProtectedEvidenceVerifier } from "../../src/store/local-protected-evidence-verifier.js";
import type { ProtectedEvidenceFrameClass } from "../../src/store/protected-evidence-store.js";
import { WorkerHumanAnswerObservation } from "../../src/schemas/worker-human-answer.js";
import { hashWorkerHumanInput } from "../../src/schemas/worker-human-input.js";
import { computeCanonicalHash } from "../../src/schemas/task-contract.js";
import { humanActionSummary } from "../../src/runs/agent-work-human-action-service.js";
import { canonicalJSONStringify } from "../../src/util/canonicalJson.js";

type Fixture = Awaited<ReturnType<typeof humanAnswerFixture>>;
type OutputEvidence = ReturnType<typeof CodexHumanAnswerOutputEvidence.parse>;
const fixtures: Fixture[] = [];
const OTHER_HASH = "sha256:" + "f".repeat(64);

afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup();
});

async function prepared(
  kind: "memory" | "sqlite" = "memory",
  disposition: "written" | "not_sent" | "uncertain" = "written"
) {
  const f = await humanAnswerFixture(kind);
  fixtures.push(f);
  f.session.workerRuntime = "codex-native";
  f.session.workerId = "thread";
  const nativeRequest = {
    id: 7,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId: "question-call",
      questions: [
        {
          id: "choice",
          header: "Candidate",
          question: "Which candidate?",
          isOther: false,
          options: [
            { label: "A", description: "Candidate A" },
            { label: "B", description: "Candidate B" },
          ],
        },
      ],
    },
  };
  const capture = {
    ...f.capture(),
    requestJson: JSON.stringify(nativeRequest),
    providerRequestId: 7,
  };
  capture.requestHash = hashWorkerHumanInput(capture.requestJson);
  const requestId = await f.record(capture);
  const answer = f.signed(await f.challenge(requestId));
  expect(
    await f.service.admitWorkerAnswer({ ...(await f.mutation("answer")), answer })
  ).toMatchObject({ ok: true });
  const claimId = randomUUID();
  expect(
    await f.service.claimWorkerAnswerDelivery({
      ...(await f.mutation("claim")),
      requestId,
      claimId,
    })
  ).toMatchObject({ ok: true, newlyClaimed: true });
  expect(
    await f.service.recordWorkerAnswerWrite({
      ...(await f.mutation("write")),
      requestId,
      claimId,
      disposition,
    })
  ).toMatchObject({ ok: true });

  // Literal native output, independent of the owned adapter's projection.
  const evidence: OutputEvidence = {
    version: 1,
    domain: "lexrunner.codex-human-answer-output-evidence/v1",
    observationId: "retained-answer-output-1",
    runId: "run",
    requestId,
    claimId,
    captureHash: computeCanonicalHash(capture),
    answerHash: computeCanonicalHash(answer),
    observedAt: f.time,
    output: {
      type: "function_call_output",
      call_id: "question-call",
      output: '{"answers":{"choice":{"answers":["A"]}}}',
    },
  };
  return { f, requestId, evidence, capture, answer, claimId };
}

type Prepared = Awaited<ReturnType<typeof prepared>>;

async function retained(
  p: Prepared,
  options: {
    bytes?: Uint8Array;
    frameClass?: ProtectedEvidenceFrameClass;
    observedAt?: string;
    incomplete?: boolean;
  } = {}
) {
  const captureId = randomUUID();
  const root = join(p.f.root, "retained-" + captureId);
  await mkdir(root);
  // Synthetic attestation and directory-sync dependencies exercise artifact
  // integrity; they make no production ACL, host-origin, or human-presence claim.
  const store = new LocalProtectedEvidenceStore(root, {
    attestRoot: async () => true,
    syncDirectory: async () => undefined,
    now: () => p.f.time,
  });
  const session = await ProtectedEvidenceCaptureSession.open({
    store,
    reservation: {
      capture_id: captureId,
      attempt_id: "attempt",
      delegation_id: "answer-reconciliation",
      authorization_binding_digest: OTHER_HASH,
      executor_binding_digest: OTHER_HASH,
      environment_binding_digest: OTHER_HASH,
      workspace_binding_digest: OTHER_HASH,
      reserved_bytes: 256 * 1024,
      reserved_frames: 10,
      reserved_events: 10,
      max_duration_ms: 60000,
    },
    openedAt: p.f.time,
  });
  // The pointer must select the control frame, not the first plausible body.
  await session.append({
    frameClass: "executor_stdout",
    bytes: Buffer.from('{"type":"unrelated-event"}\n'),
    observedAt: p.f.time,
  });
  const frame = await session.append({
    frameClass: options.frameClass ?? "control_evidence",
    bytes: options.bytes ?? Buffer.from(canonicalJSONStringify(p.evidence), "utf8"),
    observedAt: options.observedAt ?? p.evidence.observedAt,
  });
  const reference = options.incomplete
    ? await session.markIncomplete({ reasonCode: "cancelled", terminalAt: p.f.time })
    : await session.sealAndVerify({ sealedAt: p.f.time, indexedAt: p.f.time });
  const sourceEvidence = {
    captureId,
    captureRoot: reference.capture_root ?? OTHER_HASH,
    frameSequence: frame.sequence,
    frameHash: frame.evidenceRef,
  };
  const verifier = new LocalProtectedEvidenceVerifier(root, { attestRoot: async () => true });
  const input = {
    ...(await p.f.mutation("retained-output")),
    requestId: p.requestId,
    sourceEvidence,
  };
  return { root, reference, sourceEvidence, verifier, input };
}

function observationPort(f: Fixture) {
  return {
    getWorkerAnswer: f.service.getWorkerAnswer.bind(f.service),
    inspectWorkerAnswerDelivery: f.service.inspectWorkerAnswerDelivery.bind(f.service),
    recordWorkerAnswerObservation: vi.fn(f.service.recordWorkerAnswerObservation.bind(f.service)),
  };
}

async function expectUnchanged(p: Prepared, revision: number) {
  expect((await p.f.store.getRunCoordination("run"))!.revision).toBe(revision);
  expect(await p.f.service.inspectWorkerAnswerDelivery("run", p.requestId)).toMatchObject({
    holdPending: true,
    observations: [],
    consumptionQualified: false,
    resendAllowed: false,
  });
}

async function expectSourceRefusal(
  p: Prepared,
  r: Awaited<ReturnType<typeof retained>>,
  reader: ProtectedEvidenceIndependentReader = r.verifier,
  input = r.input
) {
  const revision = (await p.f.store.getRunCoordination("run"))!.revision;
  const port = observationPort(p.f);
  expect(await recordRetainedCodexHumanAnswerOutput(port, reader, input)).toMatchObject({
    ok: false,
  });
  expect(port.recordWorkerAnswerObservation).not.toHaveBeenCalled();
  await expectUnchanged(p, revision);
}

describe.each(["memory", "sqlite"] as const)("retained Codex answer output (%s)", (kind) => {
  it("freshly verifies the selected sealed frame, retains only its pointer and keeps the hold", async () => {
    const p = await prepared(kind);
    const r = await retained(p);
    const reader = {
      readVerifiedCapture: vi.fn(r.verifier.readVerifiedCapture.bind(r.verifier)),
    };
    const result = await recordRetainedCodexHumanAnswerOutput(p.f.service, reader, r.input);
    expect(result).toMatchObject({
      ok: true,
      replay: false,
      contentMatched: true,
      sourceEvidenceVerified: true,
      sourceAuthenticated: false,
      consumptionQualified: false,
      resendAllowed: false,
    });
    expect(reader.readVerifiedCapture).toHaveBeenCalledExactlyOnceWith(r.sourceEvidence.captureId);
    expect(await recordRetainedCodexHumanAnswerOutput(p.f.service, reader, r.input)).toMatchObject({
      ok: true,
      replay: true,
      sourceEvidenceVerified: true,
    });
    expect(reader.readVerifiedCapture).toHaveBeenCalledTimes(2);
    if (kind === "sqlite") await p.f.reopen();
    const report = await p.f.service.inspectWorkerAnswerDelivery("run", p.requestId);
    expect(report).toMatchObject({
      holdPending: true,
      delivery: { disposition: "written" },
      observations: [
        {
          kind: "matching_answer_output",
          observationId: p.evidence.observationId,
          sourceEvidence: r.sourceEvidence,
        },
      ],
      consumptionQualified: false,
      resendAllowed: false,
    });
    expect(report!.observations).toHaveLength(1);
    const compact = JSON.stringify({ result, observations: report!.observations });
    expect(compact).not.toContain('"answers"');
    expect(compact).not.toContain('"signature"');
    expect(compact).not.toContain('"bytes"');
    expect(compact).not.toContain('"output"');
    expect(compact).not.toContain(p.answer.signature);
    expect(compact).not.toContain(r.root);
    expect(
      humanActionSummary((await p.f.store.getRunCoordination("run"))!.state, p.f.time)
    ).toHaveLength(1);
  });

  it("recovers an exact replay after the journal commits but its acknowledgement is lost", async () => {
    const p = await prepared(kind);
    const r = await retained(p);
    const port = observationPort(p.f);
    port.recordWorkerAnswerObservation.mockImplementation(async (...args) => {
      await p.f.service.recordWorkerAnswerObservation(...args);
      throw new Error("lost acknowledgement");
    });
    await expect(recordRetainedCodexHumanAnswerOutput(port, r.verifier, r.input)).rejects.toThrow(
      "lost acknowledgement"
    );
    if (kind === "sqlite") await p.f.reopen();
    expect(
      await recordRetainedCodexHumanAnswerOutput(p.f.service, r.verifier, r.input)
    ).toMatchObject({ ok: true, replay: true, consumptionQualified: false, resendAllowed: false });
    const report = await p.f.service.inspectWorkerAnswerDelivery("run", p.requestId);
    expect(report!.observations).toHaveLength(1);
    expect(report!.observations[0]).toMatchObject({ sourceEvidence: r.sourceEvidence });
    expect(report!.holdPending).toBe(true);
  });

  it("re-verifies the artifact before an otherwise exact journal replay", async () => {
    const p = await prepared(kind);
    const r = await retained(p);
    expect(
      await recordRetainedCodexHumanAnswerOutput(p.f.service, r.verifier, r.input)
    ).toMatchObject({ ok: true });
    const revision = (await p.f.store.getRunCoordination("run"))!.revision;
    const file = join(
      r.root,
      "captures",
      r.reference.store_key.replace("pe:", "pe-"),
      "00000002.frame"
    );
    const bytes = await readFile(file);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    await writeFile(file, bytes);
    const port = observationPort(p.f);
    expect(await recordRetainedCodexHumanAnswerOutput(port, r.verifier, r.input)).toMatchObject({
      ok: false,
    });
    expect(port.recordWorkerAnswerObservation).not.toHaveBeenCalled();
    expect((await p.f.store.getRunCoordination("run"))!.revision).toBe(revision);
    const report = await p.f.service.inspectWorkerAnswerDelivery("run", p.requestId);
    expect(report!.observations).toHaveLength(1);
    expect(report!.observations[0]).toMatchObject({ sourceEvidence: r.sourceEvidence });
    expect(report!.holdPending).toBe(true);
  });

  it("rejects a different retained source for an already recorded observation", async () => {
    const p = await prepared(kind);
    const first = await retained(p);
    expect(
      await recordRetainedCodexHumanAnswerOutput(p.f.service, first.verifier, first.input)
    ).toMatchObject({ ok: true });
    const second = await retained(p);
    const revision = (await p.f.store.getRunCoordination("run"))!.revision;
    expect(
      await recordRetainedCodexHumanAnswerOutput(p.f.service, second.verifier, second.input)
    ).toMatchObject({ ok: false });
    expect((await p.f.store.getRunCoordination("run"))!.revision).toBe(revision);
    const report = await p.f.service.inspectWorkerAnswerDelivery("run", p.requestId);
    expect(report!.observations).toHaveLength(1);
    expect(report!.observations[0]).toMatchObject({ sourceEvidence: first.sourceEvidence });
    expect(report!.holdPending).toBe(true);
  });
  it.each(["not_sent", "uncertain"] as const)(
    "preserves the %s disposition without worker-consumption authority",
    async (disposition) => {
      const p = await prepared(kind, disposition);
      const r = await retained(p);
      const revision = (await p.f.store.getRunCoordination("run"))!.revision;
      const result = await recordRetainedCodexHumanAnswerOutput(p.f.service, r.verifier, r.input);
      expect(result).toMatchObject(
        disposition === "not_sent"
          ? { ok: false }
          : { ok: true, sourceEvidenceVerified: true, consumptionQualified: false }
      );
      const report = await p.f.service.inspectWorkerAnswerDelivery("run", p.requestId);
      expect(report).toMatchObject({
        holdPending: true,
        delivery: { disposition },
        consumptionQualified: false,
        resendAllowed: false,
      });
      if (disposition === "not_sent") await expectUnchanged(p, revision);
    }
  );

  it("snapshots the caller's pointer and mutation binding before the verifier awaits", async () => {
    const p = await prepared(kind);
    const r = await retained(p);
    const input = structuredClone(r.input);
    const original = structuredClone(input);
    const reader: ProtectedEvidenceIndependentReader = {
      async readVerifiedCapture(captureId) {
        const verified = await r.verifier.readVerifiedCapture(captureId);
        input.requestId = "changed";
        input.controller.runId = "changed";
        input.sourceEvidence.captureId = "changed";
        input.sourceEvidence.captureRoot = OTHER_HASH;
        input.sourceEvidence.frameSequence = 1;
        input.sourceEvidence.frameHash = OTHER_HASH;
        return verified;
      },
    };
    expect(await recordRetainedCodexHumanAnswerOutput(p.f.service, reader, input)).toMatchObject({
      ok: true,
    });
    const report = await p.f.service.inspectWorkerAnswerDelivery("run", p.requestId);
    expect(report!.observations[0]).toMatchObject({
      requestId: original.requestId,
      sourceEvidence: original.sourceEvidence,
    });
  });

  it("propagates stale revision refusal without retaining evidence", async () => {
    const p = await prepared(kind);
    const r = await retained(p);
    const revision = (await p.f.store.getRunCoordination("run"))!.revision;
    expect(
      await recordRetainedCodexHumanAnswerOutput(p.f.service, r.verifier, {
        ...r.input,
        expectedRunRevision: revision - 1,
      })
    ).toMatchObject({ ok: false });
    await expectUnchanged(p, revision);
  });
});

describe("retained source qualification", () => {
  it.each(["tampered", "missing", "untrusted", "incomplete", "expired"] as const)(
    "refuses %s retained evidence without mutation",
    async (failure) => {
      const p = await prepared();
      const r = await retained(p, { incomplete: failure === "incomplete" });
      let reader: ProtectedEvidenceIndependentReader = r.verifier;
      let input = r.input;
      if (failure === "tampered") {
        const file = join(
          r.root,
          "captures",
          r.reference.store_key.replace("pe:", "pe-"),
          "00000002.frame"
        );
        const bytes = await readFile(file);
        bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
        await writeFile(file, bytes);
      } else if (failure === "missing") {
        input = { ...r.input, sourceEvidence: { ...r.sourceEvidence, captureId: "absent" } };
      } else if (failure === "untrusted") {
        reader = new LocalProtectedEvidenceVerifier(r.root, { attestRoot: async () => false });
      } else if (failure === "expired") {
        input = { ...r.input, now: r.reference.retention_expires_at };
      }
      await expectSourceRefusal(p, r, reader, input);
    }
  );

  it.each(["captureRoot", "frameHash", "frameSequence"] as const)(
    "refuses a mismatched pointer %s",
    async (field) => {
      const p = await prepared();
      const r = await retained(p);
      const sourceEvidence = {
        ...r.sourceEvidence,
        [field]: field === "frameSequence" ? 1 : OTHER_HASH,
      };
      await expectSourceRefusal(p, r, r.verifier, { ...r.input, sourceEvidence });
    }
  );

  it.each([
    "capture_id",
    "capture_root",
    "missing-frame",
    "duplicate-frame",
    "wrong-class",
    "frame-time",
  ] as const)("refuses reader binding mismatch %s", async (field) => {
    const p = await prepared();
    const r = await retained(p);
    const reader: ProtectedEvidenceIndependentReader = {
      async readVerifiedCapture(captureId) {
        const verified = structuredClone(await r.verifier.readVerifiedCapture(captureId));
        if (field === "capture_id") verified.reference.capture_id = "different-capture";
        else if (field === "capture_root") verified.reference.capture_root = OTHER_HASH;
        else if (field === "missing-frame")
          verified.frames = verified.frames.filter((frame) => frame.sequence !== 2);
        else if (field === "duplicate-frame")
          verified.frames = [...verified.frames, structuredClone(verified.frames[1]!)];
        else if (field === "wrong-class") verified.frames[1]!.frameClass = "executor_stdout";
        else verified.frames[1]!.observedAt = "2026-10-07T00:00:00.001Z";
        return verified;
      },
    };
    await expectSourceRefusal(p, r, reader);
  });

  it.each([
    "runId",
    "requestId",
    "claimId",
    "captureHash",
    "answerHash",
    "call_id",
    "answer-body",
  ] as const)("refuses a sealed but inapplicable %s", async (field) => {
    const p = await prepared();
    const evidence = structuredClone(p.evidence);
    if (field === "claimId") evidence.claimId = randomUUID();
    else if (field === "captureHash" || field === "answerHash") evidence[field] = OTHER_HASH;
    else if (field === "call_id") evidence.output.call_id = "different-call";
    else if (field === "answer-body")
      evidence.output.output = '{"answers":{"choice":{"answers":["B"]}}}';
    else evidence[field] = "different";
    const r = await retained(p, { bytes: Buffer.from(canonicalJSONStringify(evidence)) });
    await expectSourceRefusal(p, r);
  });

  it("accepts matching absolute instants expressed with different offsets", async () => {
    const p = await prepared();
    const evidence = { ...p.evidence, observedAt: "2026-10-06T20:00:00.000-04:00" };
    const r = await retained(p, { bytes: Buffer.from(canonicalJSONStringify(evidence)) });
    expect(
      await recordRetainedCodexHumanAnswerOutput(p.f.service, r.verifier, r.input)
    ).toMatchObject({ ok: true, sourceAuthenticated: false, consumptionQualified: false });
  });
});

describe("strict retained answer-output bytes", () => {
  it.each([
    "duplicate-key",
    "extra-field",
    "extra-output-field",
    "noncanonical",
    "invalid-utf8",
    "oversized-frame",
    "oversized-output",
    "escaped-oversized-envelope",
  ] as const)("refuses %s in a correctly sealed artifact", async (failure) => {
    const p = await prepared();
    const canonical = canonicalJSONStringify(p.evidence);
    let bytes: Uint8Array = Buffer.from(canonical);
    if (failure === "duplicate-key") {
      bytes = Buffer.from(canonical.replace('"version": 1', '"version": 0,\n  "version": 1'));
    } else if (failure === "extra-field") {
      bytes = Buffer.from(canonicalJSONStringify({ ...p.evidence, trusted: true }));
    } else if (failure === "extra-output-field") {
      bytes = Buffer.from(
        canonicalJSONStringify({
          ...p.evidence,
          output: { ...p.evidence.output, consumed: true },
        })
      );
    } else if (failure === "noncanonical") bytes = Buffer.from(JSON.stringify(p.evidence));
    else if (failure === "invalid-utf8") {
      bytes = Buffer.from(canonical);
      bytes[canonical.indexOf("retained-answer-output-1")] = 0xff;
    } else if (failure === "oversized-frame") {
      bytes = Buffer.from(canonical + " ".repeat(32769));
    } else {
      bytes = Buffer.from(
        canonicalJSONStringify({
          ...p.evidence,
          output: {
            ...p.evidence.output,
            output:
              failure === "escaped-oversized-envelope" ? "\u0000".repeat(6000) : "é".repeat(8193),
          },
        })
      );
    }
    const r = await retained(p, { bytes });
    await expectSourceRefusal(p, r);
  });

  it("rejects invalid pointer schemas before a verifier read", async () => {
    const p = await prepared();
    const r = await retained(p);
    const reader = { readVerifiedCapture: vi.fn(r.verifier.readVerifiedCapture.bind(r.verifier)) };
    for (const sourceEvidence of [
      { ...r.sourceEvidence, frameSequence: 0 },
      { ...r.sourceEvidence, frameSequence: 65537 },
      { ...r.sourceEvidence, frameSequence: 1.5 },
      { ...r.sourceEvidence, frameHash: "unhashed" },
      { ...r.sourceEvidence, captureRoot: "unhashed" },
      { ...r.sourceEvidence, trusted: true },
    ]) {
      await expectSourceRefusal(p, r, reader, { ...r.input, sourceEvidence });
    }
    expect(reader.readVerifiedCapture).not.toHaveBeenCalled();
  });

  it("allows the retained pointer only on matching-answer-output observations", async () => {
    const p = await prepared();
    const r = await retained(p);
    const observation = {
      version: 1,
      domain: "lexrunner.worker-answer-observation/v1",
      observationId: p.evidence.observationId,
      runId: "run",
      requestId: p.requestId,
      claimId: p.claimId,
      captureHash: p.evidence.captureHash,
      answerHash: p.evidence.answerHash,
      evidenceHash: computeCanonicalHash(p.evidence.output),
      kind: "matching_answer_output",
      observedAt: p.f.time,
      sourceEvidence: r.sourceEvidence,
    };
    expect(WorkerHumanAnswerObservation.safeParse(observation).success).toBe(true);
    for (const kind of ["request_cleared", "delivery_uncertain"])
      expect(WorkerHumanAnswerObservation.safeParse({ ...observation, kind }).success).toBe(false);
  });

  it("does not accept caller-supplied source bytes as a replacement for a pointer", async () => {
    const p = await prepared();
    const r = await retained(p);
    const reader = { readVerifiedCapture: vi.fn(r.verifier.readVerifiedCapture.bind(r.verifier)) };
    const input = { ...r.input, sourceEvidence: { ...r.sourceEvidence, bytes: p.evidence } };
    await expectSourceRefusal(p, r, reader, input);
    expect(reader.readVerifiedCapture).not.toHaveBeenCalled();
  });
});
