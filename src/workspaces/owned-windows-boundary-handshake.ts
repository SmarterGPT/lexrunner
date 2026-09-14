import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { canonicalJSONStringify } from "../util/canonicalJson.js";
import {
  WindowsBoundaryExchange,
  type WindowsBoundaryExchangeFailure,
} from "./windows-boundary-exchange.js";

import {
  assessWindowsBoundaryHello,
  encodeWindowsBoundaryControl,
  encodeWindowsBoundarySession,
  WINDOWS_BOUNDARY_PROTOCOL_VERSION,
  WindowsBoundaryControlDecoder,
  WindowsBoundaryHelloResult,
} from "./windows-boundary-protocol.js";

const AbsolutePath = z
  .string()
  .min(1)
  .max(16_384)
  .refine(isAbsolute)
  .refine((s) => !s.includes("\0"));
const Options = z.strictObject({
  executable: AbsolutePath,
  cwd: AbsolutePath,
  expectedArtifactSha256: WindowsBoundaryHelloResult.shape.helper.shape.artifact_sha256,
  architecture: WindowsBoundaryHelloResult.shape.helper.shape.architecture,
  handshakeTimeoutMs: z.number().int().min(1).max(30_000).default(5_000),
  closeTimeoutMs: z.number().int().min(1).max(5_000).default(500),
  killTimeoutMs: z.number().int().min(1).max(5_000).default(1_000),
});
export type OwnedWindowsBoundaryHandshakeOptions = z.input<typeof Options>;
type Failure =
  | "invalid_options"
  | "cancelled"
  | "spawn_error"
  | "protocol_error"
  | "metadata_mismatch"
  | "child_exit"
  | "handshake_timeout"
  | "operation_timeout"
  | "cleanup_forced"
  | "cleanup_unknown"
  | "io_error"
  | "output_limit";
export interface WindowsBoundaryHandshakeReport {
  outcome: "matched" | "failed";
  reason?: Failure;
  verification: "not_performed";
  helloMatched: boolean;
  sessionNonceSha256?: string;
  cleanup: {
    disposition: "not_started" | "closed" | "unknown";
    processExited: boolean;
    terminationRequested: boolean;
    exitCode: number | null;
    signal: string | null;
    descendants: "not_assessed";
  };
  stderrBytes: number;
  sessionOperations?: {
    requested: number;
    correlated: number;
    failure?: WindowsBoundaryExchangeFailure;
  };
}

/**
 * Explicit development probe, never production resolution. The expected digest is supplied
 * data, not verified executable provenance. No operations or reusable capabilities are exposed.
 */
export async function probeOwnedWindowsBoundaryHandshake(
  options: OwnedWindowsBoundaryHandshakeOptions,
  signal?: AbortSignal
): Promise<WindowsBoundaryHandshakeReport> {
  return runOwnedWindowsBoundary(options, signal, 0);
}

/** Up to fifteen status round trips on one owned process; no filesystem operations. */
export async function probeOwnedWindowsBoundarySession(
  options: OwnedWindowsBoundaryHandshakeOptions,
  rounds: number,
  signal?: AbortSignal
): Promise<WindowsBoundaryHandshakeReport> {
  return runOwnedWindowsBoundary(options, signal, rounds);
}

