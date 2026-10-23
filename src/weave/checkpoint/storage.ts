/**
 * Checkpoint storage layer - file-based persistence for merge-weave state
 */

import fs from "fs";
import path from "path";
import { canonicalJSONStringify } from "../../util/canonicalJson.js";
import type {
  WeaveCheckpoint,
  CheckpointListEntry,
  SaveCheckpointOptions,
  LoadCheckpointOptions,
  ListCheckpointsOptions,
  CleanupResult,
} from "./types.js";

/**
 * Default checkpoint directory relative to workspace root
 */
export const DEFAULT_CHECKPOINT_DIR = ".lexrunner/checkpoints";

/**
 * Checkpoint retention period in days
 */
export const CHECKPOINT_RETENTION_DAYS = 7;
export const MAX_CHECKPOINT_BYTES = 1024 * 1024;

/**
 * Get the default checkpoint directory path
 */
export function getDefaultCheckpointDir(): string {
  return path.join(process.cwd(), DEFAULT_CHECKPOINT_DIR);
}

/**
 * Ensure checkpoint directory exists
 */
export function ensureCheckpointDir(checkpointDir?: string): string {
  const dir = checkpointDir || getDefaultCheckpointDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Resolve a checkpoint file path without creating filesystem state. Mutating callers must invoke
 * `ensureCheckpointDir` only after their read-only admission checks succeed.
 */
export function getCheckpointPath(runId: string, checkpointDir?: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error("Invalid checkpoint run ID");
  }
  const dir = checkpointDir || getDefaultCheckpointDir();
  return path.join(dir, `${runId}.json`);
}

/**
 * Save a checkpoint to disk
 */
