import type {
  AcquireControllerLeaseInput,
  AcquireControllerLeaseResult,
  CompareAndSetRunStateInput,
  CompareAndSetRunStateResult,
  ControllerLease,
  CoordinationStore,
  ReleaseControllerLeaseInput,
  ReleaseControllerLeaseResult,
  RenewControllerLeaseInput,
  RenewControllerLeaseResult,
  RunCoordinationRecord,
  RunCoordinationEvent,
} from "../coordination-store.js";
import { canonicalJSONStringify } from "../../util/canonicalJson.js";
import {
  calculateExpiry,
  cloneJsonValue,
  credentialFailureReason,
  parseInstant,
} from "../coordination-store.js";

interface StoredCoordinationRecord {
  runId: string;
  revision: number;
  state: RunCoordinationRecord["state"];
  updatedAt: string;
  lease: ControllerLease | null;
  fencingToken: number;
}

/** Deterministic in-memory implementation of the controller coordination contract. */
export class InMemoryCoordinationStore implements CoordinationStore {
  private readonly records = new Map<string, StoredCoordinationRecord>();
  private readonly events = new Map<string, RunCoordinationEvent[]>();

  async acquireControllerLease(
    input: AcquireControllerLeaseInput
  ): Promise<AcquireControllerLeaseResult> {
    const nowMs = parseInstant(input.now, "now");
    const now = new Date(nowMs).toISOString();
    const expiresAt = calculateExpiry(now, input.ttlMs);
    const current = this.records.get(input.runId);

    if (!current) {
      const lease = this.createLease(input, 1, now, expiresAt);
      const record: StoredCoordinationRecord = {
        runId: input.runId,
        revision: 0,
        state: cloneJsonValue(input.initialState),
        updatedAt: now,
        lease,
        fencingToken: lease.fencingToken,
      };
      this.records.set(input.runId, record);
      return { acquired: true, lease: { ...lease }, record: this.toPublicRecord(record) };
    }

    if (current.lease && parseInstant(current.lease.expiresAt, "expiresAt") > nowMs) {
      if (
        current.lease.controllerId === input.controllerId &&
        current.lease.leaseId === input.leaseId
      ) {
        return {
          acquired: true,
          lease: { ...current.lease },
          record: this.toPublicRecord(current),
        };
      }
      return {
        acquired: false,
        reason: "held_by_other",
        currentLease: { ...current.lease },
      };
    }

    const lease = this.createLease(input, current.fencingToken + 1, now, expiresAt);
    current.lease = lease;
    current.fencingToken = lease.fencingToken;
    return { acquired: true, lease: { ...lease }, record: this.toPublicRecord(current) };
  }

  async renewControllerLease(
    input: RenewControllerLeaseInput
  ): Promise<RenewControllerLeaseResult> {
    const record = this.records.get(input.runId);
    if (!record) {
      return { renewed: false, reason: "not_found" };
    }

    const failure = credentialFailureReason(record.lease, input);
    if (failure) {
      return { renewed: false, reason: failure };
    }

    const nowMs = parseInstant(input.now, "now");
    if (parseInstant(record.lease!.expiresAt, "expiresAt") <= nowMs) {
      return { renewed: false, reason: "lease_expired" };
    }

    const renewedAt = new Date(nowMs).toISOString();
    record.lease = {
      ...record.lease!,
      renewedAt,
      expiresAt: calculateExpiry(renewedAt, input.ttlMs),
    };
    return { renewed: true, lease: { ...record.lease } };
  }

  async releaseControllerLease(
    input: ReleaseControllerLeaseInput
  ): Promise<ReleaseControllerLeaseResult> {
    const record = this.records.get(input.runId);
    if (!record) {
      return { released: false, reason: "not_found" };
    }

    const failure = credentialFailureReason(record.lease, input);
    if (failure) {
      return { released: false, reason: failure };
    }

    record.lease = null;
    return { released: true };
  }

  async getControllerLease(runId: string): Promise<ControllerLease | null> {
    const lease = this.records.get(runId)?.lease;
    return lease ? { ...lease } : null;
  }

  async getRunCoordination(runId: string): Promise<RunCoordinationRecord | null> {
    const record = this.records.get(runId);
    return record ? this.toPublicRecord(record) : null;
  }

  async listRunCoordinationEvents(runId: string): Promise<RunCoordinationEvent[]> {
    return (this.events.get(runId) ?? []).map((event) => ({
      ...event,
      payload: cloneJsonValue(event.payload),
      resultingState: cloneJsonValue(event.resultingState),
    }));
  }

