import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { OwnedCodexConnection } from "../../src/runs/owned-codex-connection.js";
import { CodexReceiptOutputSchema } from "../../src/runs/codex-receipt-contract.js";
import {
  FinalAgentMessage,
  type WorkerReceiptCapture,
} from "../../src/store/worker-receipt-evidence.js";
import { TerminalTurnNotification } from "../../src/store/worker-turn-evidence.js";
import { InMemoryWorkerObservationStore } from "../../src/store/inmemory/worker-observation-store.js";
import { createAttachedWorker, taskPacket } from "../store/worker-dispatch-fixture.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const options = {
  executable: resolve("codex.exe"),
  cwd: resolve("scratch"),
  codexHome: resolve("home"),
  adapterId: "test",
  adapterVersion: "1",
};
let child: EventEmitter & {
  pid: number;
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};
let sent: Array<{ id?: number; method: string; params: unknown }>;
let mode: string;
let providerThreadId: string;
let connection: OwnedCodexConnection | undefined;
function reply(value: unknown) {
  child.stdout.write(JSON.stringify(value) + "\n");
}
beforeEach(() => {
  sent = [];
  mode = "normal";
  providerThreadId = "owned-thread";
  child = Object.assign(new EventEmitter(), {
    pid: 123,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        const message = JSON.parse(chunk.toString());
        sent.push(message);
        queueMicrotask(() => {
          if (message.method === "initialize") reply({ id: message.id, result: {} });
          if (message.method === "thread/start")
            reply({
              id: message.id,
              result: {
                thread: {
                  id: providerThreadId,
                  ephemeral: true,
                  status: { type: "idle" },
                  turns: [],
                },
                cwd: options.cwd,
                approvalPolicy: "never",
                sandbox: { type: mode === "bad-settings" ? "dangerFullAccess" : "readOnly" },
                model: "test-model",
                modelProvider: "test",
              },
            });
          if (message.method === "turn/start" && mode !== "lost")
            reply({
              id: message.id,
              result: mode === "bad-start" ? {} : { turn: { id: "turn-1" } },
            });
          if (message.method === "turn/interrupt" && mode !== "lost-interrupt")
            reply({ id: message.id, result: mode === "bad-interrupt" ? { stopped: true } : {} });
        });
        callback();
      },
      final(callback) {
        queueMicrotask(() => child.emit("close", 0, null));
        callback();
      },
    }),
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    }),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
});
afterEach(async () => {
  await connection?.close();
  connection = undefined;
  vi.restoreAllMocks();
});
const requestOptions = () => ({
  signal: new AbortController().signal,
  deadlineAt: new Date(Date.now() + 1000).toISOString(),
});
const params = { threadId: "owned-thread", input: [{ type: "text" as const, text: "task" }] };

