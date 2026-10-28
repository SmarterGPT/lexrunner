import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { WindowsGitFixtureProfileInput } from "../../src/workspaces/windows-git-command-profile.js";

/** Unprotected disposable test data, never a production service selection. */
export async function makeWindowsGitFixtureProfile(
  root: string,
  gitExecutable: string
): Promise<WindowsGitFixtureProfileInput> {
  const profileRoot = path.join(root, "git-profile");
  const homeDirectory = path.join(profileRoot, "home");
  const tempDirectory = path.join(profileRoot, "temp");
  const templateDirectory = path.join(profileRoot, "templates");
  const emptyHooksDirectory = path.join(profileRoot, "empty-hooks");
  const configFile = path.join(profileRoot, "empty.gitconfig");
  await Promise.all(
    [homeDirectory, tempDirectory, templateDirectory, emptyHooksDirectory].map((directory) =>
      mkdir(directory, { recursive: true })
    )
  );
  await writeFile(configFile, "");
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const gitRoot = path.dirname(path.dirname(gitExecutable));
  return {
    gitExecutable,
    systemRoot,
    homeDirectory,
    tempDirectory,
    configFile,
    templateDirectory,
    emptyHooksDirectory,
    searchPath: [
      path.join(gitRoot, "cmd"),
      path.join(gitRoot, "mingw64", "bin"),
      path.join(gitRoot, "usr", "bin"),
      path.join(systemRoot, "System32"),
      systemRoot,
    ],
  };
}
