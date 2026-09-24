import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, rm, access } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, basename } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { SqliteWorkspaceLifecycleStore } from "../src/store/sqlite/workspace-lifecycle-store.js";
import { SqliteRemovalEvidenceStore } from "../src/store/sqlite/removal-evidence-store.js";
import {
  assessReservedRemovalRecovery,
  parseRemovalIntentBytes,
} from "../src/workspaces/workspace-removal-evidence.js";
import { canonicalJSONStringify } from "../src/util/canonicalJson.js";
import {
  probeIntent,
  probeObservation,
  probePreservationDigest,
  removalProbeSnapshot,
} from "./removal-probe-records.js";

// Disposable native qualification only. A successful assessment never dispatches removal.
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packetHash = `sha256:${"a".repeat(64)}`;
const controller = {
  runId: "run",
  controllerId: "parent",
  leaseId: "parent-lease",
  fencingToken: 1,
};
function command(exe: string, args: string[], cwd: string, expected = 0) {
  const result = spawnSync(exe, args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 128 * 1024,
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, expected, result.stderr);
  return result.stdout.trim();
}
function validateRoot(root: string) {
  assert.ok(isAbsolute(root));
  assert.match(basename(root), /^interrupted-(content|gitfile|root)$/u);
  assert.match(basename(dirname(root)), /^removal-probe-/u);
}
async function snapshot(root: string, probe: string, git: string) {
  return removalProbeSnapshot.parse(
    JSON.parse(command(probe, ["--restart-snapshot", root, git], sourceRoot))
  );
}

async function parent(root: string, phase: string, probe: string, git: string) {
  validateRoot(root);
  const repo = join(root, "repo"),
    target = join(root, "worker");
  await mkdir(repo, { recursive: true });
  const runGit = (...args: string[]) => command(git, args, repo);
  runGit("init", "--quiet");
  runGit("config", "gc.auto", "0");
  await writeFile(join(repo, "first.txt"), "first");
  await writeFile(join(repo, "second.txt"), "second");
  runGit("add", "first.txt", "second.txt");
  runGit(
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture"
  );
  const baseSha = runGit("rev-parse", "HEAD");
  runGit("worktree", "add", "-b", "fixture/task", target, "HEAD");
  runGit("worktree", "add", "--detach", join(root, "other"), "HEAD");
  const gitfile = await readFile(join(target, ".git"), "utf8");
  await writeFile(join(root, "intent.json"), JSON.stringify({ gitfile }));
  const initial = await snapshot(root, probe, git);
  assert.ok(initial.root);
  await writeFile(join(root, "intent.json"), JSON.stringify({ ...initial.root, gitfile }));

  const database = join(root, "journal.db");
  const lifecycle = new SqliteWorkspaceLifecycleStore(database);
  const acquired = await lifecycle.acquireControllerLease({
    ...controller,
    now: initial.at,
    ttlMs: 120_000,
    initialState: {},
  });
  assert.ok(acquired.acquired);
  assert.equal(acquired.lease.fencingToken, controller.fencingToken);
  const common = { runId: "run", controller, expectedRunRevision: 0, now: initial.at };
  assert.ok(
    (
      await lifecycle.createAttempt({
        ...common,
        mutationId: "create",
        attemptId: "fixture-attempt",
        workItemId: "work",
        workItemRevision: 1,
        packetId: "packet",
        packetHash,
        baseSha,
      })
    ).updated
  );
  assert.ok(
    (
      await lifecycle.acquireWorkspace({
        ...common,
        mutationId: "reserve",
        attemptId: "fixture-attempt",
        workspaceLeaseId: "fixture-lease",
        expectedAttemptRevision: 0,
        workItemId: "work",
        repositoryId: "fixture",
        hostId: "native-fixture",
        gitRuntime: "native",
        projectRoot: repo,
        branch: "fixture/task",
        worktreePath: target,
        baseSha,
        ttlMs: 60_000,
      })
    ).updated
  );
  const journal = new SqliteRemovalEvidenceStore(database);
  const intent = probeIntent(phase, initial, probePreservationDigest(initial));
  const observation = probeObservation(intent.intent_digest, initial);
  assert.ok(journal.appendIntent(canonicalJSONStringify(intent)).recorded);
  assert.ok(journal.appendObservation(canonicalJSONStringify(observation)).recorded);
  assert.ok(
    journal.selectObservation(phase, intent.intent_digest, observation.observation_digest, null)
  );
  await writeFile(
    join(root, "selection.json"),
    JSON.stringify({
      intentDigest: intent.intent_digest,
      observationDigest: observation.observation_digest,
    })
  );
  const readback = new SqliteRemovalEvidenceStore(database, { readOnly: true });
  assert.equal(
    readback.readSelection(phase, intent.intent_digest)?.observationDigest,
    observation.observation_digest
  );
  await readback.close();
  command(probe, ["--mutate-once", root, phase], sourceRoot);
  // The native call completed and closed its handles. Abrupt coordinator exit leaves
  // both live SQLite connections unclosed and the selected pre-effect observation intact.
  process.exit(73);
}

