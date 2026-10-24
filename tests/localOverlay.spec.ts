import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  initLocalOverlay,
  hasLocalOverlay,
  LocalOverlayError,
} from "../src/config/localOverlay.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import YAML from "yaml";

const admissionRace = vi.hoisted(() => ({
  enabled: false,
  operation: "" as
    | "write"
    | "copy"
    | "manifest-check"
    | "force-stage-file"
    | "force-stage-protected"
    | "force-stage-protected-occupied"
    | "",
  destination: "",
  content: "",
  renames: [] as Array<{ from: string; to: string }>,
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync(file: fs.PathLike) {
      if (
        admissionRace.enabled &&
        admissionRace.operation === "manifest-check" &&
        path.resolve(String(file)) === path.resolve(admissionRace.destination)
      ) {
        actual.writeFileSync(file, admissionRace.content);
        admissionRace.enabled = false;
        return false;
      }
      return actual.existsSync(file);
    },
    writeFileSync(
      file: fs.PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
      options?: fs.WriteFileOptions
    ) {
      if (
        admissionRace.enabled &&
        admissionRace.operation === "write" &&
        path.resolve(String(file)) === path.resolve(admissionRace.destination)
      ) {
        actual.writeFileSync(file, admissionRace.content);
        admissionRace.enabled = false;
      }
      actual.writeFileSync(file, data, options);
    },
    copyFileSync(from: fs.PathLike, to: fs.PathLike, mode?: number) {
      if (
        admissionRace.enabled &&
        admissionRace.operation === "copy" &&
        path.resolve(String(to)) === path.resolve(admissionRace.destination)
      ) {
        actual.writeFileSync(to, admissionRace.content);
        admissionRace.enabled = false;
      }
      actual.copyFileSync(from, to, mode);
    },
    renameSync(oldPath: fs.PathLike, newPath: fs.PathLike) {
      admissionRace.renames.push({ from: String(oldPath), to: String(newPath) });
      if (
        admissionRace.enabled &&
        (admissionRace.operation === "force-stage-file" ||
          admissionRace.operation === "force-stage-protected" ||
          admissionRace.operation === "force-stage-protected-occupied") &&
        path.resolve(String(oldPath)) === path.resolve(admissionRace.destination)
      ) {
        const operation = admissionRace.operation;
        actual.writeFileSync(path.join(String(oldPath), "concurrent.txt"), admissionRace.content);
        if (
          operation === "force-stage-protected" ||
          operation === "force-stage-protected-occupied"
        ) {
          actual.writeFileSync(path.join(String(oldPath), "profile.yml"), "role: example\n");
        }
        admissionRace.enabled = false;
        actual.renameSync(oldPath, newPath);
        if (operation === "force-stage-protected-occupied") {
          actual.mkdirSync(oldPath, { recursive: true });
          actual.writeFileSync(path.join(String(oldPath), "profile.yml"), "role: development\n");
          actual.writeFileSync(path.join(String(oldPath), "competing.txt"), "competing");
        }
        return;
      }
      actual.renameSync(oldPath, newPath);
    },
  };
});

