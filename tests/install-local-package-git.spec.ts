import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  localSourceGitEnvironment,
  runLocalPackageInstall,
} from "../scripts/install-local-package.mjs";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];
const ownedArtifactRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  for (const root of ownedArtifactRoots.splice(0)) {
    const relative = path.relative(path.join(sourceRoot, "artifacts"), root);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Refusing to remove an unowned artifact directory.");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function git(args: string[], cwd: string, env = localSourceGitEnvironment()) {
  const result = spawnSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function tarball(entries: Array<{ path: string; bytes: Buffer }>) {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100);
    header.write("0000644\0", 100, 8);
    header.write("0000000\0", 108, 8);
    header.write("0000000\0", 116, 8);
    header.write(`${entry.bytes.length.toString(8).padStart(11, "0")}\0`, 124, 12);
    header.write("00000000000\0", 136, 12);
    header.fill(32, 148, 156);
    header.write("0", 156, 1);
    header.write("ustar\0", 257, 6);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    blocks.push(header, entry.bytes, Buffer.alloc((512 - (entry.bytes.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function treeFingerprint(root: string) {
  const hash = createHash("sha256");
  const visit = (directory: string) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const target = path.join(directory, name);
      const relative = path.relative(root, target).split(path.sep).join("/");
      const stat = fs.lstatSync(target);
      hash.update(`${relative}\0${stat.isDirectory() ? "directory" : "file"}\0`);
      if (stat.isDirectory()) visit(target);
      else hash.update(fs.readFileSync(target));
    }
  };
  visit(root);
  return hash.digest("hex");
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lexrunner-local-install-git-"));
  temporaryRoots.push(root);
  const foreignRoot = path.join(root, "foreign-repository");
  fs.mkdirSync(foreignRoot);
  git(["init", "--quiet"], foreignRoot);
  git(["config", "user.name", "Owned fixture"], foreignRoot);
  git(["config", "user.email", "owned-fixture@example.invalid"], foreignRoot);
  git(["config", "commit.gpgsign", "false"], foreignRoot);
  fs.writeFileSync(path.join(foreignRoot, "foreign.txt"), "An unrelated source checkpoint.\n");
  git(["add", "foreign.txt"], foreignRoot);
  git(
    ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "owned foreign fixture"],
    foreignRoot
  );
  const foreignHead = git(["rev-parse", "HEAD"], foreignRoot);
  const npmCliPath = path.join(root, "observed-fixture-npm.cjs");
  fs.writeFileSync(
    npmCliPath,
    `const args=process.argv.slice(2);
     if(args[0]==='--version') console.log('11.16.0');
     else if(args[0]==='approve-scripts'&&args[1]==='--usage') console.log('npm approve-scripts --allow-scripts-pending');
     else if(args[0]==='install'&&args[1]==='--usage') console.log('npm install --allow-scripts --strict-allow-scripts');
     else process.exit(2);`
  );
  const env = Object.fromEntries(
    Object.entries(localSourceGitEnvironment()).filter(
      ([key]) =>
        !/^(?:node_options|npm_config_allow_scripts|npm_config_node_options|npm_execpath)$/i.test(
          key
        )
    )
  );
  env.npm_execpath = npmCliPath;
  env.GIT_DIR = path.join(foreignRoot, ".git");
  env.GIT_WORK_TREE = foreignRoot;
  return {
    root,
    foreignRoot,
    foreignHead,
    env,
    prefix: path.join(root, "uncreated-prefix"),
    artifactsDir: path.join(root, "evidence"),
  };
}

describe("local installer source Git context", () => {
  it("rejects a clean CRLF-packed executable before mutating an existing target", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lexrunner-local-install-crlf-"));
    temporaryRoots.push(root);
    const projectRoot = path.join(root, "source");
    const prefix = path.join(root, "prefix");
    const artifactsDir = path.join(root, "evidence");
    fs.mkdirSync(projectRoot);
    for (const name of ["package.json", "package-lock.json"]) {
      fs.copyFileSync(path.join(sourceRoot, name), path.join(projectRoot, name));
    }
    fs.writeFileSync(path.join(projectRoot, ".gitattributes"), "* text=auto eol=lf\n");
    fs.mkdirSync(path.join(projectRoot, "dist"));
    fs.writeFileSync(path.join(projectRoot, "dist", "cli.js"), "#!/usr/bin/env node\n");
    fs.writeFileSync(path.join(projectRoot, "mcp-server.mjs"), "#!/usr/bin/env node\n");
    git(["init", "--quiet"], projectRoot);
    git(["config", "user.name", "Signed installer fixture"], projectRoot);
    git(["config", "user.email", "installer-fixture@example.invalid"], projectRoot);
    git(["config", "core.autocrlf", "false"], projectRoot);
    git(["config", "core.safecrlf", "warn"], projectRoot);
    const signingKey = path.join(root, "fixture-signing-key");
    const generated = spawnSync(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-C", "installer-fixture", "-f", signingKey],
      { encoding: "utf8", timeout: 10_000, windowsHide: true }
    );
    expect(generated.status, generated.stderr).toBe(0);
    const allowedSigners = path.join(root, "allowed-signers");
    fs.writeFileSync(
      allowedSigners,
      `installer-fixture@example.invalid ${fs.readFileSync(`${signingKey}.pub`, "utf8")}`
    );
    git(["config", "gpg.format", "ssh"], projectRoot);
    git(["config", "user.signingkey", signingKey], projectRoot);
    git(["config", "gpg.ssh.allowedSignersFile", allowedSigners], projectRoot);
    git(["add", "."], projectRoot);
    git(["commit", "-S", "--quiet", "-m", "signed CRLF admission fixture"], projectRoot);
    fs.writeFileSync(path.join(projectRoot, "dist", "cli.js"), "#!/usr/bin/env node\r\n");
    git(["add", "dist/cli.js"], projectRoot);
    expect(git(["diff", "--cached", "--name-only"], projectRoot)).toBe("");
    expect(git(["status", "--porcelain=v1", "--untracked-files=all"], projectRoot)).toBe("");
    git(["verify-commit", "HEAD"], projectRoot);

    const manifestBytes = fs.readFileSync(path.join(projectRoot, "package.json"));
    const packed = tarball([
      { path: "package/package.json", bytes: manifestBytes },
      { path: "package/dist/cli.js", bytes: Buffer.from("#!/usr/bin/env node\r\n") },
      { path: "package/mcp-server.mjs", bytes: Buffer.from("#!/usr/bin/env node\n") },
    ]);
    const npmCliPath = path.join(root, "fixture-npm.cjs");
    const npmTracePath = path.join(root, "fixture-npm-trace.jsonl");
    fs.writeFileSync(
      npmCliPath,
      `const fs=require('node:fs');
       const path=require('node:path');
       const args=process.argv.slice(2);
       fs.appendFileSync(${JSON.stringify(npmTracePath)}, JSON.stringify(args)+'\\n');
       if(args[0]==='--version') console.log('11.16.0');
       else if(args[0]==='approve-scripts'&&args[1]==='--usage') console.log('npm approve-scripts --allow-scripts-pending');
       else if(args[0]==='install'&&args[1]==='--usage') console.log('npm install --allow-scripts --strict-allow-scripts');
       else {
         const command=args.find((argument)=>!argument.startsWith('--'));
         if(command==='ci'&&args.includes('--dry-run')) process.exit(0);
         else if(command==='run'&&args.includes('build')) process.exit(0);
         else if(command==='pack') {
           const destination=args[args.indexOf('--pack-destination')+1];
           const filename='smartergpt-lexrunner-2.4.0.tgz';
           fs.writeFileSync(path.join(destination,filename),Buffer.from(${JSON.stringify(packed.toString("base64"))},'base64'));
           console.log(JSON.stringify([{filename,integrity:'sha512-fixture',files:[{path:'package.json'},{path:'dist/cli.js'},{path:'mcp-server.mjs'}]}]));
         } else process.exit(9);
       }`
    );
    const env = Object.fromEntries(
      Object.entries(localSourceGitEnvironment()).filter(
        ([key]) =>
          !/^(?:node_options|npm_config_allow_scripts|npm_config_node_options|npm_execpath)$/i.test(
            key
          )
      )
    );
    env.npm_execpath = npmCliPath;

    const installedRoot = path.join(
      prefix,
      ...(process.platform === "win32" ? [] : ["lib"]),
      "node_modules",
      "@smartergpt",
      "lexrunner"
    );
    fs.mkdirSync(installedRoot, { recursive: true });
    fs.writeFileSync(
      path.join(installedRoot, "package.json"),
      JSON.stringify({ name: "@smartergpt/lexrunner", version: "2.3.0" })
    );
    fs.writeFileSync(path.join(installedRoot, "sentinel.bin"), Buffer.from([0, 1, 2, 3, 255]));
    const before = treeFingerprint(installedRoot);

    let failure: any;
    try {
      runLocalPackageInstall({ projectRoot, prefix, artifactsDir, execute: true, env });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "LOCAL_INSTALL_PACKED_EXECUTABLE_HEADER_NONCANONICAL",
      phase: "packed_executable_admission",
      targetMutationAttempted: false,
    });
    const receipt = JSON.parse(fs.readFileSync(path.join(artifactsDir, "receipt.json"), "utf8"));
    expect(receipt).toMatchObject({
      status: "failed",
      phase: "packed_executable_admission",
      targetMutationAttempted: false,
      errorCode: "LOCAL_INSTALL_PACKED_EXECUTABLE_HEADER_NONCANONICAL",
      npmRuntime: { npmVersion: "11.16.0", probes: expect.any(Array) },
    });
    expect(
      receipt.commands.some(
        (command: { name: string }) => command.name === "global-install-without-scripts"
      )
    ).toBe(false);
    expect(treeFingerprint(installedRoot)).toBe(before);
  }, 30_000);

  it.each(["lock", "manifest"])(
    "refuses a clean %s checkpoint switch during runtime preflight before retaining or deploying inputs",
    (changedInput) => {
      const input = fixture();
      for (const name of ["package.json", "package-lock.json"])
        fs.copyFileSync(path.join(sourceRoot, name), path.join(input.foreignRoot, name));
      git(["add", "package.json", "package-lock.json"], input.foreignRoot);
      git(["commit", "--quiet", "-m", "capture owned input snapshot"], input.foreignRoot);
      const initialHead = git(["rev-parse", "HEAD"], input.foreignRoot);
      const npmCliPath = input.env.npm_execpath;
      const originalProbe = fs.readFileSync(npmCliPath, "utf8");
      fs.writeFileSync(
        npmCliPath,
        `const probeFs = require('node:fs');
         const probePath = require('node:path');
         const probeRepo = ${JSON.stringify(input.foreignRoot)};
         const marker = probePath.join(probeRepo, '.git', 'preflight-switch.once');
         if (process.argv[2] === '--version' && !probeFs.existsSync(marker)) {
           const lockPath = probePath.join(probeRepo, 'package-lock.json');
           const lock = JSON.parse(probeFs.readFileSync(lockPath, 'utf8'));
           lock.packages['node_modules/@smartergpt/lex'].version = '4.0.4';
           probeFs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\\n');
           if (${JSON.stringify(changedInput)} === 'manifest') {
             const manifestPath = probePath.join(probeRepo, 'package.json');
             const manifest = JSON.parse(probeFs.readFileSync(manifestPath, 'utf8'));
             manifest.description = 'Owned second preflight checkpoint';
             probeFs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\\n');
           }
           const commandOptions = {cwd:probeRepo,env:process.env,windowsHide:true,timeout:10000,stdio:'pipe'};
           const execute = require('node:child_process').execFileSync;
           execute('git', ['add', 'package.json', 'package-lock.json'], commandOptions);
           execute('git', ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'switch owned preflight checkpoint'], commandOptions);
           probeFs.writeFileSync(marker, 'changed');
         }
         ${originalProbe}`
      );
      expect(() => runLocalPackageInstall({ ...input, projectRoot: input.foreignRoot })).toThrow(
        "Source inputs changed during preflight"
      );
      expect(git(["rev-parse", "HEAD"], input.foreignRoot)).not.toBe(initialHead);
      expect(git(["status", "--porcelain=v1"], input.foreignRoot)).toBe("");
      const receipt = JSON.parse(
        fs.readFileSync(path.join(input.artifactsDir, "receipt.json"), "utf8")
      );
      expect(receipt.status).toBe("failed");
      expect(
        receipt.commands.every((command: { name: string }) => command.name === "git-observe")
      ).toBe(true);
      expect(fs.existsSync(path.join(input.artifactsDir, "source-package.json"))).toBe(false);
      expect(fs.existsSync(path.join(input.artifactsDir, "source-package-lock.json"))).toBe(false);
      expect(fs.existsSync(input.prefix)).toBe(false);
    },
    20_000
  );

  it("observes the canonical source HEAD/tree despite an actual foreign Git environment", () => {
    const input = fixture();
    const sourceHead = git(["rev-parse", "HEAD"], sourceRoot);
    const sourceTree = git(["rev-parse", "HEAD^{tree}"], sourceRoot);
    // This proves the supplied environment selects the unrelated repository
    // before the installer's source Git sanitation is applied.
    expect(git(["rev-parse", "HEAD"], sourceRoot, input.env)).toBe(input.foreignHead);
    expect(input.foreignHead).not.toBe(sourceHead);
    const receipt = runLocalPackageInstall({ projectRoot: sourceRoot, ...input });
    expect(receipt.status).toBe("planned");
    expect(receipt.source).toMatchObject({ head: sourceHead, tree: sourceTree });
    expect(receipt.sourceAfter).toMatchObject({ head: sourceHead, tree: sourceTree });
    expect(receipt.source.dirty).toBe(
      git(["status", "--porcelain=v1", "--untracked-files=all"], sourceRoot)
    );
    expect(fs.existsSync(input.prefix)).toBe(false);
    expect(
      receipt.commands.every((command: { name: string }) => command.name === "git-observe")
    ).toBe(true);
  });

  it("refuses an ignored child source that is outside the owning Git root checkpoint", () => {
    const input = fixture();
    const childRoot = path.join(input.foreignRoot, "owned-source");
    fs.mkdirSync(childRoot);
    for (const name of ["package.json", "package-lock.json"])
      fs.copyFileSync(path.join(sourceRoot, name), path.join(childRoot, name));
    fs.writeFileSync(path.join(input.foreignRoot, ".gitignore"), "owned-source/\n");
    git(["add", ".gitignore"], input.foreignRoot);
    git(
      ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "ignore owned child"],
      input.foreignRoot
    );
    expect(git(["status", "--porcelain=v1"], input.foreignRoot)).toBe("");
    expect(() => runLocalPackageInstall({ ...input, projectRoot: childRoot })).toThrow(
      "physical owning Git repository root"
    );
    const receipt = JSON.parse(
      fs.readFileSync(path.join(input.artifactsDir, "receipt.json"), "utf8")
    );
    expect(receipt.status).toBe("failed");
    expect(fs.existsSync(input.prefix)).toBe(false);
  });

  it("refuses root manifest/lock inputs ignored by a clean source HEAD", () => {
    const input = fixture();
    for (const name of ["package.json", "package-lock.json"])
      fs.copyFileSync(path.join(sourceRoot, name), path.join(input.foreignRoot, name));
    fs.writeFileSync(
      path.join(input.foreignRoot, ".gitignore"),
      "package.json\npackage-lock.json\n"
    );
    git(["add", ".gitignore"], input.foreignRoot);
    git(
      ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "ignore unbound inputs"],
      input.foreignRoot
    );
    expect(git(["status", "--porcelain=v1"], input.foreignRoot)).toBe("");
    expect(() => runLocalPackageInstall({ ...input, projectRoot: input.foreignRoot })).toThrow(
      "manifest and lock must be tracked in HEAD"
    );
    const receipt = JSON.parse(
      fs.readFileSync(path.join(input.artifactsDir, "receipt.json"), "utf8")
    );
    expect(receipt.status).toBe("failed");
    expect(fs.existsSync(input.prefix)).toBe(false);
  });

  it("records dirty tracked input mismatch in a plan and refuses execution before source build", () => {
    const input = fixture();
    for (const name of ["package.json", "package-lock.json"])
      fs.copyFileSync(path.join(sourceRoot, name), path.join(input.foreignRoot, name));
    git(["add", "package.json", "package-lock.json"], input.foreignRoot);
    git(
      ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "track owned inputs"],
      input.foreignRoot
    );
    const initial = runLocalPackageInstall({ ...input, projectRoot: input.foreignRoot });
    expect(initial.source.inputsMatchHead).toBe(true);
    expect(initial.source.dirty).toBe("");
    const manifestPath = path.join(input.foreignRoot, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.description = "Changed current input outside the recorded source HEAD bytes";
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const planned = runLocalPackageInstall({
      ...input,
      projectRoot: input.foreignRoot,
      artifactsDir: path.join(input.root, "dirty-plan"),
    });
    expect(planned.source.inputsMatchHead).toBe(false);
    expect(planned.source.dirty).toContain("package.json");
    expect(planned.source.headManifestSha256).not.toBe(planned.package.manifestSha256);
    const artifactsDir = path.join(input.root, "refused-execution");
    expect(() =>
      runLocalPackageInstall({
        ...input,
        projectRoot: input.foreignRoot,
        artifactsDir,
        execute: true,
      })
    ).toThrow("Source checkpoint changed or is dirty");
    const receipt = JSON.parse(fs.readFileSync(path.join(artifactsDir, "receipt.json"), "utf8"));
    expect(
      receipt.commands.every((command: { name: string }) => command.name === "git-observe")
    ).toBe(true);
    expect(fs.existsSync(input.prefix)).toBe(false);
  }, 20_000);

  it("uses canonical ignored-artifact checks and strips mixed-case Git selectors", () => {
    const input = fixture();
    const artifactsDir = path.join(sourceRoot, "artifacts", path.basename(input.root));
    ownedArtifactRoots.push(artifactsDir);
    expect(
      spawnSync(
        "git",
        ["check-ignore", "--quiet", "--no-index", path.relative(sourceRoot, artifactsDir)],
        {
          cwd: sourceRoot,
          env: input.env,
          timeout: 10_000,
        }
      ).status
    ).not.toBe(0);
    const env = {
      ...input.env,
      git_index_file: path.join(input.root, "unowned-index"),
      GiT_COMMON_DIR: path.join(input.root, "missing-common-directory"),
    };
    const receipt = runLocalPackageInstall({
      projectRoot: sourceRoot,
      ...input,
      artifactsDir,
      env,
    });
    expect(receipt.status).toBe("planned");
    expect(receipt.source.head).toBe(git(["rev-parse", "HEAD"], sourceRoot));
    expect(fs.existsSync(path.join(artifactsDir, "receipt.json"))).toBe(true);
    expect(fs.existsSync(input.prefix)).toBe(false);
    expect(fs.existsSync(env.git_index_file)).toBe(false);
  });

  it("retains CLI selector refusal diagnostics in the owning ignored source area", () => {
    const input = fixture();
    const result = spawnSync(
      process.execPath,
      [
        path.join(sourceRoot, "scripts", "install-local-package.mjs"),
        "--prefix",
        "relative-prefix",
      ],
      { cwd: sourceRoot, env: input.env, encoding: "utf8", timeout: 10_000 }
    );
    expect(result.status).toBe(1);
    const receiptPath = /Receipt: ([^\r\n]+)/.exec(result.stderr)?.[1];
    expect(receiptPath).toBeTruthy();
    const directory = path.dirname(receiptPath!);
    ownedArtifactRoots.push(directory);
    expect(
      path.relative(path.join(sourceRoot, "artifacts", "local-install"), directory)
    ).not.toMatch(/^\.\./);
    expect(JSON.parse(fs.readFileSync(receiptPath!, "utf8"))).toMatchObject({
      status: "failed",
      phase: "preflight",
      commands: [],
    });
    expect(fs.existsSync(input.prefix)).toBe(false);
  });
});
