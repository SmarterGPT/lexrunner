import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");
const vitestEntry = join(repoRoot, "node_modules", "vitest", "vitest.mjs");
const configPath = join(repoRoot, "vitest.config.ts");

type RunResult = {
  root: string;
  reportPath: string;
  stdout: string;
  stderr: string;
};

function runIsolatedVitest(outputFile?: string): RunResult {
  const root = mkdtempSync(join(tmpdir(), "lexrunner-vitest-json-"));
  const fixturePath = join(root, "fixture.spec.ts");
  const reportPath = resolve(root, outputFile ?? "test-results.json");

  writeFileSync(
    fixturePath,
    'import { expect, test } from "vitest";\ntest("isolated fixture", () => expect(true).toBe(true));\n',
    "utf8"
  );
  mkdirSync(dirname(reportPath), { recursive: true });

  const args = [
    vitestEntry,
    "run",
    fixturePath,
    "--config",
    configPath,
    "--root",
    root,
    "--pool=threads",
    "--maxWorkers=1",
  ];
  if (outputFile) {
    args.push("--reporter=default", "--reporter=json", `--outputFile=${outputFile}`);
  }

  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 1_048_576,
  });

  if (result.error) {
    rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    throw result.error;
  }

  if (result.signal !== null || result.status !== 0) {
    const diagnostics = `${result.stdout}\n${result.stderr}`;
    rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    throw new Error(
      `Isolated Vitest exited with status ${String(result.status)} and signal ${String(result.signal)}:\n${diagnostics}`
    );
  }

  return {
    root,
    reportPath,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function verifyReport(result: RunResult): void {
  try {
    expect(existsSync(result.reportPath), `${result.stdout}\n${result.stderr}`).toBe(true);
    const report = JSON.parse(readFileSync(result.reportPath, "utf8")) as {
      numPassedTests?: number;
      success?: boolean;
    };
    expect(report.success).toBe(true);
    expect(report.numPassedTests).toBe(1);
  } finally {
    rmSync(result.root, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
  }
}

describe("Vitest JSON evidence output", () => {
  it("retains test-results.json as the default in an isolated native process", () => {
    verifyReport(runIsolatedVitest());
  });

  it("honors an explicit output path in a separate isolated native process", () => {
    const selectedPath = join("review", "independent.json");
    const result = runIsolatedVitest(selectedPath);

    try {
      expect(existsSync(join(result.root, "test-results.json"))).toBe(false);
    } catch (error) {
      rmSync(result.root, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
      throw error;
    }

    verifyReport(result);
  });
});
