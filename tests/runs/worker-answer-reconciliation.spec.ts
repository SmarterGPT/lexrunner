import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { humanAnswerFixture } from "../store/worker-human-answer-fixture.js";
import {
  humanActionSummary,
  readHumanActionState,
} from "../../src/runs/agent-work-human-action-service.js";
import { computeCanonicalHash } from "../../src/schemas/task-contract.js";
import type { WorkerHumanAnswerObservation } from "../../src/schemas/worker-human-answer.js";

const fixtures: Awaited<ReturnType<typeof humanAnswerFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup();
});
async function prepared(
  kind: "memory" | "sqlite",
  disposition: "written" | "not_sent" | "uncertain" = "written"
) {
  const f = await humanAnswerFixture(kind);
  fixtures.push(f);
  const requestId = await f.record();
  const answer = f.signed(await f.challenge(requestId));
  expect(
    await f.service.admitWorkerAnswer({ ...(await f.mutation("answer")), answer })
  ).toMatchObject({ ok: true });
  const claimId = randomUUID();
  const claim = await f.service.claimWorkerAnswerDelivery({
    ...(await f.mutation("claim")),
    requestId,
    claimId,
  });
  if (!claim.ok || !("delivery" in claim)) throw new Error("claim failed");
  expect(
    await f.service.recordWorkerAnswerWrite({
      ...(await f.mutation("write")),
      requestId,
      claimId,
      disposition,
    })
  ).toMatchObject({ ok: true });
  const stored = (await f.service.getWorkerAnswer("run", requestId))!;
  const observation: WorkerHumanAnswerObservation = {
    version: 1,
    domain: "lexrunner.worker-answer-observation/v1",
    observationId: randomUUID(),
    runId: "run",
    requestId,
    claimId,
    captureHash: computeCanonicalHash(stored.capture),
    answerHash: claim.delivery.answerHash,
    evidenceHash: computeCanonicalHash({ isolated: "host fixture observation" }),
    kind: "request_cleared",
    observedAt: f.time,
  };
  return { f, requestId, observation };
}

