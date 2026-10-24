import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { resolveConfigPath, resetMigrationNotice } from "../src/config/pathResolver.js";

describe("Config Path Resolver", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "path-resolver-test-"));
    resetMigrationNotice();
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe("resolveConfigPath", () => {
    it("prefers canonical profile-root config over compatibility runner config", () => {
      const runnerDir = path.join(tempDir, "runner");
      fs.mkdirSync(runnerDir, { recursive: true });

      // Create files in both locations
      fs.writeFileSync(path.join(runnerDir, "scope.yml"), "version: 1 # runner");
      fs.writeFileSync(path.join(tempDir, "scope.yml"), "version: 1 # flat");

      const resolved = resolveConfigPath(tempDir, "scope.yml");

      expect(resolved.exists).toBe(true);
      expect(resolved.source).toBe("profile-root");
      expect(resolved.path).toBe(path.join(tempDir, "scope.yml"));
      expect(resolved.shouldNotifyMigration).toBe(false);
    });

    it("falls back to compatibility runner config and requests one remediation notice", () => {
      const runnerDir = path.join(tempDir, "runner");
      fs.mkdirSync(runnerDir, { recursive: true });
      fs.writeFileSync(path.join(runnerDir, "scope.yml"), "version: 1");

      const resolved = resolveConfigPath(tempDir, "scope.yml");

      expect(resolved.exists).toBe(true);
      expect(resolved.source).toBe("runner/ (compatibility)");
      expect(resolved.path).toBe(path.join(runnerDir, "scope.yml"));
      expect(resolved.shouldNotifyMigration).toBe(true);
    });

    it("should return non-existent path when file does not exist", () => {
      const resolved = resolveConfigPath(tempDir, "nonexistent.yml");

      expect(resolved.exists).toBe(false);
      expect(resolved.source).toBe("profile-root");
      expect(resolved.path).toBe(path.join(tempDir, "nonexistent.yml"));
      expect(resolved.shouldNotifyMigration).toBe(false);
    });

    it("should only notify migration once per process", () => {
      const runnerDir = path.join(tempDir, "runner");
      fs.mkdirSync(runnerDir, { recursive: true });
      fs.writeFileSync(path.join(runnerDir, "scope.yml"), "version: 1");
      fs.writeFileSync(path.join(runnerDir, "deps.yml"), "version: 1");

      const resolved1 = resolveConfigPath(tempDir, "scope.yml");
      expect(resolved1.shouldNotifyMigration).toBe(true);

      const resolved2 = resolveConfigPath(tempDir, "deps.yml");
      expect(resolved2.shouldNotifyMigration).toBe(false); // Already notified
    });

    it("keeps the canonical root authoritative when both layouts exist", () => {
      const runnerDir = path.join(tempDir, "runner");
      fs.mkdirSync(runnerDir, { recursive: true });

      fs.writeFileSync(path.join(runnerDir, "gates.yml"), "version: 1 # new");
      fs.writeFileSync(path.join(tempDir, "gates.yml"), "version: 1 # old");

      const resolved = resolveConfigPath(tempDir, "gates.yml");

      expect(resolved.source).toBe("profile-root");
      expect(resolved.path).toBe(path.join(tempDir, "gates.yml"));
    });

    it("falls back file-by-file from a partial local overlay to the tracked workspace", () => {
      const localProfile = path.join(tempDir, ".smartergpt.local");
      const workspaceProfile = path.join(tempDir, ".smartergpt");
      fs.mkdirSync(localProfile, { recursive: true });
      fs.mkdirSync(workspaceProfile, { recursive: true });
      fs.writeFileSync(path.join(localProfile, "scope.yml"), "version: 1 # local");
      fs.writeFileSync(path.join(workspaceProfile, "deps.yml"), "version: 1 # workspace");

      const local = resolveConfigPath(localProfile, "scope.yml");
      const fallback = resolveConfigPath(localProfile, "deps.yml");

      expect(local).toMatchObject({
        exists: true,
        source: "profile-root",
        path: path.join(localProfile, "scope.yml"),
      });
      expect(fallback).toMatchObject({
        exists: true,
        source: "workspace fallback",
        path: path.join(workspaceProfile, "deps.yml"),
        shouldNotifyMigration: false,
      });
    });

    it("keeps local runner compatibility ahead of the tracked workspace fallback", () => {
      const localProfile = path.join(tempDir, ".smartergpt.local");
      const workspaceProfile = path.join(tempDir, ".smartergpt");
      fs.mkdirSync(path.join(localProfile, "runner"), { recursive: true });
      fs.mkdirSync(workspaceProfile, { recursive: true });
      fs.writeFileSync(path.join(localProfile, "runner", "gates.yml"), "version: 1 # local");
      fs.writeFileSync(path.join(workspaceProfile, "gates.yml"), "version: 1 # workspace");

      const resolved = resolveConfigPath(localProfile, "gates.yml");

      expect(resolved).toMatchObject({
        source: "runner/ (compatibility)",
        path: path.join(localProfile, "runner", "gates.yml"),
        shouldNotifyMigration: true,
      });
    });

    it("reports tracked runner fallback as compatibility and can disable sibling fallback", () => {
      const localProfile = path.join(tempDir, ".smartergpt.local");
      const workspaceRunner = path.join(tempDir, ".smartergpt", "runner");
      fs.mkdirSync(localProfile, { recursive: true });
      fs.mkdirSync(workspaceRunner, { recursive: true });
      fs.writeFileSync(path.join(workspaceRunner, "intent.md"), "# Intent");

      const fallback = resolveConfigPath(localProfile, "intent.md");
      const isolated = resolveConfigPath(localProfile, "intent.md", {
        allowWorkspaceFallback: false,
      });

      expect(fallback).toMatchObject({
        source: "workspace runner/ (compatibility)",
        path: path.join(workspaceRunner, "intent.md"),
        shouldNotifyMigration: true,
      });
      expect(isolated).toMatchObject({
        exists: false,
        source: "profile-root",
        path: path.join(localProfile, "intent.md"),
      });
    });
  });

  describe("migration notice state", () => {
    it("should reset migration notice state", () => {
      const runnerDir = path.join(tempDir, "runner");
      fs.mkdirSync(runnerDir, { recursive: true });
      fs.writeFileSync(path.join(runnerDir, "scope.yml"), "version: 1");

      // First resolve should notify
      const resolved1 = resolveConfigPath(tempDir, "scope.yml");
      expect(resolved1.shouldNotifyMigration).toBe(true);

      // Second resolve should not notify
      const resolved2 = resolveConfigPath(tempDir, "deps.yml");
      expect(resolved2.shouldNotifyMigration).toBe(false);

      // After reset, should notify again
      resetMigrationNotice();
      fs.writeFileSync(path.join(runnerDir, "deps.yml"), "version: 1");
      const resolved3 = resolveConfigPath(tempDir, "deps.yml");
      expect(resolved3.shouldNotifyMigration).toBe(true);
    });
  });

  describe("multiple config files", () => {
    it("should handle multiple config files with consistent behavior", () => {
      const runnerDir = path.join(tempDir, "runner");
      fs.mkdirSync(runnerDir, { recursive: true });

      // Mix compatibility and canonical files.
      fs.writeFileSync(path.join(runnerDir, "scope.yml"), "version: 1");
      fs.writeFileSync(path.join(tempDir, "deps.yml"), "version: 1");
      fs.writeFileSync(path.join(runnerDir, "gates.yml"), "version: 1");

      const scopeResolved = resolveConfigPath(tempDir, "scope.yml");
      expect(scopeResolved.source).toBe("runner/ (compatibility)");

      const depsResolved = resolveConfigPath(tempDir, "deps.yml");
      expect(depsResolved.source).toBe("profile-root");

      const gatesResolved = resolveConfigPath(tempDir, "gates.yml");
      expect(gatesResolved.source).toBe("runner/ (compatibility)");
    });
  });
});
