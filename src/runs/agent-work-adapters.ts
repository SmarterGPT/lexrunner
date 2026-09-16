import path from "node:path";
import { stat } from "node:fs/promises";

import { z } from "zod";

import {
  AGENT_WORK_CONTRACT_VERSION,
  AgentTaskPacketHashInput_v1,
  ExecutionEnvironmentOS,
  WorkItem_v1,
  createAgentTaskPacket,
} from "../schemas/agent-work.js";
import { RunStateSchema } from "./types.js";
import { computeCanonicalHash, SHA256Hash } from "../schemas/task-contract.js";
import { canonicalJSONStringify } from "../util/canonicalJson.js";
import type {
  AgentWorkLifecycleResult,
  AgentWorkStatus,
  StartAttemptInput,
} from "./agent-work-lifecycle-service.js";
import { readAgentWorkStatus } from "./agent-work-lifecycle-service.js";
import {
  prepareAttemptLaunchBundle,
  type AttemptLaunchBundleResult,
} from "./agent-work-launch-bundle.js";
import {
  AgentWorkRuntimeConfigSchema,
  openAgentWorkRuntime,
  type AgentWorkRuntimeConfig,
} from "./agent-work-runtime.js";
import { SqliteWorkspaceLifecycleStore } from "../store/sqlite/workspace-lifecycle-store.js";

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_TEXT = 4_096;
const MAX_PATH = 16_384;
const MAX_ISSUES = 20;

const text = z.string().min(1).max(MAX_TEXT);
const nativePath = z
  .string()
  .min(1)
  .max(MAX_PATH)
  .refine((value) => !value.includes("\0"), {
    message: "must not contain NUL bytes",
  });
const absoluteNativePath = nativePath.refine((value) => path.isAbsolute(value), {
  message: "must be a runtime-native absolute path",
});
const instant = z.string().datetime({ offset: true });
const revision = z.number().int().nonnegative();
const positiveTtl = z
  .number()
  .int()
  .positive()
  .max(24 * 60 * 60 * 1_000);
const mutation = z.object({ mutationId: text, now: instant }).strict();

export const AttemptStartInputSchema = z
  .object({
    runId: text,
    initialRunState: RunStateSchema,
    controller: z
      .object({ controllerId: text, leaseId: text, now: instant, ttlMs: positiveTtl })
      .strict(),
    attempt: z
      .object({
        attemptId: text,
        workItemId: text,
        workItemRevision: revision,
        packetId: text,
        packetHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        baseSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
      })
      .strict(),
    workspace: z
      .object({
        workspaceLeaseId: text,
        repositoryId: text,
        hostId: text,
        gitRuntime: text,
        projectRoot: nativePath,
        branch: text,
        worktreePath: nativePath,
        ttlMs: positiveTtl,
      })
      .strict(),
    mutations: z
      .object({
        createAttempt: mutation,
        reserveWorkspace: mutation,
        activateWorkspace: mutation,
        resumeWorkspace: mutation,
        quarantineWorkspace: mutation,
        authorizeLaunch: mutation,
      })
      .strict(),
    broker: z.object({ timeoutMs: positiveTtl }).strict().optional(),
  })
  .strict();

export const AttemptStatusInputSchema = z
  .object({
    databasePath: nativePath.refine((value) => path.isAbsolute(value), {
      message: "must be a runtime-native absolute path",
    }),
    runId: text,
    attemptId: text,
  })
  .strict();

export const AttemptStartRequestSchema = z
  .object({ runtime: AgentWorkRuntimeConfigSchema, attempt: AttemptStartInputSchema })
  .strict();

const AttemptPrepareLifecycleInputSchema = AttemptStartInputSchema.omit({
  runId: true,
  attempt: true,
  workspace: true,
}).extend({
  workspace: AttemptStartInputSchema.shape.workspace
    .omit({ repositoryId: true, hostId: true, gitRuntime: true, projectRoot: true })
    .strict(),
});
const AttemptLaunchPacketPolicySchema = AgentTaskPacketHashInput_v1.pick({
  instructions: true,
  scope: true,
  authority: true,
  verification: true,
  budget: true,
})
  .extend({ packetId: text, createdAt: instant })
  .strict();
const AttemptLaunchEnvelopePolicySchema = z
  .object({
    envelopeId: text,
    os: ExecutionEnvironmentOS,
    architecture: text,
    workerRuntime: text,
    projectRoot: absoluteNativePath,
    executionRoot: absoluteNativePath,
    exposedEnvironmentKeys: z.array(text).max(256),
    createdAt: instant,
    projection: z
      .object({
        selectionDigest: SHA256Hash,
      })
      .strict()
      .optional(),
  })
  .strict();

