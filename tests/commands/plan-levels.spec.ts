import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const cli = resolve(import.meta.dirname, "../../dist/cli.js");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("offline plan levels CLI", () => {
  it("orders non-PR work in a non-Git directory with no executable PATH, token or profile", () => {
    const fixture = makeFixture([
      { name: "delivery", deps: ["load", "interpreter"] },
      { name: "load", deps: [] },
      { name: "interpreter", deps: [] },
    ]);
    const before = readdirSync(fixture.root).sort();
    const planBytes = readFileSync(fixture.plan, "utf8");
    const result = run(fixture, ["plan", "levels", "--plan", fixture.plan, "--json"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      contract: "bounded-ax-v1",
      levels: [["interpreter", "load"], ["delivery"]],
      maxParallelism: 2,
      totalItems: 3,
    });
    expect(readdirSync(fixture.root).sort()).toEqual(before);
    expect(readFileSync(fixture.plan, "utf8")).toBe(planBytes);
  });

  it("prints dependency levels in human output and accepts a parent JSON flag", () => {
    const fixture = makeFixture([{ name: "task", deps: [] }]);
    const human = run(fixture, ["plan", "levels", "--plan", fixture.plan]);
    expect(human.status).toBe(0);
    expect(human.stdout).toContain("Dependency levels for 1 work items:");
    expect(human.stdout).toContain("Level 1: [task]");
    const json = run(fixture, ["--json", "plan", "levels", "--plan", fixture.plan]);
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout).levels).toEqual([["task"]]);
  });

  it.each([
    [
      "cycle",
      [
        { name: "a", deps: ["b"] },
        { name: "b", deps: ["a"] },
      ],
    ],
    ["missing dependency", [{ name: "a", deps: ["absent"] }]],
  ])("matches weave merge-order refusal for %s", (_name, items) => {
    const fixture = makeFixture(items);
    const levels = run(fixture, ["plan", "levels", "--plan", fixture.plan, "--json"]);
    const weave = run(fixture, ["weave", "merge-order", fixture.plan, "--json"]);
    expect(levels.status).toBe(2);
    expect(weave.status).not.toBe(0);
    expect(JSON.parse(levels.stdout).message).toBe(JSON.parse(weave.stdout).error);
    expect(JSON.parse(levels.stdout).nextActions.length).toBeGreaterThan(0);
  });

  it("does not interpret weave-policy fields as an override of graph validation", () => {
    const fixture = makeFixture([{ name: "a", deps: ["absent"] }], {
      on_cycle: "ignore",
      on_missing_dep: "ignore",
    });
    const levels = run(fixture, ["plan", "levels", "--plan", fixture.plan, "--json"]);
    const weave = run(fixture, ["weave", "merge-order", fixture.plan, "--json"]);
    expect(levels.status).toBe(2);
    expect(weave.status).not.toBe(0);
    expect(JSON.parse(levels.stdout).message).toBe(JSON.parse(weave.stdout).error);
  });

  it("refuses malformed schema and missing files without writes", () => {
    const fixture = makeFixture([{ name: "duplicate", deps: [] }]);
    const input = JSON.parse(readFileSync(fixture.plan, "utf8"));
    input.items.push(input.items[0]);
    writeFileSync(fixture.plan, JSON.stringify(input));
    const invalid = run(fixture, ["plan", "levels", "--plan", fixture.plan, "--json"]);
    expect(invalid.status).toBe(2);
    expect(JSON.parse(invalid.stdout)).toMatchObject({ valid: false });
    const missing = run(fixture, ["plan", "levels", "--plan", "absent.json", "--json"]);
    expect(missing.status).not.toBe(0);
    expect(JSON.parse(missing.stdout).code).toBe("PLAN_LEVELS_FAILED");
  });

  it("retains generator help and exposes offline usage", () => {
    const fixture = makeFixture([]);
    const generator = run(fixture, ["plan", "--help"]);
    expect(generator.status).toBe(0);
    expect(generator.stdout).toContain("--from-github");
    expect(generator.stdout).toContain("--dry-run");
    expect(generator.stdout).toContain("levels");
    const offline = run(fixture, ["plan", "levels", "--help"]);
    expect(offline.status).toBe(0);
    expect(offline.stdout).toContain("Requires no Git checkout");
  });
});

function makeFixture(items: Array<{ name: string; deps: string[] }>, policy?: unknown) {
  const root = mkdtempSync(join(tmpdir(), "lexrunner-offline-levels-"));
  roots.push(root);
  const plan = join(root, "plan.json");
  // A gate is deliberately present: ordering must not execute it.
  writeFileSync(
    plan,
    JSON.stringify({
      schemaVersion: "1.0.0",
      ...(policy ? { policy } : {}),
      items: items.map((item) => ({
        ...item,
        gates: [{ name: "must-not-run", run: 'node -e "process.exit(91)"' }],
      })),
    })
  );
  const guard = join(root, "deny-effects.cjs");
  writeFileSync(
    guard,
    `const { syncBuiltinESMExports } = require('node:module');
const deny = () => { throw new Error('OFFLINE_EFFECT_ATTEMPTED'); };
const child = require('node:child_process');
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) child[key] = deny;
for (const name of ['node:net', 'node:tls', 'node:http', 'node:https']) {
  const api = require(name);
  for (const key of ['connect', 'createConnection', 'request', 'get']) if (key in api) api[key] = deny;
}
globalThis.fetch = deny;
const fs = require('node:fs');
for (const key of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'mkdir', 'mkdirSync', 'rm', 'rmSync', 'rename', 'renameSync', 'unlink', 'unlinkSync']) fs[key] = deny;
for (const key of ['writeFile', 'appendFile', 'mkdir', 'rm', 'rename', 'unlink']) fs.promises[key] = deny;
syncBuiltinESMExports();
`
  );
  return { root, plan, guard };
}

function run(fixture: ReturnType<typeof makeFixture>, args: string[]) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(GIT_|GH_|GITHUB_|LEX_|LEXRUNNER_|NODE_OPTIONS$|NODE_PATH$|PATH$|HOME$|USERPROFILE$)/i.test(
          key
        )
    )
  );
  Object.assign(env, { PATH: "", HOME: fixture.root, USERPROFILE: fixture.root });
  try {
    const stdout = execFileSync(process.execPath, ["--require", fixture.guard, cli, ...args], {
      cwd: fixture.root,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return { status: failure.status, stdout: failure.stdout, stderr: failure.stderr };
  }
}
