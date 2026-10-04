import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { ExecutionState } from "../executionState.js";
import { executeGatesWithPolicy } from "../gates.js";
import type { Plan } from "../schema.js";
import { loadPlan } from "../schema.js";
import { canonicalJSONStringify } from "../util/canonicalJson.js";
import {
  captureGateCandidateIdentity,
  resolveGateRepositoryRoot,
  sameGateCandidate,
  type GateCandidateIdentity,
} from "./gate-candidate-identity.js";
import {
  writeGateEvidenceManifest,
  type GateEvidenceArtifactReference,
} from "./gate-evidence-service.js";

const MAX_ITEMS = 256;
const MAX_GATES_PER_ITEM = 64;
const MAX_LABEL_BYTES = 512;
const MAX_ARTIFACT_REF_BYTES = 4096;

type GateExecutor = typeof executeGatesWithPolicy;

export interface GateExecutionServiceInput {
  plan: Plan;
  artifactDir: string;
  timeoutMs?: number;
  progressReporter?: Parameters<GateExecutor>[4];
  skipValidation?: boolean;
  repoRoot?: string;
  options?: Parameters<GateExecutor>[7];
  onlyItem?: string;
  onlyGate?: string;
  executionState?: ExecutionState;
  /** Internal detached-worker binding: all metadata shares this excluded run directory. */
  preparedArtifactDir?: string;
  expectedCandidate?: GateCandidateIdentity;
}

export interface BoundedGateRunResult {
  contract: "bounded-ax-v1";
  items: Array<{
    name: string;
    status: string;
    gates: Array<{
      name: string;
      status: string;
      failureKind?: "nonzero_exit" | "spawn_error" | "timeout" | "evidence_error";
      timeoutMs?: number;
      timeoutCleanup?: {
        method: "process-group" | "taskkill" | "direct-child";
        forceKilled: boolean;
        descendantsReaped: boolean;
      };
    }>;
  }>;
  allGreen: boolean;
  artifactRefs: Array<
    { kind: "gate-results-directory"; path: string } | GateEvidenceArtifactReference
  >;
}

export interface GateExecutionServiceResult {
  summary: BoundedGateRunResult;
  executionState: ExecutionState;
}

export class GateExecutionServiceError extends Error {
  constructor(
    readonly code:
      | "GATE_EXECUTION_FAILED"
      | "GATE_RESULT_LIMIT_EXCEEDED"
      | "GATE_SELECTION_NOT_FOUND"
      | "GATE_TIMEOUT_INVALID"
      | "GATE_CANDIDATE_ROOT_INVALID"
      | "GATE_WORKING_DIRECTORY_INVALID"
      | "GATE_WORKING_DIRECTORY_CONFLICT"
      | "GATE_CANDIDATE_CHANGED",
    message: string
  ) {
    super(message);
    this.name = "GateExecutionServiceError";
  }
}

/** One bounded transport-neutral owner for canonical CLI and MCP gate execution. */
export class GateExecutionService {
  constructor(private readonly execute: GateExecutor = executeGatesWithPolicy) {}

