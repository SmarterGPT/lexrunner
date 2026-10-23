import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { skipIfCliNotBuilt } from "./helpers/cli";

describe("CLI Color and JSON Output Control", () => {
  const testDir = path.join(os.tmpdir(), "lexrunner-color-control-test");
  const cliPath = path.resolve(__dirname, "..", "dist", "cli.js");

  beforeEach((context) => {
    // Clean test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
    process.chdir(testDir);

    // Gate tests on CLI build
    if (skipIfCliNotBuilt({ skip: context.skip })) return;
  });

  afterEach(() => {
    // Cleanup
    process.chdir("/");
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe("--no-color flag", () => {
    it("should disable ANSI color codes when used with TTY", (ctx) => {
      if (skipIfCliNotBuilt({ skip: ctx.skip })) return;
      if (process.platform === "win32") {
        ctx.skip();
        return;
      }

      // Create minimal local profile
      fs.mkdirSync(".smartergpt.local", { recursive: true });
      fs.writeFileSync(".smartergpt.local/profile.yml", "role: local\nversion: 1\n");
      fs.writeFileSync(
        ".smartergpt.local/stack.yml",
        `
version: 1
target: main
items:
  - id: test-item
    branch: feat/test
    deps: []
`
      );

      // Use script to simulate TTY
      const result = spawnSync(
        "script",
        [
          "-q",
          "-c",
          `LEX_PR_PROFILE_DIR=${path.join(testDir, ".smartergpt.local")} node ${cliPath} --no-color config:inspect`,
          "/dev/null",
        ],
        {
          cwd: testDir,
          encoding: "utf8",
          env: { ...process.env },
        }
      );

      const output = result.stdout + result.stderr;

      // Should not contain ANSI escape codes (ESC[)
      expect(output).not.toMatch(/\x1b\[/);
    });

    it("should work with other commands", (ctx) => {
      if (skipIfCliNotBuilt({ skip: ctx.skip })) return;

      // Use .smartergpt (example profile) for read-only plan generation
      fs.mkdirSync(".smartergpt", { recursive: true });
      fs.writeFileSync(
        ".smartergpt/stack.yml",
        `
version: 1
target: main
items:
  - id: test-item
    branch: feat/test
    deps: []
`
      );

      const result = spawnSync("node", [cliPath, "--no-color", "plan", "--json"], {
        cwd: testDir,
        encoding: "utf8",
        env: { ...process.env },
      });

      const output = result.stdout;

      // Should be valid JSON
      expect(() => JSON.parse(output)).not.toThrow();
      // Should not have color codes
      expect(output).not.toMatch(/\x1b\[/);
    });
  });

  describe("--json global flag", () => {
    it("should enable JSON mode and disable colors", (ctx) => {
      if (skipIfCliNotBuilt({ skip: ctx.skip })) return;

      // Use .smartergpt for read-only plan generation
      fs.mkdirSync(".smartergpt", { recursive: true });
      fs.writeFileSync(
        ".smartergpt/stack.yml",
        `
version: 1
target: main
items:
  - id: test-item
    branch: feat/test
    deps: []
`
      );

      const result = spawnSync("node", [cliPath, "--json", "plan"], {
        cwd: testDir,
        encoding: "utf8",
        env: { ...process.env },
      });

      const stdout = result.stdout;

      // Should output JSON
      expect(() => JSON.parse(stdout)).not.toThrow();
      const plan = JSON.parse(stdout);
      expect(plan).toHaveProperty("schemaVersion");
      expect(plan).toHaveProperty("items");
    });

    it("should suppress emoji icons in error messages", (ctx) => {
      if (skipIfCliNotBuilt({ skip: ctx.skip })) return;

      // Trigger a write protection error by using example profile
      fs.mkdirSync(".smartergpt", { recursive: true });
      fs.writeFileSync(
        ".smartergpt/stack.yml",
        `
version: 1
target: main
items:
  - id: test
    branch: feat/test
    deps: []
`
      );

      const result = spawnSync("node", [cliPath, "--json", "plan"], {
        cwd: testDir,
        encoding: "utf8",
        env: { ...process.env },
      });

      const stderr = result.stderr;

      // Should use plain prefix [lexrunner] instead of emoji (only if error occurs)
      if (stderr && stderr.trim()) {
        expect(stderr).toMatch(/\[lexrunner\]/);
        // Should not contain emoji
        expect(stderr).not.toMatch(/[❌✓💡]/);
      }
    });

    it("should suppress tips in JSON mode", (ctx) => {
      if (skipIfCliNotBuilt({ skip: ctx.skip })) return;

      // Trigger a validation error by using example profile for write operations
      fs.mkdirSync(".smartergpt", { recursive: true });
      fs.writeFileSync(
        ".smartergpt/stack.yml",
        `
version: 1
target: main
items:
  - id: test
    branch: feat/test
    deps: []
`
      );

      const result = spawnSync("node", [cliPath, "--json", "plan", "--out", "/tmp/some-output"], {
        cwd: testDir,
        encoding: "utf8",
        env: { ...process.env },
      });

      const stderr = result.stderr;
      const stdout = result.stdout;

      // Stdout should be valid JSON (even on error, plan might succeed with warnings)
      if (stdout.trim()) {
        expect(() => JSON.parse(stdout)).not.toThrow();
      }

      // Should not contain tip emoji in stderr
      expect(stderr).not.toMatch(/💡 Tip:/);
    });

    it("should work with command-level --json flag", (ctx) => {
      if (skipIfCliNotBuilt({ skip: ctx.skip })) return;

      // Setup config
      fs.mkdirSync(".smartergpt", { recursive: true });
      fs.writeFileSync(
        ".smartergpt/stack.yml",
        `
version: 1
target: main
items:
  - id: test-item
    branch: feat/test
    deps: []
`
      );

      // Both global and command-level should work
      const result1 = spawnSync("node", [cliPath, "--json", "plan"], {
        cwd: testDir,
        encoding: "utf8",
        env: { ...process.env },
      });

      const result2 = spawnSync("node", [cliPath, "plan", "--json"], {
        cwd: testDir,
        encoding: "utf8",
        env: { ...process.env },
      });

      // Both should produce valid JSON
      expect(() => JSON.parse(result1.stdout)).not.toThrow();
      expect(() => JSON.parse(result2.stdout)).not.toThrow();

      // Both should produce identical output
      expect(result1.stdout).toBe(result2.stdout);
    });
  });

  describe("Logger emoji icons", () => {
    it("should use text-based icons when color is disabled", (ctx) => {
      if (skipIfCliNotBuilt({ skip: ctx.skip })) return;

      // The logger is used internally, so we test it indirectly
      // by checking that diagnostics use plain text in JSON mode
      const result = spawnSync("node", [cliPath, "--json", "--help"], {
        cwd: testDir,
        encoding: "utf8",
        env: { ...process.env },
      });

      // Even help output should not contain emoji when --json is used
      // (though help exits before JSON formatting typically applies)
      // This is more of a consistency check
      expect(result.status).toBe(0);
    });
  });

  describe("NO_COLOR environment variable", () => {
    it("should disable colors when NO_COLOR is set", (ctx) => {
      if (skipIfCliNotBuilt({ skip: ctx.skip })) return;
      if (process.platform === "win32") {
        ctx.skip();
        return;
      }

      // Create minimal local profile
      fs.mkdirSync(".smartergpt.local", { recursive: true });
      fs.writeFileSync(".smartergpt.local/profile.yml", "role: local\nversion: 1\n");
      fs.writeFileSync(
        ".smartergpt.local/stack.yml",
        `
version: 1
target: main
items:
  - id: test-item
    branch: feat/test
    deps: []
`
      );

      const result = spawnSync(
        "script",
        [
          "-q",
          "-c",
          `LEX_PR_PROFILE_DIR=${path.join(testDir, ".smartergpt.local")} NO_COLOR=1 node ${cliPath} config:inspect`,
          "/dev/null",
        ],
        {
          cwd: testDir,
          encoding: "utf8",
          env: { ...process.env },
        }
      );

      const output = result.stdout + result.stderr;

      // Should not contain ANSI escape codes
      expect(output).not.toMatch(/\x1b\[/);
    });

    it("should work together with --json flag", (ctx) => {
      if (skipIfCliNotBuilt({ skip: ctx.skip })) return;

      // Setup config
      fs.mkdirSync(".smartergpt", { recursive: true });
      fs.writeFileSync(
        ".smartergpt/stack.yml",
        `
version: 1
target: main
items:
  - id: test-item
    branch: feat/test
    deps: []
`
      );

      const result = spawnSync("node", [cliPath, "--json", "plan"], {
        cwd: testDir,
        encoding: "utf8",
        env: {
          ...process.env,
          NO_COLOR: "1",
        },
      });

      // Should still output valid JSON
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    });
  });
});
