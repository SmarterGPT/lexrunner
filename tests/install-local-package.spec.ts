import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  createLocalInstallPlan,
  inspectLocalInstallTarball,
  inspectLocalInstallTarget,
  parseLocalInstallArguments,
  runLocalPackageInstall,
  validateLocalInstallInputs,
  verifyInstalledPackedFiles,
} from "../scripts/install-local-package.mjs";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const script = path.join(sourceRoot, "scripts", "install-local-package.mjs");
const temporaryRoots: string[] = [];
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(version = "11.16.0") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lexrunner-local-install-"));
  temporaryRoots.push(root);
  const projectRoot = path.join(root, "source");
  const prefix = path.join(root, "prefix");
  const artifactsDir = path.join(root, "evidence");
  fs.mkdirSync(projectRoot);
  const manifest = {
    name: "@smartergpt/lexrunner",
    version: "2.4.0",
    packageManager: "npm@11.16.0",
    dependencies: { "better-sqlite3-multiple-ciphers": "^12.6.2", "@smartergpt/lex": "4.0.3" },
    devDependencies: {},
    bin: { lexrunner: "dist/cli.js" },
    engines: { node: ">=24" },
    allowScripts: { "better-sqlite3-multiple-ciphers@12.11.1": true, "@smartergpt/lex": false },
  };
  const lock = {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    packages: {
      "": {
        name: manifest.name,
        version: manifest.version,
        dependencies: manifest.dependencies,
        devDependencies: {},
        bin: manifest.bin,
        engines: manifest.engines,
      },
      "node_modules/better-sqlite3-multiple-ciphers": { version: "12.11.1" },
    },
  };
  fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(projectRoot, "package-lock.json"), JSON.stringify(lock));
  const npmCliPath = path.join(root, "npm-cli.cjs");
  const tracePath = path.join(root, "npm-commands.jsonl");
  fs.writeFileSync(
    npmCliPath,
    `
    const fs=require('node:fs');
    const args=process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify(args)+'\\n');
    if(args[0]==='--version') console.log(${JSON.stringify(version)});
    else if(args[0]==='approve-scripts'&&args[1]==='--usage') console.log('npm approve-scripts --allow-scripts-pending');
    else if(args[0]==='install'&&args[1]==='--usage') console.log('npm install --allow-scripts --strict-allow-scripts');
    else process.exit(2);
  `
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(?:node_options|npm_config_allow_scripts|npm_config_node_options)$/i.test(name)
    )
  );
  env.npm_execpath = npmCliPath;
  return { root, projectRoot, prefix, artifactsDir, npmCliPath, tracePath, env, manifest, lock };
}

function tarball(entries: Array<{ path: string; text: string; type?: string }>) {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const bytes = Buffer.from(entry.text);
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100);
    header.write("0000644\0", 100, 8);
    header.write("0000000\0", 108, 8);
    header.write("0000000\0", 116, 8);
    header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124, 12);
    header.write("00000000000\0", 136, 12);
    header.fill(32, 148, 156);
    header.write(entry.type ?? "0", 156, 1);
    header.write("ustar\0", 257, 6);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    blocks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

