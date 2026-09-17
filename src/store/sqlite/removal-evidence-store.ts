import {
  parseRemovalIntentBytes,
  parseRemovalObservationBytes,
} from "../../workspaces/workspace-removal-evidence.js";
import {
  SqliteCoordinationStore,
  type SqliteCoordinationStoreOptions,
} from "./coordination-store.js";

type AppendResult =
  { recorded: true; replay: boolean } | { recorded: false; reason: "conflict" | "intent_missing" };

/** Opt-in immutable evidence journal. No lifecycle/fencing/authority mutations.
 * Transaction commits are storage observations, not qualified power-loss guarantees.
 */
export class SqliteRemovalEvidenceStore extends SqliteCoordinationStore {
  constructor(dbPath: string, options: SqliteCoordinationStoreOptions = {}) {
    super(dbPath, options);
    try {
      if (!options.readOnly)
        this.db.exec(`
        CREATE TABLE IF NOT EXISTS removal_intents (
          operationId TEXT PRIMARY KEY, intentDigest TEXT NOT NULL UNIQUE, recordJson TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS removal_observations (
          observationDigest TEXT PRIMARY KEY, intentDigest TEXT NOT NULL, recordJson TEXT NOT NULL,
          FOREIGN KEY(intentDigest) REFERENCES removal_intents(intentDigest) ON DELETE RESTRICT
        );
        INSERT OR IGNORE INTO coordination_schema_migrations(version,name,appliedAt)
          VALUES(21,'removal-evidence',datetime('now'));
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  appendIntent(bytes: string): AppendResult {
    const intent = parseRemovalIntentBytes(bytes);
    return this.immediateTransaction(() => {
      const existing = this.intent(intent.operation_id);
      if (existing)
        return existing.bytes === bytes
          ? { recorded: true, replay: true }
          : { recorded: false, reason: "conflict" };
      this.db
        .prepare("INSERT INTO removal_intents(operationId,intentDigest,recordJson) VALUES(?,?,?)")
        .run(intent.operation_id, intent.intent_digest, bytes);
      return { recorded: true, replay: false };
    });
  }

  appendObservation(bytes: string): AppendResult {
    const observation = parseRemovalObservationBytes(bytes);
    return this.immediateTransaction(() => {
      const row = this.db
        .prepare("SELECT operationId FROM removal_intents WHERE intentDigest=?")
        .get(observation.intent_digest) as { operationId: string } | undefined;
      if (!row) return { recorded: false, reason: "intent_missing" };
      const intent = this.intent(row.operationId);
      if (!intent || intent.digest !== observation.intent_digest)
        throw new Error("Corrupt removal intent binding");
      const existing = this.observation(observation.observation_digest, intent.digest);
      if (existing !== null)
        return existing === bytes
          ? { recorded: true, replay: true }
          : { recorded: false, reason: "conflict" };
      this.db
        .prepare(
          "INSERT INTO removal_observations(observationDigest,intentDigest,recordJson) VALUES(?,?,?)"
        )
        .run(observation.observation_digest, intent.digest, bytes);
      return { recorded: true, replay: false };
    });
  }

  /** Exact caller-selected observation; no timestamp/latest-row inference. */
  readEvidence(operationId: string, observationDigest: string) {
    if (
      typeof operationId !== "string" ||
      operationId.length < 1 ||
      operationId.length > 128 ||
      !/^sha256:[a-f0-9]{64}$/u.test(observationDigest)
    )
      throw new Error("Invalid removal evidence selection");
    // Deferred read transaction works on read-only connections and snapshots both rows.
    return this.db.transaction(() => {
      const intent = this.intent(operationId);
      return Object.freeze({
        intentBytes: intent?.bytes ?? null,
        observationBytes: intent ? this.observation(observationDigest, intent.digest) : null,
      });
    })();
  }

  private intent(operationId: string) {
    const row = this.db
      .prepare(
        "SELECT intentDigest,substr(recordJson,1,16385) AS bytes FROM removal_intents WHERE operationId=?"
      )
      .get(operationId) as { intentDigest: string; bytes: string } | undefined;
    if (!row) return null;
    const parsed = parseRemovalIntentBytes(row.bytes);
    if (parsed.operation_id !== operationId || parsed.intent_digest !== row.intentDigest)
      throw new Error("Corrupt removal intent binding");
    return { bytes: row.bytes, digest: row.intentDigest };
  }

  private observation(observationDigest: string, intentDigest: string) {
    const row = this.db
      .prepare(
        "SELECT intentDigest,substr(recordJson,1,16385) AS bytes FROM removal_observations WHERE observationDigest=?"
      )
      .get(observationDigest) as { intentDigest: string; bytes: string } | undefined;
    if (!row) return null;
    const parsed = parseRemovalObservationBytes(row.bytes);
    if (
      row.intentDigest !== parsed.intent_digest ||
      parsed.observation_digest !== observationDigest
    )
      throw new Error("Corrupt removal observation binding");
    // A valid record for another intent is never attached to this snapshot.
    return parsed.intent_digest === intentDigest ? row.bytes : null;
  }
}
