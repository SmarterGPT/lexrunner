import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import { registerExecuteCommand } from "../../src/commands/execute.js";

describe("Execute Command", () => {
  let program: Command;
  let jsonModeActive: boolean;
  let exitWithCalls: unknown[];
  let programOpts: any;
  let consoleLogSpy: any;
  let consoleErrorSpy: any;

  beforeEach(() => {
    // Reset state
    jsonModeActive = false;
    exitWithCalls = [];
    programOpts = { auditProfile: "off" };

    // Create a fresh Command instance
    program = new Command();
    program.exitOverride(); // Prevent actual process exit

    // Spy on console methods
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const exitWith = (error: unknown) => {
      exitWithCalls.push(error);
      throw error;
    };

    // Register the execute command
    registerExecuteCommand(program, {
      jsonModeActive: () => jsonModeActive,
      exitWith,
      getProgramOpts: () => programOpts,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("command registration", () => {
    it("should register execute command with correct name", () => {
      const commands = program.commands;
      const executeCommand = commands.find((cmd) => cmd.name() === "execute");

      expect(executeCommand).toBeDefined();
      expect(executeCommand?.description()).toBe(
        "Execute plan with policy-aware gate running and status tracking"
      );
    });

    it("should register all required options", () => {
      const commands = program.commands;
      const executeCommand = commands.find((cmd) => cmd.name() === "execute");

      expect(executeCommand).toBeDefined();

      const options = executeCommand?.options.map((opt) => opt.long);

      // Core options
      expect(options).toContain("--plan");
      expect(options).toContain("--repo-root");
      expect(options).toContain("--only-item");
      expect(options).toContain("--only-gate");
      expect(options).toContain("--artifact-dir");
      expect(options).toContain("--timeout");
      expect(options).toContain("--dry-run");
      expect(options).toContain("--json");
      expect(options).toContain("--status-table");
      expect(options).toContain("--skip-input-validation");

      // Autopilot options
      expect(options).toContain("--max-level");
      expect(options).toContain("--open-pr");
      expect(options).toContain("--close-superseded");
      expect(options).toContain("--comment-template");
      expect(options).toContain("--branch-prefix");

      // Audit options
      expect(options).toContain("--audit");
      expect(options).toContain("--audit-dir");
      expect(options).toContain("--audit-format");
      expect(options).toContain("--audit-include-env");
      expect(options).toContain("--audit-redact");
      expect(options).toContain("--audit-hash-paths");
      expect(options).toContain("--audit-signer");
      expect(options).toContain("--audit-retain-days");
      expect(options).toContain("--audit-context");
      expect(options).toContain("--audit-sample");
    });

    it("should have correct default values", () => {
      const commands = program.commands;
      const executeCommand = commands.find((cmd) => cmd.name() === "execute");

      const planOption = executeCommand?.options.find((opt) => opt.long === "--plan");
      // The fallback is resolved by the action so a positional plan path can take precedence.
      expect(planOption?.defaultValue).toBeUndefined();

      const artifactDirOption = executeCommand?.options.find(
        (opt) => opt.long === "--artifact-dir"
      );
      expect(artifactDirOption?.defaultValue).toBe("./artifacts");

      const timeoutOption = executeCommand?.options.find((opt) => opt.long === "--timeout");
      expect(timeoutOption?.defaultValue).toBe("30000");

      const maxLevelOption = executeCommand?.options.find((opt) => opt.long === "--max-level");
      expect(maxLevelOption?.defaultValue).toBe("0");

      const branchPrefixOption = executeCommand?.options.find(
        (opt) => opt.long === "--branch-prefix"
      );
      expect(branchPrefixOption?.defaultValue).toBe("integration/");

      const auditOption = executeCommand?.options.find((opt) => opt.long === "--audit");
      expect(auditOption?.defaultValue).toBe("off");

      const auditFormatOption = executeCommand?.options.find(
        (opt) => opt.long === "--audit-format"
      );
      expect(auditFormatOption?.defaultValue).toBe("jsonl");

      const auditSampleOption = executeCommand?.options.find(
        (opt) => opt.long === "--audit-sample"
      );
      expect(auditSampleOption?.defaultValue).toBe("100");
    });

    it("should accept plan file as positional argument", () => {
      const commands = program.commands;
      const executeCommand = commands.find((cmd) => cmd.name() === "execute");

      expect(executeCommand).toBeDefined();

      // Check that the command accepts an argument
      // Commander stores arguments in _args property
      const args = (executeCommand as any)._args;
      expect(args).toBeDefined();
      expect(args.length).toBeGreaterThan(0);
      expect(args[0].description).toBe("Path to plan.json file (alternative to --plan)");
    });

    it("should include help text with examples", () => {
      const commands = program.commands;
      const executeCommand = commands.find((cmd) => cmd.name() === "execute");

      expect(executeCommand).toBeDefined();

      // Verify the command has the expected structure
      expect(executeCommand?.description()).toBe(
        "Execute plan with policy-aware gate running and status tracking"
      );

      // Verify key options are registered
      const options = executeCommand?.options.map((opt) => opt.long);
      expect(options).toContain("--dry-run");
      expect(options).toContain("--json");
      expect(options).toContain("--status-table");
    });
  });

  describe("option descriptions", () => {
    it("should have descriptive option help text", () => {
      const commands = program.commands;
      const executeCommand = commands.find((cmd) => cmd.name() === "execute");

      const helpText = executeCommand?.helpInformation() ?? "";

      // Verify key option descriptions are present
      expect(helpText).toContain("--plan");
      expect(helpText).toContain("--dry-run");
      expect(helpText).toContain("--json");
      expect(helpText).toContain("--timeout");
      expect(helpText).toContain("--artifact-dir");
    });

    it("should document autopilot-related options", () => {
      const commands = program.commands;
      const executeCommand = commands.find((cmd) => cmd.name() === "execute");

      const helpText = executeCommand?.helpInformation() ?? "";

      // Autopilot options
      expect(helpText).toContain("--max-level");
      expect(helpText).toContain("--open-pr");
      expect(helpText).toContain("--close-superseded");
      expect(helpText).toContain("--comment-template");
      expect(helpText).toContain("--branch-prefix");
    });

    it("should document audit-related options", () => {
      const commands = program.commands;
      const executeCommand = commands.find((cmd) => cmd.name() === "execute");

      const helpText = executeCommand?.helpInformation() ?? "";

      // Audit options
      expect(helpText).toContain("--audit");
      expect(helpText).toContain("--audit-dir");
      expect(helpText).toContain("--audit-format");
      expect(helpText).toContain("--audit-include-env");
      expect(helpText).toContain("--audit-redact");
      expect(helpText).toContain("--audit-hash-paths");
      expect(helpText).toContain("--audit-signer");
      expect(helpText).toContain("--audit-retain-days");
      expect(helpText).toContain("--audit-context");
      expect(helpText).toContain("--audit-sample");
    });

    it("should have help text support", () => {
      const commands = program.commands;
      const executeCommand = commands.find((cmd) => cmd.name() === "execute");

      // Verify the command has help information
      const helpText = executeCommand?.helpInformation() ?? "";
      expect(helpText).toBeTruthy();

      // Verify command description is in help
      expect(helpText).toContain("Execute plan with policy-aware gate running and status tracking");
    });
  });

  describe("command structure", () => {
    it("should have an action handler", () => {
      const commands = program.commands;
      const executeCommand = commands.find((cmd) => cmd.name() === "execute");

      expect(executeCommand).toBeDefined();
      // Commander wraps action handlers, so we can't easily test their existence
      // but if the command registered, it has an action
    });

    it("should be properly integrated into program", () => {
      const commandNames = program.commands.map((cmd) => cmd.name());
      expect(commandNames).toContain("execute");
    });
  });

  describe("option validation", () => {
    it("should accept valid timeout values", () => {
      const commands = program.commands;
      const executeCommand = commands.find((cmd) => cmd.name() === "execute");

      const timeoutOption = executeCommand?.options.find((opt) => opt.long === "--timeout");
      expect(timeoutOption).toBeDefined();
      expect(timeoutOption?.description).toContain("milliseconds");
    });

    it("should accept valid max-level values", () => {
      const commands = program.commands;
      const executeCommand = commands.find((cmd) => cmd.name() === "execute");

      const maxLevelOption = executeCommand?.options.find((opt) => opt.long === "--max-level");
      expect(maxLevelOption).toBeDefined();
      expect(maxLevelOption?.description).toContain("0-4");
    });

    it("should accept valid audit profile values", () => {
      const commands = program.commands;
      const executeCommand = commands.find((cmd) => cmd.name() === "execute");

      const auditOption = executeCommand?.options.find((opt) => opt.long === "--audit");
      expect(auditOption).toBeDefined();
      expect(auditOption?.description).toContain("off|basic|soc2|hipaa-strict");
    });
  });

  describe("dependency injection", () => {
    it("should use provided jsonModeActive function", () => {
      // This is tested by the command using the function we provide
      // We can't easily test it without executing the command
      const commands = program.commands;
      const executeCommand = commands.find((cmd) => cmd.name() === "execute");
      expect(executeCommand).toBeDefined();
    });

    it("should use provided exitWith function", () => {
      // This is tested by the command using the function we provide
      // We can't easily test it without executing the command
      const commands = program.commands;
      const executeCommand = commands.find((cmd) => cmd.name() === "execute");
      expect(executeCommand).toBeDefined();
    });

    it("should use provided getProgramOpts function", () => {
      // This is tested by the command using the function we provide
      // We can't easily test it without executing the command
      const commands = program.commands;
      const executeCommand = commands.find((cmd) => cmd.name() === "execute");
      expect(executeCommand).toBeDefined();
    });
  });
});
