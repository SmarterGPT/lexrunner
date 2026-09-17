import { describe, expect, it } from "vitest";
import { verifyRemovalProbeEvidence } from "../../scripts/verify-removal-probe-evidence.js";

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
