import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rename, rm, access, open } from "node:fs/promises";
import { dirname, basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { SqliteWorkspaceLifecycleStore } from "../src/store/sqlite/workspace-lifecycle-store.js";
import { SqliteRemovalEvidenceStore } from "../src/store/sqlite/removal-evidence-store.js";
import { SqliteRemovalOperationStore } from "../src/store/sqlite/removal-operation-store.js";
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
  const store = new SqliteRemovalOperationStore(join(root, "journal.db"));
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
      assert.ok(["current", "expired", "recover", "commit-loss"].includes(condition));
      const recovery = await assess(root);
      const current = await store.getRunCoordination("run");
      assert.ok(current?.lease);
      const now =
        condition === "expired"
          ? new Date(Date.parse(current.lease.expiresAt) + 1).toISOString()
          : new Date(
              condition === "recover"
                ? Math.max(
                    Date.now(),
                    Date.parse(current.updatedAt),
                    Date.parse(current.lease.renewedAt)
                  )
                : Date.now()
            ).toISOString();
      const intentDigest = JSON.parse(recovery.intentBytes!).intent_digest;
      let operation;
      if (condition === "recover") {
        const admitted = store.readOperation("content");
        assert.ok(admitted);
        assert.ok(store.appendObservation(recovery.observationBytes).recorded);
        const active = current.lease;
        operation = store.resolveRemoval({
          operationId: "content",
          admissionDigest: admitted.admission.admissionDigest,
          observationDigest: JSON.parse(recovery.observationBytes).observation_digest,
          controller: {
            runId: active.runId,
            controllerId: active.controllerId,
            leaseId: active.leaseId,
            fencingToken: active.fencingToken,
          },
          expectedRunRevision: current.revision,
          now,
          maxObservationAgeMs: 180_000,
        });
      } else {
        operation = store.admitRemoval({
          operationId: "content",
          intentDigest,
          observationDigest: recovery.selectedObservationDigest,
          expectedRunRevision: current.revision,
          expectedAttemptRevision: recovery.attempt.revision,
          controller: oldController,
          executorId: `native-${child.pid}`,
          now,
          maxObservationAgeMs: 30_000,
        });
      }
      console.log(
        JSON.stringify({
          request: id,
          stage: "checked",
          operation,
          assessment: recovery.assessment,
        })
      );
      if (condition === "commit-loss") {
        assert.equal(operation.kind, "admitted");
        console.log(JSON.stringify({ request: id, stage: "commit-recorded" }));
        await waitFor(
          () => exists(join(root, `${id}.dispatch`)),
          "dispatch barrier after admission commit"
        );
      }
      // Only a newly committed admission reaches this fixture's native effect.
      // Replay/recovery never dispatch; physical custody remains a separate port.
      await signal(root, id, "decision", operation.kind === "admitted" ? "admit" : "deny");
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
  operation?: { kind: string; reason?: string };
};
const terminalStages = [
  "busy",
  "cancelled",
  "effect-completed",
  "deadline-before-admission",
  "deadline-before-effect",
];
async function nativeMarkers(root: string, id: string) {
  const markers: Event[] = [];
  for (const stage of ["held", "admitted", ...terminalStages]) {
    const path = join(root, `${id}.${stage}.json`);
    if (!(await exists(path))) continue;
    const file = await open(path, "r");
    try {
      const buffer = Buffer.alloc(4097);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      assert.ok(bytesRead <= 4096, "Oversized native marker");
      const event = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as Event;
      assert.equal(event.request, id);
      assert.equal(event.stage, stage);
      markers.push(event);
    } finally {
      await file.close();
    }
  }
  return markers;
}
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
    snapshot() {
      return { pid, closed, code, output, error };
    },
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
    async diagnostics() {
      let markers: Event[] = [];
      let markerError: string | undefined;
      try {
        markers = await nativeMarkers(root, id);
      } catch (failure) {
        markerError = String(failure);
      }
      return {
        id,
        events,
        markers,
        markerError,
        coordinator: {
          pid: child.pid,
          exited,
          closed,
          code,
          stderr,
          error: error?.message,
        },
        watcher: observer?.snapshot(),
      };
    },
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
        if (["held", "admitted", ...terminalStages].includes(stage)) {
          const terminal = (await nativeMarkers(root, id)).find((event) =>
            terminalStages.includes(event.stage)
          );
          if (terminal)
            throw new Error(`Native ${id} ended with ${terminal.stage} before ${stage}`);
        }
        if (closed && observer?.snapshot().closed)
          throw new Error(`Actor and native watcher closed before ${stage}: ${stderr}`);
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
      if (exited && code === 0) {
        await waitFor(async () => closed, "normal coordinator cleanup closure", 5000);
        return;
      }
      if (!exited) child.kill();
      assert.ok(observer, "No process watcher: retain fixture rather than assume quiescence");
      await observer.finish();
      await waitFor(async () => exited && closed, "coordinator cleanup closure", 5000);
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
    "commit-loss",
    "admission-deadline",
  ];
  if (request) assert.ok(conditions.includes(request));
  if (launch) assert.ok(launch === "diagnostic-failure" && request === "admission-deadline");
  for (const condition of request ? [request] : conditions) {
    const container = await mkdtemp(join(resolve(rootArg), "removal-probe-"));
    const root = join(container, "interrupted-content");
    const actors: ReturnType<typeof start>[] = [];
    const started = performance.now();
    let failed = false;
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
      if (["before", "admission-deadline"].includes(condition)) replacement = await replace(root);
      // Reproduce a delayed controller check without guessing a sleep duration.
      // The stale check is delivered only after the native deadline marker exists.
      if (condition === "admission-deadline") await primary.stage("deadline-before-admission");
      await signal(
        root,
        "primary",
        "check",
        condition === "expired"
          ? "expired"
          : condition === "commit-loss"
            ? "commit-loss"
            : "current"
      );
      const rejected = ["before", "expired", "admission-deadline"].includes(condition);
      if (rejected) {
        await primary.stage(condition === "admission-deadline" ? "checked" : "cancelled");
        assert.equal(
          primary.events.find((e) => e.stage === "checked")?.operation?.reason,
          condition === "expired" ? "lease_expired" : "stale_fence"
        );
        assert.ok(!primary.events.some((e) => e.stage === "admitted"));
        if (condition === "admission-deadline") {
          // Explicit negative qualification: exercise the actual retained-failure path.
          if (launch === "diagnostic-failure") await primary.stage("cancelled");
          await assert.rejects(
            primary.stage("cancelled"),
            /deadline-before-admission before cancelled/u
          );
          const diagnostics = await primary.diagnostics();
          assert.ok(diagnostics.markers.some((e) => e.stage === "deadline-before-admission"));
          const rejectedStore = new SqliteRemovalOperationStore(join(root, "journal.db"), {
            readOnly: true,
          });
          try {
            assert.equal(rejectedStore.readOperation("content"), undefined);
          } finally {
            await rejectedStore.close();
          }
        }
      } else if (condition === "commit-loss") {
        await primary.stage("commit-recorded");
        await primary.killParent(false);
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
        condition.startsWith("parent-exit") || condition === "commit-loss",
        condition === "parent-exit-attached" || condition === "commit-loss"
      );
      if (replacement) {
        const stale = start(root, "stale");
        actors.push(stale);
        await stale.stage("held");
        await signal(root, "stale", "check", "current");
        await stale.stage("cancelled");
        await stale.finish();
        const response = stale.events.find((e) => e.stage === "checked")?.operation;
        if (rejected) assert.equal(response?.reason, "stale_fence");
        else assert.equal(response?.kind, "replay");
      }
      const effected =
        !rejected &&
        !["cancel", "deadline", "parent-exit-attached", "commit-loss"].includes(condition);
      assert.equal(await exists(join(root, "worker/first.txt")), !effected);
      assert.equal(await readFile(join(root, "worker/second.txt"), "utf8"), "second");
      assert.equal(await readFile(join(root, "other/first.txt"), "utf8"), "first");
      assert.equal(await readFile(join(root, "other/second.txt"), "utf8"), "second");
      let operation;
      if (!rejected) {
        const recoverer = start(root, "recoverer");
        actors.push(recoverer);
        await recoverer.stage("held");
        await signal(root, "recoverer", "check", "recover");
        await recoverer.stage("cancelled");
        await recoverer.finish();
        assert.equal(
          recoverer.events.find((e) => e.stage === "checked")?.operation?.kind,
          "resolved"
        );
        const reopened = new SqliteRemovalOperationStore(join(root, "journal.db"), {
          readOnly: true,
        });
        try {
          operation = reopened.readOperation("content");
          assert.ok(operation?.resolution);
          assert.equal(operation.admission.controller.fencingToken, 1);
          assert.equal(operation.resolution.controller.fencingToken, replacement ? 2 : 1);
          assert.equal(operation.resolution.observedState, "contents_remaining");
        } finally {
          await reopened.close();
        }
        const replay = start(root, "replay");
        actors.push(replay);
        await replay.stage("held");
        await signal(root, "replay", "check", "current");
        await replay.stage("cancelled");
        await replay.finish();
        assert.equal(replay.events.find((e) => e.stage === "checked")?.operation?.kind, "replay");
        assert.equal(await exists(join(root, "worker/first.txt")), !effected);
      }
      const recovery = await assess(root);
      assert.deepEqual(recovery.attempt, initial.attempt);
      assert.deepEqual(recovery.lease, initial.lease);
      assert.equal(recovery.selectedObservationDigest, initial.selectedObservationDigest);
      results.push({
        condition,
        durationMs: performance.now() - started,
        effectObserved: effected,
        replacement,
        operation,
        events: actors.map((actor) => actor.events),
        diagnostics: await Promise.all(actors.map((actor) => actor.diagnostics())),
        recovery,
        reservationRetained: true,
        selectionAdvanced: false,
      });
    } catch (error) {
      failed = true;
      console.error(
        JSON.stringify({
          condition,
          root,
          durationMs: performance.now() - started,
          events: actors.map((actor) => actor.events),
          error: String(error),
          diagnostics: await Promise.all(actors.map((actor) => actor.diagnostics())),
          retained: true,
        })
      );
      throw error;
    } finally {
      const cleanup = await Promise.allSettled(actors.map((actor) => actor.cleanup()));
      const quiescent = cleanup.every((result) => result.status === "fulfilled");
      if (failed || !quiescent) {
        const failure = {
          root,
          condition,
          quiescent,
          cleanup: cleanup.map((result) =>
            result.status === "fulfilled"
              ? { status: result.status }
              : { status: result.status, reason: String(result.reason) }
          ),
          diagnostics: await Promise.all(actors.map((actor) => actor.diagnostics())),
        };
        await writeFile(join(container, "failure.json"), JSON.stringify(failure, null, 2));
        console.error(JSON.stringify({ retainedFailure: container, ...failure }));
      }
      assert.ok(quiescent, "Cleanup could not establish quiescence; fixture retained");
      assert.equal(dirname(container), resolve(rootArg));
      assert.match(basename(container), /^removal-probe-/u);
      if (!failed) await rm(container, { recursive: true, force: true, maxRetries: 3 });
    }
  }
  console.log(
    JSON.stringify({
      fixtureOnly: true,
      results,
      limits: [
        "Cooperative child-owned file exclusion and explicit fixture authorization; not authenticated helper admission.",
        "All simulated entry paths use one stable slot. Product broker and helper protocol remain unchanged.",
        "SQLite admission is atomic over current controller, reservation and selected evidence; filesystem effects remain a separate cooperative executor contract.",
        "Current-controller recovery records an observation without releasing the reservation or advancing selection; it does not transfer ownership for new deletion.",
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
