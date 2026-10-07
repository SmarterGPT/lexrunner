import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, lstat, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3-multiple-ciphers";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  AgentWorkHumanActionService,
  readHumanActionState,
} from "../src/runs/agent-work-human-action-service.ts";
import {
  NativeMcpHumanPresentationHost,
  mcpHumanFormChannel,
} from "../src/runs/native-mcp-human-host.ts";
import { SqliteCoordinationStore } from "../src/store/sqlite/coordination-store.ts";
import {
  WorkerHumanInputCapture,
  hashWorkerHumanInput,
} from "../src/schemas/worker-human-input.ts";

// Source-only UI qualification. Synthetic workspace/session, no signer or verifier.
// The production adapter is exercised; human trust and worker containment are not.
const version = 1;
const question =
  "UI-only sample: choose A or B, or use Skip. Your choice is recorded only as a protocol observation; it approves no work. After a timeout, leave the old form alone and explicitly request recovery.";
const requestJson = JSON.stringify({ fixture: "native-human-host-ui", question });
const specHash = hashWorkerHumanInput(requestJson);
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const empty = z.object({}).strict();
const markerSchema = z
  .object({
    version: z.literal(version),
    probeId: z.string().uuid(),
    specHash: z.literal(specHash),
  })
  .strict();
const toolSchema = { type: "object", properties: {}, additionalProperties: false };
const output = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

