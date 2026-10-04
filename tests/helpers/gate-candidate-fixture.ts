import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import type { BoundedGateRunResult } from "../../src/application/gate-execution-service.js";
import { Gate, loadPlan, type Plan } from "../../src/schema.js";
import { computeCanonicalHash } from "../../src/schemas/task-contract.js";
import { canonicalJSONStringify } from "../../src/util/canonicalJson.js";

export interface CandidateFixture {
  root: string;
  startup: string;
  a: string;
  b: string;
  artifacts: string;
  dispose(): void;
}

const probe = `const fs = require('node:fs');
const path = require('node:path');
const cwd = process.cwd();
const root = fs.existsSync(path.join(cwd, 'candidate.txt')) ? cwd : path.dirname(cwd);
console.log(JSON.stringify({cwd, candidate: fs.readFileSync(path.join(root, 'candidate.txt'), 'utf8').trim()}));
`;

export function candidateFixture(): CandidateFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lexrunner-candidate-routing-")));
  const startup = join(root, "startup");
  const a = join(root, "repo-a");
  const b = join(root, "repo-b");
  const artifacts = join(root, "artifacts");
  for (const directory of [startup, artifacts]) mkdirSync(directory);
  if (
    spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: startup, env: gitEnvironment() })
      .status === 0
  ) {
    throw new Error("The private startup fixture must be outside a Git repository");
  }
  for (const [directory, name] of [
    [a, "a"],
    [b, "b"],
  ] as const) {
    mkdirSync(join(directory, "checks"), { recursive: true });
    writeFileSync(join(directory, "candidate.txt"), name);
    writeFileSync(join(directory, "probe.cjs"), probe);
    writeFileSync(join(directory, "checks", "probe.cjs"), probe);
    initializeFixtureRepository(directory);
  }
  return {
    root,
    startup,
    a,
    b,
    artifacts,
    dispose() {
      const fromTemp = relative(realpathSync(tmpdir()), root);
      if (
        fromTemp.startsWith(`..${sep}`) ||
        fromTemp === ".." ||
        lstatSync(root).isSymbolicLink() ||
        realpathSync(root) !== root
      ) {
        throw new Error("Refusing to remove a redirected private fixture");
      }
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

export function initializeFixtureRepository(directory: string): void {
  for (const args of [
    ["init", "-b", "main"],
    ["config", "commit.gpgsign", "false"],
    ["config", "user.name", "LexRunner test fixture"],
    ["config", "user.email", "fixture@example.invalid"],
    ["add", "."],
    ["commit", "-m", "Private candidate fixture"],
  ]) {
    execFileSync("git", ["--no-optional-locks", ...args], {
      cwd: directory,
      env: gitEnvironment(),
      stdio: "pipe",
      windowsHide: true,
    });
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))
  );
}

export function routingPlan(cwd?: string): Plan {
  return loadPlan(
    canonicalJSONStringify({
      schemaVersion: "1.0.0",
      target: "main",
      policy: { requiredGates: ["probe"], maxWorkers: 1 },
      items: [
        {
          name: "selected",
          deps: [],
          gates: [{ name: "probe", run: "node probe.cjs", ...(cwd === undefined ? {} : { cwd }) }],
        },
      ],
    })
  );
}

export function evidence(summary: BoundedGateRunResult): {
  manifest: any;
  receipt: any;
  output: { cwd: string; candidate: string };
} {
  const reference = summary.artifactRefs.find((entry) => entry.kind === "gate-evidence-manifest");
  if (!reference) throw new Error("Expected actual execution evidence");
  const manifest = JSON.parse(readFileSync(reference.path, "utf8"));
  if (manifest.entries.length !== 1) throw new Error("Expected one actual gate receipt");
  const receiptPath = resolve(reference.path, "..", manifest.entries[0].receipt.path);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  const output = JSON.parse(receipt.output.stdout.content);
  return { manifest, receipt, output };
}

export function expectedDigests(plan: Plan): { plan: string; gate: string } {
  return {
    plan: computeCanonicalHash(loadPlan(canonicalJSONStringify(plan))),
    gate: computeCanonicalHash(Gate.parse(plan.items[0]!.gates[0])),
  };
}

export function containsManifest(directory: string): boolean {
  if (!existsSync(directory)) return false;
  // The fixture path is owned; recursion never follows a link.
  return readdirSync(directory, { withFileTypes: true }).some(
    (entry) =>
      entry.name === "gate-evidence-manifest.json" ||
      (entry.isDirectory() && containsManifest(join(directory, entry.name)))
  );
}
