import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { inspectRegisteredCliSurface } from "../src/cli.js";
import { createWorkflowGuide, type WorkflowPhase } from "../src/mcp/workflow/state-machine.js";

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
const workflowPhases: WorkflowPhase[] = [
  "initial",
  "post-plan-creation",
  "post-gates-run",
  "pre-merge",
  "post-merge",
  "error-recovery",
];

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
    const launcher = await read("mcp-server.mjs");
    const sourceAdapter = await read("src/mcp/server.ts");
    const environmentGuide = await read("docs/environment-variables.md");

    expect(readme).toContain("<!-- BEGIN GENERATED MCP TOOL INVENTORY -->");
    expect(readme).toContain("<!-- END GENERATED MCP TOOL INVENTORY -->");
    expect(readme).toContain("checked against the published `tools/list` surface");
    expect(readme).toContain("`ALLOW_MUTATIONS=false`");
    expect(readme).toMatch(/does \*\*not\*\*\s+turn the server into a read-only sandbox/);
    expect(launcher).toContain("[lexrunner] Protected mutations:");
    expect(launcher).not.toContain("disabled (read-only)");
    expect(sourceAdapter).not.toContain("Exposes read-only tools");
    expect(environmentGuide).toContain("this is not a read-only sandbox");
    expect(environmentGuide).not.toContain("All operations are read-only");

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

  it("keeps both selected MCP/CLI mapping guides bounded to published tools", async () => {
    const surface = JSON.parse(await read("docs/architecture/cli-mcp-surface.json")) as {
      mcp: { canonical: string[]; deprecated: Array<{ tool: string }> };
    };
    const publishedTools = new Set([
      ...surface.mcp.canonical,
      ...surface.mcp.deprecated.map(({ tool }) => tool),
    ]);
    for (const path of ["docs/MCP-CLI-PARITY.md", "docs/MCP-PARITY.md"]) {
      const parity = await read(path);
      const selectedTables = parity.match(
        /<!-- lexrunner-mcp-parity-tools:start -->([\s\S]*?)<!-- lexrunner-mcp-parity-tools:end -->/u
      );

      expect(selectedTables, `${path} lacks its checked selected-tool tables`).not.toBeNull();
      expect(parity, `${path} claims to be the complete inventory`).toMatch(
        /is not the\s+published\s+tool inventory/u
      );
      expect(parity).toContain("README.mcp.md");
      expect(parity).toContain("cli-mcp-surface.json");
      expect(parity).toContain("workspace init --non-interactive");
      expect(parity).toContain('"schemaVersion": "1.0.1"');

      for (const staleClaim of [
        "**Status:** Complete",
        "✅ Full",
        "Both return:",
        "same JSON structure",
        "senior-dev.",
        "lexrunner.listRuns",
        "tests/mcp-parity.spec.ts",
        "-32601 (Method not found)",
      ]) {
        expect(parity, `${path} contains stale parity claim ${staleClaim}`).not.toContain(
          staleClaim
        );
      }

      for (const line of selectedTables?.[1].split(/\r?\n/u) ?? []) {
        if (!line.trimStart().startsWith("|")) continue;
        const cells = line.split("|");
        const mcpCell = cells[3] ?? "";
        for (const match of mcpCell.matchAll(/`([^`]+)`/gu)) {
          expect(
            publishedTools,
            `${path} selected table advertises unpublished tool ${match[1]}`
          ).toContain(match[1]);
        }
      }

      for (const match of parity.matchAll(/`(lexrunner\.[^`]+)`/gu)) {
        expect(
          publishedTools,
          `${path} advertises unpublished compatibility tool ${match[1]}`
        ).toContain(match[1]);
      }
    }
  });

  it("keeps workflow guidance aligned with live actions and the published MCP surface", async () => {
    const guidance = await read("docs/WORKFLOW_GUIDANCE.md");
    const publishedServer = await read("mcp-server.mjs");
    const responseTypes = await read("src/mcp/types/guided-response.ts");
    const packageManifest = JSON.parse(await read("package.json")) as { files?: string[] };
    const packageFiles = packageManifest.files ?? [];
    const guides = workflowPhases.map((phase) => createWorkflowGuide(phase));
    const actionNames = new Set(
      guides.flatMap(({ nextSteps }) => nextSteps.map(({ command }) => command))
    );

    actionNames.add("local.init");
    actionNames.add("workflow.guide");

    for (const actionName of actionNames) {
      const publishedProperty = /^[A-Z_$][\w$]*$/iu.test(actionName)
        ? actionName
        : JSON.stringify(actionName);
      expect(guidance, `workflow guidance omits ${actionName}`).toContain(`\`${actionName}\``);
      expect(publishedServer, `${actionName} is not on the published MCP surface`).toContain(
        `${publishedProperty}: {`
      );
    }

    for (const guide of guides) {
      expect(guide).toMatchObject({
        authority: "advisory",
        authorizesExecution: false,
        authorizesMerge: false,
      });
    }
    expect(guidance).toContain('authority: "advisory";');
    expect(guidance).toContain("authorizesExecution: false;");
    expect(guidance).toContain("authorizesMerge: false;");
    expect(guidance).toContain("It does not prove plan validity, gate success, merge eligibility");
    expect(guidance).toContain("`canProceed` is `!readiness.hasErrors`");
    expect(guidance).toContain('from "@smartergpt/lexrunner"');
    expect(guidance).not.toContain('from "lexrunner/src/');

    for (const obsoleteName of ["plan.validate", "merge.order", "plan_validate", "gates_run"]) {
      expect(guidance, `workflow guidance uses obsolete name ${obsoleteName}`).not.toContain(
        obsoleteName
      );
      expect(
        responseTypes,
        `workflow response types use obsolete name ${obsoleteName}`
      ).not.toContain(obsoleteName);
    }

    for (const documentationPath of new Set(
      guides.flatMap(({ documentation }) => (documentation ? [documentation] : []))
    )) {
      expect(await read(documentationPath), `${documentationPath} is missing`).not.toHaveLength(0);
      expect(
        isIncludedByPackageFiles(documentationPath, packageFiles),
        `${documentationPath} is excluded from the package.json files boundary`
      ).toBe(true);
    }
  });
});

async function read(path: string): Promise<string> {
  return readFile(resolve(repositoryRoot, path), "utf8");
}

function isIncludedByPackageFiles(path: string, files: string[]): boolean {
  const normalizedPath = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  return files.some((entry) => {
    const normalizedEntry = entry.replaceAll("\\", "/").replace(/^\.\//u, "");
    return (
      normalizedPath === normalizedEntry ||
      (normalizedEntry.endsWith("/") && normalizedPath.startsWith(normalizedEntry))
    );
  });
}
