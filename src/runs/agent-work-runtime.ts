import path from "node:path";

import { z } from "zod";

import { SqliteWorkspaceLifecycleStore } from "../store/sqlite/workspace-lifecycle-store.js";
import { NodeGitWorktreeBroker } from "../workspaces/node-git-worktree-broker.js";
import type { GitWorktreeBroker } from "../workspaces/git-worktree-broker.js";
import { WorkspaceCoordinator } from "../workspaces/workspace-coordinator.js";
import { AgentWorkLifecycleService } from "./agent-work-lifecycle-service.js";
import { AgentWorkWorkerSessionService } from "./agent-work-worker-session-service.js";
import { AgentWorkWorkerAdapterNegotiator } from "./agent-work-worker-runtime.js";

const required = z
  .string()
  .min(1)
  .max(16_384)
  .refine((value) => !value.includes("\0"));
const absolutePath = required.refine((value) => path.isAbsolute(value), {
  message: "must be a runtime-native absolute path",
});

export const AgentWorkRuntimeConfigSchema = z
  .object({
    databasePath: absolutePath,
    repositoryId: z.string().min(1).max(4_096),
    repositoryRoot: absolutePath,
    worktreeRoot: absolutePath,
    hostId: z.string().min(1).max(4_096),
    gitRuntime: z.string().min(1).max(4_096),
    pathComparison: z.enum(["case-sensitive", "case-insensitive"]),
    gitExecutable: required.optional(),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60 * 1_000)
      .optional(),
    maxDirtyPaths: z.number().int().positive().max(10_000).optional(),
  })
  .strict();

export type AgentWorkRuntimeConfig = z.infer<typeof AgentWorkRuntimeConfigSchema>;

export interface AgentWorkRuntime {
  config: Readonly<AgentWorkRuntimeConfig>;
  observeWorkspace: GitWorktreeBroker["observe"];
  service: AgentWorkLifecycleService;
  workerSessions: AgentWorkWorkerSessionService;
  workerAdapters: AgentWorkWorkerAdapterNegotiator;
  close(): Promise<void>;
}

/** Validate all machine identity and paths before opening SQLite or invoking Git. */
export function createAgentWorkRuntime(input: unknown): AgentWorkRuntime {
  const config = AgentWorkRuntimeConfigSchema.parse(input);
  const broker = new NodeGitWorktreeBroker({
    repositoryId: config.repositoryId,
    repositoryRoot: config.repositoryRoot,
    worktreeRoot: config.worktreeRoot,
    hostId: config.hostId,
    gitRuntime: config.gitRuntime,
    pathComparison: config.pathComparison,
    ...(config.gitExecutable ? { gitExecutable: config.gitExecutable } : {}),
    ...(config.timeoutMs ? { defaultTimeoutMs: config.timeoutMs } : {}),
    ...(config.maxDirtyPaths ? { maxDirtyPaths: config.maxDirtyPaths } : {}),
  });
  return assembleAgentWorkRuntime(config, broker);
}

export async function openAgentWorkRuntime(input: unknown): Promise<AgentWorkRuntime> {
  const config = AgentWorkRuntimeConfigSchema.parse(input);
  const broker = await NodeGitWorktreeBroker.open({
    repositoryId: config.repositoryId,
    repositoryRoot: config.repositoryRoot,
    worktreeRoot: config.worktreeRoot,
    hostId: config.hostId,
    gitRuntime: config.gitRuntime,
    pathComparison: config.pathComparison,
    ...(config.gitExecutable ? { gitExecutable: config.gitExecutable } : {}),
    ...(config.timeoutMs ? { defaultTimeoutMs: config.timeoutMs } : {}),
    ...(config.maxDirtyPaths ? { maxDirtyPaths: config.maxDirtyPaths } : {}),
  });
  return assembleAgentWorkRuntime(config, broker);
}

function assembleAgentWorkRuntime(
  config: AgentWorkRuntimeConfig,
  broker: GitWorktreeBroker
): AgentWorkRuntime {
  const store = new SqliteWorkspaceLifecycleStore(config.databasePath);
  try {
    const service = new AgentWorkLifecycleService(
      store,
      store,
      new WorkspaceCoordinator(store, broker)
    );
    const observeWorkspace = broker.observe.bind(broker);
    return {
      config: Object.freeze({ ...config }),
      observeWorkspace,
      service,
      workerSessions: new AgentWorkWorkerSessionService(store, {
        config: Object.freeze({ ...config }),
        observeWorkspace,
      }),
      workerAdapters: new AgentWorkWorkerAdapterNegotiator(store),
      close: () => store.close(),
    };
  } catch (error) {
    void store.close();
    throw error;
  }
}
