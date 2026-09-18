import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { computeCanonicalHash } from "../src/schemas/task-contract.js";
import { canonicalJSONStringify } from "../src/util/canonicalJson.js";
import {
  parseRemovalIntentBytes,
  assessRemovalRecovery,
} from "../src/workspaces/workspace-removal-evidence.js";
import { SqliteRemovalEvidenceStore } from "../src/store/sqlite/removal-evidence-store.js";

import {
  removalProbeSnapshot as snapshot,
  removalProbeCheckpoint,
  probeIntent,
  probeObservation,
  probePreservationDigest,
} from "./removal-probe-records.js";

const text = z.string().min(1).max(4096);
const names = [
  "worktree-planned-stop-content",
  "worktree-planned-stop-gitfile",
  "worktree-planned-stop-root",
  "worktree-process-killed-content",
  "worktree-process-killed-gitfile",
  "worktree-process-killed-root",
] as const;
const reportSchema = z
  .object({
    root: text,
    filesystem: text,
    passed: z.array(text).max(32),
    worktreeEvidence: z
      .array(
        z
          .object({
            name: z.enum(names),
            snapshots: z.array(snapshot).length(4),
            journalCheckpoints: z.array(removalProbeCheckpoint).length(4).optional(),
          })
          .strict()
      )
      .length(6),
  })
  .strict();

/** Fixture-only ingestion/readback qualification. A report digest is provenance, not authentication. */
export async function verifyRemovalProbeEvidence(raw: Buffer) {
  if (raw.length > 256 * 1024) throw new Error("Oversized probe report");
  const report = reportSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw))
  );
  if (new Set(report.worktreeEvidence.map((item) => item.name)).size !== names.length)
    throw new Error("Repeated/missing probe case");
  if (
    report.worktreeEvidence.some((item) => item.journalCheckpoints) &&
    !report.worktreeEvidence.every((item) => item.journalCheckpoints)
  )
    throw new Error("Mixed journal checkpoint coverage");
  const sourceDigest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  const dir = await mkdtemp(join(tmpdir(), "removal-projection-"));
  const path = join(dir, "journal.db");
  let store = new SqliteRemovalEvidenceStore(path);
  const results = [];
  try {
    for (const item of report.worktreeEvidence) {
      for (let index = 1; index < item.snapshots.length; index++) {
        if (Date.parse(item.snapshots[index].at) < Date.parse(item.snapshots[index - 1].at))
          throw new Error("Observation time order");
      }
      if (!report.passed.includes(item.name)) throw new Error("Missing probe success");
      const initial = item.snapshots[0];
      if (!initial.root || !initial.registration || !initial.backlink)
        throw new Error("Missing initial identity");
      const intent = item.journalCheckpoints
        ? parseRemovalIntentBytes(item.journalCheckpoints[0].intentBytes)
        : probeIntent(
            item.name,
            initial,
            computeCanonicalHash({
              profile: "disposable-known-files-fixture",
              sourceDigest,
            })
          );
      if (
        item.journalCheckpoints &&
        canonicalJSONStringify(intent) !==
          canonicalJSONStringify(probeIntent(item.name, initial, probePreservationDigest(initial)))
      )
        throw new Error("Pre-mutation intent binding mismatch");
      const intentBytes = canonicalJSONStringify(intent);
      if (!store.appendIntent(intentBytes).recorded) throw new Error("Intent append failed");
      const records = item.snapshots.map((state) => probeObservation(intent.intent_digest, state));
      if (item.journalCheckpoints) {
        item.journalCheckpoints.forEach((checkpoint, index) => {
          if (
            checkpoint.intentBytes !== intentBytes ||
            checkpoint.observationBytes !== canonicalJSONStringify(records[index])
          )
            throw new Error("Journal checkpoint does not match observed snapshot");
        });
      }
      for (const record of records)
        if (!store.appendObservation(canonicalJSONStringify(record)).recorded)
          throw new Error("Observation append failed");
      await store.close();
      store = new SqliteRemovalEvidenceStore(path);
      const states = records.map((record, index) => {
        const selected = store.readEvidence(item.name, record.observation_digest);
        if (
          selected.intentBytes !== intentBytes ||
          selected.observationBytes !== canonicalJSONStringify(record)
        )
          throw new Error("Readback mismatch");
        const assessment = assessRemovalRecovery({
          ...selected,
          expectedIntentDigest: intent.intent_digest,
          expectedObservationDigest: record.observation_digest,
          now: item.snapshots[index].at,
          maxObservationAgeMs: 0,
        });
        const expected =
          index === 0
            ? "contents_remaining"
            : index === 3
              ? "absence_observed"
              : index === 2 || item.name.endsWith("-root")
                ? "registration_remaining"
                : "contents_remaining";
        if (assessment.state !== expected || assessment.authorizesMutation)
          throw new Error(`Unexpected ${item.name} snapshot ${index}: ${assessment.reason}`);
        return { observationDigest: record.observation_digest, ...assessment };
      });
      results.push({ name: item.name, intentDigest: intent.intent_digest, states });
    }
    return {
      sourceDigest,
      profile: "development-native-removal-fixture",
      intentTiming: report.worktreeEvidence.every((item) => item.journalCheckpoints)
        ? "pre-mutation-journal-fixture"
        : "retrospective-fixture",
      authenticated: false,
      authorizesMutation: false,
      results,
    };
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(process.argv[2], { end: 256 * 1024 }))
    chunks.push(Buffer.from(chunk));
  console.log(canonicalJSONStringify(await verifyRemovalProbeEvidence(Buffer.concat(chunks))));
}
