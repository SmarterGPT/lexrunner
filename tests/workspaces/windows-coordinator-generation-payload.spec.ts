import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  enumerateBoundedGenerationEntries,
  verifyWindowsCoordinatorGenerationPayload,
} from "../../scripts/verify-windows-coordinator-generation-payload.js";
import { createWindowsCoordinatorGenerationGraph } from "../../src/workspaces/windows-coordinator-generation-graph.js";
import { WINDOWS_BOUNDARY_PROTOCOL_VERSION } from "../../src/workspaces/windows-boundary-protocol.js";
import { WINDOWS_REMOVAL_VERSION } from "../../src/workspaces/windows-removal-protocol.js";

const members = [
  ["bin/helper.exe", "helper-image"],
  ["client/client.exe", "client-image"],
  ["git/cmd/git.exe", "git-entry"],
  ["node/admission.mjs", "admission-entry"],
  ["node/addon.node", "sqlite-addon"],
  ["node/node.exe", "node-image"],
  ["service/coordinator.exe", "service-image"],
] as const;
const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    if (dirname(root) !== tmpdir() || !basename(root).startsWith("lexrunner-graph-payload-"))
      throw new Error("Unexpected payload fixture cleanup path");
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lexrunner-graph-payload-"));
  temporaryRoots.push(root);
  const files = members
    .map(([path, role]) => {
      const bytes = Buffer.from(`fixture:${path}`, "utf8");
      return {
        path,
        role,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
        content: bytes,
      };
    })
    .sort((left, right) => left.path.toLowerCase().localeCompare(right.path.toLowerCase()));
  for (const file of files) {
    const target = join(root, ...file.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
  const authored = createWindowsCoordinatorGenerationGraph({
    schemaVersion: "lexrunner-windows-coordinator-generation-graph/2",
    profile: "windows-coordinator-service-msi/2",
    architecture: "win-x64",
    serviceName: "LexRunnerCoordinator",
    coordinatorProtocolVersion: "1.0.0",
    boundaryProtocolVersion: WINDOWS_BOUNDARY_PROTOCOL_VERSION,
    removalProtocolVersion: WINDOWS_REMOVAL_VERSION,
    files: files.map(({ path, role, sha256, bytes }) => ({ path, role, sha256, bytes })),
  });
  await writeFile(join(root, "generation-graph.json"), authored.manifestBytes);
  return { root, files, authored };
}

describe("Windows coordinator v2 generation payload source preflight", () => {
  it("binds every listed file and never authorizes launch", async () => {
    const { root, files, authored } = await fixture();
    expect(await verifyWindowsCoordinatorGenerationPayload(root, authored.manifestSha256)).toEqual({
      schemaVersion: "windows-coordinator-generation-payload-check/1",
      graphDigest: authored.graphDigest,
      manifestSha256: authored.manifestSha256,
      fileCount: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      authorizesLaunch: false,
    });
  });

  it("rejects missing, extra and altered package members", async () => {
    const missing = await fixture();
    await unlink(join(missing.root, ...missing.files[0]!.path.split("/")));
    await expect(
      verifyWindowsCoordinatorGenerationPayload(missing.root, missing.authored.manifestSha256)
    ).rejects.toThrow("incomplete");

    const extra = await fixture();
    await writeFile(join(extra.root, "node", "hidden.mjs"), "extra");
    await expect(
      verifyWindowsCoordinatorGenerationPayload(extra.root, extra.authored.manifestSha256)
    ).rejects.toThrow("Unlisted generation member");

    const altered = await fixture();
    await writeFile(join(altered.root, ...altered.files[0]!.path.split("/")), "tampered");
    await expect(
      verifyWindowsCoordinatorGenerationPayload(altered.root, altered.authored.manifestSha256)
    ).rejects.toThrow("digest mismatch");
  });

  it("rejects a caller digest that does not bind the manifest", async () => {
    const { root } = await fixture();
    await expect(verifyWindowsCoordinatorGenerationPayload(root, "0".repeat(64))).rejects.toThrow(
      "digest mismatch"
    );
  });

  it("rejects rooted-drive-relative, UNC, device and drive-relative payload paths", async () => {
    const { authored } = await fixture();
    for (const root of [
      "\\payload",
      "\\\\server\\share\\payload",
      "\\\\?\\D:\\payload",
      "D:relative",
    ]) {
      await expect(
        verifyWindowsCoordinatorGenerationPayload(root, authored.manifestSha256)
      ).rejects.toThrow("fully qualified");
    }
  });

  it("stops enumerating at the directory entry budget", async () => {
    const { root } = await fixture();
    const nodeDirectory = join(root, "node");
    for (let index = 0; index < 511; index++) {
      await writeFile(join(nodeDirectory, `extra-${index.toString().padStart(3, "0")}.bin`), "x");
    }
    const consume = async () => {
      for await (const _ of enumerateBoundedGenerationEntries(nodeDirectory)) {
        // Consume entries until the verifier refuses the over-budget directory.
      }
    };
    await expect(consume()).rejects.toThrow("entry budget exceeded");
  });
});
