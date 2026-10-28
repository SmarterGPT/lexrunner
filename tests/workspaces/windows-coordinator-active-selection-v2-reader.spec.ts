import { beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  arch: vi.fn(),
  platform: vi.fn(),
  realpath: vi.fn(),
  stat: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawnSync: host.spawn }));
vi.mock("node:fs", () => ({ realpathSync: { native: host.realpath }, statSync: host.stat }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  arch: host.arch,
  platform: host.platform,
}));

import {
  observeWindowsCoordinatorV2ActiveSelection,
  observeWindowsCoordinatorV2GenerationCatalog,
  parseWindowsCoordinatorV2CatalogRegQueryOutput,
  parseWindowsCoordinatorV2RegQueryOutput,
} from "../../src/workspaces/windows-coordinator-active-selection-reader.js";

const osRoot = String.raw`\\?\GLOBALROOT\SystemRoot\System32\reg.exe`;
const dosPath = String.raw`D:\Windows\System32\reg.exe`;
const graphDigest = "a".repeat(64);
const manifestDigest = "b".repeat(64);
const serviceDigest = "c".repeat(64);
const selectionValue = JSON.stringify({
  coordinatorProtocolVersion: "1.0.0",
  generationId: graphDigest,
  graphDigest,
  manifestSha256: manifestDigest,
  profile: "windows-coordinator-service-msi/2",
  revision: 2,
  schemaVersion: "windows-coordinator-active-selection/2",
  serviceImageSha256: serviceDigest,
  serviceName: "LexRunnerCoordinator",
});
const selectionOutput =
  "\r\nHKEY_LOCAL_MACHINE\\Software\\SmarterGPT.LexRunner.WindowsCoordinator\r\n" +
  `    ActiveSelection    REG_SZ    ${selectionValue}\r\n`;
const catalogOutput =
  "\r\nHKEY_LOCAL_MACHINE\\Software\\SmarterGPT.LexRunner.WindowsCoordinator\\Generations\\" +
  `${graphDigest}\r\n` +
  `    GraphDigest    REG_SZ    ${graphDigest}\r\n` +
  `    ManifestDigest    REG_SZ    ${manifestDigest}\r\n` +
  `    ServiceImageDigest    REG_SZ    ${serviceDigest}\r\n` +
  "    State    REG_SZ    qualified\r\n" +
  "    ServiceName    REG_SZ    LexRunnerCoordinator\r\n";

function stat(ino = 123n) {
  return { dev: 77n, ino, size: 110_592n, isFile: () => true };
}

function queryOutput(stdout: string, status = 0) {
  return {
    status,
    signal: null,
    error: undefined,
    stdout: Buffer.from(stdout, "ascii"),
    stderr: Buffer.alloc(0),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  host.platform.mockReturnValue("win32");
  host.arch.mockReturnValue("x64");
  host.realpath.mockReturnValue(dosPath);
  host.stat.mockReturnValue(stat());
  host.spawn.mockReturnValue(queryOutput(selectionOutput));
});

describe("fixed Windows coordinator v2 HKLM observer", () => {
  it("reads only the distinct 64-bit selection value with a fixed system reader", () => {
    expect(parseWindowsCoordinatorV2RegQueryOutput(Buffer.from(selectionOutput, "ascii"))).toBe(
      selectionValue
    );
    expect(observeWindowsCoordinatorV2ActiveSelection()).toEqual({
      state: "observed",
      selectionValue,
      authorizesLaunch: false,
    });
    expect(host.realpath.mock.calls).toEqual([[osRoot], [dosPath]]);
    expect(host.spawn.mock.calls[0]![1]).toEqual([
      "query",
      String.raw`HKLM\Software\SmarterGPT.LexRunner.WindowsCoordinator`,
      "/v",
      "ActiveSelection",
      "/reg:64",
    ]);
    expect(host.spawn.mock.calls[0]![2]).toMatchObject({
      cwd: String.raw`D:\Windows\System32`,
      env: { SystemRoot: String.raw`D:\Windows`, WINDIR: String.raw`D:\Windows` },
      shell: false,
      timeout: 5000,
      maxBuffer: 8192,
    });
  });

  it("rejects v1, duplicate rows, extra rows and malformed registry transport", () => {
    for (const invalid of [
      selectionOutput.replace("active-selection/2", "active-selection/1"),
      selectionOutput.replace("REG_SZ", "REG_EXPAND_SZ"),
      selectionOutput + `    ActiveSelection    REG_SZ    ${selectionValue}\r\n`,
      selectionOutput.replace('"revision":2,', '"revision":2,"revision":3,'),
      selectionOutput.replace("REG_SZ    {", "REG_SZ    {é"),
      selectionOutput.replace("\r\n", "\r"),
    ])
      expect(() => parseWindowsCoordinatorV2RegQueryOutput(Buffer.from(invalid, "utf8"))).toThrow();
    host.spawn.mockReturnValueOnce(
      queryOutput(selectionOutput.replace("active-selection/2", "active-selection/1"))
    );
    expect(observeWindowsCoordinatorV2ActiveSelection()).toEqual({
      state: "unavailable",
      reason: "registry_output_invalid",
      authorizesLaunch: false,
    });
  });

  it("requires the five exact catalog rows under the selected graph ID", () => {
    expect(
      parseWindowsCoordinatorV2CatalogRegQueryOutput(
        Buffer.from(catalogOutput, "ascii"),
        graphDigest
      )
    ).toEqual({
      GraphDigest: graphDigest,
      ManifestDigest: manifestDigest,
      ServiceImageDigest: serviceDigest,
      State: "qualified",
      ServiceName: "LexRunnerCoordinator",
    });
    for (const invalid of [
      catalogOutput.replace("WindowsCoordinator", "WindowsHelper"),
      catalogOutput.replace("GraphDigest    REG_SZ", "GraphDigest    REG_DWORD"),
      catalogOutput + `    State    REG_SZ    qualified\r\n`,
      catalogOutput + "    Extra    REG_SZ    yes\r\n",
      catalogOutput.replace(`    GraphDigest    REG_SZ    ${graphDigest}\r\n`, ""),
    ])
      expect(() =>
        parseWindowsCoordinatorV2CatalogRegQueryOutput(Buffer.from(invalid, "ascii"), graphDigest)
      ).toThrow();
    host.spawn.mockReturnValue(queryOutput(catalogOutput));
    expect(observeWindowsCoordinatorV2GenerationCatalog(graphDigest)).toMatchObject({
      state: "observed",
      authorizesLaunch: false,
      systemRoot: String.raw`D:\Windows`,
    });
    expect(host.spawn.mock.calls[0]![1]).toEqual([
      "query",
      String.raw`HKLM\Software\SmarterGPT.LexRunner.WindowsCoordinator\Generations` +
        `\\${graphDigest}`,
      "/reg:64",
    ]);
    expect(observeWindowsCoordinatorV2GenerationCatalog("../other")).toMatchObject({
      state: "unavailable",
      reason: "generation_id_invalid",
      authorizesLaunch: false,
    });
  });
});
