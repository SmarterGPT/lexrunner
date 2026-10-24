/**
 * Configuration bootstrapping and workspace setup
 * Provides automatic configuration discovery and fallback mechanisms
 */

import * as fs from "fs";
import * as path from "path";
import YAML from "yaml";
import { exec } from "child_process";
import {
  resolveProfile,
  validateWriteOperation,
  WriteProtectionError,
} from "../config/profileResolver.js";
import { resolveConfigPath } from "../config/pathResolver.js";

// Cached Docker availability probe. null = unknown, true = available, false = not available
let dockerAvailable: boolean | null = null;

// Probe Docker availability asynchronously at module load time and cache the result.
// We use a short timeout to avoid hanging in environments where Docker is installed but
// inaccessible. This keeps `getEnvironmentSuggestions()` non-blocking.
(function probeDockerAvailability() {
  try {
    exec("docker --version", { timeout: 2000 }, (err) => {
      dockerAvailable = err ? false : true;
    });
  } catch {
    dockerAvailable = false;
  }
})();

export interface BootstrapConfig {
  profileDir: string;
  hasConfiguration: boolean;
  missingFiles: string[];
  compatibilityFiles: string[];
  suggestions: string[];
}

export interface WorkspaceTemplate {
  name: string;
  description: string;
  files: Record<string, string>;
}

/**
 * Bootstrap workspace configuration with intelligent defaults
 *
 * @param baseDir - Base directory for profile resolution
 * @param profileDirFlag - Optional profile directory override (from CLI --profile-dir)
 */
export function bootstrapWorkspace(
  baseDir: string = ".",
  profileDirFlag?: string
): BootstrapConfig {
  // Resolve the profile directory
  const resolved = resolveProfile(profileDirFlag, baseDir);
  const profileDir = resolved.path;
  const expectedFiles = ["intent.md", "scope.yml", "deps.yml", "gates.yml"];

  const missingFiles: string[] = [];
  const compatibilityFiles: string[] = [];
  const compatibilityMoves: Array<{ from: string; to: string }> = [];
  const configurationTargetDir = fs.existsSync(profileDir)
    ? profileDir
    : path.resolve(baseDir, ".smartergpt.local");
  const suggestions: string[] = [];

  // Check if profile directory exists
  if (!fs.existsSync(profileDir)) {
    suggestions.push(
      `Initialize the local profile at ${path.resolve(baseDir, ".smartergpt.local")}`
    );
    missingFiles.push(...expectedFiles);
  } else {
    // Profile-root config is canonical. Continue observing historical runner/
    // config so existing workspaces fail neither silently nor unnecessarily.
    for (const file of expectedFiles) {
      const resolved = resolveConfigPath(profileDir, file);
      if (!resolved.exists) missingFiles.push(file);
      else if (resolved.source.includes("runner/ (compatibility)")) {
        compatibilityFiles.push(file);
        compatibilityMoves.push({
          from: resolved.path,
          to: path.join(path.dirname(path.dirname(resolved.path)), file),
        });
      }
    }
  }

  // Generate contextual suggestions
  if (missingFiles.includes("intent.md")) {
    suggestions.push(
      `Create ${path.join(configurationTargetDir, "intent.md")} to describe project goals and scope`
    );
  }

  if (missingFiles.includes("scope.yml")) {
    suggestions.push(
      `Create ${path.join(configurationTargetDir, "scope.yml")} to define PR discovery rules`
    );
  }

  if (missingFiles.includes("deps.yml")) {
    suggestions.push(
      `Create ${path.join(configurationTargetDir, "deps.yml")} to specify dependency relationships`
    );
  }

  if (missingFiles.includes("gates.yml")) {
    suggestions.push(
      `Create ${path.join(configurationTargetDir, "gates.yml")} to define quality gates`
    );
  }

  if (compatibilityFiles.length) {
    suggestions.push(
      ...compatibilityMoves.map(
        ({ from, to }) => `Move compatibility configuration ${from} to ${to}`
      )
    );
  }

  return {
    profileDir,
    hasConfiguration: missingFiles.length === 0,
    missingFiles,
    compatibilityFiles,
    suggestions,
  };
}

/**
 * Create minimal workspace configuration
 *
 * @param baseDir - Base directory for profile resolution
 * @param profileDirFlag - Optional profile directory override (from CLI --profile-dir)
 * @throws WriteProtectionError if attempting to write to a read-only profile
 */
