import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

import { GatesRunArgs } from "../src/mcp/types.js";
import {
  candidateFixture,
  containsManifest,
  evidence,
  expectedDigests,
  routingPlan,
  type CandidateFixture,
} from "./helpers/gate-candidate-fixture.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const fixtures: CandidateFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});
function fixture(): CandidateFixture {
  const result = candidateFixture();
  fixtures.push(result);
  return result;
}

async function connectedClient(
  f: CandidateFixture,
  surface: "source" | "published",
  startup = f.startup
): Promise<Client> {
  const bootstrap = join(f.root, "source-server.mts");
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
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      ),
      ALLOW_MUTATIONS: "false",
      LEX_PR_PROFILE_DIR: join(f.root, "private-profile"),
    },
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk) => {
    diagnostics = (diagnostics + String(chunk)).slice(-32_768);
  });
  const client = new Client({ name: "candidate-routing-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await transport.close();
    throw new Error(`Source fixture connection failed: ${String(error)}\n${diagnostics}`);
  }
}

describe("candidate-root MCP argument shape", () => {
  it("retains an explicit root and rejects invalid bounded argument shapes", () => {
    expect(GatesRunArgs.parse({ repoRoot: "candidate" }).repoRoot).toBe("candidate");
    for (const repoRoot of [null, 3, {}, "", "x".repeat(4097)])
      expect(() => GatesRunArgs.parse({ repoRoot })).toThrow();
  });
});

