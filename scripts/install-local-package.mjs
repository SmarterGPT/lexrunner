import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import { observeNpmPolicyRuntime, assertNpmPolicyRuntimeUnchanged } from "./npm-policy-runtime.mjs";

const packageName = "@smartergpt/lexrunner";
const nativeName = "better-sqlite3-multiple-ciphers";
const nativeVersion = "12.11.1";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function parseLocalInstallArguments(args) {
  const options = { execute: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--execute" && !options.execute) options.execute = true;
    else if (["--prefix", "--artifacts-dir"].includes(argument)) {
      const key = argument === "--prefix" ? "prefix" : "artifactsDir";
      if (options[key] !== undefined || !args[index + 1] || args[index + 1].startsWith("--")) {
        throw new Error(`${argument} requires one explicit absolute path.`);
      }
      options[key] = args[++index];
    } else throw new Error(`Unsupported local-install argument: ${argument}`);
  }
  requireAbsoluteDirectory(options.prefix, "--prefix");
  if (options.artifactsDir !== undefined)
    requireAbsoluteDirectory(options.artifactsDir, "--artifacts-dir");
  return options;
}

export function validateLocalInstallInputs(projectRoot) {
  const manifestBytes = fs.readFileSync(path.join(projectRoot, "package.json"));
  const lockBytes = fs.readFileSync(path.join(projectRoot, "package-lock.json"));
  const manifest = JSON.parse(manifestBytes);
  const lock = JSON.parse(lockBytes);
  const root = lock.packages?.[""];
  if (
    manifest.name !== packageName ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version ?? "")
  ) {
    throw new Error("Local installer requires the canonical LexRunner manifest and version.");
  }
  if (
    lock.lockfileVersion !== 3 ||
    !root ||
    lock.name !== manifest.name ||
    lock.version !== manifest.version ||
    root.name !== manifest.name ||
    root.version !== manifest.version
  ) {
    throw new Error("Source manifest and lock package identity do not match.");
  }
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "engines",
    "bin",
  ]) {
    if (stableJSON(manifest[field] ?? {}) !== stableJSON(root[field] ?? {})) {
      throw new Error(`Source manifest and lock ${field} do not match.`);
    }
  }
  if (
    manifest.allowScripts?.[`${nativeName}@${nativeVersion}`] !== true ||
    manifest.allowScripts?.["@smartergpt/lex"] !== false ||
    lock.packages?.[`node_modules/${nativeName}`]?.version !== nativeVersion
  ) {
    throw new Error(
      "Local install requires the exact source-approved SQLite 12.11.1 lock and Lex script denial."
    );
  }
  for (const [specifier, decision] of Object.entries(manifest.allowScripts)) {
    if (
      typeof decision !== "boolean" ||
      (decision && !/^(?:@[^/]+\/)?[^@/]+@\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(specifier))
    ) {
      throw new Error(
        `Source install-script policy must use exact registry approvals: ${specifier}`
      );
    }
  }
  return {
    manifest,
    manifestBytes,
    lockBytes,
    manifestSha256: sha256(manifestBytes),
    lockSha256: sha256(lockBytes),
  };
}

