import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createConnection, createServer, type Server } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createAgentTaskPacket } from "../../src/schemas/agent-work.js";
import { canonicalJSONStringify } from "../../src/util/canonicalJson.js";
import {
  encodeWindowsCoordinatorClientFrame,
  parseWindowsCoordinatorClientFrame,
  WINDOWS_COORDINATOR_MAX_FRAME_BYTES,
} from "../../src/windows-coordinator/client-protocol.js";
import { WindowsCoordinatorDenial_v1 } from "../../src/windows-coordinator/deny-first-dispatcher.js";

const hostImage = process.env.LEXRUNNER_TEST_COORDINATOR_HOST;
const native = process.platform === "win32" && !!hostImage;
const status = {
  schema_version: "1.0.0",
  verb: "attempt.status" as const,
  request_id: "status-request-1",
  run_id: "run-1",
  attempt_id: "attempt-1",
};

function currentUserSid(): string {
  const output = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  const sid = output.match(/S-\d+(?:-\d+)+/u)?.[0];
  if (!sid) throw new Error("Current Windows user SID unavailable");
  return sid;
}

function nonce() {
  return randomBytes(16).toString("hex");
}

function pipeName(id: string) {
  return `\\\\.\\pipe\\LexRunner.Coordinator.Probe.${id}`;
}

function frame(payload: Buffer): Buffer {
  const result = Buffer.alloc(payload.length + 4);
  result.writeUInt32LE(payload.length, 0);
  payload.copy(result, 4);
  return result;
}

