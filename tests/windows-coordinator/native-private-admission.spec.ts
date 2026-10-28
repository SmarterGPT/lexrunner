import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import path from "node:path";

import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, describe, expect, it } from "vitest";

import { createAgentTaskPacket } from "../../src/schemas/agent-work.js";
import { computeCanonicalHash } from "../../src/schemas/task-contract.js";
import { canonicalJSONStringify } from "../../src/util/canonicalJson.js";
import {
  WindowsAttemptIntentBody_v1,
  WindowsAttemptIntent_v1,
  WindowsCoordinatorEnrollmentBody_v1,
  WindowsCoordinatorEnrollment_v1,
  windowsPacketEffectsDigest,
} from "../../src/windows-coordinator/admission-contract.js";
import { encodeWindowsCoordinatorClientFrame } from "../../src/windows-coordinator/client-protocol.js";
import { WindowsCoordinatorDenial_v1 } from "../../src/windows-coordinator/deny-first-dispatcher.js";
import { SqliteWindowsCoordinatorAdmissionStore } from "../../src/windows-coordinator/sqlite-admission-store.js";

const hostImage = process.env.LEXRUNNER_TEST_COORDINATOR_BRIDGE_HOST;
const baselineImage = process.env.LEXRUNNER_TEST_COORDINATOR_HOST;
const nodeImage = process.env.LEXRUNNER_TEST_COORDINATOR_NODE;
const workerImage = process.env.LEXRUNNER_TEST_COORDINATOR_WORKER;
const fixtureParent = process.env.LEXRUNNER_TEST_COORDINATOR_ROOT;
const fixtureVolume = process.env.LEXRUNNER_TEST_COORDINATOR_VOLUME;
const native =
  process.platform === "win32" &&
  !!hostImage &&
  !!baselineImage &&
  !!nodeImage &&
  !!workerImage &&
  !!fixtureParent &&
  (fixtureVolume === "NTFS" || fixtureVolume === "ReFS");
const fixturePrefix = "private-admission-";
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const packetCreatedAt = "2026-10-28T12:00:00.000Z";

