import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { resolveContainedPackageTarget } from "./packed-package-paths.mjs";
import {
  createPackedConsumerManifest,
  servePackedTarball,
  installPackedConsumer,
  reviewPackedArtifactLifecycle,
  observePackedArtifactPostinstall,
  readPackedArtifactManifest,
  smokeUnreviewedInstallScript,
  smokeLifecycleNodeOptionsIsolation,
  ownedNpmLifecycleEnvironment,
} from "./packed-consumer-install-policy.mjs";
import { observeNpmPolicyRuntime, assertNpmPolicyRuntimeUnchanged } from "./npm-policy-runtime.mjs";
import { smokeGateExecution } from "./smoke-gate-execution.mjs";
import { smokeGateOperations } from "./smoke-gate-operations.mjs";
import { ownMcpConnection } from "./owned-mcp-smoke.mjs";

const projectRoot = process.cwd();
const sourceManifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const packageVersion = sourceManifest.version;
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lexrunner-packed-smoke-"));
const consumerRoot = path.join(temporaryRoot, "consumer");
let tarballServer;
let preserveTemporaryRoot = false;
const requiredAttemptTools = [
  "materialize_attempt_input",
  "preflight_attempt_containment",
  "prepare_attempt",
  "start_attempt",
  "get_attempt_status",
  "attach_attempt_worker",
  "heartbeat_attempt_worker",
  "end_attempt_worker",
  "get_attempt_worker",
  "submit_attempt_receipt",
  "get_attempt_receipt",
  "verify_attempt",
  "get_attempt_verification",
  "accept_attempt",
  "get_attempt_acceptance",
  "prepare_native_wsl_projection",
  "get_native_wsl_projection_status",
  "cleanup_native_wsl_projection",
  "inspect_native_wsl_projection_quarantine",
];

