import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { assertNpmPolicyRuntimeUnchanged } from "./npm-policy-runtime.mjs";

const reviewedPostinstall = String.raw`node -e "console.log('\n📦 lexrunner installed! Run \"npx lexrunner init\" to set up your workspace. The \"lex-pr\" compatibility alias remains supported.\n')"`;
const reviewedPostinstallOutput =
  '📦 lexrunner installed! Run "npx lexrunner init" to set up your workspace. The "lex-pr" compatibility alias remains supported.';

export function reviewPackedArtifactLifecycle(sourceManifest) {
  const scripts = sourceManifest.scripts ?? {};
  if (
    sourceManifest.name !== "@smartergpt/lexrunner" ||
    scripts.postinstall !== reviewedPostinstall ||
    scripts.prepare !== "husky" ||
    scripts.preinstall !== undefined ||
    scripts.install !== undefined
  ) {
    throw new Error(
      "Packed artifact lifecycle differs from the reviewed informational postinstall/source prepare contract"
    );
  }
  return {
    approval: "exact_immutable_artifact_url",
    reason: "reviewed_informational_postinstall_and_source_husky_prepare_contract",
    postinstall: reviewedPostinstall,
    sourcePrepare: "husky",
  };
}

export async function readPackedArtifactManifest({ npmRuntime, tarballPath, expectedIntegrity }) {
  assertNpmPolicyRuntimeUnchanged(npmRuntime);
  const bytes = fs.readFileSync(tarballPath);
  if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== expectedIntegrity) {
    throw new Error("Packed manifest inspection does not match the frozen artifact integrity");
  }
  const requireNpm = createRequire(npmRuntime.npmCliPath);
  const tar = requireNpm("tar");
  const parts = [];
  let manifestEntries = 0;
  await new Promise((resolve, reject) => {
    const parser = tar.t({
      onReadEntry(entry) {
        if (entry.path !== "package/package.json") return;
        manifestEntries++;
        if (entry.size > 256 * 1024) {
          reject(new Error("Packed manifest exceeded the inspection size bound"));
          return;
        }
        entry.on("data", (chunk) => parts.push(chunk));
      },
    });
    parser.once("error", reject);
    parser.once("end", resolve);
    parser.end(bytes);
  });
  if (manifestEntries !== 1)
    throw new Error("Packed artifact requires exactly one package manifest");
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}

export function createPackedConsumerManifest(sourceManifest, tarballSpecifier) {
  const sourcePolicy = sourceManifest.allowScripts;
  if (!sourcePolicy || typeof sourcePolicy !== "object" || Array.isArray(sourcePolicy)) {
    throw new Error("Packed consumer requires the reviewed source install-script policy");
  }

  reviewPackedArtifactLifecycle(sourceManifest);
  const artifactUrl = new URL(tarballSpecifier);
  if (
    artifactUrl.protocol !== "http:" ||
    artifactUrl.hostname !== "127.0.0.1" ||
    !artifactUrl.port ||
    artifactUrl.username ||
    artifactUrl.password ||
    artifactUrl.search ||
    artifactUrl.hash
  ) {
    throw new Error("Packed artifact approval requires its exact owned loopback URL");
  }
  if (sourcePolicy["@smartergpt/lex"] !== false) {
    throw new Error("Packed consumer requires the reviewed @smartergpt/lex script denial");
  }
  for (const [specifier, allowed] of Object.entries(sourcePolicy)) {
    if (typeof allowed !== "boolean") {
      throw new Error(`Invalid install-script decision for ${specifier}`);
    }
    if (allowed && !/^(?:@[^/]+\/)?[^@/]+@\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(specifier)) {
      throw new Error(`Packed consumer requires exact registry script approvals: ${specifier}`);
    }
  }

  return {
    name: "lexrunner-packed-smoke",
    private: true,
    type: "module",
    dependencies: { [sourceManifest.name]: tarballSpecifier },
    // Approve only this frozen artifact's reviewed lifecycle. npm's false rule
    // also suppresses bin links, which the actual packed CLI checks require.
    allowScripts: { ...sourcePolicy, [tarballSpecifier]: true },
  };
}

