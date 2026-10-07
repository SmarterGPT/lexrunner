import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentWorkHumanActionService } from "../../src/runs/agent-work-human-action-service.js";
import { TrustedHumanAnswerVerifier } from "../../src/runs/trusted-human-answer-verifier.js";
import { InMemoryCoordinationStore } from "../../src/store/inmemory/coordination-store.js";
import { SqliteCoordinationStore } from "../../src/store/sqlite/coordination-store.js";
import type { CoordinationStore } from "../../src/store/coordination-store.js";
import {
  WorkerHumanInputCapture,
  hashWorkerHumanInput,
} from "../../src/schemas/worker-human-input.js";
import {
  WorkerHumanAnswerPayload,
  type WorkerHumanAnswerChallenge,
} from "../../src/schemas/worker-human-answer.js";
import { canonicalJSONStringify } from "../../src/util/canonicalJson.js";

/** Controlled signer/workspace fixture; no real human channel or native authority. */
export async function humanAnswerFixture(
  kind: "memory" | "sqlite",
  time = "2026-10-07T00:00:00.000Z"
) {
  const root = await mkdtemp(join(tmpdir(), "lexrunner-human-answer-"));
  const path = join(root, "coordination.db");
  let store: CoordinationStore =
    kind === "sqlite" ? new SqliteCoordinationStore(path) : new InMemoryCoordinationStore();
  const keys = generateKeyPairSync("ed25519");
  const trust = {
    runId: "run",
    hostId: "human-host",
    keyId: "key-1",
    actorIds: ["human-1"],
    publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  const verifier = new TrustedHumanAnswerVerifier([trust]);
  const acquired = await store.acquireControllerLease({
    runId: "run",
    controllerId: "controller",
    leaseId: "controller-lease",
    now: time,
    ttlMs: 60000,
    initialState: { task: "Compare candidates", metadata: { retained: "Keep this" } },
  });
  if (!acquired.acquired) throw new Error("fixture lease failed");
  const controller = {
    runId: "run",
    controllerId: "controller",
    leaseId: "controller-lease",
    fencingToken: acquired.lease.fencingToken,
  };
  const lease = {
    leaseId: "workspace",
    runId: "run",
    attemptId: "attempt",
    revision: 2,
    repositoryId: "fixture/repo",
    hostId: "fixture-host",
    gitRuntime: "git",
    projectRoot: root,
    worktreePath: root,
    branch: "fixture",
  };
  const session = {
    runId: "run",
    attemptId: "attempt",
    workspaceLeaseId: "workspace",
    workerRuntime: "other-app",
    workerId: "other-app-thread",
    status: "awaiting_human",
  };
  const workspace = {
    async getAttempt() {
      return { runId: "run", attemptId: "attempt", workspaceLeaseId: "workspace" };
    },
    async getWorkspaceLease() {
      return lease;
    },
    async getWorkerSession() {
      return session;
    },
  } as unknown as ConstructorParameters<typeof AgentWorkHumanActionService>[1];
  const observed = {
    ...lease,
    exists: true,
    registered: true,
    headSha: "a".repeat(40),
    cleanliness: "clean" as const,
  };
  const observer = {
    async observe() {
      return observed;
    },
  };
  const serviceFor = (target: CoordinationStore, trustVerifier = verifier) =>
    new AgentWorkHumanActionService(target, workspace, observer, trustVerifier);
  let service = serviceFor(store);
  const mutation = async (mutationId: string, now = time) => ({
    controller,
    expectedRunRevision: (await store.getRunCoordination("run"))!.revision,
    mutationId,
    now,
  });
  const capture = () => {
    const connectionId = randomUUID(),
      requestJson = '{"provider_request":0,"question":"Which candidate?"}';
    return WorkerHumanInputCapture.parse({
      version: 1,
      connectionId,
      observationId: `${connectionId}:1`,
      observedAt: time,
      workerRuntime: session.workerRuntime,
      workerId: session.workerId,
      turnId: "turn",
      providerRequestId: 0,
      questions: [
        {
          id: "choice",
          header: "Candidate",
          question: "Which candidate?",
          allowOther: false,
          options: [
            { label: "A", description: "Candidate A" },
            { label: "B", description: "Candidate B" },
          ],
        },
      ],
      requestJson,
      requestHash: hashWorkerHumanInput(requestJson),
    });
  };
  const record = async (workerInput = capture()) => {
    const requestId = `worker-input:${workerInput.observationId}`;
    const result = await service.request({
      ...(await mutation("question")),
      workerInput,
      request: {
        schema_version: "1.0.0",
        request_id: requestId,
        run_id: "run",
        attempt_id: "attempt",
        workspace_lease_id: "workspace",
        worker_session_id: "worker",
        action: "other",
        summary: "Worker requires a human decision.",
        instructions: ["Review the exact persisted question."],
        suggested_commands: [],
        preconditions: {
          run_revision: 0,
          workspace_lease_revision: 2,
          expected_head_sha: observed.headSha,
        },
        requested_at: workerInput.observedAt,
      },
    });
    if (!result.ok) throw new Error(result.reason);
    return requestId;
  };
  const challenge = async (requestId: string, now = time) => {
    const result = await service.issueWorkerAnswerChallenge({
      ...(await mutation("challenge", now)),
      requestId,
      challengeId: randomUUID(),
      expiresAt: new Date(Date.parse(now) + 30000).toISOString(),
    });
    if (!result.ok || !("challenge" in result)) throw new Error("challenge failed");
    return result.challenge;
  };
  const signed = (
    challenge: WorkerHumanAnswerChallenge,
    changes: Partial<WorkerHumanAnswerPayload> = {},
    signingKey = keys.privateKey
  ) => {
    const payload = WorkerHumanAnswerPayload.parse({
      version: 1,
      challenge,
      hostId: "human-host",
      keyId: "key-1",
      actorId: "human-1",
      authenticationEventId: "auth-event-1",
      answeredAt: challenge.issuedAt,
      answers: [{ questionId: "choice", value: "A" }],
      ...changes,
    });
    return {
      payload,
      signature: sign(null, Buffer.from(canonicalJSONStringify(payload)), signingKey).toString(
        "base64url"
      ),
    };
  };
  return {
    root,
    path,
    time,
    keys,
    trust,
    verifier,
    controller,
    lease,
    session,
    workspace,
    observed,
    observer,
    serviceFor,
    mutation,
    capture,
    record,
    challenge,
    signed,
    get store() {
      return store;
    },
    get service() {
      return service;
    },
    async reopen() {
      await store.close();
      store = new SqliteCoordinationStore(path);
      service = serviceFor(store);
    },
    async cleanup() {
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
