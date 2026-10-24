/**
 * Configuration path resolution with compatibility support for the historical
 * runner/ configuration layout. Profile-root configuration is canonical;
 * runner/ is reserved for working artifacts.
 */

import * as fs from "fs";
import * as path from "path";

export interface ResolvedConfigPath {
  /** Absolute path to the config file */
  path: string;
  /** Whether the file exists at the resolved path */
  exists: boolean;
  /** Source pattern used for this observation */
  source:
    | "profile-root"
    | "runner/ (compatibility)"
    | "workspace fallback"
    | "workspace runner/ (compatibility)";
  /** Whether compatibility-layout remediation should be shown */
  shouldNotifyMigration: boolean;
}

// Track if we've already shown the migration notice in this process
let migrationNoticeShown = false;

/**
 * Resolve a configuration file from the canonical profile root, with a
 * compatibility-only fallback for releases that emitted config into runner/.
 *
 * Tries paths in this order:
 * 1. profileDir/{fileName} (canonical)
 * 2. profileDir/runner/{fileName} (compatibility fallback)
 * 3. sibling .smartergpt/{fileName}, only when profileDir is the local overlay
 * 4. sibling .smartergpt/runner/{fileName} (compatibility fallback)
 *
 * @param profileDir - Base profile directory
 * @param fileName - Configuration file name
 * @returns Resolved path information
 */
export function resolveConfigPath(
  profileDir: string,
  fileName: string,
  options: { allowWorkspaceFallback?: boolean } = {}
): ResolvedConfigPath {
  const rootPath = path.join(profileDir, fileName);
  if (fs.existsSync(rootPath)) {
    return {
      path: rootPath,
      exists: true,
      source: "profile-root",
      shouldNotifyMigration: false,
    };
  }

  // Older releases could place configuration in runner/. Continue reading it,
  // but never allow it to override a canonical root file.
  const runnerPath = path.join(profileDir, "runner", fileName);
  if (fs.existsSync(runnerPath)) {
    const shouldNotify = !migrationNoticeShown;
    if (shouldNotify) migrationNoticeShown = true;
    return {
      path: runnerPath,
      exists: true,
      source: "runner/ (compatibility)",
      shouldNotifyMigration: shouldNotify,
    };
  }

  // A local overlay is file-level: when it omits a file, read the tracked
  // workspace profile. Explicit/environment profiles do not silently cross
  // this boundary because their directory names are not .smartergpt.local.
  if (
    options.allowWorkspaceFallback !== false &&
    path.basename(path.resolve(profileDir)) === ".smartergpt.local"
  ) {
    const workspaceDir = path.join(path.dirname(path.resolve(profileDir)), ".smartergpt");
    const workspaceRootPath = path.join(workspaceDir, fileName);
    if (fs.existsSync(workspaceRootPath)) {
      return {
        path: workspaceRootPath,
        exists: true,
        source: "workspace fallback",
        shouldNotifyMigration: false,
      };
    }

    const workspaceRunnerPath = path.join(workspaceDir, "runner", fileName);
    if (fs.existsSync(workspaceRunnerPath)) {
      const shouldNotify = !migrationNoticeShown;
      if (shouldNotify) migrationNoticeShown = true;
      return {
        path: workspaceRunnerPath,
        exists: true,
        source: "workspace runner/ (compatibility)",
        shouldNotifyMigration: shouldNotify,
      };
    }
  }

  return {
    path: rootPath,
    exists: false,
    source: "profile-root",
    shouldNotifyMigration: false,
  };
}

/**
 * Show one-time migration notice to stderr
 */
export function showMigrationNotice(): void {
  // Don't show notice in test environment
  if (!process.env.VITEST) {
    console.error(
      "⚠️  Compatibility configuration found under runner/. Move configuration files to the profile root; runner/ is reserved for working artifacts."
    );
  }
}

/**
 * Reset migration notice state (useful for testing)
 */
export function resetMigrationNotice(): void {
  migrationNoticeShown = false;
}

/**
 * Log path resolution for telemetry
 *
 * @param operation - Operation name (e.g., "loadScope")
 * @param resolved - Resolved path information
 */
export function logPathResolution(operation: string, resolved: ResolvedConfigPath): void {
  const compatibilitySource = resolved.source.includes("runner/ (compatibility)");
  const logEntry = {
    timestamp: new Date().toISOString(),
    level: compatibilitySource ? "warn" : "info",
    module: "config/pathResolver",
    operation,
    path_source: resolved.source,
    path: resolved.path,
    ...(compatibilitySource && {
      message:
        "Using compatibility runner/ configuration. Move it to the profile root; runner/ is reserved for working artifacts.",
    }),
  };

  // Only log to stderr in non-JSON mode and not in test environment
  if (!process.env.LEX_JSON_MODE && !process.env.VITEST) {
    console.error(JSON.stringify(logEntry));
  }
}
