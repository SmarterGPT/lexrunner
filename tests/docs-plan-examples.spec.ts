import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { computeMergeOrder } from "../src/mergeOrder.js";
import { Plan } from "../src/schema.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const expectedMarkdownExamples: Record<string, string> = {
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
const standaloneExamples: Record<string, string> = {
  "template-plan-json": "docs/templates/plan.example.json",
  "github-integration-plan-json": "examples/github-integration/example-plan.json",
  "sample-plan-json": "examples/sample-plan.json",
  "root-test-plan-json": "test-plan.json",
};
const standaloneNonExecutableExamples: Record<string, string> = {
  "legacy-merge-weave-dogfood": "merge-weave-dogfood.json",
  "legacy-merge-weave-plan": "merge-weave-plan.json",
  "legacy-sample-stack": "examples/sample-stack.yml",
};
const standaloneNonPlanDataExamples: Record<string, string> = {
  "front-end-feature-plan": "examples/front-end-capture-pipeline/plan-dark-mode.json",
  "gate-configuration": "docs/templates/gates.example.yml",
};
const shellPlanExamples: Record<string, string> = {
  "cluster-gates-demo": "examples/cluster-gates-demo.sh",
};
const shellNonExecutableExamples: Record<string, string> = {
  "quick-start-gates-config": "scripts/quick-start-merge-weave.sh",
};
const expectedNonExecutableExamples: Record<string, string> = {
  "adr-merge-order-policy-fragment": "docs/adr/ADR-005-merge-pyramid-ordering.md",
  "adr-schema-version-fragment": "docs/adr/ADR-006-schema-versioning-semver.md",
  "agents-policy-fragment": "AGENTS.md",
  "autopilot-legacy-plan-graph": "docs/autopilot.md",
  "cli-plan-response-shape": "docs/cli.md",
  "cli-gate-execution-success": "docs/cli.md",
  "cli-gate-report-output": "docs/cli.md",
  "cli-vulnerability-policy-fragment": "docs/cli.md",
  "config-inspect-envelope": "docs/config.md",
  "error-recovery-policy-fragment": "docs/error-recovery.md",
  "error-recovery-legacy-basic-policy": "examples/error-recovery/README.md",
  "error-recovery-legacy-basic-stack": "examples/error-recovery/README.md",
  "error-recovery-legacy-service-policy": "examples/error-recovery/README.md",
  "error-recovery-legacy-service-stack": "examples/error-recovery/README.md",
  "error-recovery-progressive-policy": "examples/error-recovery/README.md",
  "github-generated-plan-abridged": "examples/github-integration/README.md",
  "integration-matrix-projection": "docs/cli-mcp-weave-reporting.md",
  "json-output-status-plan-summary": "docs/JSON_OUTPUT_SCHEMAS.md",
  "legacy-stack-only-config": "docs/config.md",
  "legacy-stack-override-config": "docs/config.md",
  "manual-mcp-plan-response": "MANUAL_TEST_GUIDE.md",
  "mcp-parity-plan-output-fragment": "docs/MCP-PARITY.md",
  "mcp-parity-gate-output-fragment": "docs/MCP-PARITY.md",
  "mcp-parity-status-plan-summary": "docs/MCP-PARITY.md",
  "merge-weave-execute-failure-output": "docs/merge-weave-quickstart.md",
  "merge-weave-execute-success-output": "docs/merge-weave-quickstart.md",
  "merge-weave-policy-fragment": "docs/merge-weave-quickstart.md",
  "performance-large-legacy": "examples/performance-config.md",
  "performance-example-high-memory-policy": "examples/performance-config.md",
  "performance-example-slow-execution-policy": "examples/performance-config.md",
  "performance-large-policy-fragment": "docs/performance-scale.md",
  "performance-high-memory-policy-fragment": "docs/performance-scale.md",
  "performance-medium-legacy": "examples/performance-config.md",
  "performance-medium-policy-fragment": "docs/performance-scale.md",
  "performance-metrics-legacy": "examples/performance-config.md",
  "performance-resource-policy-fragment": "docs/performance-scale.md",
  "performance-scale-policy-sketch": "docs/performance-scale.md",
  "performance-small-legacy": "examples/performance-config.md",
  "performance-small-policy-fragment": "docs/performance-scale.md",
  "performance-slow-execution-policy-fragment": "docs/performance-scale.md",
  "performance-xlarge-legacy": "examples/performance-config.md",
  "performance-xlarge-policy-fragment": "docs/performance-scale.md",
  "quick-merge-pyramid-stack-fragment": "docs/tutorials/quick-merge-pyramid.md",
  "troubleshooting-future-plan-fragment": "docs/troubleshooting-planner.md",
  "troubleshooting-dependency-items-fragment": "docs/troubleshooting.md",
};