describe.each(["source", "published"] as const)("%s MCP candidate binding", (surface) => {
  const tool = surface === "source" ? "gates_run" : "gates.run";
  it("advertises explicit root and executes from a non-Git startup with unchanged declared digests", async () => {
    const f = fixture();
    const client = await connectedClient(f, surface);
    const plan = routingPlan("checks");
    const planFile = join(f.root, "external-plan.json");
    writeFileSync(planFile, JSON.stringify(plan));
    try {
      const inventory = await client.listTools();
      expect(
        inventory.tools.find(({ name }) => name === tool)?.inputSchema.properties
      ).toMatchObject({
        repoRoot: { type: "string", minLength: 1, maxLength: 4096 },
        onlyItem: { type: "string", minLength: 1 },
        onlyGate: { type: "string", minLength: 1 },
      });
      const response = await client.callTool({
        name: tool,
        arguments: {
          planFile,
          repoRoot: f.a,
          outDir: f.artifacts,
          onlyItem: "selected",
          onlyGate: "probe",
        },
      });
      const summary = JSON.parse((response.content as Array<{ text: string }>)[0]!.text);
      const actual = evidence(summary);
      const digests = expectedDigests(plan);
      expect(summary.allGreen).toBe(true);
      expect(actual.manifest.candidate.repositoryRoot).toBe(f.a);
      expect(actual.output).toEqual({ cwd: join(f.a, "checks"), candidate: "a" });
      expect(actual.manifest.plan.digest).toBe(digests.plan);
      expect(actual.receipt.binding.declaredGateDigest).toBe(digests.gate);
      expect(actual.receipt.declaredGate.cwd).toBe("checks");
    } finally {
      await client.close();
    }
  }, 30_000);

  it("keeps sequential and concurrent candidate calls invocation-local in one server", async () => {
    const f = fixture();
    const client = await connectedClient(f, surface);
    const planFile = join(f.root, "external-plan.json");
    writeFileSync(planFile, JSON.stringify(routingPlan("checks")));
    try {
      const call = async (repoRoot: string) => {
        const response = await client.callTool({
          name: tool,
          arguments: { planFile, repoRoot, outDir: f.artifacts },
        });
        const summary = JSON.parse((response.content as Array<{ text: string }>)[0]!.text);
        expect(summary.allGreen).toBe(true);
        return evidence(summary);
      };
      for (const repoRoot of [f.a, f.b]) {
        const actual = await call(repoRoot);
        expect(actual.manifest.candidate.repositoryRoot).toBe(repoRoot);
        expect(actual.output.cwd).toBe(join(repoRoot, "checks"));
      }
      const results = await Promise.all([call(f.a), call(f.b)]);
      for (const [index, actual] of results.entries()) {
        const root = index === 0 ? f.a : f.b;
        expect(actual.manifest.candidate.repositoryRoot).toBe(root);
        expect(actual.output).toEqual({
          cwd: join(root, "checks"),
          candidate: index === 0 ? "a" : "b",
        });
        expect(actual.receipt.binding.candidateDigest).toBe(
          actual.manifest.candidate.worktreeDigest
        );
      }
    } finally {
      await client.close();
    }
  }, 30_000);

  it("refuses unavailable roots and conflicting gate candidates before gate output or manifests", async () => {
    const f = fixture();
    const client = await connectedClient(f, surface);
    const planFile = join(f.root, "external-plan.json");
    writeFileSync(planFile, JSON.stringify(routingPlan(f.a)));
    try {
      for (const [repoRoot, code] of [
        [f.startup, "GATE_CANDIDATE_ROOT_INVALID"],
        [join(f.root, "missing"), "GATE_CANDIDATE_ROOT_INVALID"],
        [f.b, "GATE_WORKING_DIRECTORY_CONFLICT"],
      ]) {
        await expect(
          client.callTool({ name: tool, arguments: { planFile, repoRoot, outDir: f.artifacts } })
        ).rejects.toThrow(code);
      }
      expect(containsManifest(f.artifacts)).toBe(false);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("refuses empty item and gate selectors before the actual marker command", async () => {
    const f = fixture();
    const marker = join(f.artifacts, "must-not-run.marker");
    writeFileSync(
      join(f.a, "empty-selector-probe.cjs"),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n`
    );
    const plan = routingPlan();
    plan.items[0]!.gates[0]!.run = "node empty-selector-probe.cjs";
    const planFile = join(f.root, "empty-selector-plan.json");
    writeFileSync(planFile, JSON.stringify(plan));
    const client = await connectedClient(f, surface);
    try {
      for (const selection of [
        { onlyItem: "" },
        { onlyGate: "" },
        { onlyItem: "selected", onlyGate: "" },
      ]) {
        await expect(
          client.callTool({
            name: tool,
            arguments: { planFile, repoRoot: f.a, outDir: f.artifacts, ...selection },
          })
        ).rejects.toThrow("GATE_SELECTION_NOT_FOUND");
        expect(existsSync(marker)).toBe(false);
        expect(containsManifest(f.artifacts)).toBe(false);
      }
    } finally {
      await client.close();
    }
  }, 30_000);

  it("refuses provided nonstring roots from a Git startup before the actual marker command", async () => {
    const f = fixture();
    const marker = join(f.artifacts, "invalid-root-must-not-run.marker");
    writeFileSync(
      join(f.a, "invalid-root-probe.cjs"),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n`
    );
    const plan = routingPlan();
    plan.items[0]!.gates[0]!.run = "node invalid-root-probe.cjs";
    const planFile = join(f.root, "invalid-root-plan.json");
    writeFileSync(planFile, JSON.stringify(plan));
    const controlPlan = join(f.root, "default-root-control-plan.json");
    writeFileSync(controlPlan, JSON.stringify(routingPlan()));
    const client = await connectedClient(f, surface, f.a);
    try {
      // Omission is a supported default at this actual Git startup; malformed provision is not.
      const control = await client.callTool({
        name: tool,
        arguments: {
          planFile: controlPlan,
          outDir: join(f.root, "default-root-control-artifacts"),
        },
      });
      const summary = JSON.parse((control.content as Array<{ text: string }>)[0]!.text);
      expect(summary.allGreen).toBe(true);
      expect(evidence(summary).output).toEqual({ cwd: f.a, candidate: "a" });
      for (const repoRoot of [null, false, 0, {}]) {
        const call = client.callTool({
          name: tool,
          arguments: { planFile, repoRoot, outDir: f.artifacts },
        });
        // The SDK rejects malformed shapes at parsing; the raw published adapter uses the service.
        if (surface === "source") await expect(call).rejects.toThrow();
        else await expect(call).rejects.toThrow("GATE_CANDIDATE_ROOT_INVALID");
        expect(existsSync(marker)).toBe(false);
        expect(containsManifest(f.artifacts)).toBe(false);
      }
    } finally {
      await client.close();
    }
  }, 30_000);
});
