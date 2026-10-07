import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OwnedCodexConnection } from "../../src/runs/owned-codex-connection.js";
import {
  AgentWorkHumanActionService,
  humanActionSummary,
  readHumanActionState,
} from "../../src/runs/agent-work-human-action-service.js";
import { SqliteCoordinationStore } from "../../src/store/sqlite/coordination-store.js";

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
    if (fs.readFileSync("mode", "utf8") === "question") send({
      id: "question-42", method: "item/tool/requestUserInput", emittedAtMs: 1791335791251,
      params: { threadId: "owned-thread", turnId: "turn-1", itemId: "question-item", autoResolutionMs: null,
        questions: [{ id: "choice", header: "Approach", question: "Which candidate?",
          options: [{ label: "A", description: "Use retained evidence." }] }] }
    });
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    if (["terminal", "question"].includes(fs.readFileSync("mode", "utf8"))) setImmediate(() => send({
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
  it("persists a native question through lost storage ACK, interruption and SQLite reopen without answering", async () => {
    const root = await mkdtemp(join(tmpdir(), "owned-codex-question-"));
    let connection: OwnedCodexConnection | undefined;
    let store: SqliteCoordinationStore | undefined;
    try {
      const home = join(root, "home");
      await mkdir(home);
      await writeFile(join(root, "app-server"), fixture);
      await writeFile(join(root, "mode"), "question");
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
      await expect.poll(() => connection!.snapshot().pendingHumanInputCaptures).toBe(1);
      const now = new Date().toISOString();
      const path = join(root, "coordination.db");
      store = new SqliteCoordinationStore(path);
      const acquired = await store.acquireControllerLease({
        runId: "run",
        controllerId: "controller",
        leaseId: "controller-lease",
        now,
        ttlMs: 60000,
        initialState: { task: "Retain exact question" },
      });
      if (!acquired.acquired) throw new Error("Fixture lease failed");
      const controller = {
        runId: "run",
        controllerId: "controller",
        leaseId: "controller-lease",
        fencingToken: acquired.lease.fencingToken,
      };
      // This deliberately simulated workspace port qualifies persistence and pipes,
      // not a real workspace, authenticated host or native containment.
      const lease = {
        leaseId: "workspace",
        runId: "run",
        attemptId: "attempt",
        revision: 1,
        repositoryId: "fixture/repo",
        hostId: "fixture-host",
        gitRuntime: "git",
        projectRoot: root,
        worktreePath: root,
        branch: "fixture",
      };
      const workspace = {
        async getAttempt() {
          return { runId: "run", attemptId: "attempt", workspaceLeaseId: "workspace" };
        },
        async getWorkspaceLease() {
          return lease;
        },
        async getWorkerSession() {
          return {
            runId: "run",
            attemptId: "attempt",
            workspaceLeaseId: "workspace",
            workerRuntime: "codex-native",
            workerId: "owned-thread",
          };
        },
      } as unknown as ConstructorParameters<typeof AgentWorkHumanActionService>[1];
      const service = new AgentWorkHumanActionService(store, workspace, {
        async observe() {
          return {
            ...lease,
            exists: true,
            registered: true,
            headSha: "a".repeat(40),
            cleanliness: "clean",
          };
        },
      });
      const input = {
        controller,
        expectedRunRevision: 0,
        mutationId: "native-question",
        now,
        attemptId: "attempt",
        workspaceLeaseId: "workspace",
        workerSessionId: "worker",
        workspaceLeaseRevision: 1,
        expectedHeadSha: "a".repeat(40),
      };
      await expect(
        connection.persistNextHumanInputCapture(
          {
            async request(value) {
              const committed = await service.request(value);
              expect(committed.ok).toBe(true);
              throw new Error("storage acknowledgement lost");
            },
          },
          input
        )
      ).rejects.toThrow("storage acknowledgement lost");
      expect(connection.snapshot().pendingHumanInputCaptures).toBe(1);
      expect(humanActionSummary((await store.getRunCoordination("run"))!.state, now)).toHaveLength(
        1
      );
      expect(await connection.persistNextHumanInputCapture(service, input)).toMatchObject({
        ok: true,
        replay: true,
      });
      expect(await store.listRunCoordinationEvents("run")).toHaveLength(1);
      await connection.interrupt({ threadId: "owned-thread", turnId: "turn-1" }, window());
      expect(await connection.awaitTerminal("turn-1", window())).toEqual({
        turnId: "turn-1",
        status: "interrupted",
      });
      expect(await connection.close()).toMatchObject({ processExited: true, forced: false });
      await store.close();
      store = new SqliteCoordinationStore(path);
      const record = (await store.getRunCoordination("run"))!;
      const entry = readHumanActionState(record.state).entries[0];
      expect(entry.workerInput).toMatchObject({
        providerRequestId: "question-42",
        workerId: "owned-thread",
        questions: [{ id: "choice", question: "Which candidate?" }],
      });
      expect(JSON.parse(entry.workerInput!.requestJson).id).toBe("question-42");
      expect(humanActionSummary(record.state, new Date().toISOString())).toHaveLength(1);
      const calls = (await readFile(join(root, "calls.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
      expect(calls.filter((call) => call.method === "turn/interrupt")).toHaveLength(1);
      expect(calls.every((call) => typeof call.method === "string")).toBe(true);
    } finally {
      await connection?.close();
      await store?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

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