export function inspectLocalInstallTarget(prefix, projectRoot, platform = process.platform) {
  requireAbsoluteDirectory(prefix, "--prefix");
  const physicalPrefix = resolveFuturePath(prefix);
  const sourceRoot = fs.realpathSync(projectRoot);
  if (isWithin(sourceRoot, physicalPrefix) || isWithin(physicalPrefix, sourceRoot)) {
    throw new Error("Local install prefix must be separate from the source checkout.");
  }
  const globalModulesRoot = path.join(
    prefix,
    ...(platform === "win32" ? [] : ["lib"]),
    "node_modules"
  );
  const installedRoot = path.join(globalModulesRoot, "@smartergpt", "lexrunner");
  for (const target of [
    globalModulesRoot,
    installedRoot,
    path.join(installedRoot, "package.json"),
    path.join(installedRoot, "package-lock.json"),
  ]) {
    if (!isWithin(resolveFuturePath(target), physicalPrefix))
      throw new Error(`Installed target escapes the explicit physical prefix: ${target}`);
  }
  const manifestPath = path.join(installedRoot, "package.json");
  const lockPath = path.join(installedRoot, "package-lock.json");
  let existingPackage = null;
  if (fs.existsSync(manifestPath)) {
    const bytes = fs.readFileSync(manifestPath);
    const manifest = JSON.parse(bytes);
    if (manifest.name !== packageName)
      throw new Error("Existing target package identity is ambiguous.");
    existingPackage = {
      name: manifest.name,
      version: manifest.version,
      manifestSha256: sha256(bytes),
      lockSha256: fs.existsSync(lockPath) ? sha256(fs.readFileSync(lockPath)) : null,
    };
  } else if (fs.existsSync(installedRoot) && fs.readdirSync(installedRoot).length > 0) {
    throw new Error("Existing nonempty target has no LexRunner package identity.");
  }
  return {
    prefix: path.resolve(prefix),
    physicalPrefix,
    globalModulesRoot,
    installedRoot,
    physicalInstalledRoot: resolveFuturePath(installedRoot),
    existingPackage,
  };
}

export function createLocalInstallPlan({ projectRoot, prefix, artifactsDir, npmRuntime, source }) {
  const inputs = validateLocalInstallInputs(projectRoot);
  const target = inspectLocalInstallTarget(prefix, projectRoot);
  return {
    schemaVersion: "lexrunner-local-install/v2",
    status: "planned",
    projectRoot: fs.realpathSync(projectRoot),
    artifactsDir,
    source,
    npmRuntime,
    target,
    package: {
      name: inputs.manifest.name,
      version: inputs.manifest.version,
      manifestSha256: inputs.manifestSha256,
      lockSha256: inputs.lockSha256,
    },
    commands: [],
    plannedCommands: installationCommands(
      target,
      path.join(artifactsDir, "packed-current-source.tgz")
    ),
    executionRequirements: [
      "clean matching source HEAD/tree/manifest/lock",
      "git verify-commit HEAD succeeds",
      "external independent review of exact source checkpoint",
    ],
    qualification: {
      localDogfoodOnly: true,
      releaseQualified: false,
      existingMcpProcessesReloaded: false,
    },
  };
}

