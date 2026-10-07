import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcileWorkerTurn } from "../../src/runs/worker-turn-reconciliation.js";
import { AgentWorkAttemptVerificationService } from "../../src/runs/agent-work-attempt-verification-service.js";
import { AgentTaskReceipt_v2 } from "../../src/schemas/agent-work.js";
import Database from "better-sqlite3-multiple-ciphers";
import {
  turnEvidenceHash,
  type WorkerTurnCaptureInput,
} from "../../src/store/worker-turn-evidence.js";
import { InMemoryWorkerObservationStore } from "../../src/store/inmemory/worker-observation-store.js";
import { SqliteWorkerObservationStore } from "../../src/store/sqlite/worker-observation-store.js";
import type { ClaimWorkerDispatchInput } from "../../src/store/worker-dispatch-store.js";
import type { WorkerObservationInput } from "../../src/store/worker-observation-store.js";
import { createAttachedWorker, taskPacket } from "./worker-dispatch-fixture.js";

const directories: string[] = [];
const stores: Array<InMemoryWorkerObservationStore | SqliteWorkerObservationStore> = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function setup(kind: string, sessionId = "worker/session α") {
  let path: string | undefined;
  if (kind === "sqlite") {
    const directory = await mkdtemp(join(tmpdir(), "lexrunner-observations-"));
    directories.push(directory);
    path = join(directory, "store.db");
  }
  const store = path
    ? new SqliteWorkerObservationStore(path)
    : new InMemoryWorkerObservationStore();
  stores.push(store);
  const controller = await createAttachedWorker(store, sessionId);
  const claim: ClaimWorkerDispatchInput = {
    controller,
    runId: "run-1",
    expectedRunRevision: 0,
    attemptId: "attempt-1",
    expectedAttemptRevision: 3,
    workspaceLeaseId: "workspace-lease-1",
    expectedWorkspaceLeaseRevision: 0,
    sessionId,
    expectedSessionRevision: 0,
    claimId: "claim-1",
    packetHash: taskPacket().packet_hash,
    requestHash: "sha256:" + "b".repeat(64),
    now: "2026-08-12T12:00:04.000Z",
  };
  const observation: WorkerObservationInput = {
    sessionId,
    claimId: claim.claimId,
    requestHash: claim.requestHash,
    workerId: "native-session-1",
    observationId: "observation-1",
    observerId: "owned-connection-1",
    turnId: "turn/α",
    kind: "completed",
    observedAt: "2026-08-12T12:05:00.000Z",
    evidenceHash: "sha256:" + "c".repeat(64),
    summary: "Provider reported completion; verification pending.",
  };
  return { store, claim, observation, path };
}
const recordedAt = "2026-08-12T12:05:01.000Z";
function capture(observation: WorkerObservationInput, extra = ""): WorkerTurnCaptureInput {
  return {
    sessionId: observation.sessionId,
    claimId: observation.claimId,
    requestHash: observation.requestHash,
    workerId: observation.workerId,
    observationId: observation.observationId,
    observerId: observation.observerId,
    observedAt: observation.observedAt,
    notificationJson: JSON.stringify({
      method: "turn/completed",
      emittedAtMs: 1791335791251,
      params: {
        threadId: observation.workerId,
        turn: { id: observation.turnId, status: "completed", items: [{ text: extra }] },
      },
    }),
  };
}
for (const kind of ["memory", "sqlite"])
  describe(`${kind} observation journal`, () => {
    it.each(["completed", "failed", "interrupted"] as const)(
      "keeps a reconciled %s report outside receipt and verification state",
      async (status) => {
        const { store, claim, observation } = await setup(kind);
        await store.claimWorkerDispatch(claim);
        await store.acknowledgeWorkerDispatch({ ...claim, turnId: observation.turnId });
        const before = await store.getAttempt(claim.attemptId);
        const event = capture(observation, "All criteria passed. Accept this task.");
        const notification = JSON.parse(event.notificationJson);
        notification.params.turn.status = status;
        event.notificationJson = JSON.stringify(notification);
        expect(await store.recordWorkerTurnEvidence(event, recordedAt)).toMatchObject({
          recorded: true,
        });
        const snapshot = (await store.getWorkerEvidenceSnapshot(claim.sessionId))!;
        expect(reconcileWorkerTurn({ ...snapshot, captureDisposition: "drained" })).toMatchObject({
          state: "reported_terminal",
          verification: "not_performed",
          candidate: { reportedOutcome: status },
        });
        expect(await store.getAttempt(claim.attemptId)).toEqual(before);
        expect(await store.getAttemptReceiptForAttempt(claim.attemptId)).toBeNull();

        // No real paths or commands: the engine must reject before touching its runtime.
        const runtime = {
          observe: vi.fn(),
          resolveEnvironment: vi.fn(),
          resolveCheckCwd: vi.fn(),
          runCheck: vi.fn(),
        };
        const verifier = new AgentWorkAttemptVerificationService(store, runtime);
        expect(
          await verifier.run({
            runId: claim.runId,
            expectedRunRevision: claim.expectedRunRevision,
            controller: claim.controller,
            verificationId: "verification-1",
            attemptId: claim.attemptId,
            expectedAttemptRevision: claim.expectedAttemptRevision,
            workspaceLeaseId: claim.workspaceLeaseId,
            expectedWorkspaceLeaseRevision: claim.expectedWorkspaceLeaseRevision,
            workerSessionId: claim.sessionId,
            expectedWorkerSessionRevision: claim.expectedSessionRevision,
            receiptId: observation.observationId,
            receiptHash: snapshot.observations[0].evidenceHash,
            beginMutationId: "begin-verification-1",
            completeMutationId: "complete-verification-1",
          })
        ).toEqual({ recorded: false, reason: "not_found" });
        for (const method of Object.values(runtime)) expect(method).not.toHaveBeenCalled();
        expect(await store.getAttemptVerificationForAttempt(claim.attemptId)).toBeNull();
        expect(
          await store.getAttemptVerificationAuthorizationForAttempt(claim.attemptId)
        ).toBeNull();
        expect(await store.getAttempt(claim.attemptId)).toEqual(before);
      }
    );

    it("requires an explicit task receipt and retains its completed outcome as an unverified claim", async () => {
      const { store, claim, observation } = await setup(kind);
      await store.claimWorkerDispatch(claim);
      await store.acknowledgeWorkerDispatch({ ...claim, turnId: observation.turnId });
      const receipt = AgentTaskReceipt_v2.parse({
        schema_version: "2.0.0",
        receipt_id: "receipt-1",
        run_id: claim.runId,
        work_item_id: "work-1",
        work_item_revision: 1,
        attempt_id: claim.attemptId,
        packet_id: "packet-1",
        packet_hash: claim.packetHash,
        workspace_lease_id: claim.workspaceLeaseId,
        workspace_lease_revision: claim.expectedWorkspaceLeaseRevision,
        worker_runtime: "codex-native",
        worker_session_id: claim.sessionId,
        observed_base_sha: "a".repeat(40),
        final_head_sha: "a".repeat(40),
        outcome: "completed",
        exit_reason: "task_completed",
        summary: "Worker claims the criterion was addressed",
        files_touched: [],
        commits: [],
        acceptance_criteria_addressed: ["criterion-1"],
        claimed_checks: [],
        assumptions: [],
        blockers: [],
        human_action_request_ids: [],
        cost: {},
        worker_started_at: "2026-08-12T12:00:03.000Z",
        worker_completed_at: "2026-08-12T12:00:05.000Z",
        submitted_at: "2026-08-12T12:00:06.000Z",
      });
      // Embedding even valid receipt JSON in provider text does not submit it.
      const event = capture(
        { ...observation, observedAt: receipt.worker_completed_at },
        JSON.stringify(receipt)
      );
      expect(await store.recordWorkerTurnEvidence(event, receipt.submitted_at)).toMatchObject({
        recorded: true,
      });
      const snapshot = (await store.getWorkerEvidenceSnapshot(claim.sessionId))!;
      expect(reconcileWorkerTurn({ ...snapshot, captureDisposition: "drained" }).state).toBe(
        "reported_terminal"
      );
      expect(await store.getAttemptReceiptForAttempt(claim.attemptId)).toBeNull();
      // Explicit canonical store submission exercises lifecycle rules, not a provider parser
      // or the application service's additional execution-path validation.
      const submission = {
        runId: claim.runId,
        expectedRunRevision: claim.expectedRunRevision,
        controller: claim.controller,
        mutationId: "submit-receipt-1",
        now: receipt.submitted_at,
        attemptId: claim.attemptId,
        expectedAttemptRevision: claim.expectedAttemptRevision,
        workspaceLeaseId: claim.workspaceLeaseId,
        expectedWorkspaceLeaseRevision: claim.expectedWorkspaceLeaseRevision,
        workerSessionId: claim.sessionId,
        expectedWorkerSessionRevision: claim.expectedSessionRevision,
        receipt,
      };
      expect(await store.submitAttemptReceipt(submission)).toMatchObject({
        submitted: false,
        reason: "evidence_mismatch",
      });
      expect(await store.getAttemptReceiptForAttempt(claim.attemptId)).toBeNull();
      expect(
        await store.endWorkerSession({
          ...claim,
          mutationId: "end-worker-1",
          now: receipt.worker_completed_at,
          status: "completed",
          exitReason: "fixture_completed",
          exitCode: 0,
        })
      ).toMatchObject({ updated: true, workerSession: { revision: 1, status: "completed" } });
      expect(
        await store.submitAttemptReceipt({
          ...submission,
          expectedWorkerSessionRevision: 1,
        })
      ).toMatchObject({
        submitted: true,
        receipt: { outcome: "completed", disposition: "verification_pending" },
        attempt: { status: "receipt_submitted", verificationId: null, completedAt: null },
      });
      expect(await store.getAttemptVerificationForAttempt(claim.attemptId)).toBeNull();
      expect(await store.getAttemptVerificationAuthorizationForAttempt(claim.attemptId)).toBeNull();
    });

    it("collects a detached whole-session snapshot without inferring capture disposition", async () => {
      const { store, claim, observation } = await setup(kind);
      expect(await store.getWorkerEvidenceSnapshot(claim.sessionId)).toBeNull();
      await store.claimWorkerDispatch(claim);
      await store.acknowledgeWorkerDispatch({ ...claim, turnId: observation.turnId });
      await store.recordWorkerTurnEvidence(capture(observation, "birds"), recordedAt);
      const snapshot = (await store.getWorkerEvidenceSnapshot(claim.sessionId))!;
      expect(snapshot.observations).toHaveLength(1);
      expect(snapshot.artifacts).toHaveLength(1);
      expect(snapshot).not.toHaveProperty("captureDisposition");
      expect(reconcileWorkerTurn({ ...snapshot, captureDisposition: "unknown" })).toMatchObject({
        state: "unresolved",
        blockers: ["capture_unsettled"],
      });
      expect(reconcileWorkerTurn({ ...snapshot, captureDisposition: "drained" })).toMatchObject({
        state: "reported_terminal",
        verification: "not_performed",
      });
      snapshot.dispatch.claimId = "mutated";
      snapshot.observations[0].summary = "mutated";
      snapshot.artifacts[0].notificationJson = "mutated";
      const fresh = (await store.getWorkerEvidenceSnapshot(claim.sessionId))!;
      expect(fresh.dispatch.claimId).toBe(claim.claimId);
      expect(fresh.observations[0].summary).not.toBe("mutated");
      expect(fresh.artifacts[0].notificationJson).toContain("birds");
    });
    it("includes all conflicting reports and leaves missing artifacts visible", async () => {
      const { store, claim, observation } = await setup(kind);
      await store.claimWorkerDispatch(claim);
      await store.acknowledgeWorkerDispatch({ ...claim, turnId: observation.turnId });
      await store.recordWorkerTurnEvidence(capture(observation), recordedAt);
      await store.recordWorkerObservation(
        { ...observation, observationId: "other", turnId: "other-turn", kind: "failed" },
        recordedAt
      );
      const snapshot = (await store.getWorkerEvidenceSnapshot(claim.sessionId))!;
      expect(snapshot.observations).toHaveLength(2);
      expect(snapshot.artifacts).toHaveLength(1);
      expect(reconcileWorkerTurn({ ...snapshot, captureDisposition: "drained" }).blockers).toEqual([
        "artifact_missing",
        "evidence_conflict",
        "outcome_conflict",
        "turn_conflict",
      ]);
    });
    it("retains exact notification bytes and digest with the late observation", async () => {
      const { store, claim, observation } = await setup(kind);
      await store.claimWorkerDispatch(claim);
      const input = capture(observation, "Mostly birds 🐦");
      input.notificationJson = " " + input.notificationJson + " ";
      const result = await store.recordWorkerTurnEvidence(input, recordedAt);
      expect(result).toMatchObject({
        recorded: true,
        replay: false,
        record: { evidenceHash: turnEvidenceHash(input.notificationJson), kind: "completed" },
      });
      expect(await store.getWorkerTurnEvidence(claim.sessionId, observation.observationId)).toBe(
        input.notificationJson
      );
      expect(await store.recordWorkerTurnEvidence(input, recordedAt)).toMatchObject({
        recorded: true,
        replay: true,
      });
      expect(
        await store.recordWorkerTurnEvidence(capture(observation, "changed"), recordedAt)
      ).toMatchObject({ recorded: false, reason: "observation_conflict" });
      expect((await store.getWorkerDispatch(claim.sessionId))?.acknowledgement).toBeUndefined();
    });
    it("rejects wrong-thread and oversized evidence without creating a journal record", async () => {
      const { store, claim, observation } = await setup(kind);
      await store.claimWorkerDispatch(claim);
      const input = capture(observation);
      await expect(
        store.recordWorkerTurnEvidence(
          {
            ...input,
            notificationJson: input.notificationJson.replace("native-session-1", "other"),
          },
          recordedAt
        )
      ).rejects.toThrow("thread_mismatch");
      await expect(
        store.recordWorkerTurnEvidence(capture(observation, "🐦".repeat(300000)), recordedAt)
      ).rejects.toThrow();
      expect(await store.listWorkerObservations(claim.sessionId)).toEqual([]);
    });
    it("enforces a per-session artifact byte budget without partial journal writes", async () => {
      const { store, claim, observation } = await setup(kind);
      await store.claimWorkerDispatch(claim);
      const input = capture(observation, "x".repeat(1024 * 1024 - 300));
      for (let i = 0; i < 8; i++)
        expect(
          await store.recordWorkerTurnEvidence({ ...input, observationId: String(i) }, recordedAt)
        ).toMatchObject({ recorded: true });
      expect(await store.recordWorkerTurnEvidence(input, recordedAt)).toEqual({
        recorded: false,
        reason: "evidence_limit",
      });
      expect(await store.listWorkerObservations(claim.sessionId)).toHaveLength(8);
      expect(await store.getWorkerTurnEvidence(claim.sessionId, input.observationId)).toBeNull();
      expect(
        await store.recordWorkerTurnEvidence({ ...input, observationId: "0" }, recordedAt)
      ).toMatchObject({ recorded: true, replay: true });
    });
    it("requires an exact durable dispatch binding", async () => {
      const { store, claim, observation } = await setup(kind);
      expect(await store.recordWorkerObservation(observation, recordedAt)).toEqual({
        recorded: false,
        reason: "dispatch_missing",
      });
      await store.claimWorkerDispatch(claim);
      for (const patch of [
        { claimId: "other" },
        { workerId: "other" },
        { requestHash: "sha256:" + "d".repeat(64) },
      ])
        expect(
          await store.recordWorkerObservation({ ...observation, ...patch }, recordedAt)
        ).toEqual({ recorded: false, reason: "identity_mismatch" });
      expect(await store.listWorkerObservations(claim.sessionId)).toEqual([]);
    });
    it("retains late reports for a lost session without changing authority or acknowledgments", async () => {
      const { store, claim, observation } = await setup(kind);
      await store.claimWorkerDispatch(claim);
      expect(
        await store.endWorkerSession({ ...claim, status: "lost", mutationId: "lost-1" })
      ).toMatchObject({ updated: true });
      const before = await store.getWorkerDispatch(claim.sessionId);
      const result = await store.recordWorkerObservation(observation, recordedAt);
      expect(result).toMatchObject({
        recorded: true,
        replay: false,
        record: { kind: "completed", attemptId: "attempt-1", packetHash: claim.packetHash },
      });
      expect(await store.getWorkerDispatch(claim.sessionId)).toEqual(before);
      expect(await store.claimWorkerDispatch({ ...claim, now: recordedAt })).toMatchObject({
        recorded: false,
      });
      expect(
        await store.acknowledgeWorkerDispatch({
          ...claim,
          turnId: observation.turnId,
          now: recordedAt,
        })
      ).toMatchObject({ recorded: false });
    });
    it("deduplicates retry after lost persistence response and rejects changed evidence", async () => {
      const { store, claim, observation } = await setup(kind);
      await store.claimWorkerDispatch(claim);
      const results = await Promise.all([
        store.recordWorkerObservation(observation, recordedAt),
        store.recordWorkerObservation(observation, recordedAt),
      ]);
      expect(results.filter((x) => x.recorded && !x.replay)).toHaveLength(1);
      expect(
        await store.recordWorkerObservation(observation, "2026-08-12T12:06:00.000Z")
      ).toMatchObject({ recorded: true, replay: true, record: { recordedAt } });
      expect(
        await store.recordWorkerObservation({ ...observation, summary: "changed" }, recordedAt)
      ).toEqual({ recorded: false, reason: "observation_conflict" });
      const records = await store.listWorkerObservations(claim.sessionId);
      expect(records).toHaveLength(1);
      records[0].summary = "mutation";
      expect((await store.listWorkerObservations(claim.sessionId))[0].summary).toBe(
        observation.summary
      );
    });
    it("preserves contradictory reports without selecting a winning turn or outcome", async () => {
      const { store, claim, observation } = await setup(kind);
      await store.claimWorkerDispatch(claim);
      await store.acknowledgeWorkerDispatch({ ...claim, turnId: "acknowledged-turn" });
      await store.recordWorkerObservation(observation, recordedAt);
      await store.recordWorkerObservation(
        { ...observation, observationId: "contradiction", kind: "failed", turnId: "other-turn" },
        recordedAt
      );
      expect((await store.listWorkerObservations(claim.sessionId)).map((x) => x.kind)).toEqual([
        "completed",
        "failed",
      ]);
      expect((await store.getWorkerDispatch(claim.sessionId))?.acknowledgement?.turnId).toBe(
        "acknowledged-turn"
      );
    });
    it("rejects invalid times, unbounded summaries and invented verification fields", async () => {
      const { store, claim, observation } = await setup(kind);
      await store.claimWorkerDispatch(claim);
      expect(
        await store.recordWorkerObservation(
          { ...observation, observedAt: "2026-08-12T11:00:00.000Z" },
          recordedAt
        )
      ).toMatchObject({ recorded: false, reason: "invalid_time" });
      expect(await store.recordWorkerObservation(observation, claim.now)).toMatchObject({
        recorded: false,
        reason: "invalid_time",
      });
      await expect(
        store.recordWorkerObservation({ ...observation, summary: "x".repeat(8193) }, recordedAt)
      ).rejects.toThrow();
      await expect(
        store.recordWorkerObservation(
          { ...observation, verified: true } as WorkerObservationInput,
          recordedAt
        )
      ).rejects.toThrow();
    });
    it("caps new entries without evicting historical evidence or denying exact replay", async () => {
      const { store, claim, observation } = await setup(kind);
      await store.claimWorkerDispatch(claim);
      for (let i = 0; i < 128; i++)
        expect(
          await store.recordWorkerObservation(
            { ...observation, observationId: String(i) },
            recordedAt
          )
        ).toMatchObject({ recorded: true, replay: false });
      expect(await store.recordWorkerObservation(observation, recordedAt)).toEqual({
        recorded: false,
        reason: "observation_limit",
      });
      expect(
        await store.recordWorkerObservation({ ...observation, observationId: "0" }, recordedAt)
      ).toMatchObject({ recorded: true, replay: true });
      expect(await store.listWorkerObservations(claim.sessionId)).toHaveLength(128);
    });
    it("preserves canonical opaque identity domains", async () => {
      const { store, claim, observation } = await setup(kind, "worker/" + "α".repeat(17000));
      await store.claimWorkerDispatch(claim);
      expect(
        await store.recordWorkerObservation(
          { ...observation, turnId: "turn/" + "β".repeat(17000) },
          recordedAt
        )
      ).toMatchObject({ recorded: true });
    });
  });
