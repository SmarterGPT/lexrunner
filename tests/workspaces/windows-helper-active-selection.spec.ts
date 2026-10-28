import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  assessWindowsHelperSelectionConsistency,
  parseWindowsHelperActiveSelectionValue,
} from "../../src/workspaces/windows-helper-active-selection.js";

const generation = "a".repeat(64);
const sourceRevision = "b".repeat(40);
const otherRevision = "c".repeat(40);
// Independently calculated with the MSI builder's .NET Guid(byte[]) recipe.
const productCode = "{B4631CCA-77F3-5A51-8812-ADBCBB8296D1}";

function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === "object") {
      const record = item as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, sort(record[key])])
      );
    }
    return item;
  };
  return JSON.stringify(sort(value));
}

function suppliedData() {
  const manifest = {
    schemaVersion: "windows-helper-generation/1",
    profile: "windows-helper-msi-direct/1",
    generationId: generation,
    helperVersion: "0.1.0",
    helper: {
      file: "lexrunner-windows-boundary-helper.exe",
      sha256: generation,
      bytes: 2_753_944,
      architecture: "x64",
      protocolVersion: "2.0.0",
      removalVersion: "1.0.0",
    },
    source: {
      repository: "SmarterGPT/lexrunner",
      revision: sourceRevision,
      signingRunId: 40291115593,
      basis: "supplied test claim; no independent provenance",
    },
    publisherPolicy: {
      id: "lexrunner-azure-helper-publisher/1",
      subject: "CN=Joseph Gustavson",
      identityEku: "1.3.6.1.4.1.311.97.664386437.910814316.510550690.722133748",
    },
    state: "qualified",
    productionReady: true,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const selection = {
    schemaVersion: "windows-helper-active-selection/1",
    profile: "windows-helper-msi-direct/1",
    generationId: generation,
    manifestSha256,
    publisherPolicyId: "lexrunner-azure-helper-publisher/1",
    protocolVersion: "2.0.0",
    removalVersion: "1.0.0",
    source: {
      repository: "SmarterGPT/lexrunner",
      revision: sourceRevision,
      signingRunId: 40291115593,
    },
    revision: 1,
  };
  const marker = {
    schemaVersion: "windows-helper-installation/1",
    generationId: generation,
    manifestSha256,
    state: "qualified",
    productionReady: true,
  };
  return {
    selectionValue: canonical(selection),
    manifestBytes,
    catalog: { ManifestDigest: manifestSha256, State: "qualified", ProductCode: productCode },
    installationMarkerBytes: Buffer.from(JSON.stringify(marker), "utf8"),
  };
}

describe("supplied Windows helper ActiveSelection consistency", () => {
  it("matches one complete selection, manifest, catalog and installation marker without authorizing launch", () => {
    const input = suppliedData();
    expect(parseWindowsHelperActiveSelectionValue(input.selectionValue).generationId).toBe(
      generation
    );
    expect(assessWindowsHelperSelectionConsistency(input)).toEqual({
      state: "consistent",
      authorizesLaunch: false,
    });
  });

  it("refuses absent and ambiguous selection values", () => {
    const input = suppliedData();
    expect(
      assessWindowsHelperSelectionConsistency({ ...input, selectionValue: null })
    ).toMatchObject({
      state: "inconsistent",
      reason: "selection_absent",
    });
    const duplicate = input.selectionValue.replace('"revision":1', '"revision":1,"revision":2');
    for (const selectionValue of [
      duplicate,
      input.selectionValue + "\n",
      input.selectionValue.replace('"revision":1', '"revision":1,"unknown":true'),
      input.selectionValue.replace('"revision":1', '"revision":0'),
      "x".repeat(4097),
    ]) {
      expect(assessWindowsHelperSelectionConsistency({ ...input, selectionValue })).toMatchObject({
        state: "inconsistent",
        reason: "selection_invalid",
        authorizesLaunch: false,
      });
    }
  });

  it("rejects altered manifest bytes and a separately selected source revision", () => {
    const input = suppliedData();
    expect(
      assessWindowsHelperSelectionConsistency({
        ...input,
        manifestBytes: Buffer.concat([input.manifestBytes, Buffer.from(" ")]),
      })
    ).toMatchObject({ reason: "manifest_digest_mismatch" });
    const selection = JSON.parse(input.selectionValue) as Record<string, any>;
    selection.source.revision = otherRevision;
    expect(
      assessWindowsHelperSelectionConsistency({ ...input, selectionValue: canonical(selection) })
    ).toMatchObject({ reason: "selection_manifest_mismatch" });
  });

  it("rejects BOM and duplicate-key metadata even when the selection digest is updated", () => {
    const input = suppliedData();
    const bomManifest = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), input.manifestBytes]);
    const duplicateManifest = Buffer.from(
      input.manifestBytes
        .toString("utf8")
        .replace('"state":"qualified"', '"state":"qualified","state":"qualified"'),
      "utf8"
    );
    for (const manifestBytes of [bomManifest, duplicateManifest]) {
      const selection = JSON.parse(input.selectionValue) as Record<string, unknown>;
      selection.manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
      expect(
        assessWindowsHelperSelectionConsistency({
          ...input,
          selectionValue: canonical(selection),
          manifestBytes,
        })
      ).toMatchObject({ reason: "manifest_invalid", authorizesLaunch: false });
    }
    const duplicateMarker = Buffer.from(
      input.installationMarkerBytes
        .toString("utf8")
        .replace('"productionReady":true', '"productionReady":true,"productionReady":true'),
      "utf8"
    );
    expect(
      assessWindowsHelperSelectionConsistency({
        ...input,
        installationMarkerBytes: duplicateMarker,
      })
    ).toMatchObject({ reason: "installation_marker_invalid", authorizesLaunch: false });
  });

  it("does not promote the installed provisioned-unqualified generation from a forged selection", () => {
    const input = suppliedData();
    const manifest = JSON.parse(input.manifestBytes.toString("utf8")) as Record<string, unknown>;
    manifest.state = "provisioned-unqualified";
    manifest.productionReady = false;
    const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
    const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    const selection = JSON.parse(input.selectionValue) as Record<string, unknown>;
    selection.manifestSha256 = manifestSha256;
    expect(
      assessWindowsHelperSelectionConsistency({
        ...input,
        selectionValue: canonical(selection),
        manifestBytes,
      })
    ).toMatchObject({ reason: "generation_unqualified", authorizesLaunch: false });
  });

  it("rejects missing or disagreeing catalog and installation marker claims", () => {
    const input = suppliedData();
    expect(
      assessWindowsHelperSelectionConsistency({
        ...input,
        catalog: { ...input.catalog, State: "provisioned-unqualified" },
      })
    ).toMatchObject({ reason: "catalog_mismatch" });
    expect(
      assessWindowsHelperSelectionConsistency({
        ...input,
        catalog: { ...input.catalog, ProductCode: "{C60E00FC-77ED-528D-8822-528CEF18D1C6}" },
      })
    ).toMatchObject({ reason: "catalog_mismatch", authorizesLaunch: false });
    expect(
      assessWindowsHelperSelectionConsistency({ ...input, installationMarkerBytes: null })
    ).toMatchObject({ reason: "installation_marker_absent" });
    const marker = JSON.parse(input.installationMarkerBytes.toString("utf8")) as Record<
      string,
      unknown
    >;
    marker.generationId = "d".repeat(64);
    expect(
      assessWindowsHelperSelectionConsistency({
        ...input,
        installationMarkerBytes: Buffer.from(JSON.stringify(marker), "utf8"),
      })
    ).toMatchObject({ reason: "installation_marker_mismatch" });
  });
});
