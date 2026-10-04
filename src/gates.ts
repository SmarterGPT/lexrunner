import { spawn } from "child_process";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  Plan,
  Gate,
  PlanItem,
  Policy,
  GateResult,
  GateStatus,
  RetryConfig,
  type PerformanceConfig,
} from "./schema.js";
import { ExecutionState } from "./executionState.js";
import path from "path";
import fs from "fs";
import { classifyError, formatErrorForUser, ErrorType } from "./core/errorRecovery.js";
import { MemoryMonitor, OperationCache } from "./performance.js";
import { metrics, METRICS } from "./monitoring/metrics.js";
import { parseSarif } from "./security/sarif.js";
import {
  SecurityScanResult,
  DEFAULT_SECURITY_POLICY,
  SecurityPolicy,
  NpmAuditScanner,
} from "./security/scanning.js";
import { FlakeReport, AttemptRecord } from "./schema/flakeReport.js";
import { canonicalJSONStringify } from "./util/canonicalJson.js";
import { ProgressReporter } from "./util/progress.js";
import { validateGateInput } from "./gates/validator.js";
import { wrapGateFailure, logGateFailure, type FailureHandlingPayload } from "./runs/failures.js";
import { emitGateFrame } from "./frames/index.js";
import type { FrameEmitResult } from "./frames/types.js";
import { emitGateReceipt } from "./weave/receiptHelper.js";
import type { ActionReceipt } from "./receipts/schema.js";
import { runEnvironmentQualityCheck } from "./hostility/index.js";
import {
  calculateHostilityAdjustedTimeout,
  logTimeoutAdjustment,
} from "./governance/timeoutAdjustment.js";
import type { MergeWeaveTurnCost } from "./metrics/turncost.js";
import {
  createCounterExampleFromGate,
  type CounterExampleClassification,
} from "./learning/counter-example.js";
import {
  promptCounterExampleClassification,
  createAutoRecordClassification,
} from "./learning/prompts.js";
import { storeCounterExample } from "./learning/storage.js";
import { terminateProcessTree, type ProcessTreeTerminationResult } from "./process/process-tree.js";
import {
  captureDeclaredArtifactBaselines,
  collectFreshGateArtifacts,
  fileIdentity,
  gateOutputEvidence,
  GATE_EXECUTION_RECEIPT_SCHEMA_VERSION,
  gateExecutionBinding,
  resolveSpawnExecutable,
  writeLocalGateExecutionReceipt,
  type DeclaredArtifactBaseline,
  type GateArtifactFileIdentity,
} from "./gates/execution-receipt.js";

export interface LocalGateShellInvocation {
  command: "bash" | "pwsh";
  arguments: string[];
}

/** Resolve the host-native shell used for a frozen local gate command. */
export function resolveLocalGateShell(
  command: string,
  platform: NodeJS.Platform = process.platform
): LocalGateShellInvocation {
  return platform === "win32"
    ? {
        command: "pwsh",
        arguments: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      }
    : { command: "bash", arguments: ["-c", command] };
}

function sanitizedGateEnvironment(declared: Record<string, string>): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase().startsWith("GIT_")) delete environment[key];
  }
  return { ...environment, ...declared };
}

export function artifactIdentitySegment(identity: string): string {
  return `identity-${createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 32)}`;
}

/**
 * Gate execution with local command running, retry logic, and policy-aware execution
 */

/**
 * Execute a single gate with retry logic and artifact collection
 */
