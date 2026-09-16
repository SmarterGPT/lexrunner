import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireOwnedWindowsWorkspaceLease } from "../../src/workspaces/owned-windows-workspace-lease.js";
import type { WorkspaceBoundaryDirectoryCapability } from "../../src/workspaces/workspace-boundary.js";

const executable = process.env.LEXRUNNER_TEST_NATIVE_HELPER;
const artifacts = path.resolve("artifacts");
const roots: string[] = [];
async function fixture(workTimeoutMs = 30_000) {
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(path.join(artifacts, "workspace-lease-"));
  roots.push(root);
  const acquired = await acquireOwnedWindowsWorkspaceLease(
    {
      executable: executable!,
      cwd: path.dirname(executable!),
      architecture: "x64",
      expectedArtifactSha256: `sha256:${createHash("sha256").update(readFileSync(executable!)).digest("hex")}`,
    },
    {
      operationId: "acquire",
      orchestrationLeaseId: "development-work",
      orchestrationLeaseRevision: 1,
      ownerId: "test-worker",
      roots: [{ role: "root", absolutePath: root }],
    },
    `sha256:${"a".repeat(64)}`,
    { workTimeoutMs }
  );
  if (!acquired.ok) throw new Error(JSON.stringify(acquired));
  return { root, lease: acquired.lease, directory: acquired.lease.root("root") };
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== artifacts || !path.basename(root).startsWith("workspace-lease-"))
      throw new Error("Invalid cleanup root");
    // Cancellation deliberately reports unconfirmed release. Its bounded child
    // can still hold cwd briefly; fixture cleanup is not release evidence.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

