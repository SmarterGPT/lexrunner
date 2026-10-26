import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgentTaskPacket,
  parseAgentEngineVerificationV2,
} from "../../../src/schemas/agent-work.js";
import { createNativeExecutionPathMapping } from "../../../src/schemas/agent-work-projection.js";
import { computeCanonicalHash } from "../../../src/schemas/task-contract.js";
import { SqliteWorkspaceLifecycleStore } from "../../../src/store/sqlite/workspace-lifecycle-store.js";
import { SqliteRemovalOperationStore } from "../../../src/store/sqlite/removal-operation-store.js";
import {
  createRemovalIntent,
  createRemovalObservation,
} from "../../../src/workspaces/workspace-removal-evidence.js";
import { canonicalJSONStringify } from "../../../src/util/canonicalJson.js";

// Real SQLite lifecycle APIs with synthetic directory observations. No worker,
// native executor or filesystem removal is launched by this store qualification.
const hash = `sha256:${"a".repeat(64)}`;
const time = (seconds: number) => new Date(Date.UTC(2026, 9, 25) + seconds * 1000).toISOString();
const controller = {
  runId: "run",
  controllerId: "controller",
  leaseId: "controller-lease",
  fencingToken: 1,
};
const root = (path: string, inode: string) => ({
  runtime_id: "git",
  path,
  verification: "directory_identity" as const,
  directory_identity: { device: "1", inode },
});

