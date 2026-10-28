import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireOwnedWindowsWorkspaceLease,
  type OwnedWindowsWorkspaceLease,
} from "../../src/workspaces/owned-windows-workspace-lease.js";
import {
  createWorkspaceBoundaryCapabilityDecision,
  type WorkspaceBoundary,
  type WorkspaceBoundaryProcessRequest,
} from "../../src/workspaces/workspace-boundary.js";
import type { WorktreeTarget } from "../../src/workspaces/git-worktree-broker.js";
import type { BrokerFailure } from "../../src/workspaces/git-worktree-broker.js";
import type { WindowsBrokerGitVerb } from "../../src/workspaces/windows-git-command-profile.js";
import type { WindowsGitFixtureProfileInput } from "../../src/workspaces/windows-git-command-profile.js";
const mocks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("../../src/workspaces/workspace-boundary-resolver.js", () => ({
  resolveWorkspaceBoundary: mocks.resolve,
  NativeWorkspaceBoundaryResolver: class {
    resolve = mocks.resolve;
  },
}));
import {
  NodeGitWorktreeBroker,
  type NodeGitWorktreeBrokerOptions,
} from "../../src/workspaces/node-git-worktree-broker.js";
import { makeWindowsGitFixtureProfile } from "./windows-git-fixture-profile.js";

