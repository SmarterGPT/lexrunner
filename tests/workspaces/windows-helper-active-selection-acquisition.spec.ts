import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  selection: vi.fn(),
  catalog: vi.fn(),
  lstat: vi.fn(),
  fstat: vi.fn(),
  realpath: vi.fn(),
  open: vi.fn(),
  read: vi.fn(),
  close: vi.fn(),
}));

vi.mock("../../src/workspaces/windows-helper-active-selection-reader.js", () => ({
  observeWindowsHelperActiveSelection: host.selection,
  observeWindowsHelperGenerationCatalog: host.catalog,
}));
vi.mock("node:fs", () => ({
  lstatSync: host.lstat,
  fstatSync: host.fstat,
  realpathSync: { native: host.realpath },
  openSync: host.open,
  readSync: host.read,
  closeSync: host.close,
}));

import { observeWindowsHelperSelectionAcquisition } from "../../src/workspaces/windows-helper-active-selection-acquisition.js";

const generation = "a".repeat(64);
const sourceRevision = "b".repeat(40);
const productCode = "{B4631CCA-77F3-5A51-8812-ADBCBB8296D1}";
const installationRoot =
  String.raw`D:\Program Files\SmarterGPT.LexRunner.WindowsHelper\generations` + `\\${generation}`;

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

function fixture() {
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
      protocolVersion: "2.1.0",
      removalVersion: "1.0.0",
    },
    source: {
      repository: "SmarterGPT/lexrunner",
      revision: sourceRevision,
      signingRunId: 40291115593,
      basis: "fixture only",
    },
    publisherPolicy: {
      id: "lexrunner-azure-helper-publisher/1",
      subject: "CN=Joseph Gustavson",
      identityEku: "1.3.6.1.4.1.311.97.664386437.910814316.510550690.722133748",
    },
    state: "qualified",
    productionReady: true,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const digest = createHash("sha256").update(manifestBytes).digest("hex");
  const markerBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: "windows-helper-installation/1",
      generationId: generation,
      manifestSha256: digest,
      state: "qualified",
      productionReady: true,
    })
  );
  const selectionValue = canonical({
    schemaVersion: "windows-helper-active-selection/1",
    profile: "windows-helper-msi-direct/1",
    generationId: generation,
    manifestSha256: digest,
    publisherPolicyId: "lexrunner-azure-helper-publisher/1",
    protocolVersion: "2.1.0",
    removalVersion: "1.0.0",
    source: {
      repository: "SmarterGPT/lexrunner",
      revision: sourceRevision,
      signingRunId: 40291115593,
    },
    revision: 1,
  });
  return { manifestBytes, markerBytes, selectionValue, digest };
}

const data = fixture();

beforeEach(() => {
  vi.resetAllMocks();
  host.selection.mockReturnValue({
    state: "observed",
    selectionValue: data.selectionValue,
    authorizesLaunch: false,
  });
  host.catalog.mockReturnValue({
    state: "observed",
    catalog: { ManifestDigest: data.digest, State: "qualified", ProductCode: productCode },
    systemRoot: String.raw`D:\Windows`,
    authorizesLaunch: false,
  });
  host.realpath.mockImplementation((component: string) => component);
  const files = new Map<number, Buffer>([
    [101, data.manifestBytes],
    [102, data.markerBytes],
  ]);
  host.open.mockImplementation((file: string) => (file.endsWith("generation.json") ? 101 : 102));
  const statFor = (bytes: Buffer, ino: bigint) => ({
    dev: 77n,
    ino,
    size: BigInt(bytes.length),
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
  });
  host.fstat.mockImplementation((fd: number) => statFor(files.get(fd)!, BigInt(fd)));
  host.lstat.mockImplementation((file: string) => {
    if (file.endsWith("generation.json")) return statFor(data.manifestBytes, 101n);
    if (file.endsWith("installed.json")) return statFor(data.markerBytes, 102n);
    return {
      dev: 77n,
      ino: 200n,
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false,
    };
  });
  host.read.mockImplementation(
    (fd: number, target: Buffer, offset: number, length: number, position: number) => {
      const bytes = files.get(fd)!;
      const count = bytes.copy(target, offset, position, position + length);
      return count;
    }
  );
});