type DataLanguage = "" | "json" | "jsonc" | "yaml" | "yml";
type ClassificationKind = "plan-example" | "non-executable-plan";

interface FenceClassification {
  id: string;
  kind: ClassificationKind;
  line: number;
}

interface MarkdownFence {
  classification?: FenceClassification;
  language: string;
  line: number;
  source: string;
}

interface ShellHeredoc {
  classification?: FenceClassification;
  language: DataLanguage;
  line: number;
  source: string;
}

interface ParsedExample {
  language: DataLanguage;
  line: number;
  path: string;
  source: string;
}

type DataParseResult = { success: true; value: unknown } | { error: unknown; success: false };

const classificationPattern =
  /^\s*<!--\s*lexrunner-(plan-example|non-executable-plan):([a-z0-9-]+)\s*-->\s*$/u;
const openingFencePattern = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/u;
const closingFencePattern = /^ {0,3}(`+|~+)[ \t]*$/u;
const supportedDataLanguages = new Set<DataLanguage>(["", "json", "jsonc", "yaml", "yml"]);
const shellClassificationPattern =
  /^\s*#\s*lexrunner-(plan-example|non-executable-plan):([a-z0-9-]+)\s*$/u;

describe("documented Plan examples", () => {
  it("keeps every registered example valid, complete, and dependency-safe", async () => {
    const paths = [
      ...(await rootMarkdownFiles(repositoryRoot)),
      ...(await markdownFiles(resolve(repositoryRoot, "docs"))),
      ...(await markdownFiles(resolve(repositoryRoot, "examples"))),
    ];
    const found = new Map<string, ParsedExample>();
    const nonExecutable = new Map<string, ParsedExample>();

    for (const path of paths) {
      const contents = await readFile(path, "utf8");
      const displayPath = relative(repositoryRoot, path).replaceAll("\\", "/");
      const { fences, orphanedClassifications, unclosedFence } = scanMarkdownFences(contents);

      expect(
        orphanedClassifications,
        `${displayPath} has a Plan classification that is not immediately followed by a fence`
      ).toEqual([]);
      expect(unclosedFence, `${displayPath} has an unclosed Markdown fence`).toBeUndefined();

      for (const fence of fences) {
        const language = normalizeDataLanguage(fence.language);
        if (fence.classification) {
          expect(
            language,
            `${displayPath}:${fence.line} classification ${fence.classification.id} must annotate ` +
              "a JSON, JSONC, YAML, or unlabeled data fence"
          ).toBeDefined();
        }
        if (language === undefined) continue;

        // Parse before applying source heuristics so inline/minified Plans cannot evade strict checks.
        const decoded = tryParseData(fence.source, language);
        const isStrictPlan = decoded.success && Plan.safeParse(decoded.value).success;
        const isPlanLike = decoded.success
          ? containsPlanLikeData(decoded.value)
          : looksLikePlanSource(fence.source);
        const classification = fence.classification;

        if (isStrictPlan) {
          expect(
            classification?.kind,
            `${displayPath}:${fence.line} is a strict Plan without a lexrunner-plan-example marker`
          ).toBe("plan-example");
        }
        if (!classification) {
          expect(
            isPlanLike,
            `${displayPath}:${fence.line} is Plan-like data without an explicit ` +
              "lexrunner-plan-example or lexrunner-non-executable-plan classification"
          ).toBe(false);
          continue;
        }

        const target = classification.kind === "plan-example" ? found : nonExecutable;
        const other = classification.kind === "plan-example" ? nonExecutable : found;
        expect(
          target.has(classification.id),
          `duplicate ${classification.kind} marker ${classification.id} at ` +
            `${displayPath}:${classification.line}`
        ).toBe(false);
        expect(
          other.has(classification.id),
          `${classification.id} is classified both executable and non-executable at ` +
            `${displayPath}:${classification.line}`
        ).toBe(false);
        target.set(classification.id, {
          path: displayPath,
          line: fence.line,
          language,
          source: fence.source,
        });
      }
    }

    const shellFound = new Map<string, ParsedExample>();
    const shellNonExecutable = new Map<string, ParsedExample>();
    const shellPaths = [
      ...(await rootShellFiles(repositoryRoot)),
      ...(await shellFiles(resolve(repositoryRoot, "scripts"))),
      ...(await shellFiles(resolve(repositoryRoot, "examples"))),
    ];
    for (const path of shellPaths) {
      const contents = await readFile(path, "utf8");
      const displayPath = relative(repositoryRoot, path).replaceAll("\\", "/");
      const { heredocs, orphanedClassifications, unclosedHeredoc } = scanShellHeredocs(contents);
      expect(
        orphanedClassifications,
        `${displayPath} has a shell Plan classification without an immediately following heredoc`
      ).toEqual([]);
      expect(unclosedHeredoc, `${displayPath} has an unclosed shell heredoc`).toBeUndefined();

      for (const heredoc of heredocs) {
        const decoded = tryParseData(heredoc.source, heredoc.language);
        const isStrictPlan = decoded.success && Plan.safeParse(decoded.value).success;
        const isPlanLike = decoded.success
          ? containsPlanLikeData(decoded.value)
          : looksLikePlanSource(heredoc.source);
        if (isStrictPlan) {
          expect(
            heredoc.classification?.kind,
            `${displayPath}:${heredoc.line} is a strict Plan heredoc without a ` +
              "# lexrunner-plan-example marker"
          ).toBe("plan-example");
        }
        if (!heredoc.classification) {
          expect(
            isPlanLike,
            `${displayPath}:${heredoc.line} is Plan-like heredoc data without an explicit shell ` +
              "Plan classification"
          ).toBe(false);
          continue;
        }

        const target =
          heredoc.classification.kind === "plan-example" ? shellFound : shellNonExecutable;
        const other =
          heredoc.classification.kind === "plan-example" ? shellNonExecutable : shellFound;
        expect(
          target.has(heredoc.classification.id),
          `duplicate shell ${heredoc.classification.kind} marker ${heredoc.classification.id} at ` +
            `${displayPath}:${heredoc.line}`
        ).toBe(false);
        expect(
          other.has(heredoc.classification.id),
          `${heredoc.classification.id} is classified both executable and non-executable at ` +
            `${displayPath}:${heredoc.line}`
        ).toBe(false);
        target.set(heredoc.classification.id, {
          path: displayPath,
          line: heredoc.line,
          language: heredoc.language,
          source: heredoc.source,
        });
      }
    }

    expect([...found.keys()].sort()).toEqual(Object.keys(expectedMarkdownExamples).sort());
    expect([...nonExecutable.keys()].sort()).toEqual(
      Object.keys(expectedNonExecutableExamples).sort()
    );
    expect([...shellFound.keys()].sort()).toEqual(Object.keys(shellPlanExamples).sort());
    expect([...shellNonExecutable.keys()].sort()).toEqual(
      Object.keys(shellNonExecutableExamples).sort()
    );

    for (const [id, expectedPath] of Object.entries(expectedMarkdownExamples)) {
      const example = found.get(id);
      expect(example, `missing registered Plan example ${id}`).toBeDefined();
      if (!example) continue;
      expect(example.path, `Plan example ${id} moved without updating the registry`).toBe(
        expectedPath
      );
      validatePlanExample(id, example.path, example.line, example.source, example.language);
    }

    for (const [id, expectedPath] of Object.entries(expectedNonExecutableExamples)) {
      const example = nonExecutable.get(id);
      expect(example, `missing classified non-executable Plan ${id}`).toBeDefined();
      if (!example) continue;
      expect(
        example.path,
        `non-executable Plan ${id} moved without updating the reviewed registry`
      ).toBe(expectedPath);

      const decoded = tryParseData(example.source, example.language);
      expect(
        decoded.success && Plan.safeParse(decoded.value).success,
        `${example.path}:${example.line} (${id}) is marked non-executable but passes the strict Plan schema`
      ).toBe(false);
    }

    for (const [id, expectedPath] of Object.entries(shellPlanExamples)) {
      const example = shellFound.get(id);
      expect(example, `missing registered shell Plan example ${id}`).toBeDefined();
      if (!example) continue;
      expect(example.path, `shell Plan ${id} moved without updating the registry`).toBe(
        expectedPath
      );
      validatePlanExample(id, example.path, example.line, example.source, example.language);
    }

    for (const [id, expectedPath] of Object.entries(shellNonExecutableExamples)) {
      const example = shellNonExecutable.get(id);
      expect(example, `missing classified non-executable shell Plan ${id}`).toBeDefined();
      if (!example) continue;
      expect(
        example.path,
        `non-executable shell Plan ${id} moved without updating the reviewed registry`
      ).toBe(expectedPath);
      const decoded = tryParseData(example.source, example.language);
      expect(
        decoded.success && Plan.safeParse(decoded.value).success,
        `${example.path}:${example.line} (${id}) is marked non-executable but passes the strict Plan schema`
      ).toBe(false);
    }

    for (const [id, examplePath] of Object.entries(standaloneExamples)) {
      const source = await readFile(resolve(repositoryRoot, examplePath), "utf8");
      validatePlanExample(id, examplePath, 1, source, languageForPath(examplePath));
    }

    for (const [id, examplePath] of Object.entries(standaloneNonExecutableExamples)) {
      const source = await readFile(resolve(repositoryRoot, examplePath), "utf8");
      const decoded = parseData(source, languageForPath(examplePath));
      expect(
        Plan.safeParse(decoded).success,
        `${examplePath}:1 (${id}) is registered historical data but now passes the strict Plan schema`
      ).toBe(false);
    }

    for (const [id, examplePath] of Object.entries(standaloneNonPlanDataExamples)) {
      const source = await readFile(resolve(repositoryRoot, examplePath), "utf8");
      const decoded = parseData(source, languageForPath(examplePath));
      expect(
        Plan.safeParse(decoded).success,
        `${examplePath}:1 (${id}) is registered as distinct data but now passes the strict Plan schema`
      ).toBe(false);
      expect(
        isStandalonePlanLikeData(decoded),
        `${examplePath}:1 (${id}) is a distinct data contract but now resembles a LexRunner Plan`
      ).toBe(false);
    }

    const discoveredStandalonePlans: string[] = [];
    for (const path of [
      ...(await rootDataFiles(repositoryRoot)),
      ...(await dataFiles(resolve(repositoryRoot, "docs"))),
      ...(await dataFiles(resolve(repositoryRoot, "examples"))),
    ]) {
      const displayPath = relative(repositoryRoot, path).replaceAll("\\", "/");
      const source = await readFile(path, "utf8");
      const decoded = parseData(source, languageForPath(displayPath));
      if (!isStandalonePlanCandidate(decoded)) continue;
      discoveredStandalonePlans.push(displayPath);
    }
    expect(discoveredStandalonePlans.sort()).toEqual(
      [
        ...Object.values(standaloneExamples),
        ...Object.values(standaloneNonExecutableExamples),
      ].sort()
    );
  });

  it("tracks matching backtick and tilde fences and every supported data label", () => {
    const markdown = [
      "<!-- lexrunner-non-executable-plan:jsonc-example -->",
      "````jsonc",
      '{ "value": 1, // a shorter ordinary closer remains inside this fence',
      '  "text": "ok",',
      "/*",
      "```",
      "*/",
      "}",
      "````",
      "~~~yaml",
      "value: 2",
      "~~~",
      "```yml",
      "value: 3",
      "```",
      "```json",
      '{"value":4}',
      "```",
      "```",
      '{"value":5}',
      "```",
    ].join("\n");

    const scan = scanMarkdownFences(markdown);
    expect(scan.orphanedClassifications).toEqual([]);
    expect(scan.unclosedFence).toBeUndefined();
    expect(scan.fences.map(({ language }) => language)).toEqual([
      "jsonc",
      "yaml",
      "yml",
      "json",
      "",
    ]);
    expect(scan.fences[0]?.source).toContain("```");
    expect(scan.fences[0]?.classification?.id).toBe("jsonc-example");
    expect(tryParseData(scan.fences[0]?.source ?? "", "jsonc").success).toBe(true);
  });

  it("parses minified strict Plans across longer, tilde, JSONC, and unlabeled fences", () => {
    const plan = '{"schemaVersion":"1.0.1","target":"main","items":[]}';
    const markdown = [
      "````json",
      plan,
      "````",
      "~~~yaml",
      plan,
      "~~~",
      "```yml",
      plan,
      "```",
      "```jsonc",
      '{"schemaVersion":"1.0.1","target":"main","items":[],}',
      "```",
      "```",
      plan,
      "```",
    ].join("\n");

    const fences = scanMarkdownFences(markdown).fences;
    expect(fences.map(({ language }) => language)).toEqual(["json", "yaml", "yml", "jsonc", ""]);
    for (const fence of fences) {
      const language = normalizeDataLanguage(fence.language);
      expect(language).toBeDefined();
      if (language === undefined) continue;
      const decoded = tryParseData(fence.source, language);
      expect(decoded.success && Plan.safeParse(decoded.value).success).toBe(true);
      expect(fence.classification).toBeUndefined();
    }
  });

  it("extracts marked and unmarked strict Plans from shell heredocs for validation", () => {
    const shell = [
      "# lexrunner-plan-example:embedded-plan",
      "cat > plan.json <<'JSON'",
      '{"schemaVersion":"1.0.1","target":"main","items":[]}',
      "JSON",
    ].join("\n");
    const scan = scanShellHeredocs(shell);

    expect(scan.orphanedClassifications).toEqual([]);
    expect(scan.unclosedHeredoc).toBeUndefined();
    expect(scan.heredocs).toHaveLength(1);
    expect(scan.heredocs[0]?.classification?.id).toBe("embedded-plan");
    expect(scan.heredocs[0]?.language).toBe("json");
    const decoded = tryParseData(scan.heredocs[0]?.source ?? "", "json");
    expect(decoded.success && Plan.safeParse(decoded.value).success).toBe(true);

    const unmarked = scanShellHeredocs(shell.split("\n").slice(1).join("\n")).heredocs[0];
    const unmarkedDecoded = tryParseData(unmarked?.source ?? "", unmarked?.language ?? "");
    expect(unmarked?.classification).toBeUndefined();
    expect(unmarkedDecoded.success && Plan.safeParse(unmarkedDecoded.value).success).toBe(true);
  });

  it("discovers strict standalone Plans whose omitted fields are supplied by schema defaults", () => {
    for (const candidate of [
      { schemaVersion: "1.0.0" },
      { schemaVersion: "1.0.0", target: "main" },
      { schemaVersion: "1.0.0", items: [] },
    ]) {
      expect(Plan.safeParse(candidate).success).toBe(true);
      expect(isStandalonePlanCandidate(candidate)).toBe(true);
    }
  });
});