describe("owned Codex connection", () => {
  const humanInput = (id: number | string = 42) => ({
    id,
    method: "item/tool/requestUserInput",
    emittedAtMs: 1791335791251,
    params: {
      threadId: "owned-thread",
      turnId: "turn-1",
      itemId: "question-item",
      autoResolutionMs: null,
      questions: [
        {
          id: "choice",
          header: "Approach",
          question: "Which candidate?",
          isSecret: false,
          isOther: true,
          options: [{ label: "A", description: "Use the retained evidence." }],
        },
      ],
    },
  });
  const persistInput = () => ({
    controller: { runId: "run", controllerId: "controller", leaseId: "lease", fencingToken: 1 },
    expectedRunRevision: 0,
    mutationId: "capture",
    now: new Date().toISOString(),
    attemptId: "attempt",
    workspaceLeaseId: "workspace",
    workerSessionId: "worker",
    workspaceLeaseRevision: 1,
    expectedHeadSha: "a".repeat(40),
  });

  it("retains an exact question until the portable hold commit confirms, without answering", async () => {
    connection = await OwnedCodexConnection.open(options);
    await connection.request("turn/start", params, requestOptions());
    const question = humanInput();
    const wire = JSON.stringify(question);
    reply(question);
    expect(connection.snapshot()).toMatchObject({
      failure: null,
      pendingHumanInputCaptures: 1,
      unclearedHumanRequests: 1,
    });
    let committed: unknown;
    const request = vi
      .fn()
      .mockImplementationOnce(async (input) => {
        committed = structuredClone(input);
        throw new Error("storage response lost");
      })
      .mockResolvedValueOnce({ ok: false, reason: "stale_revision" })
      .mockResolvedValueOnce({ ok: true, revision: 1, replay: true });
    const input = persistInput();
    await expect(connection.persistNextHumanInputCapture({ request }, input)).rejects.toThrow(
      "storage response lost"
    );
    expect(connection.snapshot().pendingHumanInputCaptures).toBe(1);
    expect(await connection.persistNextHumanInputCapture({ request }, input)).toMatchObject({
      ok: false,
    });
    expect(connection.snapshot().pendingHumanInputCaptures).toBe(1);
    expect(await connection.persistNextHumanInputCapture({ request }, input)).toMatchObject({
      ok: true,
      replay: true,
    });
    expect(request.mock.calls[2][0]).toEqual(committed);
    expect(committed).toMatchObject({
      request: {
        action: "other",
        run_id: "run",
        attempt_id: "attempt",
        worker_session_id: "worker",
      },
      workerInput: {
        version: 1,
        workerRuntime: "codex-native",
        workerId: "owned-thread",
        turnId: "turn-1",
        providerRequestId: 42,
        requestJson: wire,
        questions: [{ id: "choice", allowOther: true, options: [{ label: "A" }] }],
      },
    });
    expect(connection.snapshot().pendingHumanInputCaptureBytes).toBe(0);
    expect(await connection.persistNextHumanInputCapture({ request }, input)).toBeNull();
    expect(sent.every((message) => typeof message.method === "string")).toBe(true);
    expect(sent.filter((message) => message.method === "turn/start")).toHaveLength(1);
  });

  it("keeps captured questions through cleanup, terminal observation and child exit", async () => {
    connection = await OwnedCodexConnection.open(options);
    await connection.request("turn/start", params, requestOptions());
    reply(humanInput("42"));
    reply({
      method: "serverRequest/resolved",
      params: { threadId: "owned-thread", requestId: 42 },
    });
    expect(connection.snapshot().unclearedHumanRequests).toBe(1);
    reply({
      method: "serverRequest/resolved",
      params: { threadId: "owned-thread", requestId: "42" },
    });
    expect(connection.snapshot().unclearedHumanRequests).toBe(0);
    reply(terminal());
    await connection.close();
    const request = vi.fn().mockResolvedValue({ ok: true, revision: 1, replay: false });
    expect(
      await connection.persistNextHumanInputCapture({ request }, persistInput())
    ).toMatchObject({ ok: true });
    expect(request.mock.calls[0][0].workerInput.providerRequestId).toBe("42");
  });

  it("deduplicates exact pending questions but rejects conflicting or reused request IDs", async () => {
    connection = await OwnedCodexConnection.open(options);
    await connection.request("turn/start", params, requestOptions());
    reply(humanInput());
    reply(humanInput());
    expect(connection.snapshot()).toMatchObject({ failure: null, pendingHumanInputCaptures: 1 });
    const changed = humanInput();
    changed.params.questions[0].question = "Different scope?";
    reply(changed);
    expect(connection.snapshot()).toMatchObject({
      failure: "human_input_request_conflict",
      pendingHumanInputCaptures: 1,
    });
  });

  it("rejects request ID reuse after cleanup without losing the original question", async () => {
    connection = await OwnedCodexConnection.open(options);
    await connection.request("turn/start", params, requestOptions());
    reply(humanInput());
    reply({
      method: "serverRequest/resolved",
      params: { threadId: "owned-thread", requestId: 42 },
    });
    reply(humanInput());
    expect(connection.snapshot()).toMatchObject({
      failure: "human_input_request_conflict",
      pendingHumanInputCaptures: 1,
    });
  });

  it("refuses questions for an unobserved turn", async () => {
    connection = await OwnedCodexConnection.open(options);
    reply(humanInput());
    expect(connection.snapshot()).toMatchObject({
      failure: "human_input_turn_mismatch",
      pendingHumanInputCaptures: 0,
    });
  });

  it.each(["before-dispatch", "during-turn"])(
    "rejects questions missing their request ID %s",
    async (stage) => {
      connection = await OwnedCodexConnection.open(options);
      if (stage === "during-turn") await connection.request("turn/start", params, requestOptions());
      const { id: _id, ...missingId } = humanInput();
      reply(missingId);
      expect(connection.snapshot()).toMatchObject({
        failure: "unsupported_human_input",
        pendingHumanInputCaptures: 0,
      });
    }
  );

  it("refuses concurrent questions", async () => {
    connection = await OwnedCodexConnection.open(options);
    await connection.request("turn/start", params, requestOptions());
    reply(humanInput());
    reply(humanInput(43));
    expect(connection.snapshot()).toMatchObject({
      failure: "human_input_already_pending",
      pendingHumanInputCaptures: 1,
    });
  });

  it.each([
    "secret",
    "auto",
    "duplicate-question",
    "unknown",
    "other-thread",
    "other-turn",
    "terminal",
  ])("rejects unsupported or misbound %s questions before queueing", async (kind) => {
    connection = await OwnedCodexConnection.open(options);
    await connection.request("turn/start", params, requestOptions());
    const question = humanInput();
    if (kind === "secret") Object.assign(question.params.questions[0], { isSecret: true });
    if (kind === "auto") Object.assign(question.params, { autoResolutionMs: 0 });
    if (kind === "duplicate-question") question.params.questions.push(question.params.questions[0]);
    if (kind === "unknown") Object.assign(question.params, { authority: "approved" });
    if (kind === "other-thread") question.params.threadId = "other";
    if (kind === "other-turn") question.params.turnId = "other";
    if (kind === "terminal") reply(terminal());
    reply(question);
    expect(connection.snapshot().failure).not.toBeNull();
    expect(connection.snapshot().pendingHumanInputCaptures).toBe(0);
  });

  it("accepts a question after native started observation while dispatch ACK is pending", async () => {
    connection = await OwnedCodexConnection.open(options);
    mode = "lost";
    const dispatched = connection.request("turn/start", params, requestOptions());
    reply({ method: "turn/started", params: { threadId: "owned-thread", turn: { id: "turn-1" } } });
    reply(humanInput());
    expect(connection.snapshot()).toMatchObject({ failure: null, pendingHumanInputCaptures: 1 });
    const start = sent.find((message) => message.method === "turn/start")!;
    reply({ id: start.id, result: { turn: { id: "turn-1" } } });
    await dispatched;
  });

  it("serializes capture persistence and snapshots the caller's binding before the asynchronous service", async () => {
    connection = await OwnedCodexConnection.open(options);
    await connection.request("turn/start", params, requestOptions());
    reply(humanInput());
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = vi.fn(async (input) => {
      await ready;
      expect(input.request.run_id).toBe("run");
      expect(input.request.attempt_id).toBe("attempt");
      return { ok: true as const, revision: 1, replay: false };
    });
    const input = persistInput();
    const persistence = connection.persistNextHumanInputCapture({ request }, input);
    input.controller.runId = "other";
    input.attemptId = "other";
    await expect(
      connection.persistNextHumanInputCapture({ request }, persistInput())
    ).rejects.toThrow("capture_in_progress");
    release();
    await persistence;
  });

  const stopParams = { threadId: "owned-thread", turnId: "turn-1" };
  it("bounds retained request identities without evicting an unanswered durable capture", async () => {
    connection = await OwnedCodexConnection.open(options);
    await connection.request("turn/start", params, requestOptions());
    for (let id = 0; id < 128; id++) {
      reply(humanInput(id));
      reply({
        method: "serverRequest/resolved",
        params: { threadId: "owned-thread", requestId: id },
      });
    }
    expect(connection.snapshot()).toMatchObject({ failure: null, pendingHumanInputCaptures: 128 });
    reply(humanInput(128));
    expect(connection.snapshot()).toMatchObject({
      failure: "human_input_capture_limit",
      pendingHumanInputCaptures: 128,
    });
  });

  it("accepts bounded free-text questions and refuses oversized source bytes", async () => {
    connection = await OwnedCodexConnection.open(options);
    await connection.request("turn/start", params, requestOptions());
    const freeText = humanInput();
    Object.assign(freeText.params.questions[0], { options: null });
    reply(freeText);
    const request = vi.fn().mockResolvedValue({ ok: true, revision: 1, replay: false });
    await connection.persistNextHumanInputCapture({ request }, persistInput());
    expect(request.mock.calls[0][0].workerInput.questions[0].options).toBeNull();
    reply({
      method: "serverRequest/resolved",
      params: { threadId: "owned-thread", requestId: 42 },
    });
    const oversized = humanInput(43);
    oversized.params.questions = Array.from({ length: 4 }, (_, index) => ({
      ...oversized.params.questions[0],
      id: `q${index}`,
      question: "鳥".repeat(2048),
    }));
    reply(oversized);
    expect(connection.snapshot()).toMatchObject({
      failure: "unsupported_human_input",
      pendingHumanInputCaptures: 0,
    });
  });

  it("bounds the aggregate capture queue without discarding previously captured questions", async () => {
    connection = await OwnedCodexConnection.open(options);
    await connection.request("turn/start", params, requestOptions());
    for (let id = 0; id < 128 && !connection.snapshot().failure; id++) {
      const question = humanInput(id);
      question.params.questions = [0, 1].map((index) => ({
        ...question.params.questions[0],
        id: `q${index}`,
        question: "a".repeat(4096),
      }));
      reply(question);
      if (!connection.snapshot().failure)
        reply({
          method: "serverRequest/resolved",
          params: { threadId: "owned-thread", requestId: id },
        });
    }
    expect(connection.snapshot().failure).toBe("human_input_capture_limit");
    expect(connection.snapshot().pendingHumanInputCaptureBytes).toBeLessThanOrEqual(
      2 * 1024 * 1024
    );
    expect(connection.snapshot().pendingHumanInputCaptures).toBeGreaterThan(0);
  });

  const terminal = (status = "interrupted", turnId = "turn-1") => ({
    method: "turn/completed",
    emittedAtMs: 1791335791251,
    params: { threadId: "owned-thread", turn: { id: turnId, status } },
  });

  it("accepts only bounded native emission metadata without opening arbitrary headers", () => {
    const final = {
      method: "item/completed",
      emittedAtMs: 1791335791251,
      params: {
        threadId: "owned-thread",
        turnId: "turn-1",
        item: { type: "agentMessage", id: "item-1", phase: "final_answer", text: "{}" },
      },
    };
    for (const [schema, event] of [
      [TerminalTurnNotification, terminal()],
      [FinalAgentMessage, final],
    ] as const) {
      expect(schema.safeParse(event).success).toBe(true);
      for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1791335791251", null])
        expect(schema.safeParse({ ...event, emittedAtMs: value }).success).toBe(false);
      expect(schema.safeParse({ ...event, authority: "approved" }).success).toBe(false);
    }
  });

  it("rejects unobserved, wrong-thread, wrong-turn, and overridden stops without sending", async () => {
    connection = await OwnedCodexConnection.open(options);
    await expect(connection.interrupt(stopParams, requestOptions())).rejects.toThrow(
      "turn_not_observed"
    );
    await connection.request("turn/start", params, requestOptions());
    await expect(
      connection.interrupt({ ...stopParams, threadId: "other" }, requestOptions())
    ).rejects.toThrow("thread_mismatch");
    await expect(
      connection.interrupt({ ...stopParams, turnId: "other" }, requestOptions())
    ).rejects.toThrow("turn_mismatch");
    await expect(
      connection.interrupt({ ...stopParams, scope: "all" } as typeof stopParams, requestOptions())
    ).rejects.toThrow();
    await expect(
      connection.interrupt(stopParams, { ...requestOptions(), signal: AbortSignal.abort() })
    ).rejects.toThrow("interrupt_window_expired");
    await expect(
      connection.interrupt(stopParams, { ...requestOptions(), deadlineAt: "invalid" })
    ).rejects.toThrow("interrupt_window_expired");
    expect(connection.snapshot().interruptAttempted).toBe(false);
    expect(sent.filter((x) => x.method === "turn/interrupt")).toHaveLength(0);
  });

  it("distinguishes interrupt ACK and cleared questions from a terminal observation", async () => {
    connection = await OwnedCodexConnection.open(options);
    await connection.request("turn/start", params, requestOptions());
    expect(await connection.interrupt(stopParams, requestOptions())).toEqual({
      acknowledged: true,
      terminalStatus: null,
    });
    reply({
      method: "serverRequest/resolved",
      params: { threadId: "owned-thread", requestId: 10 },
    });
    const result = await connection.awaitTerminal("turn-1", {
      ...requestOptions(),
      deadlineAt: new Date(Date.now() + 15).toISOString(),
    });
    expect(result).toBeNull();
    expect(connection.snapshot()).toMatchObject({
      interruptAcknowledged: true,
      terminalTurnStatus: null,
      pendingTurnCaptures: 0,
    });
    await expect(connection.interrupt(stopParams, requestOptions())).rejects.toThrow(
      "interrupt_already_attempted"
    );
    expect(sent.filter((x) => x.method === "turn/interrupt")).toHaveLength(1);
    await expect(connection.request("turn/start", params, requestOptions())).rejects.toThrow(
      "dispatch_already_attempted"
    );
  });

  it("waits on matching events and retains interruption evidence until storage confirms", async () => {
    connection = await OwnedCodexConnection.open(options);
    await connection.request("turn/start", params, requestOptions());
    await connection.interrupt(stopParams, requestOptions());
    const wait = connection.awaitTerminal("turn-1", requestOptions());
    await expect(connection.awaitTerminal("turn-1", requestOptions())).rejects.toThrow(
      "terminal_wait_already_pending"
    );
    reply(terminal());
    expect(await wait).toEqual({ turnId: "turn-1", status: "interrupted" });
    await connection.close();
    const recordWorkerTurnEvidence = vi
      .fn()
      .mockRejectedValueOnce(new Error("storage response lost"))
      .mockResolvedValue({ recorded: true });
    const port = { recordWorkerTurnEvidence, getWorkerTurnEvidence: async () => null };
    const binding = { sessionId: "session", claimId: "claim", requestHash: "hash" };
    await expect(connection.persistNextTurnCapture(port, binding, "now")).rejects.toThrow(
      "storage response lost"
    );
    expect(connection.snapshot().pendingTurnCaptures).toBe(1);
    await connection.persistNextTurnCapture(port, binding, "later");
    expect(recordWorkerTurnEvidence.mock.calls[0][0]).toEqual(
      recordWorkerTurnEvidence.mock.calls[1][0]
    );
    expect(recordWorkerTurnEvidence.mock.calls[0][0].notificationJson).toBe(
      JSON.stringify(terminal())
    );
    expect(connection.snapshot().pendingTurnCaptures).toBe(0);
  });

  it("stops an observed turn before a delayed dispatch ACK without replaying dispatch", async () => {
    mode = "lost";
    connection = await OwnedCodexConnection.open(options);
    const dispatch = connection.request("turn/start", params, requestOptions());
    reply({ method: "turn/started", params: { threadId: "owned-thread", turn: { id: "turn-1" } } });
    expect(await connection.interrupt(stopParams, requestOptions())).toMatchObject({
      acknowledged: true,
    });
    reply(terminal());
    const start = sent.find((x) => x.method === "turn/start")!;
    reply({ id: start.id, result: { turn: { id: "turn-1" } } });
    await dispatch;
    expect(await connection.awaitTerminal("turn-1", requestOptions())).toEqual({
      turnId: "turn-1",
      status: "interrupted",
    });
    expect(sent.filter((x) => x.method === "turn/start")).toHaveLength(1);
    expect(sent.filter((x) => x.method === "turn/interrupt")).toHaveLength(1);
  });

  it("keeps completion racing with a stop distinct from interruption", async () => {
    connection = await OwnedCodexConnection.open(options);
    await connection.request("turn/start", params, requestOptions());
    const stop = connection.interrupt(stopParams, requestOptions());
    reply(terminal("completed"));
    expect(await stop).toEqual({ acknowledged: true, terminalStatus: "completed" });
    expect(await connection.awaitTerminal("turn-1", requestOptions())).toEqual({
      turnId: "turn-1",
      status: "completed",
    });
    expect(await connection.interrupt(stopParams, requestOptions())).toEqual({
      acknowledged: false,
      terminalStatus: "completed",
    });
    expect(sent.filter((x) => x.method === "turn/interrupt")).toHaveLength(1);
  });

  it("does not send an interrupt for a turn already observed as terminal", async () => {
    connection = await OwnedCodexConnection.open(options);
    await connection.request("turn/start", params, requestOptions());
    reply(terminal("failed"));
    expect(await connection.interrupt(stopParams, requestOptions())).toEqual({
      acknowledged: false,
      terminalStatus: "failed",
    });
    expect(sent.filter((x) => x.method === "turn/interrupt")).toHaveLength(0);
  });

  it("treats lost stop ACK as uncertain, rejects concurrent/replayed stop, and preserves observed evidence", async () => {
    connection = await OwnedCodexConnection.open(options);
    await connection.request("turn/start", params, requestOptions());
    mode = "lost-interrupt";
    const abort = new AbortController();
    const stop = connection.interrupt(stopParams, { ...requestOptions(), signal: abort.signal });
    const rejection = expect(stop).rejects.toThrow("request_aborted");
    await expect(connection.interrupt(stopParams, requestOptions())).rejects.toThrow(
      "interrupt_already_attempted"
    );
    reply(terminal());
    abort.abort();
    await rejection;
    await connection.close();
    expect(connection.snapshot()).toMatchObject({
      interruptAttempted: true,
      interruptAcknowledged: false,
      terminalTurnStatus: "interrupted",
      pendingTurnCaptures: 1,
    });
    await expect(connection.interrupt(stopParams, requestOptions())).rejects.toThrow();
    expect(sent.filter((x) => x.method === "turn/interrupt")).toHaveLength(1);
  });

  it("rejects malformed stop acknowledgements", async () => {
    connection = await OwnedCodexConnection.open(options);
    await connection.request("turn/start", params, requestOptions());
    mode = "bad-interrupt";
    await expect(connection.interrupt(stopParams, requestOptions())).rejects.toThrow(
      "invalid_interrupt_acknowledgement"
    );
    expect(connection.snapshot().interruptAcknowledged).toBe(false);
  });

  it.each(["turn/started", "turn/completed"])(
    "rejects %s from another turn and leaves stop unproven",
    async (method) => {
      connection = await OwnedCodexConnection.open(options);
      await connection.request("turn/start", params, requestOptions());
      const wait = connection.awaitTerminal("turn-1", requestOptions());
      const rejection = expect(wait).rejects.toThrow("turn_mismatch");
      reply({ ...terminal("interrupted", "other"), method });
      await rejection;
      expect(connection.snapshot()).toMatchObject({
        failure: "turn_mismatch",
        pendingTurnCaptures: 0,
        terminalTurnStatus: null,
      });
    }
  );

  it("rejects a dispatch ACK conflicting with an earlier observed turn", async () => {
    mode = "lost";
    connection = await OwnedCodexConnection.open(options);
    const dispatch = connection.request("turn/start", params, requestOptions());
    const rejection = expect(dispatch).rejects.toThrow("turn_mismatch");
    reply({ method: "turn/started", params: { threadId: "owned-thread", turn: { id: "turn-1" } } });
    reply({
      id: sent.find((x) => x.method === "turn/start")!.id,
      result: { turn: { id: "other" } },
    });
    await rejection;
  });

  it("rejects a malformed dispatch ACK without inventing a stoppable turn", async () => {
    mode = "bad-start";
    connection = await OwnedCodexConnection.open(options);
    await expect(connection.request("turn/start", params, requestOptions())).rejects.toThrow(
      "invalid_turn_acknowledgement"
    );
    expect(connection.snapshot()).toMatchObject({
      failure: "invalid_turn_acknowledgement",
      ownedTurnId: null,
      interruptAttempted: false,
    });
  });

  it("retains the earlier terminal evidence when the provider contradicts its status", async () => {
    connection = await OwnedCodexConnection.open(options);
    await connection.request("turn/start", params, requestOptions());
    reply(terminal("completed"));
    reply(terminal("interrupted"));
    expect(connection.snapshot()).toMatchObject({
      failure: "terminal_status_conflict",
      terminalTurnStatus: "completed",
      pendingTurnCaptures: 1,
    });
    await expect(connection.awaitTerminal("turn-1", requestOptions())).rejects.toThrow(
      "terminal_status_conflict"
    );
  });

  it("rejects a new live wait after close while retaining earlier raw evidence", async () => {
    connection = await OwnedCodexConnection.open(options);
    await connection.request("turn/start", params, requestOptions());
    reply(terminal());
    await connection.close();
    await expect(connection.awaitTerminal("turn-1", requestOptions())).rejects.toThrow(
      "connection_closed"
    );
    expect(connection.snapshot()).toMatchObject({
      terminalTurnStatus: "interrupted",
      pendingTurnCaptures: 1,
    });
  });

  it("rejects a pending live wait when the same read contradicts the terminal event", async () => {
    connection = await OwnedCodexConnection.open(options);
    await connection.request("turn/start", params, requestOptions());
    const wait = connection.awaitTerminal("turn-1", requestOptions());
    const rejection = expect(wait).rejects.toThrow("terminal_status_conflict");
    child.stdout.write(
      [terminal("completed"), terminal("interrupted")]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n"
    );
    await rejection;
    expect(connection.snapshot()).toMatchObject({
      failure: "terminal_status_conflict",
      terminalTurnStatus: "completed",
      pendingTurnCaptures: 1,
    });
  });

  it.each(["turn/start", "turn/interrupt"])(
    "rejects a %s ACK followed by a conflicting report in the same read",
    async (method) => {
      connection = await OwnedCodexConnection.open(options);
      let pending: Promise<unknown>;
      if (method === "turn/start") {
        mode = "lost";
        pending = connection.request("turn/start", params, requestOptions());
      } else {
        await connection.request("turn/start", params, requestOptions());
        mode = "lost-interrupt";
        pending = connection.interrupt(stopParams, requestOptions());
      }
      const rejection = expect(pending).rejects.toThrow("terminal_status_conflict");
      const rpc = sent.find((x) => x.method === method)!;
      child.stdout.write(
        [
          terminal("completed"),
          { id: rpc.id, result: method === "turn/start" ? { turn: { id: "turn-1" } } : {} },
          terminal("interrupted"),
        ]
          .map((event) => JSON.stringify(event))
          .join("\n") + "\n"
      );
      await rejection;
      expect(connection.snapshot()).toMatchObject({
        failure: "terminal_status_conflict",
        terminalTurnStatus: "completed",
        pendingTurnCaptures: 1,
      });
    }
  );

  it("keeps the originally supplied wait signal when the caller mutates its options", async () => {
    connection = await OwnedCodexConnection.open(options);
    await connection.request("turn/start", params, requestOptions());
    const abort = new AbortController();
    const waitOptions = { ...requestOptions(), signal: abort.signal };
    const wait = connection.awaitTerminal("turn-1", waitOptions);
    const rejection = expect(wait).rejects.toThrow("terminal_wait_aborted");
    waitOptions.signal = new AbortController().signal;
    abort.abort();
    await rejection;
    const next = connection.awaitTerminal("turn-1", requestOptions());
    reply(terminal());
    expect(await next).toMatchObject({ status: "interrupted" });
  });

  it("bounds a long terminal wait at thirty seconds without stopping or dispatching again", async () => {
    connection = await OwnedCodexConnection.open(options);
    await connection.request("turn/start", params, requestOptions());
    vi.useFakeTimers();
    try {
      const wait = connection.awaitTerminal("turn-1", {
        ...requestOptions(),
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await wait).toBeNull();
      expect(sent.filter((x) => x.method === "turn/interrupt")).toHaveLength(0);
      expect(sent.filter((x) => x.method === "turn/start")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows waiting again after timeout/abort without any new dispatch or interrupt", async () => {
    connection = await OwnedCodexConnection.open(options);
    await connection.request("turn/start", params, requestOptions());
    const abort = new AbortController();
    const wait = connection.awaitTerminal("turn-1", { ...requestOptions(), signal: abort.signal });
    const rejection = expect(wait).rejects.toThrow("terminal_wait_aborted");
    abort.abort();
    await rejection;
    const again = connection.awaitTerminal("turn-1", requestOptions());
    reply(terminal());
    expect(await again).toMatchObject({ status: "interrupted" });
    expect(sent.filter((x) => x.method === "turn/start")).toHaveLength(1);
    expect(sent.filter((x) => x.method === "turn/interrupt")).toHaveLength(0);
  });

  it("rejects a terminal wait on connection close without claiming a stop", async () => {
    connection = await OwnedCodexConnection.open(options);
    await connection.request("turn/start", params, requestOptions());
    const wait = connection.awaitTerminal("turn-1", requestOptions());
    const rejection = expect(wait).rejects.toThrow("connection_closed");
    await connection.close();
    await rejection;
    expect(connection.snapshot().terminalTurnStatus).toBeNull();
  });

  it("requests the supported receipt schema and retries only final-message persistence after response loss", async () => {
    connection = await OwnedCodexConnection.open(options);
    await connection.request(
      "turn/start",
      { ...params, outputSchema: CodexReceiptOutputSchema },
      requestOptions()
    );
    const event = {
      method: "item/completed",
      emittedAtMs: 1791335791251,
      params: {
        threadId: "owned-thread",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "item-1",
          phase: "final_answer",
          text: '{"receipt":"fixture"}',
        },
      },
    };
    reply({
      ...event,
      params: { ...event.params, item: { ...event.params.item, phase: "commentary" } },
    });
    reply(event);
    expect(connection.snapshot().pendingReceiptCaptures).toBe(1);
    await connection.close();
    const recordWorkerReceiptEvidence = vi.fn(
      async (capture: WorkerReceiptCapture, recordedAt: string) => ({
        recorded: true as const,
        replay: true,
        record: {
          ...capture,
          recordedAt,
          sourceHash: "fixture",
          recordHash: "fixture",
          attemptId: "fixture",
          runId: "fixture",
          packetHash: "fixture",
          envelopeHash: "fixture",
        },
      })
    );
    recordWorkerReceiptEvidence.mockRejectedValueOnce(new Error("lost persist response"));
    const store = {
      recordWorkerReceiptEvidence,
      getWorkerReceiptSnapshot: vi.fn(async () => null),
    };
    const binding = { sessionId: "s", claimId: "c", requestHash: "h" };
    await expect(connection.persistNextReceiptCapture(store, binding, "now")).rejects.toThrow(
      "lost persist response"
    );
    expect(connection.snapshot().pendingReceiptCaptures).toBe(1);
    expect(await connection.persistNextReceiptCapture(store, binding, "later")).toMatchObject({
      recorded: true,
    });
    const [first] = recordWorkerReceiptEvidence.mock.calls[0];
    const [second] = recordWorkerReceiptEvidence.mock.calls[1];
    expect(second).toEqual(first);
    expect(first.notificationJson).toBe(JSON.stringify(event));
    expect(first.workerId).toBe("owned-thread");
    expect(connection.snapshot().pendingReceiptCaptures).toBe(0);
    expect(sent.filter((x) => x.method === "turn/start")).toHaveLength(1);
  });
  it("rejects caller-selected schema overrides before dispatch", async () => {
    connection = await OwnedCodexConnection.open(options);
    await expect(
      connection.request(
        "turn/start",
        { ...params, outputSchema: { type: "string" } },
        requestOptions()
      )
    ).rejects.toThrow();
    expect(sent.filter((x) => x.method === "turn/start")).toHaveLength(0);
  });
  it("retains bounded final messages and fails explicitly on receipt capture overflow", async () => {
    connection = await OwnedCodexConnection.open(options);
    await connection.request("turn/start", params, requestOptions());
    for (let i = 0; i < 129; i++)
      reply({
        method: "item/completed",
        params: {
          threadId: "owned-thread",
          turnId: "turn-1",
          item: { type: "agentMessage", id: `item-${i}`, phase: "final_answer", text: "{}" },
        },
      });
    expect(connection.snapshot()).toMatchObject({
      pendingReceiptCaptures: 128,
      failure: "receipt_capture_limit",
    });
  });
  it("retains terminal evidence before acknowledgment and retries only persistence after loss", async () => {
    const store = new InMemoryWorkerObservationStore();
    try {
      const controller = await createAttachedWorker(store);
      providerThreadId = "native-session-1";
      connection = await OwnedCodexConnection.open(options);
      const binding = {
        sessionId: "worker-session-1",
        claimId: "capture-claim",
        requestHash: "sha256:" + "b".repeat(64),
      };
      await store.claimWorkerDispatch({
        ...binding,
        controller,
        runId: "run-1",
        expectedRunRevision: 0,
        attemptId: "attempt-1",
        expectedAttemptRevision: 3,
        workspaceLeaseId: "workspace-lease-1",
        expectedWorkspaceLeaseRevision: 0,
        expectedSessionRevision: 0,
        packetHash: taskPacket().packet_hash,
        now: "2026-08-12T12:00:04.000Z",
      });
      const realPersist = store.recordWorkerTurnEvidence.bind(store);
      let lost = true;
      const port = {
        getWorkerTurnEvidence: store.getWorkerTurnEvidence.bind(store),
        recordWorkerTurnEvidence: vi.fn(async (input, now) => {
          const result = await realPersist(input, now);
          if (lost) {
            lost = false;
            throw new Error("lost persistence response");
          }
          return result;
        }),
      };
      mode = "lost";
      const abort = new AbortController();
      const send = connection.request(
        "turn/start",
        { ...params, threadId: providerThreadId },
        {
          ...requestOptions(),
          signal: abort.signal,
        }
      );
      const sendFailure = expect(send).rejects.toThrow("request_aborted");
      reply({
        method: "turn/completed",
        params: {
          threadId: providerThreadId,
          turn: { id: "turn-early", status: "completed", items: [{ text: "birds" }] },
        },
      });
      expect(connection.snapshot().pendingTurnCaptures).toBe(1);
      abort.abort();
      await sendFailure;
      await connection.close();
      await expect(
        connection.persistNextTurnCapture(port, binding, new Date().toISOString())
      ).rejects.toThrow("lost persistence response");
      expect(connection.snapshot().pendingTurnCaptures).toBe(1);
      expect(
        await connection.persistNextTurnCapture(port, binding, new Date().toISOString())
      ).toMatchObject({ recorded: true, replay: true });
      expect(connection.snapshot().pendingTurnCaptures).toBe(0);
      expect(await store.listWorkerObservations(binding.sessionId)).toHaveLength(1);
      const records = await store.listWorkerObservations(binding.sessionId);
      expect(
        await store.getWorkerTurnEvidence(binding.sessionId, records[0].observationId)
      ).toContain('"text":"birds"');
      expect(sent.filter((x) => x.method === "turn/start")).toHaveLength(1);
    } finally {
      await store.close();
    }
  });
  it("rejects terminal events from another thread and premature completion", async () => {
    connection = await OwnedCodexConnection.open(options);
    reply({
      method: "turn/completed",
      params: { threadId: "other", turn: { id: "turn-1", status: "completed" } },
    });
    expect(connection.snapshot().failure).toBe("unexpected_execution");
    expect(connection.snapshot().pendingTurnCaptures).toBe(0);
  });
  it("rejects a different thread after dispatch without enqueuing its evidence", async () => {
    connection = await OwnedCodexConnection.open(options);
    await connection.request("turn/start", params, requestOptions());
    reply({
      method: "turn/completed",
      params: { threadId: "other", turn: { id: "turn", status: "completed" } },
    });
    expect(connection.snapshot().failure).toBe("thread_mismatch");
    expect(connection.snapshot().pendingTurnCaptures).toBe(0);
  });
  it("serializes capture persistence and retains an event when storage rejects it", async () => {
    connection = await OwnedCodexConnection.open(options);
    await connection.request("turn/start", params, requestOptions());
    reply({
      method: "turn/completed",
      params: { threadId: "owned-thread", turn: { id: "turn-1", status: "failed" } },
    });
    let finish!: (value: { recorded: false; reason: "evidence_limit" }) => void;
    const port = {
      getWorkerTurnEvidence: async () => null,
      recordWorkerTurnEvidence: vi.fn(
        () =>
          new Promise<{ recorded: false; reason: "evidence_limit" }>((resolve) => {
            finish = resolve;
          })
      ),
    };
    const binding = {
      sessionId: "session",
      claimId: "claim",
      requestHash: "sha256:" + "b".repeat(64),
    };
    const pending = connection.persistNextTurnCapture(port, binding, new Date().toISOString());
    await expect(
      connection.persistNextTurnCapture(port, binding, new Date().toISOString())
    ).rejects.toThrow("capture_in_progress");
    finish({ recorded: false, reason: "evidence_limit" });
    expect(await pending).toEqual({ recorded: false, reason: "evidence_limit" });
    expect(connection.snapshot().pendingTurnCaptures).toBe(1);
    expect(port.recordWorkerTurnEvidence).toHaveBeenCalledOnce();
  });
  it("bounds queued bytes independently of event count", async () => {
    connection = await OwnedCodexConnection.open(options);
    await connection.request("turn/start", params, requestOptions());
    for (let i = 0; i < 3; i++)
      reply({
        method: "turn/completed",
        params: {
          threadId: "owned-thread",
          turn: { id: "turn-1", status: "completed", items: [{ text: "x".repeat(900000) }] },
        },
      });
    expect(connection.snapshot().failure).toBe("turn_capture_limit");
    expect(connection.snapshot().pendingTurnCaptures).toBe(2);
  });
  it("fails explicitly on capture overflow while preserving previously queued evidence", async () => {
    connection = await OwnedCodexConnection.open(options);
    await connection.request("turn/start", params, requestOptions());
    for (let i = 0; i < 129; i++)
      reply({
        method: "turn/completed",
        params: { threadId: "owned-thread", turn: { id: "turn-1", status: "completed" } },
      });
    expect(connection.snapshot().failure).toBe("turn_capture_limit");
    expect(connection.snapshot().pendingTurnCaptures).toBe(128);
  });
  it("rejects invalid UTF-8 rather than changing retained evidence bytes", async () => {
    connection = await OwnedCodexConnection.open(options);
    child.stdout.write(Buffer.from([0xff]));
    expect(connection.snapshot().failure).toBe("invalid_utf8");
  });
  it.each([
    [Buffer.from([0xf0, 0x9f]), "invalid_utf8", "end"],
    [Buffer.from('{"method":"turn/completed","params":'), "incomplete_frame", "end"],
    [Buffer.from([0xf0, 0x9f]), "invalid_utf8", "close"],
    [Buffer.from('{"method":"turn/completed","params":'), "incomplete_frame", "close"],
  ])(
    "reports truncated stdout %j as %s on %s without discarding earlier evidence",
    async (tail, reason, boundary) => {
      connection = await OwnedCodexConnection.open(options);
      await connection.request("turn/start", params, requestOptions());
      reply({
        method: "turn/completed",
        params: { threadId: "owned-thread", turn: { id: "turn-1", status: "completed" } },
      });
      child.stdout.write(tail);
      if (boundary === "end") {
        child.stdout.end();
        await new Promise<void>((resolve) => setImmediate(resolve));
      } else child.emit("close", 0, null);
      expect(connection.snapshot().failure).toBe(reason);
      expect(connection.snapshot().pendingTurnCaptures).toBe(1);
      expect(await connection.close()).toMatchObject({
        processExited: true,
        execution: "may_have_started",
      });
      expect(connection.snapshot().failure).toBe(reason);
    }
  );
  it("launches fixed argv, binds an idle session, and closes only its child", async () => {
    connection = await OwnedCodexConnection.open(options);
    expect(spawn).toHaveBeenCalledWith(
      options.executable,
      ["app-server", "--stdio"],
      expect.objectContaining({ shell: false, windowsHide: true, cwd: options.cwd })
    );
    const launch = vi.mocked(spawn).mock.calls[0][2]!;
    expect(launch.env?.CODEX_HOME).toBe(options.codexHome);
    expect(launch.env?.NODE_OPTIONS).toBeUndefined();
    expect(connection.session.threadId).toBe("owned-thread");
    expect(connection.snapshot().methods).toEqual(["initialize", "thread/start"]);
    expect(await connection.close()).toMatchObject({
      processExited: true,
      forced: false,
      execution: "not_dispatched",
    });
  });
  it("rejects changed settings and cleans up bootstrap", async () => {
    mode = "bad-settings";
    await expect(OwnedCodexConnection.open(options)).rejects.toThrow("bootstrap_rejected");
    expect(sent.some((x) => x.method === "turn/start")).toBe(false);
  });
  it("rejects a different thread and settings overrides before writing", async () => {
    connection = await OwnedCodexConnection.open(options);
    await expect(
      connection.request("turn/start", { ...params, threadId: "other" }, requestOptions())
    ).rejects.toThrow("thread_mismatch");
    await expect(
      connection.request(
        "turn/start",
        { ...params, model: "other" } as typeof params,
        requestOptions()
      )
    ).rejects.toThrow();
    expect(connection.snapshot().turnAttempted).toBe(false);
  });
  it("rejects expired and pre-aborted dispatch without spending the send", async () => {
    connection = await OwnedCodexConnection.open(options);
    await expect(
      connection.request("turn/start", params, { ...requestOptions(), deadlineAt: "invalid" })
    ).rejects.toThrow("dispatch_window_expired");
    await expect(
      connection.request("turn/start", params, { ...requestOptions(), signal: AbortSignal.abort() })
    ).rejects.toThrow("dispatch_window_expired");
    expect(connection.snapshot().turnAttempted).toBe(false);
  });
  it("sends at most once and retains possible execution at close", async () => {
    connection = await OwnedCodexConnection.open(options);
    await expect(connection.request("turn/start", params, requestOptions())).resolves.toEqual({
      turn: { id: "turn-1" },
    });
    await expect(connection.request("turn/start", params, requestOptions())).rejects.toThrow(
      "dispatch_already_attempted"
    );
    expect(sent.filter((x) => x.method === "turn/start")).toHaveLength(1);
    expect(await connection.close()).toMatchObject({ execution: "may_have_started" });
  });
  it("treats lost acknowledgment as uncertain and never replays", async () => {
    mode = "lost";
    connection = await OwnedCodexConnection.open(options);
    const abort = new AbortController();
    const result = connection.request("turn/start", params, {
      ...requestOptions(),
      signal: abort.signal,
    });
    abort.abort();
    await expect(result).rejects.toThrow("request_aborted");
    await expect(connection.request("turn/start", params, requestOptions())).rejects.toThrow();
    expect(sent.filter((x) => x.method === "turn/start")).toHaveLength(1);
    expect(await connection.close()).toMatchObject({
      execution: "may_have_started",
      processExited: true,
    });
  });
  it.each([
    [{ id: 99, result: {} }, "response_mismatch"],
    [{ id: 3, method: "approval/request", params: {} }, "server_request_unsupported"],
    [{ method: "turn/started", params: {} }, "unexpected_execution"],
    [{ method: "thread/started", params: { thread: { id: "other" } } }, "thread_mismatch"],
  ])("fails closed on protocol violation %j", async (message, reason) => {
    connection = await OwnedCodexConnection.open(options);
    reply(message);
    expect(connection.snapshot().failure).toBe(reason);
    expect(child.kill).toHaveBeenCalledOnce();
  });
  it("decodes fragmented UTF-8 and safely counts prototype-like notification names", async () => {
    connection = await OwnedCodexConnection.open(options);
    const bytes = Buffer.from(JSON.stringify({ method: "__proto__", params: "🐦" }) + "\n");
    for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
    expect(connection.snapshot().notifications["__proto__"]).toBe(1);
    expect(connection.snapshot().failure).toBeNull();
  });
  it("bounds malformed output and never retains provider stderr", async () => {
    connection = await OwnedCodexConnection.open(options);
    child.stderr.write("private provider diagnostic");
    child.stdout.write("garbage\n");
    expect(connection.snapshot().failure).toBe("invalid_json");
    expect(JSON.stringify(connection.snapshot())).not.toContain("private provider");
  });
  it("times out a lost response without replay", async () => {
    mode = "lost";
    connection = await OwnedCodexConnection.open(options);
    await expect(
      connection.request("turn/start", params, {
        ...requestOptions(),
        deadlineAt: new Date(Date.now() + 20).toISOString(),
      })
    ).rejects.toThrow("request_timeout");
    expect(sent.filter((x) => x.method === "turn/start")).toHaveLength(1);
    expect(await connection.close()).toMatchObject({
      processExited: true,
      execution: "may_have_started",
    });
  });
  it("reports uncertainty if its child cannot be stopped", async () => {
    connection = await OwnedCodexConnection.open(options);
    vi.spyOn(child.stdin, "end").mockReturnValue(child.stdin);
    child.kill.mockImplementation(() => false);
    vi.useFakeTimers();
    try {
      const closing = connection.close();
      await vi.advanceTimersByTimeAsync(6000);
      expect(await closing).toMatchObject({
        processExited: false,
        forced: true,
        execution: "not_dispatched",
      });
      await expect(connection.request("turn/start", params, requestOptions())).rejects.toThrow(
        "connection_closed"
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
