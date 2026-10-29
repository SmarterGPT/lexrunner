import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createServer } from "../src/mcp/server.js";
import { InMemoryRunStore } from "../src/store/inmemory/index.js";

const roots: string[] = [];
const originalCwd = process.cwd();
const mcpPath = resolve(import.meta.dirname, "../mcp-server.mjs");
const target = "a".repeat(40);
const source = "b".repeat(40);

afterEach(async () => {
  process.chdir(originalCwd);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  );
});

function responseFor(url: string, options: RequestInit) {
  const parsed = new URL(url);
  if (
    parsed.origin !== "https://api.bitbucket.org" ||
    options.method !== "GET" ||
    options.body !== undefined
  ) {
    throw new Error("Unexpected forge or non-read-only request");
  }
  if (!parsed.pathname.startsWith("/2.0/repositories/team/project"))
    throw new Error("Wrong repository");
  const endpoint = {
    branch: { name: "main" },
    commit: { hash: target },
    repository: { full_name: "team/project" },
  };
  const value = parsed.pathname.endsWith("/pullrequests")
    ? {
        values: [
          {
            id: 17,
            title: "Read-only fixture",
            description: "Body must not leak from discovery",
            state: "OPEN",
            author: { display_name: "Fixture" },
            destination: endpoint,
            source: { ...endpoint, branch: { name: "feature/17" }, commit: { hash: source } },
          },
        ],
      }
    : parsed.pathname.includes("/refs/branches/")
      ? { name: "main", target: { hash: target } }
      : { full_name: "team/project", mainbranch: { name: "main" } };
  return new Response(JSON.stringify(value));
}

const invalidDiscovery = [
  { provider: "bitbucket" },
  { provider: "bitbucket", owner: "team", repo: "project", suggest: true },
  { provider: "bitbucket", owner: "team", repo: "project", state: "invalid" },
  { provider: "bitbucket", owner: "../team", repo: "project" },
  { provider: "bitbucket", owner: "team", repo: "project", execute: true },
  { provider: "gitlab", owner: "team", repo: "project" },
  { provider: "github", owner: "team", repo: "project", query: "Bitbucket-only filter" },
];
const invalidPlans = [
  { fromBitbucket: true },
  { fromBitbucket: true, fromGithub: true, owner: "team", repo: "project" },
  ...["outDir", "repoRoot", "profileDir", "githubToken"].map((field) => ({
    fromBitbucket: true,
    owner: "team",
    repo: "project",
    [field]: "must-not-use",
  })),
  { fromBitbucket: true, owner: "team", repo: "project", repos: [] },
  { fromBitbucket: true, owner: "team", repo: "project", labels: [] },
  { fromBitbucket: true, owner: "team", repo: "project", push: true },
  { fromBitbucket: "true", owner: "team", repo: "project" },
];

function assertPlanningResults(discovered: any, planned: any) {
  for (const result of [discovered, planned]) {
    expect(result).toMatchObject({
      contract: "bounded-ax-v1",
      provider: "bitbucket",
      authority: "unverified",
      authorizesExecution: false,
      authorizesMerge: false,
    });
    expect(JSON.stringify(result)).not.toContain("fixture-bitbucket-token");
  }
  expect(discovered).toMatchObject({
    total: 1,
    pullRequests: [
      { number: 17, sourceRepository: "team/project", destinationRepository: "team/project" },
    ],
  });
  expect(JSON.stringify(discovered)).not.toContain("Body must not leak");
  expect(planned).not.toHaveProperty("files");
  expect(planned).not.toHaveProperty("routing");
  expect(planned.plan.gitInputs).toMatchObject({
    repository: "https://bitbucket.org/team/project.git",
    target: { commit: target },
    sources: [{ item: "PR-17", commit: source, ref: "refs/heads/feature/17" }],
  });
}

