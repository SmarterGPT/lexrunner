import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { loadPlan } from "../schema.js";
import { computeMergeOrder } from "../mergeOrder.js";
import { canonicalJSONStringify } from "../util/canonicalJson.js";
import { fileIdentity } from "../gates/execution-receipt.js";
import {
  captureGateCandidateIdentity,
  GateCandidateIdentitySchema,
  resolveGateRepositoryRoot,
  sameGateCandidate,
} from "./gate-candidate-identity.js";
import {
  GateExecutionService,
  assertGateSelectionExists,
  type BoundedGateRunResult,
} from "./gate-execution-service.js";
import { loadGateEvidence } from "./gate-evidence-service.js";
import { PlanArtifactService } from "./plan-artifact-service.js";
import type { RetainedGateEvidenceReport } from "./retained-gate-evidence.js";

const HASH = /^sha256:[a-f0-9]{64}$/u;
const MAX_BYTES = 4 * 1024 * 1024;
const HEARTBEAT_MS = 2000;
const STALE_MS = 15000;
const pathSchema = z.string().min(1).max(4096);
export const GateOperationStartArgs = z
  .object({
    repoRoot: pathSchema,
    planFile: pathSchema,
    outDir: pathSchema,
    idempotencyKey: z.string().min(1).max(128),
    onlyItem: z.string().min(1).max(512).optional(),
    onlyGate: z.string().min(1).max(512).optional(),
    timeoutMs: z.number().int().min(1).max(86_400_000).optional(),
  })
  .strict();
export const GateOperationObserveArgs = z
  .object({
    repoRoot: pathSchema,
    operationFile: pathSchema,
    operationSha256: z.string().regex(HASH),
  })
  .strict();
export const GateOperationStartJsonSchema = z.toJSONSchema(GateOperationStartArgs);
export const GateOperationObserveJsonSchema = z.toJSONSchema(GateOperationObserveArgs);
export const GateOperationStatusArgs = GateOperationObserveArgs.extend({
  verifyArtifacts: z.boolean().optional(),
});
export const GateOperationStatusJsonSchema = z.toJSONSchema(GateOperationStatusArgs);
export type GateOperationStartInput = z.infer<typeof GateOperationStartArgs>;
export type GateOperationHandle = z.infer<typeof GateOperationObserveArgs>;
export type GateOperationStatusInput = z.infer<typeof GateOperationStatusArgs>;

const codeIdentity = z.object({ path: pathSchema, sha256: z.string().regex(HASH) }).strict();
const Descriptor = z
  .object({
    schemaVersion: z.literal("lexrunner-gate-operation/v1"),
    operationId: z.string().regex(/^[a-f0-9]{64}$/u),
    idempotencyKey: z.string().min(1).max(128),
    requestDigest: z.string().regex(HASH),
    createdAt: z.iso.datetime(),
    directory: pathSchema,
    candidate: GateCandidateIdentitySchema,
    plan: z.unknown(),
    onlyItem: z.string().min(1).max(512).optional(),
    onlyGate: z.string().min(1).max(512).optional(),
    timeoutMs: z.number().int().min(1).max(86_400_000).optional(),
    worker: codeIdentity,
    node: codeIdentity,
  })
  .strict();
type OperationDescriptor = z.infer<typeof Descriptor>;
const WorkerState = z
  .object({
    operationSha256: z.string().regex(HASH),
    state: z.enum(["running", "cancel_requested"]),
    updatedAt: z.iso.datetime(),
    pid: z.number().int().positive(),
  })
  .strict();
const Terminal = z
  .object({
    operationSha256: z.string().regex(HASH),
    state: z.enum(["completed", "cancelled", "failed"]),
    finishedAt: z.iso.datetime(),
    result: z.unknown().optional(),
    errorCode: z.string().min(1).max(128).optional(),
    deferredHeartbeatPublications: z.number().int().nonnegative().optional(),
  })
  .strict();
const Cancel = z
  .object({
    operationSha256: z.string().regex(HASH),
    requestedAt: z.iso.datetime(),
    mode: z.literal("after-active-gates"),
  })
  .strict();

