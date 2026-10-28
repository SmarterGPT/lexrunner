import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { arch, platform } from "node:os";
import path from "node:path";

import { parseWindowsHelperActiveSelectionValue } from "./windows-helper-active-selection.js";

const OS_ROOT_READER = String.raw`\\?\GLOBALROOT\SystemRoot\System32\reg.exe`;
const SELECTION_KEY = String.raw`HKEY_LOCAL_MACHINE\Software\SmarterGPT.LexRunner.WindowsHelper`;
const QUERY_ARGS = [
  "query",
  String.raw`HKLM\Software\SmarterGPT.LexRunner.WindowsHelper`,
  "/v",
  "ActiveSelection",
  "/reg:64",
] as const;
const MAX_OUTPUT_BYTES = 8192;

export type WindowsHelperSelectionReadReason =
  | "unsupported_host"
  | "system_reader_unavailable"
  | "system_reader_identity_mismatch"
  | "registry_query_failed"
  | "registry_output_invalid";

export type WindowsHelperSelectionReadObservation =
  | {
      readonly state: "observed";
      readonly selectionValue: string;
      readonly authorizesLaunch: false;
    }
  | {
      readonly state: "unavailable";
      readonly reason: WindowsHelperSelectionReadReason;
      readonly authorizesLaunch: false;
    };

/**
 * Parse exactly one ASCII REG_SZ value returned by the dedicated 64-bit reg.exe
 * query. This checks transport syntax and the structural selection contract;
 * caller-supplied output is never evidence of protected acquisition.
 */
export function parseWindowsHelperRegQueryOutput(bytes: Uint8Array): string {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_OUTPUT_BYTES ||
    bytes.some((byte) => byte > 0x7f || (byte < 0x20 && byte !== 0x0d && byte !== 0x0a))
  )
    throw new Error("Invalid reg.exe output bytes");
  const output = Buffer.from(bytes).toString("ascii");
  if (output.replace(/\r\n/gu, "").includes("\r"))
    throw new Error("Unexpected reg.exe line ending");
  const lines = output.split(/\r?\n/u).filter((line) => line !== "");
  if (lines.length !== 2 || lines[0]!.toLowerCase() !== SELECTION_KEY.toLowerCase())
    throw new Error("Unexpected reg.exe output structure");
  const match = /^ {4}ActiveSelection {4}REG_SZ {4}(.+)$/u.exec(lines[1]!);
  if (!match) throw new Error("Missing exact ActiveSelection REG_SZ line");
  const value = match[1]!;
  parseWindowsHelperActiveSelectionValue(value);
  return value;
}

function ordinarySystemReaderPath(value: string): boolean {
  if (!/^[A-Za-z]:\\/u.test(value) || path.win32.normalize(value) !== value) return false;
  const directory = path.win32.dirname(value);
  const root = path.win32.dirname(directory);
  return (
    path.win32.basename(value).toLowerCase() === "reg.exe" &&
    path.win32.basename(directory).toLowerCase() === "system32" &&
    root.length > path.win32.parse(value).root.length
  );
}

/**
 * A bounded, read-only observation from one machine-wide registry value.
 *
 * File identity is a preflight only. It does not bind the actual reg.exe child,
 * authenticate the selection, protect the helper image/loader, or permit launch.
 */
export function observeWindowsHelperActiveSelection(): WindowsHelperSelectionReadObservation {
  const stop = (
    reason: WindowsHelperSelectionReadReason
  ): WindowsHelperSelectionReadObservation => ({
    state: "unavailable",
    reason,
    authorizesLaunch: false,
  });
  if (platform() !== "win32" || arch() !== "x64") return stop("unsupported_host");

  let executable: string;
  let systemDirectory: string;
  let systemRoot: string;
  try {
    executable = realpathSync.native(OS_ROOT_READER);
    if (!ordinarySystemReaderPath(executable)) return stop("system_reader_unavailable");
    systemDirectory = path.win32.dirname(executable);
    systemRoot = path.win32.dirname(systemDirectory);
    const objectRoot = statSync(OS_ROOT_READER, { bigint: true });
    const dos = statSync(executable, { bigint: true });
    if (
      !objectRoot.isFile() ||
      !dos.isFile() ||
      objectRoot.dev !== dos.dev ||
      objectRoot.ino === 0n ||
      objectRoot.ino !== dos.ino ||
      objectRoot.size !== dos.size ||
      realpathSync.native(executable).toLowerCase() !== executable.toLowerCase()
    )
      return stop("system_reader_identity_mismatch");
  } catch {
    return stop("system_reader_unavailable");
  }

  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(executable, [...QUERY_ARGS], {
      cwd: systemDirectory,
      env: { SystemRoot: systemRoot, WINDIR: systemRoot },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "buffer",
      timeout: 5000,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
  } catch {
    return stop("registry_query_failed");
  }
  if (
    result.error ||
    result.status !== 0 ||
    result.signal !== null ||
    !Buffer.isBuffer(result.stdout) ||
    !Buffer.isBuffer(result.stderr) ||
    result.stderr.byteLength !== 0
  )
    return stop("registry_query_failed");
  try {
    return {
      state: "observed",
      selectionValue: parseWindowsHelperRegQueryOutput(result.stdout),
      authorizesLaunch: false,
    };
  } catch {
    return stop("registry_output_invalid");
  }
}
