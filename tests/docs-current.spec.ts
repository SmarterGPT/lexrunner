import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { inspectRegisteredCliSurface } from "../src/cli.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const documentedCommands = [
  ["workspace", "doctor"],
  ["weave", "plan"],
  ["schema", "validate"],
  ["weave", "merge-order"],
  ["gate", "run"],
  ["weave", "apply"],
] as const;
const runtimeTimeoutConfigurationDocs = [
  "docs/MERGE_WEAVE_SETUP.md",
  "docs/architecture.md",
  "docs/migration-guide.md",
  "docs/templates/gates.example.yml",
  "docs/troubleshooting.md",
  "docs/tutorials/quick-merge-pyramid.md",
  "docs/workflows/enterprise.md",
  "docs/workflows/small-team.md",
  "docs/workflows/solo-developer.md",
] as const;

describe("current documentation", () => {
  it("keeps the README progression on registered commands exposed by the built CLI", async () => {
    const registered = new Set(inspectRegisteredCliSurface().map(({ path }) => path));

    for (const command of documentedCommands) {
      const path = command.join(" ");
      expect(registered, `${path} is not a registered CLI operation`).toContain(path);

      const result = await execa(
        "node",
        [resolve(repositoryRoot, "dist/cli.js"), ...command, "--help"],
        { cwd: repositoryRoot }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage:");
    }
  }, 15_000);

  it("labels superseded v2 drafts as historical", async () => {
    for (const path of [
      "docs/lexrunner-v2-contract.md",
      "docs/lexrunner-v2-migration-plan.md",
      "docs/lexrunner-v2-salvage-map.md",
    ]) {
      const contents = await read(path);
      expect(contents.slice(0, 500), `${path} lacks an early historical warning`).toMatch(
        /historical|superseded/i
      );
    }
  });

  it("preserves the read-only evaluation and release authority boundaries", async () => {
    const evaluation = await read("docs/agent-evaluation.md");
    expect(evaluation).toContain("decision: adopt | pilot | defer | not a fit");
    expect(evaluation).toContain(
      "Do not convert a read-only evaluation into the trial automatically"
    );

    const release = await read("docs/release-process.md");
    expect(release).toContain("@smartergpt/lexrunner");
    expect(release).toContain("npm login --scope=@smartergpt");
    expect(release).toContain("runs only for push events");
    expect(release).toContain("release-owner primary fingerprint");
    expect(release).toContain("LexSona is a separate release");
  });

  it("does not advertise the unimplemented gate-timeout environment control", async () => {
    for (const path of ["docs/cli.md", "docs/troubleshooting.md", "docs/integrations/README.md"]) {
      expect(await read(path), `${path} advertises a phantom timeout control`).not.toContain(
        "LEX_PR_TIMEOUT"
      );
    }
  });

  it("does not advertise unsupported gates.yml timeout fields", async () => {
    for (const path of runtimeTimeoutConfigurationDocs) {
      expect(await read(path), `${path} advertises an unsupported timeout field`).not.toMatch(
        /^\s*#?\s*timeout:/mu
      );
    }
  });

  it("keeps the MCP README on the generated published tool surface", async () => {
    const readme = await read("README.mcp.md");

    expect(readme).toContain("<!-- BEGIN GENERATED MCP TOOL INVENTORY -->");
    expect(readme).toContain("<!-- END GENERATED MCP TOOL INVENTORY -->");
    expect(readme).toContain("checked against the published `tools/list` surface");
    expect(readme).toContain("`ALLOW_MUTATIONS=false`");
    expect(readme).toMatch(/does \*\*not\*\*\s+turn the server into a read-only sandbox/);

    for (const unpublishedName of [
      "plan_validate",
      "plan_analyze",
      "pr_list",
      "mcp_lexrunner_",
      "create_task_snapshot",
      "submit_task_receipt",
      "get_task_status",
      "list_pending_tasks",
    ]) {
      expect(readme, `README.mcp.md advertises absent tool ${unpublishedName}`).not.toContain(
        unpublishedName
      );
    }
  });
});

async function read(path: string): Promise<string> {
  return readFile(resolve(repositoryRoot, path), "utf8");
}