export async function servePackedTarball(tarballPath) {
  // npm 11.16's file-policy matcher compares incompatible Windows slash forms.
  // A loopback URL has one identity for both fetching and exact script denial.
  const bytes = fs.readFileSync(tarballPath);
  const endpoint = `/${randomUUID()}/packed-candidate.tgz`;
  const server = http.createServer((request, response) => {
    if (request.url !== endpoint || !["GET", "HEAD"].includes(request.method)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": bytes.length,
      "Cache-Control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : bytes);
  });
  server.maxConnections = 4;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}${endpoint}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    byteLength: bytes.length,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}

export async function installPackedConsumer({ npmRuntime, consumerRoot, env = process.env }) {
  assertNpmPolicyRuntimeUnchanged(npmRuntime);
  const result = await runOwnedPackedInstallCommand({
    nodeExecutable: npmRuntime.nodeExecutable,
    npmCliPath: npmRuntime.npmCliPath,
    consumerRoot,
    env,
    lifecycleNodeOptions: npmRuntime.lifecycleNodeOptions,
  });
  assertNpmPolicyRuntimeUnchanged(npmRuntime);
  return result;
}

export function runOwnedPackedInstallCommand({
  nodeExecutable,
  npmCliPath,
  consumerRoot,
  env = process.env,
  lifecycleNodeOptions,
  spawnProcess = spawn,
  commandTimeoutMs = 120_000,
  releaseTimeoutMs = 5_000,
  maxOutputBytes = 10 * 1024 * 1024,
}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(
      nodeExecutable,
      [npmCliPath, ...packedConsumerInstallArguments(lifecycleNodeOptions)],
      {
        cwd: consumerRoot,
        env: ownedNpmLifecycleEnvironment(env, lifecycleNodeOptions),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      }
    );
    let output = "";
    let bytes = 0;
    let failure;
    let terminationRequested = false;
    let settled = false;
    let commandTimer;
    let releaseTimer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(commandTimer);
      clearTimeout(releaseTimer);
      if (error) reject(error);
      else resolve(result);
    };
    const failureResult = (message, ownedProcessClosed, release) =>
      Object.assign(new Error(message), {
        ownedProcessClosed,
        resourceRelease: release,
        ownedProcessId: child.pid,
        retainedConsumerRoot: release === "uncertain" ? consumerRoot : undefined,
      });
    const awaitOwnedClose = () => {
      clearTimeout(commandTimer);
      releaseTimer = setTimeout(() => {
        finish(
          failureResult(
            `${failure.message}; owned npm process did not close within ${releaseTimeoutMs}ms; resource release is uncertain.`,
            false,
            "uncertain"
          )
        );
      }, releaseTimeoutMs);
    };
    const stopOwnedProcess = (reason) => {
      if (failure || settled) return;
      failure = reason;
      terminationRequested = true;
      awaitOwnedClose();
      try {
        child.kill();
      } catch (error) {
        failure = new Error(`${reason.message}; owned termination failed: ${error.message}`);
      }
    };
    const collect = (chunk) => {
      if (failure || settled) return;
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        stopOwnedProcess(new Error("Packed consumer install exceeded the output budget"));
      } else output += chunk.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.stdout.on("error", stopOwnedProcess);
    child.stderr.on("error", stopOwnedProcess);
    child.once("error", (error) => {
      if (failure || settled) return;
      failure = error;
      awaitOwnedClose();
    });
    child.once("close", (code, signal) => {
      if (failure) {
        const release = terminationRequested ? "uncertain" : "owned_process_closed";
        finish(
          failureResult(
            `${failure.message}; owned npm process closed${terminationRequested ? " after termination; descendant release is uncertain" : ""}.`,
            true,
            release
          )
        );
      } else if (code !== 0 || signal) {
        finish(
          failureResult(
            `Packed consumer install failed (${code}, ${signal}): ${output}`,
            true,
            "owned_process_closed"
          )
        );
      } else finish(undefined, { status: "passed", output });
    });
    commandTimer = setTimeout(
      () => stopOwnedProcess(new Error(`Packed consumer install exceeded ${commandTimeoutMs}ms`)),
      commandTimeoutMs
    );
  });
}

