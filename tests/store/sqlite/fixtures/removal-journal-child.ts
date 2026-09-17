import { readFileSync, writeFileSync } from "node:fs";
import { SqliteRemovalEvidenceStore } from "../../../../src/store/sqlite/removal-evidence-store.js";

// Test-only transaction seam. Product APIs gain no pause/kill hooks.
class InterruptedStore extends SqliteRemovalEvidenceStore {
  beginUncommittedObservation() {
    this.db.exec("BEGIN IMMEDIATE");
  }
  get inTransaction() {
    return this.db.inTransaction;
  }
}

const [path, phase, inputPath, finallyPath] = process.argv.slice(2);
if (!process.send || !["intent", "uncommitted", "observation"].includes(phase))
  throw new Error("Expected fixture IPC and a known phase");
const input = JSON.parse(readFileSync(inputPath, "utf8"));
const store = new InterruptedStore(path);
try {
  const intent = store.appendIntent(input.intentBytes);
  if (!intent.recorded || intent.replay) throw new Error("Expected fresh intent");
  if (phase === "uncommitted") store.beginUncommittedObservation();
  if (phase !== "intent") {
    const observation = store.appendObservation(input.observationBytes);
    if (!observation.recorded || observation.replay) throw new Error("Expected fresh observation");
  }
  if (store.inTransaction !== (phase === "uncommitted"))
    throw new Error("Unexpected transaction state");
  process.send({ phase, inTransaction: store.inTransaction });
  await new Promise<void>(() => {
    setInterval(() => {}, 1000);
  });
} finally {
  writeFileSync(finallyPath, "managed cleanup entered");
  await store.close();
}
