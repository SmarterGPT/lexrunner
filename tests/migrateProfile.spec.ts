import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { runMigrateProfile } from "../src/commands/migrateProfile.js";

const rootRace = vi.hoisted(() => ({
  enabled: false,
  destination: "",
  content: "",
}));
const backupFault = vi.hoisted(() => ({
  enabled: false,
  copyFrom: "",
}));
const unlinkFault = vi.hoisted(() => ({
  enabled: false,
  file: "",
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    copyFileSync(from: fs.PathLike, to: fs.PathLike, mode?: number) {
      const source = String(from);
      const destination = String(to);
      if (backupFault.enabled && source === backupFault.copyFrom) {
        throw new Error("injected backup copy failure");
      }
      if (rootRace.enabled && destination === rootRace.destination) {
        actual.writeFileSync(destination, rootRace.content);
        rootRace.enabled = false;
      }
      actual.copyFileSync(from, to, mode);
    },
    unlinkSync(target: fs.PathLike) {
      const selected = String(target).replaceAll("\\", "/");
      if (unlinkFault.enabled && selected.endsWith(`/staging/${unlinkFault.file}`)) {
        throw new Error("injected staging unlink failure");
      }
      actual.unlinkSync(target);
    },
  };
});

describe("Migrate Profile Command", () => {
  let tempDir: string;
  let profileDir: string;
  let runnerDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-profile-test-"));
    profileDir = path.join(tempDir, ".smartergpt.local");
    runnerDir = path.join(profileDir, "runner");
    fs.mkdirSync(runnerDir, { recursive: true });

    rootRace.enabled = false;
    rootRace.destination = "";
    rootRace.content = "";
    backupFault.enabled = false;
    backupFault.copyFrom = "";
    unlinkFault.enabled = false;
    unlinkFault.file = "";

    // Create profile manifest
    fs.writeFileSync(path.join(profileDir, "profile.yml"), "role: local\nname: Test Profile\n");
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe("basic migration", () => {
    it("moves compatibility config from runner/ to the canonical profile root", async () => {
      fs.writeFileSync(path.join(runnerDir, "scope.yml"), "version: 1");
      fs.writeFileSync(path.join(runnerDir, "deps.yml"), "version: 1");
      fs.writeFileSync(path.join(runnerDir, "gates.yml"), "version: 1");

      const result = await runMigrateProfile({
        fromRunner: true,
        profileDir,
      });

      expect(result.success).toBe(true);
      expect(result.migratedFiles.length).toBe(3);
      expect(result.migratedFiles).toContain("scope.yml");
      expect(result.migratedFiles).toContain("deps.yml");
      expect(result.migratedFiles).toContain("gates.yml");

      expect(fs.existsSync(path.join(profileDir, "scope.yml"))).toBe(true);
      expect(fs.existsSync(path.join(profileDir, "deps.yml"))).toBe(true);
      expect(fs.existsSync(path.join(profileDir, "gates.yml"))).toBe(true);
      expect(fs.existsSync(path.join(runnerDir, "scope.yml"))).toBe(false);
      expect(fs.existsSync(path.join(runnerDir, "deps.yml"))).toBe(false);
      expect(fs.existsSync(path.join(runnerDir, "gates.yml"))).toBe(false);
    });

    it("should create backup before migration", async () => {
      fs.writeFileSync(path.join(runnerDir, "scope.yml"), "version: 1");

      const result = await runMigrateProfile({
        fromRunner: true,
        profileDir,
      });

      expect(result.success).toBe(true);
      expect(result.backupPath).toBeDefined();
      expect(path.basename(result.backupPath!)).toBe("runner-config");
      expect(fs.existsSync(result.backupPath!)).toBe(true);
      expect(fs.existsSync(path.join(result.backupPath!, "scope.yml"))).toBe(true);
    });

    it("should preserve file contents during migration", async () => {
      const scopeContent = 'version: 1\ntarget: main\nsources:\n  - query: "is:pr"';
      fs.writeFileSync(path.join(runnerDir, "scope.yml"), scopeContent);

      await runMigrateProfile({
        fromRunner: true,
        profileDir,
      });

      const migratedContent = fs.readFileSync(path.join(profileDir, "scope.yml"), "utf-8");
      expect(migratedContent).toBe(scopeContent);
    });
  });

  describe("dry-run mode", () => {
    it("should not migrate files in dry-run mode", async () => {
      fs.writeFileSync(path.join(runnerDir, "scope.yml"), "version: 1");
      fs.writeFileSync(path.join(runnerDir, "deps.yml"), "version: 1");

      const result = await runMigrateProfile({
        fromRunner: true,
        dryRun: true,
        profileDir,
      });

      expect(result.success).toBe(true);
      expect(result.migratedFiles.length).toBe(2);
      expect(result.migratedFiles[0]).toContain("(would migrate)");

      expect(fs.existsSync(path.join(profileDir, "scope.yml"))).toBe(false);
      expect(fs.existsSync(path.join(profileDir, "deps.yml"))).toBe(false);
      expect(fs.existsSync(path.join(runnerDir, "scope.yml"))).toBe(true);
      expect(fs.readdirSync(profileDir).some((name) => name.startsWith(".backup-"))).toBe(false);
    });

    it("should report what would be migrated in dry-run", async () => {
      fs.writeFileSync(path.join(runnerDir, "intent.md"), "# Intent");
      fs.writeFileSync(path.join(runnerDir, "scope.yml"), "version: 1");

      const result = await runMigrateProfile({
        fromRunner: true,
        dryRun: true,
        profileDir,
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain("Would migrate 2 file(s)");
      expect(result.message).toContain("profile root");
    });
  });

  describe("idempotency", () => {
    it("should be idempotent - safe to run multiple times", async () => {
      fs.writeFileSync(path.join(runnerDir, "scope.yml"), "version: 1");

      // First migration
      const result1 = await runMigrateProfile({
        fromRunner: true,
        profileDir,
      });
      expect(result1.success).toBe(true);
      expect(result1.migratedFiles.length).toBe(1);

      // Second migration should report already complete
      const result2 = await runMigrateProfile({
        fromRunner: true,
        profileDir,
      });
      expect(result2.success).toBe(true);
      expect(result2.migratedFiles.length).toBe(0);
      expect(result2.message).toContain("No compatibility configuration files found under runner/");
    });

    it("never overwrites a canonical root file and preserves the compatibility copy", async () => {
      fs.writeFileSync(path.join(runnerDir, "scope.yml"), "version: 1 # compatibility");
      fs.writeFileSync(path.join(profileDir, "scope.yml"), "version: 1 # canonical");
      fs.writeFileSync(path.join(runnerDir, "deps.yml"), "version: 1");

      const result = await runMigrateProfile({
        fromRunner: true,
        profileDir,
      });

      expect(result.success).toBe(true);
      expect(result.migratedFiles).toContain("deps.yml");
      expect(result.migratedFiles).not.toContain("scope.yml");
      expect(result.skippedFiles.some((f) => f.includes("scope.yml"))).toBe(true);

      const scopeContent = fs.readFileSync(path.join(runnerDir, "scope.yml"), "utf-8");
      expect(scopeContent).toContain("# compatibility");
      expect(fs.readFileSync(path.join(profileDir, "scope.yml"), "utf8")).toContain("# canonical");
    });
  });

  describe("error handling", () => {
    it("should report when no files need migration", async () => {
      const result = await runMigrateProfile({
        fromRunner: true,
        profileDir,
      });

      expect(result.success).toBe(true);
      expect(result.migratedFiles.length).toBe(0);
      expect(result.message).toContain("No compatibility configuration files found under runner/");
    });

    it("should report when profile directory does not exist", async () => {
      const nonExistentDir = path.join(tempDir, "nonexistent");

      const result = await runMigrateProfile({
        fromRunner: true,
        profileDir: nonExistentDir,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain("Profile directory error");
    });

    it("should require --from-runner", async () => {
      const result = await runMigrateProfile({
        profileDir,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain("No migration type specified");
      expect(result.message).toContain("--from-runner");
    });

    it("retires --from-flat with a non-mutating refusal", async () => {
      fs.writeFileSync(path.join(profileDir, "scope.yml"), "version: 1 # canonical");

      const result = await runMigrateProfile({
        fromFlat: true,
        profileDir,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain("profile-root configuration is canonical");
      expect(result.message).toContain("--from-runner");
      expect(fs.readFileSync(path.join(profileDir, "scope.yml"), "utf8")).toContain("# canonical");
      expect(fs.existsSync(path.join(runnerDir, "scope.yml"))).toBe(false);
    });

    it("refuses to mutate a read-only example profile while keeping dry-run observational", async () => {
      fs.writeFileSync(path.join(profileDir, "profile.yml"), "role: example\n");
      fs.writeFileSync(path.join(runnerDir, "scope.yml"), "version: 1\n");

      const dryRun = await runMigrateProfile({ fromRunner: true, dryRun: true, profileDir });
      const result = await runMigrateProfile({ fromRunner: true, profileDir });

      expect(dryRun).toMatchObject({
        success: true,
        migratedFiles: ["scope.yml (would migrate)"],
      });
      expect(result).toMatchObject({ success: false, migratedFiles: [], skippedFiles: [] });
      expect(result.message).toContain('role="example" (read-only)');
      expect(fs.existsSync(path.join(runnerDir, "scope.yml"))).toBe(true);
      expect(fs.existsSync(path.join(profileDir, "scope.yml"))).toBe(false);
      expect(fs.readdirSync(profileDir).some((name) => name.startsWith(".backup-"))).toBe(false);
    });

    it.each([
      ["non-scalar", "role: [example]\n"],
      ["padded example", 'role: " example "\n'],
      ["empty scalar", 'role: "   "\n'],
    ])("refuses to migrate with a %s manifest role", async (_name, manifest) => {
      const runnerPath = path.join(runnerDir, "scope.yml");
      const rootPath = path.join(profileDir, "scope.yml");
      fs.writeFileSync(path.join(profileDir, "profile.yml"), manifest);
      fs.writeFileSync(runnerPath, "version: 1 # preserve\n");

      const result = await runMigrateProfile({ fromRunner: true, profileDir });

      expect(result).toMatchObject({
        success: false,
        migratedFiles: [],
        skippedFiles: [],
      });
      expect(result.message).toContain("Profile directory error");
      expect(result.message).toContain("read-only");
      expect(fs.readFileSync(runnerPath, "utf8")).toContain("# preserve");
      expect(fs.existsSync(rootPath)).toBe(false);
      expect(fs.readdirSync(profileDir).some((name) => name.startsWith(".backup-"))).toBe(false);
    });

    it("preserves both files when a canonical root appears during migration", async () => {
      const runnerPath = path.join(runnerDir, "scope.yml");
      const rootPath = path.join(profileDir, "scope.yml");
      fs.writeFileSync(runnerPath, "version: 1 # compatibility");
      rootRace.destination = rootPath;
      rootRace.content = "version: 1 # concurrent canonical";
      rootRace.enabled = true;

      const result = await runMigrateProfile({ fromRunner: true, profileDir });

      expect(result).toMatchObject({
        success: true,
        migratedFiles: [],
        backupStatus: "complete",
      });
      expect(result.skippedFiles).toContain(
        "scope.yml (profile-root file appeared during migration; compatibility copy preserved)"
      );
      expect(result.retainedFiles).toBeUndefined();
      expect(fs.readFileSync(rootPath, "utf8")).toContain("# concurrent canonical");
      expect(fs.readFileSync(runnerPath, "utf8")).toContain("# compatibility");
      expect(fs.readFileSync(path.join(result.backupPath!, "scope.yml"), "utf8")).toContain(
        "# compatibility"
      );
    });

    it("retains completed moves and every copy when staging cleanup fails", async () => {
      fs.writeFileSync(path.join(runnerDir, "scope.yml"), "version: 1 # scope");
      fs.writeFileSync(path.join(runnerDir, "deps.yml"), "version: 1 # deps");
      unlinkFault.file = "deps.yml";
      unlinkFault.enabled = true;

      const result = await runMigrateProfile({ fromRunner: true, profileDir });

      expect(result).toMatchObject({
        success: false,
        migratedFiles: ["scope.yml"],
        uncertainFiles: ["deps.yml"],
        backupStatus: "complete",
      });
      expect(result.retainedFiles).toHaveLength(1);
      expect(result.message).toContain("Completed safe moves were retained for: scope.yml");
      expect(result.message).toContain("Reconcile the in-flight file: deps.yml");
      expect(fs.existsSync(path.join(profileDir, "scope.yml"))).toBe(true);
      expect(fs.existsSync(path.join(runnerDir, "scope.yml"))).toBe(false);
      expect(fs.existsSync(path.join(profileDir, "deps.yml"))).toBe(true);
      expect(fs.existsSync(path.join(runnerDir, "deps.yml"))).toBe(true);
      expect(fs.existsSync(result.retainedFiles![0])).toBe(true);
      expect(fs.existsSync(path.join(result.backupPath!, "deps.yml"))).toBe(true);
    });

    it("reports an incomplete backup without moving source files", async () => {
      fs.writeFileSync(path.join(runnerDir, "scope.yml"), "version: 1");
      fs.writeFileSync(path.join(runnerDir, "deps.yml"), "version: 1");
      backupFault.copyFrom = path.join(runnerDir, "deps.yml");
      backupFault.enabled = true;
      let result: Awaited<ReturnType<typeof runMigrateProfile>> | undefined;
      try {
        result = await runMigrateProfile({ fromRunner: true, profileDir });
      } finally {
        backupFault.enabled = false;
      }
      expect(result).toBeDefined();
      if (!result) throw new Error("migration result missing");

      expect(result).toMatchObject({
        success: false,
        migratedFiles: [],
        backupStatus: "incomplete",
      });
      expect(result.uncertainFiles).toBeUndefined();
      expect(result.message).toContain("No files completed migration");
      expect(result.message).toContain("is incomplete and must not be relied upon for recovery");
      expect(result.message).not.toContain("complete backup is retained");
      expect(result.backupPath).toBeDefined();
      expect(fs.existsSync(path.join(result.backupPath!, "scope.yml"))).toBe(true);
      expect(fs.existsSync(path.join(result.backupPath!, "deps.yml"))).toBe(false);
      expect(fs.existsSync(path.join(runnerDir, "scope.yml"))).toBe(true);
      expect(fs.existsSync(path.join(runnerDir, "deps.yml"))).toBe(true);
      expect(fs.existsSync(path.join(profileDir, "scope.yml"))).toBe(false);
    });
  });

  describe("all config files", () => {
    it("should migrate all supported config files", async () => {
      const configFiles = [
        "intent.md",
        "scope.yml",
        "deps.yml",
        "gates.yml",
        "stack.yml",
        "merge-policy.yml",
        "pull-request-template.md",
      ];

      // Create every supported compatibility config under runner/.
      configFiles.forEach((file) => {
        fs.writeFileSync(path.join(runnerDir, file), `# ${file}`);
      });

      const result = await runMigrateProfile({
        fromRunner: true,
        profileDir,
      });

      expect(result.success).toBe(true);
      expect(result.migratedFiles.length).toBe(configFiles.length);

      configFiles.forEach((file) => {
        expect(fs.existsSync(path.join(profileDir, file))).toBe(true);
        expect(fs.existsSync(path.join(runnerDir, file))).toBe(false);
      });
    });
  });

  describe("partial migration", () => {
    it("should migrate only compatibility files that exist under runner/", async () => {
      fs.writeFileSync(path.join(runnerDir, "scope.yml"), "version: 1");
      fs.writeFileSync(path.join(runnerDir, "gates.yml"), "version: 1");

      const result = await runMigrateProfile({
        fromRunner: true,
        profileDir,
      });

      expect(result.success).toBe(true);
      expect(result.migratedFiles.length).toBe(2);
      expect(result.migratedFiles).toContain("scope.yml");
      expect(result.migratedFiles).toContain("gates.yml");
      expect(result.migratedFiles).not.toContain("deps.yml");
    });
  });
});
