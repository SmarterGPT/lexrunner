import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { arch, platform } from "node:os";
import path from "node:path";

import { parseWindowsCoordinatorActiveSelectionValue } from "./windows-coordinator-active-selection.js";
import {
  parseWindowsCoordinatorActiveSelectionV2Value,
  WindowsCoordinatorGenerationCatalogV2,
  type WindowsCoordinatorGenerationCatalogV2 as WindowsCoordinatorGenerationCatalogV2Type,
} from "./windows-coordinator-active-selection-v2.js";

const OS_ROOT_READER = String.raw`\\?\GLOBALROOT\SystemRoot\System32\reg.exe`;
const SELECTION_KEY = String.raw`HKEY_LOCAL_MACHINE\Software\SmarterGPT.LexRunner.WindowsCoordinator`;
const GENERATIONS_KEY = `${SELECTION_KEY}\\Generations`;
const QUERY_KEY = String.raw`HKLM\Software\SmarterGPT.LexRunner.WindowsCoordinator`;
const MAX_OUTPUT_BYTES = 8192;

export type WindowsCoordinatorRegistryReadReason =
  | "unsupported_host"
  | "system_reader_unavailable"
  | "system_reader_identity_mismatch"
  | "registry_query_failed"
  | "registry_output_invalid"
  | "generation_id_invalid";

export type WindowsCoordinatorSelectionObservation =
  | {
      readonly state: "observed";
      readonly selectionValue: string;
      readonly authorizesLaunch: false;
    }
  | {
      readonly state: "unavailable";
      readonly reason: WindowsCoordinatorRegistryReadReason;
      readonly authorizesLaunch: false;
    };

export type WindowsCoordinatorCatalogObservation =
  | {
      readonly state: "observed";
      readonly catalog: {
        readonly ManifestDigest: string;
        readonly ImageDigest: string;
        readonly State: "provisioned-unqualified" | "qualified";
        readonly ServiceName: "LexRunnerCoordinator";
      };
      readonly systemRoot: string;
      readonly authorizesLaunch: false;
    }
  | {
      readonly state: "unavailable";
      readonly reason: WindowsCoordinatorRegistryReadReason;
      readonly authorizesLaunch: false;
    };

export type WindowsCoordinatorV2CatalogObservation =
  | {
      readonly state: "observed";
      readonly catalog: WindowsCoordinatorGenerationCatalogV2Type;
      readonly systemRoot: string;
      readonly authorizesLaunch: false;
    }
  | {
      readonly state: "unavailable";
      readonly reason: WindowsCoordinatorRegistryReadReason;
      readonly authorizesLaunch: false;
    };

function linesOf(bytes: Uint8Array): string[] {
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
  return output.split(/\r?\n/u).filter((line) => line !== "");
}

function selectionValueFromRegQueryOutput(bytes: Uint8Array): string {
  const lines = linesOf(bytes);
  if (lines.length !== 2 || lines[0]!.toLowerCase() !== SELECTION_KEY.toLowerCase())
    throw new Error("Unexpected selection query structure");
  const match = /^ {4}ActiveSelection {4}REG_SZ {4}(.+)$/u.exec(lines[1]!);
  if (!match) throw new Error("Missing exact ActiveSelection REG_SZ line");
  return match[1]!;
}

/** Exact one-value REG_SZ transport grammar for the distinct v1 service key. */
export function parseWindowsCoordinatorRegQueryOutput(bytes: Uint8Array): string {
  const value = selectionValueFromRegQueryOutput(bytes);
  parseWindowsCoordinatorActiveSelectionValue(value);
  return value;
}

/** Separate v2 grammar; v1 values cannot be silently promoted. */
export function parseWindowsCoordinatorV2RegQueryOutput(bytes: Uint8Array): string {
  const value = selectionValueFromRegQueryOutput(bytes);
  parseWindowsCoordinatorActiveSelectionV2Value(value);
  return value;
}

/** Strict four-row proposed catalog grammar; the first MSI authors no catalog. */
export function parseWindowsCoordinatorCatalogRegQueryOutput(
  bytes: Uint8Array,
  generationId: string
): Extract<WindowsCoordinatorCatalogObservation, { state: "observed" }>["catalog"] {
  if (!/^[a-f0-9]{64}$/u.test(generationId)) throw new Error("Invalid generation ID");
  const lines = linesOf(bytes);
  if (
    lines.length !== 5 ||
    lines[0]!.toLowerCase() !== `${GENERATIONS_KEY}\\${generationId}`.toLowerCase()
  )
    throw new Error("Unexpected catalog query structure");
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const line of lines.slice(1)) {
    const match = /^ {4}(ManifestDigest|ImageDigest|State|ServiceName) {4}REG_SZ {4}(\S+)$/u.exec(
      line
    );
    if (!match || Object.prototype.hasOwnProperty.call(values, match[1]!))
      throw new Error("Ambiguous catalog row");
    values[match[1]!] = match[2]!;
  }
  if (
    !/^[a-f0-9]{64}$/u.test(values.ManifestDigest ?? "") ||
    !/^[a-f0-9]{64}$/u.test(values.ImageDigest ?? "") ||
    !["provisioned-unqualified", "qualified"].includes(values.State ?? "") ||
    values.ServiceName !== "LexRunnerCoordinator"
  )
    throw new Error("Invalid catalog values");
  return {
    ManifestDigest: values.ManifestDigest!,
    ImageDigest: values.ImageDigest!,
    State: values.State as "provisioned-unqualified" | "qualified",
    ServiceName: "LexRunnerCoordinator",
  };
}

