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

  const manifest = loadProfileManifest(profilePath, source);

  // Emit telemetry breadcrumb
  emitTelemetry(profilePath, manifest.role);

  return {
    path: profilePath,
    source,
    manifest,
  };
}

function loadProfileManifest(profilePath: string, source: string): ProfileManifest {
  const manifestPath = path.join(profilePath, "profile.yml");
  let content: string;

  try {
    content = fs.readFileSync(manifestPath, "utf8");
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      // The tracked profile remains optional and defaults to the read-only
      // example role only when its manifest is genuinely absent.
      if (source === ".smartergpt/") {
        return { role: "example" };
      }
      throw new ProfileResolverError(
        `Profile directory "${profilePath}" (from ${source}) is missing profile.yml manifest`
      );
    }

    throw new ProfileResolverError(
      `Profile directory "${profilePath}" (from ${source}) has an unreadable profile.yml manifest`
    );
  }

  let parsed;
  try {
    parsed = YAML.parse(content);
  } catch {
    throw invalidManifestError(profilePath, source);
  }

  if (!isManifestObject(parsed)) {
    throw invalidManifestError(profilePath, source);
  }

  return {
    role: parsed.role === undefined ? "example" : parsed.role,
    name: parsed.name,
    version: parsed.version,
  };
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function isManifestObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidManifestError(profilePath: string, source: string): ProfileResolverError {
  return new ProfileResolverError(
    `Profile directory "${profilePath}" (from ${source}) has an invalid profile.yml manifest`
  );
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
 * Classify write-protection failures through the shared runtime identity.
 * Subclasses retain the same authority disposition even when they add
 * recovery metadata such as a retained backup path.
 */
export function isWriteProtectionError(error: unknown): error is WriteProtectionError {
  return error instanceof WriteProtectionError;
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
export function canWriteToProfile(profilePath: string, role: unknown): boolean {
  void profilePath;
  const normalizedRole = normalizeProfileRole(role);

  // Missing, malformed, and example roles are all read-only. Authority must
  // be established by a non-empty scalar role, never inferred from coercion.
  return normalizedRole !== undefined && normalizedRole !== "example";
}

/**
 * Validate write operation and throw error if not allowed
 *
 * @param profilePath - Absolute path to the profile directory
 * @param role - Profile role from manifest
 * @param operation - Description of the operation being attempted (for error message)
 * @throws WriteProtectionError if writes are not allowed
 */
export function validateWriteOperation(
  profilePath: string,
  role: unknown,
  operation: string
): void {
  if (!canWriteToProfile(profilePath, role)) {
    const normalizedRole = normalizeProfileRole(role);
    const roleDisposition =
      normalizedRole === "example"
        ? 'role="example"'
        : `an invalid ${describeProfileRole(role)} role`;
    throw new WriteProtectionError(
      `Cannot ${operation}: profile at "${profilePath}" has ${roleDisposition} (read-only). ` +
        `Use a local profile (.smartergpt.local/) or set LEX_PR_PROFILE_DIR to a writable location.`
    );
  }
}

function normalizeProfileRole(role: unknown): string | undefined {
  if (typeof role !== "string") return undefined;
  const normalized = role.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function describeProfileRole(role: unknown): string {
  if (role === null) return "null";
  if (Array.isArray(role)) return "array";
  if (typeof role === "string") return "empty";
  return typeof role;
}