describe.skipIf(!native)("NativeAOT Windows coordinator console peer probe", () => {
  const children: ChildProcess[] = [];
  const servers: Server[] = [];

  function launch(expectedSid: string, timeoutMs = 3000, id = nonce()) {
    const child = spawn(
      hostImage!,
      ["--probe", "--nonce", id, "--expected-sid", expectedSid, "--timeout-ms", `${timeoutMs}`],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    children.push(child);
    return { child, pipe: pipeName(id), id };
  }

  async function ready(child: ChildProcess): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("Console probe readiness timed out")), 5000);
      child.stdout!.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (/ready\r?\n/u.test(output)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Console probe exited before ready (${code})`));
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
      const timer = setTimeout(() => reject(new Error("Console probe did not exit")), 6000);
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

  async function exchange(pipe: string, request: Buffer): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const socket = createConnection(pipe);
      socket.setTimeout(5000, () => socket.destroy(new Error("Pipe reply timed out")));
      socket.once("connect", () => socket.write(request));
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.once("end", () => resolve(Buffer.concat(chunks)));
      socket.once("error", reject);
    });
  }

  function denial(reply: Buffer) {
    expect(reply.length).toBeGreaterThan(4);
    expect(reply.readUInt32LE(0)).toBe(reply.length - 4);
    return WindowsCoordinatorDenial_v1.parse(JSON.parse(reply.subarray(4).toString("utf8")));
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
  });

  it("denies the TypeScript canonical status golden frame with no effect", async () => {
    const source = Buffer.from(encodeWindowsCoordinatorClientFrame(status));
    expect(parseWindowsCoordinatorClientFrame(source)).toEqual({ ok: true, request: status });
    const host = launch(currentUserSid());
    await ready(host.child);
    const response = await exchange(host.pipe, source);
    const expected = {
      schema_version: "1.0.0",
      kind: "denial",
      request_id: status.request_id,
      reason_code: "admission_unavailable",
      effect_state: "no_effect",
      authorizes_execution: false,
    };
    expect(denial(response)).toEqual(expected);
    expect(response.subarray(4).toString("utf8")).toBe(canonicalJSONStringify(expected));
    expect(await exited(host.child)).toBe(0);
  });

  it("keeps a TypeScript-valid prepare packet outside this transport probe's semantic scope", async () => {
    const packet = createAgentTaskPacket({
      schema_version: "1.0.0",
      packet_id: "packet-1",
      run_id: "run-1",
      work_item: { work_item_id: "work-1", revision: 1 },
      attempt_id: "attempt-1",
      repository: { id: "owner/repo", base_sha: "a".repeat(40) },
      objective: "Verify a transport-only denial",
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
      created_at: "2026-10-28T12:00:00.000Z",
    });
    const source = Buffer.from(
      encodeWindowsCoordinatorClientFrame({
        schema_version: "1.0.0",
        verb: "attempt.prepare",
        request_id: "prepare-request-1",
        client_idempotency_key: "client-key-1",
        packet,
      })
    );
    expect(parseWindowsCoordinatorClientFrame(source).ok).toBe(true);
    const host = launch(currentUserSid());
    await ready(host.child);
    expect(denial(await exchange(host.pipe, source))).toMatchObject({
      request_id: null,
      reason_code: "invalid_request",
      effect_state: "no_effect",
      authorizes_execution: false,
    });
    expect(await exited(host.child)).toBe(0);
  });

  it("denies a different expected SID after observing the actual peer", async () => {
    const host = launch("S-1-5-32-544");
    await ready(host.child);
    expect(
      denial(await exchange(host.pipe, Buffer.from(encodeWindowsCoordinatorClientFrame(status))))
    ).toMatchObject({
      request_id: null,
      reason_code: "admission_unavailable",
      effect_state: "no_effect",
      authorizes_execution: false,
    });
    expect(await exited(host.child)).toBe(0);
  });

  it.each([
    ["invalid UTF-8", frame(Buffer.from([0xc3, 0x28]))],
    ["noncanonical JSON", frame(Buffer.from(JSON.stringify(status)))],
    ["zero length", Buffer.alloc(4)],
  ])("denies %s before admission", async (_label, request) => {
    const host = launch(currentUserSid());
    await ready(host.child);
    expect(denial(await exchange(host.pipe, request))).toMatchObject({
      request_id: null,
      reason_code: "invalid_frame",
      effect_state: "no_effect",
      authorizes_execution: false,
    });
    expect(await exited(host.child)).toBe(0);
  });

  it("refuses an oversized declared length without reading a payload", async () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(WINDOWS_COORDINATOR_MAX_FRAME_BYTES + 1, 0);
    const host = launch(currentUserSid());
    await ready(host.child);
    expect(denial(await exchange(host.pipe, header))).toMatchObject({
      request_id: null,
      reason_code: "invalid_frame",
    });
    expect(await exited(host.child)).toBe(0);
  });

  it("ends an unconnected pipe at its one bounded deadline", async () => {
    const host = launch(currentUserSid(), 500);
    await ready(host.child);
    expect(await exited(host.child)).toBe(4);
  });

  it("ends a connected client that sends no header at the same deadline", async () => {
    const host = launch(currentUserSid(), 500);
    await ready(host.child);
    const socket = createConnection(host.pipe);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", () => resolve());
        socket.once("error", reject);
      });
      expect(await exited(host.child)).toBe(4);
    } finally {
      socket.destroy();
    }
  });

  it("refuses a disconnected partial frame", async () => {
    const host = launch(currentUserSid());
    await ready(host.child);
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(host.pipe);
      socket.once("connect", () =>
        socket.write(Buffer.from([10, 0, 0, 0]), () => socket.destroy())
      );
      socket.once("close", () => resolve());
      socket.once("error", reject);
    });
    expect(await exited(host.child)).toBe(5);
  });

  it("refuses a preexisting pipe instance", async () => {
    const id = nonce();
    const squatter = createServer();
    servers.push(squatter);
    await new Promise<void>((resolve, reject) => {
      squatter.once("error", reject);
      squatter.listen(pipeName(id), resolve);
    });
    const host = launch(currentUserSid(), 3000, id);
    expect(await exited(host.child)).toBe(3);
  });

  it("refuses service and unknown modes before pipe creation", async () => {
    for (const args of [["--service"], ["--unknown"]]) {
      const child = spawn(hostImage!, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      children.push(child);
      expect(await exited(child)).toBe(2);
    }
  });
});