export async function createNativeHumanHostProbe(root, timeoutMs = 120000) {
  const sourceFiles = [
    "./probe-native-human-host.mjs",
    "../src/runs/native-mcp-human-host.ts",
    "../src/runs/agent-work-human-action-service.ts",
    "../src/runs/trusted-human-answer-verifier.ts",
    "../src/store/sqlite/coordination-store.ts",
    "../src/store/coordination-store.ts",
    "../src/schemas/worker-human-input.ts",
    "../src/schemas/worker-human-presentation.ts",
    "../src/schemas/worker-human-answer.ts",
    "../src/schemas/task-contract.ts",
    "../src/schemas/agent-work.ts",
    "../src/util/canonicalJson.ts",
    "../package-lock.json",
  ];
  const sourceDigest = digest(
    await Promise.all(
      sourceFiles.map(async (file) => ({
        file,
        sha256: createHash("sha256")
          .update(await readFile(new URL(file, import.meta.url)))
          .digest("hex"),
      }))
    )
  );
  root = resolve(root);
  if (!/^native-host-[A-Za-z0-9-]+$/u.test(basename(root)))
    throw new Error("Expected a dedicated native-host-* diagnostic directory");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 150 || timeoutMs > 120000)
    throw new Error("Probe timeout must be 150..120000ms");
  await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink())
    throw new Error("Probe directory must not be a symbolic link");
  const markerPath = join(root, "probe-marker.json");
  let marker;
  try {
    marker = markerSchema.parse(JSON.parse(await readFile(markerPath, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if ((await readdir(root)).length !== 0)
      throw new Error("Unmarked diagnostic directory is not empty; preserve and reconcile");
    marker = { version, probeId: randomUUID(), specHash };
    try {
      await writeFile(markerPath, JSON.stringify(marker), { flag: "wx" });
    } catch (writeError) {
      if (writeError.code !== "EEXIST") throw writeError;
      marker = markerSchema.parse(JSON.parse(await readFile(markerPath, "utf8")));
    }
  }
  const runId = `ui-probe:${marker.probeId}`;
  const store = new SqliteCoordinationStore(join(root, "probe-coordination.db"));
  const journal = new Database(join(root, "probe-telemetry.db"));
  journal.pragma("journal_mode = WAL");
  journal.pragma("synchronous = FULL");
  journal.exec(
    "CREATE TABLE IF NOT EXISTS observations (id INTEGER PRIMARY KEY, body TEXT NOT NULL)"
  );
  const bootId = randomUUID();
  const record = (kind, details = {}) =>
    journal
      .prepare("INSERT INTO observations(body) VALUES (?)")
      .run(JSON.stringify({ kind, bootId, at: new Date().toISOString(), ...details }));
  const workspaceLease = {
    leaseId: "synthetic-workspace",
    runId,
    attemptId: "synthetic-attempt",
    revision: 1,
    repositoryId: "diagnostic/ui-only",
    hostId: "synthetic-host",
    gitRuntime: "git",
    projectRoot: root,
    worktreePath: root,
    branch: "synthetic-fixture",
  };
  const session = {
    runId,
    attemptId: workspaceLease.attemptId,
    workspaceLeaseId: workspaceLease.leaseId,
    workerRuntime: "other-app",
    workerId: "synthetic-ui-worker",
    status: "awaiting_human",
  };
  const service = new AgentWorkHumanActionService(
    store,
    {
      getAttempt: async () => ({
        runId,
        attemptId: session.attemptId,
        workspaceLeaseId: session.workspaceLeaseId,
      }),
      getWorkspaceLease: async () => workspaceLease,
      getWorkerSession: async () => session,
    },
    {
      observe: async () => ({
        ...workspaceLease,
        exists: true,
        registered: true,
        headSha: "a".repeat(40),
        cleanliness: "clean",
      }),
    }
  );
  const server = new Server(
    { name: "lexrunner-native-human-host-probe", version: "0.0.1" },
    { capabilities: { tools: {} } }
  );
  const channel = mcpHumanFormChannel(server);
  const originalRequest = channel.request.bind(channel);
  channel.request = async (form, window) => {
    // Diagnostic-only coaching: retain the immutable question and answer schema.
    // The production projector remains unchanged; this overlay is journaled.
    const instructions = `Select B, then submit. You have up to ${timeoutMs / 1000} seconds. Use Skip to dismiss this display and keep the question pending. After expiry, stop here and request recovery; leave the old form alone.`;
    const projected = structuredClone(form);
    projected.message = `${instructions}\n\n${form.message}`;
    projected.requestedSchema.properties.q0.title = `Select B, then submit (up to ${timeoutMs / 1000} seconds)`;
    projected.requestedSchema.properties.q0.description = `${instructions}\n\n${form.requestedSchema.properties.q0.description}`;
    record("dispatch", {
      mode: projected.mode,
      projection: "diagnostic-directions-v1",
      formDigest: digest(projected),
      timeoutMs: window.timeoutMs,
    });
    return originalRequest(projected, window);
  };
  const host = new NativeMcpHumanPresentationHost(service, store, channel, {
    admitInput: async (input) => {
      record("valid_host_input_observed", {
        presentationId: input.presentation.presentationId,
        answerCount: input.answers.length,
        answerDigest: digest(input.answers),
      });
      return null; // Deliberate: no authentication/signing, admission or delivery.
    },
  });
  let active = null,
    controller = null,
    closing = null,
    ready = false;
  const shutdown = new AbortController();
  server.oninitialized = () => {
    ready = true;
    record("initialized");
  };
  const mutation = async (suffix) => ({
    controller,
    expectedRunRevision: (await store.getRunCoordination(runId)).revision,
    mutationId: `${bootId}:${suffix}:${randomUUID()}`,
    now: new Date().toISOString(),
  });
  async function status() {
    const state = await store.getRunCoordination(runId);
    const entries = state ? readHumanActionState(state.state).entries : [];
    const entry = entries[0];
    const presentation = entry
      ? await service.getWorkerQuestionPresentation(
          runId,
          entry.request.request_id,
          new Date().toISOString()
        )
      : null;
    const capabilities = server.getClientCapabilities();
    return {
      version,
      runtime: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        executable: process.execPath,
        sourceEvidence: {
          kind: "selected-startup-disk-files",
          digest: sourceDigest,
          fileCount: sourceFiles.length,
        },
        client: {
          name: server.getClientVersion()?.name?.slice(0, 128) ?? null,
          version: server.getClientVersion()?.version?.slice(0, 128) ?? null,
        },
      },
      probeId: marker.probeId,
      ready,
      inFlight: Boolean(active),
      timeoutMs,
      authority:
        "UI-only synthetic fixture; no human authentication, signing, answer admission, delivery or action permission",
      channel: {
        standardForm: Boolean(capabilities?.elicitation?.form),
        openaiForm: Boolean(
          capabilities?.extensions?.["openai/form"] ||
          capabilities?.extensions?.["openai/elicitation"]?.form
        ),
      },
      questionCount: entries.length,
      requestId: entry?.request.request_id ?? null,
      presentation,
      holdPending: Boolean(entry && !entry.receipt),
      answerAdmitted: Boolean(entry?.workerAnswer),
      observations: journal
        .prepare("SELECT body FROM observations ORDER BY id DESC LIMIT 16")
        .all()
        .reverse()
        .map((row) => JSON.parse(row.body)),
    };
  }
  async function runPresentation(recovery, signal) {
    const existing = await store.getRunCoordination(runId);
    const previousEntry = existing ? readHumanActionState(existing.state).entries[0] : null;
    const previous = previousEntry?.presentations?.at(-1);
    if (recovery && !previous) return { status: "blocked", reason: "no_previous_presentation" };
    if (!recovery && previous) return { status: "blocked", reason: "explicit_recovery_required" };
    if (signal.aborted) return { status: "pending", reason: "cancelled_before_claim" };
    const acquired = await store.acquireControllerLease({
      runId,
      controllerId: `probe:${bootId}`,
      leaseId: `probe-lease:${bootId}`,
      now: new Date().toISOString(),
      ttlMs: Math.max(60000, timeoutMs + 30000),
      initialState: {
        diagnostic: "UI-only synthetic fixture",
        metadata: { probeId: marker.probeId },
      },
    });
    if (!acquired.acquired) return { status: "blocked", reason: "another_probe_controller_active" };
    controller = {
      runId,
      controllerId: acquired.lease.controllerId,
      leaseId: acquired.lease.leaseId,
      fencingToken: acquired.lease.fencingToken,
    };
    let entry = previousEntry;
    if (!entry) {
      if (acquired.record.revision !== 0)
        return {
          status: "reconciliation_required",
          reason: "question_missing_from_existing_journal",
        };
      const observedAt = new Date().toISOString();
      const capture = WorkerHumanInputCapture.parse({
        version,
        connectionId: marker.probeId,
        observationId: `${marker.probeId}:1`,
        observedAt,
        workerRuntime: session.workerRuntime,
        workerId: session.workerId,
        turnId: "synthetic-turn",
        providerRequestId: 0,
        questions: [
          {
            id: "sample-choice",
            header: "UI-only sample",
            question,
            allowOther: false,
            options: [
              { label: "A", description: "Sample A; no work is approved" },
              { label: "B", description: "Sample B; no work is approved" },
            ],
          },
        ],
        requestJson,
        requestHash: specHash,
      });
      const requestId = `worker-input:${capture.observationId}`;
      const created = await service.request({
        ...(await mutation("question")),
        workerInput: capture,
        request: {
          schema_version: "1.0.0",
          request_id: requestId,
          run_id: runId,
          attempt_id: session.attemptId,
          workspace_lease_id: workspaceLease.leaseId,
          worker_session_id: "synthetic-session",
          action: "other",
          summary: "UI-only sample; no worker or dependent action exists.",
          instructions: ["Use the native form only for this diagnostic."],
          suggested_commands: [],
          requested_at: observedAt,
          preconditions: {
            run_revision: 0,
            workspace_lease_revision: workspaceLease.revision,
            expected_head_sha: "a".repeat(40),
          },
        },
      });
      if (!created.ok) return { status: "reconciliation_required", reason: created.reason };
      entry = readHumanActionState((await store.getRunCoordination(runId)).state).entries[0];
    }
    // Reacquiring this process's live lease does not extend its expiry.
    // Renew for each display, including same-process recovery after distraction.
    const renewed = await store.renewControllerLease({
      ...controller,
      now: new Date().toISOString(),
      ttlMs: Math.max(60000, timeoutMs + 30000),
    });
    if (!renewed.renewed)
      return { status: "blocked", reason: renewed.reason, boundary: "controller_renewal" };
    const result = await host.present(
      {
        ...(await mutation("presentation")),
        requestId: entry.request.request_id,
        presentationId: randomUUID(),
        challengeId: randomUUID(),
        expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
        ...(recovery ? { previousPresentationId: previous.presentationId } : {}),
      },
      signal
    );
    record("presentation_result", { result });
    return result;
  }
  async function present(recovery, signal) {
    if (!ready || closing) return { status: "blocked", reason: "channel_not_ready" };
    if (active) return { status: "blocked", reason: "presentation_in_progress" };
    active = runPresentation(recovery, AbortSignal.any([signal, shutdown.signal]));
    try {
      return await active;
    } finally {
      active = null;
    }
  }
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      shutdown.abort();
      try {
        await active;
      } catch {
        /* Retain uncertain journal state on shutdown. */
      }
      if (controller) await store.releaseControllerLease(controller);
      await store.close();
      journal.close();
    })();
    return closing;
  }
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "status",
        description: "Read bounded UI-only probe state; never prompts or admits answers.",
        inputSchema: toolSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "present_sample",
        description:
          "Only after explicit human readiness: show one fresh UI-only sample through the reviewed source adapter. No answer arguments or work permission.",
        inputSchema: toolSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "recover_sample",
        description:
          "Only after explicit human return/recovery request: re-present the SAME pending sample with a fresh display identity. Never retry automatically.",
        inputSchema: toolSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    empty.parse(request.params.arguments ?? {});
    if (request.params.name === "status") return output(await status());
    if (!["present_sample", "recover_sample"].includes(request.params.name))
      throw new Error("Unknown diagnostic tool");
    const result = await present(request.params.name === "recover_sample", extra.signal);
    return output({ result, ...(await status()) });
  });
  return { server, status, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length < 3 || process.argv.length > 4)
    throw new Error(
      "Usage: node --import tsx scripts/probe-native-human-host.mjs <dedicated-native-host-directory> [timeout-ms]"
    );
  const probe = await createNativeHumanHostProbe(
    process.argv[2],
    process.argv[3] === undefined ? 120000 : Number(process.argv[3])
  );
  probe.server.onclose = () => {
    void probe.close();
  };
  process.once("SIGINT", () => {
    void probe.server.close();
  });
  process.once("SIGTERM", () => {
    void probe.server.close();
  });
  await probe.server.connect(new StdioServerTransport());
}
