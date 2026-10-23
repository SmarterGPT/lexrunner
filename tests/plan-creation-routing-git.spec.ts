import { execFileSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PlanCreationOperationService,
  writePlanCreationArtifacts,
} from "../src/application/plan-creation-operation-service.js";
import { RepositoryBindingError } from "../src/application/repository-binding.js";
import { ExecutionState } from "../src/executionState.js";
import { executeGatesWithPolicy } from "../src/gates.js";
import type { GitHubClient } from "../src/github/client.js";

const roots: string[] = [];
const originalProfile = process.env.LEX_PR_PROFILE_DIR;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalProfile === undefined) delete process.env.LEX_PR_PROFILE_DIR;
  else process.env.LEX_PR_PROFILE_DIR = originalProfile;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("repository-bound plan creation", () => {
  it("keeps configuration-only plan creation available in a canonical non-Git directory", async () => {
    const root = fixtureRoot();
    const profileRoot = join(root, ".smartergpt");
    mkdirSync(profileRoot, { recursive: true });
    writeFileSync(
      join(profileRoot, "stack.yml"),
      [
        "version: 1",
        "target: main",
        "items:",
        "  - id: local",
        "    branch: feature/local",
        "    deps: []",
        "",
      ].join("\n"),
      "utf8"
    );
    const createClient = vi.fn();

    const operation = await new PlanCreationOperationService(createClient as any).run({
      startupDir: root,
      args: {},
    });

    expect(createClient).not.toHaveBeenCalled();
    expect(operation.routing).toMatchObject({
      resolvedRepository: { root },
      discovery: { mode: "configuration" },
      gate: { cwd: ".", repositoryRoot: root },
    });
    expect(operation.plan.items.map(({ name }) => name)).toEqual(["local"]);
  });

  it("writes an explicit external output for a manifestless legacy profile", async () => {
    const root = fixtureRoot();
    const profileRoot = join(root, ".smartergpt");
    const output = join(root, ".artifacts");
    mkdirSync(profileRoot, { recursive: true });
    writeFileSync(
      join(profileRoot, "stack.yml"),
      [
        "version: 1",
        "target: main",
        "items:",
        "  - id: local",
        "    branch: feature/local",
        "    deps: []",
        "",
      ].join("\n"),
      "utf8"
    );
    const operation = await new PlanCreationOperationService(vi.fn() as any).run({
      startupDir: root,
      args: { outDir: output },
    });

    writePlanCreationArtifacts(operation);

    expect(operation.routing.output.root).toBe(output);
    expect(existsSync(join(output, "plan.json"))).toBe(true);
    expect(existsSync(join(output, "snapshot.md"))).toBe(true);
    expect(existsSync(join(output, "routing-receipt.json"))).toBe(true);
  });

  it("uses the explicit worktree, query, profile and output without inheriting startup scope", async () => {
    const root = fixtureRoot();
    const startup = repository(join(root, "startup"), "SmarterGPT", "control");
    const target = repository(join(root, "target"), "SmarterGPT", "lex");
    const startupProfile = profile(startup, "is:pr is:open");
    const targetProfile = profile(target, "is:pr is:open label:broad");
    process.env.LEX_PR_PROFILE_DIR = startupProfile;

    const listOpenPRs = vi.fn().mockResolvedValue([pullRequest()]);
    const client = githubClient(listOpenPRs);
    const createClient = vi.fn().mockResolvedValue(client);
    const operation = await new PlanCreationOperationService(createClient as any).run({
      startupDir: startup,
      args: {
        fromGithub: true,
        repoRoot: target,
        owner: "SmarterGPT",
        repo: "lex",
        query: "is:pr is:open head:codex/release",
        target: "main",
        outDir: "artifacts",
      },
    });

    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "SmarterGPT", repo: "lex" })
    );
    expect(listOpenPRs).toHaveBeenCalledWith(
      expect.objectContaining({ query: "is:pr is:open head:codex/release", base: "main" })
    );
    expect(operation.routing).toMatchObject({
      authority: "unverified",
      authorizesExecution: false,
      authorizesMerge: false,
      resolvedRepository: { root: target, owner: "SmarterGPT", repo: "lex" },
      profile: { root: targetProfile, precedence: "repository-local" },
      discovery: {
        query: "is:pr is:open head:codex/release repo:SmarterGPT/lex base:main",
        querySource: "explicit",
      },
      output: { root: join(target, "artifacts"), source: "explicit" },
      gate: { cwd: ".", repositoryRoot: target },
    });
    expect(operation.routing.profile.root).not.toBe(startupProfile);
    expect(operation.plan.items[0]?.gates.every(({ cwd }) => cwd === ".")).toBe(true);

    writePlanCreationArtifacts(operation);
    expect(existsSync(operation.files.plan)).toBe(true);
    expect(existsSync(operation.files.snapshot)).toBe(true);
    expect(existsSync(operation.files.routingReceipt)).toBe(true);

    // Staging-and-replace must retain the historical overwrite contract on
    // Windows as well as POSIX without following a caller-controlled link.
    for (const file of Object.values(operation.files)) writeFileSync(file, "stale", "utf8");
    writePlanCreationArtifacts(operation);
    expect(JSON.parse(readFileSync(operation.files.plan, "utf8"))).toMatchObject({
      schemaVersion: operation.plan.schemaVersion,
    });
    expect(readFileSync(operation.files.snapshot, "utf8")).toBe(operation.snapshot);
    expect(JSON.parse(readFileSync(operation.files.routingReceipt, "utf8"))).toMatchObject({
      contract: "lexrunner-plan-routing-v1",
    });
  });

  it("rejects a requested repository mismatch before client creation or writes", async () => {
    const root = fixtureRoot();
    const startup = repository(join(root, "startup"), "SmarterGPT", "control");
    profile(startup, "is:pr is:open");
    const output = join(startup, "must-not-exist");
    const createClient = vi.fn();
    const service = new PlanCreationOperationService(createClient as any);

    await expect(
      service.run({
        startupDir: startup,
        args: {
          fromGithub: true,
          owner: "SmarterGPT",
          repo: "lex",
          query: "is:pr is:open head:codex/release",
          outDir: output,
        },
      })
    ).rejects.toMatchObject<Partial<RepositoryBindingError>>({ code: "PLAN_REPOSITORY_MISMATCH" });
    expect(createClient).not.toHaveBeenCalled();
    expect(existsSync(output)).toBe(false);
  });

  it("records the canonical GitHub repository spelling used for the executed query", async () => {
    const root = fixtureRoot();
    const target = repository(join(root, "target"), "smartergpt", "lex");
    profile(target, "is:pr is:open");
    const client = githubClient(vi.fn().mockResolvedValue([pullRequest()]), {
      owner: "SmarterGPT",
      repo: "Lex",
    });

    const operation = await new PlanCreationOperationService(
      vi.fn().mockResolvedValue(client) as any
    ).run({
      startupDir: target,
      args: { fromGithub: true, query: "is:pr is:open", target: "main" },
    });

    expect(operation.routing.discovery.query).toBe("is:pr is:open repo:SmarterGPT/Lex base:main");
  });

  it("rejects a lookalike GitHub path on another host before client creation or writes", async () => {
    const root = fixtureRoot();
    const target = repository(
      join(root, "target"),
      "SmarterGPT",
      "lex",
      "https://evil.example/github.com/SmarterGPT/lex.git"
    );
    profile(target, "is:pr is:open");
    const output = join(target, "must-not-exist");
    const createClient = vi.fn();

    await expect(
      new PlanCreationOperationService(createClient as any).run({
        startupDir: target,
        args: {
          fromGithub: true,
          owner: "SmarterGPT",
          repo: "lex",
          outDir: output,
        },
      })
    ).rejects.toMatchObject<Partial<RepositoryBindingError>>({
      code: "PLAN_REPOSITORY_REMOTE_UNAVAILABLE",
    });
    expect(createClient).not.toHaveBeenCalled();
    expect(existsSync(output)).toBe(false);
  });

  it("rejects GitHub discovery when the executable origin binding is absent", async () => {
    const root = fixtureRoot();
    const target = repository(join(root, "target"), "SmarterGPT", "lex");
    git(target, "remote", "rename", "origin", "upstream");
    profile(target, "is:pr is:open");
    const createClient = vi.fn();

    await expect(
      new PlanCreationOperationService(createClient as any).run({
        startupDir: target,
        args: { fromGithub: true, owner: "SmarterGPT", repo: "lex" },
      })
    ).rejects.toMatchObject<Partial<RepositoryBindingError>>({
      code: "PLAN_REPOSITORY_REMOTE_UNAVAILABLE",
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each(["snapshot.md", "routing-receipt.json"])(
    "rejects colliding explicit plan output %s before client creation or writes",
    async (planFile) => {
      const root = fixtureRoot();
      const target = repository(join(root, "target"), "SmarterGPT", "lex");
      profile(target, "is:pr is:open");
      const createClient = vi.fn();

      await expect(
        new PlanCreationOperationService(createClient as any).run({
          startupDir: target,
          args: { fromGithub: true, planFile },
        })
      ).rejects.toMatchObject({ code: "PLAN_CREATION_ARGUMENTS_INVALID" });
      expect(createClient).not.toHaveBeenCalled();
      expect(existsSync(join(target, planFile))).toBe(false);
    }
  );

  it("rejects preexisting hard-linked output aliases before discovery or writes", async () => {
    const root = fixtureRoot();
    const target = repository(join(root, "target"), "SmarterGPT", "lex");
    const profileRoot = profile(target, "is:pr is:open");
    const planFile = join(profileRoot, "runner", "plan.json");
    const snapshotFile = join(profileRoot, "runner", "snapshot.md");
    writeFileSync(planFile, "unchanged", "utf8");
    linkSync(planFile, snapshotFile);
    const createClient = vi.fn();

    await expect(
      new PlanCreationOperationService(createClient as any).run({
        startupDir: target,
        args: { fromGithub: true },
      })
    ).rejects.toMatchObject({ code: "PLAN_CREATION_ARGUMENTS_INVALID" });
    expect(createClient).not.toHaveBeenCalled();
    expect(readFileSync(planFile, "utf8")).toBe("unchanged");
    expect(readFileSync(snapshotFile, "utf8")).toBe("unchanged");
  });

  it("rejects a single output hard-linked to an external file before discovery or writes", async () => {
    const root = fixtureRoot();
    const target = repository(join(root, "target"), "SmarterGPT", "lex");
    const profileRoot = profile(target, "is:pr is:open");
    const planFile = join(profileRoot, "runner", "plan.json");
    const external = join(root, "external-hardlink-target.json");
    writeFileSync(external, "external-unchanged", "utf8");
    linkSync(external, planFile);
    const createClient = vi.fn();

    await expect(
      new PlanCreationOperationService(createClient as any).run({
        startupDir: target,
        args: { fromGithub: true },
      })
    ).rejects.toMatchObject({ code: "PLAN_CREATION_ARGUMENTS_INVALID" });
    expect(createClient).not.toHaveBeenCalled();
    expect(readFileSync(external, "utf8")).toBe("external-unchanged");
    expect(existsSync(join(profileRoot, "runner", "snapshot.md"))).toBe(false);
    expect(existsSync(join(profileRoot, "runner", "routing-receipt.json"))).toBe(false);
  });

  it("rejects a profile output directory redirected outside its physical boundary", async () => {
    const root = fixtureRoot();
    const profileRoot = join(root, ".smartergpt.local");
    const external = join(root, "external");
    mkdirSync(profileRoot, { recursive: true });
    mkdirSync(external, { recursive: true });
    writeFileSync(join(profileRoot, "profile.yml"), "role: local\n", "utf8");
    writeFileSync(
      join(profileRoot, "stack.yml"),
      [
        "version: 1",
        "target: main",
        "items:",
        "  - id: local",
        "    branch: feature/local",
        "    deps: []",
        "",
      ].join("\n"),
      "utf8"
    );
    symlinkSync(
      external,
      join(profileRoot, "runner"),
      process.platform === "win32" ? "junction" : "dir"
    );
    const createClient = vi.fn();

    await expect(
      new PlanCreationOperationService(createClient as any).run({
        startupDir: root,
        args: { profileDir: profileRoot },
      })
    ).rejects.toMatchObject({ code: "PLAN_CREATION_ARGUMENTS_INVALID" });
    expect(createClient).not.toHaveBeenCalled();
    expect(readFileSync(join(profileRoot, "stack.yml"), "utf8")).toContain("feature/local");
    expect(existsSync(join(external, "plan.json"))).toBe(false);
    expect(existsSync(join(external, "snapshot.md"))).toBe(false);
    expect(existsSync(join(external, "routing-receipt.json"))).toBe(false);
  });

  it("rechecks a missing output directory before artifact writes", async () => {
    const root = fixtureRoot();
    const profileRoot = join(root, ".smartergpt.local");
    const external = join(root, "external");
    mkdirSync(profileRoot, { recursive: true });
    mkdirSync(external, { recursive: true });
    writeFileSync(join(profileRoot, "profile.yml"), "role: local\n", "utf8");
    writeFileSync(
      join(profileRoot, "stack.yml"),
      [
        "version: 1",
        "target: main",
        "items:",
        "  - id: local",
        "    branch: feature/local",
        "    deps: []",
        "",
      ].join("\n"),
      "utf8"
    );
    const operation = await new PlanCreationOperationService(vi.fn() as any).run({
      startupDir: root,
      args: { profileDir: profileRoot },
    });
    symlinkSync(
      external,
      operation.routing.output.root,
      process.platform === "win32" ? "junction" : "dir"
    );

    expect(() => writePlanCreationArtifacts(operation)).toThrowError(
      expect.objectContaining({ code: "PLAN_CREATION_ARGUMENTS_INVALID" })
    );
    expect(existsSync(join(external, "plan.json"))).toBe(false);
    expect(existsSync(join(external, "snapshot.md"))).toBe(false);
    expect(existsSync(join(external, "routing-receipt.json"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a single output symlinked to an external file before discovery or writes",
    async () => {
      const root = fixtureRoot();
      const target = repository(join(root, "target"), "SmarterGPT", "lex");
      const profileRoot = profile(target, "is:pr is:open");
      const planFile = join(profileRoot, "runner", "plan.json");
      const external = join(root, "external-symlink-target.json");
      writeFileSync(external, "external-unchanged", "utf8");
      symlinkSync(external, planFile, "file");
      const createClient = vi.fn();

      await expect(
        new PlanCreationOperationService(createClient as any).run({
          startupDir: target,
          args: { fromGithub: true },
        })
      ).rejects.toMatchObject({ code: "PLAN_CREATION_ARGUMENTS_INVALID" });
      expect(createClient).not.toHaveBeenCalled();
      expect(readFileSync(external, "utf8")).toBe("external-unchanged");
      expect(existsSync(join(profileRoot, "runner", "snapshot.md"))).toBe(false);
      expect(existsSync(join(profileRoot, "runner", "routing-receipt.json"))).toBe(false);
    }
  );

  it("rechecks symlink aliases before the first artifact write", async () => {
    const root = fixtureRoot();
    const target = repository(join(root, "target"), "SmarterGPT", "lex");
    profile(target, "is:pr is:open");
    const operation = await new PlanCreationOperationService(
      vi.fn().mockResolvedValue(githubClient(vi.fn().mockResolvedValue([pullRequest()]))) as any
    ).run({
      startupDir: target,
      args: { fromGithub: true },
    });
    writeFileSync(operation.files.plan, "unchanged", "utf8");
    const alias = join(root, "output-alias");
    symlinkSync(
      operation.routing.output.root,
      alias,
      process.platform === "win32" ? "junction" : "dir"
    );
    operation.files.snapshot = join(alias, "plan.json");

    expect(() => writePlanCreationArtifacts(operation)).toThrowError(
      expect.objectContaining({ code: "PLAN_CREATION_ARGUMENTS_INVALID" })
    );
    expect(readFileSync(operation.files.plan, "utf8")).toBe("unchanged");
    expect(existsSync(operation.files.routingReceipt)).toBe(false);
  });

  it("rejects raw gate execution on a different repository before artifacts or commands", async () => {
    const root = fixtureRoot();
    const startup = repository(join(root, "startup"), "SmarterGPT", "control");
    const target = repository(join(root, "target"), "SmarterGPT", "lex");
    profile(target, "is:pr is:open");
    const service = new PlanCreationOperationService(
      vi.fn().mockResolvedValue(githubClient(vi.fn().mockResolvedValue([pullRequest()]))) as any
    );
    const operation = await service.run({
      startupDir: target,
      args: { fromGithub: true, owner: "SmarterGPT", repo: "lex", target: "main" },
    });
    const artifacts = join(root, "gate-artifacts");
    const state = new ExecutionState(operation.plan);

    await expect(
      executeGatesWithPolicy(operation.plan, state, artifacts, 5_000, undefined, true, startup, {
        emitReceipt: false,
        suppressStdout: true,
      })
    ).rejects.toMatchObject<Partial<RepositoryBindingError>>({ code: "PLAN_REPOSITORY_MISMATCH" });
    expect(existsSync(artifacts)).toBe(false);
  });

  it("anchors raw gate cwd to the physical repository root from a nested start", async () => {
    const root = fixtureRoot();
    const target = repository(join(root, "target"), "SmarterGPT", "lex");
    const nested = join(target, "nested");
    mkdirSync(nested);
    const plan = localGatePlan(
      "node -e \"require('node:fs').writeFileSync('anchored.txt','yes')\""
    );
    const artifacts = join(root, "gate-artifacts");

    await executeGatesWithPolicy(
      plan,
      new ExecutionState(plan),
      artifacts,
      5_000,
      undefined,
      true,
      nested,
      { emitReceipt: false, suppressStdout: true }
    );

    expect(existsSync(join(target, "anchored.txt"))).toBe(true);
    expect(existsSync(join(nested, "anchored.txt"))).toBe(false);
  });

  it("rejects a raw gate cwd in another repository before artifacts or commands", async () => {
    const root = fixtureRoot();
    const target = repository(join(root, "target"), "SmarterGPT", "lex");
    const foreign = repository(join(root, "foreign"), "SmarterGPT", "other");
    const plan = localGatePlan(
      "node -e \"require('node:fs').writeFileSync('must-not-run.txt','yes')\"",
      foreign
    );
    const artifacts = join(root, "gate-artifacts");

    await expect(
      executeGatesWithPolicy(
        plan,
        new ExecutionState(plan),
        artifacts,
        5_000,
        undefined,
        true,
        target,
        { emitReceipt: false, suppressStdout: true }
      )
    ).rejects.toMatchObject<Partial<RepositoryBindingError>>({
      code: "PLAN_REPOSITORY_MISMATCH",
    });
    expect(existsSync(artifacts)).toBe(false);
    expect(existsSync(join(foreign, "must-not-run.txt"))).toBe(false);
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lexrunner-plan-routing-"));
  roots.push(root);
  return root;
}

function repository(
  directory: string,
  owner: string,
  repo: string,
  remote = `https://github.com/${owner}/${repo}.git`
): string {
  mkdirSync(directory, { recursive: true });
  git(directory, "init", "--quiet");
  git(directory, "remote", "add", "origin", remote);
  return directory;
}

function profile(repositoryRoot: string, query: string): string {
  const directory = join(repositoryRoot, ".smartergpt.local");
  mkdirSync(join(directory, "runner"), { recursive: true });
  writeFileSync(join(directory, "profile.yml"), "role: local\n", "utf8");
  writeFileSync(
    join(directory, "runner", "scope.yml"),
    [
      "version: 1",
      "target: main",
      "sources:",
      `  - query: ${JSON.stringify(query)}`,
      "selectors:",
      "  include_labels: []",
      "  exclude_labels: []",
      "defaults:",
      "  strategy: merge-weave",
      "  base: main",
      "pin_commits: false",
      "",
    ].join("\n"),
    "utf8"
  );
  return directory;
}

function pullRequest() {
  return {
    number: 821,
    title: "release",
    body: "",
    head: { ref: "codex/release", sha: "b".repeat(40) },
    base: { ref: "main", sha: "a".repeat(40) },
    state: "open" as const,
    labels: [],
    draft: false,
    user: { login: "agent" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    dependencies: [],
    tags: [],
    requiredGates: [],
  };
}

function localGatePlan(run: string, cwd = ".") {
  return {
    schemaVersion: "1.0.0" as const,
    target: "main",
    items: [
      {
        name: "local",
        deps: [],
        gates: [{ name: "local", run, cwd, env: {}, runtime: "local" as const }],
      },
    ],
  };
}

function githubClient(
  listOpenPRs: ReturnType<typeof vi.fn>,
  canonical = { owner: "SmarterGPT", repo: "lex" }
): GitHubClient {
  return {
    validateRepository: vi.fn().mockResolvedValue({
      owner: canonical.owner,
      repo: canonical.repo,
      defaultBranch: "main",
      url: `https://github.com/${canonical.owner}/${canonical.repo}`,
    }),
    getBranchHead: vi.fn().mockResolvedValue("a".repeat(40)),
    listOpenPRs,
    getPRDetails: vi.fn().mockResolvedValue(pullRequest()),
    getPRDependencies: vi.fn(),
    listIssues: vi.fn(),
    getOctokit: vi.fn(),
    getOwner: vi.fn().mockReturnValue(canonical.owner),
    getRepo: vi.fn().mockReturnValue(canonical.repo),
    getPRDiff: vi.fn(),
    getPRFiles: vi.fn(),
    getCheckRuns: vi.fn(),
    updatePullRequestBranch: vi.fn(),
  } as unknown as GitHubClient;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, windowsHide: true, stdio: "ignore" });
}
