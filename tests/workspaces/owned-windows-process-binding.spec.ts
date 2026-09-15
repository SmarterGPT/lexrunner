import { describe, expect, it, vi } from "vitest";
import { bindOwnedWindowsProcessObservation } from "../../src/workspaces/owned-windows-process-binding.js";
import type { WorkspaceLifecycleLeaseRecord } from "../../src/store/workspace-lifecycle-store.js";
import type { OwnedWindowsProcessAttempt } from "../../src/workspaces/owned-windows-boundary-handshake.js";
const reference = {
  leaseId: "workspace-1",
  revision: 2,
  attemptId: "attempt-1",
  hostId: "windows-1",
};
const lease: WorkspaceLifecycleLeaseRecord = {
  ...reference,
  repositoryId: "repository-1",
  gitRuntime: "native",
  projectRoot: "D:\\repo",
  branch: "codex/work",
  worktreePath: "D:\\work",
  runId: "run-1",
  runRevision: 1,
  workItemId: "work-1",
  workItemRevision: 1,
  packetId: "packet-1",
  packetHash: `sha256:${"a".repeat(64)}`,
  controllerId: "controller-1",
  controllerLeaseId: "controller-lease-1",
  fencingToken: 3,
  baseSha: "b".repeat(40),
  status: "active",
  acquiredAt: "2026-09-15T05:00:00.000Z",
  heartbeatAt: "2026-09-15T05:00:00.000Z",
  expiresAt: "2026-09-15T06:00:00.000Z",
};
const attempt: OwnedWindowsProcessAttempt = {
  boundaryLeaseId: "boundary-1",
  requestId: "request-1",
  operationId: "operation-1",
  requestDigest: `sha256:${"c".repeat(64)}`,
  startedAt: "2026-09-15T05:01:00.000Z",
  observedAt: "2026-09-15T05:01:01.000Z",
  acknowledged: false,
  cwd: {
    path: "D:\\work",
    file_id: "d".repeat(32),
    volume_serial_number: "e".repeat(16),
    filesystem: "ReFS",
    chain_length: 1,
  },
};
const clock = () => new Date("2026-09-15T05:02:00.000Z");
const store = (value: WorkspaceLifecycleLeaseRecord | null = lease) => ({
  getWorkspaceLease: vi.fn(async () => value),
});
describe("owned process lifecycle association", () => {
  it("associates a stored lease while preserving unknown command effects", async () => {
    const source = store();
    const value = await bindOwnedWindowsProcessObservation(
      source,
      reference,
      attempt,
      undefined,
      clock
    );
    expect(source.getWorkspaceLease).toHaveBeenCalledWith(reference.leaseId);
    expect(value).toMatchObject({
      bound: true,
      binding: {
        boundaryLeaseId: "boundary-1",
        workspaceLeaseId: "workspace-1",
        workspaceLeaseRevision: 2,
        fencingToken: 3,
      },
      projected: {
        ok: false,
        error: { effect_state: "effect_unknown" },
        receipt: {
          lease_id: "boundary-1",
          started_at: attempt.startedAt,
          completed_at: attempt.observedAt,
        },
      },
    });
  });
  it.each([
    { revision: 3 },
    { attemptId: "another" },
    { hostId: "another" },
    { worktreePath: "D:\\another" },
  ])("retains unbound observation on lease mismatch %j", async (change) => {
    expect(
      await bindOwnedWindowsProcessObservation(
        store({ ...lease, ...change }),
        reference,
        attempt,
        undefined,
        clock
      )
    ).toMatchObject({ bound: false, reason: "lease_mismatch", observation: { attempt } });
  });
  it.each([
    { status: "released" as const },
    { expiresAt: "2026-09-15T05:01:01.000Z" },
    { acquiredAt: "2026-09-15T05:01:01.000Z" },
  ])("rejects inactive interval %j", async (change) => {
    expect(
      await bindOwnedWindowsProcessObservation(
        store({ ...lease, ...change }),
        reference,
        attempt,
        undefined,
        clock
      )
    ).toMatchObject({ bound: false, reason: "lease_inactive" });
  });
  it("retains observation on missing lease or lookup failure", async () => {
    expect(
      await bindOwnedWindowsProcessObservation(store(null), reference, attempt, undefined, clock)
    ).toMatchObject({ bound: false, reason: "lease_missing", observation: { attempt } });
    expect(
      await bindOwnedWindowsProcessObservation(
        {
          getWorkspaceLease: async () => {
            throw new Error("offline");
          },
        },
        reference,
        attempt,
        undefined,
        clock
      )
    ).toMatchObject({ bound: false, reason: "lookup_failed", observation: { attempt } });
  });
  it("rejects missing observation time and invalid clock", async () => {
    expect(
      await bindOwnedWindowsProcessObservation(
        store(),
        reference,
        { ...attempt, observedAt: undefined },
        undefined,
        clock
      )
    ).toMatchObject({ bound: false, reason: "observation_invalid" });
    expect(
      await bindOwnedWindowsProcessObservation(
        store(),
        reference,
        attempt,
        undefined,
        () => new Date(NaN)
      )
    ).toMatchObject({ bound: false, reason: "observation_invalid" });
  });
  it("snapshots the input before awaiting the source", async () => {
    const mutable = structuredClone(attempt);
    let resolve!: (value: WorkspaceLifecycleLeaseRecord) => void;
    const pending = bindOwnedWindowsProcessObservation(
      {
        getWorkspaceLease: () =>
          new Promise((r) => {
            resolve = r;
          }),
      },
      reference,
      mutable,
      undefined,
      clock
    );
    (mutable as any).boundaryLeaseId = "swapped";
    resolve(lease);
    expect(await pending).toMatchObject({
      bound: true,
      projected: { receipt: { lease_id: "boundary-1" } },
    });
  });
});
