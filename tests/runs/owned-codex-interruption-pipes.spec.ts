import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OwnedCodexConnection } from "../../src/runs/owned-codex-connection.js";

// A controlled JSONL child, not Codex or inference. Node executes the extensionless
// app-server fixture using the transport's fixed argv on Windows and Linux alike.
const fixture = `
const fs = require("node:fs");
const readline = require("node:readline");
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  fs.appendFileSync("calls.jsonl", JSON.stringify(message) + "\\n");
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (message.method === "thread/start") send({ id: message.id, result: {
    thread: { id: "owned-thread", ephemeral: true, status: { type: "idle" }, turns: [] },
    cwd: process.cwd(), approvalPolicy: "never", sandbox: { type: "readOnly" },
    model: "controlled", modelProvider: "fixture"
  } });
  if (message.method === "turn/start") {
    send({ method: "turn/started", params: { threadId: "owned-thread", turn: { id: "turn-1", status: "inProgress" } } });
    send({ id: message.id, result: { turn: { id: "turn-1" } } });
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    if (fs.readFileSync("mode", "utf8") === "terminal") setImmediate(() => send({
      method: "turn/completed", params: { threadId: "owned-thread", turn: { id: "turn-1", status: "interrupted", items: [] } }
    }));
  }
});
`;
const window = () => ({
  signal: new AbortController().signal,
  deadlineAt: new Date(Date.now() + 3000).toISOString(),
});

describe("owned interruption over real child pipes (controlled protocol)", () => {
  it.each(["terminal", "ack-only"])(
    "keeps %s evidence distinct with one dispatch and one stop",
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), "owned-codex-stop-"));
      let connection: OwnedCodexConnection | undefined;
      try {
        const home = join(root, "home");
        await mkdir(home);
        await writeFile(join(root, "app-server"), fixture);
        await writeFile(join(root, "mode"), mode);
        await writeFile(join(root, "sentinel"), "unchanged");
        connection = await OwnedCodexConnection.open({
          executable: process.execPath,
          cwd: root,
          codexHome: home,
          adapterId: "controlled-pipe-fixture",
          adapterVersion: "1",
        });
        await connection.request(
          "turn/start",
          {
            threadId: connection.session.threadId,
            input: [{ type: "text", text: "controlled fixture; no model execution" }],
          },
          window()
        );
        const ack = await connection.interrupt(
          { threadId: connection.session.threadId, turnId: "turn-1" },
          window()
        );
        expect(ack.acknowledged).toBe(true);
        const observed = await connection.awaitTerminal("turn-1", {
          ...window(),
          deadlineAt: new Date(Date.now() + (mode === "terminal" ? 3000 : 40)).toISOString(),
        });
        expect(observed).toEqual(
          mode === "terminal" ? { turnId: "turn-1", status: "interrupted" } : null
        );
        const closed = await connection.close();
        expect(closed).toMatchObject({
          processExited: true,
          forced: false,
          execution: "may_have_started",
        });
        expect(connection.snapshot()).toMatchObject({
          failure: null,
          interruptAttempted: true,
          interruptAcknowledged: true,
          pendingTurnCaptures: mode === "terminal" ? 1 : 0,
        });
        const calls = (await readFile(join(root, "calls.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
        expect(calls.filter((call) => call.method === "turn/interrupt")).toEqual([
          expect.objectContaining({ params: { threadId: "owned-thread", turnId: "turn-1" } }),
        ]);
        expect(await readFile(join(root, "sentinel"), "utf8")).toBe("unchanged");
      } finally {
        await connection?.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});
