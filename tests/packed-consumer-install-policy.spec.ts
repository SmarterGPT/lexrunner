import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPackedConsumerManifest,
  packedConsumerInstallArguments,
  servePackedTarball,
  reviewPackedArtifactLifecycle,
  runOwnedPackedInstallCommand,
  ownedNpmLifecycleEnvironment,
  observePackedArtifactPostinstall,
} from "../scripts/packed-consumer-install-policy.mjs";

const sourceManifest = {
  name: "@smartergpt/lexrunner",
  scripts: JSON.parse(
    fs.readFileSync(path.resolve(import.meta.dirname, "..", "package.json"), "utf8")
  ).scripts,
  allowScripts: {
    "better-sqlite3-multiple-ciphers@12.11.1": true,
    "esbuild@0.28.1": true,
    "@smartergpt/lex": false,
  },
};
const tarballSpecifier = "http://127.0.0.1:12345/packed-candidate.tgz";

describe("packed consumer install-script boundary", () => {
  it("retains the Lex denial and exact native approvals in the consumer that owns installation", () => {
    const manifest = createPackedConsumerManifest(sourceManifest, tarballSpecifier);
    const dependency = manifest.dependencies[sourceManifest.name];
    expect(dependency).toBe(tarballSpecifier);
    expect(manifest.allowScripts[dependency]).toBe(true);
    expect(manifest.allowScripts["@smartergpt/lex"]).toBe(false);
    expect(manifest.allowScripts["better-sqlite3-multiple-ciphers@12.11.1"]).toBe(true);
    expect(Object.keys(sourceManifest.allowScripts)).toHaveLength(3);
  });

  it("fails before installation if the source Lex denial is missing or changed", () => {
    for (const denial of [undefined, true]) {
      expect(() =>
        createPackedConsumerManifest(
          {
            ...sourceManifest,
            allowScripts: { ...sourceManifest.allowScripts, "@smartergpt/lex": denial },
          },
          tarballSpecifier
        )
      ).toThrow("reviewed @smartergpt/lex script denial");
    }
  });

  it("refuses lifecycle edits before approving any packed artifact script", () => {
    for (const scripts of [
      { ...sourceManifest.scripts, postinstall: "node arbitrary-script.mjs" },
      { ...sourceManifest.scripts, prepare: "node arbitrary-script.mjs" },
      { ...sourceManifest.scripts, install: "node arbitrary-script.mjs" },
    ]) {
      expect(() => reviewPackedArtifactLifecycle({ ...sourceManifest, scripts })).toThrow(
        "differs from the reviewed"
      );
    }
  });

  it("refuses approval for an unowned or ambiguous remote tarball URL", () => {
    for (const specifier of [
      "https://example.com/candidate.tgz",
      "file:../candidate.tgz",
      "http://127.0.0.1:1234/candidate.tgz?other=artifact",
    ]) {
      expect(() => createPackedConsumerManifest(sourceManifest, specifier)).toThrow();
    }
  });

  it("rejects broad or range approvals rather than changing consumer permission", () => {
    for (const specifier of ["better-sqlite3-multiple-ciphers", "esbuild@*", "esbuild@^0.28.1"]) {
      expect(() =>
        createPackedConsumerManifest(
          {
            ...sourceManifest,
            allowScripts: { ...sourceManifest.allowScripts, [specifier]: true },
          },
          tarballSpecifier
        )
      ).toThrow("exact registry script approvals");
    }
  });

  it("rejects absent or malformed source policy", () => {
    for (const allowScripts of [
      undefined,
      [],
      { ...sourceManifest.allowScripts, esbuild: "true" },
    ]) {
      expect(() =>
        createPackedConsumerManifest({ ...sourceManifest, allowScripts }, tarballSpecifier)
      ).toThrow();
    }
  });

  it("requires strict enforcement and actively disables inherited suppression or bypass", () => {
    const args = packedConsumerInstallArguments('""');
    expect(args).toContain("--global=false");
    expect(args).toContain("--strict-allow-scripts");
    expect(args).toContain("--ignore-scripts=false");
    expect(args).toContain("--dangerously-allow-all-scripts=false");
    expect(args).toContain('--node-options=""');
    expect(args).not.toContain("--no-package-lock");
    expect(args).not.toContain("--no-save");
  });

  it("serves only the captured packed bytes at the exact loopback artifact URL", async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lexrunner-tarball-server-test-"));
    const tarballPath = path.join(temporaryRoot, "candidate.tgz");
    const bytes = Buffer.from("isolated packed artifact fixture");
    fs.writeFileSync(tarballPath, bytes);
    const server = await servePackedTarball(tarballPath);
    try {
      fs.writeFileSync(tarballPath, "later disk mutation");
      const response = await fetch(server.url);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
      const otherPath = new URL("/package.json", server.url);
      expect((await fetch(otherPath)).status).toBe(404);
      expect((await fetch(server.url, { method: "POST" })).status).toBe(404);
    } finally {
      await server.close();
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("replaces every inherited npm node-options casing with the single qualified value", () => {
    const nodeOptions = "--max-old-space-size=2048";
    const env = ownedNpmLifecycleEnvironment(
      {
        npm_config_node_options: "--import=unapproved.mjs",
        NPM_CONFIG_NODE_OPTIONS: "--require=unapproved.cjs",
        NODE_OPTIONS: nodeOptions,
        PATH: "owned fixture path",
      },
      nodeOptions
    );
    expect(env.NODE_OPTIONS).toBe(nodeOptions);
    expect(env.PATH).toBe("owned fixture path");
    expect(
      Object.keys(env).filter((key) => key.toLowerCase() === "npm_config_node_options")
    ).toEqual(["npm_config_node_options"]);
    expect(env.npm_config_node_options).toBe(nodeOptions);
    expect(packedConsumerInstallArguments(nodeOptions)).toContain(`--node-options=${nodeOptions}`);
  });

  it("requires the observed nonblank lifecycle value instead of allowing npm to skip an empty export", () => {
    for (const value of [undefined, null, "", " ", "\t"]) {
      expect(() => packedConsumerInstallArguments(value)).toThrow("explicit qualified nonblank");
      expect(() => ownedNpmLifecycleEnvironment({}, value)).toThrow("explicit qualified nonblank");
    }
    expect(ownedNpmLifecycleEnvironment({}, '""').npm_config_node_options).toBe('""');
  });
});
describe("owned packed npm process shutdown", () => {
  afterEach(() => vi.useRealTimers());
  const start = (overrides = {}) => {
    // Track only this command's timers, not Vitest/HTTP/client timers sharing the clock.
    const activeTimers = new Set<ReturnType<typeof setTimeout>>();
    const scheduleTimeout = vi.fn((callback: () => void, delay: number) => {
      const timer = setTimeout(() => {
        activeTimers.delete(timer);
        callback();
      }, delay);
      activeTimers.add(timer);
      return timer;
    });
    const cancelTimeout = vi.fn((timer: ReturnType<typeof setTimeout> | undefined) => {
      if (timer !== undefined) activeTimers.delete(timer);
      clearTimeout(timer);
    });
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = 12345;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn(() => true);
    const spawnProcess = vi.fn(() => child);
    const promise = runOwnedPackedInstallCommand({
      nodeExecutable: "fixture-node",
      npmCliPath: "fixture-npm-cli.js",
      consumerRoot: "fixture-consumer",
      lifecycleNodeOptions: '""',
      spawnProcess,
      scheduleTimeout,
      cancelTimeout,
      commandTimeoutMs: 1_000,
      releaseTimeoutMs: 100,
      maxOutputBytes: 5,
      ...overrides,
    });
    return { child, promise, spawnProcess, activeTimers, scheduleTimeout, cancelTimeout };
  };

  it("keeps failure pending until the owned close event after output overflow", async () => {
    vi.useFakeTimers();
    const { child, promise, activeTimers } = start();
    let settled = false;
    const failure = promise.then(
      () => undefined,
      (error) => {
        settled = true;
        return error;
      }
    );
    child.stdout.emit("data", Buffer.from("overflow"));
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    child.emit("close", null, "SIGTERM");
    expect(await failure).toMatchObject({
      ownedProcessClosed: true,
      resourceRelease: "uncertain",
      retainedConsumerRoot: "fixture-consumer",
    });
    expect(activeTimers.size).toBe(0);
  });

  it("bounds command duration while awaiting owned close before timeout rejection", async () => {
    vi.useFakeTimers();
    const { child, promise, activeTimers, scheduleTimeout, cancelTimeout } = start();
    let settled = false;
    const failure = promise.then(
      () => undefined,
      (error) => {
        settled = true;
        return error;
      }
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(activeTimers.size).toBe(1);
    expect(scheduleTimeout.mock.calls.map(([, delay]) => delay)).toEqual([1_000, 100]);
    child.emit("close", null, "SIGTERM");
    expect((await failure).message).toContain("exceeded 1000ms");
    expect(activeTimers.size).toBe(0);
    for (const scheduled of scheduleTimeout.mock.results) {
      expect(cancelTimeout).toHaveBeenCalledWith(scheduled.value);
    }
  });

  it("reports uncertain release rather than authorizing cleanup when owned close never arrives", async () => {
    vi.useFakeTimers();
    const { child, promise, activeTimers } = start();
    const failure = promise.then(
      () => undefined,
      (error) => error
    );
    child.stderr.emit("data", Buffer.from("overflow"));
    await vi.advanceTimersByTimeAsync(100);
    expect(await failure).toMatchObject({
      ownedProcessClosed: false,
      resourceRelease: "uncertain",
    });
    expect(activeTimers.size).toBe(0);
  });

  it("clears the command timer when the owned process completes normally", async () => {
    vi.useFakeTimers();
    const { child, promise, activeTimers } = start();
    child.stdout.emit("data", Buffer.from("ok"));
    child.emit("close", 0, null);
    expect(await promise).toEqual({ status: "passed", output: "ok" });
    expect(child.kill).not.toHaveBeenCalled();
    expect(activeTimers.size).toBe(0);
  });

  it("observes the exact approved postinstall when its UTF-8 glyph spans chunks", async () => {
    vi.useFakeTimers();
    const manifest = { ...sourceManifest, version: "2.4.0" };
    const prefix = `> ${manifest.name}@${manifest.version} postinstall\n`;
    const glyph = Buffer.from("📦");
    const suffix =
      ' lexrunner installed! Run "npx lexrunner init" to set up your workspace. The "lex-pr" compatibility alias remains supported.\n';
    for (const streamName of ["stdout", "stderr"] as const) {
      for (const split of [1, 2, 3]) {
        const { child, promise, activeTimers } = start({ maxOutputBytes: 1_024 });
        child[streamName].emit(
          "data",
          Buffer.concat([Buffer.from(prefix), glyph.subarray(0, split)])
        );
        child[streamName].emit("data", Buffer.concat([glyph.subarray(split), Buffer.from(suffix)]));
        child.emit("close", 0, null);
        const result = await promise;
        expect(result).toEqual({ status: "passed", output: `${prefix}📦${suffix}` });
        expect(observePackedArtifactPostinstall(manifest, result)).toMatchObject({
          event: "postinstall",
          status: "passed",
        });
        expect(child.kill).not.toHaveBeenCalled();
        expect(activeTimers.size).toBe(0);
      }
    }
  });

  it("keeps each stream's pending UTF-8 bytes separate and flushes them on owned close", async () => {
    vi.useFakeTimers();
    const { child, promise, activeTimers } = start({ maxOutputBytes: 10 });
    const stdoutGlyph = Buffer.from("📦");
    const stderrGlyph = Buffer.from("é");
    child.stdout.emit("data", stdoutGlyph.subarray(0, 2));
    child.stderr.emit("data", stderrGlyph.subarray(0, 1));
    child.stdout.emit("data", stdoutGlyph.subarray(2));
    child.stderr.emit("data", stderrGlyph.subarray(1));
    child.stdout.emit("data", Buffer.from([0xe2, 0x82]));
    child.stderr.emit("data", Buffer.from([0xf0, 0x9f]));
    child.emit("close", 0, null);
    expect(await promise).toEqual({ status: "passed", output: "📦é��" });
    expect(child.kill).not.toHaveBeenCalled();
    expect(activeTimers.size).toBe(0);
  });

  it("accepts multibyte output exactly at the aggregate raw-byte budget", async () => {
    vi.useFakeTimers();
    const { child, promise, activeTimers } = start({ maxOutputBytes: 6 });
    const glyph = Buffer.from("📦");
    child.stdout.emit("data", glyph.subarray(0, 1));
    child.stderr.emit("data", Buffer.from("é"));
    child.stdout.emit("data", glyph.subarray(1));
    child.emit("close", 0, null);
    expect(await promise).toEqual({ status: "passed", output: "é📦" });
    expect(child.kill).not.toHaveBeenCalled();
    expect(activeTimers.size).toBe(0);
  });

  it("terminates on a byte beyond the aggregate multibyte output budget and awaits owned close", async () => {
    vi.useFakeTimers();
    const { child, promise, activeTimers } = start({ maxOutputBytes: 6 });
    const failure = promise.then(
      () => undefined,
      (error) => error
    );
    child.stdout.emit("data", Buffer.from("📦"));
    child.stderr.emit("data", Buffer.from("é"));
    expect(child.kill).not.toHaveBeenCalled();
    child.stderr.emit("data", Buffer.from("x"));
    expect(child.kill).toHaveBeenCalledOnce();
    expect(activeTimers.size).toBe(1);
    child.emit("close", null, "SIGTERM");
    expect(await failure).toMatchObject({
      message: expect.stringContaining("exceeded the output budget"),
      ownedProcessClosed: true,
      resourceRelease: "uncertain",
      retainedConsumerRoot: "fixture-consumer",
    });
    expect(activeTimers.size).toBe(0);
  });

  it("binds the actual owned spawn arguments and environment to the same observed lifecycle value", async () => {
    vi.useFakeTimers();
    const lifecycleNodeOptions = "--max-old-space-size=2048";
    const { child, promise, spawnProcess, activeTimers } = start({
      lifecycleNodeOptions,
      env: {
        NODE_OPTIONS: "--import=unreviewed-direct.mjs",
        Node_Options: "--require=unreviewed-direct.cjs",
        NPM_CONFIG_NODE_OPTIONS: "--import=unreviewed.mjs",
        npm_config_node_options: "--require=unreviewed.cjs",
      },
    });
    expect(spawnProcess).toHaveBeenCalledWith(
      "fixture-node",
      expect.arrayContaining(["fixture-npm-cli.js", `--node-options=${lifecycleNodeOptions}`]),
      expect.objectContaining({
        env: { NODE_OPTIONS: lifecycleNodeOptions, npm_config_node_options: lifecycleNodeOptions },
        shell: false,
      })
    );
    child.emit("close", 0, null);
    await expect(promise).resolves.toMatchObject({ status: "passed" });
    expect(activeTimers.size).toBe(0);
  });

  it("clears both owned timers while an unrelated timer remains active", async () => {
    vi.useFakeTimers();
    const unrelated = vi.fn();
    const unrelatedTimer = setTimeout(unrelated, 5_000);
    const { child, promise, activeTimers, scheduleTimeout, cancelTimeout } = start();
    const failure = promise.then(
      () => undefined,
      (error) => error
    );
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(child.kill).toHaveBeenCalledOnce();
      expect(activeTimers.size).toBe(1);
      child.emit("close", null, "SIGTERM");
      expect(await failure).toMatchObject({
        ownedProcessClosed: true,
        resourceRelease: "uncertain",
      });
      expect(activeTimers.size).toBe(0);
      for (const scheduled of scheduleTimeout.mock.results) {
        expect(cancelTimeout).toHaveBeenCalledWith(scheduled.value);
      }
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      expect(unrelated).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(4_000);
      expect(unrelated).toHaveBeenCalledOnce();
      expect(child.kill).toHaveBeenCalledOnce();
    } finally {
      clearTimeout(unrelatedTimer);
    }
  });
});
