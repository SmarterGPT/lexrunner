import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { ExecutionState } from "../src/executionState.js";
import { executeGatesWithPolicy } from "../src/gates.js";
import { MemoryMonitor } from "../src/performance.js";
import { Plan, type Policy } from "../src/schema.js";
import { ProgressReporter } from "../src/util/progress.js";

const retainedRoot = process.env.LEX1019_TEST_ARTIFACT_ROOT;
const suiteRoot = path.resolve(
  retainedRoot ?? path.join(os.tmpdir(), "lexrunner-cancellation-" + randomUUID())
);
fs.mkdirSync(suiteRoot, { recursive: true });

const childSource = [
  'import fs from "node:fs";',
  'import path from "node:path";',
  'import { setTimeout as delay } from "node:timers/promises";',
  "const root = process.env.LEX_CANCEL_FIXTURE;",
  "const id = process.env.LEX_CANCEL_GATE;",
  'if (!root || !id || !/^[A-C][12]?$/.test(id)) throw new Error("closed fixture required");',
  'const counter = path.join(root, id + ".count");',
  'const attempt = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) + 1 : 1;',
  'if (!Number.isInteger(attempt) || attempt > 2) throw new Error("unexpected fixture attempt");',
  "fs.writeFileSync(counter, String(attempt));",
  'const base = path.join(root, id + ".attempt-" + attempt);',
  'fs.writeFileSync(base + ".started.json", JSON.stringify({ pid:process.pid, id, attempt }), {flag:"wx"});',
  'const release = base + ".release";',
  "const deadline = Date.now() + 10000;",
  "while (!fs.existsSync(release) && Date.now() < deadline) await delay(10);",
  'if (!fs.existsSync(release)) throw new Error("fixture barrier deadline");',
  "const exitCode = Number(process.env.LEX_CANCEL_EXIT ?? 0);",
  'fs.writeFileSync(base + ".finished.json", JSON.stringify({ pid:process.pid, id, attempt, exitCode }), {flag:"wx"});',
  "process.exitCode = exitCode;",
].join("\n");

type NodeSpec = {
  name: string;
  deps?: string[];
  ids?: string[];
  exitCode?: number;
  empty?: boolean;
};
const fixtures: Fixture[] = [];

class Fixture {
  readonly root = fs.mkdtempSync(path.join(suiteRoot, "case-"));
  readonly artifacts = path.join(this.root, "gate-artifacts");
  readonly script = path.join(this.root, "gate-child.mjs");
  readonly plan: Plan;
  readonly state: ExecutionState;
  readonly reporter = new ProgressReporter({ enabled: false });
  readonly starts: string[] = [];
  cancelRequested = false;
  settled = false;
  execution?: Promise<void>;

  constructor(
    readonly nodes: NodeSpec[],
    policy: Partial<Policy> = {}
  ) {
    fs.writeFileSync(this.script, childSource);
    const quote = (value: string) =>
      process.platform === "win32"
        ? "'" + value.replace(/'/g, "''") + "'"
        : "'" + value.replace(/'/g, "'\"'\"'") + "'";
    const command =
      (process.platform === "win32" ? "& " : "") +
      quote(process.execPath) +
      " " +
      quote(this.script);
    this.plan = Plan.parse({
      schemaVersion: "1.0.0",
      target: "main",
      policy: { maxWorkers: 1, performance: { throttleOnMemory: false }, ...policy },
      items: nodes.map((node) => ({
        name: node.name,
        deps: node.deps ?? [],
        gates: node.empty
          ? []
          : (node.ids ?? [node.name]).map((id) => ({
              name: "fixture-" + id,
              run: command,
              runtime: "local",
              cwd: this.root,
              timeoutMs: 8000,
              env: {
                LEX_CANCEL_FIXTURE: this.root,
                LEX_CANCEL_GATE: id,
                LEX_CANCEL_EXIT: String(node.exitCode ?? 0),
              },
              artifacts: [],
            })),
      })),
    });
    this.state = new ExecutionState(this.plan);
    this.reporter.nodeStart = (name) => this.starts.push(name);
    fixtures.push(this);
  }

  run(): Promise<void> {
    this.execution = executeGatesWithPolicy(
      this.plan,
      this.state,
      this.artifacts,
      8000,
      this.reporter,
      true,
      this.root,
      { emitReceipt: false, suppressStdout: true, shouldCancel: () => this.cancelRequested }
    ).finally(() => {
      this.settled = true;
    });
    return this.execution;
  }

  file(id: string, suffix: string, attempt = 1): string {
    return path.join(this.root, id + ".attempt-" + attempt + suffix);
  }

  async started(id: string, attempt = 1): Promise<void> {
    await until(() => fs.existsSync(this.file(id, ".started.json", attempt)), id + " started");
  }

  release(id: string, attempt = 1): void {
    const file = this.file(id, ".release", attempt);
    if (!fs.existsSync(file)) fs.writeFileSync(file, "", { flag: "wx" });
  }

  releaseAll(): void {
    for (const node of this.nodes) {
      for (const id of node.ids ?? [node.name]) {
        this.release(id, 1);
        this.release(id, 2);
      }
    }
  }
}

async function until(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 6000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("bounded event wait: " + label);
    await delay(10);
  }
}

