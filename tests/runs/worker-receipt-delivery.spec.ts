import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryWorkerObservationStore } from "../../src/store/inmemory/worker-observation-store.js";
import { SqliteWorkerObservationStore } from "../../src/store/sqlite/worker-observation-store.js";
import { AgentTaskReceipt_v2, ExecutionEnvelope_v1 } from "../../src/schemas/agent-work.js";
import { computeCanonicalHash } from "../../src/schemas/task-contract.js";
import {
  codexReceiptRequest,
  CodexReceiptOutputSchema,
  decodeCodexReceipt,
} from "../../src/runs/codex-receipt-contract.js";
import {
  WorkerReceiptDeliveryService,
  assessWorkerReceipt,
} from "../../src/runs/worker-receipt-delivery.js";
import { AgentWorkAttemptReceiptService } from "../../src/runs/agent-work-attempt-receipt-service.js";
import { createAttachedWorker, taskPacket } from "../store/worker-dispatch-fixture.js";
import type { SubmitAttemptReceiptInput } from "../../src/store/workspace-lifecycle-store.js";
import type {
  AgentWorkAttemptVerificationService,
  RunAttemptVerificationInput,
} from "../../src/runs/agent-work-attempt-verification-service.js";

const directories: string[] = [];
const stores: Array<InMemoryWorkerObservationStore | SqliteWorkerObservationStore> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function setup(kind: string, heartbeatBeforeDispatch = false) {
  const path = kind === "sqlite" ? await mkdtemp(join(tmpdir(), "lexrunner-receipts-")) : undefined;
  if (path) directories.push(path);
  const dbPath = path && join(path, "store.db");
  const store = dbPath
    ? new SqliteWorkerObservationStore(dbPath)
    : new InMemoryWorkerObservationStore();
  stores.push(store);
  const controller = await createAttachedWorker(store);
  if (heartbeatBeforeDispatch) {
    const lease = (await store.getWorkspaceLease("workspace-lease-1"))!;
    expect(
      await store.heartbeatWorkspace({
        controller,
        runId: "run-1",
        expectedRunRevision: 0,
        attemptId: "attempt-1",
        expectedAttemptRevision: 3,
        workspaceLeaseId: lease.leaseId,
        expectedWorkspaceLeaseRevision: 0,
        mutationId: "heartbeat-before-dispatch",
        now: "2026-08-12T12:00:03.500Z",
        ttlMs: 60_000,
        observation: {
          repositoryId: lease.repositoryId,
          hostId: lease.hostId,
          gitRuntime: lease.gitRuntime,
          projectRoot: lease.projectRoot,
          worktreePath: lease.worktreePath,
          branch: lease.branch,
          attemptId: lease.attemptId,
          exists: true,
          registered: true,
          headSha: lease.baseSha,
          cleanliness: "clean",
        },
      })
    ).toMatchObject({ updated: true });
  }
  const packet = taskPacket();
  const envelope = ExecutionEnvelope_v1.parse(
    JSON.parse((await store.getLaunchEnvelopeBinding("attempt-1"))!.envelopeJson)
  );
  const request = codexReceiptRequest(packet, envelope, "native-session-1", "worker-session-1");
  const claim = {
    controller,
    runId: "run-1",
    expectedRunRevision: 0,
    attemptId: "attempt-1",
    expectedAttemptRevision: heartbeatBeforeDispatch ? 4 : 3,
    workspaceLeaseId: "workspace-lease-1",
    expectedWorkspaceLeaseRevision: heartbeatBeforeDispatch ? 1 : 0,
    sessionId: "worker-session-1",
    expectedSessionRevision: 0,
    claimId: "claim-1",
    requestHash: computeCanonicalHash(request),
    packetHash: packet.packet_hash,
    now: "2026-08-12T12:00:04.000Z",
  };
  expect(await store.claimWorkerDispatch(claim)).toMatchObject({ recorded: true });
  expect(await store.acknowledgeWorkerDispatch({ ...claim, turnId: "turn-1" })).toMatchObject({
    recorded: true,
  });
  const receipt = AgentTaskReceipt_v2.parse({
    schema_version: "2.0.0",
    receipt_id: "receipt-1",
    run_id: "run-1",
    work_item_id: "work-1",
    work_item_revision: 1,
    attempt_id: "attempt-1",
    packet_id: "packet-1",
    packet_hash: packet.packet_hash,
    workspace_lease_id: "workspace-lease-1",
    workspace_lease_revision: 0,
    worker_runtime: "codex-native",
    worker_session_id: "worker-session-1",
    observed_base_sha: "a".repeat(40),
    final_head_sha: "a".repeat(40),
    outcome: "completed",
    exit_reason: "task_completed",
    summary: "Synthetic worker claim",
    files_touched: [],
    commits: [],
    acceptance_criteria_addressed: ["criterion-1"],
    claimed_checks: [],
    assumptions: [],
    blockers: [],
    human_action_request_ids: [],
    cost: {},
    worker_started_at: "2026-08-12T12:00:04.000Z",
    worker_completed_at: "2026-08-12T12:00:05.000Z",
    submitted_at: "2026-08-12T12:00:05.000Z",
  });
  const source = {
    sessionId: claim.sessionId,
    claimId: claim.claimId,
    requestHash: claim.requestHash,
    workerId: "native-session-1",
    observationId: "source-1",
    observerId: "owned-1",
    observedAt: "2026-08-12T12:00:06.000Z",
    notificationJson: JSON.stringify({
      method: "item/completed",
      emittedAtMs: 1791335791251,
      params: {
        threadId: "native-session-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "item-1",
          phase: "final_answer",
          text: JSON.stringify(wireReceipt(receipt)),
        },
      },
    }),
  };
  const terminal = {
    ...source,
    observationId: "terminal-1",
    observedAt: "2026-08-12T12:00:07.000Z",
    notificationJson: JSON.stringify({
      method: "turn/completed",
      emittedAtMs: 1791335791251,
      params: {
        threadId: "native-session-1",
        turn: { id: "turn-1", status: "completed", items: [] },
      },
    }),
  };
  expect(await store.recordWorkerTurnEvidence(terminal, terminal.observedAt)).toMatchObject({
    recorded: true,
  });
  const input = { ...claim, captureDisposition: "drained" as const };
  const clock = { now: "2026-08-12T12:00:08.000Z" };
  const services = portableServices(store);
  const service = () => new WorkerReceiptDeliveryService(store, () => clock.now, services);
  return { store, dbPath, source, receipt, input, clock, services, service, request };
}
function wireReceipt(receipt: AgentTaskReceipt_v2) {
  return {
    ...receipt,
    final_head_sha: receipt.final_head_sha ?? null,
    patch_hash: receipt.patch_hash ?? null,
    cost: {
      input_tokens: receipt.cost.input_tokens ?? null,
      output_tokens: receipt.cost.output_tokens ?? null,
      tool_calls: receipt.cost.tool_calls ?? null,
      elapsed_ms: receipt.cost.elapsed_ms ?? null,
    },
    claimed_checks: receipt.claimed_checks.map((check) => ({
      ...check,
      exit_code: check.exit_code ?? null,
      output_snippet: check.output_snippet ?? null,
    })),
  };
}
function portableServices(store: InMemoryWorkerObservationStore | SqliteWorkerObservationStore) {
  // Portable store-contract adapters only. Real application services additionally validate paths.
  return {
    sessions: { end: vi.fn(store.endWorkerSession.bind(store)) },
    receipts: {
      submit: vi.fn(async (submission: SubmitAttemptReceiptInput) => {
        const result = await store.submitAttemptReceipt(submission);
        if (!result.submitted) return result;
        return {
          submitted: true as const,
          receiptId: result.receipt.receiptId,
          receiptHash: result.receipt.receiptHash,
          attemptId: result.attempt.attemptId,
          outcome: result.receipt.outcome,
          disposition: result.receipt.disposition,
          attemptRevision: result.attempt.revision,
          attemptStatus: result.attempt.status,
          event: {
            type: result.event.type,
            sequence: result.event.sequence,
            createdAt: result.event.createdAt,
          },
          idempotentReplay: result.idempotentReplay,
        };
      }),
    } satisfies { submit: AgentWorkAttemptReceiptService["submit"] },
  };
}
for (const kind of ["memory", "sqlite"])
  describe(`${kind} structured receipt delivery`, () => {
    it("keeps the receipt bound to attachment after a workspace heartbeat advances dispatch fencing", async () => {
      const f = await setup(kind, true);
      expect((await f.store.getWorkerDispatch(f.input.sessionId))!.workspaceLeaseRevision).toBe(1);
      expect(
        JSON.parse(f.request.params.input[0].text).receipt_contract.workspace_lease_revision
      ).toBe(0);
      await f.store.recordWorkerReceiptEvidence(f.source, f.source.observedAt);
      expect(await f.service().deliver(f.input)).toMatchObject({
        state: "submitted",
        disposition: "verification_pending",
      });
      expect(
        (await f.store.getAttemptReceiptForAttempt(f.input.attemptId))!.workspaceLeaseRevision
      ).toBe(0);
      const stored = JSON.parse(
        (await f.store.getAttemptReceiptForAttempt(f.input.attemptId))!.receiptJson
      );
      expect(stored.workspace_lease_revision).toBe(0);
    });
    it("does not attribute an unrelated canonical submission to the captured source", async () => {
      const f = await setup(kind);
      await f.store.recordWorkerReceiptEvidence(f.source, f.source.observedAt);
      f.services.sessions.end.mockImplementationOnce((input) =>
        f.store.endWorkerSession({ ...input, exitReason: "another-delivery" })
      );
      // The injected adapter violates the service's marker request; recovery must detect it.
      await f.service().deliver(f.input);
      await expect(f.service().deliver(f.input)).rejects.toThrow("receipt_conflict");
    });
    it("enforces the receipt journal count budget without evicting or denying exact replay", async () => {
      const f = await setup(kind);
      const first = await f.store.recordWorkerReceiptEvidence(f.source, f.source.observedAt);
      for (let i = 1; i < 128; i++)
        expect(
          await f.store.recordWorkerReceiptEvidence(
            { ...f.source, observationId: `source-${i + 1}` },
            f.clock.now
          )
        ).toMatchObject({ recorded: true });
      expect(
        await f.store.recordWorkerReceiptEvidence(
          { ...f.source, observationId: "over-limit" },
          f.clock.now
        )
      ).toEqual({ recorded: false, reason: "evidence_limit" });
      expect(await f.store.recordWorkerReceiptEvidence(f.source, f.clock.now)).toEqual({
        ...first,
        replay: true,
      });
    });
    it("delegates explicit verification to the existing verifier and preserves its failure", async () => {
      const f = await setup(kind);
      await f.store.recordWorkerReceiptEvidence(f.source, f.source.observedAt);
      const verifier = {
        run: vi
          .fn<AgentWorkAttemptVerificationService["run"]>()
          .mockResolvedValue({ recorded: false, reason: "evidence_mismatch" }),
      };
      await f.service().deliver(f.input);
      expect(verifier.run).not.toHaveBeenCalled();
      const request: RunAttemptVerificationInput = {
        runId: f.input.runId,
        expectedRunRevision: 0,
        controller: f.input.controller,
        verificationId: "verification-1",
        attemptId: f.input.attemptId,
        expectedAttemptRevision: 4,
        workspaceLeaseId: f.input.workspaceLeaseId,
        expectedWorkspaceLeaseRevision: 0,
        workerSessionId: f.input.sessionId,
        expectedWorkerSessionRevision: 1,
        receiptId: f.receipt.receipt_id,
        receiptHash: computeCanonicalHash(f.receipt),
        beginMutationId: "verify-begin",
        completeMutationId: "verify-complete",
      };
      await expect(
        f.service().verify(f.input, { ...request, receiptHash: "wrong" }, verifier)
      ).rejects.toThrow("verification_receipt_mismatch");
      expect(verifier.run).not.toHaveBeenCalled();
      expect(await f.service().verify(f.input, request, verifier)).toEqual({
        recorded: false,
        reason: "evidence_mismatch",
      });
      expect(verifier.run).toHaveBeenCalledWith(request);
    });
    it.each(["not json", "{}"])(
      "retains malformed worker claims but does not deliver them: %s",
      async (text) => {
        const f = await setup(kind);
        const event = JSON.parse(f.source.notificationJson);
        event.params.item.text = text;
        expect(
          await f.store.recordWorkerReceiptEvidence(
            { ...f.source, notificationJson: JSON.stringify(event) },
            f.clock.now
          )
        ).toMatchObject({ recorded: true });
        await expect(f.service().deliver(f.input)).rejects.toThrow("invalid_task_receipt");
        expect(f.services.sessions.end).not.toHaveBeenCalled();
      }
    );
    it("requires a durable structured source and pending capture blocks all lifecycle work", async () => {
      const f = await setup(kind);
      await expect(f.service().deliver(f.input)).rejects.toThrow("receipt_missing");
      await f.store.recordWorkerReceiptEvidence(f.source, f.source.observedAt);
      await expect(
        f.service().deliver({ ...f.input, captureDisposition: "unknown" })
      ).rejects.toThrow("receipt_turn_unresolved");
      expect(f.services.sessions.end).not.toHaveBeenCalled();
      expect(f.services.receipts.submit).not.toHaveBeenCalled();
    });
    it("persists provenance and delivers only an unverified claim; replay performs no effects", async () => {
      const f = await setup(kind);
      const persisted = await f.store.recordWorkerReceiptEvidence(f.source, f.source.observedAt);
      expect(persisted).toMatchObject({ recorded: true, replay: false });
      expect(await f.store.recordWorkerReceiptEvidence(f.source, f.clock.now)).toEqual({
        ...persisted,
        replay: true,
      });
      const result = await f.service().deliver(f.input);
      expect(result).toMatchObject({
        state: "submitted",
        verification: "not_performed",
        disposition: "verification_pending",
        provenance: {
          observationId: "source-1",
          turnId: "turn-1",
          itemId: "item-1",
          receiptHash: computeCanonicalHash(f.receipt),
        },
      });
      expect(await f.store.getAttempt("attempt-1")).toMatchObject({
        status: "receipt_submitted",
        verificationId: null,
      });
      expect(await f.service().deliver(f.input)).toMatchObject({
        state: "submitted",
        replay: true,
      });
      expect(f.services.sessions.end).toHaveBeenCalledTimes(1);
      expect(f.services.receipts.submit).toHaveBeenCalledTimes(1);
    });
    it.each(["end", "submit"] as const)(
      "recovers a lost %s response without repeating its committed effect",
      async (stage) => {
        const f = await setup(kind);
        await f.store.recordWorkerReceiptEvidence(f.source, f.source.observedAt);
        if (stage === "end") {
          f.services.sessions.end.mockImplementationOnce(async (input) => {
            await f.store.endWorkerSession(input);
            throw new Error("lost");
          });
        } else {
          f.services.receipts.submit.mockImplementationOnce(async (input) => {
            await f.store.submitAttemptReceipt(input);
            throw new Error("lost");
          });
        }
        await expect(f.service().deliver(f.input)).rejects.toThrow("lost");
        f.clock.now = "2026-08-12T12:00:09.000Z";
        expect(await f.service().deliver(f.input)).toMatchObject({
          state: "submitted",
          disposition: "verification_pending",
        });
        expect(f.services.sessions.end).toHaveBeenCalledTimes(1);
        expect(f.services.receipts.submit).toHaveBeenCalledTimes(1);
      }
    );
    it("retains conflicting final messages and never chooses the newest", async () => {
      const f = await setup(kind);
      await f.store.recordWorkerReceiptEvidence(f.source, f.source.observedAt);
      await f.store.recordWorkerReceiptEvidence(
        { ...f.source, observationId: "source-2" },
        f.clock.now
      );
      await expect(f.service().deliver(f.input)).rejects.toThrow("receipt_conflict");
      expect(f.services.sessions.end).not.toHaveBeenCalled();
    });
    it("rejects changed source IDs, wrong threads, non-final phases and oversized capture", async () => {
      const f = await setup(kind);
      await f.store.recordWorkerReceiptEvidence(f.source, f.source.observedAt);
      for (const [notificationJson, reason] of [
        [f.source.notificationJson + " ", "receipt_capture_conflict"],
        [
          f.source.notificationJson.replace('"threadId":"native-session-1"', '"threadId":"other"'),
          "receipt_binding_mismatch",
        ],
        [
          f.source.notificationJson.replace('"final_answer"', '"commentary"'),
          "invalid_receipt_event",
        ],
        [" ".repeat(1024 * 1024 + 1), "invalid_receipt_capture"],
      ])
        expect(
          await f.store.recordWorkerReceiptEvidence({ ...f.source, notificationJson }, f.clock.now)
        ).toEqual({ recorded: false, reason });
    });
    it("validates raw source hashes, typed claims and turn binding before ending a session", async () => {
      const f = await setup(kind);
      await f.store.recordWorkerReceiptEvidence(f.source, f.source.observedAt);
      const snapshot = (await f.store.getWorkerReceiptSnapshot(f.input.sessionId))!;
      snapshot.receipts[0].sourceHash = "sha256:" + "0".repeat(64);
      expect(() => assessWorkerReceipt(snapshot, "drained")).toThrow("receipt_provenance_mismatch");
      const g = await setup(kind);
      await g.store.recordWorkerReceiptEvidence(
        {
          ...g.source,
          notificationJson: g.source.notificationJson.replace(
            '"turnId":"turn-1"',
            '"turnId":"other"'
          ),
        },
        g.clock.now
      );
      await expect(g.service().deliver(g.input)).rejects.toThrow("receipt_turn_mismatch");
      expect(g.services.sessions.end).not.toHaveBeenCalled();
    });
    it("does not use old timestamps to revive expired authority during recovery", async () => {
      const f = await setup(kind);
      await f.store.recordWorkerReceiptEvidence(f.source, f.source.observedAt);
      f.services.sessions.end.mockImplementationOnce(async (input) => {
        await f.store.endWorkerSession(input);
        throw new Error("lost");
      });
      await expect(f.service().deliver(f.input)).rejects.toThrow("lost");
      f.clock.now = "2026-08-12T12:02:00.000Z";
      expect(await f.service().deliver(f.input)).toMatchObject({ state: "blocked" });
      expect(await f.store.getAttemptReceiptForAttempt(f.input.attemptId)).toBeNull();
    });
  });

