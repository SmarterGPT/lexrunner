import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJSONStringify } from "../../src/util/canonicalJson.js";
import { computeCanonicalHash } from "../../src/schemas/task-contract.js";
import {
  AgentWorkFanoutPlan_v1,
  createAgentTaskPacket,
  parseAgentEngineVerificationV2,
  parseAgentTaskReceiptV2,
} from "../../src/schemas/agent-work.js";
import { createNativeExecutionPathMapping } from "../../src/schemas/agent-work-projection.js";
import { AgentWorkFanoutService } from "../../src/runs/agent-work-fanout-service.js";
import type {
  ControllerLease,
  ControllerLeaseCredential,
} from "../../src/store/coordination-store.js";
import type {
  WorkspaceLifecycleStore,
  LaunchEnvelopeBindingStore,
  TaskPacketBindingStore,
  AttemptReceiptStore,
  AttemptVerificationStore,
  AgentWorkFanoutStore,
  WorkspaceObservation,
  WorkerSessionStore,
  WorkerAuthorityDecisionStore,
} from "../../src/store/workspace-lifecycle-store.js";
import { toAttemptContract } from "../../src/store/workspace-lifecycle-store.js";

export interface WorkspaceLifecycleHarness
  extends
    WorkspaceLifecycleStore,
    LaunchEnvelopeBindingStore,
    TaskPacketBindingStore,
    WorkerSessionStore,
    WorkerAuthorityDecisionStore,
    AttemptReceiptStore,
    AttemptVerificationStore,
    AgentWorkFanoutStore {
  acquireControllerLease(input: {
    runId: string;
    controllerId: string;
    leaseId: string;
    now: string;
    ttlMs: number;
    initialState: Record<string, never>;
  }): Promise<{ acquired: true; lease: ControllerLease } | { acquired: false }>;
  compareAndSetRunState(input: {
    runId: string;
    controllerId: string;
    leaseId: string;
    fencingToken: number;
    expectedRevision: number;
    mutationId: string;
    state: Record<string, string>;
    event: { type: string; payload: Record<string, string> };
    now: string;
  }): Promise<{ updated: boolean }>;
  close(): Promise<void>;
}

export interface WorkspaceLifecycleHarnessFactory {
  name: string;
  create(): Promise<WorkspaceLifecycleHarness>;
}

const T0 = "2026-07-11T12:00:00.000Z";
const T1 = "2026-07-11T12:00:01.000Z";
const T2 = "2026-07-11T12:00:02.000Z";
const T3 = "2026-07-11T12:00:03.000Z";
const T_LATE = "2026-07-11T12:00:11.000Z";

function taskPacketSnapshot(attemptId = "attempt-1", workItemId = "work-1", packetId = "packet-1") {
  return createAgentTaskPacket({
    schema_version: "1.0.0",
    packet_id: packetId,
    run_id: "run-1",
    work_item: { work_item_id: workItemId, revision: 7 },
    attempt_id: attemptId,
    repository: { id: "repo-1", base_sha: "a".repeat(40) },
    objective: "Persist the packet snapshot",
    acceptance_criteria: [
      { id: "criterion-1", text: "Packet is immutable" },
      { id: "criterion-2", text: "Receipt references are bound" },
    ],
    instructions: ["Make no host-local assumptions."],
    scope: {
      read_globs: ["src/**"],
      write_globs: ["src/**"],
      deny_globs: [],
      cross_repo_allowed: false,
    },
    authority: {
      edit: true,
      git_write: false,
      github_write: false,
      external_runtime: false,
      secrets: false,
      signing: false,
      release: false,
    },
    verification: [
      { id: "check-1", argv: ["npm", "test"], expected_exit_codes: [0] },
      { id: "check-2", argv: ["npm", "run", "typecheck"], expected_exit_codes: [0] },
    ],
    budget: {},
    created_at: T2,
  });
}

const DEFAULT_PACKET = taskPacketSnapshot();
const DEFAULT_PACKET_JSON = canonicalJSONStringify(DEFAULT_PACKET);

const identity = {
  repositoryId: "repo-1",
  hostId: "host-1",
  gitRuntime: "wsl-git",
  projectRoot: "/srv/repo",
  branch: "agent/work-1",
  worktreePath: "/srv/worktrees/work-1",
  attemptId: "attempt-1",
};

function observation(overrides: Partial<WorkspaceObservation> = {}): WorkspaceObservation {
  return {
    ...identity,
    exists: true,
    registered: true,
    headSha: "a".repeat(40),
    cleanliness: "clean",
    ...overrides,
  };
}

function verifiedTestRoot(runtimeId: string, path: string, inode: string) {
  return {
    runtime_id: runtimeId,
    path,
    verification: "directory_identity" as const,
    directory_identity: { device: "1", inode },
  };
}

function credential(lease: ControllerLease): ControllerLeaseCredential {
  return {
    runId: lease.runId,
    controllerId: lease.controllerId,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
  };
}

