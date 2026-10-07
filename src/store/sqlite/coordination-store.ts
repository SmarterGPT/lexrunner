import Database from "better-sqlite3-multiple-ciphers";
import type { Database as DatabaseType } from "better-sqlite3-multiple-ciphers";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  AcquireControllerLeaseInput,
  AcquireControllerLeaseResult,
  CompareAndSetRunStateInput,
  CompareAndSetRunStateResult,
  ControllerLease,
  CoordinationStore,
  JsonValue,
  ReleaseControllerLeaseInput,
  ReleaseControllerLeaseResult,
  RenewControllerLeaseInput,
  RenewControllerLeaseResult,
  RunCoordinationEvent,
  RunCoordinationRecord,
} from "../coordination-store.js";
import { canonicalJSONStringify } from "../../util/canonicalJson.js";
import {
  calculateExpiry,
  cloneJsonValue,
  credentialFailureReason,
  parseInstant,
} from "../coordination-store.js";

const INLINE_COORDINATION_MIGRATION = `
  CREATE TABLE IF NOT EXISTS run_coordination (
    runId TEXT PRIMARY KEY,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    stateJson TEXT NOT NULL,
    fencingToken INTEGER NOT NULL DEFAULT 0 CHECK (fencingToken >= 0),
    controllerId TEXT,
    leaseId TEXT,
    acquiredAt TEXT,
    renewedAt TEXT,
    expiresAt TEXT,
    updatedAt TEXT NOT NULL,
    CHECK (
      (controllerId IS NULL AND leaseId IS NULL AND acquiredAt IS NULL AND renewedAt IS NULL AND expiresAt IS NULL)
      OR
      (controllerId IS NOT NULL AND leaseId IS NOT NULL AND acquiredAt IS NOT NULL AND renewedAt IS NOT NULL AND expiresAt IS NOT NULL)
    )
  );
  CREATE INDEX IF NOT EXISTS idx_run_coordination_expiresAt
    ON run_coordination(expiresAt);
  CREATE TABLE IF NOT EXISTS run_coordination_events (
    runId TEXT NOT NULL,
    mutationId TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    expectedRevision INTEGER NOT NULL CHECK (expectedRevision >= 0),
    controllerId TEXT NOT NULL,
    leaseId TEXT NOT NULL,
    fencingToken INTEGER NOT NULL CHECK (fencingToken > 0),
    type TEXT NOT NULL,
    payloadJson TEXT NOT NULL,
    resultingStateJson TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    PRIMARY KEY (runId, mutationId),
    UNIQUE (runId, revision),
    FOREIGN KEY (runId) REFERENCES run_coordination(runId) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS coordination_schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    appliedAt TEXT NOT NULL
  );
  INSERT OR IGNORE INTO coordination_schema_migrations (version, name, appliedAt)
    VALUES (1, 'controller-coordination', datetime('now'));
`;

interface CoordinationRow {
  runId: string;
  revision: number;
  stateJson: string;
  fencingToken: number;
  controllerId: string | null;
  leaseId: string | null;
  acquiredAt: string | null;
  renewedAt: string | null;
  expiresAt: string | null;
  updatedAt: string;
}

interface CoordinationEventRow {
  runId: string;
  mutationId: string;
  revision: number;
  expectedRevision: number;
  controllerId: string;
  leaseId: string;
  fencingToken: number;
  type: string;
  payloadJson: string;
  resultingStateJson: string;
  createdAt: string;
}

export interface SqliteCoordinationStoreOptions {
  readOnly?: boolean;
}

/** SQLite implementation with transactionally serialized lease and CAS operations. */
export class SqliteCoordinationStore implements CoordinationStore {
  /** Shared connection for additive stores whose mutations must share this transaction boundary. */
  protected readonly db: DatabaseType;
  private closed = false;

  constructor(dbPath: string, options: SqliteCoordinationStoreOptions = {}) {
    this.db = new Database(
      dbPath,
      options.readOnly ? { readonly: true, fileMustExist: true } : undefined
    );
    try {
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("busy_timeout = 5000");
      if (!options.readOnly) this.applyCoordinationMigration();
    } catch (error) {
      this.db.close();
      this.closed = true;
      throw error;
    }
  }