it("reconstructs receipt provenance from SQLite after a process restart", async () => {
  const f = await setup("sqlite");
  await f.store.recordWorkerReceiptEvidence(f.source, f.source.observedAt);
  const before = await f.store.getWorkerReceiptSnapshot(f.input.sessionId);
  await f.store.close();
  stores.splice(stores.indexOf(f.store), 1);
  const reopened = new SqliteWorkerObservationStore(f.dbPath!, { readOnly: true });
  stores.push(reopened);
  const after = await reopened.getWorkerReceiptSnapshot(f.input.sessionId);
  expect(after).toEqual(before);
  expect(assessWorkerReceipt(after!, "drained").provenance.receiptHash).toBe(
    computeCanonicalHash(f.receipt)
  );
});

it("uses required nullable wire fields and decodes omissions without inventing zero costs", async () => {
  const f = await setup("memory");
  const wire = wireReceipt(f.receipt);
  expect(decodeCodexReceipt(wire)).toEqual(f.receipt);
  expect(decodeCodexReceipt({ ...wire, cost: { ...wire.cost, input_tokens: 0 } }).cost).toEqual({
    input_tokens: 0,
  });
  expect(() => decodeCodexReceipt(f.receipt)).toThrow();
  expect(() => decodeCodexReceipt({ ...wire, final_head_sha: null, patch_hash: null })).toThrow();
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const object = node as Record<string, unknown>;
    if (object.type === "object") {
      expect(object.additionalProperties).toBe(false);
      expect([...(object.required as string[])].sort()).toEqual(
        Object.keys(object.properties as object).sort()
      );
    }
    Object.values(object).forEach(visit);
  };
  visit(CodexReceiptOutputSchema);
});

