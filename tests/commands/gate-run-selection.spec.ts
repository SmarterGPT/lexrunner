import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

const cli = resolve(import.meta.dirname, "../..", "dist/cli.js");
const ownedRoots: string[] = [];
const fixtureEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))
);

afterEach(() => {
  for (const root of ownedRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("built gate run selection", () => {
  it("publishes all selection flags in actual CLI help", async () => {
    const help = await execa(process.execPath, [cli, "gate", "run", "--help"]);
    for (const flag of ["--repo-root", "--only-item", "--only-gate"]) {
      expect(help.stdout).toContain(flag);
    }
  });

  it("runs exactly the selected item from a non-Git startup and scopes its evidence", async () => {
    const fixture = makeFixture();
    const result = await run(fixture, ["--only-item", "a"]);
    expect(result.exitCode).toBe(0);
    expect(markers(fixture)).toEqual(["a-lint", "a-unit"]);
    const summary = JSON.parse(result.stdout);
    expect(summary.items.map((item: { name: string }) => item.name)).toEqual(["a"]);
    expect(summary.allGreen).toBe(true);
    const ref = summary.artifactRefs.find(
      (entry: { kind: string }) => entry.kind === "gate-evidence-manifest"
    );
    const evidence = JSON.parse(readFileSync(ref.path, "utf8"));
    expect(evidence.plan.itemCount).toBe(2);
    expect(evidence.selection).toEqual({ onlyItem: "a", onlyGate: null });
    expect(evidence.entries.map((entry: { item: string }) => entry.item)).toEqual(["a", "a"]);
  }, 30_000);

  it("runs exactly the selected gate and leaves omitted required gates unqualified", async () => {
    const fixture = makeFixture();
    const result = await run(fixture, ["--only-gate", "lint"]);
    expect(markers(fixture)).toEqual(["a-lint", "b-lint"]);
    const summary = JSON.parse(result.stdout);
    expect(summary.allGreen).toBe(false);
    expect(summary.items.every((item: { status: string }) => item.status !== "pass")).toBe(true);
    expect(
      summary.items.flatMap((item: { gates: Array<{ name: string }> }) =>
        item.gates.map((gate) => gate.name)
      )
    ).toEqual(["lint", "lint"]);
  }, 30_000);

  it("combines item and gate selection without running either omitted scope", async () => {
    const fixture = makeFixture();
    const result = await run(fixture, ["--only-item", "b", "--only-gate", "unit"]);
    expect(markers(fixture)).toEqual(["b-unit"]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      allGreen: false,
      items: [{ name: "b", gates: [{ name: "unit", status: "pass" }] }],
    });
  }, 30_000);

  it.each([
    ["--only-item", "missing"],
    ["--only-gate", "missing"],
    ["--only-item", ""],
    ["--only-gate", ""],
    ["--only-item", "a", "--only-gate", "b-only"],
  ])(
    "refuses invalid selection %j before any marker command",
    async (...selection) => {
      const fixture = makeFixture();
      const result = await run(fixture, selection);
      expect(result.exitCode).not.toBe(0);
      expect(markers(fixture)).toEqual([]);
      expect(JSON.parse(result.stdout)).toMatchObject({ code: "GATE_SELECTION_NOT_FOUND" });
    },
    30_000
  );

  it("validates selectors during dry run without executing commands", async () => {
    const fixture = makeFixture();
    const invalid = await run(fixture, ["--dry-run", "--only-item", "missing"]);
    expect(invalid.exitCode).not.toBe(0);
    const valid = await run(fixture, ["--dry-run", "--only-item", "a", "--only-gate", "lint"]);
    expect(valid.exitCode).toBe(0);
    expect(JSON.parse(valid.stdout)).toMatchObject({
      dryRun: true,
      selection: { onlyItem: "a", onlyGate: "lint" },
      plan: { itemCount: 2 },
    });
    expect(markers(fixture)).toEqual([]);
  }, 30_000);
});

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "lexrunner-cli-selection-"));
  ownedRoots.push(root);
  const repo = join(root, "candidate");
  const startup = join(root, "non-git-startup");
  const markerRoot = join(root, "markers");
  for (const directory of [repo, startup, markerRoot]) mkdirSync(directory);
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      env: fixtureEnvironment,
      stdio: "pipe",
      timeout: 10_000,
      windowsHide: true,
    });
  git(["init", "--quiet"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["config", "user.name", "LexRunner isolated test"]);
  git(["config", "user.email", "lexrunner-test@example.invalid"]);
  writeFileSync(join(repo, "candidate.txt"), "owned test candidate\n");
  git(["add", "candidate.txt"]);
  git(["commit", "--quiet", "-m", "Create isolated test candidate"]);
  const markerScript = join(root, "marker.cjs");
  writeFileSync(
    markerScript,
    'require("node:fs").writeFileSync(process.argv[2], process.cwd());\n'
  );
  const command = (marker: string) =>
    (process.platform === "win32" ? "& " : "") +
    [process.execPath, markerScript, join(markerRoot, marker)].map(shellQuote).join(" ");
  const items = ["a", "b"].map((name) => ({
    name,
    deps: [],
    gates: ["lint", "unit"].map((gate) => ({ name: gate, run: command(`${name}-${gate}`) })),
  }));
  items[1]!.gates.push({ name: "b-only", run: command("b-only") });
  const planFile = join(root, "plan.json");
  writeFileSync(
    planFile,
    JSON.stringify({
      schemaVersion: "1.0.0",
      target: "main",
      items,
      policy: { maxWorkers: 1, requiredGates: ["lint", "unit"], retries: {} },
    })
  );
  return { root, repo, startup, markerRoot, planFile };
}

function run(fixture: ReturnType<typeof makeFixture>, selection: string[]) {
  return execa(
    process.execPath,
    [
      cli,
      "--no-emit-frames",
      "gate",
      "run",
      "--plan",
      fixture.planFile,
      "--repo-root",
      fixture.repo,
      "--artifact-dir",
      join(fixture.root, "artifacts"),
      "--keep-cache",
      "--profile-dir",
      join(fixture.root, "private-profile"),
      "--json",
      ...selection,
    ],
    { cwd: fixture.startup, env: fixtureEnvironment, reject: false, timeout: 25_000 }
  );
}

function markers(fixture: ReturnType<typeof makeFixture>): string[] {
  return ["a-lint", "a-unit", "b-lint", "b-unit", "b-only"].filter((name) =>
    existsSync(join(fixture.markerRoot, name))
  );
}

function shellQuote(value: string): string {
  return process.platform === "win32"
    ? "'" + value.replaceAll("'", "''") + "'"
    : "'" + value.replaceAll("'", "'\"'\"'") + "'";
}
