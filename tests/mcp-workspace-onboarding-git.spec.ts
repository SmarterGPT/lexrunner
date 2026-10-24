import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeFixtureRoot(root)));
});

describe("published MCP Git-backed workspace onboarding", () => {
  it("completes init through diagnostic-backed guidance, plan creation, and status", async () => {
    const root = fixtureRoot();
    await prepareCleanOnboardingRepository(root);
    const planFile = path.join(root, ".smartergpt.local", "runner", "plan.json");

    const responses = await withoutProfileEnvironment(() =>
      invokeMany(root, [
        toolRequest(40, "local.init", {}),
        toolRequest(41, "doctor", {}),
        toolRequest(42, "config.show", { key: "scope.target" }),
        toolRequest(43, "workflow.guide", { phase: "initial" }),
        toolRequest(44, "plan.create", {}),
        toolRequest(45, "status", { planFile }),
      ])
    );

    for (const response of responses) expect(response.error).toBeUndefined();
    const [initialized, doctor, config, guide, created, status] = responses.map((response) =>
      JSON.parse(response.result.content[0].text)
    );

    expect(initialized).toMatchObject({
      contract: "bounded-ax-v1",
      created: true,
      copiedFiles: ["intent.md", "scope.yml", "deps.yml", "gates.yml", "stack.yml"],
    });
    expect(doctor).toMatchObject({
      hasErrors: false,
      git: { status: "ok", isClean: true, currentBranch: "main" },
      configuration: {
        hasConfiguration: true,
        missingFiles: [],
        compatibilityFiles: [],
      },
    });
    expect(config).toMatchObject({
      contract: "bounded-ax-v1",
      key: "scope.target",
      value: "main",
      source: ".smartergpt.local/scope.yml",
    });
    expect(guide).toMatchObject({
      authority: "advisory",
      authorizesExecution: false,
      authorizesMerge: false,
      canProceed: true,
      readiness: { source: "doctor", hasErrors: false, missingFiles: [] },
    });
    expect(created).toMatchObject({
      contract: "bounded-ax-v1",
      plan: { schemaVersion: "1.0.0", target: "main", items: [{ name: "feature/example" }] },
      files: { plan: planFile },
    });
    expect(status).toMatchObject({
      contract: "bounded-ax-v1",
      plan: { schemaVersion: "1.0.0", target: "main", itemCount: 1 },
      planArtifact: { kind: "execution-plan", itemCount: 1 },
    });
  }, 15_000);

  it("makes a genuinely blank repository doctor-ready before creating an empty plan", async () => {
    const root = fixtureRoot();
    await prepareBlankOnboardingRepository(root);
    const planFile = path.join(root, ".smartergpt.local", "runner", "plan.json");

    const responses = await withoutProfileEnvironment(() =>
      invokeMany(root, [
        toolRequest(49, "local.init", {}),
        toolRequest(50, "doctor", {}),
        toolRequest(51, "config.show", { key: "scope.target" }),
        toolRequest(52, "workflow.guide", { phase: "initial" }),
        toolRequest(53, "plan.create", {}),
        toolRequest(54, "status", { planFile }),
      ])
    );

    for (const response of responses) expect(response.error).toBeUndefined();
    const [initialized, doctor, config, guide, created, status] = responses.map((response) =>
      JSON.parse(response.result.content[0].text)
    );

    expect(initialized).toMatchObject({
      contract: "bounded-ax-v1",
      created: true,
      copiedFiles: [],
    });
    for (const file of ["profile.yml", "intent.md", "scope.yml", "deps.yml", "gates.yml"]) {
      expect(fs.existsSync(path.join(root, ".smartergpt.local", file))).toBe(true);
    }
    expect(doctor).toMatchObject({
      hasErrors: false,
      git: { status: "ok", isClean: true, currentBranch: "main" },
      configuration: {
        hasConfiguration: true,
        missingFiles: [],
        compatibilityFiles: [],
      },
    });
    expect(config).toMatchObject({
      contract: "bounded-ax-v1",
      key: "scope.target",
      value: "main",
      source: ".smartergpt.local/scope.yml",
    });
    expect(guide).toMatchObject({
      authority: "advisory",
      authorizesExecution: false,
      authorizesMerge: false,
      canProceed: true,
      readiness: { source: "doctor", hasErrors: false, missingFiles: [] },
    });
    expect(created).toMatchObject({
      contract: "bounded-ax-v1",
      plan: { schemaVersion: "1.0.0", target: "main", items: [] },
      files: { plan: planFile },
    });
    expect(status).toMatchObject({
      contract: "bounded-ax-v1",
      plan: { schemaVersion: "1.0.0", target: "main", itemCount: 0 },
      planArtifact: { kind: "execution-plan", itemCount: 0 },
    });
  }, 15_000);

  it("keeps published workflow readiness aligned with doctor's exact remediation", async () => {
    const root = fixtureRoot();
    await prepareCleanOnboardingRepository(root);
    fs.rmSync(path.join(root, ".smartergpt", "gates.yml"));

    const [doctorResponse, guideResponse, laterGuideResponse] = await withoutProfileEnvironment(
      () =>
        invokeMany(root, [
          toolRequest(46, "doctor", {}),
          toolRequest(47, "workflow.guide", { phase: "initial" }),
          toolRequest(48, "workflow.guide", { phase: "post-plan-creation" }),
        ])
    );
    const doctor = JSON.parse(doctorResponse.result.content[0].text);
    const guide = JSON.parse(guideResponse.result.content[0].text);
    const laterGuide = JSON.parse(laterGuideResponse.result.content[0].text);

    expect(doctor).toMatchObject({
      hasErrors: true,
      configuration: { hasConfiguration: false, missingFiles: ["gates.yml"] },
    });
    expect(guide).toMatchObject({
      authority: "advisory",
      authorizesExecution: false,
      authorizesMerge: false,
      canProceed: false,
      recommendedAction: "local.init",
      readiness: {
        source: "doctor",
        hasErrors: true,
        missingFiles: ["gates.yml"],
        suggestions: doctor.suggestions,
      },
    });
    expect(guide.commonIssues.at(-1)?.solution).toBe(doctor.suggestions.join("; "));
    expect(guide.commonIssues.at(-1)?.solution).toContain(
      path.join(root, ".smartergpt", "gates.yml")
    );
    expect(laterGuide).toMatchObject({
      authority: "advisory",
      authorizesExecution: false,
      authorizesMerge: false,
      phase: "post-plan-creation",
      canProceed: true,
      recommendedAction: "gates.run",
    });
    expect(laterGuide).not.toHaveProperty("readiness");
  });
});

