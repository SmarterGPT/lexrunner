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
  observeWindowsCoordinatorActiveSelection,
  observeWindowsCoordinatorGenerationCatalog,
  parseWindowsCoordinatorCatalogRegQueryOutput,
  parseWindowsCoordinatorRegQueryOutput,
} from "../../src/workspaces/windows-coordinator-active-selection-reader.js";

const osRoot = String.raw`\\?\GLOBALROOT\SystemRoot\System32\reg.exe`;
const dosPath = String.raw`D:\Windows\System32\reg.exe`;
const imageDigest = "a".repeat(64);
const manifestDigest = "b".repeat(64);
const selectionValue =
  `{"generationId":"${imageDigest}","manifestSha256":"${manifestDigest}",` +
  '"profile":"windows-coordinator-service-msi/1","protocolVersion":"1.0.0",' +
  '"revision":1,"schemaVersion":"windows-coordinator-active-selection/1",' +
  `"serviceImageSha256":"${imageDigest}","serviceName":"LexRunnerCoordinator",` +
  '"serviceVersion":"2.5.0"}';
const selectionOutput =
  "\r\nHKEY_LOCAL_MACHINE\\Software\\SmarterGPT.LexRunner.WindowsCoordinator\r\n" +
  `    ActiveSelection    REG_SZ    ${selectionValue}\r\n`;
const catalogOutput =
  "\r\nHKEY_LOCAL_MACHINE\\Software\\SmarterGPT.LexRunner.WindowsCoordinator\\Generations\\" +
  `${imageDigest}\r\n` +
  `    ManifestDigest    REG_SZ    ${manifestDigest}\r\n` +
  `    ImageDigest    REG_SZ    ${imageDigest}\r\n` +
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

describe("fixed Windows coordinator registry observer", () => {
  it("accepts one canonical selection from the distinct 64-bit HKLM key", () => {
    expect(parseWindowsCoordinatorRegQueryOutput(Buffer.from(selectionOutput, "ascii"))).toBe(
      selectionValue
    );
    expect(observeWindowsCoordinatorActiveSelection()).toEqual({
      state: "observed",
      selectionValue,
      authorizesLaunch: false,
    });
    expect(host.realpath.mock.calls).toEqual([[osRoot], [dosPath]]);
    expect(host.spawn).toHaveBeenCalledExactlyOnceWith(
      dosPath,
      [
        "query",
        String.raw`HKLM\Software\SmarterGPT.LexRunner.WindowsCoordinator`,
        "/v",
        "ActiveSelection",
        "/reg:64",
      ],
      {
        cwd: String.raw`D:\Windows\System32`,
        env: { SystemRoot: String.raw`D:\Windows`, WINDIR: String.raw`D:\Windows` },
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "buffer",
        timeout: 5000,
        maxBuffer: 8192,
      }
    );
  });

  it("rejects old keys, duplicate lines, non-ASCII, wrong type and changed selection", () => {
    for (const invalid of [
      selectionOutput.replace("WindowsCoordinator", "WindowsHelper"),
      selectionOutput.replace("REG_SZ", "REG_EXPAND_SZ"),
      selectionOutput + `    ActiveSelection    REG_SZ    ${selectionValue}\r\n`,
      selectionOutput.replace('"revision":1,', '"revision":1,"revision":2,'),
      selectionOutput.replace("REG_SZ    {", "REG_SZ    {é"),
      selectionOutput.replace("\r\n", "\r"),
      "x".repeat(8193),
    ])
      expect(() => parseWindowsCoordinatorRegQueryOutput(Buffer.from(invalid, "utf8"))).toThrow();
  });

  it("accepts only four exact service catalog rows under the selected generation", () => {
    expect(
      parseWindowsCoordinatorCatalogRegQueryOutput(Buffer.from(catalogOutput, "ascii"), imageDigest)
    ).toEqual({
      ManifestDigest: manifestDigest,
      ImageDigest: imageDigest,
      State: "qualified",
      ServiceName: "LexRunnerCoordinator",
    });
    for (const invalid of [
      catalogOutput.replace("WindowsCoordinator", "WindowsHelper"),
      catalogOutput.replace("LexRunnerCoordinator\r\n", "OtherService\r\n"),
      catalogOutput.replace("ImageDigest    REG_SZ", "ImageDigest    REG_DWORD"),
      catalogOutput + `    State    REG_SZ    qualified\r\n`,
      catalogOutput + `    Extra    REG_SZ    yes\r\n`,
    ])
      expect(() =>
        parseWindowsCoordinatorCatalogRegQueryOutput(Buffer.from(invalid, "ascii"), imageDigest)
      ).toThrow();
    expect(observeWindowsCoordinatorGenerationCatalog("../other")).toEqual({
      state: "unavailable",
      reason: "generation_id_invalid",
      authorizesLaunch: false,
    });
  });

  it("fails closed for absent key, unsupported host and reader identity mismatch", () => {
    host.spawn.mockReturnValueOnce(queryOutput("", 1));
    expect(observeWindowsCoordinatorActiveSelection()).toEqual({
      state: "unavailable",
      reason: "registry_query_failed",
      authorizesLaunch: false,
    });
    host.platform.mockReturnValue("linux");
    expect(observeWindowsCoordinatorActiveSelection()).toMatchObject({
      state: "unavailable",
      reason: "unsupported_host",
      authorizesLaunch: false,
    });
    host.platform.mockReturnValue("win32");
    host.stat.mockReturnValueOnce(stat(123n)).mockReturnValueOnce(stat(456n));
    expect(observeWindowsCoordinatorActiveSelection()).toMatchObject({
      state: "unavailable",
      reason: "system_reader_identity_mismatch",
      authorizesLaunch: false,
    });
    expect(host.spawn).toHaveBeenCalledTimes(1);
  });

  it("observes the catalog using only a validated generation digest", () => {
    host.spawn.mockReturnValue(queryOutput(catalogOutput));
    expect(observeWindowsCoordinatorGenerationCatalog(imageDigest)).toMatchObject({
      state: "observed",
      authorizesLaunch: false,
      systemRoot: String.raw`D:\Windows`,
    });
    expect(host.spawn.mock.calls[0]![1]).toEqual([
      "query",
      String.raw`HKLM\Software\SmarterGPT.LexRunner.WindowsCoordinator\Generations` +
        `\\${imageDigest}`,
      "/reg:64",
    ]);
  });
});
