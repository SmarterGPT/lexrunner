import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteWorkspaceLifecycleStore } from "../../src/store/sqlite/workspace-lifecycle-store.js";
import { SqliteRemovalEvidenceStore } from "../../src/store/sqlite/removal-evidence-store.js";
import {
  assessReservedRemovalRecovery,
  createRemovalIntent,
  createRemovalObservation,
} from "../../src/workspaces/workspace-removal-evidence.js";
import { canonicalJSONStringify } from "../../src/util/canonicalJson.js";

const now = "2026-09-22T00:00:00Z";
const hash = `sha256:${"a".repeat(64)}`;
describe("removal intent reservation binding", () => {
  let directory: string;
  let lifecycle: SqliteWorkspaceLifecycleStore;
  let journal: SqliteRemovalEvidenceStore;
  let input: Parameters<typeof assessReservedRemovalRecovery>[0];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "removal-binding-"));
    const database = join(directory, "store.db");
    lifecycle = new SqliteWorkspaceLifecycleStore(database);
    const acquired = await lifecycle.acquireControllerLease({
      runId: "run",
      controllerId: "controller",
      leaseId: "controller-lease",
      now,
      ttlMs: 60_000,
      initialState: {},
    });
    if (!acquired.acquired) throw new Error("controller setup");
    const controller = {
      runId: "run",
      controllerId: "controller",
      leaseId: "controller-lease",
      fencingToken: acquired.lease.fencingToken,
    };
    const common = { runId: "run", expectedRunRevision: 0, controller, now };
    const created = await lifecycle.createAttempt({
      ...common,
      mutationId: "create",
      attemptId: "attempt",
      workItemId: "work",
      workItemRevision: 1,
      packetId: "packet",
      packetHash: hash,
      baseSha: "a".repeat(40),
    });
    expect(created.updated).toBe(true);
    const reserved = await lifecycle.acquireWorkspace({
      ...common,
      mutationId: "reserve",
      attemptId: "attempt",
      workspaceLeaseId: "workspace",
      expectedAttemptRevision: 0,
      workItemId: "work",
      repositoryId: "repo",
      hostId: "host",
      gitRuntime: "fixture",
      projectRoot: directory,
      branch: "agent/task",
      worktreePath: join(directory, "worker"),
      baseSha: "a".repeat(40),
      ttlMs: 10_000,
    });
    expect(reserved.updated).toBe(true);
    const intent = createRemovalIntent({
      schema_version: "workspace-removal-intent/1",
      operation_id: "remove",
      attempt_id: "attempt",
      lease_id: "workspace",
      lease_revision: 0,
      root_identity_digest: hash,
      registration_digest: hash,
      preservation_digest: hash,
      created_at: now,
    });
    const observation = createRemovalObservation({
      schema_version: "workspace-removal-observation/1",
      intent_digest: intent.intent_digest,
      observed_at: now,
      root_state: "absent",
      root_identity_digest: null,
      contents: "unknown",
      registration_state: "absent",
      registration_digest: null,
    });
    journal = new SqliteRemovalEvidenceStore(database);
    expect(journal.appendIntent(canonicalJSONStringify(intent)).recorded).toBe(true);
    expect(journal.appendObservation(canonicalJSONStringify(observation)).recorded).toBe(true);
    expect(
      journal.selectObservation(
        "remove",
        intent.intent_digest,
        observation.observation_digest,
        null
      )
    ).toBe(true);
    await lifecycle.close();
    await journal.close();
    lifecycle = new SqliteWorkspaceLifecycleStore(database, { readOnly: true });
    journal = new SqliteRemovalEvidenceStore(database, { readOnly: true });
    const selected = journal.readSelection("remove", intent.intent_digest)!;
    input = {
      intentBytes: selected.intentBytes,
      observationBytes: selected.observationBytes,
      expectedIntentDigest: intent.intent_digest,
      expectedObservationDigest: selected.observationDigest,
      now,
      maxObservationAgeMs: 0,
      attempt: await lifecycle.getAttempt("attempt"),
      lease: await lifecycle.getWorkspaceLease("workspace"),
    };
  });
  afterEach(async () => {
    await lifecycle?.close();
    await journal?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("assesses reopened selected evidence without releasing its real reservation", async () => {
    expect(assessReservedRemovalRecovery(input)).toMatchObject({
      state: "absence_observed",
      authorizesMutation: false,
    });
    expect(await lifecycle.getWorkspaceLease("workspace")).toEqual(input.lease);
    expect(await lifecycle.getAttempt("attempt")).toEqual(input.attempt);
    expect(await lifecycle.listWorkspaceLifecycleEvents("run")).toHaveLength(2);
  });
  it.each(["attemptId", "runId", "workItemId", "packetId", "packetHash", "baseSha"] as const)(
    "rejects mismatched %s",
    (key) => {
      expect(
        assessReservedRemovalRecovery({ ...input, lease: { ...input.lease!, [key]: "different" } })
          .state
      ).toBe("reconciliation_required");
    }
  );
  it.each(["runRevision", "workItemRevision"] as const)("rejects mismatched %s", (key) => {
    expect(
      assessReservedRemovalRecovery({ ...input, lease: { ...input.lease!, [key]: 99 } }).reason
    ).toBe("reservation_binding_mismatch");
  });
  it.each(["released", "preserved", "abandoned"] as const)("rejects %s reservations", (status) => {
    expect(
      assessReservedRemovalRecovery({ ...input, lease: { ...input.lease!, status } }).reason
    ).toBe("reservation_not_held");
  });
  it("rejects revision drift and reassignment instead of adopting newer ownership", () => {
    expect(
      assessReservedRemovalRecovery({ ...input, lease: { ...input.lease!, revision: 1 } }).reason
    ).toBe("reservation_revision_changed");
    expect(
      assessReservedRemovalRecovery({
        ...input,
        attempt: { ...input.attempt!, workspaceLeaseId: "other" },
      }).reason
    ).toBe("reservation_binding_mismatch");
  });
  it("retains the verifier's freshness checks", () => {
    expect(assessReservedRemovalRecovery({ ...input, now: "2026-09-22T00:00:01Z" }).reason).toBe(
      "evidence_time_invalid"
    );
  });
  it("fails on missing records and does not equate quarantine with released storage", () => {
    expect(assessReservedRemovalRecovery({ ...input, attempt: null }).state).toBe(
      "reconciliation_required"
    );
    expect(assessReservedRemovalRecovery({ ...input, lease: null }).state).toBe(
      "reconciliation_required"
    );
    expect(
      assessReservedRemovalRecovery({ ...input, lease: { ...input.lease!, status: "quarantined" } })
    ).toMatchObject({ state: "absence_observed", authorizesMutation: false });
  });
});
