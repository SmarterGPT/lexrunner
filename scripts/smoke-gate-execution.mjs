import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execa } from "execa";

/** Exercise installed tarball entry points against disposable, explicitly selected candidates. */
export async function smokeGateExecution({ cli, mcp, fixtureRoot }) {
  const gateTimeoutMs = 10_000;
  const fixtureEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))
  );
  mkdirSync(fixtureRoot);
  const startup = path.join(fixtureRoot, "non-git-startup");
  mkdirSync(startup);
  const repoA = candidate("a");
  const repoB = candidate("b");
  const markerScript = path.join(fixtureRoot, "marker.cjs");
  writeFileSync(
    markerScript,
    [
      'const fs = require("node:fs");',
      "const [log, name, code] = process.argv.slice(2);",
      'fs.appendFileSync(log, JSON.stringify({name, kind:"start", cwd:process.cwd()}) + "\\n");',
      'setTimeout(() => { fs.appendFileSync(log, JSON.stringify({name, kind:"end", cwd:process.cwd()}) + "\\n"); process.exit(Number(code)); }, 50);',
    ].join("\n")
  );
  const client = new Client({ name: "lexrunner-packed-gate-smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcp],
    cwd: startup,
    env: {
      ...fixtureEnvironment,
      ALLOW_MUTATIONS: "false",
      LEX_PR_PROFILE_DIR: path.join(fixtureRoot, "private-profile"),
    },
    stderr: "pipe",
  });
  let invocation = 0;
  try {
    const help = await execa(process.execPath, [cli, "gate", "run", "--help"], { timeout: 15_000 });
    for (const flag of ["--repo-root", "--only-item", "--only-gate"])
      assert.ok(help.stdout.includes(flag));
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(tools.find(({ name }) => name === "gates.run")?.inputSchema.properties.repoRoot);

    const cliCase = fixture("cli-selected", repoA);
    const cliResult = await cliRun(cliCase, ["--only-item", "a"]);
    assert.equal(cliResult.exitCode, 0);
    const cliSummary = JSON.parse(cliResult.stdout);
    assert.deepEqual(started(cliCase), ["a-unit", "a-lint"]);
    assertSelection(cliSummary, cliCase, "a");

    const mcpCase = fixture("mcp-selected", repoA);
    const mcpSummary = await mcpRun(mcpCase, { onlyItem: "a" });
    assert.deepEqual(mcpSummary.items, cliSummary.items);
    assert.deepEqual(started(mcpCase), ["a-unit", "a-lint"]);
    assertSelection(mcpSummary, mcpCase, "a");

    const first = fixture("concurrent-a", repoA);
    const second = fixture("concurrent-b", repoB);
    const concurrentSummaries = await Promise.all([
      mcpRun(first, { onlyItem: "a" }),
      mcpRun(second, { onlyItem: "a" }),
    ]);
    for (const [index, current] of [first, second].entries()) {
      const summary = concurrentSummaries[index];
      assert.equal(summary.allGreen, true);
      assert.deepEqual(started(current), ["a-unit", "a-lint"]);
      assert.deepEqual(
        events(current).map(({ kind }) => kind),
        ["start", "end", "start", "end"]
      );
      assertSelection(summary, current, "a");
      assert.ok(events(current).every((event) => physical(event.cwd) === physical(current.repo)));
    }

    const invalidCli = fixture("invalid-cli", repoA);
    const invalidCliResult = await cliRun(invalidCli, ["--only-item", "missing"]);
    assert.notEqual(invalidCliResult.exitCode, 0);
    assert.equal(JSON.parse(invalidCliResult.stdout).code, "GATE_SELECTION_NOT_FOUND");
    assert.deepEqual(started(invalidCli), []);
    const invalidMcp = fixture("invalid-mcp", repoA);
    await refused(invalidMcp, { onlyItem: "missing" }, /GATE_SELECTION_NOT_FOUND/);
    for (const selector of ["onlyItem", "onlyGate"]) {
      const emptyCli = fixture(`empty-cli-${selector}`, repoA);
      const flag = selector === "onlyItem" ? "--only-item" : "--only-gate";
      const emptyResult = await cliRun(emptyCli, [flag, ""]);
      assert.notEqual(emptyResult.exitCode, 0);
      assert.equal(JSON.parse(emptyResult.stdout).code, "GATE_SELECTION_NOT_FOUND");
      assert.deepEqual(started(emptyCli), []);
      const emptyMcp = fixture(`empty-mcp-${selector}`, repoA);
      await refused(emptyMcp, { [selector]: "" }, /GATE_SELECTION_NOT_FOUND/);
    }
    const conflict = fixture("wrong-root", repoA, { explicitCwd: true });
    await refused(conflict, { repoRoot: repoB }, /GATE_WORKING_DIRECTORY_CONFLICT/);

    const gitStartupClient = new Client({ name: "lexrunner-packed-null-root", version: "1.0.0" });
    try {
      await gitStartupClient.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [mcp],
          cwd: repoA,
          env: {
            ...fixtureEnvironment,
            ALLOW_MUTATIONS: "false",
            LEX_PR_PROFILE_DIR: path.join(fixtureRoot, "private-profile"),
          },
          stderr: "pipe",
        })
      );
      const nullRoot = fixture("null-root-git-startup", repoA);
      await refused(nullRoot, { repoRoot: null }, /GATE_CANDIDATE_ROOT_INVALID/, gitStartupClient);
    } finally {
      await gitStartupClient.close();
    }

    const filtered = fixture("filtered-required", repoA);
    const filteredSummary = await mcpRun(filtered, { onlyGate: "unit" });
    assert.deepEqual(started(filtered), ["a-unit", "b-unit"]);
    assert.equal(filteredSummary.allGreen, false);

    const chain = fixture("ordered-chain", repoA, { chain: true });
    const chainSummary = await mcpRun(chain);
    assert.equal(chainSummary.allGreen, true);
    assertSerial(chain);
    assert.deepEqual(started(chain), ["a-unit", "a-lint", "b-unit", "b-lint"]);
    const failure = fixture("failed-chain", repoA, { chain: true, fail: true });
    const failedSummary = await mcpRun(failure);
    assert.equal(failedSummary.allGreen, false);
    assert.deepEqual(started(failure), ["a-unit", "a-lint"]);
    assert.equal(failedSummary.items.find(({ name }) => name === "b").status, "blocked");
    return {
      cases: 15,
      cli: "passed",
      mcp: "passed",
      candidateIsolation: "passed",
      dependencyOrdering: "passed",
      maxWorkers1: "passed",
    };
  } finally {
    await client.close();
  }

  function candidate(name) {
    const root = path.join(fixtureRoot, `candidate-${name}`);
    mkdirSync(root);
    const git = (args) =>
      execFileSync("git", args, {
        cwd: root,
        env: fixtureEnvironment,
        stdio: "pipe",
        timeout: 10_000,
        windowsHide: true,
      });
    git(["init", "--quiet"]);
    git(["config", "commit.gpgsign", "false"]);
    git(["config", "user.name", "LexRunner packed smoke"]);
    git(["config", "user.email", "lexrunner-packed@example.invalid"]);
    writeFileSync(path.join(root, "candidate.txt"), `${name}\n`);
    git(["add", "candidate.txt"]);
    git(["commit", "--quiet", "-m", "Create disposable packed candidate"]);
    return root;
  }

  function fixture(name, repo, options = {}) {
    const log = path.join(fixtureRoot, `${name}.jsonl`);
    writeFileSync(log, "");
    const planFile = path.join(fixtureRoot, `${name}.plan.json`);
    const items = ["a", "b"].map((item) => ({
      name: item,
      deps: options.chain && item === "b" ? ["a"] : [],
      gates: ["unit", "lint"].map((gate) => ({
        name: gate,
        run:
          (process.platform === "win32" ? "& " : "") +
          [
            process.execPath,
            markerScript,
            log,
            `${item}-${gate}`,
            String(options.fail && item === "a" && gate === "unit" ? 1 : 0),
          ]
            .map(shellQuote)
            .join(" "),
        ...(options.explicitCwd ? { cwd: repo } : {}),
      })),
    }));
    writeFileSync(
      planFile,
      JSON.stringify({
        schemaVersion: "1.0.0",
        target: "main",
        items,
        policy: { requiredGates: ["unit", "lint"], maxWorkers: 1, retries: {} },
      })
    );
    return { repo, log, planFile };
  }

  function cliRun(current, selection) {
    return execa(
      process.execPath,
      [
        cli,
        "--no-emit-frames",
        "gate",
        "run",
        "--plan",
        current.planFile,
        "--repo-root",
        current.repo,
        "--artifact-dir",
        path.join(fixtureRoot, `cli-artifacts-${++invocation}`),
        "--keep-cache",
        "--timeout",
        String(gateTimeoutMs),
        "--profile-dir",
        path.join(fixtureRoot, "private-profile"),
        "--json",
        ...selection,
      ],
      { cwd: startup, env: fixtureEnvironment, reject: false, timeout: 30_000 }
    );
  }

  async function mcpRun(current, extra = {}, activeClient = client) {
    const result = await activeClient.callTool(
      {
        name: "gates.run",
        arguments: {
          planFile: current.planFile,
          repoRoot: current.repo,
          outDir: path.join(fixtureRoot, `mcp-artifacts-${++invocation}`),
          timeoutMs: gateTimeoutMs,
          ...extra,
        },
      },
      undefined,
      { timeout: 30_000 }
    );
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return JSON.parse(result.content.find(({ type }) => type === "text").text);
  }

  async function refused(current, extra, code, activeClient = client) {
    await assert.rejects(() => mcpRun(current, extra, activeClient), code);
    assert.deepEqual(started(current), []);
  }
}

function events(current) {
  return readFileSync(current.log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
function started(current) {
  return events(current)
    .filter(({ kind }) => kind === "start")
    .map(({ name }) => name);
}
function physical(value) {
  return process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
}
function assertSerial(current) {
  let active = 0;
  for (const event of events(current)) {
    active += event.kind === "start" ? 1 : -1;
    assert.ok(active >= 0 && active <= 1, "packed execution exceeded maxWorkers=1");
  }
  assert.equal(active, 0);
}
function assertSelection(summary, current, onlyItem) {
  const ref = summary.artifactRefs.find(({ kind }) => kind === "gate-evidence-manifest");
  const manifest = JSON.parse(readFileSync(ref.path, "utf8"));
  assert.equal(manifest.plan.itemCount, 2);
  assert.deepEqual(manifest.selection, { onlyItem, onlyGate: null });
  assert.ok(manifest.entries.every(({ item }) => item === onlyItem));
  assert.ok(events(current).every((event) => physical(event.cwd) === physical(current.repo)));
}

function shellQuote(value) {
  return process.platform === "win32"
    ? "'" + value.replaceAll("'", "''") + "'"
    : "'" + value.replaceAll("'", "'\"'\"'") + "'";
}
