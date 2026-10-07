import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import {
  FinalAgentMessage,
  type WorkerReceiptEvidenceStore,
} from "../store/worker-receipt-evidence.js";
import { CodexReceiptOutputSchema } from "./codex-receipt-contract.js";
import { computeCanonicalHash } from "../schemas/task-contract.js";
import { TextDecoder } from "node:util";
import {
  TerminalTurnNotification,
  type WorkerTurnEvidenceStore,
  type WorkerTurnCaptureResult,
} from "../store/worker-turn-evidence.js";
import { z } from "zod";
import type { AttachedCodexTransport, CodexTurnStartParams } from "./codex-worker-dispatch.js";

const text = z.string().min(1).max(16384);
const absolute = text.refine(isAbsolute, "Native absolute path required");
const Options = z
  .object({
    executable: absolute,
    cwd: absolute,
    codexHome: absolute,
    adapterId: text,
    adapterVersion: text,
    model: text.optional(),
  })
  .strict();
export type OwnedCodexConnectionOptions = z.infer<typeof Options>;
const TurnParams = z
  .object({
    threadId: text,
    input: z.array(z.object({ type: z.literal("text"), text: z.string() }).strict()).length(1),
    outputSchema: z
      .unknown()
      .optional()
      .refine(
        (value) =>
          value === undefined ||
          computeCanonicalHash(value) === computeCanonicalHash(CodexReceiptOutputSchema),
        "Unsupported receipt schema"
      ),
  })
  .strict();
const Started = z.object({
  thread: z.object({
    id: text,
    ephemeral: z.literal(true),
    status: z.object({ type: z.literal("idle") }),
    turns: z.array(z.unknown()).length(0),
  }),
  cwd: absolute,
  approvalPolicy: z.literal("never"),
  sandbox: z.object({ type: z.literal("readOnly") }),
  model: text,
  modelProvider: text,
});
const MAX_FRAME = 1024 * 1024;
const MAX_TOTAL = 8 * MAX_FRAME;
const TurnIdentity = z.object({ id: text });
const InterruptParams = z.object({ threadId: text, turnId: text }).strict();
type TerminalStatus = "completed" | "failed" | "interrupted";
type RequestWindow = { signal: AbortSignal; deadlineAt: string };
export interface OwnedCodexTerminalObservation {
  turnId: string;
  status: TerminalStatus;
}
type Pending = { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void };
export interface CodexConnectionCloseResult {
  processExited: boolean;
  forced: boolean;
  exitCode: number | null;
  signal: string | null;
  execution: "not_dispatched" | "may_have_started";
}

/** Owns one stdio child and one ephemeral read-only session. Not a qualified host profile. */
export class OwnedCodexConnection implements AttachedCodexTransport {
  readonly adapterId: string;
  readonly adapterVersion: string;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  private readonly captureId = randomUUID();
  private captureSequence = 0;
  private captureBytes = 0;
  private captureBusy = false;
  private outputFinalized = false;
  private readonly capturedTurns: Array<{
    observationId: string;
    observedAt: string;
    notificationJson: string;
  }> = [];
  private readonly capturedReceipts: typeof this.capturedTurns = [];
  private receiptCaptureBytes = 0;
  private receiptCaptureBusy = false;
  private readonly exited: Promise<void>;
  private closing?: Promise<CodexConnectionCloseResult>;
  private sequence = 0;
  private buffer = "";
  private failure?: string;
  private processExited = false;
  private exitCode: number | null = null;
  private signal: string | null = null;
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private turnAttempted = false;
  private ownedTurnId?: string;
  private terminalTurnStatus?: TerminalStatus;
  private interruptAttempted = false;
  private interruptAcknowledged = false;
  private terminalWaiter?: {
    resolve(value: OwnedCodexTerminalObservation | null): void;
    reject(error: Error): void;
    cleanup(): void;
  };
  private startedNotificationId?: string;
  private readonly methods: string[] = [];
  private readonly notifications: Record<string, number> = Object.create(null);
  private settings?: { threadId: string; cwd: string; model: string; modelProvider: string };

