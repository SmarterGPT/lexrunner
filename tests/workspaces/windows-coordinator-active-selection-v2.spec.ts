import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  assessWindowsCoordinatorV2SelectionConsistency,
  parseWindowsCoordinatorActiveSelectionV2Value,
} from "../../src/workspaces/windows-coordinator-active-selection-v2.js";
import { createWindowsCoordinatorGenerationGraph } from "../../src/workspaces/windows-coordinator-generation-graph.js";
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

function canonical(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
  );
}

function fixture(state: "qualified" | "provisioned-unqualified" = "qualified") {
  const files = roots.map(([path, role]) => {
    const bytes = Buffer.from(`image:${path}`, "utf8");
    return { path, role, sha256: sha256(bytes), bytes: bytes.length };
  });
  const authored = createWindowsCoordinatorGenerationGraph({
    schemaVersion: "lexrunner-windows-coordinator-generation-graph/2",
    profile: "windows-coordinator-service-msi/2",
    architecture: "win-x64",
    serviceName: "LexRunnerCoordinator",
    coordinatorProtocolVersion: "1.0.0",
    boundaryProtocolVersion: WINDOWS_BOUNDARY_PROTOCOL_VERSION,
    removalProtocolVersion: WINDOWS_REMOVAL_VERSION,
    files,
  });
  const serviceImageSha256 = files.find((file) => file.role === "service-image")!.sha256;
  const selection = {
    schemaVersion: "windows-coordinator-active-selection/2",
    profile: "windows-coordinator-service-msi/2",
    generationId: authored.graphDigest,
    graphDigest: authored.graphDigest,
    manifestSha256: authored.manifestSha256,
    serviceImageSha256,
    serviceName: "LexRunnerCoordinator",
    coordinatorProtocolVersion: "1.0.0",
    revision: 2,
  };
  const catalog = {
    GraphDigest: authored.graphDigest,
    ManifestDigest: authored.manifestSha256,
    ServiceImageDigest: serviceImageSha256,
    State: state,
    ServiceName: "LexRunnerCoordinator",
  };
  return {
    selection,
    selectionValue: canonical(selection),
    catalog,
    manifestBytes: authored.manifestBytes,
  };
}

describe("Windows coordinator v2 selection source contract", () => {
  it("binds the graph, manifest and service image separately but never authorizes launch", () => {
    const input = fixture();
    expect(input.selection.graphDigest).toBe(input.selection.generationId);
    expect(input.selection.manifestSha256).not.toBe(input.selection.graphDigest);
    expect(parseWindowsCoordinatorActiveSelectionV2Value(input.selectionValue)).toEqual(
      input.selection
    );
    expect(assessWindowsCoordinatorV2SelectionConsistency(input)).toEqual({
      state: "consistent",
      authorizesLaunch: false,
    });
  });

  it("rejects v1, duplicate, extra, alternate encoding and malformed selection", () => {
    const input = fixture();
    const invalid = [
      "{",
      input.selectionValue.replace("active-selection/2", "active-selection/1"),
      input.selectionValue.replace("service-msi/2", "service-msi/1"),
      input.selectionValue.replace('"revision":2,', '"revision":2,"revision":3,'),
      input.selectionValue.replace('"revision":2,', '"revision":2,"imagePath":"C:\\\\bad",'),
      input.selectionValue.replace('"revision":2,', '"revision":0,'),
      input.selectionValue.replace('"revision":2,', '"revision":2.0,'),
      input.selectionValue.replace('"revision":2,', '"revision":2, '),
      input.selectionValue.replace(
        `"generationId":"${input.selection.generationId}"`,
        `"generationId":"${"b".repeat(64)}"`
      ),
      input.selectionValue + "\n",
      "x".repeat(4097),
    ];
    for (const value of invalid) {
      expect(() => parseWindowsCoordinatorActiveSelectionV2Value(value), value).toThrow();
      expect(
        assessWindowsCoordinatorV2SelectionConsistency({ ...input, selectionValue: value })
      ).toEqual({ state: "inconsistent", reason: "selection_invalid", authorizesLaunch: false });
    }
  });

  it("rejects changed manifest, graph, service image and catalog claims", () => {
    const input = fixture();
    expect(
      assessWindowsCoordinatorV2SelectionConsistency({ ...input, selectionValue: null })
    ).toMatchObject({ reason: "selection_absent", authorizesLaunch: false });
    expect(
      assessWindowsCoordinatorV2SelectionConsistency({ ...input, manifestBytes: null })
    ).toMatchObject({ reason: "manifest_absent", authorizesLaunch: false });
    const changed = Buffer.from(input.manifestBytes);
    changed[changed.length - 2] = 0x20;
    expect(
      assessWindowsCoordinatorV2SelectionConsistency({ ...input, manifestBytes: changed })
    ).toMatchObject({ reason: "manifest_digest_mismatch", authorizesLaunch: false });
    for (const selectionPatch of [
      { graphDigest: "b".repeat(64), generationId: "b".repeat(64) },
      { serviceImageSha256: "b".repeat(64) },
    ]) {
      expect(
        assessWindowsCoordinatorV2SelectionConsistency({
          ...input,
          selectionValue: canonical({ ...input.selection, ...selectionPatch }),
        })
      ).toMatchObject({ reason: "selection_manifest_mismatch", authorizesLaunch: false });
    }
    for (const catalog of [
      { ...input.catalog, GraphDigest: "b".repeat(64) },
      { ...input.catalog, ManifestDigest: "b".repeat(64) },
      { ...input.catalog, ServiceImageDigest: "b".repeat(64) },
      { ...input.catalog, Extra: "accepted" },
      null,
    ]) {
      expect(assessWindowsCoordinatorV2SelectionConsistency({ ...input, catalog })).toMatchObject({
        state: "inconsistent",
        authorizesLaunch: false,
      });
    }
  });

  it("cannot infer qualification or rollback protection from supplied state/revision", () => {
    const input = fixture("provisioned-unqualified");
    expect(assessWindowsCoordinatorV2SelectionConsistency(input)).toEqual({
      state: "inconsistent",
      reason: "generation_unqualified",
      authorizesLaunch: false,
    });
    const prior = fixture();
    const priorValue = canonical({ ...prior.selection, revision: 1 });
    expect(
      assessWindowsCoordinatorV2SelectionConsistency({ ...prior, selectionValue: priorValue })
    ).toEqual({ state: "consistent", authorizesLaunch: false });
    // A protected external high-water mark, absent here, must reject a replayed old value.
  });
});
