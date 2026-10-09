import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { computeCanonicalHash } from "../schemas/task-contract.js";

const RunBinding = z.object({ runId: z.string().min(1).max(512) }).strict();
const Binding = z
  .object({
    runId: z.string().min(1).max(512),
    connectionId: z.string().uuid(),
  })
  .strict();
type Binding = z.infer<typeof Binding>;
const Window = z.object({ ttlMs: z.number().int().min(1).max(900000) }).strict();

/**
 * Host-owned local ingress capability for one child launch. Verification proves
 * credential possession only, never process identity, human input or custody.
 * The host configures the fixed header mapping in the child's isolated home.
 */
export class CodexProviderIngressSession {
  readonly #sessionId = randomUUID();
  readonly #runId: string;
  #bindingHash: string | null = null;
  readonly #credential = randomBytes(32);
  readonly #controller = new AbortController();
  readonly #deadline: number;
  readonly #timer: ReturnType<typeof setTimeout>;
  #state: "allocated" | "bound" | "expired" | "revoked" = "allocated";

  constructor(binding: { runId: string }, window: { ttlMs: number }) {
    try {
      this.#runId = RunBinding.parse(structuredClone(binding)).runId;
      const { ttlMs } = Window.parse(window);
      this.#deadline = performance.now() + ttlMs;
      this.#timer = setTimeout(() => this.end("expired"), ttlMs);
      this.#timer.unref();
    } catch {
      this.#credential.fill(0);
      throw new TypeError("invalid_provider_session_binding");
    }
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  matchesBinding(binding: Binding): boolean {
    const parsed = Binding.safeParse(binding);
    return parsed.success && computeCanonicalHash(parsed.data) === this.#bindingHash;
  }

  /** Trusted host use only; do not expose this credential through CLI/MCP or logs. */
  claimChildEnvironment(connectionId: string): { LEXRUNNER_PROVIDER_SESSION: string } {
    this.checkExpiry();
    if (this.#state !== "allocated") throw new Error("provider_session_unavailable");
    const parsed = z.string().uuid().safeParse(connectionId);
    if (!parsed.success) throw new TypeError("invalid_provider_session_connection");
    this.#bindingHash = computeCanonicalHash({ runId: this.#runId, connectionId: parsed.data });
    this.#state = "bound";
    return { LEXRUNNER_PROVIDER_SESSION: this.#credential.toString("base64url") };
  }

  /** Checks raw headers before any body read; the caller owns rejected requests. */
  authorize(request: IncomingMessage) {
    this.checkExpiry();
    if (this.#state !== "bound") return null;
    let selected: string | undefined;
    let count = 0;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index]?.toLowerCase() === "x-lexrunner-provider-session") {
        count++;
        selected = request.rawHeaders[index + 1];
      }
    }
    if (count !== 1 || !selected || !/^[A-Za-z0-9_-]{43}$/u.test(selected)) return null;
    const bytes = Buffer.from(selected, "base64url");
    if (
      bytes.length !== 32 ||
      bytes.toString("base64url") !== selected ||
      !timingSafeEqual(bytes, this.#credential)
    )
      return null;
    return {
      sessionId: this.#sessionId,
      bindingHash: this.#bindingHash!,
      credentialPossessionVerified: true as const,
    };
  }

  revoke(): void {
    this.end("revoked");
  }

  snapshot() {
    this.checkExpiry();
    return {
      sessionId: this.#sessionId,
      bindingHash: this.#bindingHash,
      state: this.#state,
      credentialPossessionVerified: false as const,
      intendedChildQualified: false as const,
      sourceAuthenticated: false as const,
    };
  }

  private checkExpiry(): void {
    if (performance.now() >= this.#deadline) this.end("expired");
  }

  private end(state: "expired" | "revoked"): void {
    if (this.#state === "expired" || this.#state === "revoked") return;
    this.#state = state;
    clearTimeout(this.#timer);
    this.#credential.fill(0);
    this.#controller.abort();
  }
}
