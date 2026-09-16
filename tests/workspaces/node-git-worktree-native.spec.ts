import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
const mocks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("../../src/workspaces/workspace-boundary-resolver.js", () => ({
  resolveWorkspaceBoundary: mocks.resolve,
}));
import { NodeGitWorktreeBroker } from "../../src/workspaces/node-git-worktree-broker.js";

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
    let target: WorktreeTarget;
    const leases: OwnedWindowsWorkspaceLease[] = [];
    const commands: WorkspaceBoundaryProcessRequest[] = [];
    async function git(...args: string[]) {
      return (await execa(executable!, args, { cwd: repo, timeout: 10000 })).stdout.trim();
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
          protocol_version: "2.0.0",
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
      broker = await NodeGitWorktreeBroker.open({
        repositoryId: "native",
        repositoryRoot: repo,
        worktreeRoot: allocation,
        hostId: "host",
        gitRuntime: "native-git",
        gitExecutable: executable,
        pathComparison: "case-insensitive",
        testOnlyAllowUnboundBoundaryAuthority: true,
      });
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

    it("creates, reuses and observes the real native workspace", async () => {
      expect(await broker.create(target)).toMatchObject({ ok: true, outcome: "created" });
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
      expect(await broker.create(target)).toMatchObject({ ok: true });
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
      expect(await broker.create(target)).toMatchObject({ ok: true });
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
  }
);