function validatePlanExample(
  id: string,
  path: string,
  line: number,
  source: string,
  language: DataLanguage
): void {
  let decoded: unknown;
  try {
    decoded = parseData(source, language);
  } catch (error) {
    const label = language || "unlabeled data";
    throw new Error(`${path}:${line} (${id}) is not valid ${label}: ${String(error)}`);
  }

  const parsed = Plan.safeParse(decoded);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${path}:${line} (${id}) violates the Plan schema: ${details}`);
  }

  expect(
    () => computeMergeOrder(parsed.data),
    `${path}:${line} (${id}) has an invalid dependency graph`
  ).not.toThrow();

  for (const item of parsed.data.items) {
    const availableGates = new Set(item.gates.map(({ name }) => name));
    const missingGates = (parsed.data.policy?.requiredGates ?? []).filter(
      (gate) => !availableGates.has(gate)
    );
    expect(
      missingGates,
      `${path}:${line} (${id}) item ${item.name} omits policy-required gates`
    ).toEqual([]);
  }
}

function scanMarkdownFences(contents: string): {
  fences: MarkdownFence[];
  orphanedClassifications: FenceClassification[];
  unclosedFence?: { delimiter: string; line: number };
} {
  const lines = contents.split(/\r?\n/u);
  const fences: MarkdownFence[] = [];
  const orphanedClassifications: FenceClassification[] = [];
  let pendingClassification: FenceClassification | undefined;
  let open:
    | {
        classification?: FenceClassification;
        delimiterCharacter: "`" | "~";
        delimiterLength: number;
        language: string;
        line: number;
        source: string[];
      }
    | undefined;

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (open) {
      const close = line.match(closingFencePattern)?.[1];
      if (close && close[0] === open.delimiterCharacter && close.length >= open.delimiterLength) {
        fences.push({
          classification: open.classification,
          language: open.language,
          line: open.line,
          source: open.source.join("\n"),
        });
        open = undefined;
      } else {
        open.source.push(line);
      }
      continue;
    }

    const classification = line.match(classificationPattern);
    if (classification) {
      if (pendingClassification) orphanedClassifications.push(pendingClassification);
      pendingClassification = {
        kind: classification[1] as ClassificationKind,
        id: classification[2],
        line: lineNumber,
      };
      continue;
    }

    const opening = line.match(openingFencePattern);
    if (opening) {
      const delimiter = opening[1];
      const info = opening[2].trim();
      if (delimiter[0] === "`" && info.includes("`")) {
        if (pendingClassification) {
          orphanedClassifications.push(pendingClassification);
          pendingClassification = undefined;
        }
        continue;
      }
      open = {
        classification: pendingClassification,
        delimiterCharacter: delimiter[0] as "`" | "~",
        delimiterLength: delimiter.length,
        language: normalizeFenceLanguage(info),
        line: lineNumber,
        source: [],
      };
      pendingClassification = undefined;
      continue;
    }

    if (pendingClassification && line.trim() !== "") {
      orphanedClassifications.push(pendingClassification);
      pendingClassification = undefined;
    }
  }

  if (pendingClassification) orphanedClassifications.push(pendingClassification);
  return {
    fences,
    orphanedClassifications,
    unclosedFence: open
      ? {
          delimiter: open.delimiterCharacter.repeat(open.delimiterLength),
          line: open.line,
        }
      : undefined,
  };
}

