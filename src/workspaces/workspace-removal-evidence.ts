import { z } from "zod";
import { computeCanonicalHash } from "../schemas/task-contract.js";
import { canonicalJSONStringify } from "../util/canonicalJson.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const id = z.string().min(1).max(128);
const instant = z.string().datetime({ offset: true });
const intentBody = z
  .object({
    schema_version: z.literal("workspace-removal-intent/1"),
    operation_id: id,
    attempt_id: id,
    lease_id: id,
    lease_revision: z.number().int().nonnegative().safe(),
    root_identity_digest: digest,
    registration_digest: digest,
    preservation_digest: digest,
    created_at: instant,
  })
  .strict();
const intentSchema = intentBody.extend({ intent_digest: digest });
const observationBody = z
  .object({
    schema_version: z.literal("workspace-removal-observation/1"),
    intent_digest: digest,
    observed_at: instant,
    root_state: z.enum(["present", "absent", "unknown"]),
    root_identity_digest: digest.nullable(),
    contents: z.enum(["remaining", "empty", "unknown"]),
    registration_state: z.enum(["present", "absent", "locked", "unknown"]),
    registration_digest: digest.nullable(),
  })
  .strict();
const observationSchema = observationBody.extend({ observation_digest: digest });

export function createRemovalIntent(input: z.input<typeof intentBody>) {
  const body = intentBody.parse(input);
  return Object.freeze({ ...body, intent_digest: computeCanonicalHash(body) });
}

export function createRemovalObservation(input: z.input<typeof observationBody>) {
  const body = observationBody.parse(input);
  return Object.freeze({ ...body, observation_digest: computeCanonicalHash(body) });
}

export function parseRemovalIntentBytes(bytes: string | null) {
  const record = intentSchema.parse(decode(bytes));
  const { intent_digest, ...body } = record;
  if (computeCanonicalHash(body) !== intent_digest)
    throw new Error("Removal intent digest mismatch");
  return Object.freeze(record);
}

export function parseRemovalObservationBytes(bytes: string | null) {
  const record = observationSchema.parse(decode(bytes));
  const { observation_digest, ...body } = record;
  if (computeCanonicalHash(body) !== observation_digest)
    throw new Error("Removal observation digest mismatch");
  return Object.freeze(record);
}

export type RemovalRecoveryState =
  | "reconciliation_required"
  | "contents_remaining"
  | "root_remaining"
  | "registration_remaining"
  | "absence_observed";
export interface RemovalRecoveryAssessment {
  state: RemovalRecoveryState;
  reason: string;
  authorizesMutation: false;
}

/** Read-side assessment only: supplied digests associate records, not authority.
 * The caller must independently select current evidence and authenticate its source.
 * No persistence, native-release receipt, retry permission or completion transition.
 */
export function assessRemovalRecovery(input: {
  intentBytes: string | null;
  observationBytes: string | null;
  expectedIntentDigest: string;
  expectedObservationDigest: string;
  now: string;
  maxObservationAgeMs: number;
}): RemovalRecoveryAssessment {
  const result = (state: RemovalRecoveryState, reason: string): RemovalRecoveryAssessment => ({
    state,
    reason,
    authorizesMutation: false,
  });
  const stop = (reason: string) => result("reconciliation_required", reason);
  try {
    digest.parse(input.expectedIntentDigest);
    digest.parse(input.expectedObservationDigest);
    instant.parse(input.now);
    z.number().int().nonnegative().safe().parse(input.maxObservationAgeMs);
    const intent = intentSchema.parse(decode(input.intentBytes));
    const observation = observationSchema.parse(decode(input.observationBytes));
    const { intent_digest: intentDigest, ...intentData } = intent;
    const { observation_digest: observationDigest, ...observationData } = observation;
    if (
      computeCanonicalHash(intentData) !== intentDigest ||
      intentDigest !== input.expectedIntentDigest ||
      observation.intent_digest !== intentDigest ||
      computeCanonicalHash(observationData) !== observationDigest ||
      observationDigest !== input.expectedObservationDigest
    )
      return stop("evidence_mismatch");
    const observed = Date.parse(observation.observed_at),
      now = Date.parse(input.now);
    if (
      observed < Date.parse(intent.created_at) ||
      observed > now ||
      now - observed > input.maxObservationAgeMs
    )
      return stop("evidence_time_invalid");
    if (
      (observation.root_state === "present") !== (observation.root_identity_digest !== null) ||
      (observation.registration_state === "present" ||
        observation.registration_state === "locked") !==
        (observation.registration_digest !== null) ||
      (observation.root_state !== "present" && observation.contents !== "unknown")
    )
      return stop("inconsistent_observation");
    if (observation.root_state === "unknown" || observation.registration_state === "unknown")
      return stop("observation_unknown");
    if (observation.registration_state === "locked") return stop("registration_locked");
    if (
      (observation.root_identity_digest !== null &&
        observation.root_identity_digest !== intent.root_identity_digest) ||
      (observation.registration_digest !== null &&
        observation.registration_digest !== intent.registration_digest)
    )
      return stop("identity_changed");
    if (observation.root_state === "absent")
      return observation.registration_state === "absent"
        ? result("absence_observed", "root_and_registration_absent")
        : result("registration_remaining", "root_absent_registration_present");
    // Missing registration with a surviving root is a partial effect, not permission to delete it.
    if (observation.registration_state === "absent") return stop("root_without_registration");
    if (observation.contents === "unknown") return stop("contents_unknown");
    return observation.contents === "remaining"
      ? result("contents_remaining", "original_root_has_contents")
      : result("root_remaining", "original_root_empty");
  } catch {
    return stop("evidence_invalid");
  }
}

function decode(bytes: string | null): unknown {
  if (typeof bytes !== "string" || Buffer.byteLength(bytes, "utf8") > 16_384)
    throw new Error("Invalid record");
  const value: unknown = JSON.parse(bytes);
  // Exact canonical bytes reject duplicate keys and ambiguous alternate encodings.
  if (canonicalJSONStringify(value) !== bytes) throw new Error("Noncanonical record");
  return value;
}
