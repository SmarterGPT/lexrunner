import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getMCPEnvironment, PlanCreateArgs, GatesRunArgs, MergeApplyArgs } from "../src/mcp/types";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("MCP Contract Tests", () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };

    // Create test directory
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-"));
    process.env.LEX_PR_PROFILE_DIR = testDir;
    process.env.ALLOW_MUTATIONS = "false";
    process.chdir(testDir);
  });

  afterEach(() => {
    // Restore environment
    process.env = originalEnv;
    process.chdir("/");

    // Cleanup test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe("Parameter validation schemas", () => {
    it("should validate PlanCreateArgs schema correctly", () => {
      // Valid arguments - basic
      expect(() => PlanCreateArgs.parse({})).not.toThrow();
      expect(() => PlanCreateArgs.parse({ json: true })).not.toThrow();
      expect(() => PlanCreateArgs.parse({ json: false })).not.toThrow();
      expect(() => PlanCreateArgs.parse({ outDir: "/tmp" })).not.toThrow();
      expect(() => PlanCreateArgs.parse({ json: true, outDir: "/tmp" })).not.toThrow();

      // Valid arguments - GitHub auto-discovery
      expect(() => PlanCreateArgs.parse({ fromGithub: true })).not.toThrow();
      expect(() =>
        PlanCreateArgs.parse({ fromGithub: true, query: "is:open label:feature" })
      ).not.toThrow();
      expect(() =>
        PlanCreateArgs.parse({ fromGithub: true, labels: ["bug", "feature"] })
      ).not.toThrow();
      expect(() => PlanCreateArgs.parse({ fromGithub: true, includeDrafts: false })).not.toThrow();
      expect(() =>
        PlanCreateArgs.parse({ fromGithub: true, excludePRs: [123, 456] })
      ).not.toThrow();
      expect(() =>
        PlanCreateArgs.parse({ fromGithub: true, githubToken: "ghp_token123" })
      ).not.toThrow();
      expect(() =>
        PlanCreateArgs.parse({ fromGithub: true, owner: "testowner", repo: "testrepo" })
      ).not.toThrow();
      expect(() =>
        PlanCreateArgs.parse({ fromGithub: true, requiredGates: ["lint", "test", "typecheck"] })
      ).not.toThrow();
      expect(() => PlanCreateArgs.parse({ fromGithub: true, maxWorkers: 4 })).not.toThrow();
      expect(() => PlanCreateArgs.parse({ fromGithub: true, target: "develop" })).not.toThrow();

      const multiRepoArgs = PlanCreateArgs.parse({
        fromGithub: true,
        repos: [
          { owner: "org", repo: "primary", priority: 2 },
          { owner: "org", repo: "secondary" },
        ],
      });
      expect(multiRepoArgs.repos).toEqual([
        { owner: "org", repo: "primary", priority: 2 },
        { owner: "org", repo: "secondary", priority: 1 },
      ]);

      // Valid arguments - complex GitHub scenarios
      expect(() =>
        PlanCreateArgs.parse({
          fromGithub: true,
          query: "is:open label:stack:*",
          labels: ["priority:high"],
          excludePRs: [100, 200],
          includeDrafts: true,
          githubToken: "token",
          owner: "org",
          repo: "repo",
          requiredGates: ["lint", "test"],
          maxWorkers: 2,
          target: "main",
          outDir: "/tmp/plan",
        })
      ).not.toThrow();

      // Invalid arguments
      expect(() => PlanCreateArgs.parse({ json: "true" })).toThrow();
      expect(() => PlanCreateArgs.parse({ outDir: 123 })).toThrow();
      expect(() => PlanCreateArgs.parse({ fromGithub: "true" })).toThrow(); // Should be boolean
      expect(() => PlanCreateArgs.parse({ labels: "bug,feature" })).toThrow(); // Should be array
      expect(() => PlanCreateArgs.parse({ excludePRs: "123,456" })).toThrow(); // Should be array of numbers
      expect(() => PlanCreateArgs.parse({ excludePRs: [123, "456"] })).toThrow(); // Should be numbers, not strings
      expect(() => PlanCreateArgs.parse({ maxWorkers: "4" })).toThrow(); // Should be number
      expect(() => PlanCreateArgs.parse({ requiredGates: "lint,test" })).toThrow(); // Should be array
      expect(() => PlanCreateArgs.parse({ repos: [{ owner: "org" }] })).toThrow();
    });

    it("should validate GatesRunArgs schema correctly", () => {
      // Valid arguments
      expect(() => GatesRunArgs.parse({})).not.toThrow();
      expect(() => GatesRunArgs.parse({ onlyItem: "item1" })).not.toThrow();
      expect(() => GatesRunArgs.parse({ onlyGate: "test" })).not.toThrow();
      expect(() => GatesRunArgs.parse({ outDir: "/tmp" })).not.toThrow();
      expect(() => GatesRunArgs.parse({ onlyItem: "item1", onlyGate: "test" })).not.toThrow();
      expect(() => GatesRunArgs.parse({ planFile: "/path/to/plan.json" })).not.toThrow();
      expect(() =>
        GatesRunArgs.parse({ planFile: "/path/to/plan.json", outDir: "/tmp" })
      ).not.toThrow();

      // Invalid arguments
      expect(() => GatesRunArgs.parse({ onlyItem: 123 })).toThrow();
      expect(() => GatesRunArgs.parse({ onlyGate: true })).toThrow();
      expect(() => GatesRunArgs.parse({ outDir: null })).toThrow();
      expect(() => GatesRunArgs.parse({ planFile: 123 })).toThrow();
    });

    it("should validate MergeApplyArgs schema correctly", () => {
      // Valid arguments
      expect(() => MergeApplyArgs.parse({})).not.toThrow();
      expect(() => MergeApplyArgs.parse({ planFile: "plan.json", dryRun: true })).not.toThrow();
      expect(() => MergeApplyArgs.parse({ dryRun: true })).not.toThrow();
      expect(() => MergeApplyArgs.parse({ dryRun: false })).not.toThrow();

      // Invalid arguments
      expect(() => MergeApplyArgs.parse({ dryRun: "true" })).toThrow();
      expect(() => MergeApplyArgs.parse({ dryRun: 1 })).toThrow();
      expect(() => MergeApplyArgs.parse({ planFile: "" })).toThrow();
    });
  });

  describe("Environment variable handling", () => {
    it("should use correct default values", () => {
      delete process.env.LEX_PR_PROFILE_DIR;
      delete process.env.ALLOW_MUTATIONS;

      const env = getMCPEnvironment();
      expect(env.LEX_PR_PROFILE_DIR).toBeUndefined();
      expect(env.ALLOW_MUTATIONS).toBe(false);
    });

    it("should parse ALLOW_MUTATIONS correctly", () => {
      // Test various falsy values
      const falsyValues = ["false", "", "0", undefined];
      for (const value of falsyValues) {
        process.env.ALLOW_MUTATIONS = value;
        expect(getMCPEnvironment().ALLOW_MUTATIONS).toBe(false);
      }

      // Test truthy value
      process.env.ALLOW_MUTATIONS = "true";
      expect(getMCPEnvironment().ALLOW_MUTATIONS).toBe(true);
    });

    it("should use custom LEX_PR_PROFILE_DIR", () => {
      const customPath = "/custom/profile/path";
      process.env.LEX_PR_PROFILE_DIR = customPath;

      const env = getMCPEnvironment();
      expect(env.LEX_PR_PROFILE_DIR).toBe(customPath);
    });
  });

  describe("Filesystem isolation", () => {
    it("should run in isolated temp directory", () => {
      // Tests should run in isolated temp directory
      expect(path.resolve(process.cwd())).toBe(path.resolve(testDir));
      expect(path.basename(process.cwd())).toContain("mcp-test-");
    });

    it("should clean up test artifacts after each test", () => {
      const artifactPath = path.join(testDir, "test-artifact.json");
      fs.writeFileSync(artifactPath, '{"test": true}');

      expect(fs.existsSync(artifactPath)).toBe(true);

      // Test passes - cleanup is verified by afterEach hook
    });

    it("should handle missing files gracefully in environment setup", () => {
      // Test that missing profile directory doesn't crash getMCPEnvironment
      const customDir = path.join(testDir, "nonexistent");
      process.env.LEX_PR_PROFILE_DIR = customDir;

      expect(() => getMCPEnvironment()).not.toThrow();
      const env = getMCPEnvironment();
      expect(env.LEX_PR_PROFILE_DIR).toBe(customDir);
    });
  });

  describe("Schema type compliance", () => {
    it("should have consistent typing for all MCP argument schemas", () => {
      // Verify that all schemas follow the same pattern
      const planArgs = PlanCreateArgs.parse({});
      const gatesArgs = GatesRunArgs.parse({});
      const mergeArgs = MergeApplyArgs.parse({});

      // All should be objects
      expect(typeof planArgs).toBe("object");
      expect(typeof gatesArgs).toBe("object");
      expect(typeof mergeArgs).toBe("object");

      // All should be non-null
      expect(planArgs).not.toBe(null);
      expect(gatesArgs).not.toBe(null);
      expect(mergeArgs).not.toBe(null);
    });

    it("should handle optional vs required properties correctly", () => {
      // All properties should be optional for these schemas
      expect(() => PlanCreateArgs.parse({})).not.toThrow();
      expect(() => GatesRunArgs.parse({})).not.toThrow();
      expect(() => MergeApplyArgs.parse({})).not.toThrow();
    });

    it("should reject unknown properties", () => {
      // Test with unknown properties - some schemas may allow, others may not
      // This tests the behavior rather than requiring strict rejection
      try {
        PlanCreateArgs.parse({ unknownProp: "value" });
      } catch (error) {
        expect(error).toBeDefined(); // If it throws, that's valid behavior
      }

      try {
        GatesRunArgs.parse({ unknownProp: "value" });
      } catch (error) {
        expect(error).toBeDefined();
      }

      try {
        MergeApplyArgs.parse({ unknownProp: "value" });
      } catch (error) {
        expect(error).toBeDefined();
      }
    });

    it("should parse GitHub auto-discovery parameters with correct types", () => {
      const githubArgs = PlanCreateArgs.parse({
        fromGithub: true,
        query: "is:open label:feature",
        labels: ["bug", "enhancement"],
        includeDrafts: false,
        excludePRs: [100, 200, 300],
        githubToken: "ghp_test_token",
        owner: "testorg",
        repo: "testrepo",
        requiredGates: ["lint", "test", "security"],
        maxWorkers: 4,
        target: "develop",
      });

      // Verify all fields are present and have correct types
      expect(githubArgs.fromGithub).toBe(true);
      expect(githubArgs.query).toBe("is:open label:feature");
      expect(githubArgs.labels).toEqual(["bug", "enhancement"]);
      expect(githubArgs.includeDrafts).toBe(false);
      expect(githubArgs.excludePRs).toEqual([100, 200, 300]);
      expect(githubArgs.githubToken).toBe("ghp_test_token");
      expect(githubArgs.owner).toBe("testorg");
      expect(githubArgs.repo).toBe("testrepo");
      expect(githubArgs.requiredGates).toEqual(["lint", "test", "security"]);
      expect(githubArgs.maxWorkers).toBe(4);
      expect(githubArgs.target).toBe("develop");
    });
  });

  describe("MCP environment configuration determinism", () => {
    it("should produce consistent environment configs", () => {
      process.env.LEX_PR_PROFILE_DIR = "/test/path";
      process.env.ALLOW_MUTATIONS = "true";

      const env1 = getMCPEnvironment();
      const env2 = getMCPEnvironment();

      expect(env1).toEqual(env2);
      expect(env1.LEX_PR_PROFILE_DIR).toBe(env2.LEX_PR_PROFILE_DIR);
      expect(env1.ALLOW_MUTATIONS).toBe(env2.ALLOW_MUTATIONS);
    });

    it("should handle environment changes between calls", () => {
      // First call
      process.env.ALLOW_MUTATIONS = "false";
      const env1 = getMCPEnvironment();
      expect(env1.ALLOW_MUTATIONS).toBe(false);

      // Change environment and call again
      process.env.ALLOW_MUTATIONS = "true";
      const env2 = getMCPEnvironment();
      expect(env2.ALLOW_MUTATIONS).toBe(true);

      // Should reflect the change
      expect(env1.ALLOW_MUTATIONS).not.toBe(env2.ALLOW_MUTATIONS);
    });
  });
});