function scanShellHeredocs(contents: string): {
  heredocs: ShellHeredoc[];
  orphanedClassifications: FenceClassification[];
  unclosedHeredoc?: { delimiter: string; line: number };
} {
  const lines = contents.split(/\r?\n/u);
  const heredocs: ShellHeredoc[] = [];
  const orphanedClassifications: FenceClassification[] = [];
  let pendingClassification: FenceClassification | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    const classification = line.match(shellClassificationPattern);
    if (classification) {
      if (pendingClassification) orphanedClassifications.push(pendingClassification);
      pendingClassification = {
        kind: classification[1] as ClassificationKind,
        id: classification[2],
        line: lineNumber,
      };
      continue;
    }

    const opening = line.match(
      /(?<!<)<<-?(?!<)\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_-]*))/u
    );
    if (!opening) {
      if (pendingClassification && line.trim() !== "") {
        orphanedClassifications.push(pendingClassification);
        pendingClassification = undefined;
      }
      continue;
    }

    const delimiter = opening[1] ?? opening[2] ?? opening[3];
    const stripTabs = /<<-/u.test(opening[0]);
    const bodyStart = index + 1;
    let closingIndex = bodyStart;
    while (closingIndex < lines.length) {
      const candidate = stripTabs ? lines[closingIndex].replace(/^\t+/u, "") : lines[closingIndex];
      if (candidate === delimiter) break;
      closingIndex += 1;
    }
    if (closingIndex >= lines.length) {
      return {
        heredocs,
        orphanedClassifications,
        unclosedHeredoc: { delimiter, line: lineNumber },
      };
    }

    heredocs.push({
      classification: pendingClassification,
      language: inferHeredocLanguage(line, delimiter),
      line: bodyStart + 1,
      source: lines.slice(bodyStart, closingIndex).join("\n"),
    });
    pendingClassification = undefined;
    index = closingIndex;
  }

  if (pendingClassification) orphanedClassifications.push(pendingClassification);
  return { heredocs, orphanedClassifications };
}