const helper = process.env.LEXRUNNER_TEST_NATIVE_HELPER;
const executable = process.env.LEXRUNNER_TEST_GIT;
const parent = path.resolve("artifacts");
describe.skipIf(process.platform !== "win32" || !helper)(
  "real broker with explicit native test composition",
  () => {
    let root: string;
    let repo: string;
    let allocation: string;
    let broker: NodeGitWorktreeBroker;
    let brokerOptions: NodeGitWorktreeBrokerOptions;
    let profileInput: WindowsGitFixtureProfileInput;
    let target: WorktreeTarget;
    const leases: OwnedWindowsWorkspaceLease[] = [];
    const commands: WorkspaceBoundaryProcessRequest[] = [];
    async function git(...args: string[]) {
      return (await execa(executable!, args, { cwd: repo, timeout: 10000 })).stdout.trim();
    }
    async function seedFixtureWorktree() {
      // Fixture setup uses ordinary Git without a racing actor. It is not a
      // qualified product creation path.
      await git("worktree", "add", "-b", target.branch, target.worktreePath, target.baseSha);
      await writeFile(
        path.join(repo, ".git", "worktrees", "worker", "lexrunner-attempt.json"),
        `${JSON.stringify({ schemaVersion: 1, ...target })}\n`
      );
    }
    beforeEach(async () => {
      if (!executable) throw new Error("LEXRUNNER_TEST_GIT required for native qualification");
      await mkdir(parent, { recursive: true });
      root = await mkdtemp(path.join(parent, "native-broker-"));
      repo = path.join(root, "repository");
      allocation = path.join(root, "allocation");
      await mkdir(repo);
      await mkdir(allocation);
      await git("init", "-b", "main");
      await git("config", "commit.gpgsign", "false");
      await git("config", "core.autocrlf", "false");
      await git("config", "user.name", "Native Fixture");
      await git("config", "user.email", "fixture@example.invalid");
      await writeFile(path.join(repo, "tracked.txt"), "mostly birds\n");
      await git("add", "tracked.txt");
      await git("commit", "-m", "base");
      const digest = `sha256:${createHash("sha256").update(readFileSync(helper!)).digest("hex")}`;
      // Synthetic discovery for this test only. Production resolver is not changed;
      // this metadata is not signature/provisioning evidence.
      const capability = createWorkspaceBoundaryCapabilityDecision({
        schema_version: "1.0.0",
        decision_id: "native-fixture",
        selection: { mode: "native" },
        backend_kind: "windows-native",
        state: "ready",
        reason_code: "native_backend_ready",
        host: { platform: "windows", architecture: "x64", path_comparison: "case-insensitive" },
        backend: {
          transport: "native_helper",
          implementation: "test-composition",
          implementation_version: "1.0.0",
          protocol_version: "2.2.0",
          artifact_digest: digest,
          signature: { status: "verified", signer_identity: "synthetic-test-metadata" },
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
      const boundary: WorkspaceBoundary = {
        capability,
        async acquire(request) {
          const result = await acquireOwnedWindowsWorkspaceLease(
            {
              executable: helper!,
              cwd: path.dirname(helper!),
              architecture: "x64",
              expectedArtifactSha256: digest,
            },
            request,
            capability.decision_digest,
            { workTimeoutMs: 120000 }
          );
          if (!result.ok) throw new Error(JSON.stringify(result));
          leases.push(result.lease);
          const run = result.lease.runProcess.bind(result.lease);
          result.lease.runProcess = async (request) => {
            commands.push(request);
            return run(request);
          };
          return result;
        },
      };
      mocks.resolve.mockReturnValue({ ok: true, boundary });
      profileInput = await makeWindowsGitFixtureProfile(root, executable!);
      brokerOptions = {
        repositoryId: "native",
        repositoryRoot: repo,
        worktreeRoot: allocation,
        hostId: "host",
        gitRuntime: "native-git",
        gitExecutable: executable,
        pathComparison: "case-insensitive",
        testOnlyAllowUnboundBoundaryAuthority: true,
        testOnlyWindowsGitProfile: profileInput,
      };
      broker = await NodeGitWorktreeBroker.open(brokerOptions);
      target = {
        repositoryId: "native",
        hostId: "host",
        gitRuntime: "native-git",
        projectRoot: repo,
        worktreePath: path.join(allocation, "worker"),
        branch: "agent/worker",
        attemptId: "attempt-worker",
        baseSha: await git("rev-parse", "HEAD"),
      };
      commands.length = 0;
    });
    afterEach(async () => {
      for (const lease of leases.splice(0)) await lease.close("completed").catch(() => {});
      if (root) {
        if (path.dirname(root) !== parent || !path.basename(root).startsWith("native-broker-"))
          throw new Error("invalid cleanup root");
        await rm(root, { recursive: true, force: true });
      }
    });

    it("refuses a new native target before Git add or target creation", async () => {
      expect(await broker.create(target)).toMatchObject({
        ok: false,
        reason: "containment_violation",
        message: expect.stringContaining("qualified protected creation transition"),
      });
      expect(existsSync(target.worktreePath)).toBe(false);
      expect(await git("branch", "--list", target.branch)).toBe("");
      expect(
        commands.some((command) =>
          command.args.some((arg) => arg.kind === "literal" && arg.value === "add")
        )
      ).toBe(false);
    });
    it("reuses and observes an existing fixture worktree", async () => {
      await seedFixtureWorktree();
      expect(await broker.create(target)).toMatchObject({ ok: true, outcome: "reused" });
      expect(await broker.observe(target)).toMatchObject({
        ok: true,
        observation: { registered: true, cleanliness: "clean", headSha: target.baseSha },
      });
      expect(await readFile(path.join(target.worktreePath, "tracked.txt"), "utf8")).toBe(
        "mostly birds\n"
      );
    });
    it("refuses incompatible removal without changing tracked bytes or registration", async () => {
      await seedFixtureWorktree();
      commands.length = 0;
      expect(await broker.remove(target)).toMatchObject({
        ok: false,
        reason: "containment_violation",
        message: expect.stringContaining("qualified removal transition"),
      });
      expect(
        commands.some((command) =>
          command.args.some((arg) => arg.kind === "literal" && arg.value === "remove")
        )
      ).toBe(false);
      expect(await readFile(path.join(target.worktreePath, "tracked.txt"), "utf8")).toBe(
        "mostly birds\n"
      );
      expect(await broker.observe(target)).toMatchObject({
        ok: true,
        observation: { registered: true, cleanliness: "clean" },
      });
    });
    it("keeps the existing missing-workspace preservation outcome", async () => {
      expect(await broker.remove(target)).toMatchObject({
        ok: true,
        outcome: "preserved",
        preservationReason: "missing",
      });
      expect(
        commands.some((command) =>
          command.args.some((arg) => arg.kind === "literal" && arg.value === "remove")
        )
      ).toBe(false);
    });
    it("preserves an unregistered directory and its contents", async () => {
      await mkdir(target.worktreePath);
      await writeFile(path.join(target.worktreePath, "keep.txt"), "coworker content\n");
      expect(await broker.remove(target)).toMatchObject({
        ok: true,
        outcome: "preserved",
        preservationReason: "unregistered",
      });
      expect(await readFile(path.join(target.worktreePath, "keep.txt"), "utf8")).toBe(
        "coworker content\n"
      );
    });
    it("preserves dirty content through the normal product outcome", async () => {
      await seedFixtureWorktree();
      await writeFile(path.join(target.worktreePath, "tracked.txt"), "and wander\n");
      expect(await broker.remove(target)).toMatchObject({
        ok: true,
        outcome: "preserved",
        preservationReason: "dirty",
      });
      expect(await readFile(path.join(target.worktreePath, "tracked.txt"), "utf8")).toBe(
        "and wander\n"
      );
    });
    it("runs broker Git with a fixed process profile despite ambient Git configuration", async () => {
      await seedFixtureWorktree();
      const originalSearch = profileInput.searchPath[0]!;
      (profileInput.searchPath as string[])[0] = "C:\\mutable-input-should-not-reach-git";
      const canary = path.join(root, "ambient-canary.txt");
      const script = path.join(root, "ambient-fsmonitor");
      if (!/^[A-Za-z]:\\/u.test(canary) || canary.includes("'"))
        throw new Error("Unsafe fixture canary path");
      const msysCanary = `/${canary[0]!.toLowerCase()}/${canary.slice(3).replace(/\\/gu, "/")}`;
      await writeFile(
        script,
        `#!/bin/sh\nprintf 'ambient:%s\\n' "$1" >> '${msysCanary}'\nprintf 'probe-token\\000/\\000'\n`
      );
      await writeFile(canary, "");
      const saved = {
        count: process.env.GIT_CONFIG_COUNT,
        key: process.env.GIT_CONFIG_KEY_0,
        value: process.env.GIT_CONFIG_VALUE_0,
      };
      try {
        process.env.GIT_CONFIG_COUNT = "1";
        process.env.GIT_CONFIG_KEY_0 = "core.fsmonitor";
        process.env.GIT_CONFIG_VALUE_0 = script.replace(/\\/gu, "/");
        // Positive control is fixture setup, outside the broker process ledger.
        await git("status", "--porcelain=v1");
        expect(await readFile(canary, "utf8")).toContain("ambient:");
        await writeFile(canary, "");
        commands.length = 0;
        expect(await broker.observe(target)).toMatchObject({ ok: true });
        expect(await readFile(canary, "utf8")).toBe("");
        expect(commands.length).toBeGreaterThan(0);
        for (const command of commands) {
          expect(command.executable).toBe(executable);
          expect(command.extendEnv).toBe(false);
          expect(command.maxOutputBytes).toBe(256 * 1024);
          expect(command.timeoutMs).toBeLessThanOrEqual(30_000);
          expect(command.env).not.toHaveProperty("GIT_CONFIG_COUNT");
          expect(command.env).not.toHaveProperty("GIT_CONFIG_KEY_0");
          expect(command.env).not.toHaveProperty("GIT_CONFIG_VALUE_0");
          expect(command.env?.PATH).toContain(originalSearch);
          expect(command.env?.PATH).not.toContain("mutable-input-should-not-reach-git");
          expect(command.args.slice(0, 2)).toEqual([
            { kind: "literal", value: "--no-pager" },
            { kind: "literal", value: "-c" },
          ]);
          expect(command.args).toContainEqual({ kind: "literal", value: "core.fsmonitor=false" });
        }
      } finally {
        for (const [name, value] of [
          ["GIT_CONFIG_COUNT", saved.count],
          ["GIT_CONFIG_KEY_0", saved.key],
          ["GIT_CONFIG_VALUE_0", saved.value],
        ] as const) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    });
    it("returns structured containment failures before a child for missing or closed Git profiles", async () => {
      const runProcess = vi.fn();
      const operationBoundary = { lease: { runProcess } } as never;
      const cwd = {} as never;
      const directory = {} as never;
      const prefix = [
        { kind: "directory", directory, prefix: "--git-dir=" },
        { kind: "directory", directory, prefix: "--work-tree=" },
      ];
      const dispatch = broker as unknown as {
        git(
          boundary: never,
          operation: "create",
          verb: WindowsBrokerGitVerb,
          args: never,
          cwd: never,
          options: {}
        ): Promise<BrokerFailure>;
      };
      for (const verb of ["worktree_add", "worktree_remove"] as const) {
        const args = [
          ...prefix,
          { kind: "literal", value: "worktree" },
          { kind: "literal", value: verb === "worktree_add" ? "add" : "remove" },
        ];
        expect(
          await dispatch.git(operationBoundary, "create", verb, args as never, cwd, {})
        ).toMatchObject({ ok: false, operation: "create", reason: "containment_violation" });
      }
      expect(
        await dispatch.git(
          operationBoundary,
          "create",
          "check_branch",
          [
            ...prefix,
            { kind: "literal", value: "check-ref-format" },
            { kind: "literal", value: "--branch" },
            { kind: "literal", value: "agent/work" },
          ] as never,
          cwd,
          { timeoutMs: 30_001 }
        )
      ).toMatchObject({ ok: false, reason: "containment_violation" });
      expect(runProcess).not.toHaveBeenCalled();
      const selected = Reflect.get(broker, "windowsGitProfile");
      try {
        Reflect.set(broker, "windowsGitProfile", undefined);
        expect(
          await dispatch.git(operationBoundary, "create", "check_branch", prefix as never, cwd, {})
        ).toMatchObject({
          ok: false,
          operation: "create",
          reason: "containment_violation",
          message: expect.stringContaining("process profile is unavailable"),
        });
        expect(runProcess).not.toHaveBeenCalled();
      } finally {
        Reflect.set(broker, "windowsGitProfile", selected);
      }
    });
    it("rejects fixture Git selection against a non-synthetic boundary before acquisition", async () => {
      const resolved = mocks.resolve() as { ok: true; boundary: WorkspaceBoundary };
      mocks.resolve.mockReturnValue({
        ok: true,
        boundary: {
          ...resolved.boundary,
          capability: {
            ...resolved.boundary.capability,
            backend: {
              ...resolved.boundary.capability.backend,
              implementation: "installed-service",
            },
          },
        },
      });
      const count = leases.length;
      await expect(NodeGitWorktreeBroker.open(brokerOptions)).rejects.toThrow(
        /explicit synthetic test composition/u
      );
      expect(leases.length).toBe(count);
      expect(commands).toEqual([]);
    });
  }
);
