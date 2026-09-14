import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  rename,
  rm,
  symlink,
  writeFile,
  stat,
  readFile,
  open,
} from "node:fs/promises";
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
  async function operation(
    operation: "acquire" | "assert" | "release" | "open-child" | "try-open-child" | "create-child",
    argument: string,
    component?: string
  ) {
    const body = {
      kind: "directory_request",
      protocol_version: "1.0.0",
      client_nonce: nonce,
      session_nonce: hello.session_nonce,
      request_id: randomUUID(),
      operation_id: randomUUID(),
      operation,
      ...(component === undefined ? {} : { component }),
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
  async function read(token: string, component: string, maximum: number) {
    const body = {
      kind: "file_request",
      protocol_version: "1.0.0",
      operation: "read-file",
      client_nonce: nonce,
      session_nonce: hello.session_nonce,
      request_id: randomUUID(),
      operation_id: randomUUID(),
      lease_token: token,
      component,
      max_bytes: maximum,
    };
    const digest = `sha256:${createHash("sha256").update(canonicalJSONStringify(body)).digest("hex")}`;
    exchange.reserve(
      { request_id: body.request_id, operation_id: body.operation_id, request_digest: digest },
      2000
    );
    const reply = await send({ ...body, request_digest: digest });
    expect(reply.kind).toBe("file_result");
    expect(
      exchange.correlate({
        client_nonce: reply.client_nonce,
        session_nonce: reply.session_nonce,
        request_id: reply.request_id,
        operation_id: reply.operation_id,
        request_digest: reply.request_digest,
      }).correlated
    ).toBe(true);
    expect(reply.lease_token).toBe(token);
    const content = Buffer.from(reply.content_base64, "base64");
    expect(content.toString("base64")).toBe(reply.content_base64);
    expect(content.length).toBe(reply.byte_length);
    expect(content.length).toBeLessThanOrEqual(maximum);
    expect(`sha256:${createHash("sha256").update(content).digest("hex")}`).toBe(
      reply.content_sha256
    );
    return { reply, content };
  }
  async function create(
    token: string,
    component: string,
    content: Buffer,
    correction: Record<string, string> = {}
  ) {
    const body = {
      kind: "file_create_request",
      protocol_version: "1.0.0",
      operation: "create-file",
      client_nonce: nonce,
      session_nonce: hello.session_nonce,
      request_id: randomUUID(),
      operation_id: randomUUID(),
      lease_token: token,
      component,
      content_base64: content.toString("base64"),
      content_sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      ...correction,
    };
    const digest = `sha256:${createHash("sha256").update(canonicalJSONStringify(body)).digest("hex")}`;
    exchange.reserve(
      { request_id: body.request_id, operation_id: body.operation_id, request_digest: digest },
      2000
    );
    const reply = await send({ ...body, request_digest: digest });
    expect(reply.kind).toBe("file_create_result");
    expect(
      exchange.correlate({
        client_nonce: reply.client_nonce,
        session_nonce: reply.session_nonce,
        request_id: reply.request_id,
        operation_id: reply.operation_id,
        request_digest: reply.request_digest,
      }).correlated
    ).toBe(true);
    expect(reply).toMatchObject({
      status: "created",
      lease_token: token,
      byte_length: content.length,
      content_sha256: body.content_sha256,
    });
    return reply;
  }
  return { root, parent, directory, child, closed, operation, read, create };
}

describe.skipIf(process.platform !== "win32" || !executable)("real native directory lease", () => {
  it.each([0, 1, 257, 1024])("creates and reads back exactly %i bytes", async (size) => {
    const f = await setup();
    const data = Buffer.from(Array.from({ length: size }, (_, i) => i % 256));
    const root = await f.operation("acquire", f.directory);
    const created = await f.create(root.lease_token, "créé.bin", data);
    expect(await readFile(path.join(f.directory, "créé.bin"))).toEqual(data);
    const observed = await f.read(root.lease_token, "créé.bin", size);
    expect(observed.content).toEqual(data);
    expect(observed.reply.file_id).toBe(created.file_id);
    await rename(path.join(f.directory, "créé.bin"), path.join(f.directory, "closed.bin"));
    await f.operation("release", root.lease_token);
  });
  it("preserves an existing file when creation collides", async () => {
    const f = await setup();
    const target = path.join(f.directory, "existing");
    await writeFile(target, "coworker content");
    const root = await f.operation("acquire", f.directory);
    await expect(
      f.create(root.lease_token, "existing", Buffer.from("new content"))
    ).rejects.toThrow();
    await f.closed;
    expect(f.child.exitCode).toBe(3);
    expect(await readFile(target, "utf8")).toBe("coworker content");
    await rename(f.parent, f.parent + "-released");
  });
  it("creates within a held child after its parent token is released", async () => {
    const f = await setup();
    const parent = await f.operation("acquire", f.parent);
    const child = await f.operation("open-child", parent.lease_token, "café");
    await f.operation("release", parent.lease_token);
    await f.create(child.lease_token, "child-file", Buffer.from("child work"));
    expect(await readFile(path.join(f.directory, "child-file"), "utf8")).toBe("child work");
    await f.operation("release", child.lease_token);
  });
  it.each(["digest", "encoding", "component"])(
    "rejects inconsistent %s before creating a file",
    async (kind) => {
      const f = await setup();
      const root = await f.operation("acquire", f.directory);
      const correction =
        kind === "digest"
          ? { content_sha256: `sha256:${"0".repeat(64)}` }
          : kind === "encoding"
            ? { content_base64: "/x==" }
            : { component: "../outside" };
      await expect(
        f.create(root.lease_token, "not-created", Buffer.from([255]), correction)
      ).rejects.toThrow();
      await f.closed;
      expect(f.child.exitCode).toBe(3);
      await expect(stat(path.join(f.directory, "not-created"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(stat(path.join(f.parent, "outside"))).rejects.toMatchObject({ code: "ENOENT" });
      await rename(f.parent, f.parent + "-released");
    }
  );
  it.each([0, 1, 257, 1024])(
    "reads exactly %i binary bytes and closes the file handle",
    async (size) => {
      const f = await setup();
      const data = Buffer.from(Array.from({ length: size }, (_, i) => i % 256));
      const target = path.join(f.directory, "résumé.bin");
      await writeFile(target, data);
      const root = await f.operation("acquire", f.directory);
      const result = await f.read(root.lease_token, "résumé.bin", size);
      expect(result.content).toEqual(data);
      expect(result.reply.volume_serial_number).toBe(root.volume_serial_number);
      await rename(target, target + "-closed");
      expect((await f.operation("assert", root.lease_token)).status).toBe("current");
      await f.operation("release", root.lease_token);
    }
  );
  it.each(["missing", "oversized", "directory", "junction", "stream", "traversal"])(
    "fails %s file reads without returning partial content",
    async (kind) => {
      const f = await setup();
      let component = kind;
      if (kind === "oversized") await writeFile(path.join(f.directory, kind), Buffer.alloc(1025));
      if (kind === "directory") await mkdir(path.join(f.directory, kind));
      if (kind === "junction") await symlink(f.parent, path.join(f.directory, kind), "junction");
      if (kind === "stream") component = "file:stream";
      if (kind === "traversal") component = "../outside";
      const root = await f.operation("acquire", f.directory);
      await expect(f.read(root.lease_token, component, 1024)).rejects.toThrow();
      await f.closed;
      expect(f.child.exitCode).toBe(3);
      await rename(f.parent, f.parent + "-released");
    }
  );
  it("rejects a file held for writing", async () => {
    const f = await setup();
    const target = path.join(f.directory, "active");
    await writeFile(target, "in progress");
    const writer = await open(target, "r+");
    try {
      const root = await f.operation("acquire", f.directory);
      await expect(f.read(root.lease_token, "active", 1024)).rejects.toThrow();
      await f.closed;
      expect(f.child.exitCode).toBe(3);
    } finally {
      await writer.close();
    }
    await rename(f.parent, f.parent + "-released");
  });
  it("opens an independent child that survives parent release", async () => {
    const f = await setup();
    const parent = await f.operation("acquire", f.parent);
    const child = await f.operation("open-child", parent.lease_token, "café");
    expect(child).toMatchObject({
      status: "child-opened",
      path: f.directory,
      chain_length: parent.chain_length + 1,
    });
    expect(child.lease_token).not.toBe(parent.lease_token);
    await f.operation("release", parent.lease_token);
    expect((await f.operation("assert", child.lease_token)).file_id).toBe(child.file_id);
    await expect(rename(f.parent, f.parent + "-moved")).rejects.toThrow();
    await f.operation("release", child.lease_token);
    await rename(f.parent, f.parent + "-released");
  });
  it("reports a missing child without turning it into a capability or ending the session", async () => {
    const f = await setup();
    const parent = await f.operation("acquire", f.parent);
    const absent = await f.operation("try-open-child", parent.lease_token, "absent");
    expect(absent).toMatchObject({
      status: "child-missing",
      lease_token: parent.lease_token,
      file_id: parent.file_id,
      path: parent.path,
    });
    await expect(stat(path.join(f.parent, "absent"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await f.operation("assert", parent.lease_token)).status).toBe("current");
    await f.operation("release", parent.lease_token);
  });
  it("creates a child and retains nested children through EOF cleanup", async () => {
    const f = await setup();
    const parent = await f.operation("acquire", f.parent);
    const created = await f.operation("create-child", parent.lease_token, "created");
    expect(created.status).toBe("child-created");
    expect((await stat(path.join(f.parent, "created"))).isDirectory()).toBe(true);
    const nested = await f.operation("create-child", created.lease_token, "nested");
    expect(nested.chain_length).toBe(created.chain_length + 1);
    f.child.stdin.end();
    await f.closed;
    expect(f.child.exitCode).toBe(0);
    await rename(f.parent, f.parent + "-released");
  });
  it("does not overwrite an existing child when asked to create", async () => {
    const f = await setup();
    await writeFile(path.join(f.directory, "sentinel"), "preserved");
    const parent = await f.operation("acquire", f.parent);
    await expect(f.operation("create-child", parent.lease_token, "café")).rejects.toThrow();
    await f.closed;
    expect(f.child.exitCode).toBe(3);
    expect(await readFile(path.join(f.directory, "sentinel"), "utf8")).toBe("preserved");
    await rename(f.parent, f.parent + "-released");
  });
  it.each(["..", "nested/escape", "nested\\escape", "ads:stream", "trailing."])(
    "rejects invalid child component %s before creation",
    async (component) => {
      const f = await setup();
      const parent = await f.operation("acquire", f.parent);
      await expect(f.operation("create-child", parent.lease_token, component)).rejects.toThrow();
      await f.closed;
      expect(f.child.exitCode).toBe(3);
      await rename(f.parent, f.parent + "-released");
    }
  );
  it.each(["junction", "file"])("try-open does not label %s as absent", async (kind) => {
    const f = await setup();
    const target = path.join(f.parent, kind);
    if (kind === "junction") await symlink(f.directory, target, "junction");
    else await writeFile(target, "ordinary file");
    const parent = await f.operation("acquire", f.parent);
    await expect(f.operation("try-open-child", parent.lease_token, kind)).rejects.toThrow();
    await f.closed;
    expect(f.child.exitCode).toBe(3);
    await rename(f.parent, f.parent + "-released");
  });
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