  async run(request: GateExecutionServiceInput): Promise<GateExecutionServiceResult> {
    // Caller-owned fields must not change selection or publication after execution yields.
    const input = { ...request, options: { ...request.options } };
    if (
      input.timeoutMs !== undefined &&
      (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 86_400_000)
    ) {
      throw new GateExecutionServiceError(
        "GATE_TIMEOUT_INVALID",
        "Gate timeout must be an integer from 1 through 86400000 milliseconds"
      );
    }
    const plan = loadPlan(canonicalJSONStringify(input.plan));
    const validatedInput = { ...input, plan };
    assertGateSelectionExists(validatedInput);
    assertGateSelectionBounded(validatedInput);
    const binding = bindGateDirectories(
      validatedInput,
      input.repoRoot === undefined ? process.cwd() : input.repoRoot
    );
    const executionState = input.executionState ?? new ExecutionState(plan);
    const artifactDir = input.preparedArtifactDir
      ? realpathSync(input.preparedArtifactDir)
      : prepareOwnedArtifactDirectory(input.artifactDir);
    if (input.preparedArtifactDir && artifactDir !== realpathSync(input.artifactDir)) {
      throw new GateExecutionServiceError(
        "GATE_WORKING_DIRECTORY_CONFLICT",
        "Prepared artifacts must use the operation directory"
      );
    }
    let candidate: ReturnType<typeof captureGateCandidateIdentity>;
    try {
      candidate = captureGateCandidateIdentity(binding.repository.path, artifactDir);
    } catch {
      throw new GateExecutionServiceError(
        "GATE_CANDIDATE_ROOT_INVALID",
        "The candidate repository is unavailable"
      );
    }
    if (input.expectedCandidate && !sameGateCandidate(input.expectedCandidate, candidate)) {
      throw new GateExecutionServiceError(
        "GATE_CANDIDATE_CHANGED",
        "The admission candidate changed before gate execution"
      );
    }
    try {
      await this.execute(
        plan,
        executionState,
        bounded(artifactDir, MAX_ARTIFACT_REF_BYTES),
        input.timeoutMs,
        input.progressReporter,
        input.skipValidation,
        binding.repository.path,
        {
          ...input.options,
          resolvedGateWorkingDirectories: binding.workingDirectories,
          candidateDigest: candidate.worktreeDigest,
          onlyItem: input.onlyItem,
          onlyGate: input.onlyGate,
        }
      );
    } catch {
      throw new GateExecutionServiceError(
        "GATE_EXECUTION_FAILED",
        "Gate execution failed; inspect the gate artifact references for details"
      );
    }

    let candidateUnchanged = false;
    try {
      const bindingAfter = bindGateDirectories(validatedInput, binding.repository.path);
      const candidateAfter = captureGateCandidateIdentity(candidate.repositoryRoot, artifactDir);
      candidateUnchanged =
        sameDirectory(binding.repository, bindingAfter.repository) &&
        Object.keys(binding.directories).every((key) => {
          const after = bindingAfter.directories[key];
          return after !== undefined && sameDirectory(binding.directories[key]!, after);
        }) &&
        sameGateCandidate(candidate, candidateAfter);
    } catch {
      // A disappeared or redirected root/working directory also invalidates the candidate.
    }
    if (!candidateUnchanged) {
      throw new GateExecutionServiceError(
        "GATE_CANDIDATE_CHANGED",
        "The repository candidate changed during gate execution; evidence was not published"
      );
    }

    const items = [...executionState.getResults().entries()]
      .filter(([name]) => !input.onlyItem || name === input.onlyItem)
      .map(([name, result]) => ({
        name: bounded(name, MAX_LABEL_BYTES),
        status: bounded(result.status, MAX_LABEL_BYTES),
        gates: result.gates
          .filter((gate) => !input.onlyGate || gate.gate === input.onlyGate)
          .map((gate) => ({
            name: bounded(gate.gate, MAX_LABEL_BYTES),
            status: bounded(gate.status, MAX_LABEL_BYTES),
            ...(gate.timeoutMs !== undefined ? { timeoutMs: gate.timeoutMs } : {}),
            ...(gate.failureKind ? { failureKind: gate.failureKind } : {}),
            ...(gate.timeoutCleanup ? { timeoutCleanup: gate.timeoutCleanup } : {}),
          })),
      }));
    if (items.length > MAX_ITEMS || items.some(({ gates }) => gates.length > MAX_GATES_PER_ITEM)) {
      throw new GateExecutionServiceError(
        "GATE_RESULT_LIMIT_EXCEEDED",
        `Gate result exceeds ${MAX_ITEMS} items or ${MAX_GATES_PER_ITEM} gates per item`
      );
    }
    const evidenceReference = writeGateEvidenceManifest({
      plan,
      executionState,
      artifactDir,
      candidate,
      onlyItem: input.onlyItem,
      onlyGate: input.onlyGate,
    });
    return {
      executionState,
      summary: {
        contract: "bounded-ax-v1",
        items,
        allGreen: items.every(({ status }) => status === "pass"),
        artifactRefs: [
          {
            kind: "gate-results-directory",
            path: bounded(artifactDir, MAX_ARTIFACT_REF_BYTES),
          },
          evidenceReference,
        ],
      },
    };
  }
}

function prepareOwnedArtifactDirectory(requestedRoot: string): string {
  const root = resolve(bounded(requestedRoot, MAX_ARTIFACT_REF_BYTES));
  mkdirSync(root, { recursive: true });
  const runDirectory = join(root, `gate-run-${Date.now()}-${randomUUID()}`);
  mkdirSync(runDirectory);
  return runDirectory;
}

export function assertGateSelectionExists(
  input: Pick<GateExecutionServiceInput, "plan" | "onlyItem" | "onlyGate">
): void {
  for (const selector of [input.onlyItem, input.onlyGate]) {
    if (selector !== undefined && (typeof selector !== "string" || selector.length === 0)) {
      throw new GateExecutionServiceError(
        "GATE_SELECTION_NOT_FOUND",
        "A provided item or gate selection must be a nonempty string"
      );
    }
  }
  const selectedItems = input.onlyItem
    ? input.plan.items.filter(({ name }) => name === input.onlyItem)
    : input.plan.items;
  if (input.onlyItem && selectedItems.length === 0) {
    throw new GateExecutionServiceError(
      "GATE_SELECTION_NOT_FOUND",
      "The selected plan item does not exist"
    );
  }
  if (
    input.onlyGate &&
    !selectedItems.some(({ gates }) => gates.some(({ name }) => name === input.onlyGate))
  ) {
    throw new GateExecutionServiceError(
      "GATE_SELECTION_NOT_FOUND",
      "The selected gate does not exist on the selected plan items"
    );
  }
}

