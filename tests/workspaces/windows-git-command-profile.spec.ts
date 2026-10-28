import { describe, expect, it } from "vitest";

import type {
  WorkspaceBoundaryDirectoryCapability,
  WorkspaceBoundaryProcessArgument,
} from "../../src/workspaces/workspace-boundary.js";
import {
  snapshotWindowsGitFixtureProfile,
  windowsGitFixtureProcessPlan,
  type WindowsBrokerGitVerb,
  type WindowsGitFixtureProfileInput,
} from "../../src/workspaces/windows-git-command-profile.js";

const input: WindowsGitFixtureProfileInput = {
  gitExecutable: "C:\\Program Files\\Git\\cmd\\git.exe",
  systemRoot: "C:\\Windows",
  homeDirectory: "D:\\fixture\\home",
  tempDirectory: "D:\\fixture\\temp",
  configFile: "D:\\fixture\\empty.gitconfig",
  templateDirectory: "D:\\fixture\\templates",
  emptyHooksDirectory: "D:\\fixture\\empty-hooks",
  searchPath: ["C:\\Program Files\\Git\\cmd", "C:\\Windows\\System32"],
};
const directory = {} as WorkspaceBoundaryDirectoryCapability;
const prefix: WorkspaceBoundaryProcessArgument[] = [
  { kind: "directory", directory, prefix: "--git-dir=" },
  { kind: "directory", directory, prefix: "--work-tree=" },
];
const args = (...tail: string[]): WorkspaceBoundaryProcessArgument[] => [
  ...prefix,
  ...tail.map((value) => ({ kind: "literal" as const, value })),
];

describe("Windows Git fixture process profile", () => {
  it("snapshots its input and excludes the parent environment", () => {
    const mutable = { ...input, searchPath: [...input.searchPath] };
    const profile = snapshotWindowsGitFixtureProfile(mutable);
    mutable.searchPath[0] = "C:\\malicious";
    const previous = process.env.GIT_CONFIG_COUNT;
    process.env.GIT_CONFIG_COUNT = "1";
    try {
      const plan = windowsGitFixtureProcessPlan(
        profile,
        "status_worktree",
        args("status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all")
      );
      expect(plan.gitExecutable).toBe(input.gitExecutable);
      expect(plan.extendEnv).toBe(false);
      expect(plan.maxOutputBytes).toBe(256 * 1024);
      expect(plan.env).not.toHaveProperty("GIT_CONFIG_COUNT");
      expect(plan.env.PATH).toContain(input.searchPath[0]);
      expect(plan.env.PATH).not.toContain("malicious");
      expect(plan.args.map((arg) => (arg.kind === "literal" ? arg.value : arg.prefix))).toEqual([
        ...plan.evidencePrefix,
        "--git-dir=",
        "--work-tree=",
        "status",
        "--porcelain=v1",
        "-z",
        "--ignored=matching",
        "--untracked-files=all",
      ]);
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_COUNT;
      else process.env.GIT_CONFIG_COUNT = previous;
    }
  });

  it("admits exactly the read-oriented broker verbs and closes write verbs", () => {
    const profile = snapshotWindowsGitFixtureProfile(input);
    const allowed: [WindowsBrokerGitVerb, string[]][] = [
      ["check_branch", ["check-ref-format", "--branch", "agent/work"]],
      ["verify_commit", ["rev-parse", "--verify", `${"a".repeat(40)}^{commit}`]],
      ["list_worktrees", ["worktree", "list", "--porcelain", "-z"]],
      [
        "status_worktree",
        ["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all"],
      ],
      ["show_ref", ["show-ref", "--verify", "--quiet", "refs/heads/agent/work"]],
    ];
    for (const [verb, tail] of allowed)
      expect(windowsGitFixtureProcessPlan(profile, verb, args(...tail)).gitExecutable).toBe(
        input.gitExecutable
      );
    for (const verb of ["worktree_add", "worktree_remove"] as const)
      expect(() => windowsGitFixtureProcessPlan(profile, verb, args("worktree", "add"))).toThrow(
        /not admitted/u
      );
    expect(() =>
      windowsGitFixtureProcessPlan(profile, "show_ref", args("-c", "core.fsmonitor=true"))
    ).toThrow();
    expect(() =>
      windowsGitFixtureProcessPlan(profile, "list_worktrees", [
        { kind: "literal", value: "--git-dir=.git" },
        ...args("worktree", "list", "--porcelain", "-z").slice(1),
      ])
    ).toThrow(/directory/u);
  });
});
