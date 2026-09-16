import { WINDOWS_BOUNDARY_REPLY_TIMEOUT_MS } from "./windows-boundary-protocol.js";
import { z } from "zod";

const Id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/u);
const Nonce = z.string().regex(/^[a-f0-9]{64}$/u);
const Binding = z.strictObject({ client_nonce: Nonce, session_nonce: Nonce });
const Operation = z.strictObject({
  request_id: Id,
  operation_id: Id,
  request_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
});
const ReplyBinding = Operation.extend(Binding.shape);
type OperationIdentity = z.infer<typeof Operation>;
type Correlation = z.infer<typeof ReplyBinding>;
type FailureReason = "connection_lost" | "deadline" | "clock_invalid" | "reply_mismatch";

export interface WindowsBoundaryExchangeFailure {
  readonly reason: FailureReason;
  /** Reserved before send: even a lost write acknowledgement cannot imply no effect. */
  readonly outstanding: Readonly<OperationIdentity> | null;
  readonly disposition: "reconciliation_required";
}

/**
 * Local correlation bookkeeping for a future persistent owned transport.
 * Inputs must come from that transport's strict decoder. A match says nothing
 * about authorization, operation success, native handle lifetime or cleanup.
 * No wire decoder, I/O, retries, reusable capabilities or resolver route is added.
 */
export class WindowsBoundaryExchange {
  private readonly binding: z.infer<typeof Binding>;
  private readonly requests = new Set<string>();
  private readonly operations = new Set<string>();
  private pending: { identity: OperationIdentity; deadline: number } | null = null;
  private failure: WindowsBoundaryExchangeFailure | null = null;
  private lastTime = -Infinity;

  constructor(
    binding: unknown,
    private readonly clock: () => number = () => performance.now()
  ) {
    this.binding = Binding.parse(binding);
  }

  reserve(identity: unknown, timeoutMs: number): Readonly<Correlation> {
    if (this.failure) throw new Error("exchange_terminal");
    if (this.pending) throw new Error("exchange_busy");
    const parsed = Operation.parse(identity);
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > WINDOWS_BOUNDARY_REPLY_TIMEOUT_MS
    )
      throw new Error("invalid_timeout");
    if (this.requests.has(parsed.request_id) || this.operations.has(parsed.operation_id))
      throw new Error("operation_reuse");
    if (this.requests.size >= 4096) throw new Error("session_budget");
    const now = this.time();
    if (now === null) throw new Error("exchange_terminal");
    this.requests.add(parsed.request_id);
    this.operations.add(parsed.operation_id);
    this.pending = { identity: parsed, deadline: now + timeoutMs };
    return Object.freeze({ ...parsed, ...this.binding });
  }

  correlate(
    reply: unknown
  ):
    | { correlated: true; identity: Readonly<OperationIdentity> }
    | { correlated: false; failure: WindowsBoundaryExchangeFailure } {
    if (this.failure) return { correlated: false, failure: this.failure };
    const now = this.time();
    if (now === null) return { correlated: false, failure: this.failure! };
    if (this.pending && now >= this.pending.deadline)
      return { correlated: false, failure: this.fail("deadline") };
    const parsed = ReplyBinding.safeParse(reply);
    if (
      !parsed.success ||
      !this.pending ||
      parsed.data.client_nonce !== this.binding.client_nonce ||
      parsed.data.session_nonce !== this.binding.session_nonce ||
      parsed.data.request_id !== this.pending.identity.request_id ||
      parsed.data.operation_id !== this.pending.identity.operation_id ||
      parsed.data.request_digest !== this.pending.identity.request_digest
    )
      return { correlated: false, failure: this.fail("reply_mismatch") };
    const identity = Object.freeze({ ...this.pending.identity });
    this.pending = null;
    return { correlated: true, identity };
  }

  disconnect(): WindowsBoundaryExchangeFailure {
    return this.fail("connection_lost");
  }

  private time(): number | null {
    let value: number;
    try {
      value = this.clock();
    } catch {
      this.fail("clock_invalid");
      return null;
    }
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      value > Number.MAX_SAFE_INTEGER - WINDOWS_BOUNDARY_REPLY_TIMEOUT_MS ||
      value < this.lastTime
    ) {
      this.fail("clock_invalid");
      return null;
    }
    this.lastTime = value;
    return value;
  }

  private fail(reason: FailureReason): WindowsBoundaryExchangeFailure {
    this.failure ??= Object.freeze({
      reason,
      outstanding: this.pending ? Object.freeze({ ...this.pending.identity }) : null,
      disposition: "reconciliation_required" as const,
    });
    this.pending = null;
    return this.failure;
  }
}
