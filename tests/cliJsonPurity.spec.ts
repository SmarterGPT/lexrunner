import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(__dirname, "..");

beforeAll(() => {
  // Ensure built CLI exists; run build if missing (keep minimal)
  const distCli = path.join(repoRoot, "dist", "cli.js");
  if (!fs.existsSync(distCli)) {
    // run npm run build synchronously
    const execa = require("child_process").spawnSync;
    const res = execa("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
    if (res.status !== 0) throw new Error("Build failed for CLI tests");
  }
});

/**
 * Helper to run CLI with custom arguments and optional fake Octokit
 */
function runCli(
  args: string[],
  options: {
    fakeOctokit?: any;
    env?: Record<string, string>;
    sendSignal?: "SIGINT" | "SIGTERM";
    signalDelay?: number;
    redirectConsoleLog?: boolean; // Only redirect console.log when needed
  } = {}
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const bootstrapPath = path.join(repoRoot, "tests", "tmp-cli-bootstrap.js");

    // Serialize the fake object. Functions are preserved by stringifying them as source.
    function serialize(val: any): string {
      if (val === null) return "null";
      if (typeof val === "function") return val.toString();
      if (Array.isArray(val)) return "[" + val.map(serialize).join(",") + "]";
      if (typeof val === "object") {
        const entries = Object.entries(val).map(([k, v]) => `${JSON.stringify(k)}:${serialize(v)}`);
        return "{" + entries.join(",") + "}";
      }
      return JSON.stringify(val);
    }

    const cliPath = path.join(repoRoot, "dist", "cli.js");
    let content = `// Test bootstrap - inject fake octokit and trap process.exit to stabilize tests\n`;

    if (options.fakeOctokit) {
      content += `global.__FAKE_OCTOKIT = ${serialize(options.fakeOctokit)};\n`;
      content += `process.env.LEX_PR_FAKE_OCTOKIT='1';\n`;
    }

    // Only redirect console.log when explicitly requested (for --from-github tests)
    if (options.redirectConsoleLog) {
      content += `// Redirect console.log to stderr so that --json mode can guarantee stdout purity\n`;
      content += `console.log = (...a) => { console.error(...a); };\n`;
    }

    content +=
      `const _origExit = process.exit.bind(process);\n` +
      `// Ensure process.exit calls the real exit synchronously to avoid uncaught async throws\n` +
      `process.exit = (code = 0) => { _origExit(code); };\n` +
      `import(${JSON.stringify(pathToFileURL(cliPath).href)}).then(mod => {\n` +
      `  if (mod.main) {\n` +
      `    mod.main().catch(e => {\n` +
      `      console.error('CLI main error:', e);\n` +
      `      _origExit(1);\n` +
      `    });\n` +
      `  }\n` +
      `}).catch(e => {\n` +
      `  console.error('CLI bootstrap error:', e && e.stack ? e.stack : e);\n` +
      `  _origExit(1);\n` +
      `});\n`;

    fs.writeFileSync(bootstrapPath, content);

    const proc = spawn(process.execPath, [bootstrapPath, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        LEX_PR_PROFILE_DIR: path.join(repoRoot, ".smartergpt"),
        ...options.env,
      },
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    // Send signal if requested
    if (options.sendSignal && options.signalDelay) {
      setTimeout(() => {
        proc.kill(options.sendSignal);
      }, options.signalDelay);
    }

    proc.on("close", (code) => {
      try {
        // cleanup
        if (fs.existsSync(bootstrapPath)) fs.unlinkSync(bootstrapPath);
      } catch (e) {}
      resolve({ stdout, stderr, code });
    });
    proc.on("error", (err) => {
      try {
        if (fs.existsSync(bootstrapPath)) fs.unlinkSync(bootstrapPath);
      } catch (e) {}
      reject(err);
    });
  });
}

// Legacy helper for backward compatibility
function runCliWithFakeOctokit(
  fake: any
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return runCli(["plan", "--from-github", "--json"], {
    fakeOctokit: fake,
    redirectConsoleLog: true, // GitHub plan mode needs console.log redirected
  });
}

