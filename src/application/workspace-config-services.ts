import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import { z } from "zod";

import {
  bootstrapWorkspace,
  detectProjectType,
  getEnvironmentSuggestions,
} from "../core/bootstrap.js";
import { initLocalOverlay, type LocalOverlayResult } from "../config/localOverlay.js";
import { resolveConfigPath } from "../config/pathResolver.js";
import { resolveProfile, type ResolvedProfile } from "../config/profileResolver.js";
import { createGitHubAPI } from "../github/api.js";
import { createGitOperations } from "../git/operations.js";
import { runEnvironmentQualityCheck } from "../hostility/index.js";
import { NODE_ENGINE_RANGE, NODE_RUNTIME_MAJOR } from "../runtime-contract.js";
import { getEnvWithAlias } from "../util/envUtils.js";

const MAX_CONFIG_VALUES = 256;
const MAX_LABEL_BYTES = 512;
const MAX_PATH_BYTES = 4096;
const MAX_RESULT_BYTES = 256 * 1024;
const SENSITIVE_KEY = /(token|secret|password|credential|private[_-]?key|auth)/i;

export type WorkspaceConfigFailureCode =
  | "WORKSPACE_INIT_FAILED"
  | "WORKSPACE_DIAGNOSTICS_FAILED"
  | "WORKSPACE_DIAGNOSTICS_ARGUMENTS_INVALID"
  | "CONFIG_KEY_NOT_FOUND"
  | "CONFIG_RESULT_LIMIT_EXCEEDED"
  | "PROFILE_RESOLUTION_FAILED";

export class WorkspaceConfigServiceError extends Error {
  constructor(
    readonly code: WorkspaceConfigFailureCode,
    message: string
  ) {
    super(message);
    this.name = "WorkspaceConfigServiceError";
  }
}

interface ConfigSourceLevel {
  level: string;
  path?: string;
  checked: boolean;
  found: boolean;
  overridden?: boolean;
}

export interface BoundedConfigValue {
  key: string;
  value: unknown;
  source: string;
  overrides?: { source: string; value: unknown };
  precedence: ConfigSourceLevel[];
}

export interface BoundedConfigResult {
  contract: "bounded-ax-v1";
  precedenceChain: Array<{ level: string; source?: string; path?: string }>;
  configuration: BoundedConfigValue[];
}

export interface BoundedWorkspaceInitResult extends LocalOverlayResult {
  contract: "bounded-ax-v1";
}

export interface BoundedProfileResult {
  contract: "bounded-ax-v1";
  path: string;
  source: string;
  manifest: ResolvedProfile["manifest"];
}

export interface BoundedDoctorResult {
  contract: "bounded-ax-v1";
  diagnosticBase: string;
  hasErrors: boolean;
  issues: string[];
  suggestions: string[];
  nodejs: {
    status: "ok" | "mismatch" | "no_constraint";
    current: string;
    required: string;
    expected?: string;
  };
  configuration: ReturnType<typeof bootstrapWorkspace>;
  projectType: string;
  environmentSuggestions: string[];
  github?: { detected: boolean; authenticated?: boolean; user?: string; error?: string };
  git?: { status: "ok" | "error"; isClean?: boolean; currentBranch?: string; error?: string };
  environmentQuality?: ReturnType<typeof runEnvironmentQualityCheck>;
}

export const WorkspaceDoctorArgsSchema = z.strictObject({
  environmentQuality: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include environmental hostility scoring in the check"),
});
export type WorkspaceDoctorArgs = z.input<typeof WorkspaceDoctorArgsSchema>;
export type ParsedWorkspaceDoctorArgs = z.output<typeof WorkspaceDoctorArgsSchema>;
export const WorkspaceDoctorArgsJsonSchema = z.toJSONSchema(WorkspaceDoctorArgsSchema, {
  io: "input",
});

export function parseWorkspaceDoctorArgs(value: unknown): ParsedWorkspaceDoctorArgs {
  const normalized = value === undefined ? {} : value;
  const unsupported =
    normalized !== null && typeof normalized === "object" && !Array.isArray(normalized)
      ? Object.keys(normalized)
          .filter((key) => key !== "environmentQuality")
          .sort()
      : [];
  if (unsupported.length) {
    throw new WorkspaceConfigServiceError(
      "WORKSPACE_DIAGNOSTICS_ARGUMENTS_INVALID",
      `doctor accepts only optional boolean environmentQuality; unsupported properties: ${boundedArgumentNames(unsupported)}`
    );
  }

  const parsed = WorkspaceDoctorArgsSchema.safeParse(normalized);
  if (parsed.success) return parsed.data;

  throw new WorkspaceConfigServiceError(
    "WORKSPACE_DIAGNOSTICS_ARGUMENTS_INVALID",
    "doctor accepts only optional boolean environmentQuality"
  );
}

