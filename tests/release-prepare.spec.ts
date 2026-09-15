/**
 * Tests for release preparation script
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("release:prepare script", () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(() => {
    // Create a temporary test directory
    originalCwd = process.cwd();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "release-test-"));
    process.chdir(testDir);

    // Initialize git repo
    execSync("git init", { cwd: testDir });
    execSync('git config user.name "Test User"', { cwd: testDir });
    execSync('git config user.email "test@example.com"', { cwd: testDir });
    execSync("git config commit.gpgsign false", { cwd: testDir });

    // Create package.json
    const pkg = {
      name: "test-package",
      version: "1.0.0",
      private: true,
    };
    fs.writeFileSync(path.join(testDir, "package.json"), JSON.stringify(pkg, null, 2));

    // Create CHANGELOG.md
    const changelog = `# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Placeholder entry

## [1.0.0] - 2024-01-01

Initial release.
`;
    fs.writeFileSync(path.join(testDir, "CHANGELOG.md"), changelog);

    // Initial commit
    execSync("git add .", { cwd: testDir });
    execSync('git commit -m "Initial commit"', { cwd: testDir });
    execSync("git tag -a v1.0.0 -m 'v1.0.0'", { cwd: testDir });
  });
  afterEach(() => {
    process.chdir(originalCwd);
    // Clean up test directory
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("should detect no commits since last release", () => {
    // No new commits, so script should exit cleanly
    const scriptPath = path.join(originalCwd, "scripts/release-prepare.ts");

    try {
      const output = execSync(`tsx ${scriptPath}`, {
        cwd: testDir,
        encoding: "utf-8",
      });
      expect(output).toContain("No commits since last release");
    } catch (error) {
      // Script exits with 0, so no error should be thrown
      throw error;
    }
  });

  it("should compute patch version for fix commits", () => {
    // Add a fix commit
    execSync('git commit --allow-empty -m "fix: resolve bug"', {
      cwd: testDir,
    });

    const scriptPath = path.join(originalCwd, "scripts/release-prepare.ts");
    const output = execSync(`tsx ${scriptPath}`, {
      cwd: testDir,
      encoding: "utf-8",
    });

    expect(output).toContain("Version bump type: PATCH");
    expect(output).toContain("Next version: 1.0.0 → 1.0.1");

    // Verify package.json was updated
    const pkg = JSON.parse(fs.readFileSync(path.join(testDir, "package.json"), "utf-8"));
    expect(pkg.version).toBe("1.0.1");

    // Verify CHANGELOG was updated
    const changelog = fs.readFileSync(path.join(testDir, "CHANGELOG.md"), "utf-8");
    expect(changelog).toContain("## [1.0.1]");
    expect(changelog).toContain("### Fixed");
  });

  it("should compute minor version for feat commits", () => {
    // Add a feature commit
    execSync('git commit --allow-empty -m "feat: add new feature"', {
      cwd: testDir,
    });

    const scriptPath = path.join(originalCwd, "scripts/release-prepare.ts");
    const output = execSync(`tsx ${scriptPath}`, {
      cwd: testDir,
      encoding: "utf-8",
    });

    expect(output).toContain("Version bump type: MINOR");
    expect(output).toContain("Next version: 1.0.0 → 1.1.0");

    // Verify package.json was updated
    const pkg = JSON.parse(fs.readFileSync(path.join(testDir, "package.json"), "utf-8"));
    expect(pkg.version).toBe("1.1.0");

    // Verify CHANGELOG was updated
    const changelog = fs.readFileSync(path.join(testDir, "CHANGELOG.md"), "utf-8");
    expect(changelog).toContain("## [1.1.0]");
    expect(changelog).toContain("### Added");
  });

  it("should compute major version for breaking changes", () => {
    // Add a breaking change commit
    execSync('git commit --allow-empty -m "feat!: breaking change"', {
      cwd: testDir,
    });

    const scriptPath = path.join(originalCwd, "scripts/release-prepare.ts");
    const output = execSync(`tsx ${scriptPath}`, {
      cwd: testDir,
      encoding: "utf-8",
    });

    expect(output).toContain("Version bump type: MAJOR");
    expect(output).toContain("Next version: 1.0.0 → 2.0.0");

    // Verify package.json was updated
    const pkg = JSON.parse(fs.readFileSync(path.join(testDir, "package.json"), "utf-8"));
    expect(pkg.version).toBe("2.0.0");

    // Verify CHANGELOG was updated
    const changelog = fs.readFileSync(path.join(testDir, "CHANGELOG.md"), "utf-8");
    expect(changelog).toContain("## [2.0.0]");
    expect(changelog).toContain("### ⚠ BREAKING CHANGES");
  });

  it("should group commits by type in changelog", () => {
    // Add multiple commits of different types
    execSync('git commit --allow-empty -m "feat: new feature 1"', {
      cwd: testDir,
    });
    execSync('git commit --allow-empty -m "feat(scope): new feature 2"', {
      cwd: testDir,
    });
    execSync('git commit --allow-empty -m "fix: bug fix"', {
      cwd: testDir,
    });
    execSync('git commit --allow-empty -m "docs: update readme"', {
      cwd: testDir,
    });
    execSync('git commit --allow-empty -m "chore: update deps"', {
      cwd: testDir,
    });

    const scriptPath = path.join(originalCwd, "scripts/release-prepare.ts");
    execSync(`tsx ${scriptPath}`, { cwd: testDir, encoding: "utf-8" });

    const changelog = fs.readFileSync(path.join(testDir, "CHANGELOG.md"), "utf-8");

    // Check sections exist
    expect(changelog).toContain("### Added");
    expect(changelog).toContain("### Fixed");
    expect(changelog).toContain("### Documentation");
    expect(changelog).toContain("### Internal");

    // Check specific entries
    expect(changelog).toMatch(/new feature 1.*\([a-f0-9]{7}\)/);
    expect(changelog).toMatch(/\*\*scope\*\*: new feature 2.*\([a-f0-9]{7}\)/);
    expect(changelog).toMatch(/bug fix.*\([a-f0-9]{7}\)/);
  });

  it("should handle repositories without tags", () => {
    // Remove all tags
    execSync("git tag -d v1.0.0", { cwd: testDir });

    // Add a commit
    execSync('git commit --allow-empty -m "feat: first feature"', {
      cwd: testDir,
    });

    const scriptPath = path.join(originalCwd, "scripts/release-prepare.ts");
    const output = execSync(`tsx ${scriptPath}`, {
      cwd: testDir,
      encoding: "utf-8",
    });

    expect(output).toContain("Last tag: (none)");
    expect(output).toContain("Next version: 1.0.0 → 1.1.0");
  });

  it("should preserve unreleased section in changelog", () => {
    // Add a commit
    execSync('git commit --allow-empty -m "fix: bug fix"', {
      cwd: testDir,
    });

    const scriptPath = path.join(originalCwd, "scripts/release-prepare.ts");
    execSync(`tsx ${scriptPath}`, { cwd: testDir, encoding: "utf-8" });

    const changelog = fs.readFileSync(path.join(testDir, "CHANGELOG.md"), "utf-8");

    // Unreleased section should still exist
    expect(changelog).toContain("## [Unreleased]");

    // New version should be after unreleased
    const unreleasedIndex = changelog.indexOf("## [Unreleased]");
    const newVersionIndex = changelog.indexOf("## [1.0.1]");
    expect(newVersionIndex).toBeGreaterThan(unreleasedIndex);
  });

  it("should handle non-conventional commits gracefully", () => {
    // Add a non-conventional commit
    execSync('git commit --allow-empty -m "random commit message"', {
      cwd: testDir,
    });

    const scriptPath = path.join(originalCwd, "scripts/release-prepare.ts");
    const output = execSync(`tsx ${scriptPath}`, {
      cwd: testDir,
      encoding: "utf-8",
    });

    // Should still work and bump patch
    expect(output).toContain("Version bump type: PATCH");
    expect(output).toContain("Next version: 1.0.0 → 1.0.1");

    const changelog = fs.readFileSync(path.join(testDir, "CHANGELOG.md"), "utf-8");
    expect(changelog).toContain("### Other");
  });

  it("should provide next steps instructions", () => {
    // Add a commit
    execSync('git commit --allow-empty -m "feat: new feature"', {
      cwd: testDir,
    });

    const scriptPath = path.join(originalCwd, "scripts/release-prepare.ts");
    const output = execSync(`tsx ${scriptPath}`, {
      cwd: testDir,
      encoding: "utf-8",
    });

    // Check for next steps
    expect(output).toContain("Next steps:");
    expect(output).toContain("Review the changes");
    expect(output).toContain("git diff CHANGELOG.md package.json");
    expect(output).toContain("Commit the changes");
    expect(output).toContain("Create a signed tag");
    expect(output).toContain("git tag -s v1.1.0");
    expect(output).toContain("git push origin v1.1.0");
    expect(output).toContain("Push the changes and tag");
  });
});