  async acquireControllerLease(
    input: AcquireControllerLeaseInput
  ): Promise<AcquireControllerLeaseResult> {
    const nowMs = parseInstant(input.now, "now");
    const now = new Date(nowMs).toISOString();
    const expiresAt = calculateExpiry(now, input.ttlMs);

    return this.immediateTransaction(() => {
      const current = this.selectRow(input.runId);
      if (!current) {
        const lease = this.createLease(input, 1, now, expiresAt);
        this.db
          .prepare(
            `INSERT INTO run_coordination (
              runId, revision, stateJson, fencingToken, controllerId, leaseId,
              acquiredAt, renewedAt, expiresAt, updatedAt
            ) VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            input.runId,
            this.serializeState(input.initialState),
            lease.fencingToken,
            lease.controllerId,
            lease.leaseId,
            lease.acquiredAt,
            lease.renewedAt,
            lease.expiresAt,
            now
          );
        const record = this.requireRow(input.runId);
        return { acquired: true, lease, record: this.rowToRecord(record) };
      }

      const currentLease = this.rowToLease(current);
      if (currentLease && parseInstant(currentLease.expiresAt, "expiresAt") > nowMs) {
        if (
          currentLease.controllerId === input.controllerId &&
          currentLease.leaseId === input.leaseId
        ) {
          return { acquired: true, lease: currentLease, record: this.rowToRecord(current) };
        }
        return { acquired: false, reason: "held_by_other", currentLease };
      }

      const lease = this.createLease(input, current.fencingToken + 1, now, expiresAt);
      this.db
        .prepare(
          `UPDATE run_coordination
           SET fencingToken = ?, controllerId = ?, leaseId = ?, acquiredAt = ?, renewedAt = ?, expiresAt = ?
           WHERE runId = ?`
        )
        .run(
          lease.fencingToken,
          lease.controllerId,
          lease.leaseId,
          lease.acquiredAt,
          lease.renewedAt,
          lease.expiresAt,
          input.runId
        );
      return {
        acquired: true,
        lease,
        record: this.rowToRecord(this.requireRow(input.runId)),
      };
    });
  }

  async renewControllerLease(
    input: RenewControllerLeaseInput
  ): Promise<RenewControllerLeaseResult> {
    const nowMs = parseInstant(input.now, "now");
    const renewedAt = new Date(nowMs).toISOString();
    const expiresAt = calculateExpiry(renewedAt, input.ttlMs);

    return this.immediateTransaction(() => {
      const row = this.selectRow(input.runId);
      if (!row) {
        return { renewed: false, reason: "not_found" };
      }
      const lease = this.rowToLease(row);
      const failure = credentialFailureReason(lease, input);
      if (failure) {
        return { renewed: false, reason: failure };
      }
      if (parseInstant(lease!.expiresAt, "expiresAt") <= nowMs) {
        return { renewed: false, reason: "lease_expired" };
      }

      this.db
        .prepare(
          `UPDATE run_coordination SET renewedAt = ?, expiresAt = ?
           WHERE runId = ? AND controllerId = ? AND leaseId = ? AND fencingToken = ?`
        )
        .run(
          renewedAt,
          expiresAt,
          input.runId,
          input.controllerId,
          input.leaseId,
          input.fencingToken
        );
      return {
        renewed: true,
        lease: this.rowToLease(this.requireRow(input.runId))!,
      };
    });
  }

  async releaseControllerLease(
    input: ReleaseControllerLeaseInput
  ): Promise<ReleaseControllerLeaseResult> {
    return this.immediateTransaction(() => {
      const row = this.selectRow(input.runId);
      if (!row) {
        return { released: false, reason: "not_found" };
      }
      const failure = credentialFailureReason(this.rowToLease(row), input);
      if (failure) {
        return { released: false, reason: failure };
      }

      this.db
        .prepare(
          `UPDATE run_coordination
           SET controllerId = NULL, leaseId = NULL, acquiredAt = NULL,
               renewedAt = NULL, expiresAt = NULL
           WHERE runId = ? AND controllerId = ? AND leaseId = ? AND fencingToken = ?`
        )
        .run(input.runId, input.controllerId, input.leaseId, input.fencingToken);
      return { released: true };
    });
  }

  async getControllerLease(runId: string): Promise<ControllerLease | null> {
    const row = this.selectRow(runId);
    return row ? this.rowToLease(row) : null;
  }

  async getRunCoordination(runId: string): Promise<RunCoordinationRecord | null> {
    const row = this.selectRow(runId);
    return row ? this.rowToRecord(row) : null;
  }

  async listRunCoordinationEvents(runId: string): Promise<RunCoordinationEvent[]> {
    const rows = this.db
      .prepare("SELECT * FROM run_coordination_events WHERE runId = ? ORDER BY revision ASC")
      .all(runId) as CoordinationEventRow[];
    return rows.map((row) => this.rowToEvent(row));
  }

  async compareAndSetRunState(
    input: CompareAndSetRunStateInput
  ): Promise<CompareAndSetRunStateResult> {
    const nowMs = parseInstant(input.now, "now");
    const now = new Date(nowMs).toISOString();

    return this.immediateTransaction(() => {
      const row = this.selectRow(input.runId);
      if (!row) {
        return { updated: false, reason: "not_found" };
      }
      const lease = this.rowToLease(row);
      const failure = credentialFailureReason(lease, input);
      if (failure) {
        return { updated: false, reason: failure, currentRevision: row.revision };
      }
      if (parseInstant(lease!.expiresAt, "expiresAt") <= nowMs) {
        return { updated: false, reason: "lease_expired", currentRevision: row.revision };
      }
      const priorEvent = this.selectEvent(input.runId, input.mutationId);
      if (priorEvent) {
        if (
          priorEvent.type !== input.event.type ||
          priorEvent.payloadJson !== this.serializeState(input.event.payload) ||
          priorEvent.resultingStateJson !== this.serializeState(input.state) ||
          priorEvent.expectedRevision !== input.expectedRevision ||
          priorEvent.controllerId !== input.controllerId ||
          priorEvent.leaseId !== input.leaseId ||
          priorEvent.fencingToken !== input.fencingToken
        ) {
          return {
            updated: false,
            reason: "mutation_conflict",
            currentRevision: row.revision,
          };
        }
        return {
          updated: true,
          record: {
            ...this.rowToRecord(row),
            revision: priorEvent.revision,
            state: JSON.parse(priorEvent.resultingStateJson) as JsonValue,
            updatedAt: priorEvent.createdAt,
          },
          event: this.rowToEvent(priorEvent),
          idempotentReplay: true,
        };
      }
      if (row.revision !== input.expectedRevision) {
        return { updated: false, reason: "stale_revision", currentRevision: row.revision };
      }

      const stateJson = this.serializeState(input.state);
      const payloadJson = this.serializeState(input.event.payload);
      const update = this.db.prepare(
        `UPDATE run_coordination
           SET stateJson = ?, revision = revision + 1, updatedAt = ?
           WHERE runId = ? AND revision = ? AND controllerId = ? AND leaseId = ?
             AND fencingToken = ? AND expiresAt > ?`
      );
      if (input.commitGuard && input.commitGuard() !== true)
        return { updated: false, reason: "commit_condition_failed", currentRevision: row.revision };
      const result = update.run(
        stateJson,
        now,
        input.runId,
        input.expectedRevision,
        input.controllerId,
        input.leaseId,
        input.fencingToken,
        now
      );

      if (result.changes !== 1) {
        throw new Error("Coordination state changed during an immediate transaction");
      }
      const revision = input.expectedRevision + 1;
      this.db
        .prepare(
          `INSERT INTO run_coordination_events (
             runId, mutationId, revision, expectedRevision, controllerId, leaseId,
             fencingToken, type, payloadJson,
             resultingStateJson, createdAt
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.runId,
          input.mutationId,
          revision,
          input.expectedRevision,
          input.controllerId,
          input.leaseId,
          input.fencingToken,
          input.event.type,
          payloadJson,
          stateJson,
          now
        );
      return {
        updated: true,
        record: this.rowToRecord(this.requireRow(input.runId)),
        event: this.rowToEvent(this.requireEvent(input.runId, input.mutationId)),
        idempotentReplay: false,
      };
    });
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  protected immediateTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  private applyCoordinationMigration(): void {
    let sql = INLINE_COORDINATION_MIGRATION;
    try {
      const migrationPath = fileURLToPath(
        new URL("./migrations/001-controller-coordination.sql", import.meta.url)
      );
      sql = readFileSync(migrationPath, "utf8");
    } catch {
      // Bundled distributions may not include the standalone SQL asset.
    }
    this.db.exec(sql);
  }

  private selectRow(runId: string): CoordinationRow | null {
    return (
      (this.db.prepare("SELECT * FROM run_coordination WHERE runId = ?").get(runId) as
        CoordinationRow | undefined) ?? null
    );
  }

  private requireRow(runId: string): CoordinationRow {
    const row = this.selectRow(runId);
    if (!row) {
      throw new Error(`Coordination record '${runId}' disappeared`);
    }
    return row;
  }

  private selectEvent(runId: string, mutationId: string): CoordinationEventRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM run_coordination_events WHERE runId = ? AND mutationId = ?")
        .get(runId, mutationId) as CoordinationEventRow | undefined) ?? null
    );
  }

