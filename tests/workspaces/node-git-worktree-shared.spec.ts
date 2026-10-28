import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorktreeTarget } from "../../src/workspaces/git-worktree-broker.js";
import { NodeGitWorktreeBroker } from "../../src/workspaces/node-git-worktree-broker.js";
import { acquireOwnedWindowsWorkspaceLease } from "../../src/workspaces/owned-windows-workspace-lease.js";
import {
  createWorkspaceBoundaryCapabilityDecision,
  type WorkspaceBoundary,
  type WorkspaceBoundaryLease,
} from "../../src/workspaces/workspace-boundary.js";
import { NativeWorkspaceBoundaryResolver } from "../../src/workspaces/workspace-boundary-resolver.js";

const windows = process.platform === "win32";
const helper = process.env.LEXRUNNER_TEST_NATIVE_HELPER;
const gitExecutable = process.env.LEXRUNNER_TEST_GIT ?? "git";
// Hosted Node can return a short-name TEMP alias (RUNNER~1), which the native
// boundary intentionally refuses. Use the ordinary checkout-local fixture root.
const fixtureParent = path.resolve("artifacts", "shared-broker");

/** Public broker behavior shared by Linux and native Windows. Windows uses an
 * explicit development lease because production selection is still unavailable.
 * Direct fixture Git creation is setup only; the product creation gate is tested
 * separately below. This is not installed-helper or #893 production parity. */