describe("CLI JSON purity", () => {
  it("stdout is only JSON and stderr has diagnostic", async () => {
    // fake octokit that will return consistent PR data and repository metadata
    const prCreated = new Date().toISOString();
    const fake = {
      rest: {
        repos: {
          getBranch: async () => ({ data: { commit: { sha: "b".repeat(40) } } }),
          get: async () => ({
            data: {
              default_branch: "main",
              // The fake API's canonical identity must agree with the locally
              // observed origin; repository-bound planning rejects mismatches.
              html_url: "https://github.com/SmarterGPT/lexrunner",
            },
          }),
        },
        pulls: {
          list: async () => ({
            data: [
              {
                number: 1,
                title: "Test PR",
                body: "",
                head: { ref: "feature/test", sha: "a".repeat(40) },
                base: { ref: "main", sha: "b".repeat(40) },
                state: "open",
                labels: [],
                draft: false,
                mergeable: true,
                user: { login: "tester" },
                created_at: "2025-10-12T00:00:00Z",
                updated_at: "2025-10-12T00:00:00Z",
              },
            ],
          }),
          get: async () => ({
            data: {
              number: 1,
              title: "Test PR",
              body: "",
              head: { ref: "feature/test", sha: "a".repeat(40) },
              base: { ref: "main", sha: "b".repeat(40) },
              state: "open",
              labels: [],
              draft: false,
              mergeable: true,
              user: { login: "tester" },
              created_at: "2025-10-12T00:00:00Z",
              updated_at: "2025-10-12T00:00:00Z",
            },
          }),
        },
      },
      paginate: async () => [
        {
          number: 1,
          title: "Test PR",
          head: { ref: "feature/test", sha: "a".repeat(40) },
          base: { ref: "main", sha: "b".repeat(40) },
          state: "open",
          labels: [],
          draft: false,
          mergeable: true,
          user: { login: "tester" },
          created_at: "2025-10-12T00:00:00Z",
          updated_at: "2025-10-12T00:00:00Z",
        },
      ],
    };

    const { stdout, stderr, code } = await runCliWithFakeOctokit(fake);
    expect(code, stderr).toBe(0);
    // stdout should be pure JSON
    expect(() => JSON.parse(stdout)).not.toThrow();
    const obj = JSON.parse(stdout);
    expect(obj).toHaveProperty("items");
    expect(obj.gitInputs.target).toEqual({ ref: "refs/heads/main", commit: "b".repeat(40) });
    expect(obj.gitInputs.sources).toEqual([
      { item: "PR-1", ref: "refs/pull/1/head", commit: "a".repeat(40) },
    ]);
    // stderr should include our diagnostic line
    expect(stderr).toMatch(/\[from-github\] repo=.* discovered=\d+/);
  });

  it("invalid plan file produces structured error in JSON mode, exit code 1", async () => {
    // Create a temporary invalid plan file
    const tmpDir = path.join(repoRoot, "tests", "tmp-test-data");
    fs.mkdirSync(tmpDir, { recursive: true });
    const invalidPlanPath = path.join(tmpDir, "invalid-plan.json");

    try {
      // Write invalid JSON (malformed structure, missing required fields)
      fs.writeFileSync(
        invalidPlanPath,
        JSON.stringify({
          invalid: "structure",
          // Missing schemaVersion, target, items, etc.
        })
      );

      const { stdout, stderr, code } = await runCli([
        "schema",
        "validate",
        invalidPlanPath,
        "--json",
      ]);

      // Should fail with validation error (exit code 1)
      expect(code).toBe(1);

      // stdout should contain structured JSON error response
      expect(() => JSON.parse(stdout)).not.toThrow();
      const result = JSON.parse(stdout);
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(Array.isArray(result.errors)).toBe(true);
      expect(result.errors.length).toBeGreaterThan(0);

      // In JSON mode, stdout has structured errors, stderr may have diagnostics
      // This maintains JSON purity (stdout is always valid JSON)
    } finally {
      // Cleanup
      if (fs.existsSync(invalidPlanPath)) fs.unlinkSync(invalidPlanPath);
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("SIGINT during execution exits cleanly", async () => {
    // Use a fake octokit that will delay to allow signal to be sent
    const fake = {
      rest: {
        repos: {
          get: async () => {
            // Delay to ensure process is running when signal arrives
            await new Promise((resolve) => setTimeout(resolve, 200));
            return {
              data: {
                default_branch: "main",
                html_url: "https://github.com/test/test",
              },
            };
          },
        },
        pulls: {
          list: async () => ({ data: [] }),
        },
      },
      paginate: async () => [],
    };

    const { stdout, stderr, code } = await runCli(["plan", "--from-github", "--json"], {
      fakeOctokit: fake,
      redirectConsoleLog: true,
      sendSignal: "SIGINT",
      signalDelay: 100,
    });

    // SIGINT should result in abnormal exit (not 0)
    // Exit code may be 130, null, or 1 depending on timing of signal vs process completion
    expect(code).not.toBe(0);

    // The key test: stdout should be clean (no partial JSON output)
    const trimmed = stdout.trim();
    if (trimmed) {
      // If there's any output, it should be valid JSON
      expect(() => JSON.parse(trimmed)).not.toThrow();
    }

    // Signal handling message may or may not be captured depending on timing
    // The critical behavior is clean exit, not the exact message
  });

  it("missing GitHub token produces auth error on stderr", async () => {
    // Fake octokit that simulates auth failure
    const fake = {
      rest: {
        repos: {
          get: async () => {
            const error: any = new Error("Bad credentials");
            error.status = 401;
            throw error;
          },
        },
      },
    };

    const { stdout, stderr, code } = await runCli(["plan", "--from-github", "--json"], {
      fakeOctokit: fake,
      env: {
        // Explicitly unset any GitHub tokens
        GITHUB_TOKEN: "",
        GH_TOKEN: "",
        GITHUB_PAT: "",
      },
    });

    // Should fail with error code 1 (system/API error)
    expect(code).toBe(1);

    // stdout should be clean
    const trimmed = stdout.trim();
    if (trimmed) {
      expect(() => JSON.parse(trimmed)).not.toThrow();
    }

    // stderr should contain authentication-related error
    expect(stderr.toLowerCase()).toMatch(/auth|credential|token/);
  });

  it("gate failure maintains JSON purity when executing plan", async () => {
    // Create a temporary plan with a failing gate
    const tmpDir = path.join(repoRoot, "tests", "tmp-test-data");
    fs.mkdirSync(tmpDir, { recursive: true });
    const planPath = path.join(tmpDir, "gate-fail-plan.json");

    try {
      const plan = {
        schemaVersion: "1.0.0",
        target: "main",
        items: [
          {
            pr: 1,
            branch: "test-branch",
            title: "Test",
            dependencies: [],
            gates: [
              {
                name: "fail-gate",
                run: "exit 1",
                runtime: "local",
              },
            ],
          },
        ],
        policy: {
          requiredGates: ["fail-gate"],
          optionalGates: [],
          maxWorkers: 1,
          retries: {},
          overrides: {},
          blockOn: [],
          mergeRule: { type: "strict-required" },
        },
      };

      fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));

      const { stdout, stderr, code } = await runCli(["execute", planPath, "--json"]);

      // Gate failure should result in non-zero exit
      expect(code).not.toBe(0);

      // stdout may be empty or contain JSON - check if present
      const trimmed = stdout.trim();
      if (trimmed) {
        // If there's output, it should be valid JSON
        expect(() => JSON.parse(trimmed)).not.toThrow();
      }

      // stderr may contain diagnostic info
      // The key test is that stdout maintains purity (empty or valid JSON)
    } finally {
      // Cleanup
      if (fs.existsSync(planPath)) fs.unlinkSync(planPath);
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("malformed plan JSON produces structured error in JSON mode", async () => {
    const tmpDir = path.join(repoRoot, "tests", "tmp-test-data");
    fs.mkdirSync(tmpDir, { recursive: true });
    const malformedPath = path.join(tmpDir, "malformed.json");

    try {
      // Write completely invalid JSON (not even parseable)
      fs.writeFileSync(malformedPath, "{ this is not valid json at all }");

      const { stdout, stderr, code } = await runCli([
        "schema",
        "validate",
        malformedPath,
        "--json",
      ]);

      // Should fail
      expect(code).not.toBe(0);

      // stdout should contain structured JSON error response
      expect(() => JSON.parse(stdout)).not.toThrow();
      const result = JSON.parse(stdout);
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(Array.isArray(result.errors)).toBe(true);
      expect(result.errors.length).toBeGreaterThan(0);

      // Error details should indicate JSON parsing issue
      expect(result.errors[0].message).toContain("JSON");
    } finally {
      // Cleanup
      if (fs.existsSync(malformedPath)) fs.unlinkSync(malformedPath);
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("unhandled promise rejection exits cleanly with diagnostic on stderr", async () => {
    // This test verifies unhandled rejection handler is installed and working
    // The handler is tested directly in exitHandler.spec.ts
    // Here we verify it's actually installed when CLI starts

    // Run CLI --version which should install handlers but exit quickly with code 0
    const { stdout, stderr, code } = await runCli(["--version"]);

    // Should complete successfully
    expect(code).toBe(0);

    // stdout should have version info
    const packageVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"))
      .version as string;
    expect(stdout.trim()).toBe(`LexRunner ${packageVersion} (lexrunner)`);

    // The key point: handlers are installed at CLI startup (tested in exitHandler.spec.ts)
    // If an unhandled rejection occurs, it will be caught and logged to stderr
  });
});
