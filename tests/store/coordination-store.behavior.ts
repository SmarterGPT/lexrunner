import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ControllerLease,
  ControllerLeaseCredential,
  CoordinationStore,
} from "../../src/store/coordination-store.js";

export interface CoordinationStoreHarness {
  primary: CoordinationStore;
  /** A separately constructed handle when the implementation supports it. */
  secondary: CoordinationStore;
  cleanup(): Promise<void>;
}

export interface CoordinationStoreHarnessFactory {
  name: string;
  create(): Promise<CoordinationStoreHarness>;
}

const T0 = "2026-07-11T12:00:00.000Z";
const T1 = "2026-07-11T12:00:01.000Z";
const T2 = "2026-07-11T12:00:02.000Z";

function credential(lease: ControllerLease): ControllerLeaseCredential {
  return {
    runId: lease.runId,
    controllerId: lease.controllerId,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
  };
}

function mutation(mutationId: string, phase: string) {
  return {
    mutationId,
    event: { type: "phase_changed", payload: { phase } },
  };
}

export function runCoordinationStoreBehaviorTests(factory: CoordinationStoreHarnessFactory): void {
  describe(`${factory.name} coordination behavior`, () => {
    let harness!: CoordinationStoreHarness;

    beforeEach(async () => {
      harness = await factory.create();
    });

    afterEach(async () => {
      await harness?.cleanup();
    });

    it("vetoes a new mutation atomically without changing state or consuming its idempotency key", async () => {
      const acquired = await harness.primary.acquireControllerLease({
        runId: "guard",
        controllerId: "controller",
        leaseId: "lease",
        now: T0,
        ttlMs: 60000,
        initialState: { phase: "initial" },
      });
      if (!acquired.acquired) throw new Error("fixture acquisition failed");
      const input = {
        ...credential(acquired.lease),
        expectedRevision: 0,
        ...mutation("guarded-write", "next"),
        state: { phase: "next" },
        now: T1,
      };
      for (const guard of [
        () => false,
        () => {
          throw new Error("guard failed");
        },
      ]) {
        try {
          expect(
            await harness.primary.compareAndSetRunState({ ...input, commitGuard: guard })
          ).toMatchObject({ updated: false, reason: "commit_condition_failed" });
        } catch (error) {
          expect((error as Error).message).toBe("guard failed");
        }
        expect(await harness.secondary.getRunCoordination("guard")).toMatchObject({
          revision: 0,
          state: { phase: "initial" },
        });
        expect(await harness.secondary.listRunCoordinationEvents("guard")).toEqual([]);
      }
      expect(
        await harness.primary.compareAndSetRunState({ ...input, commitGuard: () => true })
      ).toMatchObject({ updated: true, idempotentReplay: false });
      // Replay observes the original commit. It must not invoke a guard or mutate again.
      expect(
        await harness.primary.compareAndSetRunState({
          ...input,
          commitGuard: () => {
            throw new Error("replay invoked guard");
          },
        })
      ).toMatchObject({ updated: true, idempotentReplay: true });
      expect(await harness.secondary.listRunCoordinationEvents("guard")).toHaveLength(1);
    });

    it("allows exactly one winner when controllers race to acquire a run", async () => {
      const [first, second] = await Promise.all([
        harness!.primary.acquireControllerLease({
          runId: "run-race",
          controllerId: "controller-a",
          leaseId: "lease-a",
          now: T0,
          ttlMs: 10_000,
          initialState: { phase: "assigned" },
        }),
        harness!.secondary.acquireControllerLease({
          runId: "run-race",
          controllerId: "controller-b",
          leaseId: "lease-b",
          now: T0,
          ttlMs: 10_000,
          initialState: { phase: "different-initial-state" },
        }),
      ]);

      const winners = [first, second].filter((result) => result.acquired);
      const losers = [first, second].filter((result) => !result.acquired);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]).toMatchObject({ acquired: false, reason: "held_by_other" });
      expect(winners[0].acquired && winners[0].lease.fencingToken).toBe(1);

      const record = await harness.primary.getRunCoordination("run-race");
      expect(record?.revision).toBe(0);
      expect(record?.state).toEqual(
        first.acquired ? { phase: "assigned" } : { phase: "different-initial-state" }
      );
    });

    it("makes an uncertain acquisition retry idempotent", async () => {
      const first = await harness.primary.acquireControllerLease({
        runId: "run-idempotent",
        controllerId: "controller-a",
        leaseId: "lease-a",
        now: T0,
        ttlMs: 10_000,
        initialState: { phase: "assigned" },
      });
      const retry = await harness.secondary.acquireControllerLease({
        runId: "run-idempotent",
        controllerId: "controller-a",
        leaseId: "lease-a",
        now: T1,
        ttlMs: 99_000,
        initialState: { phase: "must-not-replace" },
      });

      expect(first.acquired).toBe(true);
      expect(retry.acquired).toBe(true);
      if (!first.acquired || !retry.acquired) return;
      expect(retry.lease).toEqual(first.lease);
      expect(retry.record.state).toEqual({ phase: "assigned" });
      expect(retry.record.revision).toBe(0);
    });

    it("renews only for the current lease owner and does not change its fence", async () => {
      const acquired = await harness.primary.acquireControllerLease({
        runId: "run-renew",
        controllerId: "controller-a",
        leaseId: "lease-a",
        now: T0,
        ttlMs: 5_000,
        initialState: {},
      });
      expect(acquired.acquired).toBe(true);
      if (!acquired.acquired) return;

      const rejected = await harness.secondary.renewControllerLease({
        ...credential(acquired.lease),
        controllerId: "controller-b",
        leaseId: "lease-b",
        now: T1,
        ttlMs: 20_000,
      });
      expect(rejected).toEqual({ renewed: false, reason: "lease_mismatch" });

      const renewed = await harness.primary.renewControllerLease({
        ...credential(acquired.lease),
        now: T1,
        ttlMs: 20_000,
      });
      expect(renewed.renewed).toBe(true);
      if (!renewed.renewed) return;
      expect(renewed.lease.fencingToken).toBe(acquired.lease.fencingToken);
      expect(renewed.lease.acquiredAt).toBe(T0);
      expect(renewed.lease.renewedAt).toBe(T1);
      expect(renewed.lease.expiresAt).toBe("2026-07-11T12:00:21.000Z");
    });

    it("rejects renewal and state mutation after lease expiry", async () => {
      const acquired = await harness.primary.acquireControllerLease({
        runId: "run-expired",
        controllerId: "controller-a",
        leaseId: "lease-a",
        now: T0,
        ttlMs: 1_000,
        initialState: { phase: "assigned" },
      });
      expect(acquired.acquired).toBe(true);
      if (!acquired.acquired) return;

      await expect(
        harness.primary.renewControllerLease({
          ...credential(acquired.lease),
          now: T1,
          ttlMs: 1_000,
        })
      ).resolves.toEqual({ renewed: false, reason: "lease_expired" });
      await expect(
        harness.primary.compareAndSetRunState({
          ...credential(acquired.lease),
          expectedRevision: 0,
          ...mutation("expired-mutation", "must-not-write"),
          state: { phase: "must-not-write" },
          now: T1,
        })
      ).resolves.toMatchObject({
        updated: false,
        reason: "lease_expired",
        currentRevision: 0,
      });
    });

    it("increments the fence on expired takeover and rejects the stale owner", async () => {
      const first = await harness.primary.acquireControllerLease({
        runId: "run-takeover",
        controllerId: "controller-a",
        leaseId: "lease-a",
        now: T0,
        ttlMs: 1_000,
        initialState: { phase: "assigned" },
      });
      expect(first.acquired).toBe(true);
      if (!first.acquired) return;

      const takeover = await harness.secondary.acquireControllerLease({
        runId: "run-takeover",
        controllerId: "controller-b",
        leaseId: "lease-b",
        now: T1,
        ttlMs: 10_000,
        initialState: { phase: "must-not-replace" },
      });
      expect(takeover.acquired).toBe(true);
      if (!takeover.acquired) return;
      expect(takeover.lease.fencingToken).toBe(first.lease.fencingToken + 1);
      expect(takeover.record.state).toEqual({ phase: "assigned" });

      await expect(
        harness.primary.compareAndSetRunState({
          ...credential(first.lease),
          expectedRevision: 0,
          ...mutation("stale-owner-mutation", "stale-write"),
          state: { phase: "stale-write" },
          now: T2,
        })
      ).resolves.toMatchObject({ updated: false, reason: "stale_fence" });
      expect(await harness.primary.listRunCoordinationEvents("run-takeover")).toEqual([]);
      await expect(
        harness.primary.releaseControllerLease(credential(first.lease))
      ).resolves.toEqual({ released: false, reason: "stale_fence" });
    });

    it("rejects a stale revision without replacing the winning state", async () => {
      const acquired = await harness.primary.acquireControllerLease({
        runId: "run-cas",
        controllerId: "controller-a",
        leaseId: "lease-a",
        now: T0,
        ttlMs: 10_000,
        initialState: { phase: "assigned" },
      });
      expect(acquired.acquired).toBe(true);
      if (!acquired.acquired) return;

      const updated = await harness.primary.compareAndSetRunState({
        ...credential(acquired.lease),
        expectedRevision: 0,
        ...mutation("plan-mutation", "planned"),
        state: { phase: "planned" },
        now: T1,
      });
      expect(updated.updated).toBe(true);
      if (!updated.updated) return;
      expect(updated.record.revision).toBe(1);

      const stale = await harness.secondary.compareAndSetRunState({
        ...credential(acquired.lease),
        expectedRevision: 0,
        ...mutation("stale-revision-mutation", "stale"),
        state: { phase: "stale" },
        now: T2,
      });
      expect(stale).toEqual({
        updated: false,
        reason: "stale_revision",
        currentRevision: 1,
      });
      expect((await harness.primary.getRunCoordination("run-cas"))?.state).toEqual({
        phase: "planned",
      });
      expect(await harness.primary.listRunCoordinationEvents("run-cas")).toHaveLength(1);
    });

    it("commits state and event together and replays a mutation idempotently", async () => {
      const acquired = await harness.primary.acquireControllerLease({
        runId: "run-events",
        controllerId: "controller-a",
        leaseId: "lease-a",
        now: T0,
        ttlMs: 10_000,
        initialState: { phase: "assigned" },
      });
      expect(acquired.acquired).toBe(true);
      if (!acquired.acquired) return;

      const input = {
        ...credential(acquired.lease),
        expectedRevision: 0,
        ...mutation("mutation-1", "planned"),
        state: { phase: "planned" },
        now: T1,
      };
      const first = await harness.primary.compareAndSetRunState(input);
      expect(first).toMatchObject({
        updated: true,
        idempotentReplay: false,
        record: { revision: 1, state: { phase: "planned" } },
        event: { mutationId: "mutation-1", revision: 1, type: "phase_changed" },
      });
      if (!first.updated) return;
      expect(first.event).toMatchObject({
        expectedRevision: 0,
        controllerId: "controller-a",
        leaseId: "lease-a",
        fencingToken: acquired.lease.fencingToken,
      });

      await harness.primary.compareAndSetRunState({
        ...credential(acquired.lease),
        expectedRevision: 1,
        ...mutation("mutation-2", "completed"),
        state: { phase: "completed" },
        now: T2,
      });

      const retry = await harness.secondary.compareAndSetRunState(input);
      expect(retry).toMatchObject({
        updated: true,
        idempotentReplay: true,
        record: { revision: 1, state: { phase: "planned" } },
        event: { mutationId: "mutation-1", revision: 1 },
      });
      expect(await harness.primary.listRunCoordinationEvents("run-events")).toEqual([
        expect.objectContaining({ mutationId: "mutation-1", revision: 1 }),
        expect.objectContaining({ mutationId: "mutation-2", revision: 2 }),
      ]);
      expect((await harness.primary.getRunCoordination("run-events"))?.revision).toBe(2);

      await expect(
        harness.primary.compareAndSetRunState({
          ...input,
          state: { phase: "collision" },
        })
      ).resolves.toMatchObject({ updated: false, reason: "mutation_conflict" });
      await expect(
        harness.primary.compareAndSetRunState({
          ...input,
          expectedRevision: 1,
        })
      ).resolves.toMatchObject({ updated: false, reason: "mutation_conflict" });
      expect(await harness.primary.listRunCoordinationEvents("run-events")).toHaveLength(2);
    });

    it("does not replay a mutation id under a replacement lease", async () => {
      const first = await harness.primary.acquireControllerLease({
        runId: "run-authority-replay",
        controllerId: "controller-a",
        leaseId: "lease-a",
        now: T0,
        ttlMs: 1_000,
        initialState: { phase: "assigned" },
      });
      expect(first.acquired).toBe(true);
      if (!first.acquired) return;
      const originalMutation = {
        ...credential(first.lease),
        expectedRevision: 0,
        ...mutation("authority-bound-mutation", "planned"),
        state: { phase: "planned" },
        now: "2026-07-11T12:00:00.500Z",
      };
      await expect(harness.primary.compareAndSetRunState(originalMutation)).resolves.toMatchObject({
        updated: true,
      });

      const takeover = await harness.secondary.acquireControllerLease({
        runId: "run-authority-replay",
        controllerId: "controller-b",
        leaseId: "lease-b",
        now: T1,
        ttlMs: 10_000,
        initialState: { phase: "must-not-replace" },
      });
      expect(takeover.acquired).toBe(true);
      if (!takeover.acquired) return;

      await expect(
        harness.secondary.compareAndSetRunState({
          ...originalMutation,
          ...credential(takeover.lease),
          now: T2,
        })
      ).resolves.toMatchObject({ updated: false, reason: "mutation_conflict" });
      expect(await harness.primary.listRunCoordinationEvents("run-authority-replay")).toHaveLength(
        1
      );
      expect((await harness.primary.getRunCoordination("run-authority-replay"))?.revision).toBe(1);
    });

    it("releases only the matching lease and preserves revision, state, and fence history", async () => {
      const acquired = await harness.primary.acquireControllerLease({
        runId: "run-release",
        controllerId: "controller-a",
        leaseId: "lease-a",
        now: T0,
        ttlMs: 10_000,
        initialState: { phase: "assigned" },
      });
      expect(acquired.acquired).toBe(true);
      if (!acquired.acquired) return;

      await expect(
        harness.secondary.releaseControllerLease({
          ...credential(acquired.lease),
          controllerId: "controller-b",
        })
      ).resolves.toEqual({ released: false, reason: "lease_mismatch" });
      await expect(
        harness.primary.releaseControllerLease(credential(acquired.lease))
      ).resolves.toEqual({ released: true });
      await expect(harness.primary.getControllerLease("run-release")).resolves.toBeNull();
      await expect(
        harness.primary.releaseControllerLease(credential(acquired.lease))
      ).resolves.toEqual({ released: false, reason: "no_active_lease" });

      const next = await harness.secondary.acquireControllerLease({
        runId: "run-release",
        controllerId: "controller-b",
        leaseId: "lease-b",
        now: T1,
        ttlMs: 10_000,
        initialState: { phase: "must-not-replace" },
      });
      expect(next.acquired).toBe(true);
      if (!next.acquired) return;
      expect(next.lease.fencingToken).toBe(acquired.lease.fencingToken + 1);
      expect(next.record.revision).toBe(0);
      expect(next.record.state).toEqual({ phase: "assigned" });
    });
  });
}
