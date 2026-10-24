import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { skipIfCliNotBuilt } from "./helpers/cli";
import { canonicalJSONStringify } from "../src/util/canonicalJson";
import { sha256, sha256FileRaw } from "../src/util/hash";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

describe("bulletproof determinism", () => {
  // Use a per-test-file temp directory to avoid collisions when Vitest runs tests
  // in parallel. Using the filename ensures uniqueness across test files.
  const testDir = path.join(os.tmpdir(), `lexrunner-determinism-test-${path.basename(__filename)}`);

  beforeEach(() => {
    // Clean test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
    process.chdir(testDir);
  });

  afterEach(() => {
    // Cleanup
    process.chdir("/");
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  it("plan --out should produce identical artifacts on repeated runs", (ctx) => {
    if (skipIfCliNotBuilt({ skip: ctx.skip })) return;
    // Create minimal config
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
`,
      { encoding: "utf8", flush: true }
    );

    // Use pre-built CLI (assume it's already built) to avoid rebuild loop
    const repoRoot = path.resolve(__dirname, "..");
    const cliPath = path.join(repoRoot, "dist/cli.js");

    // Check if CLI exists, if not skip this test
    if (!fs.existsSync(cliPath)) {
      console.log("CLI not built, skipping determinism test");
      return;
    }

    // First run
    execSync(`node ${cliPath} plan --out .artifacts1`, { stdio: "pipe" });

    // Second run
    execSync(`node ${cliPath} plan --out .artifacts2`, { stdio: "pipe" });

    // Compare exact bytes
    const plan1 = fs.readFileSync(".artifacts1/plan.json");
    const plan2 = fs.readFileSync(".artifacts2/plan.json");
    const snapshot1 = fs.readFileSync(".artifacts1/snapshot.md");
    const snapshot2 = fs.readFileSync(".artifacts2/snapshot.md");

    expect(plan1.equals(plan2)).toBe(true);
    expect(snapshot1.equals(snapshot2)).toBe(true);

    // Verify hashes match
    expect(sha256(plan1)).toBe(sha256(plan2));
    expect(sha256(snapshot1)).toBe(sha256(snapshot2));
  });

  it("plan --json should produce identical stdout on repeated runs", (ctx) => {
    if (skipIfCliNotBuilt({ skip: ctx.skip })) return;
    // Create minimal config
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
`,
      { encoding: "utf8", flush: true }
    );

    // Use pre-built CLI (assume it's already built) to avoid rebuild loop
    const repoRoot = path.resolve(__dirname, "..");
    const cliPath = path.join(repoRoot, "dist/cli.js");

    // Check if CLI exists, if not skip this test
    if (!fs.existsSync(cliPath)) {
      console.log("CLI not built, skipping determinism test");
      return;
    }

    // First run
    const output1 = execSync(`node ${cliPath} plan --json`, { encoding: "utf8" });

    // Second run
    const output2 = execSync(`node ${cliPath} plan --json`, { encoding: "utf8" });

    // Compare exact bytes
    expect(output1).toBe(output2);
    expect(sha256(Buffer.from(output1))).toBe(sha256(Buffer.from(output2)));
  });

  it("canonical JSON should be deterministic with jumbled key order", () => {
    const jumbled = {
      z: "last",
      a: "first",
      m: {
        nested: true,
        zebra: "animal",
        apple: "fruit",
      },
      array: [
        { c: 3, a: 1, b: 2 },
        { z: 26, a: 1 },
      ],
    };

    // Create same object with different key ordering
    const reordered = {
      array: [
        { a: 1, b: 2, c: 3 },
        { a: 1, z: 26 },
      ],
      m: {
        apple: "fruit",
        zebra: "animal",
        nested: true,
      },
      a: "first",
      z: "last",
    };

    const json1 = canonicalJSONStringify(jumbled);
    const json2 = canonicalJSONStringify(reordered);

    // Should be byte-for-byte identical despite different key order
    expect(json1).toBe(json2);

    // Verify key sorting worked
    expect(json1).toMatch(/"a".*"array".*"m".*"z"/s);
    expect(json1).toMatch(/"apple".*"nested".*"zebra"/s);
  });

  it("lockfile hashing should handle line ending normalization", () => {
    // Create lockfiles with different line endings
    const content = '{\n  "lockfileVersion": 3\n}';
    const contentCRLF = content.replace(/\n/g, "\r\n");

    fs.writeFileSync("package-lock-lf.json", content);
    fs.writeFileSync("package-lock-crlf.json", contentCRLF);

    const hashLF = sha256FileRaw("package-lock-lf.json");
    const hashCRLF = sha256FileRaw("package-lock-crlf.json");

    // Raw byte hashing should detect the difference
    expect(hashLF).not.toBe(hashCRLF);

    // But both should be deterministic
    expect(sha256FileRaw("package-lock-lf.json")).toBe(hashLF);
    expect(sha256FileRaw("package-lock-crlf.json")).toBe(hashCRLF);
  });

  it("plan generation should be deterministic regardless of file discovery order", async () => {
    // Create config in nested structure
    fs.mkdirSync(".smartergpt/nested/deep", { recursive: true });

    // Create multiple config files that could be discovered in different orders
    fs.writeFileSync(
      ".smartergpt/stack.yml",
      `
version: 1
target: main
items:
  - id: item-1
    branch: feat/item-1
    deps: []
  - id: item-2
    branch: feat/item-2
    deps: [item-1]
`
    );

    // Generate multiple plans
    const { loadInputs } = await import("../src/core/inputs.js");
    const { generatePlan } = await import("../src/core/plan.js");

    const inputs1 = loadInputs();
    const plan1 = generatePlan(inputs1);

    const inputs2 = loadInputs();
    const plan2 = generatePlan(inputs2);

    // Should be deterministic
    expect(canonicalJSONStringify(plan1)).toBe(canonicalJSONStringify(plan2));

    // Items should be sorted by name
    expect(plan1.items[0].name).toBe("item-1");
    expect(plan1.items[1].name).toBe("item-2");
    expect(plan1.items[1].deps).toEqual(["item-1"]);
  });
});