export function observePackedArtifactPostinstall(sourceManifest, installResult) {
  const label = `> ${sourceManifest.name}@${sourceManifest.version} postinstall`;
  if (
    !installResult.output.includes(label) ||
    !installResult.output.includes(reviewedPostinstallOutput)
  ) {
    throw new Error("Packed consumer did not observe the reviewed artifact postinstall execution");
  }
  return { event: "postinstall", status: installResult.status, output: reviewedPostinstallOutput };
}

export function ownedNpmLifecycleEnvironment(env, lifecycleNodeOptions) {
  assertLifecycleNodeOptions(lifecycleNodeOptions);
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(
        ([name]) => !["npm_config_node_options", "node_options"].includes(name.toLowerCase())
      )
    ),
    NODE_OPTIONS: lifecycleNodeOptions,
    npm_config_node_options: lifecycleNodeOptions,
  };
}

function assertLifecycleNodeOptions(lifecycleNodeOptions) {
  if (typeof lifecycleNodeOptions !== "string" || !lifecycleNodeOptions.trim()) {
    throw new Error("Packed lifecycle requires the explicit qualified nonblank node-options value");
  }
}

export function packedConsumerInstallArguments(lifecycleNodeOptions) {
  assertLifecycleNodeOptions(lifecycleNodeOptions);
  return [
    "install",
    "--global=false",
    "--strict-allow-scripts",
    "--ignore-scripts=false",
    "--dangerously-allow-all-scripts=false",
    // npm converts effective node-options config into lifecycle NODE_OPTIONS.
    // The qualified nonblank value survives npm's export to nested npm scripts.
    `--node-options=${lifecycleNodeOptions}`,
    "--foreground-scripts",
    "--prefer-online",
    "--no-audit",
    "--no-fund",
  ];
}