function inferHeredocLanguage(openingLine: string, delimiter: string): DataLanguage {
  const target = openingLine.match(/(?:>|tee\s+)([^\s]+)\s*<<-?/u)?.[1]?.toLowerCase();
  const extension = target?.match(/\.(jsonc?|ya?ml)$/u)?.[1];
  if (extension) return extension as DataLanguage;
  const normalizedDelimiter = delimiter.toLowerCase();
  return supportedDataLanguages.has(normalizedDelimiter as DataLanguage)
    ? (normalizedDelimiter as DataLanguage)
    : "";
}

function normalizeFenceLanguage(info: string): string {
  const token = info.split(/\s+/u)[0]?.toLowerCase() ?? "";
  const attributeLanguage = token.match(/^\{?\.?((?:jsonc?)|(?:ya?ml))\}?$/u)?.[1];
  return attributeLanguage ?? token;
}

function normalizeDataLanguage(language: string): DataLanguage | undefined {
  return supportedDataLanguages.has(language as DataLanguage)
    ? (language as DataLanguage)
    : undefined;
}

function languageForPath(path: string): DataLanguage {
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".yaml")) return "yaml";
  if (path.endsWith(".yml")) return "yml";
  throw new Error(`Unsupported standalone data path: ${path}`);
}

function tryParseData(source: string, language: DataLanguage): DataParseResult {
  try {
    return { success: true, value: parseData(source, language) };
  } catch (error) {
    return { error, success: false };
  }
}