export async function executeGate(
  gate: Gate,
  policy: Policy,
  artifactDir: string,
  timeoutMs: number = 30000,
  itemName?: string,
  skipValidation: boolean = false,
  repoRoot?: string,
  turnCostTracker?: MergeWeaveTurnCost,
  suppressStdout: boolean = false,
  candidateDigest?: string,
  resolvedWorkingDirectory?: string,
  shouldCancel?: () => boolean
): Promise<GateResult> {
  if (shouldCancel?.()) return cancelledGateAdmission(gate.name);
  // Validate gate input before execution (unless explicitly skipped)
  if (!skipValidation && gate.input) {
    try {
      validateGateInput(gate.name, gate.input);
    } catch (error) {
      // Return validation error as a failed gate result
      return {
        gate: gate.name,
        status: "fail",
        exitCode: 1,
        duration: 0,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        artifacts: [],
        attempts: 0,
        lastAttempt: new Date().toISOString(),
      };
    }
  }

  const retryConfig = policy.retries[gate.name] || { maxAttempts: 1, backoffSeconds: 0 };
  let lastResult: GateResult | null = null;
  const attemptRecords: AttemptRecord[] = [];
  let totalDuration = 0;

  for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
    if (shouldCancel?.()) return stopGateRetries(gate.name, lastResult);
    // Add backoff delay for retries
    if (attempt > 1 && retryConfig.backoffSeconds > 0) {
      const delayMs = retryConfig.backoffSeconds * 1000;
      if (!suppressStdout) {
        console.log(
          `⏳ Retrying gate '${gate.name}' (attempt ${attempt}/${retryConfig.maxAttempts}) after ${retryConfig.backoffSeconds}s delay...`
        );
      }
      if (!(await waitForGateRetry(delayMs, shouldCancel))) {
        return stopGateRetries(gate.name, lastResult);
      }
    }
    if (shouldCancel?.()) return stopGateRetries(gate.name, lastResult);

    const result = await executeGateAttempt(
      gate,
      artifactDir,
      attempt,
      timeoutMs,
      repoRoot,
      itemName,
      candidateDigest,
      resolvedWorkingDirectory,
      shouldCancel
    );
    if (result.attempts === 0 && shouldCancel?.()) {
      return stopGateRetries(gate.name, lastResult);
    }
    lastResult = result;
    totalDuration += result.duration || 0;

    // Cooperative cancellation drains the admitted command. Its observed outcome
    // stays intact, but a cancellation request never admits a retry.
    if (shouldCancel?.()) return result;

    // Track gate latency in Turn Cost if tracker is provided
    if (turnCostTracker && result.duration) {
      turnCostTracker.recordLatency(result.duration, itemName || gate.name);
    }

    // Track attempt metadata for flake report
    const attemptRecord: AttemptRecord = {
      attempt,
      timestamp: result.lastAttempt || new Date().toISOString(),
      status: result.status === "pass" ? "pass" : "fail",
      duration_ms: result.duration || 0,
    };

    // Classify error if present
    let errorType: ErrorType | undefined;
    if (result.stderr) {
      const error = new Error(result.stderr);
      const classified = classifyError(error, `Gate '${gate.name}' execution`);
      errorType = classified.type;

      attemptRecord.error_type = errorType;
      attemptRecord.error_message = result.stderr;

      // Log error classification for diagnostics
      if (classified.type === ErrorType.Permanent) {
        console.error(`❌ Gate '${gate.name}' failed with permanent error - not retrying`);
        console.error(formatErrorForUser(classified));
        attemptRecords.push(attemptRecord);

        // Write flake report if there were retries
        if (itemName && attemptRecords.length > 1) {
          await writeFlakeReport(
            itemName,
            gate.name,
            attemptRecords,
            totalDuration,
            artifactDir,
            suppressStdout
          );
        }

        return result;
      } else if (classified.type === ErrorType.Transient && attempt < retryConfig.maxAttempts) {
        console.warn(`⚠️  Gate '${gate.name}' failed with transient error - will retry`);

        // Track renegotiation (retry) in Turn Cost
        if (turnCostTracker) {
          turnCostTracker.recordRenegotiation(
            `Gate '${gate.name}' retry due to transient error`,
            itemName
          );
        }
      }
    }

    attemptRecords.push(attemptRecord);

    // If successful, return immediately
    if (result.status === "pass") {
      if (attempt > 1) {
        if (!suppressStdout) {
          console.log(`✅ Gate '${gate.name}' succeeded on attempt ${attempt}`);
        }

        // Write flake report for successful retry
        if (itemName) {
          await writeFlakeReport(
            itemName,
            gate.name,
            attemptRecords,
            totalDuration,
            artifactDir,
            suppressStdout
          );
        }
      }
      return result;
    }

    // If this is the last attempt, return the result
    if (attempt === retryConfig.maxAttempts) {
      if (attempt > 1) {
        console.error(`❌ Gate '${gate.name}' failed after ${attempt} attempts`);

        // Write flake report for failed retries
        if (itemName) {
          await writeFlakeReport(
            itemName,
            gate.name,
            attemptRecords,
            totalDuration,
            artifactDir,
            suppressStdout
          );
        }
      }
      return result;
    }

    // Mark as retrying for intermediate attempts
    result.status = "retrying";
  }

  return lastResult!;
}

function cancelledGateAdmission(gateName: string): GateResult {
  return {
    gate: gateName,
    status: "blocked",
    duration: 0,
    stdout: "",
    stderr: "GATE_RUN_CANCELLED: command was not admitted",
    artifacts: [],
    attempts: 0,
    lastAttempt: new Date().toISOString(),
  };
}

function stopGateRetries(gateName: string, result: GateResult | null): GateResult {
  if (!result) return cancelledGateAdmission(gateName);
  // The retained attempt receipt describes an observed failure, not a future
  // retry. Restore that outcome when cancellation stops the retry backoff.
  return result.status === "retrying" ? { ...result, status: "fail" } : result;
}

async function waitForGateRetry(delayMs: number, shouldCancel?: () => boolean): Promise<boolean> {
  if (!shouldCancel) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return true;
  }
  const deadline = performance.now() + delayMs;
  while (!shouldCancel()) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 100)));
  }
  return false;
}

/**
 * Write flake report artifact when retries occur
 */
async function writeFlakeReport(
  itemName: string,
  gateName: string,
  attempts: AttemptRecord[],
  totalDuration: number,
  artifactDir: string,
  suppressStdout: boolean = false
): Promise<void> {
  // Only write flake report if there were multiple attempts
  if (attempts.length <= 1) {
    return;
  }

  const finalAttempt = attempts[attempts.length - 1];
  const flakeReport: FlakeReport = {
    schemaVersion: "1.0.0",
    item: itemName,
    gate: gateName,
    total_attempts: attempts.length,
    final_status: finalAttempt.status,
    attempts: attempts.sort((a, b) => a.attempt - b.attempt), // Ensure chronological order
    total_duration_ms: totalDuration,
  };

  // Write flake report to artifact directory
  const flakeReportDir = path.join(artifactDir, "flake-reports");
  if (!fs.existsSync(flakeReportDir)) {
    fs.mkdirSync(flakeReportDir, { recursive: true });
  }

  const reportPath = path.join(
    flakeReportDir,
    `${artifactIdentitySegment(itemName)}-${artifactIdentitySegment(gateName)}.json`
  );
  const reportContent = canonicalJSONStringify(flakeReport);
  fs.writeFileSync(reportPath, reportContent, "utf-8");

  if (!suppressStdout) {
    console.log(`📊 Flake report written: ${reportPath}`);
  }
}

