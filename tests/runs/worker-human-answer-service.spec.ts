import { generateKeyPairSync, randomUUID } from "node:crypto";
import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, describe, expect, it } from "vitest";
import { humanAnswerFixture } from "../store/worker-human-answer-fixture.js";
import {
  humanActionSummary,
  readHumanActionState,
} from "../../src/runs/agent-work-human-action-service.js";
import { TrustedHumanAnswerVerifier } from "../../src/runs/trusted-human-answer-verifier.js";
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
function lostAck(store: CoordinationStore, type: string) {
  let lost = false;
  return new Proxy(store, {
    get(target, key) {
      if (key === "compareAndSetRunState")
        return async (input: Parameters<CoordinationStore["compareAndSetRunState"]>[0]) => {
          const result = await target.compareAndSetRunState(input);
          if (result.updated && input.event.type === type && !lost) {
            lost = true;
            throw new Error("lost storage acknowledgement");
          }
          return result;
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe.each(["memory", "sqlite"] as const)("host-authenticated worker answers (%s)", (kind) => {
  it("retains an authenticated answer, single send claim and write observation without releasing the hold", async () => {
    const f = await fixture(kind),
      requestId = await f.record(),
      challenge = await f.challenge(requestId),
      answer = f.signed(challenge);
    const admission = { ...(await f.mutation("answer")), answer };
    expect(await f.service.admitWorkerAnswer(admission)).toMatchObject({
      ok: true,
      revision: 3,
      replay: false,
    });
    expect(await f.service.admitWorkerAnswer(admission)).toMatchObject({ ok: true, replay: true });
    const claim = { ...(await f.mutation("claim")), requestId, claimId: randomUUID() };
    expect(await f.service.claimWorkerAnswerDelivery(claim)).toMatchObject({
      ok: true,
      newlyClaimed: true,
      delivery: { disposition: "claimed" },
    });
    expect(await f.service.claimWorkerAnswerDelivery(claim)).toMatchObject({
      ok: true,
      newlyClaimed: false,
    });
    const write = {
      ...(await f.mutation("write")),
      requestId,
      claimId: claim.claimId,
      disposition: "written" as const,
    };
    expect(await f.service.recordWorkerAnswerWrite(write)).toMatchObject({ ok: true, revision: 5 });
    expect(await f.service.recordWorkerAnswerWrite(write)).toMatchObject({
      ok: true,
      replay: true,
    });
    if (kind === "sqlite") await f.reopen();
    const state = (await f.store.getRunCoordination("run"))!.state;
    expect(readHumanActionState(state).entries[0]).toMatchObject({
      workerAnswer: answer,
      answerDelivery: { disposition: "written" },
    });
    expect(humanActionSummary(state, f.time)).toHaveLength(1);
    expect(await f.store.listRunCoordinationEvents("run")).toHaveLength(5);
  });
  it.each(["actor", "host", "key", "run", "wrong-key", "tamper"])(
    "rejects unauthenticated %s answers without a mutation",
    async (attack) => {
      const f = await fixture(kind),
        requestId = await f.record(),
        challenge = await f.challenge(requestId);
      let answer = f.signed(challenge);
      if (attack === "actor") answer = f.signed(challenge, { actorId: "worker" });
      if (attack === "host") answer = f.signed(challenge, { hostId: "other-host" });
      if (attack === "key") answer = f.signed(challenge, { keyId: "other-key" });
      if (attack === "run") answer = f.signed({ ...challenge, runId: "other-run" });
      if (attack === "wrong-key")
        answer = f.signed(challenge, {}, generateKeyPairSync("ed25519").privateKey);
      if (attack === "tamper") answer.payload.answers[0].value = "B";
      expect(
        await f.service.admitWorkerAnswer({ ...(await f.mutation("answer")), answer })
      ).toEqual({ ok: false, reason: "human_host_authentication_failed" });
      expect((await f.store.getRunCoordination("run"))!.revision).toBe(2);
    }
  );
  it.each(["challenge", "binding", "missing-question", "extra-question", "invalid-option"])(
    "rejects a correctly signed answer with mismatched %s",
    async (attack) => {
      const f = await fixture(kind),
        requestId = await f.record(),
        challenge = await f.challenge(requestId);
      const answer = f.signed(
        attack === "challenge"
          ? { ...challenge, challengeId: randomUUID() }
          : attack === "binding"
            ? { ...challenge, bindingHash: `sha256:${"b".repeat(64)}` }
            : challenge,
        attack === "missing-question"
          ? { answers: [{ questionId: "wrong", value: "A" }] }
          : attack === "extra-question"
            ? {
                answers: [
                  { questionId: "choice", value: "A" },
                  { questionId: "extra", value: "A" },
                ],
              }
            : attack === "invalid-option"
              ? { answers: [{ questionId: "choice", value: "C" }] }
              : {}
      );
      expect(
        await f.service.admitWorkerAnswer({ ...(await f.mutation("answer")), answer })
      ).toEqual({ ok: false, reason: "worker_answer_binding_mismatch" });
    }
  );
  it("does not accept an expired answer or silently rotate an active challenge", async () => {
    const f = await fixture(kind),
      requestId = await f.record(),
      challenge = await f.challenge(requestId);
    expect(
      await f.service.issueWorkerAnswerChallenge({
        ...(await f.mutation("second")),
        requestId,
        challengeId: randomUUID(),
        expiresAt: challenge.expiresAt,
      })
    ).toMatchObject({ ok: false, reason: "challenge_already_active" });
    expect(
      await f.service.admitWorkerAnswer({
        ...(await f.mutation("answer", challenge.expiresAt)),
        answer: f.signed(challenge),
      })
    ).toMatchObject({ ok: false, reason: "worker_answer_expired_or_invalid_time" });
    const newer = await f.service.issueWorkerAnswerChallenge({
      ...(await f.mutation("renew", challenge.expiresAt)),
      requestId,
      challengeId: randomUUID(),
      expiresAt: new Date(Date.parse(challenge.expiresAt) + 15000).toISOString(),
    });
    expect(newer).toMatchObject({ ok: true, challenge: { generation: 2 } });
    expect(
      await f.service.admitWorkerAnswer({
        ...(await f.mutation("old-answer", challenge.expiresAt)),
        answer: f.signed(challenge),
      })
    ).toMatchObject({ ok: false, reason: "worker_answer_binding_mismatch" });
  });
  it.each(["challenge", "admission", "claim"])(
    "confirms a lost %s storage ACK without creating another effect",
    async (step) => {
      const f = await fixture(kind),
        requestId = await f.record();
      const type =
        step === "challenge"
          ? "worker_answer_challenged"
          : step === "admission"
            ? "worker_answer_admitted"
            : "worker_answer_send_claimed";
      const service = f.serviceFor(lostAck(f.store, type));
      const challengeInput = {
        ...(await f.mutation("challenge")),
        requestId,
        challengeId: randomUUID(),
        expiresAt: new Date(Date.parse(f.time) + 30000).toISOString(),
      };
      if (step === "challenge") {
        await expect(service.issueWorkerAnswerChallenge(challengeInput)).rejects.toThrow(
          "lost storage acknowledgement"
        );
        expect(await service.issueWorkerAnswerChallenge(challengeInput)).toMatchObject({
          ok: true,
          replay: true,
        });
        expect(await f.store.listRunCoordinationEvents("run")).toHaveLength(2);
        return;
      }
      const challenge = await f.challenge(requestId),
        admission = { ...(await f.mutation("answer")), answer: f.signed(challenge) };
      if (step === "admission") {
        await expect(service.admitWorkerAnswer(admission)).rejects.toThrow(
          "lost storage acknowledgement"
        );
        expect(await service.admitWorkerAnswer(admission)).toMatchObject({
          ok: true,
          replay: true,
        });
        expect(await f.store.listRunCoordinationEvents("run")).toHaveLength(3);
        return;
      }
      expect(await f.service.admitWorkerAnswer(admission)).toMatchObject({ ok: true });
      const claim = { ...(await f.mutation("claim")), requestId, claimId: randomUUID() };
      await expect(service.claimWorkerAnswerDelivery(claim)).rejects.toThrow(
        "lost storage acknowledgement"
      );
      expect(await service.claimWorkerAnswerDelivery(claim)).toMatchObject({
        ok: true,
        newlyClaimed: false,
        delivery: { disposition: "claimed" },
      });
      expect(await f.store.listRunCoordinationEvents("run")).toHaveLength(4);
    }
  );
  it("retains the claimed slot through controller takeover; no replay grants a new send", async () => {
    const f = await fixture(kind),
      requestId = await f.record(),
      challenge = await f.challenge(requestId);
    await f.service.admitWorkerAnswer({
      ...(await f.mutation("answer")),
      answer: f.signed(challenge),
    });
    const claim = { ...(await f.mutation("claim")), requestId, claimId: randomUUID() };
    expect(await f.service.claimWorkerAnswerDelivery(claim)).toMatchObject({
      ok: true,
      newlyClaimed: true,
    });
    if (kind === "sqlite") await f.reopen();
    const now = new Date(Date.parse(f.time) + 60001).toISOString();
    const takeover = await f.store.acquireControllerLease({
      runId: "run",
      controllerId: "new-controller",
      leaseId: "new-lease",
      now,
      ttlMs: 60000,
      initialState: {},
    });
    if (!takeover.acquired) throw new Error("takeover failed");
    const controller = {
      runId: "run",
      controllerId: "new-controller",
      leaseId: "new-lease",
      fencingToken: takeover.lease.fencingToken,
    };
    expect(
      await f.service.claimWorkerAnswerDelivery({
        ...claim,
        controller,
        now,
        claimId: randomUUID(),
      })
    ).toMatchObject({ ok: true, newlyClaimed: false });
    expect(
      await f.service.recordWorkerAnswerWrite({
        ...claim,
        expectedRunRevision: 4,
        now,
        disposition: "uncertain",
      })
    ).toMatchObject({ ok: false, reason: "stale_fence" });
    expect(
      await f.service.recordWorkerAnswerWrite({
        ...claim,
        controller,
        mutationId: "reconcile-write",
        expectedRunRevision: 4,
        now,
        disposition: "uncertain",
      })
    ).toMatchObject({ ok: true });
    expect(humanActionSummary((await f.store.getRunCoordination("run"))!.state, now)).toHaveLength(
      1
    );
  });
  it.each(["head", "runtime", "ended", "context", "special-key-context"])(
    "rejects changed %s before admitting a signed answer",
    async (boundary) => {
      const f = await fixture(kind),
        requestId = await f.record(),
        challenge = await f.challenge(requestId);
      if (boundary === "head") f.observed.headSha = "b".repeat(40);
      if (boundary === "runtime") f.session.workerRuntime = "different-app";
      if (boundary === "ended") f.session.status = "completed";
      if (boundary === "context" || boundary === "special-key-context") {
        const record = (await f.store.getRunCoordination("run"))!;
        const changed =
          boundary === "context"
            ? { ...(record.state as object), task: "Different task" }
            : {
                ...(record.state as object),
                metadata: {
                  ...(record.state as { metadata: object }).metadata,
                  ...JSON.parse('{"__proto__":{"changed":true}}'),
                },
              };
        // Controlled legacy/corrupt-row fixture only. The current SQLite JSON
        // serializer drops this special key, so inject exact bytes to exercise
        // the answer boundary against a stored context that actually changed.
        if (boundary === "special-key-context" && kind === "sqlite") {
          const db = new Database(f.path);
          try {
            db.prepare("UPDATE run_coordination SET stateJson = ? WHERE runId = ?").run(
              JSON.stringify(changed),
              "run"
            );
          } finally {
            db.close();
          }
        } else {
          await f.store.compareAndSetRunState({
            ...f.controller,
            expectedRevision: record.revision,
            mutationId: "change",
            now: f.time,
            state: changed,
            event: { type: "changed", payload: {} },
          });
        }
      }
      expect(
        await f.service.admitWorkerAnswer({
          ...(await f.mutation("answer")),
          answer: f.signed(challenge),
        })
      ).toMatchObject({ ok: false });
      expect(await f.service.getWorkerAnswer("run", requestId)).toBeNull();
    }
  );
  it("allows only one concurrent send claim", async () => {
    const f = await fixture(kind),
      requestId = await f.record(),
      challenge = await f.challenge(requestId);
    await f.service.admitWorkerAnswer({
      ...(await f.mutation("answer")),
      answer: f.signed(challenge),
    });
    const base = { ...(await f.mutation("claim")), requestId };
    const results = await Promise.all([
      f.service.claimWorkerAnswerDelivery({ ...base, claimId: randomUUID() }),
      f.service.claimWorkerAnswerDelivery({
        ...base,
        mutationId: "other-claim",
        claimId: randomUUID(),
      }),
    ]);
    expect(results.filter((x) => x.ok && "newlyClaimed" in x && x.newlyClaimed)).toHaveLength(1);
    expect(
      (await f.store.listRunCoordinationEvents("run")).filter(
        (x) => x.type === "worker_answer_send_claimed"
      )
    ).toHaveLength(1);
  });
  it("keeps trust immutable and re-verifies persisted signatures before claim", async () => {
    const f = await fixture(kind),
      requestId = await f.record(),
      challenge = await f.challenge(requestId);
    f.trust.actorIds.push("worker");
    expect(f.verifier.verify(f.signed(challenge, { actorId: "worker" }))).toBe(false);
    await f.service.admitWorkerAnswer({
      ...(await f.mutation("answer")),
      answer: f.signed(challenge),
    });
    const replacement = generateKeyPairSync("ed25519");
    const revoked = f.serviceFor(
      f.store,
      new TrustedHumanAnswerVerifier([
        {
          ...f.trust,
          publicKeyPem: replacement.publicKey.export({ type: "spki", format: "pem" }).toString(),
        },
      ])
    );
    expect(
      await revoked.claimWorkerAnswerDelivery({
        ...(await f.mutation("claim")),
        requestId,
        claimId: randomUUID(),
      })
    ).toMatchObject({ ok: false, reason: "authenticated_worker_answer_missing" });
  });
});
