/**
 * Lease-fenced application service for coordinated run mutations.
 *
 * This is intentionally separate from RunManager. RunManager remains the
 * legacy, file-canonical API; coordinated runs are canonical in a
 * CoordinationStore and write the legacy files only as compatibility
 * projections after a successful compare-and-set.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AcquireControllerLeaseInput,
  AcquireControllerLeaseResult,
  ControllerLeaseCredential,
  CoordinationStore,
  JsonValue,
  ReleaseControllerLeaseResult,
  RenewControllerLeaseResult,
  RunCoordinationRecord,
} from "../store/coordination-store.js";
import type { Procedure } from "../procedures/types.js";
import { parseRunState, type RunState, type RunIndexEntry } from "./types.js";
import { ensureRunDir, ensureRunsDir, upsertIndexEntry, writeRunState } from "./storage.js";

export const COORDINATED_RUN_SCHEMA_VERSION = "1.0.0";

export interface CoordinatedRunEnvelope {
  schemaVersion: typeof COORDINATED_RUN_SCHEMA_VERSION;
  run: RunState;
}

export interface RunProjection {
  project(run: RunState, canonicalRevision: number): Promise<void>;
}

/** Default compatibility projection to .lexrunner/runs and its index. */
export class FileRunProjection implements RunProjection {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly baseDir: string = process.cwd()) {}

  async project(run: RunState, canonicalRevision: number): Promise<void> {
    const operation = this.queue.then(() => this.projectInRevisionOrder(run, canonicalRevision));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private projectInRevisionOrder(run: RunState, canonicalRevision: number): void {
    const current = readProjectedRevision(run.runId, this.baseDir);
    if (current !== null && current > canonicalRevision) return;

    writeRunState(run, this.baseDir);
    ensureRunDir(run.runId, this.baseDir);
    upsertIndexEntry(toIndexEntry(run), this.baseDir);
    writeProjectedRevision(run.runId, this.baseDir, canonicalRevision);
  }
}

export type ProcedureResolver = (procedureId: string) => Promise<Procedure | null>;

export interface CoordinatedRunManagerOptions {
  coordinationStore: CoordinationStore;
  resolveProcedure: ProcedureResolver;
  projection?: RunProjection;
  baseDir?: string;
}

export interface AcquireCoordinatedRunInput extends Omit<
  AcquireControllerLeaseInput,
  "initialState"
> {
  /** Used only when the canonical coordination record does not yet exist. */
  initialState: RunState;
}

export interface RenewCoordinatedRunInput extends ControllerLeaseCredential {
  now: string;
  ttlMs: number;
}

export interface AdvanceCoordinatedRunInput extends ControllerLeaseCredential {
  expectedRevision: number;
  /** Stable caller-generated key for uncertain retries. */
  mutationId: string;
  /** A procedure event; callers never provide the resulting target state. */
  event: string;
  now: string;
}

export type ProjectionResult = { status: "written" } | { status: "failed"; error: Error };

export type AdvanceCoordinatedRunResult =
  | {
      advanced: true;
      record: RunCoordinationRecord;
      run: RunState;
      projection: ProjectionResult;
    }
  | {
      advanced: false;
      reason:
        | "not_found"
        | "no_active_lease"
        | "lease_mismatch"
        | "stale_fence"
        | "lease_expired"
        | "stale_revision"
        | "mutation_conflict"
        | "commit_condition_failed";
      currentRevision?: number;
    };

export type RebuildProjectionResult =
  | { rebuilt: true; record: RunCoordinationRecord; run: RunState }
  | { rebuilt: false; reason: "not_found" };

export class InvalidProcedureTransitionError extends Error {
  constructor(
    public readonly procedureId: string,
    public readonly state: string,
    public readonly event: string,
    message?: string
  ) {
    super(message ?? `Invalid event "${event}" for procedure "${procedureId}" in state "${state}"`);
    this.name = "InvalidProcedureTransitionError";
  }
}

export class ProcedureUnavailableError extends Error {
  constructor(public readonly procedureId: string) {
    super(`Procedure "${procedureId}" is unavailable; coordinated state cannot be advanced`);
    this.name = "ProcedureUnavailableError";
  }
}

/**
 * The single lease-protected application path for coordinated run mutation.
 * SQLite is the production canonical store; the interface permits deterministic
 * in-memory testing without changing the ownership or CAS semantics.
 */
export class CoordinatedRunManager {
  private readonly store: CoordinationStore;
  private readonly resolveProcedure: ProcedureResolver;
  private readonly projection: RunProjection;

  constructor(options: CoordinatedRunManagerOptions) {
    this.store = options.coordinationStore;
    this.resolveProcedure = options.resolveProcedure;
    this.projection = options.projection ?? new FileRunProjection(options.baseDir);
  }

  async acquireController(
    input: AcquireCoordinatedRunInput
  ): Promise<AcquireControllerLeaseResult> {
    const initialState = parseRunState(input.initialState);
    if (initialState.runId !== input.runId) {
      throw new TypeError("initialState.runId must match runId");
    }
    return this.store.acquireControllerLease({
      ...input,
      initialState: toCanonicalState(initialState),
    });
  }

  async renewController(input: RenewCoordinatedRunInput): Promise<RenewControllerLeaseResult> {
    return this.store.renewControllerLease(input);
  }

  async releaseController(
    credential: ControllerLeaseCredential
  ): Promise<ReleaseControllerLeaseResult> {
    return this.store.releaseControllerLease(credential);
  }

  async getCanonicalRun(runId: string): Promise<RunCoordinationRecord | null> {
    const record = await this.store.getRunCoordination(runId);
    if (!record) return null;
    const run = parseCanonicalState(record.state);
    return { ...record, state: toCanonicalState(run) };
  }

