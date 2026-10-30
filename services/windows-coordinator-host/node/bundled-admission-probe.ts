import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path, { win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { SqliteWindowsCoordinatorAdmissionStore } from "../../../src/windows-coordinator/sqlite-admission-store.js";
import { parseWindowsCoordinatorGenerationGraph } from "../../../src/workspaces/windows-coordinator-generation-graph.js";

declare const __LEX_BUNDLED_SQLITE_VERSION__: string;

const expectedNodeAbi = "137";
const maxManifestBytes = 262_144;
const maxEntryBytes = 8 * 1024 * 1024;
const maxAddonBytes = 16 * 1024 * 1024;
const runtimeRequire = createRequire(import.meta.url);

export function requireBundledNodeAbi(observed: string): "137" {
  if (observed !== expectedNodeAbi) throw new Error("bundled_node_abi_unavailable");
  return expectedNodeAbi;
}

/** Node-API capability is separate from the narrowly selected Node module ABI. */
export function requireBundledNodeApi(
  observed: string | undefined,
  sqliteVersion: string
): string | null {
  if (sqliteVersion !== "12.11.1" && sqliteVersion !== "13.0.3")
    throw new Error("bundled_sqlite_version_unavailable");
  if (
    sqliteVersion === "13.0.3" &&
    (observed === undefined || !/^[0-9]{1,3}$/u.test(observed) || Number(observed) < 10)
  )
    throw new Error("bundled_node_api_unavailable");
  return observed ?? null;
}

function exactLocalPath(value: string): boolean {
  return /^[A-Za-z]:\\/u.test(value) && win32.resolve(value) === value;
}

function boundedRegularFile(file: string, maxBytes: number): Uint8Array {
  const before = lstatSync(file, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size <= 0n ||
    before.size > BigInt(maxBytes) ||
    before.ino === 0n
  )
    throw new Error("bundled_member_unavailable");
  const bytes = readFileSync(file);
  const after = lstatSync(file, { bigint: true });
  if (
    BigInt(bytes.byteLength) !== before.size ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeNs !== before.mtimeNs
  )
    throw new Error("bundled_member_changed");
  return bytes;
}

function exactMember(root: string, relative: string): string {
  const joined = win32.join(root, ...relative.split("/"));
  if (
    !exactLocalPath(joined) ||
    !joined.toLowerCase().startsWith(`${root.toLowerCase()}\\`) ||
    realpathSync.native(joined).toLowerCase() !== joined.toLowerCase()
  )
    throw new Error("bundled_member_path");
  return joined;
}

/**
 * An isolated, non-authorizing Node/SQLite bundle probe. The manifest digest is
 * caller-supplied fixture data; this does not establish installed custody.
 */
export async function probeBundledAdmission(
  manifestPath: string,
  expectedManifestSha256: string,
  entryPath: string = fileURLToPath(import.meta.url)
): Promise<{
  readonly schemaVersion: "windows-bundled-admission-probe/1";
  readonly graphDigest: string;
  readonly addonSha256: string;
  readonly nodeAbi: "137";
  readonly nodeApiVersion: string | null;
  readonly sqlitePackageVersion: string;
  readonly authorizesLaunch: false;
}> {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("bundled_windows_x64_required");
  const nodeAbi = requireBundledNodeAbi(process.versions.modules);
  const sqlitePackageVersion =
    typeof __LEX_BUNDLED_SQLITE_VERSION__ === "undefined"
      ? "unselected"
      : __LEX_BUNDLED_SQLITE_VERSION__;
  const nodeApiVersion = requireBundledNodeApi(process.versions.napi, sqlitePackageVersion);
  if (!exactLocalPath(manifestPath) || !exactLocalPath(entryPath))
    throw new Error("bundled_manifest_path");
  const root = win32.dirname(manifestPath);
  if (win32.basename(manifestPath) !== "generation-graph.json")
    throw new Error("bundled_manifest_name");
  const manifestBytes = boundedRegularFile(manifestPath, maxManifestBytes);
  const { manifest } = parseWindowsCoordinatorGenerationGraph(
    manifestBytes,
    expectedManifestSha256
  );
  const entry = manifest.files.find((file) => file.role === "admission-entry")!;
  const addon = manifest.files.find((file) => file.role === "sqlite-addon")!;
  const selectedEntry = exactMember(root, entry.path);
  const selectedAddon = exactMember(root, addon.path);
  if (selectedEntry.toLowerCase() !== entryPath.toLowerCase())
    throw new Error("bundled_entry_mismatch");
  for (const [member, absolute, limit] of [
    [entry, selectedEntry, maxEntryBytes],
    [addon, selectedAddon, maxAddonBytes],
  ] as const) {
    const bytes = boundedRegularFile(absolute, limit);
    if (
      bytes.byteLength !== member.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== member.sha256
    )
      throw new Error("bundled_member_digest_mismatch");
  }
  // Only the explicit selected addon object reaches the bundled default wrapper.
  // Its version-specific resolver refuses default or string-path lookup.
  const nativeBinding = runtimeRequire(selectedAddon) as object;
  if (nativeBinding === null || typeof nativeBinding !== "object")
    throw new Error("bundled_addon_invalid");
  const store = new SqliteWindowsCoordinatorAdmissionStore(":memory:", { nativeBinding });
  await store.close();
  return {
    schemaVersion: "windows-bundled-admission-probe/1",
    graphDigest: manifest.graphDigest,
    addonSha256: addon.sha256,
    nodeAbi,
    nodeApiVersion,
    sqlitePackageVersion,
    authorizesLaunch: false,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.length !== 5 || process.argv[2] !== "--bundle-probe") {
    process.stderr.write("bundled_admission_probe_usage\n");
    process.exitCode = 2;
  } else {
    probeBundledAdmission(process.argv[3]!, process.argv[4]!)
      .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
      .catch(() => {
        process.stderr.write("bundled_admission_probe_unavailable\n");
        process.exitCode = 3;
      });
  }
}
