import { Buffer } from "node:buffer";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { win32 } from "node:path";
import { TextDecoder } from "node:util";

import { canonicalJSONStringify } from "../../../src/util/canonicalJson.js";
import {
  handlePrivateAdmissionObservation,
  PrivateAdmissionFixtureConfig_v1,
} from "../../../src/windows-coordinator/private-admission-bridge.js";
import {
  encodePrivatePeerDenial,
  parsePrivatePeerObservation,
  PRIVATE_PEER_MAX_REQUEST_BYTES,
} from "../../../src/windows-coordinator/private-peer-protocol.js";
import { SqliteWindowsCoordinatorAdmissionStore } from "../../../src/windows-coordinator/sqlite-admission-store.js";

// One-shot console fixture child. It has no product CLI/MCP export, service
// entrypoint, broker, Git, helper, worker dispatch or effectful verb.
function readFixture(path: string) {
  if (!win32.isAbsolute(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    throw new Error("private_fixture_path");
  const bytes = readFileSync(path);
  if (bytes.length === 0 || bytes.length > 65_536) throw new Error("private_fixture_bound");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const fixture = PrivateAdmissionFixtureConfig_v1.parse(JSON.parse(text));
  if (!bytes.equals(Buffer.from(canonicalJSONStringify(fixture), "utf8")))
    throw new Error("private_fixture_canonical");
  const database = fixture.database_path;
  if (
    !win32.isAbsolute(database) ||
    !lstatSync(database).isFile() ||
    lstatSync(database).isSymbolicLink() ||
    win32.dirname(realpathSync.native(database)).toLowerCase() !==
      win32.dirname(realpathSync.native(path)).toLowerCase()
  )
    throw new Error("private_fixture_database");
  return fixture;
}

async function readOnePrivateRequest(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > PRIVATE_PEER_MAX_REQUEST_BYTES) throw new Error("private_request_bound");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

async function main(): Promise<void> {
  if (
    process.platform !== "win32" ||
    process.argv.length !== 4 ||
    process.argv[2] !== "--private-admission-fixture"
  )
    throw new Error("private_fixture_mode");
  const fixture = readFixture(process.argv[3]);
  const observation = parsePrivatePeerObservation(await readOnePrivateRequest());
  let store: SqliteWindowsCoordinatorAdmissionStore | undefined;
  let denial;
  try {
    denial = handlePrivateAdmissionObservation(observation, fixture, {
      recordCandidate(input) {
        store ??= new SqliteWindowsCoordinatorAdmissionStore(fixture.database_path);
        return store.recordCandidate(input);
      },
    });
  } finally {
    await store?.close();
  }
  const reply = encodePrivatePeerDenial(observation.nonce, denial);
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(reply, (error) => (error ? reject(error) : resolve()));
  });
}

try {
  await main();
} catch {
  // No unbound detail or partial no-effect claim is emitted on child failure.
  process.stderr.write("private_admission_fixture_unavailable\n");
  process.exitCode = 3;
}
