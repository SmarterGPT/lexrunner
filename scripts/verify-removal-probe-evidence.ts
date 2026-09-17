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
  createRemovalIntent,
  createRemovalObservation,
  assessRemovalRecovery,
} from "../src/workspaces/workspace-removal-evidence.js";
import { SqliteRemovalEvidenceStore } from "../src/store/sqlite/removal-evidence-store.js";

const text = z.string().min(1).max(4096);
const identity = z.object({ path: text, volume: text, fileId: text, filesystem: text }).strict();
const snapshot = z
  .object({
    at: z.string().datetime({ offset: true }),
    root: identity.nullable(),
    contents: z.enum(["remaining", "empty", "unknown"]),
    registration: identity.nullable(),
    backlink: text.nullable(),
  })
  .strict();
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
      const registrationDigest = (state: z.infer<typeof snapshot>) =>
        state.registration === null
          ? null
          : computeCanonicalHash({ identity: state.registration, backlink: state.backlink });
      const intent = createRemovalIntent({
        schema_version: "workspace-removal-intent/1",
        operation_id: item.name,
        attempt_id: "fixture-attempt",
        lease_id: "fixture-lease",
        lease_revision: 0,
        root_identity_digest: computeCanonicalHash(initial.root),
        registration_digest: registrationDigest(initial)!,
        preservation_digest: computeCanonicalHash({
          profile: "disposable-known-files-fixture",
          sourceDigest,
        }),
        created_at: initial.at,
      });
      const intentBytes = canonicalJSONStringify(intent);
      if (!store.appendIntent(intentBytes).recorded) throw new Error("Intent append failed");
      const records = item.snapshots.map((state) => {
        if ((state.registration === null) !== (state.backlink === null))
          throw new Error("Inconsistent registration snapshot");
        return createRemovalObservation({
          schema_version: "workspace-removal-observation/1",
          intent_digest: intent.intent_digest,
          observed_at: state.at,
          root_state: state.root === null ? "absent" : "present",
          root_identity_digest: state.root === null ? null : computeCanonicalHash(state.root),
          contents: state.contents,
          registration_state: state.registration === null ? "absent" : "present",
          registration_digest: registrationDigest(state),
        });
      });
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
      intentTiming: "retrospective-fixture",
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
