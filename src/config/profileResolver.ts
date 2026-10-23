/**
 * Profile resolver with manifest support
 * Implements precedence chain: --profile-dir → LEX_PR_PROFILE_DIR → .smartergpt.local/ → .smartergpt/
 */

import * as fs from "fs";
import * as path from "path";
import YAML from "yaml";
import { getEnvWithAlias } from "../util/envUtils.js";

/**
 * Profile manifest schema
 */
export interface ProfileManifest {
  role: string;
  name?: string;
  version?: string;
}

/**
 * Resolved profile information
 */
export interface ResolvedProfile {
  path: string; // Absolute path to profile directory
  source: string; // Source of resolution (--profile-dir, LEX_PR_PROFILE_DIR, .smartergpt.local, .smartergpt)
  manifest: ProfileManifest;
}

/**
 * Resolve profile directory with precedence chain
 *
 * Precedence order:
 * 1. --profile-dir flag (passed as parameter)
 * 2. LEX_PR_PROFILE_DIR environment variable
 * 3. .smartergpt.local/ (local override, not tracked)
 * 4. .smartergpt/ (tracked example profile)
 *
 * @param profileDirFlag - Profile directory from CLI flag (optional)
 * @param baseDir - Base directory to resolve relative paths (default: current working directory)
 * @returns Resolved profile with absolute path and manifest
 */
export function resolveProfile(
  profileDirFlag?: string,
  baseDir: string = process.cwd(),
  options: { ignoreEnvironment?: boolean } = {}
): ResolvedProfile {
  let profilePath: string | undefined;
  let source: string;

  // Precedence 1: --profile-dir flag
  if (profileDirFlag) {
    profilePath = path.isAbsolute(profileDirFlag)
      ? profileDirFlag
      : path.resolve(baseDir, profileDirFlag);
    source = "--profile-dir";
  }
  // Precedence 2: LEX_PR_PROFILE_DIR environment variable (with LEXRUNNER_PROFILE_DIR alias)
  else {
    const envProfileDir = options.ignoreEnvironment
      ? undefined
      : getEnvWithAlias("LEX_PR_PROFILE_DIR", "LEXRUNNER_PROFILE_DIR");
    if (envProfileDir) {
      profilePath = path.isAbsolute(envProfileDir)
        ? envProfileDir
        : path.resolve(baseDir, envProfileDir);
      source = "LEX_PR_PROFILE_DIR";
    }
    // Precedence 3: .smartergpt.local/ (local override)
    else {
      const localPath = path.resolve(baseDir, ".smartergpt.local");
      if (fs.existsSync(localPath)) {
        profilePath = localPath;
        source = ".smartergpt.local/";
      }
      // Precedence 4: .smartergpt/ (tracked profile)
      else {
        profilePath = path.resolve(baseDir, ".smartergpt");
        source = ".smartergpt/";
      }
    }
  }

  // Read manifest file if present
  const manifestPath = path.join(profilePath, "profile.yml");
  let manifest: ProfileManifest;

  try {
    const content = fs.readFileSync(manifestPath, "utf8");
    const parsed = YAML.parse(content);
    manifest = {
      role: parsed.role || "example",
      name: parsed.name,
      version: parsed.version,
    };
  } catch (error) {
    // Default manifest for .smartergpt/ when no profile.yml exists
    if (source === ".smartergpt/") {
      manifest = { role: "example" };
    } else {
      // For other sources, missing manifest is an error
      throw new ProfileResolverError(
        `Profile directory "${profilePath}" (from ${source}) is missing profile.yml manifest`
      );
    }
  }

  // Emit telemetry breadcrumb
  emitTelemetry(profilePath, manifest.role);

  return {
    path: profilePath,
    source,
    manifest,
  };
}

import { isJsonMode } from "../util/colorControl.js";

/**
 * Log profile-related message to stderr with consistent prefix
 *
 * @param message - The message to log (without prefix)
 */
export function logProfileMessage(message: string): void {
  // Suppress in JSON mode to keep stderr clean
  if (isJsonMode()) {
    return;
  }
  // Use stderr to avoid interfering with JSON output to stdout
  console.error(`lexrunner profile: ${message}`);
}

/**
 * Emit telemetry breadcrumb on profile resolution
 */
function emitTelemetry(profilePath: string, role: string): void {
  logProfileMessage(`using profile: ${profilePath} (role: ${role})`);
}

/**
 * Profile resolver error
 */
export class ProfileResolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileResolverError";
  }
}

/**
 * Write protection error - thrown when attempting to write to a protected profile
 */
export class WriteProtectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteProtectionError";
  }
}

/**
 * Validate if writes are allowed to a profile path
 *
 * Write discipline rules:
 * - Profiles with role="example" are read-only (tracked example profiles)
 * - All writes must target local overlay or explicitly writable profiles
 * - .smartergpt/ is treated as role="example" if no manifest exists
 *
 * @param profilePath - Absolute path to the profile directory
 * @param role - Profile role from manifest (defaults to "example" for .smartergpt/)
 * @returns true if writes are allowed, false otherwise
 */
export function canWriteToProfile(profilePath: string, role: string): boolean {
  // Profiles with role "example" are read-only
  if (role === "example") {
    return false;
  }

  // All other roles are writable
  return true;
}

/**
 * Validate write operation and throw error if not allowed
 *
 * @param profilePath - Absolute path to the profile directory
 * @param role - Profile role from manifest
 * @param operation - Description of the operation being attempted (for error message)
 * @throws WriteProtectionError if writes are not allowed
 */
export function validateWriteOperation(profilePath: string, role: string, operation: string): void {
  if (!canWriteToProfile(profilePath, role)) {
    throw new WriteProtectionError(
      `Cannot ${operation}: profile at "${profilePath}" has role="${role}" (read-only). ` +
        `Use a local profile (.smartergpt.local/) or set LEX_PR_PROFILE_DIR to a writable location.`
    );
  }
}
