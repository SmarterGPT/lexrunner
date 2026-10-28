import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createWindowsCoordinatorGenerationGraph,
  parseWindowsCoordinatorGenerationGraph,
  verifyWindowsCoordinatorGraphBytes,
} from "../../src/workspaces/windows-coordinator-generation-graph.js";
import { WINDOWS_BOUNDARY_PROTOCOL_VERSION } from "../../src/workspaces/windows-boundary-protocol.js";
import { WINDOWS_REMOVAL_VERSION } from "../../src/workspaces/windows-removal-protocol.js";

const roots = [
  ["bin/lexrunner-windows-boundary-helper.exe", "helper-image"],
  ["client/lexrunner-windows-coordinator-client.exe", "client-image"],
  ["git/cmd/git.exe", "git-entry"],
  ["node/better_sqlite3.node", "sqlite-addon"],
  ["node/node.exe", "node-image"],
  ["node/private-admission-worker.mjs", "admission-entry"],
  ["service/LexRunner.WindowsCoordinator.Service.exe", "service-image"],
] as const;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture(extra: readonly (readonly [string, string])[] = []) {
  const artifacts = [...roots, ...extra]
    .map(([path, role]) => ({ path, role, bytes: Buffer.from(`image:${path}`, "utf8") }))
    .sort((left, right) => (left.path.toLowerCase() < right.path.toLowerCase() ? -1 : 1));
  const body = {
    schemaVersion: "lexrunner-windows-coordinator-generation-graph/2",
    profile: "windows-coordinator-service-msi/2",
    architecture: "win-x64",
    serviceName: "LexRunnerCoordinator",
    coordinatorProtocolVersion: "1.0.0",
    boundaryProtocolVersion: WINDOWS_BOUNDARY_PROTOCOL_VERSION,
    removalProtocolVersion: WINDOWS_REMOVAL_VERSION,
    files: artifacts.map(({ path, role, bytes }) => ({
      path,
      role,
      sha256: sha256(bytes),
      bytes: bytes.length,
    })),
  };
  return { body, artifacts: artifacts.map(({ path, bytes }) => ({ path, bytes })) };
}