/** Transport-neutral owner for deterministic workspace initialization. */
export class WorkspaceInitializationService {
  run(input: { baseDir: string; force?: boolean }): BoundedWorkspaceInitResult {
    try {
      const result = initLocalOverlay(input.baseDir, input.force ?? false);
      return boundedResult({
        contract: "bounded-ax-v1",
        ...result,
        path: bounded(result.path, MAX_PATH_BYTES),
        copiedFiles: boundedStrings(result.copiedFiles),
      });
    } catch {
      throw new WorkspaceConfigServiceError(
        "WORKSPACE_INIT_FAILED",
        "Workspace initialization failed; inspect the selected local profile path"
      );
    }
  }
}

/** Transport-neutral owner for workspace and environment diagnostics. */
export class WorkspaceDiagnosticsService {
  async run(input: {
    baseDir: string;
    environmentQuality?: boolean;
  }): Promise<BoundedDoctorResult> {
    const diagnosticBase = path.resolve(input.baseDir);
    const issues: string[] = [];
    const suggestions: string[] = [];
    let hasErrors = false;
    let nodejs: BoundedDoctorResult["nodejs"];
    let expectedPin: string | undefined;
    try {
      expectedPin = fs.readFileSync(path.join(diagnosticBase, ".nvmrc"), "utf8").trim();
    } catch {
      suggestions.push("Consider adding .nvmrc for Node.js version consistency");
    }
    nodejs = evaluateNodeRuntime(process.version, expectedPin);
    if (nodejs.status === "mismatch") {
      hasErrors = true;
      const pinDetail = nodejs.expected ? ` and workspace pin ${nodejs.expected}` : "";
      issues.push(
        `Node.js version ${process.version} does not satisfy package floor ${nodejs.required}${pinDetail}`
      );
    }

    const configuration = bootstrapWorkspace(diagnosticBase);
    if (!configuration.hasConfiguration) {
      hasErrors = true;
      issues.push(
        `Configuration is missing required profile-root files: ${configuration.missingFiles.join(", ")}`
      );
      suggestions.push(...configuration.suggestions);
    } else if (configuration.compatibilityFiles.length) {
      suggestions.push(...configuration.suggestions);
    }
    let github: BoundedDoctorResult["github"];
    try {
      const api = await createGitHubAPI(diagnosticBase);
      if (api) {
        const auth = await api.checkAuth();
        github = {
          detected: true,
          authenticated: auth.authenticated,
          ...(auth.user ? { user: bounded(auth.user, MAX_LABEL_BYTES) } : {}),
        };
      } else {
        github = { detected: false };
      }
    } catch (error) {
      github = { detected: false, error: boundedError(error) };
    }

    let git: BoundedDoctorResult["git"];
    try {
      const operations = createGitOperations(diagnosticBase);
      git = {
        status: "ok",
        isClean: await operations.isClean(),
        currentBranch: bounded(await operations.getCurrentBranch(), MAX_LABEL_BYTES),
      };
    } catch (error) {
      const message = boundedError(error);
      git = { status: "error", error: message };
      hasErrors = true;
      issues.push(`Git operations failed: ${message}`);
    }

    return boundedResult({
      contract: "bounded-ax-v1",
      diagnosticBase: bounded(diagnosticBase, MAX_PATH_BYTES),
      hasErrors,
      issues: boundedStrings(issues),
      suggestions: boundedStrings(suggestions),
      nodejs,
      configuration,
      projectType: bounded(detectProjectType(diagnosticBase), MAX_LABEL_BYTES),
      environmentSuggestions: boundedStrings(getEnvironmentSuggestions()),
      github,
      git,
      ...(input.environmentQuality
        ? {
            environmentQuality: runEnvironmentQualityCheck({
              cwd: diagnosticBase,
              profileDir: configuration.profileDir,
            }),
          }
        : {}),
    });
  }
}