/**
 * Execute a single gate attempt
 */
async function executeGateAttempt(
  gate: Gate,
  artifactDir: string,
  attempt: number,
  timeoutMs: number,
  repoRoot?: string,
  itemName?: string,
  candidateDigest?: string,
  resolvedWorkingDirectory?: string,
  shouldCancel?: () => boolean
): Promise<GateResult> {
  const startedAt = new Date().toISOString();
  const startTime = Date.now();

  // Handle different runtime modes
  switch (gate.runtime) {
    case "container":
      return executeContainerGate(
        gate,
        artifactDir,
        attempt,
        startedAt,
        startTime,
        timeoutMs,
        repoRoot,
        itemName
      );
    case "ci-service":
      return executeCiServiceGate(gate, artifactDir, attempt, startedAt, startTime);
    case "local":
    default:
      return executeLocalGate(
        gate,
        artifactDir,
        attempt,
        startedAt,
        startTime,
        timeoutMs,
        repoRoot,
        itemName,
        candidateDigest,
        resolvedWorkingDirectory,
        shouldCancel
      );
  }
}

/**
 * Execute gate locally
 */
async function executeLocalGate(
  gate: Gate,
  artifactDir: string,
  attempt: number,
  startedAt: string,
  startTime: number,
  timeoutMs: number,
  repoRoot?: string,
  itemName?: string,
  candidateDigest?: string,
  resolvedWorkingDirectory?: string,
  shouldCancel?: () => boolean
): Promise<GateResult> {
  // Use gate.cwd if specified, otherwise fall back to repoRoot (captured at execution start).
  // If neither is available, use process.cwd() as a last resort fallback.
  const workingDirectory = path.resolve(
    resolvedWorkingDirectory ?? (gate.cwd || repoRoot || process.cwd())
  );
  const gateArtifactDirectory = path.join(artifactDir, artifactIdentitySegment(gate.name));
  const environment = sanitizedGateEnvironment(gate.env);
  const shell = resolveLocalGateShell(gate.run);
  const artifactBaselines = captureDeclaredArtifactBaselines(
    gate.artifacts ?? [],
    workingDirectory
  );
  let shellExecutable: string;
  let shellIdentityBefore: GateArtifactFileIdentity | null = null;
  try {
    shellExecutable = resolveSpawnExecutable(
      shell.command,
      environment,
      workingDirectory,
      process.platform
    );
    shellIdentityBefore = fileIdentity(shellExecutable);
    if (!shellIdentityBefore) throw new Error("Resolved shell is not an evidence-bindable file.");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return finalizeLocalGateAttempt({
      gate,
      artifactBaselines,
      gateArtifactDirectory,
      workingDirectory,
      attempt,
      startedAt,
      startTime,
      shell,
      shellExecutable: null,
      shellIdentityBefore: null,
      spawned: false,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(errorMessage, "utf8"),
      result: {
        gate: gate.name,
        status: "fail",
        exitCode: 1,
        duration: Date.now() - startTime,
        stdout: "",
        stderr: errorMessage,
        failureKind: "spawn_error",
        artifacts: [],
        attempts: attempt,
        lastAttempt: startedAt,
      },
      itemName,
      timeoutMs,
      candidateDigest,
    });
  }

  // Validate command before execution (security check)
  try {
    const { getCommandValidator } = await import("./security/commandValidator.js");
    const validator = getCommandValidator();
    validator.validate(gate.run);
  } catch (validationError) {
    // Return failed gate result if validation fails
    const duration = Date.now() - startTime;
    const errorMessage =
      validationError instanceof Error ? validationError.message : String(validationError);

    return finalizeLocalGateAttempt({
      gate,
      artifactBaselines,
      gateArtifactDirectory,
      workingDirectory,
      attempt,
      startedAt,
      startTime,
      shell,
      shellExecutable,
      shellIdentityBefore,
      spawned: false,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(`Command validation failed: ${errorMessage}`, "utf8"),
      result: {
        gate: gate.name,
        status: "fail",
        exitCode: 1,
        duration,
        stdout: "",
        stderr: `Command validation failed: ${errorMessage}`,
        artifacts: [],
        attempts: attempt,
        lastAttempt: startedAt,
      },
      itemName,
      timeoutMs,
      candidateDigest,
    });
  }

  // Command validation yields to the event loop. Recheck cancellation before
  // creating a process; cancellation cannot terminate an already admitted gate.
  if (shouldCancel?.()) return cancelledGateAdmission(gate.name);

  return new Promise((resolve, reject) => {
    let timedOut = false;
    let settled = false;
    const childProcess = spawn(shellExecutable, shell.arguments, {
      cwd: workingDirectory,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    childProcess.stdout?.on("data", (data) => {
      stdoutChunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    });

    childProcess.stderr?.on("data", (data) => {
      stderrChunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    });

    let timeoutCleanup: Promise<ProcessTreeTerminationResult> | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      timeoutCleanup = terminateProcessTree(childProcess);
    }, timeoutMs);

    childProcess.on("close", async (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        const cleanup = timeoutCleanup ? await timeoutCleanup : undefined;
        const duration = Date.now() - startTime;
        const stdout = Buffer.concat(stdoutChunks);
        const stderr = Buffer.concat(stderrChunks);
        const stdoutText = stdout.toString("utf8");
        const stderrText = stderr.toString("utf8");

        const projectedStderr = timedOut
          ? `GATE_TIMEOUT: exceeded ${timeoutMs}ms; descendantsReaped=${cleanup?.descendantsReaped ?? false}`
          : stderrText.trim();
        resolve(
          finalizeLocalGateAttempt({
            gate,
            artifactBaselines,
            gateArtifactDirectory,
            workingDirectory,
            attempt,
            startedAt,
            startTime,
            shell,
            shellExecutable,
            shellIdentityBefore,
            spawned: true,
            stdout,
            stderr,
            result: {
              gate: gate.name,
              status: exitCode === 0 && !timedOut ? "pass" : "fail",
              exitCode: timedOut ? 124 : (exitCode ?? 1),
              duration,
              stdout: stdoutText.trim(),
              stderr: projectedStderr,
              failureKind: timedOut ? "timeout" : exitCode === 0 ? undefined : "nonzero_exit",
              ...(cleanup ? { timeoutCleanup: cleanup } : {}),
              artifacts: [],
              attempts: attempt,
              lastAttempt: startedAt,
            },
            itemName,
            timeoutMs,
            candidateDigest,
          })
        );
      } catch (error) {
        // EventEmitter does not forward callback exceptions to this promise.
        // Retention/cleanup failures must reach the item's terminal failure path.
        reject(error);
      }
    });

    childProcess.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        const duration = Date.now() - startTime;
        const stdout = Buffer.concat(stdoutChunks);

        // Classify the error for better diagnostics
        const classified = classifyError(error, `Gate '${gate.name}' process error`);
        console.error(formatErrorForUser(classified));

        const projectedStderr = `${classified.context}: ${error.message}`;
        resolve(
          finalizeLocalGateAttempt({
            gate,
            artifactBaselines,
            gateArtifactDirectory,
            workingDirectory,
            attempt,
            startedAt,
            startTime,
            shell,
            shellExecutable,
            shellIdentityBefore,
            spawned: false,
            stdout,
            stderr: Buffer.from(projectedStderr, "utf8"),
            result: {
              gate: gate.name,
              status: "fail",
              exitCode: 1,
              duration,
              stdout: stdout.toString("utf8").trim(),
              stderr: projectedStderr,
              failureKind: "spawn_error",
              artifacts: [],
              attempts: attempt,
              lastAttempt: startedAt,
            },
            itemName,
            timeoutMs,
            candidateDigest,
          })
        );
      } catch (retentionError) {
        reject(retentionError);
      }
    });
  });
}

