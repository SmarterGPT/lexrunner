import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("CLI init-local Integration Tests", () => {
  let tempDir: string;
  let cliPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-init-local-test-"));
    cliPath = path.resolve(__dirname, "../dist/cli.js");
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  it("scopes recoverable-backup help to local overlay initialization", () => {
    const workspaceHelp = execSync(`node "${cliPath}" workspace init --help`, {
      cwd: tempDir,
      encoding: "utf8",
    });
    const localHelp = execSync(`node "${cliPath}" init-local --help`, {
      cwd: tempDir,
      encoding: "utf8",
    });

    expect(workspaceHelp).toMatch(/Continue initialization for an existing\s+writable profile/u);
    expect(workspaceHelp).not.toMatch(/recoverable\s+backup/u);
    expect(localHelp).toMatch(/recoverable\s+backup/u);
  });

  it("should initialize local overlay with generic project type", () => {
    const output = execSync(`node "${cliPath}" init-local`, {
      cwd: tempDir,
      encoding: "utf8",
    });

    expect(output).toContain("Local overlay initialized successfully");
    expect(output).toContain("Project type: generic");
    expect(output).toContain("Role: development");

    // Verify directory and files created
    expect(fs.existsSync(path.join(tempDir, ".smartergpt.local"))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, ".smartergpt.local", "profile.yml"))).toBe(true);
  });

  it("should detect Node.js project type", () => {
    fs.writeFileSync(path.join(tempDir, "package.json"), '{"name":"test"}');

    const output = execSync(`node "${cliPath}" init-local`, {
      cwd: tempDir,
      encoding: "utf8",
    });

    expect(output).toContain("Project type: nodejs");
  });

  it("should detect Python project type", () => {
    fs.writeFileSync(path.join(tempDir, "requirements.txt"), "requests==2.28.0");

    const output = execSync(`node "${cliPath}" init-local`, {
      cwd: tempDir,
      encoding: "utf8",
    });

    expect(output).toContain("Project type: python");
  });

  it("should output JSON format", () => {
    const output = execSync(`node "${cliPath}" init-local --json`, {
      cwd: tempDir,
      encoding: "utf8",
    });

    const result = JSON.parse(output);
    expect(result.created).toBe(true);
    expect(result.config.role).toBe("development");
    expect(result.config.projectType).toBe("generic");
    expect(Array.isArray(result.copiedFiles)).toBe(true);
  });

  it("should be no-op on second run", () => {
    // First run
    execSync(`node "${cliPath}" init-local`, {
      cwd: tempDir,
      encoding: "utf8",
    });

    // Second run
    const output = execSync(`node "${cliPath}" init-local`, {
      cwd: tempDir,
      encoding: "utf8",
    });

    expect(output).toContain("Local overlay already exists");
    expect(output).toContain("Use --force to recreate");
  });

  it("should force recreation with --force flag", () => {
    // First run
    execSync(`node "${cliPath}" init-local`, {
      cwd: tempDir,
      encoding: "utf8",
    });

    // Create a custom file
    fs.writeFileSync(path.join(tempDir, ".smartergpt.local", "custom.txt"), "custom");

    // Force recreation
    const output = execSync(`node "${cliPath}" init-local --force`, {
      cwd: tempDir,
      encoding: "utf8",
    });

    expect(output).toContain("Local overlay initialized successfully");
    expect(output).toContain("Previous overlay retained:");
    expect(fs.existsSync(path.join(tempDir, ".smartergpt.local", "custom.txt"))).toBe(false);
    const backupsDir = path.join(tempDir, ".smartergpt.local", "runner", "force-backups");
    const [backup] = fs.readdirSync(backupsDir);
    expect(fs.readFileSync(path.join(backupsDir, backup, "custom.txt"), "utf8")).toBe("custom");
  });

  it("should copy files from .smartergpt/ if it exists", () => {
    // Create .smartergpt directory with files
    const smartergptDir = path.join(tempDir, ".smartergpt");
    fs.mkdirSync(smartergptDir, { recursive: true });
    fs.writeFileSync(path.join(smartergptDir, "intent.md"), "# Intent");
    fs.writeFileSync(path.join(smartergptDir, "scope.yml"), "version: 1");

    const output = execSync(`node "${cliPath}" init-local`, {
      cwd: tempDir,
      encoding: "utf8",
    });

    expect(output).toContain("Copied files from .smartergpt/");
    expect(output).toContain("intent.md");
    expect(output).toContain("scope.yml");

    // Configuration is canonical at the profile root; runner/ is artifact-only.
    const localDir = path.join(tempDir, ".smartergpt.local");
    expect(fs.existsSync(path.join(localDir, "intent.md"))).toBe(true);
    expect(fs.existsSync(path.join(localDir, "scope.yml"))).toBe(true);
    expect(fs.existsSync(path.join(localDir, "runner"))).toBe(true);
    expect(fs.existsSync(path.join(localDir, "runner", "intent.md"))).toBe(false);
    expect(fs.existsSync(path.join(localDir, "runner", "scope.yml"))).toBe(false);
  });

  it("should have deterministic JSON output", () => {
    fs.writeFileSync(path.join(tempDir, "package.json"), '{"name":"test"}');

    // Run twice
    const output1 = execSync(`node "${cliPath}" init-local --json`, {
      cwd: tempDir,
      encoding: "utf8",
    });

    // Remove the directory for second run
    fs.rmSync(path.join(tempDir, ".smartergpt.local"), { recursive: true });

    const output2 = execSync(`node "${cliPath}" init-local --json`, {
      cwd: tempDir,
      encoding: "utf8",
    });

    // Parse and compare (ignoring path which will be absolute)
    const result1 = JSON.parse(output1);
    const result2 = JSON.parse(output2);

    expect(result1.created).toBe(result2.created);
    expect(result1.config).toEqual(result2.config);
    expect(result1.copiedFiles).toEqual(result2.copiedFiles);
  });
});
