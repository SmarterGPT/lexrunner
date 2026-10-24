import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConfigurationQueryService,
  evaluateNodeRuntime,
  parseWorkspaceDoctorArgs,
  WorkspaceConfigServiceError,
  WorkspaceDoctorArgsJsonSchema,
  WorkspaceDiagnosticsService,
  WorkspaceInitializationService,
} from "../../src/application/workspace-config-services.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("workspace/config application services", () => {
  it("initializes the deterministic local overlay without an interactive adapter", () => {
    const root = fixtureRoot();
    fs.mkdirSync(path.join(root, ".smartergpt"), { recursive: true });
    fs.writeFileSync(path.join(root, ".smartergpt", "scope.yml"), "version: 1\ntarget: main\n");

    const first = new WorkspaceInitializationService().run({ baseDir: root });
    const replay = new WorkspaceInitializationService().run({ baseDir: root });

    expect(first).toMatchObject({
      contract: "bounded-ax-v1",
      created: true,
      config: { role: "development" },
      copiedFiles: ["scope.yml"],
    });
    expect(replay).toMatchObject({
      contract: "bounded-ax-v1",
      created: false,
      copiedFiles: [],
    });
  });

  it("returns a bounded retained-backup path after forced recreation", () => {
    const root = fixtureRoot();
    const service = new WorkspaceInitializationService();
    service.run({ baseDir: root });
    fs.writeFileSync(path.join(root, ".smartergpt.local", "marker.txt"), "preserve");

    const forced = service.run({ baseDir: root, force: true });

    expect(forced.backupPath).toContain(path.join("runner", "force-backups"));
    expect(fs.readFileSync(path.join(forced.backupPath!, "marker.txt"), "utf8")).toBe("preserve");
  });

  it("makes initialization immediately visible to doctor and config queries", async () => {
    const root = fixtureRoot();
    const tracked = path.join(root, ".smartergpt");
    fs.mkdirSync(tracked);
    fs.writeFileSync(path.join(tracked, "intent.md"), "# Intent\n");
    fs.writeFileSync(path.join(tracked, "scope.yml"), "version: 1\ntarget: release\n");
    fs.writeFileSync(path.join(tracked, "deps.yml"), "version: 1\nitems: []\n");
    fs.writeFileSync(path.join(tracked, "gates.yml"), "version: 1\ngates: []\n");
    const initialized = new WorkspaceInitializationService().run({ baseDir: root });
    const doctor = await withoutProfileEnvironment(() =>
      new WorkspaceDiagnosticsService().run({ baseDir: root })
    );
    const shown = new ConfigurationQueryService().show({ baseDir: root, key: "scope.target" });

    expect(initialized.copiedFiles).toEqual(["intent.md", "scope.yml", "deps.yml", "gates.yml"]);
    expect(doctor).toMatchObject({
      configuration: {
        hasConfiguration: true,
        missingFiles: [],
        compatibilityFiles: [],
      },
    });
    expect(shown.configuration[0]).toMatchObject({
      value: "release",
      source: ".smartergpt.local/scope.yml",
    });
    expect(fs.readdirSync(path.join(root, ".smartergpt.local", "runner"))).toEqual([]);
  });

  it("reads runner compatibility config with exact root-migration remediation", async () => {
    const root = fixtureRoot();
    const profile = path.join(root, ".smartergpt.local");
    const runner = path.join(profile, "runner");
    fs.mkdirSync(runner, { recursive: true });
    fs.writeFileSync(path.join(profile, "profile.yml"), "role: development\n");
    fs.writeFileSync(path.join(runner, "intent.md"), "# Intent\n");
    fs.writeFileSync(path.join(runner, "scope.yml"), "version: 1\ntarget: compatibility\n");
    fs.writeFileSync(path.join(runner, "deps.yml"), "version: 1\nitems: []\n");
    fs.writeFileSync(path.join(runner, "gates.yml"), "version: 1\ngates: []\n");
    const doctor = await withoutProfileEnvironment(() =>
      new WorkspaceDiagnosticsService().run({ baseDir: root })
    );
    const shown = new ConfigurationQueryService().show({ baseDir: root, key: "scope.target" });

    expect(doctor).toMatchObject({
      configuration: {
        hasConfiguration: true,
        missingFiles: [],
        compatibilityFiles: ["intent.md", "scope.yml", "deps.yml", "gates.yml"],
      },
    });
    for (const file of ["intent.md", "scope.yml", "deps.yml", "gates.yml"]) {
      expect(doctor.suggestions).toContain(
        `Move compatibility configuration ${path.join(runner, file)} to ${path.join(profile, file)}`
      );
    }
    expect(shown.configuration[0]).toMatchObject({
      value: "compatibility",
      source: ".smartergpt.local/runner/scope.yml",
    });
  });

  it("fills a partial local overlay file-by-file from the tracked workspace", async () => {
    const root = fixtureRoot();
    const workspace = path.join(root, ".smartergpt");
    const local = path.join(root, ".smartergpt.local");
    fs.mkdirSync(workspace);
    fs.mkdirSync(local);
    fs.writeFileSync(path.join(workspace, "intent.md"), "# Workspace intent\n");
    fs.writeFileSync(path.join(workspace, "scope.yml"), "version: 1\ntarget: workspace\n");
    fs.writeFileSync(path.join(workspace, "deps.yml"), "version: 1\nitems: []\n");
    fs.writeFileSync(path.join(workspace, "gates.yml"), "version: 1\ngates: []\n");
    fs.writeFileSync(path.join(local, "profile.yml"), "role: development\n");
    fs.writeFileSync(path.join(local, "intent.md"), "# Local intent\n");

    const doctor = await withoutProfileEnvironment(() =>
      new WorkspaceDiagnosticsService().run({ baseDir: root })
    );
    const shown = new ConfigurationQueryService().show({ baseDir: root, key: "scope.target" });

    expect(doctor.configuration).toMatchObject({
      profileDir: local,
      hasConfiguration: true,
      missingFiles: [],
      compatibilityFiles: [],
    });
    expect(shown.configuration[0]).toMatchObject({
      value: "workspace",
      source: ".smartergpt/scope.yml",
    });
  });

  it("makes missing required configuration an unhealthy doctor result", async () => {
    const root = fixtureRoot();
    fs.mkdirSync(path.join(root, ".smartergpt"));
    fs.writeFileSync(path.join(root, ".smartergpt", "profile.yml"), "role: development\n");
    const doctor = await withoutProfileEnvironment(() =>
      new WorkspaceDiagnosticsService().run({ baseDir: root })
    );
    expect(doctor.hasErrors).toBe(true);
    expect(doctor.issues.join(" ")).toContain("intent.md");
    expect(doctor.suggestions).toContain(
      `Create ${path.join(root, ".smartergpt", "scope.yml")} to define PR discovery rules`
    );
  });

  it("uses shell-neutral initialization remediation when no profile exists", async () => {
    const root = fixtureRoot();

    const doctor = await withoutProfileEnvironment(() =>
      new WorkspaceDiagnosticsService().run({ baseDir: root })
    );

    expect(doctor.hasErrors).toBe(true);
    expect(doctor.suggestions).toContain(
      `Initialize the local profile at ${path.join(root, ".smartergpt.local")}`
    );
    expect(doctor.suggestions.join(" ")).not.toContain("mkdir ");
    for (const file of ["intent.md", "scope.yml", "deps.yml", "gates.yml"]) {
      expect(
        doctor.suggestions.some((suggestion) =>
          suggestion.includes(path.join(root, ".smartergpt.local", file))
        )
      ).toBe(true);
      expect(doctor.suggestions.join(" ")).not.toContain(path.join(root, ".smartergpt", file));
    }
  });

  it("resolves bounded precedence once and redacts sensitive values", () => {
    const root = fixtureRoot();
    fs.mkdirSync(path.join(root, ".smartergpt"), { recursive: true });
    fs.mkdirSync(path.join(root, ".smartergpt.local"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".smartergpt", "scope.yml"),
      "version: 1\ntarget: main\ncredentials:\n  token: tracked-secret\n"
    );
    fs.writeFileSync(
      path.join(root, ".smartergpt.local", "scope.yml"),
      "version: 1\ntarget: release\ncredentials:\n  token: local-secret\n"
    );
    fs.writeFileSync(
      path.join(root, ".smartergpt.local", "profile.yml"),
      "role: development\nname: Local\nversion: 1\n"
    );

    const service = new ConfigurationQueryService();
    const result = service.show({ baseDir: root });
    const target = result.configuration.find(({ key }) => key === "scope.target");
    const token = result.configuration.find(({ key }) => key === "scope.credentials.token");

    expect(result.contract).toBe("bounded-ax-v1");
    expect(target).toMatchObject({
      value: "release",
      source: ".smartergpt.local/scope.yml",
      overrides: { value: "main", source: ".smartergpt/scope.yml" },
    });
    expect(token).toMatchObject({ value: "[REDACTED]", overrides: { value: "[REDACTED]" } });
    expect(JSON.stringify(result)).not.toContain("tracked-secret");
    expect(JSON.stringify(result)).not.toContain("local-secret");
    expect(service.resolveProfile({ baseDir: root })).toMatchObject({
      contract: "bounded-ax-v1",
      source: ".smartergpt.local/",
      manifest: { role: "development", name: "Local", version: "1" },
    });
  });

  it("uses stable errors for missing and unbounded configuration queries", () => {
    const root = fixtureRoot();
    const profile = path.join(root, ".smartergpt");
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, "scope.yml"), "version: 1\ntarget: main\n");
    const service = new ConfigurationQueryService();

    expect(() => service.show({ baseDir: root, key: "missing" })).toThrowError(
      expect.objectContaining<Partial<WorkspaceConfigServiceError>>({
        code: "CONFIG_KEY_NOT_FOUND",
      })
    );

    const values = Array.from({ length: 260 }, (_, index) => `  key_${index}: value`).join("\n");
    fs.writeFileSync(path.join(profile, "stack.yml"), `values:\n${values}\n`);
    expect(() => service.show({ baseDir: root })).toThrowError(
      expect.objectContaining<Partial<WorkspaceConfigServiceError>>({
        code: "CONFIG_RESULT_LIMIT_EXCEEDED",
      })
    );
  });

  it("accepts a matching major-only Node pin in bounded diagnostics", async () => {
    const root = fixtureRoot();
    fs.mkdirSync(path.join(root, ".smartergpt"));
    fs.writeFileSync(path.join(root, ".smartergpt", "profile.yml"), "role: development\n");
    fs.writeFileSync(path.join(root, ".nvmrc"), `${process.versions.node.split(".")[0]}\n`);
    const result = await withoutProfileEnvironment(() =>
      new WorkspaceDiagnosticsService().run({ baseDir: root })
    );

    expect(result).toMatchObject({
      contract: "bounded-ax-v1",
      diagnosticBase: path.resolve(root),
      configuration: { profileDir: path.join(root, ".smartergpt") },
      nodejs: { status: "ok", current: process.version, required: ">=24" },
    });
  });

  it("publishes and enforces one bounded strict doctor argument contract", () => {
    expect(WorkspaceDoctorArgsJsonSchema).toMatchObject({
      type: "object",
      properties: {
        environmentQuality: { type: "boolean", default: false },
      },
      additionalProperties: false,
    });
    expect(WorkspaceDoctorArgsJsonSchema).not.toHaveProperty("required");
    expect(parseWorkspaceDoctorArgs(undefined)).toEqual({ environmentQuality: false });
    expect(parseWorkspaceDoctorArgs({})).toEqual({ environmentQuality: false });
    expect(parseWorkspaceDoctorArgs({ environmentQuality: true })).toEqual({
      environmentQuality: true,
    });

    for (const invalid of [
      { repoRoot: "ignored" },
      { environmentQuality: "true" },
      JSON.parse('{"__proto__":"never-print-this"}'),
      null,
    ]) {
      expect(() => parseWorkspaceDoctorArgs(invalid)).toThrowError(
        expect.objectContaining<Partial<WorkspaceConfigServiceError>>({
          code: "WORKSPACE_DIAGNOSTICS_ARGUMENTS_INVALID",
        })
      );
    }

    const hostileName = "\0".repeat(10_000);
    let error: unknown;
    try {
      parseWorkspaceDoctorArgs({ [hostileName]: "never-print-this" });
    } catch (problem) {
      error = problem;
    }
    expect(error).toMatchObject({ code: "WORKSPACE_DIAGNOSTICS_ARGUMENTS_INVALID" });
    expect(Buffer.byteLength((error as Error).message, "utf8")).toBeLessThan(1024);
    expect((error as Error).message).not.toContain("never-print-this");
  });

  it("interprets major-only pins while enforcing and reporting the package floor", () => {
    expect(evaluateNodeRuntime("v24.18.0", "24")).toEqual({
      status: "ok",
      current: "v24.18.0",
      required: ">=24",
      expected: "v24",
    });
    expect(evaluateNodeRuntime("v22.22.1", "22")).toEqual({
      status: "mismatch",
      current: "v22.22.1",
      required: ">=24",
      expected: "v22",
    });
  });
});

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lexrunner-workspace-service-"));
  roots.push(root);
  return root;
}

async function withoutProfileEnvironment<T>(operation: () => Promise<T>): Promise<T> {
  const previousPrimary = process.env.LEX_PR_PROFILE_DIR;
  const previousAlias = process.env.LEXRUNNER_PROFILE_DIR;
  delete process.env.LEX_PR_PROFILE_DIR;
  delete process.env.LEXRUNNER_PROFILE_DIR;
  try {
    return await operation();
  } finally {
    if (previousPrimary === undefined) delete process.env.LEX_PR_PROFILE_DIR;
    else process.env.LEX_PR_PROFILE_DIR = previousPrimary;
    if (previousAlias === undefined) delete process.env.LEXRUNNER_PROFILE_DIR;
    else process.env.LEXRUNNER_PROFILE_DIR = previousAlias;
  }
}