export function evaluateNodeRuntime(
  currentVersion: string,
  expectedPin?: string
): BoundedDoctorResult["nodejs"] {
  const current = currentVersion.replace(/^v/, "");
  const currentMajor = Number.parseInt(current.split(".")[0] ?? "", 10);
  const normalizedPin = expectedPin?.trim().replace(/^v/, "");
  const floorMatches = Number.isInteger(currentMajor) && currentMajor >= NODE_RUNTIME_MAJOR;
  const pinMatches = normalizedPin
    ? normalizedPin.includes(".")
      ? current === normalizedPin
      : String(currentMajor) === normalizedPin
    : true;

  return {
    status:
      !normalizedPin && floorMatches
        ? "no_constraint"
        : floorMatches && pinMatches
          ? "ok"
          : "mismatch",
    current: currentVersion.startsWith("v") ? currentVersion : `v${currentVersion}`,
    required: NODE_ENGINE_RANGE,
    ...(normalizedPin ? { expected: `v${normalizedPin}` } : {}),
  };
}

/** Transport-neutral owner for configuration and profile queries. */
export class ConfigurationQueryService {
  show(input: { baseDir: string; key?: string }): BoundedConfigResult {
    const result = resolveConfig(input.baseDir);
    if (!input.key) return boundedResult(result);
    const selected = result.configuration.find(({ key }) => key === input.key);
    if (!selected) {
      throw new WorkspaceConfigServiceError(
        "CONFIG_KEY_NOT_FOUND",
        `Configuration key not found: ${bounded(input.key, MAX_LABEL_BYTES)}`
      );
    }
    return boundedResult({ ...result, configuration: [selected] });
  }

  resolveProfile(input: { baseDir: string; profileDir?: string }): BoundedProfileResult {
    try {
      const resolved = resolveProfile(input.profileDir, input.baseDir);
      return boundedResult({
        contract: "bounded-ax-v1",
        path: bounded(resolved.path, MAX_PATH_BYTES),
        source: bounded(resolved.source, MAX_LABEL_BYTES),
        manifest: {
          role: bounded(resolved.manifest.role, MAX_LABEL_BYTES),
          ...(resolved.manifest.name
            ? { name: bounded(resolved.manifest.name, MAX_LABEL_BYTES) }
            : {}),
          ...(resolved.manifest.version
            ? { version: bounded(String(resolved.manifest.version), MAX_LABEL_BYTES) }
            : {}),
        },
      });
    } catch {
      throw new WorkspaceConfigServiceError(
        "PROFILE_RESOLUTION_FAILED",
        "Profile resolution failed; inspect the configured profile manifest"
      );
    }
  }
}