it.each(["end", "submit"] as const)(
  "recovers delivery after SQLite close/reopen following committed %s",
  async (stage) => {
    const f = await setup("sqlite");
    await f.store.recordWorkerReceiptEvidence(f.source, f.source.observedAt);
    if (stage === "end")
      f.services.sessions.end.mockImplementationOnce(async (input) => {
        await f.store.endWorkerSession(input);
        throw new Error("process exit");
      });
    else
      f.services.receipts.submit.mockImplementationOnce(async (input) => {
        await f.store.submitAttemptReceipt(input);
        throw new Error("process exit");
      });
    await expect(f.service().deliver(f.input)).rejects.toThrow("process exit");
    await f.store.close();
    stores.splice(stores.indexOf(f.store), 1);
    const reopened = new SqliteWorkerObservationStore(f.dbPath!);
    stores.push(reopened);
    const services = portableServices(reopened);
    const service = new WorkerReceiptDeliveryService(
      reopened,
      () => "2026-08-12T12:00:09.000Z",
      services
    );
    expect(await service.deliver(f.input)).toMatchObject({ state: "submitted" });
    expect(services.sessions.end).not.toHaveBeenCalled();
    expect(services.receipts.submit).toHaveBeenCalledTimes(stage === "end" ? 1 : 0);
  }
);
