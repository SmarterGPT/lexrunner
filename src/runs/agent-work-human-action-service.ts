import { z } from "zod";

import {
  HumanActionRequest_v1,
  HumanActionReceipt_v1,
  validateHumanActionReceiptBinding,
} from "../schemas/agent-work.js";
import { computeCanonicalHash } from "../schemas/task-contract.js";
import { WorkerHumanInputCapture } from "../schemas/worker-human-input.js";
import type {
  CoordinationStore,
  ControllerLeaseCredential,
  JsonValue,
} from "../store/coordination-store.js";
import type {
  WorkspaceLifecycleStore,
  WorkerSessionStore,
  WorkspaceObservation,
} from "../store/workspace-lifecycle-store.js";

const KEY = "agentWorkHumanActions";
const entrySchema = z
  .object({
    request: HumanActionRequest_v1,
    contextHash: z.string(),
    receipt: HumanActionReceipt_v1.nullable(),
    supersededBy: z.string().optional(),
    replacesRequestId: z.string().optional(),
    workerInput: WorkerHumanInputCapture.optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (
      entry.workerInput &&
      (entry.request.action !== "other" ||
        entry.request.request_id !== `worker-input:${entry.workerInput.observationId}` ||
        entry.request.requested_at !== entry.workerInput.observedAt ||
        entry.receipt?.outcome === "completed")
    )
      ctx.addIssue({ code: "custom", message: "Invalid worker question hold" });
  });
const stateSchema = z
  .object({ version: z.literal(1), entries: z.array(entrySchema).max(128) })
  .strict();
type HumanState = z.infer<typeof stateSchema>;

export interface HumanActionMutationInput {
  controller: ControllerLeaseCredential;
  expectedRunRevision: number;
  mutationId: string;
  now: string;
}

export type HumanActionMutationResult =
  { ok: true; revision: number; replay: boolean } | { ok: false; reason: string };

/** Fail closed on corrupt state. Receipts remain data, never execution authority. */
export function readHumanActionState(state: JsonValue): HumanState {
  const metadata = rootObject(state).metadata;
  if (metadata === undefined) return { version: 1, entries: [] };
  const value = rootObject(metadata)[KEY];
  return value === undefined ? { version: 1, entries: [] } : stateSchema.parse(value);
}

export function humanActionSummary(state: JsonValue, now: string) {
  return readHumanActionState(state)
    .entries.filter((entry) => !entry.supersededBy && entry.receipt?.outcome !== "completed")
    .map(({ request, receipt }) => ({
      requestId: request.request_id,
      attemptId: request.attempt_id,
      summary: [...request.summary].slice(0, 240).join(""),
      summaryTruncated: [...request.summary].length > 240,
      disposition:
        receipt?.outcome ??
        (request.expires_at && Date.parse(now) >= Date.parse(request.expires_at)
          ? "expired"
          : "pending"),
    }));
}

/**
 * Source-only ADR-010 service. Commit before presenting the request to a human.
 * The host must admit receipts through its authenticated human channel; actor_id
 * and a matching hash do not authenticate an agent-supplied answer.
 */
export class AgentWorkHumanActionService {
  constructor(
    private readonly coordination: CoordinationStore,
    private readonly workspace: Pick<WorkspaceLifecycleStore, "getAttempt" | "getWorkspaceLease"> &
      Pick<WorkerSessionStore, "getWorkerSession">,
    private readonly observer: {
      observe(
        lease: Awaited<ReturnType<WorkspaceLifecycleStore["getWorkspaceLease"]>> & {}
      ): Promise<WorkspaceObservation>;
    }
  ) {}

