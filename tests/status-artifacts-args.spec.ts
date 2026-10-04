import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GateOperationObserveArgs,
  GateOperationStartArgs,
  GateOperationStatusArgs,
} from "../src/application/gate-operation-service.js";
import { registerGateOperationCommands } from "../src/commands/gate-operation.js";
import { registerStatusCommand } from "../src/commands/status.js";
import { StatusArgs } from "../src/mcp/types.js";

const digest = `sha256:${"a".repeat(64)}`;
const handle = {
  repoRoot: "missing-repo",
  operationFile: "missing-operation",
  operationSha256: digest,
};
const evidence = { evidenceFile: "manifest.json", evidenceSha256: digest };

afterEach(() => vi.restoreAllMocks());

describe("artifact read-back adapter input contracts", () => {
  it("accepts omitted/false status options without evidence, and requires an explicit pair for true", () => {
    expect(StatusArgs.parse({})).not.toHaveProperty("verifyArtifacts");
    expect(StatusArgs.parse({ verifyArtifacts: false })).toEqual({ verifyArtifacts: false });
    expect(StatusArgs.parse({ ...evidence, verifyArtifacts: true })).toEqual({
      ...evidence,
      verifyArtifacts: true,
    });
    for (const value of [{}, { evidenceFile: evidence.evidenceFile }, { evidenceSha256: digest }]) {
      expect(() => StatusArgs.parse({ ...value, verifyArtifacts: true })).toThrow();
    }
    for (const verifyArtifacts of [null, 0, 1, "true", "false", "", [], {}]) {
      expect(() => StatusArgs.parse({ ...evidence, verifyArtifacts })).toThrow();
      expect(() => GateOperationStatusArgs.parse({ ...handle, verifyArtifacts })).toThrow();
    }
    expect(GateOperationStatusArgs.parse(handle)).toEqual(handle);
    for (const verifyArtifacts of [false, true]) {
      expect(GateOperationStatusArgs.parse({ ...handle, verifyArtifacts })).toEqual({
        ...handle,
        verifyArtifacts,
      });
    }
  });

  it("keeps start/cancel strict even for an explicitly false read-back option", () => {
    const start = { repoRoot: "repo", planFile: "plan.json", outDir: "out", idempotencyKey: "key" };
    for (const verifyArtifacts of [false, true]) {
      expect(() => GateOperationObserveArgs.parse({ ...handle, verifyArtifacts })).toThrow(
        "verifyArtifacts"
      );
      expect(() => GateOperationStartArgs.parse({ ...start, verifyArtifacts })).toThrow(
        "verifyArtifacts"
      );
    }
  });

  it("advertises valueless status flags while start and cancel do not accept them", () => {
    const program = new Command().name("lexrunner").exitOverride();
    registerStatusCommand(program, () => false);
    const gate = program.command("gate");
    registerGateOperationCommands(gate);
    expect(
      program.commands.find((command) => command.name() === "status")!.helpInformation()
    ).toContain("--verify-artifacts");
    const status = gate.commands.find((command) => command.name() === "status")!;
    expect(status.options.find(({ long }) => long === "--verify-artifacts")).toMatchObject({
      required: false,
      optional: false,
    });
    for (const name of ["start", "cancel"]) {
      expect(
        gate.commands.find((command) => command.name() === name)!.helpInformation()
      ).not.toContain("--verify-artifacts");
    }
  });

  it("refuses a CLI opt-in without evidence before attempting missing repo/plan IO", async () => {
    const program = new Command().name("lexrunner").exitOverride();
    registerStatusCommand(program, () => false);
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      program.parseAsync([
        "node",
        "lexrunner",
        "status",
        "--repo-root",
        "missing-repo",
        "--plan",
        "missing-plan",
        "--verify-artifacts",
      ])
    ).rejects.toMatchObject({ exitCode: 1 });
    expect(diagnostic.mock.calls).toEqual([
      [
        "Error getting status: --verify-artifacts requires explicit --evidence and --evidence-sha256",
      ],
    ]);
  });
});