  private requireEvent(runId: string, mutationId: string): CoordinationEventRow {
    const row = this.selectEvent(runId, mutationId);
    if (!row) throw new Error(`Coordination event '${runId}/${mutationId}' disappeared`);
    return row;
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

  private rowToLease(row: CoordinationRow): ControllerLease | null {
    if (
      row.controllerId === null ||
      row.leaseId === null ||
      row.acquiredAt === null ||
      row.renewedAt === null ||
      row.expiresAt === null
    ) {
      return null;
    }
    return {
      runId: row.runId,
      controllerId: row.controllerId,
      leaseId: row.leaseId,
      fencingToken: row.fencingToken,
      acquiredAt: row.acquiredAt,
      renewedAt: row.renewedAt,
      expiresAt: row.expiresAt,
    };
  }

  private rowToRecord(row: CoordinationRow): RunCoordinationRecord {
    return {
      runId: row.runId,
      revision: row.revision,
      state: JSON.parse(row.stateJson) as JsonValue,
      updatedAt: row.updatedAt,
      lease: this.rowToLease(row),
    };
  }

  private rowToEvent(row: CoordinationEventRow): RunCoordinationEvent {
    return {
      runId: row.runId,
      mutationId: row.mutationId,
      revision: row.revision,
      expectedRevision: row.expectedRevision,
      controllerId: row.controllerId,
      leaseId: row.leaseId,
      fencingToken: row.fencingToken,
      type: row.type,
      payload: JSON.parse(row.payloadJson) as JsonValue,
      createdAt: row.createdAt,
      resultingState: JSON.parse(row.resultingStateJson) as JsonValue,
    };
  }

  private serializeState(state: JsonValue): string {
    return canonicalJSONStringify(cloneJsonValue(state));
  }
}