  async request(
    input: HumanActionMutationInput & {
      request: HumanActionRequest_v1;
      replacesRequestId?: string;
      workerInput?: WorkerHumanInputCapture;
    }
  ): Promise<HumanActionMutationResult> {
    input = structuredClone(input);
    if (!z.string().datetime({ offset: true }).safeParse(input.now).success)
      return { ok: false, reason: "invalid_time" };
    const request = HumanActionRequest_v1.parse(input.request);
    const workerInput =
      input.workerInput === undefined
        ? undefined
        : WorkerHumanInputCapture.parse(input.workerInput);
    if (
      workerInput &&
      (request.action !== "other" ||
        request.requested_at !== workerInput.observedAt ||
        request.request_id !== `worker-input:${workerInput.observationId}`)
    )
      return { ok: false, reason: "invalid_worker_input_binding" };
    if (
      Buffer.byteLength(JSON.stringify(request), "utf8") > 16 * 1024 ||
      request.summary.length > 2048
    )
      return { ok: false, reason: "request_too_large" };
    const record = await this.coordination.getRunCoordination(input.controller.runId);
    if (!record) return { ok: false, reason: "not_found" };
    const state = readHumanActionState(record.state);
    const prior = state.entries.find((entry) => entry.request.request_id === request.request_id);
    if (prior) {
      if (prior.supersededBy) return { ok: false, reason: "request_superseded" };
      if (
        computeCanonicalHash(prior.request) !== computeCanonicalHash(request) ||
        prior.replacesRequestId !== input.replacesRequestId ||
        computeCanonicalHash(prior.workerInput ?? null) !==
          computeCanonicalHash(workerInput ?? null)
      )
        return { ok: false, reason: "request_conflict" };
      return { ok: true, revision: record.revision, replay: true };
    }
    if (
      record.revision !== input.expectedRunRevision ||
      request.preconditions.run_revision !== record.revision
    )
      return { ok: false, reason: "stale_run_revision" };
    if (
      request.run_id !== input.controller.runId ||
      Date.parse(request.requested_at) > Date.parse(input.now) ||
      (request.expires_at && Date.parse(request.expires_at) <= Date.parse(request.requested_at))
    )
      return { ok: false, reason: "invalid_request_binding" };
    if (!(await this.matchesWorkspace(request, request.preconditions.expected_head_sha)))
      return { ok: false, reason: "stale_workspace_binding" };
    if (workerInput) {
      const session = await this.workspace.getWorkerSession(request.worker_session_id);
      if (
        session?.workerRuntime !== workerInput.workerRuntime ||
        session.workerId !== workerInput.workerId
      )
        return { ok: false, reason: "worker_input_session_mismatch" };
      if (
        state.entries.some(
          (entry) =>
            entry.workerInput &&
            entry.workerInput.connectionId === workerInput.connectionId &&
            entry.workerInput.providerRequestId === workerInput.providerRequestId
        )
      )
        return { ok: false, reason: "worker_request_already_bound" };
    }
    if (state.entries.length === 128) return { ok: false, reason: "human_action_capacity" };
    if (input.replacesRequestId) {
      const replaced = state.entries.find(
        (entry) => entry.request.request_id === input.replacesRequestId
      );
      if (!replaced || replaced.supersededBy || replaced.receipt?.outcome === "completed")
        return { ok: false, reason: "replacement_not_pending" };
      if (replaced.workerInput && !workerInput)
        return { ok: false, reason: "worker_input_replacement_required" };
      replaced.supersededBy = request.request_id;
    }
    state.entries.push({
      request,
      contextHash: contextHash(record.state),
      receipt: null,
      ...(input.replacesRequestId ? { replacesRequestId: input.replacesRequestId } : {}),
      ...(workerInput ? { workerInput } : {}),
    });
    return this.commit(input, record.state, state, "human_action_requested", request.request_id);
  }