interface FinalizeLocalGateAttemptInput {
  gate: Gate;
  artifactBaselines: DeclaredArtifactBaseline[];
  gateArtifactDirectory: string;
  workingDirectory: string;
  attempt: number;
  startedAt: string;
  startTime: number;
  shell: LocalGateShellInvocation;
  shellExecutable: string | null;
  shellIdentityBefore: GateArtifactFileIdentity | null;
  spawned: boolean;
  stdout: Buffer;
  stderr: Buffer;
  result: GateResult;
  itemName?: string;
  timeoutMs: number;
  candidateDigest?: string;
}

function finalizeLocalGateAttempt(input: FinalizeLocalGateAttemptInput): GateResult {
  const collected = collectFreshGateArtifacts(input.artifactBaselines, input.gateArtifactDirectory);
  const shellIdentityAfter = input.shellExecutable ? fileIdentity(input.shellExecutable) : null;
  const shellUnchanged =
    input.shellIdentityBefore !== null &&
    shellIdentityAfter !== null &&
    input.shellIdentityBefore.sha256 === shellIdentityAfter.sha256 &&
    input.shellIdentityBefore.bytes === shellIdentityAfter.bytes;
  const evidenceComplete =
    collected.complete &&
    (!input.spawned || (input.shellIdentityBefore !== null && shellUnchanged));
  const result = { ...input.result };
  if (result.status === "pass" && !evidenceComplete) {
    result.status = "fail";
    result.exitCode = 1;
    result.failureKind = "evidence_error";
    result.stderr = [
      result.stderr,
      "GATE_EVIDENCE_INVALID: declared output or shell identity failed",
    ]
      .filter(Boolean)
      .join("\n");
  }
  const finishedAt = new Date().toISOString();
  const duration = Date.now() - input.startTime;
  result.duration = duration;

  const receiptPath = writeLocalGateExecutionReceipt(input.gateArtifactDirectory, {
    schemaVersion: GATE_EXECUTION_RECEIPT_SCHEMA_VERSION,
    attempt: input.attempt,
    binding: gateExecutionBinding(
      input.gate,
      input.itemName,
      input.timeoutMs,
      input.candidateDigest
    ),
    declaredGate: {
      name: input.gate.name,
      run: input.gate.run,
      cwd: input.gate.cwd ?? null,
      runtime: input.gate.runtime,
      artifacts: [...(input.gate.artifacts ?? [])],
    },
    execution: {
      cwd: input.workingDirectory,
      startedAt: input.startedAt,
      finishedAt,
      durationMs: duration,
      shell: {
        command: input.shell.command,
        executable: input.shellIdentityBefore,
        argv: [...input.shell.arguments],
        identityAfter: shellIdentityAfter,
        unchanged: shellUnchanged,
        spawned: input.spawned,
      },
    },
    outcome: {
      status: result.status,
      exitCode: result.exitCode ?? null,
      failureKind: result.failureKind ?? null,
      timeoutCleanup: result.timeoutCleanup ?? null,
      evidenceComplete,
    },
    output: {
      stdout: gateOutputEvidence(input.stdout),
      stderr: gateOutputEvidence(input.stderr),
    },
    artifacts: collected.identities,
  });
  result.artifacts = [...collected.paths, receiptPath];
  return result;
}

