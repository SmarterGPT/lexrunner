import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runInit } from "../src/commands/init.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("Init Command - Enterprise Mode", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-init-test-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe("Enterprise initialization", () => {
    it("should create enterprise workspace structure", async () => {
      const result = await runInit({
        nonInteractive: true,
        enterprise: true,
        jsonMode: true,
      });

      expect(result.success).toBe(true);
      expect(result.profileDir).toContain(".smartergpt.local");

      const profileDir = result.profileDir;

      // Check basic workspace files
      expect(fs.existsSync(path.join(profileDir, "intent.md"))).toBe(true);
      expect(fs.existsSync(path.join(profileDir, "scope.yml"))).toBe(true);
      expect(fs.existsSync(path.join(profileDir, "deps.yml"))).toBe(true);
      expect(fs.existsSync(path.join(profileDir, "gates.yml"))).toBe(true);

      // Check enterprise structure
      const lexrunnerDir = path.join(profileDir, ".lexrunner");
      expect(fs.existsSync(lexrunnerDir)).toBe(true);
      expect(fs.existsSync(path.join(lexrunnerDir, "config.yaml"))).toBe(true);
      expect(fs.existsSync(path.join(lexrunnerDir, "gate-mapping.yaml"))).toBe(true);
      expect(fs.existsSync(path.join(lexrunnerDir, "personas"))).toBe(true);
    });

    it("should describe no-force output as created or preserved", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      let output = "";
      try {
        const result = await runInit({
          nonInteractive: true,
          enterprise: true,
        });
        expect(result.success).toBe(true);
        output = log.mock.calls.flat().join("\n");
      } finally {
        log.mockRestore();
      }

      expect(output).toContain("Workspace structure after initialization");
      expect(output).toContain("created or preserved");
      expect(output).not.toContain("Created structure");
      expect(output).not.toContain("quality gates - updated");
    });

    it("should create audit directory for soc2 profile", async () => {
      const result = await runInit({
        nonInteractive: true,
        enterprise: true,
        auditProfile: "soc2",
        jsonMode: true,
      });

      expect(result.success).toBe(true);

      const lexrunnerDir = path.join(result.profileDir, ".lexrunner");
      const auditDir = path.join(lexrunnerDir, "audit");
      expect(fs.existsSync(auditDir)).toBe(true);
    });

    it("should not create audit directory for off profile", async () => {
      const result = await runInit({
        nonInteractive: true,
        enterprise: true,
        auditProfile: "off",
        jsonMode: true,
      });

      expect(result.success).toBe(true);

      const lexrunnerDir = path.join(result.profileDir, ".lexrunner");
      const auditDir = path.join(lexrunnerDir, "audit");
      expect(fs.existsSync(auditDir)).toBe(false);
    });

    it("should configure gates based on policy template", async () => {
      const result = await runInit({
        nonInteractive: true,
        enterprise: true,
        policyTemplate: "enterprise-standard",
        jsonMode: true,
      });

      expect(result.success).toBe(true);

      const gatesPath = path.join(result.profileDir, "gates.yml");
      const gatesContent = fs.readFileSync(gatesPath, "utf-8");

      // Enterprise-standard should include these gates
      expect(gatesContent).toContain("lint");
      expect(gatesContent).toContain("typecheck");
      expect(gatesContent).toContain("test");
      expect(gatesContent).toContain("security-scan");
    });

    it("should configure different gates for basic template", async () => {
      const result = await runInit({
        nonInteractive: true,
        enterprise: true,
        policyTemplate: "basic",
        jsonMode: true,
      });

      expect(result.success).toBe(true);

      const gatesPath = path.join(result.profileDir, "gates.yml");
      const gatesContent = fs.readFileSync(gatesPath, "utf-8");

      // Basic should only include lint and typecheck
      expect(gatesContent).toContain("lint");
      expect(gatesContent).toContain("typecheck");
      expect(gatesContent).not.toContain("security-scan");
    });

    it("should configure all gates for strict template", async () => {
      const result = await runInit({
        nonInteractive: true,
        enterprise: true,
        policyTemplate: "strict",
        jsonMode: true,
      });

      expect(result.success).toBe(true);

      const gatesPath = path.join(result.profileDir, "gates.yml");
      const gatesContent = fs.readFileSync(gatesPath, "utf-8");

      // Strict should include all gates including e2e
      expect(gatesContent).toContain("lint");
      expect(gatesContent).toContain("typecheck");
      expect(gatesContent).toContain("test");
      expect(gatesContent).toContain("security-scan");
      expect(gatesContent).toContain("e2e");
    });

    it("should create GitHub Copilot instructions when GitHub Actions detected", async () => {
      // Create .github directory to simulate GitHub Actions
      const githubDir = path.join(tempDir, ".github", "workflows");
      fs.mkdirSync(githubDir, { recursive: true });
      fs.writeFileSync(path.join(githubDir, "test.yml"), "name: Test");

      const result = await runInit({
        nonInteractive: true,
        enterprise: true,
        jsonMode: true,
      });

      expect(result.success).toBe(true);

      const copilotInstructions = path.join(tempDir, ".github", "copilot-instructions.md");
      expect(fs.existsSync(copilotInstructions)).toBe(true);

      const content = fs.readFileSync(copilotInstructions, "utf-8");
      expect(content).toContain("GitHub Copilot Instructions");
      expect(content).toContain("Quality Gates");
      expect(content).toContain("Audit & Compliance");
    });

    it("should create merge-weave workflow for GitHub Actions", async () => {
      // Create .github directory to simulate GitHub Actions
      const githubDir = path.join(tempDir, ".github", "workflows");
      fs.mkdirSync(githubDir, { recursive: true });
      fs.writeFileSync(path.join(githubDir, "test.yml"), "name: Test");

      const result = await runInit({
        nonInteractive: true,
        enterprise: true,
        jsonMode: true,
      });

      expect(result.success).toBe(true);

      const workflowPath = path.join(tempDir, ".github", "workflows", "merge-weave.yaml");
      expect(fs.existsSync(workflowPath)).toBe(true);

      const content = fs.readFileSync(workflowPath, "utf-8");
      expect(content).toContain("name: Merge Weave");
      expect(content).toContain("lex-pr discover");
      expect(content).toContain("lex-pr weave");
    });

    it("should work with custom profile directory", async () => {
      const customDir = path.join(tempDir, "custom-workspace");

      const result = await runInit({
        nonInteractive: true,
        enterprise: true,
        profileDir: customDir,
        jsonMode: true,
      });

      expect(result.success).toBe(true);
      expect(result.profileDir).toBe(customDir);

      const lexrunnerDir = path.join(customDir, ".lexrunner");
      expect(fs.existsSync(lexrunnerDir)).toBe(true);
    });

    it("should combine all audit profiles correctly", async () => {
      const profiles: Array<"off" | "basic" | "soc2" | "hipaa-strict"> = [
        "off",
        "basic",
        "soc2",
        "hipaa-strict",
      ];

      for (const profile of profiles) {
        const testDir = fs.mkdtempSync(path.join(os.tmpdir(), `audit-${profile}-`));
        process.chdir(testDir);

        const result = await runInit({
          nonInteractive: true,
          enterprise: true,
          auditProfile: profile,
          jsonMode: true,
        });

        expect(result.success).toBe(true);

        const configPath = path.join(result.profileDir, ".lexrunner", "config.yaml");
        const configContent = fs.readFileSync(configPath, "utf-8");
        expect(configContent).toContain(`profile: ${profile}`);

        process.chdir(originalCwd);
        fs.rmSync(testDir, { recursive: true });
      }
    });

    it("should repair an incomplete profile without overwriting authored enterprise files", async () => {
      const profileDir = path.join(tempDir, ".smartergpt.local");
      const lexrunnerDir = path.join(profileDir, ".lexrunner");
      const workflowsDir = path.join(tempDir, ".github", "workflows");
      fs.mkdirSync(lexrunnerDir, { recursive: true });
      fs.mkdirSync(workflowsDir, { recursive: true });
      fs.writeFileSync(path.join(profileDir, "profile.yml"), "role: local\nname: Authored\n");

      const preserved = new Map([
        [path.join(profileDir, "gates.yml"), "AUTHORED-GATES-SENTINEL\n"],
        [path.join(lexrunnerDir, "config.yaml"), "AUTHORED-CONFIG-SENTINEL\n"],
        [path.join(lexrunnerDir, "gate-mapping.yaml"), "AUTHORED-MAPPING-SENTINEL\n"],
        [path.join(tempDir, ".github", "copilot-instructions.md"), "AUTHORED-COPILOT-SENTINEL\n"],
        [path.join(workflowsDir, "merge-weave.yaml"), "AUTHORED-WORKFLOW-SENTINEL\n"],
      ]);
      for (const [file, content] of preserved) fs.writeFileSync(file, content);

      const repaired = await runInit({
        nonInteractive: true,
        enterprise: true,
        jsonMode: true,
      });

      expect(repaired.success).toBe(true);
      for (const [file, content] of preserved) {
        expect(fs.readFileSync(file, "utf8")).toBe(content);
      }
      for (const file of ["intent.md", "scope.yml", "deps.yml"]) {
        expect(fs.existsSync(path.join(profileDir, file))).toBe(true);
      }

      const forced = await runInit({
        nonInteractive: true,
        enterprise: true,
        force: true,
        jsonMode: true,
      });

      expect(forced.success).toBe(true);
      for (const file of [
        path.join(profileDir, "gates.yml"),
        path.join(lexrunnerDir, "config.yaml"),
        path.join(lexrunnerDir, "gate-mapping.yaml"),
        path.join(tempDir, ".github", "copilot-instructions.md"),
      ]) {
        expect(fs.readFileSync(file, "utf8")).not.toContain("SENTINEL");
      }
      expect(fs.readFileSync(path.join(workflowsDir, "merge-weave.yaml"), "utf8")).toBe(
        "AUTHORED-WORKFLOW-SENTINEL\n"
      );
    });

    it("should respect --force flag in enterprise mode", async () => {
      // Create initial enterprise workspace
      const result1 = await runInit({
        nonInteractive: true,
        enterprise: true,
        jsonMode: true,
      });

      expect(result1.success).toBe(true);

      // Modify enterprise config
      const configPath = path.join(result1.profileDir, ".lexrunner", "config.yaml");
      fs.writeFileSync(configPath, "# Modified");

      // Try to reinitialize without force (should fail)
      const result2 = await runInit({
        nonInteractive: true,
        enterprise: true,
        jsonMode: true,
      });

      expect(result2.success).toBe(false);
      expect(result2.message).toContain("already exists");

      // Reinitialize with force (should succeed)
      const result3 = await runInit({
        nonInteractive: true,
        enterprise: true,
        force: true,
        jsonMode: true,
      });

      expect(result3.success).toBe(true);

      // Verify config was recreated
      const newConfig = fs.readFileSync(configPath, "utf-8");
      expect(newConfig).not.toBe("# Modified");
      expect(newConfig).toContain("version: 1");
    });
  });

  describe("Non-enterprise mode should still work", () => {
    it("should create standard workspace without enterprise flag", async () => {
      const result = await runInit({
        nonInteractive: true,
        jsonMode: true,
      });

      expect(result.success).toBe(true);

      // Should have basic files
      const profileDir = result.profileDir;
      expect(fs.existsSync(path.join(profileDir, "intent.md"))).toBe(true);
      expect(fs.existsSync(path.join(profileDir, "scope.yml"))).toBe(true);

      // Should NOT have enterprise structure
      const lexrunnerDir = path.join(profileDir, ".lexrunner");
      expect(fs.existsSync(lexrunnerDir)).toBe(false);
    });
  });
});
