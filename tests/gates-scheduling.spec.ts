import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { artifactIdentitySegment, executeGatesWithPolicy } from "../src/gates.js";
import { ExecutionState } from "../src/executionState.js";
import { Plan, type Gate, type Policy } from "../src/schema.js";
import { ProgressReporter } from "../src/util/progress.js";

const retainedRoot = process.env.LEX1017_TEST_ARTIFACT_ROOT;
const suiteRoot = path.resolve(
  retainedRoot ?? path.join(os.tmpdir(), "lexrunner-scheduling-" + randomUUID())
);
fs.mkdirSync(suiteRoot, { recursive: true });

const childSource = [
  'import fs from "node:fs";',
  'import path from "node:path";',
  'import { setTimeout as delay } from "node:timers/promises";',
  "const root = process.env.LEX_SCHED_FIXTURE;",
  "const id = process.env.LEX_SCHED_GATE;",
  'if (!root || !id || !/^[A-D][12]?$/.test(id)) throw new Error("closed fixture required");',
  'const counter = path.join(root, id + ".count");',
  'const attempt = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) + 1 : 1;',
  'if (!Number.isInteger(attempt) || attempt > 2) throw new Error("unexpected fixture attempt");',
  "fs.writeFileSync(counter, String(attempt));",
  'const base = path.join(root, id + ".attempt-" + attempt);',
  'fs.writeFileSync(base + ".started.json", JSON.stringify({ pid:process.pid, id, attempt, time:Date.now(), cwd:process.cwd() }), {flag:"wx"});',
  'const release = base + ".release";',
  "const deadline = Date.now() + 10000;",
  "while (!fs.existsSync(release) && Date.now() < deadline) await delay(10);",
  'if (!fs.existsSync(release)) throw new Error("fixture barrier deadline");',
  "const exitCode = attempt === 1 && process.env.LEX_SCHED_FIRST_EXIT",
  "  ? Number(process.env.LEX_SCHED_FIRST_EXIT) : Number(process.env.LEX_SCHED_EXIT ?? 0);",
  'fs.writeFileSync(base + ".finished.json", JSON.stringify({ pid:process.pid, id, attempt, exitCode, time:Date.now() }), {flag:"wx"});',
  "process.exitCode = exitCode;",
].join("\n");

type NodeSpec = {
  name: string;
  deps: string[];
  ids?: string[];
  exitCode?: number;
  firstExitCode?: number;
  runtime?: Gate["runtime"];
  gateName?: string;
  timeoutMs?: number;
  empty?: boolean;
};
type StartObservation = {
  name: string;
  dependencies: { name: string; status: string | undefined }[];
};
const fixtures: Fixture[] = [];

class Fixture {
  readonly root = fs.mkdtempSync(path.join(suiteRoot, "case-"));
  readonly artifacts = path.join(this.root, "gate-artifacts");
  readonly script = path.join(this.root, "gate-child.mjs");
  readonly plan: Plan;
  readonly state: ExecutionState;
  readonly starts: StartObservation[] = [];
  readonly completes: { name: string; success: boolean; status: string | undefined }[] = [];
  readonly active = new Set<string>();
  readonly reporter = new ProgressReporter({ enabled: false });
  peak = 0;
  execution?: Promise<void>;

