import path from "node:path";
import { stat } from "node:fs/promises";

import { z } from "zod";

import {
  ExecutionEnvelope_v1,
  ExecutionEnvironmentOS,
  WorkerSessionBackend,
} from "../schemas/agent-work.js";
import { AgentExecutionPathMapping_v1 } from "../schemas/agent-work-projection.js";
import { SqliteWorkspaceLifecycleStore } from "../store/sqlite/workspace-lifecycle-store.js";
import {
  EndWorkerSessionStatus,
  HeartbeatWorkerSessionStatus,
} from "../store/workspace-lifecycle-domains.js";
import type {
  EndWorkerSessionInput,
  HeartbeatWorkerSessionInput,
  WorkerSessionMutationResult,
} from "../store/workspace-lifecycle-store.js";
import type {
  AdapterInputError,
  AdapterOperationError,
  AgentWorkHandlerResult,
} from "./agent-work-adapters.js";
import { AgentWorkRuntimeConfigSchema, openAgentWorkRuntime } from "./agent-work-runtime.js";
import {
  AgentWorkWorkerSessionService,
  type WorkerSessionStatusResult,
} from "./agent-work-worker-session-service.js";
import { WorkerAdapterSelection_v1 } from "./agent-work-worker-runtime.js";

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_ISSUES = 20;
const text = z.string().min(1).max(4_096);
const shortText = z.string().min(1).max(1_024);
const nativePath = z
  .string()
  .min(1)
  .max(16_384)
  .refine((value) => !value.includes("\0") && path.isAbsolute(value), {
    message: "must be a runtime-native absolute path",
  });
const instant = z.string().datetime({ offset: true });
const revision = z.number().int().nonnegative();
const mutation = z.object({ mutationId: text, now: instant }).strict();
const controller = z
  .object({
    runId: text,
    controllerId: text,
    leaseId: text,
    fencingToken: z.number().int().positive(),
  })
  .strict();
const common = {
  runId: text,
  expectedRunRevision: revision,
  controller,
  attemptId: text,
  expectedAttemptRevision: revision,
  workspaceLeaseId: text,
  expectedWorkspaceLeaseRevision: revision,
  workerSessionId: text,
  mutation,
};

const BoundedExecutionEnvelopeSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    envelope_id: text,
    run_id: text,
    attempt_id: text,
    packet_id: text,
    packet_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    workspace_lease_id: text,
    workspace_lease_revision: revision,
    expected_head_sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i),
    branch: text,
    runtime: z
      .object({
        host_id: text,
        os: ExecutionEnvironmentOS,
        architecture: text,
        worker_runtime: text,
        git_runtime: text,
      })
      .strict(),
    paths: z
      .object({
        project_root: nativePath,
        execution_root: nativePath,
        allocation_root: nativePath.optional(),
        worktree_root: nativePath,
      })
      .strict(),
    path_mappings: z.array(AgentExecutionPathMapping_v1).max(1),
    exposed_environment_keys: z.array(text).max(256),
    created_at: instant,
  })
  .strict()
  .superRefine((value, context) => {
    const parsed = ExecutionEnvelope_v1.safeParse(value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues.slice(0, MAX_ISSUES)) {
        context.addIssue({ code: "custom", path: issue.path, message: issue.message });
      }
    }
  });