it("collects memory state before a pending journal append without yielding mid-snapshot", async () => {
  const { store, claim, observation } = await setup("memory");
  await store.claimWorkerDispatch(claim);
  const write = store.recordWorkerTurnEvidence(capture(observation), recordedAt);
  const reading = store.getWorkerEvidenceSnapshot(claim.sessionId);
  await write;
  expect(await reading).toMatchObject({ observations: [], artifacts: [] });
  const after = (await store.getWorkerEvidenceSnapshot(claim.sessionId))!;
  expect(after.observations).toHaveLength(1);
  expect(after.artifacts).toHaveLength(1);
});
it("pins a SQLite snapshot across an independent writer commit, including on a read-only reader", async () => {
  const { store, claim, observation, path } = await setup("sqlite");
  await store.claimWorkerDispatch(claim);
  const configure = new Database(path!);
  try {
    expect(configure.pragma("journal_mode=WAL", { simple: true })).toBe("wal");
  } finally {
    configure.close();
  }
  class InspectableReader extends SqliteWorkerObservationStore {
    get connection() {
      return this.db;
    }
  }
  const reader = new InspectableReader(path!, { readOnly: true });
  stores.push(reader);
  const prepare = reader.connection.prepare.bind(reader.connection);
  let interleaved = false;
  const writes: Array<Promise<unknown>> = [];
  const spy = vi.spyOn(reader.connection, "prepare").mockImplementation((sql: string) => {
    const statement = prepare(sql);
    if (sql === "SELECT recordJson FROM worker_dispatches WHERE sessionId=?") {
      const get = statement.get.bind(statement);
      vi.spyOn(statement, "get").mockImplementation((...args: unknown[]) => {
        const value = get(...args);
        if (!interleaved) {
          interleaved = true;
          writes.push(store.acknowledgeWorkerDispatch({ ...claim, turnId: observation.turnId }));
          writes.push(store.recordWorkerTurnEvidence(capture(observation), recordedAt));
        }
        return value;
      });
    }
    return statement;
  });
  try {
    const snapshot = (await reader.getWorkerEvidenceSnapshot(claim.sessionId))!;
    expect(await Promise.all(writes)).toEqual([
      expect.objectContaining({ recorded: true }),
      expect.objectContaining({ recorded: true }),
    ]);
    expect(interleaved).toBe(true);
    expect(snapshot.dispatch.acknowledgement).toBeUndefined();
    expect(snapshot.observations).toEqual([]);
    expect(snapshot.artifacts).toEqual([]);
  } finally {
    spy.mockRestore();
  }
  const next = (await reader.getWorkerEvidenceSnapshot(claim.sessionId))!;
  expect(next.dispatch.acknowledgement?.turnId).toBe(observation.turnId);
  expect(next.observations).toHaveLength(1);
  expect(next.artifacts).toHaveLength(1);
  expect(reconcileWorkerTurn({ ...next, captureDisposition: "drained" }).state).toBe(
    "reported_terminal"
  );
});
it("rolls back the journal when SQLite artifact insertion fails, then survives read-only reopen", async () => {
  const { store, claim, observation, path } = await setup("sqlite");
  await store.claimWorkerDispatch(claim);
  const db = new Database(path!);
  try {
    db.exec(
      "CREATE TRIGGER fail_capture BEFORE INSERT ON worker_turn_evidence BEGIN SELECT RAISE(ABORT,'injected capture failure'); END;"
    );
    await expect(store.recordWorkerTurnEvidence(capture(observation), recordedAt)).rejects.toThrow(
      "injected capture failure"
    );
    expect(await store.listWorkerObservations(claim.sessionId)).toEqual([]);
    expect(
      await store.getWorkerTurnEvidence(claim.sessionId, observation.observationId)
    ).toBeNull();
    db.exec("DROP TRIGGER fail_capture");
    await store.recordWorkerTurnEvidence(capture(observation), recordedAt);
  } finally {
    db.close();
  }
  await store.close();
  stores.splice(stores.indexOf(store), 1);
  const reader = new SqliteWorkerObservationStore(path!, { readOnly: true });
  stores.push(reader);
  expect(await reader.getWorkerTurnEvidence(claim.sessionId, observation.observationId)).toBe(
    capture(observation).notificationJson
  );
  const writer = new Database(path!);
  try {
    writer.prepare("UPDATE worker_turn_evidence SET notificationJson=?").run("{}");
  } finally {
    writer.close();
  }
  await expect(
    reader.getWorkerTurnEvidence(claim.sessionId, observation.observationId)
  ).rejects.toThrow("evidence_hash_mismatch");
});
it("serializes independent SQLite writers and survives reopen read-only", async () => {
  const { store, claim, observation, path } = await setup("sqlite");
  await store.claimWorkerDispatch(claim);
  const second = new SqliteWorkerObservationStore(path!);
  stores.push(second);
  const results = await Promise.all([
    store.recordWorkerObservation(observation, recordedAt),
    second.recordWorkerObservation({ ...observation, summary: "different writer" }, recordedAt),
  ]);
  expect(results.filter((x) => x.recorded)).toHaveLength(1);
  expect(results.filter((x) => !x.recorded && x.reason === "observation_conflict")).toHaveLength(1);
  await store.close();
  await second.close();
  stores.splice(0);
  const reader = new SqliteWorkerObservationStore(path!, { readOnly: true });
  stores.push(reader);
  expect(await reader.listWorkerObservations(claim.sessionId)).toHaveLength(1);
  expect((await reader.getWorkerDispatch(claim.sessionId))?.acknowledgement).toBeUndefined();
  await expect(
    reader.recordWorkerObservation({ ...observation, observationId: "new" }, recordedAt)
  ).rejects.toThrow();
});