async function runOwnedWindowsBoundary(
  options: OwnedWindowsBoundaryHandshakeOptions,
  signal: AbortSignal | undefined,
  rounds: number
): Promise<WindowsBoundaryHandshakeReport> {
  const parsed = Options.safeParse(options);
  const empty = (reason: Failure): WindowsBoundaryHandshakeReport => ({
    outcome: "failed",
    reason,
    verification: "not_performed",
    helloMatched: false,
    cleanup: {
      disposition: "not_started",
      processExited: false,
      terminationRequested: false,
      exitCode: null,
      signal: null,
      descendants: "not_assessed",
    },
    stderrBytes: 0,
  });
  if (!parsed.success || !Number.isSafeInteger(rounds) || rounds < 0 || rounds > 15)
    return empty("invalid_options");
  if (signal?.aborted) return empty("cancelled");
  const settings = parsed.data;
  const handshakeDeadline = performance.now() + settings.handshakeTimeoutMs;
  const request = {
    kind: "hello" as const,
    protocol_version: WINDOWS_BOUNDARY_PROTOCOL_VERSION,
    request_id: randomUUID(),
    client_nonce: randomBytes(32).toString("hex"),
  };
  // Never forward NODE_OPTIONS, loader overrides, caller argv or the general ambient environment.
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      ["SYSTEMROOT", "WINDIR", "TEMP", "TMP"].includes(key.toUpperCase())
    )
  );
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(
      settings.executable,
      [rounds ? "--boundary-session" : "--boundary-protocol", WINDOWS_BOUNDARY_PROTOCOL_VERSION],
      {
        cwd: settings.cwd,
        env: environment,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
  } catch {
    return empty("spawn_error");
  }
  return new Promise((resolve) => {
    const decoder = new WindowsBoundaryControlDecoder(rounds > 0);
    let exchange: WindowsBoundaryExchange | undefined;
    let operationCount = 0;
    let sessionNonce: string | undefined;
    let failure: Failure | undefined;
    let helloMatched = false;
    let sessionNonceSha256: string | undefined;
    let seenReply = false;
    let outputEnded = false;
    let started = false;
    let processExited = false;
    let terminationRequested = false;
    let finished = false;
    let closing = false;
    let stderrBytes = 0;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (disposition: "closed" | "unknown") => {
      if (finished) return;
      finished = true;
      clearTimeout(handshakeTimer);
      clearTimeout(closeTimer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      if (disposition === "unknown") {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
      if (!failure && !helloMatched) failure = "child_exit";
      if (!failure && operationCount !== rounds) failure = "child_exit";
      resolve({
        outcome: failure ? "failed" : "matched",
        ...(failure ? { reason: failure } : {}),
        verification: "not_performed",
        helloMatched,
        ...(sessionNonceSha256 ? { sessionNonceSha256 } : {}),
        cleanup: {
          disposition: !started && disposition === "closed" ? "not_started" : disposition,
          processExited,
          terminationRequested,
          exitCode,
          signal: exitSignal,
          descendants: "not_assessed",
        },
        stderrBytes,
        ...(rounds
          ? {
              sessionOperations: {
                requested: rounds,
                correlated: operationCount,
                ...(failure && exchange ? { failure: exchange.disconnect() } : {}),
              },
            }
          : {}),
      });
    };
    const terminate = () => {
      if (finished) return;
      failure ??= processExited ? "cleanup_unknown" : "cleanup_forced";
      killTimer = setTimeout(() => {
        finish("unknown");
      }, settings.killTimeoutMs);
      if (!processExited) {
        terminationRequested = true;
        try {
          child.kill();
        } catch {
          /* Exit and close observations determine disposition. */
        }
      }
    };
    const close = () => {
      if (finished || closing) return;
      closing = true;
      clearTimeout(handshakeTimer);
      closeTimer = setTimeout(terminate, settings.closeTimeoutMs);
      child.stdin.end();
    };
    const fail = (reason: Failure) => {
      if (finished) return;
      failure ??= reason;
      close();
    };
    const abort = () => fail("cancelled");
    const sendStatus = () => {
      const body = {
        client_nonce: request.client_nonce,
        kind: "session_request" as const,
        operation: "session-status" as const,
        operation_id: randomUUID(),
        protocol_version: WINDOWS_BOUNDARY_PROTOCOL_VERSION,
        request_id: randomUUID(),
        session_nonce: sessionNonce!,
      };
      const requestDigest = `sha256:${createHash("sha256").update(canonicalJSONStringify(body)).digest("hex")}`;
      exchange!.reserve(
        {
          request_id: body.request_id,
          operation_id: body.operation_id,
          request_digest: requestDigest,
        },
        settings.handshakeTimeoutMs
      );
      clearTimeout(handshakeTimer);
      handshakeTimer = setTimeout(() => fail("operation_timeout"), settings.handshakeTimeoutMs);
      child.stdin.write(encodeWindowsBoundarySession({ ...body, request_digest: requestDigest }));
    };
    child.on("error", () => fail("spawn_error"));
    child.stdin.on("error", () => fail("io_error"));
    child.stdout.on("error", () => fail("io_error"));
    child.stderr.on("error", () => fail("io_error"));
    child.on("spawn", () => {
      started = true;
      if (finished || closing) return;
      if (performance.now() >= handshakeDeadline) {
        fail("handshake_timeout");
        return;
      }
      child.stdin.write(encodeWindowsBoundaryControl(request));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (finished || failure) return;
      if (!seenReply && performance.now() >= handshakeDeadline) {
        fail("handshake_timeout");
        return;
      }
      try {
        const messages = decoder.push(chunk);
        for (const message of messages) {
          if (seenReply && rounds && message.kind === "session_result") {
            const {
              kind: _kind,
              status: _status,
              protocol_version: _version,
              ...correlation
            } = message;
            const match = exchange!.correlate(correlation);
            if (!match.correlated) {
              fail(match.failure.reason === "deadline" ? "operation_timeout" : "protocol_error");
              return;
            }
            operationCount++;
            if (operationCount === rounds) close();
            else sendStatus();
            continue;
          }
          if (seenReply || message.kind !== "hello_result") {
            fail("protocol_error");
            return;
          }
          seenReply = true;
          const match = assessWindowsBoundaryHello(request, message, {
            artifact_sha256: settings.expectedArtifactSha256,
            architecture: settings.architecture,
            process_id: child.pid ?? 0,
          });
          if (!match.matched) {
            fail("metadata_mismatch");
            return;
          }
          if (performance.now() >= handshakeDeadline) {
            fail("handshake_timeout");
            return;
          }
          helloMatched = true;
          sessionNonceSha256 = `sha256:${createHash("sha256").update(message.session_nonce, "hex").digest("hex")}`;
          if (rounds) {
            sessionNonce = message.session_nonce;
            exchange = new WindowsBoundaryExchange({
              client_nonce: request.client_nonce,
              session_nonce: sessionNonce,
            });
            sendStatus();
          } else close();
        }
      } catch {
        fail("protocol_error");
      }
    });
    child.stdout.on("end", () => {
      if (finished || outputEnded) return;
      outputEnded = true;
      try {
        decoder.end();
      } catch {
        fail("protocol_error");
      }
      if (!helloMatched) fail("child_exit");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (finished) return;
      stderrBytes = Math.min(65_537, stderrBytes + chunk.byteLength);
      if (stderrBytes > 65_536) fail("output_limit");
    });
    child.on("exit", (code, exitSignalValue) => {
      processExited = true;
      exitCode = code;
      exitSignal = exitSignalValue;
    });
    child.on("close", (code, exitSignalValue) => {
      if (finished) return;
      exitCode = code;
      exitSignal = exitSignalValue;
      if (!outputEnded) {
        outputEnded = true;
        try {
          decoder.end();
        } catch {
          failure ??= "protocol_error";
        }
      }
      if (started && (!processExited || code !== 0)) failure ??= "child_exit";
      finish("closed");
    });
    signal?.addEventListener("abort", abort, { once: true });
    handshakeTimer = setTimeout(
      () => fail("handshake_timeout"),
      Math.max(0, handshakeDeadline - performance.now())
    );
    if (signal?.aborted) abort();
  });
}
