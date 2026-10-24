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
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(profileDir, `.backup-${timestamp}`, "runner-config");
  let backupCreated = false;
  let backupComplete = false;

  try {
    fs.mkdirSync(backupPath, { recursive: true });
    backupCreated = true;

    // Copy files to backup
    for (const file of filesToMigrate) {
      const sourcePath = path.join(runnerDir, file);
      const backupFilePath = path.join(backupPath, file);
      fs.copyFileSync(sourcePath, backupFilePath);
    }
    backupComplete = true;

    // Move compatibility files to the canonical profile root.
    for (const file of filesToMigrate) {
      const runnerPath = path.join(runnerDir, file);
      const rootPath = path.join(profileDir, file);
      fs.renameSync(runnerPath, rootPath);
      migratedFiles.push(file);
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
    const uncertainFiles: string[] = [];
    // Roll back every completed move independently so one failure does not
    // hide the disposition of the remaining files.
    for (const file of migratedFiles) {
      try {
        const runnerPath = path.join(runnerDir, file);
        const rootPath = path.join(profileDir, file);
        if (fs.existsSync(rootPath) && !fs.existsSync(runnerPath)) {
          fs.renameSync(rootPath, runnerPath);
        }
        if (!fs.existsSync(runnerPath) || fs.existsSync(rootPath)) uncertainFiles.push(file);
      } catch {
        uncertainFiles.push(file);
      }
    }

    const moveDisposition = uncertainFiles.length
      ? `Rollback could not confirm restoration for: ${uncertainFiles.join(", ")}.`
      : migratedFiles.length
        ? "Completed moves were restored."
        : "No files were moved.";
    const backupStatus = backupComplete ? "complete" : backupCreated ? "incomplete" : "unavailable";
    const backupDisposition = backupComplete
      ? `A complete backup is retained at ${backupPath}.`
      : backupCreated
        ? `The backup at ${backupPath} is incomplete and must not be relied upon for recovery.`
        : "No backup was created.";

    return {
      success: false,
      message: `Migration failed: ${error instanceof Error ? error.message : String(error)}. ${moveDisposition} ${backupDisposition}`,
      migratedFiles: [],
      ...(backupCreated ? { backupPath } : {}),
      backupStatus,
      skippedFiles,
      ...(uncertainFiles.length ? { uncertainFiles } : {}),
    };
  }
}
