import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { SqliteRemovalEvidenceStore } from "../../../src/store/sqlite/removal-evidence-store.js";
import {
  createRemovalIntent,
  createRemovalObservation,
  assessRemovalRecovery,
} from "../../../src/workspaces/workspace-removal-evidence.js";
import { canonicalJSONStringify as bytes } from "../../../src/util/canonicalJson.js";

const hash = (c: string) => `sha256:${c.repeat(64)}`;
const intentBody = {
  schema_version: "workspace-removal-intent/1" as const,
  operation_id: "remove-1",
  attempt_id: "attempt-1",
  lease_id: "lease-1",
  lease_revision: 3,
  root_identity_digest: hash("a"),
  registration_digest: hash("b"),
  preservation_digest: hash("c"),
  created_at: "2026-09-16T00:00:00Z",
};
const intent = createRemovalIntent(intentBody);
const observationBody = {
  schema_version: "workspace-removal-observation/1" as const,
  intent_digest: intent.intent_digest,
  observed_at: "2026-09-16T00:00:01Z",
  root_state: "present" as const,
  root_identity_digest: hash("a"),
  contents: "remaining" as const,
  registration_state: "present" as const,
  registration_digest: hash("b"),
};
const observation = createRemovalObservation(observationBody);

describe("SQLite removal evidence journal", () => {
  let dir: string, path: string;
  let stores: SqliteRemovalEvidenceStore[];
  function open(readOnly = false) {
    const store = new SqliteRemovalEvidenceStore(path, { readOnly });
    stores.push(store);
    return store;
  }
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "removal-journal-"));
    path = join(dir, "store.db");
    stores = [];
  });
  afterEach(async () => {
    for (const store of stores) await store.close();
    await rm(dir, { recursive: true, force: true });
  });
  it("reopens intent before appending an observation and assesses exact readback", async () => {
    const first = open();
    expect(first.appendIntent(bytes(intent))).toEqual({ recorded: true, replay: false });
    await first.close();
    const second = open();
    expect(second.readEvidence(intent.operation_id, observation.observation_digest)).toEqual({
      intentBytes: bytes(intent),
      observationBytes: null,
    });
    expect(second.appendObservation(bytes(observation))).toEqual({ recorded: true, replay: false });
    await second.close();
    const evidence = open(true).readEvidence(intent.operation_id, observation.observation_digest);
    expect(evidence).toEqual({ intentBytes: bytes(intent), observationBytes: bytes(observation) });
    expect(
      assessRemovalRecovery({
        ...evidence,
        expectedIntentDigest: intent.intent_digest,
        expectedObservationDigest: observation.observation_digest,
        now: "2026-09-16T00:00:02Z",
        maxObservationAgeMs: 1000,
      })
    ).toMatchObject({ state: "contents_remaining", authorizesMutation: false });
  });
  it("makes exact retries idempotent across connections and refuses conflicting intents", () => {
    const first = open(),
      second = open();
    first.appendIntent(bytes(intent));
    expect(second.appendIntent(bytes(intent))).toEqual({ recorded: true, replay: true });
    expect(
      second.appendIntent(bytes(createRemovalIntent({ ...intentBody, lease_revision: 4 })))
    ).toEqual({ recorded: false, reason: "conflict" });
    first.appendObservation(bytes(observation));
    expect(second.appendObservation(bytes(observation))).toEqual({ recorded: true, replay: true });
    expect(
      second.readEvidence(intent.operation_id, observation.observation_digest).intentBytes
    ).toBe(bytes(intent));
  });
  it("requires a recorded intent and never infers a latest observation", () => {
    const store = open();
    expect(store.appendObservation(bytes(observation))).toEqual({
      recorded: false,
      reason: "intent_missing",
    });
    store.appendIntent(bytes(intent));
    store.appendObservation(bytes(observation));
    const newer = createRemovalObservation({
      ...observationBody,
      contents: "empty",
      observed_at: "2026-09-16T00:00:02Z",
    });
    store.appendObservation(bytes(newer));
    expect(
      store.readEvidence(intent.operation_id, observation.observation_digest).observationBytes
    ).toBe(bytes(observation));
    expect(store.readEvidence(intent.operation_id, newer.observation_digest).observationBytes).toBe(
      bytes(newer)
    );
    expect(store.readEvidence(intent.operation_id, hash("f")).observationBytes).toBeNull();
    expect(store.readEvidence("missing", newer.observation_digest)).toEqual({
      intentBytes: null,
      observationBytes: null,
    });
  });
  it("does not attach another intent's valid observation", () => {
    const store = open();
    const other = createRemovalIntent({ ...intentBody, operation_id: "other" });
    store.appendIntent(bytes(intent));
    store.appendIntent(bytes(other));
    store.appendObservation(bytes(observation));
    expect(store.readEvidence(other.operation_id, observation.observation_digest)).toEqual({
      intentBytes: bytes(other),
      observationBytes: null,
    });
  });
  it("cannot append through a read-only connection", async () => {
    const store = open();
    store.appendIntent(bytes(intent));
    await store.close();
    expect(() => open(true).appendObservation(bytes(observation))).toThrow();
    expect(
      open().readEvidence(intent.operation_id, observation.observation_digest).observationBytes
    ).toBeNull();
  });
  it.each([
    "{",
    "x".repeat(16385),
    bytes(intent).replace('"lease_revision": 3', '"lease_revision": 4'),
    JSON.stringify(intent),
  ])("rejects invalid intent bytes before recording", (invalid) => {
    const store = open();
    expect(() => store.appendIntent(invalid)).toThrow();
    expect(
      store.readEvidence(intent.operation_id, observation.observation_digest).intentBytes
    ).toBeNull();
  });
  it.each(["intent", "observation"] as const)(
    "retains corrupted %s bytes and refuses readback or replay",
    async (kind) => {
      const store = open();
      store.appendIntent(bytes(intent));
      store.appendObservation(bytes(observation));
      await store.close();
      const db = new Database(path);
      try {
        db.prepare(
          `UPDATE removal_${kind === "intent" ? "intents" : "observations"} SET recordJson=?`
        ).run("{");
      } finally {
        db.close();
      }
      const reopened = open();
      expect(() =>
        reopened.readEvidence(intent.operation_id, observation.observation_digest)
      ).toThrow();
      expect(() =>
        kind === "intent"
          ? reopened.appendIntent(bytes(intent))
          : reopened.appendObservation(bytes(observation))
      ).toThrow();
      const read = new Database(path, { readonly: true });
      try {
        expect(
          read
            .prepare(
              `SELECT recordJson FROM removal_${kind === "intent" ? "intents" : "observations"}`
            )
            .get()
        ).toEqual({ recordJson: "{" });
      } finally {
        read.close();
      }
    }
  );
  it("rejects a row whose operation binding disagrees with valid bytes", () => {
    const store = open();
    store.appendIntent(bytes(intent));
    const db = new Database(path);
    try {
      db.prepare("UPDATE removal_intents SET operationId='wrong'").run();
    } finally {
      db.close();
    }
    expect(() => store.readEvidence("wrong", observation.observation_digest)).toThrow("binding");
  });
  describe.each(["intent", "observation"] as const)("raw %s corruption", (kind) => {
    it.each(["nul", "oversized", "invalid-utf8", "bom"])(
      "rejects %s bytes on read and replay",
      (damage) => {
        const store = open();
        store.appendIntent(bytes(intent));
        store.appendObservation(bytes(observation));
        const original = Buffer.from(bytes(kind === "intent" ? intent : observation));
        const corrupted =
          damage === "nul"
            ? Buffer.concat([original, Buffer.from([0]), Buffer.from("CORRUPT")])
            : damage === "oversized"
              ? Buffer.concat([original, Buffer.alloc(17000, 32)])
              : damage === "bom"
                ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original])
                : Buffer.concat([original, Buffer.from([0xff])]);
        const db = new Database(path);
        try {
          db.prepare(
            `UPDATE removal_${kind === "intent" ? "intents" : "observations"} SET recordJson=CAST(? AS TEXT)`
          ).run(corrupted);
          expect(() =>
            store.readEvidence(intent.operation_id, observation.observation_digest)
          ).toThrow();
          expect(() =>
            kind === "intent"
              ? store.appendIntent(bytes(intent))
              : store.appendObservation(bytes(observation))
          ).toThrow();
          expect(
            db
              .prepare(
                `SELECT CAST(recordJson AS BLOB) AS raw FROM removal_${kind === "intent" ? "intents" : "observations"}`
              )
              .get()
          ).toEqual({ raw: corrupted });
        } finally {
          db.close();
        }
      }
    );
  });
});