/**
 * Execute gate in container (placeholder for future implementation)
 */
async function executeContainerGate(
  gate: Gate,
  artifactDir: string,
  attempt: number,
  startedAt: string,
  startTime: number,
  timeoutMs: number,
  repoRoot?: string,
  itemName?: string
): Promise<GateResult> {
  // A declared container runtime cannot be satisfied by a local fallback.
  console.warn(`⚠️  Container runtime for gate '${gate.name}' is not implemented; failing closed`);
  return {
    gate: gate.name,
    status: "fail",
    exitCode: 1,
    duration: Date.now() - startTime,
    stdout: "",
    stderr: "GATE_RUNTIME_UNAVAILABLE: container execution is not implemented",
    failureKind: "evidence_error",
    artifacts: [],
    attempts: attempt,
    lastAttempt: startedAt,
    timeoutMs,
  };
}

/**
 * Execute gate as CI service (placeholder for future implementation)
 */
async function executeCiServiceGate(
  gate: Gate,
  artifactDir: string,
  attempt: number,
  startedAt: string,
  startTime: number
): Promise<GateResult> {
  // TODO: Implement CI service execution (e.g., GitHub Actions API)
  // For now, mark as skipped with informative message
  console.warn(
    `⚠️  CI service runtime for gate '${gate.name}' not yet implemented, marking as skipped`
  );
  return {
    gate: gate.name,
    status: "skipped",
    duration: Date.now() - startTime,
    stdout: "CI service execution not yet implemented - graceful degradation",
    stderr: "This gate requires CI service integration which is not available",
    artifacts: [],
    attempts: attempt,
    lastAttempt: startedAt,
  };
}

/**
 * Check vulnerability scan results against policy thresholds
 */
function checkVulnGate(artifactDir: string, policy?: SecurityPolicy): GateResult {
  const startTime = Date.now();
  const startedAt = new Date().toISOString();

  // Use default policy if not provided
  const vulnPolicy = policy || DEFAULT_SECURITY_POLICY;

  // Look for SARIF file first, then npm audit JSON
  const sarifPath = path.join(artifactDir, "scan-results.sarif");
  const npmAuditPath = path.join(artifactDir, "npm-audit.json");

  let scanResult: SecurityScanResult | null = null;
  let artifactPath: string | null = null;

  // Try SARIF first
  if (fs.existsSync(sarifPath)) {
    try {
      const sarifContent = fs.readFileSync(sarifPath, "utf-8");
      scanResult = parseSarif(sarifContent);
      artifactPath = sarifPath;
    } catch (error) {
      return {
        gate: "vuln",
        status: "fail",
        exitCode: 1,
        duration: Date.now() - startTime,
        stdout: "",
        stderr: `Failed to parse SARIF: ${error instanceof Error ? error.message : String(error)}`,
        artifacts: [],
        attempts: 1,
        lastAttempt: startedAt,
      };
    }
  }
  // Fall back to npm audit JSON
  else if (fs.existsSync(npmAuditPath)) {
    try {
      const npmAuditContent = fs.readFileSync(npmAuditPath, "utf-8");
      const auditData = JSON.parse(npmAuditContent);
      // Use NpmAuditScanner's parsing logic
      const scanner = new NpmAuditScanner();
      scanResult = (scanner as any).parseNpmAudit(auditData);
      artifactPath = npmAuditPath;
    } catch (error) {
      return {
        gate: "vuln",
        status: "fail",
        exitCode: 1,
        duration: Date.now() - startTime,
        stdout: "",
        stderr: `Failed to parse npm audit: ${error instanceof Error ? error.message : String(error)}`,
        artifacts: [],
        attempts: 1,
        lastAttempt: startedAt,
      };
    }
  }
  // No vulnerability scan artifacts found
  else {
    return {
      gate: "vuln",
      status: "fail",
      exitCode: 1,
      duration: Date.now() - startTime,
      stdout: "",
      stderr: `No vulnerability scan artifacts found. Expected SARIF at ${sarifPath} or npm audit JSON at ${npmAuditPath}`,
      artifacts: [],
      attempts: 1,
      lastAttempt: startedAt,
    };
  }

  // scanResult is guaranteed to be non-null here due to the else return above
  if (!scanResult) {
    throw new Error("Unexpected null scan result");
  }

  // Check against policy thresholds
  const violations: string[] = [];

  if (vulnPolicy.blockCritical && scanResult.criticalCount > 0) {
    violations.push(`${scanResult.criticalCount} critical vulnerabilities (threshold: 0)`);
  }

  if (vulnPolicy.blockHigh && scanResult.highCount > 0) {
    violations.push(`${scanResult.highCount} high vulnerabilities (threshold: 0)`);
  }

  if (scanResult.mediumCount > vulnPolicy.maxMedium) {
    violations.push(
      `${scanResult.mediumCount} medium vulnerabilities (threshold: ${vulnPolicy.maxMedium})`
    );
  }

  if (scanResult.lowCount > vulnPolicy.maxLow) {
    violations.push(`${scanResult.lowCount} low vulnerabilities (threshold: ${vulnPolicy.maxLow})`);
  }

  const passed = violations.length === 0;

  // Build deterministic output message
  const summary = [
    `Vulnerability scan results (${scanResult.scanner}):`,
    `  Critical: ${scanResult.criticalCount}`,
    `  High: ${scanResult.highCount}`,
    `  Medium: ${scanResult.mediumCount}`,
    `  Low: ${scanResult.lowCount}`,
    `  Total: ${scanResult.totalVulnerabilities}`,
  ].join("\n");

  const output = passed
    ? `${summary}\n\n✅ All thresholds met`
    : `${summary}\n\n❌ Policy violations:\n${violations.map((v) => `  - ${v}`).join("\n")}`;

  return {
    gate: "vuln",
    status: passed ? "pass" : "fail",
    exitCode: passed ? 0 : 1,
    duration: Date.now() - startTime,
    stdout: output,
    stderr: passed ? "" : violations.join("; "),
    artifacts: artifactPath ? [artifactPath] : [],
    attempts: 1,
    lastAttempt: startedAt,
  };
}

