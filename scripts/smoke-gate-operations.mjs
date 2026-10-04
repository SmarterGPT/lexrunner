import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { execa } from "execa";

import {
  boundedSmoke as bounded,
  drainGateOperationFixtures,
  ownMcpConnection,
} from "./owned-mcp-smoke.mjs";

const TERMINAL = new Set(["completed", "cancelled", "failed"]);
const OBSERVATION_TIMEOUT_MS = 15_000;
const TOOL_TIMEOUT_MS = 5_000;

/** Exercise detached workers through actual packed entry points and disposable candidates. */
export async function smokeGateOperations({ cli, mcp, fixtureRoot }) {
  const worker = path.join(path.dirname(cli), "gate-worker.js");
  assert.ok(existsSync(worker), "packed detached gate worker is missing");
  const workerSource = readFileSync(worker, "utf8");
  assert.doesNotMatch(
    workerSource,
    /\b(?:import|export)\s[^;\n]*\bfrom\s*["']\.{1,2}\//u,
    "worker has an unbundled first-party static import"
  );
  assert.doesNotMatch(
    workerSource,
    /\b(?:import|require)\s*\(\s*["']\.{1,2}\//u,
    "worker has an unbundled first-party dynamic import"
  );

  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))
  );
  mkdirSync(fixtureRoot);
  const startup = path.join(fixtureRoot, "non-git-startup");
  const repo = path.join(fixtureRoot, "candidate");
  const profile = path.join(fixtureRoot, "private-profile");
  mkdirSync(startup);
  mkdirSync(repo);
  const git = (args) =>
    execFileSync("git", args, {
      cwd: repo,
      env: environment,
      stdio: "pipe",
      timeout: 10_000,
      windowsHide: true,
    });
  git(["init", "--quiet"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["config", "user.name", "LexRunner packed operation smoke"]);
  git(["config", "user.email", "lexrunner-packed@example.invalid"]);
  writeFileSync(path.join(repo, "candidate.txt"), "packed durable operation candidate\n");
  git(["add", "candidate.txt"]);
  git(["commit", "--quiet", "-m", "Create disposable packed operation candidate"]);
  const markerScript = path.join(fixtureRoot, "gate-child.cjs");
  writeFileSync(
    markerScript,
    [
      'const fs = require("node:fs");',
      "const [log, name, release, code] = process.argv.slice(2);",
      'fs.appendFileSync(log, JSON.stringify({name,kind:"start",pid:process.pid,cwd:process.cwd()}) + "\\n");',
      "const deadline = Date.now() + 9000;",
      "const timer = setInterval(() => {",
      "  if (!fs.existsSync(release) && Date.now() < deadline) return;",
      "  clearInterval(timer);",
      "  const outcome = fs.existsSync(release) ? Number(code) : 91;",
      '  fs.appendFileSync(log, JSON.stringify({name,kind:"end",pid:process.pid,exitCode:outcome,cwd:process.cwd()}) + "\\n");',
      "  process.exit(outcome);",
      "}, 10);",
    ].join("\n")
  );

  const fixtures = [];
  const connections = new Set();
  let failure;
  let observations;
  try {
    let connection = await connect();
    const listed = await bounded(connection.client.listTools(), TOOL_TIMEOUT_MS, "MCP tool list");
    for (const name of ["gates.start", "gates.status", "gates.cancel"]) {
      const tool = listed.tools.find((value) => value.name === name);
      assert.ok(tool, `packed MCP omitted ${name}`);
      assert.ok(tool.inputSchema.properties.repoRoot, `${name} omitted explicit repo routing`);
    }
    for (const name of ["start", "status", "cancel"]) {
      const help = await cliCommand(["gate", name, "--help"]);
      assert.equal(help.exitCode, 0);
      assert.ok(help.stdout.includes("--repo-root"));
    }

    const success = fixture("reconnect-pass", [{ name: "a", gates: ["unit"] }]);
    const startedAt = Date.now();
    const first = await call(connection, "start", success.input);
    assert.ok(Date.now() - startedAt < TOOL_TIMEOUT_MS, "start waited for held gate completion");
    assertHandle(first, false);
    success.handle = first.operation;
    await markerStarted(success, "a-unit");
    assert.deepEqual(started(success), ["a-unit"]);
    assert.equal(ended(success).length, 0);
    await close(connection);
    connection = await connect();
    const stillRunning = await call(connection, "status", success.handle);
    assert.equal(stillRunning.state, "running");
    assert.equal(stillRunning.authority, "unverified");
    const replay = await call(connection, "start", success.input);
    assertHandle(replay, true);
    assert.deepEqual(replay.operation, success.handle);
    assert.deepEqual(started(success), ["a-unit"]);
    release(success, "a-unit");
    const passed = await terminal(() => call(connection, "status", success.handle));
    assert.equal(passed.state, "completed");
    assert.equal(passed.outcome, "pass");
    assert.equal(passed.result.allGreen, true);
    assert.deepEqual(started(success), ["a-unit"]);
    assert.deepEqual(ended(success), ["a-unit"]);
    assertEvidence(passed, success);

    const lostAcknowledgement = fixture("lost-start-ack", [{ name: "a", gates: ["unit"] }]);
    const requestTimeoutMs = 1;
    const send = connection.transport.send.bind(connection.transport);
    let startRequestId;
    let cancellationRequestId;
    connection.transport.send = (message, options) => {
      if (message.method === "tools/call" && message.params?.name === "gates.start") {
        startRequestId = message.id;
      }
      if (message.method === "notifications/cancelled") {
        cancellationRequestId = message.params.requestId;
      }
      // Observe and forward the real SDK messages without changing admission or
      // suppressing the request-cancellation notification emitted on timeout.
      return send(message, options);
    };
    await assert.rejects(
      () =>
        connection.client.callTool(
          { name: "gates.start", arguments: lostAcknowledgement.input },
          undefined,
          { timeout: requestTimeoutMs }
        ),
      (error) => {
        assert.ok(error instanceof McpError, "expected an actual SDK MCP error");
        assert.equal(error.code, ErrorCode.RequestTimeout);
        assert.equal(error.data.timeout, requestTimeoutMs);
        assert.match(error.message, /Request timed out/u);
        return true;
      }
    );
    assert.notEqual(startRequestId, undefined);
    assert.equal(cancellationRequestId, startRequestId);
    await markerStarted(lostAcknowledgement, "a-unit");
    assert.equal(ended(lostAcknowledgement).length, 0);
    await close(connection);
    recoverHandle(lostAcknowledgement);
    assert.ok(lostAcknowledgement.handle, "original timed-out request omitted its descriptor");
    connection = await connect();
    const originalRunning = await call(connection, "status", lostAcknowledgement.handle);
    assert.equal(originalRunning.state, "running");
    assert.equal(originalRunning.cancelRequested, false);
    assert.equal(
      existsSync(path.join(path.dirname(lostAcknowledgement.handle.operationFile), "cancel.json")),
      false,
      "transport request timeout became an explicit gate cancellation"
    );
    const recoveredStart = await call(connection, "start", lostAcknowledgement.input);
    assertHandle(recoveredStart, true);
    assert.deepEqual(recoveredStart.operation, lostAcknowledgement.handle);
    assert.deepEqual(started(lostAcknowledgement), ["a-unit"]);
    release(lostAcknowledgement, "a-unit");
    const recoveredPass = await terminal(() =>
      call(connection, "status", lostAcknowledgement.handle)
    );
    assert.equal(recoveredPass.state, "completed");
    assert.equal(recoveredPass.outcome, "pass");
    assert.equal(recoveredPass.result.allGreen, true);
    assert.deepEqual(started(lostAcknowledgement), ["a-unit"]);
    assert.deepEqual(ended(lostAcknowledgement), ["a-unit"]);
    assertEvidence(recoveredPass, lostAcknowledgement);

    const failed = fixture("reconnect-fail", [
      { name: "a", gates: ["unit"], exitCode: 7 },
      { name: "b", deps: ["a"], gates: ["unit"] },
    ]);
    const failureStart = await call(connection, "start", failed.input);
    failed.handle = failureStart.operation;
    await markerStarted(failed, "a-unit");
    await close(connection);
    connection = await connect();
    assert.equal((await call(connection, "status", failed.handle)).state, "running");
    release(failed, "a-unit");
    const nonzero = await terminal(() => call(connection, "status", failed.handle));
    assert.equal(nonzero.state, "completed");
    assert.equal(nonzero.outcome, "fail");
    assert.equal(nonzero.result.allGreen, false);
    assert.equal(nonzero.result.items.find(({ name }) => name === "a").status, "fail");
    assert.equal(nonzero.result.items.find(({ name }) => name === "b").status, "blocked");
    assert.deepEqual(started(failed), ["a-unit"]);
    assertEvidence(nonzero, failed, "nonzero_exit");

    const cancelled = fixture("cli-cancel", [
      { name: "a", gates: ["unit", "later"] },
      { name: "b", deps: ["a"], gates: ["unit"] },
    ]);
    const cliStart = await cliStartOperation(cancelled);
    assertHandle(cliStart, false);
    cancelled.handle = cliStart.operation;
    await markerStarted(cancelled, "a-unit");
    const cliRunning = await cliObserve("status", cancelled.handle);
    assert.equal(cliRunning.state, "running");
    assert.equal(cliRunning.authority, "unverified");
    const request = await cliObserve("cancel", cancelled.handle);
    assert.equal(request.cancelRequested, true);
    assert.equal(request.terminalAcknowledged, false);
    assert.equal(request.cancellationMode, "after-active-gates");
    const repeatCancel = await call(connection, "cancel", cancelled.handle);
    assert.equal(repeatCancel.cancelRequested, true);
    assert.equal(repeatCancel.terminalAcknowledged, false);
    await delay(100);
    const draining = await call(connection, "status", cancelled.handle);
    assert.equal(draining.cancelRequested, true);
    assert.ok(!TERMINAL.has(draining.state), "cancel falsely acknowledged held gate completion");
    assert.deepEqual(ended(cancelled), []);
    release(cancelled, "a-unit");
    const cancellation = await terminal(() => cliObserve("status", cancelled.handle));
    assert.equal(cancellation.state, "cancelled");
    assert.equal(cancellation.result, undefined);
    assert.equal(cancellation.outcome, undefined);
    assert.deepEqual(started(cancelled), ["a-unit"]);
    assert.deepEqual(ended(cancelled), ["a-unit"]);
    const cancelledReplay = await cliStartOperation(cancelled);
    assertHandle(cancelledReplay, true);
    assert.deepEqual(cancelledReplay.operation, cancelled.handle);
    assert.deepEqual(started(cancelled), ["a-unit"]);

    const timedOut = fixture(
      "short-timeout",
      [
        { name: "a", gates: ["unit"] },
        { name: "b", deps: ["a"], gates: ["unit"] },
      ],
      1500
    );
    const timeoutStart = await call(connection, "start", timedOut.input);
    timedOut.handle = timeoutStart.operation;
    await markerStarted(timedOut, "a-unit");
    await close(connection);
    connection = await connect();
    const timeout = await terminal(() => call(connection, "status", timedOut.handle));
    assert.equal(timeout.state, "completed");
    assert.equal(timeout.outcome, "fail");
    assert.equal(timeout.result.allGreen, false);
    assert.equal(timeout.result.items.find(({ name }) => name === "b").status, "blocked");
    assert.deepEqual(started(timedOut), ["a-unit"]);
    assert.deepEqual(ended(timedOut), []);
    assertEvidence(timeout, timedOut, "timeout");

    observations = {
      cases: 9,
      producerOperations: 5,
      standaloneWorker: "passed",
      explicitRepoRouting: "passed",
      promptStartHandle: "passed",
      observerReconnect: "pass_fail_timeout_passed",
      lostStartAcknowledgement: {
        status: "passed",
        sdkErrorCode: ErrorCode.RequestTimeout,
        requestTimeoutMs,
        cancellationNotification: "forwarded",
        gateCancellationRequested: false,
      },
      idempotentAdmission: "passed",
      cliMcpParity: "passed",
      afterActiveGatesCancellation: "passed",
      boundedTimeout: "passed",
      workerSha256: digest(readFileSync(worker)),
    };
  } catch (error) {
    failure = error;
  } finally {
    await drainGateOperationFixtures({
      fixtures,
      connections,
      release,
      recoverHandle,
      observeTerminal: (handle) => terminal(() => cliObserve("status", handle)),
      fixtureRoot,
      failure,
    });
  }
  if (failure) throw failure;
  return observations;

  async function connect() {
    const client = new Client({ name: "lexrunner-packed-operation-smoke", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [mcp],
      cwd: startup,
      env: { ...environment, ALLOW_MUTATIONS: "false", LEX_PR_PROFILE_DIR: profile },
      stderr: "pipe",
    });
    const connection = ownMcpConnection(client, transport, { fixtureRoot });
    connections.add(connection);
    await connection.connect();
    return connection;
  }

  async function close(connection) {
    await connection.close();
    connections.delete(connection);
  }

  async function call(connection, name, args) {
    const result = await connection.client.callTool(
      { name: "gates." + name, arguments: args },
      undefined,
      { timeout: TOOL_TIMEOUT_MS }
    );
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const text = result.content.find(({ type }) => type === "text");
    assert.ok(text);
    return JSON.parse(text.text);
  }

  function fixture(name, nodes, timeoutMs = 5000) {
    const log = path.join(fixtureRoot, name + ".jsonl");
    writeFileSync(log, "");
    const gates = [];
    const items = nodes.map((node) => ({
      name: node.name,
      deps: node.deps ?? [],
      gates: node.gates.map((gate) => {
        const identity = node.name + "-" + gate;
        gates.push(identity);
        const releaseFile = path.join(fixtureRoot, name + "." + identity + ".release");
        return {
          name: gate,
          runtime: "local",
          timeoutMs,
          run:
            (process.platform === "win32" ? "& " : "") +
            [process.execPath, markerScript, log, identity, releaseFile, String(node.exitCode ?? 0)]
              .map(shellQuote)
              .join(" "),
          artifacts: [],
        };
      }),
    }));
    const planFile = path.join(fixtureRoot, name + ".plan.json");
    writeFileSync(
      planFile,
      JSON.stringify({
        schemaVersion: "1.0.0",
        target: "main",
        policy: { maxWorkers: 1, retries: {}, performance: { throttleOnMemory: false } },
        items,
      })
    );
    const current = {
      name,
      log,
      gates,
      input: {
        repoRoot: repo,
        planFile,
        outDir: path.join(fixtureRoot, name + ".operations"),
        idempotencyKey: "packed-" + name,
        timeoutMs,
      },
    };
    fixtures.push(current);
    return current;
  }

  function release(current, name) {
    const file = path.join(fixtureRoot, current.name + "." + name + ".release");
    if (!existsSync(file)) writeFileSync(file, "", { flag: "wx" });
  }

  function recoverHandle(current) {
    if (current.handle) return;
    const descriptor = path.join(
      current.input.outDir,
      "gate-operation-" + createHash("sha256").update(current.input.idempotencyKey).digest("hex"),
      "operation.json"
    );
    if (existsSync(descriptor)) {
      current.handle = {
        repoRoot: realpathSync(repo),
        operationFile: descriptor,
        operationSha256: digest(readFileSync(descriptor)),
      };
    }
  }

  async function markerStarted(current, name) {
    const deadline = Date.now() + TOOL_TIMEOUT_MS;
    while (!started(current).includes(name)) {
      assert.ok(Date.now() < deadline, "fixture command did not start: " + name);
      await delay(25);
    }
  }

  async function cliCommand(args) {
    return execa(process.execPath, [cli, "--no-emit-frames", ...args], {
      cwd: startup,
      env: { ...environment, LEX_PR_PROFILE_DIR: profile, ALLOW_MUTATIONS: "false" },
      reject: false,
      timeout: TOOL_TIMEOUT_MS,
    });
  }

  async function cliStartOperation(current) {
    const input = current.input;
    const result = await cliCommand([
      "gate",
      "start",
      "--repo-root",
      input.repoRoot,
      "--plan",
      input.planFile,
      "--out",
      input.outDir,
      "--idempotency-key",
      input.idempotencyKey,
      "--timeout-ms",
      String(input.timeoutMs),
      "--json",
    ]);
    assert.equal(result.exitCode, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  }

  async function cliObserve(action, handle) {
    const result = await cliCommand([
      "gate",
      action,
      "--repo-root",
      handle.repoRoot,
      "--operation",
      handle.operationFile,
      "--operation-sha256",
      handle.operationSha256,
      "--json",
    ]);
    assert.equal(result.exitCode, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  }
}

async function terminal(observe) {
  const deadline = Date.now() + OBSERVATION_TIMEOUT_MS;
  let observation;
  while (Date.now() < deadline) {
    observation = await observe();
    if (TERMINAL.has(observation.state)) return observation;
    await delay(50);
  }
  throw new Error(
    "Gate operation did not reach an observed terminal state: " + JSON.stringify(observation)
  );
}

function events(current) {
  return readFileSync(current.log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
function started(current) {
  return events(current)
    .filter(({ kind }) => kind === "start")
    .map(({ name }) => name);
}
function ended(current) {
  return events(current)
    .filter(({ kind }) => kind === "end")
    .map(({ name }) => name);
}
function digest(bytes) {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}
function assertHandle(result, reused) {
  assert.equal(result.contract, "gate-operation-handle/v1");
  assert.equal(result.reused, reused);
  assert.equal(result.cancellationMode, "after-active-gates");
  assert.match(result.operation.operationSha256, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(
    digest(readFileSync(result.operation.operationFile)),
    result.operation.operationSha256
  );
}
function assertEvidence(result, current, failureKind) {
  const reference = result.result.artifactRefs.find(
    ({ kind }) => kind === "gate-evidence-manifest"
  );
  assert.ok(reference);
  assert.equal(digest(readFileSync(reference.path)), reference.sha256);
  const manifest = JSON.parse(readFileSync(reference.path, "utf8"));
  assert.equal(manifest.candidate.repositoryRoot, realpathSync(current.input.repoRoot));
  assert.ok(
    events(current).every(({ cwd }) => realpathSync(cwd) === realpathSync(current.input.repoRoot))
  );
  assert.equal(manifest.entries.length, 1);
  const entry = manifest.entries[0];
  const receipt = path.resolve(path.dirname(reference.path), entry.receipt.path);
  assert.equal(digest(readFileSync(receipt)), entry.receipt.sha256);
  const parsed = JSON.parse(readFileSync(receipt, "utf8"));
  assert.equal(parsed.execution.shell.spawned, true);
  assert.equal(parsed.outcome.failureKind, failureKind ?? null);
  assert.equal(parsed.outcome.status, failureKind ? "fail" : "pass");
}
function shellQuote(value) {
  return process.platform === "win32"
    ? "'" + value.replaceAll("'", "''") + "'"
    : "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(name);
    if (index < 0 || !args[index + 1]) throw new Error("Required option: " + name);
    return path.resolve(args[index + 1]);
  };
  const result = await smokeGateOperations({
    cli: option("--cli"),
    mcp: option("--mcp"),
    fixtureRoot: option("--fixture-root"),
  });
  process.stdout.write(JSON.stringify(result) + "\n");
}
