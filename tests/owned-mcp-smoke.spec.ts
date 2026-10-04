import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  drainBlockingGateFixtures,
  drainGateOperationFixtures,
  ownMcpConnection,
} from "../scripts/owned-mcp-smoke.mjs";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lexrunner-owned-mcp-test-"));
  roots.push(root);
  const transport: { pid: number | null; onclose?: () => void } = { pid: 31415 };
  const client = {
    onclose: vi.fn(),
    connect: vi.fn(async () => {
      // Match Protocol.connect's public callback preservation, not private fields.
      const previousClose = transport.onclose;
      transport.onclose = () => {
        previousClose?.();
        client.onclose();
      };
    }),
    close: vi.fn(async () => {
      // SDK close can discard its public PID and resolve before child close.
      transport.pid = null;
    }),
  };
  const connection = ownMcpConnection(client, transport, {
    fixtureRoot: root,
    closeTimeoutMs: 25,
  });
  return { root, transport, client, connection };
}

describe("owned smoke MCP release observation", () => {
  it("retains the fixture when close resolves without the actual transport close event", async () => {
    vi.useFakeTimers();
    const { root, transport, connection } = fixture();
    await connection.connect();
    const closing = connection.close();
    const rejected = expect(closing).rejects.toMatchObject({
      resourceRelease: "uncertain",
      retainedFixtureRoot: root,
      ownedProcessClosed: false,
      ownedProcessId: 31415,
    });
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(transport.pid).toBeNull();
    expect(connection.closed).toBe(false);
    expect(fs.existsSync(root)).toBe(true);
  });

  it("does not accept client protocol closure as spawned-process release", async () => {
    vi.useFakeTimers();
    const { client, connection } = fixture();
    await connection.connect();
    client.onclose();
    const rejected = expect(connection.close()).rejects.toMatchObject({
      resourceRelease: "uncertain",
      ownedProcessClosed: false,
    });
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(connection.closed).toBe(false);
  });

  it("waits for the late transport event and retains the original owned PID", async () => {
    const { client, transport, connection } = fixture();
    await connection.connect();
    let resolved = false;
    const closing = connection.close().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(client.close).toHaveBeenCalledOnce();
    expect(resolved).toBe(false);
    expect(transport.pid).toBeNull();
    transport.onclose?.();
    await closing;
    expect(client.onclose).toHaveBeenCalledOnce();
    expect(connection.closed).toBe(true);
    expect(connection.ownedProcessClosed).toBe(true);
    expect(connection.ownedProcessId).toBe(31415);
    await connection.close();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("bounds a close call that remains pending even after transport closure", async () => {
    vi.useFakeTimers();
    const { client, transport, connection } = fixture();
    client.close.mockImplementation(() => new Promise(() => {}));
    await connection.connect();
    const rejected = expect(connection.close()).rejects.toMatchObject({
      resourceRelease: "uncertain",
      ownedProcessClosed: true,
    });
    transport.onclose?.();
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(connection.closed).toBe(false);
  });

  it("allows cleanup when no connect or process-start attempt was made", async () => {
    const { client, connection } = fixture();
    await connection.close();
    expect(client.connect).not.toHaveBeenCalled();
    expect(connection.closed).toBe(true);
    expect(connection.ownedProcessClosed).toBe(false);
  });

  it("preserves uncertainty after a failed connect without a process close event", async () => {
    vi.useFakeTimers();
    const { client, connection } = fixture();
    client.connect.mockRejectedValue(new Error("synthetic connect failure"));
    await expect(connection.connect()).rejects.toThrow("synthetic connect failure");
    const rejected = expect(connection.close()).rejects.toMatchObject({
      resourceRelease: "uncertain",
    });
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
  });
});

describe("lost gate acknowledgement cleanup ordering", () => {
  it("recovers a descriptor published during admission shutdown after owned process closure", async () => {
    const { root, client, transport, connection } = fixture();
    await connection.connect();
    const descriptor = path.join(root, "operation.json");
    const current: { gates: string[]; handle?: unknown } = { gates: ["held"] };
    const order: string[] = [];
    client.close.mockImplementation(async () => {
      expect(fs.existsSync(descriptor)).toBe(false);
      order.push("late-admission");
      fs.writeFileSync(descriptor, JSON.stringify({ operation: "retained" }));
      transport.pid = null;
      transport.onclose?.();
      order.push("process-closed");
    });
    const observeTerminal = vi.fn(async () => {
      order.push("terminal-observed");
      return { state: "completed" };
    });
    await drainGateOperationFixtures({
      fixtures: [current],
      connections: new Set([connection]),
      fixtureRoot: root,
      release: () => order.push("release"),
      recoverHandle: () => {
        expect(connection.ownedProcessClosed).toBe(true);
        order.push("recover");
        current.handle = JSON.parse(fs.readFileSync(descriptor, "utf8"));
      },
      observeTerminal,
    });
    expect(order).toEqual([
      "release",
      "late-admission",
      "process-closed",
      "recover",
      "terminal-observed",
    ]);
    expect(observeTerminal).toHaveBeenCalledExactlyOnceWith({ operation: "retained" });
    expect(fs.existsSync(descriptor)).toBe(true);
  });

  it("does not recover or remove evidence while admission process release is uncertain", async () => {
    vi.useFakeTimers();
    const { root, connection } = fixture();
    await connection.connect();
    const descriptor = path.join(root, "operation.json");
    fs.writeFileSync(descriptor, "late admission remains possible\n");
    const recoverHandle = vi.fn();
    const observeTerminal = vi.fn();
    const rejected = expect(
      drainGateOperationFixtures({
        fixtures: [{ gates: ["held"] }],
        connections: new Set([connection]),
        fixtureRoot: root,
        release: vi.fn(),
        recoverHandle,
        observeTerminal,
      })
    ).rejects.toMatchObject({
      resourceRelease: "uncertain",
      retainedFixtureRoot: root,
      ownedProcessClosed: false,
      ownedProcessId: 31415,
    });
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(recoverHandle).not.toHaveBeenCalled();
    expect(observeTerminal).not.toHaveBeenCalled();
    expect(fs.readFileSync(descriptor, "utf8")).toBe("late admission remains possible\n");
  });

  it("retains recovered evidence when bounded terminal observation fails", async () => {
    const { root, client, transport, connection } = fixture();
    await connection.connect();
    client.close.mockImplementation(async () => transport.onclose?.());
    const marker = path.join(root, "retained-marker");
    fs.writeFileSync(marker, "owned fixture\n");
    const current: { gates: string[]; handle?: unknown } = { gates: [] };
    await expect(
      drainGateOperationFixtures({
        fixtures: [current],
        connections: new Set([connection]),
        fixtureRoot: root,
        release: vi.fn(),
        recoverHandle: () => {
          current.handle = { operation: "known" };
        },
        observeTerminal: async () => {
          throw new Error("terminal observation deadline");
        },
      })
    ).rejects.toMatchObject({ resourceRelease: "uncertain", retainedFixtureRoot: root });
    expect(fs.readFileSync(marker, "utf8")).toBe("owned fixture\n");
  });
});

describe("blocking producer cleanup uncertainty", () => {
  it("retains a lost blocking producer outcome even after actual server process closure", async () => {
    const { root, client, transport, connection } = fixture();
    await connection.connect();
    client.close.mockImplementation(async () => transport.onclose?.());
    await expect(
      drainBlockingGateFixtures({
        connections: new Set([connection]),
        unresolvedProducers: new Set(["timed-out blocking request"]),
        fixtureRoot: root,
      })
    ).rejects.toMatchObject({ resourceRelease: "uncertain", retainedFixtureRoot: root });
    expect(connection.ownedProcessClosed).toBe(true);
    expect(fs.existsSync(root)).toBe(true);
  });

  it("finishes when server closure and all blocking producer outcomes are observed", async () => {
    const { root, client, transport, connection } = fixture();
    await connection.connect();
    client.close.mockImplementation(async () => transport.onclose?.());
    await drainBlockingGateFixtures({
      connections: new Set([connection]),
      unresolvedProducers: new Set(),
      fixtureRoot: root,
    });
    expect(connection.closed).toBe(true);
  });
});