/**
 * Emit Frame and Receipt for gate execution result (AX-005 + Wave 3)
 *
 * This function emits both:
 * 1. A Frame for Lex memory (existing behavior)
 * 2. An ActionReceipt for disciplined failure pattern (Wave 3 requirement)
 */
async function emitGateExecutionFrame(
  gateName: string,
  itemName: string,
  result: GateResult,
  runId?: string,
  emitReceipt: boolean = true
): Promise<FrameEmitResult | undefined> {
  // Skip emitting frame for blocked or skipped gates - they didn't actually execute
  if (result.status === "blocked" || result.status === "skipped" || result.status === "retrying") {
    return undefined;
  }

  const passed = result.status === "pass";
  const duration = result.duration || 0;
  const outcome = passed ? "success" : "failure";

  // Emit ActionReceipt for disciplined failure pattern (Wave 3)
  // CLI callers emit a receipt even without a runId. Transport adapters may
  // suppress console emission to preserve their framing contract.
  if (emitReceipt) {
    emitGateReceipt(
      gateName,
      itemName,
      passed,
      duration,
      runId,
      { log: true, json: true },
      // Include detailed context for failure receipts
      !passed
        ? {
            error: result.stderr,
            exitCode: result.exitCode,
            artifacts: result.artifacts,
            failureKind: result.failureKind,
            descendantsReaped: result.timeoutCleanup?.descendantsReaped,
          }
        : undefined
    );
  }

  // Only emit Frame if runId is provided
  if (!runId) {
    return undefined;
  }

  return await emitGateFrame({
    runId,
    gateName,
    itemName,
    durationMs: duration,
    outcome,
    exitCode: result.exitCode,
    artifacts: result.artifacts,
    error: result.stderr && !passed ? result.stderr : undefined,
  });
}

/**
 * Execute all gates for a specific item with policy-aware execution
 */
export async function executeItemGates(
  item: PlanItem,
  policy: Policy,
  executionState: ExecutionState,
  artifactDir: string,
  timeoutMs: number = 30000,
  skipValidation: boolean = false,
  repoRoot?: string,
  options?: {
    runId?: string;
    baseDir?: string;
    turnCostTracker?: MergeWeaveTurnCost;
    recordFailures?: boolean | "auto" | "interactive";
    planPath?: string;
    activeConstraints?: string[];
    scope?: string[];
    onlyGate?: string;
    emitReceipt?: boolean;
    suppressStdout?: boolean;
    candidateDigest?: string;
    resolvedGateWorkingDirectories?: Readonly<Record<string, string>>;
    shouldCancel?: () => boolean;
  }
): Promise<GateResult[]> {
  if (!item.gates || item.gates.length === 0) {
    return [];
  }

  const results: GateResult[] = [];
  const itemArtifactDir = path.join(artifactDir, artifactIdentitySegment(item.name));

  // Ensure item artifact directory exists
  if (!fs.existsSync(itemArtifactDir)) {
    fs.mkdirSync(itemArtifactDir, { recursive: true });
  }

  for (const gate of item.gates) {
    if (options?.onlyGate && gate.name !== options.onlyGate) {
      continue;
    }
    if (options?.shouldCancel?.()) {
      executionState.blockNode(item.name, []);
      break;
    }
    // Check if gate should be blocked based on policy
    if (shouldBlockGate(gate, policy)) {
      const blockedResult: GateResult = {
        gate: gate.name,
        status: "blocked",
        duration: 0,
        stdout: "",
        stderr: "Gate blocked by policy",
        artifacts: [],
        attempts: 0,
        lastAttempt: new Date().toISOString(),
      };
      results.push(blockedResult);
      executionState.updateGateResult(item.name, blockedResult);
      continue;
    }

    // Special handling for 'vuln' gate
    if (gate.name === "vuln") {
      // Extract security policy from plan policy if available
      const securityPolicy = (policy as any).security || DEFAULT_SECURITY_POLICY;
      const result = checkVulnGate(itemArtifactDir, securityPolicy);
      results.push(result);
      executionState.updateGateResult(item.name, result);

      // Log failure if gate failed and runId is provided
      if (result.status === "fail" && options?.runId) {
        logGateFailure(
          options.runId,
          result,
          {
            isFlaky: false,
          },
          options.baseDir
        );
      }

      // Emit Frame for gate execution (AX-005)
      await emitGateExecutionFrame(
        gate.name,
        item.name,
        result,
        options?.runId,
        options?.emitReceipt !== false
      );
      continue;
    }

    const result = await executeGate(
      gate,
      policy,
      itemArtifactDir,
      gate.timeoutMs ?? timeoutMs,
      item.name,
      skipValidation,
      repoRoot,
      options?.turnCostTracker,
      options?.suppressStdout,
      options?.candidateDigest,
      options?.resolvedGateWorkingDirectories?.[JSON.stringify([item.name, gate.name])],
      options?.shouldCancel
    );
    result.timeoutMs = gate.timeoutMs ?? timeoutMs;
    results.push(result);

    // Update execution state
    executionState.updateGateResult(item.name, result);

    // Log failure if gate failed and runId is provided
    if (result.status === "fail" && options?.runId) {
      // Check if gate is marked as flaky in policy
      const isFlaky = Boolean(
        policy.retries[gate.name]?.maxAttempts && policy.retries[gate.name].maxAttempts > 1
      );
      logGateFailure(
        options.runId,
        result,
        {
          isFlaky,
        },
        options.baseDir
      );

      // Prompt for counter-example if enabled
      await promptCounterExampleIfEnabled(result, options);
    }

    // Emit Frame for gate execution (AX-005)
    await emitGateExecutionFrame(
      gate.name,
      item.name,
      result,
      options?.runId,
      options?.emitReceipt !== false
    );
  }
  return results;
}