export function runLocalPackageInstall({
  projectRoot = process.cwd(),
  prefix,
  artifactsDir,
  execute = false,
  env = process.env,
}) {
  requireAbsoluteDirectory(prefix, "--prefix");
  const root = fs.realpathSync(projectRoot);
  const outputRoot = artifactsDir ?? path.join(root, "artifacts", "local-install", randomUUID());
  requireAbsoluteDirectory(outputRoot, "--artifacts-dir");
  // Receipt storage must not become an installation target or modify source files.
  const target = inspectLocalInstallTarget(prefix, root);
  if (isWithin(resolveFuturePath(outputRoot), target.physicalPrefix))
    throw new Error("Install artifacts must be outside the target prefix.");
  const physicalOutputRoot = resolveFuturePath(outputRoot);
  if (isWithin(physicalOutputRoot, root)) {
    const relativeOutputRoot = path.relative(root, physicalOutputRoot);
    const ignored = spawnSync(
      "git",
      ["check-ignore", "--quiet", "--no-index", relativeOutputRoot],
      { cwd: root, encoding: "utf8", timeout: 10_000, windowsHide: true }
    );
    const tracked = spawnSync("git", ["ls-files", "--", relativeOutputRoot], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    if (ignored.status !== 0 || tracked.status !== 0 || tracked.stdout?.trim())
      throw new Error(
        "Install artifacts inside the source checkout require an ignored directory with no tracked files."
      );
  }
  if (fs.existsSync(outputRoot) && fs.readdirSync(outputRoot).length)
    throw new Error("Local-install artifacts require a new or empty directory.");
  fs.mkdirSync(outputRoot, { recursive: true });
  let receipt = {
    schemaVersion: "lexrunner-local-install/v2",
    status: "preflight",
    projectRoot: root,
    artifactsDir: outputRoot,
    target,
    commands: [],
    startedAt: new Date().toISOString(),
  };
  const save = () =>
    fs.writeFileSync(
      path.join(outputRoot, "receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`
    );
  save();
  const run = (name, executable, args, cwd, commandEnv = env) => {
    const index = receipt.commands.length;
    const command = { name, executable, args, cwd, startedAt: new Date().toISOString() };
    receipt.commands.push(command);
    save();
    const result = spawnSync(executable, args, {
      cwd,
      env: commandEnv,
      encoding: "utf8",
      timeout: 10 * 60_000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      shell: false,
    });
    for (const stream of ["stdout", "stderr"]) {
      const bytes = Buffer.from(result[stream] ?? "");
      const filename = `${String(index).padStart(3, "0")}-${name}.${stream}.log`;
      fs.writeFileSync(path.join(outputRoot, filename), bytes);
      command[`${stream}Path`] = filename;
      command[`${stream}Sha256`] = sha256(bytes);
    }
    Object.assign(command, {
      completedAt: new Date().toISOString(),
      exitCode: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
    });
    save();
    if (result.error || result.status !== 0 || result.signal)
      throw new Error(
        `${name} failed (exit ${result.status}): ${result.error?.message ?? result.stderr.slice(-1500)}`
      );
    return result.stdout;
  };
  const git = (args) => run("git-observe", "git", args, root).trim();
  const observeSource = () => ({
    head: git(["rev-parse", "HEAD"]),
    tree: git(["rev-parse", "HEAD^{tree}"]),
    branch: git(["branch", "--show-current"]),
    dirty: git(["status", "--porcelain=v1", "--untracked-files=all"]),
  });
  let runtime;
  let source;
  const assertSource = () => {
    const current = observeSource();
    const inputs = validateLocalInstallInputs(root);
    if (
      current.head !== source.head ||
      current.tree !== source.tree ||
      current.dirty ||
      inputs.manifestSha256 !== receipt.package.manifestSha256 ||
      inputs.lockSha256 !== receipt.package.lockSha256
    ) {
      throw new Error("Source checkpoint changed or is dirty; local installation refused.");
    }
    assertNpmPolicyRuntimeUnchanged(runtime);
  };
  const assertTarget = () => {
    const current = inspectLocalInstallTarget(prefix, root);
    if (
      current.physicalPrefix !== target.physicalPrefix ||
      current.physicalInstalledRoot !== target.physicalInstalledRoot
    )
      throw new Error("Installation target changed since planning.");
    return current;
  };
  try {
    const inputs = validateLocalInstallInputs(root);
    rejectPolicyEnvironment(env);
    runtime = observeNpmPolicyRuntime({ projectRoot: root, env });
    receipt.npmRuntime = runtime;
    source = observeSource();
    const recordedCommands = receipt.commands;
    receipt = {
      ...receipt,
      ...createLocalInstallPlan({
        projectRoot: root,
        prefix,
        artifactsDir: outputRoot,
        npmRuntime: runtime,
        source,
      }),
      commands: recordedCommands,
    };
    fs.writeFileSync(path.join(outputRoot, "source-package.json"), inputs.manifestBytes);
    fs.writeFileSync(path.join(outputRoot, "source-package-lock.json"), inputs.lockBytes);
    const priorLock = path.join(target.installedRoot, "package-lock.json");
    if (fs.existsSync(priorLock)) {
      const bytes = fs.readFileSync(priorLock);
      fs.writeFileSync(path.join(outputRoot, "previous-installed-package-lock.json"), bytes);
      receipt.previousInstalledLock = {
        artifactPath: "previous-installed-package-lock.json",
        sha256: sha256(bytes),
      };
      if (receipt.previousInstalledLock.sha256 !== target.existingPackage?.lockSha256)
        throw new Error("Existing installed lock changed while being preserved.");
    }
    save();
    if (!execute) return receipt;

    assertSource();
    run("source-signature", "git", ["verify-commit", source.head], root);
    receipt.source.signatureVerified = true;
    const npmEnv = { ...env, npm_execpath: runtime.npmCliPath };
    const npm = (name, args, cwd = root) => {
      assertSource();
      assertTarget();
      const output = run(name, runtime.nodeExecutable, [runtime.npmCliPath, ...args], cwd, npmEnv);
      assertSource();
      assertTarget();
      return output;
    };
    // npm ci dry-run validates the full virtual/ideal lock graph and skips its
    // node_modules removal branch. Scripts are explicitly suppressed as well.
    npm("source-lock-preflight", [
      "ci",
      "--global=false",
      "--prefix",
      root,
      "--dry-run",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
    npm("source-build", ["run", "build"]);
    const packs = JSON.parse(
      npm("source-pack", ["pack", "--json", "--ignore-scripts", "--pack-destination", outputRoot])
    );
    if (
      !Array.isArray(packs) ||
      packs.length !== 1 ||
      !packs[0].filename ||
      path.basename(packs[0].filename) !== packs[0].filename
    )
      throw new Error("npm pack returned an ambiguous tarball.");
    const tarballPath = path.join(outputRoot, packs[0].filename);
    const tarball = fs.readFileSync(tarballPath);
    const packedFiles = inspectLocalInstallTarball(tarball);
    const packedManifest = JSON.parse(
      packedFiles.find((file) => file.path === "package.json")?.bytes ?? "null"
    );
    if (stableJSON(packedManifest) !== stableJSON(inputs.manifest))
      throw new Error("Packed manifest differs from the exact source manifest.");
    if (
      stableJSON(packedFiles.map((file) => file.path).sort()) !==
      stableJSON(packs[0].files.map((file) => file.path).sort())
    )
      throw new Error("Packed archive files differ from npm pack report.");
    receipt.tarball = {
      path: tarballPath,
      bytes: tarball.length,
      sha256: sha256(tarball),
      integrity: packs[0].integrity,
    };
    receipt.packedFiles = packedFiles.map(({ path: relative, bytes }) => ({
      path: relative,
      bytes: bytes.length,
      sha256: sha256(bytes),
    }));
    receipt.plannedCommands = installationCommands(target, tarballPath);
    receipt.status = "installing";
    save();
    assertSource();
    if (sha256(fs.readFileSync(tarballPath)) !== receipt.tarball.sha256)
      throw new Error("Packed tarball changed before installation.");
    if (stableJSON(assertTarget().existingPackage) !== stableJSON(target.existingPackage))
      throw new Error("Existing target package identity changed before global installation.");
    npm("global-install-without-scripts", receipt.plannedCommands[0].args);
    assertSource();
    assertTarget();
    verifyInstalledPackedFiles(receipt.packedFiles, target.installedRoot);
    const installedLock = path.join(target.installedRoot, "package-lock.json");
    if (fs.existsSync(installedLock)) {
      const bytes = fs.readFileSync(installedLock);
      fs.writeFileSync(path.join(outputRoot, "post-global-installed-package-lock.json"), bytes);
      receipt.replacedLockSha256 = sha256(bytes);
    }
    fs.writeFileSync(installedLock, inputs.lockBytes);
    receipt.deploymentLock = {
      path: installedLock,
      sourceHead: source.head,
      sha256: sha256(fs.readFileSync(installedLock)),
      deploymentMetadata: true,
    };
    save();
    npm("locked-runtime-dependencies", receipt.plannedCommands[1].args, target.installedRoot);
    npm("approved-native-rebuild", receipt.plannedCommands[2].args, target.installedRoot);
    const pending = npm(
      "pending-install-scripts",
      receipt.plannedCommands[3].args,
      target.installedRoot
    ).trim();
    if (pending !== "No packages with unreviewed install scripts.")
      throw new Error(`Installed package has an ambiguous pending-script result: ${pending}`);
    const nativeFixturePath = path.join(outputRoot, "private-native-fixture.sqlite");
    const probe = `const version=require(${JSON.stringify(path.join(target.installedRoot, "node_modules", nativeName, "package.json"))}).version; if(version!==${JSON.stringify(nativeVersion)}) throw new Error('installed native package version differs from source lock'); const Database=require(${JSON.stringify(path.join(target.installedRoot, "node_modules", nativeName))}); const db=new Database(${JSON.stringify(nativeFixturePath)}); try { db.exec('CREATE TABLE local_install_probe(value INTEGER)'); db.prepare('INSERT INTO local_install_probe VALUES (?)').run(42); if(db.prepare('SELECT value FROM local_install_probe').get().value!==42) throw new Error('private SQLite query failed'); console.log(JSON.stringify({status:'passed',version,privateFixture:true})); } finally { db.close(); }`;
    assertSource();
    receipt.nativeSqlite = JSON.parse(
      run(
        "private-native-fixture",
        runtime.nodeExecutable,
        ["--eval", probe],
        target.installedRoot,
        npmEnv
      )
    );
    receipt.nativeSqlite.fixtureSha256 = sha256(fs.readFileSync(nativeFixturePath));
    assertSource();
    assertTarget();
    verifyInstalledPackedFiles(receipt.packedFiles, target.installedRoot);
    if (sha256(fs.readFileSync(installedLock)) !== inputs.lockSha256)
      throw new Error("Installed deployment lock changed during qualification.");
    if (
      sha256(fs.readFileSync(tarballPath)) !== receipt.tarball.sha256 ||
      sha256(fs.readFileSync(path.join(outputRoot, "source-package-lock.json"))) !==
        inputs.lockSha256
    )
      throw new Error("Retained tarball or source lock changed during qualification.");
    receipt.installedAfter = inspectLocalInstallTarget(prefix, root).existingPackage;
    receipt.status = "installed_and_verified";
    receipt.pendingInstallScripts = 0;
    return receipt;
  } catch (error) {
    receipt.status = "failed";
    receipt.error = error.message;
    error.receiptPath = path.join(outputRoot, "receipt.json");
    throw error;
  } finally {
    let finalObservationError;
    if (runtime) {
      try {
        assertNpmPolicyRuntimeUnchanged(runtime);
        receipt.runtimeUnchangedAfter = true;
      } catch (error) {
        receipt.status = "failed";
        receipt.runtimeObservationError = error.message;
        finalObservationError = error;
      }
    }
    if (source) {
      try {
        receipt.sourceAfter = observeSource();
        const currentInputs = validateLocalInstallInputs(root);
        receipt.sourceAfter.manifestSha256 = currentInputs.manifestSha256;
        receipt.sourceAfter.lockSha256 = currentInputs.lockSha256;
        if (
          execute &&
          receipt.status === "installed_and_verified" &&
          (receipt.sourceAfter.head !== source.head ||
            receipt.sourceAfter.tree !== source.tree ||
            receipt.sourceAfter.dirty ||
            currentInputs.manifestSha256 !== receipt.package.manifestSha256 ||
            currentInputs.lockSha256 !== receipt.package.lockSha256)
        )
          throw new Error("Source changed after local installation qualification.");
      } catch (error) {
        receipt.status = "failed";
        receipt.sourceObservationError = error.message;
        finalObservationError = error;
      }
    }
    receipt.completedAt = new Date().toISOString();
    save();
    if (finalObservationError) {
      finalObservationError.receiptPath = path.join(outputRoot, "receipt.json");
      throw finalObservationError;
    }
  }
}

export function inspectLocalInstallTarball(bytes) {
  if (bytes.length > 10 * 1024 * 1024)
    throw new Error("Packed tarball exceeds the local observation bound.");
  const archive = gunzipSync(bytes, { maxOutputLength: 10 * 1024 * 1024 });
  const files = [];
  let pendingPath;
  let terminated = false;
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (archive.subarray(offset).some((byte) => byte !== 0))
        throw new Error("Packed tar contains data after its terminator.");
      terminated = true;
      break;
    }
    const read = (start, length) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .split("\0")[0];
    const checksumText = read(148, 8).trim();
    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0
    );
    if (!/^[0-7]+$/.test(checksumText) || Number.parseInt(checksumText, 8) !== checksum)
      throw new Error("Packed tar entry checksum is invalid.");
    const sizeText = read(124, 12).trim();
    if (!/^[0-7]+$/.test(sizeText)) throw new Error("Packed tar entry has an invalid size.");
    const size = Number.parseInt(sizeText, 8);
    const payload = archive.subarray(offset + 512, offset + 512 + size);
    if (payload.length !== size) throw new Error("Packed tar entry is truncated.");
    const type = read(156, 1);
    let name = pendingPath ?? [read(345, 155), read(0, 100)].filter(Boolean).join("/");
    pendingPath = undefined;
    if (type === "x") {
      let cursor = 0;
      while (cursor < payload.length) {
        const space = payload.indexOf(32, cursor);
        const length = Number(payload.subarray(cursor, space).toString());
        if (
          space < cursor ||
          !Number.isInteger(length) ||
          length <= space - cursor + 1 ||
          cursor + length > payload.length
        )
          throw new Error("Invalid packed tar PAX metadata.");
        const record = payload.subarray(space + 1, cursor + length - 1).toString();
        if (record.startsWith("path=")) pendingPath = record.slice(5);
        cursor += length;
      }
    } else if (type === "0" || type === "") {
      if (!name.startsWith("package/"))
        throw new Error("Packed file is outside the package archive root.");
      name = name.slice(8);
      if (
        !name ||
        name.includes("\\") ||
        name.includes(":") ||
        path.posix.isAbsolute(name) ||
        name.split("/").some((part) => ["..", ".", ""].includes(part)) ||
        files.some((file) => file.path === name)
      )
        throw new Error("Packed file path is ambiguous or escapes its root.");
      files.push({ path: name, bytes: payload });
      if (files.length > 120) throw new Error("Packed package exceeds the local file-count bound.");
    } else if (type === "5") {
      const directory = name.replace(/\/$/, "");
      if (
        directory !== "package" &&
        (!directory.startsWith("package/") ||
          directory.includes("\\") ||
          directory.includes(":") ||
          directory.split("/").some((part) => ["..", ".", ""].includes(part)))
      )
        throw new Error("Packed directory escapes the package archive root.");
    } else throw new Error("Packed archive contains unsupported non-file entries.");
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!terminated || pendingPath)
    throw new Error("Packed archive is truncated or has dangling metadata.");
  if (!files.length) throw new Error("Packed archive contains no files.");
  return files;
}

export function verifyInstalledPackedFiles(files, installedRoot) {
  const physicalRoot = fs.realpathSync(installedRoot);
  for (const file of files) {
    const target = path.join(installedRoot, file.path);
    if (
      !isWithin(fs.realpathSync(target), physicalRoot) ||
      sha256(fs.readFileSync(target)) !== file.sha256
    )
      throw new Error(`Installed packed file differs or escapes its package root: ${file.path}`);
  }
}

function installationCommands(target, tarball) {
  return [
    {
      name: "global-install-without-scripts",
      args: [
        "install",
        "--global",
        "--prefix",
        target.prefix,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        tarball,
      ],
    },
    {
      name: "locked-runtime-dependencies",
      args: [
        "ci",
        "--global=false",
        "--prefix",
        target.installedRoot,
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
    },
    {
      name: "approved-native-rebuild",
      args: [
        "rebuild",
        "--global=false",
        "--prefix",
        target.installedRoot,
        `${nativeName}@${nativeVersion}`,
        "--strict-allow-scripts",
        "--ignore-scripts=false",
        "--dangerously-allow-all-scripts=false",
      ],
    },
    {
      name: "pending-install-scripts",
      args: [
        "approve-scripts",
        "--global=false",
        "--prefix",
        target.installedRoot,
        "--allow-scripts-pending",
      ],
    },
  ];
}

function rejectPolicyEnvironment(env) {
  for (const [name, value] of Object.entries(env)) {
    if (/^npm_config_allow_scripts$/i.test(name) && value)
      throw new Error(
        "Local installer refuses inherited allow-scripts overrides of the source policy."
      );
    if (
      /^npm_config_node_options$/i.test(name) &&
      /--(?:require|import|(?:experimental-)?loader)|(?:^|\s)-r/.test(value ?? "")
    )
      throw new Error("Local installer refuses inherited executable lifecycle preloads.");
  }
}

function requireAbsoluteDirectory(value, label) {
  if (
    typeof value !== "string" ||
    !value ||
    !path.isAbsolute(value) ||
    value.includes("\0") ||
    path.resolve(value) === path.parse(path.resolve(value)).root
  )
    throw new Error(`${label} requires an explicit absolute directory below a filesystem root.`);
}

function resolveFuturePath(value) {
  const suffix = [];
  let ancestor = path.resolve(value);
  while (!pathExists(ancestor)) {
    suffix.unshift(path.basename(ancestor));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error(`Cannot resolve target ancestor: ${value}`);
    ancestor = parent;
  }
  return path.join(fs.realpathSync(ancestor), ...suffix);
}

function pathExists(value) {
  try {
    fs.lstatSync(value);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function isWithin(target, root) {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function stableJSON(value) {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJSON(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseLocalInstallArguments(process.argv.slice(2));
    const receipt = runLocalPackageInstall(options);
    console.log(
      JSON.stringify({
        status: receipt.status,
        receiptPath: path.join(receipt.artifactsDir, "receipt.json"),
        sourceHead: receipt.source.head,
        target: receipt.target,
        qualification: receipt.qualification,
      })
    );
  } catch (error) {
    let receiptPath = error.receiptPath;
    // Invalid CLI/target/artifact selectors have no safe caller-selected receipt
    // destination. Retain that refusal in this repo's ignored diagnostics area.
    if (!receiptPath) {
      try {
        const root = fs.realpathSync(process.cwd());
        if (JSON.parse(fs.readFileSync(path.join(root, "package.json"))).name !== packageName)
          throw new Error("not the canonical package");
        const directory = path.join(root, "artifacts", "local-install", randomUUID());
        const ignored = spawnSync(
          "git",
          ["check-ignore", "--quiet", "--no-index", path.relative(root, directory)],
          { cwd: root, timeout: 10_000, windowsHide: true }
        );
        if (ignored.status !== 0) throw new Error("no ignored diagnostic destination");
        fs.mkdirSync(directory, { recursive: true });
        receiptPath = path.join(directory, "receipt.json");
        fs.writeFileSync(
          receiptPath,
          `${JSON.stringify({ schemaVersion: "lexrunner-local-install/v2", status: "failed", phase: "preflight", error: error.message, requestedArguments: process.argv.slice(2), commands: [], completedAt: new Date().toISOString() }, null, 2)}\n`
        );
      } catch {
        /* Keep the original refusal if diagnostic storage is unavailable. */
      }
    }
    console.error(`${error.message}${receiptPath ? `\nReceipt: ${receiptPath}` : ""}`);
    process.exitCode = 1;
  }
}