function parseData(source: string, language: DataLanguage): unknown {
  if (language === "json") return JSON.parse(source);
  if (language === "jsonc") return JSON.parse(stripJsoncSyntax(source));
  if (language === "yaml" || language === "yml") return YAML.parse(source);

  try {
    return JSON.parse(source);
  } catch {
    return YAML.parse(source);
  }
}

function stripJsoncSyntax(source: string): string {
  let withoutComments = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n" || character === "\r") {
        lineComment = false;
        withoutComments += character;
      } else {
        withoutComments += " ";
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        withoutComments += "  ";
        blockComment = false;
        index += 1;
      } else {
        withoutComments += character === "\n" || character === "\r" ? character : " ";
      }
      continue;
    }
    if (inString) {
      withoutComments += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      withoutComments += character;
    } else if (character === "/" && next === "/") {
      lineComment = true;
      withoutComments += "  ";
      index += 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      withoutComments += "  ";
      index += 1;
    } else {
      withoutComments += character;
    }
  }

  let result = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < withoutComments.length; index += 1) {
    const character = withoutComments[index];
    if (inString) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    if (character === ",") {
      let lookahead = index + 1;
      while (/\s/u.test(withoutComments[lookahead] ?? "")) lookahead += 1;
      if (withoutComments[lookahead] === "}" || withoutComments[lookahead] === "]") continue;
    }
    result += character;
  }
  return result;
}

