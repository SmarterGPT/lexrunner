import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GateExecutionService } from "../../src/application/gate-execution-service.js";
import * as candidateIdentity from "../../src/application/gate-candidate-identity.js";
import { executeGatesWithPolicy } from "../../src/gates.js";
import {
  candidateFixture,
  containsManifest,
  evidence,
  expectedDigests,
  initializeFixtureRepository,
  routingPlan,
  type CandidateFixture,
} from "../helpers/gate-candidate-fixture.js";

const fixtures: CandidateFixture[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});
function fixture(): CandidateFixture {
  const result = candidateFixture();
  fixtures.push(result);
  return result;
}

describe("invocation-local gate candidate routing", () => {
  it.each([undefined, ".", "checks"])(
    "binds default and relative cwd %s without rewriting declared digests",
    async (cwd) => {
      const f = fixture();
      const plan = routingPlan(cwd);
      const original = JSON.stringify(plan);
      const digests = expectedDigests(plan);
      const result = await new GateExecutionService().run({
        plan,
        repoRoot: f.a,
        artifactDir: f.artifacts,
        options: { emitReceipt: false, suppressStdout: true },
      });
      expect(result.summary.allGreen).toBe(true);
      const actual = evidence(result.summary);
      const expectedCwd = cwd === "checks" ? join(f.a, "checks") : f.a;
      expect(actual.output).toEqual({ cwd: expectedCwd, candidate: "a" });
      expect(actual.manifest.candidate.repositoryRoot).toBe(f.a);
      expect(actual.manifest.plan.digest).toBe(digests.plan);
      expect(actual.manifest.entries[0].declaredGateDigest).toBe(digests.gate);
      expect(actual.receipt.binding.declaredGateDigest).toBe(digests.gate);
      expect(actual.receipt.binding.candidateDigest).toBe(actual.manifest.candidate.worktreeDigest);
      expect(actual.receipt.declaredGate.cwd).toBe(cwd ?? null);
      expect(actual.receipt.execution.cwd).toBe(expectedCwd);
      expect(JSON.stringify(plan)).toBe(original);
    },
    30_000
  );

  it("keeps concurrent repositories distinct through one shared service", async () => {
    const f = fixture();
    const startup = process.cwd();
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new GateExecutionService(async (...args) => {
      if (++arrivals === 2) release();
      await barrier;
      return executeGatesWithPolicy(...args);
    });
    const results = await Promise.all(
      [f.a, f.b].map((repoRoot) =>
        service.run({
          plan: routingPlan("checks"),
          repoRoot,
          artifactDir: f.artifacts,
          options: { emitReceipt: false, suppressStdout: true },
        })
      )
    );
    expect(process.cwd()).toBe(startup);
    expect(arrivals).toBe(2);
    for (const [index, result] of results.entries()) {
      const repo = index === 0 ? f.a : f.b;
      const actual = evidence(result.summary);
      expect(result.summary.allGreen).toBe(true);
      expect(actual.manifest.candidate.repositoryRoot).toBe(repo);
      expect(actual.output).toEqual({
        cwd: join(repo, "checks"),
        candidate: index === 0 ? "a" : "b",
      });
      expect(actual.receipt.execution.cwd).toBe(join(repo, "checks"));
      expect(actual.receipt.binding.candidateDigest).toBe(actual.manifest.candidate.worktreeDigest);
    }
  }, 30_000);

  it("rejects missing, non-Git and invalid explicit roots before executor entry", async () => {
    const f = fixture();
    const execute = vi.fn();
    const service = new GateExecutionService(execute);
    for (const repoRoot of [
      join(f.root, "missing"),
      f.startup,
      join(f.a, "candidate.txt"),
      "",
      "\0",
      "x".repeat(4097),
      null,
      false,
      0,
      {},
    ]) {
      await expect(
        service.run({ plan: routingPlan(), repoRoot: repoRoot as string, artifactDir: f.artifacts })
      ).rejects.toMatchObject({ code: "GATE_CANDIDATE_ROOT_INVALID" });
    }
    expect(execute).not.toHaveBeenCalled();
    expect(containsManifest(f.artifacts)).toBe(false);
  });

  it("refuses provided empty or nonstring selectors rather than widening execution", async () => {
    const f = fixture();
    const execute = vi.fn();
    const service = new GateExecutionService(execute);
    for (const value of ["", 0, false, null, {}]) {
      for (const field of ["onlyItem", "onlyGate"] as const) {
        await expect(
          service.run({
            plan: routingPlan(),
            repoRoot: f.a,
            artifactDir: f.artifacts,
            [field]: value as string,
          })
        ).rejects.toMatchObject({ code: "GATE_SELECTION_NOT_FOUND" });
      }
    }
    expect(execute).not.toHaveBeenCalled();
    expect(containsManifest(f.artifacts)).toBe(false);
  });

  it("rejects another candidate, missing cwd, parent escape and nested Git roots before executor entry", async () => {
    const f = fixture();
    const nested = join(f.a, "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, "nested.txt"), "nested");
    initializeFixtureRepository(nested);
    const execute = vi.fn();
    const service = new GateExecutionService(execute);
    for (const [cwd, code] of [
      [f.b, "GATE_WORKING_DIRECTORY_CONFLICT"],
      ["../repo-b", "GATE_WORKING_DIRECTORY_CONFLICT"],
      ["missing", "GATE_WORKING_DIRECTORY_INVALID"],
      ["nested", "GATE_WORKING_DIRECTORY_CONFLICT"],
    ]) {
      await expect(
        service.run({ plan: routingPlan(cwd), repoRoot: f.a, artifactDir: f.artifacts })
      ).rejects.toMatchObject({ code });
    }
    expect(execute).not.toHaveBeenCalled();
    expect(containsManifest(f.artifacts)).toBe(false);
  });

  it("rejects a physical junction or symlink escape while accepting an alias to the selected root", async () => {
    const f = fixture();
    const alias = join(f.root, "alias-a");
    const escape = join(f.a, "foreign");
    symlinkSync(f.a, alias, process.platform === "win32" ? "junction" : "dir");
    const result = await new GateExecutionService().run({
      plan: routingPlan("checks"),
      repoRoot: alias,
      artifactDir: f.artifacts,
      options: { emitReceipt: false, suppressStdout: true },
    });
    expect(result.summary.allGreen).toBe(true);
    expect(evidence(result.summary).manifest.candidate.repositoryRoot).toBe(f.a);
    symlinkSync(f.b, escape, process.platform === "win32" ? "junction" : "dir");
    const execute = vi.fn();
    await expect(
      new GateExecutionService(execute).run({
        plan: routingPlan("foreign"),
        repoRoot: alias,
        artifactDir: f.artifacts,
      })
    ).rejects.toMatchObject({ code: "GATE_WORKING_DIRECTORY_CONFLICT" });
    expect(execute).not.toHaveBeenCalled();
  }, 30_000);

  it("validates only the executable selected item and gate subset", async () => {
    const f = fixture();
    const plan = routingPlan();
    plan.items[0]!.gates.push({ ...plan.items[0]!.gates[0]!, name: "unselected", cwd: f.b });
    plan.items.push({
      name: "other",
      deps: [],
      gates: [{ ...plan.items[0]!.gates[0]!, cwd: f.b }],
    });
    const result = await new GateExecutionService().run({
      plan,
      repoRoot: f.a,
      artifactDir: f.artifacts,
      onlyItem: "selected",
      onlyGate: "probe",
      options: { emitReceipt: false, suppressStdout: true },
    });
    expect(result.summary.allGreen).toBe(false);
    expect(result.summary.items[0]!.gates).toEqual([
      { name: "probe", status: "pass", timeoutMs: expect.any(Number) },
    ]);
    expect(evidence(result.summary).output.candidate).toBe("a");
  }, 30_000);

  it("replaces caller cwd maps with the validated invocation binding", async () => {
    const f = fixture();
    const result = await new GateExecutionService().run({
      plan: routingPlan("checks"),
      repoRoot: f.a,
      artifactDir: f.artifacts,
      options: {
        emitReceipt: false,
        suppressStdout: true,
        resolvedGateWorkingDirectories: { [JSON.stringify(["selected", "probe"])]: f.b },
      },
    });
    expect(result.summary.allGreen).toBe(true);
    expect(evidence(result.summary).output).toEqual({ cwd: join(f.a, "checks"), candidate: "a" });
  }, 30_000);

  it("bounds only the selected subset while preserving unqualified omitted gates", async () => {
    const f = fixture();
    const plan = routingPlan();
    plan.items[0]!.gates.push(
      ...Array.from({ length: 64 }, (_, index) => ({
        ...plan.items[0]!.gates[0]!,
        name: `omitted-gate-${index}`,
        cwd: f.b,
      }))
    );
    plan.items.push(
      ...Array.from({ length: 256 }, (_, index) => ({
        name: `omitted-item-${index}`,
        deps: [],
        gates: [{ ...plan.items[0]!.gates[0]!, cwd: f.b }],
      }))
    );
    const result = await new GateExecutionService().run({
      plan,
      repoRoot: f.a,
      artifactDir: f.artifacts,
      onlyItem: "selected",
      onlyGate: "probe",
      options: { emitReceipt: false, suppressStdout: true },
    });
    expect(result.summary.items.map(({ name }) => name)).toEqual(["selected"]);
    expect(result.summary.allGreen).toBe(false);
    expect(result.summary.items[0]!.gates[0]!.status).toBe("pass");
    expect(evidence(result.summary).output).toEqual({ cwd: f.a, candidate: "a" });
  }, 30_000);

  it("keeps repeated cwd lookup work independent of the selected gate count in each phase", async () => {
    const f = fixture();
    const plan = routingPlan("checks");
    plan.items = Array.from({ length: 128 }, (_, index) => ({
      name: `item-${index}`,
      deps: [],
      gates: [
        { ...plan.items[0]!.gates[0]! },
        { ...plan.items[0]!.gates[0]!, name: "repeat", cwd: "checks/../checks" },
      ],
    }));
    const resolveRoot = vi.spyOn(candidateIdentity, "resolveGateRepositoryRoot");
    const execute = vi.fn(async (...args: Parameters<typeof executeGatesWithPolicy>) => {
      expect(args[6]).toBe(f.a);
      const directories = args[7]!.resolvedGateWorkingDirectories!;
      expect(Object.keys(directories)).toHaveLength(256);
      expect(
        Object.values(directories).every((directory) => directory === join(f.a, "checks"))
      ).toBe(true);
    });
    const result = await new GateExecutionService(execute).run({
      plan,
      repoRoot: f.a,
      artifactDir: f.artifacts,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(result.summary.items).toHaveLength(128);
    // Two unique physical cwd values, freshly observed in two distinct phases.
    expect(resolveRoot.mock.calls.length).toBeLessThanOrEqual(4);
    expect(result.summary.allGreen).toBe(false);
  }, 30_000);

  it("reobserves repeated lexical aliases after execution before publishing evidence", async () => {
    const f = fixture();
    const alias = join(f.root, "gate-alias");
    symlinkSync(join(f.a, "checks"), alias, process.platform === "win32" ? "junction" : "dir");
    const plan = routingPlan(alias);
    plan.items[0]!.gates.push({ ...plan.items[0]!.gates[0]!, name: "repeat" });
    const service = new GateExecutionService(async (...args) => {
      await executeGatesWithPolicy(...args);
      unlinkSync(alias);
      symlinkSync(join(f.b, "checks"), alias, process.platform === "win32" ? "junction" : "dir");
    });
    await expect(
      service.run({
        plan,
        repoRoot: f.a,
        artifactDir: f.artifacts,
        options: { emitReceipt: false, suppressStdout: true },
      })
    ).rejects.toMatchObject({ code: "GATE_CANDIDATE_CHANGED" });
    expect(containsManifest(f.artifacts)).toBe(false);
  }, 30_000);

  it("retains captured root and selection after the caller mutates its request", async () => {
    const f = fixture();
    const plan = routingPlan();
    plan.items.push({
      name: "other",
      deps: [],
      gates: [{ ...plan.items[0]!.gates[0]!, cwd: f.b }],
    });
    const request = {
      plan,
      repoRoot: f.a,
      artifactDir: f.artifacts,
      onlyItem: "selected",
      onlyGate: "probe",
      options: { emitReceipt: false, suppressStdout: true },
    };
    const service = new GateExecutionService(async (...args) => {
      await executeGatesWithPolicy(...args);
      request.repoRoot = f.b;
      request.onlyItem = "other";
      request.onlyGate = "omitted";
    });
    const result = await service.run(request);
    expect(result.summary.allGreen).toBe(true);
    expect(result.summary.items.map(({ name }) => name)).toEqual(["selected"]);
    const actual = evidence(result.summary);
    expect(actual.manifest.selection).toEqual({ onlyItem: "selected", onlyGate: "probe" });
    expect(actual.manifest.candidate.repositoryRoot).toBe(f.a);
    expect(actual.output.candidate).toBe("a");
  }, 30_000);

  it("refuses postflight candidate mutation without publishing a successful manifest", async () => {
    const f = fixture();
    const service = new GateExecutionService(async (...args) => {
      await executeGatesWithPolicy(...args);
      writeFileSync(join(f.a, "candidate.txt"), "changed-after-command");
    });
    await expect(
      service.run({
        plan: routingPlan(),
        repoRoot: f.a,
        artifactDir: f.artifacts,
        options: { emitReceipt: false, suppressStdout: true },
      })
    ).rejects.toMatchObject({ code: "GATE_CANDIDATE_CHANGED" });
    expect(containsManifest(f.artifacts)).toBe(false);
    expect(readFileSync(join(f.a, "candidate.txt"), "utf8")).toBe("changed-after-command");
  }, 30_000);
});