export const AttemptWorkerAttachRequestSchema = z
  .object({
    runtime: AgentWorkRuntimeConfigSchema,
    attach: z
      .object({
        ...common,
        envelope: BoundedExecutionEnvelopeSchema,
        worker: z
          .object({
            backend: WorkerSessionBackend,
            workerId: text,
            model: text.optional(),
            startedAt: instant,
          })
          .strict(),
        adapter: WorkerAdapterSelection_v1,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.attach.controller.runId !== value.attach.runId) {
      context.addIssue({
        code: "custom",
        path: ["attach", "controller", "runId"],
        message: "must match attach.runId",
      });
    }
    if (
      Date.parse(value.attach.worker.startedAt) < Date.parse(value.attach.envelope.created_at) ||
      Date.parse(value.attach.worker.startedAt) > Date.parse(value.attach.mutation.now)
    ) {
      context.addIssue({
        code: "custom",
        path: ["attach", "worker", "startedAt"],
        message: "must be between envelope creation and attachment",
      });
    }
    if (value.attach.adapter.mode !== "assisted_attach") {
      context.addIssue({
        code: "custom",
        path: ["attach", "adapter", "mode"],
        message: "must be assisted_attach for the worker attach surface",
      });
    }
  });

const WorkerHeartbeatInputSchema = z
  .object({
    ...common,
    expectedWorkerSessionRevision: revision,
    status: HeartbeatWorkerSessionStatus.optional(),
  })
  .strict();
export const AttemptWorkerHeartbeatRequestSchema = z
  .object({ databasePath: nativePath, heartbeat: WorkerHeartbeatInputSchema })
  .strict()
  .superRefine((value, context) => {
    requireControllerRun(value.heartbeat, "heartbeat", context);
  });

const WorkerEndInputSchema = z
  .object({
    ...common,
    expectedWorkerSessionRevision: revision,
    status: EndWorkerSessionStatus,
    exit: z
      .object({
        code: z.number().int().optional(),
        signal: z.string().min(1).max(128).optional(),
        summary: shortText.optional(),
      })
      .strict(),
  })
  .strict();
export const AttemptWorkerEndRequestSchema = z
  .object({ databasePath: nativePath, end: WorkerEndInputSchema })
  .strict()
  .superRefine((value, context) => {
    requireControllerRun(value.end, "end", context);
  });

export const AttemptWorkerStatusRequestSchema = z
  .object({ databasePath: nativePath, runId: text, attemptId: text })
  .strict();

export const AttemptWorkerAttachRequestJsonSchema = z.toJSONSchema(
  AttemptWorkerAttachRequestSchema,
  { target: "draft-7" }
);
export const AttemptWorkerHeartbeatRequestJsonSchema = z.toJSONSchema(
  AttemptWorkerHeartbeatRequestSchema,
  { target: "draft-7" }
);
export const AttemptWorkerEndRequestJsonSchema = z.toJSONSchema(AttemptWorkerEndRequestSchema, {
  target: "draft-7",
});
export const AttemptWorkerStatusRequestJsonSchema = z.toJSONSchema(
  AttemptWorkerStatusRequestSchema,
  { target: "draft-7" }
);

export interface AttemptWorkerHandlers {
  attach(request: unknown): Promise<AgentWorkHandlerResult<WorkerSessionMutationResult>>;
  heartbeat(request: unknown): Promise<AgentWorkHandlerResult<WorkerSessionMutationResult>>;
  end(request: unknown): Promise<AgentWorkHandlerResult<WorkerSessionMutationResult>>;
  status(request: unknown): Promise<AgentWorkHandlerResult<WorkerSessionStatusResult>>;
}

export function createAttemptWorkerHandlers(): AttemptWorkerHandlers {
  return {
    async attach(request) {
      const parsed = parseBounded(AttemptWorkerAttachRequestSchema, request);
      if (!parsed.success) return parsed.failure;
      let runtime;
      try {
        runtime = await openAgentWorkRuntime(parsed.data.runtime);
      } catch (error) {
        return operationFailed(error);
      }
      try {
        const input = parsed.data.attach;
        const negotiation = await runtime.workerAdapters.negotiate(input.attemptId, input.adapter);
        if (!negotiation.go) {
          return {
            ok: false,
            error: {
              code: "operation_failed",
              message: `Worker adapter capability negotiation denied GO: ${negotiation.reason}`,
            },
          };
        }
        if (input.worker.backend !== negotiation.adapter.session_backend) {
          return {
            ok: false,
            error: {
              code: "operation_failed",
              message: "Worker adapter backend identity does not match the requested worker",
            },
          };
        }
        return {
          ok: true,
          result: await runtime.workerSessions.attach({
            runId: input.runId,
            expectedRunRevision: input.expectedRunRevision,
            controller: input.controller,
            attemptId: input.attemptId,
            expectedAttemptRevision: input.expectedAttemptRevision,
            workspaceLeaseId: input.workspaceLeaseId,
            expectedWorkspaceLeaseRevision: input.expectedWorkspaceLeaseRevision,
            sessionId: input.workerSessionId,
            envelope: input.envelope,
            backend: input.worker.backend,
            workerId: input.worker.workerId,
            ...(input.worker.model ? { model: input.worker.model } : {}),
            startedAt: input.worker.startedAt,
            adapter: {
              adapterId: negotiation.adapter.id,
              adapterVersion: negotiation.adapter.version,
              enforcementSummaryHash: negotiation.enforcementSummaryHash,
              trustGapDimensions: negotiation.trustGaps,
            },
            mutationId: input.mutation.mutationId,
            now: input.mutation.now,
          }),
        };
      } catch (error) {
        return operationFailed(error);
      } finally {
        await runtime.close().catch(() => undefined);
      }
    },
    heartbeat: (request) => mutate(request, AttemptWorkerHeartbeatRequestSchema, "heartbeat"),
    end: (request) => mutate(request, AttemptWorkerEndRequestSchema, "end"),
    async status(request) {
      const parsed = parseBounded(AttemptWorkerStatusRequestSchema, request);
      if (!parsed.success) return parsed.failure;
      try {
        const entry = await stat(parsed.data.databasePath);
        if (!entry.isFile()) return invalid([{ path: "databasePath", message: "must be a file" }]);
      } catch {
        return invalid([{ path: "databasePath", message: "must be a file" }]);
      }
      let store: SqliteWorkspaceLifecycleStore;
      try {
        store = new SqliteWorkspaceLifecycleStore(parsed.data.databasePath, { readOnly: true });
      } catch (error) {
        return operationFailed(error);
      }
      try {
        return {
          ok: true,
          result: await new AgentWorkWorkerSessionService(store).status(parsed.data),
        };
      } catch (error) {
        return operationFailed(error);
      } finally {
        await store.close().catch(() => undefined);
      }
    },
  };
}

async function mutate<T extends z.ZodTypeAny>(
  request: unknown,
  schema: T,
  operation: "heartbeat" | "end"
): Promise<AgentWorkHandlerResult<WorkerSessionMutationResult>> {
  const parsed = parseBounded(schema, request);
  if (!parsed.success) return parsed.failure;
  const data = parsed.data as z.infer<typeof AttemptWorkerHeartbeatRequestSchema> &
    z.infer<typeof AttemptWorkerEndRequestSchema>;
  const payload = operation === "heartbeat" ? data.heartbeat : data.end;
  let store: SqliteWorkspaceLifecycleStore;
  try {
    store = new SqliteWorkspaceLifecycleStore(data.databasePath);
  } catch (error) {
    return operationFailed(error);
  }
  const service = new AgentWorkWorkerSessionService(store);
  try {
    const commonInput = {
      runId: payload.runId,
      expectedRunRevision: payload.expectedRunRevision,
      controller: payload.controller,
      attemptId: payload.attemptId,
      expectedAttemptRevision: payload.expectedAttemptRevision,
      workspaceLeaseId: payload.workspaceLeaseId,
      expectedWorkspaceLeaseRevision: payload.expectedWorkspaceLeaseRevision,
      sessionId: payload.workerSessionId,
      expectedSessionRevision: payload.expectedWorkerSessionRevision,
      mutationId: payload.mutation.mutationId,
      now: payload.mutation.now,
    };
    if (operation === "heartbeat") {
      const heartbeat = payload as z.infer<typeof WorkerHeartbeatInputSchema>;
      return {
        ok: true,
        result: await service.heartbeat({
          ...commonInput,
          ...(heartbeat.status ? { status: heartbeat.status } : {}),
        } satisfies HeartbeatWorkerSessionInput),
      };
    }
    const end = payload as z.infer<typeof WorkerEndInputSchema>;
    return {
      ok: true,
      result: await service.end({
        ...commonInput,
        status: end.status,
        exitReason: end.exit.signal ?? end.status,
        ...(end.exit.code !== undefined ? { exitCode: end.exit.code } : {}),
        ...(end.exit.summary ? { exitSummary: end.exit.summary } : {}),
      } satisfies EndWorkerSessionInput),
    };
  } catch (error) {
    return operationFailed(error);
  } finally {
    await store.close().catch(() => undefined);
  }
}

type ParseResult<T> =
  { success: true; data: T } | { success: false; failure: { ok: false; error: AdapterInputError } };

function parseBounded<T>(schema: z.ZodType<T>, input: unknown): ParseResult<T> {
  if (!isJsonSafe(input)) {
    return {
      success: false,
      failure: invalid([{ path: "", message: "input must be JSON-safe" }]),
    };
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(input);
  } catch {
    return { success: false, failure: invalid([{ path: "", message: "input must be JSON-safe" }]) };
  }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_INPUT_BYTES) {
    return {
      success: false,
      failure: invalid([{ path: "", message: `input exceeds ${MAX_INPUT_BYTES} bytes` }]),
    };
  }
  const parsed = schema.safeParse(input);
  if (parsed.success) return { success: true, data: parsed.data };
  return {
    success: false,
    failure: invalid(
      parsed.error.issues.slice(0, MAX_ISSUES).map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message.slice(0, 512),
      }))
    ),
  };
}

function requireControllerRun(
  value: { runId: string; controller: { runId: string } },
  field: string,
  context: z.RefinementCtx
): void {
  if (value.controller.runId !== value.runId) {
    context.addIssue({
      code: "custom",
      path: [field, "controller", "runId"],
      message: `must match ${field}.runId`,
    });
  }
}

function isJsonSafe(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (depth > 100) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
    return false;
  }
  const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  const safe = entries.every((entry) => isJsonSafe(entry, seen, depth + 1));
  seen.delete(value);
  return safe;
}

function invalid(issues: AdapterInputError["issues"]): { ok: false; error: AdapterInputError } {
  return {
    ok: false,
    error: { code: "invalid_input", message: "Invalid Attempt worker input", issues },
  };
}

function operationFailed(error: unknown): { ok: false; error: AdapterOperationError } {
  return {
    ok: false,
    error: {
      code: "operation_failed",
      message: (error instanceof Error ? error.message : "worker operation failed").slice(0, 512),
    },
  };
}
