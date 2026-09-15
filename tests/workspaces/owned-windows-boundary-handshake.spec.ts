import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  probeOwnedWindowsBoundaryHandshake,
  probeOwnedWindowsBoundarySession,
  withOwnedWindowsBoundaryDirectory,
} from "../../src/workspaces/owned-windows-boundary-handshake.js";

const fixture = fileURLToPath(
  new URL("../fixtures/windows-boundary-handshake-child.mjs", import.meta.url)
);
const state = vi.hoisted(() => ({
  mode: "valid",
  calls: [] as unknown[][],
  child: undefined as any,
  write: undefined as any,
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      state.calls.push(args);
      if (state.mode === "spawn-throws") throw new Error("private spawn diagnostic");
      if (state.mode === "fake") return state.child;
      if (state.mode === "async-spawn-error") {
        return actual.spawn(process.execPath + ".missing-boundary", [], args[2]);
      }
      // The production fixed argv is captured above; only this test replaces the executable peer.
      state.child = actual.spawn(
        process.execPath,
        [fixture, state.mode, `sha256:${"c".repeat(64)}`],
        args[2]
      );
      state.write = vi.spyOn(state.child.stdin, "write");
      return state.child;
    },
  };
});
const options = () => ({
  executable: process.execPath,
  cwd: process.cwd(),
  expectedArtifactSha256: `sha256:${"c".repeat(64)}`,
  architecture: process.arch as "x64" | "arm64",
  handshakeTimeoutMs: 2_000,
  // Real peers need scheduling room to report natural exit on a loaded Windows host.
  // Tests of forced cleanup select their own short deadline below.
  closeTimeoutMs: 1_000,
  killTimeoutMs: 1_000,
});
afterEach(() => {
  state.calls.length = 0;
  state.mode = "valid";
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("owned Windows boundary development handshake", () => {
  it.each(["foreign-scope", "insufficient-budget", "over-timeout"])(
    "rejects %s before dispatch",
    async (mode) => {
      state.mode = "directory-process-valid";
      const report = await withOwnedWindowsBoundaryDirectory(
        options(),
        { path: "D:\\fixture", workTimeoutMs: mode === "insufficient-budget" ? 5_000 : 30_000 },
        async (scope) => {
          await scope.runProcess({
            executable: "C:\\fixture.exe",
            args:
              mode === "foreign-scope"
                ? [{ kind: "directory", directory: { ...scope }, prefix: "", relativeToCwd: false }]
                : [],
            environment: "inherit-helper",
            timeoutMs: mode === "over-timeout" ? 30_000 : 100,
            maxOutputBytes: 1,
          });
        }
      );
      expect(report).toMatchObject({ reason: "work_failed", processAttempts: [] });
      expect(state.write).toHaveBeenCalledTimes(2);
    }
  );
  it.each([
    "wrong-token",
    "wrong-digest",
    "noncanonical",
    "over-bound",
    "wrong-exit",
    "wrong-truncation",
    "lost",
  ])("preserves unknown process outcome after %s reply", async (mode) => {
    state.mode = `directory-process-${mode}`;
    let delivered = false;
    const report = await withOwnedWindowsBoundaryDirectory(
      options(),
      { path: "D:\\fixture", workTimeoutMs: 15_000 },
      async (scope) => {
        await scope.runProcess({
          executable: "C:\\fixture.exe",
          args: [],
          environment: "inherit-helper",
          timeoutMs: 100,
          maxOutputBytes: 1,
        });
        delivered = true;
      }
    );
    expect(delivered).toBe(false);
    expect(report).toMatchObject({ outcome: "failed", processAttempts: [{ acknowledged: false }] });
    expect(state.write).toHaveBeenCalledTimes(3);
    expect(Object.isFrozen(report.processAttempts)).toBe(true);
    expect(Object.isFrozen(report.processAttempts![0])).toBe(true);
  });
  it("retains an acknowledged command when subsequent work fails", async () => {
    state.mode = "directory-process-valid";
    const report = await withOwnedWindowsBoundaryDirectory(
      options(),
      { path: "D:\\fixture", workTimeoutMs: 15_000 },
      async (scope) => {
        const result = await scope.runProcess({
          executable: "C:\\fixture.exe",
          args: [],
          environment: "inherit-helper",
          timeoutMs: 100,
          maxOutputBytes: 1,
        });
        expect(Buffer.from(result.stdout).toString()).toBe("a");
        throw new Error("Later work failed");
      }
    );
    expect(report).toMatchObject({
      reason: "work_failed",
      processAttempts: [{ acknowledged: true, status: "exited" }],
    });
  });
  it("rejects unsupported environment options before process dispatch", async () => {
    state.mode = "directory-process-valid";
    const report = await withOwnedWindowsBoundaryDirectory(
      options(),
      { path: "D:\\fixture", workTimeoutMs: 15_000 },
      async (scope) => {
        await scope.runProcess({
          executable: "C:\\fixture.exe",
          args: [],
          environment: "inherit-helper",
          timeoutMs: 100,
          maxOutputBytes: 1,
          env: {},
        } as any);
      }
    );
    expect(report).toMatchObject({ reason: "work_failed", processAttempts: [] });
    expect(state.write).toHaveBeenCalledTimes(2);
  });
  it.each([
    "wrong-length",
    "wrong-digest",
    "wrong-token",
    "wrong-volume",
    "wrong-operation",
    "wrong-kind",
  ])("retains unknown creation after %s reply", async (mode) => {
    state.mode = `directory-create-${mode}`;
    const report = await withOwnedWindowsBoundaryDirectory(
      options(),
      { path: "D:\\fixture" },
      async (root) => {
        await root.createFile("file", Buffer.from("a"));
      }
    );
    expect(report).toMatchObject({
      reason: "protocol_error",
      directory: { filesCreated: 0, releaseAcknowledged: false },
      fileCreations: [
        { component: "file", byteLength: 1, acknowledged: false, parent: { path: "D:\\fixture" } },
      ],
      sessionOperations: { failure: { outstanding: { operation_id: expect.any(String) } } },
    });
    expect(report.fileCreations![0].operationId).toBe(
      report.sessionOperations!.failure!.outstanding!.operation_id
    );
  });
  it("retains creation intent when the acknowledgment is missing, without retry", async () => {
    state.mode = "directory-create-silent";
    const report = await withOwnedWindowsBoundaryDirectory(
      { ...options(), handshakeTimeoutMs: 500 },
      { path: "D:\\fixture" },
      async (root) => {
        await root.createFile("file", Buffer.from("a"));
      }
    );
    expect(report).toMatchObject({
      reason: "operation_timeout",
      fileCreations: [{ acknowledged: false }],
      directory: { filesCreated: 0 },
    });
    expect(state.write).toHaveBeenCalledTimes(3);
    expect(Object.isFrozen(report.fileCreations)).toBe(true);
    expect(Object.isFrozen(report.fileCreations![0])).toBe(true);
    expect(Object.isFrozen(report.fileCreations![0].parent)).toBe(true);
  });
  it.each([
    "wrong-length",
    "noncanonical",
    "wrong-digest",
    "wrong-token",
    "wrong-volume",
    "wrong-operation",
    "wrong-kind",
    "over-bound",
  ])("rejects file %s before delivering content", async (mode) => {
    state.mode = `directory-file-${mode}`;
    let delivered = false;
    const report = await withOwnedWindowsBoundaryDirectory(
      options(),
      { path: "D:\\fixture" },
      async (root) => {
        await root.readFile("file", mode === "over-bound" ? 0 : 1);
        delivered = true;
      }
    );
    expect(delivered).toBe(false);
    expect(report).toMatchObject({
      reason: "protocol_error",
      directory: { filesRead: 0, bytesRead: 0, releaseAcknowledged: false },
      sessionOperations: { failure: { outstanding: { operation_id: expect.any(String) } } },
    });
  });
  it("retains an unanswered file request without retry", async () => {
    state.mode = "directory-file-silent";
    const report = await withOwnedWindowsBoundaryDirectory(
      { ...options(), handshakeTimeoutMs: 500 },
      { path: "D:\\fixture" },
      async (root) => {
        await root.readFile("file", 1);
      }
    );
    expect(report).toMatchObject({
      reason: "operation_timeout",
      directory: { filesRead: 0 },
      sessionOperations: {
        requested: 2,
        correlated: 1,
        failure: { outstanding: { operation_id: expect.any(String) } },
      },
    });
    expect(state.write).toHaveBeenCalledTimes(3);
  });
  it.each(["reused-token", "wrong-path", "false-missing"])(
    "rejects child %s before exposing a scope",
    async (mode) => {
      state.mode = `directory-child-${mode}`;
      const report = await withOwnedWindowsBoundaryDirectory(
        options(),
        { path: "D:\\fixture" },
        async (root) => {
          await root.openChild("child");
        }
      );
      expect(report).toMatchObject({
        reason: "protocol_error",
        directory: { childrenAcquired: 0, releaseAcknowledged: false },
        sessionOperations: { failure: { outstanding: { operation_id: expect.any(String) } } },
      });
    }
  );
  it("does not claim all scopes released when a child release reply is lost", async () => {
    state.mode = "directory-child-lost-release";
    const report = await withOwnedWindowsBoundaryDirectory(
      { ...options(), handshakeTimeoutMs: 500 },
      { path: "D:\\fixture" },
      async (root) => {
        await root.openChild("child");
      }
    );
    expect(report).toMatchObject({
      reason: "operation_timeout",
      directory: { childrenAcquired: 1, childrenReleased: 0, releaseAcknowledged: false },
      sessionOperations: { requested: 3, correlated: 2 },
      cleanup: { exitCode: 0 },
    });
    expect(state.write).toHaveBeenCalledTimes(4);
  });
  it.each(["wrong-status", "changed-identity", "wrong-token"])(
    "rejects directory %s before acknowledging it",
    async (mode) => {
      state.mode = `directory-${mode}`;
      const report = await withOwnedWindowsBoundaryDirectory(
        options(),
        { path: "D:\\fixture" },
        async (scope) => {
          await scope.assertCurrent();
        }
      );
      expect(report).toMatchObject({
        outcome: "failed",
        reason: "protocol_error",
        directory: { releaseAcknowledged: false },
        sessionOperations: {
          failure: {
            disposition: "reconciliation_required",
            outstanding: { operation_id: expect.any(String) },
          },
        },
      });
    }
  );
  it("retains a lost release request instead of treating clean exit as acknowledgment", async () => {
    state.mode = "directory-lost-release";
    const report = await withOwnedWindowsBoundaryDirectory(
      { ...options(), handshakeTimeoutMs: 500 },
      { path: "D:\\fixture" },
      async () => {}
    );
    expect(report).toMatchObject({
      reason: "operation_timeout",
      directory: { acquired: true, releaseAcknowledged: false },
      sessionOperations: {
        requested: 2,
        correlated: 1,
        failure: { outstanding: { operation_id: expect.any(String) } },
      },
      cleanup: { exitCode: 0 },
    });
    expect(state.write).toHaveBeenCalledTimes(3);
  });
  it("rejects invalid directory options before spawning", async () => {
    expect(
      await withOwnedWindowsBoundaryDirectory(options(), { path: "relative" }, async () => {})
    ).toMatchObject({ reason: "invalid_options" });
    expect(state.calls).toHaveLength(0);
  });
  it("times out an unanswered operation and retains its unknown outcome", async () => {
    // This controlled peer answers hello but deliberately ignores later requests.
    const report = await probeOwnedWindowsBoundarySession(
      { ...options(), handshakeTimeoutMs: 500 },
      2
    );
    expect(report).toMatchObject({
      outcome: "failed",
      reason: "operation_timeout",
      sessionOperations: {
        requested: 2,
        correlated: 0,
        failure: {
          disposition: "reconciliation_required",
          outstanding: { operation_id: expect.any(String) },
        },
      },
      cleanup: { disposition: "closed", processExited: true },
    });
    expect(state.write).toHaveBeenCalledTimes(2); // Hello and one operation; no resend.
  });
  it("does not count clean child exit as completion of an outstanding operation", async () => {
    state.mode = "session-exit";
    const report = await probeOwnedWindowsBoundarySession(options(), 2);
    expect(report).toMatchObject({
      outcome: "failed",
      reason: "child_exit",
      sessionOperations: {
        correlated: 0,
        failure: { outstanding: { request_id: expect.any(String) } },
      },
      cleanup: { exitCode: 0 },
    });
    expect(state.write).toHaveBeenCalledTimes(2);
  });
  it("rejects session budgets before spawning", async () => {
    expect(await probeOwnedWindowsBoundarySession(options(), 16)).toMatchObject({
      reason: "invalid_options",
    });
    expect(state.calls).toHaveLength(0);
  });
  it("checks the elapsed deadline even before the timer callback runs", async () => {
    const now = performance.now();
    const clock = vi.spyOn(performance, "now").mockReturnValue(now);
    const pending = probeOwnedWindowsBoundaryHandshake(options());
    clock.mockReturnValue(now + 3_000);
    const report = await pending;
    expect(report).toMatchObject({
      reason: "handshake_timeout",
      cleanup: { disposition: "closed" },
    });
    expect(state.write).not.toHaveBeenCalled();
  });
  it("generates a distinct cryptographic client nonce and request identity per launch", async () => {
    await probeOwnedWindowsBoundaryHandshake(options());
    const first = JSON.parse(state.write.mock.calls[0][0].subarray(4).toString("utf8"));
    await probeOwnedWindowsBoundaryHandshake(options());
    const second = JSON.parse(state.write.mock.calls[0][0].subarray(4).toString("utf8"));
    expect(first.client_nonce).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.client_nonce).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.client_nonce).not.toBe(first.client_nonce);
    expect(second.request_id).not.toBe(first.request_id);
    expect(state.calls).toHaveLength(2);
  });
  it("handles asynchronous executable-not-found without claiming an exited process", async () => {
    state.mode = "async-spawn-error";
    expect(await probeOwnedWindowsBoundaryHandshake(options())).toMatchObject({
      reason: "spawn_error",
      cleanup: { disposition: "not_started", processExited: false },
    });
  });
  it("finalizes truncated bytes when close arrives without a stdout end event", async () => {
    state.mode = "fake";
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      unref: vi.fn(),
    });
    state.child = child;
    const pending = probeOwnedWindowsBoundaryHandshake(options());
    child.emit("spawn");
    child.stdout.write(Buffer.from([0, 0]));
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    expect(await pending).toMatchObject({
      reason: "protocol_error",
      cleanup: { disposition: "closed", processExited: true },
    });
    expect(child.kill).not.toHaveBeenCalled();
  });
  it.each(["valid", "fragmented"])(
    "matches %s real peer and observes process/pipe closure",
    async (mode) => {
      state.mode = mode;
      const report = await probeOwnedWindowsBoundaryHandshake(options());
      expect(report).toMatchObject({
        outcome: "matched",
        verification: "not_performed",
        helloMatched: true,
        cleanup: {
          disposition: "closed",
          processExited: true,
          terminationRequested: false,
          exitCode: 0,
          descendants: "not_assessed",
        },
      });
      expect(report.sessionNonceSha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(state.calls).toHaveLength(1);
    }
  );
  it("uses fixed argv, fresh pipes and a restricted child environment", async () => {
    vi.stubEnv("NODE_OPTIONS", "--require=do-not-load-this");
    vi.stubEnv("LD_PRELOAD", "/do-not-load-this");
    vi.stubEnv("PRIVATE_TEST_SECRET", "must-not-be-forwarded");
    expect((await probeOwnedWindowsBoundaryHandshake(options())).outcome).toBe("matched");
    expect(state.calls[0][1]).toEqual(["--boundary-protocol", "1.0.0"]);
    const launch = state.calls[0][2] as any;
    expect(launch).toMatchObject({
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(
      Object.keys(launch.env).every((key) =>
        ["SYSTEMROOT", "WINDIR", "TEMP", "TMP"].includes(key.toUpperCase())
      )
    ).toBe(true);
  });
  it.each([
    ["wrong-pid", "metadata_mismatch"],
    ["wrong-nonce", "metadata_mismatch"],
    ["wrong-digest", "metadata_mismatch"],
    ["duplicate", "protocol_error"],
    ["trailing-partial", "protocol_error"],
    ["partial", "protocol_error"],
    ["garbage", "protocol_error"],
    ["early-exit", "child_exit"],
    ["stderr-overflow", "output_limit"],
  ])("rejects %s and waits for cleanup", async (mode, reason) => {
    state.mode = mode;
    const report = await probeOwnedWindowsBoundaryHandshake(options());
    expect(report).toMatchObject({
      outcome: "failed",
      reason,
      verification: "not_performed",
      cleanup: { disposition: "closed", processExited: true },
    });
  });
  it("rejects a natural nonzero exit without requesting termination", async () => {
    state.mode = "nonzero-exit";
    expect(await probeOwnedWindowsBoundaryHandshake(options())).toMatchObject({
      outcome: "failed",
      reason: "child_exit",
      verification: "not_performed",
      helloMatched: true,
      cleanup: {
        disposition: "closed",
        processExited: true,
        terminationRequested: false,
        exitCode: 7,
        signal: null,
      },
    });
  });
  it("retains a matched hello as evidence but fails if graceful shutdown needs termination", async () => {
    state.mode = "ignore-eof";
    expect(
      await probeOwnedWindowsBoundaryHandshake({ ...options(), closeTimeoutMs: 100 })
    ).toMatchObject({
      outcome: "failed",
      reason: "cleanup_forced",
      helloMatched: true,
      cleanup: { disposition: "closed", terminationRequested: true, processExited: true },
    });
  });
  it("times out and closes a silent real child without resending", async () => {
    state.mode = "silent";
    expect(
      await probeOwnedWindowsBoundaryHandshake({ ...options(), handshakeTimeoutMs: 100 })
    ).toMatchObject({
      outcome: "failed",
      reason: "handshake_timeout",
      cleanup: { disposition: "closed" },
    });
    expect(state.calls).toHaveLength(1);
  });
  it("does not spawn for invalid options or prior cancellation", async () => {
    expect(
      await probeOwnedWindowsBoundaryHandshake({ ...options(), executable: "relative" })
    ).toMatchObject({ reason: "invalid_options", cleanup: { disposition: "not_started" } });
    expect(await probeOwnedWindowsBoundaryHandshake(options(), AbortSignal.abort())).toMatchObject({
      reason: "cancelled",
      cleanup: { disposition: "not_started" },
    });
    expect(state.calls).toHaveLength(0);
  });
  it("cancels a waiting child and retains explicit closure", async () => {
    state.mode = "silent";
    const controller = new AbortController();
    const pending = probeOwnedWindowsBoundaryHandshake(options(), controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({
      reason: "cancelled",
      cleanup: { disposition: "closed" },
    });
  });
  it("reports synchronous spawn failure without private diagnostics", async () => {
    state.mode = "spawn-throws";
    const report = await probeOwnedWindowsBoundaryHandshake(options());
    expect(report).toMatchObject({
      reason: "spawn_error",
      cleanup: { disposition: "not_started" },
    });
    expect(JSON.stringify(report)).not.toContain("private");
  });
  it("bounds cleanup when the owned handle cannot confirm exit or pipe closure", async () => {
    state.mode = "fake";
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => false),
      unref: vi.fn(),
    });
    state.child = child;
    const pending = probeOwnedWindowsBoundaryHandshake({
      ...options(),
      handshakeTimeoutMs: 10,
      closeTimeoutMs: 10,
      killTimeoutMs: 10,
    });
    child.emit("spawn");
    const report = await pending;
    expect(report).toMatchObject({
      reason: "handshake_timeout",
      cleanup: { disposition: "unknown", processExited: false, terminationRequested: true },
    });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(child.stdout.destroyed).toBe(true);
  });
});
