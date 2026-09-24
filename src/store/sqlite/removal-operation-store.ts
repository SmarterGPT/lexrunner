import { z } from "zod";
import { SqliteRemovalEvidenceStore } from "./removal-evidence-store.js";
import type { SqliteCoordinationStoreOptions } from "./coordination-store.js";
import { credentialFailureReason, type ControllerLease } from "../coordination-store.js";
import type { AttemptRecord, WorkspaceLifecycleLeaseRecord } from "../workspace-lifecycle-store.js";
import {
  assessReservedRemovalRecovery,
  parseRemovalIntentBytes,
  parseRemovalObservationBytes,
  type RemovalReservationAttempt,
  type RemovalReservationLease,
} from "../../workspaces/workspace-removal-evidence.js";
import { canonicalJSONStringify } from "../../util/canonicalJson.js";
import { computeCanonicalHash } from "../../schemas/task-contract.js";

const id = z.string().min(1).max(128);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const revision = z.number().int().nonnegative().safe();
const instant = z.string().datetime({ offset: true });
const controller = z
  .object({ runId: id, controllerId: id, leaseId: id, fencingToken: revision.min(1) })
  .strict();
const selection = z.object({
  operationId: id,
  intentDigest: digest,
  observationDigest: digest,
  expectedRunRevision: revision,
  expectedAttemptRevision: revision,
});
const admitInput = selection
  .extend({ controller, executorId: id, now: instant, maxObservationAgeMs: revision })
  .strict();
const admissionSchema = selection
  .extend({
    schemaVersion: z.literal("removal-admission/1"),
    controller,
    executorId: id,
    admittedAt: instant,
    workspaceLeaseId: id,
    admissionDigest: digest,
  })
  .strict();
const resolutionSchema = z
  .object({
    schemaVersion: z.literal("removal-resolution/1"),
    admissionDigest: digest,
    observationDigest: digest,
    controller,
    runRevision: revision,
    observedState: z.enum([
      "contents_remaining",
      "root_remaining",
      "registration_remaining",
      "absence_observed",
    ]),
    resolvedAt: instant,
    resolutionDigest: digest,
  })
  .strict();
const resolveInput = z
  .object({
    operationId: id,
    admissionDigest: digest,
    observationDigest: digest,
    controller,
    expectedRunRevision: revision,
    now: instant,
    maxObservationAgeMs: revision,
  })
  .strict();
export type RemovalAdmissionInput = z.input<typeof admitInput>;
export type RemovalResolutionInput = z.input<typeof resolveInput>;
export type RemovalAdmission = Readonly<z.infer<typeof admissionSchema>>;
export type RemovalResolution = Readonly<z.infer<typeof resolutionSchema>>;
export interface RemovalOperation {
  admission: RemovalAdmission;
  resolution: RemovalResolution | null;
}
type Rejected = { kind: "rejected"; reason: string };
export type RemovalAdmissionResult =
  Rejected | { kind: "admitted" | "replay"; operation: RemovalOperation };
export type RemovalResolutionResult =
  Rejected | { kind: "resolved" | "replay"; operation: RemovalOperation };
interface OperationRow {
  operationId: string;
  workspaceLeaseId: string;
  admissionJson: string;
  resolutionJson: string | null;
  observationDigest: string | null;
}
const rejected = (reason: string): Rejected => ({ kind: "rejected", reason });

/** Internal opt-in SQLite admission/recovery adapter. Instantiate against an existing
 * lifecycle database. Call only while the executor owns the target's effect exclusion.
 * A transaction is not native custody, authenticated provisioning or power-loss proof.
 * No broker, CLI, MCP or protected helper entrypoint activates this store.
 */