export const AttemptPrepareRequestSchema = z
  .object({
    expectedPacketHash: SHA256Hash.optional(),
    runtime: AgentWorkRuntimeConfigSchema,
    workItem: WorkItem_v1,
    identity: z
      .object({
        runId: text,
        attemptId: text,
        baseSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
      })
      .strict(),
    packet: AttemptLaunchPacketPolicySchema,
    envelope: AttemptLaunchEnvelopePolicySchema,
    attempt: AttemptPrepareLifecycleInputSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.workItem.repository.id !== value.runtime.repositoryId) {
      context.addIssue({
        code: "custom",
        path: ["workItem", "repository", "id"],
        message: "must match runtime.repositoryId",
      });
    }
    if (value.attempt.initialRunState.runId !== value.identity.runId) {
      context.addIssue({
        code: "custom",
        path: ["attempt", "initialRunState", "runId"],
        message: "must match identity.runId",
      });
    }
    if (value.attempt.initialRunState.repo !== value.runtime.repositoryId) {
      context.addIssue({
        code: "custom",
        path: ["attempt", "initialRunState", "repo"],
        message: "must match runtime.repositoryId",
      });
    }
    if (
      !sameOrDescendant(
        value.envelope.projectRoot,
        value.attempt.workspace.worktreePath,
        value.runtime.pathComparison
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["envelope", "projectRoot"],
        message: "must be the allocated worktree or a descendant",
      });
    }
    if (
      !sameOrDescendant(
        value.envelope.executionRoot,
        value.envelope.projectRoot,
        value.runtime.pathComparison
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["envelope", "executionRoot"],
        message: "must be the project root or a descendant",
      });
    }
    if (Date.parse(value.envelope.createdAt) < Date.parse(value.packet.createdAt)) {
      context.addIssue({
        code: "custom",
        path: ["envelope", "createdAt"],
        message: "must not precede packet.createdAt",
      });
    }
    if (
      Date.parse(value.envelope.createdAt) < Date.parse(value.attempt.mutations.authorizeLaunch.now)
    ) {
      context.addIssue({
        code: "custom",
        path: ["envelope", "createdAt"],
        message: "must not precede launch authorization",
      });
    }
    const envelopeAt = Date.parse(value.envelope.createdAt);
    if (envelopeAt >= Date.parse(value.attempt.controller.now) + value.attempt.controller.ttlMs) {
      context.addIssue({
        code: "custom",
        path: ["envelope", "createdAt"],
        message: "must precede controller lease expiry",
      });
    }
    try {
      const packet = createAgentTaskPacket({
        schema_version: AGENT_WORK_CONTRACT_VERSION,
        packet_id: value.packet.packetId,
        run_id: value.identity.runId,
        work_item: {
          work_item_id: value.workItem.work_item_id,
          revision: value.workItem.revision,
        },
        attempt_id: value.identity.attemptId,
        repository: { ...value.workItem.repository, base_sha: value.identity.baseSha },
        objective: value.workItem.objective,
        acceptance_criteria: value.workItem.acceptance_criteria,
        instructions: value.packet.instructions,
        scope: value.packet.scope,
        authority: value.packet.authority,
        verification: value.packet.verification,
        budget: value.packet.budget,
        created_at: value.packet.createdAt,
      });
      if (value.expectedPacketHash && packet.packet_hash !== value.expectedPacketHash) {
        context.addIssue({
          code: "custom",
          path: ["expectedPacketHash"],
          message: "does not match the constructed packet; no preparation was performed",
        });
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        for (const issue of error.issues.slice(0, MAX_ISSUES)) {
          context.addIssue({
            code: "custom",
            path: ["packet", ...issue.path],
            message: issue.message,
          });
        }
      } else {
        context.addIssue({ code: "custom", path: ["packet"], message: "is invalid" });
      }
    }
  });

export const AttemptStartRequestJsonSchema = z.toJSONSchema(AttemptStartRequestSchema, {
  target: "draft-7",
});
export const AttemptPrepareRequestJsonSchema = z.toJSONSchema(AttemptPrepareRequestSchema, {
  target: "draft-7",
});
export const AttemptStatusInputJsonSchema = z.toJSONSchema(AttemptStatusInputSchema, {
  target: "draft-7",
});

export type AttemptStartHandlerInput = z.infer<typeof AttemptStartInputSchema>;
export type AttemptStatusHandlerInput = z.infer<typeof AttemptStatusInputSchema>;
export type AttemptStartRequest = z.infer<typeof AttemptStartRequestSchema>;
export type AttemptPrepareRequest = z.infer<typeof AttemptPrepareRequestSchema>;