interface JsonRpcResponse {
  result: any;
  error: any;
}

function toolRequest(id: number, name: string, args: Record<string, unknown>) {
  return {
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

async function invokeMany(
  cwd: string,
  requests: Array<{ id: number; method: string; params: Record<string, unknown> }>
): Promise<JsonRpcResponse[]> {
  const subprocess = execa("node", [path.join(repositoryRoot, "mcp-server.mjs")], {
    cwd,
    env: { ...process.env, ALLOW_MUTATIONS: "false" },
  });
  let stdout = "";
  const responses: JsonRpcResponse[] = [];
  const complete = new Promise<JsonRpcResponse[]>((resolve, reject) => {
    subprocess.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      let newline = stdout.indexOf("\n");
      while (newline >= 0) {
        responses.push(JSON.parse(stdout.slice(0, newline)) as JsonRpcResponse);
        stdout = stdout.slice(newline + 1);
        if (responses.length === requests.length) {
          resolve(responses);
        } else {
          subprocess.stdin?.write(
            `${JSON.stringify({ jsonrpc: "2.0", ...requests[responses.length] })}\n`
          );
        }
        newline = stdout.indexOf("\n");
      }
    });
    subprocess.once("error", reject);
    subprocess.once("exit", (code) => {
      if (responses.length !== requests.length) {
        reject(
          new Error(
            `MCP server exited ${code ?? "without a code"} after ${responses.length}/${requests.length} responses`
          )
        );
      }
    });
  });
  subprocess.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", ...requests[0] })}\n`);
  const result = await complete;
  subprocess.stdin?.end();
  await subprocess;
  return result;
}

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lexrunner-onboarding-git-"));
  roots.push(root);
  return root;
}

async function removeFixtureRoot(root: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.promises.rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 30 || (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY")) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function prepareCleanOnboardingRepository(root: string): Promise<void> {
  const profile = path.join(root, ".smartergpt");
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, "profile.yml"), "role: development\n");
  fs.writeFileSync(path.join(profile, "intent.md"), "# Onboarding fixture\n");
  fs.writeFileSync(path.join(profile, "scope.yml"), "version: 1\ntarget: main\n");
  fs.writeFileSync(path.join(profile, "deps.yml"), "version: 1\nitems: []\n");
  fs.writeFileSync(path.join(profile, "gates.yml"), "version: 1\ngates: []\n");
  fs.writeFileSync(
    path.join(profile, "stack.yml"),
    [
      "version: 1",
      "target: main",
      "items:",
      "  - name: feature/example",
      "    branch: feature/example",
      "    deps: []",
      "    strategy: merge-weave",
      "    gates:",
      "      - name: unit",
      '        run: node -e "process.exit(0)"',
      "",
    ].join("\n")
  );
  fs.writeFileSync(path.join(root, ".nvmrc"), `${process.versions.node.split(".")[0]}\n`);
  fs.writeFileSync(path.join(root, ".gitignore"), ".smartergpt.local/\n");

  await initializeGitRepository(root);
}

async function prepareBlankOnboardingRepository(root: string): Promise<void> {
  fs.writeFileSync(path.join(root, ".nvmrc"), `${process.versions.node.split(".")[0]}\n`);
  fs.writeFileSync(path.join(root, ".gitignore"), ".smartergpt.local/\n");
  await initializeGitRepository(root);
}

async function initializeGitRepository(root: string): Promise<void> {
  await execa("git", ["init", "--quiet", "-b", "main"], { cwd: root });
  await execa("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  await execa("git", ["add", "."], { cwd: root });
  await execa(
    "git",
    [
      "-c",
      "user.name=LexRunner Test",
      "-c",
      "user.email=lexrunner@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Create onboarding fixture",
    ],
    { cwd: root }
  );
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
