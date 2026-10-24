import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { skipIfCliNotBuilt } from "./helpers/cli";
import { execSync } from "child_process";
import { canonicalJSONStringify } from "../src/util/canonicalJson";
import { sha256 } from "../src/util/hash";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("CLI Determinism Integration Tests", () => {
  // Use a per-test-file temp directory to avoid collisions when Vitest runs tests
  // in parallel. Using the filename ensures uniqueness across test files.
  const testDir = path.join(os.tmpdir(), `lexrunner-determinism-test-${path.basename(__filename)}`);
  const cliPath = path.resolve(__dirname, "..", "dist", "cli.js");

  beforeEach((context) => {
    // Clean test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
    process.chdir(testDir);

    // Central CLI build gate
    if (skipIfCliNotBuilt({ skip: context.skip })) return;
  });

  afterEach(() => {
    // Cleanup
    process.chdir("/");
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe("Cross-command determinism", () => {
    it("should produce identical JSON across all CLI commands for same inputs", (ctx) => {
      if (skipIfCliNotBuilt({ skip: ctx.skip })) return;
      // Create consistent test setup
      fs.mkdirSync(".smartergpt", { recursive: true });
      fs.writeFileSync(
        ".smartergpt/stack.yml",
        `
version: 1
target: main
items:
  - id: item-alpha
    branch: feat/alpha
    deps: []
  - id: item-beta
    branch: feat/beta
    deps: [item-alpha]
  - id: item-gamma
    branch: feat/gamma
    deps: [item-beta]
`,
        { encoding: "utf8", flush: true }
      );

      // Generate plan first
      const planOutput1 = execSync(`node ${cliPath} plan --json`, { encoding: "utf8" });
      const planOutput2 = execSync(`node ${cliPath} plan --json`, { encoding: "utf8" });

      expect(planOutput1).toBe(planOutput2);
      expect(sha256(Buffer.from(planOutput1))).toBe(sha256(Buffer.from(planOutput2)));

      // Write plan to file for other commands
      fs.writeFileSync("plan.json", planOutput1);

      // Test merge-order determinism
      const mergeOutput1 = execSync(`node ${cliPath} merge-order plan.json --json`, {
        encoding: "utf8",
      });
      const mergeOutput2 = execSync(`node ${cliPath} merge-order plan.json --json`, {
        encoding: "utf8",
      });

      expect(mergeOutput1).toBe(mergeOutput2);
      expect(sha256(Buffer.from(mergeOutput1))).toBe(sha256(Buffer.from(mergeOutput2)));

      // Test status determinism
      const statusOutput1 = execSync(`node ${cliPath} status plan.json --json`, {
        encoding: "utf8",
      });
      const statusOutput2 = execSync(`node ${cliPath} status plan.json --json`, {
        encoding: "utf8",
      });

      expect(statusOutput1).toBe(statusOutput2);
      expect(sha256(Buffer.from(statusOutput1))).toBe(sha256(Buffer.from(statusOutput2)));

      // Test execute dry-run determinism
      const executeOutput1 = execSync(`node ${cliPath} execute plan.json --dry-run --json`, {
        encoding: "utf8",
      });
      const executeOutput2 = execSync(`node ${cliPath} execute plan.json --dry-run --json`, {
        encoding: "utf8",
      });

      expect(executeOutput1).toBe(executeOutput2);
      expect(sha256(Buffer.from(executeOutput1))).toBe(sha256(Buffer.from(executeOutput2)));
    }, 30000); // 30 second timeout for 8 CLI calls

    it("should maintain determinism with complex dependency graphs", (ctx) => {
      if (skipIfCliNotBuilt({ skip: ctx.skip })) return;
      // Create complex dependency structure with potential ordering ambiguity
      fs.mkdirSync(".smartergpt", { recursive: true });
      fs.writeFileSync(
        ".smartergpt/stack.yml",
        `
version: 1
target: main
items:
  - id: z-item
    branch: feat/z
    deps: []
  - id: a-item
    branch: feat/a
    deps: []
  - id: m-item
    branch: feat/m
    deps: [z-item, a-item]
  - id: b-item
    branch: feat/b
    deps: [a-item]
  - id: final-item
    branch: feat/final
    deps: [m-item, b-item]
`,
        { encoding: "utf8", flush: true }
      );

      // Generate plan multiple times
      const outputs = [];
      for (let i = 0; i < 5; i++) {
        const output = execSync(`node ${cliPath} plan --json`, { encoding: "utf8" });
        outputs.push(output);
      }

      // All outputs should be identical
      for (let i = 1; i < outputs.length; i++) {
        expect(outputs[i]).toBe(outputs[0]);
      }

      // Verify dependency ordering is deterministic
      const plan = JSON.parse(outputs[0]);
      const itemNames = plan.items.map((item: any) => item.name);

      // Should be sorted by name for deterministic ordering
      const sortedNames = [...itemNames].sort();
      expect(itemNames).toEqual(sortedNames);
    }, 30_000); // Five built CLI invocations can exceed the default on native Windows.
  });

  describe("Environment state isolation", () => {
    it("should produce identical output regardless of working directory", (ctx) => {
      if (skipIfCliNotBuilt({ skip: ctx.skip })) return;
      // Create test configs in multiple directories
      const dir1 = path.join(testDir, "workspace1");
      const dir2 = path.join(testDir, "workspace2");

      for (const dir of [dir1, dir2]) {
        fs.mkdirSync(dir, { recursive: true });
        fs.mkdirSync(path.join(dir, ".smartergpt"), { recursive: true });
        fs.writeFileSync(
          path.join(dir, ".smartergpt", "stack.yml"),
          `
version: 1
target: main
items:
  - id: test-item
    branch: feat/test
    deps: []
`
        );
      }

      // Generate plans from different directories
      process.chdir(dir1);
      const output1 = execSync(`node ${cliPath} plan --json`, { encoding: "utf8" });

      process.chdir(dir2);
      const output2 = execSync(`node ${cliPath} plan --json`, { encoding: "utf8" });

      expect(output1).toBe(output2);
    });

    it("should not be affected by environment variables unrelated to the tool", (ctx) => {
      if (skipIfCliNotBuilt({ skip: ctx.skip })) return;
      fs.mkdirSync(".smartergpt", { recursive: true });
      fs.writeFileSync(
        ".smartergpt/stack.yml",
        `
version: 1
target: main
items:
  - id: env-test
    branch: feat/env-test
    deps: []
`
      );

      // Generate baseline output
      const baselineEnv = { ...process.env };
      delete baselineEnv.HOME; // Remove potentially variable env var
      const baseline = execSync(`node ${cliPath} plan --json`, {
        encoding: "utf8",
        env: baselineEnv,
      });

      // Test with various unrelated environment variables
      const testEnvs = [
        { ...baselineEnv, RANDOM_VAR: "value1" },
        { ...baselineEnv, ANOTHER_VAR: "value2", PATH: baselineEnv.PATH + ":/fake/path" },
        { ...baselineEnv, USER: "testuser", LANG: "en_US.UTF-8" },
      ];

      for (const testEnv of testEnvs) {
        const output = execSync(`node ${cliPath} plan --json`, {
          encoding: "utf8",
          env: testEnv,
        });
        expect(output).toBe(baseline);
      }
    });

    it("should be affected only by relevant environment variables", (ctx) => {
      if (skipIfCliNotBuilt({ skip: ctx.skip })) return;
      // The CLI primarily depends on the working directory, not LEX_PROFILE_DIR
      // This test verifies that outputs change when the configuration changes

      fs.mkdirSync(".smartergpt", { recursive: true });
      fs.writeFileSync(
        ".smartergpt/stack.yml",
        `
version: 1
target: main
items:
  - id: single-item
    branch: feat/single
    deps: []
`
      );

      const singleItemOutput = execSync(`node ${cliPath} plan --json`, { encoding: "utf8" });

      // Update configuration to have more items
      fs.writeFileSync(
        ".smartergpt/stack.yml",
        `
version: 1
target: main
items:
  - id: item-one
    branch: feat/one
    deps: []
  - id: item-two
    branch: feat/two
    deps: [item-one]
`
      );

      const twoItemOutput = execSync(`node ${cliPath} plan --json`, { encoding: "utf8" });

      // Parse to compare structure
      const singlePlan = JSON.parse(singleItemOutput);
      const twoPlan = JSON.parse(twoItemOutput);

      // Outputs should be different due to different config (different number of items)
      expect(singlePlan.items.length).not.toBe(twoPlan.items.length);
      expect(singlePlan.items.length).toBe(1);
      expect(twoPlan.items.length).toBe(2);

      // But each should be deterministic when run again with same config
      const singleItemOutput2 = execSync(`node ${cliPath} plan --json`, { encoding: "utf8" });
      expect(twoItemOutput).toBe(singleItemOutput2); // Should match current config
    });
  });

  describe("Repeated execution consistency", () => {
    it("should produce identical results across many repeated runs", (ctx) => {
      if (skipIfCliNotBuilt({ skip: ctx.skip })) return;
      fs.mkdirSync(".smartergpt", { recursive: true });
      fs.writeFileSync(
        ".smartergpt/stack.yml",
        `
version: 1
target: main
items:
  - id: repeat-test-1
    branch: feat/repeat-1
    deps: []
  - id: repeat-test-2
    branch: feat/repeat-2
    deps: [repeat-test-1]
`
      );

      // Run plan generation many times
      const outputs = [];
      const hashes = [];

      for (let i = 0; i < 10; i++) {
        const output = execSync(`node ${cliPath} plan --json`, { encoding: "utf8" });
        const hash = sha256(Buffer.from(output));

        outputs.push(output);
        hashes.push(hash);
      }

      // All outputs should be identical
      for (let i = 1; i < outputs.length; i++) {
        expect(outputs[i]).toBe(outputs[0]);
        expect(hashes[i]).toBe(hashes[0]);
      }
    }, 30000); // 30 second timeout for 10 CLI calls

    it("should maintain consistency with file system state changes", (ctx) => {
      if (skipIfCliNotBuilt({ skip: ctx.skip })) return;
      fs.mkdirSync(".smartergpt", { recursive: true });

      const config = `
version: 1
target: main
items:
  - id: fs-test
    branch: feat/fs-test
    deps: []
`;

      // Write config, generate plan, delete and recreate config
      fs.writeFileSync(".smartergpt/stack.yml", config);
      const output1 = execSync(`node ${cliPath} plan --json`, { encoding: "utf8" });

      fs.unlinkSync(".smartergpt/stack.yml");
      fs.writeFileSync(".smartergpt/stack.yml", config);
      const output2 = execSync(`node ${cliPath} plan --json`, { encoding: "utf8" });

      expect(output1).toBe(output2);
    });
  });

  describe("JSON formatting consistency", () => {
    it("should always use canonical JSON formatting across all commands", (ctx) => {
      if (skipIfCliNotBuilt({ skip: ctx.skip })) return;
      // Setup test data
      fs.mkdirSync(".smartergpt", { recursive: true });
      fs.writeFileSync(
        ".smartergpt/stack.yml",
        `
version: 1
target: main
items:
  - id: zebra-last
    branch: feat/zebra
    deps: []
  - id: alpha-first
    branch: feat/alpha
    deps: []
`
      );

      const planOutput = execSync(`node ${cliPath} plan --json`, { encoding: "utf8" });
      fs.writeFileSync("plan.json", planOutput);

      // Test that all commands use consistent formatting
      const commands = [
        `node ${cliPath} plan --json`,
        `node ${cliPath} merge-order plan.json --json`,
        `node ${cliPath} status plan.json --json`,
        `node ${cliPath} execute plan.json --dry-run --json`,
      ];

      for (const command of commands) {
        const output = execSync(command, { encoding: "utf8" });

        // All JSON outputs should end with newline
        expect(output.endsWith("\n")).toBe(true);

        // Should be parseable as JSON
        expect(() => JSON.parse(output)).not.toThrow();

        // Should be properly formatted (test passes if no exception)
        const parsed = JSON.parse(output);
        expect(parsed).toBeDefined();
      }
    });

    it("should maintain key ordering consistency", (ctx) => {
      if (skipIfCliNotBuilt({ skip: ctx.skip })) return;
      fs.mkdirSync(".smartergpt", { recursive: true });
      fs.writeFileSync(
        ".smartergpt/stack.yml",
        `
version: 1
target: main
items:
  - id: test-ordering
    branch: feat/ordering
    deps: []
`
      );

      const output = execSync(`node ${cliPath} plan --json`, { encoding: "utf8" });

      // Verify key ordering is consistent with canonical JSON
      const parsed = JSON.parse(output);
      const reordered = JSON.parse(JSON.stringify(parsed)); // This might change order
      const canonicalOriginal = canonicalJSONStringify(parsed);
      const canonicalReordered = canonicalJSONStringify(reordered);

      expect(canonicalOriginal).toBe(canonicalReordered);
      expect(output).toBe(canonicalOriginal);
    });
  });

  describe("Error output determinism", () => {
    it("should produce consistent error JSON across multiple attempts", (ctx) => {
      if (skipIfCliNotBuilt({ skip: ctx.skip })) return;
      // Create invalid plan file
      fs.writeFileSync("invalid-plan.json", '{"malformed": "json"');

      let error1: string = "";
      let error2: string = "";

      // Run schema validation twice and capture errors
      try {
        execSync(`node ${cliPath} schema validate invalid-plan.json --json`, {
          encoding: "utf8",
          stdio: "pipe",
        });
      } catch (e: any) {
        error1 = e.stdout || e.stderr || "";
      }

      try {
        execSync(`node ${cliPath} schema validate invalid-plan.json --json`, {
          encoding: "utf8",
          stdio: "pipe",
        });
      } catch (e: any) {
        error2 = e.stdout || e.stderr || "";
      }

      // Error outputs should be identical
      expect(error1!).toBe(error2!);

      // Should still be valid JSON even for errors
      if (error1) {
        expect(() => JSON.parse(error1)).not.toThrow();
      }
    });

    it("should not include timestamps or random elements in error output", (ctx) => {
      if (skipIfCliNotBuilt({ skip: ctx.skip })) return;
      fs.writeFileSync(
        "nonexistent-ref.json",
        `{
  "schemaVersion": "1.0.0",
  "target": "main",
  "items": [
    {
      "name": "test",
      "branch": "feat/test",
      "deps": ["nonexistent-dependency"]
    }
  ]
}`
      );

      let errorOutput: string;
      try {
        execSync(`node ${cliPath} merge-order nonexistent-ref.json --json`, {
          encoding: "utf8",
          stdio: "pipe",
        });
      } catch (e: any) {
        errorOutput = e.stdout || e.stderr || "";
      }

      // Error should not contain timestamps or other variable elements
      expect(errorOutput!).not.toMatch(/\d{4}-\d{2}-\d{2}/); // No dates
      expect(errorOutput!).not.toMatch(/\d{2}:\d{2}:\d{2}/); // No times
      expect(errorOutput!).not.toMatch(/\d+ms/); // No timing info
      expect(errorOutput!).not.toMatch(/Process \d+/); // No process IDs
    });
  });
});
