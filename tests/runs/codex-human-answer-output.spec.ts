import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { humanAnswerFixture } from "../store/worker-human-answer-fixture.js";
import {
  matchCodexHumanAnswerOutput,
  recordCodexHumanAnswerOutput,
} from "../../src/runs/codex-human-answer-output.js";
import { hashWorkerHumanInput } from "../../src/schemas/worker-human-input.js";
import { computeCanonicalHash } from "../../src/schemas/task-contract.js";
import { humanActionSummary } from "../../src/runs/agent-work-human-action-service.js";

const fixtures: Awaited<ReturnType<typeof humanAnswerFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup();
});
async function prepared(
  kind: "memory" | "sqlite" = "memory",
  disposition = "written" as "written" | "not_sent" | "uncertain"
) {
  const f = await humanAnswerFixture(kind);
  fixtures.push(f);
  f.session.workerRuntime = "codex-native";
  f.session.workerId = "thread";
  const frame = {
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
  const capture = { ...f.capture(), requestJson: JSON.stringify(frame), providerRequestId: 7 };
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
  // Native result fixture is literal, independent of the adapter's projection.
  const output = {
    type: "function_call_output" as const,
    call_id: "question-call",
    output: '{"answers":{"choice":{"answers":["A"]}}}',
  };
  const binding = { runId: "run", requestId, capture, answer, output };
  const input = {
    ...(await f.mutation("output")),
    requestId,
    observationId: "provider-observation-1",
    observedAt: f.time,
    output,
  };
  return { f, binding, input, claimId };
}

describe("exact Codex answer output content", () => {
  it("matches an exact result with bounded hashes and no source or action authority", async () => {
    const { binding } = await prepared();
    const match = matchCodexHumanAnswerOutput(binding);
    expect(match).toEqual({
      matched: true,
      runId: "run",
      requestId: binding.requestId,
      captureHash: computeCanonicalHash(binding.capture),
      answerHash: computeCanonicalHash(binding.answer),
      evidenceHash: computeCanonicalHash(binding.output),
      sourceAuthenticated: false,
      consumptionQualified: false,
      resendAllowed: false,
    });
    expect(JSON.stringify(match)).not.toContain('"answers"');
    expect(JSON.stringify(match)).not.toContain('"signature"');
  });
  it.each([
    '{"answers":{"choice":{"answers":["B"]}}}',
    '{"answers":{"choice":{"answers":["A","B"]}}}',
    '{"answers":{"choice":{"answers":["A "]}}}',
    '{"answers":{"choice":{"answers":["B"]},"choice":{"answers":["A"]}}}',
    '{"answers":{"choice":{"answers":["A"]},"extra":{"answers":["A"]}}}',
    '{"answers":{}}',
    '{"answers": {"choice":{"answers":["A"]}}}',
    "not json",
  ])("rejects non-exact body %s", async (output) => {
    const { binding } = await prepared();
    binding.output.output = output;
    expect(matchCodexHumanAnswerOutput(binding)).toEqual({
      matched: false,
      reason: "answer_output_body_mismatch",
    });
  });
  it.each(["different-call", "7"])("rejects %s as an item ID", async (call) => {
    const { binding } = await prepared();
    binding.output.call_id = call;
    expect(matchCodexHumanAnswerOutput(binding)).toMatchObject({
      matched: false,
      reason: "answer_output_call_mismatch",
    });
  });
  it.each(["runId", "requestId"] as const)("rejects a mismatched %s", async (field) => {
    const { binding } = await prepared();
    binding[field] = "other";
    expect(matchCodexHumanAnswerOutput(binding)).toMatchObject({
      matched: false,
      reason: "answer_output_binding_mismatch",
    });
  });
  it.each(["providerRequestId", "workerId", "turnId", "requestHash", "workerRuntime"] as const)(
    "rejects a mismatched capture %s",
    async (field) => {
      const { binding } = await prepared();
      const capture = {
        ...binding.capture,
        [field]: field === "providerRequestId" ? "7" : "other",
      };
      expect(matchCodexHumanAnswerOutput({ ...binding, capture })).toMatchObject({
        matched: false,
        reason: "invalid_answer_output_evidence",
      });
    }
  );
  it("rejects extra source fields, authorizing kinds and oversized output", async () => {
    const { binding } = await prepared();
    for (const output of [
      { ...binding.output, trusted: true },
      { ...binding.output, type: "consumed" },
      { ...binding.output, output: "é".repeat(8193) },
    ])
      expect(matchCodexHumanAnswerOutput({ ...binding, output })).toMatchObject({
        matched: false,
        reason: "invalid_answer_output_evidence",
      });
  });
  it("preserves special IDs and authored Unicode/free-text bytes", async () => {
    const { binding } = await prepared();
    const names = ["__proto__", "constructor", "2"];
    const values = ["  café\n猫  ", "A", "e\u0301"];
    const frame = JSON.parse(binding.capture.requestJson);
    frame.params.questions = names.map((id) => ({
      id,
      header: "Text",
      question: "Enter text",
      options: null,
    }));
    binding.capture.questions = names.map((id) => ({
      id,
      header: "Text",
      question: "Enter text",
      allowOther: false,
      options: null,
    }));
    binding.capture.requestJson = JSON.stringify(frame);
    binding.capture.requestHash = hashWorkerHumanInput(binding.capture.requestJson);
    binding.answer.payload.answers = names.map((questionId, i) => ({
      questionId,
      value: values[i],
    }));
    binding.output.output =
      '{"answers":{"2":{"answers":["é"]},"__proto__":{"answers":["  café\\n猫  "]},"constructor":{"answers":["A"]}}}';
    expect(matchCodexHumanAnswerOutput(binding)).toMatchObject({
      matched: true,
      sourceAuthenticated: false,
    });
    binding.output.output = binding.output.output.replace("é", "é");
    expect(matchCodexHumanAnswerOutput(binding)).toMatchObject({
      matched: false,
      reason: "answer_output_body_mismatch",
    });
  });
  it("does not misrepresent signature syntax validation as authentication", async () => {
    const { binding } = await prepared();
    binding.answer.signature = "A".repeat(86);
    expect(matchCodexHumanAnswerOutput(binding)).toMatchObject({
      matched: true,
      sourceAuthenticated: false,
      consumptionQualified: false,
    });
  });
});

describe.each(["memory", "sqlite"] as const)("protected output recording (%s)", (kind) => {
  it("persists and replays the exact match with the hold intact after reopen", async () => {
    const { f, input } = await prepared(kind);
    expect(await recordCodexHumanAnswerOutput(f.service, input)).toMatchObject({
      ok: true,
      replay: false,
      contentMatched: true,
      consumptionQualified: false,
      resendAllowed: false,
    });
    expect(await recordCodexHumanAnswerOutput(f.service, input)).toMatchObject({
      ok: true,
      replay: true,
    });
    if (kind === "sqlite") await f.reopen();
    expect(await f.service.inspectWorkerAnswerDelivery("run", input.requestId)).toMatchObject({
      holdPending: true,
      observations: [{ kind: "matching_answer_output" }],
      consumptionQualified: false,
      resendAllowed: false,
    });
    expect(
      humanActionSummary((await f.store.getRunCoordination("run"))!.state, f.time)
    ).toHaveLength(1);
  });
  it("recovers a lost persistence acknowledgement without any delivery port", async () => {
    const { f, input } = await prepared(kind);
    const port = {
      getWorkerAnswer: f.service.getWorkerAnswer.bind(f.service),
      inspectWorkerAnswerDelivery: f.service.inspectWorkerAnswerDelivery.bind(f.service),
      recordWorkerAnswerObservation: vi.fn(
        async (...args: Parameters<typeof f.service.recordWorkerAnswerObservation>) => {
          await f.service.recordWorkerAnswerObservation(...args);
          throw new Error("lost acknowledgement");
        }
      ),
    };
    await expect(recordCodexHumanAnswerOutput(port, input)).rejects.toThrow("lost acknowledgement");
    expect(await recordCodexHumanAnswerOutput(f.service, input)).toMatchObject({
      ok: true,
      replay: true,
    });
    expect(
      (await f.service.inspectWorkerAnswerDelivery("run", input.requestId))!.observations
    ).toHaveLength(1);
  });
  it.each(["not_sent", "uncertain"] as const)(
    "keeps the %s delivery disposition",
    async (disposition) => {
      const { f, input } = await prepared(kind, disposition);
      expect(await recordCodexHumanAnswerOutput(f.service, input)).toMatchObject(
        disposition === "not_sent"
          ? { ok: false, reason: "answer_not_sent" }
          : { ok: true, consumptionQualified: false }
      );
      expect(
        (await f.service.inspectWorkerAnswerDelivery("run", input.requestId))!.delivery!.disposition
      ).toBe(disposition);
    }
  );
  it("rejects bad content before mutation and propagates stale revision rejection", async () => {
    const { f, input } = await prepared(kind);
    const before = (await f.store.getRunCoordination("run"))!.revision;
    expect(
      await recordCodexHumanAnswerOutput(f.service, {
        ...input,
        output: { ...input.output, output: "wrong" },
      })
    ).toMatchObject({ ok: false, reason: "answer_output_body_mismatch" });
    expect(
      await recordCodexHumanAnswerOutput(f.service, { ...input, expectedRunRevision: before - 1 })
    ).toMatchObject({ ok: false, reason: "stale_run_revision" });
    expect((await f.store.getRunCoordination("run"))!.revision).toBe(before);
  });
  it("snapshots caller input before a delayed read", async () => {
    const { f, input } = await prepared(kind);
    const port = {
      getWorkerAnswer: async (runId: string, requestId: string) => {
        input.output.output = "changed during read";
        input.observationId = "changed";
        input.controller.runId = "changed";
        return f.service.getWorkerAnswer(runId, requestId);
      },
      inspectWorkerAnswerDelivery: f.service.inspectWorkerAnswerDelivery.bind(f.service),
      recordWorkerAnswerObservation: f.service.recordWorkerAnswerObservation.bind(f.service),
    };
    expect(await recordCodexHumanAnswerOutput(port, input)).toMatchObject({ ok: true });
    expect(
      (await f.service.inspectWorkerAnswerDelivery("run", input.requestId))!.observations[0]
        .observationId
    ).toBe("provider-observation-1");
  });
  it("rejects output for another pending question", async () => {
    const { f, input } = await prepared(kind);
    expect(
      await recordCodexHumanAnswerOutput(f.service, { ...input, requestId: "missing" })
    ).toMatchObject({ ok: false, reason: "authenticated_worker_answer_missing" });
    expect(
      (await f.service.inspectWorkerAnswerDelivery("run", input.requestId))!.observations
    ).toEqual([]);
  });
});