export class GateOperationServiceError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "GateOperationServiceError";
  }
}
function fail(code: string, message: string): never {
  throw new GateOperationServiceError(code, message);
}
function hash(bytes: string | Buffer): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}
function readBounded(file: string): Buffer {
  const pathBefore = lstatSync(file, { bigint: true });
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.size > BigInt(MAX_BYTES)) {
    fail("GATE_OPERATION_INVALID", "Operation artifact must be a bounded regular file");
  }
  const fd = openSync(file, "r");
  try {
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.dev !== pathBefore.dev ||
      before.ino !== pathBefore.ino ||
      before.size > BigInt(MAX_BYTES)
    )
      fail("GATE_OPERATION_INVALID", "Operation artifact identity changed");
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytes = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!bytes) break;
      offset += bytes;
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      BigInt(offset) !== before.size ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.dev !== after.dev ||
      before.ino !== after.ino
    ) {
      fail("GATE_OPERATION_INVALID", "Operation artifact changed during bounded acquisition");
    }
    // A complete opened version remains readable during atomic namespace publication.
    // Link removal changes ctime, and heartbeat replacement changes the pathname inode;
    // neither changes these acquired bytes. Immutable callers additionally verify SHA-256.
    return buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}
function jsonFile(file: string): unknown {
  return JSON.parse(readBounded(file).toString("utf8"));
}
function exclusiveJson(file: string, value: unknown, overwrite = false): void {
  const bytes = canonicalJSONStringify(value);
  if (Buffer.byteLength(bytes) > MAX_BYTES)
    fail("GATE_OPERATION_INVALID", "Operation artifact exceeds its byte budget");
  const temporary = file + "." + process.pid + "." + randomUUID() + ".pending";
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    // Atomic publication of complete fsynced bytes; link refuses existing claims.
    if (overwrite) renameSync(temporary, file);
    else linkSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
function atomicJson(file: string, value: unknown): boolean {
  try {
    exclusiveJson(file, value, true);
    return true;
  } catch (error) {
    const problem = error as NodeJS.ErrnoException;
    if (
      process.platform === "win32" &&
      problem.syscall === "rename" &&
      ["EPERM", "EACCES", "EBUSY"].includes(problem.code ?? "")
    ) {
      // Win32 readers may deny namespace replacement. Keep the prior complete
      // observation and try the next heartbeat; stale observations remain unknown.
      return false;
    }
    throw error;
  }
}
function identity(file: string): z.infer<typeof codeIdentity> {
  const observed = fileIdentity(realpathSync(file));
  if (!observed)
    fail("GATE_OPERATION_WORKER_UNAVAILABLE", "The operation executable is unavailable");
  return { path: realpathSync(file), sha256: observed.sha256 };
}
function requestBinding(value: OperationDescriptor): unknown {
  return {
    idempotencyKey: value.idempotencyKey,
    directory: value.directory,
    candidate: value.candidate,
    plan: loadPlan(canonicalJSONStringify(value.plan)),
    onlyItem: value.onlyItem,
    onlyGate: value.onlyGate,
    timeoutMs: value.timeoutMs,
    worker: value.worker,
    node: value.node,
  };
}
function descriptorAt(handle: GateOperationHandle): OperationDescriptor {
  const bytes = readBounded(handle.operationFile);
  if (hash(bytes) !== handle.operationSha256)
    fail("GATE_OPERATION_DIGEST_MISMATCH", "Operation descriptor digest does not match");
  const descriptor = Descriptor.parse(JSON.parse(bytes.toString("utf8")));
  const root = resolveGateRepositoryRoot(handle.repoRoot);
  if (
    root !== descriptor.candidate.repositoryRoot ||
    realpathSync(descriptor.directory) !== dirname(realpathSync(handle.operationFile)) ||
    resolve(handle.operationFile) !== join(descriptor.directory, "operation.json") ||
    descriptor.operationId !==
      createHash("sha256").update(descriptor.idempotencyKey).digest("hex") ||
    hash(canonicalJSONStringify(requestBinding(descriptor))) !== descriptor.requestDigest
  ) {
    fail(
      "GATE_OPERATION_BINDING_MISMATCH",
      "Operation repository or request binding does not match"
    );
  }
  return descriptor;
}
function cancellationObserved(descriptor: OperationDescriptor, operationSha256: string): boolean {
  const file = join(descriptor.directory, "cancel.json");
  if (!existsSync(file)) return false;
  const request = Cancel.parse(jsonFile(file));
  if (request.operationSha256 !== operationSha256)
    fail("GATE_OPERATION_BINDING_MISMATCH", "Cancellation request does not match the operation");
  return true;
}

/** Explicit artifact-backed execution observation, never coordination or merge authority. */
export class GateOperationService {
  async start(raw: GateOperationStartInput): Promise<{
    contract: "gate-operation-handle/v1";
    operation: GateOperationHandle;
    reused: boolean;
    cancellationMode: "after-active-gates";
  }> {
    const input = GateOperationStartArgs.parse(raw);
    const repoRoot = resolveGateRepositoryRoot(input.repoRoot);
    const artifact = new PlanArtifactService().resolve({
      workingDir: repoRoot,
      planFile: input.planFile,
    });
    assertGateSelectionExists({
      plan: artifact.plan,
      onlyItem: input.onlyItem,
      onlyGate: input.onlyGate,
    });
    for (const item of artifact.plan.items) {
      if (input.onlyItem && item.name !== input.onlyItem) continue;
      for (const gate of item.gates) {
        if (input.onlyGate && gate.name !== input.onlyGate) continue;
        if (gate.runtime !== "local" || gate.name === "vuln") {
          fail(
            "GATE_OPERATION_RUNTIME_UNSUPPORTED",
            "Durable operations require local command gates with execution receipts"
          );
        }
        if (gate.input !== undefined) {
          fail(
            "GATE_OPERATION_INPUT_UNSUPPORTED",
            "Durable operations require command gates without pre-execution input validators"
          );
        }
      }
    }
    mkdirSync(resolve(repoRoot, input.outDir), { recursive: true });
    const artifactRoot = realpathSync(resolve(repoRoot, input.outDir));
    const operationId = createHash("sha256").update(input.idempotencyKey).digest("hex");
    const directory = join(artifactRoot, "gate-operation-" + operationId);
    const workerPath = join(
      dirname(createRequire(import.meta.url).resolve("@smartergpt/lexrunner")),
      "gate-worker.js"
    );
    const descriptor: OperationDescriptor = {
      schemaVersion: "lexrunner-gate-operation/v1",
      operationId,
      idempotencyKey: input.idempotencyKey,
      createdAt: new Date().toISOString(),
      directory,
      candidate: captureGateCandidateIdentity(repoRoot, directory),
      plan: artifact.plan,
      onlyItem: input.onlyItem,
      onlyGate: input.onlyGate,
      timeoutMs: input.timeoutMs,
      worker: identity(workerPath),
      node: identity(process.execPath),
      requestDigest: "sha256:" + "0".repeat(64),
    };
    descriptor.requestDigest = hash(canonicalJSONStringify(requestBinding(descriptor)));
    const operationFile = join(directory, "operation.json");
    let reused = false;
    try {
      mkdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      reused = true;
    }
    if (reused) {
      if (!existsSync(operationFile))
        fail(
          "GATE_OPERATION_ADMISSION_UNCERTAIN",
          "An admission exists without a descriptor; no worker was relaunched"
        );
      const previous = Descriptor.parse(jsonFile(operationFile));
      if (previous.requestDigest !== descriptor.requestDigest)
        fail(
          "GATE_OPERATION_IDEMPOTENCY_CONFLICT",
          "The idempotency key already binds different inputs"
        );
    } else {
      exclusiveJson(operationFile, descriptor);
    }
    const operation = {
      repoRoot,
      operationFile,
      operationSha256: hash(readBounded(operationFile)),
    };
    descriptorAt(operation);
    if (!reused) {
      // The durable claim precedes launch. Lost acknowledgements never authorize another launch.
      await new Promise<void>((resolveSpawn) => {
        const child = spawn(
          descriptor.node.path,
          [descriptor.worker.path, operationFile, operation.operationSha256],
          {
            cwd: repoRoot,
            detached: true,
            windowsHide: true,
            stdio: "ignore",
            env: { ...process.env, ALLOW_MUTATIONS: "false", LEX_FRAME_EMISSION: "false" },
          }
        );
        child.once("error", () => {
          try {
            exclusiveJson(join(directory, "terminal.json"), {
              operationSha256: operation.operationSha256,
              state: "failed",
              finishedAt: new Date().toISOString(),
              errorCode: "GATE_OPERATION_LAUNCH_FAILED",
            });
          } catch {
            // The retained admission remains unknown if launch failure cannot be published.
          } finally {
            resolveSpawn();
          }
        });
        child.once("spawn", () => {
          child.unref();
          resolveSpawn();
        });
      });
    }
    return {
      contract: "gate-operation-handle/v1",
      operation,
      reused,
      cancellationMode: "after-active-gates",
    };
  }

  status(raw: GateOperationStatusInput): Record<string, unknown> {
    const { verifyArtifacts, ...handle } = GateOperationStatusArgs.parse(raw);
    const descriptor = descriptorAt(handle);
    const terminalFile = join(descriptor.directory, "terminal.json");
    const base = {
      contract: "gate-operation-observation/v1",
      operation: handle,
      authority: "unverified",
      candidate: descriptor.candidate,
      cancellationMode: "after-active-gates",
    };
    if (existsSync(terminalFile)) {
      const terminalBytes = readBounded(terminalFile);
      const terminal = Terminal.parse(JSON.parse(terminalBytes.toString("utf8")));
      if (terminal.operationSha256 !== handle.operationSha256)
        fail("GATE_OPERATION_BINDING_MISMATCH", "Terminal result does not match the operation");
      if (terminal.state !== "completed")
        return {
          ...base,
          state: terminal.state,
          finishedAt: terminal.finishedAt,
          errorCode: terminal.errorCode,
          deferredHeartbeatPublications: terminal.deferredHeartbeatPublications,
        };
      let artifactVerification: RetainedGateEvidenceReport | undefined;
      try {
        const result = terminal.result as BoundedGateRunResult;
        const manifest = result?.artifactRefs?.find((ref) => ref.kind === "gate-evidence-manifest");
        if (
          !manifest ||
          !("sha256" in manifest) ||
          dirname(resolve(manifest.path)) !== descriptor.directory
        )
          throw new Error("Invalid evidence reference");
        const indexedBytes = readBounded(manifest.path);
        if (hash(indexedBytes) !== manifest.sha256) throw new Error("Evidence digest changed");
        const indexed = JSON.parse(indexedBytes.toString("utf8")) as {
          candidate?: unknown;
          selection?: { onlyItem: string | null; onlyGate: string | null };
          entries?: Array<{ item: string; gate: string }>;
        };
        if (
          !sameGateCandidate(
            descriptor.candidate,
            GateCandidateIdentitySchema.parse(indexed.candidate)
          )
        ) {
          throw new Error("Evidence does not match the admitted candidate");
        }
        if (
          indexed.selection?.onlyItem !== (descriptor.onlyItem ?? null) ||
          indexed.selection?.onlyGate !== (descriptor.onlyGate ?? null) ||
          !Array.isArray(indexed.entries) ||
          indexed.entries.some(
            (entry) =>
              (descriptor.onlyItem !== undefined && entry.item !== descriptor.onlyItem) ||
              (descriptor.onlyGate !== undefined && entry.gate !== descriptor.onlyGate)
          )
        ) {
          throw new Error("Evidence does not match the admitted selection");
        }
        const evidence = loadGateEvidence({
          plan: loadPlan(canonicalJSONStringify(descriptor.plan)),
          repoRoot: handle.repoRoot,
          evidenceFile: manifest.path,
          evidenceSha256: manifest.sha256,
          verifyArtifacts,
          additionalReferences: [
            {
              kind: "operation-descriptor",
              path: handle.operationFile,
              sha256: handle.operationSha256,
            },
            { kind: "operation-terminal", path: terminalFile, sha256: hash(terminalBytes) },
          ],
        });
        artifactVerification = evidence.artifactVerification;
        const plan = loadPlan(canonicalJSONStringify(descriptor.plan));
        for (const name of computeMergeOrder(plan).flat()) {
          if (descriptor.onlyItem && name !== descriptor.onlyItem) continue;
          const item = plan.items.find((value) => value.name === name)!;
          const observed = evidence.executionState.getNodeResult(name)!;
          const blockedBy = item.deps.filter(
            (dep) => evidence.executionState.getNodeResult(dep)?.status !== "pass"
          );
          if (blockedBy.length) {
            if (observed.gates.length)
              throw new Error("Commands ran before their prerequisites passed");
            evidence.executionState.blockNode(name, blockedBy);
            continue;
          }
          for (const gate of item.gates) {
            if (descriptor.onlyGate && gate.name !== descriptor.onlyGate) continue;
            if (plan.policy?.blockOn.some((pattern) => gate.name.includes(pattern))) {
              if (observed.gates.some((value) => value.gate === gate.name))
                throw new Error("A blocked command has execution evidence");
              evidence.executionState.updateGateResult(name, {
                gate: gate.name,
                status: "blocked",
                attempts: 0,
              });
            }
          }
          evidence.executionState.completeNodeExecution(name);
        }
        const expected = [...evidence.executionState.getResults().entries()]
          .filter(([name]) => !descriptor.onlyItem || name === descriptor.onlyItem)
          .map(([name, value]) => ({
            name,
            status: value.status,
            gates: value.gates
              .filter((gate) => !descriptor.onlyGate || gate.gate === descriptor.onlyGate)
              .map((gate) => ({ name: gate.gate, status: gate.status }))
              .sort((left, right) => {
                const gates = plan.items.find((item) => item.name === name)!.gates;
                return (
                  gates.findIndex((gate) => gate.name === left.name) -
                  gates.findIndex((gate) => gate.name === right.name)
                );
              }),
          }));
        const actual = result.items.map((item) => ({
          name: item.name,
          status: item.status,
          gates: item.gates.map((gate) => ({ name: gate.name, status: gate.status })),
        }));
        if (
          canonicalJSONStringify(expected) !== canonicalJSONStringify(actual) ||
          result.allGreen !== expected.every((item) => item.status === "pass") ||
          (verifyArtifacts !== true &&
            !sameGateCandidate(
              descriptor.candidate,
              captureGateCandidateIdentity(handle.repoRoot, descriptor.directory)
            ))
        )
          throw new Error("Invalid result projection");
        const observedResult = {
          contract: "bounded-ax-v1",
          items: expected,
          allGreen: result.allGreen,
          artifactRefs: [{ kind: "gate-results-directory", path: descriptor.directory }, manifest],
        };
        if (evidence.artifactVerification?.status === "incomplete") {
          return {
            ...base,
            state: "unknown",
            lastReportedState: "completed",
            errorCode: "GATE_OPERATION_ARTIFACTS_INCOMPLETE",
            recordedOutcome: result.allGreen ? "pass" : "fail",
            artifactVerification: evidence.artifactVerification,
          };
        }
        return {
          ...base,
          state: "completed",
          outcome: result.allGreen ? "pass" : "fail",
          finishedAt: terminal.finishedAt,
          result: observedResult,
          deferredHeartbeatPublications: terminal.deferredHeartbeatPublications,
          terminalArtifact: { path: terminalFile, sha256: hash(terminalBytes) },
          ...(evidence.artifactVerification
            ? { artifactVerification: evidence.artifactVerification }
            : {}),
        };
      } catch {
        return {
          ...base,
          state: "unknown",
          lastReportedState: "completed",
          errorCode:
            artifactVerification?.status === "incomplete"
              ? "GATE_OPERATION_ARTIFACTS_INCOMPLETE"
              : "GATE_OPERATION_EVIDENCE_INVALID",
          ...(artifactVerification ? { artifactVerification } : {}),
        };
      }
    }
    const cancelRequested = cancellationObserved(descriptor, handle.operationSha256);
    const stateFile = join(descriptor.directory, "worker-state.json");
    if (!existsSync(stateFile))
      return {
        ...base,
        state: "unknown",
        cancelRequested,
        reason: "No worker observation; do not relaunch",
      };
    const worker = WorkerState.parse(jsonFile(stateFile));
    if (worker.operationSha256 !== handle.operationSha256)
      fail("GATE_OPERATION_BINDING_MISMATCH", "Worker observation does not match the operation");
    const ageMs = Date.now() - Date.parse(worker.updatedAt);
    return {
      ...base,
      state: ageMs < 0 || ageMs > STALE_MS ? "unknown" : worker.state,
      lastReportedState: worker.state,
      observedAt: worker.updatedAt,
      observationAgeMs: ageMs,
      producerReportedPid: worker.pid,
      cancelRequested,
    };
  }

  cancel(raw: GateOperationHandle): Record<string, unknown> {
    const handle = GateOperationObserveArgs.parse(raw);
    const descriptor = descriptorAt(handle);
    if (existsSync(join(descriptor.directory, "terminal.json"))) return this.status(handle);
    const file = join(descriptor.directory, "cancel.json");
    if (!existsSync(file)) {
      try {
        exclusiveJson(file, {
          operationSha256: handle.operationSha256,
          requestedAt: new Date().toISOString(),
          mode: "after-active-gates",
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    cancellationObserved(descriptor, handle.operationSha256);
    return {
      contract: "gate-operation-cancel-request/v1",
      operation: handle,
      cancelRequested: true,
      cancellationMode: "after-active-gates",
      terminalAcknowledged: false,
    };
  }
}

/** Runs only in the detached packaged worker; transport cancellation is never passed here. */
export async function runGateOperationWorker(
  operationFile: string,
  operationSha256: string
): Promise<void> {
  // Acquire the descriptor by hash before accepting its repository selector.
  const bytes = readBounded(operationFile);
  if (hash(bytes) !== operationSha256)
    fail("GATE_OPERATION_DIGEST_MISMATCH", "Worker descriptor digest does not match");
  const initial = Descriptor.parse(JSON.parse(bytes.toString("utf8")));
  const handle = { operationFile, operationSha256, repoRoot: initial.candidate.repositoryRoot };
  const descriptor = descriptorAt(handle);
  const terminalFile = join(descriptor.directory, "terminal.json");
  // Even an accidentally duplicated worker cannot execute the admitted commands again.
  try {
    exclusiveJson(join(descriptor.directory, "worker-claim.json"), {
      operationSha256,
      pid: process.pid,
      claimedAt: new Date().toISOString(),
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  let cancelled = false;
  const shouldCancel = () => {
    if (!cancelled) cancelled = cancellationObserved(descriptor, operationSha256);
    return cancelled;
  };
  let deferredHeartbeatPublications = 0;
  const heartbeat = () => {
    const published = atomicJson(join(descriptor.directory, "worker-state.json"), {
      operationSha256,
      state: shouldCancel() ? "cancel_requested" : "running",
      updatedAt: new Date().toISOString(),
      pid: process.pid,
    });
    if (!published)
      deferredHeartbeatPublications = Math.min(1_000_000, deferredHeartbeatPublications + 1);
  };
  let heartbeatFailure = false;
  const timer = setInterval(() => {
    try {
      heartbeat();
    } catch {
      heartbeatFailure = true;
      cancelled = true;
    }
  }, HEARTBEAT_MS);
  try {
    if (
      identity(process.execPath).sha256 !== descriptor.node.sha256 ||
      identity(descriptor.worker.path).sha256 !== descriptor.worker.sha256
    )
      fail("GATE_OPERATION_WORKER_CHANGED", "Worker executable identity changed after admission");
    heartbeat();
    const result = await new GateExecutionService().run({
      plan: loadPlan(canonicalJSONStringify(descriptor.plan)),
      repoRoot: descriptor.candidate.repositoryRoot,
      expectedCandidate: descriptor.candidate,
      artifactDir: descriptor.directory,
      preparedArtifactDir: descriptor.directory,
      onlyItem: descriptor.onlyItem,
      onlyGate: descriptor.onlyGate,
      timeoutMs: descriptor.timeoutMs,
      options: { emitReceipt: false, suppressStdout: true, shouldCancel },
    });
    if (heartbeatFailure)
      fail("GATE_OPERATION_OBSERVATION_FAILED", "Worker observation could not be retained");
    const state = shouldCancel() ? "cancelled" : "completed";
    exclusiveJson(terminalFile, {
      operationSha256,
      state,
      finishedAt: new Date().toISOString(),
      deferredHeartbeatPublications,
      ...(state === "completed" ? { result: result.summary } : {}),
    });
  } catch (error) {
    exclusiveJson(terminalFile, {
      operationSha256,
      state: "failed",
      finishedAt: new Date().toISOString(),
      deferredHeartbeatPublications,
      errorCode:
        error instanceof GateOperationServiceError
          ? error.code
          : error && typeof error === "object" && "code" in error
            ? String(error.code).slice(0, 128)
            : "GATE_OPERATION_EXECUTION_FAILED",
    });
  } finally {
    clearInterval(timer);
  }
}
