/**
 * CLI runner lifecycle management
 * Handles locks, logging, and cache for CLI commands
 */

import {
  RunnerLock,
  LockError,
  createFileLogger,
  FileLogger,
  purgeCacheIfNeeded,
  formatCachePurgeResult,
} from "../monitoring/index.js";
import { resolveProfile } from "../config/profileResolver.js";

/**
 * Global runner lock instance
 */
let globalLock: RunnerLock | null = null;

/**
 * Global file logger instance
 */
let globalFileLogger: FileLogger | null = null;

/**
 * Acquire runner lock for the given profile
 */
export async function acquireRunnerLock(profileDir?: string): Promise<void> {
  // Resolve profile directory
  const profile = resolveProfile(profileDir);

  // Create and acquire lock
  globalLock = new RunnerLock(profile.path);

  try {
    await globalLock.acquire();
  } catch (error) {
    if (error instanceof LockError) {
      // Re-throw with more context
      throw error;
    }
    throw new Error(
      `Failed to acquire runner lock: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Release runner lock
 */
export function releaseRunnerLock(): void {
  if (globalLock) {
    globalLock.release();
    globalLock = null;
  }
}

/**
 * Initialize file logger for the given profile
 */
export function initializeFileLogger(
  profileDir?: string,
  options?: {
    enabled?: boolean;
    minLevel?: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  }
): FileLogger {
  const profile = resolveProfile(profileDir);

  globalFileLogger = createFileLogger({
    profileDir: profile.path,
    enabled: options?.enabled,
    minLevel: options?.minLevel,
  });

  return globalFileLogger;
}

/**
 * Get the global file logger instance
 */
export function getFileLogger(): FileLogger | null {
  return globalFileLogger;
}

/**
 * Close file logger
 */
export async function closeFileLogger(): Promise<void> {
  if (globalFileLogger) {
    await globalFileLogger.close();
    globalFileLogger = null;
  }
}

/**
 * Purge cache if needed and display result
 */
export function purgeCache(
  profileDir?: string,
  keepCache?: boolean,
  resolution: { baseDir?: string; ignoreEnvironment?: boolean } = {}
): void {
  const profile = resolveProfile(profileDir, resolution.baseDir, {
    ignoreEnvironment: resolution.ignoreEnvironment,
  });

  const result = purgeCacheIfNeeded({
    profileDir: profile.path,
    keepCache,
  });

  const message = formatCachePurgeResult(result);
  console.log(message);
}

/**
 * Cleanup all runner resources
 */
export async function cleanupRunnerResources(): Promise<void> {
  releaseRunnerLock();
  await closeFileLogger();
}
