import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile, rmdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteWorkspaceLifecycleStore } from "../../src/store/sqlite/workspace-lifecycle-store.js";
import { SqliteWindowsRemovalStore } from "../../src/store/sqlite/windows-removal-store.js";
import { acquireOwnedWindowsRootSession } from "../../src/workspaces/owned-windows-root-session.js";
import {
  executeOwnedWindowsRemoval,
  recoverOwnedWindowsRemoval,
} from "../../src/workspaces/owned-windows-removal.js";
import { windowsRemovalSlot } from "../../src/workspaces/windows-removal-binding.js";
import { WindowsRemovalIdentity } from "../../src/workspaces/windows-removal-protocol.js";
import { createOwnedWindowsRemovalTransition } from "../../src/workspaces/owned-windows-removal-transition.js";
import { acquireOwnedWindowsWorkspaceLease } from "../../src/workspaces/owned-windows-workspace-lease.js";
import type { OwnedWindowsWorkspaceLease } from "../../src/workspaces/owned-windows-workspace-lease.js";
import { NodeGitWorktreeBroker } from "../../src/workspaces/node-git-worktree-broker.js";
import { createWorkspaceBoundaryCapabilityDecision } from "../../src/workspaces/workspace-boundary.js";
import { resolveWorkspaceBoundary } from "../../src/workspaces/workspace-boundary-resolver.js";

vi.mock("../../src/workspaces/workspace-boundary-resolver.js", async (original) => {
  const actual =
    await original<typeof import("../../src/workspaces/workspace-boundary-resolver.js")>();
  return { ...actual, resolveWorkspaceBoundary: vi.fn(actual.resolveWorkspaceBoundary) };
});

const executable = process.env.LEXRUNNER_TEST_NATIVE_HELPER;
const faultExecutable = process.env.LEXRUNNER_TEST_REMOVAL_FAULT_HELPER;
const gitExecutable = process.env.LEXRUNNER_TEST_GIT_EXE;
const artifactParent = process.env.LEXRUNNER_TEST_REMOVAL_ROOT ?? tmpdir();
const hash = `sha256:${"a".repeat(64)}`;
const controller = {
  runId: "run",
  controllerId: "controller",
  leaseId: "controller-lease",
  fencingToken: 1,
};
type Roots = Extract<Awaited<ReturnType<typeof acquireOwnedWindowsRootSession>>, { ok: true }>;

