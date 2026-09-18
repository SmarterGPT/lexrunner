import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { canonicalJSONStringify } from "../src/util/canonicalJson.js";
import { SqliteRemovalEvidenceStore } from "../src/store/sqlite/removal-evidence-store.js";
import {
  assessRemovalRecovery,
  parseRemovalIntentBytes,
  parseRemovalObservationBytes,
} from "../src/workspaces/workspace-removal-evidence.js";
import {
  removalProbeSnapshot,
  probeIntent,
  probeObservation,
  probePreservationDigest,
} from "./removal-probe-records.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const requestSchema = z
  .object({
    operation: z.string().min(1).max(128),
    snapshot: removalProbeSnapshot,
    previous: z.object({ intentDigest: digest, observationDigest: digest }).strict().nullable(),
  })
  .strict();

/** Development fixture only. Commit and independent connection readback precede acknowledgement.
 * No filesystem mutation, authentication, allocation reservation or production authority.
 */
export async function checkpointRemovalProbe(journal: string, raw: Buffer) {
  if (raw.length > 16384) throw new Error("Oversized checkpoint request");
  const request = requestSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw))
  );
  let store = new SqliteRemovalEvidenceStore(journal);
  try {
    let intentBytes: string;
    if (request.previous === null) {
      intentBytes = canonicalJSONStringify(
        probeIntent(request.operation, request.snapshot, probePreservationDigest(request.snapshot))
      );
      if (!store.appendIntent(intentBytes).recorded) throw new Error("Conflicting fixture intent");
    } else {
      const previous = store.readEvidence(request.operation, request.previous.observationDigest);
      const intent = parseRemovalIntentBytes(previous.intentBytes);
      const observation = parseRemovalObservationBytes(previous.observationBytes);
      if (
        intent.intent_digest !== request.previous.intentDigest ||
        observation.intent_digest !== intent.intent_digest ||
        Date.parse(request.snapshot.at) < Date.parse(observation.observed_at)
      )
        throw new Error("Checkpoint selection mismatch or time regression");
      intentBytes = previous.intentBytes!;
    }
    const intent = parseRemovalIntentBytes(intentBytes);
    const observation = probeObservation(intent.intent_digest, request.snapshot);
    const observationBytes = canonicalJSONStringify(observation);
    const assessment = assessRemovalRecovery({
      intentBytes,
      observationBytes,
      expectedIntentDigest: intent.intent_digest,
      expectedObservationDigest: observation.observation_digest,
      now: request.snapshot.at,
      maxObservationAgeMs: 0,
    });
    // Retain conflicting observations, but never acknowledge them as a successful checkpoint.
    if (!store.appendObservation(observationBytes).recorded)
      throw new Error("Observation append failed");
    await store.close();
    store = new SqliteRemovalEvidenceStore(journal, { readOnly: true });
    const readback = store.readEvidence(request.operation, observation.observation_digest);
    if (readback.intentBytes !== intentBytes || readback.observationBytes !== observationBytes)
      throw new Error("Checkpoint readback mismatch");
    if (assessment.state === "reconciliation_required") throw new Error(assessment.reason);
    return { intentBytes, observationBytes };
  } finally {
    await store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const handle = await open(process.argv[3], "r");
  let raw: Buffer;
  try {
    raw = Buffer.alloc(16385);
    const { bytesRead } = await handle.read(raw, 0, raw.length, 0);
    raw = raw.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  console.log(canonicalJSONStringify(await checkpointRemovalProbe(process.argv[2], raw)));
}
