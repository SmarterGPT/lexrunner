import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "../src/mcp/server.js";
import { InMemoryRunStore } from "../src/store/inmemory/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  );
});

describe("SDK MCP plan artifact parity", () => {
  it("uses the same explicit plan and identity for status, order, gates, and merge preview", async () => {
    const root = await mkdtemp(join(tmpdir(), "lexrunner-sdk-plan-"));
    roots.push(root);
    const profile = join(root, "profile");
    const planFile = join(root, "authored-plan.json");
    await mkdir(join(profile, "runner"), { recursive: true });
    await writeFile(join(profile, "profile.yml"), "role: local\n", "utf8");
    await writeFile(
      join(profile, "runner", "plan.json"),
      `${JSON.stringify(plan("profile-only"), null, 2)}\n`,
      "utf8"
    );
    await writeFile(planFile, `${JSON.stringify(plan("explicit"), null, 2)}\n`, "utf8");
    await execa("git", ["init", "-b", "main"], { cwd: root });
    await execa("git", ["add", "."], { cwd: root });
    await execa(
      "git",
      [
        "-c",
        "user.name=LexRunner Test",
        "-c",
        "user.email=lexrunner@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "fixture",
      ],
      { cwd: root }
    );

    const previousCwd = process.cwd();
    const previousProfile = process.env.LEX_PR_PROFILE_DIR;
    process.chdir(root);
    process.env.LEX_PR_PROFILE_DIR = profile;

    const runStore = new InMemoryRunStore();
    const server = createServer({ runStore });
    const client = new Client({ name: "plan-artifact-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const inventory = await client.listTools();
      const planCreateTool = inventory.tools.find(({ name }) => name === "plan_create");
      expect(planCreateTool?.inputSchema.properties).toMatchObject({
        repoRoot: { type: "string", minLength: 1, maxLength: 4096 },
        profileDir: { type: "string", minLength: 1, maxLength: 4096 },
      });
      expect(planCreateTool?.inputSchema.properties.repos).toBeUndefined();
      for (const name of ["weave_status", "merge_order", "gates_run", "merge_apply"]) {
        const tool = inventory.tools.find((candidate) => candidate.name === name);
        expect((tool?.inputSchema.properties as Record<string, unknown>).planFile).toMatchObject({
          type: "string",
        });
      }

      const gatesTool = inventory.tools.find(({ name }) => name === "gates_run");
      expect(gatesTool?.inputSchema.properties).toMatchObject({ timeoutMs: { type: "integer" } });
      const statusTool = inventory.tools.find(({ name }) => name === "weave_status");
      expect(statusTool?.inputSchema.properties).toMatchObject({
        evidenceFile: { type: "string", minLength: 1, maxLength: 4096 },
        evidenceSha256: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
      });

      const calls = [
        ["weave_status", { planFile }],
        ["merge_order", { planFile }],
        ["merge_apply", { planFile, dryRun: true }],
        ["gates_run", { planFile, onlyItem: "explicit", outDir: join(root, "gates") }],
      ] as const;
      const results: Record<string, any> = {};
      for (const [name, args] of calls) {
        const response = await client.callTool({ name, arguments: args });
        results[name] = parseToolText(response);
      }

      expect(results.weave_status.mergeSummary.pending).toEqual(["explicit"]);

      expect(results.weave_status.plan.itemCount).toBe(1);
      expect(results.merge_order.levels).toEqual([["explicit"]]);
      expect(results.merge_apply).toMatchObject({ mode: "dry-run", totalItems: 1 });
      expect(results.gates_run.items).toMatchObject([
        {
          name: "explicit",
          status: "pass",
          gates: [{ name: "test", status: "pass" }],
        },
      ]);
      const evidence = results.gates_run.artifactRefs.find(
        ({ kind }: { kind: string }) => kind === "gate-evidence-manifest"
      );
      const statusWithEvidence = parseToolText(
        await client.callTool({
          name: "weave_status",
          arguments: {
            planFile,
            evidenceFile: evidence.path,
            evidenceSha256: evidence.sha256,
          },
        })
      );
      expect(statusWithEvidence).toMatchObject({
        evidence: {
          kind: "gate-evidence-manifest",
          applied: 1,
          authority: "unverified",
          observations: { passed: ["explicit/test"], failed: [], other: [] },
        },
        mergeSummary: { eligible: [], pending: ["explicit"], failed: [] },
      });
      expect(statusWithEvidence.planArtifact).toEqual(results.gates_run.planArtifact);
      const identities = calls.map(([name]) => results[name].planArtifact);
      expect(
        identities.every((identity) => JSON.stringify(identity) === JSON.stringify(identities[0]))
      ).toBe(true);
    } finally {
      await client.close();
      await server.close();
      await runStore.close();
      process.chdir(previousCwd);
      if (previousProfile === undefined) delete process.env.LEX_PR_PROFILE_DIR;
      else process.env.LEX_PR_PROFILE_DIR = previousProfile;
    }
  }, 10_000);
});

function plan(name: string) {
  return {
    schemaVersion: "1.0.0",
    target: "main",
    items: [
      {
        name,
        deps: [],
        gates: [{ name: "test", run: 'node -e "process.exit(0)"', env: {} }],
      },
    ],
  };
}

function parseToolText(result: {
  content: Array<{ type: string; text?: string }>;
}): Record<string, any> {
  const text = result.content.find(({ type }) => type === "text")?.text;
  if (!text) throw new Error("MCP tool returned no text content");
  return JSON.parse(text);
}