function assertGateSelectionBounded(
  input: Pick<GateExecutionServiceInput, "plan" | "onlyItem" | "onlyGate">
): void {
  let selectedItems = 0;
  for (const item of input.plan.items) {
    if (input.onlyItem && item.name !== input.onlyItem) continue;
    selectedItems++;
    let selectedGates = 0;
    for (const gate of item.gates) {
      if (!input.onlyGate || gate.name === input.onlyGate) selectedGates++;
    }
    if (selectedItems > MAX_ITEMS || selectedGates > MAX_GATES_PER_ITEM) {
      throw new GateExecutionServiceError(
        "GATE_RESULT_LIMIT_EXCEEDED",
        `Gate selection exceeds ${MAX_ITEMS} items or ${MAX_GATES_PER_ITEM} gates per item`
      );
    }
  }
}

interface ObservedDirectory {
  path: string;
  device: bigint;
  inode: bigint;
}

interface GateDirectoryBinding {
  repository: ObservedDirectory;
  directories: Readonly<Record<string, ObservedDirectory>>;
  workingDirectories: Readonly<Record<string, string>>;
}

/** Portable consistency observations, not a filesystem lease or execution authority. */
function bindGateDirectories(
  input: Pick<GateExecutionServiceInput, "plan" | "onlyItem" | "onlyGate">,
  requestedRoot: unknown
): GateDirectoryBinding {
  // These observations belong to this phase only. Postflight rebuilds both caches.
  const observedReferences = new Map<string, ObservedDirectory>();
  const repositoriesByDirectory = new Map<string, ObservedDirectory>();
  const observeReference = (reference: string): ObservedDirectory => {
    const lexicalPath = resolve(reference);
    const cached = observedReferences.get(lexicalPath);
    if (cached) return cached;
    const observed = observeDirectory(lexicalPath);
    observedReferences.set(lexicalPath, observed);
    return observed;
  };
  const repositoryFor = (directory: ObservedDirectory): ObservedDirectory => {
    const cached = repositoriesByDirectory.get(directory.path);
    if (cached) return cached;
    const observed = observeReference(resolveGateRepositoryRoot(directory.path));
    repositoriesByDirectory.set(directory.path, observed);
    return observed;
  };
  let repository: ObservedDirectory;
  try {
    const requested = directoryReference(requestedRoot);
    repository = repositoryFor(observeReference(requested));
    // This canonical root was established by the same phase's Git observation.
    repositoriesByDirectory.set(repository.path, repository);
  } catch {
    throw new GateExecutionServiceError(
      "GATE_CANDIDATE_ROOT_INVALID",
      "The candidate root must identify an available Git repository"
    );
  }

  const directories: Record<string, ObservedDirectory> = Object.create(null);
  const workingDirectories: Record<string, string> = Object.create(null);
  for (const item of input.plan.items) {
    if (input.onlyItem && item.name !== input.onlyItem) continue;
    for (const gate of item.gates) {
      if (input.onlyGate && gate.name !== input.onlyGate) continue;
      if (gate.runtime !== "local") continue;
      let directory: ObservedDirectory;
      let gateRepository: ObservedDirectory;
      try {
        const requested = gate.cwd === undefined ? "." : directoryReference(gate.cwd);
        directory = observeReference(resolve(repository.path, requested));
        gateRepository = repositoryFor(directory);
      } catch {
        throw new GateExecutionServiceError(
          "GATE_WORKING_DIRECTORY_INVALID",
          "A selected local gate working directory is unavailable"
        );
      }
      const relativeDirectory = relative(repository.path, directory.path);
      if (
        !sameDirectory(repository, gateRepository) ||
        relativeDirectory === ".." ||
        relativeDirectory.startsWith(`..${sep}`) ||
        isAbsolute(relativeDirectory)
      ) {
        throw new GateExecutionServiceError(
          "GATE_WORKING_DIRECTORY_CONFLICT",
          "A selected local gate working directory belongs to another candidate"
        );
      }
      const key = JSON.stringify([item.name, gate.name]);
      directories[key] = directory;
      workingDirectories[key] = directory.path;
    }
  }
  return {
    repository,
    directories: Object.freeze(directories),
    workingDirectories: Object.freeze(workingDirectories),
  };
}

function directoryReference(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_ARTIFACT_REF_BYTES
  ) {
    throw new Error("Invalid directory reference");
  }
  return value;
}

function observeDirectory(reference: string): ObservedDirectory {
  const path = realpathSync(reference);
  const info = statSync(path, { bigint: true });
  if (!info.isDirectory() || info.ino === 0n) throw new Error("Directory is unavailable");
  return { path, device: info.dev, inode: info.ino };
}

function sameDirectory(left: ObservedDirectory, right: ObservedDirectory): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function bounded(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new GateExecutionServiceError(
      "GATE_RESULT_LIMIT_EXCEEDED",
      "Gate result contains an overlong label or artifact reference"
    );
  }
  return value;
}