describe("Bitbucket MCP planning-only parity", () => {
  it("routes the SDK adapter without GitHub credentials, local Git, profiles or artifact writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "lexrunner-sdk-bitbucket-"));
    roots.push(root);
    process.chdir(root);
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("BITBUCKET_TOKEN", "fixture-bitbucket-token");
    vi.stubEnv("ALLOW_MUTATIONS", "false");
    const fetcher = vi.fn(async (url: string, options: RequestInit) => responseFor(url, options));
    vi.stubGlobal("fetch", fetcher);
    const server = createServer({ runStore: new InMemoryRunStore() });
    const client = new Client({ name: "bitbucket-fixture", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = (await client.listTools()).tools;
      expect(tools.find(({ name }) => name === "discover")?.inputSchema.properties).toHaveProperty(
        "provider"
      );
      expect(
        tools.find(({ name }) => name === "plan_create")?.inputSchema.properties
      ).toHaveProperty("fromBitbucket");
      const discovered = text(
        await client.callTool({
          name: "discover",
          arguments: {
            provider: "bitbucket",
            owner: "team",
            repo: "project",
            query: 'title~"fixture"',
            target: "main",
          },
        })
      );
      const planned = text(
        await client.callTool({
          name: "plan_create",
          arguments: { fromBitbucket: true, owner: "team", repo: "project" },
        })
      );
      assertPlanningResults(discovered, planned);
      const requestCount = fetcher.mock.calls.length;
      for (const args of invalidDiscovery) {
        await expect(client.callTool({ name: "discover", arguments: args })).rejects.toThrow(
          "FORGE_ARGUMENTS_INVALID"
        );
      }
      for (const args of invalidPlans) {
        await expect(client.callTool({ name: "plan_create", arguments: args })).rejects.toThrow(
          "FORGE_ARGUMENTS_INVALID"
        );
      }
      expect(fetcher).toHaveBeenCalledTimes(requestCount);
      const query = new URL(fetcher.mock.calls[0]![0]).searchParams.get("q");
      expect(query).toContain('state="OPEN"');
      expect(query).toContain('destination.branch.name="main"');
      expect(await readdir(root)).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("routes the actual published adapter using only fixture GETs with Git/process/write attempts denied", async () => {
    const root = await mkdtemp(join(tmpdir(), "lexrunner-published-bitbucket-"));
    roots.push(root);
    const preload = join(root, "fixture.mjs");
    await writeFile(
      preload,
      `
import { createRequire, syncBuiltinESMExports } from 'node:module';
const require = createRequire(import.meta.url);
const deny = () => { throw new Error('FORBIDDEN_FIXTURE_EFFECT'); };
for (const name of ['node:child_process', 'node:http', 'node:https', 'node:net', 'node:tls']) {
  const api = require(name);
  for (const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork','request','get','connect','createConnection']) if (key in api) api[key] = deny;
}
const fs = require('node:fs');
for (const name of ['writeFile','appendFile','mkdir','rm','rename','unlink','copyFile','cp','mkdtemp','truncate','symlink','link']) {
  fs[name] = deny; fs[name + 'Sync'] = deny; fs.promises[name] = deny;
}
for (const api of [fs, fs.promises]) {
  for (const name of ['open','openSync']) if (name in api) {
    const original = api[name];
    api[name] = (...args) => {
      if (![undefined, 0, 'r', 'rs'].includes(args[1])) deny();
      return original.apply(api, args);
    };
  }
}
syncBuiltinESMExports();
const target = ${JSON.stringify(target)}, source = ${JSON.stringify(source)};
globalThis.fetch = async (url, options) => {
  console.error('[fixture-get]');
  return (${responseFor.toString()})(url, options);
};
`,
      "utf8"
    );
    const calls = [
      { method: "tools/list" },
      ...[
        ["discover", { provider: "bitbucket", owner: "team", repo: "project" }],
        ["plan.create", { fromBitbucket: true, owner: "team", repo: "project" }],
        ...invalidDiscovery.map((args) => ["discover", args]),
        ...invalidPlans.map((args) => ["plan.create", args]),
      ].map(([name, args]) => ({ method: "tools/call", params: { name, arguments: args } })),
    ];
    const child = execa(process.execPath, ["--import", pathToFileURL(preload).href, mcpPath], {
      cwd: root,
      windowsHide: true,
      timeout: 30_000,
      env: {
        ...process.env,
        GITHUB_TOKEN: "",
        GH_TOKEN: "",
        BITBUCKET_TOKEN: "fixture-bitbucket-token",
        ALLOW_MUTATIONS: "false",
        NODE_OPTIONS: "",
      },
    });
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.trim().split("\n").length === calls.length) child.stdin?.end();
    });
    child.stdin?.write(
      calls
        .map((call, index) => JSON.stringify({ jsonrpc: "2.0", id: index + 1, ...call }))
        .join("\n") + "\n"
    );
    const result = await child;
    const replies = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(replies).toHaveLength(calls.length);
    expect(
      replies[0].result.tools.find(({ name }: any) => name === "plan.create").inputSchema.properties
    ).toHaveProperty("fromBitbucket");
    assertPlanningResults(text(replies[1].result), text(replies[2].result));
    for (const reply of replies.slice(3)) {
      expect(reply.error.code).toBe(-32602);
      expect(JSON.parse(reply.error.message).code).toBe("FORGE_ARGUMENTS_INVALID");
    }
    expect(result.stderr.match(/\[fixture-get\]/g)).toHaveLength(4);
    expect(result.stderr).not.toContain("FORBIDDEN_FIXTURE_EFFECT");
    expect(result.stdout + result.stderr).not.toContain("fixture-bitbucket-token");
    expect(await readdir(root)).toEqual(["fixture.mjs"]);
  }, 35_000);
});

function text(result: any) {
  return JSON.parse(result.content[0].text);
}