  async settle(
    input: HumanActionMutationInput & { receipt: HumanActionReceipt_v1 }
  ): Promise<HumanActionMutationResult> {
    input = structuredClone(input);
    if (!z.string().datetime({ offset: true }).safeParse(input.now).success)
      return { ok: false, reason: "invalid_time" };
    const receipt = HumanActionReceipt_v1.parse(input.receipt);
    if (Buffer.byteLength(JSON.stringify(receipt), "utf8") > 16 * 1024)
      return { ok: false, reason: "receipt_too_large" };
    const record = await this.coordination.getRunCoordination(input.controller.runId);
    if (!record) return { ok: false, reason: "not_found" };
    const state = readHumanActionState(record.state);
    const entry = state.entries.find((item) => item.request.request_id === receipt.request_id);
    if (!entry) return { ok: false, reason: "request_not_found" };
    if (entry.supersededBy) return { ok: false, reason: "request_superseded" };
    if (entry.receipt) {
      return computeCanonicalHash(entry.receipt) === computeCanonicalHash(receipt)
        ? { ok: true, revision: record.revision, replay: true }
        : { ok: false, reason: "receipt_conflict" };
    }
    if (record.revision !== input.expectedRunRevision)
      return { ok: false, reason: "stale_run_revision" };
    const request = entry.request;
    if (
      !validateHumanActionReceiptBinding(request, receipt).valid ||
      Date.parse(receipt.completed_at) < Date.parse(request.requested_at) ||
      Date.parse(receipt.completed_at) > Date.parse(input.now)
    )
      return { ok: false, reason: "invalid_receipt_binding" };
    if (receipt.outcome === "completed") {
      // No source caller can turn a captured worker question into an answered
      // hold before authenticated admission and fenced worker delivery exist.
      if (entry.workerInput) return { ok: false, reason: "worker_answer_delivery_not_qualified" };
      if (
        request.expires_at &&
        (Date.parse(input.now) >= Date.parse(request.expires_at) ||
          Date.parse(receipt.completed_at) >= Date.parse(request.expires_at))
      )
        return { ok: false, reason: "request_expired" };
      if (entry.contextHash !== contextHash(record.state))
        return { ok: false, reason: "request_context_changed" };
      // Source pilot deliberately forbids head-changing approvals. Signing and
      // other mutations need their own independently observed admission boundary.
      if (
        receipt.resulting_head_sha &&
        receipt.resulting_head_sha !== request.preconditions.expected_head_sha
      )
        return { ok: false, reason: "head_changing_action_not_supported" };
      if (!(await this.matchesWorkspace(request, request.preconditions.expected_head_sha)))
        return { ok: false, reason: "stale_workspace_binding" };
    }
    entry.receipt = receipt;
    return this.commit(input, record.state, state, "human_action_settled", request.request_id);
  }

  private async matchesWorkspace(request: HumanActionRequest_v1, head: string): Promise<boolean> {
    const [attempt, lease, session] = await Promise.all([
      this.workspace.getAttempt(request.attempt_id),
      this.workspace.getWorkspaceLease(request.workspace_lease_id),
      this.workspace.getWorkerSession(request.worker_session_id),
    ]);
    if (
      !attempt ||
      !lease ||
      !session ||
      attempt.runId !== request.run_id ||
      attempt.workspaceLeaseId !== lease.leaseId ||
      lease.runId !== request.run_id ||
      lease.attemptId !== attempt.attemptId ||
      lease.revision !== request.preconditions.workspace_lease_revision ||
      session.runId !== request.run_id ||
      session.attemptId !== attempt.attemptId ||
      session.workspaceLeaseId !== lease.leaseId
    )
      return false;
    const observed = await this.observer.observe(lease);
    return (
      observed.exists &&
      observed.registered &&
      observed.repositoryId === lease.repositoryId &&
      observed.hostId === lease.hostId &&
      observed.gitRuntime === lease.gitRuntime &&
      observed.projectRoot === lease.projectRoot &&
      observed.worktreePath === lease.worktreePath &&
      observed.branch === lease.branch &&
      observed.attemptId === lease.attemptId &&
      observed.headSha === head
    );
  }

  private async commit(
    input: HumanActionMutationInput,
    original: JsonValue,
    state: HumanState,
    type: string,
    requestId: string
  ): Promise<HumanActionMutationResult> {
    const root = rootObject(original);
    const result = await this.coordination.compareAndSetRunState({
      ...input.controller,
      expectedRevision: input.expectedRunRevision,
      mutationId: input.mutationId,
      state: {
        ...root,
        metadata: {
          ...rootObject(root.metadata ?? {}),
          [KEY]: JSON.parse(JSON.stringify(state)) as JsonValue,
        },
      },
      event: { type, payload: { requestId } },
      now: input.now,
    });
    return result.updated
      ? { ok: true, revision: result.record.revision, replay: result.idempotentReplay }
      : { ok: false, reason: result.reason };
  }
}

function contextHash(state: JsonValue): string {
  const root = rootObject(state);
  const { [KEY]: _holds, ...metadata } = rootObject(root.metadata ?? {});
  return computeCanonicalHash({ ...root, metadata });
}

function rootObject(value: JsonValue): { [key: string]: JsonValue } {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Human actions require an object coordination state/metadata");
  return value;
}
