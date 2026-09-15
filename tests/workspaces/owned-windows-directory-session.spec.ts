import { projectOwnedWindowsProcessReceipt } from "../../src/workspaces/owned-windows-process-receipt.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireOwnedWindowsDirectorySession } from "../../src/workspaces/owned-windows-directory-session.js";

const executable = process.env.LEXRUNNER_TEST_NATIVE_HELPER;
const artifacts = path.resolve("artifacts");
const roots: string[] = [];
async function fixture() {
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(path.join(artifacts, "directory-session-"));
  roots.push(root);
  return {
    root,
    options: {
      executable: executable!,
      cwd: path.dirname(executable!),
      architecture: "x64" as const,
      expectedArtifactSha256: `sha256:${createHash("sha256").update(readFileSync(executable!)).digest("hex")}`,
    },
  };
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== artifacts || !path.basename(root).startsWith("directory-session-"))
      throw new Error("Invalid cleanup root");
    await rm(root, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== "win32" || !executable)(
  "owned directory session bridge",
  () => {
    it("projects an acknowledged process receipt before closing the native session", async () => {
      const f = await fixture();
      const acquired = await acquireOwnedWindowsDirectorySession(f.options, {
        path: f.root,
        workTimeoutMs: 25_000,
      });
      if (!acquired.ok) throw new Error("acquisition failed");
      const { session } = acquired;
      try {
        const empty = session.snapshotProcessAttempts();
        const child = await session.run((scope) => scope.createChild("worker"));
        await session.run(async () => {
          const pending = child.runProcess({
            executable: process.execPath,
            args: [
              { kind: "literal", value: "-e" },
              { kind: "literal", value: "process.stdout.write('bird')" },
            ],
            environment: "inherit-helper",
            timeoutMs: 5_000,
            maxOutputBytes: 1024,
          });
          const before = session.snapshotProcessAttempts();
          expect(before).toHaveLength(1);
          expect(before[0]).toMatchObject({
            acknowledged: false,
            cwd: { path: child.identity.path },
          });
          expect(before[0].observedAt).toBeUndefined();
          expect(Object.isFrozen(before)).toBe(true);
          expect(Object.isFrozen(before[0])).toBe(true);
          expect(Object.isFrozen(before[0].cwd)).toBe(true);
          expect(Reflect.set(before[0], "acknowledged", true)).toBe(false);
          const result = await pending;
          const after = session.snapshotProcessAttempts();
          expect(empty).toHaveLength(0);
          expect(before[0].acknowledged).toBe(false);
          expect(after[0]).toMatchObject({ acknowledged: true, operationId: result.operationId });
          const attempt = after[0];
          const projected = projectOwnedWindowsProcessReceipt(
            {
              leaseId: attempt.boundaryLeaseId,
              startedAt: attempt.startedAt,
              completedAt: attempt.observedAt!,
            },
            attempt,
            result
          );
          expect(projected).toMatchObject({ ok: true, value: { ok: true, stdout: "bird" } });
        });
        // Receipt projection neither closes nor re-acquires the native owner.
        await session.run(() => child.assertCurrent());
        const report = await session.close();
        expect(report.outcome).toBe("matched");
        expect(session.snapshotProcessAttempts()).toEqual(report.processAttempts);
      } finally {
        await session.close();
      }
    });
    it("retains real scopes across calls and returns the owner's terminal report", async () => {
      const f = await fixture();
      const acquired = await acquireOwnedWindowsDirectorySession(f.options, { path: f.root });
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) throw new Error("acquisition failed");
      const { session } = acquired;
      const child = await session.run((scope) => scope.createChild("worker"));
      await session.run(() => child.createFile("marker", Buffer.from("durable observation")));
      const bytes = await session.run(() => child.readFile("marker", 100));
      expect(Buffer.from(bytes.bytes).toString()).toBe("durable observation");
      const closed = session.close();
      expect(session.close()).toBe(closed);
      await expect(session.run((scope) => scope.assertCurrent())).rejects.toThrow(
        "directory_session_closed"
      );
      const report = await closed;
      expect(report).toMatchObject({
        outcome: "matched",
        directory: { releaseAcknowledged: true, childrenReleased: 1 },
        cleanup: { disposition: "closed" },
      });
      expect(await session.completion).toBe(report);
      await expect(child.assertCurrent()).rejects.toThrow();
    });

    it("drains admitted work while refusing concurrent and post-close calls", async () => {
      const f = await fixture();
      const acquired = await acquireOwnedWindowsDirectorySession(f.options, { path: f.root });
      if (!acquired.ok) throw new Error("acquisition failed");
      let finish!: () => void;
      const barrier = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const active = acquired.session.run(async (scope) => {
        await barrier;
        return scope.assertCurrent();
      });
      await expect(acquired.session.run((scope) => scope.assertCurrent())).rejects.toThrow(
        "directory_session_busy"
      );
      const close = acquired.session.close();
      await expect(acquired.session.run((scope) => scope.assertCurrent())).rejects.toThrow(
        "directory_session_closed"
      );
      finish();
      await active;
      expect(await close).toMatchObject({
        outcome: "matched",
        directory: { assertions: 1, releaseAcknowledged: true },
      });
    });

    it("preserves callback failure as failed work even when close is also requested", async () => {
      const f = await fixture();
      const acquired = await acquireOwnedWindowsDirectorySession(f.options, { path: f.root });
      if (!acquired.ok) throw new Error("acquisition failed");
      const work = acquired.session.run(async () => {
        throw new Error("work broke");
      });
      const close = acquired.session.close();
      await expect(work).rejects.toThrow("work broke");
      expect(await close).toMatchObject({ outcome: "failed", reason: "work_failed" });
    });

    it("settles acquisition when native acquisition fails", async () => {
      const f = await fixture();
      const acquired = await acquireOwnedWindowsDirectorySession(f.options, {
        path: path.join(f.root, "missing"),
      });
      expect(acquired).toMatchObject({
        ok: false,
        report: { outcome: "failed", directory: { acquired: false } },
      });
    });

    it("settles pre-aborted acquisition without opening a session", async () => {
      const f = await fixture();
      const controller = new AbortController();
      controller.abort();
      expect(
        await acquireOwnedWindowsDirectorySession(f.options, { path: f.root }, controller.signal)
      ).toMatchObject({ ok: false, report: { outcome: "failed", reason: "cancelled" } });
    });

    it("ends a hung caller at expiry while acknowledging idle native release", async () => {
      const f = await fixture();
      const acquired = await acquireOwnedWindowsDirectorySession(f.options, {
        path: f.root,
        workTimeoutMs: 50,
      });
      if (!acquired.ok) throw new Error("acquisition failed");
      await expect(acquired.session.run(() => new Promise<never>(() => {}))).rejects.toThrow(
        "directory_session_ended"
      );
      expect(await acquired.session.close()).toMatchObject({
        outcome: "failed",
        reason: "work_timeout",
        deadline: { graceExpired: false },
        directory: { releaseAcknowledged: true },
      });
    });

    it("does not invoke newly scheduled work after cancellation", async () => {
      const f = await fixture();
      const controller = new AbortController();
      const acquired = await acquireOwnedWindowsDirectorySession(
        f.options,
        { path: f.root },
        controller.signal
      );
      if (!acquired.ok) throw new Error("acquisition failed");
      let invoked = false;
      const work = acquired.session.run(async () => {
        invoked = true;
      });
      controller.abort();
      await expect(work).rejects.toThrow("directory_session_ended");
      await expect(acquired.session.run(async () => {})).rejects.toThrow(
        "directory_session_closed"
      );
      expect(invoked).toBe(false);
      expect(await acquired.session.close()).toMatchObject({
        outcome: "failed",
        reason: "cancelled",
      });
    });

    it("retains cancellation after acquisition and rejects later work", async () => {
      const f = await fixture();
      const controller = new AbortController();
      const acquired = await acquireOwnedWindowsDirectorySession(
        f.options,
        { path: f.root },
        controller.signal
      );
      if (!acquired.ok) throw new Error("acquisition failed");
      controller.abort();
      expect(await acquired.session.completion).toMatchObject({
        outcome: "failed",
        reason: "cancelled",
      });
      await expect(acquired.session.run((scope) => scope.assertCurrent())).rejects.toThrow(
        "directory_session_closed"
      );
    });
  }
);
