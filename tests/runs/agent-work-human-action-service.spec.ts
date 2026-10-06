import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentWorkHumanActionService,
  humanActionSummary,
  readHumanActionState,
} from "../../src/runs/agent-work-human-action-service.js";
import { InMemoryCoordinationStore } from "../../src/store/inmemory/coordination-store.js";
import { SqliteCoordinationStore } from "../../src/store/sqlite/coordination-store.js";
import type { CoordinationStore } from "../../src/store/coordination-store.js";
import type { HumanActionReceipt_v1, HumanActionRequest_v1 } from "../../src/schemas/agent-work.js";

const roots: string[] = [];
const stores: CoordinationStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const time = "2026-10-06T12:00:00.000Z";
const head = "a".repeat(40);

async function fixture(kind: "memory" | "sqlite") {
  let path = "";
  if (kind === "sqlite") {
    const root = await mkdtemp(join(tmpdir(), "lexrunner-human-hold-"));
    roots.push(root);
    path = join(root, "coordination.db");
  }
  const store =
    kind === "memory" ? new InMemoryCoordinationStore() : new SqliteCoordinationStore(path);
  stores.push(store);
  const acquired = await store.acquireControllerLease({
    runId: "run",
    controllerId: "controller",
    leaseId: "controller-lease",
    now: time,
    ttlMs: 60000,
    initialState: { task: "Compare candidates", metadata: { retained: "Keep this" } },
  });
  if (!acquired.acquired) throw new Error("setup failed");
  const controller = {
    runId: "run",
    controllerId: "controller",
    leaseId: "controller-lease",
    fencingToken: acquired.lease.fencingToken,
  };
  // This port is an observed test workspace, not a live checkout or an authority credential.
  const lease = {
    leaseId: "workspace",
    runId: "run",
    attemptId: "attempt",
    revision: 2,
    repositoryId: "owner/repo",
    hostId: "host",
    gitRuntime: "git",
    projectRoot: "/repo",
    worktreePath: "/repo",
    branch: "science",
  };
  const workspace = {
    async getAttempt() {
      return { runId: "run", attemptId: "attempt", workspaceLeaseId: "workspace" };
    },
    async getWorkspaceLease() {
      return lease;
    },
    async getWorkerSession() {
      return { runId: "run", attemptId: "attempt", workspaceLeaseId: "workspace" };
    },
  } as unknown as ConstructorParameters<typeof AgentWorkHumanActionService>[1];
  const observed = {
    exists: true,
    registered: true,
    repositoryId: "owner/repo",
    hostId: "host",
    gitRuntime: "git",
    projectRoot: "/repo",
    branch: "science",
    worktreePath: "/repo",
    attemptId: "attempt",
    headSha: head,
    cleanliness: "dirty" as const,
  };
  const observer = {
    async observe() {
      return observed;
    },
  };
  const service = new AgentWorkHumanActionService(store, workspace, observer);
  const request: HumanActionRequest_v1 = {
    schema_version: "1.0.0",
    request_id: "decision",
    run_id: "run",
    attempt_id: "attempt",
    workspace_lease_id: "workspace",
    worker_session_id: "worker",
    action: "other",
    summary: "Is this tradeoff acceptable?",
    instructions: ["Compare the retained evidence."],
    suggested_commands: [],
    preconditions: { run_revision: 0, workspace_lease_revision: 2, expected_head_sha: head },
    requested_at: time,
  };
  const mutation = { controller, expectedRunRevision: 0, mutationId: "request", now: time };
  const answer = (
    outcome: HumanActionReceipt_v1["outcome"] = "completed"
  ): HumanActionReceipt_v1 => ({
    schema_version: "1.0.0",
    receipt_id: "answer",
    request_id: "decision",
    run_id: "run",
    attempt_id: "attempt",
    workspace_lease_id: "workspace",
    worker_session_id: "worker",
    observed_preconditions: { ...request.preconditions },
    outcome,
    actor_id: "human-channel",
    summary: "Recorded human answer",
    completed_at: time,
  });
  return {
    store,
    path,
    workspace,
    observer,
    observed,
    lease,
    service,
    request,
    mutation,
    controller,
    answer,
  };
}

