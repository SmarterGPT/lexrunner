/**
 * Tests for init command with --json flag support
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execa } from "execa";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";

// Path to the built CLI
const CLI_PATH = path.resolve(__dirname, "../dist/cli.js");

const INIT_ROUTE_CASES = [
  { name: "standard without force", args: [] },
  { name: "standard with force", args: ["--force"] },
  { name: "enterprise without force", args: ["--enterprise"] },
  { name: "enterprise with force", args: ["--enterprise", "--force"] },
] as const;

const PROFILE_VALIDATION_CASES = [
  { name: "malformed", manifest: "role: [PRIVATE-SENTINEL\n" },
  { name: "missing", manifest: undefined },
  { name: "non-scalar", manifest: "role:\n  - example\n" },
] as const;

const PROFILE_ROUTE_CASES = PROFILE_VALIDATION_CASES.flatMap((profileCase) =>
  INIT_ROUTE_CASES.map((routeCase) => ({ profileCase, routeCase }))
);

describe("init command with --json flag", () => {
  let testDir: string;

  beforeEach(async () => {
    // Create a temporary test directory
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "lexrunner-init-json-"));
  });

  afterEach(async () => {
    // Clean up test directory
    await fs.remove(testDir);
  });

  it("should output JSON envelope on success", async () => {
    const result = await execa(
      "node",
      [CLI_PATH, "init", "--non-interactive", "--json", "--profile-dir", ".smartergpt.local"],
      {
        cwd: testDir,
        reject: false,
      }
    );

    expect(result.exitCode).toBe(0);

    // Parse JSON output
    const output = JSON.parse(result.stdout);

    // Verify envelope structure
    expect(output).toHaveProperty("success");
    expect(output).toHaveProperty("data");
    expect(output).toHaveProperty("meta");

    // Verify success
    expect(output.success).toBe(true);

    // Verify data payload
    expect(output.data).toHaveProperty("profileDir");
    expect(output.data).toHaveProperty("message");
    expect(output.data.profileDir).toContain(".smartergpt.local");

    // Verify metadata
    expect(output.meta).toHaveProperty("command");
    expect(output.meta).toHaveProperty("timestamp");
    expect(output.meta).toHaveProperty("version");
    expect(output.meta.command).toBe("lex-pr init");
  });

  it("should output JSON error envelope when configuration exists", async () => {
    // Create existing complete configuration
    const profileDir = path.join(testDir, ".smartergpt.local");
    await fs.ensureDir(profileDir);
    await fs.writeFile(path.join(profileDir, "intent.md"), "# Existing config");
    await fs.writeFile(path.join(profileDir, "scope.yml"), "target: main");
    await fs.writeFile(path.join(profileDir, "deps.yml"), "items: []");
    await fs.writeFile(path.join(profileDir, "gates.yml"), "gates: []");
    await fs.writeFile(path.join(profileDir, "profile.yml"), "role: local");

    const result = await execa(
      "node",
      [CLI_PATH, "init", "--non-interactive", "--json", "--profile-dir", ".smartergpt.local"],
      {
        cwd: testDir,
        reject: false,
      }
    );

    expect(result.exitCode).toBe(1);

    // Parse JSON output
    const output = JSON.parse(result.stdout);

    // Verify envelope structure
    expect(output).toHaveProperty("success");
    expect(output).toHaveProperty("error");
    expect(output).toHaveProperty("meta");

    // Verify error
    expect(output.success).toBe(false);
    expect(output.error).toHaveProperty("code");
    expect(output.error).toHaveProperty("message");
    expect(output.error.code).toBe("EINIT");
    expect(output.error.message).toContain("already exists");
  });

  it("should create workspace files successfully", async () => {
    const profileDir = path.join(testDir, ".smartergpt.local");

    const result = await execa(
      "node",
      [CLI_PATH, "init", "--non-interactive", "--json", "--profile-dir", ".smartergpt.local"],
      {
        cwd: testDir,
        reject: false,
      }
    );

    expect(result.exitCode).toBe(0);

    // Verify files were created
    expect(await fs.pathExists(path.join(profileDir, "intent.md"))).toBe(true);
    expect(await fs.pathExists(path.join(profileDir, "scope.yml"))).toBe(true);
    expect(await fs.pathExists(path.join(profileDir, "deps.yml"))).toBe(true);
    expect(await fs.pathExists(path.join(profileDir, "gates.yml"))).toBe(true);
    expect(await fs.pathExists(path.join(profileDir, "profile.yml"))).toBe(true);
  });

  it("should respect --force flag in JSON mode", async () => {
    // Create initial configuration
    await execa(
      "node",
      [CLI_PATH, "init", "--non-interactive", "--json", "--profile-dir", ".smartergpt.local"],
      {
        cwd: testDir,
      }
    );

    // Try to init again with --force
    const result = await execa(
      "node",
      [
        CLI_PATH,
        "init",
        "--non-interactive",
        "--json",
        "--force",
        "--profile-dir",
        ".smartergpt.local",
      ],
      {
        cwd: testDir,
        reject: false,
      }
    );

    expect(result.exitCode).toBe(0);

    const output = JSON.parse(result.stdout);
    expect(output.success).toBe(true);
  });

  it.each(INIT_ROUTE_CASES)(
    "should preserve the EWRITE_PROTECTED contract and tree for a protected profile in $name mode",
    async ({ args }) => {
      const profileDir = path.join(testDir, ".smartergpt.local");
      await fs.ensureDir(path.join(profileDir, "nested"));
      await fs.writeFile(path.join(profileDir, "profile.yml"), "role: example\nname: Protected\n");
      await fs.writeFile(path.join(profileDir, "intent.md"), "# PROTECTED-INTENT\n");
      await fs.writeFile(path.join(profileDir, "scope.yml"), "version: 1\ntarget: protected\n");
      await fs.writeFile(path.join(profileDir, "deps.yml"), "version: 1\ndepends_on: []\n");
      await fs.writeFile(path.join(profileDir, "gates.yml"), "CUSTOM-GATES-SENTINEL\n");
      await fs.writeFile(path.join(profileDir, "nested", "sentinel.txt"), "preserve-me\n");

      const workflowsDir = path.join(testDir, ".github", "workflows");
      await fs.ensureDir(workflowsDir);
      await fs.writeFile(path.join(workflowsDir, "existing.yml"), "name: Existing\n");
      const before = snapshotTree(testDir);

      const result = await execa(
        "node",
        [
          CLI_PATH,
          "workspace",
          "init",
          "--non-interactive",
          "--json",
          "--profile-dir",
          ".smartergpt.local",
          ...args,
        ],
        { cwd: testDir, reject: false }
      );

      expect(result.exitCode).toBe(2);
      const output = JSON.parse(result.stdout);
      expect(output).toMatchObject({
        success: false,
        error: { code: "EWRITE_PROTECTED" },
      });
      expect(output.error.message).toContain('role="example" (read-only)');
      expect(snapshotTree(testDir)).toEqual(before);
      expect(await fs.pathExists(path.join(profileDir, "runner"))).toBe(false);
      expect(await fs.pathExists(path.join(testDir, ".github", "copilot-instructions.md"))).toBe(
        false
      );
      expect(
        await fs.pathExists(path.join(testDir, ".github", "workflows", "merge-weave.yaml"))
      ).toBe(false);
    }
  );

  it("should return the same protected-write contract for default and explicit profile routing", async () => {
    const profileDir = path.join(testDir, ".smartergpt.local");
    await fs.ensureDir(profileDir);
    await fs.writeFile(path.join(profileDir, "profile.yml"), "role: example\nname: Protected\n");
    await fs.writeFile(path.join(profileDir, "gates.yml"), "AUTHORED-GATES-SENTINEL\n");
    const before = snapshotTree(testDir);

    for (const args of [[], ["--profile-dir", ".smartergpt.local"]]) {
      const result = await execa(
        "node",
        [CLI_PATH, "workspace", "init", "--non-interactive", "--json", ...args],
        { cwd: testDir, reject: false }
      );

      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        success: false,
        error: { code: "EWRITE_PROTECTED" },
      });
      expect(snapshotTree(testDir)).toEqual(before);
    }
  });

  it.each(PROFILE_ROUTE_CASES)(
    "should reject a $profileCase.name existing profile without mutation in $routeCase.name mode",
    async ({ profileCase, routeCase }) => {
      const profileDir = path.join(testDir, ".smartergpt.local");
      await fs.ensureDir(path.join(profileDir, "nested"));
      await fs.writeFile(path.join(profileDir, "nested", "sentinel.txt"), "preserve-me\n");
      if (profileCase.manifest !== undefined) {
        await fs.writeFile(path.join(profileDir, "profile.yml"), profileCase.manifest);
      }

      const workflowsDir = path.join(testDir, ".github", "workflows");
      await fs.ensureDir(workflowsDir);
      await fs.writeFile(path.join(workflowsDir, "existing.yml"), "name: Existing\n");
      const before = snapshotTree(testDir);

      const result = await execa(
        "node",
        [
          CLI_PATH,
          "workspace",
          "init",
          "--non-interactive",
          "--json",
          "--profile-dir",
          ".smartergpt.local",
          ...routeCase.args,
        ],
        { cwd: testDir, reject: false }
      );

      const output = JSON.parse(result.stdout);
      if (profileCase.name === "non-scalar") {
        expect(result.exitCode).toBe(2);
        expect(output).toMatchObject({
          success: false,
          error: { code: "EWRITE_PROTECTED" },
        });
        expect(output.error.message).toContain("invalid array role");
      } else {
        expect(result.exitCode).toBe(1);
        expect(output).toMatchObject({
          success: false,
          error: {
            code: "EINIT_FAILED",
            details: { name: "ProfileResolverError" },
          },
        });
        const disposition = profileCase.name === "malformed" ? "has an invalid" : "is missing";
        expect(output.error.message).toBe(
          `Profile directory "${profileDir}" (from --profile-dir) ${disposition} profile.yml manifest`
        );
        expect(output.error.message).not.toContain("PRIVATE-SENTINEL");
      }

      expect(snapshotTree(testDir)).toEqual(before);
      expect(await fs.pathExists(path.join(profileDir, "runner"))).toBe(false);
      expect(await fs.pathExists(path.join(testDir, ".github", "copilot-instructions.md"))).toBe(
        false
      );
      expect(
        await fs.pathExists(path.join(testDir, ".github", "workflows", "merge-weave.yaml"))
      ).toBe(false);
    }
  );

  it.each([
    {
      name: "role flip",
      mutate: (manifestPath: string) => fs.writeFileSync(manifestPath, "role: example\n"),
    },
    { name: "manifest deletion", mutate: (manifestPath: string) => fs.removeSync(manifestPath) },
  ])(
    "should reject an interactive $name after admission without further mutation",
    async ({ mutate }) => {
      const profileDir = path.join(testDir, ".smartergpt.local");
      const manifestPath = path.join(profileDir, "profile.yml");
      await fs.ensureDir(path.join(profileDir, "nested"));
      await fs.writeFile(manifestPath, "role: local\nname: Initially Writable\n");
      await fs.writeFile(path.join(profileDir, "nested", "sentinel.txt"), "preserve-me\n");

      const child = execa(
        "node",
        [CLI_PATH, "workspace", "init", "--profile-dir", ".smartergpt.local"],
        {
          cwd: testDir,
          reject: false,
          stdin: "pipe",
          env: { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "" },
        }
      );

      try {
        await waitForOutput(child.stdout, "GitHub token (optional, press Enter to skip):");
      } catch (error) {
        child.kill();
        await child;
        throw error;
      }

      mutate(manifestPath);
      const afterHumanMutation = snapshotTree(testDir);
      child.stdin?.end("\n");
      const result = await child;

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("point-in-time profile write guard");
      expect(result.stderr).toContain("not a portable lock");
      expect(snapshotTree(testDir)).toEqual(afterHumanMutation);
      expect(await fs.pathExists(path.join(profileDir, "runner"))).toBe(false);
    },
    30_000
  );

  it("should reject an interactive claim of an initially absent profile path", async () => {
    const profileDir = path.join(testDir, ".smartergpt.local");
    const child = execa(
      "node",
      [CLI_PATH, "workspace", "init", "--profile-dir", ".smartergpt.local"],
      {
        cwd: testDir,
        reject: false,
        stdin: "pipe",
        env: { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "" },
      }
    );

    try {
      await waitForOutput(child.stdout, "GitHub token (optional, press Enter to skip):");
    } catch (error) {
      child.kill();
      await child;
      throw error;
    }

    await fs.ensureDir(path.join(profileDir, "nested"));
    await fs.writeFile(path.join(profileDir, "profile.yml"), "role: local\nname: Claimed\n");
    await fs.writeFile(path.join(profileDir, "nested", "sentinel.txt"), "preserve-me\n");
    const afterClaim = snapshotTree(testDir);
    child.stdin?.end("\n");
    const result = await child;

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("point-in-time profile write guard");
    expect(result.stderr).toContain("not a portable lock");
    expect(snapshotTree(testDir)).toEqual(afterClaim);
    expect(await fs.pathExists(path.join(profileDir, "runner"))).toBe(false);
  }, 30_000);

  it("should detect routing-ancestor retargeting for an initially absent profile", async () => {
    const targetA = path.join(testDir, "target-a");
    const targetB = path.join(testDir, "target-b");
    const routePath = path.join(testDir, "route");
    const profileDir = path.join(routePath, "profile");
    await fs.ensureDir(targetA);
    await fs.ensureDir(targetB);
    fs.symlinkSync(targetA, routePath, process.platform === "win32" ? "junction" : "dir");
    expect(fs.lstatSync(routePath).isSymbolicLink()).toBe(true);

    const child = execa(
      "node",
      [CLI_PATH, "workspace", "init", "--profile-dir", path.join("route", "profile")],
      {
        cwd: testDir,
        reject: false,
        stdin: "pipe",
        env: { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "" },
      }
    );

    try {
      await waitForOutput(child.stdout, "GitHub token (optional, press Enter to skip):");
    } catch (error) {
      child.kill();
      await child;
      throw error;
    }

    fs.removeSync(routePath);
    fs.symlinkSync(targetB, routePath, process.platform === "win32" ? "junction" : "dir");
    const afterRetarget = snapshotTree(testDir);
    child.stdin?.end("\n");
    const result = await child;

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("point-in-time profile write guard");
    expect(result.stderr).toContain("not a portable lock");
    expect(snapshotTree(testDir)).toEqual(afterRetarget);
    expect(await fs.pathExists(profileDir)).toBe(false);
    expect(await fs.pathExists(path.join(targetA, "profile"))).toBe(false);
    expect(await fs.pathExists(path.join(targetB, "profile"))).toBe(false);
  }, 30_000);
});

function waitForOutput(
  stream: NodeJS.ReadableStream | null | undefined,
  expected: string
): Promise<void> {
  if (!stream) return Promise.reject(new Error("Child stdout was not piped"));

  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for child output: ${expected}`));
    }, 15_000);

    const onData = (chunk: string | Buffer): void => {
      output += chunk.toString();
      if (output.includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      stream.removeListener("data", onData);
      stream.removeListener("error", onError);
    };

    stream.on("data", onData);
    stream.on("error", onError);
  });
}

function snapshotTree(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};

  const visit = (directory: string, prefix: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) {
        snapshot[`${relative}/`] = "directory";
        visit(absolute, relative);
      } else if (stat.isSymbolicLink()) {
        snapshot[relative] = `symlink:${fs.readlinkSync(absolute)}`;
      } else {
        snapshot[relative] = `file:${fs.readFileSync(absolute).toString("base64")}`;
      }
    }
  };

  visit(root, "");
  return snapshot;
}