export function runWorkspaceLifecycleStoreBehaviorTests(
  factory: WorkspaceLifecycleHarnessFactory
): void {
  describe(`${factory.name} workspace lifecycle behavior`, () => {
    let store: WorkspaceLifecycleHarness;
    let controller: ControllerLeaseCredential;

    beforeEach(async () => {
      store = await factory.create();
      const acquired = await store.acquireControllerLease({
        runId: "run-1",
        controllerId: "controller-1",
        leaseId: "controller-lease-1",
        now: T0,
        ttlMs: 10_000,
        initialState: {},
      });
      if (!acquired.acquired) throw new Error("controller setup failed");
      controller = credential(acquired.lease);
    });

    afterEach(async () => store.close());

    async function createAttempt(
      attemptId = "attempt-1",
      workItemId = "work-1",
      packet = { packetId: DEFAULT_PACKET.packet_id, packetHash: DEFAULT_PACKET.packet_hash }
    ) {
      return store.createAttempt({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: `create-${attemptId}`,
        now: T0,
        attemptId,
        workItemId,
        workItemRevision: 7,
        packetId: packet.packetId,
        packetHash: packet.packetHash,
        baseSha: "a".repeat(40),
      });
    }

    async function acquire(overrides: Record<string, unknown> = {}) {
      return store.acquireWorkspace({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "acquire-1",
        now: T1,
        workspaceLeaseId: "workspace-lease-1",
        workItemId: "work-1",
        baseSha: "a".repeat(40),
        expectedAttemptRevision: 0,
        ttlMs: 5_000,
        ...identity,
        ...overrides,
      });
    }

    async function launchReadyAttempt() {
      await createAttempt();
      await acquire({ observation: observation() });
      await store.transitionAttempt({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "launch-1",
        now: T2,
        attemptId: "attempt-1",
        expectedAttemptRevision: 1,
        status: "launching",
      });
      await bindEnvelope();
    }

    it("rejects blind work retries and atomically preserves a meaningful retry delta", async () => {
      await createAttempt();
      await store.transitionAttempt({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "cancel-first-attempt",
        now: T1,
        attemptId: "attempt-1",
        expectedAttemptRevision: 0,
        status: "cancelled",
      });
      const retryInput = {
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "create-attempt-2",
        now: T2,
        attemptId: "attempt-2",
        workItemId: "work-1",
        workItemRevision: 7,
        packetId: "packet-2",
        packetHash: `sha256:${"b".repeat(64)}`,
        baseSha: "a".repeat(40),
      };

      await expect(store.createAttempt(retryInput)).resolves.toMatchObject({
        updated: false,
        reason: "retry_delta_required",
      });
      const retry = {
        schema_version: "1.0.0" as const,
        previous_attempt_id: "attempt-1",
        next_attempt_id: "attempt-2",
        work_item_id: "work-1",
        work_item_revision: 7,
        changes: [
          {
            dimension: "strategy" as const,
            before_hash: `sha256:${"1".repeat(64)}`,
            after_hash: `sha256:${"2".repeat(64)}`,
          },
        ],
        inherited_evidence: [],
        summary: "Use the narrowed strategy learned from the cancelled attempt.",
        created_at: T2,
      };
      await expect(
        store.createAttempt({
          ...retryInput,
          retry: {
            ...retry,
            inherited_evidence: [
              {
                kind: "artifact" as const,
                id: "caller-asserted-artifact",
                hash: `sha256:${"3".repeat(64)}`,
              },
            ],
          },
        })
      ).resolves.toMatchObject({ updated: false, reason: "retry_delta_invalid" });
      const created = await store.createAttempt({ ...retryInput, retry });
      expect(created).toMatchObject({
        updated: true,
        attempt: { attemptId: "attempt-2", status: "prepared" },
        event: { payload: { retryDeltaHash: expect.stringMatching(/^sha256:/u) } },
      });
      await expect(store.getAttemptRetryDelta("attempt-2")).resolves.toMatchObject({
        attemptId: "attempt-2",
        previousAttemptId: "attempt-1",
        deltaHash: computeCanonicalHash(retry),
        createdAt: T2,
      });
      await expect(store.getAttempt("attempt-1")).resolves.toMatchObject({
        status: "cancelled",
        completedAt: T1,
      });
      await expect(store.listAttempts("run-1")).resolves.toHaveLength(2);
    });

    it("binds parallel Attempts to declared premises and persists deterministic fan-in", async () => {
      const plan = AgentWorkFanoutPlan_v1.parse({
        schema_version: "1.0.0",
        fanout_id: "fanout-1",
        run_id: "run-1",
        work_item_id: "parallel-work",
        work_item_revision: 1,
        rationale: "hypothesis_diversity",
        selection_criteria: ["verification_outcome", "trust_gap_count", "verified_result_identity"],
        budget: {
          max_attempts: 2,
          max_concurrency: 2,
          max_elapsed_ms: 60_000,
          max_context_bytes_per_attempt: 32_768,
          max_judging_cost_units: 10,
        },
        premises: [
          {
            premise_id: "premise-a",
            attempt_id: "parallel-a",
            strategy_hash: `sha256:${"a".repeat(64)}`,
            summary: "Test the narrow implementation hypothesis.",
          },
          {
            premise_id: "premise-b",
            attempt_id: "parallel-b",
            strategy_hash: `sha256:${"b".repeat(64)}`,
            summary: "Test the compatibility-first hypothesis.",
          },
        ],
        direct_worker_communication: "forbidden",
        created_at: T0,
      });
      const fanout = new AgentWorkFanoutService(store);
      await expect(
        fanout.create({
          runId: "run-1",
          expectedRunRevision: 0,
          controller,
          mutationId: "create-fanout-1",
          now: T0,
          plan,
        })
      ).resolves.toMatchObject({ created: true, idempotentReplay: false });
      const [bindingA, bindingB] = await Promise.all([
        fanout.binding("fanout-1", "parallel-a"),
        fanout.binding("fanout-1", "parallel-b"),
      ]);
      if (!bindingA || !bindingB) throw new Error("expected fanout bindings");
      for (const [attemptId, packetId, binding] of [
        ["parallel-a", "parallel-packet-a", bindingA],
        ["parallel-b", "parallel-packet-b", bindingB],
      ] as const) {
        const created = await store.createAttempt({
          runId: "run-1",
          controller,
          expectedRunRevision: 0,
          mutationId: `create-${attemptId}`,
          now: T0,
          attemptId,
          workItemId: "parallel-work",
          workItemRevision: 1,
          packetId,
          packetHash: `sha256:${attemptId === "parallel-a" ? "c".repeat(64) : "d".repeat(64)}`,
          baseSha: "a".repeat(40),
          fanout: binding,
        });
        expect(created).toMatchObject({ updated: true, attempt: { attemptId } });
        await expect(store.getAttemptFanoutBinding(attemptId)).resolves.toMatchObject({
          fanoutId: "fanout-1",
          attemptId,
        });
      }
      for (const attemptId of ["parallel-a", "parallel-b"]) {
        await store.transitionAttempt({
          runId: "run-1",
          controller,
          expectedRunRevision: 0,
          mutationId: `cancel-${attemptId}`,
          now: T1,
          attemptId,
          expectedAttemptRevision: 0,
          status: "cancelled",
        });
      }
      const decision = await fanout.decide({
        runId: "run-1",
        expectedRunRevision: 0,
        controller,
        mutationId: "decide-fanout-1",
        now: T2,
        fanoutId: "fanout-1",
        decisionId: "fanin-1",
      });
      expect(decision).toMatchObject({
        recorded: true,
        outcome: "escalated",
        candidateCount: 2,
        idempotentReplay: false,
      });
      expect(decision).not.toHaveProperty("diagnostics");
      const persisted = await store.getFanInDecisionForFanout("fanout-1");
      expect(persisted).toMatchObject({
        decisionId: "fanin-1",
        outcome: "escalated",
      });
      if (!persisted) throw new Error("expected persisted fan-in decision");
      const forged = JSON.parse(persisted.decisionJson) as {
        decision_id: string;
        candidates: Array<{ conclusion: string; reason_codes: string[] }>;
      };
      forged.decision_id = "fanin-forged";
      forged.candidates[0]!.conclusion = "unselected";
      forged.candidates[0]!.reason_codes = ["caller_selected_conclusion"];
      await expect(
        store.commitFanInDecision({
          runId: "run-1",
          expectedRunRevision: 0,
          controller,
          mutationId: "forge-fan-in",
          now: T2,
          decision: forged as never,
        })
      ).resolves.toMatchObject({ recorded: false, reason: "fanout_evidence_mismatch" });
    });

    it("requires every retry fanout sibling to bind the same prior terminal evidence", async () => {
      await store.createAttempt({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "create-prior-fanout-attempt",
        now: T0,
        attemptId: "prior-fanout-attempt",
        workItemId: "retry-fanout-work",
        workItemRevision: 1,
        packetId: "prior-fanout-packet",
        packetHash: `sha256:${"8".repeat(64)}`,
        baseSha: "a".repeat(40),
      });
      await store.transitionAttempt({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "cancel-prior-fanout-attempt",
        now: T1,
        attemptId: "prior-fanout-attempt",
        expectedAttemptRevision: 0,
        status: "cancelled",
      });
      const plan = AgentWorkFanoutPlan_v1.parse({
        schema_version: "1.0.0",
        fanout_id: "retry-fanout",
        run_id: "run-1",
        work_item_id: "retry-fanout-work",
        work_item_revision: 1,
        rationale: "hypothesis_diversity",
        selection_criteria: ["verification_outcome", "trust_gap_count", "verified_result_identity"],
        budget: {
          max_attempts: 2,
          max_concurrency: 2,
          max_elapsed_ms: 60_000,
          max_context_bytes_per_attempt: 32_768,
          max_judging_cost_units: 10,
        },
        premises: [
          {
            premise_id: "retry-premise-a",
            attempt_id: "retry-parallel-a",
            strategy_hash: `sha256:${"a".repeat(64)}`,
            summary: "Apply the first changed premise.",
          },
          {
            premise_id: "retry-premise-b",
            attempt_id: "retry-parallel-b",
            strategy_hash: `sha256:${"b".repeat(64)}`,
            summary: "Apply the second changed premise.",
          },
        ],
        direct_worker_communication: "forbidden",
        created_at: T1,
      });
      const fanout = new AgentWorkFanoutService(store);
      await fanout.create({
        runId: "run-1",
        expectedRunRevision: 0,
        controller,
        mutationId: "create-retry-fanout",
        now: T1,
        plan,
      });

      for (const attemptId of ["retry-parallel-a", "retry-parallel-b"]) {
        const binding = await fanout.binding("retry-fanout", attemptId);
        if (!binding) throw new Error("expected retry fanout binding");
        const input = {
          runId: "run-1",
          controller,
          expectedRunRevision: 0,
          mutationId: `create-${attemptId}`,
          now: T2,
          attemptId,
          workItemId: "retry-fanout-work",
          workItemRevision: 1,
          packetId: `packet-${attemptId}`,
          packetHash: `sha256:${attemptId.endsWith("a") ? "c".repeat(64) : "d".repeat(64)}`,
          baseSha: "a".repeat(40),
          fanout: binding,
        };
        if (attemptId === "retry-parallel-a") {
          await expect(store.createAttempt(input)).resolves.toMatchObject({
            updated: false,
            reason: "retry_delta_required",
          });
        }
        const retry = {
          schema_version: "1.0.0" as const,
          previous_attempt_id: "prior-fanout-attempt",
          next_attempt_id: attemptId,
          work_item_id: "retry-fanout-work",
          work_item_revision: 1,
          changes: [
            {
              dimension: "premise" as const,
              before_hash: `sha256:${"0".repeat(64)}`,
              after_hash: binding.premise_hash,
            },
          ],
          inherited_evidence: [],
          summary: `Retry through ${binding.premise_id}.`,
          created_at: T2,
        };
        await expect(
          store.createAttempt({ ...input, mutationId: `retry-${attemptId}`, retry })
        ).resolves.toMatchObject({ updated: true, attempt: { attemptId } });
        await expect(store.getAttemptRetryDelta(attemptId)).resolves.toMatchObject({
          previousAttemptId: "prior-fanout-attempt",
          deltaHash: computeCanonicalHash(retry),
        });
      }
    });

    function envelopeBindingInput(overrides: Record<string, unknown> = {}) {
      const createdAt = "2026-07-11T12:00:02.250Z";
      const envelopeId = "envelope-1";
      const pathMapping = createNativeExecutionPathMapping({
        schema_version: "1.0.0",
        mapping_kind: "native_linux",
        repository_id: "repo-1",
        base_sha: "a".repeat(40),
        native_host_id: "host-1",
        git_runtime: "wsl-git",
        roots: {
          native_repository: verifiedTestRoot("wsl-git", "/srv/repo", "11"),
          native_allocation_root: verifiedTestRoot("wsl-git", "/srv/worktrees", "12"),
          native_worktree: verifiedTestRoot("wsl-git", "/srv/worktrees/work-1", "13"),
        },
      });
      const envelope = {
        schema_version: "1.0.0",
        envelope_id: envelopeId,
        run_id: "run-1",
        attempt_id: "attempt-1",
        packet_id: "packet-1",
        packet_hash: DEFAULT_PACKET.packet_hash,
        workspace_lease_id: "workspace-lease-1",
        workspace_lease_revision: 0,
        expected_head_sha: "a".repeat(40),
        branch: "agent/work-1",
        runtime: {
          host_id: "host-1",
          os: "linux",
          architecture: "x64",
          git_runtime: "wsl-git",
          worker_runtime: "codex-native",
        },
        paths: {
          project_root: "/srv/worktrees/work-1",
          execution_root: "/srv/worktrees/work-1",
          allocation_root: "/srv/worktrees",
          worktree_root: "/srv/worktrees/work-1",
        },
        path_mappings: [pathMapping],
        exposed_environment_keys: [],
        created_at: createdAt,
      };
      const envelopeJson = canonicalJSONStringify(envelope);
      return {
        runId: "run-1",
        attemptId: "attempt-1",
        workspaceLeaseId: "workspace-lease-1",
        expectedRunRevision: 0,
        expectedAttemptRevision: 2,
        expectedWorkspaceLeaseRevision: 0,
        controller,
        authorizationMutationId: "launch-1",
        envelopeId,
        envelopeHash: computeCanonicalHash(envelope),
        envelopeJson,
        packetJson: DEFAULT_PACKET_JSON,
        createdAt,
        ...overrides,
      };
    }

    async function bindEnvelope(overrides: Record<string, unknown> = {}) {
      return store.bindLaunchEnvelope(envelopeBindingInput(overrides));
    }

    function launchReconciliationInput(overrides: Record<string, unknown> = {}) {
      return {
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "reconcile-incomplete-launch-1",
        now: T3,
        attemptId: "attempt-1",
        workspaceLeaseId: "workspace-lease-1",
        expectedAttemptRevision: 2,
        expectedWorkspaceLeaseRevision: 0,
        ...overrides,
      };
    }

    function attachInput(overrides: Record<string, unknown> = {}) {
      return {
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "attach-worker-1",
        now: T3,
        attemptId: "attempt-1",
        workspaceLeaseId: "workspace-lease-1",
        expectedAttemptRevision: 2,
        expectedWorkspaceLeaseRevision: 0,
        sessionId: "worker-session-1",
        packetId: "packet-1",
        packetHash: DEFAULT_PACKET.packet_hash,
        executionEnvelopeId: "envelope-1",
        executionEnvelopeHash: envelopeBindingInput().envelopeHash,
        hostId: "host-1",
        workerRuntime: "codex-native",
        gitRuntime: "wsl-git",
        backend: "host-subagent" as const,
        workerId: "native-session-123",
        model: "gpt-5",
        startedAt: "2026-07-11T12:00:02.500Z",
        ...overrides,
      };
    }

    function authorityInput(overrides: Record<string, unknown> = {}) {
      return {
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "authority-external-runtime-1",
        now: "2026-07-11T12:00:03.500Z",
        attemptId: "attempt-1",
        expectedAttemptRevision: 3,
        workspaceLeaseId: "workspace-lease-1",
        expectedWorkspaceLeaseRevision: 0,
        workerSessionId: "worker-session-1",
        expectedWorkerSessionRevision: 0,
        dimension: "external_runtime" as const,
        decision: "denied" as const,
        enforcement: "brokered" as const,
        actionClass: "external_runtime",
        actionHash: computeCanonicalHash({
          action_class: "external_runtime",
          executable: "docker",
        }),
        backendId: "lexrunner.argv-authority-broker",
        backendVersion: "1.0.0",
        reason: "packet_denied" as const,
        ...overrides,
      };
    }

    async function endedWorker(
      status: "completed" | "failed" | "cancelled" | "lost" = "completed"
    ) {
      await launchReadyAttempt();
      await store.attachWorkerSession(attachInput());
      return store.endWorkerSession({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: `end-for-receipt-${status}`,
        now: "2026-07-11T12:00:04.000Z",
        attemptId: "attempt-1",
        workspaceLeaseId: "workspace-lease-1",
        expectedAttemptRevision: 3,
        expectedWorkspaceLeaseRevision: 0,
        sessionId: "worker-session-1",
        expectedSessionRevision: 0,
        status,
        exitReason: status,
      });
    }

    function receiptClaim(
      outcome: "completed" | "blocked" | "failed" | "cancelled" = "completed",
      overrides: Record<string, unknown> = {}
    ) {
      return {
        schema_version: "2.0.0" as const,
        receipt_id: "receipt-1",
        run_id: "run-1",
        work_item_id: "work-1",
        work_item_revision: 7,
        attempt_id: "attempt-1",
        packet_id: "packet-1",
        packet_hash: DEFAULT_PACKET.packet_hash,
        workspace_lease_id: "workspace-lease-1",
        workspace_lease_revision: 0,
        worker_runtime: "codex-native",
        worker_session_id: "worker-session-1",
        observed_base_sha: "a".repeat(40),
        patch_hash: `sha256:${"c".repeat(64)}`,
        outcome,
        exit_reason: outcome,
        summary: `Worker reported ${outcome}`,
        files_touched: ["src/result.ts"],
        commits: [],
        acceptance_criteria_addressed: [],
        claimed_checks: [{ id: "check-1", outcome: "pass" as const }],
        assumptions: [],
        blockers: outcome === "blocked" ? ["Needs a decision"] : [],
        human_action_request_ids: [],
        cost: { tool_calls: 1 },
        worker_started_at: "2026-07-11T12:00:02.500Z",
        worker_completed_at: "2026-07-11T12:00:04.000Z",
        submitted_at: "2026-07-11T12:00:04.500Z",
        ...overrides,
      };
    }

    function receiptInput(
      outcome: "completed" | "blocked" | "failed" | "cancelled" = "completed",
      overrides: Record<string, unknown> = {}
    ) {
      return {
        runId: "run-1",
        expectedRunRevision: 0,
        controller,
        mutationId: "submit-receipt-1",
        now: "2026-07-11T12:00:05.000Z",
        attemptId: "attempt-1",
        expectedAttemptRevision: 3,
        workspaceLeaseId: "workspace-lease-1",
        expectedWorkspaceLeaseRevision: 0,
        workerSessionId: "worker-session-1",
        expectedWorkerSessionRevision: 1,
        receipt: receiptClaim(outcome),
        ...overrides,
      };
    }

    function verificationEvidence(
      outcome: "pass" | "fail" | "inconclusive" | "infrastructure_error" | "cancelled" = "pass",
      overrides: Record<string, unknown> = {}
    ) {
      const passing = outcome === "pass";
      return parseAgentEngineVerificationV2({
        schema_version: "2.0.0",
        verification_id: "verification-1",
        run_id: "run-1",
        work_item_id: "work-1",
        work_item_revision: 7,
        attempt_id: "attempt-1",
        packet_id: "packet-1",
        packet_hash: DEFAULT_PACKET.packet_hash,
        workspace_lease_id: "workspace-lease-1",
        workspace_lease_revision: 0,
        worker_session_id: "worker-session-1",
        worker_session_revision: 1,
        receipt_id: "receipt-1",
        receipt_hash: computeCanonicalHash(parseAgentTaskReceiptV2(receiptClaim())),
        observed_base_sha: "a".repeat(40),
        verified_patch_hash: `sha256:${"c".repeat(64)}`,
        workspace_observation_hash: `sha256:${"d".repeat(64)}`,
        outcome,
        summary: `Engine reported ${outcome}`,
        checks: [
          {
            id: "check-1",
            source: "packet",
            outcome: passing ? "pass" : outcome,
            command_hash: `sha256:${"e".repeat(64)}`,
            environment_fingerprint: `sha256:${"f".repeat(64)}`,
            ...(passing ? { exit_code: 0 } : {}),
            duration_ms: 100,
            retry_count: 0,
            artifact_refs: [],
            determinism: "deterministic",
          },
          {
            id: "check-2",
            source: "packet",
            outcome: "pass",
            command_hash: `sha256:${"1".repeat(64)}`,
            environment_fingerprint: `sha256:${"2".repeat(64)}`,
            exit_code: 0,
            duration_ms: 50,
            retry_count: 0,
            artifact_refs: [],
            determinism: "deterministic",
          },
        ],
        failures: passing ? [] : [`Engine outcome: ${outcome}`],
        trust_gap_reasons: passing ? [] : ["worker_outcome_disagrees", "claimed_check_disagrees"],
        verifier_id: "lexrunner-engine",
        verifier_version: "1.1.0",
        started_at: "2026-07-11T12:00:05.100Z",
        completed_at: "2026-07-11T12:00:05.500Z",
        ...overrides,
      });
    }

    function verificationInput(
      outcome: "pass" | "fail" | "inconclusive" | "infrastructure_error" | "cancelled" = "pass",
      overrides: Record<string, unknown> = {}
    ) {
      const verification = verificationEvidence(outcome);
      return {
        runId: "run-1",
        expectedRunRevision: 0,
        controller,
        mutationId: "submit-verification-1",
        now: "2026-07-11T12:00:05.750Z",
        attemptId: "attempt-1",
        expectedAttemptRevision: 5,
        workspaceLeaseId: "workspace-lease-1",
        expectedWorkspaceLeaseRevision: 0,
        workerSessionId: "worker-session-1",
        expectedWorkerSessionRevision: 1,
        receiptId: "receipt-1",
        receiptHash: verification.receipt_hash,
        verification,
        ...overrides,
      };
    }

    function acceptanceInput(overrides: Record<string, unknown> = {}) {
      const verification = verificationEvidence();
      return {
        runId: "run-1",
        expectedRunRevision: 0,
        controller,
        mutationId: "accept-verification-1",
        now: "2026-07-11T12:00:05.900Z",
        attemptId: "attempt-1",
        expectedAttemptRevision: 6,
        workspaceLeaseId: "workspace-lease-1",
        expectedWorkspaceLeaseRevision: 0,
        workerSessionId: "worker-session-1",
        expectedWorkerSessionRevision: 1,
        receiptId: "receipt-1",
        receiptHash: verification.receipt_hash,
        verificationId: verification.verification_id,
        verificationHash: computeCanonicalHash(verification),
        ...overrides,
      };
    }

    async function receiptSubmittedAttempt() {
      await endedWorker();
      const submitted = await store.submitAttemptReceipt(receiptInput());
      if (!submitted.submitted) throw new Error("receipt setup failed");
      return submitted;
    }

    function verificationBeginInput(overrides: Record<string, unknown> = {}) {
      const receiptHash = computeCanonicalHash(parseAgentTaskReceiptV2(receiptClaim()));
      return {
        runId: "run-1",
        expectedRunRevision: 0,
        controller,
        mutationId: "begin-verification-1",
        now: "2026-07-11T12:00:05.050Z",
        verificationId: "verification-1",
        attemptId: "attempt-1",
        expectedAttemptRevision: 4,
        workspaceLeaseId: "workspace-lease-1",
        expectedWorkspaceLeaseRevision: 0,
        workerSessionId: "worker-session-1",
        expectedWorkerSessionRevision: 1,
        receiptId: "receipt-1",
        receiptHash,
        ...overrides,
      };
    }

    async function verificationStartedAttempt() {
      await receiptSubmittedAttempt();
      const started = await store.beginAttemptVerification(verificationBeginInput());
      if (!started.started) throw new Error("verification authorization setup failed");
      return started;
    }

    it("binds one canonical envelope to the audited launch authorization", async () => {
      await createAttempt();
      await acquire({ observation: observation() });
      await store.transitionAttempt({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "launch-1",
        now: T2,
        attemptId: "attempt-1",
        expectedAttemptRevision: 1,
        status: "launching",
      });
      const input = envelopeBindingInput();
      await expect(store.bindLaunchEnvelope(input)).resolves.toMatchObject({
        bound: true,
        idempotentReplay: false,
        binding: { envelopeId: "envelope-1", authorizationMutationId: "launch-1" },
      });
      await expect(store.bindLaunchEnvelope(input)).resolves.toMatchObject({
        bound: true,
        idempotentReplay: true,
      });
      await expect(
        store.bindLaunchEnvelope({ ...input, envelopeHash: `sha256:${"f".repeat(64)}` })
      ).resolves.toMatchObject({ bound: false, reason: "mutation_conflict" });
      await expect(store.getLaunchEnvelopeBinding("attempt-1")).resolves.toMatchObject({
        envelopeHash: input.envelopeHash,
      });
    });

    it("rejects a new launch-envelope binding that omits its packet snapshot", async () => {
      await createAttempt();
      await acquire({ observation: observation() });
      await store.transitionAttempt({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "launch-1",
        now: T2,
        attemptId: "attempt-1",
        expectedAttemptRevision: 1,
        status: "launching",
      });

      await expect(
        store.bindLaunchEnvelope({ ...envelopeBindingInput(), packetJson: undefined })
      ).resolves.toMatchObject({ bound: false, reason: "evidence_mismatch" });
      await expect(store.getLaunchEnvelopeBinding("attempt-1")).resolves.toBeNull();
      await expect(store.getTaskPacketBinding("attempt-1")).resolves.toBeNull();
    });

    it("persists a canonical task packet atomically with its launch envelope", async () => {
      const packet = createAgentTaskPacket({
        schema_version: "1.0.0",
        packet_id: "packet-1",
        run_id: "run-1",
        work_item: { work_item_id: "work-1", revision: 7 },
        attempt_id: "attempt-1",
        repository: { id: "repo-1", base_sha: "a".repeat(40) },
        objective: "Persist the packet snapshot",
        acceptance_criteria: [{ id: "criterion-1", text: "Packet is immutable" }],
        instructions: ["Make no host-local assumptions."],
        scope: {
          read_globs: ["src/**"],
          write_globs: ["src/**"],
          deny_globs: [],
          cross_repo_allowed: false,
        },
        authority: {
          edit: true,
          git_write: false,
          github_write: false,
          external_runtime: false,
          secrets: false,
          signing: false,
          release: false,
        },
        verification: [{ id: "check-1", argv: ["npm", "test"], expected_exit_codes: [0] }],
        budget: {},
        created_at: T2,
      });
      await createAttempt("attempt-1", "work-1", {
        packetId: packet.packet_id,
        packetHash: packet.packet_hash,
      });
      await acquire({ observation: observation() });
      await store.transitionAttempt({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "launch-1",
        now: T2,
        attemptId: "attempt-1",
        expectedAttemptRevision: 1,
        status: "launching",
      });
      const input = envelopeBindingInput();
      const envelope = JSON.parse(input.envelopeJson) as Record<string, unknown>;
      envelope.packet_hash = packet.packet_hash;
      input.envelopeJson = canonicalJSONStringify(envelope);
      input.envelopeHash = computeCanonicalHash(envelope);
      const packetJson = canonicalJSONStringify(packet);
      await expect(store.bindLaunchEnvelope({ ...input, packetJson })).resolves.toMatchObject({
        bound: true,
        idempotentReplay: false,
      });
      const binding = await store.getTaskPacketBinding("attempt-1");
      expect(binding).toEqual({
        runId: "run-1",
        attemptId: "attempt-1",
        workItemId: "work-1",
        workItemRevision: 7,
        packetId: "packet-1",
        packetHash: packet.packet_hash,
        packetJson,
        createdAt: "2026-07-11T12:00:02.250Z",
      });
      if (!binding) throw new Error("expected task packet binding");
      binding.packetJson = "{}";
      await expect(store.getTaskPacketBinding("attempt-1")).resolves.toMatchObject({ packetJson });
      await expect(store.bindLaunchEnvelope({ ...input, packetJson: "{}" })).resolves.toMatchObject(
        {
          bound: false,
          reason: "mutation_conflict",
        }
      );
    });

    it("rejects a malformed packet snapshot without writing either binding", async () => {
      await createAttempt();
      await acquire({ observation: observation() });
      await store.transitionAttempt({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "launch-1",
        now: T2,
        attemptId: "attempt-1",
        expectedAttemptRevision: 1,
        status: "launching",
      });
      await expect(
        store.bindLaunchEnvelope({ ...envelopeBindingInput(), packetJson: "{}" })
      ).resolves.toMatchObject({
        bound: false,
        reason: "evidence_mismatch",
      });
      await expect(store.getLaunchEnvelopeBinding("attempt-1")).resolves.toBeNull();
      await expect(store.getTaskPacketBinding("attempt-1")).resolves.toBeNull();
    });

    it("fails an incomplete launch closed once and replays concurrent reconciliation", async () => {
      await createAttempt();
      await acquire({ observation: observation() });
      await store.transitionAttempt({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "launch-1",
        now: T2,
        attemptId: "attempt-1",
        expectedAttemptRevision: 1,
        status: "launching",
      });
      const input = launchReconciliationInput();

      const results = await Promise.all([
        store.reconcileIncompleteLaunch(input),
        store.reconcileIncompleteLaunch(input),
      ]);

      expect(results.map((result) => result.updated && result.idempotentReplay).sort()).toEqual([
        false,
        true,
      ]);
      for (const result of results) {
        expect(result).toMatchObject({
          updated: true,
          attempt: { status: "launch_failed", revision: 3 },
          workspaceLease: { status: "active", revision: 0 },
          event: {
            type: "attempt_transitioned",
            payload: {
              status: "launch_failed",
              receiptId: null,
              verificationId: null,
              details: {
                reconciliation: "missing_launch_envelope",
                authorizationMutationId: "launch-1",
              },
            },
          },
        });
      }
      await expect(store.getLaunchEnvelopeBinding("attempt-1")).resolves.toBeNull();
      await expect(store.getTaskPacketBinding("attempt-1")).resolves.toBeNull();
      await expect(
        store.bindLaunchEnvelope(envelopeBindingInput({ expectedAttemptRevision: 3 }))
      ).resolves.toMatchObject({ bound: false, reason: "invalid_attempt_transition" });
    });

    it("lets a complete durable launch binding win reconciliation", async () => {
      await createAttempt();
      await acquire({ observation: observation() });
      await store.transitionAttempt({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "launch-1",
        now: T2,
        attemptId: "attempt-1",
        expectedAttemptRevision: 1,
        status: "launching",
      });
      await expect(bindEnvelope()).resolves.toMatchObject({ bound: true });

      await expect(
        store.reconcileIncompleteLaunch(launchReconciliationInput())
      ).resolves.toMatchObject({ updated: false, reason: "evidence_mismatch" });
      await expect(store.getAttempt("attempt-1")).resolves.toMatchObject({
        status: "launching",
        revision: 2,
      });
    });

    it("fails a missing launch binding closed after controller restart and workspace takeover", async () => {
      await createAttempt();
      await acquire({ observation: observation() });
      await store.transitionAttempt({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "launch-1",
        now: T2,
        attemptId: "attempt-1",
        expectedAttemptRevision: 1,
        status: "launching",
      });
      const takeover = await store.acquireControllerLease({
        runId: "run-1",
        controllerId: "controller-2",
        leaseId: "controller-lease-2",
        now: T_LATE,
        ttlMs: 10_000,
        initialState: {},
      });
      if (!takeover.acquired) throw new Error("expected controller takeover");
      controller = credential(takeover.lease);
      await expect(
        store.reconcileWorkspace({
          runId: "run-1",
          controller,
          expectedRunRevision: 0,
          mutationId: "resume-incomplete-launch",
          now: "2026-07-11T12:00:11.100Z",
          attemptId: "attempt-1",
          workspaceLeaseId: "workspace-lease-1",
          expectedAttemptRevision: 2,
          expectedWorkspaceLeaseRevision: 0,
          action: "resume",
          ttlMs: 5_000,
          observation: observation(),
        })
      ).resolves.toMatchObject({
        updated: true,
        attempt: { revision: 3, status: "launching" },
        workspaceLease: { revision: 1, controllerId: "controller-2" },
      });

      await expect(
        store.reconcileIncompleteLaunch(
          launchReconciliationInput({
            mutationId: "fail-incomplete-launch-after-restart",
            now: "2026-07-11T12:00:11.200Z",
            expectedAttemptRevision: 3,
            expectedWorkspaceLeaseRevision: 1,
          })
        )
      ).resolves.toMatchObject({
        updated: true,
        attempt: { revision: 4, status: "launch_failed" },
        workspaceLease: { status: "active", revision: 1 },
      });
    });

    it("attaches an exact worker identity and atomically starts the attempt", async () => {
      await launchReadyAttempt();
      const input = attachInput();
      const attached = await store.attachWorkerSession(input);
      expect(attached).toMatchObject({
        updated: true,
        idempotentReplay: false,
        attempt: { status: "running", revision: 3 },
        workerSession: {
          sessionId: "worker-session-1",
          revision: 0,
          backend: "host-subagent",
          workerId: "native-session-123",
          hostId: "host-1",
          workerRuntime: "codex-native",
          gitRuntime: "wsl-git",
          status: "running",
          startedAt: "2026-07-11T12:00:02.500Z",
          heartbeatAt: T3,
        },
        event: {
          type: "worker_session_attached",
          sequence: 1,
          attemptRevision: 3,
          sessionRevision: 0,
        },
      });

      await expect(store.attachWorkerSession(input)).resolves.toMatchObject({
        updated: true,
        idempotentReplay: true,
      });
      await expect(bindEnvelope()).resolves.toMatchObject({
        bound: true,
        idempotentReplay: true,
      });
      await expect(store.getWorkerSession("worker-session-1")).resolves.toMatchObject({
        workerId: "native-session-123",
      });
      await expect(store.getWorkerSessionForAttempt("attempt-1")).resolves.toMatchObject({
        sessionId: "worker-session-1",
      });
      await expect(store.listWorkerSessionEvents("run-1")).resolves.toHaveLength(1);
      await expect(
        store.attachWorkerSession({ ...input, workerId: "different-native-session" })
      ).resolves.toMatchObject({ updated: false, reason: "mutation_conflict" });
    });

    it("atomically persists the negotiated adapter and compact enforcement identity", async () => {
      await launchReadyAttempt();
      const adapter = {
        adapterId: "lexrunner.host-assisted",
        adapterVersion: "1.0.0",
        enforcementSummaryHash: `sha256:${"b".repeat(64)}`,
        trustGapDimensions: ["filesystem_read", "filesystem_write"],
      };
      const attached = await store.attachWorkerSession(attachInput({ adapter }));

      expect(attached).toMatchObject({
        updated: true,
        event: {
          payload: {
            adapter: {
              id: adapter.adapterId,
              version: adapter.adapterVersion,
              enforcementSummaryHash: adapter.enforcementSummaryHash,
              trustGapDimensions: adapter.trustGapDimensions,
            },
          },
        },
      });
      await expect(store.getWorkerAdapterBinding("worker-session-1")).resolves.toEqual({
        sessionId: "worker-session-1",
        ...adapter,
        createdAt: T3,
      });
    });

    it("persists redacted packet-bound worker authority decisions and deviations", async () => {
      await launchReadyAttempt();
      await store.attachWorkerSession(attachInput());

      const denied = authorityInput();
      await expect(store.recordWorkerAuthorityDecision(denied)).resolves.toMatchObject({
        recorded: true,
        idempotentReplay: false,
        event: {
          sequence: 1,
          dimension: "external_runtime",
          decision: "denied",
          enforcement: "brokered",
          reason: "packet_denied",
          packetId: "packet-1",
        },
      });
      await expect(store.recordWorkerAuthorityDecision(denied)).resolves.toMatchObject({
        recorded: true,
        idempotentReplay: true,
      });
      await expect(
        store.recordWorkerAuthorityDecision({
          ...denied,
          now: "2026-07-11T12:00:03.500Z",
        })
      ).resolves.toMatchObject({ recorded: true, idempotentReplay: true });
      await expect(
        store.recordWorkerAuthorityDecision({ ...denied, actionClass: "changed" })
      ).resolves.toMatchObject({ recorded: false, reason: "mutation_conflict" });

      await expect(
        store.recordWorkerAuthorityDecision(
          authorityInput({
            mutationId: "authority-edit-allowed",
            dimension: "edit",
            decision: "allowed",
            enforcement: "enforced",
            actionClass: "workspace_mutation",
            actionHash: computeCanonicalHash({
              action_class: "workspace_mutation",
              executable: "apply_patch",
            }),
            reason: "packet_granted",
          })
        )
      ).resolves.toMatchObject({
        recorded: true,
        event: { sequence: 2, dimension: "edit", decision: "allowed" },
      });
      await expect(
        store.recordWorkerAuthorityDecision(
          authorityInput({
            mutationId: "authority-external-deviation",
            decision: "deviation",
            enforcement: "unenforced",
            reason: "observed_after_execution",
          })
        )
      ).resolves.toMatchObject({
        recorded: true,
        event: { sequence: 3, decision: "deviation" },
      });
      const events = await store.listWorkerAuthorityEvents("run-1");
      expect(events).toHaveLength(3);
      expect(events.every((event) => !Object.hasOwn(event, "argv"))).toBe(true);
      expect(JSON.stringify(events)).not.toContain("docker");

      await expect(
        store.recordWorkerAuthorityDecision(
          authorityInput({
            mutationId: "authority-invalid-allow",
            decision: "allowed",
            reason: "packet_granted",
          })
        )
      ).resolves.toMatchObject({ recorded: false, reason: "evidence_mismatch" });
    });

    it("rejects stale, mismatched, or duplicate worker attachment", async () => {
      await launchReadyAttempt();
      await expect(
        store.attachWorkerSession(attachInput({ expectedWorkspaceLeaseRevision: 9 }))
      ).resolves.toMatchObject({ updated: false, reason: "stale_workspace_revision" });
      await expect(
        store.attachWorkerSession(attachInput({ mutationId: "bad-host", hostId: "other-host" }))
      ).resolves.toMatchObject({ updated: false, reason: "identity_mismatch" });
      await expect(
        store.attachWorkerSession(
          attachInput({ mutationId: "bad-runtime", workerRuntime: "other-runtime" })
        )
      ).resolves.toMatchObject({ updated: false, reason: "identity_mismatch" });
      await expect(
        store.attachWorkerSession(
          attachInput({
            mutationId: "early-start",
            startedAt: "2026-07-11T12:00:02.000Z",
          })
        )
      ).resolves.toMatchObject({ updated: false, reason: "invalid_time" });
      await expect(store.attachWorkerSession(attachInput())).resolves.toMatchObject({
        updated: true,
      });
      await expect(
        store.attachWorkerSession(
          attachInput({
            mutationId: "attach-worker-2",
            sessionId: "worker-session-2",
            expectedAttemptRevision: 3,
          })
        )
      ).resolves.toMatchObject({ updated: false, reason: "worker_session_conflict" });
    });

    it("reserves mutation IDs across workspace and worker lifecycle domains", async () => {
      await launchReadyAttempt();
      await expect(
        store.attachWorkerSession(attachInput({ mutationId: "launch-1" }))
      ).resolves.toMatchObject({ updated: false, reason: "mutation_conflict" });
      await store.attachWorkerSession(attachInput());
      await expect(
        store.heartbeatWorkspace({
          runId: "run-1",
          controller,
          expectedRunRevision: 0,
          mutationId: "attach-worker-1",
          now: "2026-07-11T12:00:04.000Z",
          attemptId: "attempt-1",
          workspaceLeaseId: "workspace-lease-1",
          expectedAttemptRevision: 3,
          expectedWorkspaceLeaseRevision: 0,
          ttlMs: 5_000,
          observation: observation(),
        })
      ).resolves.toMatchObject({ updated: false, reason: "mutation_conflict" });
    });

    it("prevents one live native worker identity from serving two attempts", async () => {
      const secondPacket = taskPacketSnapshot("attempt-2", "work-2");
      const secondPacketJson = canonicalJSONStringify(secondPacket);
      await createAttempt("attempt-1", "work-1");
      await createAttempt("attempt-2", "work-2", {
        packetId: secondPacket.packet_id,
        packetHash: secondPacket.packet_hash,
      });
      await acquire({ observation: observation() });
      const secondIdentity = {
        ...identity,
        attemptId: "attempt-2",
        branch: "agent/work-2",
        worktreePath: "/srv/worktrees/work-2",
      };
      await acquire({
        ...secondIdentity,
        mutationId: "acquire-2",
        workspaceLeaseId: "workspace-lease-2",
        workItemId: "work-2",
        observation: observation(secondIdentity),
      });
      for (const [attemptId, mutationId] of [
        ["attempt-1", "launch-1"],
        ["attempt-2", "launch-2"],
      ] as const) {
        await store.transitionAttempt({
          runId: "run-1",
          controller,
          expectedRunRevision: 0,
          mutationId,
          now: T2,
          attemptId,
          expectedAttemptRevision: 1,
          status: "launching",
        });
      }
      await bindEnvelope();
      const secondEnvelope = JSON.parse(envelopeBindingInput().envelopeJson) as Record<
        string,
        unknown
      >;
      secondEnvelope.envelope_id = "envelope-2";
      secondEnvelope.attempt_id = "attempt-2";
      secondEnvelope.packet_hash = secondPacket.packet_hash;
      secondEnvelope.workspace_lease_id = "workspace-lease-2";
      secondEnvelope.branch = "agent/work-2";
      const secondPaths = secondEnvelope.paths as Record<string, unknown>;
      secondPaths.project_root = "/srv/worktrees/work-2";
      secondPaths.execution_root = "/srv/worktrees/work-2";
      secondPaths.worktree_root = "/srv/worktrees/work-2";
      secondEnvelope.path_mappings = [
        createNativeExecutionPathMapping({
          schema_version: "1.0.0",
          mapping_kind: "native_linux",
          repository_id: "repo-1",
          base_sha: "a".repeat(40),
          native_host_id: "host-1",
          git_runtime: "wsl-git",
          roots: {
            native_repository: verifiedTestRoot("wsl-git", "/srv/repo", "11"),
            native_allocation_root: verifiedTestRoot("wsl-git", "/srv/worktrees", "12"),
            native_worktree: verifiedTestRoot("wsl-git", "/srv/worktrees/work-2", "14"),
          },
        }),
      ];
      const secondEnvelopeJson = canonicalJSONStringify(secondEnvelope);
      const secondEnvelopeHash = computeCanonicalHash(secondEnvelope);
      const duplicateIdEnvelope = { ...secondEnvelope, envelope_id: "envelope-1" };
      const duplicateIdEnvelopeJson = canonicalJSONStringify(duplicateIdEnvelope);
      await expect(
        store.bindLaunchEnvelope({
          ...envelopeBindingInput(),
          attemptId: "attempt-2",
          workspaceLeaseId: "workspace-lease-2",
          authorizationMutationId: "launch-2",
          envelopeId: "envelope-1",
          envelopeHash: computeCanonicalHash(duplicateIdEnvelope),
          envelopeJson: duplicateIdEnvelopeJson,
          packetJson: secondPacketJson,
        })
      ).resolves.toMatchObject({ bound: false, reason: "mutation_conflict" });
      await store.bindLaunchEnvelope({
        ...envelopeBindingInput(),
        attemptId: "attempt-2",
        workspaceLeaseId: "workspace-lease-2",
        authorizationMutationId: "launch-2",
        envelopeId: "envelope-2",
        envelopeHash: secondEnvelopeHash,
        envelopeJson: secondEnvelopeJson,
        packetJson: secondPacketJson,
      });
      await expect(store.getTaskPacketBinding("attempt-2")).resolves.toMatchObject({
        packetId: "packet-1",
        packetHash: secondPacket.packet_hash,
        packetJson: secondPacketJson,
      });
      await store.attachWorkerSession(attachInput());
      await expect(
        store.attachWorkerSession(
          attachInput({
            mutationId: "attach-worker-2",
            attemptId: "attempt-2",
            workspaceLeaseId: "workspace-lease-2",
            sessionId: "worker-session-2",
            packetHash: secondPacket.packet_hash,
            executionEnvelopeId: "envelope-2",
            executionEnvelopeHash: secondEnvelopeHash,
          })
        )
      ).resolves.toMatchObject({ updated: false, reason: "worker_session_conflict" });
    });

    it("heartbeats and ends worker sessions with revision fencing and audit events", async () => {
      await launchReadyAttempt();
      await store.attachWorkerSession(attachInput());
      const heartbeat = await store.heartbeatWorkerSession({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "heartbeat-worker-1",
        now: "2026-07-11T12:00:04.000Z",
        attemptId: "attempt-1",
        workspaceLeaseId: "workspace-lease-1",
        expectedAttemptRevision: 3,
        expectedWorkspaceLeaseRevision: 0,
        sessionId: "worker-session-1",
        expectedSessionRevision: 0,
        status: "awaiting_human",
      });
      expect(heartbeat).toMatchObject({
        updated: true,
        workerSession: { revision: 1, status: "awaiting_human" },
        event: { type: "worker_session_heartbeat", sequence: 2 },
      });
      await expect(
        store.heartbeatWorkerSession({
          runId: "run-1",
          controller,
          expectedRunRevision: 0,
          mutationId: "heartbeat-worker-stale",
          now: "2026-07-11T12:00:04.500Z",
          attemptId: "attempt-1",
          workspaceLeaseId: "workspace-lease-1",
          expectedAttemptRevision: 3,
          expectedWorkspaceLeaseRevision: 0,
          sessionId: "worker-session-1",
          expectedSessionRevision: 0,
        })
      ).resolves.toMatchObject({
        updated: false,
        reason: "stale_session_revision",
        currentSessionRevision: 1,
      });
      const ended = await store.endWorkerSession({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "end-worker-1",
        now: "2026-07-11T12:00:05.000Z",
        attemptId: "attempt-1",
        workspaceLeaseId: "workspace-lease-1",
        expectedAttemptRevision: 3,
        expectedWorkspaceLeaseRevision: 0,
        sessionId: "worker-session-1",
        expectedSessionRevision: 1,
        status: "completed",
        exitReason: "work_complete",
        exitCode: 0,
        exitSummary: "Implementation and focused checks completed.",
      });
      expect(ended).toMatchObject({
        updated: true,
        attempt: { status: "running", revision: 3 },
        workerSession: {
          revision: 2,
          status: "completed",
          endedAt: "2026-07-11T12:00:05.000Z",
          exitCode: 0,
        },
        event: { type: "worker_session_ended", sequence: 3 },
      });
      await expect(store.listWorkerSessionEvents("run-1")).resolves.toHaveLength(3);
    });

    it("preserves awaiting-human status when a heartbeat omits status", async () => {
      await launchReadyAttempt();
      await store.attachWorkerSession(attachInput());
      const common = {
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        attemptId: "attempt-1",
        workspaceLeaseId: "workspace-lease-1",
        expectedAttemptRevision: 3,
        expectedWorkspaceLeaseRevision: 0,
        sessionId: "worker-session-1",
      };
      await store.heartbeatWorkerSession({
        ...common,
        mutationId: "heartbeat-awaiting",
        now: "2026-07-11T12:00:04.000Z",
        expectedSessionRevision: 0,
        status: "awaiting_human",
      });
      await expect(
        store.heartbeatWorkerSession({
          ...common,
          mutationId: "heartbeat-omitted",
          now: "2026-07-11T12:00:04.500Z",
          expectedSessionRevision: 1,
        })
      ).resolves.toMatchObject({
        updated: true,
        workerSession: { revision: 2, status: "awaiting_human" },
        event: { payload: { status: "awaiting_human" } },
      });
    });

    it("atomically fails the attempt when its worker fails or is lost", async () => {
      await launchReadyAttempt();
      await store.attachWorkerSession(attachInput());
      const ended = await store.endWorkerSession({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "lose-worker-1",
        now: "2026-07-11T12:00:04.000Z",
        attemptId: "attempt-1",
        workspaceLeaseId: "workspace-lease-1",
        expectedAttemptRevision: 3,
        expectedWorkspaceLeaseRevision: 0,
        sessionId: "worker-session-1",
        expectedSessionRevision: 0,
        status: "lost",
        exitReason: "native_session_missing",
      });
      expect(ended).toMatchObject({
        updated: true,
        attempt: { status: "failed", revision: 4, completedAt: "2026-07-11T12:00:04.000Z" },
        workerSession: { status: "lost", revision: 1 },
        event: { attemptRevision: 4 },
      });
    });

    it("rejects unbounded worker exit metadata without mutating the session", async () => {
      await launchReadyAttempt();
      await store.attachWorkerSession(attachInput());
      await expect(
        store.endWorkerSession({
          runId: "run-1",
          controller,
          expectedRunRevision: 0,
          mutationId: "end-worker-unbounded",
          now: "2026-07-11T12:00:04.000Z",
          attemptId: "attempt-1",
          workspaceLeaseId: "workspace-lease-1",
          expectedAttemptRevision: 3,
          expectedWorkspaceLeaseRevision: 0,
          sessionId: "worker-session-1",
          expectedSessionRevision: 0,
          status: "failed",
          exitSummary: "x".repeat(4_097),
        })
      ).resolves.toMatchObject({ updated: false, reason: "evidence_mismatch" });
      await expect(store.getWorkerSession("worker-session-1")).resolves.toMatchObject({
        revision: 0,
        status: "running",
      });
    });

    it.each([
      ["completed", "receipt_submitted"],
      ["blocked", "blocked"],
      ["failed", "failed"],
      ["cancelled", "cancelled"],
    ] as const)("atomically applies active %s receipt claims", async (outcome, status) => {
      await endedWorker();
      const input = receiptInput(outcome);
      const submitted = await store.submitAttemptReceipt(input);
      expect(submitted).toMatchObject({
        submitted: true,
        idempotentReplay: false,
        receipt: {
          receiptId: "receipt-1",
          disposition: "verification_pending",
          outcome,
          workerSessionRevision: 1,
        },
        attempt: { status, revision: 4, receiptId: "receipt-1" },
        event: { type: "attempt_receipt_submitted", sequence: 1 },
      });
      if (!submitted.submitted) throw new Error("receipt submission failed");
      expect(submitted.receipt.receiptHash).toBe(computeCanonicalHash(input.receipt));
      expect(submitted.receipt.receiptJson).toBe(canonicalJSONStringify(input.receipt));
      await expect(store.getAttemptReceipt("receipt-1")).resolves.toEqual(submitted.receipt);
      await expect(store.getAttemptReceiptForAttempt("attempt-1")).resolves.toEqual(
        submitted.receipt
      );
      await expect(store.getAttemptReceiptByHash(submitted.receipt.receiptHash)).resolves.toEqual(
        submitted.receipt
      );
    });

    it("replays receipts by mutation ID and canonical hash while reserving the mutation namespace", async () => {
      await endedWorker();
      const input = receiptInput();
      const first = await store.submitAttemptReceipt(input);
      expect(first).toMatchObject({ submitted: true, idempotentReplay: false });
      await expect(store.submitAttemptReceipt(input)).resolves.toMatchObject({
        submitted: true,
        idempotentReplay: true,
      });
      await expect(
        store.submitAttemptReceipt({
          ...input,
          mutationId: "submit-receipt-hash-wrong-lease",
          workspaceLeaseId: "other-lease",
        })
      ).resolves.toMatchObject({ submitted: false, reason: "receipt_conflict" });
      await expect(store.beginAttemptVerification(verificationBeginInput())).resolves.toMatchObject(
        {
          started: true,
          attempt: { status: "verifying", revision: 5 },
        }
      );
      await expect(
        store.submitAttemptVerification(
          verificationInput("pass", { mutationId: "verify-before-receipt-replay" })
        )
      ).resolves.toMatchObject({
        recorded: true,
        attempt: { status: "verified", revision: 6 },
      });
      await expect(
        store.submitAttemptReceipt({
          ...input,
          mutationId: "submit-receipt-hash-replay",
          now: "2026-07-11T12:00:05.900Z",
        })
      ).resolves.toMatchObject({
        submitted: true,
        idempotentReplay: true,
        receipt: { receiptId: "receipt-1" },
        attempt: { status: "receipt_submitted", revision: 4 },
        event: { type: "attempt_receipt_replayed", sequence: 2 },
      });
      await expect(
        store.submitAttemptReceipt({
          ...input,
          mutationId: "launch-1",
        })
      ).resolves.toMatchObject({ submitted: false, reason: "mutation_conflict" });
      await expect(
        store.heartbeatWorkspace({
          runId: "run-1",
          controller,
          expectedRunRevision: 0,
          mutationId: "submit-receipt-hash-replay",
          now: "2026-07-11T12:00:05.900Z",
          attemptId: "attempt-1",
          workspaceLeaseId: "workspace-lease-1",
          expectedAttemptRevision: 4,
          expectedWorkspaceLeaseRevision: 0,
          ttlMs: 5_000,
          observation: observation(),
        })
      ).resolves.toMatchObject({ updated: false, reason: "mutation_conflict" });
      await expect(store.listAttemptReceiptEvents("run-1")).resolves.toHaveLength(2);
    });

    it("canonicalizes set-like receipt fields before hashing and replay fingerprinting", async () => {
      await endedWorker();
      const unordered = receiptInput("completed", {
        receipt: receiptClaim("completed", {
          files_touched: ["src/z.ts", "src/a.ts"],
          acceptance_criteria_addressed: ["criterion-2", "criterion-1"],
          claimed_checks: [
            { id: "check-2", outcome: "pass" as const },
            { id: "check-1", outcome: "pass" as const },
          ],
          assumptions: ["z assumption", "a assumption"],
          human_action_request_ids: ["request-z", "request-a"],
        }),
      });
      const first = await store.submitAttemptReceipt(unordered);
      expect(first).toMatchObject({ submitted: true, idempotentReplay: false });
      if (!first.submitted) throw new Error("receipt submission failed");

      const canonicalReceipt = receiptClaim("completed", {
        files_touched: ["src/a.ts", "src/z.ts"],
        acceptance_criteria_addressed: ["criterion-1", "criterion-2"],
        claimed_checks: [
          { id: "check-1", outcome: "pass" as const },
          { id: "check-2", outcome: "pass" as const },
        ],
        assumptions: ["a assumption", "z assumption"],
        human_action_request_ids: ["request-a", "request-z"],
      });
      expect(first.receipt.receiptHash).toBe(
        computeCanonicalHash(parseAgentTaskReceiptV2(canonicalReceipt))
      );
      await expect(
        store.submitAttemptReceipt({ ...unordered, receipt: canonicalReceipt })
      ).resolves.toMatchObject({ submitted: true, idempotentReplay: true });
    });

    it("rejects duplicate set members and dangling packet references", async () => {
      await endedWorker();
      await expect(
        store.submitAttemptReceipt(
          receiptInput("completed", {
            receipt: receiptClaim("completed", {
              files_touched: ["src/result.ts", "src/result.ts"],
            }),
          })
        )
      ).resolves.toMatchObject({ submitted: false, reason: "evidence_mismatch" });
      await expect(
        store.submitAttemptReceipt(
          receiptInput("completed", {
            mutationId: "submit-dangling-references",
            receipt: receiptClaim("completed", {
              acceptance_criteria_addressed: ["criterion-unknown"],
              claimed_checks: [{ id: "check-unknown", outcome: "pass" as const }],
            }),
          })
        )
      ).resolves.toMatchObject({ submitted: false, reason: "evidence_mismatch" });
    });

    it("rejects wrong receipt identity and a second immutable receipt", async () => {
      await endedWorker();
      await expect(
        store.submitAttemptReceipt(
          receiptInput("completed", {
            receipt: receiptClaim("completed", { packet_hash: `sha256:${"d".repeat(64)}` }),
          })
        )
      ).resolves.toMatchObject({ submitted: false, reason: "evidence_mismatch" });
      await store.submitAttemptReceipt(receiptInput());
      await expect(
        store.submitAttemptReceipt(
          receiptInput("completed", {
            mutationId: "submit-receipt-2",
            expectedAttemptRevision: 4,
            receipt: receiptClaim("completed", {
              receipt_id: "receipt-2",
              summary: "A distinct second claim",
            }),
          })
        )
      ).resolves.toMatchObject({ submitted: false, reason: "receipt_conflict" });
    });

    it("fences receipt submission by controller and every current entity revision", async () => {
      await endedWorker();
      await expect(
        store.submitAttemptReceipt(receiptInput("completed", { expectedAttemptRevision: 99 }))
      ).resolves.toMatchObject({ submitted: false, reason: "stale_attempt_revision" });
      await expect(
        store.submitAttemptReceipt(
          receiptInput("completed", { expectedWorkspaceLeaseRevision: 99 })
        )
      ).resolves.toMatchObject({ submitted: false, reason: "stale_workspace_revision" });
      await expect(
        store.submitAttemptReceipt(receiptInput("completed", { expectedWorkerSessionRevision: 99 }))
      ).resolves.toMatchObject({ submitted: false, reason: "stale_session_revision" });
      await expect(
        store.submitAttemptReceipt(
          receiptInput("completed", {
            controller: { ...controller, fencingToken: controller.fencingToken + 1 },
          })
        )
      ).resolves.toMatchObject({ submitted: false, reason: "stale_fence" });
    });

    it.each([
      ["work item", { work_item_id: "other-work" }],
      ["work revision", { work_item_revision: 8 }],
      ["Attempt", { attempt_id: "other-attempt" }],
      ["packet", { packet_id: "other-packet" }],
      ["lease", { workspace_lease_id: "other-lease" }],
      ["launch revision", { workspace_lease_revision: 9 }],
      ["runtime", { worker_runtime: "other-runtime" }],
      ["session", { worker_session_id: "other-session" }],
      ["base", { observed_base_sha: "d".repeat(40) }],
    ] as const)("rejects mismatched receipt %s binding", async (_field, claimOverride) => {
      await endedWorker();
      await expect(
        store.submitAttemptReceipt(
          receiptInput("completed", { receipt: receiptClaim("completed", claimOverride) })
        )
      ).resolves.toMatchObject({ submitted: false, reason: "evidence_mismatch" });
    });

    it.each(["failed", "cancelled", "lost"] as const)(
      "retains correctly bound evidence after worker %s without advancing Attempt",
      async (workerStatus) => {
        await endedWorker(workerStatus);
        const attempt = await store.getAttempt("attempt-1");
        const input = receiptInput(workerStatus === "cancelled" ? "cancelled" : "failed", {
          expectedAttemptRevision: attempt!.revision,
        });
        await expect(store.submitAttemptReceipt(input)).resolves.toMatchObject({
          submitted: true,
          receipt: { disposition: "retained_late" },
          attempt: { status: attempt!.status, revision: attempt!.revision, receiptId: null },
          event: { type: "attempt_receipt_retained_late" },
        });
      }
    );

    it("retains correctly bound evidence after workspace expiry", async () => {
      await endedWorker();
      await expect(
        store.submitAttemptReceipt(
          receiptInput("completed", {
            now: "2026-07-11T12:00:07.000Z",
            receipt: receiptClaim("completed", {
              submitted_at: "2026-07-11T12:00:06.500Z",
            }),
          })
        )
      ).resolves.toMatchObject({
        submitted: true,
        receipt: { disposition: "retained_late" },
        attempt: { status: "running", revision: 3, receiptId: null },
      });
      await expect(
        store.transitionAttempt({
          runId: "run-1",
          controller,
          expectedRunRevision: 0,
          mutationId: "cannot-attach-retained-late-receipt",
          now: "2026-07-11T12:00:07.000Z",
          attemptId: "attempt-1",
          expectedAttemptRevision: 3,
          status: "failed",
          receiptId: "receipt-1",
        })
      ).resolves.toMatchObject({ updated: false, reason: "evidence_mismatch" });
      await expect(store.getAttempt("attempt-1")).resolves.toMatchObject({
        status: "running",
        revision: 3,
        receiptId: null,
      });
    });

    it("closes direct receipt-submitted transitions without durable evidence", async () => {
      await launchReadyAttempt();
      await store.attachWorkerSession(attachInput());
      await expect(
        store.transitionAttempt({
          runId: "run-1",
          controller,
          expectedRunRevision: 0,
          mutationId: "bypass-receipt",
          now: "2026-07-11T12:00:04.000Z",
          attemptId: "attempt-1",
          expectedAttemptRevision: 3,
          status: "receipt_submitted",
          receiptId: "not-durable",
        })
      ).resolves.toMatchObject({ updated: false, reason: "evidence_mismatch" });
      await expect(
        store.transitionAttempt({
          runId: "run-1",
          controller,
          expectedRunRevision: 0,
          mutationId: "bypass-terminal-receipt",
          now: "2026-07-11T12:00:04.000Z",
          attemptId: "attempt-1",
          expectedAttemptRevision: 3,
          status: "blocked",
          receiptId: "not-durable",
        })
      ).resolves.toMatchObject({ updated: false, reason: "evidence_mismatch" });
    });

    it.each([
      ["pass", "verified"],
      ["fail", "rejected"],
      ["inconclusive", "inconclusive"],
      ["infrastructure_error", "inconclusive"],
      ["cancelled", "inconclusive"],
    ] as const)("atomically persists engine %s evidence as %s", async (outcome, status) => {
      const started = await verificationStartedAttempt();
      expect(started).toMatchObject({
        attempt: { status: "verifying", revision: 5 },
        event: { type: "attempt_verification_started", sequence: 1, outcome: null },
      });
      const input = verificationInput(outcome);
      const recorded = await store.submitAttemptVerification(input);
      expect(recorded).toMatchObject({
        recorded: true,
        idempotentReplay: false,
        verification: {
          verificationId: "verification-1",
          outcome,
          resultingAttemptStatus: status,
          resultingAttemptRevision: 6,
        },
        attempt: { status, revision: 6, verificationId: "verification-1" },
        event: { type: "attempt_verification_recorded", sequence: 2 },
      });
      if (!recorded.recorded) throw new Error("verification submission failed");
      expect(recorded.verification.verificationHash).toBe(computeCanonicalHash(input.verification));
      await expect(store.getAttemptVerification("verification-1")).resolves.toEqual(
        recorded.verification
      );
      await expect(store.getAttemptVerificationForAttempt("attempt-1")).resolves.toEqual(
        recorded.verification
      );
      await expect(
        store.getAttemptVerificationByHash(recorded.verification.verificationHash)
      ).resolves.toEqual(recorded.verification);
      await expect(store.listAttemptVerificationEvents("run-1")).resolves.toEqual([
        started.event,
        recorded.event,
      ]);
    });

    it("fences and replays the durable verification authorization", async () => {
      await receiptSubmittedAttempt();
      const input = verificationBeginInput();
      await expect(store.beginAttemptVerification(input)).resolves.toMatchObject({
        started: true,
        idempotentReplay: false,
        authorization: { verificationId: "verification-1", attemptRevision: 5 },
        attempt: { status: "verifying", revision: 5 },
      });
      await expect(store.beginAttemptVerification(input)).resolves.toMatchObject({
        started: true,
        idempotentReplay: true,
      });
      await expect(
        store.beginAttemptVerification({ ...input, receiptHash: `sha256:${"9".repeat(64)}` })
      ).resolves.toMatchObject({ started: false, reason: "mutation_conflict" });
      await expect(
        store.getAttemptVerificationAuthorization("verification-1")
      ).resolves.toMatchObject({
        verificationId: "verification-1",
        attemptId: "attempt-1",
        attemptRevision: 5,
      });
      await expect(
        store.getAttemptVerificationAuthorizationForAttempt("attempt-1")
      ).resolves.toMatchObject({ verificationId: "verification-1" });
    });

    it("applies strict policy acceptance only to exact passing evidence", async () => {
      await verificationStartedAttempt();
      await store.submitAttemptVerification(verificationInput());
      const input = acceptanceInput();
      await expect(
        store.applyAttemptAcceptance({
          ...input,
          mutationId: "accept-verification-wrong-hash",
          verificationHash: `sha256:${"9".repeat(64)}`,
        })
      ).resolves.toMatchObject({ updated: false, reason: "evidence_mismatch" });
      await expect(store.applyAttemptAcceptance(input)).resolves.toMatchObject({
        updated: true,
        idempotentReplay: false,
        attempt: { status: "accepted", revision: 7 },
        event: {
          type: "attempt_transitioned",
          payload: {
            details: {
              policyId: "lexrunner.strict-pass",
              policyVersion: "1.0.0",
              decision: "accepted",
              reasonCodes: [],
            },
          },
        },
      });
      await expect(store.applyAttemptAcceptance(input)).resolves.toMatchObject({
        updated: true,
        idempotentReplay: true,
        attempt: { status: "accepted", revision: 7 },
      });
    });

    it("rejects passing verification with an unresolved trust gap", async () => {
      await verificationStartedAttempt();
      const verification = verificationEvidence("pass", {
        verified_patch_hash: `sha256:${"9".repeat(64)}`,
        trust_gap_reasons: ["patch_identity_disagrees"],
      });
      await store.submitAttemptVerification(
        verificationInput("pass", { verification, receiptHash: verification.receipt_hash })
      );
      await expect(
        store.applyAttemptAcceptance(
          acceptanceInput({ verificationHash: computeCanonicalHash(verification) })
        )
      ).resolves.toMatchObject({
        updated: true,
        attempt: { status: "rejected", revision: 7 },
        event: {
          payload: {
            details: {
              decision: "rejected",
              reasonCodes: ["trust_gap:patch_identity_disagrees"],
            },
          },
        },
      });
    });

    it("rejects completed evidence without a durable verification authorization", async () => {
      await receiptSubmittedAttempt();
      await expect(store.submitAttemptVerification(verificationInput())).resolves.toMatchObject({
        recorded: false,
        reason: "not_found",
      });
    });

    it("replays immutable verification by mutation ID and canonical hash", async () => {
      await verificationStartedAttempt();
      const input = verificationInput();
      await expect(store.submitAttemptVerification(input)).resolves.toMatchObject({
        recorded: true,
        idempotentReplay: false,
      });
      await expect(store.submitAttemptVerification(input)).resolves.toMatchObject({
        recorded: true,
        idempotentReplay: true,
      });
      await expect(
        store.submitAttemptVerification({
          ...input,
          mutationId: "submit-verification-hash-replay",
          now: "2026-07-11T12:00:05.900Z",
        })
      ).resolves.toMatchObject({
        recorded: true,
        idempotentReplay: true,
        event: { type: "attempt_verification_replayed", sequence: 3 },
      });
      await expect(
        store.submitAttemptVerification({
          ...input,
          mutationId: "submit-verification-conflict",
          workspaceLeaseId: "other-lease",
        })
      ).resolves.toMatchObject({ recorded: false, reason: "verification_conflict" });
    });

    it("fences verification identity, revisions, packet checks, and trust gaps", async () => {
      await verificationStartedAttempt();
      await expect(
        store.submitAttemptVerification(verificationInput("pass", { expectedAttemptRevision: 99 }))
      ).resolves.toMatchObject({ recorded: false, reason: "stale_attempt_revision" });
      await expect(
        store.submitAttemptVerification(
          verificationInput("pass", {
            mutationId: "verification-dangling-check",
            verification: verificationEvidence("fail", {
              checks: [
                {
                  ...verificationEvidence().checks[0],
                  id: "undeclared",
                  outcome: "fail",
                },
              ],
              failures: ["undeclared check failed"],
              trust_gap_reasons: ["worker_outcome_disagrees", "claimed_check_disagrees"],
            }),
          })
        )
      ).resolves.toMatchObject({ recorded: false, reason: "evidence_mismatch" });
      await expect(
        store.submitAttemptVerification(
          verificationInput("fail", {
            mutationId: "verification-hidden-trust-gap",
            verification: verificationEvidence("fail", { trust_gap_reasons: [] }),
          })
        )
      ).resolves.toMatchObject({ recorded: false, reason: "evidence_mismatch" });
    });

    it("prevents generic transitions from manufacturing verification state", async () => {
      await receiptSubmittedAttempt();
      await expect(
        store.transitionAttempt({
          runId: "run-1",
          controller,
          expectedRunRevision: 0,
          mutationId: "bypass-verification-persistence",
          now: "2026-07-11T12:00:05.500Z",
          attemptId: "attempt-1",
          expectedAttemptRevision: 4,
          status: "verifying",
        })
      ).resolves.toMatchObject({ updated: false, reason: "evidence_mismatch" });
    });

    it("durably creates an attempt before reserving a workspace", async () => {
      const created = await createAttempt();
      expect(created).toMatchObject({
        updated: true,
        attempt: {
          status: "prepared",
          revision: 0,
          workItemRevision: 7,
          packetId: "packet-1",
          baseSha: "a".repeat(40),
          workspaceLeaseId: null,
          receiptId: null,
          verificationId: null,
        },
        workspaceLease: null,
        event: { type: "attempt_created", sequence: 1 },
      });
      if (!created.updated) throw new Error("attempt creation failed");
      expect(() => toAttemptContract(created.attempt)).not.toThrow();

      const reserved = await acquire();
      expect(reserved).toMatchObject({
        updated: true,
        attempt: { status: "leased", revision: 1 },
        workspaceLease: {
          status: "reserved",
          revision: 0,
          runRevision: 0,
          hostId: "host-1",
          workItemRevision: 7,
          packetId: "packet-1",
          packetHash: DEFAULT_PACKET.packet_hash,
        },
        event: { type: "workspace_acquired", sequence: 2 },
      });
      if (!reserved.updated) throw new Error("workspace reservation failed");
      expect(() => toAttemptContract(reserved.attempt)).not.toThrow();
    });

    it("allows a prepared attempt to be cancelled but not to skip into later terminal states", async () => {
      await createAttempt();
      for (const status of ["blocked", "launch_failed", "quarantined"] as const) {
        await expect(
          store.transitionAttempt({
            runId: "run-1",
            controller,
            expectedRunRevision: 0,
            mutationId: `prepared-${status}`,
            now: T1,
            attemptId: "attempt-1",
            expectedAttemptRevision: 0,
            status,
          })
        ).resolves.toMatchObject({ updated: false, reason: "invalid_attempt_transition" });
      }
      const cancelled = await store.transitionAttempt({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "prepared-cancelled",
        now: T1,
        attemptId: "attempt-1",
        expectedAttemptRevision: 0,
        status: "cancelled",
      });
      expect(cancelled).toMatchObject({
        updated: true,
        attempt: { status: "cancelled", revision: 1, completedAt: T1 },
      });
      if (!cancelled.updated) throw new Error("attempt cancellation failed");
      expect(() => toAttemptContract(cancelled.attempt)).not.toThrow();
    });

    it("authenticates every mutation against the authoritative controller fence", async () => {
      await expect(
        store.createAttempt({
          runId: "run-1",
          controller: { ...controller, fencingToken: controller.fencingToken + 1 },
          expectedRunRevision: 0,
          mutationId: "forged",
          now: T0,
          attemptId: "attempt-forged",
          workItemId: "work-forged",
          workItemRevision: 1,
          packetId: "packet-forged",
          packetHash: `sha256:${"c".repeat(64)}`,
          baseSha: "a".repeat(40),
        })
      ).resolves.toEqual({ updated: false, reason: "stale_fence" });
      expect(await store.getAttempt("attempt-forged")).toBeNull();
      expect(await store.listWorkspaceLifecycleEvents("run-1")).toEqual([]);
    });

    it("binds attempt creation to the expected canonical Run revision", async () => {
      await expect(
        store.createAttempt({
          runId: "run-1",
          controller,
          expectedRunRevision: 1,
          mutationId: "stale-run",
          now: T0,
          attemptId: "attempt-stale",
          workItemId: "work-stale",
          workItemRevision: 1,
          packetId: "packet-stale",
          packetHash: `sha256:${"c".repeat(64)}`,
          baseSha: "a".repeat(40),
        })
      ).resolves.toEqual({
        updated: false,
        reason: "stale_run_revision",
        currentRunRevision: 0,
      });
      expect(await store.getAttempt("attempt-stale")).toBeNull();
    });

    it("rejects a stale expected Run revision after an authoritative Run CAS", async () => {
      await createAttempt();
      await expect(
        store.compareAndSetRunState({
          ...controller,
          expectedRevision: 0,
          mutationId: "advance-run",
          state: { phase: "planning" },
          event: { type: "run_advanced", payload: { phase: "planning" } },
          now: T1,
        })
      ).resolves.toMatchObject({ updated: true });

      await expect(acquire()).resolves.toEqual({
        updated: false,
        reason: "stale_run_revision",
        currentRunRevision: 1,
      });
      await expect(store.getWorkspaceLease("workspace-lease-1")).resolves.toBeNull();
    });

    it("makes exact mutation retries idempotent and rejects mutation-id conflicts", async () => {
      const first = await createAttempt();
      const retry = await createAttempt();
      expect(first.updated && first.idempotentReplay).toBe(false);
      expect(retry.updated && retry.idempotentReplay).toBe(true);
      expect(await store.listWorkspaceLifecycleEvents("run-1")).toHaveLength(1);

      await expect(
        store.createAttempt({
          runId: "run-1",
          controller,
          expectedRunRevision: 0,
          mutationId: "create-attempt-1",
          now: T0,
          attemptId: "different",
          workItemId: "different",
          workItemRevision: 1,
          packetId: "different",
          packetHash: `sha256:${"d".repeat(64)}`,
          baseSha: "a".repeat(40),
        })
      ).resolves.toEqual({ updated: false, reason: "mutation_conflict" });
    });

    it("enforces live attempt, branch, and worktree uniqueness", async () => {
      await createAttempt();
      await acquire();
      await expect(createAttempt("attempt-2", "work-1")).resolves.toMatchObject({
        updated: false,
        reason: "live_attempt_conflict",
      });

      await createAttempt("attempt-2", "work-2");
      await expect(
        acquire({
          mutationId: "acquire-branch-conflict",
          attemptId: "attempt-2",
          workItemId: "work-2",
          workspaceLeaseId: "workspace-lease-2",
        })
      ).resolves.toMatchObject({ updated: false, reason: "branch_conflict" });
      await expect(
        acquire({
          mutationId: "acquire-tree-conflict",
          attemptId: "attempt-2",
          workItemId: "work-2",
          workspaceLeaseId: "workspace-lease-2",
          branch: "agent/work-2",
        })
      ).resolves.toMatchObject({ updated: false, reason: "worktree_conflict" });
      await expect(
        acquire({
          mutationId: "acquire-cross-repo-tree-conflict",
          attemptId: "attempt-2",
          workItemId: "work-2",
          workspaceLeaseId: "workspace-lease-2",
          repositoryId: "repo-2",
          branch: "agent/work-2",
        })
      ).resolves.toMatchObject({ updated: false, reason: "worktree_conflict" });
    });

    it("activates a reservation from observed registration and rejects stale revisions", async () => {
      await createAttempt();
      await acquire();
      const heartbeat = await store.heartbeatWorkspace({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "heartbeat-1",
        now: T2,
        attemptId: "attempt-1",
        workspaceLeaseId: "workspace-lease-1",
        expectedAttemptRevision: 1,
        expectedWorkspaceLeaseRevision: 0,
        ttlMs: 10_000,
        observation: observation({ cleanliness: "dirty", dirtyPaths: ["src/a.ts"] }),
      });
      expect(heartbeat).toMatchObject({
        updated: true,
        attempt: { revision: 2 },
        workspaceLease: {
          status: "active",
          revision: 1,
          lastObservation: { cleanliness: "dirty" },
        },
      });
      await expect(
        store.heartbeatWorkspace({
          runId: "run-1",
          controller,
          expectedRunRevision: 0,
          mutationId: "heartbeat-stale",
          now: T3,
          attemptId: "attempt-1",
          workspaceLeaseId: "workspace-lease-1",
          expectedAttemptRevision: 1,
          expectedWorkspaceLeaseRevision: 1,
          ttlMs: 10_000,
          observation: observation(),
        })
      ).resolves.toMatchObject({ updated: false, reason: "stale_attempt_revision" });
    });

    it("replays an exact heartbeat idempotently and conflicts on changed retry input", async () => {
      await createAttempt();
      await acquire({ observation: observation() });
      const heartbeat = {
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "heartbeat-retry",
        now: T2,
        attemptId: "attempt-1",
        workspaceLeaseId: "workspace-lease-1",
        expectedAttemptRevision: 1,
        expectedWorkspaceLeaseRevision: 0,
        ttlMs: 10_000,
        observation: observation(),
      };

      const first = await store.heartbeatWorkspace(heartbeat);
      const retry = await store.heartbeatWorkspace(heartbeat);
      expect(first).toMatchObject({ updated: true, idempotentReplay: false });
      expect(retry).toEqual({ ...first, idempotentReplay: true });
      await expect(
        store.heartbeatWorkspace({
          ...heartbeat,
          observation: observation({ cleanliness: "dirty", dirtyPaths: ["changed.ts"] }),
        })
      ).resolves.toEqual({ updated: false, reason: "mutation_conflict" });
      await expect(store.listWorkspaceLifecycleEvents("run-1")).resolves.toHaveLength(3);
    });

    it("rejects an already-existing dirty workspace instead of implicitly adopting it", async () => {
      await createAttempt();
      await expect(
        acquire({
          observation: observation({ cleanliness: "dirty", dirtyPaths: ["unfinished.ts"] }),
        })
      ).resolves.toMatchObject({ updated: false, reason: "dirty_workspace" });
      await expect(store.getAttempt("attempt-1")).resolves.toMatchObject({
        revision: 0,
        status: "prepared",
        workspaceLeaseId: null,
      });
      await expect(store.getWorkspaceLease("workspace-lease-1")).resolves.toBeNull();
      await expect(store.listWorkspaceLifecycleEvents("run-1")).resolves.toHaveLength(1);
    });

    it("requires explicit reconciliation after a workspace lease expires", async () => {
      await createAttempt();
      await acquire({ ttlMs: 500, observation: observation() });
      await expect(
        store.heartbeatWorkspace({
          runId: "run-1",
          controller,
          expectedRunRevision: 0,
          mutationId: "expired-heartbeat",
          now: T2,
          attemptId: "attempt-1",
          workspaceLeaseId: "workspace-lease-1",
          expectedAttemptRevision: 1,
          expectedWorkspaceLeaseRevision: 0,
          ttlMs: 10_000,
          observation: observation(),
        })
      ).resolves.toMatchObject({ updated: false, reason: "workspace_expired" });

      const reconciled = await store.reconcileWorkspace({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "resume-expired",
        now: T2,
        attemptId: "attempt-1",
        workspaceLeaseId: "workspace-lease-1",
        expectedAttemptRevision: 1,
        expectedWorkspaceLeaseRevision: 0,
        action: "resume",
        ttlMs: 10_000,
        observation: observation(),
      });
      expect(reconciled).toMatchObject({
        updated: true,
        workspaceLease: { status: "active", revision: 1, heartbeatAt: T2 },
        event: { type: "workspace_reconciled", payload: { action: "resume" } },
      });
    });

    it("requires explicit reconciliation when a new controller takes over", async () => {
      await createAttempt();
      await acquire({ observation: observation() });
      const takeover = await store.acquireControllerLease({
        runId: "run-1",
        controllerId: "controller-2",
        leaseId: "controller-lease-2",
        now: T_LATE,
        ttlMs: 10_000,
        initialState: {},
      });
      if (!takeover.acquired) throw new Error("controller takeover failed");
      const replacement = credential(takeover.lease);

      const smuggledHeartbeat = {
        runId: "run-1",
        controller: replacement,
        expectedRunRevision: 0,
        mutationId: "takeover-smuggled-heartbeat",
        now: T_LATE,
        attemptId: "attempt-1",
        workspaceLeaseId: "workspace-lease-1",
        expectedAttemptRevision: 1,
        expectedWorkspaceLeaseRevision: 0,
        ttlMs: 10_000,
        observation: observation(),
        action: "resume",
      } as Parameters<WorkspaceLifecycleStore["heartbeatWorkspace"]>[0];
      await expect(store.heartbeatWorkspace(smuggledHeartbeat)).resolves.toMatchObject({
        updated: false,
        reason: "stale_fence",
      });

      await expect(
        store.heartbeatWorkspace({
          runId: "run-1",
          controller: replacement,
          expectedRunRevision: 0,
          mutationId: "takeover-heartbeat",
          now: T_LATE,
          attemptId: "attempt-1",
          workspaceLeaseId: "workspace-lease-1",
          expectedAttemptRevision: 1,
          expectedWorkspaceLeaseRevision: 0,
          ttlMs: 10_000,
          observation: observation(),
        })
      ).resolves.toMatchObject({ updated: false, reason: "stale_fence" });

      await expect(
        store.reconcileWorkspace({
          runId: "run-1",
          controller: replacement,
          expectedRunRevision: 0,
          mutationId: "takeover-reconcile",
          now: T_LATE,
          attemptId: "attempt-1",
          workspaceLeaseId: "workspace-lease-1",
          expectedAttemptRevision: 1,
          expectedWorkspaceLeaseRevision: 0,
          action: "resume",
          ttlMs: 10_000,
          observation: observation(),
        })
      ).resolves.toMatchObject({
        updated: true,
        workspaceLease: {
          controllerId: "controller-2",
          controllerLeaseId: "controller-lease-2",
          fencingToken: replacement.fencingToken,
        },
      });
    });

    it("quarantines an expired dirty workspace instead of resuming it", async () => {
      await createAttempt();
      await acquire({ ttlMs: 500, observation: observation() });
      const result = await store.reconcileWorkspace({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "resume-expired-dirty",
        now: T2,
        attemptId: "attempt-1",
        workspaceLeaseId: "workspace-lease-1",
        expectedAttemptRevision: 1,
        expectedWorkspaceLeaseRevision: 0,
        action: "resume",
        ttlMs: 10_000,
        observation: observation({ cleanliness: "dirty", dirtyPaths: ["unfinished.ts"] }),
      });
      expect(result).toMatchObject({
        updated: true,
        attempt: { status: "quarantined" },
        workspaceLease: { status: "quarantined", cleanupDisposition: "preserved" },
        event: { type: "workspace_quarantined", payload: { reason: "dirty_workspace" } },
      });
    });

    it("atomically quarantines dirty release and identity mismatch observations", async () => {
      await createAttempt();
      await acquire({ observation: observation() });
      const result = await store.releaseWorkspace({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "unsafe-release",
        now: T2,
        attemptId: "attempt-1",
        workspaceLeaseId: "workspace-lease-1",
        expectedAttemptRevision: 1,
        expectedWorkspaceLeaseRevision: 0,
        disposition: "discarded",
        observation: observation({ cleanliness: "dirty", dirtyPaths: ["important.txt"] }),
      });
      expect(result).toMatchObject({
        updated: true,
        attempt: { status: "quarantined", revision: 2, completedAt: T2 },
        workspaceLease: {
          status: "quarantined",
          revision: 1,
          cleanupDisposition: "preserved",
        },
        event: { type: "workspace_quarantined", payload: { reason: "dirty_workspace" } },
      });
      if (!result.updated) throw new Error("workspace quarantine failed");
      expect(() => toAttemptContract(result.attempt)).not.toThrow();
      expect(await store.listWorkspaceLifecycleEvents("run-1")).toHaveLength(3);
      await createAttempt("attempt-2", "work-2");
      const retry = {
        attemptId: "attempt-2",
        workItemId: "work-2",
        workspaceLeaseId: "workspace-lease-2",
      };
      await expect(
        acquire({ ...retry, mutationId: "quarantined-branch-reuse" })
      ).resolves.toMatchObject({
        updated: false,
        reason: "branch_conflict",
      });
      await expect(
        acquire({
          ...retry,
          mutationId: "quarantined-path-reuse",
          repositoryId: "repo-2",
          branch: "agent/work-2",
        })
      ).resolves.toMatchObject({ updated: false, reason: "worktree_conflict" });
      expect(await store.listWorkspaceLifecycleEvents("run-1")).toHaveLength(4);
      await expect(
        acquire({
          ...retry,
          mutationId: "quarantined-fresh-allocation",
          branch: "agent/work-2",
          worktreePath: "/worktrees/work-2",
        })
      ).resolves.toMatchObject({ updated: true });
    });

    it("quarantines an observed branch identity mismatch instead of adopting it", async () => {
      await createAttempt();
      await acquire({ observation: observation() });
      const result = await store.heartbeatWorkspace({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "mismatched-heartbeat",
        now: T2,
        attemptId: "attempt-1",
        workspaceLeaseId: "workspace-lease-1",
        expectedAttemptRevision: 1,
        expectedWorkspaceLeaseRevision: 0,
        ttlMs: 10_000,
        observation: observation({ branch: "somebody-elses-branch" }),
      });
      expect(result).toMatchObject({
        updated: true,
        attempt: { status: "quarantined" },
        workspaceLease: { status: "quarantined" },
        event: { type: "workspace_quarantined", payload: { reason: "identity_mismatch" } },
      });
    });

    it("quarantines a missing worktree registration observation", async () => {
      await createAttempt();
      await acquire({ observation: observation() });
      const result = await store.heartbeatWorkspace({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "unregistered-heartbeat",
        now: T2,
        attemptId: "attempt-1",
        workspaceLeaseId: "workspace-lease-1",
        expectedAttemptRevision: 1,
        expectedWorkspaceLeaseRevision: 0,
        ttlMs: 10_000,
        observation: observation({ registered: false, reason: "git worktree list missing" }),
      });
      expect(result).toMatchObject({
        updated: true,
        workspaceLease: { status: "quarantined", cleanupDisposition: "preserved" },
        event: { type: "workspace_quarantined", payload: { reason: "identity_mismatch" } },
      });
    });

    it("rejects backward heartbeats and illegal attempt transitions", async () => {
      await createAttempt();
      await acquire({ observation: observation() });
      await expect(
        store.heartbeatWorkspace({
          runId: "run-1",
          controller,
          expectedRunRevision: 0,
          mutationId: "backward-heartbeat",
          now: T0,
          attemptId: "attempt-1",
          workspaceLeaseId: "workspace-lease-1",
          expectedAttemptRevision: 1,
          expectedWorkspaceLeaseRevision: 0,
          ttlMs: 10_000,
          observation: observation(),
        })
      ).resolves.toMatchObject({ updated: false, reason: "invalid_time" });
      await expect(
        store.transitionAttempt({
          runId: "run-1",
          controller,
          expectedRunRevision: 0,
          mutationId: "skip-verification",
          now: T2,
          attemptId: "attempt-1",
          expectedAttemptRevision: 1,
          status: "accepted",
        })
      ).resolves.toMatchObject({ updated: false, reason: "invalid_attempt_transition" });
      await store.transitionAttempt({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "launch-for-backward-evidence",
        now: T2,
        attemptId: "attempt-1",
        expectedAttemptRevision: 1,
        status: "launching",
      });
      await store.transitionAttempt({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "run-for-backward-evidence",
        now: T2,
        attemptId: "attempt-1",
        expectedAttemptRevision: 2,
        status: "running",
      });
      await expect(
        store.transitionAttempt({
          runId: "run-1",
          controller,
          expectedRunRevision: 0,
          mutationId: "backward-and-missing-evidence",
          now: T0,
          attemptId: "attempt-1",
          expectedAttemptRevision: 3,
          status: "receipt_submitted",
        })
      ).resolves.toMatchObject({ updated: false, reason: "evidence_mismatch" });
      expect(await store.listWorkspaceLifecycleEvents("run-1")).toHaveLength(4);
    });

    it("binds receipt and verification evidence before terminal acceptance", async () => {
      await createAttempt();
      await acquire({ observation: observation() });
      const transition = async (
        mutationId: string,
        expectedAttemptRevision: number,
        status: "launching" | "running" | "receipt_submitted" | "verifying" | "verified",
        evidence: { receiptId?: string; verificationId?: string } = {}
      ) =>
        store.transitionAttempt({
          runId: "run-1",
          controller,
          expectedRunRevision: 0,
          mutationId,
          now: T2,
          attemptId: "attempt-1",
          expectedAttemptRevision,
          status,
          ...evidence,
        });

      expect(await transition("launch", 1, "launching")).toMatchObject({ updated: true });
      expect(await transition("run", 2, "running")).toMatchObject({ updated: true });
      expect(await transition("receipt-missing", 3, "receipt_submitted")).toMatchObject({
        updated: false,
        reason: "evidence_mismatch",
      });
      expect(
        await transition("receipt", 3, "receipt_submitted", { receiptId: "receipt-1" })
      ).toMatchObject({ updated: false, reason: "evidence_mismatch" });
      expect(await transition("verify", 3, "verifying")).toMatchObject({
        updated: false,
        reason: "invalid_attempt_transition",
      });
    });

    it("requires an active workspace before launching an attempt", async () => {
      await createAttempt();
      await acquire();

      await expect(
        store.transitionAttempt({
          runId: "run-1",
          controller,
          expectedRunRevision: 0,
          mutationId: "launch-reserved",
          now: T2,
          attemptId: "attempt-1",
          expectedAttemptRevision: 1,
          status: "launching",
        })
      ).resolves.toMatchObject({ updated: false, reason: "workspace_not_active" });
    });

    it("rejects launch at the workspace expiry boundary", async () => {
      await createAttempt();
      await acquire({ ttlMs: 1_000, observation: observation() });

      await expect(
        store.transitionAttempt({
          runId: "run-1",
          controller,
          expectedRunRevision: 0,
          mutationId: "launch-expired",
          now: T2,
          attemptId: "attempt-1",
          expectedAttemptRevision: 1,
          status: "launching",
        })
      ).resolves.toMatchObject({ updated: false, reason: "workspace_expired" });
    });

    it("requires the current controller to resume a workspace before launch", async () => {
      await createAttempt();
      await acquire({ ttlMs: 20_000, observation: observation() });
      const takeover = await store.acquireControllerLease({
        runId: "run-1",
        controllerId: "controller-2",
        leaseId: "controller-lease-2",
        now: T_LATE,
        ttlMs: 10_000,
        initialState: {},
      });
      if (!takeover.acquired) throw new Error("controller takeover failed");

      await expect(
        store.transitionAttempt({
          runId: "run-1",
          controller: credential(takeover.lease),
          expectedRunRevision: 0,
          mutationId: "launch-before-resume",
          now: T_LATE,
          attemptId: "attempt-1",
          expectedAttemptRevision: 1,
          status: "launching",
        })
      ).resolves.toMatchObject({ updated: false, reason: "stale_fence" });
    });

    it.each([
      ["wrong HEAD", observation({ headSha: "c".repeat(40) })],
      ["broker warning", observation({ reason: "ambiguous worktree ownership" })],
    ])("rejects launch from active workspace evidence with %s", async (_label, observed) => {
      await createAttempt();
      await acquire({ observation: observed });

      await expect(
        store.transitionAttempt({
          runId: "run-1",
          controller,
          expectedRunRevision: 0,
          mutationId: "launch-unsafe-evidence",
          now: T2,
          attemptId: "attempt-1",
          expectedAttemptRevision: 1,
          status: "launching",
        })
      ).resolves.toMatchObject({ updated: false, reason: "evidence_mismatch" });
    });

    it("rejects launch from a dirty workspace heartbeat", async () => {
      await createAttempt();
      await acquire();
      const heartbeat = await store.heartbeatWorkspace({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "activate-dirty",
        now: T2,
        attemptId: "attempt-1",
        workspaceLeaseId: "workspace-lease-1",
        expectedAttemptRevision: 1,
        expectedWorkspaceLeaseRevision: 0,
        ttlMs: 5_000,
        observation: observation({ cleanliness: "dirty", dirtyPaths: ["unfinished.txt"] }),
      });
      expect(heartbeat).toMatchObject({ updated: true, workspaceLease: { status: "active" } });

      await expect(
        store.transitionAttempt({
          runId: "run-1",
          controller,
          expectedRunRevision: 0,
          mutationId: "launch-dirty",
          now: T3,
          attemptId: "attempt-1",
          expectedAttemptRevision: 2,
          status: "launching",
        })
      ).resolves.toMatchObject({ updated: false, reason: "evidence_mismatch" });
    });

    it("releases a clean matching workspace with one authoritative event", async () => {
      await createAttempt();
      await acquire({ observation: observation() });
      const released = await store.releaseWorkspace({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "release-1",
        now: T2,
        attemptId: "attempt-1",
        workspaceLeaseId: "workspace-lease-1",
        expectedAttemptRevision: 1,
        expectedWorkspaceLeaseRevision: 0,
        disposition: "integrated",
        observation: observation(),
      });
      expect(released).toMatchObject({
        updated: true,
        workspaceLease: {
          status: "released",
          cleanupDisposition: "integrated",
          revision: 1,
        },
        event: { type: "workspace_released", sequence: 3 },
      });
      expect(await store.listWorkspaceLifecycleEvents("run-1")).toHaveLength(3);
    });

    it("preserves dirty abandoned work but releases only clean matching work", async () => {
      await createAttempt();
      await acquire({ observation: observation() });
      const preserved = await store.reconcileWorkspace({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "preserve-1",
        now: T2,
        attemptId: "attempt-1",
        workspaceLeaseId: "workspace-lease-1",
        expectedAttemptRevision: 1,
        expectedWorkspaceLeaseRevision: 0,
        action: "preserve",
        observation: observation({ cleanliness: "dirty" }),
      });
      expect(preserved).toMatchObject({
        updated: true,
        workspaceLease: { status: "preserved", cleanupDisposition: "preserved" },
      });
    });

    it("does not launch an attempt after its workspace was released or preserved", async () => {
      await createAttempt();
      await acquire({ observation: observation() });
      await store.releaseWorkspace({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "release-before-launch",
        now: T2,
        attemptId: "attempt-1",
        workspaceLeaseId: "workspace-lease-1",
        expectedAttemptRevision: 1,
        expectedWorkspaceLeaseRevision: 0,
        disposition: "discarded",
        observation: observation(),
      });
      await expect(
        store.transitionAttempt({
          runId: "run-1",
          controller,
          expectedRunRevision: 0,
          mutationId: "launch-after-release",
          now: T3,
          attemptId: "attempt-1",
          expectedAttemptRevision: 2,
          status: "launching",
        })
      ).resolves.toMatchObject({ updated: false, reason: "workspace_not_active" });

      await createAttempt("attempt-2", "work-2");
      await acquire({
        mutationId: "acquire-2",
        attemptId: "attempt-2",
        workItemId: "work-2",
        workspaceLeaseId: "workspace-lease-2",
        branch: "agent/work-2",
        worktreePath: "/srv/worktrees/work-2",
        observation: observation({
          attemptId: "attempt-2",
          branch: "agent/work-2",
          worktreePath: "/srv/worktrees/work-2",
        }),
      });
      await store.reconcileWorkspace({
        runId: "run-1",
        controller,
        expectedRunRevision: 0,
        mutationId: "preserve-before-launch",
        now: T2,
        attemptId: "attempt-2",
        workspaceLeaseId: "workspace-lease-2",
        expectedAttemptRevision: 1,
        expectedWorkspaceLeaseRevision: 0,
        action: "preserve",
        observation: observation({
          attemptId: "attempt-2",
          branch: "agent/work-2",
          worktreePath: "/srv/worktrees/work-2",
          cleanliness: "dirty",
        }),
      });
      await expect(
        store.transitionAttempt({
          runId: "run-1",
          controller,
          expectedRunRevision: 0,
          mutationId: "launch-after-preserve",
          now: T3,
          attemptId: "attempt-2",
          expectedAttemptRevision: 2,
          status: "launching",
        })
      ).resolves.toMatchObject({ updated: false, reason: "workspace_not_active" });
    });
  });
}