function containsPlanLikeData(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (Array.isArray(value)) return value.some((entry) => containsPlanLikeData(entry, depth + 1));
  if (!isRecord(value)) return false;
  if ("$schema" in value && "properties" in value) return false;
  if (isPlanLikeObject(value)) return true;
  return Object.values(value).some((entry) => containsPlanLikeData(entry, depth + 1));
}

function isPlanLikeObject(value: Record<string, unknown>): boolean {
  const has = (field: string): boolean => Object.hasOwn(value, field);
  const currentShape = has("schemaVersion") && has("target") && has("items");
  const legacyStackShape = has("version") && has("target") && has("items");
  const legacyGraphShape = has("schemaVersion") && has("nodes");
  const statusShape = has("schemaVersion") && has("target") && (has("policy") || has("itemCount"));
  const versionedItemsShape = has("schemaVersion") && has("items");
  const versionedPlanEnvelope =
    has("schemaVersion") &&
    isRecord(value.plan) &&
    (Object.hasOwn(value.plan, "items") || Object.hasOwn(value.plan, "nodes"));
  const summarizedPlan =
    has("items") &&
    has("requiredGates") &&
    (typeof value.items === "number" || Array.isArray(value.items));
  const itemArrayShape =
    Array.isArray(value.items) &&
    value.items.some(
      (item) =>
        isRecord(item) &&
        (Object.hasOwn(item, "name") ||
          Object.hasOwn(item, "id") ||
          Object.hasOwn(item, "branch")) &&
        (Object.hasOwn(item, "deps") || Object.hasOwn(item, "gates"))
    );
  const policyShape =
    (has("requiredGates") &&
      ["optionalGates", "maxWorkers", "retries", "mergeRule", "performance"].some(has)) ||
    (isRecord(value.policy) &&
      ["requiredGates", "optionalGates", "maxWorkers", "retries", "mergeRule"].some((field) =>
        Object.hasOwn(value.policy, field)
      ));

  return (
    currentShape ||
    legacyStackShape ||
    legacyGraphShape ||
    statusShape ||
    versionedItemsShape ||
    versionedPlanEnvelope ||
    summarizedPlan ||
    itemArrayShape ||
    policyShape
  );
}