  private constructor(private readonly options: OwnedCodexConnectionOptions) {
    this.adapterId = options.adapterId;
    this.adapterVersion = options.adapterVersion;
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        [
          "PATH",
          "SYSTEMROOT",
          "WINDIR",
          "TEMP",
          "TMP",
          "COMSPEC",
          "USERPROFILE",
          "APPDATA",
          "LOCALAPPDATA",
          "HOME",
        ].includes(key.toUpperCase())
      )
    );
    environment.CODEX_HOME = options.codexHome;
    this.child = spawn(options.executable, ["app-server", "--stdio"], {
      cwd: options.cwd,
      env: environment,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise((resolve) =>
      this.child.once("close", (code, signal) => {
        this.processExited = true;
        this.finalizeOutput();
        this.exitCode = code;
        this.signal = signal;
        this.rejectPending("connection_closed");
        resolve();
      })
    );
    this.child.on("error", () => this.fail("process_error"));
    this.child.stdin.on("error", () => this.fail("stdin_error"));
    this.child.stdout.on("error", () => this.fail("stdout_error"));
    this.child.stderr.on("error", () => this.fail("stderr_error"));
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.stdout.on("end", () => this.finalizeOutput());
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > MAX_TOTAL) this.fail("stderr_limit");
    });
  }

  static async open(input: OwnedCodexConnectionOptions): Promise<OwnedCodexConnection> {
    const options = Options.parse(input);
    const connection = new OwnedCodexConnection(options);
    try {
      await connection.rpc("initialize", {
        clientInfo: { name: "lexrunner_owned_connection", version: "1.0.0" },
      });
      connection.write({ method: "initialized", params: {} });
      const response = Started.parse(
        await connection.rpc("thread/start", {
          cwd: options.cwd,
          ephemeral: true,
          approvalPolicy: "never",
          sandbox: "read-only",
          ...(options.model ? { model: options.model } : {}),
        })
      );
      if (
        normalize(response.cwd) !== normalize(options.cwd) ||
        (options.model && response.model !== options.model) ||
        (connection.startedNotificationId &&
          connection.startedNotificationId !== response.thread.id)
      ) {
        throw new Error("settings_mismatch");
      }
      connection.settings = {
        threadId: response.thread.id,
        cwd: response.cwd,
        model: response.model,
        modelProvider: response.modelProvider,
      };
      connection.requireOpen();
      return connection;
    } catch {
      connection.failure ??= "bootstrap_rejected";
      const closed = await connection.close();
      throw new Error(closed.processExited ? connection.failure : "bootstrap_cleanup_uncertain");
    }
  }

  get session() {
    if (!this.settings) throw new Error("session_not_initialized");
    return {
      ...this.settings,
      approvalPolicy: "never" as const,
      sandbox: "readOnly" as const,
      ephemeral: true as const,
    };
  }
  snapshot() {
    return {
      pid: this.child.pid ?? null,
      processExited: this.processExited,
      failure: this.failure ?? null,
      turnAttempted: this.turnAttempted,
      ownedTurnId: this.ownedTurnId ?? null,
      terminalTurnStatus: this.terminalTurnStatus ?? null,
      interruptAttempted: this.interruptAttempted,
      interruptAcknowledged: this.interruptAcknowledged,
      stdoutBytes: this.stdoutBytes,
      stderrBytes: this.stderrBytes,
      methods: [...this.methods],
      notifications: { ...this.notifications },
      pendingTurnCaptures: this.capturedTurns.length,
      pendingTurnCaptureBytes: this.captureBytes,
      pendingReceiptCaptures: this.capturedReceipts.length,
      pendingReceiptCaptureBytes: this.receiptCaptureBytes,
    };
  }

  /** Retain the source event before removing it from the volatile queue. No lifecycle effects. */
  async persistNextReceiptCapture(
    store: WorkerReceiptEvidenceStore,
    binding: { sessionId: string; claimId: string; requestHash: string },
    recordedAt: string
  ) {
    if (this.receiptCaptureBusy) throw new Error("capture_in_progress");
    const next = this.capturedReceipts[0];
    if (!next) return null;
    this.receiptCaptureBusy = true;
    try {
      const result = await store.recordWorkerReceiptEvidence(
        { ...binding, ...next, observerId: this.captureId, workerId: this.session.threadId },
        recordedAt
      );
      if (result.recorded) {
        this.capturedReceipts.shift();
        this.receiptCaptureBytes -= Buffer.byteLength(next.notificationJson, "utf8");
      }
      return result;
    } finally {
      this.receiptCaptureBusy = false;
    }
  }

  /** Store transaction precedes queue removal. May run after child exit; grants no execution. */
  async persistNextTurnCapture(
    store: WorkerTurnEvidenceStore,
    binding: { sessionId: string; claimId: string; requestHash: string },
    recordedAt: string
  ): Promise<WorkerTurnCaptureResult | null> {
    if (this.captureBusy) throw new Error("capture_in_progress");
    const next = this.capturedTurns[0];
    if (!next) return null;
    this.captureBusy = true;
    try {
      const result = await store.recordWorkerTurnEvidence(
        { ...binding, ...next, observerId: this.captureId, workerId: this.session.threadId },
        recordedAt
      );
      if (result.recorded) {
        this.capturedTurns.shift();
        this.captureBytes -= Buffer.byteLength(next.notificationJson, "utf8");
      }
      return result;
    } finally {
      this.captureBusy = false;
    }
  }

  async request(
    method: "turn/start",
    params: CodexTurnStartParams,
    options: RequestWindow
  ): Promise<unknown> {
    this.requireOpen();
    if (method !== "turn/start") throw new Error("method_not_permitted");
    const parsed = TurnParams.parse(params);
    if (!this.settings || parsed.threadId !== this.settings.threadId)
      throw new Error("thread_mismatch");
    if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > 256 * 1024)
      throw new Error("request_limit");
    const remaining = Date.parse(options.deadlineAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0 || options.signal.aborted)
      throw new Error("dispatch_window_expired");
    if (this.turnAttempted) throw new Error("dispatch_already_attempted");
    this.turnAttempted = true;
    const response = await this.rpc(method, parsed, Math.min(remaining, 30_000), options.signal);
    const ack = z.object({ turn: TurnIdentity }).safeParse(response);
    if (!ack.success) {
      this.fail("invalid_turn_acknowledgement");
      throw new Error("invalid_turn_acknowledgement");
    }
    if (!this.bindTurn(ack.data.turn.id)) throw new Error("turn_mismatch");
    return response;
  }

  /** One explicit stop request for the observed owned turn. An ACK is not a stopped worker. */
  async interrupt(input: { threadId: string; turnId: string }, options: RequestWindow) {
    this.requireOpen();
    const params = InterruptParams.parse(input);
    if (params.threadId !== this.session.threadId) throw new Error("thread_mismatch");
    if (!this.ownedTurnId) throw new Error("turn_not_observed");
    if (params.turnId !== this.ownedTurnId) throw new Error("turn_mismatch");
    const remaining = Date.parse(options.deadlineAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0 || options.signal.aborted)
      throw new Error("interrupt_window_expired");
    if (this.terminalTurnStatus)
      return { acknowledged: false, terminalStatus: this.terminalTurnStatus };
    if (this.interruptAttempted) throw new Error("interrupt_already_attempted");
    this.interruptAttempted = true;
    // A turn/started notification can arrive before the turn/start response. Stop
    // that exact observed turn even while its dispatch acknowledgement is pending.
    const response = await this.rpc(
      "turn/interrupt",
      params,
      Math.min(remaining, 30_000),
      options.signal,
      true
    );
    if (!z.object({}).strict().safeParse(response).success) {
      this.fail("invalid_interrupt_acknowledgement");
      throw new Error("invalid_interrupt_acknowledgement");
    }
    this.interruptAcknowledged = true;
    return { acknowledged: true, terminalStatus: this.terminalTurnStatus ?? null };
  }

  /** Event-driven bounded wait. Timeout returns null; neither timeout nor close proves a stop. */
  async awaitTerminal(
    turnId: string,
    options: RequestWindow
  ): Promise<OwnedCodexTerminalObservation | null> {
    const { signal, deadlineAt } = options;
    if (!this.ownedTurnId) throw new Error("turn_not_observed");
    if (turnId !== this.ownedTurnId) throw new Error("turn_mismatch");
    const remaining = Date.parse(deadlineAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0 || signal.aborted)
      throw new Error("terminal_window_expired");
    if (this.terminalTurnStatus) return { turnId, status: this.terminalTurnStatus };
    this.requireOpen();
    if (this.terminalWaiter) throw new Error("terminal_wait_already_pending");
    return new Promise((resolve, reject) => {
      const finish = (value: OwnedCodexTerminalObservation | null) => {
        this.terminalWaiter?.cleanup();
        this.terminalWaiter = undefined;
        resolve(value);
      };
      const aborted = () => {
        this.terminalWaiter?.cleanup();
        this.terminalWaiter = undefined;
        reject(new Error("terminal_wait_aborted"));
      };
      const timer = setTimeout(() => finish(null), Math.min(remaining, 30_000));
      this.terminalWaiter = {
        resolve: finish,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", aborted);
        },
      };
      signal.addEventListener("abort", aborted, { once: true });
    });
  }

  private bindTurn(turnId: string): boolean {
    if (!text.safeParse(turnId).success) {
      this.fail("invalid_turn_identity");
      return false;
    }
    if (this.ownedTurnId && this.ownedTurnId !== turnId) {
      this.fail("turn_mismatch");
      return false;
    }
    this.ownedTurnId = turnId;
    return true;
  }

  close(): Promise<CodexConnectionCloseResult> {
    this.closing ??= this.stop();
    return this.closing;
  }
  private async stop(): Promise<CodexConnectionCloseResult> {
    this.rejectPending("connection_closed");
    if (!this.processExited) this.child.stdin.end();
    let forced = false;
    if (!(await this.waitForExit(3000))) {
      forced = true;
      this.child.kill("SIGKILL");
      await this.waitForExit(3000);
    }
    return {
      processExited: this.processExited,
      forced,
      exitCode: this.exitCode,
      signal: this.signal,
      execution: this.turnAttempted ? "may_have_started" : "not_dispatched",
    };
  }
  private async waitForExit(ms: number): Promise<boolean> {
    if (this.processExited) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.exited.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private requireOpen() {
    if (this.failure || this.processExited || this.closing)
      throw new Error(this.failure ?? "connection_closed");
  }
  private write(message: unknown) {
    this.requireOpen();
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  private rpc(
    method: string,
    params: unknown,
    timeoutMs = 15_000,
    signal?: AbortSignal,
    allowConcurrent = false
  ): Promise<unknown> {
    this.requireOpen();
    if (this.pending.size && (!allowConcurrent || this.pending.size >= 2))
      return Promise.reject(new Error("request_already_pending"));
    if (signal?.aborted) return Promise.reject(new Error("request_aborted"));
    const id = ++this.sequence;
    this.methods.push(method);
    return new Promise((resolve, reject) => {
      const aborted = () => this.fail("request_aborted");
      const timer = setTimeout(() => this.fail("request_timeout"), timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
      };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", aborted, { once: true });
      try {
        this.write({ id, method, params });
      } catch {
        this.fail("write_failed");
      }
    });
  }
  private rejectPending(reason: string) {
    for (const item of this.pending.values()) {
      item.cleanup();
      item.reject(new Error(reason));
    }
    this.pending.clear();
    if (this.terminalWaiter) {
      this.terminalWaiter.cleanup();
      this.terminalWaiter.reject(new Error(reason));
      this.terminalWaiter = undefined;
    }
  }
  private fail(reason: string) {
    this.failure ??= reason;
    this.rejectPending(this.failure);
    if (!this.processExited) this.child.kill();
  }
  private receive(chunk: Buffer) {
    if (this.failure || this.processExited) return;
    this.stdoutBytes += chunk.length;
    if (this.stdoutBytes > MAX_TOTAL) {
      this.fail("stdout_limit");
      return;
    }
    try {
      this.buffer += this.decoder.decode(chunk, { stream: true });
    } catch {
      this.fail("invalid_utf8");
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > MAX_FRAME) {
        this.fail("frame_limit");
        return;
      }
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line);
        if (!message || Array.isArray(message) || typeof message !== "object") throw new Error();
      } catch {
        this.fail("invalid_json");
        return;
      }
      if (typeof message.method === "string") {
        // General diagnostics retain method counts only; terminal evidence is queued below.
        if (
          message.method.length > 128 ||
          (!this.notifications[message.method] && Object.keys(this.notifications).length >= 64)
        ) {
          this.fail("notification_limit");
          return;
        }
        this.notifications[message.method] = (this.notifications[message.method] ?? 0) + 1;
        if (message.id !== undefined) {
          this.fail("server_request_unsupported");
          return;
        }
        if (
          !this.turnAttempted &&
          /^(turn\/started|turn\/completed|item\/started|item\/completed)/u.test(message.method)
        ) {
          this.fail("unexpected_execution");
          return;
        }
        if (message.method === "thread/started") {
          const id = (message.params as { thread?: { id?: unknown } } | undefined)?.thread?.id;
          if (
            typeof id !== "string" ||
            !id ||
            (this.startedNotificationId && this.startedNotificationId !== id) ||
            (this.settings && this.settings.threadId !== id)
          ) {
            this.fail("thread_mismatch");
            return;
          }
          this.startedNotificationId = id;
        }
        if (message.method === "turn/started") {
          const event = z.object({ threadId: text, turn: TurnIdentity }).safeParse(message.params);
          if (!event.success) {
            this.fail("invalid_started_turn");
            return;
          }
          if (event.data.threadId !== this.settings?.threadId) {
            this.fail("thread_mismatch");
            return;
          }
          if (!this.bindTurn(event.data.turn.id)) return;
          if (this.terminalTurnStatus) {
            this.fail("turn_already_terminal");
            return;
          }
        }
        if (message.method === "turn/completed") {
          const event = TerminalTurnNotification.safeParse(message);
          if (!event.success) {
            this.fail("invalid_terminal_turn");
            return;
          }
          if (event.data.params.threadId !== this.settings?.threadId) {
            this.fail("thread_mismatch");
            return;
          }
          if (!this.bindTurn(event.data.params.turn.id)) return;
          if (
            this.terminalTurnStatus &&
            this.terminalTurnStatus !== event.data.params.turn.status
          ) {
            this.fail("terminal_status_conflict");
            return;
          }
          const bytes = Buffer.byteLength(line, "utf8");
          if (this.capturedTurns.length >= 128 || this.captureBytes + bytes > 2 * MAX_FRAME) {
            this.fail("turn_capture_limit");
            return;
          }
          this.capturedTurns.push({
            observationId: `${this.captureId}:${++this.captureSequence}`,
            observedAt: new Date().toISOString(),
            notificationJson: line,
          });
          this.captureBytes += bytes;
          this.terminalTurnStatus = event.data.params.turn.status;
          this.terminalWaiter?.resolve({
            turnId: event.data.params.turn.id,
            status: this.terminalTurnStatus,
          });
        }
        if (message.method === "item/completed") {
          const params = message.params as
            { item?: { type?: string; phase?: string }; threadId?: string } | undefined;
          if (params?.threadId !== this.settings?.threadId) {
            this.fail("thread_mismatch");
            return;
          }
          if (params?.item?.type === "agentMessage" && params.item.phase === "final_answer") {
            if (!FinalAgentMessage.safeParse(message).success) {
              this.fail("invalid_receipt_event");
              return;
            }
            const bytes = Buffer.byteLength(line, "utf8");
            if (
              this.capturedReceipts.length >= 128 ||
              this.receiptCaptureBytes + bytes > 2 * MAX_FRAME
            ) {
              this.fail("receipt_capture_limit");
              return;
            }
            this.capturedReceipts.push({
              observationId: `${this.captureId}:${++this.captureSequence}`,
              observedAt: new Date().toISOString(),
              notificationJson: line,
            });
            this.receiptCaptureBytes += bytes;
          }
        }
      } else {
        const pending = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
        if (!pending || "result" in message === "error" in message) {
          this.fail("response_mismatch");
          return;
        }
        this.pending.delete(message.id as number);
        pending.cleanup();
        if ("error" in message) pending.reject(new Error("provider_rejected"));
        else pending.resolve(message.result);
      }
      if (this.failure) return;
    }
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_FRAME) this.fail("frame_limit");
  }
  private finalizeOutput() {
    if (this.outputFinalized) return;
    this.outputFinalized = true;
    if (this.failure) return;
    try {
      this.buffer += this.decoder.decode();
    } catch {
      this.fail("invalid_utf8");
      return;
    }
    if (this.buffer.length) this.fail("incomplete_frame");
  }
}