export async function saveCheckpoint(
  checkpoint: WeaveCheckpoint,
  options: SaveCheckpointOptions = {}
): Promise<void> {
  const checkpointPath = getCheckpointPath(checkpoint.runId, options.checkpointDir);
  ensureCheckpointDir(options.checkpointDir);
  const json = canonicalJSONStringify(checkpoint);
  if (Buffer.byteLength(json, "utf-8") > MAX_CHECKPOINT_BYTES) {
    throw new Error(`Checkpoint exceeds ${MAX_CHECKPOINT_BYTES} bytes`);
  }
  const temporaryPath = `${checkpointPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, json + "\n", { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(temporaryPath, checkpointPath);

  // Run cleanup unless explicitly skipped
  if (!options.skipCleanup) {
    await cleanupOldCheckpoints(options.checkpointDir);
  }
}

export interface CheckpointExecutionLease {
  release(): void;
}

/**
 * Acquire a process-scoped execution lease for a checkpoint. The journal itself is still the
 * durable truth; this lock only prevents two local resume processes from issuing the same next
 * side effect concurrently.
 */
export function acquireCheckpointExecutionLease(
  runId: string,
  checkpointDir?: string
): CheckpointExecutionLease | null {
  const checkpointPath = getCheckpointPath(runId, checkpointDir);
  ensureCheckpointDir(checkpointDir);
  const lockPath = `${checkpointPath}.resume.lock`;
  let descriptor: number;
  try {
    descriptor = fs.openSync(lockPath, "wx", 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" && removeStaleExecutionLease(lockPath)) {
      try {
        descriptor = fs.openSync(lockPath, "wx", 0o600);
      } catch (retryError) {
        if ((retryError as NodeJS.ErrnoException).code === "EEXIST") return null;
        throw retryError;
      }
    } else if (code === "EEXIST") {
      return null;
    } else {
      throw error;
    }
  }
  fs.writeFileSync(descriptor, `${process.pid}\n`, "utf-8");
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      fs.closeSync(descriptor);
      try {
        fs.unlinkSync(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}

function removeStaleExecutionLease(lockPath: string): boolean {
  try {
    const pid = Number.parseInt(fs.readFileSync(lockPath, "utf-8").trim(), 10);
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") return false;
    }
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load a checkpoint from disk
 */
export async function loadCheckpoint(
  runId: string,
  options: LoadCheckpointOptions = {}
): Promise<WeaveCheckpoint> {
  const checkpointPath = getCheckpointPath(runId, options.checkpointDir);

  if (!fs.existsSync(checkpointPath)) {
    throw new Error(`Checkpoint not found for run ID: ${runId}`);
  }

  if (fs.statSync(checkpointPath).size > MAX_CHECKPOINT_BYTES) {
    throw new Error(`Checkpoint exceeds ${MAX_CHECKPOINT_BYTES} bytes`);
  }

  const json = fs.readFileSync(checkpointPath, "utf-8");
  const checkpoint: WeaveCheckpoint = JSON.parse(json);

  // Validate plan hash if requested (default: true)
  const shouldValidate = options.validatePlanHash !== false;
  if (shouldValidate && options.expectedPlanHash) {
    if (checkpoint.planHash !== options.expectedPlanHash) {
      throw new Error(
        `Plan hash mismatch: checkpoint has ${checkpoint.planHash}, expected ${options.expectedPlanHash}`
      );
    }
  }

  return checkpoint;
}

/**
 * List all checkpoints
 */
export async function listCheckpoints(
  options: ListCheckpointsOptions = {}
): Promise<CheckpointListEntry[]> {
  const dir = options.checkpointDir || getDefaultCheckpointDir();

  if (!fs.existsSync(dir)) {
    return [];
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const entries: CheckpointListEntry[] = [];

  for (const file of files) {
    try {
      const filePath = path.join(dir, file);
      if (fs.statSync(filePath).size > MAX_CHECKPOINT_BYTES) continue;
      const json = fs.readFileSync(filePath, "utf-8");
      const checkpoint: WeaveCheckpoint = JSON.parse(json);

      // Apply filters
      if (options.phase && checkpoint.phase !== options.phase) {
        continue;
      }
      if (options.state && checkpoint.state !== options.state) {
        continue;
      }

      entries.push({
        runId: checkpoint.runId,
        timestamp: checkpoint.timestamp,
        phase: checkpoint.phase,
        state: checkpoint.state,
        completedItems: checkpoint.completedItems.length,
        pendingItems: checkpoint.pendingItems.length,
        failedItems: checkpoint.failedItems.length,
        startedAt: checkpoint.startedAt,
      });
    } catch (error) {
      // Skip malformed checkpoint files
      console.warn(`Warning: Failed to parse checkpoint file ${file}:`, error);
    }
  }

  // Sort by timestamp descending (newest first)
  entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  // Apply limit if specified
  if (options.limit && options.limit > 0) {
    return entries.slice(0, options.limit);
  }

  return entries;
}

/**
 * Get the most recent checkpoint
 */
export async function getLatestCheckpoint(checkpointDir?: string): Promise<WeaveCheckpoint | null> {
  const entries = await listCheckpoints({ checkpointDir, limit: 1 });

  if (entries.length === 0) {
    return null;
  }

  return loadCheckpoint(entries[0].runId, { checkpointDir });
}

/**
 * Delete a checkpoint
 */
export async function deleteCheckpoint(runId: string, checkpointDir?: string): Promise<boolean> {
  const checkpointPath = getCheckpointPath(runId, checkpointDir);

  if (!fs.existsSync(checkpointPath)) {
    return false;
  }

  fs.unlinkSync(checkpointPath);
  return true;
}

/**
 * Clean up old checkpoints based on retention policy
 */
export async function cleanupOldCheckpoints(checkpointDir?: string): Promise<CleanupResult> {
  const dir = ensureCheckpointDir(checkpointDir);
  const now = new Date();
  const cutoffDate = new Date(now.getTime() - CHECKPOINT_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const entries = await listCheckpoints({ checkpointDir });
  const removedRunIds: string[] = [];
  let removed = 0;
  let retained = 0;

  for (const entry of entries) {
    const checkpointDate = new Date(entry.timestamp);

    if (checkpointDate < cutoffDate) {
      const deleted = await deleteCheckpoint(entry.runId, checkpointDir);
      if (deleted) {
        removedRunIds.push(entry.runId);
        removed++;
      }
    } else {
      retained++;
    }
  }

  return {
    removed,
    retained,
    removedRunIds,
  };
}

/**
 * Check if a checkpoint exists
 */
export function checkpointExists(runId: string, checkpointDir?: string): boolean {
  const checkpointPath = getCheckpointPath(runId, checkpointDir);
  return fs.existsSync(checkpointPath);
}
