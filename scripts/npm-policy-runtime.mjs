import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const probeTimeoutMs = 10_000;
const probeMaxBuffer = 16 * 1024;
const executableMaxBytes = 256 * 1024 * 1024;

/**
 * Qualify the executable used by packaging/install-policy lanes, independently of
 * the packageManager declaration. The fallback is npm's Node-adjacent JS entry;
 * PATH and command shims are deliberately not searched.
 */
export function observeNpmPolicyRuntime({
  projectRoot,
  npmCliPath,
  env = process.env,
  nodeExecutable = process.execPath,
}) {
  const root = path.resolve(projectRoot);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const pin = /^npm@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager ?? "");
  if (!pin)
    throw new Error("Install-policy qualification requires an exact npm packageManager pin.");
  const lifecycleNodeOptions = assertNoNodePreload(env);

  const selectedNodeExecutable = selectAbsolutePath(nodeExecutable, "Node executable", root);
  const selected = npmCliPath ?? env.npm_execpath;
  const selection =
    npmCliPath !== undefined ? "explicit" : selected ? "npm_execpath" : "node-adjacent";
  const selectedNpmCliPath =
    npmCliPath !== undefined || selected
      ? selectAbsolutePath(selected, "npm CLI", root)
      : path.join(path.dirname(selectedNodeExecutable), "node_modules", "npm", "bin", "npm-cli.js");
  const nodeIdentity = observeFile(selectedNodeExecutable, "Node executable");
  const npmIdentity = observeFile(selectedNpmCliPath, "npm CLI");
  const identity = {
    selectedNodeExecutable,
    nodeExecutable: nodeIdentity.physicalPath,
    nodeExecutableSha256: nodeIdentity.sha256,
    selectedNpmCliPath,
    npmCliPath: npmIdentity.physicalPath,
    npmCliSha256: npmIdentity.sha256,
  };

  const probe = (args, label, nodeOnly = false) => {
    assertNpmPolicyRuntimeUnchanged(identity);
    const result = spawnSync(
      identity.nodeExecutable,
      nodeOnly ? args : [identity.npmCliPath, ...args],
      {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: probeTimeoutMs,
        maxBuffer: probeMaxBuffer,
        windowsHide: true,
        shell: false,
      }
    );
    assertNpmPolicyRuntimeUnchanged(identity);
    if (result.error || result.status !== 0 || result.signal) {
      const detail = result.error?.message ?? (result.stderr?.trim() || `exit ${result.status}`);
      throw new Error(`Unable to observe ${label}: ${String(detail).slice(0, 1000)}`);
    }
    return result.stdout.trim();
  };

  const nodeVersion = probe(["--version"], "Node version", true);
  const requiredNodeMajor = validateObservedNodeRuntime(nodeVersion, manifest.engines?.node);
  const npmVersion = probe(["--version"], "npm version");
  if (!/^\d+\.\d+\.\d+$/.test(npmVersion))
    throw new Error("npm returned a malformed version response.");
  if (npmVersion !== pin[1]) {
    throw new Error(
      `Install-policy qualification requires npm ${pin[1]}; observed ${npmVersion} at ${identity.npmCliPath}.`
    );
  }
  const approvalUsage = probe(["approve-scripts", "--usage"], "npm approve-scripts capability");
  const installUsage = probe(["install", "--usage"], "npm install-script policy capability");
  if (
    !approvalUsage.includes("npm approve-scripts") ||
    !approvalUsage.includes("--allow-scripts-pending") ||
    !installUsage.includes("--allow-scripts") ||
    !installUsage.includes("--strict-allow-scripts")
  ) {
    throw new Error(
      `Observed npm ${npmVersion} lacks the required approve-scripts/allowScripts policy capabilities.`
    );
  }

  return Object.freeze({
    ...identity,
    selection,
    nodeVersion,
    requiredNodeMajor,
    nodeEngine: manifest.engines.node,
    lifecycleNodeOptions,
    npmVersion,
    requiredNpmVersion: pin[1],
    policyCapabilities: Object.freeze(["approve-scripts", "allow-scripts", "strict-allow-scripts"]),
  });
}