  async compareAndSetRunState(
    input: CompareAndSetRunStateInput
  ): Promise<CompareAndSetRunStateResult> {
    const record = this.records.get(input.runId);
    if (!record) {
      return { updated: false, reason: "not_found" };
    }

    const failure = credentialFailureReason(record.lease, input);
    if (failure) {
      return { updated: false, reason: failure, currentRevision: record.revision };
    }

    const nowMs = parseInstant(input.now, "now");
    if (parseInstant(record.lease!.expiresAt, "expiresAt") <= nowMs) {
      return { updated: false, reason: "lease_expired", currentRevision: record.revision };
    }
    const priorEvent = (this.events.get(input.runId) ?? []).find(
      (event) => event.mutationId === input.mutationId
    );
    if (priorEvent) {
      if (
        !sameEventInput(priorEvent, input.event) ||
        canonicalJSONStringify(priorEvent.resultingState) !== canonicalJSONStringify(input.state) ||
        priorEvent.expectedRevision !== input.expectedRevision ||
        priorEvent.controllerId !== input.controllerId ||
        priorEvent.leaseId !== input.leaseId ||
        priorEvent.fencingToken !== input.fencingToken
      ) {
        return {
          updated: false,
          reason: "mutation_conflict",
          currentRevision: record.revision,
        };
      }
      return {
        updated: true,
        record: {
          ...this.toPublicRecord(record),
          revision: priorEvent.revision,
          state: cloneJsonValue(priorEvent.resultingState),
          updatedAt: priorEvent.createdAt,
        },
        event: {
          ...priorEvent,
          payload: cloneJsonValue(priorEvent.payload),
          resultingState: cloneJsonValue(priorEvent.resultingState),
        },
        idempotentReplay: true,
      };
    }
    if (record.revision !== input.expectedRevision) {
      return { updated: false, reason: "stale_revision", currentRevision: record.revision };
    }

    const nextState = cloneJsonValue(input.state);
    if (input.commitGuard && input.commitGuard() !== true)
      return {
        updated: false,
        reason: "commit_condition_failed",
        currentRevision: record.revision,
      };
    record.state = nextState;
    record.revision += 1;
    record.updatedAt = new Date(nowMs).toISOString();
    const event: RunCoordinationEvent = {
      runId: input.runId,
      mutationId: input.mutationId,
      revision: record.revision,
      expectedRevision: input.expectedRevision,
      controllerId: input.controllerId,
      leaseId: input.leaseId,
      fencingToken: input.fencingToken,
      type: input.event.type,
      payload: cloneJsonValue(input.event.payload),
      createdAt: record.updatedAt,
      resultingState: cloneJsonValue(input.state),
    };
    const events = this.events.get(input.runId) ?? [];
    events.push(event);
    this.events.set(input.runId, events);
    return {
      updated: true,
      record: this.toPublicRecord(record),
      event: {
        ...event,
        payload: cloneJsonValue(event.payload),
        resultingState: cloneJsonValue(event.resultingState),
      },
      idempotentReplay: false,
    };
  }

  async close(): Promise<void> {
    // No resources to release.
  }

  /**
   * Execute an in-memory mutation while the presented controller lease is
   * authoritative. Subclasses use this synchronous critical section so a
   * workspace mutation cannot be separated from controller authentication.
   */
  protected withActiveControllerCredential<T>(
    credential: {
      runId: string;
      controllerId: string;
      leaseId: string;
      fencingToken: number;
    },
    now: string,
    expectedRunRevision: number,
    action: () => T
  ):
    | { authenticated: true; value: T }
    | {
        authenticated: false;
        reason:
          | "no_active_lease"
          | "lease_mismatch"
          | "stale_fence"
          | "lease_expired"
          | "stale_run_revision";
        currentRunRevision?: number;
      } {
    const record = this.records.get(credential.runId);
    const failure = credentialFailureReason(record?.lease ?? null, credential);
    if (failure) return { authenticated: false, reason: failure };
    if (record!.revision !== expectedRunRevision) {
      return {
        authenticated: false,
        reason: "stale_run_revision",
        currentRunRevision: record!.revision,
      };
    }
    if (parseInstant(record!.lease!.expiresAt, "expiresAt") <= parseInstant(now, "now")) {
      return { authenticated: false, reason: "lease_expired" };
    }
    return { authenticated: true, value: action() };
  }

  private createLease(
    input: AcquireControllerLeaseInput,
    fencingToken: number,
    now: string,
    expiresAt: string
  ): ControllerLease {
    return {
      runId: input.runId,
      controllerId: input.controllerId,
      leaseId: input.leaseId,
      fencingToken,
      acquiredAt: now,
      renewedAt: now,
      expiresAt,
    };
  }

  private toPublicRecord(record: StoredCoordinationRecord): RunCoordinationRecord {
    return {
      runId: record.runId,
      revision: record.revision,
      state: cloneJsonValue(record.state),
      updatedAt: record.updatedAt,
      lease: record.lease ? { ...record.lease } : null,
    };
  }
}

function sameEventInput(
  event: RunCoordinationEvent,
  input: { type: string; payload: RunCoordinationEvent["payload"] }
): boolean {
  return (
    event.type === input.type &&
    canonicalJSONStringify(event.payload) === canonicalJSONStringify(input.payload)
  );
}
