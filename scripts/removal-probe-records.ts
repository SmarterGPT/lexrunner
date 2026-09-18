import { z } from "zod";
import { computeCanonicalHash } from "../src/schemas/task-contract.js";
import {
  createRemovalIntent,
  createRemovalObservation,
} from "../src/workspaces/workspace-removal-evidence.js";

const text = z.string().min(1).max(4096);
const identity = z.object({ path: text, volume: text, fileId: text, filesystem: text }).strict();
export const removalProbeSnapshot = z
  .object({
    at: z.string().datetime({ offset: true }),
    root: identity.nullable(),
    contents: z.enum(["remaining", "empty", "unknown"]),
    registration: identity.nullable(),
    backlink: text.nullable(),
  })
  .strict();
export type ProbeSnapshot = z.infer<typeof removalProbeSnapshot>;
export const removalProbeCheckpoint = z
  .object({
    intentBytes: z.string().max(16384),
    observationBytes: z.string().max(16384),
  })
  .strict();

export function probeRegistrationDigest(state: ProbeSnapshot) {
  if ((state.registration === null) !== (state.backlink === null))
    throw new Error("Inconsistent registration snapshot");
  return state.registration === null
    ? null
    : computeCanonicalHash({ identity: state.registration, backlink: state.backlink });
}

export function probeIntent(name: string, initial: ProbeSnapshot, preservationDigest: string) {
  if (!initial.root || !initial.registration || !initial.backlink)
    throw new Error("Missing initial identity");
  return createRemovalIntent({
    schema_version: "workspace-removal-intent/1",
    operation_id: name,
    attempt_id: "fixture-attempt",
    lease_id: "fixture-lease",
    lease_revision: 0,
    root_identity_digest: computeCanonicalHash(initial.root),
    registration_digest: probeRegistrationDigest(initial)!,
    preservation_digest: preservationDigest,
    created_at: initial.at,
  });
}

export function probeObservation(intentDigest: string, state: ProbeSnapshot) {
  return createRemovalObservation({
    schema_version: "workspace-removal-observation/1",
    intent_digest: intentDigest,
    observed_at: state.at,
    root_state: state.root === null ? "absent" : "present",
    root_identity_digest: state.root === null ? null : computeCanonicalHash(state.root),
    contents: state.contents,
    registration_state: state.registration === null ? "absent" : "present",
    registration_digest: probeRegistrationDigest(state),
  });
}

// Synthetic preservation association for known disposable files, not a preservation receipt.
export function probePreservationDigest(initial: ProbeSnapshot) {
  return computeCanonicalHash({ profile: "disposable-known-files-fixture", initial });
}
