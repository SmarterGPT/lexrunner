/**
 * Integration tests for cluster gate execution and rollback
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { simpleGit, SimpleGit } from "simple-git";
import {
  executeClusterWithGates,
  ClusterContext,
  ClusterExecutionResult,
} from "../src/weave/clusterGates.js";
import { ExecutionState } from "../src/executionState.js";
import { Plan, PlanItem, Gate } from "../src/schema.js";
import { GitOperations } from "../src/git/operations.js";

describe("Cluster Gate Execution and Rollback", () => {
  let testDir: string;
  let git: SimpleGit;
  let gitOps: GitOperations;

  beforeEach(async () => {
    // Create temporary test directory
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "lexrunner-cluster-test-"));
    git = simpleGit(testDir);
    gitOps = new GitOperations(testDir);

    // Initialize git repository
    await git.init();
    await git.addConfig("user.name", "Test User");
    await git.addConfig("user.email", "test@example.com");
    await git.addConfig("commit.gpgsign", "false");

    // Create initial commit
    fs.writeFileSync(path.join(testDir, "README.md"), "# Test Repo");
    await git.add("README.md");
    await git.commit("Initial commit");
  });

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should execute gates for a cluster successfully", async () => {
    // Create a plan with simple passing gates
    const plan: Plan = {
      schemaVersion: "1.0.0",
      target: "main",
      items: [
        {
          name: "test-item",
          deps: [],
          gates: [
            {
              name: "lint",
              run: "node -e \"console.log('Linting...'); process.exitCode = 0\"",
              runtime: "local",
            },
          ],
        },
      ],
      policy: {
        requiredGates: ["lint"],
        optionalGates: [],
        maxWorkers: 1,
        retries: {},
        overrides: {},
        blockOn: [],
        mergeRule: { type: "strict-required" },
      },
    };

    const executionState = new ExecutionState(plan);
    const weaveDir = path.join(testDir, ".weave");

    const cluster: ClusterContext = {
      clusterIndex: 0,
      items: plan.items,
      baseBranch: "main",
      integrationBranch: "weave/test-integration",
      weaveDir,
    };

    const result = await executeClusterWithGates(cluster, plan, executionState, gitOps, {
      skipGates: false,
      timeoutMs: 5000,
    });

    expect(result.success).toBe(true);
    expect(result.gatesPassed).toBe(true);
    expect(result.rollbackPerformed).toBe(false);
    expect(result.gateResults).toHaveLength(1);
    expect(result.gateResults[0].status).toBe("pass");
    expect(result.gateResults[0].exitCode).toBe(0);
    expect(result.gateResults[0].stdout?.trim()).toBe("Linting...");
    expect(result.gateResults[0].stderr).toBe("");
  });

  it("should rollback on gate failure and store artifacts", async () => {
    // Create a plan with a failing gate
    const plan: Plan = {
      schemaVersion: "1.0.0",
      target: "main",
      items: [
        {
          name: "test-item",
          deps: [],
          gates: [
            {
              name: "test",
              run: "node -e \"console.error('Test failed'); process.exitCode = 1\"",
              runtime: "local",
            },
          ],
        },
      ],
      policy: {
        requiredGates: ["test"],
        optionalGates: [],
        maxWorkers: 1,
        retries: {},
        overrides: {},
        blockOn: [],
        mergeRule: { type: "strict-required" },
      },
    };

    const executionState = new ExecutionState(plan);
    const weaveDir = path.join(testDir, ".weave");

    // Make a commit to simulate cluster changes
    fs.writeFileSync(path.join(testDir, "file.txt"), "cluster changes");
    await git.add("file.txt");
    await git.commit("Cluster changes");
    const preClusterSha = (await git.log(["-1"])).latest?.hash || "";

    const cluster: ClusterContext = {
      clusterIndex: 0,
      items: plan.items,
      baseBranch: "main",
      integrationBranch: "weave/test-integration",
      weaveDir,
    };

    const result = await executeClusterWithGates(cluster, plan, executionState, gitOps, {
      skipGates: false,
      timeoutMs: 5000,
    });

    // Verify rollback occurred
    expect(result.success).toBe(false);
    expect(result.gatesPassed).toBe(false);
    expect(result.rollbackPerformed).toBe(true);
    expect(result.rollbackSha).toBeDefined();
    expect(result.artifactsStored).toBe(true);
    expect(result.artifactPaths.length).toBeGreaterThan(0);
    expect(result.gateResults).toHaveLength(1);
    expect(result.gateResults[0]).toMatchObject({
      status: "fail",
      exitCode: 1,
      failureKind: "nonzero_exit",
      stdout: "",
    });
    expect(result.gateResults[0].stderr?.trim()).toBe("Test failed");

    // Verify .weave directory created
    expect(fs.existsSync(weaveDir)).toBe(true);

    // Verify merge-patch.diff stored
    const diffPath = path.join(weaveDir, "cluster-0-merge-patch.diff");
    expect(fs.existsSync(diffPath)).toBe(true);

    // Verify failure bundle stored
    const bundlePath = path.join(weaveDir, "cluster-0-failure-bundle.json");
    expect(fs.existsSync(bundlePath)).toBe(true);

    const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf-8"));
    expect(bundle.clusterIndex).toBe(0);
    expect(bundle.failedGates).toHaveLength(1);
    expect(bundle.failedGates[0].gate).toBe("test");
    expect(bundle.failedGates[0].exitCode).toBe(1);
    expect(bundle.failedGates[0].stderr.trim()).toBe("Test failed");
    expect(bundle.rollbackSha).toBeDefined();

    // Failure-delivery work must stay inside the GitOperations checkout rather
    // than mutating whichever repository launched the test process. The
    // artifact commit is based directly on the recorded rollback SHA.
    expect((await git.branchLocal()).current).toMatch(/^weave\/cluster-0-failure-/);
    expect((await git.revparse(["HEAD^"])).trim()).toBe(result.rollbackSha);
  });

  it("should skip gates when skipGates option is true", async () => {
    const plan: Plan = {
      schemaVersion: "1.0.0",
      target: "main",
      items: [
        {
          name: "test-item",
          deps: [],
          gates: [
            {
              name: "test",
              run: 'node -e "process.exit(1)"',
              runtime: "local",
            },
          ],
        },
      ],
      policy: {
        requiredGates: ["test"],
        optionalGates: [],
        maxWorkers: 1,
        retries: {},
        overrides: {},
        blockOn: [],
        mergeRule: { type: "strict-required" },
      },
    };

    const executionState = new ExecutionState(plan);
    const weaveDir = path.join(testDir, ".weave");

    const cluster: ClusterContext = {
      clusterIndex: 0,
      items: plan.items,
      baseBranch: "main",
      integrationBranch: "weave/test-integration",
      weaveDir,
    };

    const result = await executeClusterWithGates(cluster, plan, executionState, gitOps, {
      skipGates: true,
    });

    expect(result.success).toBe(true);
    expect(result.gatesPassed).toBe(true);
    expect(result.rollbackPerformed).toBe(false);
    expect(result.gateResults).toHaveLength(0);
  });

  it("should handle multiple items in a cluster", async () => {
    const plan: Plan = {
      schemaVersion: "1.0.0",
      target: "main",
      items: [
        {
          name: "item-1",
          deps: [],
          gates: [
            {
              name: "lint",
              run: 'node -e "process.exit(0)"',
              runtime: "local",
            },
          ],
        },
        {
          name: "item-2",
          deps: [],
          gates: [
            {
              name: "lint",
              run: 'node -e "process.exit(0)"',
              runtime: "local",
            },
          ],
        },
      ],
      policy: {
        requiredGates: ["lint"],
        optionalGates: [],
        maxWorkers: 1,
        retries: {},
        overrides: {},
        blockOn: [],
        mergeRule: { type: "strict-required" },
      },
    };

    const executionState = new ExecutionState(plan);
    const weaveDir = path.join(testDir, ".weave");

    const cluster: ClusterContext = {
      clusterIndex: 0,
      items: plan.items,
      baseBranch: "main",
      integrationBranch: "weave/test-integration",
      weaveDir,
    };

    const result = await executeClusterWithGates(cluster, plan, executionState, gitOps, {
      skipGates: false,
      timeoutMs: 5000,
    });

    expect(result.success).toBe(true);
    expect(result.gatesPassed).toBe(true);
    expect(result.gateResults).toHaveLength(2);
    expect(result.gateResults.every((gr) => gr.status === "pass")).toBe(true);
    expect(result.gateResults.map((gr) => gr.exitCode)).toEqual([0, 0]);
  });

  it("should rollback if any gate in cluster fails", async () => {
    const plan: Plan = {
      schemaVersion: "1.0.0",
      target: "main",
      items: [
        {
          name: "item-1",
          deps: [],
          gates: [
            {
              name: "lint",
              run: 'node -e "process.exit(0)"',
              runtime: "local",
            },
          ],
        },
        {
          name: "item-2",
          deps: [],
          gates: [
            {
              name: "lint",
              run: 'node -e "process.exit(1)"', // Fail
              runtime: "local",
            },
          ],
        },
      ],
      policy: {
        requiredGates: ["lint"],
        optionalGates: [],
        maxWorkers: 1,
        retries: {},
        overrides: {},
        blockOn: [],
        mergeRule: { type: "strict-required" },
      },
    };

    const executionState = new ExecutionState(plan);
    const weaveDir = path.join(testDir, ".weave");

    const cluster: ClusterContext = {
      clusterIndex: 0,
      items: plan.items,
      baseBranch: "main",
      integrationBranch: "weave/test-integration",
      weaveDir,
    };

    const result = await executeClusterWithGates(cluster, plan, executionState, gitOps, {
      skipGates: false,
      timeoutMs: 5000,
    });

    expect(result.success).toBe(false);
    expect(result.gatesPassed).toBe(false);
    expect(result.rollbackPerformed).toBe(true);
    expect(result.gateResults).toHaveLength(2);
    expect(result.gateResults.some((gr) => gr.status === "fail")).toBe(true);
    expect(result.gateResults.map((gr) => ({ status: gr.status, exitCode: gr.exitCode }))).toEqual([
      { status: "pass", exitCode: 0 },
      { status: "fail", exitCode: 1 },
    ]);
  });
});
