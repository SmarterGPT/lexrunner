/**
 * Profile migration command. Profile-root configuration is canonical;
 * runner/ is reserved for working artifacts.
 */

import * as fs from "fs";
import * as path from "path";
import { resolveProfile, validateWriteOperation } from "../config/profileResolver.js";

export interface MigrateProfileOptions {
  fromFlat?: boolean;
  fromRunner?: boolean;
  dryRun?: boolean;
  profileDir?: string;
}

export interface MigrateProfileResult {
  success: boolean;
  message: string;
  migratedFiles: string[];
  backupPath?: string;
  backupStatus?: "complete" | "incomplete" | "unavailable";
  skippedFiles: string[];
  uncertainFiles?: string[];
  retainedFiles?: string[];
}

/**
 * Move compatibility configuration from runner/ to the profile root without
 * overwriting an existing canonical file.
 */
export async function runMigrateProfile(
  options: MigrateProfileOptions = {}
): Promise<MigrateProfileResult> {
  if (options.fromFlat) {
    return {
      success: false,
      message:
        "--from-flat is retired because profile-root configuration is canonical. Use --from-runner to move compatibility files out of runner/.",
      migratedFiles: [],
      skippedFiles: [],
    };
  }
  if (!options.fromRunner) {
    return {
      success: false,
      message:
        "No migration type specified. Use --from-runner to restore canonical profile-root configuration.",
      migratedFiles: [],
      skippedFiles: [],
    };
  }

  const baseDir = process.cwd();

  // Resolve profile directory with error handling
  let profileDir: string;
  try {
    const resolved = resolveProfile(options.profileDir, baseDir);
    profileDir = resolved.path;
    if (!options.dryRun) {
      validateWriteOperation(profileDir, resolved.manifest.role, "migrate profile configuration");
    }
  } catch (error) {
    return {
      success: false,
      message: `Profile directory error: ${error instanceof Error ? error.message : String(error)}`,
      migratedFiles: [],
      skippedFiles: [],
    };
  }

  // Check if profile directory exists
  if (!fs.existsSync(profileDir)) {
    return {
      success: false,
      message: `Profile directory does not exist: ${profileDir}`,
      migratedFiles: [],
      skippedFiles: [],
    };
  }

  // Files to migrate
  const configFiles = [
    "intent.md",
    "scope.yml",
    "deps.yml",
    "gates.yml",
    "stack.yml",
    "merge-policy.yml",
    "pull-request-template.md",
  ];

  const migratedFiles: string[] = [];
  const runnerDir = path.join(profileDir, "runner");
  const runnerFiles = configFiles.filter((file) => fs.existsSync(path.join(runnerDir, file)));
  const conflicts = runnerFiles.filter((file) => fs.existsSync(path.join(profileDir, file)));
  const filesToMigrate = runnerFiles.filter((file) => !conflicts.includes(file));
  const skippedFiles = conflicts.map(
    (file) => `${file} (profile-root file exists; compatibility copy preserved)`
  );

  if (!runnerFiles.length) {
    return {
      success: true,
      message: "No compatibility configuration files found under runner/.",
      migratedFiles: [],
      skippedFiles: [],
    };
  }

  // Dry run mode - just report what would be done
  if (options.dryRun) {
    return {
      success: true,
      message: `Dry run: Would migrate ${filesToMigrate.length} file(s) to the profile root`,
      migratedFiles: filesToMigrate.map((f) => `${f} (would migrate)`),
      skippedFiles,
    };
  }

  if (!filesToMigrate.length) {
    return {
      success: true,
      message: "Canonical profile-root configuration already exists; no files were overwritten.",
      migratedFiles: [],
      skippedFiles,
    };
  }

  // Create backup before migration
  let backupRoot: string | undefined;
  let backupPath: string | undefined;
  let stagingPath: string | undefined;
  let backupCreated = false;
  let backupComplete = false;
  let activeFile: string | undefined;
  const retainedFiles: string[] = [];

  try {
    backupRoot = fs.mkdtempSync(path.join(profileDir, ".backup-"));
    backupPath = path.join(backupRoot, "runner-config");
    stagingPath = path.join(backupRoot, "staging");
    fs.mkdirSync(backupPath, { recursive: true });
    fs.mkdirSync(stagingPath, { recursive: true });
    backupCreated = true;

    // Copy files to backup
    for (const file of filesToMigrate) {
      const sourcePath = path.join(runnerDir, file);
      const backupFilePath = path.join(backupPath, file);
      fs.copyFileSync(sourcePath, backupFilePath);
    }
    backupComplete = true;

    // Stage each source away from its public path, then admit the canonical
    // destination with an exclusive create. This prevents a concurrently
    // created root file from being replaced and prevents a concurrently
    // recreated runner file from being deleted during cleanup.
    for (const file of filesToMigrate) {
      activeFile = file;
      const runnerPath = path.join(runnerDir, file);
      const rootPath = path.join(profileDir, file);
      const stagedPath = path.join(stagingPath, file);
      fs.renameSync(runnerPath, stagedPath);

      try {
        fs.copyFileSync(stagedPath, rootPath, fs.constants.COPYFILE_EXCL);
      } catch (error) {
        if (isAlreadyExists(error)) {
          if (restoreStagedCompatibility(stagedPath, runnerPath)) {
            addUnique(retainedFiles, stagedPath);
          }
          skippedFiles.push(
            `${file} (profile-root file appeared during migration; compatibility copy preserved)`
          );
          activeFile = undefined;
          continue;
        }
        throw error;
      }

      try {
        fs.unlinkSync(stagedPath);
      } catch (error) {
        if (restoreStagedCompatibility(stagedPath, runnerPath)) {
          addUnique(retainedFiles, stagedPath);
        }
        throw error;
      }
      migratedFiles.push(file);
      activeFile = undefined;
    }

    tryRemoveEmptyDirectory(stagingPath);

    if (retainedFiles.length) {
      return {
        success: false,
        message:
          `Migration preserved files requiring manual reconciliation: ${retainedFiles.join(", ")}. ` +
          `A complete backup is retained at ${backupPath}.`,
        migratedFiles,
        backupPath,
        backupStatus: "complete",
        skippedFiles,
        retainedFiles,
      };
    }

    return {
      success: true,
      message: `Successfully migrated ${migratedFiles.length} file(s) to the profile root`,
      migratedFiles,
      backupPath,
      backupStatus: "complete",
      skippedFiles,
    };
  } catch (error) {
    const uncertainFiles = activeFile ? [activeFile] : [];
    if (activeFile && stagingPath) {
      const stagedPath = path.join(stagingPath, activeFile);
      const runnerPath = path.join(runnerDir, activeFile);
      if (restoreStagedCompatibility(stagedPath, runnerPath)) {
        addUnique(retainedFiles, stagedPath);
      }
    }

    const moveDisposition = migratedFiles.length
      ? `Completed safe moves were retained for: ${migratedFiles.join(", ")}.`
      : "No files completed migration.";
    const uncertaintyDisposition = uncertainFiles.length
      ? `Reconcile the in-flight file: ${uncertainFiles.join(", ")}.`
      : "";
    const backupStatus = backupComplete ? "complete" : backupCreated ? "incomplete" : "unavailable";
    const backupDisposition =
      backupComplete && backupPath
        ? `A complete backup is retained at ${backupPath}.`
        : backupCreated && backupPath
          ? `The backup at ${backupPath} is incomplete and must not be relied upon for recovery.`
          : "No backup was created.";

    return {
      success: false,
      message: `Migration failed: ${error instanceof Error ? error.message : String(error)}. ${moveDisposition} ${uncertaintyDisposition} ${backupDisposition}`,
      migratedFiles,
      ...(backupCreated && backupPath ? { backupPath } : {}),
      backupStatus,
      skippedFiles,
      ...(uncertainFiles.length ? { uncertainFiles } : {}),
      ...(retainedFiles.length ? { retainedFiles } : {}),
    };
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "EEXIST";
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

/** Restore a staged compatibility source without replacing a recreated path. */
function restoreStagedCompatibility(stagedPath: string, runnerPath: string): boolean {
  if (!fs.existsSync(stagedPath)) return false;
  try {
    fs.copyFileSync(stagedPath, runnerPath, fs.constants.COPYFILE_EXCL);
  } catch {
    return true;
  }
  try {
    fs.unlinkSync(stagedPath);
    return false;
  } catch {
    return true;
  }
}

function tryRemoveEmptyDirectory(directory: string): void {
  try {
    fs.rmdirSync(directory);
  } catch {
    // The backup remains truthful even if an empty staging directory cannot be removed.
  }
}