export async function smokeUnreviewedInstallScript({ npmRuntime, fixtureRoot, consumerManifest }) {
  const fixturePackageRoot = path.join(fixtureRoot, "package");
  const fixtureConsumerRoot = path.join(fixtureRoot, "consumer");
  const markerPath = path.join(fixtureRoot, "unreviewed-postinstall-ran");
  fs.mkdirSync(fixturePackageRoot, { recursive: true });
  fs.mkdirSync(fixtureConsumerRoot);

  // A local tarball cannot inherit a registry approval even when its own
  // manifest claims the reviewed native package's name and version.
  const nativeApproval = Object.entries(consumerManifest.allowScripts).find(
    ([specifier, allowed]) => allowed && specifier.startsWith("better-sqlite3-multiple-ciphers@")
  );
  if (!nativeApproval) throw new Error("Packed consumer omitted the exact native approval");
  const claimedVersion = nativeApproval[0].slice("better-sqlite3-multiple-ciphers@".length);
  fs.writeFileSync(
    path.join(fixturePackageRoot, "package.json"),
    `${JSON.stringify({
      name: "better-sqlite3-multiple-ciphers",
      version: claimedVersion,
      scripts: { postinstall: "node postinstall.cjs" },
    })}\n`
  );
  fs.writeFileSync(
    path.join(fixturePackageRoot, "postinstall.cjs"),
    `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "executed");\n`
  );

  assertNpmPolicyRuntimeUnchanged(npmRuntime);
  const packed = JSON.parse(
    execFileSync(
      npmRuntime.nodeExecutable,
      [
        npmRuntime.npmCliPath,
        "pack",
        "--json",
        "--ignore-scripts",
        `--node-options=${npmRuntime.lifecycleNodeOptions}`,
        "--pack-destination",
        fixtureRoot,
      ],
      {
        cwd: fixturePackageRoot,
        env: ownedNpmLifecycleEnvironment(process.env, npmRuntime.lifecycleNodeOptions),
        encoding: "utf8",
        timeout: 30_000,
      }
    )
  )[0];
  fs.writeFileSync(
    path.join(fixtureConsumerRoot, "package.json"),
    `${JSON.stringify({ ...consumerManifest, dependencies: {} })}\n`
  );

  assertNpmPolicyRuntimeUnchanged(npmRuntime);
  const result = spawnSync(
    npmRuntime.nodeExecutable,
    [
      npmRuntime.npmCliPath,
      ...packedConsumerInstallArguments(npmRuntime.lifecycleNodeOptions),
      path.join(fixtureRoot, packed.filename),
    ],
    {
      cwd: fixtureConsumerRoot,
      env: ownedNpmLifecycleEnvironment(process.env, npmRuntime.lifecycleNodeOptions),
      encoding: "utf8",
      timeout: 30_000,
    }
  );
  if (result.error) throw result.error;
  if (fs.existsSync(markerPath)) {
    throw new Error("Unreviewed fixture postinstall executed across the packed consumer boundary");
  }
  if (result.status === 0 || !result.stderr.includes("ESTRICTALLOWSCRIPTS")) {
    throw new Error(
      `Packed consumer did not refuse the unreviewed local tarball: ${result.stdout}${result.stderr}`
    );
  }
  const requireNpm = createRequire(npmRuntime.npmCliPath);
  const Arborist = requireNpm("@npmcli/arborist");
  const matchPolicy = requireNpm("@npmcli/arborist/lib/script-allowed.js");
  const arb = new Arborist({ path: fixtureConsumerRoot });
  const tree = await arb.buildIdealTree({ add: [path.join(fixtureRoot, packed.filename)] });
  const node = tree.children.get("better-sqlite3-multiple-ciphers");
  if (!node || matchPolicy(node, consumerManifest.allowScripts) !== null) {
    throw new Error(
      "Registry approval unexpectedly matched the forged local native package identity"
    );
  }
  const fileDenialVerdict = matchPolicy(node, {
    [`file:${path.join(fixtureRoot, packed.filename)}`]: false,
  });
  if (process.platform === "win32" && fileDenialVerdict !== null) {
    throw new Error(
      "Observed npm Windows file-policy behavior changed; requalify the transport workaround"
    );
  }

  const deniedConsumerRoot = path.join(fixtureRoot, "denied-consumer");
  fs.mkdirSync(deniedConsumerRoot);
  const server = await servePackedTarball(path.join(fixtureRoot, packed.filename));
  try {
    fs.writeFileSync(
      path.join(deniedConsumerRoot, "package.json"),
      `${JSON.stringify({
        ...consumerManifest,
        dependencies: { "better-sqlite3-multiple-ciphers": server.url },
        allowScripts: { ...consumerManifest.allowScripts, [server.url]: false },
      })}\n`
    );
    await installPackedConsumer({ npmRuntime, consumerRoot: deniedConsumerRoot });
    if (
      !fs.existsSync(
        path.join(
          deniedConsumerRoot,
          "node_modules",
          "better-sqlite3-multiple-ciphers",
          "postinstall.cjs"
        )
      )
    ) {
      throw new Error("Denied fixture tarball was not actually installed");
    }
    if (fs.existsSync(markerPath))
      throw new Error("Exact loopback tarball denial did not suppress postinstall");
  } finally {
    await server.close();
  }
  return {
    status: "refused",
    code: "ESTRICTALLOWSCRIPTS",
    postinstallExecuted: false,
    forgedRegistryApprovalMatched: false,
    fileDenialMatched: fileDenialVerdict === false,
    exactLoopbackDenial: "installed_with_postinstall_denied",
  };
}

