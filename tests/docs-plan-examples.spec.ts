import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { computeMergeOrder } from "../src/mergeOrder.js";
import { Plan } from "../src/schema.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const expectedExamples: Record<string, string> = {
  "agents-minimal": "AGENTS.md",
  "autopilot-level4-manual": "examples/autopilot-level4-example.md",
  "ci-runtime-gates": "docs/ci-integration-guide.md",
  "diffgraph-diamond": "docs/diffgraph-planner.md",
  "diffgraph-linear": "docs/diffgraph-planner.md",
  "diffgraph-simple-stack-generated": "docs/tutorials/diffgraph-planner/01-simple-stack.md",
  "frozen-git-inputs": "docs/frozen-git-inputs.md",
  "gate-report-vulnerability": "docs/gate-report-examples.md",
  "json-output-plan": "docs/JSON_OUTPUT_SCHEMAS.md",
  "mcp-plan-output": "docs/MCP-CLI-PARITY.md",
  "merge-weave-correct-branch": "docs/merge-weave-quickstart.md",
  "merge-weave-quickstart": "docs/merge-weave-quickstart.md",
  "merge-weave-setup-lexsona": "docs/MERGE_WEAVE_SETUP.md",
  "merge-weave-setup-manual": "docs/MERGE_WEAVE_SETUP.md",
  "quick-merge-pyramid-generated": "docs/tutorials/quick-merge-pyramid.md",
  "quickstart-manual": "docs/quickstart.md",
  "security-vulnerability-gate": "docs/SECURITY_IMPLEMENTATION.md",
  "working-example": "examples/WORKING_EXAMPLE.md",
};

const markerPattern = /<!--\s*lexrunner-plan-example:([a-z0-9-]+)\s*-->/g;
const examplePattern =
  /<!--\s*lexrunner-plan-example:([a-z0-9-]+)\s*-->\s*```json\s*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;

describe("documented Plan examples", () => {
  it("keeps every registered example valid, complete, and dependency-safe", async () => {
    const paths = [
      resolve(repositoryRoot, "AGENTS.md"),
      ...(await markdownFiles(resolve(repositoryRoot, "docs"))),
      ...(await markdownFiles(resolve(repositoryRoot, "examples"))),
    ];
    const found = new Map<string, { path: string; line: number; source: string }>();

    for (const path of paths) {
      const contents = await readFile(path, "utf8");
      const markers = [...contents.matchAll(markerPattern)];
      const examples = [...contents.matchAll(examplePattern)];
      const displayPath = relative(repositoryRoot, path).replaceAll("\\", "/");

      expect(
        examples.length,
        `${displayPath} has a Plan marker without an immediately following JSON fence`
      ).toBe(markers.length);

      for (const match of examples) {
        const id = match[1];
        const line = contents.slice(0, match.index).split(/\r?\n/).length;
        expect(found.has(id), `duplicate Plan example marker ${id} at ${displayPath}:${line}`).toBe(
          false
        );
        found.set(id, { path: displayPath, line, source: match[2] });
      }
    }

    expect([...found.keys()].sort()).toEqual(Object.keys(expectedExamples).sort());

    for (const [id, expectedPath] of Object.entries(expectedExamples)) {
      const example = found.get(id);
      expect(example, `missing registered Plan example ${id}`).toBeDefined();
      if (!example) continue;
      expect(example.path, `Plan example ${id} moved without updating the registry`).toBe(
        expectedPath
      );

      let decoded: unknown;
      try {
        decoded = JSON.parse(example.source);
      } catch (error) {
        throw new Error(
          `${example.path}:${example.line} (${id}) is not valid JSON: ${String(error)}`
        );
      }

      const parsed = Plan.safeParse(decoded);
      if (!parsed.success) {
        const details = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
          .join("; ");
        throw new Error(
          `${example.path}:${example.line} (${id}) violates the Plan schema: ${details}`
        );
      }

      expect(
        () => computeMergeOrder(parsed.data),
        `${example.path}:${example.line} (${id}) has an invalid dependency graph`
      ).not.toThrow();
    }
  });
});

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return markdownFiles(path);
      return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
    })
  );
  return nested.flat();
}
