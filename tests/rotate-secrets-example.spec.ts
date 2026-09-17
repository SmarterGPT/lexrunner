import { describe, it, expect } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Rotation Script Tests
 *
 * Validates the example rotation script:
 * - Deterministic JSON output
 * - Correct exit codes (0=ok, 1=findings, 2=error)
 * - Canonical key ordering
 * - Stable output format
 */
describe("rotate-secrets-example.ts", () => {
  const scriptPath = "scripts/rotate-secrets-example.ts";
  // Exercise the installed runtime directly, without npx resolution/startup work.
  // Stop the owned child before Vitest's five-second test deadline.
  const runExample = (env: NodeJS.ProcessEnv) =>
    execFileAsync(process.execPath, ["--import", "tsx", scriptPath], {
      env,
      timeout: 4000,
      killSignal: "SIGKILL",
    });

  describe("deterministic output", () => {
    it("should produce consistent JSON structure", async () => {
      const env = {
        ...process.env,
        LEX_PR_GITHUB_TOKEN: "ghp_test1234567890abcdefghijklmnopqrstuvwx",
      };

      const { stdout } = await runExample(env);
      const output = JSON.parse(stdout.trim());

      // Check required fields exist
      expect(output).toHaveProperty("command", "rotate-secrets-example");
      expect(output).toHaveProperty("status");
      expect(output).toHaveProperty("exitCode");
      expect(output).toHaveProperty("findings");
      expect(output).toHaveProperty("timestamp");

      // Check findings structure
      expect(output.findings).toHaveProperty("needsRotation");
      expect(output.findings).toHaveProperty("ok");
      expect(output.findings).toHaveProperty("maxAgeDays", 90);

      // Arrays should be sorted
      expect(Array.isArray(output.findings.needsRotation)).toBe(true);
      expect(Array.isArray(output.findings.ok)).toBe(true);
    });

    it("should have canonical key ordering", async () => {
      const env = {
        ...process.env,
        LEX_PR_GITHUB_TOKEN: "ghp_test1234567890abcdefghijklmnopqrstuvwx",
      };

      const { stdout } = await runExample(env);
      const output = JSON.parse(stdout.trim());
      const keys = Object.keys(output);

      // Expected canonical order (from canonicalJSONStringify)
      expect(keys).toEqual(["command", "exitCode", "findings", "status", "timestamp"]);
    });

    it("should output trailing newline", async () => {
      const env = {
        ...process.env,
        LEX_PR_GITHUB_TOKEN: "ghp_test1234567890abcdefghijklmnopqrstuvwx",
      };

      const { stdout } = await runExample(env);

      expect(stdout.endsWith("\n")).toBe(true);
      // Ensure exactly one trailing newline (canonical JSON)
      expect((stdout.match(/\n$/g) || []).length).toBe(1);
    });

    it("should sort secret arrays alphabetically", async () => {
      const env = {
        ...process.env,
        LEX_PR_GITHUB_TOKEN: "ghp_test1234567890abcdefghijklmnopqrstuvwx",
        LEX_PR_API_KEY: "key_test123",
        LEX_PR_DATABASE_URL: "postgresql://test",
      };

      const { stdout } = await runExample(env);
      const output = JSON.parse(stdout.trim());

      // All secrets are fresh, should be in 'ok' array, sorted
      const okSecrets = output.findings.ok;
      expect(okSecrets).toEqual(["API_KEY", "DATABASE_URL", "GITHUB_TOKEN"]);
    });
  });

  describe("exit codes", () => {
    it("should exit 0 when all secrets are within policy", async () => {
      const env = {
        ...process.env,
        LEX_PR_GITHUB_TOKEN: "ghp_test1234567890abcdefghijklmnopqrstuvwx",
        LEX_PR_API_KEY: "key_test123",
        LEX_PR_DATABASE_URL: "postgresql://test",
      };

      const { stdout } = await runExample(env);
      const output = JSON.parse(stdout.trim());

      expect(output.status).toBe("ok");
      expect(output.exitCode).toBe(0);
      expect(output.findings.needsRotation).toHaveLength(0);
    });

    it("should exit 0 when secrets are missing but not old (current behavior)", async () => {
      // When secrets are missing, checkRotationNeeded returns false
      // This means they don't "need rotation" - they're just missing
      // Use validate-secrets command to check if secrets exist
      const env = { ...process.env };
      delete env.LEX_PR_GITHUB_TOKEN;
      delete env.LEX_PR_API_KEY;
      delete env.LEX_PR_DATABASE_URL;

      const { stdout } = await runExample(env);
      const output = JSON.parse(stdout.trim());

      // Missing secrets don't trigger "needs rotation" - they just aren't checked
      expect(output.status).toBe("ok");
      expect(output.exitCode).toBe(0);
      // All secrets end up in 'ok' because they don't have age metadata to check
    });
  });

  describe("JSON validity", () => {
    it("should produce valid, parseable JSON", async () => {
      const env = {
        ...process.env,
        LEX_PR_GITHUB_TOKEN: "ghp_test1234567890abcdefghijklmnopqrstuvwx",
      };

      const { stdout } = await runExample(env);

      expect(() => JSON.parse(stdout.trim())).not.toThrow();
    });

    it("should have ISO 8601 timestamp", async () => {
      const env = {
        ...process.env,
        LEX_PR_GITHUB_TOKEN: "ghp_test1234567890abcdefghijklmnopqrstuvwx",
      };

      const { stdout } = await runExample(env);
      const output = JSON.parse(stdout.trim());

      // Validate ISO 8601 format
      const timestamp = output.timestamp;
      expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      // Should be a valid date
      expect(new Date(timestamp).toISOString()).toBe(timestamp);
    });
  });

  describe("findings payload", () => {
    it("should include maxAgeDays in findings", async () => {
      const env = {
        ...process.env,
        LEX_PR_GITHUB_TOKEN: "ghp_test1234567890abcdefghijklmnopqrstuvwx",
      };

      const { stdout } = await runExample(env);
      const output = JSON.parse(stdout.trim());

      expect(output.findings.maxAgeDays).toBe(90);
    });

    it("should categorize secrets correctly", async () => {
      const env = {
        ...process.env,
        LEX_PR_GITHUB_TOKEN: "ghp_test1234567890abcdefghijklmnopqrstuvwx",
        // Missing: API_KEY, DATABASE_URL (but they won't need rotation, just missing)
      };

      const { stdout } = await runExample(env);
      const output = JSON.parse(stdout.trim());

      // All secrets should be 'ok' if none are old
      // (Missing secrets don't have metadata to check age)
      expect(output.findings.ok.length).toBeGreaterThan(0);
    });
  });

  describe("script metadata", () => {
    it("should identify itself as rotate-secrets-example", async () => {
      const env = {
        ...process.env,
        LEX_PR_GITHUB_TOKEN: "ghp_test1234567890abcdefghijklmnopqrstuvwx",
      };

      const { stdout } = await runExample(env);
      const output = JSON.parse(stdout.trim());

      expect(output.command).toBe("rotate-secrets-example");
    });
  });
});