/** Check the observed executable version against the source's supported floor. */
export function validateObservedNodeRuntime(nodeVersion, engineRange) {
  const floor = /^>=([1-9]\d*)$/.exec(engineRange ?? "");
  if (!floor || !Number.isSafeInteger(Number(floor[1]))) {
    throw new Error(
      "Install-policy qualification requires a supported source engines.node floor (>=N)."
    );
  }
  const version = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(nodeVersion ?? "");
  if (!version || version.slice(1).some((part) => !Number.isSafeInteger(Number(part)))) {
    throw new Error("Node returned a malformed version response.");
  }
  const requiredMajor = Number(floor[1]);
  if (Number(version[1]) < requiredMajor) {
    throw new Error(
      `Install-policy qualification requires Node ${engineRange}; observed ${nodeVersion}.`
    );
  }
  return requiredMajor;
}

/** Disk path/hash observations are consistency checks, not an executable lock. */
export function assertNpmPolicyRuntimeUnchanged(observation) {
  for (const [label, selected, physical, hash] of [
    ["npm CLI", observation.selectedNpmCliPath, observation.npmCliPath, observation.npmCliSha256],
    [
      "Node executable",
      observation.selectedNodeExecutable,
      observation.nodeExecutable,
      observation.nodeExecutableSha256,
    ],
  ]) {
    const current = observeFile(selected, label);
    if (current.physicalPath !== physical || current.sha256 !== hash) {
      throw new Error(`${label} changed since the npm policy runtime observation: ${selected}`);
    }
  }
}

function selectAbsolutePath(value, label, root) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.includes("\0") ||
    value.trim().startsWith("-")
  ) {
    throw new Error(`${label} must be an executable file path, not command-line switches.`);
  }
  return path.resolve(root, value.trim());
}

function assertNoNodePreload(env) {
  const optionKeys = Object.keys(env).filter(
    (key) => key.toUpperCase() === "NODE_OPTIONS" && env[key] !== undefined
  );
  if (optionKeys.length > 1) {
    throw new Error(
      "Install-policy qualification refuses ambiguous duplicate NODE_OPTIONS environment keys."
    );
  }
  const options = optionKeys.length ? String(env[optionKeys[0]]) : "";
  if (
    /(?:^|\s|["'])(?:--(?:require|import|(?:experimental-)?loader)(?:=|\s|$)|-r\S*)/.test(options)
  ) {
    throw new Error("Install-policy qualification refuses executable preloads in NODE_OPTIONS.");
  }
  // npm trims whitespace before exporting config to nested npm processes.
  // Node accepts an empty quoted token as no options; npm preserves that token.
  return options.trim() ? options : '""';
}

function observeFile(selectedPath, label) {
  let descriptor;
  try {
    const physicalPath = fs.realpathSync(selectedPath);
    descriptor = fs.openSync(physicalPath, "r");
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size === 0 || before.size > executableMaxBytes) {
      throw new Error("expected a nonempty executable file within the observation size bound");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let bytes;
    let total = 0;
    while ((bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      total += bytes;
      if (total > executableMaxBytes)
        throw new Error("executable exceeded the observation size bound");
      hash.update(buffer.subarray(0, bytes));
    }
    const after = fs.fstatSync(descriptor);
    const current = fs.statSync(physicalPath);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      after.dev !== current.dev ||
      after.ino !== current.ino ||
      after.size !== current.size ||
      after.mtimeMs !== current.mtimeMs ||
      fs.realpathSync(selectedPath) !== physicalPath
    ) {
      throw new Error("executable changed while its identity was observed");
    }
    return { physicalPath, sha256: hash.digest("hex") };
  } catch (error) {
    throw new Error(`Unable to observe ${label} at ${selectedPath}: ${error.message}`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