export interface AgentWorkRuntimeBinding {
  repositoryId: string;
  repositoryRoot: string;
  worktreeRoot: string;
  hostId: string;
  gitRuntime: string;
  pathComparison: "case-sensitive" | "case-insensitive";
}

export interface AdapterInputError {
  code: "invalid_input";
  message: string;
  issues: Array<{ path: string; message: string }>;
}

export interface AdapterOperationError {
  code: "operation_failed";
  message: string;
  preparationEffects?: {
    runId: string;
    attemptId: string;
    expectedPacketHash: string;
    observedPacketHash: string;
  };
}

export type AdapterError = AdapterInputError | AdapterOperationError;

export type AgentWorkHandlerResult<T> =
  { ok: true; result: T } | { ok: false; error: AdapterError };

export interface AttemptLifecycleHandlers {
  start(request: unknown): Promise<AgentWorkHandlerResult<AgentWorkLifecycleResult>>;
  status(request: unknown): Promise<AgentWorkHandlerResult<AgentWorkStatus>>;
}

export interface AttemptPreparationHandler {
  prepare(request: unknown): Promise<AgentWorkHandlerResult<AttemptLaunchBundleResult>>;
}

/** Top-level lifecycle seam. Every request owns and closes its SQLite connection. */
export function createAttemptLifecycleHandlers(): AttemptLifecycleHandlers &
  AttemptPreparationHandler {
  return {
    async prepare(request) {
      const parsed = parseBounded(AttemptPrepareRequestSchema, request);
      if (!parsed.success) return parsed.failure;
      const workspace = toStartInput(parsed.data).workspace;
      const mismatch = bindingIssue(workspace, parsed.data.runtime, "attempt.workspace");
      if (mismatch) return invalid([mismatch]);
      let runtime;
      try {
        runtime = await openAgentWorkRuntime(parsed.data.runtime);
      } catch (error) {
        return operationFailed(error);
      }
      try {
        const result = await prepareAttemptLaunchBundle(runtime.service, parsed.data, runtime);
        if (
          result.ok &&
          parsed.data.expectedPacketHash &&
          result.packet.packet_hash !== parsed.data.expectedPacketHash
        ) {
          return {
            ok: false,
            error: {
              code: "operation_failed",
              message:
                "Preparation ran but returned an unexpected packet. Preserve lifecycle state and inspect the attempt before recovery; do not retry automatically.",
              preparationEffects: {
                runId: parsed.data.identity.runId,
                attemptId: parsed.data.identity.attemptId,
                expectedPacketHash: parsed.data.expectedPacketHash,
                observedPacketHash: result.packet.packet_hash,
              },
            },
          };
        }
        if (result.ok) {
          const envelopeJson = canonicalJSONStringify(result.envelope);
          const packetJson = canonicalJSONStringify(result.packet);
          const binding = await runtime.workerSessions.bindLaunchEnvelope({
            runId: result.lifecycle.run.runId,
            attemptId: result.lifecycle.attempt.attemptId,
            workspaceLeaseId: result.lifecycle.workspace.leaseId,
            expectedRunRevision: result.lifecycle.run.revision,
            expectedAttemptRevision: result.lifecycle.attempt.revision,
            expectedWorkspaceLeaseRevision: result.lifecycle.workspace.revision,
            controller: result.lifecycle.controllerLease,
            authorizationMutationId: parsed.data.attempt.mutations.authorizeLaunch.mutationId,
            envelopeId: result.envelope.envelope_id,
            envelopeHash: computeCanonicalHash(result.envelope),
            envelopeJson,
            packetJson,
            createdAt: result.envelope.created_at,
          });
          if (!binding.bound) {
            return operationFailed(
              new Error(`Launch envelope binding rejected: ${binding.reason}`)
            );
          }
        }
        return {
          ok: true,
          result,
        };
      } catch (error) {
        return operationFailed(error);
      } finally {
        await runtime.close().catch(() => undefined);
      }
    },
    async start(request) {
      const parsed = parseBounded(AttemptStartRequestSchema, request);
      if (!parsed.success) return parsed.failure;
      const mismatch = bindingIssue(
        parsed.data.attempt.workspace,
        parsed.data.runtime,
        "attempt.workspace"
      );
      if (mismatch) return invalid([mismatch]);
      let runtime;
      try {
        runtime = await openAgentWorkRuntime(parsed.data.runtime);
      } catch (error) {
        return operationFailed(error);
      }
      try {
        return {
          ok: true,
          result: await runtime.service.startAttempt(parsed.data.attempt as StartAttemptInput),
        };
      } catch (error) {
        return operationFailed(error);
      } finally {
        await runtime.close().catch(() => undefined);
      }
    },
    async status(request) {
      const parsed = parseBounded(AttemptStatusInputSchema, request);
      if (!parsed.success) return parsed.failure;
      try {
        const database = await stat(parsed.data.databasePath);
        if (!database.isFile()) {
          return invalid([{ path: "databasePath", message: "must identify an existing file" }]);
        }
      } catch {
        return invalid([{ path: "databasePath", message: "must identify an existing file" }]);
      }
      let store: SqliteWorkspaceLifecycleStore;
      try {
        store = new SqliteWorkspaceLifecycleStore(parsed.data.databasePath, { readOnly: true });
      } catch (error) {
        return operationFailed(error);
      }
      try {
        return { ok: true, result: await readAgentWorkStatus(store, store, parsed.data) };
      } catch (error) {
        return operationFailed(error);
      } finally {
        await store.close().catch(() => undefined);
      }
    },
  };
}

