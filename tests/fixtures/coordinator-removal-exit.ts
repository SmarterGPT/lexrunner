// Disposable integration fixture: deliberately bypass coordinator/store cleanup.
import { readFile } from "node:fs/promises";
import { SqliteWorkspaceLifecycleStore } from "../../src/store/sqlite/workspace-lifecycle-store.js";
import { NodeGitWorktreeBroker } from "../../src/workspaces/node-git-worktree-broker.js";
import { WorkspaceCoordinator } from "../../src/workspaces/workspace-coordinator.js";

const request = JSON.parse(await readFile(process.argv[2], "utf8"));
if (!["before", "after"].includes(request.phase)) throw new Error("Invalid exit phase");
const store = new SqliteWorkspaceLifecycleStore(request.database);
const broker = new NodeGitWorktreeBroker(request.broker);
const remove = broker.remove.bind(broker);
broker.remove = async (...args) => {
  if (request.phase === "before") process.exit(73);
  const result = await remove(...args);
  if (!result.ok || result.observation.exists || result.observation.registered)
    throw new Error("Fixture removal did not complete");
  process.exit(73);
};
await new WorkspaceCoordinator(store, broker).release(request.release);
throw new Error("Fixture did not reach removal boundary");