export function createMinimalWorkspace(baseDir: string = ".", profileDirFlag?: string): void {
  // Resolve the profile directory and check write permissions
  const resolved = resolveProfile(profileDirFlag, baseDir);
  const profileDir = resolved.path;
  const role = resolved.manifest.role;

  // Validate write operation is allowed
  validateWriteOperation(profileDir, role, "create minimal workspace");

  // Ensure profile directory exists
  fs.mkdirSync(profileDir, { recursive: true });

  // Create runner/ subdirectory for working artifacts
  const runnerDir = path.join(profileDir, "runner");
  fs.mkdirSync(runnerDir, { recursive: true });

  // Create config files at profile root (v1 structure)
  const intentPath = path.join(profileDir, "intent.md");
  if (!fs.existsSync(intentPath)) {
    fs.writeFileSync(intentPath, getMinimalTemplate("intent"));
  }

  const scopePath = path.join(profileDir, "scope.yml");
  if (!fs.existsSync(scopePath)) {
    fs.writeFileSync(scopePath, getMinimalTemplate("scope"));
  }

  const depsPath = path.join(profileDir, "deps.yml");
  if (!fs.existsSync(depsPath)) {
    fs.writeFileSync(depsPath, getMinimalTemplate("deps"));
  }

  const gatesPath = path.join(profileDir, "gates.yml");
  if (!fs.existsSync(gatesPath)) {
    fs.writeFileSync(gatesPath, getMinimalTemplate("gates"));
  }
}

/**
 * Get minimal template content for configuration files
 */
function getMinimalTemplate(type: string): string {
  switch (type) {
    case "intent":
      return `# Project Intent

## Goals
- Define project objectives and scope
- Establish quality gates and merge criteria
- Automate PR integration workflow

## Success Criteria
- All PRs pass quality gates
- Dependencies are properly managed
- Merge operations are automated and reliable

## Notes
- Update this file to reflect your specific project needs
- Use this to guide PR selection and integration priorities
`;

    case "scope":
      return `version: 1
target: main
sources:
  - query: "is:pr is:open"
selectors:
  include_labels: []
  exclude_labels:
    - "do-not-merge"
    - "work-in-progress"
defaults:
  strategy: merge-weave
  base: main
pin_commits: false
`;

    case "deps":
      return `version: 1
target: main
items: []
# Example item:
# - id: feature-a
#   branch: feature/a
#   deps: []
#   strategy: merge-weave
`;

    case "gates":
      return `version: 1
gates:
  - name: typecheck
    run: npm run typecheck
    runtime: local
  - name: test
    run: npm test
    runtime: local
# Example advanced gate:
# - name: integration-test
#   run: npm run test:integration
#   runtime: container
#   container:
#     image: node:20
#   artifacts:
#     - test-results.xml
`;

    default:
      return `# Configuration file
# Please update with appropriate content
`;
  }
}

/**
 * Detect project type and suggest appropriate templates
 */
export function detectProjectType(baseDir: string = "."): string {
  // Check for Node.js project
  if (fs.existsSync(path.join(baseDir, "package.json"))) {
    return "nodejs";
  }

  // Check for Python project
  if (
    fs.existsSync(path.join(baseDir, "pyproject.toml")) ||
    fs.existsSync(path.join(baseDir, "requirements.txt")) ||
    fs.existsSync(path.join(baseDir, "setup.py"))
  ) {
    return "python";
  }

  // Check for Rust project
  if (fs.existsSync(path.join(baseDir, "Cargo.toml"))) {
    return "rust";
  }

  // Check for Go project
  if (fs.existsSync(path.join(baseDir, "go.mod"))) {
    return "go";
  }

  return "generic";
}

/**
 * Get environment-specific configuration suggestions
 */
export function getEnvironmentSuggestions(): string[] {
  const suggestions: string[] = [];

  // Check for CI environment
  if (process.env.CI) {
    suggestions.push("Running in CI environment - consider CI-specific gate configurations");
  }

  // Check for GitHub Actions
  if (process.env.GITHUB_ACTIONS) {
    suggestions.push("GitHub Actions detected - can use 'ci-service' runtime for gates");
  }

  // Docker availability is checked asynchronously on module load and cached in
  // `dockerAvailable`. If the value is true, emit a suggestion. If it's false
  // or unknown (null) we don't block the event loop by running a sync check
  // here. The async check is started once when the module is imported.
  if (dockerAvailable === true) {
    suggestions.push("Docker available - can use 'container' runtime for isolated gate execution");
  }

  return suggestions;
}

export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootstrapError";
  }
}