afterEach(async () => {
  const owned = fixtures.splice(0);
  for (const fixture of owned) {
    fixture.cancelRequested = true;
    fixture.releaseAll();
  }
  await Promise.allSettled(
    owned.flatMap((fixture) => (fixture.execution ? [fixture.execution] : []))
  );
  for (const fixture of owned) {
    fs.writeFileSync(
      path.join(fixture.root, "observation.json"),
      JSON.stringify(
        { starts: fixture.starts, results: [...fixture.state.getResults().values()] },
        null,
        2
      )
    );
  }
  vi.restoreAllMocks();
});

afterAll(() => {
  if (retainedRoot) return;
  const relative = path.relative(path.resolve(os.tmpdir()), suiteRoot);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !path.basename(suiteRoot).startsWith("lexrunner-cancellation-")
  ) {
    throw new Error("unexpected temporary fixture root");
  }
  fs.rmSync(suiteRoot, { recursive: true, force: true });
});

describe("cooperative gate cancellation", () => {
  it("drains an active gate without launching the next gate or pending item", async () => {
    const f = new Fixture([
      { name: "A", ids: ["A1", "A2"] },
      { name: "B", deps: ["A"] },
      { name: "C" },
    ]);
    const run = f.run();
    await f.started("A1");
    f.cancelRequested = true;
    await delay(150);
    expect(f.settled).toBe(false);
    expect(fs.existsSync(f.file("A1", ".finished.json"))).toBe(false);
    f.release("A1");
    await run;

    expect(f.starts).toEqual(["A"]);
    expect(f.state.getNodeResult("A")).toMatchObject({
      status: "blocked",
      eligibleForMerge: false,
      gates: [{ gate: "fixture-A1", status: "pass", attempts: 1 }],
    });
    for (const id of ["A2", "B", "C"]) {
      expect(fs.existsSync(f.file(id, ".started.json"))).toBe(false);
    }
    for (const id of ["B", "C"]) {
      expect(f.state.getNodeResult(id)).toMatchObject({ status: "blocked", gates: [] });
    }
  });

  it("blocks before admission and clears selected stale PASS evidence", async () => {
    const f = new Fixture([{ name: "A" }, { name: "B", empty: true }]);
    f.state.updateGateResult("A", { gate: "fixture-A", status: "pass", attempts: 1 });
    f.cancelRequested = true;
    await f.run();

    expect(f.starts).toEqual([]);
    for (const id of ["A", "B"]) {
      expect(f.state.getNodeResult(id)).toMatchObject({
        status: "blocked",
        gates: [],
        eligibleForMerge: false,
      });
      expect(fs.existsSync(f.file(id, ".started.json"))).toBe(false);
    }
  });

  it("stops retry backoff promptly and keeps the real failed attempt receipt", async () => {
    const f = new Fixture([{ name: "A", exitCode: 7 }], {
      retries: { "fixture-A": { maxAttempts: 2, backoffSeconds: 30 } },
    });
    let sawBackoff = false;
    vi.spyOn(console, "log").mockImplementation((message: unknown) => {
      if (String(message).includes("Retrying gate 'fixture-A'")) sawBackoff = true;
    });
    // Observe the retry admission point without enabling ordinary progress noise.
    const run = executeGatesWithPolicy(
      f.plan,
      f.state,
      f.artifacts,
      8000,
      f.reporter,
      true,
      f.root,
      { emitReceipt: false, shouldCancel: () => f.cancelRequested }
    );
    f.execution = run;
    await f.started("A");
    f.release("A");
    await until(() => sawBackoff, "retry backoff");
    const cancelledAt = Date.now();
    f.cancelRequested = true;
    await run;

    expect(Date.now() - cancelledAt).toBeLessThan(2000);
    expect(fs.existsSync(f.file("A", ".started.json", 2))).toBe(false);
    const node = f.state.getNodeResult("A")!;
    expect(node).toMatchObject({
      status: "blocked",
      eligibleForMerge: false,
      gates: [{ gate: "fixture-A", status: "fail", attempts: 1 }],
    });
    const receiptPath = node.gates[0]!.artifacts?.find((file) =>
      file.endsWith("gate-execution-receipt.attempt-1.json")
    );
    expect(receiptPath).toBeDefined();
    expect(JSON.parse(fs.readFileSync(receiptPath!, "utf8"))).toMatchObject({
      attempt: 1,
      outcome: { status: "fail", failureKind: "nonzero_exit" },
    });
  });

  it("does not complete an empty item as PASS when cancellation arrives at node start", async () => {
    const f = new Fixture([{ name: "A", empty: true }, { name: "B" }]);
    f.reporter.nodeStart = (name) => {
      f.starts.push(name);
      f.cancelRequested = true;
    };
    await f.run();

    expect(f.starts).toEqual(["A"]);
    expect(f.state.getNodeResult("A")).toMatchObject({
      status: "blocked",
      gates: [],
      eligibleForMerge: false,
    });
    expect(f.state.getNodeResult("B")).toMatchObject({ status: "blocked", gates: [] });
  });

  it("stops admission while memory throttling remains high", async () => {
    const f = new Fixture([{ name: "A" }], {
      performance: { maxMemoryMB: 128, throttleOnMemory: true },
    });
    vi.spyOn(MemoryMonitor.prototype, "isMemoryHigh").mockReturnValue(true);
    const run = f.run();
    await delay(150);
    f.cancelRequested = true;
    await run;

    expect(f.starts).toEqual([]);
    expect(f.state.getNodeResult("A")).toMatchObject({ status: "blocked", gates: [] });
  });
});
