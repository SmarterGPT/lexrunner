import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  bootstrapWorkspace,
  createMinimalWorkspace,
  detectProjectType,
  getEnvironmentSuggestions,
  BootstrapError,
} from "../src/core/bootstrap.js";
import { WriteProtectionError, canWriteToProfile } from "../src/config/profileResolver.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("Bootstrap Configuration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe("bootstrapWorkspace", () => {
    it("should detect missing configuration", () => {
      const result = bootstrapWorkspace(tempDir);

      expect(result.hasConfiguration).toBe(false);
      expect(result.missingFiles).toEqual(["intent.md", "scope.yml", "deps.yml", "gates.yml"]);
      expect(result.suggestions.length).toBeGreaterThan(0);
      expect(result.profileDir).toBe(path.join(tempDir, ".smartergpt"));
    });

    it("should detect existing configuration", () => {
      const profileDir = path.join(tempDir, ".smartergpt");
      fs.mkdirSync(profileDir);

      // Create all expected files
      fs.writeFileSync(path.join(profileDir, "intent.md"), "# Intent");
      fs.writeFileSync(path.join(profileDir, "scope.yml"), "version: 1");
      fs.writeFileSync(path.join(profileDir, "deps.yml"), "version: 1");
      fs.writeFileSync(path.join(profileDir, "gates.yml"), "version: 1");

      const result = bootstrapWorkspace(tempDir);

      expect(result.hasConfiguration).toBe(true);
      expect(result.missingFiles).toEqual([]);
      expect(result.suggestions.length).toBe(0);
    });

    it("should detect partial configuration", () => {
      const profileDir = path.join(tempDir, ".smartergpt");
      fs.mkdirSync(profileDir);

      // Create only some files
      fs.writeFileSync(path.join(profileDir, "intent.md"), "# Intent");
      fs.writeFileSync(path.join(profileDir, "scope.yml"), "version: 1");

      const result = bootstrapWorkspace(tempDir);

      expect(result.hasConfiguration).toBe(false);
      expect(result.missingFiles).toEqual(["deps.yml", "gates.yml"]);
      expect(result.suggestions.length).toBeGreaterThan(0);
    });
  });

  describe("createMinimalWorkspace", () => {
    it("should create all required configuration files", () => {
      // Use .smartergpt.local which will be auto-discovered
      const profileDir = path.join(tempDir, ".smartergpt.local");
      fs.mkdirSync(profileDir, { recursive: true });

      // Create a manifest with writable role
      fs.writeFileSync(
        path.join(profileDir, "profile.yml"),
        "role: local\nname: Test Local Profile\n"
      );

      createMinimalWorkspace(tempDir);

      const expectedFiles = ["intent.md", "scope.yml", "deps.yml", "gates.yml"];

      // In v1 structure, config files live at profile root and runner/ holds artifacts
      const runnerDir = path.join(profileDir, "runner");

      expect(fs.existsSync(profileDir)).toBe(true);
      expect(fs.existsSync(runnerDir)).toBe(true);

      for (const file of expectedFiles) {
        const rootPath = path.join(profileDir, file);
        expect(fs.existsSync(rootPath)).toBe(true);
        const content = fs.readFileSync(rootPath, "utf-8");
        expect(content.length).toBeGreaterThan(0);
      }
    });

    it("should not overwrite existing files", () => {
      const profileDir = path.join(tempDir, ".smartergpt.local");
      fs.mkdirSync(profileDir, { recursive: true });

      // Create a manifest with writable role
      fs.writeFileSync(
        path.join(profileDir, "profile.yml"),
        "role: local\nname: Test Local Profile\n"
      );

      const existingContent = "# Existing content";
      fs.writeFileSync(path.join(profileDir, "intent.md"), existingContent);

      createMinimalWorkspace(tempDir);

      const content = fs.readFileSync(path.join(profileDir, "intent.md"), "utf-8");
      expect(content).toBe(existingContent);
    });

    it("should create proper YAML structure in configuration files", () => {
      const profileDir = path.join(tempDir, ".smartergpt.local");
      fs.mkdirSync(profileDir, { recursive: true });

      // Create a manifest with writable role
      fs.writeFileSync(
        path.join(profileDir, "profile.yml"),
        "role: local\nname: Test Local Profile\n"
      );

      createMinimalWorkspace(tempDir);

      // In v1 structure, config files live at profile root
      const scopeContent = fs.readFileSync(path.join(profileDir, "scope.yml"), "utf-8");
      expect(scopeContent).toContain("version: 1");
      expect(scopeContent).toContain("target: main");

      // Check deps.yml has proper YAML structure
      const depsContent = fs.readFileSync(path.join(profileDir, "deps.yml"), "utf-8");
      expect(depsContent).toContain("version: 1");
      expect(depsContent).toContain("depends_on: []");
      expect(depsContent).toContain("strategies: {}");

      // Check gates.yml has proper YAML structure
      const gatesContent = fs.readFileSync(path.join(profileDir, "gates.yml"), "utf-8");
      expect(gatesContent).toContain("version: 1");
      expect(gatesContent).toContain("levels:");
      expect(gatesContent).toContain("default: []");
    });
  });

  describe("detectProjectType", () => {
    it("should detect Node.js project", () => {
      fs.writeFileSync(path.join(tempDir, "package.json"), "{}");

      const projectType = detectProjectType(tempDir);
      expect(projectType).toBe("nodejs");
    });

    it("should detect Python project with pyproject.toml", () => {
      fs.writeFileSync(path.join(tempDir, "pyproject.toml"), "[tool.poetry]");

      const projectType = detectProjectType(tempDir);
      expect(projectType).toBe("python");
    });

    it("should detect Python project with requirements.txt", () => {
      fs.writeFileSync(path.join(tempDir, "requirements.txt"), "requests==2.28.0");

      const projectType = detectProjectType(tempDir);
      expect(projectType).toBe("python");
    });

    it("should detect Rust project", () => {
      fs.writeFileSync(path.join(tempDir, "Cargo.toml"), "[package]");

      const projectType = detectProjectType(tempDir);
      expect(projectType).toBe("rust");
    });

    it("should detect Go project", () => {
      fs.writeFileSync(path.join(tempDir, "go.mod"), "module example");

      const projectType = detectProjectType(tempDir);
      expect(projectType).toBe("go");
    });

    it("should default to generic for unknown projects", () => {
      const projectType = detectProjectType(tempDir);
      expect(projectType).toBe("generic");
    });
  });

  describe("getEnvironmentSuggestions", () => {
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      originalEnv = { ...process.env };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("should suggest CI-specific configurations in CI environment", () => {
      process.env.CI = "true";

      const suggestions = getEnvironmentSuggestions();

      expect(suggestions.some((s) => s.includes("CI environment"))).toBe(true);
    });

    it("should suggest GitHub Actions configurations", () => {
      process.env.GITHUB_ACTIONS = "true";

      const suggestions = getEnvironmentSuggestions();

      expect(suggestions.some((s) => s.includes("GitHub Actions"))).toBe(true);
    });

    it("should return empty array in minimal environment", () => {
      delete process.env.CI;
      delete process.env.GITHUB_ACTIONS;

      const suggestions = getEnvironmentSuggestions();

      // Should still work, might be empty or have Docker suggestion
      expect(Array.isArray(suggestions)).toBe(true);
    });
  });

  describe("BootstrapError", () => {
    it("should create proper error instances", () => {
      const error = new BootstrapError("Test bootstrap error");

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(BootstrapError);
      expect(error.message).toBe("Test bootstrap error");
      expect(error.name).toBe("BootstrapError");
    });
  });

  describe("Write Protection", () => {
    it('should prevent writing to role="example" profiles', () => {
      const trackedDir = path.join(tempDir, ".smartergpt");
      fs.mkdirSync(trackedDir, { recursive: true });

      // .smartergpt without manifest defaults to role=example
      // Attempting to create workspace should fail
      expect(() => {
        createMinimalWorkspace(tempDir);
      }).toThrow(WriteProtectionError);
    });

    it("should reject a non-scalar manifest role before creating files", () => {
      const localDir = path.join(tempDir, ".smartergpt.local");
      fs.mkdirSync(localDir, { recursive: true });
      fs.writeFileSync(path.join(localDir, "profile.yml"), "role: [example]\n");

      expect(() => createMinimalWorkspace(tempDir)).toThrow(WriteProtectionError);

      expect(fs.existsSync(path.join(localDir, "runner"))).toBe(false);
      expect(fs.existsSync(path.join(localDir, "scope.yml"))).toBe(false);
    });

    it("should normalize whitespace before enforcing the example role", () => {
      const localDir = path.join(tempDir, ".smartergpt.local");
      fs.mkdirSync(localDir, { recursive: true });
      fs.writeFileSync(path.join(localDir, "profile.yml"), 'role: " example "\n');

      expect(() => createMinimalWorkspace(tempDir)).toThrow(WriteProtectionError);

      expect(fs.existsSync(path.join(localDir, "runner"))).toBe(false);
      expect(fs.existsSync(path.join(localDir, "scope.yml"))).toBe(false);
    });

    it('should allow writing to role="local" profiles', () => {
      const localDir = path.join(tempDir, ".smartergpt.local");
      fs.mkdirSync(localDir, { recursive: true });

      // Create manifest with role=local
      fs.writeFileSync(path.join(localDir, "profile.yml"), "role: local\nname: Local Profile\n");

      // Should succeed
      expect(() => {
        createMinimalWorkspace(tempDir);
      }).not.toThrow();
    });

    it("should allow writing to custom writable profiles via env var", () => {
      const customDir = path.join(tempDir, "custom-profile");
      fs.mkdirSync(customDir, { recursive: true });

      // Create manifest with custom role
      fs.writeFileSync(
        path.join(customDir, "profile.yml"),
        "role: development\nname: Dev Profile\n"
      );

      // Set env var to point to custom profile
      const originalEnv = process.env.LEX_PR_PROFILE_DIR;
      process.env.LEX_PR_PROFILE_DIR = customDir;

      try {
        // Should succeed
        expect(() => {
          createMinimalWorkspace(tempDir);
        }).not.toThrow();
      } finally {
        // Restore env
        if (originalEnv) {
          process.env.LEX_PR_PROFILE_DIR = originalEnv;
        } else {
          delete process.env.LEX_PR_PROFILE_DIR;
        }
      }
    });

    it("should validate write permissions with canWriteToProfile helper", () => {
      // role="example" should not be writable
      expect(canWriteToProfile("/some/path", "example")).toBe(false);

      // Other roles should be writable
      expect(canWriteToProfile("/some/path", "local")).toBe(true);
      expect(canWriteToProfile("/some/path", "development")).toBe(true);
      expect(canWriteToProfile("/some/path", "production")).toBe(true);
      expect(canWriteToProfile("/some/path", "custom")).toBe(true);
    });

    it("should provide clear error message for write protection violations", () => {
      const trackedDir = path.join(tempDir, ".smartergpt");
      fs.mkdirSync(trackedDir, { recursive: true });

      try {
        createMinimalWorkspace(tempDir);
        expect.fail("Should have thrown WriteProtectionError");
      } catch (error) {
        expect(error).toBeInstanceOf(WriteProtectionError);
        expect((error as Error).message).toContain('role="example"');
        expect((error as Error).message).toContain("read-only");
        expect((error as Error).message).toContain(".smartergpt.local");
      }
    });
  });
});