describe.skipIf(process.platform !== "win32" || !executable)("owned Windows portable lease", () => {
  it("runs directory/file operations with portable receipts and retained native identities", async () => {
    const f = await fixture();
    try {
      expect(await f.lease.tryOpenChild(f.directory, "absent", "missing")).toMatchObject({
        ok: true,
        value: null,
      });
      const made = await f.lease.createChild(f.directory, "child", "create");
      if (!made.ok) throw new Error(made.error.message);
      expect(made.receipt).toMatchObject({
        operation_id: "create",
        mutation: true,
        durability: "not_requested",
      });
      const opened = await f.lease.openChild(f.directory, "child", "open");
      expect(opened).toMatchObject({ ok: true, value: { identity: made.value.identity } });
      expect(await f.lease.assertCurrent([f.directory, made.value], "assert")).toMatchObject({
        ok: true,
      });
      const content = Buffer.from("mostly birds");
      const written = f.lease.writeFile({
        operationId: "write",
        directory: made.value,
        component: "marker",
        content,
        exclusive: true,
      });
      content.fill(0);
      expect(await written).toMatchObject({
        ok: true,
        receipt: { operation_id: "write", durability: "not_requested" },
      });
      const read = await f.lease.readFile({
        operationId: "read",
        directory: made.value,
        component: "marker",
        maxBytes: 64,
      });
      if (!read.ok) throw new Error(read.error.message);
      expect(Buffer.from(read.value).toString()).toBe("mostly birds");
      const association = f.lease
        .snapshotAssociations()
        .find((item) => item.operationId === "write")!;
      expect(association.nativeOperations).toHaveLength(1);
      expect(association.nativeOperations[0]).toMatchObject({ acknowledged: true });
      expect(association.nativeOperations[0].operationId).not.toBe("write");
    } finally {
      expect(await f.lease.close("completed")).toMatchObject({ phase: "released" });
    }
    expect((await f.lease.completion).directoryAttempts?.every((item) => item.acknowledged)).toBe(
      true
    );
    expect(await f.lease.close("expired")).toEqual(await f.lease.close("completed"));
    expect(() => f.lease.root("root")).toThrow("closed");
  });

  it("runs a real command using a held cwd, snapshots env/args and associates its acknowledgment", async () => {
    const f = await fixture();
    try {
      const args = [
        { kind: "literal" as const, value: "-e" },
        {
          kind: "literal" as const,
          value: "process.stdout.write(process.env.BIRD + ':' + process.cwd())",
        },
      ];
      const env = { BIRD: "robin", SystemRoot: process.env.SystemRoot! };
      const pending = f.lease.runProcess({
        operationId: "command",
        executable: process.execPath,
        cwd: f.directory,
        args,
        env,
        extendEnv: false,
        timeoutMs: 5000,
      });
      env.BIRD = "changed";
      args[1].value = "process.exit(5)";
      expect(await pending).toMatchObject({
        ok: true,
        value: { ok: true, stdout: `robin:${f.root}` },
      });
      expect(f.lease.snapshotAssociations()[0].nativeOperations[0]).toMatchObject({
        acknowledged: true,
      });
    } finally {
      await f.lease.close("completed");
    }
  });

  it("runs Git against the native leased cwd", async () => {
    const git = process.env.LEXRUNNER_TEST_GIT;
    if (!git) throw new Error("LEXRUNNER_TEST_GIT required for native qualification");
    const f = await fixture();
    try {
      const result = await f.lease.runProcess({
        operationId: "git-init",
        executable: git,
        cwd: f.directory,
        args: [
          { kind: "literal", value: "init" },
          { kind: "literal", value: "--quiet" },
        ],
        timeoutMs: 5000,
      });
      expect(result).toMatchObject({ ok: true, value: { ok: true } });
      expect(await readFile(path.join(f.root, ".git", "HEAD"), "utf8")).toContain(
        "ref: refs/heads/"
      );
    } finally {
      await f.lease.close("completed");
    }
  });

  it("rejects foreign capabilities without dispatch and still releases", async () => {
    const f = await fixture();
    const forged = { ...f.directory } as WorkspaceBoundaryDirectoryCapability;
    expect(await f.lease.createChild(forged, "nope", "foreign")).toMatchObject({
      ok: false,
      error: { effect_state: "no_effect" },
    });
    expect(f.lease.snapshotAssociations()).toEqual([]);
    expect(await f.lease.close("completed")).toMatchObject({ phase: "released" });
  });

  it("does not replay a repeated portable operation ID", async () => {
    const f = await fixture();
    try {
      expect(await f.lease.createChild(f.directory, "first", "same")).toMatchObject({ ok: true });
      expect(await f.lease.createChild(f.directory, "second", "same")).toMatchObject({
        ok: false,
        error: { effect_state: "no_effect" },
      });
      expect(f.lease.snapshotAssociations()).toHaveLength(1);
    } finally {
      await f.lease.close("completed");
    }
  });

  it("rejects unsupported writes before dispatch and preserves a usable lease", async () => {
    const f = await fixture();
    expect(
      await f.lease.writeFile({
        operationId: "unsupported",
        directory: f.directory,
        component: "marker",
        content: Buffer.from("x"),
      })
    ).toMatchObject({ ok: false, error: { effect_state: "no_effect" } });
    expect(f.lease.snapshotAssociations()).toEqual([]);
    expect(await f.lease.close("completed")).toMatchObject({ phase: "released" });
  });

  it("reports cancelled in-flight mutation effects as unknown and retains the native attempt", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const pending = f.lease.runProcess({
      operationId: "cancel",
      executable: process.execPath,
      cwd: f.directory,
      args: [
        { kind: "literal", value: "-e" },
        { kind: "literal", value: "setTimeout(()=>{},5000)" },
      ],
      signal: controller.signal,
      timeoutMs: 8000,
    });
    setTimeout(() => controller.abort(), 100);
    expect(await pending).toMatchObject({
      ok: false,
      receipt: { outcome: "indeterminate" },
      error: { effect_state: "effect_unknown", retryable: false },
    });
    expect(f.lease.snapshotAssociations()[0].nativeOperations[0]).toMatchObject({
      acknowledged: false,
    });
    await expect(f.lease.close("cancelled")).rejects.toThrow("release_unconfirmed");
  });

  it("rejects pre-aborted commands without dispatch", async () => {
    const f = await fixture();
    const pending = f.lease.runProcess({
      operationId: "cancel-before",
      executable: process.execPath,
      cwd: f.directory,
      args: [],
      signal: AbortSignal.abort(),
      timeoutMs: 1000,
    });
    expect(await pending).toMatchObject({ ok: false, error: { effect_state: "no_effect" } });
    expect(f.lease.snapshotAssociations()).toEqual([]);
    await f.lease.close("completed");
  });

  it("keeps a nonzero process exit distinct from a failed boundary exchange", async () => {
    const f = await fixture();
    try {
      expect(
        await f.lease.runProcess({
          operationId: "nonzero",
          executable: process.execPath,
          cwd: f.directory,
          args: [
            { kind: "literal", value: "-e" },
            { kind: "literal", value: "process.exit(7)" },
          ],
          timeoutMs: 1000,
        })
      ).toMatchObject({
        ok: true,
        value: { ok: false, kind: "nonzero_exit", exitCode: 7 },
        receipt: { outcome: "completed" },
      });
    } finally {
      await f.lease.close("completed");
    }
  });

  it("rejects unsupported argument suffixes without losing the lease", async () => {
    const f = await fixture();
    try {
      expect(
        await f.lease.runProcess({
          operationId: "suffix",
          executable: process.execPath,
          cwd: f.directory,
          args: [{ kind: "directory", directory: f.directory, suffix: "/x" }],
          timeoutMs: 1000,
        })
      ).toMatchObject({
        ok: false,
        error: { effect_state: "no_effect", message: "unsupported_directory_argument" },
      });
      expect(await f.lease.assertCurrent([f.directory], "still-live")).toMatchObject({ ok: true });
    } finally {
      await f.lease.close("completed");
    }
  });

  it("refuses concurrent work while close drains the original operation", async () => {
    const f = await fixture();
    const first = f.lease.createChild(f.directory, "first", "first");
    expect(await f.lease.createChild(f.directory, "second", "second")).toMatchObject({
      ok: false,
      error: { effect_state: "no_effect" },
    });
    const closing = f.lease.close("completed");
    expect(await first).toMatchObject({ ok: true });
    expect(await closing).toMatchObject({ phase: "released" });
    expect(f.lease.snapshotAssociations()).toHaveLength(1);
  });

  it("preserves graceful deadline expiry in the terminal receipt", async () => {
    const f = await fixture(60);
    expect(await f.lease.completion).toMatchObject({
      reason: "work_timeout",
      directory: { releaseAcknowledged: true },
    });
    expect(await f.lease.close("completed")).toMatchObject({ phase: "expired" });
    expect(await f.lease.createChild(f.directory, "late", "late")).toMatchObject({
      ok: false,
      error: { effect_state: "no_effect" },
    });
  });

  it("keeps acquisition and terminal root evidence immutable", async () => {
    const f = await fixture();
    const original = [...f.lease.acquired.root_identity_digests];
    expect(() => {
      f.lease.acquired.root_identity_digests[0] = `sha256:${"b".repeat(64)}`;
    }).toThrow();
    const closed = await f.lease.close("completed");
    expect(closed.root_identity_digests).toEqual(original);
    expect(() => {
      closed.root_identity_digests[0] = `sha256:${"c".repeat(64)}`;
    }).toThrow();
    expect((await f.lease.close("completed")).root_identity_digests).toEqual(original);
  });
});
