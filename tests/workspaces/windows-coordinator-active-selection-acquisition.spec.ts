import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  selection: vi.fn(),
  catalog: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  lstat: vi.fn(),
  fstat: vi.fn(),
  read: vi.fn(),
  realpath: vi.fn(),
}));

vi.mock("../../src/workspaces/windows-coordinator-active-selection-reader.js", () => ({
  observeWindowsCoordinatorActiveSelection: host.selection,
  observeWindowsCoordinatorGenerationCatalog: host.catalog,
}));
vi.mock("node:fs", () => ({
  openSync: host.open,
  closeSync: host.close,
  lstatSync: host.lstat,
  fstatSync: host.fstat,
  readSync: host.read,
  realpathSync: { native: host.realpath },
}));

import { observeWindowsCoordinatorSelectionAcquisition } from "../../src/workspaces/windows-coordinator-active-selection-acquisition.js";

const imageDigest = "a".repeat(64);
const manifest = Buffer.from(
  JSON.stringify({
    schemaVersion: "lexrunner-windows-coordinator-generation/1",
    profile: "windows-coordinator-service-msi/1",
    generationId: imageDigest,
    serviceName: "LexRunnerCoordinator",
    serviceImageSha256: imageDigest,
    serviceVersion: "2.5.0",
    state: "provisioned-unqualified",
    productionReady: false,
  })
);
const manifestDigest = createHash("sha256").update(manifest).digest("hex");
const selectionValue =
  `{"generationId":"${imageDigest}","manifestSha256":"${manifestDigest}",` +
  '"profile":"windows-coordinator-service-msi/1","protocolVersion":"1.0.0",' +
  '"revision":1,"schemaVersion":"windows-coordinator-active-selection/1",' +
  `"serviceImageSha256":"${imageDigest}","serviceName":"LexRunnerCoordinator",` +
  '"serviceVersion":"2.5.0"}';
const filePath =
  String.raw`D:\Program Files\SmarterGPT.LexRunner.WindowsCoordinator\generations` +
  `\\${imageDigest}\\generation.json`;

function directoryStat() {
  return { dev: 1n, ino: 2n, isDirectory: () => true, isSymbolicLink: () => false };
}
function fileStat() {
  return {
    dev: 1n,
    ino: 3n,
    size: BigInt(manifest.length),
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  host.selection.mockReturnValue({ state: "observed", selectionValue, authorizesLaunch: false });
  host.catalog.mockReturnValue({
    state: "observed",
    catalog: {
      ManifestDigest: manifestDigest,
      ImageDigest: imageDigest,
      State: "provisioned-unqualified",
      ServiceName: "LexRunnerCoordinator",
    },
    systemRoot: String.raw`D:\Windows`,
    authorizesLaunch: false,
  });
  host.open.mockReturnValue(10);
  host.lstat.mockImplementation((file: string) =>
    file.endsWith("generation.json") ? fileStat() : directoryStat()
  );
  host.fstat.mockReturnValue(fileStat());
  host.realpath.mockImplementation((file: string) => file);
  host.read.mockImplementation(
    (_handle: number, buffer: Buffer, offset: number, length: number) => {
      manifest.copy(buffer, offset, offset, offset + length);
      return length;
    }
  );
});

describe("Windows coordinator selection acquisition remains non-authorizing", () => {
  it("reads only the fixed digest generation and reports the current MSI unqualified", () => {
    expect(observeWindowsCoordinatorSelectionAcquisition()).toEqual({
      state: "assessed",
      consistency: {
        state: "inconsistent",
        reason: "generation_unqualified",
        authorizesLaunch: false,
      },
      authorizesLaunch: false,
    });
    expect(host.catalog).toHaveBeenCalledExactlyOnceWith(imageDigest);
    expect(host.open).toHaveBeenCalledExactlyOnceWith(filePath, "r");
    expect(host.close).toHaveBeenCalledExactlyOnceWith(10);
    expect(host.selection).toHaveBeenCalledTimes(2);
  });

  it("rejects absent selection before catalog or filesystem access", () => {
    host.selection.mockReturnValueOnce({
      state: "unavailable",
      reason: "registry_query_failed",
      authorizesLaunch: false,
    });
    expect(observeWindowsCoordinatorSelectionAcquisition()).toEqual({
      state: "unavailable",
      reason: "selection_unavailable",
      authorizesLaunch: false,
    });
    expect(host.catalog).not.toHaveBeenCalled();
    expect(host.open).not.toHaveBeenCalled();
  });

  it("rejects a selection changed between metadata reads", () => {
    host.selection
      .mockReturnValueOnce({ state: "observed", selectionValue, authorizesLaunch: false })
      .mockReturnValueOnce({
        state: "observed",
        selectionValue: selectionValue.replace('"revision":1', '"revision":2'),
        authorizesLaunch: false,
      });
    expect(observeWindowsCoordinatorSelectionAcquisition()).toEqual({
      state: "unavailable",
      reason: "selection_changed",
      authorizesLaunch: false,
    });
  });

  it("rejects missing catalog or redirected generation path", () => {
    host.catalog.mockReturnValueOnce({
      state: "unavailable",
      reason: "registry_query_failed",
      authorizesLaunch: false,
    });
    expect(observeWindowsCoordinatorSelectionAcquisition()).toEqual({
      state: "unavailable",
      reason: "catalog_unavailable",
      authorizesLaunch: false,
    });
    host.realpath.mockImplementationOnce(() => String.raw`E:\redirected`);
    expect(observeWindowsCoordinatorSelectionAcquisition()).toEqual({
      state: "unavailable",
      reason: "metadata_unavailable",
      authorizesLaunch: false,
    });
    expect(host.open).not.toHaveBeenCalled();
  });
});