describe("repository local-dogfood installation", () => {
  it("defaults to planning and rejects unspecified/relative/root prefixes or extra switches", () => {
    const input = fixture();
    expect(parseLocalInstallArguments(["--prefix", input.prefix])).toEqual({
      prefix: input.prefix,
      execute: false,
    });
    expect(parseLocalInstallArguments(["--prefix", input.prefix, "--execute"]).execute).toBe(true);
    for (const args of [
      [],
      ["--prefix", "relative"],
      ["--prefix", path.parse(input.prefix).root],
      ["--prefix", input.prefix, "--ignore-scripts"],
      ["--prefix", input.prefix, "--prefix", input.prefix],
    ]) {
      expect(() => parseLocalInstallArguments(args)).toThrow();
    }
  });

  it("plans explicit script-suppressed global install then lock-scoped CI/native policy commands", () => {
    const input = fixture();
    const plan = createLocalInstallPlan({
      ...input,
      source: { head: "a".repeat(40), tree: "b".repeat(40), dirty: "?? own-change" },
      npmRuntime: { npmVersion: "11.16.0" },
    });
    expect(plan.status).toBe("planned");
    expect(plan.source.dirty).toBe("?? own-change");
    expect(plan.plannedCommands[0].args).toContain("--ignore-scripts");
    expect(plan.plannedCommands[1].args).toEqual(
      expect.arrayContaining(["ci", "--global=false", "--omit=dev", "--ignore-scripts"])
    );
    expect(plan.plannedCommands[2].args).toEqual(
      expect.arrayContaining([
        "better-sqlite3-multiple-ciphers@12.11.1",
        "--strict-allow-scripts",
        "--ignore-scripts=false",
        "--dangerously-allow-all-scripts=false",
      ])
    );
    expect(fs.existsSync(input.prefix)).toBe(false);
  });

  it("CLI plan retains provenance and source lock without build, pack, install or prefix creation", () => {
    const input = fixture();
    const result = spawnSync(
      process.execPath,
      [script, "--prefix", input.prefix, "--artifacts-dir", input.artifactsDir],
      { cwd: sourceRoot, env: input.env, encoding: "utf8", timeout: 15_000 }
    );
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(
      fs.readFileSync(path.join(input.artifactsDir, "receipt.json"), "utf8")
    );
    expect(receipt).toMatchObject({
      status: "planned",
      runtimeUnchangedAfter: true,
      npmRuntime: { npmVersion: "11.16.0" },
    });
    expect(receipt.source.head).toMatch(/^[a-f0-9]{40}$/);
    expect(receipt.sourceAfter.head).toBe(receipt.source.head);
    expect(fs.readFileSync(path.join(input.artifactsDir, "source-package-lock.json"))).toEqual(
      fs.readFileSync(path.join(sourceRoot, "package-lock.json"))
    );
    expect(
      receipt.commands.every((command: { name: string }) => command.name === "git-observe")
    ).toBe(true);
    const trace = fs
      .readFileSync(input.tracePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(trace).toEqual([["--version"], ["approve-scripts", "--usage"], ["install", "--usage"]]);
    expect(fs.existsSync(input.prefix)).toBe(false);
  });

  it("retains unsupported-runtime refusal before Git/build/install and leaves prefix untouched", () => {
    const input = fixture("11.11.0");
    expect(() => runLocalPackageInstall(input)).toThrow("observed 11.11.0");
    const receipt = JSON.parse(
      fs.readFileSync(path.join(input.artifactsDir, "receipt.json"), "utf8")
    );
    expect(receipt.status).toBe("failed");
    expect(receipt.commands).toEqual([]);
    expect(fs.existsSync(input.prefix)).toBe(false);
  });

  it("refuses execution without a source Git checkpoint before build, pack or global mutation", () => {
    const input = fixture();
    expect(() => runLocalPackageInstall({ ...input, execute: true })).toThrow("git-observe failed");
    const receipt = JSON.parse(
      fs.readFileSync(path.join(input.artifactsDir, "receipt.json"), "utf8")
    );
    expect(receipt.status).toBe("failed");
    expect(receipt.commands).toHaveLength(1);
    expect(receipt.commands[0]).toMatchObject({ name: "git-observe", args: ["rev-parse", "HEAD"] });
    expect(receipt.commands[0].exitCode).not.toBe(0);
    expect(fs.existsSync(input.prefix)).toBe(false);
  });

  it("refuses stale source manifest/lock before runtime or target changes", () => {
    const input = fixture();
    input.lock.packages[""].dependencies["@smartergpt/lex"] = "0.0.0";
    fs.writeFileSync(path.join(input.projectRoot, "package-lock.json"), JSON.stringify(input.lock));
    expect(() => runLocalPackageInstall({ ...input, execute: true })).toThrow(
      "manifest and lock dependencies do not match"
    );
    const receipt = JSON.parse(
      fs.readFileSync(path.join(input.artifactsDir, "receipt.json"), "utf8")
    );
    expect(receipt.status).toBe("failed");
    expect(fs.existsSync(input.tracePath)).toBe(false);
    expect(fs.existsSync(input.prefix)).toBe(false);
  });

  it("refuses unpinned native policy or changed locked native version", () => {
    const input = fixture();
    input.lock.packages["node_modules/better-sqlite3-multiple-ciphers"].version = "12.12.0";
    fs.writeFileSync(path.join(input.projectRoot, "package-lock.json"), JSON.stringify(input.lock));
    expect(() => validateLocalInstallInputs(input.projectRoot)).toThrow("SQLite 12.11.1 lock");
  });

  it("refuses ambiguous target packages, source overlap, and junctions outside explicit prefix", () => {
    const input = fixture();
    expect(() => inspectLocalInstallTarget(input.projectRoot, input.projectRoot)).toThrow(
      "separate from the source"
    );
    fs.mkdirSync(input.prefix);
    const outside = path.join(input.root, "outside");
    fs.mkdirSync(outside);
    const modules = path.join(input.prefix, "node_modules");
    fs.symlinkSync(outside, modules, process.platform === "win32" ? "junction" : "dir");
    expect(() => inspectLocalInstallTarget(input.prefix, input.projectRoot, "win32")).toThrow(
      "escapes the explicit physical prefix"
    );
    fs.unlinkSync(modules);
    const installed = path.join(modules, "@smartergpt", "lexrunner");
    fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(
      path.join(installed, "package.json"),
      JSON.stringify({ name: "unrelated-package" })
    );
    expect(() => inspectLocalInstallTarget(input.prefix, input.projectRoot, "win32")).toThrow(
      "identity is ambiguous"
    );
  });

  it("refuses artifact storage inside source tracked paths or target prefix", () => {
    const input = fixture();
    expect(() =>
      runLocalPackageInstall({
        ...input,
        projectRoot: sourceRoot,
        artifactsDir: path.join(sourceRoot, "scripts", "installer-evidence"),
      })
    ).toThrow("ignored directory with no tracked files");
    expect(() =>
      runLocalPackageInstall({ ...input, artifactsDir: path.join(input.prefix, "evidence") })
    ).toThrow("outside the target prefix");
    expect(fs.existsSync(input.prefix)).toBe(false);
  });

  it("hashes actual bounded tar payloads and refuses traversal, links, or corrupt headers", () => {
    const packed = tarball([
      { path: "package/package.json", text: '{"name":"@smartergpt/lexrunner"}' },
      { path: "package/dist/cli.js", text: "compiled-source" },
    ]);
    expect(inspectLocalInstallTarball(packed).map((file: { path: string }) => file.path)).toEqual([
      "package.json",
      "dist/cli.js",
    ]);
    expect(() =>
      inspectLocalInstallTarball(tarball([{ path: "package/../escape", text: "x" }]))
    ).toThrow("escapes its root");
    expect(() =>
      inspectLocalInstallTarball(tarball([{ path: "package/link", text: "", type: "2" }]))
    ).toThrow("unsupported non-file");
    const invalid = Buffer.alloc(512, 1);
    expect(() => inspectLocalInstallTarball(gzipSync(invalid))).toThrow("checksum");
  });

  it("checks all installed packed-file hashes and refuses replacement bytes", () => {
    const input = fixture();
    const installed = path.join(input.root, "installed-fixture");
    fs.mkdirSync(installed);
    fs.writeFileSync(path.join(installed, "one.js"), "exact-packed-bytes");
    const files = [{ path: "one.js", sha256: hash("exact-packed-bytes") }];
    expect(() => verifyInstalledPackedFiles(files, installed)).not.toThrow();
    fs.writeFileSync(path.join(installed, "one.js"), "replacement");
    expect(() => verifyInstalledPackedFiles(files, installed)).toThrow(
      "Installed packed file differs"
    );
  });
});
