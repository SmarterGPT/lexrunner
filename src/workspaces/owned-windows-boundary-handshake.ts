import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { isAbsolute, win32 } from "node:path";
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
  WindowsBoundaryDirectoryResult,
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
  | "work_failed"
  | "work_timeout"
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
  directory?: {
    acquired: boolean;
    releaseAcknowledged: boolean;
    assertions: number;
    childrenAcquired: number;
    childrenReleased: number;
    filesRead: number;
    bytesRead: number;
  };
  sessionOperations?: {
    requested: number;
    correlated: number;
    failure?: WindowsBoundaryExchangeFailure;
  };
}

type DirectoryReply = z.infer<typeof WindowsBoundaryDirectoryResult>;
export type OwnedWindowsDirectoryIdentity = Readonly<
  Pick<DirectoryReply, "path" | "file_id" | "volume_serial_number" | "filesystem" | "chain_length">
>;
export interface OwnedWindowsDirectoryScope {
  readonly identity: OwnedWindowsDirectoryIdentity;
  assertCurrent(): Promise<OwnedWindowsDirectoryIdentity>;
  openChild(component: string): Promise<OwnedWindowsDirectoryScope>;
  tryOpenChild(component: string): Promise<OwnedWindowsDirectoryScope | null>;
  createChild(component: string): Promise<OwnedWindowsDirectoryScope>;
  readFile(component: string, maxBytes: number): Promise<OwnedWindowsFileRead>;
}
export interface OwnedWindowsFileRead {
  readonly kind: "file_read";
  readonly bytes: Uint8Array;
  readonly contentSha256: string;
  readonly fileId: string;
  readonly volumeSerialNumber: string;
}
type ScopeReply = DirectoryReply | OwnedWindowsFileRead | null;
function directoryValue(reply: ScopeReply): DirectoryReply {
  if (!reply || reply.kind !== "directory_result") throw new Error("Unexpected directory response");
  return reply;
}
type DirectoryOperation =
  "acquire" | "assert" | "release" | "open-child" | "try-open-child" | "create-child" | "read-file";
const DirectoryOptions = z.strictObject({
  path: z
    .string()
    .min(3)
    .max(1024)
    .regex(/^[a-z]:\\/iu)
    .refine((s) => !s.includes("\0")),
  workTimeoutMs: z.number().int().min(1).max(30_000).default(5_000),
});
type DirectoryWork = (scope: OwnedWindowsDirectoryScope) => Promise<void>;
type DirectoryRun = z.output<typeof DirectoryOptions> & { work: DirectoryWork };

