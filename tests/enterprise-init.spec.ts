import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  detectEnvironment,
  getAuditProfileConfig,
  getPolicyTemplateConfig,
  generateCopilotInstructions,
  generateGateMappingConfig,
  generateEnterpriseConfigYAML,
  createEnterpriseWorkspace,
} from "../src/core/enterprise.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("Enterprise Onboarding", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe("detectEnvironment", () => {
    it("should detect single-repo structure by default", () => {
      const result = detectEnvironment(tempDir);

      expect(result.projectStructure).toBe("single-repo");
      expect(result.isMonorepo).toBe(false);
      expect(result.workspaceRoot).toBe(tempDir);
    });

    it("should detect GitHub Actions CI", () => {
      const githubDir = path.join(tempDir, ".github", "workflows");
      fs.mkdirSync(githubDir, { recursive: true });
      fs.writeFileSync(path.join(githubDir, "test.yml"), "name: Test");

      const result = detectEnvironment(tempDir);

      expect(result.ciProvider).toBe("github-actions");
      expect(result.detectedCI).toContain("github-actions");
    });

    it("should detect GitLab CI", () => {
      fs.writeFileSync(path.join(tempDir, ".gitlab-ci.yml"), "stages: [test]");

      const result = detectEnvironment(tempDir);

      expect(result.detectedCI).toContain("gitlab-ci");
    });

    it("should detect monorepo with package.json workspaces", () => {
      fs.writeFileSync(
        path.join(tempDir, "package.json"),
        JSON.stringify({ workspaces: ["packages/*"] })
      );

      const result = detectEnvironment(tempDir);

      expect(result.projectStructure).toBe("monorepo");
      expect(result.isMonorepo).toBe(true);
    });

    it("should detect monorepo with lerna.json", () => {
      fs.writeFileSync(path.join(tempDir, "lerna.json"), JSON.stringify({ version: "1.0.0" }));

      const result = detectEnvironment(tempDir);

      expect(result.projectStructure).toBe("monorepo");
      expect(result.isMonorepo).toBe(true);
    });

    it("should detect monorepo with nx.json", () => {
      fs.writeFileSync(path.join(tempDir, "nx.json"), JSON.stringify({ npmScope: "test" }));

      const result = detectEnvironment(tempDir);

      expect(result.projectStructure).toBe("monorepo");
      expect(result.isMonorepo).toBe(true);
    });

    it("should detect monorepo with pnpm-workspace.yaml", () => {
      fs.writeFileSync(path.join(tempDir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'");

      const result = detectEnvironment(tempDir);

      expect(result.projectStructure).toBe("monorepo");
      expect(result.isMonorepo).toBe(true);
    });
  });

  describe("getAuditProfileConfig", () => {
    it("should return off profile", () => {
      const config = getAuditProfileConfig("off");

      expect(config.profile).toBe("off");
      expect(config.retention).toBe("0d");
      expect(config.encryption).toBe(false);
    });

    it("should return basic profile", () => {
      const config = getAuditProfileConfig("basic");

      expect(config.profile).toBe("basic");
      expect(config.retention).toBe("30d");
      expect(config.encryption).toBe(false);
    });

    it("should return soc2 profile", () => {
      const config = getAuditProfileConfig("soc2");

      expect(config.profile).toBe("soc2");
      expect(config.retention).toBe("90d");
      expect(config.encryption).toBe(true);
    });

    it("should return hipaa-strict profile", () => {
      const config = getAuditProfileConfig("hipaa-strict");

      expect(config.profile).toBe("hipaa-strict");
      expect(config.retention).toBe("365d");
      expect(config.encryption).toBe(true);
    });
  });

  describe("getPolicyTemplateConfig", () => {
    it("should return basic policy", () => {
      const config = getPolicyTemplateConfig("basic");

      expect(config.template).toBe("basic");
      expect(config.requiredGates).toEqual(["lint", "typecheck"]);
      expect(config.approvalRules).toBeUndefined();
    });

    it("should return enterprise-standard policy", () => {
      const config = getPolicyTemplateConfig("enterprise-standard");

      expect(config.template).toBe("enterprise-standard");
      expect(config.requiredGates).toEqual(["lint", "typecheck", "test", "security-scan"]);
      expect(config.approvalRules).toEqual({
        minApprovers: 2,
        requireCodeOwner: true,
      });
    });

    it("should return strict policy", () => {
      const config = getPolicyTemplateConfig("strict");

      expect(config.template).toBe("strict");
      expect(config.requiredGates).toEqual(["lint", "typecheck", "test", "security-scan", "e2e"]);
      expect(config.approvalRules).toEqual({
        minApprovers: 3,
        requireCodeOwner: true,
      });
    });
  });

  describe("generateCopilotInstructions", () => {
    it("should generate instructions with all sections", () => {
      const config = {
        audit: getAuditProfileConfig("soc2"),
        policy: getPolicyTemplateConfig("enterprise-standard"),
        environment: {
          projectStructure: "monorepo" as const,
          ciProvider: "github-actions" as const,
        },
      };

      const instructions = generateCopilotInstructions(config);

      expect(instructions).toContain("# GitHub Copilot Instructions for lexrunner");
      expect(instructions).toContain("Project Structure:** monorepo");
      expect(instructions).toContain("CI Provider:** github-actions");
      expect(instructions).toContain("Audit Profile:** soc2");
      expect(instructions).toContain("lint");
      expect(instructions).toContain("typecheck");
      expect(instructions).toContain("test");
      expect(instructions).toContain("security-scan");
      expect(instructions).toContain("Minimum approvers: 2");
      expect(instructions).toContain("Require code owner approval: Yes");
    });
  });

  describe("generateGateMappingConfig", () => {
    it("should generate GitHub Actions mapping", () => {
      const mapping = generateGateMappingConfig("github-actions", ["lint", "test"]);

      expect(mapping).toContain("provider: github-actions");
      expect(mapping).toContain("lint:");
      expect(mapping).toContain(".github/workflows/lint.yml");
      expect(mapping).toContain("test:");
      expect(mapping).toContain(".github/workflows/test.yml");
    });

    it("should generate GitLab CI mapping", () => {
      const mapping = generateGateMappingConfig("gitlab-ci", ["lint", "test"]);

      expect(mapping).toContain("provider: gitlab-ci");
      expect(mapping).toContain("lint:");
      expect(mapping).toContain("job: lint");
    });

    it("should generate custom mapping for other providers", () => {
      const mapping = generateGateMappingConfig("other", ["lint", "test"]);

      expect(mapping).toContain("provider: custom");
      expect(mapping).toContain("command: npm run lint");
    });
  });

  describe("generateEnterpriseConfigYAML", () => {
    it("should generate valid YAML", () => {
      const config = {
        audit: getAuditProfileConfig("soc2"),
        policy: getPolicyTemplateConfig("enterprise-standard"),
        environment: {
          projectStructure: "monorepo" as const,
          ciProvider: "github-actions" as const,
        },
      };

      const yaml = generateEnterpriseConfigYAML(config);

      expect(yaml).toContain("version: 1");
      expect(yaml).toContain("enterprise:");
      expect(yaml).toContain("audit:");
      expect(yaml).toContain("profile: soc2");
      expect(yaml).toContain("policy:");
      expect(yaml).toContain("template: enterprise-standard");
      expect(yaml).toContain("requiredGates:");
      expect(yaml).toContain("- lint");
    });
  });

  describe("createEnterpriseWorkspace", () => {
    it("should create enterprise directory structure", () => {
      const profileDir = path.join(tempDir, ".smartergpt.local");
      fs.mkdirSync(profileDir, { recursive: true });

      const config = {
        audit: getAuditProfileConfig("soc2"),
        policy: getPolicyTemplateConfig("enterprise-standard"),
        environment: {
          projectStructure: "monorepo" as const,
          ciProvider: "github-actions" as const,
        },
      };

      createEnterpriseWorkspace(tempDir, profileDir, config);

      // Check .lexrunner directory structure
      const lexrunnerDir = path.join(profileDir, ".lexrunner");
      expect(fs.existsSync(lexrunnerDir)).toBe(true);

      // Check config files
      expect(fs.existsSync(path.join(lexrunnerDir, "config.yaml"))).toBe(true);
      expect(fs.existsSync(path.join(lexrunnerDir, "gate-mapping.yaml"))).toBe(true);

      // Check personas directory
      expect(fs.existsSync(path.join(lexrunnerDir, "personas"))).toBe(true);

      // Check audit directory (for soc2 profile)
      expect(fs.existsSync(path.join(lexrunnerDir, "audit"))).toBe(true);
    });

    it("should not create audit directory for off profile", () => {
      const profileDir = path.join(tempDir, ".smartergpt.local");
      fs.mkdirSync(profileDir, { recursive: true });

      const config = {
        audit: getAuditProfileConfig("off"),
        policy: getPolicyTemplateConfig("basic"),
        environment: {
          projectStructure: "single-repo" as const,
          ciProvider: "other" as const,
        },
      };

      createEnterpriseWorkspace(tempDir, profileDir, config);

      const lexrunnerDir = path.join(profileDir, ".lexrunner");
      const auditDir = path.join(lexrunnerDir, "audit");
      expect(fs.existsSync(auditDir)).toBe(false);
    });

    it("should create GitHub structure for github-actions provider", () => {
      const profileDir = path.join(tempDir, ".smartergpt.local");
      fs.mkdirSync(profileDir, { recursive: true });

      const config = {
        audit: getAuditProfileConfig("basic"),
        policy: getPolicyTemplateConfig("enterprise-standard"),
        environment: {
          projectStructure: "single-repo" as const,
          ciProvider: "github-actions" as const,
        },
      };

      createEnterpriseWorkspace(tempDir, profileDir, config);

      // Check .github directory
      const githubDir = path.join(tempDir, ".github");
      expect(fs.existsSync(githubDir)).toBe(true);

      // Check copilot instructions
      const copilotInstructions = path.join(githubDir, "copilot-instructions.md");
      expect(fs.existsSync(copilotInstructions)).toBe(true);

      // Check workflow
      const workflow = path.join(githubDir, "workflows", "merge-weave.yaml");
      expect(fs.existsSync(workflow)).toBe(true);

      // Verify content
      const workflowContent = fs.readFileSync(workflow, "utf-8");
      expect(workflowContent).toContain("name: Merge Weave");
      expect(workflowContent).toContain("merge-weave");
    });

    it("should not overwrite existing workflow", () => {
      const profileDir = path.join(tempDir, ".smartergpt.local");
      fs.mkdirSync(profileDir, { recursive: true });

      const githubDir = path.join(tempDir, ".github", "workflows");
      fs.mkdirSync(githubDir, { recursive: true });

      const workflowPath = path.join(githubDir, "merge-weave.yaml");
      const existingContent = "# Existing workflow";
      fs.writeFileSync(workflowPath, existingContent);

      const config = {
        audit: getAuditProfileConfig("basic"),
        policy: getPolicyTemplateConfig("basic"),
        environment: {
          projectStructure: "single-repo" as const,
          ciProvider: "github-actions" as const,
        },
      };

      createEnterpriseWorkspace(tempDir, profileDir, config);

      // Verify existing content is preserved
      const content = fs.readFileSync(workflowPath, "utf-8");
      expect(content).toBe(existingContent);
    });

    it("should preserve existing enterprise-managed files without force", () => {
      const profileDir = path.join(tempDir, ".smartergpt.local");
      const lexrunnerDir = path.join(profileDir, ".lexrunner");
      const workflowsDir = path.join(tempDir, ".github", "workflows");
      fs.mkdirSync(lexrunnerDir, { recursive: true });
      fs.mkdirSync(workflowsDir, { recursive: true });

      const sentinels = new Map([
        [path.join(lexrunnerDir, "config.yaml"), "# authored enterprise config\n"],
        [path.join(lexrunnerDir, "gate-mapping.yaml"), "# authored gate mapping\n"],
        [path.join(tempDir, ".github", "copilot-instructions.md"), "# authored instructions\n"],
        [path.join(workflowsDir, "merge-weave.yaml"), "# authored workflow\n"],
      ]);
      for (const [file, content] of sentinels) fs.writeFileSync(file, content);

      const config = {
        audit: getAuditProfileConfig("soc2"),
        policy: getPolicyTemplateConfig("enterprise-standard"),
        environment: {
          projectStructure: "single-repo" as const,
          ciProvider: "github-actions" as const,
        },
      };

      createEnterpriseWorkspace(tempDir, profileDir, config);

      for (const [file, content] of sentinels) {
        expect(fs.readFileSync(file, "utf8")).toBe(content);
      }
    });

    it("should replace managed files with force while preserving the existing workflow", () => {
      const profileDir = path.join(tempDir, ".smartergpt.local");
      const lexrunnerDir = path.join(profileDir, ".lexrunner");
      const workflowsDir = path.join(tempDir, ".github", "workflows");
      fs.mkdirSync(lexrunnerDir, { recursive: true });
      fs.mkdirSync(workflowsDir, { recursive: true });

      const managedFiles = [
        path.join(lexrunnerDir, "config.yaml"),
        path.join(lexrunnerDir, "gate-mapping.yaml"),
        path.join(tempDir, ".github", "copilot-instructions.md"),
      ];
      for (const file of managedFiles) fs.writeFileSync(file, "AUTHORED-MANAGED-SENTINEL\n");
      const workflowPath = path.join(workflowsDir, "merge-weave.yaml");
      fs.writeFileSync(workflowPath, "AUTHORED-WORKFLOW-SENTINEL\n");

      const config = {
        audit: getAuditProfileConfig("soc2"),
        policy: getPolicyTemplateConfig("enterprise-standard"),
        environment: {
          projectStructure: "single-repo" as const,
          ciProvider: "github-actions" as const,
        },
      };

      createEnterpriseWorkspace(tempDir, profileDir, config, { force: true });

      for (const file of managedFiles) {
        expect(fs.readFileSync(file, "utf8")).not.toContain("AUTHORED-MANAGED-SENTINEL");
      }
      expect(fs.readFileSync(workflowPath, "utf8")).toBe("AUTHORED-WORKFLOW-SENTINEL\n");
    });
  });
});