describe.skipIf(process.platform !== "win32" || !executable || !gitExecutable)(
  "real Windows removal executor and journal recovery",
  () => {
    const roots: Roots[] = [];
    const stores: { close(): Promise<void> }[] = [];
    const fixtureRoots: string[] = [];
    const transitions: ReturnType<typeof createOwnedWindowsRemovalTransition>[] = [];
    const portableLeases: OwnedWindowsWorkspaceLease[] = [];
    function git(cwd: string, args: string[]) {
      const result = spawnSync(gitExecutable!, ["-c", "commit.gpgsign=false", ...args], {
        cwd,
        windowsHide: true,
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 65536,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "NUL",
          GIT_TERMINAL_PROMPT: "0",
        },
      });
      if (result.status !== 0)
        throw new Error(`Fixture Git failed (${result.status}): ${result.stderr}`);
      return result.stdout.trim();
    }
    async function setup(selectedExecutable = executable!, fixtureAutocrlf = false) {
      await mkdir(artifactParent, { recursive: true });
      const fixtureRoot = await mkdtemp(path.join(artifactParent, "native-removal-"));
      fixtureRoots.push(fixtureRoot);
      const root = fixtureRoot,
        repository = path.join(root, "repository"),
        allocation = path.join(root, "allocation"),
        slots = path.join(root, "slots");
      const options = {
        executable: selectedExecutable,
        cwd: path.dirname(selectedExecutable),
        architecture: "x64" as const,
        expectedArtifactSha256: `sha256:${createHash("sha256").update(readFileSync(selectedExecutable)).digest("hex")}`,
      };
      // Only discovery is injected. Real scopes, processes, Git, SQLite and deletion
      // run unchanged. The fixture decision explicitly remains unavailable/unverified.
      const capability = createWorkspaceBoundaryCapabilityDecision({
        schema_version: "1.0.0",
        decision_id: "native-removal-fixture",
        selection: { mode: "native" },
        backend_kind: "windows-native",
        state: "unavailable",
        reason_code: "helper_signature_unverified",
        host: { platform: "windows", architecture: "x64", path_comparison: "case-insensitive" },
        backend: {
          transport: "native_helper",
          implementation: "windows-removal-fixture",
          implementation_version: "1.0.0",
          protocol_version: "2.0.0",
          signature: { status: "development_unverified" },
        },
        claims: {
          held_directory_identity: true,
          no_follow_open: true,
          final_path_from_handle: true,
          held_ancestor_chain: true,
          replacement_resistant_process_binding: true,
          rename_delete_exclusion: true,
          durable_directory_mutation: false,
        },
        observed_at: new Date().toISOString(),
      });
      vi.mocked(resolveWorkspaceBoundary).mockReturnValue({
        ok: true,
        boundary: {
          capability,
          async acquire(request) {
            const acquired = await acquireOwnedWindowsWorkspaceLease(
              options,
              request,
              capability.decision_digest,
              { workTimeoutMs: 120000 }
            );
            if (!acquired.ok) throw new Error("Fixture native lease acquisition failed");
            portableLeases.push(acquired.lease);
            return { ok: true, lease: acquired.lease };
          },
        },
      });
      await Promise.all([mkdir(repository), mkdir(allocation), mkdir(slots)]);
      git(repository, ["init", "-b", "main"]);
      await mkdir(path.join(repository, "nested"));
      await writeFile(path.join(repository, "nested", "tracked.txt"), "tracked content\n");
      await writeFile(path.join(repository, "nested", "café-bird.txt"), "another selected file\n");
      git(repository, ["add", "."]);
      git(repository, [
        "-c",
        "user.name=Removal fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "fixture",
      ]);
      const baseSha = git(repository, ["rev-parse", "HEAD"]),
        worktree = path.join(allocation, "worker");
      // Fixture creation is ordinary Git without a racing actor; product
      // native creation remains closed until a protected transition exists.
      git(repository, [
        ...(fixtureAutocrlf ? ["-c", "core.autocrlf=true"] : []),
        "worktree",
        "add",
        "-b",
        "fixture/work",
        worktree,
        baseSha,
      ]);
      const registration = path.join(repository, ".git", "worktrees", "worker");
      const database = path.join(root, "state.db"),
        lifecycle = new SqliteWorkspaceLifecycleStore(database);
      stores.push(lifecycle);
      const now = () => new Date().toISOString();
      expect(
        (
          await lifecycle.acquireControllerLease({
            ...controller,
            now: now(),
            ttlMs: 600000,
            initialState: {},
          })
        ).acquired
      ).toBe(true);
      const common = { controller, runId: "run", expectedRunRevision: 0, now: now() };
      expect(
        (
          await lifecycle.createAttempt({
            ...common,
            mutationId: "create",
            attemptId: "attempt",
            workItemId: "work",
            workItemRevision: 1,
            packetId: "packet",
            packetHash: hash,
            baseSha,
          })
        ).updated
      ).toBe(true);
      expect(
        (
          await lifecycle.acquireWorkspace({
            ...common,
            mutationId: "reserve",
            attemptId: "attempt",
            expectedAttemptRevision: 0,
            workspaceLeaseId: "workspace",
            workItemId: "work",
            repositoryId: "fixture",
            hostId: "host",
            gitRuntime: "native-windows-git",
            projectRoot: repository,
            worktreePath: worktree,
            branch: "fixture/work",
            baseSha,
            ttlMs: 600000,
          })
        ).updated
      ).toBe(true);
      const lease = (await lifecycle.getWorkspaceLease("workspace"))!;
      const brokerOptions = {
        repositoryId: lease.repositoryId,
        hostId: lease.hostId,
        gitRuntime: lease.gitRuntime,
        repositoryRoot: repository,
        worktreeRoot: allocation,
        pathComparison: "case-insensitive" as const,
        gitExecutable: gitExecutable!,
        testOnlyAllowUnboundBoundaryAuthority: true,
      };
      await writeFile(
        path.join(registration, "lexrunner-attempt.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          repositoryId: lease.repositoryId,
          attemptId: lease.attemptId,
          hostId: lease.hostId,
          gitRuntime: lease.gitRuntime,
          projectRoot: lease.projectRoot,
          worktreePath: lease.worktreePath,
          branch: lease.branch,
          baseSha: lease.baseSha,
        })}\n`
      );
      const selectedSlot = windowsRemovalSlot(lease.leaseId);
      const store = new SqliteWindowsRemovalStore(database);
      stores.push(store);
      async function open(signal?: AbortSignal) {
        const acquired = await acquireOwnedWindowsRootSession(
          options,
          { workTimeoutMs: 120000 },
          [
            { role: "root", absolutePath: allocation },
            { role: "registration", absolutePath: path.dirname(registration) },
            { role: "slot", absolutePath: slots },
          ],
          20,
          signal
        );
        if (!acquired.ok)
          throw new Error(`Native root acquisition failed: ${JSON.stringify(acquired)}`);
        roots.push(acquired);
        return acquired;
      }
      const discovery = await open();
      const selected = await discovery.session.run(async () => {
        const rootScope = await discovery.root("root").openChild("worker");
        const registrationScope = await discovery.root("registration").openChild("worker");
        const slot = await discovery
          .root("slot")
          .createFile(selectedSlot.component, selectedSlot.content);
        const strip = (value: typeof rootScope.identity) => {
          const { chain_length: _chain, ...identity } = value;
          return WindowsRemovalIdentity.parse(identity);
        };
        return {
          rootIdentity: strip(rootScope.identity),
          registrationIdentity: strip(registrationScope.identity),
          slotIdentity: {
            path: path.join(slots, selectedSlot.component),
            file_id: slot.fileId,
            volume_serial_number: slot.volumeSerialNumber,
            filesystem: rootScope.identity.filesystem,
          },
        };
      });
      expect(await discovery.session.close()).toMatchObject({
        outcome: "matched",
        cleanup: { processExited: true, disposition: "closed" },
      });
      const parents = (session: Roots) => ({
        root: session.root("root"),
        registration: session.root("registration"),
        slot: session.root("slot"),
      });
      async function execute(session: Roots, maximumDeletes = 4096, credential = controller) {
        return session.session.run(() =>
          executeOwnedWindowsRemoval({
            store,
            lease,
            parents: parents(session),
            ...selected,
            registrationComponent: "worker",
            gitExecutable: gitExecutable!,
            now,
            maximumDeletes,
            admission: {
              operationId: "remove",
              controller: credential,
              expectedRunRevision: 0,
              expectedAttemptRevision: 1,
              now: now(),
              maxObservationAgeMs: 30000,
            },
          })
        );
      }
      async function recover(session: Roots, recoveryStore = store) {
        return session.session.run(() =>
          recoverOwnedWindowsRemoval({
            store: recoveryStore,
            parents: parents(session),
            now,
            resolution: {
              operationId: "remove",
              controller,
              expectedRunRevision: 0,
              now: now(),
              maxObservationAgeMs: 30000,
            },
          })
        );
      }
      return {
        root,
        repository,
        worktree,
        registration,
        slots,
        database,
        lifecycle,
        lease,
        store,
        open,
        execute,
        recover,
        selectedSlot,
        options,
        selected,
        now,
        brokerOptions,
        parents,
      };
    }
    afterEach(async () => {
      let quiescent = true;
      for (const item of roots.splice(0)) {
        const report = await item.session.close();
        if (!report.cleanup.processExited || report.cleanup.disposition !== "closed")
          quiescent = false;
      }
      for (const lease of portableLeases.splice(0)) {
        await lease.close("completed");
        const report = await lease.completion;
        if (!report.cleanup.processExited || report.cleanup.disposition !== "closed")
          quiescent = false;
      }
      for (const store of stores.splice(0).reverse()) await store.close();
      for (const transition of transitions.splice(0)) {
        if (
          transition
            .snapshotOwners()
            .some(
              (report) =>
                report.cleanup.disposition !== "not_started" &&
                (!report.cleanup.processExited || report.cleanup.disposition !== "closed")
            )
        )
          quiescent = false;
      }
      for (const fixtureRoot of fixtureRoots.splice(0))
        if (quiescent) {
          const resolved = path.resolve(fixtureRoot),
            parent = path.resolve(artifactParent);
          if (
            path.dirname(resolved) !== parent ||
            !path.basename(resolved).startsWith("native-removal-")
          )
            throw new Error("Unsafe fixture cleanup");
          await rm(resolved, { recursive: true, force: true });
        }
      vi.mocked(resolveWorkspaceBoundary).mockReset();
      vi.unstubAllEnvs();
      expect(quiescent, "All owned helpers must exit before fixture cleanup").toBe(true);
    });

    it("removes actual selected trees, resolves fresh absence, and never replays against a replacement", async () => {
      const f = await setup(),
        first = await f.open();
      const result = await f.execute(first);
      expect(result).toMatchObject({
        kind: "executed",
        effect: { status: "selected_trees_removed" },
      });
      expect(existsSync(f.worktree)).toBe(false);
      expect(existsSync(f.registration)).toBe(false);
      expect(f.store.readOperation("remove")?.resolution).toBeNull();
      await first.session.close();
      const recovery = await f.open();
      expect(await f.recover(recovery)).toMatchObject({
        kind: "resolved",
        operation: { resolution: { observedState: "absence_observed" } },
      });
      await recovery.session.close();
      await mkdir(f.worktree);
      await writeFile(path.join(f.worktree, "replacement"), "preserved");
      const replay = await f.open();
      expect(await f.execute(replay)).toMatchObject({ kind: "replay" });
      expect(await readFile(path.join(f.worktree, "replacement"), "utf8")).toBe("preserved");
      expect(await f.lifecycle.getWorkspaceLease("workspace")).toEqual(f.lease);
      expect(git(f.repository, ["worktree", "list", "--porcelain"])).not.toContain(
        f.worktree.replace(/\\/gu, "/")
      );
    }, 30000);
    it("records partial contents and preserves the reservation without starting a second effect", async () => {
      const f = await setup(),
        first = await f.open();
      expect(await f.execute(first, 1)).toMatchObject({
        kind: "executed",
        effect: { status: "partial", root_deleted: 1, registration_outcome: "not_started" },
      });
      await first.session.close();
      const recovery = await f.open();
      expect(await f.recover(recovery)).toMatchObject({
        kind: "resolved",
        operation: { resolution: { observedState: "contents_remaining" } },
      });
      expect(await f.lifecycle.getWorkspaceLease("workspace")).toEqual(f.lease);
      expect(existsSync(f.registration)).toBe(true);
      expect(await f.execute(recovery)).toMatchObject({ kind: "replay" });
    }, 30000);
    it("refuses recovery while the recorded native process is still alive", async () => {
      const f = await setup(),
        first = await f.open();
      await f.execute(first);
      const competing = await f.open();
      expect(await f.recover(competing)).toEqual({
        kind: "rejected",
        reason: "executor_not_quiescent",
      });
      expect(f.store.readOperation("remove")?.resolution).toBeNull();
      await competing.session.close();
      await first.session.close();
      expect(await f.recover(await f.open())).toMatchObject({ kind: "resolved" });
    }, 30000);
    it("keeps dirty worktrees intact before admission", async () => {
      const f = await setup();
      await writeFile(path.join(f.worktree, "nested", "tracked.txt"), "dirty content\n");
      await expect(f.execute(await f.open())).rejects.toThrow();
      expect(f.store.readOperation("remove")).toBeNull();
      expect(await readFile(path.join(f.worktree, "nested", "tracked.txt"), "utf8")).toBe(
        "dirty content\n"
      );
      expect(existsSync(f.registration)).toBe(true);
    }, 30000);
    it("rejects a stale controller after preparation without deleting anything", async () => {
      const f = await setup();
      expect(
        await f.execute(await f.open(), 4096, { ...controller, fencingToken: 2 })
      ).toMatchObject({ kind: "rejected" });
      expect(f.store.readOperation("remove")).toBeNull();
      expect(await readFile(path.join(f.worktree, "nested", "tracked.txt"), "utf8")).toBe(
        "tracked content\n"
      );
    }, 30000);
    it("refuses a replacement root during recovery and retains the unresolved record", async () => {
      const f = await setup(),
        first = await f.open();
      await f.execute(first);
      await first.session.close();
      await mkdir(f.worktree);
      await writeFile(path.join(f.worktree, "replacement"), "preserved");
      expect(await f.recover(await f.open())).toMatchObject({ kind: "rejected" });
      expect(f.store.readOperation("remove")?.resolution).toBeNull();
      expect(await readFile(path.join(f.worktree, "replacement"), "utf8")).toBe("preserved");
    }, 30000);
    it("connects real broker observe/dirty-preserve/remove through the prepared native executor", async () => {
      const f = await setup();
      const transition = createOwnedWindowsRemovalTransition({
        helper: f.options,
        store: f.store,
        lease: f.lease,
        ...f.selected,
        gitExecutable: gitExecutable!,
        now: f.now,
        admission: {
          operationId: "remove",
          controller,
          expectedRunRevision: 0,
          expectedAttemptRevision: 1,
          now: f.now(),
          maxObservationAgeMs: 30000,
        },
        resolution: {
          operationId: "remove",
          controller,
          expectedRunRevision: 0,
          now: f.now(),
          maxObservationAgeMs: 30000,
        },
      });
      transitions.push(transition);
      const broker = await NodeGitWorktreeBroker.open({
        ...f.brokerOptions,
        nativeRemoval: transition,
      });
      expect(await broker.observe(f.lease)).toMatchObject({
        ok: true,
        observation: { cleanliness: "clean", exists: true, registered: true },
      });
      const original = await readFile(path.join(f.worktree, "nested", "tracked.txt"));
      await writeFile(path.join(f.worktree, "nested", "tracked.txt"), "dirty content\n");
      expect(await broker.remove(f.lease)).toMatchObject({
        ok: true,
        outcome: "preserved",
        preservationReason: "dirty",
      });
      expect(f.store.readOperation("remove")).toBeNull();
      await writeFile(path.join(f.worktree, "nested", "tracked.txt"), original);
      const removed = await broker.remove(f.lease);
      expect(removed, JSON.stringify(removed)).toMatchObject({
        ok: true,
        outcome: "removed",
        observation: { exists: false, registered: false },
      });
      expect(f.store.readOperation("remove")?.resolution?.observedState).toBe("absence_observed");
      expect(await f.lifecycle.getWorkspaceLease("workspace")).toEqual(f.lease);
    }, 45000);
    it.each(["locked", "index.lock"])(
      "preserves a registration with %s before admission",
      async (name) => {
        const f = await setup();
        await writeFile(path.join(f.registration, name), "held for another operation\n");
        await expect(f.execute(await f.open())).rejects.toThrow();
        expect(f.store.readOperation("remove")).toBeNull();
        expect(existsSync(path.join(f.worktree, "nested", "tracked.txt"))).toBe(true);
      },
      30000
    );
    it("normalizes a globally configured CRLF fixture before native removal", async () => {
      await mkdir(artifactParent, { recursive: true });
      const configurationRoot = await mkdtemp(path.join(artifactParent, "native-removal-config-"));
      fixtureRoots.push(configurationRoot);
      const global = path.join(configurationRoot, "gitconfig");
      await writeFile(global, "[core]\n    autocrlf = true\n");
      vi.stubEnv("GIT_CONFIG_GLOBAL", global);
      const f = await setup(executable!, true);
      const transition = createOwnedWindowsRemovalTransition({
        helper: f.options,
        store: f.store,
        lease: f.lease,
        ...f.selected,
        gitExecutable: gitExecutable!,
        now: f.now,
        admission: {
          operationId: "remove",
          controller,
          expectedRunRevision: 0,
          expectedAttemptRevision: 1,
          now: f.now(),
          maxObservationAgeMs: 30000,
        },
        resolution: {
          operationId: "remove",
          controller,
          expectedRunRevision: 0,
          now: f.now(),
          maxObservationAgeMs: 30000,
        },
      });
      transitions.push(transition);
      const broker = await NodeGitWorktreeBroker.open({
        ...f.brokerOptions,
        nativeRemoval: transition,
      });
      expect(
        (await readFile(path.join(f.worktree, "nested", "tracked.txt"))).includes(
          Buffer.from("\r\n")
        )
      ).toBe(true);
      const removed = await broker.remove(f.lease);
      expect(removed, JSON.stringify(removed)).toMatchObject({ ok: true, outcome: "removed" });
      expect(f.store.readOperation("remove")?.resolution?.observedState).toBe("absence_observed");
    }, 45000);
    it("refuses a replaced stable slot during recovery", async () => {
      const f = await setup(),
        first = await f.open();
      await f.execute(first);
      await first.session.close();
      const slot = path.join(f.slots, f.selectedSlot.component);
      // Keep the original file live at another name to prevent file-ID reuse.
      const { rename } = await import("node:fs/promises");
      await rename(slot, slot + ".original");
      await writeFile(slot, f.selectedSlot.content);
      await expect(f.recover(await f.open())).rejects.toThrow();
      expect(f.store.readOperation("remove")?.resolution).toBeNull();
    }, 30000);
    it("refuses a junction inside the selected tree and preserves its target", async () => {
      const f = await setup(),
        outside = path.join(f.root, "junction-control"),
        link = path.join(f.worktree, "junction");
      await mkdir(outside);
      await writeFile(path.join(outside, "keep"), "preserved");
      await symlink(outside, link, "junction");
      const session = await f.open();
      try {
        await expect(f.execute(session)).rejects.toThrow();
        expect((await session.session.close()).cleanup).toMatchObject({
          disposition: "closed",
          processExited: true,
        });
        expect(f.store.readOperation("remove")).toBeNull();
        expect(await readFile(path.join(outside, "keep"), "utf8")).toBe("preserved");
      } finally {
        await rmdir(link);
      }
    }, 30000);
    it("allows independent native target operations without sharing exclusion or journal state", async () => {
      const first = await setup(),
        second = await setup();
      const [one, two] = await Promise.all([first.open(), second.open()]);
      const effects = await Promise.all([first.execute(one), second.execute(two)]);
      expect(effects.map((result) => result.kind)).toEqual(["executed", "executed"]);
      await Promise.all([one.session.close(), two.session.close()]);
      const [recoveryOne, recoveryTwo] = await Promise.all([first.open(), second.open()]);
      for (const result of await Promise.all([
        first.recover(recoveryOne),
        second.recover(recoveryTwo),
      ]))
        expect(result).toMatchObject({
          kind: "resolved",
          operation: { resolution: { observedState: "absence_observed" } },
        });
    }, 30000);
    it.skipIf(!faultExecutable).each([
      ["before-effect", "contents_remaining"],
      ["root-partial", "contents_remaining"],
      ["root-removed", "registration_remaining"],
      ["registration-partial", "registration_remaining"],
      ["after-effect", "absence_observed"],
    ] as const)(
      "recovers after owned helper termination at %s and database reopen",
      async (phase, expectedState) => {
        const f = await setup(faultExecutable!),
          abort = new AbortController();
        const slot = path.join(f.slots, f.selectedSlot.component);
        await writeFile(slot + ".fault", phase);
        const first = await f.open(abort.signal);
        const execution = f.execute(first).then(
          (value) => ({ value }),
          (error: unknown) => ({ error })
        );
        const deadline = performance.now() + 5000;
        while (!existsSync(slot + ".reached") && performance.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 10));
        const reached = existsSync(slot + ".reached");
        if (reached && phase === "before-effect") {
          const competitor = await f.open();
          await expect(f.recover(competitor)).rejects.toThrow(); // Original native executor still owns the same slot.
          expect(f.store.readOperation("remove")?.resolution).toBeNull();
          await competitor.session.close();
        }
        abort.abort(); // Existing owner terminates its actual child, never an arbitrary PID.
        expect("error" in (await execution)).toBe(true);
        const closed = await first.session.close();
        expect(closed).toMatchObject({
          outcome: "failed",
          cleanup: { processExited: true, disposition: "closed", terminationRequested: true },
        });
        expect(reached, "Native fault barrier must establish the tested order").toBe(true);
        expect(f.store.readOperation("remove")?.resolution).toBeNull();
        await f.store.close();
        stores.splice(stores.indexOf(f.store), 1);
        const reopened = new SqliteWindowsRemovalStore(f.database);
        stores.push(reopened);
        const operation = reopened.readOperation("remove")!;
        expect(operation.admission.executorId).toMatch(/^windows:/u);
        // Remove only the test-only directive; recovery never sends another commit.
        await rm(slot + ".fault");
        const result = await f.recover(await f.open(), reopened);
        expect(result).toMatchObject({
          kind: "resolved",
          operation: { resolution: { observedState: expectedState } },
        });
        expect(await f.lifecycle.getWorkspaceLease("workspace")).toEqual(f.lease);
        expect(reopened.readOperation("remove")?.admission).toEqual(operation.admission);
      },
      30000
    );
  }
);
