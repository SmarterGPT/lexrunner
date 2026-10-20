import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceDiagnosticsService } from "../../src/application/workspace-config-services.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("workspace diagnostics git routing", () => {
  it("detects GitHub remotes from the diagnostic base instead of the call-time cwd", async () => {
    const diagnosticBase = fixtureRoot();
    const laterCwd = fixtureRoot();
    prepareProfile(diagnosticBase);
    prepareProfile(laterCwd);
    await execa("git", ["init"], { cwd: diagnosticBase });
    await execa("git", ["init"], { cwd: laterCwd });
    await execa(
      "git",
      ["remote", "add", "origin", "https://github.com/SmarterGPT/not-the-diagnostic-base.git"],
      { cwd: laterCwd }
    );

    await withoutProfileEnvironment(async () => {
      const previousCwd = process.cwd();
      try {
        process.chdir(laterCwd);
        const result = await new WorkspaceDiagnosticsService().run({ baseDir: diagnosticBase });
        expect(result).toMatchObject({
          diagnosticBase: path.resolve(diagnosticBase),
          github: { detected: false },
          git: { status: "ok" },
        });
      } finally {
        process.chdir(previousCwd);
      }
    });
  });
});

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lexrunner-workspace-doctor-git-"));
  roots.push(root);
  return root;
}

function prepareProfile(root: string): void {
  const profile = path.join(root, ".smartergpt");
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, "profile.yml"), "role: development\n");
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