describe("Local Overlay Setup", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-overlay-test-"));
    admissionRace.enabled = false;
    admissionRace.operation = "";
    admissionRace.destination = "";
    admissionRace.content = "";
    admissionRace.renames = [];
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
      expect(result2.backupPath).toBeDefined();
      expect(fs.readFileSync(path.join(result2.backupPath!, "custom.txt"), "utf8")).toBe("custom");
    });

    it("retains files admitted immediately before atomic force staging", () => {
      const localDir = path.join(tempDir, ".smartergpt.local");
      initLocalOverlay(tempDir);
      fs.writeFileSync(path.join(localDir, "marker.txt"), "original");
      admissionRace.enabled = true;
      admissionRace.operation = "force-stage-file";
      admissionRace.destination = localDir;
      admissionRace.content = "concurrent";

      const result = initLocalOverlay(tempDir, true);

      expect(admissionRace.enabled).toBe(false);
      expect(result.backupPath).toBeDefined();
      expect(result.backupPath).toContain(path.join("runner", "force-backups"));
      expect(fs.readFileSync(path.join(result.backupPath!, "marker.txt"), "utf8")).toBe("original");
      expect(fs.readFileSync(path.join(result.backupPath!, "concurrent.txt"), "utf8")).toBe(
        "concurrent"
      );
      expect(fs.readFileSync(path.join(result.backupPath!, "profile.yml"), "utf8")).toContain(
        "role: development"
      );
      expect(fs.existsSync(path.join(localDir, "concurrent.txt"))).toBe(false);
    });

    it("retains an untrackable profile that becomes protected before force staging", () => {
      const localDir = path.join(tempDir, ".smartergpt.local");
      fs.mkdirSync(path.join(tempDir, ".git"), { recursive: true });
      initLocalOverlay(tempDir);
      fs.writeFileSync(path.join(localDir, "marker.txt"), "original");
      admissionRace.enabled = true;
      admissionRace.operation = "force-stage-protected";
      admissionRace.destination = localDir;
      admissionRace.content = "concurrent";

      let caught: unknown;
      try {
        initLocalOverlay(tempDir, true);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain('role="example" (read-only)');
      const backupPath = (caught as Error & { retainedBackupPath?: string }).retainedBackupPath;
      expect(backupPath).toBeDefined();
      expect(path.resolve(backupPath!)).toContain(
        path.resolve(path.join(tempDir, ".git", "lexrunner", "force-stages"))
      );
      expect((caught as Error).message).toContain(backupPath!);
      expect(fs.readFileSync(path.join(backupPath!, "profile.yml"), "utf8")).toBe(
        "role: example\n"
      );
      expect(fs.readFileSync(path.join(backupPath!, "marker.txt"), "utf8")).toBe("original");
      expect(fs.readFileSync(path.join(backupPath!, "concurrent.txt"), "utf8")).toBe("concurrent");
      expect(fs.existsSync(localDir)).toBe(false);
      expect(admissionRace.renames).toHaveLength(1);
    });

    it("retains an untrackable stage when another writer reclaims the original path", () => {
      const localDir = path.join(tempDir, ".smartergpt.local");
      fs.mkdirSync(path.join(tempDir, ".git"), { recursive: true });
      initLocalOverlay(tempDir);
      fs.writeFileSync(path.join(localDir, "marker.txt"), "original");
      admissionRace.enabled = true;
      admissionRace.operation = "force-stage-protected-occupied";
      admissionRace.destination = localDir;
      admissionRace.content = "concurrent";

      let caught: unknown;
      try {
        initLocalOverlay(tempDir, true);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain('role="example" (read-only)');
      const backupPath = (caught as Error & { retainedBackupPath?: string }).retainedBackupPath;
      expect(backupPath).toBeDefined();
      expect(path.resolve(backupPath!)).toContain(
        path.resolve(path.join(tempDir, ".git", "lexrunner", "force-stages"))
      );
      expect((caught as Error).message).toContain(backupPath!);
      expect(fs.readFileSync(path.join(backupPath!, "profile.yml"), "utf8")).toBe(
        "role: example\n"
      );
      expect(fs.readFileSync(path.join(backupPath!, "marker.txt"), "utf8")).toBe("original");
      expect(fs.readFileSync(path.join(backupPath!, "concurrent.txt"), "utf8")).toBe("concurrent");
      expect(fs.readFileSync(path.join(localDir, "competing.txt"), "utf8")).toBe("competing");
    });

    it("refuses a read-only overlay without mutating it", () => {
      const localDir = path.join(tempDir, ".smartergpt.local");
      const manifestPath = path.join(localDir, "profile.yml");
      const markerPath = path.join(localDir, "marker.txt");
      fs.mkdirSync(localDir, { recursive: true });
      fs.writeFileSync(manifestPath, "role: example\n");
      fs.writeFileSync(markerPath, "preserve");

      expect(() => initLocalOverlay(tempDir)).toThrow('role="example" (read-only)');

      expect(fs.readFileSync(manifestPath, "utf8")).toBe("role: example\n");
      expect(fs.readFileSync(markerPath, "utf8")).toBe("preserve");
      expect(fs.existsSync(path.join(localDir, "runner"))).toBe(false);
      expect(fs.existsSync(path.join(localDir, "scope.yml"))).toBe(false);
    });

    it("does not let force bypass a read-only overlay", () => {
      const localDir = path.join(tempDir, ".smartergpt.local");
      const manifestPath = path.join(localDir, "profile.yml");
      const markerPath = path.join(localDir, "marker.txt");
      fs.mkdirSync(localDir, { recursive: true });
      fs.writeFileSync(manifestPath, "role: example\n");
      fs.writeFileSync(markerPath, "preserve");

      expect(() => initLocalOverlay(tempDir, true)).toThrow('role="example" (read-only)');

      expect(fs.readFileSync(manifestPath, "utf8")).toBe("role: example\n");
      expect(fs.readFileSync(markerPath, "utf8")).toBe("preserve");
      expect(fs.existsSync(path.join(localDir, "runner"))).toBe(false);
    });

    it("preserves a protected manifest created after a manifestless force check", () => {
      const localDir = path.join(tempDir, ".smartergpt.local");
      const manifestPath = path.join(localDir, "profile.yml");
      const markerPath = path.join(localDir, "marker.txt");
      fs.mkdirSync(localDir, { recursive: true });
      fs.writeFileSync(markerPath, "preserve");
      admissionRace.enabled = true;
      admissionRace.operation = "manifest-check";
      admissionRace.destination = manifestPath;
      admissionRace.content = "role: example\n";

      expect(() => initLocalOverlay(tempDir, true)).toThrow(
        "Cannot force recreation of existing local overlay without a validated manifest"
      );

      expect(admissionRace.enabled).toBe(false);
      expect(fs.readFileSync(manifestPath, "utf8")).toBe("role: example\n");
      expect(fs.readFileSync(markerPath, "utf8")).toBe("preserve");
      expect(fs.existsSync(path.join(localDir, "runner"))).toBe(false);
    });

    it("rejects malformed manifest fields before mutating the overlay", () => {
      const localDir = path.join(tempDir, ".smartergpt.local");
      const manifestPath = path.join(localDir, "profile.yml");
      const markerPath = path.join(localDir, "marker.txt");
      fs.mkdirSync(localDir, { recursive: true });
      fs.writeFileSync(manifestPath, "role: [example]\n");
      fs.writeFileSync(markerPath, "preserve");

      expect(() => initLocalOverlay(tempDir)).toThrow(LocalOverlayError);

      expect(fs.readFileSync(manifestPath, "utf8")).toBe("role: [example]\n");
      expect(fs.readFileSync(markerPath, "utf8")).toBe("preserve");
      expect(fs.existsSync(path.join(localDir, "runner"))).toBe(false);
      expect(fs.existsSync(path.join(localDir, "scope.yml"))).toBe(false);
    });

    it("preserves and authorizes a manifest created during exclusive admission", () => {
      const localDir = path.join(tempDir, ".smartergpt.local");
      const manifestPath = path.join(localDir, "profile.yml");
      admissionRace.enabled = true;
      admissionRace.operation = "write";
      admissionRace.destination = manifestPath;
      admissionRace.content = "role: example\n";

      expect(() => initLocalOverlay(tempDir)).toThrow('role="example" (read-only)');

      expect(admissionRace.enabled).toBe(false);
      expect(fs.readFileSync(manifestPath, "utf8")).toBe("role: example\n");
      expect(fs.existsSync(path.join(localDir, "runner"))).toBe(false);
      expect(fs.existsSync(path.join(localDir, "scope.yml"))).toBe(false);
    });

    it("preserves a config file created during default admission", () => {
      const localDir = path.join(tempDir, ".smartergpt.local");
      const scopePath = path.join(localDir, "scope.yml");
      fs.mkdirSync(localDir, { recursive: true });
      fs.writeFileSync(path.join(localDir, "profile.yml"), "role: development\n");
      admissionRace.enabled = true;
      admissionRace.operation = "write";
      admissionRace.destination = scopePath;
      admissionRace.content = "version: 1\ntarget: concurrent-default\n";

      initLocalOverlay(tempDir);

      expect(admissionRace.enabled).toBe(false);
      expect(fs.readFileSync(scopePath, "utf8")).toContain("target: concurrent-default");
    });

    it("preserves a config file created during tracked-copy admission", () => {
      const trackedDir = path.join(tempDir, ".smartergpt");
      const localDir = path.join(tempDir, ".smartergpt.local");
      const scopePath = path.join(localDir, "scope.yml");
      fs.mkdirSync(trackedDir, { recursive: true });
      fs.mkdirSync(localDir, { recursive: true });
      fs.writeFileSync(path.join(trackedDir, "scope.yml"), "version: 1\ntarget: tracked\n");
      fs.writeFileSync(path.join(localDir, "profile.yml"), "role: development\n");
      admissionRace.enabled = true;
      admissionRace.operation = "copy";
      admissionRace.destination = scopePath;
      admissionRace.content = "version: 1\ntarget: concurrent-copy\n";

      const result = initLocalOverlay(tempDir);

      expect(admissionRace.enabled).toBe(false);
      expect(result.copiedFiles).not.toContain("scope.yml");
      expect(fs.readFileSync(scopePath, "utf8")).toContain("target: concurrent-copy");
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