  constructor(
    readonly nodes: NodeSpec[],
    maxWorkers = 1,
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
      policy: { maxWorkers, performance: { throttleOnMemory: false }, ...policy },
      items: nodes.map((node) => ({
        name: node.name,
        deps: node.deps,
        gates: node.empty
          ? []
          : (node.ids ?? [node.name]).map((id) => ({
              name: node.gateName ?? "fixture" + (node.ids ? "-" + id : ""),
              run: command,
              runtime: node.runtime ?? "local",
              cwd: this.root,
              timeoutMs: node.timeoutMs ?? 8000,
              env: {
                LEX_SCHED_FIXTURE: this.root,
                LEX_SCHED_GATE: id,
                LEX_SCHED_EXIT: String(node.exitCode ?? 0),
                ...(node.firstExitCode === undefined
                  ? {}
                  : { LEX_SCHED_FIRST_EXIT: String(node.firstExitCode) }),
              },
              artifacts: [],
            })),
      })),
    });
    this.state = new ExecutionState(this.plan);
    this.reporter.nodeStart = (name) => {
      this.active.add(name);
      this.peak = Math.max(this.peak, this.active.size);
      this.starts.push({
        name,
        dependencies: this.plan.items
          .find((item) => item.name === name)!
          .deps.map((dep) => ({
            name: dep,
            status: this.state.getNodeResult(dep)?.status,
          })),
      });
    };
    this.reporter.nodeComplete = (name, success = true) => {
      this.active.delete(name);
      this.completes.push({ name, success, status: this.state.getNodeResult(name)?.status });
    };
    fixtures.push(this);
    fs.writeFileSync(path.join(this.root, "frozen-plan.json"), JSON.stringify(this.plan, null, 2));
  }

  run(options: Parameters<typeof executeGatesWithPolicy>[7] = {}): Promise<void> {
    this.execution = executeGatesWithPolicy(
      this.plan,
      this.state,
      this.artifacts,
      8000,
      this.reporter,
      true,
      this.root,
      { emitReceipt: false, suppressStdout: true, ...options }
    );
    return this.execution;
  }

  file(id: string, suffix: string, attempt = 1): string {
    return path.join(this.root, id + ".attempt-" + attempt + suffix);
  }

  async started(id: string, attempt = 1): Promise<{ pid: number; cwd: string }> {
    await until(
      () => fs.existsSync(this.file(id, ".started.json", attempt)),
      "child " + id + "/" + attempt
    );
    return JSON.parse(fs.readFileSync(this.file(id, ".started.json", attempt), "utf8"));
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

  assertAcceptedDependencies(): void {
    for (const start of this.starts) {
      expect(start.dependencies.every((dep) => dep.status === "pass")).toBe(true);
    }
  }

  retainObservation(): void {
    fs.writeFileSync(
      path.join(this.root, "observation.json"),
      JSON.stringify(
        {
          starts: this.starts,
          completes: this.completes,
          peak: this.peak,
          results: [...this.state.getResults().values()],
        },
        null,
        2
      )
    );
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
  for (const fixture of owned) fixture.releaseAll();
  await Promise.allSettled(
    owned.flatMap((fixture) => (fixture.execution ? [fixture.execution] : []))
  );
  for (const fixture of owned) fixture.retainObservation();
  vi.restoreAllMocks();
});