describe.each(["memory", "sqlite"] as const)("bounded answer reconciliation (%s)", (kind) => {
  it.each(["request_cleared", "matching_answer_output", "delivery_uncertain"] as const)(
    "retains %s as unqualified evidence and never releases or resends",
    async (evidenceKind) => {
      const { f, requestId, observation } = await prepared(kind);
      observation.kind = evidenceKind;
      const input = { ...(await f.mutation("observation")), observation };
      expect(await f.service.recordWorkerAnswerObservation(input)).toMatchObject({
        ok: true,
        replay: false,
      });
      expect(await f.service.recordWorkerAnswerObservation(input)).toMatchObject({
        ok: true,
        replay: true,
      });
      if (kind === "sqlite") await f.reopen();
      const report = await f.service.inspectWorkerAnswerDelivery("run", requestId);
      expect(report).toMatchObject({
        holdPending: true,
        answerAdmitted: true,
        consumptionQualified: false,
        resendAllowed: false,
        observations: [observation],
      });
      expect(JSON.stringify(report)).not.toContain('"answers"');
      expect(JSON.stringify(report)).not.toContain('"signature"');
      const state = (await f.store.getRunCoordination("run"))!.state;
      expect(humanActionSummary(state, f.time)).toHaveLength(1);
      const request = readHumanActionState(state).entries[0].request;
      expect(
        await f.service.settle({
          ...(await f.mutation("forged-completion")),
          receipt: {
            schema_version: "1.0.0",
            receipt_id: "pretend-completed",
            request_id: requestId,
            run_id: "run",
            attempt_id: "attempt",
            workspace_lease_id: "workspace",
            worker_session_id: "worker",
            observed_preconditions: request.preconditions,
            outcome: "completed",
            actor_id: "human-1",
            summary: "An observation is not action admission",
            completed_at: f.time,
          },
        })
      ).toMatchObject({ ok: false, reason: "worker_answer_delivery_not_qualified" });
      expect(
        await f.service.claimWorkerAnswerDelivery({
          ...(await f.mutation("retry")),
          requestId,
          claimId: randomUUID(),
        })
      ).toMatchObject({ ok: true, newlyClaimed: false });
    }
  );
  it.each(["runId", "requestId", "claimId", "captureHash", "answerHash"] as const)(
    "rejects a mismatched %s without changing state",
    async (field) => {
      const { f, observation } = await prepared(kind);
      const before = (await f.store.getRunCoordination("run"))!.revision;
      const changed = {
        ...observation,
        [field]: field.includes("Hash")
          ? `sha256:${"b".repeat(64)}`
          : field === "claimId"
            ? randomUUID()
            : "other",
      };
      expect(
        await f.service.recordWorkerAnswerObservation({
          ...(await f.mutation("bad-binding")),
          observation: changed,
        })
      ).toMatchObject({ ok: false });
      expect((await f.store.getRunCoordination("run"))!.revision).toBe(before);
    }
  );
  it("preserves first observation and refuses conflicting reuse", async () => {
    const { f, observation } = await prepared(kind);
    await f.service.recordWorkerAnswerObservation({ ...(await f.mutation("first")), observation });
    expect(
      await f.service.recordWorkerAnswerObservation({
        ...(await f.mutation("conflict")),
        observation: { ...observation, kind: "matching_answer_output" },
      })
    ).toMatchObject({ ok: false, reason: "answer_observation_conflict" });
    expect(
      (await f.service.inspectWorkerAnswerDelivery("run", observation.requestId))!.observations
    ).toEqual([observation]);
  });
  it("refuses capacity without evicting records, retaining exact replay", async () => {
    const { f, observation } = await prepared(kind);
    for (let i = 0; i < 16; i++)
      expect(
        await f.service.recordWorkerAnswerObservation({
          ...(await f.mutation(`obs-${i}`)),
          observation: { ...observation, observationId: `obs-${i}` },
        })
      ).toMatchObject({ ok: true });
    expect(
      await f.service.recordWorkerAnswerObservation({
        ...(await f.mutation("overflow")),
        observation,
      })
    ).toMatchObject({ ok: false, reason: "answer_observation_capacity" });
    expect(
      await f.service.recordWorkerAnswerObservation({
        ...(await f.mutation("replay")),
        observation: { ...observation, observationId: "obs-0" },
      })
    ).toMatchObject({ ok: true, replay: true });
    expect(
      (await f.service.inspectWorkerAnswerDelivery("run", observation.requestId))!.observations
    ).toHaveLength(16);
  });
  it.each([-1, 1])("rejects out-of-range observation time delta %s", async (delta) => {
    const { f, observation } = await prepared(kind);
    observation.observedAt = new Date(Date.parse(f.time) + delta).toISOString();
    expect(
      await f.service.recordWorkerAnswerObservation({
        ...(await f.mutation("bad-time")),
        observation,
      })
    ).toMatchObject({ ok: false, reason: "invalid_answer_observation_time" });
  });
  it("retains post-deadline evidence after worker termination and workspace change without qualifying consumption", async () => {
    const { f, observation } = await prepared(kind, "uncertain");
    observation.observedAt = new Date(Date.parse(f.time) + 35000).toISOString();
    f.session.status = "completed";
    f.observed.headSha = "b".repeat(40);
    expect(
      await f.service.recordWorkerAnswerObservation({
        ...(await f.mutation("late-evidence", observation.observedAt)),
        observation,
      })
    ).toMatchObject({ ok: true });
    expect(await f.service.inspectWorkerAnswerDelivery("run", observation.requestId)).toMatchObject(
      { holdPending: true, consumptionQualified: false, resendAllowed: false }
    );
  });
  it("refuses observations when no answer was sent", async () => {
    const { f, observation } = await prepared(kind, "not_sent");
    expect(
      await f.service.recordWorkerAnswerObservation({
        ...(await f.mutation("no-send")),
        observation,
      })
    ).toMatchObject({ ok: false, reason: "answer_not_sent" });
  });
  it("rejects stale revisions and old controller credentials", async () => {
    const { f, observation } = await prepared(kind);
    const input = { ...(await f.mutation("stale")), observation };
    expect(
      await f.service.recordWorkerAnswerObservation({
        ...input,
        expectedRunRevision: input.expectedRunRevision - 1,
      })
    ).toMatchObject({ ok: false, reason: "stale_run_revision" });
    await f.store.releaseControllerLease(f.controller);
    await f.store.acquireControllerLease({
      runId: "run",
      controllerId: "new",
      leaseId: "new",
      now: f.time,
      ttlMs: 60000,
      initialState: {},
    });
    expect(await f.service.recordWorkerAnswerObservation(input)).toMatchObject({ ok: false });
    expect(
      (await f.service.inspectWorkerAnswerDelivery("run", observation.requestId))!.observations
    ).toEqual([]);
  });
  it("recovers a committed observation after lost storage acknowledgement without another event", async () => {
    const { f, observation } = await prepared(kind);
    let lost = false;
    const wrapped = new Proxy(f.store, {
      get(target, key) {
        if (key === "compareAndSetRunState")
          return async (input: any) => {
            const result = await target.compareAndSetRunState(input);
            if (result.updated && !lost) {
              lost = true;
              throw new Error("lost ACK");
            }
            return result;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const service = f.serviceFor(wrapped);
    const input = { ...(await f.mutation("lost-ack")), observation };
    await expect(service.recordWorkerAnswerObservation(input)).rejects.toThrow("lost ACK");
    expect(await service.recordWorkerAnswerObservation(input)).toMatchObject({
      ok: true,
      replay: true,
    });
    expect(
      (await f.store.listRunCoordinationEvents("run")).filter(
        (v) => v.type === "worker_answer_observation_recorded"
      )
    ).toHaveLength(1);
  });
  it.each([{ kind: "consumed" }, { rawAnswer: "A" }, { observationId: "x".repeat(513) }])(
    "rejects malformed or authorizing-looking input %j",
    async (change) => {
      const { f, observation } = await prepared(kind);
      await expect(
        f.service.recordWorkerAnswerObservation({
          ...(await f.mutation("invalid")),
          observation: { ...observation, ...change } as any,
        })
      ).rejects.toThrow();
    }
  );
});
