import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { skipIfCliNotBuilt } from "./helpers/cli";
import { loadInputs } from "../src/core/inputs.js";
import { generatePlan } from "../src/core/plan.js";
import { executeGatesWithPolicy } from "../src/gates.js";
import { ExecutionState } from "../src/executionState.js";
import { MergeEligibilityEvaluator } from "../src/mergeEligibility.js";
import { canonicalJSONStringify } from "../src/util/canonicalJson.js";
import { sha256 } from "../src/util/hash.js";
import { loadPlan } from "../src/schema.js";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("E2E Determinism Harness", () => {
  const testDir = path.join(os.tmpdir(), "lexrunner-e2e-determinism");
  const repoRoot = path.resolve(__dirname, "..");

  beforeEach((context) => {
    // Clean test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
    process.chdir(testDir);

    if (skipIfCliNotBuilt({ skip: context.skip })) return;
  });

  afterEach(() => {
    // Cleanup
    process.chdir("/");
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe("Complete Workflow Determinism", () => {
    it("should produce identical results across multiple complete runs", async () => {
      // Create test configuration with gates
      fs.mkdirSync(".smartergpt", { recursive: true });
      fs.writeFileSync(
        ".smartergpt/stack.yml",
        `
version: 1
target: main
items:
  - id: item-1
    branch: feat/item-1
    deps: []
    gates:
      - name: lint
        run: bash -c "echo 'linting item-1'; exit 0"
      - name: test
        run: bash -c "echo 'testing item-1'; exit 0"
  - id: item-2
    branch: feat/item-2
    deps: [item-1]
    gates:
      - name: lint
        run: bash -c "echo 'linting item-2'; exit 0"
      - name: test
        run: bash -c "echo 'testing item-2'; exit 0"
  - id: item-3
    branch: feat/item-3
    deps: [item-1]
    gates:
      - name: lint
        run: bash -c "echo 'linting item-3'; exit 0"
  - id: item-4
    branch: feat/item-4
    deps: [item-2, item-3]
    gates:
      - name: integration
        run: bash -c "echo 'integration test'; exit 0"
`
      );

      // Run complete workflow multiple times
      const workflows = await Promise.all([
        runCompleteWorkflow(),
        runCompleteWorkflow(),
        runCompleteWorkflow(),
      ]);

      // Verify all workflows produce identical results
      const [workflow1, workflow2, workflow3] = workflows;

      // Plan determinism
      expect(workflow1.planJson).toBe(workflow2.planJson);
      expect(workflow2.planJson).toBe(workflow3.planJson);
      expect(sha256(Buffer.from(workflow1.planJson))).toBe(sha256(Buffer.from(workflow2.planJson)));

      // Execution state determinism (structure only, not gate outputs which include stdout)
      expect(workflow1.executionStateStructure).toEqual(workflow2.executionStateStructure);
      expect(workflow2.executionStateStructure).toEqual(workflow3.executionStateStructure);

      // Merge decisions determinism
      expect(workflow1.mergeDecisions).toEqual(workflow2.mergeDecisions);
      expect(workflow2.mergeDecisions).toEqual(workflow3.mergeDecisions);

      // Snapshot determinism
      expect(workflow1.snapshot).toBe(workflow2.snapshot);
      expect(workflow2.snapshot).toBe(workflow3.snapshot);
    }, 15_000);

    it("should maintain determinism across different working directories", async () => {
      // Create configuration in original directory
      fs.mkdirSync(".smartergpt", { recursive: true });
      const configContent = `
version: 1
target: main
items:
  - id: simple-item
    branch: feat/simple
    deps: []
    gates:
      - name: check
        run: bash -c "pwd && echo 'check passed'; exit 0"
`;
      fs.writeFileSync(".smartergpt/stack.yml", configContent);

      // Run workflow in current directory
      const workflow1 = await runCompleteWorkflow();

      // Create new directory and run same workflow
      const testDir2 = path.join(os.tmpdir(), "lexrunner-e2e-determinism-2");
      fs.mkdirSync(testDir2, { recursive: true });
      const originalDir = process.cwd();

      try {
        process.chdir(testDir2);
        fs.mkdirSync(".smartergpt", { recursive: true });
        fs.writeFileSync(".smartergpt/stack.yml", configContent);

        const workflow2 = await runCompleteWorkflow();

        // Plans should be identical despite different working directories
        expect(workflow1.planJson).toBe(workflow2.planJson);
        expect(workflow1.executionStateStructure).toEqual(workflow2.executionStateStructure);
        expect(workflow1.mergeDecisions).toEqual(workflow2.mergeDecisions);
        expect(workflow1.snapshot).toBe(workflow2.snapshot);
      } finally {
        process.chdir(originalDir);
        if (fs.existsSync(testDir2)) {
          fs.rmSync(testDir2, { recursive: true });
        }
      }
    });

    it("should handle environment variations deterministically", async () => {
      // Create configuration that uses environment variables
      fs.mkdirSync(".smartergpt", { recursive: true });
      fs.writeFileSync(
        ".smartergpt/stack.yml",
        `
version: 1
target: main
items:
  - id: env-item
    branch: feat/env-test
    deps: []
    gates:
      - name: env-check
        run: bash -c "echo 'NODE_ENV: $NODE_ENV'; exit 0"
        env:
          NODE_ENV: test
`
      );

      // Run with different system environments but same gate environments
      const originalEnv = process.env.NODE_ENV;

      try {
        // First run with NODE_ENV=production (should be overridden by gate env)
        process.env.NODE_ENV = "production";
        const workflow1 = await runCompleteWorkflow();

        // Second run with NODE_ENV=development (should be overridden by gate env)
        process.env.NODE_ENV = "development";
        const workflow2 = await runCompleteWorkflow();

        // Plans should be identical as gate environment should override system
        expect(workflow1.planJson).toBe(workflow2.planJson);
        expect(workflow1.executionStateStructure).toEqual(workflow2.executionStateStructure);
        expect(workflow1.mergeDecisions).toEqual(workflow2.mergeDecisions);
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it("should maintain artifact determinism with sorted keys and stable hashes", async () => {
      // Create configuration with multiple items to test sorting
      fs.mkdirSync(".smartergpt", { recursive: true });
      fs.writeFileSync(
        ".smartergpt/stack.yml",
        `
version: 1
target: main
items:
  - id: zebra-item
    branch: feat/zebra
    deps: []
    gates:
      - name: test
        run: bash -c "echo 'zebra test'; exit 0"
  - id: alpha-item
    branch: feat/alpha
    deps: []
    gates:
      - name: test
        run: bash -c "echo 'alpha test'; exit 0"
  - id: beta-item
    branch: feat/beta
    deps: [alpha-item, zebra-item]
    gates:
      - name: integration
        run: bash -c "echo 'beta integration'; exit 0"
`
      );

      const workflow = await runCompleteWorkflow();

      // Verify plan has sorted items
      const plan = JSON.parse(workflow.planJson);
      const itemNames = plan.items.map((item: any) => item.name);
      const sortedNames = [...itemNames].sort();
      expect(itemNames).toEqual(sortedNames);

      // Verify all JSON is canonical (no key order dependency)
      expect(() => JSON.parse(workflow.planJson)).not.toThrow();

      // Verify hash consistency
      const hash1 = sha256(Buffer.from(workflow.planJson));
      const hash2 = sha256(Buffer.from(canonicalJSONStringify(JSON.parse(workflow.planJson))));
      expect(hash1).toBe(hash2);
    });
  });

  /**
   * Run complete workflow and return all artifacts
   */
  async function runCompleteWorkflow() {
    // 1. Load inputs
    const inputs = loadInputs();

    // 2. Generate plan
    const plan = generatePlan(inputs);
    const validatedPlan = loadPlan(canonicalJSONStringify(plan));
    const planJson = canonicalJSONStringify(validatedPlan);

    // 3. Execute gates
    const executionState = new ExecutionState(validatedPlan);
    const artifactDir = path.join(process.cwd(), ".artifacts");

    // Create artifact directory
    if (!fs.existsSync(artifactDir)) {
      fs.mkdirSync(artifactDir, { recursive: true });
    }

    // Execute gates with timeout
    await executeGatesWithPolicy(validatedPlan, executionState, artifactDir, 10000);

    // 4. Generate merge decisions
    const evaluator = new MergeEligibilityEvaluator(validatedPlan, executionState);
    const mergeSummary = evaluator.getMergeSummary();

    // 5. Generate snapshot (deterministic output)
    const cliPath = path.join(repoRoot, "dist/cli.js");
    const snapshotOutput = execSync(`node ${cliPath} plan --json`, {
      encoding: "utf8",
      cwd: process.cwd(),
    });

    // Extract execution state structure (without non-deterministic parts like stdout)
    const results = Array.from(executionState.getResults().values());
    const executionStateStructure = {
      nodeCount: results.length,
      nodeNames: results.map((r) => r.name).sort(),
      gateStatuses: results
        .flatMap((r) => r.gates.map((g) => ({ node: r.name, gate: g.gate, status: g.status })))
        .sort((a, b) => `${a.node}-${a.gate}`.localeCompare(`${b.node}-${b.gate}`)),
    };

    return {
      planJson,
      executionStateStructure,
      mergeDecisions: canonicalJSONStringify(mergeSummary),
      snapshot: snapshotOutput.trim(),
    };
  }
});
