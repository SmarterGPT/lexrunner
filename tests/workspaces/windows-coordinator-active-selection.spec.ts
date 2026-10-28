import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  assessWindowsCoordinatorSelectionConsistency,
  parseWindowsCoordinatorActiveSelectionValue,
} from "../../src/workspaces/windows-coordinator-active-selection.js";

const imageDigest = "a".repeat(64);

function canonical(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
  );
}

function fixture(state: "qualified" | "provisioned-unqualified" = "qualified") {
  const manifest = {
    schemaVersion: "lexrunner-windows-coordinator-generation/1",
    profile: "windows-coordinator-service-msi/1",
    generationId: imageDigest,
    serviceName: "LexRunnerCoordinator",
    serviceImageSha256: imageDigest,
    serviceVersion: "2.5.0",
    state,
    productionReady: state === "qualified",
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const selection = {
    schemaVersion: "windows-coordinator-active-selection/1",
    profile: "windows-coordinator-service-msi/1",
    generationId: imageDigest,
    manifestSha256,
    serviceImageSha256: imageDigest,
    serviceName: "LexRunnerCoordinator",
    serviceVersion: "2.5.0",
    protocolVersion: "1.0.0",
    revision: 1,
  };
  const catalog = {
    ManifestDigest: manifestSha256,
    ImageDigest: imageDigest,
    State: state,
    ServiceName: "LexRunnerCoordinator",
  };
  return { selection, selectionValue: canonical(selection), manifestBytes, catalog };
}

describe("Windows coordinator ActiveSelection structural contract", () => {
  it("can describe a hypothetical qualified generation but never authorizes launch", () => {
    const input = fixture();
    expect(parseWindowsCoordinatorActiveSelectionValue(input.selectionValue)).toEqual(
      input.selection
    );
    expect(assessWindowsCoordinatorSelectionConsistency(input)).toEqual({
      state: "consistent",
      authorizesLaunch: false,
    });
  });

  it("refuses missing, malformed, old-profile, duplicate, extra, and noncanonical selection", () => {
    const input = fixture();
    expect(
      assessWindowsCoordinatorSelectionConsistency({ ...input, selectionValue: null })
    ).toMatchObject({
      state: "inconsistent",
      reason: "selection_absent",
      authorizesLaunch: false,
    });
    const invalid = [
      "{",
      input.selectionValue.replace(
        "windows-coordinator-active-selection/1",
        "windows-helper-active-selection/1"
      ),
      input.selectionValue.replace(
        "windows-coordinator-service-msi/1",
        "windows-helper-msi-direct/1"
      ),
      input.selectionValue.replace('"revision":1,', '"revision":1,"revision":2,'),
      input.selectionValue.replace('"revision":1,', '"revision":1,"pipe":"arbitrary",'),
      input.selectionValue.replace('"revision":1,', '"revision":1,"pid":123,'),
      input.selectionValue.replace(
        '"revision":1,',
        '"revision":1,"serviceImagePath":"C:\\\\evil.exe",'
      ),
      input.selectionValue.replace('"revision":1,', '"revision":0,'),
      input.selectionValue.replace('"revision":1,', '"revision":1.0,'),
      input.selectionValue.replace('"revision":1,', '"revision":1, '),
      input.selectionValue.replace(
        '"serviceName":"LexRunnerCoordinator"',
        '"serviceName":"OtherService"'
      ),
      input.selectionValue.replace(
        '"serviceImageSha256":"' + imageDigest + '"',
        '"serviceImageSha256":"' + "b".repeat(64) + '"'
      ),
      input.selectionValue + "\n",
      "x".repeat(4097),
    ];
    for (const value of invalid) {
      expect(() => parseWindowsCoordinatorActiveSelectionValue(value)).toThrow();
      expect(
        assessWindowsCoordinatorSelectionConsistency({ ...input, selectionValue: value })
      ).toMatchObject({
        state: "inconsistent",
        reason: "selection_invalid",
        authorizesLaunch: false,
      });
    }
  });

  it("requires exact manifest digest, image, service and matching catalog", () => {
    const input = fixture();
    expect(
      assessWindowsCoordinatorSelectionConsistency({ ...input, manifestBytes: null })
    ).toMatchObject({
      reason: "manifest_absent",
      authorizesLaunch: false,
    });
    expect(
      assessWindowsCoordinatorSelectionConsistency({
        ...input,
        manifestBytes: Buffer.from("{}"),
      })
    ).toMatchObject({ reason: "manifest_invalid", authorizesLaunch: false });
    const changed = Buffer.from(input.manifestBytes);
    changed[changed.length - 2] = 0x20;
    expect(
      assessWindowsCoordinatorSelectionConsistency({ ...input, manifestBytes: changed })
    ).toMatchObject({
      reason: "manifest_invalid",
      authorizesLaunch: false,
    });
    const wrongDigest = { ...input.selection, manifestSha256: "c".repeat(64) };
    expect(
      assessWindowsCoordinatorSelectionConsistency({
        ...input,
        selectionValue: canonical(wrongDigest),
      })
    ).toMatchObject({ reason: "manifest_digest_mismatch", authorizesLaunch: false });
    for (const patch of [
      { serviceImageSha256: "d".repeat(64) },
      { generationId: "d".repeat(64) },
      { serviceVersion: "2.6.0" },
    ]) {
      const alteredManifestBytes = Buffer.from(
        JSON.stringify({ ...JSON.parse(input.manifestBytes.toString("utf8")), ...patch })
      );
      const alteredDigest = createHash("sha256").update(alteredManifestBytes).digest("hex");
      expect(
        assessWindowsCoordinatorSelectionConsistency({
          ...input,
          selectionValue: canonical({ ...input.selection, manifestSha256: alteredDigest }),
          manifestBytes: alteredManifestBytes,
        })
      ).toMatchObject({ reason: "selection_manifest_mismatch", authorizesLaunch: false });
    }
    const wrongServiceManifest = Buffer.from(
      input.manifestBytes.toString("utf8").replace("LexRunnerCoordinator", "OtherService")
    );
    expect(
      assessWindowsCoordinatorSelectionConsistency({
        ...input,
        manifestBytes: wrongServiceManifest,
      })
    ).toMatchObject({ reason: "manifest_invalid", authorizesLaunch: false });
    for (const catalog of [
      null,
      { ...input.catalog, ImageDigest: "b".repeat(64) },
      { ...input.catalog, ServiceName: "OtherService" },
      { ...input.catalog, ManifestDigest: "b".repeat(64) },
      { ...input.catalog, Extra: "not permitted" },
    ]) {
      expect(assessWindowsCoordinatorSelectionConsistency({ ...input, catalog })).toMatchObject({
        state: "inconsistent",
        authorizesLaunch: false,
      });
    }
  });

  it("cannot turn the initial MSI unqualified manifest into readiness", () => {
    const input = fixture("provisioned-unqualified");
    expect(assessWindowsCoordinatorSelectionConsistency(input)).toEqual({
      state: "inconsistent",
      reason: "generation_unqualified",
      authorizesLaunch: false,
    });
  });
});
