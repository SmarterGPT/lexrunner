/**
 * Local overlay setup and initialization
 * Auto-detects project type and creates .smartergpt.local/ directory
 */

import * as fs from "fs";
import * as path from "path";
import YAML from "yaml";
import { detectProjectType } from "../core/bootstrap.js";
import { resolveConfigPath } from "./pathResolver.js";

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

  // Skip if local overlay already exists (unless force flag is set)
  if (fs.existsSync(localDir) && !force) {
    // Initialization also repairs the artifact directory without rewriting
    // existing profile configuration.
    fs.mkdirSync(path.join(localDir, "runner"), { recursive: true });
    const manifestPath = path.join(localDir, "profile.yml");
    let config: LocalOverlayConfig;

    try {
      const content = fs.readFileSync(manifestPath, "utf8");
      const parsed = YAML.parse(content);
      config = {
        role: parsed.role || "development",
        projectType: parsed.projectType || "generic",
        name: parsed.name,
        version: parsed.version,
      };
    } catch {
      config = {
        role: "development",
        projectType: "generic",
      };
    }

    return {
      created: false,
      path: localDir,
      config,
      copiedFiles: [],
    };
  }

  // Detect project type
  const projectType = detectProjectType(baseDir);

  // Create local overlay directory
  if (force && fs.existsSync(localDir)) {
    fs.rmSync(localDir, { recursive: true });
  }
  fs.mkdirSync(localDir, { recursive: true });
  // runner/ is artifact-only. Configuration belongs at the profile root.
  fs.mkdirSync(path.join(localDir, "runner"), { recursive: true });

  // Create profile.yml with detected project type
  const config: LocalOverlayConfig = {
    role: "development",
    projectType,
    name: undefined,
    version: undefined,
  };

  const manifestPath = path.join(localDir, "profile.yml");
  const manifestContent = YAML.stringify({
    role: config.role,
    projectType: config.projectType,
  });
  fs.writeFileSync(manifestPath, manifestContent);

  // Copy relevant files from fallback profile
  const copiedFiles = copyRelevantFiles(baseDir, localDir);

  return {
    created: true,
    path: localDir,
    config,
    copiedFiles,
  };
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

    // Only copy if source exists and destination doesn't
    if (sourceResolved.exists && !fs.existsSync(destPath)) {
      fs.copyFileSync(sourceResolved.path, destPath);
      copiedFiles.push(file);
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

/**
 * Local overlay error
 */
export class LocalOverlayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalOverlayError";
  }
}
