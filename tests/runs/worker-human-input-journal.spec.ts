import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  humanActionSummary,
  readHumanActionState,
  readWorkerHumanInputJournal,
} from "../../src/runs/agent-work-human-action-service.js";
import {
  WorkerHumanInputEvent,
  hashWorkerHumanInputEvent,
  type WorkerHumanInputEventRecord,
} from "../../src/schemas/worker-human-input-event.js";
import { workerHumanAnswerBindingHash } from "../../src/schemas/worker-human-answer.js";
import { WorkerHumanInputCapture } from "../../src/schemas/worker-human-input.js";
import type { CoordinationStore, JsonValue } from "../../src/store/coordination-store.js";
import { SqliteCoordinationStore } from "../../src/store/sqlite/coordination-store.js";
import { humanAnswerFixture } from "../store/worker-human-answer-fixture.js";

type Fixture = Awaited<ReturnType<typeof humanAnswerFixture>>;
const fixtures: Fixture[] = [];
const extraStores: CoordinationStore[] = [];
afterEach(async () => {
  await Promise.all(extraStores.splice(0).map((store) => store.close()));
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});
async function setup(kind: "memory" | "sqlite", freeText = false) {
  const f = await humanAnswerFixture(kind);
  fixtures.push(f);
  const capture = f.capture();
  if (freeText) capture.questions[0].allowOther = true;
  const requestId = await f.record(capture);
  const display = {
    ...(await f.mutation("display")),
    requestId,
    presentationId: randomUUID(),
    challengeId: randomUUID(),
    expiresAt: new Date(Date.parse(f.time) + 30_000).toISOString(),
  };
  const claimed = await f.service.claimWorkerQuestionPresentation(display);
  if (!claimed.ok || !("presentation" in claimed)) throw new Error("test display claim failed");
  const event = WorkerHumanInputEvent.parse({
    version: 1,
    eventId: randomUUID(),
    source: {
      hostSessionId: randomUUID(),
      connectionId: randomUUID(),
      profileId: "controlled-input-source",
      profileHash: "sha256:" + "a".repeat(64),
      runtimeHash: "sha256:" + "b".repeat(64),
    },
    input: {
      presentation: claimed.presentation,
      capture,
      answers: [{ questionId: "choice", value: "B" }],
      observedAt: f.time,
    },
  });
  const reserve = (reservationId = randomUUID()) => ({
    eventId: event.eventId,
    eventHash: hashWorkerHumanInputEvent(event),
    reservationId,
    source: structuredClone(event.source),
  });
  const journal = async () =>
    readWorkerHumanInputJournal((await f.store.getRunCoordination("run"))!.state);
  const held = async () => {
    const state = (await f.store.getRunCoordination("run"))!.state;
    expect(humanActionSummary(state, f.time)).toHaveLength(1);
    const entry = readHumanActionState(state).entries[0];
    expect(entry.receipt).toBeNull();
    expect(entry.workerAnswer).toBeUndefined();
    expect(entry.answerDelivery).toBeUndefined();
    expect(await f.service.getWorkerAnswer("run", requestId)).toBeNull();
  };
  return { f, display, event, reserve, journal, held };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function pausedRead(store: CoordinationStore) {
  const entered = deferred(),
    release = deferred();
  let paused = false;
  const wrapped = new Proxy(store, {
    get(target, key) {
      if (key === "getRunCoordination")
        return async (runId: string) => {
          if (!paused) {
            paused = true;
            entered.resolve();
            await release.promise;
          }
          return target.getRunCoordination(runId);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { wrapped, entered: entered.promise, release: release.resolve };
}
function lostAck(store: CoordinationStore) {
  let lost = false;
  return new Proxy(store, {
    get(target, key) {
      if (key === "compareAndSetRunState")
        return async (input: Parameters<CoordinationStore["compareAndSetRunState"]>[0]) => {
          const result = await target.compareAndSetRunState(input);
          if (result.updated && !lost) {
            lost = true;
            throw new Error("synthetic lost input-journal ACK");
          }
          return result;
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
function mustNotCommit(): never {
  throw new Error("historical replay invoked mutation guard");
}
async function replaceState(f: Fixture, state: JsonValue, mutationId: string) {
  const record = (await f.store.getRunCoordination("run"))!;
  const result = await f.store.compareAndSetRunState({
    ...f.controller,
    expectedRevision: record.revision,
    mutationId,
    state,
    event: { type: "controlled_test_state", payload: null },
    now: f.time,
  });
  if (!result.updated) throw new Error("test state setup refused");
}
function compactResult(result: unknown, authored: string) {
  const json = JSON.stringify(result);
  expect(json).not.toContain(authored);
  expect(json).not.toContain("authenticationEventId");
  expect(json).not.toContain("signature");
  expect(json).not.toContain("qualification");
  expect(json.length).toBeLessThan(512);
}

describe.each(["memory", "sqlite"] as const)(
  "non-authorizing worker input journal (%s)",
  (kind) => {
    it("records exact input and reserves local processing once, surviving reopen without staling the pending hold", async () => {
      const h = await setup(kind, true);
      const authored = "  private authored answer\r\n界 e\u0301  ";
      h.event.input.answers[0].value = authored;
      const recordInput = { ...(await h.f.mutation("event")), event: h.event };
      expect(await h.f.service.recordWorkerInputEvent(recordInput, () => true)).toMatchObject({
        ok: true,
        replay: false,
        eventHash: hashWorkerHumanInputEvent(h.event),
      });
      const reservation = h.reserve();
      const result = await h.f.service.reserveWorkerInputEvent(
        {
          ...(await h.f.mutation("reserve")),
          ...reservation,
        },
        () => true
      );
      expect(result).toMatchObject({ ok: true, replay: false, eventHash: reservation.eventHash });
      compactResult(result, authored);
      if (kind === "sqlite") await h.f.reopen();
      expect((await h.journal()).entries).toEqual([
        {
          event: h.event,
          eventHash: hashWorkerHumanInputEvent(h.event),
          recordedAt: h.f.time,
          reservation: { reservationId: reservation.reservationId, reservedAt: h.f.time },
        },
      ]);
      await h.held();
      // Independent controlled admission proves journaling did not change request context.
      const answer = h.f.signed(h.event.input.presentation.challenge, {
        answeredAt: h.f.time,
        answers: h.event.input.answers,
      });
      expect(
        await h.f.service.admitWorkerAnswer({
          ...(await h.f.mutation("independent-controlled-admission")),
          answer,
        })
      ).toMatchObject({ ok: true });
      expect(
        humanActionSummary((await h.f.store.getRunCoordination("run"))!.state, h.f.time)
      ).toHaveLength(1);
    });

    it("replays recorded and reserved facts read-only after a presentation closes and expires", async () => {
      const h = await setup(kind);
      expect(
        await h.f.service.recordWorkerInputEvent(
          {
            ...(await h.f.mutation("event")),
            event: h.event,
          },
          () => true
        )
      ).toMatchObject({ ok: true });
      const reservation = h.reserve();
      expect(
        await h.f.service.reserveWorkerInputEvent(
          {
            ...(await h.f.mutation("reserve")),
            ...reservation,
          },
          () => true
        )
      ).toMatchObject({ ok: true });
      expect(
        await h.f.service.closeWorkerQuestionPresentation({
          ...(await h.f.mutation("close")),
          requestId: h.display.requestId,
          presentationId: h.display.presentationId,
          disposition: "cancelled",
        })
      ).toMatchObject({ ok: true });
      if (kind === "sqlite") await h.f.reopen();
      const before = (await h.f.store.getRunCoordination("run"))!;
      const later = h.event.input.presentation.challenge.expiresAt;
      expect(
        await h.f.service.recordWorkerInputEvent(
          {
            ...(await h.f.mutation("historical-record", later)),
            event: h.event,
          },
          mustNotCommit
        )
      ).toMatchObject({ ok: true, replay: true, revision: before.revision });
      expect(
        await h.f.service.reserveWorkerInputEvent(
          {
            ...(await h.f.mutation("historical-reserve", later)),
            ...reservation,
          },
          mustNotCommit
        )
      ).toMatchObject({ ok: true, replay: true, revision: before.revision });
      expect(await h.f.store.getRunCoordination("run")).toEqual(before);
      await h.held();
    });

    it.each(["event-content", "same-presentation", "reservation", "hash", "source"] as const)(
      "refuses %s conflict without replacing the original record or reservation",
      async (attack) => {
        const h = await setup(kind);
        expect(
          await h.f.service.recordWorkerInputEvent(
            {
              ...(await h.f.mutation("event")),
              event: h.event,
            },
            () => true
          )
        ).toMatchObject({ ok: true });
        const reservation = h.reserve();
        expect(
          await h.f.service.reserveWorkerInputEvent(
            {
              ...(await h.f.mutation("reserve")),
              ...reservation,
            },
            () => true
          )
        ).toMatchObject({ ok: true });
        const before = (await h.f.store.getRunCoordination("run"))!;
        let result: unknown;
        if (attack === "event-content" || attack === "same-presentation") {
          const event = structuredClone(h.event);
          if (attack === "event-content") event.input.answers[0].value = "A";
          else event.eventId = randomUUID();
          result = await h.f.service.recordWorkerInputEvent(
            {
              ...(await h.f.mutation("conflict")),
              event,
            },
            () => true
          );
        } else {
          const conflicting = structuredClone(reservation);
          if (attack === "reservation") conflicting.reservationId = randomUUID();
          if (attack === "hash") conflicting.eventHash = "sha256:" + "f".repeat(64);
          if (attack === "source") conflicting.source.connectionId = randomUUID();
          result = await h.f.service.reserveWorkerInputEvent(
            {
              ...(await h.f.mutation("conflict")),
              ...conflicting,
            },
            () => true
          );
        }
        expect(result).toMatchObject({ ok: false });
        expect(await h.f.store.getRunCoordination("run")).toEqual(before);
        await h.held();
      }
    );

    it.each(["record", "reserve"] as const)(
      "retains a %s commit through a lost ACK and replays without another write",
      async (operation) => {
        const h = await setup(kind);
        if (operation === "reserve")
          expect(
            await h.f.service.recordWorkerInputEvent(
              {
                ...(await h.f.mutation("event")),
                event: h.event,
              },
              () => true
            )
          ).toMatchObject({ ok: true });
        const uncertain = h.f.serviceFor(lostAck(h.f.store));
        const mutation = await h.f.mutation("uncertain");
        const reservation = h.reserve();
        const action =
          operation === "record"
            ? () => uncertain.recordWorkerInputEvent({ ...mutation, event: h.event }, () => true)
            : () => uncertain.reserveWorkerInputEvent({ ...mutation, ...reservation }, () => true);
        await expect(action()).rejects.toThrow("synthetic lost input-journal ACK");
        if (kind === "sqlite") await h.f.reopen();
        const committed = (await h.f.store.getRunCoordination("run"))!;
        const result =
          operation === "record"
            ? await h.f.service.recordWorkerInputEvent(
                { ...mutation, event: h.event },
                mustNotCommit
              )
            : await h.f.service.reserveWorkerInputEvent(
                { ...mutation, ...reservation },
                mustNotCommit
              );
        expect(result).toMatchObject({ ok: true, replay: true, revision: committed.revision });
        expect(await h.f.store.getRunCoordination("run")).toEqual(committed);
        expect((await h.journal()).entries).toHaveLength(1);
        await h.held();
      }
    );

    it.each(["record", "reserve"] as const)(
      "vetoes %s immediately before commit without consuming its identity",
      async (operation) => {
        const h = await setup(kind);
        if (operation === "reserve")
          expect(
            await h.f.service.recordWorkerInputEvent(
              {
                ...(await h.f.mutation("event")),
                event: h.event,
              },
              () => true
            )
          ).toMatchObject({ ok: true });
        const before = (await h.f.store.getRunCoordination("run"))!;
        const mutation = await h.f.mutation("cancelled");
        const reservation = h.reserve();
        const execute = (guard: () => boolean) =>
          operation === "record"
            ? h.f.service.recordWorkerInputEvent({ ...mutation, event: h.event }, guard)
            : h.f.service.reserveWorkerInputEvent({ ...mutation, ...reservation }, guard);
        let guardCalls = 0;
        expect(
          await execute(() => {
            guardCalls++;
            return false;
          })
        ).toMatchObject({ ok: false });
        expect(guardCalls).toBeGreaterThan(0);
        expect(await h.f.store.getRunCoordination("run")).toEqual(before);
        expect(await execute(() => true)).toMatchObject({ ok: true, replay: false });
        await h.held();
      }
    );

    it.each(["record", "reserve"] as const)(
      "requires an explicit synchronous guard for new %s mutations",
      async (operation) => {
        const h = await setup(kind);
        if (operation === "reserve")
          expect(
            await h.f.service.recordWorkerInputEvent(
              {
                ...(await h.f.mutation("event")),
                event: h.event,
              },
              () => true
            )
          ).toMatchObject({ ok: true });
        const before = (await h.f.store.getRunCoordination("run"))!;
        const missing = undefined as unknown as () => boolean;
        const mutation = await h.f.mutation("unguarded");
        const result =
          operation === "record"
            ? await h.f.service.recordWorkerInputEvent({ ...mutation, event: h.event }, missing)
            : await h.f.service.reserveWorkerInputEvent({ ...mutation, ...h.reserve() }, missing);
        expect(result).toMatchObject({ ok: false, reason: "input_event_guard_required" });
        expect(await h.f.store.getRunCoordination("run")).toEqual(before);
      }
    );

    it("snapshots public record and reservation inputs before an awaited store read", async () => {
      const h = await setup(kind);
      const original = structuredClone(h.event);
      const pause = pausedRead(h.f.store);
      const service = h.f.serviceFor(pause.wrapped);
      const recordInput = {
        ...structuredClone(await h.f.mutation("snapshot-record")),
        event: h.event,
      };
      const pending = service.recordWorkerInputEvent(recordInput, () => true);
      await pause.entered;
      h.event.input.answers[0].value = "A";
      h.event.source.profileId = "caller mutation";
      recordInput.controller.runId = "changed-run";
      pause.release();
      expect(await pending).toMatchObject({
        ok: true,
        eventHash: hashWorkerHumanInputEvent(original),
      });
      expect((await h.journal()).entries[0].event).toEqual(original);
      const reservePause = pausedRead(h.f.store);
      const reserveService = h.f.serviceFor(reservePause.wrapped);
      const reservation = {
        ...structuredClone(await h.f.mutation("snapshot-reserve")),
        eventId: original.eventId,
        eventHash: hashWorkerHumanInputEvent(original),
        reservationId: randomUUID(),
        source: structuredClone(original.source),
      };
      const pendingReserve = reserveService.reserveWorkerInputEvent(reservation, () => true);
      await reservePause.entered;
      reservation.source.connectionId = randomUUID();
      reservation.controller.runId = "changed-reserve-run";
      reservePause.release();
      expect(await pendingReserve).toMatchObject({ ok: true });
      await h.held();
    });

    it.each(["expired", "closed", "changed-context"] as const)(
      "refuses new recording or reservation for %s input",
      async (boundary) => {
        const h = await setup(kind);
        expect(
          await h.f.service.recordWorkerInputEvent(
            {
              ...(await h.f.mutation("event")),
              event: h.event,
            },
            () => true
          )
        ).toMatchObject({ ok: true });
        let now = h.f.time;
        if (boundary === "expired") now = h.event.input.presentation.challenge.expiresAt;
        if (boundary === "closed")
          expect(
            await h.f.service.closeWorkerQuestionPresentation({
              ...(await h.f.mutation("close")),
              requestId: h.display.requestId,
              presentationId: h.display.presentationId,
              disposition: "cancelled",
            })
          ).toMatchObject({ ok: true });
        if (boundary === "changed-context") {
          const state = structuredClone((await h.f.store.getRunCoordination("run"))!.state) as any;
          state.task = "another task";
          await replaceState(h.f, state, "changed-context");
        }
        const before = (await h.f.store.getRunCoordination("run"))!;
        expect(
          await h.f.service.reserveWorkerInputEvent(
            {
              ...(await h.f.mutation("late-reserve", now)),
              ...h.reserve(),
            },
            () => true
          )
        ).toMatchObject({ ok: false });
        const different = structuredClone(h.event);
        different.eventId = randomUUID();
        expect(
          await h.f.service.recordWorkerInputEvent(
            {
              ...(await h.f.mutation("late-record", now)),
              event: different,
            },
            () => true
          )
        ).toMatchObject({ ok: false });
        expect(await h.f.store.getRunCoordination("run")).toEqual(before);
        await h.held();
      }
    );

    it("preserves historical events while explicit recovery records and reserves the fresh presentation", async () => {
      const h = await setup(kind);
      expect(
        await h.f.service.recordWorkerInputEvent(
          {
            ...(await h.f.mutation("old-event")),
            event: h.event,
          },
          () => true
        )
      ).toMatchObject({ ok: true });
      const oldReservation = h.reserve();
      expect(
        await h.f.service.reserveWorkerInputEvent(
          {
            ...(await h.f.mutation("old-reservation")),
            ...oldReservation,
          },
          () => true
        )
      ).toMatchObject({ ok: true });
      expect(
        await h.f.service.closeWorkerQuestionPresentation({
          ...(await h.f.mutation("close-old")),
          requestId: h.display.requestId,
          presentationId: h.display.presentationId,
          disposition: "declined",
        })
      ).toMatchObject({ ok: true });
      const recovered = await h.f.service.claimWorkerQuestionPresentation({
        ...h.display,
        ...(await h.f.mutation("recover")),
        previousPresentationId: h.display.presentationId,
        presentationId: randomUUID(),
        challengeId: randomUUID(),
      });
      if (!recovered.ok || !("presentation" in recovered)) throw new Error("test recovery failed");
      const fresh = structuredClone(h.event);
      fresh.eventId = randomUUID();
      fresh.input.presentation = recovered.presentation;
      fresh.source.connectionId = randomUUID();
      expect(
        await h.f.service.recordWorkerInputEvent(
          {
            ...(await h.f.mutation("fresh-event")),
            event: fresh,
          },
          () => true
        )
      ).toMatchObject({ ok: true });
      expect(
        await h.f.service.reserveWorkerInputEvent(
          {
            ...(await h.f.mutation("old-reserve")),
            ...h.reserve(),
          },
          () => true
        )
      ).toMatchObject({ ok: false });
      expect(
        await h.f.service.reserveWorkerInputEvent(
          {
            ...(await h.f.mutation("reused-reservation")),
            eventId: fresh.eventId,
            eventHash: hashWorkerHumanInputEvent(fresh),
            reservationId: oldReservation.reservationId,
            source: fresh.source,
          },
          () => true
        )
      ).toMatchObject({ ok: false, reason: "input_reservation_conflict" });
      expect(
        await h.f.service.reserveWorkerInputEvent(
          {
            ...(await h.f.mutation("fresh-reserve")),
            eventId: fresh.eventId,
            eventHash: hashWorkerHumanInputEvent(fresh),
            reservationId: randomUUID(),
            source: fresh.source,
          },
          () => true
        )
      ).toMatchObject({ ok: true });
      if (kind === "sqlite") await h.f.reopen();
      expect((await h.journal()).entries.map((entry) => entry.event)).toEqual([h.event, fresh]);
      await h.held();
    });

    it.each(["hash", "duplicate"] as const)(
      "fails closed on malformed retained %s without repairing or writing state",
      async (attack) => {
        const h = await setup(kind);
        expect(
          await h.f.service.recordWorkerInputEvent(
            {
              ...(await h.f.mutation("event")),
              event: h.event,
            },
            () => true
          )
        ).toMatchObject({ ok: true });
        const state = structuredClone((await h.f.store.getRunCoordination("run"))!.state) as any;
        const entries = state.metadata.agentWorkHumanActions.entries[0].inputEvents;
        if (attack === "hash") entries[0].eventHash = "sha256:" + "f".repeat(64);
        else entries.push(structuredClone(entries[0]));
        await replaceState(h.f, state, "controlled-corruption");
        expect(() => readWorkerHumanInputJournal(state)).toThrow();
        const before = (await h.f.store.getRunCoordination("run"))!;
        await expect(
          h.f.service.reserveWorkerInputEvent(
            {
              ...(await h.f.mutation("corrupt-reserve")),
              ...h.reserve(),
            },
            () => true
          )
        ).rejects.toThrow();
        expect(await h.f.store.getRunCoordination("run")).toEqual(before);
      }
    );
  }
);

describe("durable input-journal store boundaries", () => {
  it("serializes independent SQLite writers so duplicate/conflicting records and reservations cannot overwrite a winner", async () => {
    const h = await setup("sqlite");
    const secondary = new SqliteCoordinationStore(h.f.path);
    extraStores.push(secondary);
    const other = h.f.serviceFor(secondary);
    const left = await h.f.mutation("race-record-a");
    const right = { ...left, mutationId: "race-record-b" };
    const results = await Promise.all([
      h.f.service.recordWorkerInputEvent({ ...left, event: h.event }, () => true),
      other.recordWorkerInputEvent({ ...right, event: h.event }, () => true),
    ]);
    expect(results.filter((result) => result.ok && !result.replay)).toHaveLength(1);
    expect((await h.journal()).entries).toHaveLength(1);
    expect(
      await other.recordWorkerInputEvent(
        {
          ...(await h.f.mutation("read-duplicate")),
          event: h.event,
        },
        mustNotCommit
      )
    ).toMatchObject({ ok: true, replay: true });
    const reservationA = h.reserve(),
      reservationB = h.reserve();
    const reserveMutation = await h.f.mutation("race-reserve-a");
    const reservations = await Promise.all([
      h.f.service.reserveWorkerInputEvent({ ...reserveMutation, ...reservationA }, () => true),
      other.reserveWorkerInputEvent(
        {
          ...reserveMutation,
          mutationId: "race-reserve-b",
          ...reservationB,
        },
        () => true
      ),
    ]);
    expect(reservations.filter((result) => result.ok && !result.replay)).toHaveLength(1);
    const winner = (await h.journal()).entries[0].reservation!;
    expect([reservationA.reservationId, reservationB.reservationId]).toContain(
      winner.reservationId
    );
    const loser = winner.reservationId === reservationA.reservationId ? reservationB : reservationA;
    expect(
      await other.reserveWorkerInputEvent(
        {
          ...(await h.f.mutation("loser-retry")),
          ...loser,
        },
        () => true
      )
    ).toMatchObject({ ok: false });
    expect((await h.journal()).entries[0].reservation).toEqual(winner);
    await h.held();
  });

  it.each(["memory", "sqlite"] as const)(
    "retains all 128 %s events at capacity and refuses an append without eviction",
    async (kind) => {
      const h = await setup(kind);
      const state = structuredClone((await h.f.store.getRunCoordination("run"))!.state) as any;
      const original = state.metadata.agentWorkHumanActions.entries[0];
      const heldEntries = [];
      let overflow!: WorkerHumanInputEvent;
      for (let entryIndex = 0; entryIndex < 9; entryIndex++) {
        const entry = structuredClone(original);
        const capture = h.f.capture();
        entry.workerInput = capture;
        entry.request.request_id = "worker-input:" + capture.observationId;
        entry.presentations = [];
        const count = entryIndex < 8 ? 16 : 1;
        let previous: string | undefined;
        const records: WorkerHumanInputEventRecord[] = [];
        for (let index = 0; index < count; index++) {
          const challenge = {
            ...h.event.input.presentation.challenge,
            requestId: entry.request.request_id,
            challengeId: randomUUID(),
            generation: index + 1,
            bindingHash: workerHumanAnswerBindingHash(entry.request, entry.contextHash, capture),
          };
          const presentation = {
            presentationId: randomUUID(),
            ...(previous ? { previousPresentationId: previous } : {}),
            challenge,
            disposition: index === count - 1 ? ("active" as const) : ("cancelled" as const),
            ...(index === count - 1 ? {} : { closedAt: h.f.time }),
          };
          previous = presentation.presentationId;
          entry.presentations.push(presentation);
          entry.answerChallenge = challenge;
          const event = WorkerHumanInputEvent.parse({
            ...h.event,
            eventId: randomUUID(),
            input: {
              ...h.event.input,
              presentation: { ...presentation, disposition: "active", closedAt: undefined },
              capture,
            },
          });
          if (entryIndex === 8) overflow = event;
          else
            records.push({
              event,
              eventHash: hashWorkerHumanInputEvent(event),
              recordedAt: h.f.time,
            });
        }
        if (records.length > 0) entry.inputEvents = records;
        heldEntries.push(entry);
      }
      state.metadata.agentWorkHumanActions.entries = heldEntries;
      await replaceState(h.f, state, "seed-capacity");
      const before = (await h.f.store.getRunCoordination("run"))!;
      expect(readWorkerHumanInputJournal(before.state).entries).toHaveLength(128);
      expect(
        await h.f.service.recordWorkerInputEvent(
          {
            ...(await h.f.mutation("overflow")),
            event: overflow,
          },
          () => true
        )
      ).toMatchObject({ ok: false });
      if (kind === "sqlite") await h.f.reopen();
      expect((await h.journal()).entries).toHaveLength(128);
      expect(await h.f.store.getRunCoordination("run")).toEqual(before);
    }
  );
});

function wideCapture(original: ReturnType<Fixture["capture"]>) {
  return WorkerHumanInputCapture.parse({
    ...original,
    questions: Array.from({ length: 8 }, (_, index) => ({
      ...original.questions[0],
      id: "wide-" + index,
      options: null,
      allowOther: true,
    })),
  });
}
function sizedEvent(template: WorkerHumanInputEvent, targetBytes: number) {
  const event = structuredClone(template);
  event.input.capture = wideCapture(event.input.capture);
  event.input.answers = event.input.capture.questions.map((question) => ({
    questionId: question.id,
    value: "界".repeat(2200),
  }));
  let remaining = targetBytes - Buffer.byteLength(JSON.stringify(event), "utf8");
  if (remaining < 0) throw new Error("byte fixture exceeds requested size");
  for (const answer of event.input.answers) {
    const count = Math.min(4096 - answer.value.length, remaining);
    answer.value += "x".repeat(count);
    remaining -= count;
  }
  if (remaining !== 0) throw new Error("byte fixture cannot reach requested size");
  return event;
}

describe("input-journal byte bounds", () => {
  it("accepts exactly 64KiB of valid event JSON and rejects one additional UTF-8 byte", async () => {
    const h = await setup("memory");
    const exact = sizedEvent(h.event, 64 * 1024);
    expect(Buffer.byteLength(JSON.stringify(exact), "utf8")).toBe(64 * 1024);
    expect(WorkerHumanInputEvent.safeParse(exact).success).toBe(true);
    const overflow = structuredClone(exact);
    const answer = overflow.input.answers.find((value) => value.value.length < 4096)!;
    answer.value += "x";
    expect(Buffer.byteLength(JSON.stringify(overflow), "utf8")).toBe(64 * 1024 + 1);
    expect(WorkerHumanInputEvent.safeParse(overflow).success).toBe(false);
  });

  it.each(["memory", "sqlite"] as const)(
    "refuses a %s append that crosses the aggregate 1MiB bound without losing existing events",
    async (kind) => {
      const h = await setup(kind);
      const state = structuredClone((await h.f.store.getRunCoordination("run"))!.state) as any;
      const original = state.metadata.agentWorkHumanActions.entries[0];
      const entries = [];
      let overflow!: WorkerHumanInputEvent;
      for (let entryIndex = 0; entryIndex < 2; entryIndex++) {
        const entry = structuredClone(original);
        const capture = wideCapture(h.f.capture());
        entry.workerInput = capture;
        entry.request.request_id = "worker-input:" + capture.observationId;
        entry.presentations = [];
        const records: WorkerHumanInputEventRecord[] = [];
        const count = entryIndex === 0 ? 16 : 2;
        let previous: string | undefined;
        for (let index = 0; index < count; index++) {
          const challenge = {
            ...h.event.input.presentation.challenge,
            requestId: entry.request.request_id,
            challengeId: randomUUID(),
            generation: index + 1,
            bindingHash: workerHumanAnswerBindingHash(entry.request, entry.contextHash, capture),
          };
          const active = {
            presentationId: randomUUID(),
            ...(previous ? { previousPresentationId: previous } : {}),
            challenge,
            disposition: "active" as const,
          };
          entry.presentations.push(
            index === count - 1
              ? active
              : { ...active, disposition: "cancelled", closedAt: h.f.time }
          );
          previous = active.presentationId;
          entry.answerChallenge = challenge;
          const event = WorkerHumanInputEvent.parse(
            sizedEvent(
              {
                ...h.event,
                eventId: randomUUID(),
                input: { ...h.event.input, presentation: active, capture },
              },
              59_000
            )
          );
          if (entryIndex === 1 && index === 1) overflow = event;
          else
            records.push({
              event,
              eventHash: hashWorkerHumanInputEvent(event),
              recordedAt: h.f.time,
            });
        }
        entry.inputEvents = records;
        entries.push(entry);
      }
      state.metadata.agentWorkHumanActions.entries = entries;
      await replaceState(h.f, state, "seed-byte-capacity");
      const before = (await h.f.store.getRunCoordination("run"))!;
      const retained = readWorkerHumanInputJournal(before.state).entries;
      expect(retained).toHaveLength(17);
      expect(Buffer.byteLength(JSON.stringify(retained), "utf8")).toBeLessThan(1024 * 1024);
      expect(
        Buffer.byteLength(
          JSON.stringify([
            ...retained,
            {
              event: overflow,
              eventHash: hashWorkerHumanInputEvent(overflow),
              recordedAt: h.f.time,
            },
          ]),
          "utf8"
        )
      ).toBeGreaterThan(1024 * 1024);
      expect(
        await h.f.service.recordWorkerInputEvent(
          {
            ...(await h.f.mutation("byte-overflow")),
            event: overflow,
          },
          () => true
        )
      ).toMatchObject({ ok: false, reason: "input_event_byte_capacity" });
      if (kind === "sqlite") await h.f.reopen();
      expect((await h.journal()).entries).toEqual(retained);
      expect(await h.f.store.getRunCoordination("run")).toEqual(before);
    }
  );
});
