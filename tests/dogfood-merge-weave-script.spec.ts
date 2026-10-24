/**
 * Tests for scripts/dogfood-merge-weave.sh
 *
 * This test validates the generic dogfood merge-weave script behavior
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execa } from "execa";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const resolveBashExecutable = (): string | undefined => {
  const override = process.env.LEXRUNNER_TEST_BASH;
  if (override) return override;
  if (process.platform !== "win32") return "bash";

  const programFiles = process.env.ProgramW6432 ?? process.env.ProgramFiles ?? "C:\\Program Files";
  return [
    path.join(programFiles, "Git", "bin", "bash.exe"),
    path.join(programFiles, "Git", "usr", "bin", "bash.exe"),
  ].find((candidate) => fs.existsSync(candidate));
};

const bashExecutable = resolveBashExecutable();
const bashCommand = bashExecutable ?? "bash";
const describeWithBash = bashExecutable === undefined ? describe.skip : describe;

interface FakeLexPrOptions {
  failValidation?: boolean;
  failMergeOrder?: boolean;
  failMerge?: boolean;
  mode?: "dry-run" | "execute";
}

const hasCommand = (commands: string[][], prefix: string[]): boolean =>
  commands.some((command) => prefix.every((part, index) => command[index] === part));

const commandWithPrefix = (commands: string[][], prefix: string[]): string[] | undefined =>
  commands.find((command) => prefix.every((part, index) => command[index] === part));

describeWithBash("scripts/dogfood-merge-weave.sh", () => {
  const scriptPath = path.join(process.cwd(), "scripts/dogfood-merge-weave.sh");
  let tempDir: string;

  const writePlan = (): string => {
    const planPath = path.join(tempDir, "test-plan.json");
    fs.writeFileSync(
      planPath,
      JSON.stringify({
        schemaVersion: "1.0.0",
        target: "main",
        items: [],
      })
    );
    return planPath;
  };

  const createFakeLexPr = (): { binDir: string; commandLogPath: string } => {
    const binDir = path.join(tempDir, "bin");
    const lexPrPath = path.join(binDir, "lex-pr");
    const commandLogPath = path.join(tempDir, "lex-pr-commands.log");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      lexPrPath,
      `#!/usr/bin/env bash
printf '%s' "$1" >> "$LEX_PR_TEST_LOG"
printf '\\037%s' "\${@:2}" >> "$LEX_PR_TEST_LOG"
printf '\\n' >> "$LEX_PR_TEST_LOG"

if [ "$1" = "weave" ] && [ "$2" = "plan" ]; then
    output_path=""
    target="trunk"
    while [ "$#" -gt 0 ]; do
      if [[ "$1" == --output=* ]]; then
        output_path="\${1#--output=}"
      elif [ "$1" = "--output" ]; then
        shift
        output_path="$1"
      elif [[ "$1" == --target=* ]]; then
        target="\${1#--target=}"
      fi
      shift
    done
    node -e 'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], JSON.stringify({schemaVersion:"1.0.0",target:process.argv[2],items:[]}));' "$output_path" "$target"
elif [ "$1" = "schema" ] && [ "$2" = "validate" ]; then
    if [ "$FAKE_LEX_PR_FAIL_VALIDATION" = "1" ]; then
      printf '%s\\n' 'schema validation rejected the plan' >&2
      exit 41
    fi
elif [ "$1" = "merge-order" ]; then
    if [ "$FAKE_LEX_PR_FAIL_MERGE_ORDER" = "1" ]; then
      printf '%s\\n' 'dependency cycle detected' >&2
      exit 42
    fi
elif [ "$1" = "merge" ]; then
    if [ "$FAKE_LEX_PR_FAIL_MERGE" = "1" ]; then
      printf '%s\\n' 'merge preview failed' >&2
      exit 43
    fi
fi

printf '{}\\n'
`,
      { mode: 0o755 }
    );
    return { binDir, commandLogPath };
  };

  const runWithFakeLexPr = async (
    repoPath: string,
    sourceArgs: string[],
    options: FakeLexPrOptions = {}
  ) => {
    const artifactsDir = path.join(tempDir, `artifacts-${path.basename(repoPath)}`);
    const { binDir, commandLogPath } = createFakeLexPr();

    const result = await execa(
      bashCommand,
      [
        scriptPath,
        ...sourceArgs,
        "--repo",
        repoPath,
        "--artifacts",
        artifactsDir,
        options.mode === "execute" ? "--execute" : "--dry-run",
      ],
      {
        reject: false,
        env: {
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          LEX_PR_TEST_LOG: commandLogPath,
          FAKE_LEX_PR_FAIL_VALIDATION: options.failValidation ? "1" : "0",
          FAKE_LEX_PR_FAIL_MERGE_ORDER: options.failMergeOrder ? "1" : "0",
          FAKE_LEX_PR_FAIL_MERGE: options.failMerge ? "1" : "0",
        },
      }
    );

    const commands = fs.existsSync(commandLogPath)
      ? fs
          .readFileSync(commandLogPath, "utf8")
          .split(/\r?\n/u)
          .filter(Boolean)
          .map((line) => line.split("\x1f"))
      : [];
    return { result, commands, artifactsDir };
  };

  const runForRepo = async (repoPath: string, options: FakeLexPrOptions = {}) =>
    runWithFakeLexPr(repoPath, ["--plan", writePlan()], options);

  const initRepository = async (repoPath: string): Promise<void> => {
    fs.mkdirSync(repoPath, { recursive: true });
    await execa("git", ["init", repoPath]);
    await execa("git", ["-C", repoPath, "config", "user.name", "Dogfood Test"]);
    await execa("git", ["-C", repoPath, "config", "user.email", "dogfood@example.invalid"]);
    await execa("git", ["-C", repoPath, "config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(repoPath, "README.md"), "test repository\n");
    await execa("git", ["-C", repoPath, "add", "README.md"]);
    await execa("git", ["-C", repoPath, "commit", "-m", "Initialize test repository"]);
  };

  beforeEach(() => {
    // Create a temporary directory for test artifacts
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dogfood-test-"));
  });

  afterEach(() => {
    // Cleanup temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should display help message", async () => {
    const { stdout, exitCode } = await execa(bashCommand, [scriptPath, "--help"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Generic Dogfood Merge-Weave Script");
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("--plan");
    expect(stdout).toContain("--from-github");
    expect(stdout).toContain("--repo");
    expect(stdout).toContain("--artifacts");
    expect(stdout).toContain("--dry-run");
    expect(stdout).toContain("--execute");
    expect(stdout).toContain("--plan plan.json");
    expect(stdout).not.toContain("merge-weave-dogfood.json");
    expect(stdout).not.toContain("--integration-branch");
    expect(stdout).not.toContain("--cleanup");
  });

  it("should fail when no plan source is specified", async () => {
    try {
      await execa(bashCommand, [scriptPath]);
      expect.fail("Should have thrown an error");
    } catch (error: any) {
      expect(error.exitCode).toBe(1);
      expect(error.stderr || error.stdout).toContain(
        "Either --plan or --from-github must be specified"
      );
    }
  });

  it("should fail when plan file does not exist", async () => {
    const nonExistentPlan = path.join(tempDir, "nonexistent.json");

    try {
      await execa(bashCommand, [scriptPath, "--plan", nonExistentPlan]);
      expect.fail("Should have thrown an error");
    } catch (error: any) {
      expect(error.exitCode).toBe(1);
      expect(error.stderr || error.stdout).toContain("Plan file not found");
    }
  });

  it("should fail when --from-github is specified without required options", async () => {
    try {
      await execa(bashCommand, [scriptPath, "--from-github"]);
      expect.fail("Should have thrown an error");
    } catch (error: any) {
      expect(error.exitCode).toBe(1);
      expect(error.stderr || error.stdout).toContain("--owner and --repo-name are required");
    }
  });

  it("should validate repository directory exists", async () => {
    const testPlan = path.join(tempDir, "test-plan.json");
    fs.writeFileSync(
      testPlan,
      JSON.stringify({
        schemaVersion: "1.0.0",
        target: "main",
        items: [],
      })
    );

    const nonExistentRepo = path.join(tempDir, "nonexistent-repo");

    try {
      await execa(bashCommand, [scriptPath, "--plan", testPlan, "--repo", nonExistentRepo]);
      expect.fail("Should have thrown an error");
    } catch (error: any) {
      expect(error.exitCode).toBe(1);
      expect(error.stderr || error.stdout).toContain("Repository directory not found");
    }
  });

  it("accepts a primary checkout whose .git is a directory", async () => {
    const repoPath = path.join(tempDir, "primary");
    await initRepository(repoPath);

    expect(fs.statSync(path.join(repoPath, ".git")).isDirectory()).toBe(true);

    const { result } = await runForRepo(repoPath);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("WORKFLOW COMPLETE");
  });

  it("accepts a linked worktree whose .git is a file", async () => {
    const repoPath = path.join(tempDir, "primary");
    const worktreePath = path.join(tempDir, "linked");
    await initRepository(repoPath);
    await execa("git", ["-C", repoPath, "worktree", "add", "-b", "linked-test", worktreePath]);

    expect(fs.statSync(path.join(worktreePath, ".git")).isFile()).toBe(true);

    const { result } = await runForRepo(worktreePath);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("WORKFLOW COMPLETE");
  });

  it("rejects a non-repository nested inside a checkout", async () => {
    const repoPath = path.join(tempDir, "primary");
    const nestedPath = path.join(repoPath, "not-a-repository");
    await initRepository(repoPath);
    fs.mkdirSync(nestedPath);

    const { result } = await runForRepo(nestedPath);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(`Not a git repository: ${nestedPath}`);
  });

  it("fails closed on supplied plan validation before merge analysis or preview", async () => {
    const repoPath = path.join(tempDir, "validation-failure");
    await initRepository(repoPath);

    const { result, commands, artifactsDir } = await runForRepo(repoPath, {
      failValidation: true,
    });

    expect(result.exitCode).toBe(41);
    expect(result.stdout).toContain("Plan file validation failed");
    expect(hasCommand(commands, ["schema", "validate"])).toBe(true);
    expect(hasCommand(commands, ["merge-order"])).toBe(false);
    expect(hasCommand(commands, ["merge"])).toBe(false);
    expect(fs.existsSync(path.join(artifactsDir, "dogfood-report.md"))).toBe(false);
  });

  it("fails closed on generated plan validation before merge analysis or preview", async () => {
    const repoPath = path.join(tempDir, "generated-validation-failure");
    await initRepository(repoPath);

    const { result, commands } = await runWithFakeLexPr(
      repoPath,
      ["--from-github", "--owner", "example", "--repo-name", "project"],
      { failValidation: true }
    );

    expect(result.exitCode).toBe(41);
    expect(hasCommand(commands, ["weave", "plan", "--from-github"])).toBe(true);
    expect(hasCommand(commands, ["schema", "validate"])).toBe(true);
    expect(hasCommand(commands, ["merge-order"])).toBe(false);
    expect(hasCommand(commands, ["merge"])).toBe(false);
  });

  it("fails closed on merge-order errors before preview or execution", async () => {
    const repoPath = path.join(tempDir, "merge-order-failure");
    await initRepository(repoPath);

    const { result, commands, artifactsDir } = await runForRepo(repoPath, {
      failMergeOrder: true,
    });

    expect(result.exitCode).toBe(42);
    expect(result.stdout).toContain("Merge order analysis failed");
    expect(hasCommand(commands, ["schema", "validate"])).toBe(true);
    expect(hasCommand(commands, ["merge-order"])).toBe(true);
    expect(hasCommand(commands, ["merge"])).toBe(false);
    expect(fs.existsSync(path.join(artifactsDir, "dogfood-report.md"))).toBe(false);
  });

  it("propagates a failed dry-run merge and does not generate a success report", async () => {
    const repoPath = path.join(tempDir, "dry-run-failure");
    await initRepository(repoPath);

    const { result, commands, artifactsDir } = await runForRepo(repoPath, {
      failMerge: true,
    });

    expect(result.exitCode).toBe(43);
    expect(result.stdout).toContain("Dry-run merge preview failed");
    expect(hasCommand(commands, ["merge"])).toBe(true);
    expect(fs.existsSync(path.join(artifactsDir, "dogfood-report.md"))).toBe(false);
  });

  it("propagates a failed execute merge and does not generate a success report", async () => {
    const repoPath = path.join(tempDir, "execute-failure");
    await initRepository(repoPath);

    const { result, commands, artifactsDir } = await runForRepo(repoPath, {
      failMerge: true,
      mode: "execute",
    });

    expect(result.exitCode).toBe(43);
    expect(result.stdout).toContain("Merge pyramid execution failed");
    expect(
      commands.some((command) => command[0] === "merge" && command.includes("--execute"))
    ).toBe(true);
    expect(fs.existsSync(path.join(artifactsDir, "dogfood-report.md"))).toBe(false);
  });

  it("invalidates a stale success report before a failed rerun", async () => {
    const repoPath = path.join(tempDir, "stale-report-rerun");
    await initRepository(repoPath);
    const artifactsDir = path.join(tempDir, `artifacts-${path.basename(repoPath)}`);
    fs.mkdirSync(artifactsDir, { recursive: true });
    const reportPath = path.join(artifactsDir, "dogfood-report.md");
    fs.writeFileSync(reportPath, "stale success\n");

    const { result } = await runForRepo(repoPath, { failValidation: true });

    expect(result.exitCode).toBe(41);
    expect(fs.existsSync(reportPath)).toBe(false);
  });

  it("preserves argument boundaries for GitHub filters and paths containing spaces", async () => {
    const repoPath = path.join(tempDir, "repository with spaces");
    await initRepository(repoPath);
    const query = 'is:pr label:"ready for merge"';
    const { result, commands, artifactsDir } = await runWithFakeLexPr(
      repoPath,
      [
        "--from-github",
        "--owner",
        "example org",
        "--repo-name",
        "example repo",
        "--base",
        "release branch",
        "--labels",
        "ready for merge, security",
        "--query",
        query,
      ],
      { mode: "dry-run" }
    );

    expect(result.exitCode).toBe(0);
    const planCommand = commandWithPrefix(commands, ["weave", "plan", "--from-github"]);
    expect(planCommand).toBeDefined();
    expect(planCommand).toContain("--owner=example org");
    expect(planCommand).toContain("--repo=example repo");
    expect(planCommand).toContain("--target=release branch");
    expect(planCommand).toContain(`--query=${query}`);
    const labelsIndex = planCommand?.indexOf("--labels") ?? -1;
    expect(planCommand?.slice(labelsIndex + 1, labelsIndex + 3)).toEqual([
      "ready for merge",
      "security",
    ]);

    const generatedPlan = path.join(artifactsDir, "plan.json");
    expect(path.normalize(commandWithPrefix(commands, ["schema", "validate"])?.[2] ?? "")).toBe(
      path.normalize(generatedPlan)
    );
    expect(path.normalize(commandWithPrefix(commands, ["merge-order"])?.[1] ?? "")).toBe(
      path.normalize(generatedPlan)
    );
    const mergeCommand = commandWithPrefix(commands, ["merge"]);
    expect(path.normalize(mergeCommand?.[mergeCommand.indexOf("--plan") + 1] ?? "")).toBe(
      path.normalize(generatedPlan)
    );
    expect(fs.readFileSync(path.join(artifactsDir, "dogfood-report.md"), "utf8")).toContain(
      "- Base Branch: release branch"
    );
  });

  it("reports the repository default branch resolved into the generated plan", async () => {
    const repoPath = path.join(tempDir, "default-branch-report");
    await initRepository(repoPath);

    const { result, commands, artifactsDir } = await runWithFakeLexPr(repoPath, [
      "--from-github",
      "--owner",
      "example",
      "--repo-name",
      "project",
    ]);

    expect(result.exitCode).toBe(0);
    const planCommand = commandWithPrefix(commands, ["weave", "plan", "--from-github"]);
    expect(planCommand?.some((argument) => argument.startsWith("--target="))).toBe(false);

    const report = fs.readFileSync(path.join(artifactsDir, "dogfood-report.md"), "utf8");
    expect(report).toContain("- Base Branch: trunk");
    expect(report).not.toContain("- Base Branch: main");
  });

  it("should handle valid plan file with dry-run (default behavior)", async () => {
    // Use the existing test-plan.json in the repository
    const testPlan = path.join(process.cwd(), "test-plan.json");
    const artifactsDir = path.join(tempDir, "artifacts");

    // Run the script
    const { stdout, stderr, exitCode } = await execa(
      bashCommand,
      [scriptPath, "--plan", testPlan, "--artifacts", artifactsDir],
      {
        cwd: process.cwd(),
        reject: false,
      }
    );

    // The script should complete successfully
    expect(exitCode).toBe(0);

    // Check output contains expected sections
    expect(stdout).toContain("DOGFOOD MERGE-WEAVE WORKFLOW");
    expect(stdout).toContain("Step 1: Plan Generation");
    expect(stdout).toContain("Step 2: Gate Validation");
    expect(stdout).toContain("Step 3: Merge Analysis");
    expect(stdout).toContain("Step 4: Merge Execution");
    expect(stdout).toContain("Step 5: Report Generation");
    expect(stdout).toContain("WORKFLOW COMPLETE");

    // Verify it's in dry-run mode
    expect(stdout).toContain("DRY-RUN");

    // Check artifacts were created
    expect(fs.existsSync(artifactsDir)).toBe(true);
    expect(fs.existsSync(path.join(artifactsDir, "dogfood-report.md"))).toBe(true);
  }, 60000); // 60 second timeout for this test

  it("should accept verbose flag", async () => {
    const testPlan = path.join(process.cwd(), "test-plan.json");
    const artifactsDir = path.join(tempDir, "artifacts-verbose");

    const { stdout, exitCode } = await execa(
      bashCommand,
      [scriptPath, "--plan", testPlan, "--artifacts", artifactsDir, "--verbose", "--dry-run"],
      {
        cwd: process.cwd(),
        reject: false,
      }
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Configuration:");
  }, 60000);
});