function resolveConfig(baseDir: string): BoundedConfigResult {
  const envProfileDir = getEnvWithAlias("LEX_PR_PROFILE_DIR", "LEXRUNNER_PROFILE_DIR");
  const localProfileDir = path.resolve(baseDir, ".smartergpt.local");
  const workspaceProfileDir = path.resolve(baseDir, ".smartergpt");
  const precedenceChain: BoundedConfigResult["precedenceChain"] = [];
  if (envProfileDir) {
    precedenceChain.push({
      level: "env",
      source: "LEX_PR_PROFILE_DIR",
      path: bounded(path.resolve(baseDir, envProfileDir), MAX_PATH_BYTES),
    });
  }
  if (fs.existsSync(localProfileDir)) {
    precedenceChain.push({ level: "local", source: ".smartergpt.local/", path: localProfileDir });
  }
  precedenceChain.push({
    level: "workspace",
    source: ".smartergpt/",
    path: workspaceProfileDir,
  });
  precedenceChain.push({ level: "defaults", source: "built-in defaults" });

  const values = new Map<string, BoundedConfigValue>();
  const defaults = {
    target: "main",
    version: 1,
    "defaults.strategy": "merge-weave",
    "defaults.base": "main",
    pin_commits: false,
  };
  for (const [key, value] of Object.entries(defaults)) {
    values.set(key, { key, value, source: "built-in defaults", precedence: [] });
  }

  const directories = [
    { level: "workspace", path: workspaceProfileDir, source: ".smartergpt/" },
    { level: "local", path: localProfileDir, source: ".smartergpt.local/" },
    ...(envProfileDir
      ? [
          {
            level: "env",
            path: path.resolve(baseDir, envProfileDir),
            source: "LEX_PR_PROFILE_DIR/",
          },
        ]
      : []),
  ].filter(({ path: profilePath }) => fs.existsSync(profilePath));
  const files = ["scope.yml", "stack.yml", "deps.yml", "gates.yml", "merge-policy.yml"];
  for (const directory of directories) {
    for (const file of files) {
      // Each directory is already being traversed in explicit precedence
      // order; do not apply the local-to-workspace fallback a second time.
      const resolved = resolveConfigPath(directory.path, file, {
        allowWorkspaceFallback: false,
      });
      const parsed = resolved.exists ? loadConfig(resolved.path) : null;
      if (!parsed) continue;
      for (const [key, rawValue] of Object.entries(flatten(parsed, file.replace(".yml", "")))) {
        if (values.size >= MAX_CONFIG_VALUES && !values.has(key)) {
          throw new WorkspaceConfigServiceError(
            "CONFIG_RESULT_LIMIT_EXCEEDED",
            `Configuration exceeds the ${MAX_CONFIG_VALUES}-value result limit`
          );
        }
        const value = redactValue(key, rawValue);
        const previous = values.get(key);
        const source = `${directory.source}${
          resolved.source === "runner/ (compatibility)" ? `runner/${file}` : file
        }`;
        values.set(key, {
          key: bounded(key, MAX_LABEL_BYTES),
          value,
          source: bounded(source, MAX_PATH_BYTES),
          ...(previous
            ? { overrides: { source: previous.source, value: redactValue(key, previous.value) } }
            : {}),
          precedence: [],
        });
      }
    }
  }

  for (const value of values.values()) {
    value.precedence = [
      {
        level: "env",
        checked: true,
        found: value.source.startsWith("LEX_PR_PROFILE_DIR/"),
        ...(envProfileDir
          ? { path: bounded(path.resolve(baseDir, envProfileDir), MAX_PATH_BYTES) }
          : {}),
      },
      ...directories
        .filter(({ level }) => level !== "env")
        .map((directory) => ({
          level: directory.level,
          path: bounded(directory.path, MAX_PATH_BYTES),
          checked: true,
          found: value.source.startsWith(directory.source),
          overridden: value.overrides?.source.startsWith(directory.source) ?? false,
        })),
    ];
  }
  return {
    contract: "bounded-ax-v1",
    precedenceChain,
    configuration: [...values.values()].sort((a, b) => a.key.localeCompare(b.key)),
  };
}

function loadConfig(file: string): Record<string, unknown> | null {
  try {
    const value = YAML.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function flatten(value: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) {
      Object.assign(result, flatten(child as Record<string, unknown>, fullKey));
    } else {
      result[fullKey] = child;
    }
  }
  return result;
}

function redactValue(key: string, value: unknown): unknown {
  return SENSITIVE_KEY.test(key) ? "[REDACTED]" : value;
}

function boundedStrings(values: string[]): string[] {
  if (values.length > MAX_CONFIG_VALUES) {
    throw new WorkspaceConfigServiceError(
      "CONFIG_RESULT_LIMIT_EXCEEDED",
      `Collection exceeds the ${MAX_CONFIG_VALUES}-entry result limit`
    );
  }
  return values.map((value) => bounded(value, MAX_PATH_BYTES));
}

function boundedArgumentNames(names: string[]): string {
  const displayed = names.slice(0, 16).map((name) => JSON.stringify(boundedPrefix(name, 128)));
  return boundedPrefix(
    `${displayed.join(", ")}${names.length > displayed.length ? `, … (+${names.length - displayed.length})` : ""}`,
    768
  );
}

function boundedPrefix(value: string, maxBytes: number): string {
  let output = "";
  for (const character of value) {
    if (Buffer.byteLength(output + character, "utf8") > maxBytes) return output + "…";
    output += character;
  }
  return output;
}

function bounded(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new WorkspaceConfigServiceError(
      "CONFIG_RESULT_LIMIT_EXCEEDED",
      "Workspace/config result contains an overlong label or path"
    );
  }
  return value;
}

function boundedError(error: unknown): string {
  return bounded(error instanceof Error ? error.message : String(error), MAX_LABEL_BYTES);
}

function boundedResult<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_RESULT_BYTES) {
    throw new WorkspaceConfigServiceError(
      "CONFIG_RESULT_LIMIT_EXCEEDED",
      `Workspace/config result exceeds ${MAX_RESULT_BYTES} bytes`
    );
  }
  return value;
}
