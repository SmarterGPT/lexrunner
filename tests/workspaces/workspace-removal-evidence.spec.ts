import { describe, expect, it } from "vitest";
import {
  assessRemovalRecovery,
  createRemovalIntent,
  createRemovalObservation,
} from "../../src/workspaces/workspace-removal-evidence.js";
import { canonicalJSONStringify } from "../../src/util/canonicalJson.js";

const hash = (c: string) => `sha256:${c.repeat(64)}`;
const intent = createRemovalIntent({
  schema_version: "workspace-removal-intent/1",
  operation_id: "remove-1",
  attempt_id: "attempt-1",
  lease_id: "lease-1",
  lease_revision: 3,
  root_identity_digest: hash("a"),
  registration_digest: hash("b"),
  preservation_digest: hash("c"),
  created_at: "2026-09-16T00:00:00Z",
});
const body = {
  schema_version: "workspace-removal-observation/1" as const,
  intent_digest: intent.intent_digest,
  observed_at: "2026-09-16T00:00:01Z",
  root_state: "present" as const,
  root_identity_digest: hash("a"),
  contents: "remaining" as const,
  registration_state: "present" as const,
  registration_digest: hash("b"),
};
function input(overrides: Partial<Parameters<typeof createRemovalObservation>[0]> = {}) {
  const observation = createRemovalObservation({ ...body, ...overrides });
  return {
    intentBytes: canonicalJSONStringify(intent),
    observationBytes: canonicalJSONStringify(observation),
    expectedIntentDigest: intent.intent_digest,
    expectedObservationDigest: observation.observation_digest,
    now: "2026-09-16T00:00:02Z",
    maxObservationAgeMs: 1000,
  };
}
describe("removal recovery evidence", () => {
  it.each([
    [{}, "contents_remaining"],
    [{ contents: "empty" }, "root_remaining"],
    [
      { root_state: "absent", root_identity_digest: null, contents: "unknown" },
      "registration_remaining",
    ],
    [
      {
        root_state: "absent",
        root_identity_digest: null,
        contents: "unknown",
        registration_state: "absent",
        registration_digest: null,
      },
      "absence_observed",
    ],
  ] as const)("separates observed removal effects: %j", (overrides, state) => {
    expect(assessRemovalRecovery(input(overrides))).toMatchObject({
      state,
      authorizesMutation: false,
    });
  });
  it.each([null, "", "{", "x".repeat(16385)])(
    "rejects missing/truncated/oversized records",
    (bytes) => {
      expect(assessRemovalRecovery({ ...input(), intentBytes: bytes }).state).toBe(
        "reconciliation_required"
      );
      expect(assessRemovalRecovery({ ...input(), observationBytes: bytes }).state).toBe(
        "reconciliation_required"
      );
    }
  );
  it("rejects modified bytes and independently selected digest mismatches", () => {
    const original = input();
    expect(
      assessRemovalRecovery({
        ...original,
        observationBytes: original.observationBytes.replace('"remaining"', '"empty"'),
      }).reason
    ).toBe("evidence_mismatch");
    expect(assessRemovalRecovery({ ...original, expectedIntentDigest: hash("d") }).reason).toBe(
      "evidence_mismatch"
    );
    expect(
      assessRemovalRecovery({ ...original, expectedObservationDigest: hash("e") }).reason
    ).toBe("evidence_mismatch");
    expect(assessRemovalRecovery(input({ intent_digest: hash("f") })).reason).toBe(
      "evidence_mismatch"
    );
  });
  it("rejects duplicate keys and extra fields even if JSON parsing would accept them", () => {
    const original = input();
    const bytes = original.intentBytes.replace("{", '{"lease_revision":3,');
    expect(assessRemovalRecovery({ ...original, intentBytes: bytes }).reason).toBe(
      "evidence_invalid"
    );
    expect(
      assessRemovalRecovery({
        ...original,
        intentBytes: canonicalJSONStringify({ ...intent, authority: true }),
      }).reason
    ).toBe("evidence_invalid");
  });
  it.each(["2026-09-15T23:59:59Z", "2026-09-16T00:00:00Z", "2026-09-16T00:00:03Z"])(
    "rejects stale/pre-intent/future evidence %s",
    (observed_at) => {
      expect(assessRemovalRecovery(input({ observed_at })).reason).toBe("evidence_time_invalid");
    }
  );
  it.each([
    [{ root_identity_digest: hash("d") }, "identity_changed"],
    [{ registration_digest: hash("d") }, "identity_changed"],
    [{ registration_state: "locked" }, "registration_locked"],
    [{ contents: "unknown" }, "contents_unknown"],
    [{ registration_state: "absent", registration_digest: null }, "root_without_registration"],
    [
      { root_state: "unknown", root_identity_digest: null, contents: "unknown" },
      "observation_unknown",
    ],
    [{ root_state: "absent" }, "inconsistent_observation"],
  ] as const)("preserves ambiguous or changed state: %j", (overrides, reason) => {
    expect(assessRemovalRecovery(input(overrides))).toEqual({
      state: "reconciliation_required",
      reason,
      authorizesMutation: false,
    });
  });
});
