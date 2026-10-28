import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createWindowsCoordinatorGenerationGraph,
  type WindowsCoordinatorGraphRole,
} from "../../src/workspaces/windows-coordinator-generation-graph.js";
import { WINDOWS_BOUNDARY_PROTOCOL_VERSION } from "../../src/workspaces/windows-boundary-protocol.js";
import { WINDOWS_REMOVAL_VERSION } from "../../src/workspaces/windows-removal-protocol.js";

const root = process.argv[2];
if (
  process.platform !== "win32" ||
  !root ||
  !path.win32.isAbsolute(root) ||
  process.argv.length !== 3
)
  throw new Error("Expected one fresh absolute Windows fixture payload root");

const gitSource = "C:\\Program Files\\Git\\mingw64";
const gitFiles = [
  [
    "git/mingw64/bin/git.exe",
    "git-entry",
    "bin/git.exe",
    "11ce9bfcb40927767c474326ee87477079e1cc24a9782e69936b3351b6c3c205",
  ],
  [
    "git/mingw64/bin/libiconv-2.dll",
    "native-dll",
    "bin/libiconv-2.dll",
    "ff31fa811f9c07cc7fdaa68c9e8bca3a7b4fdf6e0a079a58175ea58ba139c7ae",
  ],
  [
    "git/mingw64/bin/libintl-8.dll",
    "native-dll",
    "bin/libintl-8.dll",
    "479c8bffc0da6d28747cde0f4dd4d7714050811ebdfdf1fcc807efd9818e5a7f",
  ],
  [
    "git/mingw64/bin/libpcre2-8-0.dll",
    "native-dll",
    "bin/libpcre2-8-0.dll",
    "21d741e2c5089776a535587cd5fcd933b51054e16bf8e50855e74e68b3790228",
  ],
  [
    "git/mingw64/bin/libwinpthread-1.dll",
    "native-dll",
    "bin/libwinpthread-1.dll",
    "212e84730ce3ee28cd9fab37113a34931ea947ff538085372bef27c009010182",
  ],
  [
    "git/mingw64/bin/zlib1.dll",
    "native-dll",
    "bin/zlib1.dll",
    "cb7ab3788d10940df874acd97b1821bbb5ee4a91f3eec11982bb5bf7a3c96443",
  ],
  [
    "git/mingw64/libexec/git-core/git.exe",
    "git-tool",
    "libexec/git-core/git.exe",
    "11ce9bfcb40927767c474326ee87477079e1cc24a9782e69936b3351b6c3c205",
  ],
] as const;
const synthetic = [
  ["client/client.exe", "client-image"],
  ["helper/helper.exe", "helper-image"],
  ["node/addon.node", "sqlite-addon"],
  ["node/admission.mjs", "admission-entry"],
  ["node/node.exe", "node-image"],
  ["service/Coordinator.exe", "service-image"],
] as const;

await mkdir(root);
const members: {
  path: string;
  role: WindowsCoordinatorGraphRole;
  sha256: string;
  bytes: number;
}[] = [];
for (const [name, role, source, expected] of gitFiles) {
  const sourcePath = path.win32.join(gitSource, ...source.split("/"));
  const target = path.win32.join(root, ...name.split("/"));
  await mkdir(path.win32.dirname(target), { recursive: true });
  await copyFile(sourcePath, target);
  const bytes = await readFile(target);
  if (bytes.length < 512 || bytes.length > 32 * 1024 * 1024)
    throw new Error(`Git fixture member size invalid: ${name}`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== expected) throw new Error(`Git fixture source pin changed: ${name}`);
  members.push({ path: name, role, sha256, bytes: bytes.length });
}
for (const [name, role] of synthetic) {
  const target = path.win32.join(root, ...name.split("/"));
  const bytes = Buffer.from(`synthetic-uninstalled-graph-git:${name}\n`, "utf8");
  await mkdir(path.win32.dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: "wx" });
  members.push({
    path: name,
    role,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  });
}
members.sort((left, right) =>
  left.path.toLowerCase() < right.path.toLowerCase()
    ? -1
    : left.path.toLowerCase() > right.path.toLowerCase()
      ? 1
      : 0
);
const graph = createWindowsCoordinatorGenerationGraph({
  schemaVersion: "lexrunner-windows-coordinator-generation-graph/2",
  profile: "windows-coordinator-service-msi/2",
  architecture: "win-x64",
  serviceName: "LexRunnerCoordinator",
  coordinatorProtocolVersion: "1.0.0",
  boundaryProtocolVersion: WINDOWS_BOUNDARY_PROTOCOL_VERSION,
  removalProtocolVersion: WINDOWS_REMOVAL_VERSION,
  files: members,
});
await writeFile(path.win32.join(root, "generation-graph.json"), graph.manifestBytes, {
  flag: "wx",
});
console.log(
  JSON.stringify({
    manifestSha256: graph.manifestSha256,
    graphDigest: graph.graphDigest,
    gitImageSha256: members.find((member) => member.role === "git-entry")?.sha256,
    memberCount: members.length,
    authorizesLaunch: false,
  })
);
