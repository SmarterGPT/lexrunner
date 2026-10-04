import { readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GateExecutionService } from "../src/application/gate-execution-service.js";
import { registerStatusCommand } from "../src/commands/status.js";
import { StatusArgs } from "../src/mcp/types.js";
import {
  candidateFixture,
  routingPlan,
  type CandidateFixture,
} from "./helpers/gate-candidate-fixture.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const fixtures: CandidateFixture[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

async function executedFixture() {
  const fixture = candidateFixture();
  fixtures.push(fixture);
  const plan = routingPlan();
  const planFile = join(fixture.a, "plan.json");
  writeFileSync(planFile, JSON.stringify(plan));
  const result = await new GateExecutionService().run({
    plan,
    repoRoot: fixture.a,
    artifactDir: fixture.artifacts,
    timeoutMs: 10_000,
    options: { emitReceipt: false, suppressStdout: true },
  });
  const reference = result.summary.artifactRefs.find(
    (entry) => entry.kind === "gate-evidence-manifest"
  );
  if (!reference) throw new Error("Expected actual gate evidence");
  expect(result.summary.allGreen).toBe(true);
  return { ...fixture, planFile, reference };
}

type ExecutedFixture = Awaited<ReturnType<typeof executedFixture>>;

async function connectedClient(
  fixture: ExecutedFixture,
  surface: "source" | "published",
  startup = fixture.startup
): Promise<Client> {
  const bootstrap = join(fixture.root, "status-source-server.mts");
  if (surface === "source") {
    writeFileSync(
      bootstrap,
      `import { createServer } from ${JSON.stringify(pathToFileURL(join(repositoryRoot, "src/mcp/server.ts")).href)};
import { InMemoryRunStore } from ${JSON.stringify(pathToFileURL(join(repositoryRoot, "src/store/inmemory/index.ts")).href)};
import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(join(repositoryRoot, "node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js")).href)};
const store = new InMemoryRunStore();
const server = createServer({ runStore: store });
await server.connect(new StdioServerTransport());
process.stdin.on('end', async () => { await server.close(); store.close(); });
`
    );
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args:
      surface === "source"
        ? [
            "--import",
            pathToFileURL(join(repositoryRoot, "node_modules/tsx/dist/loader.mjs")).href,
            bootstrap,
          ]
        : [join(repositoryRoot, "mcp-server.mjs")],
    cwd: startup,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined && !entry[0].toUpperCase().startsWith("GIT_")
        )
      ),
      ALLOW_MUTATIONS: "false",
      LEX_PR_PROFILE_DIR: join(fixture.root, "private-profile"),
    },
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk) => {
    diagnostics = (diagnostics + String(chunk)).slice(-32_768);
  });
  const client = new Client({ name: "status-routing-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await transport.close();
    throw new Error(`Status fixture connection failed: ${String(error)}\n${diagnostics}`);
  }
}

function evidenceArguments(fixture: ExecutedFixture) {
  return {
    planFile: fixture.planFile,
    evidenceFile: fixture.reference.path,
    evidenceSha256: fixture.reference.sha256,
  };
}

function assertUnverifiedStatus(result: unknown): void {
  expect(result).toMatchObject({
    evidence: { authority: "unverified", applied: 1, observations: { passed: ["selected/probe"] } },
    mergeSummary: { eligible: [], pending: ["selected"], failed: [] },
  });
}

describe("status candidate-root argument shape", () => {
  it("retains an explicit root and refuses invalid bounded roots", () => {
    expect(StatusArgs.parse({ repoRoot: "candidate" }).repoRoot).toBe("candidate");
    for (const repoRoot of [null, false, 3, {}, "", "x".repeat(4097)])
      expect(() => StatusArgs.parse({ repoRoot })).toThrow();
  });
});