function sid(): string {
  const output = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  const value = output.match(/S-\d+(?:-\d+)+/u)?.[0];
  if (!value) throw new Error("Current Windows user SID unavailable");
  return value;
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function nonce(): string {
  return randomBytes(16).toString("hex");
}

function pipeName(id: string): string {
  return `\\\\.\\pipe\\LexRunner.Coordinator.Probe.${id}`;
}

function packet(objective = "Private no-effect preparation") {
  return createAgentTaskPacket({
    schema_version: "1.0.0",
    packet_id: "packet-1",
    run_id: "run-1",
    work_item: { work_item_id: "work-1", revision: 1 },
    attempt_id: "attempt-1",
    repository: { id: "owner/repo", base_sha: "a".repeat(40) },
    objective,
    acceptance_criteria: [],
    instructions: [],
    scope: {
      read_globs: ["**"],
      write_globs: ["src/**"],
      deny_globs: [],
      cross_repo_allowed: false,
    },
    authority: {
      edit: true,
      git_write: false,
      github_write: false,
      external_runtime: false,
      secrets: false,
      signing: false,
      release: false,
    },
    verification: [],
    budget: {},
    created_at: packetCreatedAt,
  });
}

function prepareFrame(requestId: string, objective?: string): Buffer {
  return Buffer.from(
    encodeWindowsCoordinatorClientFrame({
      schema_version: "1.0.0",
      verb: "attempt.prepare",
      request_id: requestId,
      client_idempotency_key: "client-key-1",
      packet: packet(objective),
    })
  );
}

describe.skipIf(!native)("NativeAOT private Windows admission fixture", () => {
  const children: ChildProcess[] = [];
  const servers: Server[] = [];
  const directories: string[] = [];
  const stores: SqliteWindowsCoordinatorAdmissionStore[] = [];
  const databases: Database.Database[] = [];
  const clientSid = native ? sid() : "";
  const nodeSha256 = native ? sha256(nodeImage!) : "";
  const workerSha256 = native ? sha256(workerImage!) : "";

  async function fixture(staleFence = false) {
    const directory = await mkdtemp(path.join(fixtureParent!, fixturePrefix));
    directories.push(directory);
    const databasePath = path.join(directory, "admission.db");
    const contextPath = path.join(directory, "context.json");
    const store = new SqliteWindowsCoordinatorAdmissionStore(databasePath);
    stores.push(store);
    const raw = new Database(databasePath);
    raw.pragma("foreign_keys = ON");
    databases.push(raw);
    const now = Date.now();
    const before = new Date(now).toISOString();
    const later = new Date(now + 1000).toISOString();
    const lease = await store.acquireControllerLease({
      runId: "run-1",
      controllerId: "fixture-controller",
      leaseId: "fixture-lease",
      now: before,
      ttlMs: 120_000,
      initialState: {},
    });
    if (!lease.acquired) throw new Error("Fixture controller lease failed");
    const candidatePacket = packet();
    const enrollmentBody = WindowsCoordinatorEnrollmentBody_v1.parse({
      schema_version: "windows-coordinator-enrollment/1",
      enrollment_id: "enrollment-1",
      policy_revision: 1,
      status: "active",
      client_sid: clientSid,
      repository_id: "owner/repo",
      repository_identity_digest: digest("1"),
      allocation_root_identity_digest: digest("2"),
      volume_profile: fixtureVolume,
      allowed_operation_classes: ["attempt.prepare"],
      authority_ceiling: candidatePacket.authority,
      allowed_packet_effects_digest: windowsPacketEffectsDigest(candidatePacket),
      helper_generation_digest: digest("3"),
      git_profile_digest: digest("4"),
      updated_at: before,
    });
    const enrollment = WindowsCoordinatorEnrollment_v1.parse({
      ...enrollmentBody,
      enrollment_digest: computeCanonicalHash(enrollmentBody),
    });
    raw
      .prepare(
        `INSERT INTO windows_coordinator_enrollments
         (enrollmentId,revision,status,clientSid,enrollmentJson,enrollmentDigest)
         VALUES (?,?,?,?,?,?)`
      )
      .run(
        enrollment.enrollment_id,
        enrollment.policy_revision,
        enrollment.status,
        enrollment.client_sid,
        canonicalJSONStringify(enrollment),
        enrollment.enrollment_digest
      );
    const context = {
      schema_version: "windows-private-admission-fixture/1",
      database_path: databasePath,
      reservation_context: {
        enrollment_id: enrollment.enrollment_id,
        expected_policy_revision: enrollment.policy_revision,
        observed_repository_identity_digest: digest("1"),
        observed_allocation_root_identity_digest: digest("2"),
        observed_volume_profile: fixtureVolume,
        controller: {
          run_id: "run-1",
          controller_id: lease.lease.controllerId,
          lease_id: lease.lease.leaseId,
          fencing_token: lease.lease.fencingToken + (staleFence ? 1 : 0),
          expected_run_revision: lease.record.revision,
        },
        now: later,
      },
    };
    await writeFile(contextPath, canonicalJSONStringify(context), "utf8");
    return { directory, databasePath, contextPath, context, raw };
  }

  function count(raw: Database.Database, table: string): number {
    const allowed = [
      "windows_attempt_admissions",
      "windows_attempt_intents",
      "windows_attempt_intent_events",
      "attempts",
      "workspace_leases",
      "launch_envelope_bindings",
    ];
    if (!allowed.includes(table)) throw new Error("Unexpected table");
    return (raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  }

  function noWorkspaceEffects(raw: Database.Database): void {
    for (const table of ["attempts", "workspace_leases", "launch_envelope_bindings"])
      expect(count(raw, table), table).toBe(0);
  }

  function launch(
    contextPath: string,
    options: {
      expectedSid?: string;
      timeoutMs?: number;
      worker?: string;
      workerSha256?: string;
      id?: string;
    } = {}
  ) {
    const id = options.id ?? nonce();
    const worker = options.worker ?? workerImage!;
    const child = spawn(
      hostImage!,
      [
        "--admission-probe",
        "--nonce",
        id,
        "--expected-sid",
        options.expectedSid ?? clientSid,
        "--timeout-ms",
        `${options.timeoutMs ?? 10_000}`,
        "--node-image",
        nodeImage!,
        "--worker",
        worker,
        "--context",
        contextPath,
        "--node-sha256",
        nodeSha256,
        "--worker-sha256",
        options.workerSha256 ?? workerSha256,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    children.push(child);
    return { child, pipe: pipeName(id), id };
  }

  async function ready(child: ChildProcess): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("Private probe readiness timed out")), 5000);
      child.stdout!.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (/ready\r?\n/u.test(output)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Private probe exited before ready (${code})`));
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async function exited(child: ChildProcess): Promise<number> {
    if (child.exitCode !== null) return child.exitCode;
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Private probe did not exit")), 15_000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code ?? -1);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async function exchange(pipe: string, frame: Buffer): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const socket = createConnection(pipe);
      const timer = setTimeout(
        () => socket.destroy(new Error("Private pipe reply timed out")),
        15_000
      );
      let connected = false;
      const reply = () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      };
      socket.once("connect", () => {
        connected = true;
        socket.write(frame);
      });
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.once("end", reply);
      socket.once("close", reply);
      socket.once("error", (error) => {
        clearTimeout(timer);
        if (connected) reply();
        else reject(error);
      });
    });
  }

  function denial(frame: Buffer) {
    expect(frame.length).toBeGreaterThan(4);
    expect(frame.readUInt32LE(0)).toBe(frame.length - 4);
    const json = frame.subarray(4).toString("utf8");
    const parsed = WindowsCoordinatorDenial_v1.parse(JSON.parse(json));
    expect(json).toBe(canonicalJSONStringify(parsed));
    return parsed;
  }

  afterEach(async () => {
    for (const server of servers.splice(0))
      await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const child of children.splice(0)) {
      if (child.exitCode === null) {
        child.kill();
        await exited(child);
      }
    }
    for (const store of stores.splice(0)) await store.close();
    for (const raw of databases.splice(0)) raw.close();
    for (const directory of directories.splice(0)) {
      const parent = path.resolve(fixtureParent!);
      const target = path.resolve(directory);
      if (
        path.dirname(target).toLowerCase() !== parent.toLowerCase() ||
        !path.basename(target).startsWith(fixturePrefix)
      )
        throw new Error("Unsafe private fixture cleanup target");
      const stat = await lstat(target);
      const physicalParent = await realpath(parent);
      const physicalTarget = await realpath(target);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        path.dirname(physicalTarget).toLowerCase() !== physicalParent.toLowerCase()
      )
        throw new Error("Private fixture cleanup target changed");
      await rm(target, { recursive: true, force: true });
    }
  });

  it("records one durable no-effect candidate from a canonical prepare frame", async () => {
    const f = await fixture();
    const host = launch(f.contextPath);
    await ready(host.child);
    expect(denial(await exchange(host.pipe, prepareFrame("prepare-1")))).toMatchObject({
      request_id: "prepare-1",
      reason_code: "admission_unavailable",
      effect_state: "no_effect",
      authorizes_execution: false,
    });
    expect(await exited(host.child)).toBe(0);
    expect(count(f.raw, "windows_attempt_admissions")).toBe(1);
    expect(count(f.raw, "windows_attempt_intents")).toBe(1);
    expect(count(f.raw, "windows_attempt_intent_events")).toBe(1);
    const row = f.raw
      .prepare("SELECT clientSid,admissionJson FROM windows_attempt_admissions")
      .get() as { clientSid: string; admissionJson: string };
    expect(row.clientSid).toBe(clientSid);
    expect(JSON.parse(row.admissionJson)).toMatchObject({
      client_sid: clientSid,
      disposition: "source_only_candidate",
      effect_state: "no_effect",
      authorizes_execution: false,
    });
    noWorkspaceEffects(f.raw);
  });

  it("replays one historical candidate across host restarts without another record", async () => {
    const f = await fixture();
    for (const requestId of ["prepare-1", "prepare-2"]) {
      const host = launch(f.contextPath);
      await ready(host.child);
      expect(denial(await exchange(host.pipe, prepareFrame(requestId)))).toMatchObject({
        request_id: requestId,
        reason_code: "admission_unavailable",
        effect_state: "no_effect",
      });
      expect(await exited(host.child)).toBe(0);
    }
    expect(count(f.raw, "windows_attempt_admissions")).toBe(1);
    expect(count(f.raw, "windows_attempt_intents")).toBe(1);
    expect(count(f.raw, "windows_attempt_intent_events")).toBe(1);
    noWorkspaceEffects(f.raw);
  });

  it("closes without a no-effect claim on changed-input replay", async () => {
    const f = await fixture();
    const first = launch(f.contextPath);
    await ready(first.child);
    expect(denial(await exchange(first.pipe, prepareFrame("prepare-1"))).reason_code).toBe(
      "admission_unavailable"
    );
    expect(await exited(first.child)).toBe(0);
    const changed = launch(f.contextPath);
    await ready(changed.child);
    const response = await exchange(changed.pipe, prepareFrame("prepare-2", "Changed objective"));
    expect(response.length).toBe(0);
    expect(await exited(changed.child)).not.toBe(0);
    expect(count(f.raw, "windows_attempt_admissions")).toBe(1);
    expect(count(f.raw, "windows_attempt_intent_events")).toBe(1);
    noWorkspaceEffects(f.raw);
  });

  it("rejects a stale controller fence before recording any candidate", async () => {
    const f = await fixture(true);
    const host = launch(f.contextPath);
    await ready(host.child);
    expect((await exchange(host.pipe, prepareFrame("prepare-1"))).length).toBe(0);
    expect(await exited(host.child)).not.toBe(0);
    expect(count(f.raw, "windows_attempt_admissions")).toBe(0);
    noWorkspaceEffects(f.raw);
  });

  it("does not mask a historical unknown effect with an oversized same-key packet", async () => {
    const f = await fixture();
    const first = launch(f.contextPath);
    await ready(first.child);
    expect(denial(await exchange(first.pipe, prepareFrame("prepare-1"))).reason_code).toBe(
      "admission_unavailable"
    );
    expect(await exited(first.child)).toBe(0);

    // Fixture-only historical state. Source APIs cannot create an unknown effect.
    const row = f.raw
      .prepare("SELECT operationId,intentJson FROM windows_attempt_intents")
      .get() as { operationId: string; intentJson: string };
    const prior = WindowsAttemptIntent_v1.parse(JSON.parse(row.intentJson));
    const { intent_digest: _priorDigest, ...priorBody } = prior;
    const body = WindowsAttemptIntentBody_v1.parse({
      ...priorBody,
      revision: 1,
      status: "indeterminate",
      effect_state: "effect_unknown",
      updated_at: "2026-10-28T12:00:02.000Z",
    });
    const historical = WindowsAttemptIntent_v1.parse({
      ...body,
      intent_digest: computeCanonicalHash(body),
    });
    f.raw
      .prepare(
        `INSERT INTO windows_attempt_intent_events (operationId,revision,intentJson,intentDigest)
         VALUES (?,?,?,?)`
      )
      .run(
        row.operationId,
        historical.revision,
        canonicalJSONStringify(historical),
        historical.intent_digest
      );
    f.raw
      .prepare(
        `UPDATE windows_attempt_intents SET revision=?,status=?,intentJson=?,intentDigest=?
         WHERE operationId=?`
      )
      .run(
        historical.revision,
        historical.status,
        canonicalJSONStringify(historical),
        historical.intent_digest,
        row.operationId
      );

    const oversized = prepareFrame("prepare-2", "x".repeat(70_000));
    expect(oversized.length).toBeLessThan(1024 * 1024 + 4);
    const second = launch(f.contextPath);
    await ready(second.child);
    expect((await exchange(second.pipe, oversized)).length).toBe(0);
    expect(await exited(second.child)).not.toBe(0);
    expect(count(f.raw, "windows_attempt_admissions")).toBe(1);
    expect(count(f.raw, "windows_attempt_intent_events")).toBe(2);
    noWorkspaceEffects(f.raw);
  });

  it("rejects a wrong observed SID and malformed frame without a Node candidate", async () => {
    const f = await fixture();
    const wrongSid = launch(f.contextPath, { expectedSid: "S-1-5-32-544" });
    await ready(wrongSid.child);
    expect(denial(await exchange(wrongSid.pipe, prepareFrame("prepare-1")))).toMatchObject({
      request_id: null,
      reason_code: "admission_unavailable",
      effect_state: "no_effect",
    });
    expect(await exited(wrongSid.child)).toBe(0);
    const malformed = launch(f.contextPath);
    await ready(malformed.child);
    expect(
      denial(await exchange(malformed.pipe, Buffer.from([2, 0, 0, 0, 0xc3, 0x28])))
    ).toMatchObject({
      request_id: null,
      reason_code: "invalid_frame",
      effect_state: "no_effect",
    });
    expect(await exited(malformed.child)).toBe(0);
    expect(count(f.raw, "windows_attempt_admissions")).toBe(0);
    noWorkspaceEffects(f.raw);
  });

  it("closes without a no-effect claim when the private Node child fails", async () => {
    const f = await fixture();
    await writeFile(f.contextPath, "{", "utf8");
    const host = launch(f.contextPath);
    await ready(host.child);
    const response = await exchange(host.pipe, prepareFrame("prepare-1"));
    expect(response.length).toBe(0);
    expect(await exited(host.child)).not.toBe(0);
    expect(count(f.raw, "windows_attempt_admissions")).toBe(0);
    noWorkspaceEffects(f.raw);
  });

  it("bounds a stalled private Node child and does not record a candidate", async () => {
    const f = await fixture();
    const stalledWorker = path.join(f.directory, "stalled-worker.mjs");
    await writeFile(
      stalledWorker,
      "process.stdin.resume(); setInterval(() => {}, 1000);\n",
      "utf8"
    );
    const host = launch(f.contextPath, {
      timeoutMs: 500,
      worker: stalledWorker,
      workerSha256: sha256(stalledWorker),
    });
    await ready(host.child);
    const response = await exchange(host.pipe, prepareFrame("prepare-1"));
    expect(response.length).toBe(0);
    expect(await exited(host.child)).not.toBe(0);
    expect(count(f.raw, "windows_attempt_admissions")).toBe(0);
    noWorkspaceEffects(f.raw);
  });

  it("keeps the ordinary host without an admission route and refuses pipe squatting", async () => {
    const f = await fixture();
    const ordinary = spawn(baselineImage!, ["--admission-probe"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    children.push(ordinary);
    expect(await exited(ordinary)).toBe(2);
    const id = nonce();
    const squatter = createServer();
    servers.push(squatter);
    await new Promise<void>((resolve, reject) => {
      squatter.once("error", reject);
      squatter.listen(pipeName(id), resolve);
    });
    const host = launch(f.contextPath, { id });
    expect(await exited(host.child)).not.toBe(0);
    expect(count(f.raw, "windows_attempt_admissions")).toBe(0);
    noWorkspaceEffects(f.raw);
  });
});
