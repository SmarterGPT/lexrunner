import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  localSourceGitEnvironment,
  runLocalPackageInstall,
} from "../scripts/install-local-package.mjs";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];
const ownedArtifactRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  for (const root of ownedArtifactRoots.splice(0)) {
    const relative = path.relative(path.join(sourceRoot, "artifacts"), root);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Refusing to remove an unowned artifact directory.");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function git(args: string[], cwd: string, env = localSourceGitEnvironment()) {
  const result = spawnSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lexrunner-local-install-git-"));
  temporaryRoots.push(root);
  const foreignRoot = path.join(root, "foreign-repository");
  fs.mkdirSync(foreignRoot);
  git(["init", "--quiet"], foreignRoot);
  git(["config", "user.name", "Owned fixture"], foreignRoot);
  git(["config", "user.email", "owned-fixture@example.invalid"], foreignRoot);
  git(["config", "commit.gpgsign", "false"], foreignRoot);
  fs.writeFileSync(path.join(foreignRoot, "foreign.txt"), "An unrelated source checkpoint.\n");
  git(["add", "foreign.txt"], foreignRoot);
  git(
    ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "owned foreign fixture"],
    foreignRoot
  );
  const foreignHead = git(["rev-parse", "HEAD"], foreignRoot);
  const npmCliPath = path.join(root, "observed-fixture-npm.cjs");
  fs.writeFileSync(
    npmCliPath,
    `const args=process.argv.slice(2);
     if(args[0]==='--version') console.log('11.16.0');
     else if(args[0]==='approve-scripts'&&args[1]==='--usage') console.log('npm approve-scripts --allow-scripts-pending');
     else if(args[0]==='install'&&args[1]==='--usage') console.log('npm install --allow-scripts --strict-allow-scripts');
     else process.exit(2);`
  );
  const env = Object.fromEntries(
    Object.entries(localSourceGitEnvironment()).filter(
      ([key]) =>
        !/^(?:node_options|npm_config_allow_scripts|npm_config_node_options|npm_execpath)$/i.test(
          key
        )
    )
  );
  env.npm_execpath = npmCliPath;
  env.GIT_DIR = path.join(foreignRoot, ".git");
  env.GIT_WORK_TREE = foreignRoot;
  return {
    root,
    foreignRoot,
    foreignHead,
    env,
    prefix: path.join(root, "uncreated-prefix"),
    artifactsDir: path.join(root, "evidence"),
  };
}

