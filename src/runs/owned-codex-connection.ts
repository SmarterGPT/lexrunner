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
import {
  CodexHumanInputCapture,
  CodexHumanInputRequest,
  CodexServerRequestResolved,
} from "../schemas/codex-human-input.js";
import {
  hashWorkerHumanInput,
  type WorkerHumanInputCapture,
} from "../schemas/worker-human-input.js";
import {
  type AgentWorkHumanActionService,
  type HumanActionMutationInput,
} from "./agent-work-human-action-service.js";
import {
  SignedWorkerHumanAnswer,
  WorkerHumanAnswerDelivery,
  WorkerHumanAnswerObservation,
  workerHumanAnswersMatch,
} from "../schemas/worker-human-answer.js";
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
    // Native questions require Plan mode in the qualified Codex version.
    // Select once at connection creation; caller turn settings remain forbidden.
    collaborationMode: z.literal("plan").optional(),
  })
  .strict()
  .refine((value) => !value.collaborationMode || value.model !== undefined, {
    message: "Plan mode requires an explicit model",
  });
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
  private readonly capturedHumanInputs: WorkerHumanInputCapture[] = [];
  private readonly humanRequests = new Map<
    string,
    {
      hash: string;
      cleared: boolean;
      answerAttempted?: boolean;
      resolutionObserved?: boolean;
      deliveryBinding?: Pick<
        WorkerHumanAnswerObservation,
        "runId" | "requestId" | "claimId" | "captureHash" | "answerHash"
      >;
    }
  >();
  private readonly capturedAnswerObservations: WorkerHumanAnswerObservation[] = [];
  private answerObservationBusy = false;
  private answerObservationBytes = 0;
  private humanCaptureBytes = 0;
  private humanCaptureBusy = false;
  private humanAnswerBusy = false;
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
        ...(options.collaborationMode ? { capabilities: { experimentalApi: true } } : {}),
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
      requestedCollaborationMode: this.options.collaborationMode ?? null,
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
      pendingHumanInputCaptures: this.capturedHumanInputs.length,
      pendingHumanInputCaptureBytes: this.humanCaptureBytes,
      unclearedHumanRequests: [...this.humanRequests.values()].filter((value) => !value.cleared)
        .length,
      pendingAnswerObservations: this.capturedAnswerObservations.length,
      pendingAnswerObservationBytes: this.answerObservationBytes,
      humanAnswerWriteAttempts: [...this.humanRequests.values()].filter(
        (value) => value.answerAttempted
      ).length,
    };
  }

  /** Atomically retain the portable hold and exact question before any host displays it. */
  async persistNextHumanInputCapture(
    service: Pick<AgentWorkHumanActionService, "request">,
    input: HumanActionMutationInput & {
      attemptId: string;
      workspaceLeaseId: string;
      workerSessionId: string;
      workspaceLeaseRevision: number;
      expectedHeadSha: string;
    }
  ) {
    input = structuredClone(input);
    if (this.humanCaptureBusy) throw new Error("capture_in_progress");
    const next = this.capturedHumanInputs[0];
    if (!next) return null;
    // Revalidate the adapter projection before crossing the portable service port.
    const capture = CodexHumanInputCapture.parse(next);
    this.humanCaptureBusy = true;
    try {
      const requestId = `worker-input:${capture.observationId}`;
      const result = await service.request({
        controller: input.controller,
        expectedRunRevision: input.expectedRunRevision,
        mutationId: input.mutationId,
        now: input.now,
        workerInput: capture,
        request: {
          schema_version: "1.0.0",
          request_id: requestId,
          run_id: input.controller.runId,
          attempt_id: input.attemptId,
          workspace_lease_id: input.workspaceLeaseId,
          worker_session_id: input.workerSessionId,
          action: "other",
          summary: "Worker requires a human decision.",
          instructions: [
            "Review the exact persisted worker question through a qualified host human channel.",
          ],
          suggested_commands: [],
          preconditions: {
            run_revision: input.expectedRunRevision,
            workspace_lease_revision: input.workspaceLeaseRevision,
            expected_head_sha: input.expectedHeadSha,
          },
          requested_at: capture.observedAt,
        },
      });
      if (result.ok) {
        this.capturedHumanInputs.shift();
        this.humanCaptureBytes -= Buffer.byteLength(JSON.stringify(next), "utf8");
      }
      return { ...result, requestId };
    } finally {
      this.humanCaptureBusy = false;
    }
  }

  /** Protected host composition: persisted admission and claim precede a single answer write. */
  async deliverHumanAnswer(
    service: Pick<
      AgentWorkHumanActionService,
      "getWorkerAnswer" | "claimWorkerAnswerDelivery" | "recordWorkerAnswerWrite"
    >,
    input: HumanActionMutationInput & { requestId: string; claimId: string },
    options: RequestWindow
  ) {
    input = structuredClone(input);
    options = { signal: options.signal, deadlineAt: options.deadlineAt };
    if (this.humanAnswerBusy)
      return { status: "blocked" as const, reason: "answer_delivery_in_progress" };
    this.humanAnswerBusy = true;
    try {
      const stored = await service.getWorkerAnswer(input.controller.runId, input.requestId);
      if (!stored)
        return { status: "blocked" as const, reason: "authenticated_worker_answer_missing" };
      const capture = CodexHumanInputCapture.parse(stored.capture);
      const answer = SignedWorkerHumanAnswer.parse(stored.answer);
      const key = JSON.stringify(capture.providerRequestId);
      const pending = this.humanRequests.get(key);
      const applicable = () =>
        !this.failure &&
        !this.processExited &&
        !this.closing &&
        !this.terminalTurnStatus &&
        !this.interruptAttempted &&
        !options.signal.aborted &&
        capture.connectionId === this.captureId &&
        capture.workerId === this.settings?.threadId &&
        capture.turnId === this.ownedTurnId &&
        pending?.hash === capture.requestHash &&
        !pending.cleared &&
        !pending.answerAttempted;
      if (
        answer.payload.challenge.runId !== input.controller.runId ||
        answer.payload.challenge.requestId !== input.requestId ||
        !workerHumanAnswersMatch(capture, answer.payload) ||
        !applicable()
      )
        return { status: "blocked" as const, reason: "native_question_not_pending" };
      const remaining = Date.parse(options.deadlineAt) - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0)
        return { status: "blocked" as const, reason: "answer_delivery_window_expired" };
      const claim = await service.claimWorkerAnswerDelivery(input);
      if (!claim.ok) return { status: "blocked" as const, reason: claim.reason };
      if (!claim.newlyClaimed)
        return {
          status: "reconciliation_required" as const,
          reason: "answer_send_already_claimed",
        };
      const delivery = WorkerHumanAnswerDelivery.parse(claim.delivery);
      if (
        claim.replay ||
        delivery.disposition !== "claimed" ||
        delivery.controllerId !== input.controller.controllerId ||
        delivery.controllerLeaseId !== input.controller.leaseId ||
        delivery.fencingToken !== input.controller.fencingToken ||
        delivery.claimId !== input.claimId ||
        delivery.answerHash !== computeCanonicalHash(answer)
      )
        return {
          status: "reconciliation_required" as const,
          reason: "answer_delivery_claim_mismatch",
        };
      let disposition: "written" | "not_sent" | "uncertain" = "not_sent";
      const timeout =
        Math.min(
          Date.parse(options.deadlineAt),
          Date.parse(claim.delivery.deadlineAt),
          Date.now() + 30_000
        ) - Date.now();
      if (applicable() && timeout > 0) {
        pending!.answerAttempted = true;
        pending!.deliveryBinding = {
          runId: input.controller.runId,
          requestId: input.requestId,
          claimId: delivery.claimId,
          captureHash: computeCanonicalHash(capture),
          answerHash: delivery.answerHash,
        };
        disposition = "uncertain";
        // The body comes only from persisted, host-admitted data. No raw response API.
        const response = {
          id: capture.providerRequestId,
          result: {
            answers: Object.fromEntries(
              answer.payload.answers.map((value) => [value.questionId, { answers: [value.value] }])
            ),
          },
        };
        try {
          await this.writeHumanAnswer(JSON.stringify(response) + "\n", timeout, options.signal);
          disposition = "written";
        } catch {
          /* A failed write/timeout can have reached the child. Never replay. */
        }
      }
      const recorded = await service.recordWorkerAnswerWrite({
        ...input,
        expectedRunRevision: claim.revision,
        mutationId: `${input.mutationId}:write`,
        now: new Date().toISOString(),
        disposition,
      });
      if (!recorded.ok)
        return { status: "reconciliation_required" as const, reason: recorded.reason };
      return {
        status:
          disposition === "written" ? ("written" as const) : ("reconciliation_required" as const),
        disposition,
      };
    } finally {
      this.humanAnswerBusy = false;
    }
  }

  /** Replay only evidence persistence after a lost ACK; never resend the native answer. */
  async persistNextAnswerObservation(
    service: Pick<AgentWorkHumanActionService, "recordWorkerAnswerObservation">,
    input: HumanActionMutationInput
  ) {
    input = structuredClone(input);
    if (this.answerObservationBusy) throw new Error("answer_observation_in_progress");
    const next = this.capturedAnswerObservations[0];
    if (!next) return null;
    if (next.runId !== input.controller.runId) throw new Error("answer_observation_run_mismatch");
    this.answerObservationBusy = true;
    try {
      const result = await service.recordWorkerAnswerObservation({
        ...input,
        observation: structuredClone(next),
      });
      if (result.ok) {
        this.capturedAnswerObservations.shift();
        this.answerObservationBytes -= Buffer.byteLength(JSON.stringify(next), "utf8");
      }
      return result;
    } finally {
      this.answerObservationBusy = false;
    }
  }

  private writeHumanAnswer(line: string, timeoutMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        this.child.off("close", closed);
        error ? reject(error) : resolve();
      };
      const aborted = () => finish(new Error("answer_write_aborted"));
      const closed = () => finish(new Error("answer_connection_closed"));
      const timer = setTimeout(() => finish(new Error("answer_write_timeout")), timeoutMs);
      signal.addEventListener("abort", aborted, { once: true });
      this.child.once("close", closed);
      try {
        this.requireOpen();
        if (signal.aborted) throw new Error("answer_write_aborted");
        this.child.stdin.write(line, (error) => finish(error));
      } catch (error) {
        finish(error instanceof Error ? error : new Error("answer_write_failed"));
      }
    });
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
    // Receipt dispatch hashes do not bind collaboration settings yet. Keep
    // experimental planning outside that path instead of changing its wire claim.
    if (this.options.collaborationMode && parsed.outputSchema !== undefined)
      throw new Error("plan_receipt_dispatch_not_supported");
    if (!this.settings || parsed.threadId !== this.settings.threadId)
      throw new Error("thread_mismatch");
    const wireParams = {
      ...parsed,
      ...(this.options.collaborationMode
        ? {
            collaborationMode: {
              mode: "plan",
              settings: {
                model: this.settings.model,
                developer_instructions: null,
                reasoning_effort: null,
              },
            },
          }
        : {}),
    };
    if (Buffer.byteLength(JSON.stringify(wireParams), "utf8") > 256 * 1024)
      throw new Error("request_limit");
    const remaining = Date.parse(options.deadlineAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0 || options.signal.aborted)
      throw new Error("dispatch_window_expired");
    if (this.turnAttempted) throw new Error("dispatch_already_attempted");
    this.turnAttempted = true;
    const response = await this.rpc(
      method,
      wireParams,
      Math.min(remaining, 30_000),
      options.signal
    );
    this.requireOpen();
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
    this.requireOpen();
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
    this.requireOpen();
    if (this.terminalTurnStatus) return { turnId, status: this.terminalTurnStatus };
    if (this.terminalWaiter) throw new Error("terminal_wait_already_pending");
    const observed = await new Promise<OwnedCodexTerminalObservation | null>((resolve, reject) => {
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
    this.requireOpen();
    return observed;
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
        if (message.method === "item/tool/requestUserInput") {
          this.captureHumanInput(message, line);
          if (this.failure) return;
          continue;
        }
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
          for (const request of this.humanRequests.values()) request.cleared = true;
          this.terminalWaiter?.resolve({
            turnId: event.data.params.turn.id,
            status: this.terminalTurnStatus,
          });
        }
        if (message.method === "serverRequest/resolved") {
          const event = CodexServerRequestResolved.safeParse(message);
          if (!event.success || event.data.params.threadId !== this.settings?.threadId) {
            this.fail("invalid_server_request_resolution");
            return;
          }
          const request = this.humanRequests.get(JSON.stringify(event.data.params.requestId));
          if (request) {
            request.cleared = true;
            // Terminal status may clear eligibility before the cleanup event arrives.
            // Deduplicate retained cleanup separately from answer eligibility.
            if (request.deliveryBinding && !request.resolutionObserved) {
              const observation = WorkerHumanAnswerObservation.parse({
                version: 1,
                domain: "lexrunner.worker-answer-observation/v1",
                ...request.deliveryBinding,
                observationId: `${this.captureId}:answer:${++this.captureSequence}`,
                kind: "request_cleared",
                observedAt: new Date().toISOString(),
                evidenceHash: computeCanonicalHash(event.data),
              });
              const bytes = Buffer.byteLength(JSON.stringify(observation), "utf8");
              if (
                this.capturedAnswerObservations.length >= 128 ||
                this.answerObservationBytes + bytes > 2 * MAX_FRAME
              ) {
                this.fail("answer_observation_capture_limit");
                return;
              }
              this.capturedAnswerObservations.push(observation);
              this.answerObservationBytes += bytes;
              request.resolutionObserved = true;
            }
          }
          // Cleanup evidence is never an answer, consumption qualification or hold release.
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
  private captureHumanInput(message: unknown, line: string) {
    const event = CodexHumanInputRequest.safeParse(message);
    if (!event.success || Buffer.byteLength(line, "utf8") > 16 * 1024) {
      this.fail("unsupported_human_input");
      return;
    }
    const request = event.data;
    if (
      !this.turnAttempted ||
      !this.ownedTurnId ||
      this.terminalTurnStatus ||
      request.params.threadId !== this.settings?.threadId ||
      request.params.turnId !== this.ownedTurnId
    ) {
      this.fail("human_input_turn_mismatch");
      return;
    }
    const key = JSON.stringify(request.id);
    const hash = hashWorkerHumanInput(line);
    const prior = this.humanRequests.get(key);
    if (prior) {
      if (prior.hash !== hash || prior.cleared) this.fail("human_input_request_conflict");
      return;
    }
    if ([...this.humanRequests.values()].some((value) => !value.cleared)) {
      this.fail("human_input_already_pending");
      return;
    }
    const parsedCapture = CodexHumanInputCapture.safeParse({
      version: 1,
      connectionId: this.captureId,
      observationId: `${this.captureId}:${++this.captureSequence}`,
      observedAt: new Date().toISOString(),
      workerRuntime: "codex-native",
      workerId: request.params.threadId,
      turnId: request.params.turnId,
      providerRequestId: request.id,
      questions: request.params.questions.map((q) => ({
        id: q.id,
        header: q.header,
        question: q.question,
        allowOther: q.isOther ?? false,
        options: q.options ?? null,
      })),
      requestJson: line,
      requestHash: hash,
    });
    if (!parsedCapture.success) {
      this.fail("unsupported_human_input");
      return;
    }
    const capture = parsedCapture.data;
    const bytes = Buffer.byteLength(JSON.stringify(capture), "utf8");
    if (this.humanRequests.size >= 128 || this.humanCaptureBytes + bytes > 2 * MAX_FRAME) {
      this.fail("human_input_capture_limit");
      return;
    }
    this.humanRequests.set(key, { hash, cleared: false });
    this.capturedHumanInputs.push(capture);
    this.humanCaptureBytes += bytes;
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
