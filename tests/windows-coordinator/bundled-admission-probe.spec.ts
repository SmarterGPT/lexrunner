import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildWindowsCoordinatorAdmissionBundle } from "../../scripts/build-windows-coordinator-admission-bundle.js";
import { requireBundledNodeAbi } from "../../services/windows-coordinator-host/node/bundled-admission-probe.js";
import { createWindowsCoordinatorGenerationGraph } from "../../src/workspaces/windows-coordinator-generation-graph.js";
import { WINDOWS_BOUNDARY_PROTOCOL_VERSION } from "../../src/workspaces/windows-boundary-protocol.js";
import { WINDOWS_REMOVAL_VERSION } from "../../src/workspaces/windows-removal-protocol.js";

const fixturePrefix = "lexrunner-bundled-admission-";
const nativeAddon = path.resolve(
  "node_modules/better-sqlite3-multiple-ciphers/build/Release/better_sqlite3.node"
);
const roots: string[] = [];

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function checkedCleanup(root: string): Promise<void> {
  if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith(fixturePrefix))
    throw new Error("Unexpected bundle fixture root");
  const actual = await realpath(root);
  if (actual.toLowerCase() !== root.toLowerCase() || (await lstat(root)).isSymbolicLink())
    throw new Error("Bundle fixture root was redirected");
  async function check(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Bundle fixture contains a link");
      if (entry.isDirectory()) await check(path.join(directory, entry.name));
    }
  }
  await check(root);
  await rm(root, { recursive: true });
}

afterEach(async () => {
  for (const root of roots.splice(0)) await checkedCleanup(root);
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), fixturePrefix));
  roots.push(root);
  const memberPaths = [
    ["bin/service.exe", "service-image"],
    ["client/client.exe", "client-image"],
    ["git/git.exe", "git-entry"],
    ["helper/helper.exe", "helper-image"],
    ["node/addon.node", "sqlite-addon"],
    ["node/admission.mjs", "admission-entry"],
    ["node/node.exe", "node-image"],
  ] as const;
  const bundle = await buildWindowsCoordinatorAdmissionBundle();
  const files = [];
  for (const [relative, role] of memberPaths) {
    const absolute = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    if (role === "sqlite-addon") await copyFile(nativeAddon, absolute);
    else await writeFile(absolute, role === "admission-entry" ? bundle.bytes : `fixture:${role}`);
    const bytes = await readFile(absolute);
    files.push({ path: relative, role, sha256: sha256(bytes), bytes: bytes.length });
  }
  files.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
  const graph = createWindowsCoordinatorGenerationGraph({
    schemaVersion: "lexrunner-windows-coordinator-generation-graph/2",
    profile: "windows-coordinator-service-msi/2",
    architecture: "win-x64",
    serviceName: "LexRunnerCoordinator",
    coordinatorProtocolVersion: "1.0.0",
    boundaryProtocolVersion: WINDOWS_BOUNDARY_PROTOCOL_VERSION,
    removalProtocolVersion: WINDOWS_REMOVAL_VERSION,
    files,
  });
  const manifestPath = path.join(root, "generation-graph.json");
  await writeFile(manifestPath, graph.manifestBytes);
  const entryPath = path.join(root, "node", "admission.mjs");
  return {
    root,
    graph,
    manifestPath,
    entryPath,
    addonPath: path.join(root, "node", "addon.node"),
    bundle,
  };
}

function run(entryPath: string, manifestPath: string, digest: string, root: string) {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  return spawnSync(process.execPath, [entryPath, "--bundle-probe", manifestPath, digest], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
    env: {
      ...(systemRoot ? { SystemRoot: systemRoot, WINDIR: systemRoot } : {}),
      PATH: path.dirname(process.execPath),
      NODE_PATH: path.join(root, "node_modules"),
      TEMP: root,
      TMP: root,
    },
  });
}

describe.skipIf(process.platform !== "win32")("isolated bundled admission source probe", () => {
  it("requires the reviewed Node 24 native addon ABI", () => {
    expect(requireBundledNodeAbi("137")).toBe("137");
    expect(() => requireBundledNodeAbi("138")).toThrow("bundled_node_abi_unavailable");
  });

  it("bundles JS dependencies and opens SQLite only through the graph-selected addon object", async () => {
    const { root, graph, manifestPath, entryPath, bundle } = await fixture();
    expect(
      bundle.externalImports.every(
        (specifier) =>
          specifier.startsWith("node:") || ["fs", "path", "util", "crypto"].includes(specifier)
      )
    ).toBe(true);
    expect(bundle.sourceInputCount).toBeGreaterThan(100);
    expect(Buffer.from(bundle.bytes).toString("utf8")).toContain(
      "default_sqlite_binding_search_denied"
    );
    expect(Buffer.from(bundle.bytes).toString("utf8")).toContain("bundled_dynamic_require_denied");
    const poisoned = path.join(root, "node_modules", "zod");
    await mkdir(poisoned, { recursive: true });
    await writeFile(path.join(poisoned, "index.js"), "throw new Error('poisoned_zod_load')");
    const poisonedSqlite = path.join(root, "node_modules", "better-sqlite3-multiple-ciphers");
    await mkdir(poisonedSqlite, { recursive: true });
    await writeFile(
      path.join(poisonedSqlite, "index.js"),
      "throw new Error('poisoned_sqlite_package_load')"
    );
    const result = run(entryPath, manifestPath, graph.manifestSha256, root);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: "windows-bundled-admission-probe/1",
      graphDigest: graph.graphDigest,
      addonSha256: sha256(await readFile(path.join(root, "node", "addon.node"))),
      nodeAbi: "137",
      authorizesLaunch: false,
    });
  });

  it("refuses mismatched manifest and addon bytes without a no-effect claim", async () => {
    const first = await fixture();
    const wrong = run(first.entryPath, first.manifestPath, "0".repeat(64), first.root);
    expect(wrong.status, wrong.stderr).toBe(3);
    expect(wrong.stdout).toBe("");
    const second = await fixture();
    await writeFile(second.addonPath, "wrong addon bytes");
    const changed = run(
      second.entryPath,
      second.manifestPath,
      second.graph.manifestSha256,
      second.root
    );
    expect(changed.status).toBe(3);
    expect(changed.stdout).toBe("");

    const third = await fixture();
    await writeFile(
      third.entryPath,
      Buffer.concat([third.bundle.bytes, Buffer.from("\n//changed")])
    );
    const changedEntry = run(
      third.entryPath,
      third.manifestPath,
      third.graph.manifestSha256,
      third.root
    );
    expect(changedEntry.status).toBe(3);
    expect(changedEntry.stdout).toBe("");
  });
});
