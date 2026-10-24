import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runInit } from "../src/commands/init.js";
import { WriteProtectionError } from "../src/config/profileResolver.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createRequire, syncBuiltinESMExports } from "node:module";

const mutableNodeFs = createRequire(import.meta.url)("node:fs") as {
  mkdirSync: typeof fs.mkdirSync;
};

describe("Init Command", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "init-test-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe("Non-interactive mode", () => {
    it("should create workspace with default configuration", async () => {
      const result = await runInit({
        nonInteractive: true,
      });

      expect(result.success).toBe(true);
      expect(result.profileDir).toContain(".smartergpt.local");

      // Check that profile root contains configuration files (v1 structure)
      const configFiles = ["intent.md", "scope.yml", "deps.yml", "gates.yml"];

      for (const file of configFiles) {
        const filePath = path.join(result.profileDir, file);
        expect(fs.existsSync(filePath)).toBe(true);
      }

      // Check runner/ subdirectory exists for working artifacts
      const runnerDir = path.join(result.profileDir, "runner");
      expect(fs.existsSync(runnerDir)).toBe(true);

      // Check profile.yml is in root of profile dir
      const profileManifest = path.join(result.profileDir, "profile.yml");
      expect(fs.existsSync(profileManifest)).toBe(true);

      // Check pull-request-template.md lives at profile root
      const prTemplate = path.join(result.profileDir, "pull-request-template.md");
      expect(fs.existsSync(prTemplate)).toBe(true);
    });

    it("should respect --profile-dir option", async () => {
      const customDir = path.join(tempDir, "custom-profile");
      fs.mkdirSync(customDir, { recursive: true });

      // Create manifest for custom directory
      fs.writeFileSync(path.join(customDir, "profile.yml"), "role: local\nname: Custom Profile\n");

      const result = await runInit({
        nonInteractive: true,
        profileDir: customDir,
      });

      expect(result.success).toBe(true);
      expect(result.profileDir).toBe(customDir);
      expect(fs.existsSync(customDir)).toBe(true);
    });

    it("should fail when configuration exists without --force", async () => {
      // Create initial configuration
      await runInit({ nonInteractive: true });

      // Try to create again without force
      const result = await runInit({ nonInteractive: true });

      expect(result.success).toBe(false);
      expect(result.message).toContain("already exists");
    });

    it("should continue initialization with --force without overwriting existing files", async () => {
      // Create initial configuration
      const result1 = await runInit({ nonInteractive: true });

      // Modify a file in root config
      const intentPath = path.join(result1.profileDir, "intent.md");
      fs.writeFileSync(intentPath, "# Modified content");

      // Create again with force
      const result2 = await runInit({
        nonInteractive: true,
        force: true,
      });

      expect(result2.success).toBe(true);

      // Standard force initialization fills missing files but preserves authored content.
      const currentContent = fs.readFileSync(intentPath, "utf-8");
      expect(currentContent).toBe("# Modified content");
    });

    it("should reject a concurrent winner of an initially absent profile leaf", async () => {
      const profileDir = path.join(tempDir, ".smartergpt.local");
      const originalMkdir = mutableNodeFs.mkdirSync;
      const injectedMkdir = ((...args: Parameters<typeof fs.mkdirSync>) => {
        if (path.resolve(String(args[0])) === profileDir && args[1] === undefined) {
          Reflect.apply(originalMkdir, fs, [profileDir, { recursive: true }]);
          fs.writeFileSync(path.join(profileDir, "profile.yml"), "role: local\nname: Other\n");
          fs.writeFileSync(path.join(profileDir, "sentinel.txt"), "preserve-me\n");
        }
        return Reflect.apply(originalMkdir, fs, args);
      }) as typeof fs.mkdirSync;
      mutableNodeFs.mkdirSync = injectedMkdir;
      syncBuiltinESMExports();
      try {
        await expect(runInit({ nonInteractive: true })).rejects.toThrow(WriteProtectionError);
      } finally {
        mutableNodeFs.mkdirSync = originalMkdir;
        syncBuiltinESMExports();
      }
      expect(fs.readFileSync(path.join(profileDir, "sentinel.txt"), "utf8")).toBe("preserve-me\n");
      expect(fs.existsSync(path.join(profileDir, "runner"))).toBe(false);
    });
  });

  describe("Profile directory selection", () => {
    it("should use .smartergpt.local when no tracked example exists", async () => {
      const result = await runInit({ nonInteractive: true });

      expect(result.success).toBe(true);
      expect(result.profileDir).toContain(".smartergpt.local");
    });

    it("should suggest .smartergpt.local when tracked example exists", async () => {
      // Create a tracked example
      const trackedDir = path.join(tempDir, ".smartergpt");
      fs.mkdirSync(trackedDir);
      fs.writeFileSync(
        path.join(trackedDir, "profile.yml"),
        "role: example\nname: Example Profile\n"
      );

      const result = await runInit({ nonInteractive: true });

      expect(result.success).toBe(true);
      expect(result.profileDir).toContain(".smartergpt.local");
      expect(result.profileDir).not.toBe(trackedDir);
    });
  });

  describe("File generation", () => {
    it("should create intent.md with project goals template", async () => {
      const result = await runInit({ nonInteractive: true });

      const intentPath = path.join(result.profileDir, "intent.md");
      const content = fs.readFileSync(intentPath, "utf-8");

      expect(content).toContain("# Project Intent");
      expect(content).toContain("## Goals");
      expect(content).toContain("## Success Criteria");
    });

    it("should create scope.yml with proper structure", async () => {
      const result = await runInit({ nonInteractive: true });

      const scopePath = path.join(result.profileDir, "scope.yml");
      const content = fs.readFileSync(scopePath, "utf-8");

      expect(content).toContain("version: 1");
      expect(content).toContain("target: main");
      expect(content).toContain("sources:");
    });

    it("should create gates.yml with the schema-valid default level", async () => {
      const result = await runInit({ nonInteractive: true });

      const gatesPath = path.join(result.profileDir, "gates.yml");
      const content = fs.readFileSync(gatesPath, "utf-8");

      expect(content).toContain("version: 1");
      expect(content).toContain("levels:");
      expect(content).toContain("default: []");
    });

    it("should create pull-request-template.md with dependency syntax", async () => {
      const result = await runInit({ nonInteractive: true });

      const templatePath = path.join(result.profileDir, "pull-request-template.md");
      const content = fs.readFileSync(templatePath, "utf-8");

      expect(content).toContain("Depends-On:");
      expect(content).toContain("#123");
      expect(content).toContain("## Dependencies");
    });

    it("should create profile.yml with local role", async () => {
      const result = await runInit({ nonInteractive: true });

      const manifestPath = path.join(result.profileDir, "profile.yml");
      const content = fs.readFileSync(manifestPath, "utf-8");

      expect(content).toContain("role: local");
      expect(content).toContain("name: Local Development Profile");
    });

    it("should not overwrite existing files", async () => {
      const result = await runInit({ nonInteractive: true });

      const intentPath = path.join(result.profileDir, "runner", "intent.md");
      const customContent = "# My Custom Intent";
      fs.writeFileSync(intentPath, customContent);

      // Run init again with force, but files shouldn't overwrite
      await runInit({ nonInteractive: true, force: true });

      const content = fs.readFileSync(intentPath, "utf-8");
      expect(content).toBe(customContent);
    });
  });

  describe("Project type detection", () => {
    it("should detect Node.js project", async () => {
      fs.writeFileSync(path.join(tempDir, "package.json"), "{}");

      const result = await runInit({ nonInteractive: true });

      expect(result.success).toBe(true);
      // Detection happens during init, but we can't easily assert console output in tests
    });

    it("should detect Python project", async () => {
      fs.writeFileSync(path.join(tempDir, "requirements.txt"), "requests==2.28.0");

      const result = await runInit({ nonInteractive: true });

      expect(result.success).toBe(true);
    });
  });

  describe("Error handling", () => {
    it("should handle write protection errors", async () => {
      // Create a read-only tracked profile
      const trackedDir = path.join(tempDir, ".smartergpt");
      fs.mkdirSync(trackedDir);
      fs.writeFileSync(
        path.join(trackedDir, "profile.yml"),
        "role: example\nname: Example Profile\n"
      );

      // Try to init with explicit read-only dir (should fail)
      await expect(
        runInit({
          nonInteractive: true,
          profileDir: trackedDir,
        })
      ).rejects.toBeInstanceOf(WriteProtectionError);
    });
  });

  describe("GitHub token handling", () => {
    it("should use environment variable if available", async () => {
      const originalToken = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = "test-token";

      try {
        const result = await runInit({ nonInteractive: true });
        expect(result.success).toBe(true);
        // Token validation happens internally
      } finally {
        if (originalToken) {
          process.env.GITHUB_TOKEN = originalToken;
        } else {
          delete process.env.GITHUB_TOKEN;
        }
      }
    });

    it("should use provided token option", async () => {
      const result = await runInit({
        nonInteractive: true,
        githubToken: "cli-token",
      });

      expect(result.success).toBe(true);
      // Token validation happens internally
    });
  });
});