function looksLikePlanSource(source: string): boolean {
  if (/["']\$schema["']\s*:/u.test(source) && /["']properties["']\s*:/u.test(source)) {
    return false;
  }
  const has = (field: string): boolean => new RegExp(`["']?${field}["']?\\s*:`, "u").test(source);
  const planSignals = [
    "schemaVersion",
    "version",
    "target",
    "policy",
    "requiredGates",
    "gates",
    "nodes",
  ].filter(has).length;
  const currentOrLegacy =
    (has("schemaVersion") || has("version")) && (has("items") || has("nodes")) && planSignals >= 2;
  const itemFragment =
    has("items") && (has("deps") || has("gates")) && (has("name") || has("id") || has("branch"));
  const policyFragment =
    has("requiredGates") &&
    ["optionalGates", "maxWorkers", "retries", "mergeRule", "performance"].some(has);
  const statusSummary =
    has("schemaVersion") && has("target") && (has("policy") || has("itemCount"));

  return currentOrLegacy || itemFragment || policyFragment || statusSummary;
}

function isStandalonePlanLikeData(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const has = (field: string): boolean => Object.hasOwn(value, field);
  return (
    (has("schemaVersion") && has("target") && has("items")) ||
    (has("version") && has("target") && has("items")) ||
    (has("schemaVersion") && has("nodes"))
  );
}

function isStandalonePlanCandidate(value: unknown): boolean {
  return Plan.safeParse(value).success || isStandalonePlanLikeData(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function rootMarkdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => resolve(directory, entry.name));
}

async function rootDataFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(?:json|ya?ml)$/iu.test(entry.name))
    .map((entry) => resolve(directory, entry.name));
}

async function rootShellFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sh"))
    .map((entry) => resolve(directory, entry.name));
}

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

async function shellFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return shellFiles(path);
      return entry.isFile() && entry.name.endsWith(".sh") ? [path] : [];
    })
  );
  return nested.flat();
}

async function dataFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return dataFiles(path);
      return entry.isFile() && /\.(?:json|ya?ml)$/iu.test(entry.name) ? [path] : [];
    })
  );
  return nested.flat();
}