describe("Windows coordinator generation graph v2 source contract", () => {
  it("binds canonical graph and manifest digests separately without authorizing launch", () => {
    const { body, artifacts } = fixture([
      ["git/mingw64/bin/git.exe", "git-tool"],
      ["git/mingw64/bin/libgit.dll", "native-dll"],
      ["node/lib/schema.mjs", "javascript-module"],
    ]);
    const authored = createWindowsCoordinatorGenerationGraph(body);
    const parsed = parseWindowsCoordinatorGenerationGraph(
      authored.manifestBytes,
      authored.manifestSha256
    );
    expect(parsed.manifest.files).toHaveLength(10);
    expect(parsed.manifest.graphDigest).toBe(authored.graphDigest);
    expect(parsed.manifestSha256).toBe(sha256(authored.manifestBytes));
    expect(parsed.manifestSha256).not.toBe(authored.graphDigest);
    expect(parsed.authorizesLaunch).toBe(false);
    expect(
      verifyWindowsCoordinatorGraphBytes(authored.manifestBytes, authored.manifestSha256, artifacts)
    ).toEqual({
      graphDigest: authored.graphDigest,
      manifestSha256: authored.manifestSha256,
      authorizesLaunch: false,
    });
  });

  it("rejects aliases, traversal, streams and device names in relative paths", () => {
    const attacks = [
      "bin/../helper.exe",
      "bin/x:stream.exe",
      "bin\\helper.exe",
      "C:/bin/helper.exe",
      "bin//helper.exe",
      "bin/CON.exe",
      "bin/com1.dll",
      "bin/helper.",
      "bin/HELPER~1.EXE",
      "bin/hélper.exe",
      "bin/.hidden.exe",
      "bin/helper.exe/",
    ];
    for (const path of attacks) {
      const { body } = fixture();
      body.files[0]!.path = path;
      expect(() => createWindowsCoordinatorGenerationGraph(body), path).toThrow();
    }
  });

  it("rejects case-fold collisions, inconsistent directory casing and noncanonical order", () => {
    for (const extra of [
      [
        ["bin/Extra.exe", "git-tool"],
        ["bin/extra.exe", "git-tool"],
      ],
      [["Git/tools/other.exe", "git-tool"]],
      [
        ["git/mingw64", "git-support-file"],
        ["git/mingw64.a", "git-support-file"],
        ["git/mingw64/bin/git.exe", "git-tool"],
      ],
    ]) {
      expect(() => createWindowsCoordinatorGenerationGraph(fixture(extra).body)).toThrow();
    }
    const { body } = fixture();
    body.files.reverse();
    expect(() => createWindowsCoordinatorGenerationGraph(body)).toThrow();
  });

  it("requires every exact root role and rejects unknown or malformed members", () => {
    const { body } = fixture();
    expect(() => createWindowsCoordinatorGenerationGraph({ ...body, unreviewed: true })).toThrow();
    expect(() =>
      createWindowsCoordinatorGenerationGraph({
        ...body,
        files: body.files.map((file, index) =>
          index === 0 ? { ...file, unreviewed: true } : file
        ),
      })
    ).toThrow();
    expect(() =>
      createWindowsCoordinatorGenerationGraph({ ...body, files: body.files.slice(1) })
    ).toThrow();
    for (const patch of [
      { role: "unreviewed-dll" },
      { role: "service-image" },
      { sha256: "A".repeat(64) },
      { bytes: 0 },
      { path: "bin/helper.dll" },
    ]) {
      const changed = fixture().body;
      Object.assign(changed.files[0]!, patch);
      expect(() => createWindowsCoordinatorGenerationGraph(changed)).toThrow();
    }
  });

  it("rejects changed manifest bytes, changed digests and ambiguous JSON", () => {
    const authored = createWindowsCoordinatorGenerationGraph(fixture().body);
    expect(() =>
      parseWindowsCoordinatorGenerationGraph(authored.manifestBytes, "b".repeat(64))
    ).toThrow();
    const text = Buffer.from(authored.manifestBytes).toString("utf8");
    const changedGraph = Buffer.from(
      text.replace(`"graphDigest":"${authored.graphDigest}"`, `"graphDigest":"${"b".repeat(64)}"`)
    );
    expect(() =>
      parseWindowsCoordinatorGenerationGraph(changedGraph, sha256(changedGraph))
    ).toThrow();
    for (const changed of [
      Buffer.from(text + "\n"),
      Buffer.from("\ufeff" + text),
      Buffer.from(
        text.replace(
          '"architecture":"win-x64",',
          '"architecture":"win-x64","architecture":"win-x64",'
        )
      ),
      Buffer.from(
        text.replace(
          '"profile":"windows-coordinator-service-msi/2",',
          '"profile":"windows-coordinator-service-msi/2", '
        )
      ),
    ]) {
      expect(() => parseWindowsCoordinatorGenerationGraph(changed, sha256(changed))).toThrow();
    }
  });

  it("rejects changed, missing, extra and differently spelled artifact bytes", () => {
    const { body, artifacts } = fixture();
    const authored = createWindowsCoordinatorGenerationGraph(body);
    const check = (items: typeof artifacts) =>
      verifyWindowsCoordinatorGraphBytes(authored.manifestBytes, authored.manifestSha256, items);
    expect(() =>
      check(
        artifacts.map((item, index) =>
          index === 0 ? { ...item, bytes: Buffer.from("changed") } : item
        )
      )
    ).toThrow();
    expect(() => check(artifacts.slice(1))).toThrow();
    expect(() => check([...artifacts, { path: "extra/x.dll", bytes: Buffer.from("x") }])).toThrow();
    expect(() =>
      check(
        artifacts.map((item, index) =>
          index === 0 ? { ...item, path: item.path.toUpperCase() } : item
        )
      )
    ).toThrow();
    expect(() => check([...artifacts.slice(1), artifacts[1]!])).toThrow();
  });
});