describe("non-authorizing Windows helper acquisition", () => {
  it("stops at absent selection before catalog or file access", () => {
    host.selection.mockReturnValue({
      state: "unavailable",
      reason: "registry_query_failed",
      authorizesLaunch: false,
    });
    expect(observeWindowsHelperSelectionAcquisition()).toEqual({
      state: "unavailable",
      reason: "selection_unavailable",
      authorizesLaunch: false,
    });
    expect(host.catalog).not.toHaveBeenCalled();
    expect(host.open).not.toHaveBeenCalled();
  });

  it("reads only the fixed generation metadata and feeds the existing evaluator", () => {
    expect(observeWindowsHelperSelectionAcquisition()).toEqual({
      state: "assessed",
      consistency: { state: "consistent", authorizesLaunch: false },
      authorizesLaunch: false,
    });
    expect(host.catalog).toHaveBeenCalledExactlyOnceWith(generation);
    expect(host.open.mock.calls.map((call) => call[0])).toEqual([
      `${installationRoot}\\generation.json`,
      `${installationRoot}\\installed.json`,
    ]);
    expect(host.selection).toHaveBeenCalledTimes(2);
    expect(host.close).toHaveBeenCalledTimes(2);
  });

  it("refuses catalog failure before file reads", () => {
    host.catalog.mockReturnValue({
      state: "unavailable",
      reason: "registry_query_failed",
      authorizesLaunch: false,
    });
    expect(observeWindowsHelperSelectionAcquisition()).toEqual({
      state: "unavailable",
      reason: "catalog_unavailable",
      authorizesLaunch: false,
    });
    expect(host.open).not.toHaveBeenCalled();
  });

  it("refuses a redirected generation ancestor before opening metadata", () => {
    host.realpath.mockImplementation((component: string) =>
      component.endsWith("generations") ? String.raw`D:\redirected\generations` : component
    );
    expect(observeWindowsHelperSelectionAcquisition()).toEqual({
      state: "unavailable",
      reason: "metadata_unavailable",
      authorizesLaunch: false,
    });
    expect(host.open).not.toHaveBeenCalled();
  });

  it("refuses a changed selection after metadata reads", () => {
    host.selection
      .mockReturnValueOnce({
        state: "observed",
        selectionValue: data.selectionValue,
        authorizesLaunch: false,
      })
      .mockReturnValueOnce({
        state: "unavailable",
        reason: "registry_query_failed",
        authorizesLaunch: false,
      });
    expect(observeWindowsHelperSelectionAcquisition()).toEqual({
      state: "unavailable",
      reason: "selection_changed",
      authorizesLaunch: false,
    });
  });

  it("refuses metadata identity mismatch and closes the handle", () => {
    host.fstat.mockImplementationOnce(() => ({
      dev: 77n,
      ino: 999n,
      size: BigInt(data.manifestBytes.length),
      isFile: () => true,
    }));
    expect(observeWindowsHelperSelectionAcquisition()).toEqual({
      state: "unavailable",
      reason: "metadata_unavailable",
      authorizesLaunch: false,
    });
    expect(host.close).toHaveBeenCalledExactlyOnceWith(101);
  });

  it("reports a supplied metadata mismatch without making it launch authority", () => {
    host.catalog.mockReturnValue({
      state: "observed",
      catalog: { ManifestDigest: "c".repeat(64), State: "qualified", ProductCode: productCode },
      systemRoot: String.raw`D:\Windows`,
      authorizesLaunch: false,
    });
    expect(observeWindowsHelperSelectionAcquisition()).toEqual({
      state: "assessed",
      consistency: { state: "inconsistent", reason: "catalog_mismatch", authorizesLaunch: false },
      authorizesLaunch: false,
    });
  });
});
