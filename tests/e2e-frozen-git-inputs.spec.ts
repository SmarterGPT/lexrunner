import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { PlanCreationService } from "../src/application/integration-query-services.js";
import { MergeApplicationService } from "../src/application/merge-application-service.js";
import {
  createLocalResumeCheckpoint,
  LocalWeaveResumeDriver,
} from "../src/weave/local-resume-driver.js";
import { loadCheckpoint, saveCheckpoint } from "../src/weave/checkpoint/storage.js";
import { resumePersistedWeave, validateResumeJournal } from "../src/weave/resume-service.js";
import { canonicalJSONStringify } from "../src/util/canonicalJson.js";
import { sha256 } from "../src/util/hash.js";
import type { GitHubClient } from "../src/github/client.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("frozen generated Git inputs (local repositories, simulated GitHub metadata)", () => {
  it.each(["CLI", "MCP"])(
    "executes the generated bound plan through the built %s surface",
    async (surface) => {
      const f = await fixture();
      const planFile = join(f.root, "plan.json");
      await writeFile(planFile, JSON.stringify(f.plan));
      const repositoryRoot = resolve(import.meta.dirname, "..");
      let summary;
      if (surface === "CLI") {
        const result = await execa(
          process.execPath,
          [
            join(repositoryRoot, "dist", "cli.js"),
            "weave",
            "apply",
            "--plan",
            planFile,
            "--execute",
            "--json",
          ],
          { cwd: f.working, timeout: 20_000 }
        );
        summary = JSON.parse(result.stdout);
      } else {
        const profile = join(f.root, "profile");
        await mkdir(profile);
        await writeFile(join(profile, "profile.yml"), "role: local\n");
        const child = execa("node", [join(repositoryRoot, "mcp-server.mjs")], {
          cwd: f.working,
          timeout: 20_000,
          env: { ALLOW_MUTATIONS: "true", LEX_PR_PROFILE_DIR: profile },
        });
        const response = new Promise<any>((resolveResponse, reject) => {
          let stdout = "";
          child.stdout?.on("data", (chunk) => {
            stdout += chunk.toString();
            if (stdout.includes("\n")) {
              try {
                resolveResponse(JSON.parse(stdout.split("\n")[0]));
              } catch (error) {
                reject(error);
              }
            }
          });
          child.then(() => reject(new Error("MCP exited without a response")), reject);
        });
        child.stdin!.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "merge.apply", arguments: { planFile, dryRun: false } } })}\n`
        );
        const result = await response;
        child.stdin!.end();
        await child;
        expect(result.error).toBeUndefined();
        summary = JSON.parse(result.result.content[0].text);
      }
      expect(summary).toMatchObject({ ok: true, status: "completed", gitInputBinding: "frozen" });
      expect(await git(f.working, "rev-parse", "HEAD^2")).toBe(f.source);
    },
    30_000
  );
  it("runs real gates and merges the frozen PR head despite a colliding local label", async () => {
    const f = await fixture();
    const { summary, execution } = await new MergeApplicationService().run({
      plan: f.plan,
      workingDir: f.working,
      dryRun: false,
      mutationAuthorized: true,
    });
    expect(summary, JSON.stringify(execution)).toMatchObject({
      ok: true,
      status: "completed",
      gitInputBinding: "frozen",
    });
    expect(await readFile(join(f.working, "feature.txt"), "utf8")).toBe("feature\n");
    expect(await git(f.working, "rev-parse", "HEAD^2")).toBe(f.source);
    expect(await git(f.working, "rev-parse", "PR-123")).toBe(f.base);
    expect(await git(f.working, "rev-parse", "main")).toBe(f.base);
    const checkpoint = await loadCheckpoint(summary.runId!, { checkpointDir: f.checkpointDir });
    expect(checkpoint.metadata?.resume?.repository.sourceHeads["PR-123"]).toBe(f.source);
    const gateReceipts = checkpoint
      .metadata!.resume!.operations.filter((op) => op.phase !== "merge")
      .map((op) => op.result!.externalId!);
    expect(new Set(gateReceipts).size).toBe(2);
    for (const receipt of gateReceipts)
      expect(JSON.parse(await readFile(receipt, "utf8"))).toBeTruthy();
  }, 30_000);

  it("resumes the same bound plan after a persisted gate without repeating it", async () => {
    const f = await fixture();
    const checkpoint = await createLocalResumeCheckpoint({ plan: f.plan, workingDir: f.working });
    await saveCheckpoint(checkpoint, { checkpointDir: f.checkpointDir, skipCleanup: true });
    const input = {
      runId: checkpoint.runId,
      checkpointDir: f.checkpointDir,
      driver: new LocalWeaveResumeDriver(f.working),
    };
    expect(await resumePersistedWeave({ ...input, maxOperations: 1 })).toMatchObject({
      ok: true,
      outcome: "paused",
      completed: 1,
    });
    expect(await resumePersistedWeave(input)).toMatchObject({ ok: true, outcome: "completed" });
    const finished = await loadCheckpoint(checkpoint.runId, { checkpointDir: f.checkpointDir });
    expect(finished.metadata?.resume?.operations[0].attempts).toBe(1);
    expect(await git(f.working, "rev-parse", "HEAD^2")).toBe(f.source);
  }, 30_000);

  it("rejects a resumed gate outside the repository before creating its integration branch", async () => {
    const f = await fixture();
    const foreign = join(f.root, "foreign-repository");
    await mkdir(foreign);
    await git(foreign, "init", "--quiet");
    const invalidPlan = structuredClone(f.plan);
    invalidPlan.items[0]!.gates[0]!.cwd = foreign;
    const originalHead = await git(f.working, "rev-parse", "HEAD");
    const originalAcquiredRefs = await git(
      f.working,
      "for-each-ref",
      "--format=%(refname)",
      "refs/lexrunner"
    );
    await expect(
      createLocalResumeCheckpoint({ plan: invalidPlan, workingDir: f.working })
    ).rejects.toMatchObject({ code: "PLAN_REPOSITORY_MISMATCH" });
    expect(await git(f.working, "rev-parse", "HEAD")).toBe(originalHead);
    expect(await git(f.working, "for-each-ref", "--format=%(refname)", "refs/lexrunner")).toBe(
      originalAcquiredRefs
    );

    const checkpoint = await createLocalResumeCheckpoint({ plan: f.plan, workingDir: f.working });
    checkpoint.plan.items[0]!.gates[0]!.cwd = foreign;
    checkpoint.planHash = sha256(Buffer.from(canonicalJSONStringify(checkpoint.plan)));
    await saveCheckpoint(checkpoint, { checkpointDir: f.checkpointDir, skipCleanup: true });
    const lockPath = join(f.checkpointDir, `${checkpoint.runId}.json.resume.lock`);
    class InspectingLocalResumeDriver extends LocalWeaveResumeDriver {
      override preflight(value: Parameters<LocalWeaveResumeDriver["preflight"]>[0]) {
        expect(existsSync(lockPath)).toBe(false);
        return super.preflight(value);
      }
    }
    const driver = new InspectingLocalResumeDriver(f.working);
    const integrationBranch = checkpoint.metadata!.resume!.repository.integrationBranch;

    await expect(
      resumePersistedWeave({
        runId: checkpoint.runId,
        checkpointDir: f.checkpointDir,
        driver,
      })
    ).resolves.toMatchObject({
      ok: false,
      code: "external_state_mismatch",
      reason: expect.stringContaining("not bound"),
    });
    expect(existsSync(lockPath)).toBe(false);
    await expect(driver.validate(checkpoint)).resolves.toMatchObject({
      valid: false,
      reason: expect.stringContaining("not bound"),
    });
    await expect(
      driver.execute(checkpoint.metadata!.resume!.operations[0]!, checkpoint)
    ).resolves.toMatchObject({ completed: false, reason: expect.stringContaining("not bound") });
    expect(await git(f.working, "branch", "--list", integrationBranch)).toBe("");
  }, 30_000);

  it.each(["source", "target"])(
    "rejects moved %s refs without changing expected commits",
    async (which) => {
      const f = await fixture();
      const original = JSON.stringify(f.plan);
      await git(
        f.remote,
        "update-ref",
        which === "source" ? "refs/pull/123/head" : "refs/heads/main",
        which === "source" ? f.base : f.source
      );
      await expect(
        createLocalResumeCheckpoint({ plan: f.plan, workingDir: f.working })
      ).rejects.toThrow("Stale Git input");
      expect(JSON.stringify(f.plan)).toBe(original);
      expect(await git(f.working, "rev-parse", "HEAD")).toBe(f.base);
    },
    30_000
  );

  it("rejects a different checkout remote before acquisition", async () => {
    const f = await fixture();
    await git(
      f.working,
      "remote",
      "set-url",
      "origin",
      pathToFileURL(join(f.root, "wrong.git")).href
    );
    await expect(
      createLocalResumeCheckpoint({ plan: f.plan, workingDir: f.working })
    ).rejects.toThrow("Checkout repository does not match");
    expect(await git(f.working, "for-each-ref", "--format=%(refname)", "refs/lexrunner")).toBe("");
  }, 30_000);

  it("rejects a dirty checkout before fetching any bound input", async () => {
    const f = await fixture();
    await writeFile(join(f.working, "unrelated.txt"), "preserve me\n");
    await expect(
      createLocalResumeCheckpoint({ plan: f.plan, workingDir: f.working })
    ).rejects.toThrow("Working tree must be clean");
    expect(await git(f.working, "for-each-ref", "--format=%(refname)", "refs/lexrunner")).toBe("");
    expect(await readFile(join(f.working, "unrelated.txt"), "utf8")).toBe("preserve me\n");
  }, 30_000);

  it("rejects a matching object ID whose object type is not commit", async () => {
    const f = await fixture();
    const blob = await git(f.remote, "rev-parse", `${f.source}:feature.txt`);
    await git(f.remote, "update-ref", "refs/pull/123/head", blob);
    f.plan.gitInputs!.sources[0].commit = blob;
    await expect(
      createLocalResumeCheckpoint({ plan: f.plan, workingDir: f.working })
    ).rejects.toThrow("not a commit object");
  }, 30_000);

  it("fails declared acquisition instead of falling back to an existing local label", async () => {
    const f = await fixture();
    f.plan.gitInputs!.repository = pathToFileURL(join(f.root, "missing.git")).href;
    await git(f.working, "remote", "set-url", "origin", f.plan.gitInputs!.repository);
    await expect(
      createLocalResumeCheckpoint({ plan: f.plan, workingDir: f.working })
    ).rejects.toThrow("Declared acquisition failed");
    expect(await git(f.working, "rev-parse", "PR-123")).toBe(f.base);
  }, 30_000);

  it("executes local-only inputs when the declared transport is disabled", async () => {
    const f = await fixture();
    await git(f.working, "fetch", "origin", "refs/pull/123/head:refs/pull/123/head");
    await git(f.working, "config", "protocol.file.allow", "never");
    f.plan.gitInputs!.acquisition = "local-only";
    const { summary, execution } = await new MergeApplicationService().run({
      plan: f.plan,
      workingDir: f.working,
      dryRun: false,
      mutationAuthorized: true,
    });
    expect(summary.ok, JSON.stringify(execution)).toBe(true);
    expect(await git(f.working, "rev-parse", "HEAD^2")).toBe(f.source);
  }, 30_000);

  it("does not merge after an executable gate fails", async () => {
    const f = await fixture();
    f.plan.items[0].gates[0].run = 'node -e "process.exit(7)"';
    const { summary, execution } = await new MergeApplicationService().run({
      plan: f.plan,
      workingDir: f.working,
      dryRun: false,
      mutationAuthorized: true,
    });
    expect(summary.ok).toBe(false);
    expect(summary.operations?.find((op) => op.phase === "merge")?.status).toBe("pending");
    const checkpoint = await loadCheckpoint(summary.runId!, { checkpointDir: f.checkpointDir });
    expect(
      await git(f.working, "rev-parse", checkpoint.metadata!.resume!.repository.integrationBranch)
    ).toBe(f.base);
  }, 30_000);

  it.each(["worktree", "index", "commit"])(
    "blocks a passing gate that changes the frozen %s",
    async (mode) => {
      const f = await fixture();
      const script =
        "require('node:fs').writeFileSync('feature.txt','changed');" +
        (mode !== "worktree"
          ? "require('node:child_process').execFileSync('git',['add','feature.txt']);"
          : "") +
        (mode === "commit"
          ? "require('node:child_process').execFileSync('git',['commit','-m','gate-created']);"
          : "");
      f.plan.items[0].gates[0].run = `node -e "${script}"`;
      const { summary, execution } = await new MergeApplicationService().run({
        plan: f.plan,
        workingDir: f.working,
        dryRun: false,
        mutationAuthorized: true,
      });
      expect(summary.ok).toBe(false);
      expect(execution?.operations[0].error).toContain("Frozen checkout");
      expect(summary.operations?.find((op) => op.phase === "merge")?.status).toBe("pending");
      expect(await readFile(join(f.working, "feature.txt"), "utf8")).toBe("changed");
      if (mode === "commit") expect(await git(f.working, "rev-parse", "HEAD")).not.toBe(f.source);
      const checkpoint = await loadCheckpoint(summary.runId!, { checkpointDir: f.checkpointDir });
      expect(
        await git(f.working, "rev-parse", checkpoint.metadata!.resume!.repository.integrationBranch)
      ).toBe(f.base);
    },
    30_000
  );

  it("blocks a mutating post-check and preserves its changes for inspection", async () => {
    const f = await fixture();
    f.plan.items[0].gates[0].run = `node -e "let branch;try{branch=require('node:child_process').execFileSync('git',['symbolic-ref','-q','HEAD'],{stdio:'pipe'}).toString()}catch{};if(branch)require('node:fs').writeFileSync('feature.txt','post-check change')"`;
    const { summary, execution } = await new MergeApplicationService().run({
      plan: f.plan,
      workingDir: f.working,
      dryRun: false,
      mutationAuthorized: true,
    });
    expect(summary.ok).toBe(false);
    expect(execution?.operations.find((op) => op.phase === "post_check")).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Frozen checkout"),
    });
    expect(await readFile(join(f.working, "feature.txt"), "utf8")).toBe("post-check change");
  }, 30_000);

  it("blocks a gate that moves the integration ref while leaving source HEAD clean", async () => {
    const f = await fixture();
    f.plan.items[0].gates[0].run = `node -e "const cp=require('node:child_process');const ref=cp.execFileSync('git',['for-each-ref','--format=%(refname)','refs/heads/weave/']).toString().trim();cp.execFileSync('git',['update-ref',ref,'HEAD'])"`;
    const { summary, execution } = await new MergeApplicationService().run({
      plan: f.plan,
      workingDir: f.working,
      dryRun: false,
      mutationAuthorized: true,
    });
    expect(summary.ok).toBe(false);
    expect(execution?.operations[0].error).toContain("Gate changed the frozen integration branch");
    expect(summary.operations?.find((op) => op.phase === "merge")?.status).toBe("pending");
  }, 30_000);

  it("still rejects a missing explicitly declared gate output", async () => {
    const f = await fixture();
    f.plan.items[0].gates[0].artifacts = ["missing-results.xml"];
    const { summary, execution } = await new MergeApplicationService().run({
      plan: f.plan,
      workingDir: f.working,
      dryRun: false,
      mutationAuthorized: true,
    });
    expect(summary.ok).toBe(false);
    expect(execution?.operations[0].error).toContain("GATE_EVIDENCE_INVALID");
    expect(summary.operations?.find((op) => op.phase === "merge")?.status).toBe("pending");
  }, 30_000);

  it("rejects journal commit substitution even when the canonical plan hash is unchanged", async () => {
    const f = await fixture();
    const checkpoint = await createLocalResumeCheckpoint({ plan: f.plan, workingDir: f.working });
    checkpoint.metadata!.resume!.repository.sourceHeads["PR-123"] = f.base;
    expect(validateResumeJournal(checkpoint)).toMatchObject({
      valid: false,
      reason: expect.stringContaining("frozen Git inputs"),
    });
    checkpoint.metadata!.resume!.repository.sourceHeads["PR-123"] = f.source;
    checkpoint.metadata!.resume!.repository.integrationBranch = "main";
    expect(validateResumeJournal(checkpoint)).toMatchObject({
      valid: false,
      reason: expect.stringContaining("integration branch"),
    });
  }, 30_000);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lexrunner-frozen-inputs-"));
  roots.push(root);
  const remote = join(root, "remote.git"),
    seed = join(root, "seed"),
    working = join(root, "working");
  await git(root, "init", "--bare", remote);
  await git(root, "clone", remote, seed);
  await configure(seed);
  await writeFile(join(seed, ".gitignore"), ".lexrunner/\n");
  await writeFile(
    join(seed, "package.json"),
    JSON.stringify({
      scripts: {
        test: "node -e \"if (!require('node:fs').existsSync('feature.txt')) process.exit(9)\"",
      },
    })
  );
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "base");
  await git(seed, "branch", "-M", "main");
  const base = await git(seed, "rev-parse", "HEAD");
  await git(seed, "push", "origin", "main");
  await git(seed, "checkout", "-b", "feature/one");
  await writeFile(join(seed, "feature.txt"), "feature\n");
  await git(seed, "add", "feature.txt");
  await git(seed, "commit", "-m", "feature");
  const source = await git(seed, "rev-parse", "HEAD");
  await git(seed, "push", "origin", "HEAD:refs/pull/123/head");
  const url = pathToFileURL(remote).href;
  await git(root, "clone", "--branch", "main", url, working);
  await configure(working);
  await git(working, "branch", "PR-123");
  const pr = {
    number: 123,
    head: { ref: "feature/one", sha: source },
    base: { ref: "main", sha: base },
    dependencies: [],
    requiredGates: ["test"],
  };
  const client = {
    validateRepository: async () => ({
      owner: "example",
      repo: "repo",
      defaultBranch: "main",
      url,
    }),
    getBranchHead: async () => base,
    listOpenPRs: async () => [pr],
    getPRDetails: async () => pr,
  } as unknown as GitHubClient;
  const plan = await new PlanCreationService().fromGitHub(client, {
    policy: { requiredGates: ["test"] },
  });
  return {
    root,
    remote,
    working,
    base,
    source,
    plan,
    checkpointDir: join(working, ".lexrunner", "checkpoints"),
  };
}
async function configure(cwd: string) {
  await git(cwd, "config", "user.name", "LexRunner Test");
  await git(cwd, "config", "user.email", "test@example.invalid");
  await git(cwd, "config", "commit.gpgsign", "false");
}
async function git(cwd: string, ...args: string[]) {
  return (await execa("git", args, { cwd, timeout: 15_000 })).stdout.trim();
}
