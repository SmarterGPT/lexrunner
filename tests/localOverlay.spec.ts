import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  initLocalOverlay,
  hasLocalOverlay,
  LocalOverlayError,
} from "../src/config/localOverlay.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import YAML from "yaml";

describe("Local Overlay Setup", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-overlay-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe("initLocalOverlay", () => {
    it("should create .smartergpt.local directory", () => {
      const result = initLocalOverlay(tempDir);

      expect(result.created).toBe(true);
      expect(fs.existsSync(path.join(tempDir, ".smartergpt.local"))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, ".smartergpt.local", "runner"))).toBe(true);
    });

    it("should create profile.yml with role: development", () => {
      const result = initLocalOverlay(tempDir);

      const manifestPath = path.join(tempDir, ".smartergpt.local", "profile.yml");
      expect(fs.existsSync(manifestPath)).toBe(true);

      const content = fs.readFileSync(manifestPath, "utf8");
      const parsed = YAML.parse(content);

      expect(parsed.role).toBe("development");
      expect(result.config.role).toBe("development");
    });

    it("should detect Node.js project type", () => {
      fs.writeFileSync(path.join(tempDir, "package.json"), "{}");

      const result = initLocalOverlay(tempDir);

      expect(result.config.projectType).toBe("nodejs");

      const manifestPath = path.join(tempDir, ".smartergpt.local", "profile.yml");
      const content = fs.readFileSync(manifestPath, "utf8");
      const parsed = YAML.parse(content);
      expect(parsed.projectType).toBe("nodejs");
    });

    it("should detect Python project type", () => {
      fs.writeFileSync(path.join(tempDir, "requirements.txt"), "requests==2.28.0");

      const result = initLocalOverlay(tempDir);

      expect(result.config.projectType).toBe("python");
    });

    it("should detect Rust project type", () => {
      fs.writeFileSync(path.join(tempDir, "Cargo.toml"), "[package]");

      const result = initLocalOverlay(tempDir);

      expect(result.config.projectType).toBe("rust");
    });

    it("should detect Go project type", () => {
      fs.writeFileSync(path.join(tempDir, "go.mod"), "module example");

      const result = initLocalOverlay(tempDir);

      expect(result.config.projectType).toBe("go");
    });

    it("should default to generic project type", () => {
      const result = initLocalOverlay(tempDir);

      expect(result.config.projectType).toBe("generic");
    });

    it("should be no-op if local overlay already exists", () => {
      // First initialization
      const result1 = initLocalOverlay(tempDir);
      expect(result1.created).toBe(true);

      // Second initialization (should skip)
      const result2 = initLocalOverlay(tempDir);
      expect(result2.created).toBe(false);
      expect(result2.path).toBe(path.join(tempDir, ".smartergpt.local"));
    });

    it("repairs the artifact-only runner directory without rewriting an existing overlay", () => {
      const localDir = path.join(tempDir, ".smartergpt.local");
      fs.mkdirSync(localDir, { recursive: true });
      fs.writeFileSync(path.join(localDir, "profile.yml"), "role: development\n");
      fs.writeFileSync(path.join(localDir, "scope.yml"), "version: 1\ntarget: custom\n");

      const result = initLocalOverlay(tempDir);

      expect(result.created).toBe(false);
      expect(result.copiedFiles).toEqual([]);
      expect(fs.existsSync(path.join(localDir, "runner"))).toBe(true);
      expect(fs.readFileSync(path.join(localDir, "scope.yml"), "utf8")).toContain("target: custom");
    });

    it("should force recreation when force flag is set", () => {
      // First initialization
      const result1 = initLocalOverlay(tempDir);
      expect(result1.created).toBe(true);

      // Create a custom file
      fs.writeFileSync(path.join(tempDir, ".smartergpt.local", "custom.txt"), "custom");

      // Force recreation
      const result2 = initLocalOverlay(tempDir, true);
      expect(result2.created).toBe(true);
      expect(fs.existsSync(path.join(tempDir, ".smartergpt.local", "custom.txt"))).toBe(false);
    });

    it("should copy files from .smartergpt/ if it exists", () => {
      // Create .smartergpt directory with files
      const smartergptDir = path.join(tempDir, ".smartergpt");
      fs.mkdirSync(smartergptDir, { recursive: true });
      fs.writeFileSync(path.join(smartergptDir, "intent.md"), "# Intent");
      fs.writeFileSync(path.join(smartergptDir, "scope.yml"), "version: 1");
      fs.writeFileSync(path.join(smartergptDir, "deps.yml"), "version: 1");
      fs.writeFileSync(path.join(smartergptDir, "gates.yml"), "version: 1");
      fs.writeFileSync(path.join(smartergptDir, "merge-policy.yml"), "version: 1");

      const result = initLocalOverlay(tempDir);

      expect(result.copiedFiles.length).toBeGreaterThan(0);
      expect(result.copiedFiles).toEqual([
        "intent.md",
        "scope.yml",
        "deps.yml",
        "gates.yml",
        "merge-policy.yml",
      ]);

      // Configuration is copied to the profile root; runner/ remains artifact-only.
      const localDir = path.join(tempDir, ".smartergpt.local");
      for (const file of result.copiedFiles) {
        expect(fs.existsSync(path.join(localDir, file))).toBe(true);
        expect(fs.existsSync(path.join(localDir, "runner", file))).toBe(false);
      }
    });

    it("should not overwrite existing files in local overlay", () => {
      // Create .smartergpt directory
      const smartergptDir = path.join(tempDir, ".smartergpt");
      fs.mkdirSync(smartergptDir, { recursive: true });
      fs.writeFileSync(path.join(smartergptDir, "intent.md"), "# Original");

      // Create local overlay with existing file
      const localDir = path.join(tempDir, ".smartergpt.local");
      fs.mkdirSync(localDir, { recursive: true });
      fs.writeFileSync(path.join(localDir, "intent.md"), "# Custom");

      const result = initLocalOverlay(tempDir);

      expect(result.created).toBe(false);
      const content = fs.readFileSync(path.join(localDir, "intent.md"), "utf8");
      expect(content).toBe("# Custom");
    });

    it("should handle missing .smartergpt gracefully", () => {
      const result = initLocalOverlay(tempDir);

      expect(result.created).toBe(true);
      expect(result.copiedFiles).toEqual([]);
    });

    it("should copy pull-request-template.md if present", () => {
      const smartergptDir = path.join(tempDir, ".smartergpt");
      fs.mkdirSync(smartergptDir, { recursive: true });
      fs.writeFileSync(path.join(smartergptDir, "pull-request-template.md"), "# PR Template");

      const result = initLocalOverlay(tempDir);

      expect(result.copiedFiles).toContain("pull-request-template.md");
      expect(
        fs.existsSync(path.join(tempDir, ".smartergpt.local", "pull-request-template.md"))
      ).toBe(true);
    });

    it("normalizes compatibility source config into the local profile root", () => {
      const compatibilityDir = path.join(tempDir, ".smartergpt", "runner");
      fs.mkdirSync(compatibilityDir, { recursive: true });
      fs.writeFileSync(path.join(compatibilityDir, "scope.yml"), "version: 1\ntarget: main\n");

      const result = initLocalOverlay(tempDir);

      expect(result.copiedFiles).toEqual(["scope.yml"]);
      expect(
        fs.readFileSync(path.join(tempDir, ".smartergpt.local", "scope.yml"), "utf8")
      ).toContain("target: main");
      expect(fs.existsSync(path.join(tempDir, ".smartergpt.local", "runner", "scope.yml"))).toBe(
        false
      );
    });

    it("should not copy runtime artifacts", () => {
      const smartergptDir = path.join(tempDir, ".smartergpt");
      fs.mkdirSync(smartergptDir, { recursive: true });
      fs.mkdirSync(path.join(smartergptDir, "runner-artifacts"), { recursive: true });
      fs.mkdirSync(path.join(smartergptDir, "gate-results"), { recursive: true });
      fs.writeFileSync(path.join(smartergptDir, "runner-artifacts", "plan.json"), "{}");

      const result = initLocalOverlay(tempDir);

      const localRunnerDir = path.join(tempDir, ".smartergpt.local", "runner");
      // runner/ directory should exist (we create it) but shouldn't have copied artifacts
      expect(fs.existsSync(localRunnerDir)).toBe(true);
      expect(fs.existsSync(path.join(tempDir, ".smartergpt.local", "gate-results"))).toBe(false);
    });
  });

  describe("hasLocalOverlay", () => {
    it("should return false when local overlay does not exist", () => {
      expect(hasLocalOverlay(tempDir)).toBe(false);
    });

    it("should return true when local overlay exists", () => {
      initLocalOverlay(tempDir);
      expect(hasLocalOverlay(tempDir)).toBe(true);
    });
  });
});
