import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteWorkspaceLifecycleStore } from "../../../src/store/sqlite/workspace-lifecycle-store.js";
import {
  SqliteRemovalOperationStore,
  type RemovalAdmissionInput,
} from "../../../src/store/sqlite/removal-operation-store.js";
import {
  createRemovalIntent,
  createRemovalObservation,
} from "../../../src/workspaces/workspace-removal-evidence.js";
import { canonicalJSONStringify } from "../../../src/util/canonicalJson.js";

const hash = `sha256:${"a".repeat(64)}`;
const time = (seconds: number) => new Date(Date.UTC(2026, 8, 24, 0, 0, seconds)).toISOString();
const controller = { runId: "run", controllerId: "first", leaseId: "first-lease", fencingToken: 1 };
describe("durable removal admission and observation recovery", () => {
  let directory: string, database: string;
  let lifecycle: SqliteWorkspaceLifecycleStore;
  let store: SqliteRemovalOperationStore;
  let input: RemovalAdmissionInput;
  const intentFor = (operationId = "remove") =>
    createRemovalIntent({
      schema_version: "workspace-removal-intent/1",
      operation_id: operationId,
      attempt_id: "attempt",
      lease_id: "workspace",
      lease_revision: 0,
      root_identity_digest: hash,
      registration_digest: hash,
      preservation_digest: hash,
      created_at: time(0),
    });
  const observationFor = (intentDigest: string, seconds = 0, absent = false) =>
    createRemovalObservation({
      schema_version: "workspace-removal-observation/1",
      intent_digest: intentDigest,
      observed_at: time(seconds),
      root_state: absent ? "absent" : "present",
      root_identity_digest: absent ? null : hash,
      contents: absent ? "unknown" : "remaining",
      registration_state: absent ? "absent" : "present",
      registration_digest: absent ? null : hash,
    });
  async function replace() {
    const result = await lifecycle.acquireControllerLease({
      runId: "run",
      controllerId: "next",
      leaseId: "next-lease",
      now: time(61),
      ttlMs: 60_000,
      initialState: {},
    });
    expect(result.acquired).toBe(true);
    return { runId: "run", controllerId: "next", leaseId: "next-lease", fencingToken: 2 };
  }
  function seed(operationId = "remove") {
    const intent = intentFor(operationId),
      observation = observationFor(intent.intent_digest);
    expect(store.appendIntent(canonicalJSONStringify(intent)).recorded).toBe(true);
    expect(store.appendObservation(canonicalJSONStringify(observation)).recorded).toBe(true);
    expect(
      store.selectObservation(
        operationId,
        intent.intent_digest,
        observation.observation_digest,
        null
      )
    ).toBe(true);
    return {
      operationId,
      intentDigest: intent.intent_digest,
      observationDigest: observation.observation_digest,
    };
  }
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "removal-admission-"));
    database = join(directory, "state.db");
    lifecycle = new SqliteWorkspaceLifecycleStore(database);
    expect(
      (
        await lifecycle.acquireControllerLease({
          ...controller,
          now: time(0),
          ttlMs: 60_000,
          initialState: {},
        })
      ).acquired
    ).toBe(true);
    const common = { controller, runId: "run", expectedRunRevision: 0, now: time(0) };
    expect(
      (
        await lifecycle.createAttempt({
          ...common,
          mutationId: "create",
          attemptId: "attempt",
          workItemId: "work",
          workItemRevision: 1,
          packetId: "packet",
          packetHash: hash,
          baseSha: "a".repeat(40),
        })
      ).updated
    ).toBe(true);
    expect(
      (
        await lifecycle.acquireWorkspace({
          ...common,
          mutationId: "reserve",
          attemptId: "attempt",
          expectedAttemptRevision: 0,
          workspaceLeaseId: "workspace",
          workItemId: "work",
          repositoryId: "fixture",
          hostId: "host",
          gitRuntime: "fixture",
          projectRoot: directory,
          worktreePath: join(directory, "worker"),
          branch: "fixture/work",
          baseSha: "a".repeat(40),
          ttlMs: 120_000,
        })
      ).updated
    ).toBe(true);
    store = new SqliteRemovalOperationStore(database);
    input = {
      ...seed(),
      expectedRunRevision: 0,
      expectedAttemptRevision: 1,
      controller,
      executorId: "executor-1",
      now: time(1),
      maxObservationAgeMs: 1000,
    };
  });
  afterEach(async () => {
    await store?.close();
    await lifecycle?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("commits once, survives reopen/acknowledgement loss and never re-admits the same operation", async () => {
    const before = await lifecycle.getWorkspaceLease("workspace");
    const admitted = store.admitRemoval(input);
    expect(admitted.kind).toBe("admitted");
    await store.close();
    store = new SqliteRemovalOperationStore(database);
    const next = await replace();
    const replay = store.admitRemoval({
      ...input,
      controller: next,
      executorId: "different-executor",
      now: time(62),
    });
    expect(replay.kind).toBe("replay");
    if (replay.kind === "replay") {
      expect(replay.operation.admission.controller).toEqual(controller);
      expect(replay.operation.admission.executorId).toBe("executor-1");
      expect(replay.operation.resolution).toBeNull();
    }
    expect(await lifecycle.getWorkspaceLease("workspace")).toEqual(before);
  });

  it("serializes admission across independent SQLite connections", async () => {
    const other = new SqliteRemovalOperationStore(database);
    try {
      expect(store.admitRemoval(input).kind).toBe("admitted");
      expect(other.admitRemoval(input).kind).toBe("replay");
      const second = seed("different-operation");
      expect(other.admitRemoval({ ...input, ...second })).toEqual({
        kind: "rejected",
        reason: "unresolved_operation",
      });
    } finally {
      await other.close();
    }
  });

  it.each([
    "intentDigest",
    "observationDigest",
    "expectedAttemptRevision",
    "expectedRunRevision",
  ] as const)("rejects changed %s on replay", (field) => {
    expect(store.admitRemoval(input).kind).toBe("admitted");
    const value = field.endsWith("Digest") ? `sha256:${"b".repeat(64)}` : 2;
    expect(store.admitRemoval({ ...input, [field]: value })).toEqual({
      kind: "rejected",
      reason: "operation_conflict",
    });
  });

  it("rejects stale and expired controllers before recording admission", async () => {
    expect(store.admitRemoval({ ...input, now: time(60), maxObservationAgeMs: 60_000 })).toEqual({
      kind: "rejected",
      reason: "lease_expired",
    });
    await replace();
    expect(store.admitRemoval(input)).toEqual({ kind: "rejected", reason: "stale_fence" });
    expect(store.readOperation("remove")).toBeNull();
  });

  it("requires exact current selection and reservation revisions", async () => {
    const newer = observationFor(input.intentDigest, 1);
    store.appendObservation(canonicalJSONStringify(newer));
    store.selectObservation(
      "remove",
      input.intentDigest,
      newer.observation_digest,
      input.observationDigest
    );
    expect(store.admitRemoval(input)).toEqual({ kind: "rejected", reason: "selection_changed" });
    const current = { ...input, observationDigest: newer.observation_digest };
    expect(store.admitRemoval({ ...current, expectedAttemptRevision: 0 })).toEqual({
      kind: "rejected",
      reason: "stale_attempt_revision",
    });
    expect(store.readOperation("remove")).toBeNull();
    expect(store.admitRemoval(current).kind).toBe("admitted");
  });

  it("requires explicit reservation ownership for a replacement's new admission", async () => {
    const next = await replace();
    expect(
      store.admitRemoval({ ...input, controller: next, now: time(61), maxObservationAgeMs: 61_000 })
    ).toEqual({ kind: "rejected", reason: "reservation_owner_changed" });
  });

  it("records a replacement controller's fresh recovery without releasing or selecting", async () => {
    const before = await lifecycle.getWorkspaceLease("workspace"),
      attempt = await lifecycle.getAttempt("attempt");
    const admitted = store.admitRemoval(input);
    expect(admitted.kind).toBe("admitted");
    if (admitted.kind !== "admitted") throw new Error("setup");
    const next = await replace();
    const observed = observationFor(input.intentDigest, 62, true);
    store.appendObservation(canonicalJSONStringify(observed));
    const resolution = {
      operationId: "remove",
      admissionDigest: admitted.operation.admission.admissionDigest,
      observationDigest: observed.observation_digest,
      controller: next,
      expectedRunRevision: 0,
      now: time(62),
      maxObservationAgeMs: 0,
    };
    expect(store.resolveRemoval({ ...resolution, controller })).toEqual({
      kind: "rejected",
      reason: "stale_fence",
    });
    const result = store.resolveRemoval(resolution);
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") throw new Error("resolution");
    expect(result.operation.resolution).toMatchObject({
      controller: next,
      observedState: "absence_observed",
    });
    await store.close();
    store = new SqliteRemovalOperationStore(database, { readOnly: true });
    expect(store.readOperation("remove")).toEqual(result.operation);
    expect(await lifecycle.getWorkspaceLease("workspace")).toEqual(before);
    expect(await lifecycle.getAttempt("attempt")).toEqual(attempt);
    expect(store.readSelection("remove", input.intentDigest)?.observationDigest).toBe(
      input.observationDigest
    );
  });

  it("makes terminal replay status-only and rejects a competing resolution", () => {
    const admission = store.admitRemoval(input);
    if (admission.kind !== "admitted") throw new Error("setup");
    const observed = observationFor(input.intentDigest, 2);
    store.appendObservation(canonicalJSONStringify(observed));
    const resolution = {
      operationId: "remove",
      admissionDigest: admission.operation.admission.admissionDigest,
      observationDigest: observed.observation_digest,
      controller,
      expectedRunRevision: 0,
      now: time(2),
      maxObservationAgeMs: 0,
    };
    expect(store.resolveRemoval(resolution).kind).toBe("resolved");
    expect(store.resolveRemoval({ ...resolution, now: time(99) }).kind).toBe("replay");
    expect(
      store.resolveRemoval({ ...resolution, observationDigest: input.observationDigest })
    ).toEqual({ kind: "rejected", reason: "resolution_conflict" });
    expect(store.admitRemoval(input).kind).toBe("replay");
    expect(
      store.admitRemoval({
        ...input,
        ...seed("new-operation"),
        now: time(3),
        maxObservationAgeMs: 3000,
      }).kind
    ).toBe("admitted");
  });

  it("does not resolve from pre-admission or unknown observations", () => {
    const admitted = store.admitRemoval(input);
    if (admitted.kind !== "admitted") throw new Error("setup");
    const request = {
      operationId: "remove",
      admissionDigest: admitted.operation.admission.admissionDigest,
      observationDigest: input.observationDigest,
      controller,
      expectedRunRevision: 0,
      now: time(1),
      maxObservationAgeMs: 1000,
    };
    expect(store.resolveRemoval(request)).toEqual({
      kind: "rejected",
      reason: "observation_before_admission",
    });
    const unknown = createRemovalObservation({
      schema_version: "workspace-removal-observation/1",
      intent_digest: input.intentDigest,
      observed_at: time(2),
      registration_state: "present",
      registration_digest: hash,
      root_state: "unknown",
      root_identity_digest: null,
      contents: "unknown",
    });
    expect(store.appendObservation(canonicalJSONStringify(unknown)).recorded).toBe(true);
    expect(
      store.resolveRemoval({
        ...request,
        now: time(2),
        observationDigest: unknown.observation_digest,
      })
    ).toEqual({ kind: "rejected", reason: "observation_unknown" });
    expect(store.readOperation("remove")?.resolution).toBeNull();
  });

  it("refuses changed lifecycle revisions rather than resolving against an old reservation", async () => {
    const admitted = store.admitRemoval(input);
    if (admitted.kind !== "admitted") throw new Error("setup");
    expect(
      (
        await lifecycle.heartbeatWorkspace({
          runId: "run",
          controller,
          expectedRunRevision: 0,
          mutationId: "heartbeat",
          now: time(2),
          attemptId: "attempt",
          workspaceLeaseId: "workspace",
          expectedAttemptRevision: 1,
          expectedWorkspaceLeaseRevision: 0,
          ttlMs: 60_000,
          observation: {
            repositoryId: "fixture",
            hostId: "host",
            gitRuntime: "fixture",
            projectRoot: directory,
            worktreePath: join(directory, "worker"),
            branch: "fixture/work",
            attemptId: "attempt",
            exists: true,
            registered: true,
            headSha: "a".repeat(40),
            cleanliness: "clean",
          },
        })
      ).updated
    ).toBe(true);
    const observed = observationFor(input.intentDigest, 2);
    store.appendObservation(canonicalJSONStringify(observed));
    expect(
      store.resolveRemoval({
        operationId: "remove",
        admissionDigest: admitted.operation.admission.admissionDigest,
        observationDigest: observed.observation_digest,
        controller,
        expectedRunRevision: 0,
        now: time(2),
        maxObservationAgeMs: 0,
      })
    ).toEqual({ kind: "rejected", reason: "stale_attempt_revision" });
    expect(store.readOperation("remove")?.resolution).toBeNull();
  });

  it("validates current run revision independently from the frozen attempt run revision", async () => {
    expect(
      (
        await lifecycle.compareAndSetRunState({
          ...controller,
          expectedRevision: 0,
          mutationId: "advance-run",
          now: time(1),
          state: {},
          event: { type: "progress", payload: {} },
        })
      ).updated
    ).toBe(true);
    expect(store.admitRemoval(input)).toEqual({ kind: "rejected", reason: "stale_run_revision" });
    expect(store.admitRemoval({ ...input, expectedRunRevision: 1 }).kind).toBe("admitted");
  });
});
