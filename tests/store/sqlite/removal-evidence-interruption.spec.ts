import { describe, expect, it } from "vitest";
import { fork } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteRemovalEvidenceStore } from "../../../src/store/sqlite/removal-evidence-store.js";
import {
  createRemovalIntent,
  createRemovalObservation,
  assessRemovalRecovery,
} from "../../../src/workspaces/workspace-removal-evidence.js";
import { canonicalJSONStringify } from "../../../src/util/canonicalJson.js";

async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Child fixture deadline exceeded")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("removal journal process interruption", () => {
  it.each(["intent", "uncommitted", "observation"] as const)(
    "reopens after killing child at %s boundary",
    async (phase) => {
      const dir = await mkdtemp(join(tmpdir(), "removal-interruption-"));
      const path = join(dir, "store.db"),
        inputPath = join(dir, "input.json"),
        finallyPath = join(dir, "finally.txt");
      const hash = `sha256:${"a".repeat(64)}`;
      const intent = createRemovalIntent({
        schema_version: "workspace-removal-intent/1",
        operation_id: "remove-1",
        attempt_id: "attempt-1",
        lease_id: "lease-1",
        lease_revision: 1,
        root_identity_digest: hash,
        registration_digest: hash,
        preservation_digest: hash,
        created_at: "2026-09-16T00:00:00Z",
      });
      const observation = createRemovalObservation({
        schema_version: "workspace-removal-observation/1",
        intent_digest: intent.intent_digest,
        observed_at: "2026-09-16T00:00:01Z",
        root_state: "absent",
        root_identity_digest: null,
        contents: "unknown",
        registration_state: "absent",
        registration_digest: null,
      });
      const input = {
        intentBytes: canonicalJSONStringify(intent),
        observationBytes: canonicalJSONStringify(observation),
      };
      await writeFile(inputPath, JSON.stringify(input));
      const child = fork(
        fileURLToPath(new URL("./fixtures/removal-journal-child.ts", import.meta.url)),
        [path, phase, inputPath, finallyPath],
        { execArgv: ["--import", "tsx"], silent: true }
      );
      let output = "";
      for (const stream of [child.stdout, child.stderr])
        stream?.on("data", (chunk) => {
          output = (output + String(chunk)).slice(-4096);
        });
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once("close", (code, signal) => resolve({ code, signal }))
      );
      let store: SqliteRemovalEvidenceStore | undefined;
      try {
        const ready = new Promise<unknown>((resolve, reject) => {
          child.once("message", resolve);
          child.once("error", reject);
          child.once("exit", () => reject(new Error(`Child exited before phase: ${output}`)));
        });
        expect(await bounded(ready, 15000)).toEqual({
          phase,
          inTransaction: phase === "uncommitted",
        });
        expect(child.exitCode).toBeNull();
        expect(child.kill("SIGKILL")).toBe(true);
        const exit = await bounded(closed, 10000);
        expect(exit.code === 0 && exit.signal === null).toBe(false);
        await expect(readFile(finallyPath)).rejects.toMatchObject({ code: "ENOENT" });
        // Writable reopening lets SQLite recover its interrupted transaction normally.
        store = new SqliteRemovalEvidenceStore(path);
        const evidence = store.readEvidence(intent.operation_id, observation.observation_digest);
        expect(evidence).toEqual({
          intentBytes: input.intentBytes,
          observationBytes: phase === "observation" ? input.observationBytes : null,
        });
        expect(
          assessRemovalRecovery({
            ...evidence,
            expectedIntentDigest: intent.intent_digest,
            expectedObservationDigest: observation.observation_digest,
            now: "2026-09-16T00:00:02Z",
            maxObservationAgeMs: 1000,
          })
        ).toMatchObject({
          state: phase === "observation" ? "absence_observed" : "reconciliation_required",
          authorizesMutation: false,
        });
        expect(store.appendIntent(input.intentBytes)).toEqual({ recorded: true, replay: true });
        expect(store.appendObservation(input.observationBytes)).toEqual({
          recorded: true,
          replay: phase === "observation",
        });
        await store.close();
        store = new SqliteRemovalEvidenceStore(path, { readOnly: true });
        expect(store.readEvidence(intent.operation_id, observation.observation_digest)).toEqual(
          input
        );
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await bounded(closed, 10000);
        await store?.close();
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
    40000
  );
});
