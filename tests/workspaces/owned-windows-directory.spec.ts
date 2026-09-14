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
        for (let i = 0; i < 13; i++) await scope.assertCurrent();
      }
    );
    expect(report).toMatchObject({
      outcome: "matched",
      directory: { assertions: 13, releaseAcknowledged: true },
      sessionOperations: { requested: 15, correlated: 15 },
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
      directory: { releaseAcknowledged: false },
      cleanup: { disposition: "closed" },
    });
    await expect(retained!.assertCurrent()).rejects.toThrow();
    await rename(f.directory, f.directory + "-released");
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
