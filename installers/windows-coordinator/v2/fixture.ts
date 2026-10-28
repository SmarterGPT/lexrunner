import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createWindowsCoordinatorGenerationGraph } from "../../../src/workspaces/windows-coordinator-generation-graph.js";
import { WINDOWS_BOUNDARY_PROTOCOL_VERSION } from "../../../src/workspaces/windows-boundary-protocol.js";
import { WINDOWS_REMOVAL_VERSION } from "../../../src/workspaces/windows-removal-protocol.js";

const root = process.argv[2];
if (!root || !path.win32.isAbsolute(root) || process.argv.length !== 3)
  throw new Error("Expected one absolute disposable fixture root");
const members = [
  ["bin/helper.exe", "helper-image"],
  ["client/client.exe", "client-image"],
  ["git/bin/git.exe", "git-entry"],
  ["node/addon.node", "sqlite-addon"],
  ["node/node.exe", "node-image"],
  ["node/worker.mjs", "admission-entry"],
  ["service/Coordinator.exe", "service-image"],
] as const;
const files = members.map(([name, role]) => {
  const bytes = Buffer.from(`synthetic-offline-v2:${name}\n`, "utf8");
  return {
    path: name,
    role,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    content: bytes,
  };
});
for (const file of files) {
  const target = path.join(root, ...file.path.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, file.content, { flag: "wx" });
}
const graph = createWindowsCoordinatorGenerationGraph({
  schemaVersion: "lexrunner-windows-coordinator-generation-graph/2",
  profile: "windows-coordinator-service-msi/2",
  architecture: "win-x64",
  serviceName: "LexRunnerCoordinator",
  coordinatorProtocolVersion: "1.0.0",
  boundaryProtocolVersion: WINDOWS_BOUNDARY_PROTOCOL_VERSION,
  removalProtocolVersion: WINDOWS_REMOVAL_VERSION,
  files: files.map(({ content: _content, ...file }) => file),
});
await writeFile(path.join(root, "generation-graph.json"), graph.manifestBytes, { flag: "wx" });
console.log(
  JSON.stringify({
    graphDigest: graph.graphDigest,
    manifestSha256: graph.manifestSha256,
    fileCount: files.length,
    authorizesLaunch: false,
  })
);
