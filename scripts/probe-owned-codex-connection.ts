// Explicit development probe: no turn, task, authentication copying or qualification.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OwnedCodexConnection } from "../src/runs/owned-codex-connection.js";

const [executable, output] = process.argv.slice(2);
if (!executable || !output || !isAbsolute(executable) || !isAbsolute(output))
  throw new Error("Supply absolute executable and new output directory paths");
await mkdir(output); // Deliberately refuses to reuse an existing probe home.
const codexHome = join(output, "home"),
  cwd = join(output, "workspace");
await mkdir(codexHome);
await mkdir(cwd);
await writeFile(join(cwd, "sentinel.txt"), "unchanged\n");
const sha = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const started = performance.now();
const connection = await OwnedCodexConnection.open({
  executable,
  cwd,
  codexHome,
  adapterId: "development-probe",
  adapterVersion: "1",
});
let wrongThreadRejected = false;
let unobservedStopRejected = false;
try {
  await connection.request(
    "turn/start",
    { threadId: "wrong-thread", input: [{ type: "text", text: "must never send" }] },
    { signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 1000).toISOString() }
  );
} catch (error) {
  wrongThreadRejected = error instanceof Error && error.message === "thread_mismatch";
}
try {
  await connection.interrupt(
    { threadId: connection.session.threadId, turnId: "unobserved-turn" },
    { signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 1000).toISOString() }
  );
} catch (error) {
  unobservedStopRejected = error instanceof Error && error.message === "turn_not_observed";
}
const closed = await connection.close();
const snapshot = connection.snapshot();
const sentinelUnchanged = (await readFile(join(cwd, "sentinel.txt"), "utf8")) === "unchanged\n";
const passed =
  wrongThreadRejected &&
  unobservedStopRejected &&
  !snapshot.turnAttempted &&
  !snapshot.interruptAttempted &&
  closed.processExited &&
  sentinelUnchanged &&
  !snapshot.failure;
const report = {
  status: passed ? "pass" : "fail",
  exitCode: passed ? 0 : 1,
  command:
    "npx tsx scripts/probe-owned-codex-connection.ts ABSOLUTE_EXECUTABLE NEW_ABSOLUTE_OUTPUT_DIRECTORY",
  cwd: process.cwd(),
  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  executable,
  executableSha256: await sha(executable),
  cliVersion: execFileSync(executable, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim(),
  harnessSha256: await sha(fileURLToPath(import.meta.url)),
  sourceSha256: await sha(resolve("src/runs/owned-codex-connection.ts")),
  durationMs: performance.now() - started,
  session: connection.session,
  snapshot,
  closed,
  wrongThreadRejected,
  unobservedStopRejected,
  sentinelUnchanged,
  limits:
    "Idle development connection only; echoed sandbox settings are not enforcement proof. No model task, authentication copying, store attachment or qualified native workspace preparation. Child exit does not prove descendant or remote execution cleanup.",
};
await writeFile(join(output, "receipt.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.exitCode;
