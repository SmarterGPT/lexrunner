import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  canWriteToProfile,
  resolveProfile,
  ProfileResolverError,
  logProfileMessage,
  validateWriteOperation,
  WriteProtectionError,
} from "../src/config/profileResolver.js";
import { resetDeprecationNotices } from "../src/util/envUtils.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("Profile Resolver", () => {
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-test-"));
    originalEnv = { ...process.env };
    // Reset deprecation notices to allow testing them
    resetDeprecationNotices();
    // Spy on console.error since telemetry now uses stderr
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
    process.env = originalEnv;
    consoleSpy.mockRestore();
  });

  describe("Precedence Chain", () => {
    it("should use --profile-dir flag as highest precedence", () => {
      // Set up all options
      const customDir = path.join(tempDir, "custom");
      fs.mkdirSync(customDir, { recursive: true });
      fs.writeFileSync(
        path.join(customDir, "profile.yml"),
        "role: custom\nname: Custom Profile\nversion: 1.0.0"
      );

      process.env.LEX_PR_PROFILE_DIR = path.join(tempDir, "env");
      fs.mkdirSync(path.join(tempDir, ".smartergpt.local"), { recursive: true });
      fs.mkdirSync(path.join(tempDir, ".smartergpt"), { recursive: true });

      const result = resolveProfile(customDir, tempDir);

      expect(result.path).toBe(customDir);
      expect(result.manifest.role).toBe("custom");
      expect(result.manifest.name).toBe("Custom Profile");
      expect(result.manifest.version).toBe("1.0.0");
    });

    it("should use LEX_PR_PROFILE_DIR env var when no flag provided", () => {
      const envDir = path.join(tempDir, "env");
      fs.mkdirSync(envDir, { recursive: true });
      fs.writeFileSync(path.join(envDir, "profile.yml"), "role: environment\nname: Env Profile");

      process.env.LEX_PR_PROFILE_DIR = envDir;
      fs.mkdirSync(path.join(tempDir, ".smartergpt.local"), { recursive: true });
      fs.mkdirSync(path.join(tempDir, ".smartergpt"), { recursive: true });

      const result = resolveProfile(undefined, tempDir);

      expect(result.path).toBe(envDir);
      expect(result.manifest.role).toBe("environment");
      expect(result.manifest.name).toBe("Env Profile");
    });

    it("should use .smartergpt.local/ when it exists and no flag/env", () => {
      const localDir = path.join(tempDir, ".smartergpt.local");
      fs.mkdirSync(localDir, { recursive: true });
      fs.writeFileSync(path.join(localDir, "profile.yml"), "role: local\nname: Local Profile");

      fs.mkdirSync(path.join(tempDir, ".smartergpt"), { recursive: true });

      const result = resolveProfile(undefined, tempDir);

      expect(result.path).toBe(localDir);
      expect(result.manifest.role).toBe("local");
      expect(result.manifest.name).toBe("Local Profile");
    });

    it("should fallback to .smartergpt/ when no other options", () => {
      const trackedDir = path.join(tempDir, ".smartergpt");
      fs.mkdirSync(trackedDir, { recursive: true });
      fs.writeFileSync(
        path.join(trackedDir, "profile.yml"),
        "role: tracked\nname: Tracked Profile"
      );

      const result = resolveProfile(undefined, tempDir);

      expect(result.path).toBe(trackedDir);
      expect(result.manifest.role).toBe("tracked");
      expect(result.manifest.name).toBe("Tracked Profile");
    });
  });

  describe("Manifest Parsing", () => {
    it("should parse complete manifest with all fields", () => {
      const profileDir = path.join(tempDir, "profile");
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(
        path.join(profileDir, "profile.yml"),
        "role: production\nname: Prod Profile\nversion: 2.1.0"
      );

      const result = resolveProfile(profileDir, tempDir);

      expect(result.manifest).toEqual({
        role: "production",
        name: "Prod Profile",
        version: "2.1.0",
      });
    });

    it("should parse manifest with only role field", () => {
      const profileDir = path.join(tempDir, "profile");
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(path.join(profileDir, "profile.yml"), "role: minimal");

      const result = resolveProfile(profileDir, tempDir);

      expect(result.manifest).toEqual({
        role: "minimal",
        name: undefined,
        version: undefined,
      });
    });

    it('should default role to "example" when missing in manifest', () => {
      const profileDir = path.join(tempDir, "profile");
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(path.join(profileDir, "profile.yml"), "name: No Role Profile");

      const result = resolveProfile(profileDir, tempDir);

      expect(result.manifest.role).toBe("example");
      expect(result.manifest.name).toBe("No Role Profile");
    });

    it("should default to role: example for .smartergpt/ without manifest", () => {
      const trackedDir = path.join(tempDir, ".smartergpt");
      fs.mkdirSync(trackedDir, { recursive: true });
      // No profile.yml created

      const result = resolveProfile(undefined, tempDir);

      expect(result.path).toBe(trackedDir);
      expect(result.manifest).toEqual({
        role: "example",
      });
    });

    it("should throw error for missing manifest in custom directory", () => {
      const customDir = path.join(tempDir, "custom");
      fs.mkdirSync(customDir, { recursive: true });
      // No profile.yml created

      expect(() => resolveProfile(customDir, tempDir)).toThrow(ProfileResolverError);
      expect(() => resolveProfile(customDir, tempDir)).toThrow(
        `Profile directory "${customDir}" (from --profile-dir) is missing profile.yml manifest`
      );
    });

    it("reports a syntactically malformed manifest as invalid without exposing its contents", () => {
      const customDir = path.join(tempDir, "custom");
      fs.mkdirSync(customDir, { recursive: true });
      fs.writeFileSync(path.join(customDir, "profile.yml"), "role: [PRIVATE-SENTINEL\n");

      let thrown: unknown;
      try {
        resolveProfile(customDir, tempDir);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ProfileResolverError);
      expect((thrown as Error).message).toBe(
        `Profile directory "${customDir}" (from --profile-dir) has an invalid profile.yml manifest`
      );
      expect((thrown as Error).message).not.toContain("PRIVATE-SENTINEL");
      expect((thrown as Error).message).not.toContain("missing profile.yml");
    });

    it("does not default a malformed tracked manifest to the example role", () => {
      const trackedDir = path.join(tempDir, ".smartergpt");
      fs.mkdirSync(trackedDir, { recursive: true });
      fs.writeFileSync(path.join(trackedDir, "profile.yml"), "role: [unterminated\n");

      expect(() => resolveProfile(undefined, tempDir)).toThrow(
        `Profile directory "${trackedDir}" (from .smartergpt/) has an invalid profile.yml manifest`
      );
    });

    it("reports a non-object manifest root as invalid", () => {
      const customDir = path.join(tempDir, "custom");
      fs.mkdirSync(customDir, { recursive: true });
      fs.writeFileSync(path.join(customDir, "profile.yml"), "just-a-scalar\n");

      expect(() => resolveProfile(customDir, tempDir)).toThrow(
        `Profile directory "${customDir}" (from --profile-dir) has an invalid profile.yml manifest`
      );
    });

    it("distinguishes an unreadable manifest entry from an absent manifest", () => {
      const customDir = path.join(tempDir, "custom");
      fs.mkdirSync(path.join(customDir, "profile.yml"), { recursive: true });

      expect(() => resolveProfile(customDir, tempDir)).toThrow(
        `Profile directory "${customDir}" (from --profile-dir) has an unreadable profile.yml manifest`
      );
    });

    it("should throw error for missing manifest from env var", () => {
      const envDir = path.join(tempDir, "env");
      fs.mkdirSync(envDir, { recursive: true });
      process.env.LEX_PR_PROFILE_DIR = envDir;
      // No profile.yml created

      expect(() => resolveProfile(undefined, tempDir)).toThrow(ProfileResolverError);
    });

    it("should throw error for missing manifest in .smartergpt.local/", () => {
      const localDir = path.join(tempDir, ".smartergpt.local");
      fs.mkdirSync(localDir, { recursive: true });
      // No profile.yml created

      expect(() => resolveProfile(undefined, tempDir)).toThrow(ProfileResolverError);
    });
  });

  describe("Write Authority", () => {
    it.each([
      ["array", ["example"]],
      ["object", { name: "example" }],
      ["null", null],
      ["undefined", undefined],
      ["empty", ""],
      ["whitespace-only", " \t\n"],
    ])("fails closed for a %s role", (_name, role) => {
      expect(canWriteToProfile(tempDir, role)).toBe(false);
      expect(() => validateWriteOperation(tempDir, role, "write test artifact")).toThrow(
        WriteProtectionError
      );
    });

    it.each([" example ", "\tEXAMPLE\r\n"])(
      "normalizes a padded example role before enforcing read-only policy",
      (role) => {
        expect(canWriteToProfile(tempDir, role)).toBe(false);
        expect(() => validateWriteOperation(tempDir, role, "write test artifact")).toThrow(
          'role="example" (read-only)'
        );
      }
    );

    it("retains custom writable roles after scalar normalization", () => {
      expect(canWriteToProfile(tempDir, " development ")).toBe(true);
      expect(() =>
        validateWriteOperation(tempDir, " DEVELOPMENT ", "write test artifact")
      ).not.toThrow();
    });
  });

  describe("Path Resolution", () => {
    it("should resolve relative paths to absolute paths", () => {
      const relativeDir = "custom";
      const absoluteDir = path.join(tempDir, relativeDir);
      fs.mkdirSync(absoluteDir, { recursive: true });
      fs.writeFileSync(path.join(absoluteDir, "profile.yml"), "role: relative");

      const result = resolveProfile(relativeDir, tempDir);

      expect(path.isAbsolute(result.path)).toBe(true);
      expect(result.path).toBe(absoluteDir);
    });

    it("should handle absolute paths correctly", () => {
      const absoluteDir = path.join(tempDir, "absolute");
      fs.mkdirSync(absoluteDir, { recursive: true });
      fs.writeFileSync(path.join(absoluteDir, "profile.yml"), "role: absolute");

      const result = resolveProfile(absoluteDir, tempDir);

      expect(result.path).toBe(absoluteDir);
    });

    it("should resolve env var relative paths", () => {
      const relativeDir = "env-relative";
      const absoluteDir = path.join(tempDir, relativeDir);
      fs.mkdirSync(absoluteDir, { recursive: true });
      fs.writeFileSync(path.join(absoluteDir, "profile.yml"), "role: env-relative");

      process.env.LEX_PR_PROFILE_DIR = relativeDir;

      const result = resolveProfile(undefined, tempDir);

      expect(path.isAbsolute(result.path)).toBe(true);
      expect(result.path).toBe(absoluteDir);
    });

    it("should always return absolute path for .smartergpt/", () => {
      const trackedDir = path.join(tempDir, ".smartergpt");
      fs.mkdirSync(trackedDir, { recursive: true });

      const result = resolveProfile(undefined, tempDir);

      expect(path.isAbsolute(result.path)).toBe(true);
      expect(result.path).toBe(trackedDir);
    });
  });

  describe("Telemetry", () => {
    it("should emit telemetry breadcrumb with profile path and role", () => {
      const profileDir = path.join(tempDir, "profile");
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(path.join(profileDir, "profile.yml"), "role: test-role");

      resolveProfile(profileDir, tempDir);

      expect(consoleSpy).toHaveBeenCalledWith(
        `lexrunner profile: using profile: ${profileDir} (role: test-role)`
      );
    });

    it("should emit telemetry with example role for .smartergpt/ without manifest", () => {
      const trackedDir = path.join(tempDir, ".smartergpt");
      fs.mkdirSync(trackedDir, { recursive: true });

      resolveProfile(undefined, tempDir);

      expect(consoleSpy).toHaveBeenCalledWith(
        `lexrunner profile: using profile: ${trackedDir} (role: example)`
      );
    });

    it("should emit telemetry exactly once per resolution", () => {
      const profileDir = path.join(tempDir, "profile");
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(path.join(profileDir, "profile.yml"), "role: single");

      resolveProfile(profileDir, tempDir);

      expect(consoleSpy).toHaveBeenCalledTimes(1);
    });

    it("should use consistent stderr prefix format", () => {
      const profileDir = path.join(tempDir, "profile");
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(path.join(profileDir, "profile.yml"), "role: test-prefix");

      resolveProfile(profileDir, tempDir);

      // Verify the message starts with the expected prefix
      const calls = consoleSpy.mock.calls;
      expect(calls.length).toBe(1);
      expect(calls[0][0]).toMatch(/^lexrunner profile: /);
    });
  });

  describe("Error Handling", () => {
    it("should create ProfileResolverError instances", () => {
      const customDir = path.join(tempDir, "custom");
      fs.mkdirSync(customDir, { recursive: true });

      try {
        resolveProfile(customDir, tempDir);
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(ProfileResolverError);
        expect((error as ProfileResolverError).name).toBe("ProfileResolverError");
      }
    });

    it("should include source information in error message", () => {
      const customDir = path.join(tempDir, "custom");
      fs.mkdirSync(customDir, { recursive: true });

      expect(() => resolveProfile(customDir, tempDir)).toThrow(/from --profile-dir/);
    });
  });

  describe("Environment Variable Aliases", () => {
    it("should use LEXRUNNER_PROFILE_DIR as alias for LEX_PR_PROFILE_DIR", () => {
      const aliasDir = path.join(tempDir, "alias");
      fs.mkdirSync(aliasDir, { recursive: true });
      fs.writeFileSync(path.join(aliasDir, "profile.yml"), "role: alias\nname: Alias Profile");

      process.env.LEXRUNNER_PROFILE_DIR = aliasDir;
      fs.mkdirSync(path.join(tempDir, ".smartergpt"), { recursive: true });

      const result = resolveProfile(undefined, tempDir);

      expect(result.path).toBe(aliasDir);
      expect(result.manifest.role).toBe("alias");
      expect(result.manifest.name).toBe("Alias Profile");
      expect(result.source).toBe("LEX_PR_PROFILE_DIR");
    });

    it("should prefer LEX_PR_PROFILE_DIR over LEXRUNNER_PROFILE_DIR", () => {
      const primaryDir = path.join(tempDir, "primary");
      const aliasDir = path.join(tempDir, "alias");
      fs.mkdirSync(primaryDir, { recursive: true });
      fs.mkdirSync(aliasDir, { recursive: true });
      fs.writeFileSync(path.join(primaryDir, "profile.yml"), "role: primary");
      fs.writeFileSync(path.join(aliasDir, "profile.yml"), "role: alias");

      process.env.LEX_PR_PROFILE_DIR = primaryDir;
      process.env.LEXRUNNER_PROFILE_DIR = aliasDir;

      const result = resolveProfile(undefined, tempDir);

      expect(result.path).toBe(primaryDir);
      expect(result.manifest.role).toBe("primary");
    });

    it("should show deprecation warning for LEXRUNNER_PROFILE_DIR", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const aliasDir = path.join(tempDir, "alias");
      fs.mkdirSync(aliasDir, { recursive: true });
      fs.writeFileSync(path.join(aliasDir, "profile.yml"), "role: alias");

      process.env.LEXRUNNER_PROFILE_DIR = aliasDir;

      resolveProfile(undefined, tempDir);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("LEXRUNNER_PROFILE_DIR is deprecated")
      );

      warnSpy.mockRestore();
    });
  });

  describe("Profile Message Helper", () => {
    it("should log messages with consistent prefix to stderr", () => {
      logProfileMessage("test message");

      expect(consoleSpy).toHaveBeenCalledWith("lexrunner profile: test message");
    });

    it("should write to stderr not stdout", () => {
      const stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      logProfileMessage("stderr test");

      expect(consoleSpy).toHaveBeenCalled();
      expect(stdoutSpy).not.toHaveBeenCalled();

      stdoutSpy.mockRestore();
    });
  });
});
