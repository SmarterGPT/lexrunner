import { projectOwnedWindowsProcessReceipt } from "../../src/workspaces/owned-windows-process-receipt.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  withOwnedWindowsBoundaryDirectory,
  type OwnedWindowsDirectoryScope,
} from "../../src/workspaces/owned-windows-boundary-handshake.js";

const executable = process.env.LEXRUNNER_TEST_NATIVE_HELPER;
const artifacts = path.resolve("artifacts");
const roots: string[] = [];
async function fixture() {
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(path.join(artifacts, "owned-directory-"));
  roots.push(root);
  const directory = path.join(root, "café");
  await mkdir(directory);
  return {
    root,
    directory,
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
    if (path.dirname(root) !== artifacts || !path.basename(root).startsWith("owned-directory-"))
      throw new Error("Invalid cleanup root");
    await rm(root, { recursive: true, force: true });
  }
});
describe.skipIf(process.platform !== "win32" || !executable)("owned native directory scope", () => {
  it("admits repeated 30-second command budgets within an explicit five-minute work window", async () => {
    const f = await fixture();
    const report = await withOwnedWindowsBoundaryDirectory(
      f.options,
      { path: f.directory, workTimeoutMs: 300_000 },
      async (scope) => {
        for (let i = 0; i < 2; i++) {
          const result = await scope.runProcess({
            executable: process.execPath,
            args: [
              { kind: "literal", value: "-e" },
              { kind: "literal", value: "process.exit(0)" },
            ],
            environment: "inherit-helper",
            timeoutMs: 30_000,
            maxOutputBytes: 1024,
          });
          expect(result.status).toBe("exited");
        }
      }
    );
    expect(report).toMatchObject({
      outcome: "matched",
      directory: { releaseAcknowledged: true },
      sessionOperations: { requested: 4, correlated: 4 },
    });
  });
  it("replaces command environment including Unicode and empty values", async () => {
    const f = await fixture();
    let output: unknown;
    const report = await withOwnedWindowsBoundaryDirectory(
      f.options,
      { path: f.directory, workTimeoutMs: 25_000 },
      async (scope) => {
        const env = { VALUE: "café 🐦", EMPTY: "", SystemRoot: process.env.SystemRoot! };
        const run = scope.runProcess({
          executable: process.execPath,
          args: [
            { kind: "literal", value: "-e" },
            {
              kind: "literal",
              value:
                "process.stdout.write(JSON.stringify([process.env.VALUE,process.env.EMPTY,process.env.TEMP ?? null]))",
            },
          ],
          environment: "replace",
          env,
          timeoutMs: 5_000,
          maxOutputBytes: 1024,
        });
        env.VALUE = "changed after dispatch";
        const result = await run;
        output = JSON.parse(Buffer.from(result.stdout).toString());
      }
    );
    expect(report, JSON.stringify(report)).toMatchObject({ outcome: "matched" });
    expect(output).toEqual(["café 🐦", "", null]);
    expect(JSON.stringify(report)).not.toContain("café 🐦");
  });
  it("rejects a numeric environment name before process dispatch", async () => {
    const f = await fixture();
    const report = await withOwnedWindowsBoundaryDirectory(
      f.options,
      { path: f.directory, workTimeoutMs: 25_000 },
      async (scope) => {
        await scope.runProcess({
          executable: process.execPath,
          args: [],
          environment: "replace",
          env: { "2": "two" },
          timeoutMs: 5_000,
          maxOutputBytes: 1024,
        });
      }
    );
    expect(report).toMatchObject({ outcome: "failed", reason: "work_failed", processAttempts: [] });
  });
  it("supports an explicitly empty command environment", async () => {
    expect(process.env.TEMP).toBeTruthy();
    const f = await fixture();
    let inherited: Awaited<ReturnType<OwnedWindowsDirectoryScope["runProcess"]>> | undefined;
    let result: Awaited<ReturnType<OwnedWindowsDirectoryScope["runProcess"]>> | undefined;
    const report = await withOwnedWindowsBoundaryDirectory(
      f.options,
      { path: f.directory, workTimeoutMs: 25_000 },
      async (scope) => {
        result = await scope.runProcess({
          executable: process.env.ComSpec!,
          args: [
            { kind: "literal", value: "/d" },
            { kind: "literal", value: "/c" },
            { kind: "literal", value: "set" },
            { kind: "literal", value: "TEMP" },
          ],
          environment: "replace",
          env: {},
          timeoutMs: 5_000,
          maxOutputBytes: 1024,
        });
        inherited = await scope.runProcess({
          executable: process.env.ComSpec!,
          args: [
            { kind: "literal", value: "/d" },
            { kind: "literal", value: "/c" },
            { kind: "literal", value: "set" },
            { kind: "literal", value: "TEMP" },
          ],
          environment: "inherit-helper",
          timeoutMs: 5_000,
          maxOutputBytes: 1024,
        });
      }
    );
    expect(report, JSON.stringify(report)).toMatchObject({ outcome: "matched" });
    expect(result).toMatchObject({ status: "nonzero_exit", exitCode: 1 });
    expect(Buffer.from(result!.stdout).toString()).not.toMatch(/^TEMP=/im);
    expect(Buffer.from(inherited!.stdout).toString()).toMatch(/^TEMP=/im);
    expect(inherited).toMatchObject({ status: "exited", exitCode: 0 });
  });
  it.each([0, 7])(
    "runs a native command through the owned scope with exit %i",
    async (exitCode) => {
      let command: Awaited<ReturnType<OwnedWindowsDirectoryScope["runProcess"]>> | undefined;
      const f = await fixture();
      const report = await withOwnedWindowsBoundaryDirectory(
        f.options,
        { path: f.directory, workTimeoutMs: 25_000 },
        async (scope) => {
          const result = await scope.runProcess({
            executable: process.execPath,
            args: [
              { kind: "literal", value: "-e" },
              {
                kind: "literal",
                value: `process.stdout.write(process.cwd());process.exitCode=${exitCode}`,
              },
            ],
            environment: "inherit-helper",
            timeoutMs: 5_000,
            maxOutputBytes: 1024,
          });
          command = result;
          expect(result.exitCode).toBe(exitCode);
          expect(result.status).toBe(exitCode ? "nonzero_exit" : "exited");
          expect(Buffer.from(result.stdout).toString()).toBe(f.directory);
          await scope.assertCurrent();
        }
      );
      const projection = projectOwnedWindowsProcessReceipt(
        {
          leaseId: "development-lease",
          startedAt: "2026-09-15T05:00:00.000Z",
          completedAt: "2026-09-15T05:01:00.000Z",
        },
        report.processAttempts![0],
        command
      );
      expect(report.processAttempts![0]).toMatchObject({
        boundaryLeaseId: expect.any(String),
        startedAt: expect.any(String),
        observedAt: expect.any(String),
      });
      expect(Date.parse(report.processAttempts![0].observedAt!)).toBeGreaterThanOrEqual(
        Date.parse(report.processAttempts![0].startedAt)
      );
      expect(projection).toMatchObject({
        ok: true,
        value: { ok: exitCode === 0, exitCode },
        receipt: { outcome: "completed" },
      });
      expect(report).toMatchObject({
        outcome: "matched",
        processAttempts: [{ acknowledged: true }],
        directory: { releaseAcknowledged: true },
      });
    }
  );
  it("renders live directory arguments and permits a later command after timeout", async () => {
    const f = await fixture();
    const report = await withOwnedWindowsBoundaryDirectory(
      f.options,
      { path: f.directory, workTimeoutMs: 30_000 },
      async (scope) => {
        const timed = await scope.runProcess({
          executable: process.execPath,
          args: [
            { kind: "literal", value: "-e" },
            { kind: "literal", value: "setInterval(()=>{},1000)" },
          ],
          environment: "inherit-helper",
          timeoutMs: 100,
          maxOutputBytes: 128,
        });
        expect(timed.status).toBe("timeout");
        const result = await scope.runProcess({
          executable: process.execPath,
          args: [
            { kind: "literal", value: "-e" },
            { kind: "literal", value: "process.stdout.write(process.argv[1])" },
            { kind: "directory", directory: scope, prefix: "", relativeToCwd: true },
          ],
          environment: "inherit-helper",
          timeoutMs: 5_000,
          maxOutputBytes: 128,
        });
        expect(Buffer.from(result.stdout).toString()).toBe(".");
      }
    );
    expect(report).toMatchObject({
      outcome: "matched",
      processAttempts: [
        { acknowledged: true, status: "timeout" },
        { acknowledged: true, status: "exited" },
      ],
    });
  });
  it.each([16_384, 65_536])("round trips %i bytes through the owned transport", async (size) => {
    const f = await fixture();
    const data = Buffer.from(Array.from({ length: size }, (_, i) => i % 256));
    const report = await withOwnedWindowsBoundaryDirectory(
      f.options,
      { path: f.directory },
      async (scope) => {
        const created = await scope.createFile("marker", data);
        const read = await scope.readFile("marker", size);
        expect(Buffer.from(read.bytes)).toEqual(data);
        expect(read.contentSha256).toBe(created.contentSha256);
      }
    );
    expect(report).toMatchObject({
      outcome: "matched",
      directory: { filesCreated: 1, filesRead: 1, releaseAcknowledged: true },
    });
  });
  it("creates from a private byte copy through a child scope", async () => {
    const f = await fixture();
    const original = Buffer.from([0, 255, 1]);
    const mutable = Buffer.from(original);
    const report = await withOwnedWindowsBoundaryDirectory(
      f.options,
      { path: f.directory },
      async (root) => {
        const child = await root.createChild("nested");
        const pending = child.createFile("file", mutable);
        mutable.fill(99);
        const created = await pending;
        const read = await child.readFile("file", 3);
        expect(Buffer.from(read.bytes)).toEqual(original);
        expect(created.contentSha256).toBe(read.contentSha256);
        expect(created.fileId).toBe(read.fileId);
      }
    );
    expect(report).toMatchObject({
      outcome: "matched",
      directory: { filesCreated: 1, releaseAcknowledged: true },
      fileCreations: [{ byteLength: 3, acknowledged: true, component: "file" }],
    });
  });
  it("creates an empty file", async () => {
    const f = await fixture();
    const report = await withOwnedWindowsBoundaryDirectory(
      f.options,
      { path: f.directory },
      async (root) => {
        expect((await root.createFile("empty", new Uint8Array())).byteLength).toBe(0);
      }
    );
    expect(report).toMatchObject({
      outcome: "matched",
      fileCreations: [{ byteLength: 0, acknowledged: true }],
    });
  });
  it("preserves an existing file and the unacknowledged creation record", async () => {
    const f = await fixture();
    await writeFile(path.join(f.directory, "existing"), "coworker content");
    const report = await withOwnedWindowsBoundaryDirectory(
      f.options,
      { path: f.directory },
      async (root) => {
        await root.createFile("existing", Buffer.from("replacement"));
      }
    );
    expect(readFileSync(path.join(f.directory, "existing"), "utf8")).toBe("coworker content");
    expect(report).toMatchObject({
      outcome: "failed",
      directory: { filesCreated: 0 },
      fileCreations: [{ acknowledged: false, component: "existing" }],
    });
  });
  it("rejects oversized input before recording or sending a creation", async () => {
    const f = await fixture();
    const report = await withOwnedWindowsBoundaryDirectory(
      f.options,
      { path: f.directory },
      async (root) => {
        await root.createFile("large", new Uint8Array(65_537));
      }
    );
    expect(report).toMatchObject({
      reason: "work_failed",
      fileCreations: [],
      sessionOperations: { requested: 1, correlated: 1 },
    });
  });
  it("keeps a matched creation historical when subsequent caller work fails", async () => {
    const f = await fixture();
    const report = await withOwnedWindowsBoundaryDirectory(
      f.options,
      { path: f.directory },
      async (root) => {
        await root.createFile("kept", Buffer.from("completed write"));
        throw new Error("later work failed");
      }
    );
    expect(report).toMatchObject({
      reason: "work_failed",
      fileCreations: [{ acknowledged: true }],
      directory: { filesCreated: 1, releaseAcknowledged: false },
    });
    expect(readFileSync(path.join(f.directory, "kept"), "utf8")).toBe("completed write");
  });
  it("reads binary content from a nested scope with independent caller bytes", async () => {
    const f = await fixture();
    await mkdir(path.join(f.directory, "nested"));
    const data = Buffer.from([0, 255, 1, 128]);
    await writeFile(path.join(f.directory, "nested", "résumé.bin"), data);
    let retained: OwnedWindowsDirectoryScope | undefined;
    const report = await withOwnedWindowsBoundaryDirectory(
      f.options,
      { path: f.directory },
      async (root) => {
        retained = await root.openChild("nested");
        const read = await retained.readFile("résumé.bin", 4);
        expect(Buffer.from(read.bytes)).toEqual(data);
        expect(read.contentSha256).toBe(
          `sha256:${createHash("sha256").update(data).digest("hex")}`
        );
        expect(read.fileId).toMatch(/^[a-f0-9]{32}$/u);
        expect(read.volumeSerialNumber).toBe(retained.identity.volume_serial_number);
        read.bytes[0] = 99;
        expect(Buffer.from((await retained.readFile("résumé.bin", 4)).bytes)).toEqual(data);
      }
    );
    expect(report).toMatchObject({
      outcome: "matched",
      directory: { filesRead: 2, bytesRead: 8, childrenReleased: 1, releaseAcknowledged: true },
    });
    await expect(retained!.readFile("résumé.bin", 4)).rejects.toThrow("scope ended");
    await rename(f.directory, f.directory + "-released");
  });
  it("reads an empty file with a zero bound", async () => {
    const f = await fixture();
    await writeFile(path.join(f.directory, "empty"), "");
    const report = await withOwnedWindowsBoundaryDirectory(
      f.options,
      { path: f.directory },
      async (root) => {
        expect((await root.readFile("empty", 0)).bytes.length).toBe(0);
      }
    );
    expect(report).toMatchObject({ outcome: "matched", directory: { filesRead: 1, bytesRead: 0 } });
  });
  it("fails an unawaited read and retains its outstanding request", async () => {
    const f = await fixture();
    await writeFile(path.join(f.directory, "file"), "a");
    const report = await withOwnedWindowsBoundaryDirectory(
      f.options,
      { path: f.directory },
      async (root) => {
        void root.readFile("file", 1);
      }
    );
    expect(report).toMatchObject({
      reason: "work_failed",
      directory: { releaseAcknowledged: false },
      sessionOperations: { failure: { outstanding: { operation_id: expect.any(String) } } },
    });
  });
  it("opens and creates nested child scopes and acknowledges every release", async () => {
    const f = await fixture();
    await mkdir(path.join(f.directory, "existing"));
    let retained: OwnedWindowsDirectoryScope | undefined;
    const report = await withOwnedWindowsBoundaryDirectory(
      f.options,
      { path: f.directory },
      async (root) => {
        expect(await root.tryOpenChild("absent")).toBeNull();
        const existing = await root.openChild("existing");
        retained = await existing.createChild("nested");
        expect(await retained.assertCurrent()).toEqual(retained.identity);
        await writeFile(path.join(retained.identity.path, "work.txt"), "child work");
        await expect(rename(f.directory, f.directory + "-moved")).rejects.toThrow();
      }
    );
    expect(report).toMatchObject({
      outcome: "matched",
      directory: { childrenAcquired: 2, childrenReleased: 2, releaseAcknowledged: true },
      sessionOperations: { requested: 8, correlated: 8 },
    });
    await expect(retained!.openChild("later")).rejects.toThrow("scope ended");
    await rename(f.directory, f.directory + "-released");
  });
  it("reserves release capacity for all child scopes", async () => {
    const f = await fixture();
    const report = await withOwnedWindowsBoundaryDirectory(
      f.options,
      { path: f.directory },
      async (root) => {
        for (let i = 0; i < 6; i++) await root.createChild(`child-${i}`);
      }
    );
    expect(report).toMatchObject({
      outcome: "matched",
      directory: { childrenAcquired: 6, childrenReleased: 6, releaseAcknowledged: true },
      sessionOperations: { requested: 14, correlated: 14 },
    });
  });
  it("refuses an extra child before sending an unclosable request", async () => {
    const f = await fixture();
    const report = await withOwnedWindowsBoundaryDirectory(
      f.options,
      { path: f.directory },
      async (root) => {
        for (let i = 0; i < 64; i++) await root.createChild(`child-${i}`);
      }
    );
    expect(report).toMatchObject({
      reason: "work_failed",
      directory: { childrenAcquired: 63, childrenReleased: 0, releaseAcknowledged: false },
      sessionOperations: { requested: 64, correlated: 64 },
    });
    await rename(f.directory, f.directory + "-released");
  });
  it("holds across caller work and revalidation, acknowledges release and expires the scope", async () => {
    const f = await fixture();
    let retained: OwnedWindowsDirectoryScope | undefined;
    const report = await withOwnedWindowsBoundaryDirectory(
      f.options,
      { path: f.directory },
      async (scope) => {
        retained = scope;
        await expect(rename(f.directory, f.directory + "-moved")).rejects.toThrow();
        await writeFile(path.join(f.directory, "work.txt"), "ordinary caller work");
        expect(await scope.assertCurrent()).toEqual(scope.identity);
        expect(Object.isFrozen(scope.identity)).toBe(true);
      }
    );
    expect(report).toMatchObject({
      outcome: "matched",
      verification: "not_performed",
      directory: { acquired: true, assertions: 1, releaseAcknowledged: true },
      sessionOperations: { requested: 3, correlated: 3 },
      cleanup: { disposition: "closed", exitCode: 0 },
    });
    await rename(f.directory, f.directory + "-released");
    await expect(retained!.assertCurrent()).rejects.toThrow("scope ended");
  });
  it("reserves the final operation for release at the assertion budget", async () => {
    const f = await fixture();
    const report = await withOwnedWindowsBoundaryDirectory(
      f.options,
      { path: f.directory },
      async (scope) => {
        for (let i = 0; i < 126; i++) await scope.assertCurrent();
      }
    );
    expect(report).toMatchObject({
      outcome: "matched",
      directory: { assertions: 126, releaseAcknowledged: true },
      sessionOperations: { requested: 128, correlated: 128 },
    });
  });
  it("fails caller exceptions without claiming an acknowledged release", async () => {
    const f = await fixture();
    const report = await withOwnedWindowsBoundaryDirectory(
      f.options,
      { path: f.directory },
      async () => {
        throw new Error("private diagnostic");
      }
    );
    expect(report).toMatchObject({
      outcome: "failed",
      reason: "work_failed",
      directory: { acquired: true, releaseAcknowledged: false },
      cleanup: { disposition: "closed", exitCode: 0 },
    });
    expect(JSON.stringify(report)).not.toContain("private diagnostic");
    await rename(f.directory, f.directory + "-released");
  });
  it("bounds unfinished caller work and invalidates its retained scope", async () => {
    const f = await fixture();
    let retained: OwnedWindowsDirectoryScope | undefined;
    const report = await withOwnedWindowsBoundaryDirectory(
      f.options,
      { path: f.directory, workTimeoutMs: 50 },
      async (scope) => {
        retained = scope;
        await new Promise<void>(() => {});
      }
    );
    expect(report).toMatchObject({
      reason: "work_timeout",
      deadline: { graceExpired: false },
      directory: { releaseAcknowledged: true },
      cleanup: { disposition: "closed" },
    });
    await expect(retained!.assertCurrent()).rejects.toThrow();
    await rename(f.directory, f.directory + "-released");
  });
  it("releases child and root capabilities gracefully at the work deadline", async () => {
    const f = await fixture();
    const report = await withOwnedWindowsBoundaryDirectory(
      f.options,
      { path: f.directory, workTimeoutMs: 100 },
      async (scope) => {
        await scope.createChild("child");
        await new Promise<void>(() => {});
      }
    );
    expect(report).toMatchObject({
      outcome: "failed",
      reason: "work_timeout",
      deadline: { graceExpired: false },
      directory: { childrenReleased: 1, releaseAcknowledged: true },
      cleanup: { terminationRequested: false, exitCode: 0 },
    });
  });
  it("supports zero grace without claiming native release acknowledgment", async () => {
    const f = await fixture();
    const report = await withOwnedWindowsBoundaryDirectory(
      f.options,
      { path: f.directory, workTimeoutMs: 50, deadlineGraceMs: 0 },
      async () => new Promise<void>(() => {})
    );
    expect(report).toMatchObject({
      outcome: "failed",
      reason: "work_timeout",
      deadline: { graceMs: 0, graceExpired: true },
      directory: { releaseAcknowledged: false },
    });
  });
  it("does not restart the grace budget after a blocked event loop", async () => {
    const f = await fixture();
    const report = await withOwnedWindowsBoundaryDirectory(
      f.options,
      { path: f.directory, workTimeoutMs: 20, deadlineGraceMs: 20 },
      async () => {
        const until = performance.now() + 100;
        while (performance.now() < until) {
          /* controlled event-loop delay */
        }
      }
    );
    expect(report).toMatchObject({
      outcome: "failed",
      reason: "work_timeout",
      deadline: { graceExpired: true },
      directory: { releaseAcknowledged: false },
    });
  });
  it("cancels an acquired scope and observes helper cleanup", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const report = await withOwnedWindowsBoundaryDirectory(
      f.options,
      { path: f.directory },
      async () => {
        controller.abort();
      },
      controller.signal
    );
    expect(report).toMatchObject({
      reason: "cancelled",
      directory: { acquired: true, releaseAcknowledged: false },
      cleanup: { disposition: "closed" },
    });
    await rename(f.directory, f.directory + "-released");
  });
  it("rejects concurrent assertions and preserves the outstanding request", async () => {
    const f = await fixture();
    const report = await withOwnedWindowsBoundaryDirectory(
      f.options,
      { path: f.directory },
      async (scope) => {
        await Promise.all([scope.assertCurrent(), scope.assertCurrent()]);
      }
    );
    expect(report).toMatchObject({
      reason: "work_failed",
      directory: { releaseAcknowledged: false },
      sessionOperations: { failure: { outstanding: { operation_id: expect.any(String) } } },
    });
    await rename(f.directory, f.directory + "-released");
  });
  it("fails an unawaited assertion without an unhandled rejection", async () => {
    const f = await fixture();
    const report = await withOwnedWindowsBoundaryDirectory(
      f.options,
      { path: f.directory },
      async (scope) => {
        void scope.assertCurrent();
      }
    );
    expect(report).toMatchObject({
      reason: "work_failed",
      directory: { releaseAcknowledged: false },
      sessionOperations: { failure: { outstanding: { operation_id: expect.any(String) } } },
    });
    await rename(f.directory, f.directory + "-released");
  });
});