export class SqliteRemovalOperationStore extends SqliteRemovalEvidenceStore {
  constructor(path: string, options: SqliteCoordinationStoreOptions = {}) {
    super(path, options);
    try {
      if (!options.readOnly)
        this.immediateTransaction(() => {
          this.db.exec(`
        CREATE TABLE IF NOT EXISTS removal_operations (
          operationId TEXT PRIMARY KEY, workspaceLeaseId TEXT NOT NULL,
          admissionJson TEXT NOT NULL, resolutionJson TEXT, observationDigest TEXT,
          CHECK ((resolutionJson IS NULL) = (observationDigest IS NULL)),
          FOREIGN KEY(operationId) REFERENCES removal_intents(operationId) ON DELETE RESTRICT,
          FOREIGN KEY(workspaceLeaseId) REFERENCES workspace_leases(leaseId) ON DELETE RESTRICT,
          FOREIGN KEY(observationDigest) REFERENCES removal_observations(observationDigest) ON DELETE RESTRICT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS removal_one_unresolved_per_lease
          ON removal_operations(workspaceLeaseId) WHERE resolutionJson IS NULL;
        INSERT OR IGNORE INTO coordination_schema_migrations(version,name,appliedAt)
          VALUES(23,'removal-operation-admission',datetime('now'));
      `);
          // Install in the database, not in one caller's connection-local checks.
          // Connections opened before this opt-in migration must obey the same fence.
          for (const [table, pending] of [
            [
              "workspace_leases",
              `SELECT 1 FROM removal_operations
            WHERE workspaceLeaseId=OLD.leaseId AND resolutionJson IS NULL`,
            ],
            [
              "attempts",
              `SELECT 1 FROM removal_operations AS operation
            JOIN workspace_leases AS lease ON lease.leaseId=operation.workspaceLeaseId
            WHERE lease.attemptId=OLD.attemptId AND operation.resolutionJson IS NULL`,
            ],
            [
              "removal_selections",
              `SELECT 1 FROM removal_operations
            WHERE operationId=OLD.operationId AND resolutionJson IS NULL`,
            ],
          ]) {
            for (const action of ["UPDATE", "DELETE"]) {
              this.db.exec(`CREATE TRIGGER IF NOT EXISTS removal_pending_${table}_${action}
              BEFORE ${action} ON ${table} WHEN EXISTS (${pending})
              BEGIN SELECT RAISE(ABORT, 'removal_operation_pending'); END;`);
            }
          }
          this.db.exec(`INSERT OR IGNORE INTO coordination_schema_migrations(version,name,appliedAt)
          VALUES(24,'removal-lifecycle-interlock',datetime('now'));`);
        });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /** Historical status only. A replay never grants a second dispatch, even after
   * acknowledgement loss, expiry, controller replacement or database reopen. */
  readOperation(operationId: string): RemovalOperation | null {
    id.parse(operationId);
    const row = this.db
      .prepare(
        `SELECT operationId,workspaceLeaseId,
      substr(admissionJson,1,16385) AS admissionJson,substr(resolutionJson,1,16385) AS resolutionJson,
      observationDigest FROM removal_operations WHERE operationId=?`
      )
      .get(operationId) as OperationRow | undefined;
    if (!row) return null;
    const admission = admissionSchema.parse(decode(row.admissionJson));
    const { admissionDigest, ...body } = admission;
    if (
      computeCanonicalHash(body) !== admissionDigest ||
      admission.operationId !== row.operationId ||
      admission.workspaceLeaseId !== row.workspaceLeaseId
    )
      throw new Error("Corrupt removal admission");
    const resolution =
      row.resolutionJson === null ? null : resolutionSchema.parse(decode(row.resolutionJson));
    if (resolution) {
      const { resolutionDigest, ...resolved } = resolution;
      if (
        computeCanonicalHash(resolved) !== resolutionDigest ||
        resolution.admissionDigest !== admissionDigest ||
        resolution.observationDigest !== row.observationDigest
      )
        throw new Error("Corrupt removal resolution");
    } else if (row.observationDigest !== null) throw new Error("Corrupt removal resolution");
    return {
      admission: Object.freeze(admission),
      resolution: resolution && Object.freeze(resolution),
    };
  }

  admitRemoval(value: RemovalAdmissionInput): RemovalAdmissionResult {
    const input = admitInput.parse(value);
    return this.immediateTransaction(() => {
      const prior = this.readOperation(input.operationId);
      if (prior) {
        // Executor/controller identities are historical execution provenance, not
        // a way for a retry or successor to turn the same operation into new work.
        if (
          canonicalJSONStringify(selection.parse(prior.admission)) !==
            canonicalJSONStringify(selection.parse(input)) ||
          prior.admission.controller.runId !== input.controller.runId
        )
          return rejected("operation_conflict");
        return { kind: "replay", operation: prior };
      }
      const failure = this.currentController(input);
      if (failure) return rejected(failure);
      const selected = this.readSelection(input.operationId, input.intentDigest);
      if (!selected || selected.observationDigest !== input.observationDigest)
        return rejected("selection_changed");
      const intent = parseRemovalIntentBytes(selected.intentBytes);
      const bound = this.reservation(input, selected.intentBytes, selected.observationBytes);
      if (typeof bound === "string") return rejected(bound);
      if (!["reserved", "active"].includes(bound.lease.status))
        return rejected("reservation_not_active");
      if (Date.parse(instant.parse(bound.lease.expiresAt)) <= Date.parse(input.now))
        return rejected("workspace_expired");
      if (
        bound.lease.controllerId !== input.controller.controllerId ||
        bound.lease.controllerLeaseId !== input.controller.leaseId ||
        bound.lease.fencingToken !== input.controller.fencingToken
      )
        return rejected("reservation_owner_changed");
      if (bound.assessment.state === "absence_observed") return rejected("already_absent");
      if (
        this.db
          .prepare(
            "SELECT 1 FROM removal_operations WHERE workspaceLeaseId=? AND resolutionJson IS NULL"
          )
          .get(intent.lease_id)
      )
        return rejected("unresolved_operation");
      const body = {
        ...selection.parse(input),
        schemaVersion: "removal-admission/1" as const,
        controller: input.controller,
        executorId: input.executorId,
        admittedAt: input.now,
        workspaceLeaseId: intent.lease_id,
      };
      const admission = admissionSchema.parse({
        ...body,
        admissionDigest: computeCanonicalHash(body),
      });
      this.db
        .prepare(
          "INSERT INTO removal_operations(operationId,workspaceLeaseId,admissionJson) VALUES(?,?,?)"
        )
        .run(input.operationId, intent.lease_id, canonicalJSONStringify(admission));
      return { kind: "admitted", operation: { admission, resolution: null } };
    });
  }

  /** Caller must establish executor quiescence while holding effect exclusion, then
   * append its fresh observation. This records an assessment, not successful cleanup,
   * a reservation release, a new selection, or permission to repeat the old effect. */
  resolveRemoval(value: RemovalResolutionInput): RemovalResolutionResult {
    const input = resolveInput.parse(value);
    return this.immediateTransaction(() => {
      const operation = this.readOperation(input.operationId);
      if (!operation) return rejected("operation_missing");
      if (
        operation.admission.admissionDigest !== input.admissionDigest ||
        operation.admission.controller.runId !== input.controller.runId
      )
        return rejected("operation_conflict");
      if (operation.resolution)
        return operation.resolution.observationDigest === input.observationDigest
          ? { kind: "replay", operation }
          : rejected("resolution_conflict");
      const failure = this.currentController(input);
      if (failure) return rejected(failure);
      const selected = this.readSelection(input.operationId, operation.admission.intentDigest);
      if (!selected || selected.observationDigest !== operation.admission.observationDigest)
        return rejected("selection_changed");
      const evidence = this.readEvidence(input.operationId, input.observationDigest);
      const bound = this.reservation(
        {
          ...input,
          intentDigest: operation.admission.intentDigest,
          expectedAttemptRevision: operation.admission.expectedAttemptRevision,
        },
        evidence.intentBytes,
        evidence.observationBytes
      );
      if (typeof bound === "string") return rejected(bound);
      const observed = parseRemovalObservationBytes(evidence.observationBytes);
      if (Date.parse(observed.observed_at) < Date.parse(operation.admission.admittedAt))
        return rejected("observation_before_admission");
      const body = {
        schemaVersion: "removal-resolution/1" as const,
        admissionDigest: input.admissionDigest,
        observationDigest: input.observationDigest,
        controller: input.controller,
        runRevision: input.expectedRunRevision,
        observedState: bound.assessment.state,
        resolvedAt: input.now,
      };
      const resolution = resolutionSchema.parse({
        ...body,
        resolutionDigest: computeCanonicalHash(body),
      });
      this.db
        .prepare(
          "UPDATE removal_operations SET resolutionJson=?,observationDigest=? WHERE operationId=?"
        )
        .run(canonicalJSONStringify(resolution), input.observationDigest, input.operationId);
      return { kind: "resolved", operation: { admission: operation.admission, resolution } };
    });
  }

  private currentController(input: {
    controller: z.infer<typeof controller>;
    expectedRunRevision: number;
    now: string;
  }): string | null {
    const row = this.db
      .prepare(
        `SELECT runId,revision,controllerId,leaseId,fencingToken,acquiredAt,renewedAt,expiresAt,updatedAt
      FROM run_coordination WHERE runId=?`
      )
      .get(input.controller.runId) as
      (ControllerLease & { revision: number; updatedAt: string }) | undefined;
    const failure = credentialFailureReason(row?.controllerId ? row : null, input.controller);
    if (failure) return failure;
    if (row!.revision !== input.expectedRunRevision) return "stale_run_revision";
    if (Date.parse(instant.parse(row!.expiresAt)) <= Date.parse(input.now)) return "lease_expired";
    if (
      Date.parse(input.now) <
      Math.max(
        ...[row!.acquiredAt, row!.renewedAt, row!.updatedAt].map((value) =>
          Date.parse(instant.parse(value))
        )
      )
    )
      return "invalid_time";
    return null;
  }

  private reservation(
    input: {
      intentDigest: string;
      observationDigest: string;
      expectedRunRevision: number;
      expectedAttemptRevision: number;
      controller: z.infer<typeof controller>;
      now: string;
      maxObservationAgeMs: number;
    },
    intentBytes: string | null,
    observationBytes: string | null
  ) {
    const intent = parseRemovalIntentBytes(intentBytes);
    // Flat owner fields are validated by the existing reservation assessor below;
    // lastObservationJson is neither read nor interpreted as fresh evidence here.
    const attempt = this.db
      .prepare(
        `SELECT attemptId,runId,runRevision,workItemId,workItemRevision,packetId,packetHash,
        baseSha,workspaceLeaseId,revision,updatedAt FROM attempts WHERE attemptId=?`
      )
      .get(intent.attempt_id) as
      (RemovalReservationAttempt & Pick<AttemptRecord, "revision" | "updatedAt">) | undefined;
    const lease = this.db
      .prepare(
        `SELECT attemptId,runId,runRevision,workItemId,workItemRevision,packetId,packetHash,
        baseSha,leaseId,revision,status,controllerId,controllerLeaseId,fencingToken,expiresAt,heartbeatAt
        FROM workspace_leases WHERE leaseId=?`
      )
      .get(intent.lease_id) as
      | (RemovalReservationLease &
          Pick<
            WorkspaceLifecycleLeaseRecord,
            "controllerId" | "controllerLeaseId" | "fencingToken" | "expiresAt" | "heartbeatAt"
          >)
      | undefined;
    if (!attempt || !lease || attempt.runId !== input.controller.runId)
      return "reservation_binding_mismatch";
    if (attempt.revision !== input.expectedAttemptRevision) return "stale_attempt_revision";
    if (
      Date.parse(input.now) <
      Math.max(
        Date.parse(instant.parse(attempt.updatedAt)),
        Date.parse(instant.parse(lease.heartbeatAt))
      )
    )
      return "invalid_time";
    const assessment = assessReservedRemovalRecovery({
      intentBytes,
      observationBytes,
      expectedIntentDigest: input.intentDigest,
      expectedObservationDigest: input.observationDigest,
      now: input.now,
      maxObservationAgeMs: input.maxObservationAgeMs,
      attempt,
      lease,
    });
    if (assessment.state === "reconciliation_required") return assessment.reason;
    return { attempt, lease, assessment };
  }
}

function decode(bytes: string) {
  if (typeof bytes !== "string" || Buffer.byteLength(bytes, "utf8") > 16384)
    throw new Error("Oversized removal operation");
  const parsed: unknown = JSON.parse(bytes);
  if (canonicalJSONStringify(parsed) !== bytes) throw new Error("Noncanonical removal operation");
  return parsed;
}
