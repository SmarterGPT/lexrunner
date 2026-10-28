import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseWindowsCoordinatorGenerationGraph } from "../src/workspaces/windows-coordinator-generation-graph.js";

const manifestName = "generation-graph.json";
const maxManifestBytes = 262_144;
const maxTotalBytes = 2 * 1024 * 1024 * 1024;

/** Yield at most 513 entries, closing the directory even when a consumer rejects. */
export async function* enumerateBoundedGenerationEntries(
  directory: string
): AsyncGenerator<string> {
  const handle = await opendir(directory);
  try {
    let count = 0;
    while (true) {
      const entry = await handle.read();
      if (entry === null) return;
      if (++count > 513) throw new Error("Generation directory entry budget exceeded");
      yield entry.name;
    }
  } finally {
    await handle.close();
  }
}

async function readBounded(path: string, limit: number): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > limit)
      throw new Error("Invalid generation manifest file");
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      if (length > limit) throw new Error("Generation manifest exceeds byte budget");
      chunks.push(bytes);
    }
    if (length !== info.size) throw new Error("Generation manifest changed while reading");
    return Buffer.concat(chunks);
  } finally {
    await handle.close();
  }
}

async function digestBounded(path: string, expectedBytes: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== expectedBytes)
      throw new Error("Generation member size mismatch");
    const hash = createHash("sha256");
    let length = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      length += chunk.length;
      if (length > expectedBytes) throw new Error("Generation member grew while reading");
      hash.update(chunk);
    }
    const after = await handle.stat();
    if (
      length !== expectedBytes ||
      after.size !== expectedBytes ||
      after.mtimeMs !== before.mtimeMs
    )
      throw new Error("Generation member changed while reading");
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

/** Offline source preflight only; the supplied expected digest is not an authority root. */
export async function verifyWindowsCoordinatorGenerationPayload(
  root: string,
  expectedManifestSha256: string
): Promise<{
  readonly schemaVersion: "windows-coordinator-generation-payload-check/1";
  readonly graphDigest: string;
  readonly manifestSha256: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly authorizesLaunch: false;
}> {
  if (
    !isAbsolute(root) ||
    resolve(root) !== root ||
    (process.platform === "win32" && (!/^[A-Za-z]:\\/.test(root) || root.length <= 3))
  )
    throw new Error(
      "Generation payload path must be a normalized, fully qualified local drive path"
    );
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error("Generation payload root must be a real directory");
  const manifestPath = join(root, manifestName);
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink())
    throw new Error("Generation graph must be a regular file");
  const manifestBytes = await readBounded(manifestPath, maxManifestBytes);
  const { manifest, manifestSha256 } = parseWindowsCoordinatorGenerationGraph(
    manifestBytes,
    expectedManifestSha256
  );
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  const expectedDirectories = new Set<string>();
  for (const file of manifest.files) {
    const segments = file.path.split("/");
    for (let index = 1; index < segments.length; index++)
      expectedDirectories.add(segments.slice(0, index).join("/"));
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  async function visit(directory: string, segments: readonly string[]): Promise<void> {
    for await (const name of enumerateBoundedGenerationEntries(directory)) {
      const relative = [...segments, name].join("/");
      const path = join(directory, name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`Generation link unsupported: ${relative}`);
      if (info.isDirectory()) {
        if (!expectedDirectories.has(relative))
          throw new Error(`Unlisted generation directory: ${relative}`);
        await visit(path, [...segments, name]);
        continue;
      }
      if (!info.isFile()) throw new Error(`Unsupported generation member: ${relative}`);
      if (relative === manifestName && segments.length === 0) continue;
      const file = expected.get(relative);
      if (file === undefined || seen.has(relative))
        throw new Error(`Unlisted generation member: ${relative}`);
      totalBytes += file.bytes;
      if (totalBytes > maxTotalBytes) throw new Error("Generation payload exceeds byte budget");
      if (info.size !== file.bytes || (await digestBounded(path, file.bytes)) !== file.sha256)
        throw new Error(`Generation member digest mismatch: ${relative}`);
      seen.add(relative);
    }
  }
  await visit(root, []);
  if (seen.size !== expected.size) throw new Error("Generation payload is incomplete");
  return {
    schemaVersion: "windows-coordinator-generation-payload-check/1",
    graphDigest: manifest.graphDigest,
    manifestSha256,
    fileCount: seen.size,
    totalBytes,
    authorizesLaunch: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root, digest, ...extra] = process.argv.slice(2);
  if (!root || !digest || extra.length !== 0) {
    console.error(
      "Usage: verify-windows-coordinator-generation-payload <absolute-root> <expected-manifest-sha256>"
    );
    process.exitCode = 2;
  } else {
    verifyWindowsCoordinatorGenerationPayload(root, digest)
      .then((result) => console.log(JSON.stringify(result)))
      .catch((error: unknown) => {
        console.error(
          error instanceof Error ? error.message : "Generation payload preflight failed"
        );
        process.exitCode = 3;
      });
  }
}
