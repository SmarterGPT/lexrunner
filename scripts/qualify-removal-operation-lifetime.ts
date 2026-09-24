import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rename, rm, access } from "node:fs/promises";
import { dirname, basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { SqliteWorkspaceLifecycleStore } from "../src/store/sqlite/workspace-lifecycle-store.js";
import { SqliteRemovalEvidenceStore } from "../src/store/sqlite/removal-evidence-store.js";
import { assessReservedRemovalRecovery } from "../src/workspaces/workspace-removal-evidence.js";
import { canonicalJSONStringify } from "../src/util/canonicalJson.js";
import { probeObservation, removalProbeSnapshot } from "./removal-probe-records.js";

// Cooperative development fixture only. Every effect contender here uses the slot.
// No broker/helper protocol entrypoint or authenticated admission is implemented.
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = fileURLToPath(import.meta.url);
const [mode, rootArg, probe, git, request, launch] = process.argv.slice(2);
assert.equal(process.platform, "win32");
assert.ok(rootArg && probe && git && [rootArg, probe, git].every(isAbsolute));
const oldController = {
  runId: "run",
  controllerId: "parent",
  leaseId: "parent-lease",
  fencingToken: 1,
};

function command(exe: string, args: string[]) {
  const result = spawnSync(exe, args, {
    cwd: source,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function waitFor(check: () => Promise<boolean>, description: string, timeout = 20_000) {
  const end = performance.now() + timeout;
  while (!(await check())) {
    if (performance.now() >= end) throw new Error(`Deadline: ${description}`);
    await delay(10);
  }
}
async function signal(root: string, id: string, phase: string, value: string) {
  const path = join(root, `${id}.${phase}`);
  await writeFile(path + ".tmp", value, { flag: "wx" });
  await rename(path + ".tmp", path);
}
async function assess(root: string) {
  const lifecycle = new SqliteWorkspaceLifecycleStore(join(root, "journal.db"));
  const journal = new SqliteRemovalEvidenceStore(join(root, "journal.db"), { readOnly: true });
  try {
    const selection = JSON.parse(await readFile(join(root, "selection.json"), "utf8"));
    const selected = journal.readSelection("content", selection.intentDigest);
    assert.ok(selected);
    assert.equal(selected.observationDigest, selection.observationDigest);
    const attempt = await lifecycle.getAttempt("fixture-attempt");
    const lease = await lifecycle.getWorkspaceLease("fixture-lease");
    assert.ok(attempt && lease);
    const fresh = removalProbeSnapshot.parse(
      JSON.parse(command(probe, ["--restart-snapshot", root, git]))
    );
    const observationBytes = canonicalJSONStringify(
      probeObservation(selection.intentDigest, fresh)
    );
    const assessment = assessReservedRemovalRecovery({
      intentBytes: selected.intentBytes,
      observationBytes,
      expectedIntentDigest: selection.intentDigest,
      expectedObservationDigest: JSON.parse(observationBytes).observation_digest,
      now: fresh.at,
      maxObservationAgeMs: 0,
      attempt,
      lease,
    });
    assert.equal(assessment.authorizesMutation, false);
    assert.equal(assessment.state, "contents_remaining");
    return {
      assessment,
      attempt,
      lease,
      fresh,
      intentBytes: selected.intentBytes,
      observationBytes,
      selectedObservationDigest: selected.observationDigest,
    };
  } finally {
    await journal.close();
    await lifecycle.close();
  }
}

async function actor(root: string, id: string) {
  assert.ok(["attached", "detached"].includes(launch));
  assert.match(basename(root), /^interrupted-content$/u);
  assert.match(basename(dirname(root)), /^removal-probe-/u);
  assert.match(id, /^[a-zA-Z0-9]{1,32}$/u);
  // No detached service. Pipe closure is NOT evidence of native process exit;
  // the outer driver opens a process-handle watcher before killing this parent.
  const child = spawn(probe, ["--admission-child", root, id], {
    cwd: source,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
    // Explicit experiment variable: exercise a surviving executor as well as
    // the default Windows launch that terminates descendants with their parent.
    detached: launch === "detached",
  });
  let childExited = false;
  let childCode: number | null = null;
  let childError: Error | undefined;
  child.on("error", (error) => {
    childError = error;
    childExited = true;
  });
  child.on("exit", (code) => {
    childCode = code;
    childExited = true;
  });
  const store = new SqliteWorkspaceLifecycleStore(join(root, "journal.db"));
  try {
    await waitFor(
      async () =>
        childExited ||
        (await exists(join(root, `${id}.held.json`))) ||
        (await exists(join(root, `${id}.busy.json`))),
      "child slot response"
    );
    assert.equal(childError, undefined);
    if (!(await exists(join(root, `${id}.held.json`)))) {
      assert.ok(await exists(join(root, `${id}.busy.json`)));
    } else {
      await waitFor(
        () => exists(join(root, `${id}.check`)),
        "driver permits fresh controller check"
      );
      const condition = await readFile(join(root, `${id}.check`), "utf8");
      assert.ok(["current", "expired"].includes(condition));
      const recovery = await assess(root);
      const current = await store.getRunCoordination("run");
      assert.ok(current?.lease);
      const now =
        condition === "expired"
          ? new Date(Date.parse(current.lease.expiresAt) + 1).toISOString()
          : new Date().toISOString();
      const renewal = await store.renewControllerLease({ ...oldController, now, ttlMs: 120_000 });
      console.log(
        JSON.stringify({ request: id, stage: "checked", renewal, assessment: recovery.assessment })
      );
      // This explicit fixture driver authorizes its known disposable effect.
      // Assessment/renewal are not general mutation authority or atomic reservation admission.
      await signal(root, id, "decision", renewal.renewed ? "admit" : "deny");
    }
    await waitFor(async () => childExited, "native child exit");
    assert.equal(childError, undefined);
    assert.equal(childCode, 0);
  } finally {
    await store.close();
    if (!childExited) {
      child.kill();
      await waitFor(async () => childExited, "fixture child cleanup", 5000);
    }
  }
}

type Event = {
  request: string;
  stage: string;
  pid?: number;
  elapsedMs?: number;
  renewal?: { renewed: boolean; reason?: string };
};
function watchNative(pid: number) {
  const watcher = spawn(probe, ["--watch-admission-child", String(pid)], {
    cwd: source,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "",
    error = "",
    closed = false,
    code: number | null = null;
  watcher.stdout.on("data", (chunk) => {
    output = (output + chunk).slice(-1024);
  });
  watcher.stderr.on("data", (chunk) => {
    error = (error + chunk).slice(-2048);
  });
  watcher.on("error", (failure) => {
    error = failure.message;
    closed = true;
  });
  watcher.on("close", (value) => {
    code = value;
    closed = true;
  });
  return {
    async ready() {
      await waitFor(
        async () => closed || output.includes("watching"),
        "native process handle opened"
      );
      assert.equal(closed, false, error);
    },
    assertAlive() {
      assert.equal(closed || output.includes("exited:"), false, "native child exited too soon");
    },
    async finish() {
      await waitFor(async () => closed, "native process handle signaled", 22_000);
      assert.equal(code, 0, error);
      assert.match(output, /exited:-?\d+/u);
      assert.equal(error, "");
      return Number(output.match(/exited:(-?\d+)/u)![1]);
    },
  };
}
function start(root: string, id: string, detached = false) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", script, "actor", root, probe, git, id, detached ? "detached" : "attached"],
    { cwd: source, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
  );
  const events: Event[] = [];
  let observer: ReturnType<typeof watchNative> | undefined;
  let error: Error | undefined;
  let stderr = "",
    bytes = 0,
    exited = false,
    closed = false,
    code: number | null = null;
  child.on("error", (failure) => {
    error = failure;
    exited = closed = true;
  });
  child.on("exit", (value) => {
    exited = true;
    code = value;
  });
  child.on("close", () => {
    closed = true;
  });
  child.stderr.on("data", (value) => {
    stderr = (stderr + value).slice(-8192);
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    bytes += Buffer.byteLength(line);
    if (bytes > 64 * 1024) {
      error = new Error("Oversized actor output");
      child.kill();
      return;
    }
    if (line === "phase-reached:content") return;
    try {
      const event = JSON.parse(line);
      assert.equal(event.request, id);
      events.push(event);
    } catch (failure) {
      error = failure as Error;
    }
  });
  return {
    events,
    child,
    async stage(stage: string) {
      await waitFor(async () => {
        if (error) throw error;
        if (events.some((event) => event.stage === stage)) return true;
        const path = join(root, `${id}.${stage}.json`);
        if (await exists(path)) {
          const event = JSON.parse(await readFile(path, "utf8")) as Event;
          assert.equal(event.request, id);
          assert.equal(event.stage, stage);
          events.push(event);
          return true;
        }
        if (closed && !observer) throw new Error(`Actor closed before ${stage}: ${stderr}`);
        return false;
      }, `${id}: ${stage}`);
      if (stage === "held" && !observer) {
        const pid = events.find((event) => event.stage === "held")?.pid;
        assert.ok(pid);
        observer = watchNative(pid);
        await observer.ready();
      }
    },
    async killParent(expectSurvivor = true) {
      assert.ok(!exited);
      assert.ok(child.pid);
      const parentObserver = watchNative(child.pid);
      await parentObserver.ready();
      const killStarted = performance.now();
      child.kill();
      const parentExit = await parentObserver.finish();
      assert.notEqual(parentExit, 0);
      events.push({
        request: id,
        stage: `parent-handle-signaled-${parentExit}`,
        elapsedMs: performance.now() - killStarted,
      });
      assert.ok(observer);
      if (expectSurvivor) {
        observer.assertAlive();
        events.push({ request: id, stage: "parent-exited-native-handle-still-unsignaled" });
      } else {
        const nativeExit = await observer.finish();
        events.push({ request: id, stage: `parent-exited-native-terminated-${nativeExit}` });
      }
    },
    async finish(killed = false, nativeKilled = false) {
      await waitFor(async () => closed, "coordinator output closure");
      if (observer) {
        const nativeExit = await observer.finish();
        if (!nativeKilled) assert.equal(nativeExit, 0);
      }
      if (error) throw error;
      if (!killed) assert.equal(code, 0, stderr);
      assert.equal(stderr, "");
    },
    async cleanup() {
      // No observer is needed for a normally exited parent: it awaited its own
      // child's exit. Abnormal unobserved termination leaves the fixture retained.
      if (exited && code === 0) return;
      if (!exited) child.kill();
      assert.ok(observer, "No process watcher: retain fixture rather than assume quiescence");
      await observer.finish();
    },
  };
}
async function replace(root: string) {
  const store = new SqliteWorkspaceLifecycleStore(join(root, "journal.db"));
  try {
    const current = await store.getRunCoordination("run");
    assert.ok(current?.lease);
    const result = await store.acquireControllerLease({
      runId: "run",
      controllerId: "replacement",
      leaseId: "replacement-lease",
      now: new Date(Date.parse(current.lease.expiresAt) + 1).toISOString(),
      ttlMs: 120_000,
      initialState: {},
    });
    assert.ok(result.acquired);
    assert.equal(result.lease.fencingToken, 2);
    return result;
  } finally {
    await store.close();
  }
}
async function run() {
  const results = [];
  const conditions = [
    "current",
    "before",
    "expired",
    "after",
    "parent-exit-attached",
    "parent-exit",
    "cancel",
    "deadline",
  ];
  if (request) assert.ok(conditions.includes(request));
  for (const condition of request ? [request] : conditions) {
    const container = await mkdtemp(join(resolve(rootArg), "removal-probe-"));
    const root = join(container, "interrupted-content");
    const actors: ReturnType<typeof start>[] = [];
    const started = performance.now();
    try {
      command(process.execPath, [
        "--import",
        "tsx",
        join(source, "scripts/qualify-removal-parent-restart.ts"),
        "prepare",
        root,
        probe,
        git,
        "content",
      ]);
      await writeFile(join(root, "effect-owner.lock"), "stable fixture slot", { flag: "wx" });
      const initial = await assess(root);
      const primary = start(root, "primary", condition === "parent-exit");
      actors.push(primary);
      await primary.stage("held");
      let replacement;
      if (condition === "before") replacement = await replace(root);
      await signal(root, "primary", "check", condition === "expired" ? "expired" : "current");
      const rejected = ["before", "expired"].includes(condition);
      if (rejected) {
        await primary.stage("cancelled");
        assert.equal(
          primary.events.find((e) => e.stage === "checked")?.renewal?.reason,
          condition === "before" ? "stale_fence" : "lease_expired"
        );
        assert.ok(!primary.events.some((e) => e.stage === "admitted"));
      } else {
        await primary.stage("admitted");
        if (condition === "parent-exit-attached") {
          await primary.killParent(false);
          assert.equal(await exists(join(root, "primary.effect-completed.json")), false);
          assert.equal(await exists(join(root, "primary.deadline-before-effect.json")), false);
        } else {
          if (["after", "parent-exit"].includes(condition)) {
            if (condition === "parent-exit") await primary.killParent();
            replacement = await replace(root);
            const contender = start(root, "contender");
            actors.push(contender);
            await contender.stage("busy");
            await contender.finish();
            assert.ok(
              !contender.events.some((e) => e.stage === "checked" || e.stage === "admitted")
            );
            assert.equal(await readFile(join(root, "worker/first.txt"), "utf8"), "first");
          }
          if (condition !== "deadline")
            await signal(root, "primary", "finish", condition === "cancel" ? "cancel" : "mutate");
          await primary.stage(
            condition === "deadline"
              ? "deadline-before-effect"
              : condition === "cancel"
                ? "cancelled"
                : "effect-completed"
          );
        }
      }
      await primary.finish(
        condition.startsWith("parent-exit"),
        condition === "parent-exit-attached"
      );
      if (replacement) {
        const stale = start(root, "stale");
        actors.push(stale);
        await stale.stage("held");
        await signal(root, "stale", "check", "current");
        await stale.stage("cancelled");
        await stale.finish();
        assert.equal(
          stale.events.find((e) => e.stage === "checked")?.renewal?.reason,
          "stale_fence"
        );
      }
      const effected =
        !rejected && !["cancel", "deadline", "parent-exit-attached"].includes(condition);
      assert.equal(await exists(join(root, "worker/first.txt")), !effected);
      assert.equal(await readFile(join(root, "worker/second.txt"), "utf8"), "second");
      assert.equal(await readFile(join(root, "other/first.txt"), "utf8"), "first");
      assert.equal(await readFile(join(root, "other/second.txt"), "utf8"), "second");
      const recovery = await assess(root);
      assert.deepEqual(recovery.attempt, initial.attempt);
      assert.deepEqual(recovery.lease, initial.lease);
      assert.equal(recovery.selectedObservationDigest, initial.selectedObservationDigest);
      results.push({
        condition,
        durationMs: performance.now() - started,
        effectObserved: effected,
        replacement,
        events: actors.map((actor) => actor.events),
        recovery,
        reservationRetained: true,
        selectionAdvanced: false,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          condition,
          root,
          durationMs: performance.now() - started,
          events: actors.map((actor) => actor.events),
        })
      );
      throw error;
    } finally {
      await Promise.all(actors.map((actor) => actor.cleanup()));
      assert.equal(dirname(container), resolve(rootArg));
      assert.match(basename(container), /^removal-probe-/u);
      await rm(container, { recursive: true, force: true, maxRetries: 3 });
    }
  }
  console.log(
    JSON.stringify({
      fixtureOnly: true,
      results,
      limits: [
        "Cooperative child-owned file exclusion and explicit fixture authorization; not authenticated helper admission.",
        "All simulated entry paths use one stable slot. Product broker and helper protocol remain unchanged.",
        "Real controller renewal, reservation assessment and native effect are separate; no atomic admission record or replay contract.",
        "Replacement/expiry use an advanced logical clock. Barrier ordering is real; no wall-time race-frequency claim.",
        "Parent exit occurs with native child alive before a known-file partial effect, not during a kernel call.",
        "Surviving-child case explicitly uses detached launch; default attached launch is a separate observed termination control.",
        "Cancel is at the pre-effect safe point; mid-effect deadlines, power loss and production activation remain unqualified.",
      ],
    })
  );
}
if (mode === "actor") await actor(rootArg, request);
else {
  assert.equal(mode, "run");
  await run();
}
