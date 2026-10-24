/**
 * Local overlay setup and initialization
 * Auto-detects project type and creates .smartergpt.local/ directory
 */

import * as fs from "fs";
import * as path from "path";
import YAML from "yaml";
import { createMinimalWorkspace, detectProjectType } from "../core/bootstrap.js";
import { resolveConfigPath } from "./pathResolver.js";
import { validateWriteOperation, WriteProtectionError } from "./profileResolver.js";

export interface LocalOverlayConfig {
  role: string;
  projectType: string;
  name?: string;
  version?: string;
}

export interface LocalOverlayResult {
  created: boolean;
  path: string;
  config: LocalOverlayConfig;
  copiedFiles: string[];
  /** Recoverable prior overlay retained by a forced recreation. */
  backupPath?: string;
}

interface StagedLocalOverlay {
  parent: string;
  root: string;
  profile: string;
}

/**
 * Initialize local overlay directory with auto-detected project configuration
 *
 * @param baseDir - Base directory for workspace (default: current working directory)
 * @param force - Force recreation even if local overlay exists
 * @returns Result of initialization
 */
export function initLocalOverlay(
  baseDir: string = process.cwd(),
  force: boolean = false
): LocalOverlayResult {
  const localDir = path.resolve(baseDir, ".smartergpt.local");
  const existed = fs.existsSync(localDir);
  const projectType = detectProjectType(baseDir);
  const manifestPath = path.join(localDir, "profile.yml");

  // Read and authorize an existing profile before creating runner/, replacing
  // the overlay, or writing any repair files. --force changes replacement
  // intent; it is not an authority bypass for a protected profile.
  const existingConfig = fs.existsSync(manifestPath)
    ? readLocalOverlayManifest(manifestPath, projectType)
    : undefined;
  if (force && existed && !existingConfig) {
    throw new LocalOverlayError(
      `Cannot force recreation of existing local overlay without a validated manifest: ${manifestPath}`
    );
  }
  validateWriteOperation(
    localDir,
    existingConfig?.role ?? "development",
    "initialize local overlay"
  );

  let stagedOverlay: StagedLocalOverlay | undefined;
  if (force && existed) {
    // Atomically detach the live directory instead of recursively deleting it.
    // Every file admitted before the rename remains recoverable in this stage.
    stagedOverlay = stageLocalOverlay(localDir);
    try {
      const stagedConfig = readLocalOverlayManifest(
        path.join(stagedOverlay.profile, "profile.yml"),
        projectType
      );
      validateWriteOperation(
        stagedOverlay.profile,
        stagedConfig.role,
        "force-recreate local overlay"
      );
    } catch (error) {
      throw withRetainedBackup(error, stagedOverlay.profile);
    }
  }

  try {
    fs.mkdirSync(localDir, { recursive: true });

    const config =
      !force && existingConfig
        ? existingConfig
        : createOrReadLocalOverlayManifest(manifestPath, projectType);
    validateWriteOperation(localDir, config.role, "initialize local overlay");
    const runnerDir = path.join(localDir, "runner");
    fs.mkdirSync(runnerDir, { recursive: true });

    // Copy tracked configuration first, then fill any missing required files with
    // coherent, schema-valid defaults. Existing files are never overwritten.
    const copiedFiles = copyRelevantFiles(baseDir, localDir);
    createMinimalWorkspace(baseDir, localDir);

    const backupPath = stagedOverlay ? retainStagedOverlay(stagedOverlay, runnerDir) : undefined;
    stagedOverlay = undefined;

    return {
      created: !existed || force,
      path: localDir,
      config,
      copiedFiles,
      ...(backupPath ? { backupPath } : {}),
    };
  } catch (error) {
    if (stagedOverlay) throw withRetainedBackup(error, stagedOverlay.profile);
    throw error;
  }
}

/**
 * Copy relevant configuration files from fallback profile to local overlay
 *
 * @param baseDir - Base directory for workspace
 * @param localDir - Local overlay directory
 * @returns List of copied files
 */