describe("removal and worker lifecycle writer ordering", () => {
  let directory: string, path: string;
  let lifecycle: SqliteWorkspaceLifecycleStore, worker: SqliteWorkspaceLifecycleStore;
  let removals: SqliteRemovalOperationStore;
  const packet = createAgentTaskPacket({
    schema_version: "1.0.0",
    packet_id: "packet",
    run_id: "run",
    work_item: { work_item_id: "work", revision: 1 },
    attempt_id: "attempt",
    repository: { id: "repo", base_sha: "a".repeat(40) },
    objective: "Qualify removal contention",
    acceptance_criteria: [],
    instructions: [],
    scope: { read_globs: [], write_globs: [], deny_globs: [], cross_repo_allowed: false },
    authority: {
      edit: false,
      git_write: false,
      github_write: false,
      external_runtime: false,
      secrets: false,
      signing: false,
      release: false,
    },
    verification: [],
    budget: {},
    created_at: time(0),
  });
  const identity = {
    repositoryId: "repo",
    hostId: "host",
    gitRuntime: "git",
    projectRoot: "/repo",
    branch: "agent/work",
    worktreePath: "/trees/work",
    attemptId: "attempt",
  };
  const envelope = {
    schema_version: "1.0.0",
    envelope_id: "envelope",
    run_id: "run",
    attempt_id: "attempt",
    packet_id: "packet",
    packet_hash: packet.packet_hash,
    workspace_lease_id: "workspace",
    workspace_lease_revision: 0,
    expected_head_sha: "a".repeat(40),
    branch: identity.branch,
    runtime: {
      host_id: "host",
      os: "linux",
      architecture: "x64",
      git_runtime: "git",
      worker_runtime: "fixture",
    },
    paths: {
      project_root: "/trees/work",
      execution_root: "/trees/work",
      allocation_root: "/trees",
      worktree_root: "/trees/work",
    },
    path_mappings: [
      createNativeExecutionPathMapping({
        schema_version: "1.0.0",
        mapping_kind: "native_linux",
        repository_id: "repo",
        base_sha: "a".repeat(40),
        native_host_id: "host",
        git_runtime: "git",
        roots: {
          native_repository: root("/repo", "11"),
          native_allocation_root: root("/trees", "12"),
          native_worktree: root("/trees/work", "13"),
        },
      }),
    ],
    exposed_environment_keys: [],
    created_at: time(2.25),
  };
  const auth = { controller, runId: "run", expectedRunRevision: 0 };
  const attach = () => ({
    ...auth,
    mutationId: "attach",
    now: time(6),
    attemptId: "attempt",
    workspaceLeaseId: "workspace",
    expectedAttemptRevision: 2,
    expectedWorkspaceLeaseRevision: 0,
    sessionId: "session",
    packetId: "packet",
    packetHash: packet.packet_hash,
    executionEnvelopeId: "envelope",
    executionEnvelopeHash: computeCanonicalHash(envelope),
    hostId: "host",
    workerRuntime: "fixture",
    gitRuntime: "git",
    backend: "external" as const,
    workerId: "fixture-worker",
    startedAt: time(2.5),
  });
  const sessionMutation = (expectedSessionRevision = 0) => ({
    ...auth,
    mutationId: "session-change",
    now: time(8),
    attemptId: "attempt",
    workspaceLeaseId: "workspace",
    expectedAttemptRevision: 3,
    expectedWorkspaceLeaseRevision: 0,
    sessionId: "session",
    expectedSessionRevision,
  });
  const receipt = {
    schema_version: "2.0.0" as const,
    receipt_id: "receipt",
    run_id: "run",
    work_item_id: "work",
    work_item_revision: 1,
    attempt_id: "attempt",
    packet_id: "packet",
    packet_hash: packet.packet_hash,
    workspace_lease_id: "workspace",
    workspace_lease_revision: 0,
    worker_runtime: "fixture",
    worker_session_id: "session",
    observed_base_sha: "a".repeat(40),
    patch_hash: hash,
    outcome: "completed" as const,
    exit_reason: "completed" as const,
    summary: "Controlled receipt",
    files_touched: [],
    commits: [],
    claimed_checks: [],
    acceptance_criteria_addressed: [],
    assumptions: [],
    blockers: [],
    human_action_request_ids: [],
    cost: { tool_calls: 0, elapsed_ms: 5500 },
    worker_started_at: time(2.5),
    worker_completed_at: time(8),
    submitted_at: time(10),
  };
  const submitReceipt = () => ({
    ...auth,
    mutationId: "submit",
    now: time(10),
    attemptId: "attempt",
    expectedAttemptRevision: 3,
    workspaceLeaseId: "workspace",
    expectedWorkspaceLeaseRevision: 0,
    workerSessionId: "session",
    expectedWorkerSessionRevision: 1,
    receipt,
  });
  async function seedRemoval() {
    const attempt = await lifecycle.getAttempt("attempt");
    const lease = await lifecycle.getWorkspaceLease("workspace");
    const intent = createRemovalIntent({
      schema_version: "workspace-removal-intent/1",
      operation_id: "remove",
      attempt_id: "attempt",
      lease_id: "workspace",
      lease_revision: lease!.revision,
      root_identity_digest: hash,
      registration_digest: hash,
      preservation_digest: hash,
      created_at: time(12),
    });
    const observation = observe(intent.intent_digest, 12);
    expect(removals.appendIntent(canonicalJSONStringify(intent)).recorded).toBe(true);
    expect(removals.appendObservation(canonicalJSONStringify(observation)).recorded).toBe(true);
    expect(
      removals.selectObservation(
        "remove",
        intent.intent_digest,
        observation.observation_digest,
        null
      )
    ).toBe(true);
    return {
      controller,
      expectedRunRevision: 0,
      operationId: "remove",
      intentDigest: intent.intent_digest,
      observationDigest: observation.observation_digest,
      expectedAttemptRevision: attempt!.revision,
      executorId: "no-executor-launched",
      now: time(12),
      maxObservationAgeMs: 0,
    };
  }
  function observe(intentDigest: string, seconds: number) {
    return createRemovalObservation({
      schema_version: "workspace-removal-observation/1",
      intent_digest: intentDigest,
      observed_at: time(seconds),
      root_state: "present",
      root_identity_digest: hash,
      contents: "remaining",
      registration_state: "present",
      registration_digest: hash,
    });
  }
  function resolvePending() {
    const operation = removals.readOperation("remove")!;
    const fresh = observe(operation.admission.intentDigest, 13);
    expect(removals.appendObservation(canonicalJSONStringify(fresh)).recorded).toBe(true);
    expect(
      removals.resolveRemoval({
        controller,
        expectedRunRevision: 0,
        operationId: "remove",
        admissionDigest: operation.admission.admissionDigest,
        observationDigest: fresh.observation_digest,
        now: time(13),
        maxObservationAgeMs: 0,
      }).kind
    ).toBe("resolved");
  }
  function state() {
    const db = new Database(path, { readonly: true });
    try {
      return Object.fromEntries(
        [
          "attempts",
          "workspace_leases",
          "worker_sessions",
          "worker_adapter_bindings",
          "worker_session_events",
          "worker_session_mutations",
          "workspace_lifecycle_events",
          "workspace_lifecycle_mutations",
          "attempt_receipts",
          "attempt_receipt_events",
          "attempt_receipt_mutations",
          "attempt_verification_authorizations",
          "attempt_verification_begin_mutations",
          "attempt_verification_events",
          "attempt_verifications",
          "attempt_verification_mutations",
        ].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])
      );
    } finally {
      db.close();
    }
  }
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "removal-worker-"));
    path = join(directory, "journal.db");
    lifecycle = new SqliteWorkspaceLifecycleStore(path);
    worker = new SqliteWorkspaceLifecycleStore(path); // Open before the opt-in guards.
    expect(
      (
        await lifecycle.acquireControllerLease({
          ...controller,
          now: time(0),
          ttlMs: 60000,
          initialState: {},
        })
      ).acquired
    ).toBe(true);
    expect(
      (
        await lifecycle.createAttempt({
          ...auth,
          mutationId: "create",
          now: time(0),
          attemptId: "attempt",
          workItemId: "work",
          workItemRevision: 1,
          packetId: "packet",
          packetHash: packet.packet_hash,
          baseSha: "a".repeat(40),
        })
      ).updated
    ).toBe(true);
    expect(
      (
        await lifecycle.acquireWorkspace({
          ...auth,
          ...identity,
          mutationId: "reserve",
          now: time(1),
          workspaceLeaseId: "workspace",
          workItemId: "work",
          baseSha: "a".repeat(40),
          expectedAttemptRevision: 0,
          ttlMs: 120000,
          observation: {
            ...identity,
            exists: true,
            registered: true,
            headSha: "a".repeat(40),
            cleanliness: "clean",
          },
        })
      ).updated
    ).toBe(true);
    expect(
      (
        await lifecycle.transitionAttempt({
          ...auth,
          mutationId: "launch",
          now: time(2),
          attemptId: "attempt",
          expectedAttemptRevision: 1,
          status: "launching",
        })
      ).updated
    ).toBe(true);
    expect(
      (
        await lifecycle.bindLaunchEnvelope({
          ...auth,
          attemptId: "attempt",
          workspaceLeaseId: "workspace",
          expectedAttemptRevision: 2,
          expectedWorkspaceLeaseRevision: 0,
          authorizationMutationId: "launch",
          envelopeId: "envelope",
          envelopeHash: computeCanonicalHash(envelope),
          envelopeJson: canonicalJSONStringify(envelope),
          packetJson: canonicalJSONStringify(packet),
          createdAt: time(2.25),
        })
      ).bound
    ).toBe(true);
    removals = new SqliteRemovalOperationStore(path);
  });
  afterEach(async () => {
    await removals?.close();
    await worker?.close();
    await lifecycle?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("rolls back attachment if removal wins, preserving its mutation ID for explicit recovery", async () => {
    expect(removals.admitRemoval(await seedRemoval()).kind).toBe("admitted");
    const before = state();
    const request = { ...attach(), now: time(14) };
    expect(await worker.attachWorkerSession(request)).toEqual({
      updated: false,
      reason: "removal_operation_pending",
    });
    expect(state()).toEqual(before);
    resolvePending();
    // This fixture never ran a removal. The recovery observation is state-only.
    expect((await worker.attachWorkerSession(request)).updated).toBe(true);
  });

  it.each(["starting", "running", "awaiting_human"] as const)(
    "refuses removal after attachment with a %s worker",
    async (status) => {
      expect((await worker.attachWorkerSession(attach())).updated).toBe(true);
      if (status === "starting") {
        const db = new Database(path);
        try {
          db.prepare(
            "UPDATE worker_sessions SET status='starting' WHERE sessionId='session'"
          ).run();
        } finally {
          db.close();
        }
      }
      if (status === "awaiting_human")
        expect(
          (await worker.heartbeatWorkerSession({ ...sessionMutation(), status })).updated
        ).toBe(true);
      const input = await seedRemoval();
      const before = state();
      expect(removals.admitRemoval(input)).toEqual({
        kind: "rejected",
        reason: "worker_session_not_terminal",
      });
      expect(state()).toEqual(before);
      expect(removals.readOperation("remove")).toBeNull();
      expect(
        (
          await worker.heartbeatWorkerSession({
            ...sessionMutation(status === "awaiting_human" ? 1 : 0),
            mutationId: "fresh-heartbeat",
            now: time(14),
          })
        ).updated
      ).toBe(true);
      expect(
        removals.admitRemoval({ ...input, now: time(50), maxObservationAgeMs: 40000 })
      ).toEqual({ kind: "rejected", reason: "worker_session_not_terminal" });
    }
  );

  it.each(["completed", "failed", "cancelled", "lost"] as const)(
    "admits after recorded %s termination without claiming physical quiescence",
    async (status) => {
      expect((await worker.attachWorkerSession(attach())).updated).toBe(true);
      expect((await worker.endWorkerSession({ ...sessionMutation(), status })).updated).toBe(true);
      expect(removals.admitRemoval(await seedRemoval()).kind).toBe("admitted");
    }
  );

  it("rolls back a completed worker receipt and its evidence while removal remains unresolved", async () => {
    expect((await worker.attachWorkerSession(attach())).updated).toBe(true);
    expect(
      (await worker.endWorkerSession({ ...sessionMutation(), status: "completed" })).updated
    ).toBe(true);
    expect(removals.admitRemoval(await seedRemoval()).kind).toBe("admitted");
    const before = state();
    const request = { ...submitReceipt(), now: time(14) };
    expect(await worker.submitAttemptReceipt(request)).toEqual({
      submitted: false,
      reason: "removal_operation_pending",
    });
    expect(state()).toEqual(before);
    resolvePending();
    expect((await worker.submitAttemptReceipt(request)).submitted).toBe(true);
  });

  it("does not turn unrelated SQLite trigger failures into a recovery result", async () => {
    const db = new Database(path);
    try {
      db.exec(
        "CREATE TRIGGER synthetic_failure BEFORE UPDATE ON attempts BEGIN SELECT RAISE(ABORT, 'synthetic_failure'); END;"
      );
    } finally {
      db.close();
    }
    await expect(worker.attachWorkerSession(attach())).rejects.toThrow("synthetic_failure");
    expect(await worker.getWorkerSessionForAttempt("attempt")).toBeNull();
    expect(await worker.listWorkerSessionEvents("run")).toEqual([]);
  });

  async function prepareReceipt() {
    expect((await worker.attachWorkerSession(attach())).updated).toBe(true);
    expect(
      (await worker.endWorkerSession({ ...sessionMutation(), status: "completed" })).updated
    ).toBe(true);
    const submitted = await worker.submitAttemptReceipt(submitReceipt());
    if (!submitted.submitted) throw new Error(`receipt setup: ${submitted.reason}`);
    return {
      ...auth,
      mutationId: "begin-verification",
      now: time(11),
      verificationId: "verification",
      attemptId: "attempt",
      expectedAttemptRevision: 4,
      workspaceLeaseId: "workspace",
      expectedWorkspaceLeaseRevision: 0,
      workerSessionId: "session",
      expectedWorkerSessionRevision: 1,
      receiptId: "receipt",
      receiptHash: submitted.receipt.receiptHash,
    };
  }

  it("keeps verification authorization uncommitted until pending removal recovery", async () => {
    const request = { ...(await prepareReceipt()), now: time(14) };
    expect(removals.admitRemoval(await seedRemoval()).kind).toBe("admitted");
    const before = state();
    expect(await worker.beginAttemptVerification(request)).toEqual({
      started: false,
      reason: "removal_operation_pending",
    });
    expect(state()).toEqual(before);
    resolvePending();
    expect((await worker.beginAttemptVerification(request)).started).toBe(true);
  });

  it("rolls back verification completion without losing its authorization", async () => {
    const begun = await prepareReceipt();
    expect((await worker.beginAttemptVerification(begun)).started).toBe(true);
    expect(removals.admitRemoval(await seedRemoval()).kind).toBe("admitted");
    const before = state();
    const request = {
      ...auth,
      mutationId: "complete-verification",
      now: time(14),
      attemptId: "attempt",
      expectedAttemptRevision: 5,
      workspaceLeaseId: "workspace",
      expectedWorkspaceLeaseRevision: 0,
      workerSessionId: "session",
      expectedWorkerSessionRevision: 1,
      receiptId: "receipt",
      receiptHash: begun.receiptHash,
      verification: parseAgentEngineVerificationV2({
        schema_version: "2.0.0",
        verification_id: "verification",
        run_id: "run",
        work_item_id: "work",
        work_item_revision: 1,
        attempt_id: "attempt",
        packet_id: "packet",
        packet_hash: packet.packet_hash,
        workspace_lease_id: "workspace",
        workspace_lease_revision: 0,
        worker_session_id: "session",
        worker_session_revision: 1,
        receipt_id: "receipt",
        receipt_hash: begun.receiptHash,
        observed_base_sha: "a".repeat(40),
        verified_patch_hash: hash,
        workspace_observation_hash: hash,
        outcome: "pass",
        summary: "Controlled verifier",
        checks: [],
        failures: [],
        trust_gap_reasons: [],
        verifier_id: "fixture",
        verifier_version: "1.0.0",
        started_at: time(11),
        completed_at: time(14),
      }),
    };
    expect(await worker.submitAttemptVerification(request)).toEqual({
      recorded: false,
      reason: "removal_operation_pending",
    });
    expect(state()).toEqual(before);
    resolvePending();
    expect((await worker.submitAttemptVerification(request)).recorded).toBe(true);
  });

  it.each(["failed", "cancelled", "lost"] as const)(
    "preserves worker and attempt atomically on legacy overlapping %s completion",
    async (status) => {
      expect((await worker.attachWorkerSession(attach())).updated).toBe(true);
      const input = await seedRemoval();
      // Simulate an unresolved record admitted by the preceding implementation,
      // which did not exclude live workers. No production override is introduced.
      const body = {
        schemaVersion: "removal-admission/1",
        operationId: input.operationId,
        intentDigest: input.intentDigest,
        observationDigest: input.observationDigest,
        expectedRunRevision: input.expectedRunRevision,
        expectedAttemptRevision: input.expectedAttemptRevision,
        controller,
        executorId: input.executorId,
        admittedAt: input.now,
        workspaceLeaseId: "workspace",
      };
      const db = new Database(path);
      try {
        db.prepare(
          "INSERT INTO removal_operations(operationId,workspaceLeaseId,admissionJson) VALUES(?,?,?)"
        ).run(
          "remove",
          "workspace",
          canonicalJSONStringify({ ...body, admissionDigest: computeCanonicalHash(body) })
        );
      } finally {
        db.close();
      }
      const before = state();
      const request = { ...sessionMutation(), now: time(14), status };
      expect(await worker.endWorkerSession(request)).toEqual({
        updated: false,
        reason: "removal_operation_pending",
      });
      expect(state()).toEqual(before);
      resolvePending();
      expect((await worker.endWorkerSession(request)).updated).toBe(true);
    }
  );
});
