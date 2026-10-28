import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  selection: vi.fn(),
  highWater: vi.fn(),
  catalog: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  lstat: vi.fn(),
  fstat: vi.fn(),
  read: vi.fn(),
  realpath: vi.fn(),
}));

vi.mock("../../src/workspaces/windows-coordinator-active-selection-reader.js", () => ({
  observeWindowsCoordinatorV2ActiveSelection: host.selection,
  observeWindowsCoordinatorV2HighWater: host.highWater,
  observeWindowsCoordinatorV2GenerationCatalog: host.catalog,
}));
vi.mock("node:fs", () => ({
  openSync: host.open,
  closeSync: host.close,
  lstatSync: host.lstat,
  fstatSync: host.fstat,
  readSync: host.read,
  realpathSync: { native: host.realpath },
}));

import { observeWindowsCoordinatorV2SelectionAcquisition } from "../../src/workspaces/windows-coordinator-active-selection-v2-acquisition.js";
import { createWindowsCoordinatorGenerationGraph } from "../../src/workspaces/windows-coordinator-generation-graph.js";
import { WINDOWS_BOUNDARY_PROTOCOL_VERSION } from "../../src/workspaces/windows-boundary-protocol.js";
import { WINDOWS_REMOVAL_VERSION } from "../../src/workspaces/windows-removal-protocol.js";

const roles = [
  ["bin/helper.exe", "helper-image"],
  ["client/client.exe", "client-image"],
  ["git/cmd/git.exe", "git-entry"],
  ["node/better_sqlite3.node", "sqlite-addon"],
  ["node/node.exe", "node-image"],
  ["node/worker.mjs", "admission-entry"],
  ["service/coordinator.exe", "service-image"],
] as const;

function canonical(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
  );
}