function copyRelevantFiles(baseDir: string, localDir: string): string[] {
  const copiedFiles: string[] = [];

  // Check for .smartergpt/ directory as the source
  const smartergptDir = path.resolve(baseDir, ".smartergpt");
  if (!fs.existsSync(smartergptDir)) {
    return copiedFiles; // No .smartergpt to copy from
  }

  // Files to potentially copy (excluding runtime artifacts)
  const candidateFiles = [
    "intent.md",
    "scope.yml",
    "deps.yml",
    "gates.yml",
    "stack.yml",
    "merge-policy.yml",
    "pull-request-template.md",
  ];

  for (const file of candidateFiles) {
    // Read historical source layouts through the shared resolver, but always
    // write the canonical profile-root layout.
    const sourceResolved = resolveConfigPath(smartergptDir, file);
    const destPath = path.join(localDir, file);

    if (!sourceResolved.exists) continue;

    // Admit the copy atomically. If another initializer or editor creates the
    // destination first, preserve that file and treat this candidate as skipped.
    try {
      fs.copyFileSync(sourceResolved.path, destPath, fs.constants.COPYFILE_EXCL);
      copiedFiles.push(file);
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
    }
  }

  return copiedFiles;
}

/**
 * Check if local overlay exists
 *
 * @param baseDir - Base directory for workspace
 * @returns True if local overlay directory exists
 */
export function hasLocalOverlay(baseDir: string = process.cwd()): boolean {
  const localDir = path.resolve(baseDir, ".smartergpt.local");
  return fs.existsSync(localDir);
}

function createOrReadLocalOverlayManifest(
  manifestPath: string,
  projectType: string
): LocalOverlayConfig {
  const config: LocalOverlayConfig = { role: "development", projectType };
  try {
    fs.writeFileSync(
      manifestPath,
      YAML.stringify({ role: config.role, projectType: config.projectType }),
      { encoding: "utf8", flag: "wx" }
    );
    return config;
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }

  // A concurrent writer won manifest admission. Its authority and shape now
  // control whether initialization may proceed; never replace it.
  return readLocalOverlayManifest(manifestPath, projectType);
}