describe.each(["source", "published"] as const)("%s MCP status candidate routing", (surface) => {
  const tool = surface === "source" ? "weave_status" : "status";

  it("recovers evidence from a non-Git startup and resolves explicit subdirectories to their physical repo root", async () => {
    const fixture = await executedFixture();
    const client = await connectedClient(fixture, surface);
    try {
      const inventory = await client.listTools();
      expect(
        inventory.tools.find(({ name }) => name === tool)?.inputSchema.properties
      ).toMatchObject({ repoRoot: { type: "string", minLength: 1, maxLength: 4096 } });
      const response = await client.callTool({
        name: tool,
        arguments: {
          repoRoot: join(fixture.a, "checks"),
          planFile: "plan.json",
          evidenceFile: relative(fixture.a, fixture.reference.path),
          evidenceSha256: fixture.reference.sha256,
        },
      });
      assertUnverifiedStatus(JSON.parse((response.content as Array<{ text: string }>)[0]!.text));
    } finally {
      await client.close();
    }
  }, 30_000);

  it("preserves the omitted-root default at a Git startup and keeps evidence-free status usable outside Git", async () => {
    const fixture = await executedFixture();
    const gitClient = await connectedClient(fixture, surface, fixture.a);
    try {
      const response = await gitClient.callTool({
        name: tool,
        arguments: evidenceArguments(fixture),
      });
      assertUnverifiedStatus(JSON.parse((response.content as Array<{ text: string }>)[0]!.text));
    } finally {
      await gitClient.close();
    }
    const startupClient = await connectedClient(fixture, surface);
    try {
      const response = await startupClient.callTool({
        name: tool,
        arguments: { planFile: fixture.planFile },
      });
      expect(JSON.parse((response.content as Array<{ text: string }>)[0]!.text)).toMatchObject({
        mergeSummary: { eligible: [], pending: ["selected"] },
      });
      await expect(
        startupClient.callTool({ name: tool, arguments: evidenceArguments(fixture) })
      ).rejects.toThrow("Gate candidate identity is unavailable");
    } finally {
      await startupClient.close();
    }
  }, 30_000);

  it("refuses invalid, different, stale and tampered evidence without granting merge authority", async () => {
    const fixture = await executedFixture();
    const client = await connectedClient(fixture, surface);
    const call = (overrides: Record<string, unknown> = {}) =>
      client.callTool({
        name: tool,
        arguments: { ...evidenceArguments(fixture), repoRoot: fixture.a, ...overrides },
      });
    try {
      for (const repoRoot of [null, false, 3, {}, "", "x".repeat(4097)])
        await expect(call({ repoRoot })).rejects.toThrow();
      await expect(call({ repoRoot: fixture.startup })).rejects.toThrow(
        "Gate repository root is unavailable"
      );
      await expect(call({ repoRoot: fixture.b })).rejects.toThrow("GATE_EVIDENCE_PLAN_MISMATCH");
      await expect(call({ evidenceSha256: `sha256:${"0".repeat(64)}` })).rejects.toThrow(
        "GATE_EVIDENCE_DIGEST_MISMATCH"
      );
      writeFileSync(join(fixture.a, "candidate.txt"), "changed candidate\n");
      await expect(call()).rejects.toThrow("GATE_EVIDENCE_PLAN_MISMATCH");
      writeFileSync(join(fixture.a, "candidate.txt"), "a");
      const bytes = readFileSync(fixture.reference.path, "utf8");
      writeFileSync(fixture.reference.path, bytes + "\n");
      await expect(call()).rejects.toThrow("GATE_EVIDENCE_DIGEST_MISMATCH");
    } finally {
      await client.close();
    }
  }, 30_000);
});

describe("status CLI explicit candidate routing", () => {
  function command() {
    const program = new Command().name("lexrunner").exitOverride();
    registerStatusCommand(program, () => false);
    return program;
  }

  it("advertises --repo-root in CLI help", () => {
    expect(command().commands[0]!.helpInformation()).toContain("--repo-root");
  });

  it("refuses empty and overlong roots instead of falling back to the actual process cwd", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const repoRoot of ["", "x".repeat(4097)]) {
      await expect(
        command().parseAsync(["node", "lexrunner", "status", "--repo-root", repoRoot, "--json"])
      ).rejects.toMatchObject({ exitCode: 1 });
      expect(diagnostic.mock.calls.at(-1)?.[0]).toContain("--repo-root is invalid");
    }
  });

  it("recovers exact evidence using relative paths from a non-Git default cwd", async () => {
    const fixture = await executedFixture();
    vi.spyOn(process, "cwd").mockReturnValue(fixture.startup);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    await command().parseAsync([
      "node",
      "lexrunner",
      "status",
      "--repo-root",
      join(fixture.a, "checks"),
      "--plan",
      "plan.json",
      "--evidence",
      relative(fixture.a, fixture.reference.path),
      "--evidence-sha256",
      fixture.reference.sha256,
      "--json",
    ]);
    assertUnverifiedStatus(JSON.parse(String(output.mock.calls[0]![0])));
  }, 30_000);

  it("preserves current-directory evidence recovery when no root is provided", async () => {
    const fixture = await executedFixture();
    vi.spyOn(process, "cwd").mockReturnValue(fixture.a);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    await command().parseAsync([
      "node",
      "lexrunner",
      "status",
      "--evidence",
      fixture.reference.path,
      "--evidence-sha256",
      fixture.reference.sha256,
      "--json",
    ]);
    assertUnverifiedStatus(JSON.parse(String(output.mock.calls[0]![0])));
  }, 30_000);

  it("refuses a different repo, manifest hash mismatch and a changed candidate", async () => {
    const fixture = await executedFixture();
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const call = (repoRoot = fixture.a, hash = fixture.reference.sha256) =>
      command().parseAsync([
        "node",
        "lexrunner",
        "status",
        "--repo-root",
        repoRoot,
        "--plan",
        fixture.planFile,
        "--evidence",
        fixture.reference.path,
        "--evidence-sha256",
        hash,
        "--json",
      ]);
    await expect(call(fixture.b)).rejects.toMatchObject({ exitCode: 1 });
    expect(diagnostic.mock.calls.at(-1)?.[0]).toContain("different repository candidate");
    await expect(call(fixture.a, `sha256:${"0".repeat(64)}`)).rejects.toMatchObject({
      exitCode: 1,
    });
    expect(diagnostic.mock.calls.at(-1)?.[0]).toContain("manifest digest does not match");
    writeFileSync(join(fixture.a, "candidate.txt"), "changed candidate\n");
    await expect(call()).rejects.toMatchObject({ exitCode: 1 });
    expect(diagnostic.mock.calls.at(-1)?.[0]).toContain("different repository candidate");
  }, 30_000);
});