  async advance(input: AdvanceCoordinatedRunInput): Promise<AdvanceCoordinatedRunResult> {
    const current = await this.store.getRunCoordination(input.runId);
    if (!current) {
      return { advanced: false, reason: "not_found" };
    }

    const run = parseCanonicalState(current.state);

    // An uncertain retry may arrive after the first mutation already advanced
    // the state. Let the store authenticate and replay the committed event
    // before attempting to derive the transition again from the newer state.
    const priorEvent = (await this.store.listRunCoordinationEvents(input.runId)).find(
      (event) => event.mutationId === input.mutationId
    );
    if (priorEvent) {
      const payload = asObject(priorEvent.payload);
      if (payload?.procedureEvent !== input.event) {
        return {
          advanced: false,
          reason: "mutation_conflict",
          currentRevision: current.revision,
        };
      }
      const replay = await this.store.compareAndSetRunState({
        runId: input.runId,
        controllerId: input.controllerId,
        leaseId: input.leaseId,
        fencingToken: input.fencingToken,
        expectedRevision: input.expectedRevision,
        mutationId: input.mutationId,
        state: priorEvent.resultingState,
        event: { type: priorEvent.type, payload: priorEvent.payload },
        now: input.now,
      });
      return this.finishAdvance(replay);
    }

    const procedure = await this.resolveProcedure(run.procedure);
    if (!procedure) {
      throw new ProcedureUnavailableError(run.procedure);
    }

    let nextState: string;
    try {
      nextState = procedure.applyTransition(run.state, input.event);
    } catch (error) {
      throw new InvalidProcedureTransitionError(
        run.procedure,
        run.state,
        input.event,
        error instanceof Error ? error.message : undefined
      );
    }

    const now = normalizeInstant(input.now);
    const updated: RunState = {
      ...run,
      state: nextState,
      updatedAt: now,
      completedAt: procedure.isTerminal(nextState) ? now : run.completedAt,
    };
    parseRunState(updated);

    const result = await this.store.compareAndSetRunState({
      runId: input.runId,
      controllerId: input.controllerId,
      leaseId: input.leaseId,
      fencingToken: input.fencingToken,
      expectedRevision: input.expectedRevision,
      mutationId: input.mutationId,
      state: toCanonicalState(updated),
      event: {
        type: "procedure_transition",
        payload: {
          procedureId: run.procedure,
          procedureEvent: input.event,
          fromState: run.state,
          toState: nextState,
        },
      },
      now,
    });
    return this.finishAdvance(result);
  }

  private async finishAdvance(
    result: Awaited<ReturnType<CoordinationStore["compareAndSetRunState"]>>
  ): Promise<AdvanceCoordinatedRunResult> {
    if (!result.updated) {
      return {
        advanced: false,
        reason: result.reason,
        currentRevision: result.currentRevision,
      };
    }

    const canonicalRun = parseCanonicalState(result.record.state);

    return {
      advanced: true,
      record: result.record,
      run: canonicalRun,
      projection: await this.tryProject(canonicalRun, result.record.revision),
    };
  }

  /** Rebuild or retry the compatibility projection from canonical state. */
  async rebuildProjection(runId: string): Promise<RebuildProjectionResult> {
    const record = await this.store.getRunCoordination(runId);
    if (!record) {
      return { rebuilt: false, reason: "not_found" };
    }
    const run = parseCanonicalState(record.state);
    await this.projection.project(run, record.revision);
    return { rebuilt: true, record, run };
  }

  private async tryProject(run: RunState, revision: number): Promise<ProjectionResult> {
    try {
      await this.projection.project(run, revision);
      return { status: "written" };
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
}

function readProjectedRevision(runId: string, baseDir: string): number | null {
  const path = projectionRevisionPath(runId, baseDir);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { canonicalRevision?: unknown };
    return typeof value.canonicalRevision === "number" &&
      Number.isSafeInteger(value.canonicalRevision)
      ? value.canonicalRevision
      : null;
  } catch {
    return null;
  }
}

function writeProjectedRevision(runId: string, baseDir: string, canonicalRevision: number): void {
  const runsDir = ensureRunsDir(baseDir);
  const path = projectionRevisionPath(runId, baseDir);
  const temporary = join(runsDir, `.${runId}.projection.tmp`);
  writeFileSync(temporary, JSON.stringify({ canonicalRevision }), "utf8");
  renameSync(temporary, path);
}

function projectionRevisionPath(runId: string, baseDir: string): string {
  return join(baseDir, ".lexrunner", "runs", `${runId}.projection.json`);
}

function normalizeInstant(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError("now must be a valid ISO 8601 timestamp");
  }
  return new Date(timestamp).toISOString();
}

function toCanonicalState(run: RunState): JsonValue {
  return JSON.parse(
    JSON.stringify({ schemaVersion: COORDINATED_RUN_SCHEMA_VERSION, run })
  ) as JsonValue;
}

function parseCanonicalState(value: JsonValue): RunState {
  const envelope = asObject(value);
  if (envelope?.schemaVersion !== COORDINATED_RUN_SCHEMA_VERSION || !("run" in envelope)) {
    throw new TypeError("Invalid or unsupported coordinated run envelope");
  }
  return parseRunState(envelope.run);
}

function asObject(value: JsonValue): Record<string, JsonValue> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : null;
}

function toIndexEntry(run: RunState): RunIndexEntry {
  return {
    runId: run.runId,
    mode: run.mode,
    procedure: run.procedure,
    state: run.state,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
  };
}