function toStartInput(input: AttemptPrepareRequest): AttemptStartHandlerInput {
  return {
    ...input.attempt,
    runId: input.identity.runId,
    attempt: {
      attemptId: input.identity.attemptId,
      workItemId: input.workItem.work_item_id,
      workItemRevision: input.workItem.revision,
      packetId: input.packet.packetId,
      packetHash: `sha256:${"0".repeat(64)}`,
      baseSha: input.identity.baseSha,
    },
    workspace: {
      ...input.attempt.workspace,
      repositoryId: input.runtime.repositoryId,
      hostId: input.runtime.hostId,
      gitRuntime: input.runtime.gitRuntime,
      projectRoot: input.runtime.repositoryRoot,
    },
  };
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
  if (encoded === undefined)
    return { success: false, failure: invalid([{ path: "", message: "input must be JSON-safe" }]) };
  if (Buffer.byteLength(encoded, "utf8") > MAX_INPUT_BYTES) {
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

function isJsonSafe(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (depth > 100) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null)
    return false;
  const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  const safe = entries.every((entry) => isJsonSafe(entry, seen, depth + 1));
  seen.delete(value);
  return safe;
}

function bindingIssue(
  workspace: AttemptStartHandlerInput["workspace"],
  binding: AgentWorkRuntimeBinding,
  prefix: string
): { path: string; message: string } | null {
  if (workspace.repositoryId !== binding.repositoryId)
    return { path: `${prefix}.repositoryId`, message: "must match the configured runtime" };
  if (workspace.hostId !== binding.hostId)
    return { path: `${prefix}.hostId`, message: "must match the configured runtime" };
  if (workspace.gitRuntime !== binding.gitRuntime)
    return { path: `${prefix}.gitRuntime`, message: "must match the configured runtime" };
  if (!samePath(workspace.projectRoot, binding.repositoryRoot, binding.pathComparison))
    return {
      path: `${prefix}.projectRoot`,
      message: "must match the configured repositoryRoot",
    };
  if (!strictDescendant(workspace.worktreePath, binding.worktreeRoot, binding.pathComparison))
    return {
      path: `${prefix}.worktreePath`,
      message: "must be beneath configured worktreeRoot",
    };
  return null;
}

function samePath(
  left: string,
  right: string,
  comparison: AgentWorkRuntimeBinding["pathComparison"]
): boolean {
  const normalize = (value: string) => path.resolve(value).replace(/[\\/]+$/u, "");
  const a = normalize(left);
  const b = normalize(right);
  return comparison === "case-insensitive" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function strictDescendant(
  child: string,
  root: string,
  comparison: AgentWorkRuntimeBinding["pathComparison"]
): boolean {
  const normalize = (value: string) =>
    path.resolve(value).replace(/\\/gu, "/").replace(/\/+$/u, "");
  let candidate = normalize(child);
  let parent = normalize(root);
  if (comparison === "case-insensitive") {
    candidate = candidate.toLowerCase();
    parent = parent.toLowerCase();
  }
  return candidate.startsWith(`${parent}/`) && candidate.length > parent.length + 1;
}

function sameOrDescendant(
  child: string,
  root: string,
  comparison: AgentWorkRuntimeBinding["pathComparison"]
): boolean {
  return samePath(child, root, comparison) || strictDescendant(child, root, comparison);
}

function invalid(issues: AdapterInputError["issues"]): { ok: false; error: AdapterInputError } {
  return {
    ok: false,
    error: { code: "invalid_input", message: "Invalid attempt lifecycle input", issues },
  };
}

function operationFailed(error: unknown): { ok: false; error: AdapterOperationError } {
  return {
    ok: false,
    error: { code: "operation_failed", message: safeError(error) },
  };
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "lifecycle operation failed").slice(0, 512);
}
