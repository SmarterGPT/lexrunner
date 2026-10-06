import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { materializeSelectedWork } from "../src/runs/selected-work-materialization.js";
import { selectedWorkFixture } from "./fixtures/selected-work.js";
import { compose, readInput, MAX_INPUT_BYTES } from "../scripts/compose-continuation.mjs";
import { seal } from "../scripts/exploration-trail.mjs";

function fixture() {
  const materialized = materializeSelectedWork(selectedWorkFixture());
  if (!materialized.ok) throw new Error("packet fixture failed");
  const packet = materialized.packet;
  const trail = seal({
    profile: "exploration-trail-pilot/v1",
    question: "Which implementation meets the criteria?",
    attempt: "science-1",
    capturedAt: "2026-10-06T12:00:00Z",
    conditions: ["Candidate A and B on the same pinned source and test fixture"],
    premise: "Candidate A may be sufficient",
    experiment: "Try A then compare B at the failing boundary",
    observations: [
      "A handles the normal input but fails the boundary case",
      "B passes the same boundary case",
    ],
    interpretation: "B is the stronger candidate for the tested boundary",
    limitations: ["A controlled observation, not native qualification or feature acceptance"],
    openQuestions: ["Does B meet the remaining security and convention criteria?"],
    possibleNextExperiments: ["Review the focused B implementation against the unchanged criteria"],
    evidence: [
      {
        command: ["probe", "A"],
        cwd: "/fixture",
        startedAt: "2026-10-06T11:59:00Z",
        durationMs: 10,
        exitCode: 1,
        stdout: "A failed\n".repeat(800),
        stderr: "Boundary mismatch",
      },
      {
        command: ["probe", "B"],
        cwd: "/fixture",
        startedAt: "2026-10-06T11:59:01Z",
        durationMs: 8,
        exitCode: 0,
        stdout: "B passed",
        stderr: "",
      },
    ],
  });
  return {
    packet,
    expectedPacketHash: packet.packet_hash,
    trail,
    trailPath: "/evidence/science-1.json",
    expectedTrailDigest: trail.digest,
  };
}

describe("compact scientific continuation composition", () => {
  it("carries failures, comparisons, open criteria and references without rewriting the assignment", () => {
    const input = fixture();
    const before = JSON.stringify(input);
    const result = JSON.parse(compose(input));
    expect(JSON.stringify(input)).toBe(before);
    expect(result.assignment).toEqual(input.packet);
    expect(result.continuity.record.observations).toEqual(input.trail.record.observations);
    expect(result.continuity.record.limitations).toEqual(input.trail.record.limitations);
    expect(result.continuity.record.openQuestions).toEqual(input.trail.record.openQuestions);
    expect(
      result.continuity.record.evidence.map((probe: { exitCode: number }) => probe.exitCode)
    ).toEqual([1, 0]);
    expect(result.continuity.record.evidence[0]).not.toHaveProperty("stdout");
    expect(result.continuity.source.digest).toBe(input.trail.digest);
    expect(result.continuity.questionDisposition).toBe("open");
  });

  it("permits a direct fix without demanding experiments", () => {
    const { packet, expectedPacketHash } = fixture();
    expect(JSON.parse(compose({ packet, expectedPacketHash }))).not.toHaveProperty("continuity");
  });

  it("rejects altered assignments/evidence, missing selectors and overlarge delivery", () => {
    const input = fixture();
    expect(() =>
      compose({ ...input, packet: { ...input.packet, objective: "Unexpected scope" } })
    ).toThrow(/hash/i);
    expect(() => compose({ ...input, expectedPacketHash: `sha256:${"0".repeat(64)}` })).toThrow(
      "Unexpected assignment"
    );
    expect(() =>
      compose({ ...input, trail: { ...input.trail, digest: `sha256:${"0".repeat(64)}` } })
    ).toThrow("digest mismatch");
    expect(() => compose({ ...input, expectedTrailDigest: undefined })).toThrow("expected digest");
    const huge = seal({ ...input.trail.record, observations: Array(5).fill("x".repeat(3990)) });
    expect(() => compose({ ...input, trail: huge, expectedTrailDigest: huge.digest })).toThrow(
      "16 KiB"
    );
  });

  it("runs composition and hydrates only the exact selected evidence in separate native processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "lexrunner-continuation-"));
    try {
      const input = fixture(),
        packetPath = join(root, "packet.json"),
        trailPath = join(root, "trail.json");
      await Promise.all([
        writeFile(packetPath, JSON.stringify(input.packet)),
        writeFile(trailPath, JSON.stringify(input.trail)),
      ]);
      const output = execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve("scripts/compose-continuation.mjs"),
          packetPath,
          input.expectedPacketHash,
          trailPath,
          input.expectedTrailDigest,
        ],
        { encoding: "utf8", timeout: 10000 }
      );
      const compact = JSON.parse(output);
      const full = JSON.parse(
        execFileSync(
          process.execPath,
          [
            resolve("scripts/exploration-trail.mjs"),
            "resume",
            compact.continuity.source.location,
            "--expect-digest",
            compact.continuity.source.digest,
          ],
          { encoding: "utf8", timeout: 10000 }
        )
      );
      expect(full.record).toEqual(input.trail.record);
      expect(Buffer.byteLength(output)).toBeLessThan(
        Buffer.byteLength(JSON.stringify({ assignment: input.packet, trail: input.trail }))
      );
      await writeFile(
        trailPath,
        JSON.stringify(seal({ ...input.trail.record, interpretation: "Changed after observation" }))
      );
      expect(() =>
        execFileSync(
          process.execPath,
          [
            resolve("scripts/exploration-trail.mjs"),
            "resume",
            trailPath,
            "--expect-digest",
            input.expectedTrailDigest,
          ],
          { stdio: "pipe", timeout: 10000 }
        )
      ).toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects overlarge inputs and malformed UTF-8 before parsing", async () => {
    const root = await mkdtemp(join(tmpdir(), "lexrunner-continuation-input-"));
    try {
      const path = join(root, "input.json");
      await writeFile(path, Buffer.alloc(MAX_INPUT_BYTES + 1));
      await expect(readInput(path)).rejects.toThrow("64 KiB");
      await writeFile(path, Buffer.from([0x22, 0xff, 0x22]));
      await expect(readInput(path)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
