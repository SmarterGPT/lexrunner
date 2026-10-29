import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [manifestPath, outputDirectory] = process.argv.slice(2);
if (
  !manifestPath ||
  !outputDirectory ||
  !path.win32.isAbsolute(manifestPath) ||
  !path.win32.isAbsolute(outputDirectory) ||
  process.argv.length !== 4
)
  throw new Error("Expected absolute manifest and fresh disposable output directory");
const original = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([key, item]) => [key, canonical(item)])
    );
  return value;
}
function sha(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}
function member(graph: Record<string, unknown>, role: string): Record<string, unknown> {
  const found = (graph.files as Record<string, unknown>[]).find((item) => item.role === role);
  if (!found) throw new Error("Original graph is missing fixture role");
  return found;
}
const mutations: Record<string, (value: Record<string, unknown>) => void> = {
  "wrong-worker-name": (value) => {
    value.workerServiceName = "LexRunnerWorkerSlot2";
  },
  "wrong-worker-user": (value) => {
    value.workerTokenUserSid = "S-1-5-18";
  },
  "wrong-worker-sid": (value) => {
    value.workerServiceSid = "S-1-5-80-0";
  },
  "missing-worker-image": (value) => {
    value.files = (value.files as Record<string, unknown>[]).filter(
      (item) => item.role !== "worker-service-image"
    );
  },
  "duplicate-worker-image": (value) => {
    (value.files as Record<string, unknown>[]).push({
      ...member(value, "worker-service-image"),
      path: "service/LexRunner.WindowsCoordinator.WorkerSlot2.exe",
    });
    (value.files as Record<string, unknown>[]).sort((a, b) =>
      String(a.path).toLowerCase() < String(b.path).toLowerCase() ? -1 : 1
    );
  },
  "wrong-worker-image": (value) => {
    member(value, "worker-service-image").path = "service/OtherWorker.exe";
  },
};
await mkdir(outputDirectory, { recursive: false });
const results = [];
for (const [name, change] of Object.entries(mutations)) {
  const graph = structuredClone(original);
  change(graph);
  const { graphDigest: _digest, ...body } = graph;
  graph.graphDigest = sha(
    `lexrunner-windows-coordinator-generation-graph/3\n${JSON.stringify(canonical(body))}`
  );
  const bytes = Buffer.from(JSON.stringify(canonical(graph)), "utf8");
  const manifest = path.join(outputDirectory, `${name}.json`);
  await writeFile(manifest, bytes, { flag: "wx" });
  results.push({ name, manifest, manifestSha256: sha(bytes) });
}
console.log(JSON.stringify(results));