try {
  const npmRuntime = observeNpmPolicyRuntime({ projectRoot });
  const npmCliPath = npmRuntime.npmCliPath;
  const packed = JSON.parse(
    execFileSync(
      process.execPath,
      [
        npmCliPath,
        "pack",
        "--json",
        "--ignore-scripts",
        `--node-options=${npmRuntime.lifecycleNodeOptions}`,
        "--pack-destination",
        temporaryRoot,
      ],
      {
        cwd: projectRoot,
        env: ownedNpmLifecycleEnvironment(process.env, npmRuntime.lifecycleNodeOptions),
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      }
    )
  )[0];
  const tarball = path.join(temporaryRoot, packed.filename);
  tarballServer = await servePackedTarball(tarball);
  if (tarballServer.integrity !== packed.integrity) {
    throw new Error("Packed tarball changed between npm pack and transport byte capture");
  }
  const packedManifest = await readPackedArtifactManifest({
    npmRuntime,
    tarballPath: tarball,
    expectedIntegrity: tarballServer.integrity,
  });
  if (packedManifest.name !== sourceManifest.name || packedManifest.version !== packageVersion) {
    throw new Error("Packed manifest identity does not match the source candidate");
  }
  const consumerManifest = createPackedConsumerManifest(
    { ...packedManifest, allowScripts: sourceManifest.allowScripts },
    tarballServer.url
  );
  const unreviewedInstallScript = await smokeUnreviewedInstallScript({
    npmRuntime,
    fixtureRoot: path.join(temporaryRoot, "unreviewed-install-script"),
    consumerManifest,
  });
  const lifecycleNodeOptions = await smokeLifecycleNodeOptionsIsolation({
    npmRuntime,
    fixtureRoot: path.join(temporaryRoot, "lifecycle-node-options"),
    sourceManifest: { ...packedManifest, allowScripts: sourceManifest.allowScripts },
  });

  fs.mkdirSync(consumerRoot);
  fs.writeFileSync(
    path.join(consumerRoot, "package.json"),
    `${JSON.stringify(consumerManifest)}\n`
  );
  const installResult = await installPackedConsumer({ npmRuntime, consumerRoot });
  const packedArtifactPostinstall = observePackedArtifactPostinstall(packedManifest, installResult);

  assertNpmPolicyRuntimeUnchanged(npmRuntime);
  const pendingScripts = execFileSync(
    process.execPath,
    [
      npmCliPath,
      "approve-scripts",
      "--allow-scripts-pending",
      "--global=false",
      "--ignore-scripts=false",
      "--dangerously-allow-all-scripts=false",
      `--node-options=${npmRuntime.lifecycleNodeOptions}`,
    ],
    {
      cwd: consumerRoot,
      env: ownedNpmLifecycleEnvironment(process.env, npmRuntime.lifecycleNodeOptions),
      encoding: "utf8",
    }
  );
  if (!pendingScripts.includes("No packages with unreviewed install scripts.")) {
    throw new Error(`Packed consumer has unreviewed install scripts: ${pendingScripts}`);
  }
  const nativeSqlite = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--eval",
        `
          const Database = require("better-sqlite3-multiple-ciphers");
          const database = new Database(":memory:");
          try {
            const result = database.prepare("SELECT 42 AS value").get();
            if (result.value !== 42) throw new Error("native SQLite query failed");
            const version = require("better-sqlite3-multiple-ciphers/package.json").version;
            console.log(JSON.stringify({ version, query: "passed" }));
          } finally { database.close(); }
        `,
      ],
      { cwd: consumerRoot, encoding: "utf8" }
    )
  );

  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        const main = await import("@smartergpt/lexrunner");
        if (typeof main.canonicalJSONStringify !== "function") throw new Error("missing ESM root API");
        if (typeof main.createAgentWorkContainmentPreflightHandler !== "function") {
          throw new Error("missing containment preflight root API");
        }
        if (!main.NativeWslProjectionRequest_v1) {
          throw new Error("missing native WSL projection contract root API");
        }
        if (typeof main.planNativeWslProjection !== "function") {
          throw new Error("missing native WSL projection planner root API");
        }
        if (typeof main.createNativeWslProjectionLifecycleHandlers !== "function") {
          throw new Error("missing native WSL projection lifecycle root API");
        }
        for (const name of [
          "NativeWslProjectionPrepareRequestJsonSchema",
          "NativeWslProjectionStatusRequestJsonSchema",
          "NativeWslProjectionCleanupRequestJsonSchema",
          "NativeWslProjectionQuarantineRequestJsonSchema",
        ]) {
          if (!main[name]) throw new Error("missing " + name + " root API");
        }
        const checks = [
          ["@smartergpt/lexrunner/audit-sdk", "AUDIT_SCHEMA_VERSION"],
          ["@smartergpt/lexrunner/frames", "ExecutionFrameSchema"],
          ["@smartergpt/lexrunner/errors", "createAXError"],
          ["@smartergpt/lexrunner/schemas/runner-stack", "RunnerStackSchema"],
          ["@smartergpt/lexrunner/schemas/runner-scope", "RunnerScopeSchema"],
          ["@smartergpt/lexrunner/schemas/execution-plan-v1", "ExecutionPlanV1Schema"],
          ["@smartergpt/lexrunner/schemas/gates", "GatesSchema"],
          ["@smartergpt/lexrunner/schemas/behavior-rule", "BehaviorRuleSchema"],
        ];
        for (const [specifier, name] of checks) {
          const module = await import(specifier);
          if (!(name in module)) throw new Error("missing " + name + " from " + specifier);
        }
      `,
    ],
    { cwd: consumerRoot, encoding: "utf8" }
  );

  execFileSync(
    process.execPath,
    [
      "--eval",
      `
        const main = require("@smartergpt/lexrunner");
        if (typeof main.canonicalJSONStringify !== "function") throw new Error("missing CJS root API");
        if (!main.NativeWslProjectionRequest_v1) {
          throw new Error("missing CJS native WSL projection contract root API");
        }
        if (typeof main.planNativeWslProjection !== "function") {
          throw new Error("missing CJS native WSL projection planner root API");
        }
        if (typeof main.createNativeWslProjectionLifecycleHandlers !== "function") {
          throw new Error("missing CJS native WSL projection lifecycle root API");
        }
        const schema = require("@smartergpt/lexrunner/schemas/runner-stack");
        if (!schema.RunnerStackSchema) throw new Error("missing CJS schema API");
      `,
    ],
    { cwd: consumerRoot, encoding: "utf8" }
  );

  const binRoot = path.join(consumerRoot, "node_modules", ".bin");
  const installedPackageRoot = path.join(consumerRoot, "node_modules", "@smartergpt", "lexrunner");
  const installedManifest = JSON.parse(
    fs.readFileSync(path.join(installedPackageRoot, "package.json"), "utf8")
  );
  for (const name of ["lexrunner", "lex-pr", "lexrunner-mcp"]) assertBinShim(binRoot, name);
  const canonicalCli = resolvePackageBinTarget(
    installedPackageRoot,
    installedManifest,
    "lexrunner"
  );
  const compatibilityCli = resolvePackageBinTarget(
    installedPackageRoot,
    installedManifest,
    "lex-pr"
  );
  const expectedVersion = `LexRunner ${packageVersion} (lexrunner)`;
  const canonicalVersion = execFileSync(process.execPath, [canonicalCli, "--version"], {
    cwd: consumerRoot,
    encoding: "utf8",
  }).trim();
  const compatibilityVersion = execFileSync(process.execPath, [compatibilityCli, "--version"], {
    cwd: consumerRoot,
    encoding: "utf8",
  }).trim();
  if (canonicalVersion !== expectedVersion) {
    throw new Error(`Packed canonical CLI reported unexpected version: ${canonicalVersion}`);
  }
  if (compatibilityVersion !== canonicalVersion) {
    throw new Error("Packed lex-pr compatibility alias did not execute the canonical CLI");
  }

  const cliHelp = execFileSync(process.execPath, [canonicalCli, "--help"], {
    cwd: consumerRoot,
    encoding: "utf8",
  });
  if (!cliHelp.includes("Usage: lexrunner")) {
    throw new Error("Packed canonical CLI bin did not render canonical help");
  }
  const compatibilityHelp = execFileSync(process.execPath, [compatibilityCli, "--help"], {
    cwd: consumerRoot,
    encoding: "utf8",
  });
  if (!compatibilityHelp.includes("Usage: lexrunner")) {
    throw new Error("Packed lex-pr compatibility alias did not render canonical help");
  }

  smokeBoundedAttemptStatus(canonicalCli, consumerRoot);
  smokeProjectionCliSurface(canonicalCli, consumerRoot);

  const toolCount = await smokeMcp(
    resolvePackageBinTarget(installedPackageRoot, installedManifest, "lexrunner-mcp"),
    consumerRoot,
    packageVersion
  );
  const gateExecution = await smokeGateExecution({
    cli: canonicalCli,
    mcp: resolvePackageBinTarget(installedPackageRoot, installedManifest, "lexrunner-mcp"),
    fixtureRoot: path.join(temporaryRoot, "gate-execution"),
  });
  const gateOperations = await smokeGateOperations({
    cli: canonicalCli,
    mcp: resolvePackageBinTarget(installedPackageRoot, installedManifest, "lexrunner-mcp"),
    fixtureRoot: path.join(temporaryRoot, "gate-operations"),
  });
  process.stdout.write(
    `${JSON.stringify({
      installed: "@smartergpt/lexrunner",
      npmRuntime,
      installScriptPolicy: {
        strict: true,
        pendingInstallScripts: 0,
        unreviewedInstallScript,
        lifecycleNodeOptions,
        nativeSqlite,
        consumerPolicy: consumerManifest.allowScripts,
        packedArtifactLifecycle: {
          ...reviewPackedArtifactLifecycle(packedManifest),
          invoked: packedArtifactPostinstall,
          falseRuleBinSuppression: "observed_with_npm_11_16",
        },
        transport: {
          kind: "loopback_http",
          ownedUrl: tarballServer.url,
          reason: "npm_11_16_windows_file_policy_identity_mismatch",
          tarballSha256: tarballServer.sha256,
          tarballIntegrity: tarballServer.integrity,
        },
      },
      import: "passed",
      require: "passed",
      cli: "passed",
      cliAliases: ["lexrunner", "lex-pr"],
      assistedLifecycle: "bounded_read_only_status_passed",
      mcpTools: toolCount,
      mcpAttemptTools: requiredAttemptTools.length,
      gateExecution,
      gateOperations,
    })}\n`
  );
} catch (error) {
  preserveTemporaryRoot = error.resourceRelease === "uncertain";
  if (preserveTemporaryRoot) {
    process.stderr.write(
      `${JSON.stringify({
        status: "failed",
        resourceRelease: "uncertain",
        ownedProcessClosed: error.ownedProcessClosed,
        ownedProcessId: error.ownedProcessId,
        retainedFixtureRoot: temporaryRoot,
      })}\n`
    );
  }
  throw error;
} finally {
  await tarballServer?.close();
  if (!preserveTemporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

function assertBinShim(binRoot, name) {
  const candidates =
    process.platform === "win32"
      ? [path.join(binRoot, `${name}.cmd`), path.join(binRoot, name)]
      : [path.join(binRoot, name), path.join(binRoot, `${name}.cmd`)];
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  if (!resolved) throw new Error(`Packed package omitted the ${name} executable`);
}

function resolvePackageBinTarget(packageRoot, manifest, name) {
  const relativeTarget = typeof manifest.bin === "object" ? manifest.bin?.[name] : undefined;
  if (typeof relativeTarget !== "string" || relativeTarget.length === 0) {
    throw new Error(`Packed package omitted the ${name} bin mapping`);
  }
  let target;
  try {
    target = resolveContainedPackageTarget(packageRoot, relativeTarget);
  } catch {
    throw new Error(`Packed package ${name} bin target escaped the package root`);
  }
  if (!fs.existsSync(target)) throw new Error(`Packed package omitted the ${name} bin target`);
  return target;
}

function smokeBoundedAttemptStatus(cliPath, cwd) {
  const databasePath = path.join(cwd, "missing-attempt.db");
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "attempt",
      "status",
      "--database-path",
      databasePath,
      "--run-id",
      "run-missing",
      "--attempt-id",
      "attempt-missing",
      "--json",
    ],
    { cwd, encoding: "utf8" }
  );

  if (result.error) throw result.error;
  if (result.status !== 2) {
    throw new Error(`Packed Attempt status exited ${result.status}: ${result.stderr}`);
  }
  const output = JSON.parse(result.stdout);
  if (output?.ok !== false || output?.error?.code !== "invalid_input") {
    throw new Error(`Packed Attempt status was not bounded: ${result.stdout}`);
  }
  if (Buffer.byteLength(result.stdout, "utf8") >= 4_096) {
    throw new Error("Packed Attempt status exceeded the bounded-output budget");
  }
  if (fs.existsSync(databasePath)) {
    throw new Error("Packed read-only Attempt status created lifecycle state");
  }
}

function smokeProjectionCliSurface(cliPath, cwd) {
  const inputPath = path.join(cwd, "invalid-projection-request.json");
  fs.writeFileSync(inputPath, "{}\n");
  for (const operation of ["prepare", "status", "cleanup", "quarantine"]) {
    const result = spawnSync(
      process.execPath,
      [cliPath, "attempt", "projection", operation, "--input", inputPath, "--json"],
      { cwd, encoding: "utf8" }
    );
    if (result.error) throw result.error;
    if (result.status !== 2) {
      throw new Error(`Packed projection ${operation} exited ${result.status}: ${result.stderr}`);
    }
    const output = JSON.parse(result.stdout);
    if (output?.ok !== false || output?.error?.code !== "invalid_input") {
      throw new Error(`Packed projection ${operation} was not bounded: ${result.stdout}`);
    }
    if (Buffer.byteLength(result.stdout, "utf8") >= 8_192) {
      throw new Error(`Packed projection ${operation} exceeded the output budget`);
    }
  }
}

async function smokeMcp(binPath, cwd, expectedVersion) {
  const client = new Client({ name: "lexrunner-packed-smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [binPath],
    cwd,
    env: { ...process.env, ALLOW_MUTATIONS: "false" },
    stderr: "pipe",
  });
  const connection = ownMcpConnection(client, transport, { fixtureRoot: cwd });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  let timeout;

  try {
    return await Promise.race([
      (async () => {
        await connection.connect();
        const actualVersion = client.getServerVersion()?.version;
        if (actualVersion !== expectedVersion) {
          throw new Error(`Packed MCP reported unexpected version: ${actualVersion}`);
        }
        const { tools } = await client.listTools();
        if (tools.length === 0) throw new Error("Packed MCP returned no tools");
        const publishedToolNames = new Set(tools.map(({ name }) => name));
        for (const name of requiredAttemptTools) {
          if (!publishedToolNames.has(name))
            throw new Error(`Packed MCP omitted Attempt tool ${name}`);
        }
        return tools.length;
      })(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Packed MCP smoke timed out. stderr:\n${stderr}`)),
          15_000
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    await connection.close();
  }
}
