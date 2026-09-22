import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointRemovalProbe } from "../../scripts/checkpoint-removal-probe.js";
import { SqliteRemovalEvidenceStore } from "../../src/store/sqlite/removal-evidence-store.js";

const identity = { path: "fixture", volume: "1", fileId: "2", filesystem: "fixture" };
const initial = {
  at: "2026-09-16T00:00:00Z",
  root: identity,
  contents: "remaining",
  registration: identity,
  backlink: "fixture/.git",
};
const encode = (snapshot: unknown, previous: unknown = null) =>
  Buffer.from(JSON.stringify({ operation: "remove-1", snapshot, previous }));
const selection = (checkpoint: { intentBytes: string; observationBytes: string }) => ({
  intentDigest: JSON.parse(checkpoint.intentBytes).intent_digest,
  observationDigest: JSON.parse(checkpoint.observationBytes).observation_digest,
});

async function fixture(run: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "removal-checkpoint-"));
  try {
    await run(join(dir, "journal.db"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("pre-mutation removal fixture checkpoints", () => {
  it("persists an initial intent before acknowledging and reuses it after reopening", async () => {
    await fixture(async (path) => {
      const first = await checkpointRemovalProbe(path, encode(initial));
      const expected = selection(first);
      const store = new SqliteRemovalEvidenceStore(path, { readOnly: true });
      try {
        expect(store.readEvidence("remove-1", expected.observationDigest)).toEqual(first);
      } finally {
        await store.close();
      }
      const second = await checkpointRemovalProbe(
        path,
        encode(
          { ...initial, at: "2026-09-16T00:00:01Z", root: null, contents: "unknown" },
          expected
        )
      );
      expect(second.intentBytes).toBe(first.intentBytes);
      expect(selection(second).observationDigest).not.toBe(expected.observationDigest);
      await expect(checkpointRemovalProbe(path, encode(initial))).rejects.toThrow("Stale");
      const reopened = new SqliteRemovalEvidenceStore(path, { readOnly: true });
      try {
        expect(reopened.readSelection("remove-1", expected.intentDigest)?.observationBytes).toBe(
          second.observationBytes
        );
      } finally {
        await reopened.close();
      }
    });
  });

  it("does not recreate a missing intent on a resume request", async () => {
    await fixture(async (path) => {
      await expect(
        checkpointRemovalProbe(
          path,
          encode(initial, {
            intentDigest: `sha256:${"a".repeat(64)}`,
            observationDigest: `sha256:${"b".repeat(64)}`,
          })
        )
      ).rejects.toThrow();
      const store = new SqliteRemovalEvidenceStore(path);
      try {
        expect(store.readEvidence("remove-1", `sha256:${"b".repeat(64)}`).intentBytes).toBeNull();
      } finally {
        await store.close();
      }
    });
  });

  it("rejects an old selector even when its new observation has a later timestamp", async () => {
    await fixture(async (path) => {
      const first = await checkpointRemovalProbe(path, encode(initial));
      const second = await checkpointRemovalProbe(
        path,
        encode({ ...initial, at: "2026-09-16T00:00:01Z" }, selection(first))
      );
      await expect(
        checkpointRemovalProbe(
          path,
          encode({ ...initial, at: "2026-09-16T00:00:02Z" }, selection(first))
        )
      ).rejects.toThrow("Stale");
      const store = new SqliteRemovalEvidenceStore(path);
      try {
        const current = selection(second);
        expect(store.readSelection("remove-1", current.intentDigest)?.observationDigest).toBe(
          current.observationDigest
        );
        expect(
          store.selectObservation(
            "remove-1",
            current.intentDigest,
            selection(first).observationDigest,
            current.observationDigest
          )
        ).toBe(false);
        expect(() => store.readSelection("remove-1", `sha256:${"f".repeat(64)}`)).toThrow(
          "mismatch"
        );
      } finally {
        await store.close();
      }
    });
  });

  it("replays an acknowledged checkpoint but does not select appended evidence implicitly", async () => {
    await fixture(async (path) => {
      const first = await checkpointRemovalProbe(path, encode(initial));
      expect(await checkpointRemovalProbe(path, encode(initial))).toEqual(first);
      const { probeObservation } = await import("../../scripts/removal-probe-records.js");
      const { canonicalJSONStringify } = await import("../../src/util/canonicalJson.js");
      const expected = selection(first);
      const next = probeObservation(expected.intentDigest, {
        ...initial,
        contents: "remaining",
        at: "2026-09-16T00:00:01Z",
      });
      const store = new SqliteRemovalEvidenceStore(path);
      try {
        expect(store.appendObservation(canonicalJSONStringify(next)).recorded).toBe(true);
        expect(store.readSelection("remove-1", expected.intentDigest)?.observationDigest).toBe(
          expected.observationDigest
        );
        expect(
          store.selectObservation("remove-1", expected.intentDigest, next.observation_digest, null)
        ).toBe(false);
        expect(
          store.selectObservation(
            "remove-1",
            expected.intentDigest,
            next.observation_digest,
            expected.observationDigest
          )
        ).toBe(true);
      } finally {
        await store.close();
      }
      const reopened = new SqliteRemovalEvidenceStore(path, { readOnly: true });
      try {
        expect(reopened.readSelection("remove-1", expected.intentDigest)?.observationDigest).toBe(
          next.observation_digest
        );
      } finally {
        await reopened.close();
      }
    });
  });

  it("rejects conflicting preparation, wrong selections and older observations", async () => {
    await fixture(async (path) => {
      const first = await checkpointRemovalProbe(path, encode(initial));
      await expect(
        checkpointRemovalProbe(path, encode({ ...initial, root: { ...identity, fileId: "new" } }))
      ).rejects.toThrow("Conflicting");
      await expect(
        checkpointRemovalProbe(
          path,
          encode(initial, {
            ...selection(first),
            intentDigest: `sha256:${"a".repeat(64)}`,
          })
        )
      ).rejects.toThrow("selection mismatch");
      await expect(
        checkpointRemovalProbe(
          path,
          encode({ ...initial, at: "2026-09-15T00:00:00Z" }, selection(first))
        )
      ).rejects.toThrow("time regression");
    });
  });

  it("retains changed-identity evidence but refuses a success acknowledgement", async () => {
    await fixture(async (path) => {
      const first = await checkpointRemovalProbe(path, encode(initial));
      await expect(
        checkpointRemovalProbe(
          path,
          encode({ ...initial, root: { ...identity, fileId: "replacement" } }, selection(first))
        )
      ).rejects.toThrow("identity_changed");
      const { probeObservation } = await import("../../scripts/removal-probe-records.js");
      const changed = probeObservation(selection(first).intentDigest, {
        ...initial,
        contents: "remaining",
        root: { ...identity, fileId: "replacement" },
      });
      const store = new SqliteRemovalEvidenceStore(path, { readOnly: true });
      try {
        expect(
          store.readEvidence("remove-1", changed.observation_digest).observationBytes
        ).not.toBeNull();
        expect(
          store.readSelection("remove-1", selection(first).intentDigest)?.observationDigest
        ).toBe(changed.observation_digest);
      } finally {
        await store.close();
      }
    });
  });

  it("rejects oversized and malformed input", async () => {
    await fixture(async (path) => {
      await expect(checkpointRemovalProbe(path, Buffer.alloc(16385))).rejects.toThrow("Oversized");
      await expect(checkpointRemovalProbe(path, Buffer.from([0xff]))).rejects.toThrow();
      await expect(checkpointRemovalProbe(path, Buffer.from("{}"))).rejects.toThrow();
    });
  });
});
