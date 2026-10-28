import { win32 } from "node:path";

import type { WorkspaceBoundaryProcessArgument } from "./workspace-boundary.js";
import { windowsCommandEnvironment } from "./windows-command-environment.js";

/** Fixture composition only. Installed service selection must supply a separately
 * protected image, directory graph, token and policy before this can be authority. */
export interface WindowsGitFixtureProfileInput {
  readonly gitExecutable: string;
  readonly systemRoot: string;
  readonly homeDirectory: string;
  readonly tempDirectory: string;
  readonly configFile: string;
  readonly templateDirectory: string;
  readonly emptyHooksDirectory: string;
  readonly searchPath: readonly string[];
}

export interface WindowsGitFixtureProfile extends WindowsGitFixtureProfileInput {
  readonly searchPath: readonly string[];
}

export type WindowsBrokerGitVerb =
  | "check_branch"
  | "verify_commit"
  | "list_worktrees"
  | "status_worktree"
  | "show_ref"
  | "worktree_add"
  | "worktree_remove";

const MAX_GIT_OUTPUT_BYTES = 256 * 1024;
const OBJECT_ID_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})\^\{commit\}$/u;
const DRIVE_PATH = /^[A-Za-z]:\\/u;

function absolutePath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > 1024 ||
    !DRIVE_PATH.test(value) ||
    !win32.isAbsolute(value) ||
    /[\0\r\n]/u.test(value)
  )
    throw new Error("Invalid Windows Git fixture path");
  return win32.normalize(value);
}

/** Snapshot mutable test input before any asynchronous broker operation. */
export function snapshotWindowsGitFixtureProfile(
  input: WindowsGitFixtureProfileInput
): WindowsGitFixtureProfile {
  if (
    !Array.isArray(input.searchPath) ||
    input.searchPath.length < 1 ||
    input.searchPath.length > 8
  )
    throw new Error("Invalid Windows Git fixture search path");
  const searchPath = Object.freeze(input.searchPath.map(absolutePath));
  return Object.freeze({
    gitExecutable: absolutePath(input.gitExecutable),
    systemRoot: absolutePath(input.systemRoot),
    homeDirectory: absolutePath(input.homeDirectory),
    tempDirectory: absolutePath(input.tempDirectory),
    configFile: absolutePath(input.configFile),
    templateDirectory: absolutePath(input.templateDirectory),
    emptyHooksDirectory: absolutePath(input.emptyHooksDirectory),
    searchPath,
  });
}

function literalTail(args: readonly WorkspaceBoundaryProcessArgument[]): string[] {
  if (
    args.length < 3 ||
    args[0]?.kind !== "directory" ||
    args[0].prefix !== "--git-dir=" ||
    args[1]?.kind !== "directory" ||
    args[1].prefix !== "--work-tree="
  )
    throw new Error("Unbound Windows Git directory arguments");
  return args.slice(2).map((arg) => {
    if (arg.kind !== "literal") throw new Error("Unsupported Windows Git directory argument");
    return arg.value;
  });
}

function exact(values: readonly string[], expected: readonly string[]): boolean {
  return (
    values.length === expected.length && values.every((value, index) => value === expected[index])
  );
}

function assertVerb(verb: WindowsBrokerGitVerb, args: readonly WorkspaceBoundaryProcessArgument[]) {
  const values = literalTail(args);
  const valid =
    (verb === "check_branch" &&
      values.length === 3 &&
      exact(values.slice(0, 2), ["check-ref-format", "--branch"]) &&
      values[2]!.length > 0 &&
      values[2]!.length <= 256 &&
      !/[\0\r\n]/u.test(values[2]!)) ||
    (verb === "verify_commit" &&
      values.length === 3 &&
      exact(values.slice(0, 2), ["rev-parse", "--verify"]) &&
      OBJECT_ID_COMMIT.test(values[2]!)) ||
    (verb === "list_worktrees" && exact(values, ["worktree", "list", "--porcelain", "-z"])) ||
    (verb === "status_worktree" &&
      exact(values, [
        "status",
        "--porcelain=v1",
        "-z",
        "--ignored=matching",
        "--untracked-files=all",
      ])) ||
    (verb === "show_ref" &&
      values.length === 4 &&
      exact(values.slice(0, 3), ["show-ref", "--verify", "--quiet"]) &&
      values[3]!.startsWith("refs/heads/") &&
      values[3]!.length > "refs/heads/".length &&
      values[3]!.length <= 267 &&
      !/[\0\r\n]/u.test(values[3]!));
  if (!valid) throw new Error("Windows Git verb is not admitted by the read-only fixture profile");
}

/** Exact, read-oriented broker commands under an explicit development fixture.
 * This suppresses ambient Git configuration but does not suppress repository
 * clean filters selected by .gitattributes during status. It must not be run
 * with a privileged service token or treated as installed execution authority. */
export function windowsGitFixtureProcessPlan(
  profile: WindowsGitFixtureProfile,
  verb: WindowsBrokerGitVerb,
  args: readonly WorkspaceBoundaryProcessArgument[]
) {
  assertVerb(verb, args);
  const config = [
    "--no-pager",
    "-c",
    "credential.helper=",
    "-c",
    "core.askPass=",
    "-c",
    `core.hooksPath=${profile.emptyHooksDirectory.replace(/\\/gu, "/")}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "-c",
    "core.autocrlf=false",
  ];
  const env = windowsCommandEnvironment(
    {
      extendEnv: false,
      env: {
        SystemRoot: profile.systemRoot,
        WINDIR: profile.systemRoot,
        COMSPEC: win32.join(profile.systemRoot, "System32", "cmd.exe"),
        PATH: profile.searchPath.join(";"),
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        HOME: profile.homeDirectory,
        USERPROFILE: profile.homeDirectory,
        HOMEDRIVE: profile.homeDirectory.slice(0, 2),
        HOMEPATH: profile.homeDirectory.slice(2),
        APPDATA: win32.join(profile.homeDirectory, "AppData"),
        LOCALAPPDATA: win32.join(profile.homeDirectory, "LocalAppData"),
        XDG_CONFIG_HOME: win32.join(profile.homeDirectory, "XdgConfig"),
        TEMP: profile.tempDirectory,
        TMP: profile.tempDirectory,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: profile.configFile,
        GIT_CONFIG_SYSTEM: profile.configFile,
        GIT_ATTR_NOSYSTEM: "1",
        GIT_TEMPLATE_DIR: profile.templateDirectory,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
        GIT_OPTIONAL_LOCKS: "0",
        LANG: "C",
        LC_ALL: "C",
      },
    },
    {}
  );
  return {
    gitExecutable: profile.gitExecutable,
    args: [
      ...config.map((value) => ({ kind: "literal" as const, value })),
      ...args,
    ] satisfies readonly WorkspaceBoundaryProcessArgument[],
    evidencePrefix: config,
    env,
    extendEnv: false as const,
    maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
  };
}