afterAll(() => {
  if (retainedRoot) return;
  // Only the UUID temporary directory created by this suite may be removed.
  const temporary = path.resolve(os.tmpdir());
  const relative = path.relative(temporary, suiteRoot);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !path.basename(suiteRoot).startsWith("lexrunner-scheduling-")
  ) {
    throw new Error("unexpected temporary fixture root");
  }
  fs.rmSync(suiteRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("frozen-plan gate scheduler", () => {
  it("admits a passing chain only after each prerequisite's accepted PASS", async () => {
    const f = new Fixture(
      [
        { name: "A", deps: [] },
        { name: "B", deps: ["A"] },
        { name: "C", deps: ["B"] },
      ],
      3
    );
    const run = f.run();
    await f.started("A");
    expect(f.starts.map((item) => item.name)).toEqual(["A"]);
    f.release("A");
    await f.started("B");
    expect(f.completes).toContainEqual({ name: "A", success: true, status: "pass" });
    expect(f.starts.map((item) => item.name)).toEqual(["A", "B"]);
    f.release("B");
    await f.started("C");
    f.release("C");
    await run;
    f.assertAcceptedDependencies();
    expect(f.state.isExecutionComplete()).toBe(true);
    expect(f.starts.map((item) => item.name)).toEqual(["A", "B", "C"]);
  });

  it("never launches failed descendants and still completes an independent branch", async () => {
    const f = new Fixture(
      [
        { name: "C", deps: ["B"] },
        { name: "B", deps: ["A"] },
        { name: "A", deps: [], exitCode: 7 },
        { name: "D", deps: [] },
      ],
      3
    );
    const run = f.run();
    await Promise.all([f.started("A"), f.started("D")]);
    f.release("A");
    await until(() => f.state.getNodeResult("C")?.status === "blocked", "transitive blocking");
    expect(f.starts.map((item) => item.name).sort()).toEqual(["A", "D"]);
    expect(f.state.getNodeResult("B")).toMatchObject({
      status: "blocked",
      blockedBy: ["A"],
      gates: [],
    });
    expect(f.state.getNodeResult("C")).toMatchObject({
      status: "blocked",
      blockedBy: ["B"],
      gates: [],
    });
    expect(f.completes).toContainEqual({ name: "A", success: false, status: "fail" });
    expect(fs.existsSync(f.file("D", ".finished.json"))).toBe(false);
    f.release("D");
    await run;
    expect(f.state.getNodeResult("D")?.status).toBe("pass");
    expect(f.state.isExecutionComplete()).toBe(true);
  });

  it("allows diamond siblings together but waits for both before the join", async () => {
    const f = new Fixture(
      [
        { name: "D", deps: ["B", "C"] },
        { name: "B", deps: ["A"] },
        { name: "C", deps: ["A"] },
        { name: "A", deps: [] },
      ],
      4
    );
    const run = f.run();
    await f.started("A");
    expect(f.starts.map((item) => item.name)).toEqual(["A"]);
    f.release("A");
    await Promise.all([f.started("B"), f.started("C")]);
    expect([...f.active].sort()).toEqual(["B", "C"]);
    expect(f.peak).toBe(2);
    f.release("B");
    await until(() => f.completes.some((item) => item.name === "B"), "B settled");
    expect(f.starts.map((item) => item.name)).toEqual(["A", "B", "C"]);
    f.release("C");
    await f.started("D");
    expect(f.completes).toContainEqual({ name: "C", success: true, status: "pass" });
    f.release("D");
    await run;
    f.assertAcceptedDependencies();
  });

  it("keeps independent actual commands within maxWorkers one", async () => {
    const f = new Fixture(
      [
        { name: "A", deps: [] },
        { name: "B", deps: [] },
        { name: "C", deps: [] },
      ],
      1
    );
    const run = f.run();
    for (const [index, name] of ["A", "B", "C"].entries()) {
      await f.started(name);
      expect(f.starts.map((item) => item.name)).toEqual(["A", "B", "C"].slice(0, index + 1));
      expect([...f.active]).toEqual([name]);
      f.release(name);
    }
    await run;
    expect(f.peak).toBe(1);
    expect(f.completes).toHaveLength(3);
  });

  it("reserves maxWorkers two and replenishes a freed slot before a held sibling finishes", async () => {
    const f = new Fixture(
      [
        { name: "A", deps: [] },
        { name: "B", deps: [] },
        { name: "C", deps: [] },
        { name: "D", deps: [] },
      ],
      2
    );
    const run = f.run();
    await Promise.all([f.started("A"), f.started("B")]);
    expect(f.starts.map((item) => item.name)).toEqual(["A", "B"]);
    expect(f.peak).toBe(2);
    f.release("B");
    await f.started("C");
    expect([...f.active].sort()).toEqual(["A", "C"]);
    expect(fs.existsSync(f.file("A", ".finished.json"))).toBe(false);
    f.release("C");
    await f.started("D");
    expect([...f.active].sort()).toEqual(["A", "D"]);
    f.release("A");
    f.release("D");
    await run;
    expect(f.peak).toBe(2);
    expect(f.starts.map((item) => item.name)).toEqual(["A", "B", "C", "D"]);
  });

  it("blocks the join after one diamond branch fails without stopping its running sibling", async () => {
    const f = new Fixture(
      [
        { name: "A", deps: [] },
        { name: "B", deps: ["A"], exitCode: 7 },
        { name: "C", deps: ["A"] },
        { name: "D", deps: ["B", "C"] },
      ],
      2
    );
    const run = f.run();
    await f.started("A");
    f.release("A");
    await Promise.all([f.started("B"), f.started("C")]);
    f.release("B");
    await until(() => f.state.getNodeResult("D")?.status === "blocked", "join blocked");
    expect(f.state.getNodeResult("D")).toMatchObject({ blockedBy: ["B"], gates: [] });
    expect([...f.active]).toEqual(["C"]);
    f.release("C");
    await run;
    expect(f.state.getNodeResult("C")?.status).toBe("pass");
    expect(f.starts.map((item) => item.name)).toEqual(["A", "B", "C"]);
  });

  it("turns a timed-out held process into failure and never launches its child", async () => {
    const f = new Fixture(
      [
        { name: "A", deps: [], timeoutMs: 1500 },
        { name: "B", deps: ["A"] },
      ],
      2
    );
    const run = f.run();
    const child = await f.started("A");
    await run;
    expect(f.state.getNodeResult("A")).toMatchObject({
      status: "fail",
      gates: [
        {
          status: "fail",
          failureKind: "timeout",
          exitCode: 124,
          timeoutCleanup: { descendantsReaped: true },
        },
      ],
    });
    expect(f.state.getNodeResult("B")).toMatchObject({
      status: "blocked",
      blockedBy: ["A"],
      gates: [],
    });
    expect(f.starts.map((item) => item.name)).toEqual(["A"]);
    expect(() => process.kill(child.pid, 0)).toThrow();
    expect(f.state.isExecutionComplete()).toBe(true);
  });

  it("records an executor artifact exception as terminal failure while independent work settles", async () => {
    const f = new Fixture(
      [
        { name: "A", deps: [] },
        { name: "B", deps: ["A"] },
        { name: "C", deps: [] },
      ],
      2
    );
    const failingDirectory = path.join(f.artifacts, artifactIdentitySegment("A"));
    const mkdir = fs.mkdirSync;
    const injected = ((...args: Parameters<typeof fs.mkdirSync>) => {
      if (path.resolve(String(args[0])) === failingDirectory) {
        throw Object.assign(new Error("owned fixture ENOSPC"), { code: "ENOSPC" });
      }
      return Reflect.apply(mkdir, fs, args);
    }) as typeof fs.mkdirSync;
    vi.spyOn(fs, "mkdirSync").mockImplementation(injected);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const run = f.run();
    await f.started("C");
    f.release("C");
    await run;
    expect(f.state.getNodeResult("A")).toMatchObject({ status: "fail", gates: [] });
    expect(f.state.getErrorDiagnostics()).toHaveLength(1);
    expect(f.state.getNodeResult("B")).toMatchObject({
      status: "blocked",
      blockedBy: ["A"],
      gates: [],
    });
    expect(fs.existsSync(f.file("A", ".started.json"))).toBe(false);
    expect(f.starts.map((item) => item.name)).toEqual(["A", "C"]);
    expect(f.state.isExecutionComplete()).toBe(true);
  });

  it("rejects actual receipt retention failure after a child closes and blocks its descendants", async () => {
    const f = new Fixture(
      [
        { name: "A", deps: [] },
        { name: "B", deps: ["A"] },
      ],
      2
    );
    const itemDirectory = path.join(f.artifacts, artifactIdentitySegment("A"));
    fs.mkdirSync(itemDirectory, { recursive: true });
    // This owned file makes the receipt directory impossible without changing
    // the already admitted command or throwing from an artificial executor.
    fs.writeFileSync(
      path.join(itemDirectory, artifactIdentitySegment("fixture")),
      "owned collision"
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const run = f.run();
    await f.started("A");
    f.release("A");
    await run;
    expect(fs.existsSync(f.file("A", ".finished.json"))).toBe(true);
    expect(f.state.getNodeResult("A")).toMatchObject({ status: "fail", gates: [] });
    expect(f.state.getErrorDiagnostics()).toHaveLength(1);
    expect(f.state.getNodeResult("B")).toMatchObject({
      status: "blocked",
      blockedBy: ["A"],
      gates: [],
    });
    expect(f.starts.map((item) => item.name)).toEqual(["A"]);
    expect(f.state.isExecutionComplete()).toBe(true);
  });

  it("rejects retention failure in the spawn-error callback without leaving a pending item", async () => {
    const f = new Fixture(
      [
        { name: "A", deps: [] },
        { name: "B", deps: ["A"] },
      ],
      2
    );
    f.plan.items[0].gates[0].cwd = path.join(f.root, "missing-owned-directory");
    const itemDirectory = path.join(f.artifacts, artifactIdentitySegment("A"));
    fs.mkdirSync(itemDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(itemDirectory, artifactIdentitySegment("fixture")),
      "owned collision"
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await f.run();
    expect(f.state.getNodeResult("A")).toMatchObject({ status: "fail", gates: [] });
    expect(f.state.getNodeResult("B")).toMatchObject({ status: "blocked", gates: [] });
    expect(fs.existsSync(f.file("A", ".started.json"))).toBe(false);
    expect(f.state.isExecutionComplete()).toBe(true);
  });

  it("settles a policy-blocked prerequisite without invoking any descendant command", async () => {
    const f = new Fixture(
      [
        { name: "A", deps: [], gateName: "denied" },
        { name: "B", deps: ["A"] },
      ],
      2,
      { blockOn: ["denied"] }
    );
    await f.run();
    expect(f.state.getNodeResult("A")).toMatchObject({
      status: "blocked",
      gates: [{ status: "blocked" }],
    });
    expect(f.state.getNodeResult("B")).toMatchObject({
      status: "blocked",
      blockedBy: ["A"],
      gates: [],
    });
    expect(f.starts.map((item) => item.name)).toEqual(["A"]);
    expect(fs.existsSync(f.file("A", ".started.json"))).toBe(false);
    expect(f.state.isExecutionComplete()).toBe(true);
  });

  it("blocks descendants of a settled skipped gate without spinning on pending work", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const f = new Fixture(
      [
        { name: "A", deps: [], runtime: "ci-service" },
        { name: "B", deps: ["A"] },
      ],
      2
    );
    await f.run();
    expect(f.state.getNodeResult("A")).toMatchObject({
      status: "skipped",
      gates: [{ status: "skipped" }],
    });
    expect(f.state.getNodeResult("B")).toMatchObject({
      status: "blocked",
      blockedBy: ["A"],
      gates: [],
    });
    expect(f.starts.map((item) => item.name)).toEqual(["A"]);
  });

  it("blocks a selected child when omitted prerequisites have no explicit PASS evidence", async () => {
    const f = new Fixture(
      [
        { name: "A", deps: [] },
        { name: "B", deps: ["A"] },
      ],
      2
    );
    await f.run({ onlyItem: "B" });
    expect(f.starts).toEqual([]);
    expect(f.state.getNodeResult("A")).toMatchObject({ status: "skipped", gates: [] });
    expect(f.state.getNodeResult("B")).toMatchObject({
      status: "blocked",
      blockedBy: ["A"],
      gates: [],
    });
  });

  it("uses explicit prerequisite PASS evidence without running the unselected item", async () => {
    const f = new Fixture(
      [
        { name: "A", deps: [] },
        { name: "B", deps: ["A"] },
      ],
      2
    );
    f.state.updateGateResult("A", { gate: "fixture", status: "pass", attempts: 1 });
    const omittedEvidence = JSON.stringify(f.state.getNodeResult("A"));
    const run = f.run({ onlyItem: "B" });
    await f.started("B");
    f.release("B");
    await run;
    expect(f.starts.map((item) => item.name)).toEqual(["B"]);
    expect(fs.existsSync(f.file("A", ".started.json"))).toBe(false);
    expect(JSON.stringify(f.state.getNodeResult("A"))).toBe(omittedEvidence);
    f.assertAcceptedDependencies();
  });

  it("does not let prior PASS bypass a selected prerequisite's current failing invocation", async () => {
    const f = new Fixture(
      [
        { name: "A", deps: [], exitCode: 7 },
        { name: "B", deps: ["A"] },
      ],
      2
    );
    f.state.updateGateResult("A", { gate: "fixture", status: "pass", attempts: 1 });
    const run = f.run();
    await f.started("A");
    expect(f.starts.map((item) => item.name)).toEqual(["A"]);
    f.release("A");
    await run;
    expect(f.state.getNodeResult("B")).toMatchObject({ status: "blocked", gates: [] });
  });

  it("never treats a filtered-out required parent gate as prerequisite PASS", async () => {
    const f = new Fixture(
      [
        { name: "A", deps: [], gateName: "other" },
        { name: "B", deps: ["A"] },
      ],
      2
    );
    await f.run({ onlyGate: "fixture" });
    expect(f.state.getNodeResult("A")).toMatchObject({ status: "skipped", gates: [] });
    expect(f.state.getNodeResult("B")).toMatchObject({
      status: "blocked",
      blockedBy: ["A"],
      gates: [],
    });
    expect(f.starts.map((item) => item.name)).toEqual(["A"]);
    expect(fs.existsSync(f.file("B", ".started.json"))).toBe(false);
  });

  it("discards prior required PASS when the selected parent runs no matching gate", async () => {
    const f = new Fixture(
      [
        { name: "A", deps: [], gateName: "other" },
        { name: "B", deps: ["A"] },
      ],
      2
    );
    f.state.updateGateResult("A", { gate: "other", status: "pass", attempts: 1 });
    expect(f.state.getNodeResult("A")?.status).toBe("pass");
    // Let any incorrectly admitted command finish immediately, so an absence
    // assertion exposes this seam without relying on timeout/failure behavior.
    f.releaseAll();
    await f.run({ onlyGate: "fixture" });
    expect(f.state.getNodeResult("A")).toMatchObject({ status: "skipped", gates: [] });
    expect(f.state.getNodeResult("B")).toMatchObject({
      status: "blocked",
      blockedBy: ["A"],
      gates: [],
    });
    expect(f.starts.map((item) => item.name)).toEqual(["A"]);
    expect(fs.existsSync(f.file("A", ".started.json"))).toBe(false);
    expect(fs.existsSync(f.file("B", ".started.json"))).toBe(false);
  });

  it("does not reuse another prior gate PASS alongside a current partial selected PASS", async () => {
    const f = new Fixture(
      [
        { name: "A", deps: [], ids: ["A1", "A2"] },
        { name: "B", deps: ["A"] },
      ],
      2
    );
    f.plan.items[0].gates[0].name = "fixture";
    f.plan.items[0].gates[1].name = "other";
    f.state.updateGateResult("A", { gate: "fixture", status: "pass", attempts: 1 });
    f.state.updateGateResult("A", { gate: "other", status: "pass", attempts: 1 });
    expect(f.state.getNodeResult("A")?.status).toBe("pass");
    f.releaseAll();
    await f.run({ onlyGate: "fixture" });
    expect(f.state.getNodeResult("A")).toMatchObject({
      status: "skipped",
      gates: [{ gate: "fixture", status: "pass" }],
    });
    expect(f.state.getNodeResult("A")?.gates).toHaveLength(1);
    expect(f.state.getNodeResult("B")).toMatchObject({
      status: "blocked",
      blockedBy: ["A"],
      gates: [],
    });
    expect(f.starts.map((item) => item.name)).toEqual(["A"]);
    expect(fs.existsSync(f.file("A1", ".finished.json"))).toBe(true);
    expect(fs.existsSync(f.file("A2", ".started.json"))).toBe(false);
    expect(fs.existsSync(f.file("B", ".started.json"))).toBe(false);
  });

  it("discards prior PASS for a required gate absent from the selected item's command list", async () => {
    const f = new Fixture(
      [
        { name: "A", deps: [], empty: true },
        { name: "B", deps: ["A"] },
      ],
      2,
      { requiredGates: ["missing"] }
    );
    f.state.updateGateResult("A", { gate: "missing", status: "pass", attempts: 1 });
    expect(f.state.getNodeResult("A")?.status).toBe("pass");
    f.releaseAll();
    await f.run();
    expect(f.state.getNodeResult("A")).toMatchObject({ status: "skipped", gates: [] });
    expect(f.state.getNodeResult("B")).toMatchObject({
      status: "blocked",
      blockedBy: ["A"],
      gates: [],
    });
    expect(f.starts.map((item) => item.name)).toEqual(["A"]);
    expect(fs.existsSync(f.file("B", ".started.json"))).toBe(false);
  });

  it("completes a genuinely empty node without synthesizing any gate results", async () => {
    const f = new Fixture(
      [
        { name: "A", deps: [], empty: true },
        { name: "B", deps: ["A"] },
      ],
      2
    );
    const run = f.run();
    await f.started("B");
    expect(f.state.getNodeResult("A")).toMatchObject({ status: "pass", gates: [] });
    f.release("B");
    await run;
    f.assertAcceptedDependencies();
  });

  it("leaves an empty node with declared missing requirements non-green", async () => {
    const f = new Fixture(
      [
        { name: "A", deps: [], empty: true },
        { name: "B", deps: ["A"] },
      ],
      2,
      { requiredGates: ["required"] }
    );
    await f.run();
    expect(f.state.getNodeResult("A")).toMatchObject({ status: "skipped", gates: [] });
    expect(f.state.getNodeResult("B")).toMatchObject({ status: "blocked", gates: [] });
    expect(fs.existsSync(f.file("B", ".started.json"))).toBe(false);
  });

  it("retains sequential per-item gates and holds dependents until all required gates pass", async () => {
    const f = new Fixture(
      [
        { name: "A", deps: [], ids: ["A1", "A2"] },
        { name: "B", deps: ["A"] },
      ],
      2
    );
    const run = f.run();
    await f.started("A1");
    expect(fs.existsSync(f.file("A2", ".started.json"))).toBe(false);
    expect(f.starts.map((item) => item.name)).toEqual(["A"]);
    f.release("A1");
    await f.started("A2");
    expect(f.starts.map((item) => item.name)).toEqual(["A"]);
    f.release("A2");
    await f.started("B");
    f.release("B");
    await run;
    expect(f.state.getNodeResult("A")?.gates.map((gate) => gate.status)).toEqual(["pass", "pass"]);
    f.assertAcceptedDependencies();
  });

  it("waits across real retries and only unlocks a descendant after the final accepted PASS", async () => {
    const f = new Fixture(
      [
        { name: "A", deps: [], firstExitCode: 7 },
        { name: "B", deps: ["A"] },
      ],
      2,
      {
        retries: { fixture: { maxAttempts: 2, backoffSeconds: 0 } },
      }
    );
    const run = f.run();
    await f.started("A");
    f.release("A");
    await f.started("A", 2);
    expect(f.starts.map((item) => item.name)).toEqual(["A"]);
    f.release("A", 2);
    await f.started("B");
    f.release("B");
    await run;
    expect(f.state.getNodeResult("A")).toMatchObject({
      status: "pass",
      gates: [{ status: "pass", attempts: 2 }],
    });
    f.assertAcceptedDependencies();
  });

  it("awaits admitted work even when a progress observer throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const f = new Fixture(
      [
        { name: "A", deps: [] },
        { name: "B", deps: [] },
      ],
      2
    );
    f.reporter.nodeComplete = () => {
      throw new Error("fixture observer failed");
    };
    const run = f.run();
    await Promise.all([f.started("A"), f.started("B")]);
    f.release("B");
    await until(() => f.state.getNodeResult("B")?.status === "pass", "B accepted");
    expect(fs.existsSync(f.file("A", ".finished.json"))).toBe(false);
    f.release("A");
    await run;
    expect(f.state.getNodeResult("A")?.status).toBe("pass");
    expect(f.state.getNodeResult("B")?.status).toBe("pass");
  });

  it.each(["cycle", "missing"])(
    "rejects %s dependencies before any gate commands start",
    async (kind) => {
      const f = new Fixture(
        [
          { name: "A", deps: [] },
          { name: "B", deps: ["A"] },
        ],
        2
      );
      f.plan.items[0].deps = [kind === "cycle" ? "B" : "not-in-plan"];
      await expect(f.run()).rejects.toThrow(
        kind === "cycle" ? "Dependency cycle" : "Dependency not found"
      );
      expect(f.starts).toEqual([]);
      expect(fs.existsSync(f.file("A", ".started.json"))).toBe(false);
    }
  );

  it("uses invocation-local resolved cwd while keeping declared gates and plan untouched", async () => {
    const f = new Fixture([{ name: "A", deps: [] }]);
    const resolved = path.join(f.root, "resolved");
    fs.mkdirSync(resolved);
    f.plan.items[0].gates[0].cwd = "declared-relative-path";
    const frozen = JSON.stringify(f.plan);
    Object.freeze(f.plan.items[0].gates[0]);
    const run = f.run({
      resolvedGateWorkingDirectories: { [JSON.stringify(["A", "fixture"])]: resolved },
    });
    const child = await f.started("A");
    expect(path.resolve(child.cwd)).toBe(resolved);
    f.release("A");
    await run;
    expect(f.state.getNodeResult("A")?.status).toBe("pass");
    expect(JSON.stringify(f.plan)).toBe(frozen);
  });
}, 15000);