describe.each(["memory", "sqlite"] as const)("durable human action (%s)", (kind) => {
  it("commits the hold and event before presentation; answers once without losing unrelated state", async () => {
    const f = await fixture(kind);
    expect(await f.service.request({ ...f.mutation, request: f.request })).toMatchObject({
      ok: true,
      revision: 1,
    });
    const held = await f.store.getRunCoordination("run");
    expect(humanActionSummary(held!.state, time)).toMatchObject([
      { requestId: "decision", disposition: "pending" },
    ]);
    expect(await f.store.listRunCoordinationEvents("run")).toMatchObject([
      { type: "human_action_requested", revision: 1 },
    ]);
    expect(await f.service.request({ ...f.mutation, request: f.request })).toMatchObject({
      ok: true,
      replay: true,
    });
    const receipt = f.answer();
    expect(
      await f.service.settle({
        ...f.mutation,
        expectedRunRevision: 1,
        mutationId: "answer",
        receipt,
      })
    ).toMatchObject({ ok: true, revision: 2 });
    expect(
      await f.service.settle({
        ...f.mutation,
        expectedRunRevision: 1,
        mutationId: "answer",
        receipt,
      })
    ).toMatchObject({ ok: true, replay: true });
    const answered = await f.store.getRunCoordination("run");
    expect(humanActionSummary(answered!.state, time)).toEqual([]);
    expect(answered!.state).toMatchObject({ metadata: { retained: "Keep this" } });
    expect(readHumanActionState(answered!.state).entries[0].receipt).toEqual(receipt);
  });

  it.each(["declined", "expired", "failed"] as const)("keeps %s answers held", async (outcome) => {
    const f = await fixture(kind);
    await f.service.request({ ...f.mutation, request: f.request });
    expect(
      await f.service.settle({
        ...f.mutation,
        expectedRunRevision: 1,
        mutationId: "answer",
        receipt: f.answer(outcome),
      })
    ).toMatchObject({ ok: true });
    expect(
      humanActionSummary((await f.store.getRunCoordination("run"))!.state, time)[0].disposition
    ).toBe(outcome);
  });

  it("rejects old answers after expiry, changed context/head/workspace, and cross-attempt answers", async () => {
    const f = await fixture(kind);
    f.request.expires_at = "2026-10-06T12:00:30.000Z";
    await f.service.request({ ...f.mutation, request: f.request });
    const settle = {
      ...f.mutation,
      expectedRunRevision: 1,
      mutationId: "answer",
      receipt: f.answer(),
    };
    expect(
      await f.service.settle({ ...settle, receipt: { ...f.answer(), attempt_id: "other" } })
    ).toMatchObject({ ok: false, reason: "invalid_receipt_binding" });
    expect(await f.service.settle({ ...settle, now: f.request.expires_at })).toMatchObject({
      ok: false,
      reason: "request_expired",
    });
    f.observed.headSha = "b".repeat(40);
    expect(await f.service.settle(settle)).toMatchObject({
      ok: false,
      reason: "stale_workspace_binding",
    });
    f.observed.headSha = head;
    f.lease.revision++;
    expect(await f.service.settle(settle)).toMatchObject({
      ok: false,
      reason: "stale_workspace_binding",
    });
    f.lease.revision--;
    const record = (await f.store.getRunCoordination("run"))!;
    await f.store.compareAndSetRunState({
      ...f.controller,
      expectedRevision: 1,
      mutationId: "changed-context",
      now: time,
      state: { ...(record.state as object), task: "Changed requested scope" },
      event: { type: "test_context_changed", payload: {} },
    });
    expect(await f.service.settle({ ...settle, expectedRunRevision: 2 })).toMatchObject({
      ok: false,
      reason: "request_context_changed",
    });
    expect(humanActionSummary((await f.store.getRunCoordination("run"))!.state, time)).toHaveLength(
      1
    );
  });

  it("reissues changed requests atomically and refuses the superseded answer", async () => {
    const f = await fixture(kind);
    await f.service.request({ ...f.mutation, request: f.request });
    const fresh = {
      ...f.request,
      request_id: "fresh",
      preconditions: { ...f.request.preconditions, run_revision: 1 },
    };
    expect(
      await f.service.request({
        ...f.mutation,
        expectedRunRevision: 1,
        mutationId: "replace",
        request: fresh,
        replacesRequestId: "decision",
      })
    ).toMatchObject({ ok: true });
    expect(
      humanActionSummary((await f.store.getRunCoordination("run"))!.state, time).map(
        (entry) => entry.requestId
      )
    ).toEqual(["fresh"]);
    expect(
      await f.service.settle({ ...f.mutation, expectedRunRevision: 2, receipt: f.answer() })
    ).toMatchObject({ ok: false, reason: "request_superseded" });
  });

  it("uses fenced CAS against racing controllers and rejects malformed time", async () => {
    const f = await fixture(kind);
    const raced = await Promise.all([
      f.service.request({ ...f.mutation, request: f.request }),
      f.service.request({
        ...f.mutation,
        mutationId: "racing",
        request: { ...f.request, request_id: "racing" },
      }),
    ]);
    expect(raced.filter((result) => result.ok)).toHaveLength(1);
    expect(
      await f.service.settle({
        ...f.mutation,
        expectedRunRevision: 1,
        now: "not a time",
        receipt: f.answer(),
      })
    ).toMatchObject({ ok: false, reason: "invalid_time" });
    await f.store.acquireControllerLease({
      runId: "run",
      controllerId: "new",
      leaseId: "new",
      now: "2026-10-06T12:01:00.000Z",
      ttlMs: 60000,
      initialState: {},
    });
    expect(
      await f.service.settle({
        ...f.mutation,
        expectedRunRevision: 1,
        now: "2026-10-06T12:01:00.000Z",
        receipt: f.answer(),
      })
    ).toMatchObject({ ok: false, reason: "stale_fence" });
  });
});

it("retains unanswered holds after closing and reopening the SQLite process boundary", async () => {
  const f = await fixture("sqlite");
  await f.service.request({ ...f.mutation, request: f.request });
  await f.store.close();
  const restarted = new SqliteCoordinationStore(f.path);
  stores.push(restarted);
  const state = (await restarted.getRunCoordination("run"))!.state;
  expect(humanActionSummary(state, "2026-10-07T12:00:00.000Z")).toMatchObject([
    { disposition: "pending" },
  ]);
  expect(await restarted.listRunCoordinationEvents("run")).toHaveLength(1);
});

it("fails closed on corrupt holds and bounds summaries without discarding the stored question", async () => {
  expect(() => humanActionSummary({ metadata: { agentWorkHumanActions: {} } }, time)).toThrow();
  const f = await fixture("memory");
  f.request.summary = "鳥".repeat(500);
  await f.service.request({ ...f.mutation, request: f.request });
  const state = (await f.store.getRunCoordination("run"))!.state;
  expect(humanActionSummary(state, time)[0]).toMatchObject({
    summaryTruncated: true,
    summary: "鳥".repeat(240),
  });
  expect(readHumanActionState(state).entries[0].request.summary).toHaveLength(500);
});