/** Scoped development adapter. No authenticated custody or WorkspaceBoundary readiness. */
export async function withOwnedWindowsBoundaryDirectory(
  options: OwnedWindowsBoundaryHandshakeOptions,
  directory: z.input<typeof DirectoryOptions>,
  work: DirectoryWork,
  signal?: AbortSignal
): Promise<WindowsBoundaryHandshakeReport> {
  const parsed = DirectoryOptions.safeParse(directory);
  return runOwnedWindowsBoundary(
    options,
    signal,
    parsed.success && typeof work === "function" ? 0 : -1,
    parsed.success ? { ...parsed.data, work } : undefined
  );
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
  rounds: number,
  directory?: DirectoryRun
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
  const sessionMode = rounds > 0 || !!directory;
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
      [
        sessionMode ? "--boundary-session" : "--boundary-protocol",
        WINDOWS_BOUNDARY_PROTOCOL_VERSION,
      ],
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
    const decoder = new WindowsBoundaryControlDecoder(sessionMode);
    let sentCount = 0;
    let directoryReply: DirectoryReply | undefined;
    let directoryOperation: DirectoryOperation | undefined;
    let directoryTarget: DirectoryReply | undefined;
    let childComponent: string | undefined;
    const liveDirectories: DirectoryReply[] = [];
    let childrenAcquired = 0;
    let childrenReleased = 0;
    let filesRead = 0;
    let bytesRead = 0;
    let readLimit: number | undefined;
    let releaseAcknowledged = false;
    let assertions = 0;
    let working = false;
    let workDeadline = 0;
    let workTimer: ReturnType<typeof setTimeout> | undefined;
    let assertion:
      | {
          resolve: (reply: ScopeReply) => void;
          reject: (error: Error) => void;
        }
      | undefined;
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
      clearTimeout(workTimer);
      working = false;
      assertion?.reject(new Error("Directory session ended"));
      assertion = undefined;
      signal?.removeEventListener("abort", abort);
      if (disposition === "unknown") {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
      if (!failure && !helloMatched) failure = "child_exit";
      if (!failure && (directory ? !releaseAcknowledged : operationCount !== rounds))
        failure = "child_exit";
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
        ...(directory
          ? {
              directory: {
                acquired: !!directoryReply,
                releaseAcknowledged,
                assertions,
                childrenAcquired,
                childrenReleased,
                filesRead,
                bytesRead,
              },
            }
          : {}),
        ...(sessionMode
          ? {
              sessionOperations: {
                requested: directory ? sentCount : rounds,
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
      working = false;
      clearTimeout(workTimer);
      assertion?.reject(new Error("Directory session failed"));
      assertion = undefined;
      close();
    };
    const abort = () => fail("cancelled");
    const identity = (reply: DirectoryReply): OwnedWindowsDirectoryIdentity =>
      Object.freeze({
        path: reply.path,
        file_id: reply.file_id,
        volume_serial_number: reply.volume_serial_number,
        filesystem: reply.filesystem,
        chain_length: reply.chain_length,
      });
    const sendDirectory = (
      operation: DirectoryOperation,
      target = directoryReply,
      component?: string,
      maxBytes?: number
    ) => {
      if (finished || closing || failure || directoryOperation || sentCount >= 15)
        throw new Error("Directory session unavailable");
      const body = {
        client_nonce: request.client_nonce,
        kind: operation === "read-file" ? "file_request" : "directory_request",
        operation,
        operation_id: randomUUID(),
        protocol_version: WINDOWS_BOUNDARY_PROTOCOL_VERSION,
        request_id: randomUUID(),
        session_nonce: sessionNonce!,
        ...(component === undefined ? {} : { component }),
        ...(operation === "read-file" ? { max_bytes: maxBytes } : {}),
        ...(operation === "acquire"
          ? { path: directory!.path }
          : { lease_token: target!.lease_token }),
      };
      const requestDigest = `sha256:${createHash("sha256").update(canonicalJSONStringify(body)).digest("hex")}`;
      const frame = encodeWindowsBoundarySession({ ...body, request_digest: requestDigest });
      exchange!.reserve(
        {
          request_id: body.request_id,
          operation_id: body.operation_id,
          request_digest: requestDigest,
        },
        settings.handshakeTimeoutMs
      );
      directoryOperation = operation;
      directoryTarget = target;
      childComponent = component;
      readLimit = maxBytes;
      sentCount++;
      clearTimeout(handshakeTimer);
      handshakeTimer = setTimeout(() => fail("operation_timeout"), settings.handshakeTimeoutMs);
      child.stdin.write(frame);
    };
    const scopeFor = (target: DirectoryReply): OwnedWindowsDirectoryScope => {
      const invoke = <T>(
        operation: DirectoryOperation,
        component: string | undefined,
        convert: (reply: ScopeReply) => T,
        maxBytes?: number
      ): Promise<T> => {
        const pending = new Promise<ScopeReply>((resolveAssertion, reject) => {
          if (!working || finished || failure || closing) throw new Error("Directory scope ended");
          if (performance.now() >= workDeadline) {
            fail("work_timeout");
            throw new Error("Directory work timed out");
          }
          const child = operation !== "assert" && operation !== "read-file";
          if (
            operation === "read-file" &&
            (!Number.isSafeInteger(maxBytes) || maxBytes! < 0 || maxBytes! > 1024)
          ) {
            fail("work_failed");
            throw new Error("Invalid read bound");
          }
          if (
            operation !== "assert" &&
            (typeof component !== "string" ||
              component.length < 1 ||
              component.length > 255 ||
              component === "." ||
              component === ".." ||
              /[<>:"/\\|?*\u0000-\u001f]/u.test(component) ||
              /[. ]$/u.test(component))
          ) {
            fail("work_failed");
            throw new Error("Invalid child component");
          }
          if (assertion || sentCount + 1 + liveDirectories.length + (child ? 1 : 0) > 15) {
            fail("work_failed");
            throw new Error("Directory operation limit or concurrent request");
          }
          assertion = { resolve: resolveAssertion, reject };
          try {
            sendDirectory(operation, target, component, maxBytes);
          } catch {
            fail("protocol_error");
          }
        });
        // An accidentally unawaited operation still fails the scope, without an
        // unhandled rejection escaping the process owner. Awaiters retain rejection.
        const converted = pending.then(convert);
        void converted.catch(() => {});
        return converted;
      };
      return Object.freeze({
        identity: identity(target),
        assertCurrent: () =>
          invoke("assert", undefined, (reply) => identity(directoryValue(reply))),
        openChild: (component: string) =>
          invoke("open-child", component, (reply) => scopeFor(directoryValue(reply))),
        tryOpenChild: (component: string) =>
          invoke("try-open-child", component, (reply) =>
            reply ? scopeFor(directoryValue(reply)) : null
          ),
        createChild: (component: string) =>
          invoke("create-child", component, (reply) => scopeFor(directoryValue(reply))),
        readFile: (component: string, maxBytes: number) =>
          invoke(
            "read-file",
            component,
            (reply) => {
              if (!reply || reply.kind !== "file_read") throw new Error("Unexpected file response");
              return reply;
            },
            maxBytes
          ),
      });
    };
    const releaseNext = () =>
      sendDirectory("release", liveDirectories[liveDirectories.length - 1]!);
    const startWork = () => {
      working = true;
      workDeadline = performance.now() + directory!.workTimeoutMs;
      workTimer = setTimeout(() => fail("work_timeout"), directory!.workTimeoutMs);
      const scope = scopeFor(directoryReply!);
      Promise.resolve()
        .then(() => {
          if (!working) throw new Error("Directory scope ended");
          return directory!.work(scope);
        })
        .then(
          () => {
            if (!working || failure || finished) return;
            if (performance.now() >= workDeadline) {
              fail("work_timeout");
              return;
            }
            working = false;
            clearTimeout(workTimer);
            if (assertion) {
              fail("work_failed");
              return;
            }
            try {
              releaseNext();
            } catch {
              fail("protocol_error");
            }
          },
          () => fail("work_failed")
        );
    };
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
          if (seenReply && directory && message.kind === "file_result") {
            if (
              directoryOperation !== "read-file" ||
              !directoryTarget ||
              readLimit === undefined ||
              !assertion
            ) {
              fail("protocol_error");
              return;
            }
            const bytes = Buffer.from(message.content_base64, "base64");
            const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
            if (
              message.lease_token !== directoryTarget.lease_token ||
              message.volume_serial_number !== directoryTarget.volume_serial_number ||
              bytes.length !== message.byte_length ||
              bytes.length > readLimit ||
              bytes.toString("base64") !== message.content_base64 ||
              digest !== message.content_sha256
            ) {
              fail("protocol_error");
              return;
            }
            const match = exchange!.correlate({
              client_nonce: message.client_nonce,
              session_nonce: message.session_nonce,
              request_id: message.request_id,
              operation_id: message.operation_id,
              request_digest: message.request_digest,
            });
            if (!match.correlated) {
              fail(match.failure.reason === "deadline" ? "operation_timeout" : "protocol_error");
              return;
            }
            clearTimeout(handshakeTimer);
            operationCount++;
            filesRead++;
            bytesRead += bytes.length;
            directoryOperation = undefined;
            const waiter = assertion;
            assertion = undefined;
            waiter.resolve(
              Object.freeze({
                kind: "file_read",
                bytes: Uint8Array.from(bytes),
                contentSha256: digest,
                fileId: message.file_id,
                volumeSerialNumber: message.volume_serial_number,
              })
            );
            continue;
          }
          if (seenReply && directory && message.kind === "directory_result") {
            const childOperation =
              directoryOperation === "open-child" ||
              directoryOperation === "try-open-child" ||
              directoryOperation === "create-child";
            const missing =
              directoryOperation === "try-open-child" && message.status === "child-missing";
            const expectedStatus =
              directoryOperation === "acquire"
                ? "acquired"
                : directoryOperation === "assert"
                  ? "current"
                  : childOperation
                    ? missing
                      ? "child-missing"
                      : directoryOperation === "create-child"
                        ? "child-created"
                        : "child-opened"
                    : "released";
            if (
              !directoryOperation ||
              directoryOperation === "read-file" ||
              message.status !== expectedStatus ||
              (childOperation && !missing
                ? !directoryTarget ||
                  message.path.toLowerCase() !==
                    win32.join(directoryTarget.path, childComponent!).toLowerCase() ||
                  message.chain_length !== directoryTarget.chain_length + 1 ||
                  message.volume_serial_number !== directoryTarget.volume_serial_number ||
                  message.filesystem !== directoryTarget.filesystem ||
                  liveDirectories.some((item) => item.lease_token === message.lease_token)
                : directoryTarget
                  ? message.lease_token !== directoryTarget.lease_token ||
                    canonicalJSONStringify(identity(message)) !==
                      canonicalJSONStringify(identity(directoryTarget))
                  : message.path.toLowerCase() !== directory!.path.toLowerCase())
            ) {
              fail("protocol_error");
              return;
            }
            const match = exchange!.correlate({
              client_nonce: message.client_nonce,
              session_nonce: message.session_nonce,
              request_id: message.request_id,
              operation_id: message.operation_id,
              request_digest: message.request_digest,
            });
            if (!match.correlated) {
              fail(match.failure.reason === "deadline" ? "operation_timeout" : "protocol_error");
              return;
            }
            clearTimeout(handshakeTimer);
            operationCount++;
            const operation = directoryOperation;
            directoryOperation = undefined;
            if (operation === "acquire") {
              directoryReply = message;
              liveDirectories.push(message);
              startWork();
            } else if (operation === "assert" || childOperation) {
              if (operation === "assert") assertions++;
              else if (!missing) {
                liveDirectories.push(message);
                childrenAcquired++;
              }
              const waiter = assertion;
              assertion = undefined;
              waiter!.resolve(missing ? null : message);
            } else {
              const released = liveDirectories.pop()!;
              if (released !== directoryReply) childrenReleased++;
              if (liveDirectories.length) releaseNext();
              else {
                releaseAcknowledged = true;
                close();
              }
            }
            continue;
          }
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
          if (sessionMode) {
            sessionNonce = message.session_nonce;
            exchange = new WindowsBoundaryExchange({
              client_nonce: request.client_nonce,
              session_nonce: sessionNonce,
            });
            if (directory) sendDirectory("acquire");
            else sendStatus();
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