async function recover(root: string, phase: string, probe: string, git: string, mode: string) {
  validateRoot(root);
  assert.ok(["current", "expired", "replaced"].includes(mode));
  const supplied = JSON.parse(await readFile(join(root, "selection.json"), "utf8"));
  const database = join(root, "journal.db");
  const lifecycle = new SqliteWorkspaceLifecycleStore(database);
  const journal = new SqliteRemovalEvidenceStore(database, { readOnly: true });
  try {
    const selected = journal.readSelection(phase, supplied.intentDigest);
    assert.ok(selected);
    assert.equal(selected.observationDigest, supplied.observationDigest);
    const intent = parseRemovalIntentBytes(selected.intentBytes);
    const attempt = await lifecycle.getAttempt("fixture-attempt");
    const lease = await lifecycle.getWorkspaceLease("fixture-lease");
    assert.ok(attempt && lease);
    assert.equal(lease.status, "reserved");
    const events = await lifecycle.listWorkspaceLifecycleEvents("run");
    const fresh = await snapshot(root, probe, git);
    const freshObservation = probeObservation(intent.intent_digest, fresh);
    const assessment = assessReservedRemovalRecovery({
      intentBytes: selected.intentBytes,
      observationBytes: canonicalJSONStringify(freshObservation),
      expectedIntentDigest: supplied.intentDigest,
      expectedObservationDigest: freshObservation.observation_digest,
      now: fresh.at,
      maxObservationAgeMs: 0,
      attempt,
      lease,
    });
    assert.equal(
      assessment.state,
      phase === "root" ? "registration_remaining" : "contents_remaining"
    );
    assert.equal(assessment.authorizesMutation, false);
    const coordination = await lifecycle.getRunCoordination("run");
    assert.ok(coordination?.lease);
    const fenceTime =
      mode === "current"
        ? fresh.at
        : new Date(Date.parse(coordination.lease.expiresAt) + 1).toISOString();
    if (mode === "replaced") {
      const replacement = await lifecycle.acquireControllerLease({
        runId: "run",
        controllerId: "replacement",
        leaseId: "replacement-lease",
        now: fenceTime,
        ttlMs: 120_000,
        initialState: {},
      });
      assert.ok(replacement.acquired);
      assert.ok(replacement.lease.fencingToken > controller.fencingToken);
    }
    const fence = await lifecycle.renewControllerLease({
      ...controller,
      now: fenceTime,
      ttlMs: 120_000,
    });
    if (mode === "current") assert.ok(fence.renewed);
    else {
      assert.ok(!fence.renewed);
      assert.equal(fence.reason, mode === "expired" ? "lease_expired" : "stale_fence");
      const denied = await lifecycle.compareAndSetRunState({
        ...controller,
        expectedRevision: 0,
        mutationId: `denied-${mode}`,
        now: fenceTime,
        state: { shouldNotCommit: true },
        event: { type: "fixture-stale-parent", payload: {} },
      });
      assert.ok(!denied.updated);
      assert.equal(denied.reason, fence.reason);
    }
    assert.deepEqual(await lifecycle.getWorkspaceLease(lease.leaseId), lease);
    assert.deepEqual(await lifecycle.getAttempt(attempt.attemptId), attempt);
    assert.deepEqual(await lifecycle.listWorkspaceLifecycleEvents("run"), events);
    assert.equal(
      journal.readSelection(phase, supplied.intentDigest)?.observationDigest,
      selected.observationDigest
    );
    assert.equal(await readFile(join(root, "other", "first.txt"), "utf8"), "first");
    assert.equal(await readFile(join(root, "other", "second.txt"), "utf8"), "second");
    if (phase !== "root") {
      assert.equal(await readFile(join(root, "worker", "second.txt"), "utf8"), "second");
      await assert.rejects(
        access(join(root, "worker", phase === "content" ? "first.txt" : ".git")),
        { code: "ENOENT" }
      );
      if (phase === "gitfile")
        assert.equal(await readFile(join(root, "worker", "first.txt"), "utf8"), "first");
      else await access(join(root, "worker", ".git"));
    } else await assert.rejects(access(join(root, "worker")), { code: "ENOENT" });
    assert.equal(await readFile(join(root, "child-finally.txt"), "utf8"), "managed cleanup ran");
    return {
      phase,
      mode,
      filesystem: JSON.parse(await readFile(join(root, "intent.json"), "utf8")).filesystem,
      selectedObservationDigest: selected.observationDigest,
      freshObservationDigest: freshObservation.observation_digest,
      intentBytes: selected.intentBytes,
      selectedObservationBytes: selected.observationBytes,
      freshObservationBytes: canonicalJSONStringify(freshObservation),
      attempt,
      lease,
      assessment,
      fence,
      reservationStatus: lease.status,
      lifecycleEventsUnchanged: true,
      nativeMutationDispatched: false,
      selectionAdvanced: false,
    };
  } finally {
    await journal.close();
    await lifecycle.close();
  }
}
async function main() {
  if (process.platform !== "win32") throw new Error("Native Windows qualification required");
  const [mode, parentPath, probe, git, phase, condition] = process.argv.slice(2);
  if (!parentPath || !probe || !git || !isAbsolute(probe) || !isAbsolute(git))
    throw new Error("Supply mode, root, absolute probe and Git");
  if (mode === "parent") return parent(parentPath, phase, probe, git);
  if (mode === "recover") {
    console.log(JSON.stringify(await recover(parentPath, phase, probe, git, condition)));
    return;
  }
  if (mode !== "run") throw new Error("Expected run, parent or recover");
  const parentRoot = resolve(parentPath);
  const root = await mkdtemp(join(parentRoot, "removal-probe-"));
  const results = [];
  const script = fileURLToPath(import.meta.url);
  try {
    for (const phase of ["content", "gitfile", "root"]) {
      const fixture = join(root, `interrupted-${phase}`);
      command(
        process.execPath,
        ["--import", "tsx", script, "parent", fixture, probe, git, phase],
        sourceRoot,
        73
      );
      for (const condition of ["current", "expired", "replaced"]) {
        results.push(
          JSON.parse(
            command(
              process.execPath,
              ["--import", "tsx", script, "recover", fixture, probe, git, phase, condition],
              sourceRoot
            )
          )
        );
      }
    }
    console.log(
      JSON.stringify({
        fixtureOnly: true,
        parentExit: 73,
        results,
        limits: [
          "Native child completed before abrupt parent exit; no interrupted native call or power-loss claim.",
          "Expired/replacement fence cases use an explicit advanced fixture clock, not elapsed wall time.",
          "Fresh observations are assessed without advancing selection or releasing reservations.",
          "Controller renewal and native observation are separate operations, not atomic deletion authority.",
          "No resumed native deletion, authenticated provisioning or production activation.",
        ],
      })
    );
  } finally {
    assert.equal(dirname(root), parentRoot);
    assert.match(basename(root), /^removal-probe-/u);
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