describe("local installer source Git context", () => {
  it("observes the canonical source HEAD/tree despite an actual foreign Git environment", () => {
    const input = fixture();
    const sourceHead = git(["rev-parse", "HEAD"], sourceRoot);
    const sourceTree = git(["rev-parse", "HEAD^{tree}"], sourceRoot);
    // This proves the supplied environment selects the unrelated repository
    // before the installer's source Git sanitation is applied.
    expect(git(["rev-parse", "HEAD"], sourceRoot, input.env)).toBe(input.foreignHead);
    expect(input.foreignHead).not.toBe(sourceHead);
    const receipt = runLocalPackageInstall({ projectRoot: sourceRoot, ...input });
    expect(receipt.status).toBe("planned");
    expect(receipt.source).toMatchObject({ head: sourceHead, tree: sourceTree });
    expect(receipt.sourceAfter).toMatchObject({ head: sourceHead, tree: sourceTree });
    expect(receipt.source.dirty).toBe(
      git(["status", "--porcelain=v1", "--untracked-files=all"], sourceRoot)
    );
    expect(fs.existsSync(input.prefix)).toBe(false);
    expect(
      receipt.commands.every((command: { name: string }) => command.name === "git-observe")
    ).toBe(true);
  });

  it("refuses an ignored child source that is outside the owning Git root checkpoint", () => {
    const input = fixture();
    const childRoot = path.join(input.foreignRoot, "owned-source");
    fs.mkdirSync(childRoot);
    for (const name of ["package.json", "package-lock.json"])
      fs.copyFileSync(path.join(sourceRoot, name), path.join(childRoot, name));
    fs.writeFileSync(path.join(input.foreignRoot, ".gitignore"), "owned-source/\n");
    git(["add", ".gitignore"], input.foreignRoot);
    git(
      ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "ignore owned child"],
      input.foreignRoot
    );
    expect(git(["status", "--porcelain=v1"], input.foreignRoot)).toBe("");
    expect(() => runLocalPackageInstall({ ...input, projectRoot: childRoot })).toThrow(
      "physical owning Git repository root"
    );
    const receipt = JSON.parse(
      fs.readFileSync(path.join(input.artifactsDir, "receipt.json"), "utf8")
    );
    expect(receipt.status).toBe("failed");
    expect(fs.existsSync(input.prefix)).toBe(false);
  });

  it("refuses root manifest/lock inputs ignored by a clean source HEAD", () => {
    const input = fixture();
    for (const name of ["package.json", "package-lock.json"])
      fs.copyFileSync(path.join(sourceRoot, name), path.join(input.foreignRoot, name));
    fs.writeFileSync(
      path.join(input.foreignRoot, ".gitignore"),
      "package.json\npackage-lock.json\n"
    );
    git(["add", ".gitignore"], input.foreignRoot);
    git(
      ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "ignore unbound inputs"],
      input.foreignRoot
    );
    expect(git(["status", "--porcelain=v1"], input.foreignRoot)).toBe("");
    expect(() => runLocalPackageInstall({ ...input, projectRoot: input.foreignRoot })).toThrow(
      "manifest and lock must be tracked in HEAD"
    );
    const receipt = JSON.parse(
      fs.readFileSync(path.join(input.artifactsDir, "receipt.json"), "utf8")
    );
    expect(receipt.status).toBe("failed");
    expect(fs.existsSync(input.prefix)).toBe(false);
  });

  it("records dirty tracked input mismatch in a plan and refuses execution before source build", () => {
    const input = fixture();
    for (const name of ["package.json", "package-lock.json"])
      fs.copyFileSync(path.join(sourceRoot, name), path.join(input.foreignRoot, name));
    git(["add", "package.json", "package-lock.json"], input.foreignRoot);
    git(
      ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "track owned inputs"],
      input.foreignRoot
    );
    const initial = runLocalPackageInstall({ ...input, projectRoot: input.foreignRoot });
    expect(initial.source.inputsMatchHead).toBe(true);
    expect(initial.source.dirty).toBe("");
    const manifestPath = path.join(input.foreignRoot, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.description = "Changed current input outside the recorded source HEAD bytes";
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const planned = runLocalPackageInstall({
      ...input,
      projectRoot: input.foreignRoot,
      artifactsDir: path.join(input.root, "dirty-plan"),
    });
    expect(planned.source.inputsMatchHead).toBe(false);
    expect(planned.source.dirty).toContain("package.json");
    expect(planned.source.headManifestSha256).not.toBe(planned.package.manifestSha256);
    const artifactsDir = path.join(input.root, "refused-execution");
    expect(() =>
      runLocalPackageInstall({
        ...input,
        projectRoot: input.foreignRoot,
        artifactsDir,
        execute: true,
      })
    ).toThrow("Source checkpoint changed or is dirty");
    const receipt = JSON.parse(fs.readFileSync(path.join(artifactsDir, "receipt.json"), "utf8"));
    expect(
      receipt.commands.every((command: { name: string }) => command.name === "git-observe")
    ).toBe(true);
    expect(fs.existsSync(input.prefix)).toBe(false);
  }, 20_000);

  it("uses canonical ignored-artifact checks and strips mixed-case Git selectors", () => {
    const input = fixture();
    const artifactsDir = path.join(sourceRoot, "artifacts", path.basename(input.root));
    ownedArtifactRoots.push(artifactsDir);
    expect(
      spawnSync(
        "git",
        ["check-ignore", "--quiet", "--no-index", path.relative(sourceRoot, artifactsDir)],
        {
          cwd: sourceRoot,
          env: input.env,
          timeout: 10_000,
        }
      ).status
    ).not.toBe(0);
    const env = {
      ...input.env,
      git_index_file: path.join(input.root, "unowned-index"),
      GiT_COMMON_DIR: path.join(input.root, "missing-common-directory"),
    };
    const receipt = runLocalPackageInstall({
      projectRoot: sourceRoot,
      ...input,
      artifactsDir,
      env,
    });
    expect(receipt.status).toBe("planned");
    expect(receipt.source.head).toBe(git(["rev-parse", "HEAD"], sourceRoot));
    expect(fs.existsSync(path.join(artifactsDir, "receipt.json"))).toBe(true);
    expect(fs.existsSync(input.prefix)).toBe(false);
    expect(fs.existsSync(env.git_index_file)).toBe(false);
  });

  it("retains CLI selector refusal diagnostics in the owning ignored source area", () => {
    const input = fixture();
    const result = spawnSync(
      process.execPath,
      [
        path.join(sourceRoot, "scripts", "install-local-package.mjs"),
        "--prefix",
        "relative-prefix",
      ],
      { cwd: sourceRoot, env: input.env, encoding: "utf8", timeout: 10_000 }
    );
    expect(result.status).toBe(1);
    const receiptPath = /Receipt: ([^\r\n]+)/.exec(result.stderr)?.[1];
    expect(receiptPath).toBeTruthy();
    const directory = path.dirname(receiptPath!);
    ownedArtifactRoots.push(directory);
    expect(
      path.relative(path.join(sourceRoot, "artifacts", "local-install"), directory)
    ).not.toMatch(/^\.\./);
    expect(JSON.parse(fs.readFileSync(receiptPath!, "utf8"))).toMatchObject({
      status: "failed",
      phase: "preflight",
      commands: [],
    });
    expect(fs.existsSync(input.prefix)).toBe(false);
  });
});
