import { describe, expect, it } from "vitest";
import { verifyRemovalProbeEvidence } from "../../scripts/verify-removal-probe-evidence.js";
import {
  probeIntent,
  probeObservation,
  probeOperationTime,
  probePreservationDigest,
  removalProbeSnapshot,
} from "../../scripts/removal-probe-records.js";
import { canonicalJSONStringify } from "../../src/util/canonicalJson.js";
import { assessRemovalRecovery } from "../../src/workspaces/workspace-removal-evidence.js";

function fixture() {
  const identity = { path: "fixture", volume: "1", fileId: "2", filesystem: "fixture" };
  const initial = {
    at: "2026-09-16T00:00:00Z",
    root: identity,
    contents: "remaining",
    registration: identity,
    backlink: "fixture/.git",
  };
  const rootAbsent = { ...initial, root: null, contents: "unknown" };
  const names = [
    "worktree-planned-stop-content",
    "worktree-planned-stop-gitfile",
    "worktree-planned-stop-root",
    "worktree-process-killed-content",
    "worktree-process-killed-gitfile",
    "worktree-process-killed-root",
  ];
  return {
    root: "fixture",
    filesystem: "fixture",
    passed: names,
    worktreeEvidence: names.map((name) => ({
      name,
      snapshots: [
        initial,
        name.endsWith("-root") ? rootAbsent : initial,
        rootAbsent,
        { ...rootAbsent, registration: null, backlink: null },
      ],
    })),
  };
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
describe("development removal probe evidence ingestion", () => {
  it("keeps a fresh native snapshot ahead of Node wall time unchanged while choosing fixture operation time", () => {
    const initial = removalProbeSnapshot.parse(fixture().worktreeEvidence[0].snapshots[0]);
    const intent = probeIntent("clock", initial, probePreservationDigest(initial));
    const observation = probeObservation(intent.intent_digest, {
      ...initial,
      at: "2026-09-16T00:00:01.0020000Z",
    });
    const evidence = {
      intentBytes: canonicalJSONStringify(intent),
      observationBytes: canonicalJSONStringify(observation),
      expectedIntentDigest: intent.intent_digest,
      expectedObservationDigest: observation.observation_digest,
      maxObservationAgeMs: 180_000,
    };
    const clock = {
      wallTime: "2026-09-16T00:00:01.000Z",
      observedAt: observation.observed_at,
      journalUpdatedAt: initial.at,
      leaseRenewedAt: initial.at,
    };
    expect(assessRemovalRecovery({ ...evidence, now: clock.wallTime }).reason).toBe(
      "evidence_time_invalid"
    );
    expect(assessRemovalRecovery({ ...evidence, now: probeOperationTime(clock) })).toEqual({
      state: "contents_remaining",
      reason: "original_root_has_contents",
      authorizesMutation: false,
    });
    const replacedClock = { ...clock, leaseRenewedAt: "2026-09-16T00:02:00Z" };
    expect(probeOperationTime(replacedClock)).toBe("2026-09-16T00:02:00.000Z");
    expect(
      assessRemovalRecovery({ ...evidence, now: probeOperationTime(replacedClock) }).state
    ).toBe("contents_remaining");
    // Production also refuses stale evidence; only fixture input time changes.
    expect(assessRemovalRecovery({ ...evidence, now: "2026-09-16T00:04:00Z" }).reason).toBe(
      "evidence_time_invalid"
    );
    expect(observation.observed_at).toBe("2026-09-16T00:00:01.0020000Z");
  });
  it("verifies pre-mutation checkpoint bindings without treating them as authenticated evidence", async () => {
    const report = fixture();
    const items = report.worktreeEvidence.map((item) => {
      const initial = removalProbeSnapshot.parse(item.snapshots[0]);
      const intent = probeIntent(item.name, initial, probePreservationDigest(initial));
      return {
        ...item,
        journalCheckpoints: item.snapshots.map((state) => ({
          intentBytes: canonicalJSONStringify(intent),
          observationBytes: canonicalJSONStringify(
            probeObservation(intent.intent_digest, removalProbeSnapshot.parse(state))
          ),
        })),
      };
    });
    const bound = { ...report, worktreeEvidence: items };
    const result = await verifyRemovalProbeEvidence(encode(bound));
    expect(result.intentTiming).toBe("pre-mutation-journal-fixture");
    expect(result.authenticated).toBe(false);
    items[0].journalCheckpoints[1] = items[0].journalCheckpoints[2];
    await expect(verifyRemovalProbeEvidence(encode(bound))).rejects.toThrow(
      "does not match observed snapshot"
    );
    await expect(
      verifyRemovalProbeEvidence(
        encode({ ...report, worktreeEvidence: [items[0], ...report.worktreeEvidence.slice(1)] })
      )
    ).rejects.toThrow("Mixed journal");
  });
  it("round-trips all selected observations without authorizing or authenticating them", async () => {
    const result = await verifyRemovalProbeEvidence(encode(fixture()));
    expect(result.authenticated).toBe(false);
    expect(result.authorizesMutation).toBe(false);
    expect(result.results).toHaveLength(6);
    expect(result.results.flatMap((item) => item.states)).toHaveLength(24);
    expect(
      result.results.every((item) =>
        item.states.every((state) => state.authorizesMutation === false)
      )
    ).toBe(true);
  });
  it("binds exact source bytes, not only parsed content", async () => {
    const a = await verifyRemovalProbeEvidence(encode(fixture()));
    const b = await verifyRemovalProbeEvidence(Buffer.from(JSON.stringify(fixture(), null, 2)));
    expect(a.sourceDigest).not.toBe(b.sourceDigest);
    expect(a.results[0].intentDigest).not.toBe(b.results[0].intentDigest);
  });
  it("rejects a changed observed root instead of copying the initial identity", async () => {
    // Break shared fixture object references: JSON roundtrip gives each snapshot its own identity.
    const independent = JSON.parse(JSON.stringify(fixture()));
    independent.worktreeEvidence[0].snapshots[1].root.fileId = "replacement";
    await expect(verifyRemovalProbeEvidence(encode(independent))).rejects.toThrow(
      "identity_changed"
    );
  });
  it("rejects out-of-order observation times", async () => {
    const report = fixture();
    report.worktreeEvidence[0].snapshots[2] = {
      ...report.worktreeEvidence[0].snapshots[2],
      at: "2026-09-15T00:00:00Z",
    };
    await expect(verifyRemovalProbeEvidence(encode(report))).rejects.toThrow(
      "Observation time order"
    );
  });
  it("rejects changed registration identity and inconsistent backlink evidence", async () => {
    const report = JSON.parse(JSON.stringify(fixture()));
    report.worktreeEvidence[0].snapshots[2].registration.fileId = "replacement";
    await expect(verifyRemovalProbeEvidence(encode(report))).rejects.toThrow("identity_changed");
    report.worktreeEvidence[0].snapshots[2].registration = null;
    await expect(verifyRemovalProbeEvidence(encode(report))).rejects.toThrow(
      "Inconsistent registration"
    );
  });
  it("rejects repeated cases, missing success and malformed reports", async () => {
    const report = fixture();
    report.worktreeEvidence[1].name = report.worktreeEvidence[0].name;
    await expect(verifyRemovalProbeEvidence(encode(report))).rejects.toThrow("Repeated/missing");
    const missing = fixture();
    missing.passed = [];
    await expect(verifyRemovalProbeEvidence(encode(missing))).rejects.toThrow(
      "Missing probe success"
    );
    await expect(verifyRemovalProbeEvidence(Buffer.from("{"))).rejects.toThrow();
    await expect(verifyRemovalProbeEvidence(Buffer.alloc(256 * 1024 + 1))).rejects.toThrow(
      "Oversized"
    );
  });
});
