import { Command } from "commander";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerWeaveCommand, runWeaveApply } from "../../src/commands/weave.js";
import { registerPlanCommand } from "../../src/commands/plan.js";
import { registerDiscoverCommand } from "../../src/commands/discover.js";
import { Plan } from "../../src/schema.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function program() {
  const command = new Command().name("lexrunner").exitOverride();
  const deps = {
    jsonModeActive: () => false,
    setJsonMode: vi.fn(),
    getProgramOpts: () => ({}),
    exitWith: (error: unknown) => {
      throw error;
    },
  };
  registerWeaveCommand(command, deps);
  registerDiscoverCommand(command, deps);
  registerPlanCommand(command, deps);
  return command;
}
function network() {
  const fetcher = vi.fn().mockImplementation(async (url: string) => {
    const path = new URL(url).pathname;
    return new Response(
      JSON.stringify(
        path.endsWith("/pullrequests")
          ? { values: [] }
          : path.includes("/refs/branches/")
            ? { name: "main", target: { hash: "a".repeat(40) } }
            : { full_name: "team/project", mainbranch: { name: "main" } }
      )
    );
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubEnv("BITBUCKET_TOKEN", "fixture-secret");
  return fetcher;
}

describe("Bitbucket CLI routing", () => {
  it.each([false, true])(
    "refuses non-dry-run apply before gates or ready projection (skipGates=%s)",
    async (skipGates) => {
      const root = mkdtempSync(join(tmpdir(), "bitbucket-apply-"));
      roots.push(root);
      const planFile = join(root, "plan.json");
      writeFileSync(
        planFile,
        JSON.stringify(
          Plan.parse({
            schemaVersion: "1.0.0",
            target: "main",
            items: [],
            gitInputs: {
              schemaVersion: "1.0.0",
              repository: "https://bitbucket.org/team/project.git",
              checkoutRemote: "origin",
              acquisition: "fetch",
              target: { ref: "refs/heads/main", commit: "a".repeat(40) },
              sources: [],
            },
          })
        )
      );
      const executeGates = vi.fn();
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      const deps = { jsonModeActive: () => true, getProgramOpts: () => ({}), executeGates };
      await expect(
        runWeaveApply({ plan: planFile, execute: false, skipGates, json: true }, deps)
      ).rejects.toThrow();
      expect(executeGates).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(readdirSync(root)).toEqual(["plan.json"]);
      await expect(
        runWeaveApply({ plan: planFile, dryRun: true, constraints: false, json: true }, deps)
      ).resolves.toBeUndefined();
      expect(executeGates).not.toHaveBeenCalled();
      expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({
        mode: "dry-run",
        status: "preview",
      });
    }
  );

  it.each([["weave", "discover"], ["discover"]])(
    "routes %j through read-only Bitbucket discovery without exposing tokens",
    async (...prefix) => {
      const fetcher = network();
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await program().parseAsync(
        [...prefix, "--provider", "bitbucket", "--owner", "team", "--repo", "project", "--json"],
        { from: "user" }
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({
        provider: "bitbucket",
        total: 0,
        authorizesMerge: false,
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain("fixture-secret");
    }
  );

  it.each([["weave", "plan"], ["plan"]])(
    "freezes a %j plan into only the explicit output file",
    async (...prefix) => {
      network();
      vi.spyOn(console, "log").mockImplementation(() => {});
      const root = mkdtempSync(join(tmpdir(), "bitbucket-plan-"));
      roots.push(root);
      const output = join(root, "plan.json");
      await program().parseAsync(
        [...prefix, "--from-bitbucket", "--owner", "team", "--repo", "project", "--output", output],
        { from: "user" }
      );
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
        gitInputs: { repository: "https://bitbucket.org/team/project.git" },
        items: [],
      });
      expect(readdirSync(root)).toEqual(["plan.json"]);
    }
  );

  it("refuses unsupported provider/forge combinations before any network request", async () => {
    const fetcher = network();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      program().parseAsync(["weave", "plan", "--from-bitbucket", "--from-github"], { from: "user" })
    ).rejects.toThrow();
    await expect(
      program().parseAsync(["plan", "--from-bitbucket", "--labels", "ci"], { from: "user" })
    ).rejects.toThrow("does not support");
    await expect(
      program().parseAsync(["discover", "--provider", "bitbucket", "--suggest"], { from: "user" })
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