/** Exact five-row v2 catalog; matching supplied rows are non-authorizing. */
export function parseWindowsCoordinatorV2CatalogRegQueryOutput(
  bytes: Uint8Array,
  generationId: string
): WindowsCoordinatorGenerationCatalogV2Type {
  if (!/^[a-f0-9]{64}$/u.test(generationId)) throw new Error("Invalid generation ID");
  const lines = linesOf(bytes);
  if (
    lines.length !== 6 ||
    lines[0]!.toLowerCase() !== `${GENERATIONS_KEY}\\${generationId}`.toLowerCase()
  )
    throw new Error("Unexpected v2 catalog query structure");
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const line of lines.slice(1)) {
    const match =
      /^ {4}(GraphDigest|ManifestDigest|ServiceImageDigest|State|ServiceName) {4}REG_SZ {4}(\S+)$/u.exec(
        line
      );
    if (!match || Object.prototype.hasOwnProperty.call(values, match[1]!))
      throw new Error("Ambiguous v2 catalog row");
    values[match[1]!] = match[2]!;
  }
  return WindowsCoordinatorGenerationCatalogV2.parse(values);
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
 * Fixed, bounded, read-only 64-bit registry query. File identity is a preflight
 * only: it neither authenticates the registry value nor binds a launched child.
 */
function queryFixedRegistry(
  args: readonly string[]
):
  | { readonly state: "observed"; readonly stdout: Buffer; readonly systemRoot: string }
  | { readonly state: "unavailable"; readonly reason: WindowsCoordinatorRegistryReadReason } {
  const stop = (reason: WindowsCoordinatorRegistryReadReason) =>
    ({ state: "unavailable", reason }) as const;
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
    result = spawnSync(executable, [...args], {
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
  return { state: "observed", stdout: result.stdout, systemRoot };
}

export function observeWindowsCoordinatorActiveSelection(): WindowsCoordinatorSelectionObservation {
  const result = queryFixedRegistry(["query", QUERY_KEY, "/v", "ActiveSelection", "/reg:64"]);
  if (result.state === "unavailable") return { ...result, authorizesLaunch: false };
  try {
    return {
      state: "observed",
      selectionValue: parseWindowsCoordinatorRegQueryOutput(result.stdout),
      authorizesLaunch: false,
    };
  } catch {
    return { state: "unavailable", reason: "registry_output_invalid", authorizesLaunch: false };
  }
}

/** Read-only v2 observation using the same fixed 64-bit HKLM transport. */
export function observeWindowsCoordinatorV2ActiveSelection(): WindowsCoordinatorSelectionObservation {
  const result = queryFixedRegistry(["query", QUERY_KEY, "/v", "ActiveSelection", "/reg:64"]);
  if (result.state === "unavailable") return { ...result, authorizesLaunch: false };
  try {
    return {
      state: "observed",
      selectionValue: parseWindowsCoordinatorV2RegQueryOutput(result.stdout),
      authorizesLaunch: false,
    };
  } catch {
    return { state: "unavailable", reason: "registry_output_invalid", authorizesLaunch: false };
  }
}

export function observeWindowsCoordinatorGenerationCatalog(
  generationId: string
): WindowsCoordinatorCatalogObservation {
  if (!/^[a-f0-9]{64}$/u.test(generationId))
    return { state: "unavailable", reason: "generation_id_invalid", authorizesLaunch: false };
  const result = queryFixedRegistry([
    "query",
    `${QUERY_KEY}\\Generations\\${generationId}`,
    "/reg:64",
  ]);
  if (result.state === "unavailable") return { ...result, authorizesLaunch: false };
  try {
    return {
      state: "observed",
      catalog: parseWindowsCoordinatorCatalogRegQueryOutput(result.stdout, generationId),
      systemRoot: result.systemRoot,
      authorizesLaunch: false,
    };
  } catch {
    return { state: "unavailable", reason: "registry_output_invalid", authorizesLaunch: false };
  }
}

export function observeWindowsCoordinatorV2GenerationCatalog(
  generationId: string
): WindowsCoordinatorV2CatalogObservation {
  if (!/^[a-f0-9]{64}$/u.test(generationId))
    return { state: "unavailable", reason: "generation_id_invalid", authorizesLaunch: false };
  const result = queryFixedRegistry([
    "query",
    `${QUERY_KEY}\\Generations\\${generationId}`,
    "/reg:64",
  ]);
  if (result.state === "unavailable") return { ...result, authorizesLaunch: false };
  try {
    return {
      state: "observed",
      catalog: parseWindowsCoordinatorV2CatalogRegQueryOutput(result.stdout, generationId),
      systemRoot: result.systemRoot,
      authorizesLaunch: false,
    };
  } catch {
    return { state: "unavailable", reason: "registry_output_invalid", authorizesLaunch: false };
  }
}
