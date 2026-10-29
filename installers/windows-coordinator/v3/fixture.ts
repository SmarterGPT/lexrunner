import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createWindowsCoordinatorGenerationGraphV3 } from "../../../src/workspaces/windows-coordinator-generation-graph-v3.js";
import { WINDOWS_BOUNDARY_PROTOCOL_VERSION } from "../../../src/workspaces/windows-boundary-protocol.js";
import { WINDOWS_REMOVAL_VERSION } from "../../../src/workspaces/windows-removal-protocol.js";

const root = process.argv[2];
if (!root || !path.win32.isAbsolute(root) || process.argv.length !== 3)
  throw new Error("Expected one absolute disposable fixture root");
const members = [
  ["bin/lexrunner-windows-boundary-helper.exe", "helper-image"],
  ["client/lexrunner-windows-coordinator-client.exe", "client-image"],
  ["git/cmd/git.exe", "git-entry"],
  ["node/better_sqlite3.node", "sqlite-addon"],
  ["node/node.exe", "node-image"],
  ["node/private-admission-worker.mjs", "admission-entry"],
  ["service/LexRunner.WindowsCoordinator.Service.exe", "service-image"],
  ["service/LexRunner.WindowsCoordinator.WorkerSlot.exe", "worker-service-image"],
] as const;
const files = members.map(([name, role]) => {
  const bytes = Buffer.from(`synthetic-offline-v3:${name}\n`, "utf8");
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
const graph = createWindowsCoordinatorGenerationGraphV3({
  schemaVersion: "lexrunner-windows-coordinator-generation-graph/3",
  profile: "windows-coordinator-service-msi/3",
  architecture: "win-x64",
  serviceName: "LexRunnerCoordinator",
  workerServiceName: "LexRunnerWorkerSlot1",
  workerTokenUserSid: "S-1-5-19",
  workerServiceSid: "S-1-5-80-2257548793-97284598-3436774358-445624465-2531346843",
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
    serviceImage: "service/LexRunner.WindowsCoordinator.Service.exe",
    workerServiceImage: "service/LexRunner.WindowsCoordinator.WorkerSlot.exe",
    authorizesLaunch: false,
  })
);