function fixture() {
  const files = roles.map(([path, role]) => {
    const bytes = Buffer.from(path);
    return {
      path,
      role,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
  });
  const graph = createWindowsCoordinatorGenerationGraph({
    schemaVersion: "lexrunner-windows-coordinator-generation-graph/2",
    profile: "windows-coordinator-service-msi/2",
    architecture: "win-x64",
    serviceName: "LexRunnerCoordinator",
    coordinatorProtocolVersion: "1.0.0",
    boundaryProtocolVersion: WINDOWS_BOUNDARY_PROTOCOL_VERSION,
    removalProtocolVersion: WINDOWS_REMOVAL_VERSION,
    files,
  });
  const selection = {
    schemaVersion: "windows-coordinator-active-selection/2",
    profile: "windows-coordinator-service-msi/2",
    generationId: graph.graphDigest,
    graphDigest: graph.graphDigest,
    manifestSha256: graph.manifestSha256,
    serviceImageSha256: files.find((file) => file.role === "service-image")!.sha256,
    serviceName: "LexRunnerCoordinator",
    coordinatorProtocolVersion: "1.0.0",
    revision: 2,
  };
  return {
    selectionValue: canonical(selection),
    graph,
    catalog: {
      GraphDigest: graph.graphDigest,
      ManifestDigest: graph.manifestSha256,
      ServiceImageDigest: selection.serviceImageSha256,
      State: "qualified" as const,
      ServiceName: "LexRunnerCoordinator" as const,
    },
    filePath:
      String.raw`D:\Program Files\SmarterGPT.LexRunner.WindowsCoordinator\generations` +
      `\\${graph.graphDigest}\\generation-graph.json`,
  };
}

const input = fixture();

function directoryStat() {
  return { dev: 1n, ino: 2n, isDirectory: () => true, isSymbolicLink: () => false };
}

function fileStat(ino = 3n) {
  return {
    dev: 1n,
    ino,
    size: BigInt(input.graph.manifestBytes.length),
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  host.selection.mockReturnValue({
    state: "observed",
    selectionValue: input.selectionValue,
    authorizesLaunch: false,
  });
  host.highWater.mockReturnValue({ state: "observed", revision: 2, authorizesLaunch: false });
  host.catalog.mockReturnValue({
    state: "observed",
    catalog: input.catalog,
    systemRoot: String.raw`D:\Windows`,
    authorizesLaunch: false,
  });
  host.open.mockReturnValue(10);
  host.lstat.mockImplementation((file: string) =>
    file.endsWith("generation-graph.json") ? fileStat() : directoryStat()
  );
  host.fstat.mockReturnValue(fileStat());
  host.realpath.mockImplementation((file: string) => file);
  host.read.mockImplementation(
    (_handle: number, buffer: Buffer, offset: number, length: number) => {
      Buffer.from(input.graph.manifestBytes).copy(buffer, offset, offset, offset + length);
      return length;
    }
  );
});

describe("v2 coordinator selection acquisition remains non-authorizing", () => {
  it("reads only the graph-named generation with held-file and selection/catalog re-read", () => {
    expect(observeWindowsCoordinatorV2SelectionAcquisition()).toEqual({
      state: "assessed",
      consistency: { state: "consistent", authorizesLaunch: false },
      authorizesLaunch: false,
    });
    expect(host.catalog).toHaveBeenCalledTimes(2);
    expect(host.catalog).toHaveBeenNthCalledWith(1, input.graph.graphDigest);
    expect(host.selection).toHaveBeenCalledTimes(2);
    expect(host.highWater).toHaveBeenCalledTimes(2);
    expect(host.open).toHaveBeenCalledExactlyOnceWith(input.filePath, "r");
    expect(host.close).toHaveBeenCalledExactlyOnceWith(10);
  });

  it("rejects absent or malformed selection before catalog and filesystem reads", () => {
    host.selection.mockReturnValueOnce({ state: "unavailable", reason: "registry_query_failed" });
    expect(observeWindowsCoordinatorV2SelectionAcquisition()).toMatchObject({
      state: "unavailable",
      reason: "selection_unavailable",
      authorizesLaunch: false,
    });
    expect(host.catalog).not.toHaveBeenCalled();
    expect(host.open).not.toHaveBeenCalled();
    host.selection.mockReturnValueOnce({ state: "observed", selectionValue: "{}" });
    expect(observeWindowsCoordinatorV2SelectionAcquisition()).toMatchObject({
      reason: "selection_invalid",
      authorizesLaunch: false,
    });
  });

  it("requires a present, matching high-water revision before reading the generation", () => {
    host.highWater.mockReturnValueOnce({
      state: "unavailable",
      reason: "registry_query_failed",
      authorizesLaunch: false,
    });
    expect(observeWindowsCoordinatorV2SelectionAcquisition()).toEqual({
      state: "unavailable",
      reason: "high_water_unavailable",
      authorizesLaunch: false,
    });
    expect(host.catalog).not.toHaveBeenCalled();
    expect(host.open).not.toHaveBeenCalled();

    host.highWater.mockReturnValueOnce({ state: "observed", revision: 3 });
    expect(observeWindowsCoordinatorV2SelectionAcquisition()).toMatchObject({
      state: "unavailable",
      reason: "high_water_mismatch",
      authorizesLaunch: false,
    });
    expect(host.catalog).not.toHaveBeenCalled();
    expect(host.open).not.toHaveBeenCalled();
  });

  it("rejects a high-water change or failed re-read after metadata acquisition", () => {
    host.highWater
      .mockReturnValueOnce({ state: "observed", revision: 2 })
      .mockReturnValueOnce({ state: "observed", revision: 3 });
    expect(observeWindowsCoordinatorV2SelectionAcquisition()).toMatchObject({
      state: "unavailable",
      reason: "high_water_changed",
      authorizesLaunch: false,
    });
    expect(host.close).toHaveBeenCalledExactlyOnceWith(10);

    host.highWater
      .mockReturnValueOnce({ state: "observed", revision: 2 })
      .mockReturnValueOnce({ state: "unavailable", reason: "registry_output_invalid" });
    expect(observeWindowsCoordinatorV2SelectionAcquisition()).toMatchObject({
      state: "unavailable",
      reason: "high_water_changed",
      authorizesLaunch: false,
    });
  });

  it("rejects catalog or selection changes during the manifest read", () => {
    host.catalog
      .mockReturnValueOnce({
        state: "observed",
        catalog: input.catalog,
        systemRoot: String.raw`D:\Windows`,
      })
      .mockReturnValueOnce({
        state: "observed",
        catalog: { ...input.catalog, State: "provisioned-unqualified" },
        systemRoot: String.raw`D:\Windows`,
      });
    expect(observeWindowsCoordinatorV2SelectionAcquisition()).toMatchObject({
      reason: "catalog_changed",
      authorizesLaunch: false,
    });
    host.catalog.mockReturnValue({
      state: "observed",
      catalog: input.catalog,
      systemRoot: String.raw`D:\Windows`,
    });
    host.selection
      .mockReturnValueOnce({ state: "observed", selectionValue: input.selectionValue })
      .mockReturnValueOnce({
        state: "observed",
        selectionValue: input.selectionValue.replace('"revision":2', '"revision":1'),
      });
    expect(observeWindowsCoordinatorV2SelectionAcquisition()).toMatchObject({
      reason: "selection_changed",
      authorizesLaunch: false,
    });
  });

  it("rejects redirected generation ancestry and changed held-file identity", () => {
    host.realpath.mockReturnValueOnce(String.raw`E:\redirected`);
    expect(observeWindowsCoordinatorV2SelectionAcquisition()).toMatchObject({
      reason: "metadata_unavailable",
      authorizesLaunch: false,
    });
    expect(host.open).not.toHaveBeenCalled();
    host.realpath.mockImplementation((file: string) => file);
    host.fstat.mockReturnValueOnce(fileStat()).mockReturnValueOnce(fileStat(4n));
    expect(observeWindowsCoordinatorV2SelectionAcquisition()).toMatchObject({
      reason: "metadata_unavailable",
      authorizesLaunch: false,
    });
    expect(host.close).toHaveBeenCalledExactlyOnceWith(10);
  });
});
