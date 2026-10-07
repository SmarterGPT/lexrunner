/**
 * Controller coordination persistence contract.
 *
 * This contract is deliberately separate from the frozen RunStore contract.
 * It coordinates which controller may advance a run and provides optimistic
 * concurrency control for that run's serialized orchestration state.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ControllerLease {
  runId: string;
  controllerId: string;
  leaseId: string;
  /**
   * Monotonically increasing token. A controller must present the exact token
   * on every mutation so a superseded controller cannot write after takeover.
   */
  fencingToken: number;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
}

export interface ControllerLeaseCredential {
  runId: string;
  controllerId: string;
  leaseId: string;
  fencingToken: number;
}

export interface RunCoordinationRecord {
  runId: string;
  revision: number;
  state: JsonValue;
  updatedAt: string;
  lease: ControllerLease | null;
}

export interface AcquireControllerLeaseInput {
  runId: string;
  controllerId: string;
  /** Caller-generated ID, making an uncertain acquisition retry idempotent. */
  leaseId: string;
  /** Explicit clock input keeps lease behavior deterministic in tests/replay. */
  now: string;
  ttlMs: number;
  /** Used only when this is the first coordination record for the run. */
  initialState: JsonValue;
}

export interface RenewControllerLeaseInput extends ControllerLeaseCredential {
  now: string;
  ttlMs: number;
}

export type ReleaseControllerLeaseInput = ControllerLeaseCredential;

export interface CompareAndSetRunStateInput extends ControllerLeaseCredential {
  expectedRevision: number;
  /** Stable caller-generated key for uncertain mutation retries. */
  mutationId: string;
  state: JsonValue;
  event: RunCoordinationEventInput;
  now: string;
  /** Optional protected, process-local veto. Stores must call synchronously after
   * preparation and immediately before a new atomic mutation, with no intervening
   * await. It must be pure, non-reentrant and return true to permit the write.
   * Never serialized or treated as authority; replay creates no new mutation. */
  commitGuard?: () => boolean;
}

export interface RunCoordinationEventInput {
  type: string;
  payload: JsonValue;
}

/** Authoritative event committed atomically with its resulting run revision. */
export interface RunCoordinationEvent extends RunCoordinationEventInput {
  runId: string;
  mutationId: string;
  revision: number;
  expectedRevision: number;
  controllerId: string;
  leaseId: string;
  fencingToken: number;
  createdAt: string;
  /** Exact state committed by this mutation, retained for faithful replay. */
  resultingState: JsonValue;
}

export type LeaseFailureReason =
  | "held_by_other"
  | "not_found"
  | "no_active_lease"
  | "lease_mismatch"
  | "stale_fence"
  | "lease_expired";

export type AcquireControllerLeaseResult =
  | { acquired: true; lease: ControllerLease; record: RunCoordinationRecord }
  | { acquired: false; reason: "held_by_other"; currentLease: ControllerLease };

export type RenewControllerLeaseResult =
  | { renewed: true; lease: ControllerLease }
  | { renewed: false; reason: Exclude<LeaseFailureReason, "held_by_other"> };

export type ReleaseControllerLeaseResult =
  | { released: true }
  | {
      released: false;
      reason: Exclude<LeaseFailureReason, "held_by_other" | "lease_expired">;
    };

export type CompareAndSetRunStateResult =
  | {
      updated: true;
      record: RunCoordinationRecord;
      event: RunCoordinationEvent;
      idempotentReplay: boolean;
    }
  | {
      updated: false;
      reason:
        | Exclude<LeaseFailureReason, "held_by_other">
        | "stale_revision"
        | "mutation_conflict"
        | "commit_condition_failed";
      currentRevision?: number;
    };

export interface CoordinationStore {
  acquireControllerLease(input: AcquireControllerLeaseInput): Promise<AcquireControllerLeaseResult>;

  renewControllerLease(input: RenewControllerLeaseInput): Promise<RenewControllerLeaseResult>;

  releaseControllerLease(input: ReleaseControllerLeaseInput): Promise<ReleaseControllerLeaseResult>;

  getControllerLease(runId: string): Promise<ControllerLease | null>;

  getRunCoordination(runId: string): Promise<RunCoordinationRecord | null>;

  listRunCoordinationEvents(runId: string): Promise<RunCoordinationEvent[]>;

  compareAndSetRunState(input: CompareAndSetRunStateInput): Promise<CompareAndSetRunStateResult>;

  close(): Promise<void>;
}

export function parseInstant(value: string, fieldName: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${fieldName} must be a valid ISO 8601 timestamp`);
  }
  return timestamp;
}

export function calculateExpiry(now: string, ttlMs: number): string {
  const nowMs = parseInstant(now, "now");
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new TypeError("ttlMs must be a positive safe integer");
  }
  return new Date(nowMs + ttlMs).toISOString();
}

export function cloneJsonValue<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function credentialFailureReason(
  lease: ControllerLease | null,
  credential: ControllerLeaseCredential
): "no_active_lease" | "lease_mismatch" | "stale_fence" | null {
  if (!lease) {
    return "no_active_lease";
  }
  if (lease.fencingToken !== credential.fencingToken) {
    return "stale_fence";
  }
  if (
    lease.controllerId !== credential.controllerId ||
    lease.leaseId !== credential.leaseId ||
    lease.runId !== credential.runId
  ) {
    return "lease_mismatch";
  }
  return null;
}