function stageLocalOverlay(localDir: string): StagedLocalOverlay {
  let lastError: unknown;
  for (const parent of stagingParentCandidates(path.dirname(localDir))) {
    let root: string | undefined;
    try {
      fs.mkdirSync(parent, { recursive: true });
      root = fs.mkdtempSync(path.join(parent, "overlay-"));
    } catch (error) {
      lastError = error;
      continue;
    }

    const profile = path.join(root, "profile");
    try {
      fs.renameSync(localDir, profile);
      return { parent, root, profile };
    } catch (error) {
      lastError = error;
      cleanEmptyDirectory(root);
      cleanEmptyDirectory(parent);
      if (!isCrossDeviceError(error)) {
        throw new LocalOverlayError(
          `Unable to atomically stage the existing local overlay: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  throw new LocalOverlayError(
    `Unable to atomically stage the existing local overlay: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

function stagingParentCandidates(baseDir: string): string[] {
  const candidates: string[] = [];
  const gitDirectory = findGitMetadataDirectory(baseDir);
  if (gitDirectory) {
    candidates.push(path.join(gitDirectory, "lexrunner", "force-stages"));
  }

  const outsideWorkspace = path.dirname(baseDir);
  if (outsideWorkspace !== baseDir) {
    candidates.push(path.join(outsideWorkspace, ".lexrunner-force-stages"));
  }

  return candidates.filter(
    (candidate, index) =>
      candidates.findIndex(
        (other) => path.resolve(other).toLowerCase() === path.resolve(candidate).toLowerCase()
      ) === index
  );
}

function findGitMetadataDirectory(startDir: string): string | undefined {
  let current = path.resolve(startDir);
  while (true) {
    const marker = path.join(current, ".git");
    try {
      const stat = fs.statSync(marker);
      if (stat.isDirectory()) return marker;
      if (stat.isFile()) {
        const match = /^gitdir:\s*(.+)\s*$/imu.exec(fs.readFileSync(marker, "utf8"));
        if (match?.[1]) {
          const gitDirectory = path.resolve(current, match[1]);
          if (fs.statSync(gitDirectory).isDirectory()) return gitDirectory;
        }
      }
    } catch {
      // This ancestor is not a Git worktree marker.
    }

    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function retainStagedOverlay(staged: StagedLocalOverlay, runnerDir: string): string {
  const backupsDir = path.join(runnerDir, "force-backups");
  fs.mkdirSync(backupsDir, { recursive: true });
  const backupPath = path.join(backupsDir, path.basename(staged.root));
  fs.renameSync(staged.profile, backupPath);
  cleanStageDirectories(staged);
  return backupPath;
}

function cleanStageDirectories(staged: StagedLocalOverlay): void {
  cleanEmptyDirectory(staged.root);
  cleanEmptyDirectory(staged.parent);
  const lexrunnerDirectory = path.dirname(staged.parent);
  if (path.basename(lexrunnerDirectory) === "lexrunner") {
    cleanEmptyDirectory(lexrunnerDirectory);
  }
}

function cleanEmptyDirectory(directory: string): void {
  try {
    fs.rmdirSync(directory);
  } catch {
    // Remove only known-empty directories. Unknown data is always retained.
  }
}

function withRetainedBackup(error: unknown, backupPath: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const retainedMessage = `${message} Prior overlay retained at ${backupPath}.`;
  if (error instanceof WriteProtectionError) {
    return new RetainedWriteProtectionError(retainedMessage, backupPath);
  }
  return new LocalOverlayError(retainedMessage, backupPath);
}

function readLocalOverlayManifest(
  manifestPath: string,
  fallbackProjectType: string
): LocalOverlayConfig {
  let parsed: unknown;
  try {
    parsed = YAML.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw new LocalOverlayError(`Existing profile manifest is invalid: ${manifestPath}`);
  }

  if (!isRecord(parsed)) {
    throw new LocalOverlayError(`Existing profile manifest is invalid: ${manifestPath}`);
  }

  const role = requiredNonEmptyString(parsed.role, "role", manifestPath);
  const projectType = optionalNonEmptyString(parsed.projectType, "projectType", manifestPath);
  const name = optionalString(parsed.name, "name", manifestPath);
  const version = optionalVersion(parsed.version, manifestPath);

  return {
    role,
    projectType: projectType ?? fallbackProjectType,
    ...(name !== undefined ? { name } : {}),
    ...(version !== undefined ? { version } : {}),
  };
}

function requiredNonEmptyString(value: unknown, field: string, manifestPath: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new LocalOverlayError(`Existing profile manifest has invalid ${field}: ${manifestPath}`);
  }
  return value.trim();
}

function optionalNonEmptyString(
  value: unknown,
  field: string,
  manifestPath: string
): string | undefined {
  if (value === undefined) return undefined;
  return requiredNonEmptyString(value, field, manifestPath);
}

function optionalString(value: unknown, field: string, manifestPath: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new LocalOverlayError(`Existing profile manifest has invalid ${field}: ${manifestPath}`);
  }
  return value;
}

function optionalVersion(value: unknown, manifestPath: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new LocalOverlayError(`Existing profile manifest has invalid version: ${manifestPath}`);
  }
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function isCrossDeviceError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EXDEV"
  );
}

/**
 * Local overlay error
 */
export class LocalOverlayError extends Error {
  constructor(
    message: string,
    readonly retainedBackupPath?: string
  ) {
    super(message);
    this.name = "LocalOverlayError";
  }
}

class RetainedWriteProtectionError extends WriteProtectionError {
  constructor(
    message: string,
    readonly retainedBackupPath: string
  ) {
    super(message);
    this.name = "RetainedWriteProtectionError";
  }
}
