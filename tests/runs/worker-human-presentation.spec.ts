import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { humanAnswerFixture } from "../store/worker-human-answer-fixture.js";
import {
  humanActionSummary,
  readHumanActionState,
} from "../../src/runs/agent-work-human-action-service.js";
import { AgentWorkHeadlessSupervisor } from "../../src/runs/agent-work-supervisor.js";
import type { CoordinationStore } from "../../src/store/coordination-store.js";

const fixtures: Awaited<ReturnType<typeof humanAnswerFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});
async function fixture(kind: "memory" | "sqlite") {
  const f = await humanAnswerFixture(kind);
  fixtures.push(f);
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function claim(f: Fixture, requestId: string, now = f.time, previousPresentationId?: string) {
  const input = {
    ...(await f.mutation(`display:${randomUUID()}`, now)),
    requestId,
    presentationId: randomUUID(),
    challengeId: randomUUID(),
    expiresAt: new Date(Date.parse(now) + 30_000).toISOString(),
    ...(previousPresentationId ? { previousPresentationId } : {}),
  };
  const result = await f.service.claimWorkerQuestionPresentation(input);
  if (!result.ok) throw new Error(result.reason);
  return { input, result, presentation: result.presentation };
}
async function assertHeld(f: Fixture, requestId: string, now = f.time) {
  const state = (await f.store.getRunCoordination("run"))!.state;
  expect(humanActionSummary(state, now)).toMatchObject([{ requestId }]);
  const attempts = ["attempt", "sibling"].map((attemptId) => ({ attemptId, status: "prepared" }));
  const launch = vi.fn(),
    collectReceipt = vi.fn(),
    cancel = vi.fn(),
    observe = vi.fn();
  const verify = vi.fn(),
    applyAcceptance = vi.fn(),
    transitionAttempt = vi.fn();
  // Real coordinator, presentation service and supervisor; controlled downstream ports.
  // No live worker suspension, native action containment or successful release is claimed.
  const lifecycle = {
    listAttempts: async () => attempts,
    getWorkerSessionForAttempt: async () => null,
    applyAttemptAcceptance: applyAcceptance,
    transitionAttempt,
  } as unknown as Parameters<
    typeof AgentWorkHeadlessSupervisor.withVerificationRuntime
  >[0]["store"];
  const supervisor = AgentWorkHeadlessSupervisor.withVerificationRuntime({
    coordination: f.store,
    store: lifecycle,
    workerSessions: {} as never,
    workerAdapters: {} as never,
    verificationRuntime: { verify } as never,
    workspaceObserver: f.observer,
    workerControl: { selection: {} as never, launch, collectReceipt, cancel, observe },
  });
  expect(
    await supervisor.reconcileRun({
      runId: "run",
      controllerId: f.controller.controllerId,
      controllerLeaseId: f.controller.leaseId,
      initialRunState: {},
      now,
    })
  ).toMatchObject({
    ok: true,
    humanActionCount: 1,
    attempts: attempts.map(({ attemptId }) => ({
      attemptId,
      action: "await_human",
      outcome: "deferred",
    })),
  });
  for (const port of [
    launch,
    collectReceipt,
    cancel,
    observe,
    verify,
    applyAcceptance,
    transitionAttempt,
  ])
    expect(port).not.toHaveBeenCalled();
}

describe.each(["memory", "sqlite"] as const)("durable question presentations (%s)", (kind) => {
  it.each(["declined", "cancelled", "expired", "failed"] as const)(
    "keeps the decision and supervisor held after %s and coordinator restart",
    async (disposition) => {
      const f = await fixture(kind),
        requestId = await f.record();
      const first = await claim(f, requestId);
      const now = disposition === "expired" ? first.presentation.challenge.expiresAt : f.time;
      const close = {
        ...(await f.mutation("close", now)),
        requestId,
        presentationId: first.presentation.presentationId,
        disposition,
      };
      expect(await f.service.closeWorkerQuestionPresentation(close)).toMatchObject({
        ok: true,
        replay: false,
      });
      expect(await f.service.closeWorkerQuestionPresentation(close)).toMatchObject({
        ok: true,
        replay: true,
      });
      await assertHeld(f, requestId, now);
      if (kind === "sqlite") await f.reopen();
      expect(await f.service.getWorkerQuestionPresentation("run", requestId, now)).toMatchObject({
        holdPending: true,
        answerAdmitted: false,
        presentationCount: 1,
        disposition,
      });
      await assertHeld(f, requestId, now);
      expect(await f.service.claimWorkerQuestionPresentation(first.input)).toMatchObject({
        ok: true,
        newlyClaimed: false,
      });
      expect(await f.store.listRunCoordinationEvents("run")).toHaveLength(3);
    }
  );

  it("requires explicit recovery, rejects stale replies and admits only the fresh presentation", async () => {
    const f = await fixture(kind),
      requestId = await f.record(),
      first = await claim(f, requestId);
    await f.service.closeWorkerQuestionPresentation({
      ...(await f.mutation("skip")),
      requestId,
      presentationId: first.presentation.presentationId,
      disposition: "declined",
    });
    expect(
      await f.service.admitWorkerAnswer({
        ...(await f.mutation("late")),
        answer: f.signed(first.presentation.challenge),
      })
    ).toMatchObject({ ok: false, reason: "presentation_not_active" });
    expect(
      await f.service.issueWorkerAnswerChallenge({
        ...(await f.mutation("legacy")),
        requestId,
        challengeId: randomUUID(),
        expiresAt: first.input.expiresAt,
      })
    ).toMatchObject({ ok: false, reason: "presentation_managed_challenge" });
    expect(
      await f.service.claimWorkerQuestionPresentation({
        ...first.input,
        ...(await f.mutation("auto")),
        presentationId: randomUUID(),
        challengeId: randomUUID(),
      })
    ).toMatchObject({ ok: false, reason: "explicit_presentation_recovery_required" });
    const next = await claim(f, requestId, f.time, first.presentation.presentationId);
    expect(next.presentation.challenge.generation).toBe(2);
    expect(next.result.capture).toEqual(first.result.capture);
    expect(
      await f.service.admitWorkerAnswer({
        ...(await f.mutation("stale")),
        answer: f.signed(first.presentation.challenge),
      })
    ).toMatchObject({ ok: false, reason: "worker_answer_binding_mismatch" });
    expect(
      await f.service.closeWorkerQuestionPresentation({
        ...(await f.mutation("late-close")),
        requestId,
        presentationId: first.presentation.presentationId,
        disposition: "cancelled",
      })
    ).toMatchObject({ ok: false, reason: "presentation_binding_mismatch" });
    await assertHeld(f, requestId);
    const answer = f.signed(next.presentation.challenge);
    expect(
      await f.service.admitWorkerAnswer({ ...(await f.mutation("fresh")), answer })
    ).toMatchObject({ ok: true });
    const delivery = await f.service.claimWorkerAnswerDelivery({
      ...(await f.mutation("send")),
      requestId,
      claimId: randomUUID(),
    });
    if (!delivery.ok) throw new Error(delivery.reason);
    await f.service.recordWorkerAnswerWrite({
      ...(await f.mutation("written")),
      requestId,
      claimId: delivery.delivery.claimId,
      disposition: "written",
    });
    if (kind === "sqlite") await f.reopen();
    expect(await f.service.getWorkerQuestionPresentation("run", requestId, f.time)).toMatchObject({
      holdPending: true,
      answerAdmitted: true,
      disposition: "answered",
      presentationCount: 2,
    });
    // Fresh host admission and a local pipe write still do not qualify worker consumption.
    await assertHeld(f, requestId);
    expect(
      await f.service.claimWorkerQuestionPresentation({
        ...next.input,
        ...(await f.mutation("again")),
        presentationId: randomUUID(),
        challengeId: randomUUID(),
      })
    ).toMatchObject({ ok: false, reason: "answer_already_admitted" });
  });

  it("recovers an unobserved timeout atomically without losing question or presentation history", async () => {
    const f = await fixture(kind),
      requestId = await f.record(),
      first = await claim(f, requestId);
    const now = first.presentation.challenge.expiresAt;
    if (kind === "sqlite") await f.reopen();
    const revision = (await f.store.getRunCoordination("run"))!.revision;
    expect(await f.service.getWorkerQuestionPresentation("run", requestId, now)).toMatchObject({
      disposition: "expired",
      holdPending: true,
    });
    expect((await f.store.getRunCoordination("run"))!.revision).toBe(revision);
    expect(
      await f.service.admitWorkerAnswer({
        ...(await f.mutation("late", now)),
        answer: f.signed(first.presentation.challenge),
      })
    ).toMatchObject({ ok: false, reason: "worker_answer_expired_or_invalid_time" });
    await assertHeld(f, requestId, now);
    const next = await claim(f, requestId, now, first.presentation.presentationId);
    expect(
      readHumanActionState((await f.store.getRunCoordination("run"))!.state).entries[0]
        .presentations
    ).toMatchObject([
      { disposition: "expired", closedAt: now },
      { disposition: "active", challenge: { generation: 2 } },
    ]);
    expect(next.result.newlyClaimed).toBe(true);
    await assertHeld(f, requestId, now);
  });

  it("does not display twice after a lost commit acknowledgement or replay", async () => {
    const f = await fixture(kind),
      requestId = await f.record();
    let lost = false;
    const proxy = new Proxy(f.store, {
      get(target, key) {
        if (key === "compareAndSetRunState")
          return async (input: Parameters<CoordinationStore["compareAndSetRunState"]>[0]) => {
            const result = await target.compareAndSetRunState(input);
            if (
              result.updated &&
              input.event.type === "worker_question_presentation_claimed" &&
              !lost
            ) {
              lost = true;
              throw new Error("lost ACK");
            }
            return result;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const service = f.serviceFor(proxy);
    const input = {
      ...(await f.mutation("display")),
      requestId,
      presentationId: randomUUID(),
      challengeId: randomUUID(),
      expiresAt: new Date(Date.parse(f.time) + 30_000).toISOString(),
    };
    await expect(service.claimWorkerQuestionPresentation(input)).rejects.toThrow("lost ACK");
    if (kind === "sqlite") await f.reopen();
    expect(await f.service.claimWorkerQuestionPresentation(input)).toMatchObject({
      ok: true,
      newlyClaimed: false,
      replay: true,
    });
    expect(
      await f.service.claimWorkerQuestionPresentation({
        ...input,
        presentationId: randomUUID(),
        challengeId: randomUUID(),
        previousPresentationId: input.presentationId,
        ...(await f.mutation("duplicate")),
      })
    ).toMatchObject({ ok: false, reason: "presentation_already_active" });
    expect(await f.store.listRunCoordinationEvents("run")).toHaveLength(2);
    await assertHeld(f, requestId);
  });

  it("admits at most one concurrent presentation claim", async () => {
    const f = await fixture(kind),
      requestId = await f.record(),
      mutation = await f.mutation("display");
    const inputs = [1, 2].map((i) => ({
      ...mutation,
      mutationId: `display:${i}`,
      requestId,
      presentationId: randomUUID(),
      challengeId: randomUUID(),
      expiresAt: new Date(Date.parse(f.time) + 30_000).toISOString(),
    }));
    const results = await Promise.all(
      inputs.map((input) => f.service.claimWorkerQuestionPresentation(input))
    );
    expect(results.filter((result) => result.ok && result.newlyClaimed)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(await f.store.listRunCoordinationEvents("run")).toHaveLength(2);
  });

  it.each(["workspace", "worker"])(
    "refuses recovery after the %s binding changes",
    async (boundary) => {
      const f = await fixture(kind),
        requestId = await f.record(),
        first = await claim(f, requestId);
      await f.service.closeWorkerQuestionPresentation({
        ...(await f.mutation("skip")),
        requestId,
        presentationId: first.presentation.presentationId,
        disposition: "declined",
      });
      if (boundary === "workspace") f.observed.headSha = "b".repeat(40);
      else f.session.workerId = "replacement-worker";
      expect(
        await f.service.claimWorkerQuestionPresentation({
          ...first.input,
          ...(await f.mutation("recover")),
          presentationId: randomUUID(),
          challengeId: randomUUID(),
          previousPresentationId: first.presentation.presentationId,
        })
      ).toMatchObject({
        ok: false,
        reason:
          boundary === "workspace" ? "stale_workspace_binding" : "worker_input_session_mismatch",
      });
      expect(await f.store.listRunCoordinationEvents("run")).toHaveLength(3);
      await assertHeld(f, requestId);
    }
  );

  it("refuses early expiry and an invented answer outcome without modifying the hold", async () => {
    const f = await fixture(kind),
      requestId = await f.record(),
      first = await claim(f, requestId);
    const input = {
      ...(await f.mutation("close")),
      requestId,
      presentationId: first.presentation.presentationId,
    };
    await expect(
      f.service.closeWorkerQuestionPresentation({ ...input, disposition: "expired" })
    ).rejects.toThrow();
    await expect(
      f.service.closeWorkerQuestionPresentation({ ...input, disposition: "answered" as never })
    ).rejects.toThrow();
    expect(await f.store.listRunCoordinationEvents("run")).toHaveLength(2);
    await assertHeld(f, requestId);
  });

  it("fences recovery after controller takeover and retains the same question", async () => {
    const f = await fixture(kind),
      requestId = await f.record(),
      first = await claim(f, requestId);
    const oldController = structuredClone(f.controller);
    const now = new Date(Date.parse(f.time) + 60_001).toISOString();
    const acquired = await f.store.acquireControllerLease({
      runId: "run",
      controllerId: "replacement",
      leaseId: "replacement-lease",
      now,
      ttlMs: 60_000,
      initialState: {},
    });
    if (!acquired.acquired) throw new Error("fixture takeover failed");
    const input = {
      ...(await f.mutation("recover", now)),
      requestId,
      presentationId: randomUUID(),
      challengeId: randomUUID(),
      expiresAt: new Date(Date.parse(now) + 30_000).toISOString(),
      previousPresentationId: first.presentation.presentationId,
    };
    expect(
      await f.service.claimWorkerQuestionPresentation({ ...input, controller: oldController })
    ).toMatchObject({ ok: false });
    Object.assign(f.controller, {
      controllerId: acquired.lease.controllerId,
      leaseId: acquired.lease.leaseId,
      fencingToken: acquired.lease.fencingToken,
    });
    expect(
      await f.service.claimWorkerQuestionPresentation({ ...input, controller: f.controller })
    ).toMatchObject({ ok: true, newlyClaimed: true });
    if (kind === "sqlite") await f.reopen();
    await assertHeld(f, requestId, now);
  });

  it("rejects recovery when the original request context changes", async () => {
    const f = await fixture(kind),
      requestId = await f.record(),
      first = await claim(f, requestId);
    await f.service.closeWorkerQuestionPresentation({
      ...(await f.mutation("skip")),
      requestId,
      presentationId: first.presentation.presentationId,
      disposition: "declined",
    });
    const record = (await f.store.getRunCoordination("run"))!;
    await f.store.compareAndSetRunState({
      ...f.controller,
      expectedRevision: record.revision,
      mutationId: "change-objective",
      now: f.time,
      event: { type: "objective_changed", payload: null },
      state: { ...(record.state as Record<string, never>), task: "Different objective" },
    });
    expect(
      await f.service.claimWorkerQuestionPresentation({
        ...first.input,
        ...(await f.mutation("recover")),
        presentationId: randomUUID(),
        challengeId: randomUUID(),
        previousPresentationId: first.presentation.presentationId,
      })
    ).toMatchObject({ ok: false, reason: "request_context_changed" });
    await assertHeld(f, requestId);
  });

  it("fails closed when persisted presentation history is corrupted", async () => {
    const f = await fixture(kind),
      requestId = await f.record(),
      first = await claim(f, requestId);
    const record = (await f.store.getRunCoordination("run"))!;
    const state = structuredClone(record.state) as any;
    state.metadata.agentWorkHumanActions.entries[0].presentations[0].challenge.bindingHash =
      "sha256:" + "b".repeat(64);
    await f.store.compareAndSetRunState({
      ...f.controller,
      expectedRevision: record.revision,
      mutationId: "corrupt-history",
      now: f.time,
      event: { type: "controlled_corruption", payload: null },
      state,
    });
    expect(() => readHumanActionState(state)).toThrow();
    await expect(f.service.claimWorkerQuestionPresentation(first.input)).rejects.toThrow();
  });

  it("retains all history and refuses further presentations at capacity", async () => {
    const f = await fixture(kind),
      requestId = await f.record();
    let previous: string | undefined;
    for (let i = 0; i < 16; i++) {
      const next = await claim(f, requestId, f.time, previous);
      await f.service.closeWorkerQuestionPresentation({
        ...(await f.mutation(`skip:${i}`)),
        requestId,
        presentationId: next.presentation.presentationId,
        disposition: "declined",
      });
      previous = next.presentation.presentationId;
    }
    const result = await f.service.claimWorkerQuestionPresentation({
      ...(await f.mutation("overflow")),
      requestId,
      presentationId: randomUUID(),
      challengeId: randomUUID(),
      expiresAt: new Date(Date.parse(f.time) + 30_000).toISOString(),
      previousPresentationId: previous,
    });
    expect(result).toMatchObject({ ok: false, reason: "presentation_capacity" });
    expect(
      readHumanActionState((await f.store.getRunCoordination("run"))!.state).entries[0]
        .presentations
    ).toHaveLength(16);
    await assertHeld(f, requestId);
  });
});