/**
 * Check if a gate should be blocked based on policy
 */
function shouldBlockGate(gate: Gate, policy: Policy): boolean {
  // Check if gate name matches any blocked patterns
  for (const blockPattern of policy.blockOn) {
    if (gate.name.includes(blockPattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Execute gates for multiple items with concurrency control and dependency ordering
 */
export async function executeGatesWithPolicy(
  plan: Plan,
  executionState: ExecutionState,
  artifactDir: string,
  timeoutMs: number = 30000,
  progressReporter?: ProgressReporter,
  skipValidation: boolean = false,
  repoRoot?: string,
  options?: {
    runId?: string;
    baseDir?: string;
    turnCostTracker?: MergeWeaveTurnCost;
    onlyItem?: string;
    onlyGate?: string;
    emitReceipt?: boolean;
    suppressStdout?: boolean;
    candidateDigest?: string;
    resolvedGateWorkingDirectories?: Readonly<Record<string, string>>;
    shouldCancel?: () => boolean;
  }
): Promise<void> {
  // Capture repository root once at the start of execution
  const workingDir = repoRoot || process.cwd();

  // Wave 3 Governance: Hostility → Gate Timeout Adjustment
  // Best-effort: if the environment check fails, fall back to the provided timeout.
  let effectiveTimeoutMs = timeoutMs;
  try {
    const hostilityScore = runEnvironmentQualityCheck({ cwd: workingDir });
    const adjustment = calculateHostilityAdjustedTimeout(timeoutMs, hostilityScore);
    if (!options?.suppressStdout) {
      logTimeoutAdjustment(adjustment, "all_gates");
    }
    effectiveTimeoutMs = adjustment.adjustedTimeoutMs;
  } catch {
    // Ignore hostility scoring errors to avoid blocking gate execution.
  }
  const policy = plan.policy || {
    requiredGates: [],
    optionalGates: [],
    maxWorkers: 1,
    retries: {},
    overrides: {},
    blockOn: [],
    mergeRule: { type: "strict-required" },
  };

  // Initialize performance monitoring
  const perfConfig: Partial<PerformanceConfig> = policy.performance || {};
  const memoryMonitor = new MemoryMonitor(perfConfig);

  // Ensure base artifact directory exists
  if (!fs.existsSync(artifactDir)) {
    fs.mkdirSync(artifactDir, { recursive: true });
  }

  // Build execution order based on dependencies
  const executionOrder = buildExecutionOrder(plan).filter(
    (itemName) => !options?.onlyItem || itemName === options.onlyItem
  );

  // Status labels are not invocation lifetime: a prerequisite selected for
  // re-execution must settle in this invocation, even if it entered with PASS.
  const maxWorkers = policy.maxWorkers;
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1) {
    throw new Error("Gate maxWorkers must be a positive integer");
  }
  const items = new Map(plan.items.map((item) => [item.name, item]));
  const selected = new Set(executionOrder);
  const pending = new Set(executionOrder);
  const running = new Map<string, Promise<void>>();
  const settled = new Set<string>();
  for (const node of executionOrder) {
    if (!executionState.getNodeResult(node)) throw new Error(`Node not found: ${node}`);
  }

  // Progress is observational; a broken observer must not abandon admitted jobs.
  const reportProgress = (callback: () => void): void => {
    try {
      callback();
    } catch {
      console.warn("Gate progress reporting failed; execution results remain authoritative");
    }
  };
  const block = (node: string, blockedBy: string[]): void => {
    executionState.blockNode(node, blockedBy);
    pending.delete(node);
    settled.add(node);
    reportProgress(() => progressReporter?.nodeComplete(node, false));
  };

  try {
    while (pending.size > 0 || running.size > 0) {
      // Poll memory throttling here so cancellation can stop admission even
      // while memory remains high. Admitted commands keep their own timeout.
      if (!options?.shouldCancel) {
        await memoryMonitor.throttleIfNeeded();
      } else {
        while (perfConfig.throttleOnMemory !== false && memoryMonitor.isMemoryHigh()) {
          if (options.shouldCancel()) break;
          if (global.gc) global.gc();
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      for (const node of pending) {
        if (options?.shouldCancel?.()) {
          // Clear previous selected invocation evidence before blocking it.
          executionState.beginNodeExecution(node);
          block(node, []);
          continue;
        }
        const result = executionState.getNodeResult(node)!;
        if (result.status === "fail" || result.status === "blocked") {
          pending.delete(node);
          settled.add(node);
          reportProgress(() => progressReporter?.nodeComplete(node, false));
          continue;
        }
        const item = items.get(node)!;
        const blockedBy = item.deps.filter((dep) => {
          // Unselected dependencies are never launched or assigned synthetic PASS.
          // Their evidence must already be present in this explicit state.
          const completed = !selected.has(dep) || settled.has(dep);
          return completed && executionState.getNodeResult(dep)?.status !== "pass";
        });
        if (blockedBy.length > 0) {
          block(node, blockedBy);
          continue;
        }
        if (item.deps.some((dep) => selected.has(dep) && !settled.has(dep))) continue;
        if (running.size >= maxWorkers) continue;

        pending.delete(node);
        // Reserve the slot before any observer or gate can execute.
        const worker = Promise.resolve()
          .then(async () => {
            try {
              // Only admitted selected items are reset. Omitted prerequisite
              // evidence is preserved; skipped required commands are not PASS.
              executionState.beginNodeExecution(node);
              if (options?.shouldCancel?.()) {
                executionState.blockNode(node, []);
                return;
              }
              reportProgress(() => progressReporter?.nodeStart(node));
              await executeItemGates(
                item,
                policy,
                executionState,
                artifactDir,
                effectiveTimeoutMs,
                skipValidation,
                workingDir,
                options
              );
              if (options?.shouldCancel?.()) {
                executionState.blockNode(node, []);
              } else {
                executionState.completeNodeExecution(node);
              }
            } catch (error) {
              executionState.markNodeExecutionFailed(node, error);
              console.error(`Error executing gates for ${node}:`, error);
            }
          })
          .finally(() => {
            running.delete(node);
            settled.add(node);
            metrics.setGauge(METRICS.ACTIVE_WORKERS, running.size);
            reportProgress(() =>
              progressReporter?.nodeComplete(
                node,
                executionState.getNodeResult(node)?.status === "pass"
              )
            );
          });
        running.set(node, worker);
        metrics.setGauge(METRICS.ACTIVE_WORKERS, running.size);
      }

      if (running.size > 0) {
        await Promise.race(running.values());
      } else if (pending.size > 0) {
        // A validated DAG always makes progress. Fail closed for an unresolved
        // explicit state rather than silently returning pending items as green.
        for (const node of pending) {
          block(
            node,
            items
              .get(node)!
              .deps.filter((dep) => executionState.getNodeResult(dep)?.status !== "pass")
          );
        }
      }
    }
  } finally {
    await Promise.all(running.values());
  }
}

/**
 * Build execution order based on topological sort
 */
function buildExecutionOrder(plan: Plan): string[] {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: string[] = [];

  function visit(nodeName: string): void {
    if (visited.has(nodeName)) return;
    if (visiting.has(nodeName)) {
      throw new Error(`Dependency cycle detected involving node: ${nodeName}`);
    }

    visiting.add(nodeName);
    const node = plan.items.find((item) => item.name === nodeName);
    if (!node) throw new Error(`Dependency not found: ${nodeName}`);
    for (const dep of node.deps) visit(dep);
    visiting.delete(nodeName);
    visited.add(nodeName);
    order.push(nodeName);
  }

  for (const item of plan.items) {
    visit(item.name);
  }

  return order;
}

/**
 * Prompt for counter-example recording if enabled
 */
async function promptCounterExampleIfEnabled(
  gateResult: GateResult,
  options?: {
    runId?: string;
    baseDir?: string;
    recordFailures?: boolean | "auto" | "interactive";
    planPath?: string;
    activeConstraints?: string[];
    scope?: string[];
  }
): Promise<void> {
  // Skip if not enabled
  if (!options?.recordFailures) {
    return;
  }

  const runId = options.runId || "unknown";
  const planPath = options.planPath || "unknown";
  const activeConstraints = options.activeConstraints || [];
  const scope = options.scope || [];
  const baseDir = options.baseDir || process.cwd();

  let classification: CounterExampleClassification | null = null;

  if (options.recordFailures === "interactive") {
    // Interactive mode: prompt user for classification
    classification = await promptCounterExampleClassification(
      gateResult.gate,
      gateResult.stderr || "Gate execution failed"
    );
  } else if (options.recordFailures === "auto" || options.recordFailures === true) {
    // Auto mode: record with unknown classification
    classification = createAutoRecordClassification(gateResult.stderr || "Gate execution failed");
  }

  // If user chose to skip or classification failed, return
  if (!classification) {
    return;
  }

  // Create and store counter-example
  const counterExample = createCounterExampleFromGate(
    gateResult,
    planPath,
    runId,
    classification,
    activeConstraints,
    scope
  );

  storeCounterExample(counterExample, baseDir);
}
