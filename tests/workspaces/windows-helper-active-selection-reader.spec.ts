import { beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  arch: vi.fn(),
  platform: vi.fn(),
  realpath: vi.fn(),
  stat: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawnSync: host.spawn }));
vi.mock("node:fs", () => ({
  realpathSync: { native: host.realpath },
  statSync: host.stat,
}));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  arch: host.arch,
  platform: host.platform,
}));

import {
  observeWindowsHelperActiveSelection,
  parseWindowsHelperRegQueryOutput,
} from "../../src/workspaces/windows-helper-active-selection-reader.js";

const osRoot = String.raw`\\?\GLOBALROOT\SystemRoot\System32\reg.exe`;
const dosPath = String.raw`D:\Windows\System32\reg.exe`;
const selectionValue =
  `{"generationId":"${"a".repeat(64)}","manifestSha256":"${"b".repeat(64)}",` +
  '"profile":"windows-helper-msi-direct/1","protocolVersion":"2.0.0",' +
  '"publisherPolicyId":"lexrunner-azure-helper-publisher/1","removalVersion":"1.0.0",' +
  '"revision":1,"schemaVersion":"windows-helper-active-selection/1",' +
  `"source":{"repository":"SmarterGPT/lexrunner","revision":"${"c".repeat(40)}",` +
  '"signingRunId":40291115593}}';
const output =
  "\r\nHKEY_LOCAL_MACHINE\\Software\\SmarterGPT.LexRunner.WindowsHelper\r\n" +
  `    ActiveSelection    REG_SZ    ${selectionValue}\r\n`;

function stat(ino: bigint = 123n) {
  return { dev: 77n, ino, size: 110_592n, isFile: () => true };
}

beforeEach(() => {
  vi.resetAllMocks();
  host.platform.mockReturnValue("win32");
  host.arch.mockReturnValue("x64");
  host.realpath.mockReturnValue(dosPath);
  host.stat.mockReturnValue(stat());
  host.spawn.mockReturnValue({
    status: 0,
    signal: null,
    error: undefined,
    stdout: Buffer.from(output, "ascii"),
    stderr: Buffer.alloc(0),
  });
});

describe("fixed Windows ActiveSelection reader", () => {
  it("parses exactly one canonical ASCII REG_SZ line", () => {
    expect(parseWindowsHelperRegQueryOutput(Buffer.from(output, "ascii"))).toBe(selectionValue);
  });

  it("refuses ambiguous, non-ASCII, wrong-type and malformed output", () => {
    const invalid = [
      output.replace("REG_SZ", "REG_EXPAND_SZ"),
      output.replace("ActiveSelection", "OtherValue"),
      output.replace(
        "HKEY_LOCAL_MACHINE\\Software\\SmarterGPT.LexRunner.WindowsHelper",
        "HKEY_CURRENT_USER\\Software\\SmarterGPT.LexRunner.WindowsHelper"
      ),
      output + `    ActiveSelection    REG_SZ    ${selectionValue}\r\n`,
      output.replace('"revision":1,', '"revision":1,"revision":2,'),
      output.replace('"revision":1,', '"revision":0,'),
      output.replace("REG_SZ    {", "REG_SZ    {é"),
      output.replace("    ActiveSelection", "\tActiveSelection"),
      output.replace("\r\n", "\r"),
      "x".repeat(8193),
    ];
    for (const value of invalid)
      expect(() => parseWindowsHelperRegQueryOutput(Buffer.from(value, "utf8"))).toThrow();
  });

  it("uses only the OS-root-derived drive path and fixed bounded query", () => {
    expect(observeWindowsHelperActiveSelection()).toEqual({
      state: "observed",
      selectionValue,
      authorizesLaunch: false,
    });
    expect(host.realpath.mock.calls).toEqual([[osRoot], [dosPath]]);
    expect(host.stat.mock.calls).toEqual([
      [osRoot, { bigint: true }],
      [dosPath, { bigint: true }],
    ]);
    expect(host.spawn).toHaveBeenCalledExactlyOnceWith(
      dosPath,
      [
        "query",
        String.raw`HKLM\Software\SmarterGPT.LexRunner.WindowsHelper`,
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

  it("refuses an unsupported host and an unqualified OS-root path before execution", () => {
    host.platform.mockReturnValue("linux");
    expect(observeWindowsHelperActiveSelection()).toEqual({
      state: "unavailable",
      reason: "unsupported_host",
      authorizesLaunch: false,
    });
    expect(host.realpath).not.toHaveBeenCalled();
    host.platform.mockReturnValue("win32");
    host.realpath.mockReturnValue(String.raw`\\server\share\System32\reg.exe`);
    expect(observeWindowsHelperActiveSelection()).toMatchObject({
      state: "unavailable",
      reason: "system_reader_unavailable",
      authorizesLaunch: false,
    });
    expect(host.spawn).not.toHaveBeenCalled();
  });

  it("refuses a changed DOS mapping before execution", () => {
    host.stat.mockReturnValueOnce(stat(123n)).mockReturnValueOnce(stat(456n));
    expect(observeWindowsHelperActiveSelection()).toMatchObject({
      state: "unavailable",
      reason: "system_reader_identity_mismatch",
      authorizesLaunch: false,
    });
    expect(host.spawn).not.toHaveBeenCalled();
  });

  it("refuses an unreadable OS root before querying the registry", () => {
    host.realpath.mockImplementationOnce(() => {
      throw new Error("unavailable");
    });
    expect(observeWindowsHelperActiveSelection()).toMatchObject({
      state: "unavailable",
      reason: "system_reader_unavailable",
      authorizesLaunch: false,
    });
    expect(host.spawn).not.toHaveBeenCalled();
  });

  it("refuses query failure and malformed success output", () => {
    host.spawn.mockReturnValueOnce({
      status: 1,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("missing"),
    });
    expect(observeWindowsHelperActiveSelection()).toMatchObject({
      state: "unavailable",
      reason: "registry_query_failed",
      authorizesLaunch: false,
    });
    host.spawn.mockReturnValueOnce({
      status: 0,
      signal: null,
      stdout: Buffer.from(output.replace("REG_SZ", "REG_BINARY")),
      stderr: Buffer.alloc(0),
    });
    expect(observeWindowsHelperActiveSelection()).toMatchObject({
      state: "unavailable",
      reason: "registry_output_invalid",
      authorizesLaunch: false,
    });
    host.spawn.mockReturnValueOnce({
      status: 0,
      signal: null,
      error: new Error("timed out"),
      stdout: Buffer.from(output),
      stderr: Buffer.alloc(0),
    });
    expect(observeWindowsHelperActiveSelection()).toMatchObject({
      state: "unavailable",
      reason: "registry_query_failed",
      authorizesLaunch: false,
    });
    host.spawn.mockReturnValueOnce({
      status: 0,
      signal: null,
      stdout: Buffer.from(output),
      stderr: Buffer.from("unexpected stderr"),
    });
    expect(observeWindowsHelperActiveSelection()).toMatchObject({
      state: "unavailable",
      reason: "registry_query_failed",
      authorizesLaunch: false,
    });
  });
});
