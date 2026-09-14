import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJSONStringify } from "../../src/util/canonicalJson.js";
import {
  WindowsBoundaryControlDecoder,
  encodeWindowsBoundarySession,
} from "../../src/workspaces/windows-boundary-protocol.js";
import { WindowsBoundaryExchange } from "../../src/workspaces/windows-boundary-exchange.js";

const executable = process.env.LEXRUNNER_TEST_NATIVE_HELPER;
const artifacts = path.resolve("artifacts");
const roots: string[] = [];
const peers: Array<{ child: ChildProcessWithoutNullStreams; closed: Promise<void> }> = [];
afterEach(async () => {
  for (const peer of peers.splice(0)) {
    peer.child.stdin.end();
    const timer = setTimeout(() => peer.child.kill(), 1000);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        peer.closed,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error("helper cleanup uncertain")), 3000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      clearTimeout(deadline);
    }
  }
  for (const root of roots.splice(0)) {
    if (
      path.dirname(path.resolve(root)) !== artifacts ||
      !path.basename(root).startsWith("native-lease-")
    )
      throw new Error("Unsafe cleanup root");
    await rm(root, { recursive: true, force: true });
  }
});

async function setup() {
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(path.join(artifacts, "native-lease-"));
  roots.push(root);
  const parent = path.join(root, "parent");
  const directory = path.join(parent, "café");
  await mkdir(directory, { recursive: true });
  const child = spawn(executable!, ["--boundary-session", "1.0.0"], {
    windowsHide: true,
    stdio: "pipe",
  });
  const decoder = new WindowsBoundaryControlDecoder(true);
  let pending: { resolve: (value: any) => void; reject: (error: Error) => void } | undefined;
  const closed = new Promise<void>((resolve) =>
    child.on("close", () => {
      pending?.reject(new Error("helper closed"));
      pending = undefined;
      resolve();
    })
  );
  peers.push({ child, closed });
  child.stderr.resume();
  child.stdin.on("error", (error) => pending?.reject(error));
  child.on("error", (error) => pending?.reject(error));
  child.stdout.on("data", (chunk) => {
    try {
      const messages = decoder.push(chunk);
      if (messages.length === 0) return;
      if (messages.length !== 1 || !pending) throw new Error("Unexpected helper reply");
      const waiter = pending;
      pending = undefined;
      waiter.resolve(messages[0]);
    } catch (error) {
      pending?.reject(error as Error);
      child.kill();
    }
  });
  async function send(message: unknown) {
    const frame = encodeWindowsBoundarySession(message);
    return await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("helper request timed out"));
      }, 2000);
      pending = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      child.stdin.write(frame);
    });
  }
  const nonce = randomBytes(32).toString("hex");
  const hello = await send({
    kind: "hello",
    protocol_version: "1.0.0",
    request_id: randomUUID(),
    client_nonce: nonce,
  });
  expect(hello).toMatchObject({
    kind: "hello_result",
    client_nonce: nonce,
    helper: { process_id: child.pid },
  });
  const exchange = new WindowsBoundaryExchange({
    client_nonce: nonce,
    session_nonce: hello.session_nonce,
  });
  async function operation(operation: "acquire" | "assert" | "release", argument: string) {
    const body = {
      kind: "directory_request",
      protocol_version: "1.0.0",
      client_nonce: nonce,
      session_nonce: hello.session_nonce,
      request_id: randomUUID(),
      operation_id: randomUUID(),
      operation,
      ...(operation === "acquire" ? { path: argument } : { lease_token: argument }),
    };
    const digest = `sha256:${createHash("sha256").update(canonicalJSONStringify(body)).digest("hex")}`;
    exchange.reserve(
      { request_id: body.request_id, operation_id: body.operation_id, request_digest: digest },
      2000
    );
    const reply = await send({ ...body, request_digest: digest });
    expect(reply.kind).toBe("directory_result");
    expect(
      exchange.correlate({
        client_nonce: reply.client_nonce,
        session_nonce: reply.session_nonce,
        request_id: reply.request_id,
        operation_id: reply.operation_id,
        request_digest: reply.request_digest,
      }).correlated
    ).toBe(true);
    return reply;
  }
  return { root, parent, directory, child, closed, operation };
}

describe.skipIf(process.platform !== "win32" || !executable)("real native directory lease", () => {
  it("holds leaf and ancestor across requests, revalidates, then releases", async () => {
    const f = await setup();
    await rename(f.directory, f.directory + "-control");
    await rename(f.directory + "-control", f.directory);
    const acquired = await f.operation("acquire", f.directory);
    expect(acquired.status).toBe("acquired");
    expect(acquired.path.toLowerCase()).toBe(f.directory.toLowerCase());
    expect(acquired.chain_length).toBeGreaterThan(2);
    await expect(rename(f.directory, f.directory + "-moved")).rejects.toThrow();
    await expect(rename(f.parent, f.parent + "-moved")).rejects.toThrow();
    const current = await f.operation("assert", acquired.lease_token);
    expect(current).toMatchObject({
      status: "current",
      file_id: acquired.file_id,
      volume_serial_number: acquired.volume_serial_number,
      path: acquired.path,
    });
    expect((await f.operation("release", acquired.lease_token)).status).toBe("released");
    await rename(f.parent, f.parent + "-released");
    await rename(f.parent + "-released", f.parent);
    await expect(f.operation("assert", acquired.lease_token)).rejects.toThrow();
  });
  it("releases outstanding handles on EOF", async () => {
    const f = await setup();
    await f.operation("acquire", f.directory);
    f.child.stdin.end();
    await f.closed;
    expect(f.child.exitCode).toBe(0);
    await rename(f.parent, f.parent + "-released");
  });
  it("rejects a wrong lease token and closes the held chain", async () => {
    const f = await setup();
    await f.operation("acquire", f.directory);
    await expect(f.operation("assert", "0".repeat(64))).rejects.toThrow();
    await f.closed;
    expect(f.child.exitCode).toBe(3);
    await rename(f.parent, f.parent + "-released");
  });
  it("rejects a junction rather than following its target", async () => {
    const f = await setup();
    const link = path.join(f.root, "junction");
    await symlink(f.parent, link, "junction");
    await expect(f.operation("acquire", link)).rejects.toThrow();
    await f.closed;
    expect(f.child.exitCode).toBe(3);
    await rename(f.parent, f.parent + "-untouched");
  });
  it.each(["missing", "file"])("cleans partial acquisition for %s", async (kind) => {
    const f = await setup();
    const target = path.join(f.parent, kind);
    if (kind === "file") await writeFile(target, "ordinary file");
    await expect(f.operation("acquire", target)).rejects.toThrow();
    await f.closed;
    expect(f.child.exitCode).toBe(3);
    await rename(f.parent, f.parent + "-released");
  });
});
