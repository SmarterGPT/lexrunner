import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExecutionState } from "../src/executionState.js";
import { executeGatesWithPolicy } from "../src/gates.js";
import type { Gate, Plan } from "../src/schema.js";

describe("raw gate artifact admission", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("rejects a selected pattern before command dispatch or artifact-directory creation", async () => {
    const root = temporaryRoot();
    const marker = join(root, "command-ran.txt");
    const artifactDir = join(root, "must-not-be-created");
    const plan = createPlan([createItem("selected", marker, ["reports/**/*.json"])]);

    await expect(
      executeGatesWithPolicy(
        plan,
        new ExecutionState(plan),
        artifactDir,
        5_000,
        undefined,
        true,
        root
      )
    ).rejects.toThrow(/artifact declaration is unsupported/u);

    expect(existsSync(marker)).toBe(false);
    expect(existsSync(artifactDir)).toBe(false);
  });

  it("ignores an invalid declaration outside the explicit item selection", async () => {
    const root = temporaryRoot();
    const selectedMarker = join(root, "selected-ran.txt");
    const omittedMarker = join(root, "omitted-ran.txt");
    const artifactDir = join(root, "artifacts");
    const plan = createPlan([
      createItem("selected", selectedMarker),
      createItem("omitted", omittedMarker, ["reports/**/*.json"]),
    ]);
    const state = new ExecutionState(plan);

    await executeGatesWithPolicy(plan, state, artifactDir, 5_000, undefined, true, root, {
      onlyItem: "selected",
      suppressStdout: true,
    });

    expect(existsSync(selectedMarker)).toBe(true);
    expect(existsSync(omittedMarker)).toBe(false);
    expect(state.getNodeResult("selected")?.status).toBe("pass");
  });

  it("admits and collects an exact literal artifact path", async () => {
    const root = temporaryRoot();
    const receipt = join(root, "receipt.json");
    const artifactDir = join(root, "artifacts");
    const plan = createPlan([createItem("selected", receipt, ["receipt.json"])]);
    plan.items[0]!.gates[0]!.cwd = root;
    const state = new ExecutionState(plan);

    await executeGatesWithPolicy(plan, state, artifactDir, 5_000, undefined, true, root, {
      suppressStdout: true,
    });

    expect(existsSync(receipt)).toBe(true);
    expect(existsSync(artifactDir)).toBe(true);
    expect(state.getNodeResult("selected")?.status).toBe("pass");
  });

  function temporaryRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "lexrunner-artifact-admission-"));
    roots.push(root);
    return root;
  }
});

function createPlan(items: Plan["items"]): Plan {
  return {
    schemaVersion: "1.0.0",
    target: "main",
    policy: {
      requiredGates: ["test"],
      optionalGates: [],
      maxWorkers: 1,
      retries: {},
      overrides: {},
      blockOn: [],
      mergeRule: { type: "strict-required" },
    },
    items,
  };
}

function createItem(name: string, marker: string, artifacts: string[] = []): Plan["items"][number] {
  const gate: Gate = {
    name: "test",
    run: "node -e \"require('node:fs').writeFileSync(process.env.GATE_MARKER, 'ran')\"",
    cwd: ".",
    env: { GATE_MARKER: marker },
    runtime: "local",
    artifacts,
  };
  return { name, deps: [], gates: [gate] };
}