describe("shared native broker behavior", () => {
  let root: string;
  let repository: string;
  let allocation: string;
  let broker: NodeGitWorktreeBroker;
  let target: WorktreeTarget;
  const leases: WorkspaceBoundaryLease[] = [];

  async function git(cwd: string, ...args: string[]): Promise<string> {
    const result = await execa(gitExecutable, args, {
      cwd,
      timeout: 20_000,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: windows ? "NUL" : "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return result.stdout.trim();
  }

  async function seedOwnedWorktree(): Promise<void> {
    // A disposable fixture without a racing actor; never a product creation path.
    await git(
      repository,
      "worktree",
      "add",
      "-b",
      target.branch,
      target.worktreePath,
      target.baseSha
    );
    const gitAdmin = await git(target.worktreePath, "rev-parse", "--absolute-git-dir");
    await writeFile(
      path.join(gitAdmin, "lexrunner-attempt.json"),
      `${JSON.stringify({ schemaVersion: 1, ...target })}\n`
    );
  }

  beforeEach(async () => {
    if (windows && (!helper || !existsSync(helper)))
      throw new Error(
        "LEXRUNNER_TEST_NATIVE_HELPER is required for native Windows broker conformance"
      );
    await mkdir(fixtureParent, { recursive: true });
    root = await mkdtemp(path.join(fixtureParent, "case-"));
    repository = path.join(root, "repository");
    allocation = path.join(root, "allocation");
    await mkdir(repository);
    await mkdir(allocation);
    await git(repository, "init", "-b", "main");
    await git(repository, "config", "commit.gpgsign", "false");
    await git(repository, "config", "core.autocrlf", "false");
    await git(repository, "config", "user.name", "Shared Broker Fixture");
    await git(repository, "config", "user.email", "fixture@example.invalid");
    await writeFile(path.join(repository, "tracked.txt"), "mostly birds\n");
    await git(repository, "add", "tracked.txt");
    await git(repository, "commit", "-m", "base");

    if (windows) {
      const digest = `sha256:${createHash("sha256").update(readFileSync(helper!)).digest("hex")}`;
      const capability = createWorkspaceBoundaryCapabilityDecision({
        schema_version: "1.0.0",
        decision_id: "shared-broker-development-fixture",
        selection: { mode: "native" },
        backend_kind: "windows-native",
        state: "unavailable",
        reason_code: "helper_signature_unverified",
        host: { platform: "windows", architecture: "x64", path_comparison: "case-insensitive" },
        backend: {
          transport: "native_helper",
          implementation: "shared-broker-development-fixture",
          implementation_version: "1.0.0",
          protocol_version: "2.1.0",
          artifact_digest: digest,
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
      const boundary: WorkspaceBoundary = {
        capability,
        async acquire(request) {
          const acquired = await acquireOwnedWindowsWorkspaceLease(
            {
              executable: helper!,
              cwd: path.dirname(helper!),
              architecture: "x64",
              expectedArtifactSha256: digest,
            },
            request,
            capability.decision_digest,
            { workTimeoutMs: 120_000 }
          );
          if (!acquired.ok)
            throw new Error(
              `Shared native fixture acquisition failed: ${JSON.stringify({
                reason: acquired.reason,
                reportReason: acquired.report?.reason,
                helloMatched: acquired.report?.helloMatched,
                directoryAcquired: acquired.report?.directory?.acquired,
                childrenAcquired: acquired.report?.directory?.childrenAcquired,
                releaseAcknowledged: acquired.report?.directory?.releaseAcknowledged,
                sessionRequested: acquired.report?.sessionOperations?.requested,
                sessionCorrelated: acquired.report?.sessionOperations?.correlated,
                cleanup: acquired.report?.cleanup.disposition,
                exitCode: acquired.report?.cleanup.exitCode,
                stderrBytes: acquired.report?.stderrBytes,
                fixtureRoot: root.slice(0, 512),
              })}`
            );
          leases.push(acquired.lease);
          return acquired;
        },
      };
      // Only the test substitutes discovery; the production resolver remains closed.
      vi.spyOn(NativeWorkspaceBoundaryResolver.prototype, "resolve").mockResolvedValue({
        ok: true,
        boundary,
      });
    }

    broker = await NodeGitWorktreeBroker.open({
      repositoryId: "shared-broker",
      repositoryRoot: repository,
      worktreeRoot: allocation,
      hostId: "fixture-host",
      gitRuntime: windows ? "windows-git" : "linux-git",
      gitExecutable,
      pathComparison: windows ? "case-insensitive" : "case-sensitive",
      testOnlyAllowUnboundBoundaryAuthority: true,
    });
    target = {
      repositoryId: "shared-broker",
      hostId: "fixture-host",
      gitRuntime: windows ? "windows-git" : "linux-git",
      projectRoot: repository,
      worktreePath: path.join(allocation, "worker"),
      branch: "agent/worker",
      attemptId: "attempt-worker",
      baseSha: await git(repository, "rev-parse", "HEAD"),
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const releaseFailures: unknown[] = [];
    for (const lease of leases.splice(0)) {
      try {
        const result = await lease.close("completed");
        if (result.phase !== "released")
          throw new Error(`Shared broker fixture release ended in ${result.phase}`);
      } catch (error) {
        releaseFailures.push(error);
      }
    }
    if (releaseFailures.length)
      throw new AggregateError(releaseFailures, "Shared broker fixture native release unconfirmed");
    if (root) {
      if (path.dirname(root) !== fixtureParent || !path.basename(root).startsWith("case-"))
        throw new Error("Invalid shared broker cleanup root");
      await rm(root, { recursive: true, force: true });
    }
  });

  it("checks the new-worktree capability before any first Git effect", async () => {
    const result = await broker.create(target);
    if (windows) {
      expect(result).toMatchObject({
        ok: false,
        reason: "containment_violation",
        message: expect.stringContaining("qualified protected creation transition"),
      });
      expect(existsSync(target.worktreePath)).toBe(false);
      expect(await git(repository, "branch", "--list", target.branch)).toBe("");
    } else {
      expect(result).toMatchObject({ ok: true, outcome: "created" });
      expect(await git(target.worktreePath, "rev-parse", "HEAD")).toBe(target.baseSha);
    }
  });

  it("reuses and observes an exact owned worktree", async () => {
    await seedOwnedWorktree();
    expect(await broker.create(target)).toMatchObject({ ok: true, outcome: "reused" });
    expect(await broker.observe(target)).toMatchObject({
      ok: true,
      observation: {
        registered: true,
        attemptId: target.attemptId,
        headSha: target.baseSha,
        cleanliness: "clean",
      },
    });
    expect(await readFile(path.join(target.worktreePath, "tracked.txt"), "utf8")).toBe(
      "mostly birds\n"
    );
  });

  it("rejects invalid SHA, branch, and runtime before mutation", async () => {
    expect(await broker.create({ ...target, baseSha: target.baseSha.slice(0, 12) })).toMatchObject({
      ok: false,
      reason: "invalid_base_sha",
    });
    expect(await broker.create({ ...target, branch: "agent/bad..branch" })).toMatchObject({
      ok: false,
      reason: "invalid_branch",
    });
    const foreign = { ...target, gitRuntime: "other-runtime" };
    expect(await broker.create(foreign)).toMatchObject({ ok: false, reason: "runtime_mismatch" });
    expect(await broker.observe(foreign)).toMatchObject({ ok: false, reason: "runtime_mismatch" });
    expect(await broker.remove(foreign)).toMatchObject({ ok: false, reason: "runtime_mismatch" });
    expect(existsSync(target.worktreePath)).toBe(false);
  });

  it("rejects target path and repository mismatches before mutation", async () => {
    expect(
      await broker.create({ ...target, projectRoot: path.join(root, "other-repository") })
    ).toMatchObject({ ok: false, reason: "runtime_mismatch" });
    expect(await broker.create({ ...target, worktreePath: "relative/worktree" })).toMatchObject({
      ok: false,
      reason: "invalid_path",
    });
    expect(
      await broker.create({ ...target, worktreePath: path.join(root, "outside-allocation") })
    ).toMatchObject({ ok: false, reason: "invalid_path" });
    expect(existsSync(target.worktreePath)).toBe(false);
  });

  it("does not transfer owned observation or removal to another Attempt", async () => {
    await seedOwnedWorktree();
    const stranger = { ...target, attemptId: "attempt-stranger" };
    const observed = await broker.observe(stranger);
    expect(observed).toMatchObject({ ok: true, observation: { attemptId: null } });
    if (observed.ok) expect(observed.observation.reason).toMatch(/Attempt marker does not match/u);
    expect(await broker.create(stranger)).toMatchObject({ ok: false, reason: "identity_mismatch" });
    expect(await broker.remove(stranger)).toMatchObject({
      ok: true,
      outcome: "preserved",
      preservationReason: "identity_ambiguous",
    });
    expect(await broker.observe(target)).toMatchObject({
      ok: true,
      observation: { attemptId: target.attemptId, cleanliness: "clean" },
    });
  });

  it("observes dirtiness and preserves coworker edits", async () => {
    await seedOwnedWorktree();
    await writeFile(path.join(target.worktreePath, "tracked.txt"), "changed\n");
    await writeFile(path.join(target.worktreePath, "untracked.txt"), "keep\n");
    expect(await broker.observe(target)).toMatchObject({
      ok: true,
      observation: { cleanliness: "dirty" },
    });
    expect(await broker.remove(target)).toMatchObject({
      ok: true,
      outcome: "preserved",
      preservationReason: "dirty",
    });
    expect(await readFile(path.join(target.worktreePath, "untracked.txt"), "utf8")).toBe("keep\n");
  });

  it("preserves missing and unregistered worktrees", async () => {
    expect(await broker.remove(target)).toMatchObject({
      ok: true,
      outcome: "preserved",
      preservationReason: "missing",
    });
    await mkdir(target.worktreePath);
    await writeFile(path.join(target.worktreePath, "keep.txt"), "keep\n");
    expect(await broker.remove(target)).toMatchObject({
      ok: true,
      outcome: "preserved",
      preservationReason: "unregistered",
    });
    expect(await readFile(path.join(target.worktreePath, "keep.txt"), "utf8")).toBe("keep\n");
  });

  it("preserves a locked worktree and a missing marker", async () => {
    await seedOwnedWorktree();
    await git(repository, "worktree", "lock", "--reason", "leased elsewhere", target.worktreePath);
    expect(await broker.remove(target)).toMatchObject({
      ok: true,
      outcome: "preserved",
      preservationReason: "identity_ambiguous",
    });
    await git(repository, "worktree", "unlock", target.worktreePath);
    const gitAdmin = await git(target.worktreePath, "rev-parse", "--absolute-git-dir");
    await rm(path.join(gitAdmin, "lexrunner-attempt.json"));
    expect(await broker.remove(target)).toMatchObject({
      ok: true,
      outcome: "preserved",
      preservationReason: "identity_ambiguous",
    });
  });

  it("keeps clean native removal closed until a qualified transition exists", async () => {
    await seedOwnedWorktree();
    const result = await broker.remove(target);
    if (windows) {
      expect(result).toMatchObject({
        ok: false,
        reason: "containment_violation",
        message: expect.stringContaining("qualified removal transition"),
      });
      expect(await readFile(path.join(target.worktreePath, "tracked.txt"), "utf8")).toBe(
        "mostly birds\n"
      );
      expect(
        (await git(repository, "worktree", "list", "--porcelain"))
          .replaceAll("\\", "/")
          .toLowerCase()
      ).toContain(target.worktreePath.replaceAll("\\", "/").toLowerCase());
    } else {
      expect(result).toMatchObject({ ok: true, outcome: "removed" });
      expect(existsSync(target.worktreePath)).toBe(false);
    }
  });
});