export async function smokeLifecycleNodeOptionsIsolation({
  npmRuntime,
  fixtureRoot,
  sourceManifest,
}) {
  reviewPackedArtifactLifecycle(sourceManifest);
  const scenarios = [];
  const artifacts = [];
  // Spawn the observed runtime without cmd's leading-executable quote rules.
  // Base64 path literals keep shell metacharacters out of this inspected body.
  const nestedProgram = [
    "const{spawnSync}=require('node:child_process')",
    `const node=Buffer.from('${Buffer.from(npmRuntime.nodeExecutable).toString("base64")}','base64').toString()`,
    `const npm=Buffer.from('${Buffer.from(npmRuntime.npmCliPath).toString("base64")}','base64').toString()`,
    "const result=spawnSync(node,[npm,'run','inspected-postinstall'],{stdio:'inherit',shell:false})",
    "if(result.error)throw result.error",
    "process.exit(result.status??1)",
  ].join(";");
  const nestedPostinstall = `node -e "${nestedProgram}"`;
  for (const shape of ["direct_node", "nested_npm"]) {
    const shapeRoot = path.join(fixtureRoot, shape);
    const fixturePackageRoot = path.join(shapeRoot, "package");
    fs.mkdirSync(fixturePackageRoot, { recursive: true });
    const scripts =
      shape === "direct_node"
        ? { postinstall: reviewedPostinstall, prepare: "husky" }
        : { postinstall: nestedPostinstall, "inspected-postinstall": reviewedPostinstall };
    const fixtureManifest = {
      name: sourceManifest.name,
      version: sourceManifest.version,
      scripts,
      allowScripts: sourceManifest.allowScripts,
    };
    fs.writeFileSync(
      path.join(fixturePackageRoot, "package.json"),
      `${JSON.stringify(fixtureManifest)}\n`
    );
    assertNpmPolicyRuntimeUnchanged(npmRuntime);
    const packed = JSON.parse(
      execFileSync(
        npmRuntime.nodeExecutable,
        [
          npmRuntime.npmCliPath,
          "pack",
          "--json",
          "--ignore-scripts",
          `--node-options=${npmRuntime.lifecycleNodeOptions}`,
          "--pack-destination",
          shapeRoot,
        ],
        {
          cwd: fixturePackageRoot,
          env: ownedNpmLifecycleEnvironment(process.env, npmRuntime.lifecycleNodeOptions),
          encoding: "utf8",
          timeout: 30_000,
        }
      )
    )[0];
    const tarballPath = path.join(shapeRoot, packed.filename);
    const server = await servePackedTarball(tarballPath);
    try {
      if (server.integrity !== packed.integrity)
        throw new Error("Lifecycle fixture transport integrity mismatch");
      const packedManifest = await readPackedArtifactManifest({
        npmRuntime,
        tarballPath,
        expectedIntegrity: server.integrity,
      });
      if (
        packedManifest.name !== fixtureManifest.name ||
        packedManifest.version !== fixtureManifest.version ||
        Object.keys(packedManifest.scripts).length !== Object.keys(scripts).length ||
        Object.entries(scripts).some(
          ([event, command]) => packedManifest.scripts[event] !== command
        )
      )
        throw new Error("Lifecycle fixture packed scripts differ from their exact reviewed bodies");
      artifacts.push({
        shape,
        url: server.url,
        sha256: server.sha256,
        integrity: server.integrity,
      });
      for (const layer of ["environment", "user_npmrc", "project_npmrc", "caller_node_options"]) {
        const consumerRoot = path.join(shapeRoot, layer);
        fs.mkdirSync(consumerRoot);
        const markerPath = path.join(consumerRoot, "unapproved-preload-ran");
        const preloadPath = path.join(consumerRoot, "unapproved-preload.mjs");
        fs.writeFileSync(
          preloadPath,
          `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(markerPath)}, "executed");\n`
        );
        const overlay = `--import=${pathToFileURL(preloadPath).href}`;
        const userConfigPath = path.join(consumerRoot, "isolated-user.npmrc");
        fs.writeFileSync(userConfigPath, layer === "user_npmrc" ? `node-options=${overlay}\n` : "");
        if (layer === "project_npmrc")
          fs.writeFileSync(path.join(consumerRoot, ".npmrc"), `node-options=${overlay}\n`);
        const env = Object.fromEntries(
          Object.entries(process.env).filter(
            ([name]) =>
              !["npm_config_node_options", "npm_config_userconfig"].includes(name.toLowerCase())
          )
        );
        env.npm_config_userconfig = userConfigPath;
        if (layer === "environment") env.npm_config_node_options = overlay;
        if (layer === "caller_node_options") env.NODE_OPTIONS = overlay;
        // Only the dedicated nested fixture uses this exact reviewed two-script
        // contract. Production artifact approval still requires its direct body.
        const consumerManifest =
          shape === "direct_node"
            ? createPackedConsumerManifest(packedManifest, server.url)
            : {
                name: "lexrunner-nested-lifecycle-fixture",
                private: true,
                type: "module",
                dependencies: { [packedManifest.name]: server.url },
                allowScripts: { ...sourceManifest.allowScripts, [server.url]: true },
              };
        fs.writeFileSync(
          path.join(consumerRoot, "package.json"),
          `${JSON.stringify(consumerManifest)}\n`
        );
        assertNpmPolicyRuntimeUnchanged(npmRuntime);
        const effectiveOverlay =
          layer === "caller_node_options"
            ? env.NODE_OPTIONS
            : execFileSync(
                npmRuntime.nodeExecutable,
                [npmRuntime.npmCliPath, "config", "get", "node-options", "--global=false"],
                { cwd: consumerRoot, env, encoding: "utf8", timeout: 10_000 }
              ).trim();
        if (effectiveOverlay !== overlay)
          throw new Error(
            `Lifecycle fixture ${shape}/${layer} overlay was not effective before override`
          );
        if (fs.existsSync(markerPath))
          throw new Error("Read-only lifecycle config inspection executed a preload");
        const markerEnv = Object.fromEntries(
          Object.entries(env).filter(([name]) => name.toUpperCase() !== "NODE_OPTIONS")
        );
        execFileSync(npmRuntime.nodeExecutable, ["--eval", "void 0"], {
          cwd: consumerRoot,
          env: { ...markerEnv, NODE_OPTIONS: overlay },
          timeout: 10_000,
        });
        if (!fs.existsSync(markerPath))
          throw new Error("Owned preload marker positive control failed");
        fs.unlinkSync(markerPath);
        const installResult = await installPackedConsumer({ npmRuntime, consumerRoot, env });
        const postinstall = observePackedArtifactPostinstall(packedManifest, installResult);
        if (
          shape === "nested_npm" &&
          !installResult.output.includes(
            `> ${packedManifest.name}@${packedManifest.version} inspected-postinstall`
          )
        )
          throw new Error("Nested lifecycle did not execute the inspected npm leaf script");
        if (fs.existsSync(markerPath))
          throw new Error(
            `Unapproved ${shape}/${layer} lifecycle preload executed despite the qualified override`
          );
        scenarios.push({
          shape,
          layer,
          effectiveOverlayObserved: true,
          preloadMarkerPositiveControl: "passed",
          unapprovedPreloadExecuted: false,
          approvedPostinstall: postinstall.status,
          ownedInstallClosed: true,
        });
      }
    } finally {
      await server.close();
    }
  }
  return { lifecycleNodeOptions: "qualified_nonblank_cli_and_environment", artifacts, scenarios };
}
