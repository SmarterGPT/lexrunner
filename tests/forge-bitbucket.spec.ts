import { describe, expect, it, vi } from "vitest";
import { BitbucketCloudProvider } from "../src/forge/bitbucket.js";
import { createForgePlan } from "../src/forge/plan.js";
import { GitHubForgeProvider } from "../src/forge/github.js";
import type { GitHubAPI } from "../src/github/api.js";
import type { ForgeProvider, ForgePullRequest } from "../src/forge/provider.js";
import { MergeApplicationService } from "../src/application/merge-application-service.js";

const target = "a".repeat(40);
const source = "b".repeat(40);
function pr(id = 1) {
  return {
    id,
    title: `Change ${id}`,
    description: "",
    state: "OPEN",
    author: { display_name: "Author" },
    source: {
      branch: { name: `feature/${id}` },
      commit: { hash: source },
      repository: { full_name: "team/project" },
    },
    destination: {
      branch: { name: "main" },
      commit: { hash: target },
      repository: { full_name: "team/project" },
    },
  };
}
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const client = (fetcher: ReturnType<typeof vi.fn>) =>
  new BitbucketCloudProvider("team", "project", "private-token", fetcher as typeof fetch);

describe("Bitbucket Cloud read-only provider", () => {
  it("places state and target inside q alongside a caller filter, and projects body separately", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply({ values: [pr()] }));
    const result = await client(fetcher).discover({ query: 'title~"Change"', target: "main" });
    const [url, request] = fetcher.mock.calls[0]!;
    const query = new URL(url).searchParams;
    expect(query.get("state")).toBeNull();
    expect(query.get("q")).toBe(
      'state="OPEN" AND destination.branch.name="main" AND (title~"Change")'
    );
    expect(request).toMatchObject({ method: "GET", redirect: "error" });
    expect(result[0]).toMatchObject({
      number: 1,
      sha: source,
      baseSha: target,
      state: "open",
      sourceRepository: "team/project",
    });
  });

  it("uses an explicit all-state q expression rather than Bitbucket's default OPEN", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply({ values: [] }));
    await client(fetcher).discover({ state: "all", query: 'title~"test"' });
    expect(new URL(fetcher.mock.calls[0]![0]).searchParams.get("q")).toContain(
      'state IN ("OPEN","MERGED","DECLINED","SUPERSEDED")'
    );
  });

  it("follows bounded collection-local pages and sorts the result", async () => {
    const next = new URL("https://api.bitbucket.org/2.0/repositories/team/project/pullrequests");
    next.searchParams.set("q", 'state="OPEN"');
    next.searchParams.set("page", "2");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(reply({ values: [pr(2)], next: next.href }))
      .mockResolvedValueOnce(reply({ values: [pr(1)] }));
    expect((await client(fetcher).discover()).map((entry) => entry.number)).toEqual([1, 2]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    "https://attacker.invalid/steal",
    "https://api.bitbucket.org/2.0/repositories/team/other/pullrequests?q=state%3D%22OPEN%22",
    "https://user@api.bitbucket.org/2.0/repositories/team/project/pullrequests?q=state%3D%22OPEN%22",
    "https://api.bitbucket.org/2.0/repositories/team/project/pullrequests?q=state%3D%22MERGED%22",
  ])("rejects pagination outside the exact collection/filter: %s", async (next) => {
    const fetcher = vi.fn().mockResolvedValue(reply({ values: [], next }));
    await expect(client(fetcher).discover()).rejects.toThrow("pagination left");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate PR pages and out-of-scope responses", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply({ values: [pr(), pr()] }));
    await expect(client(fetcher).discover()).rejects.toThrow("duplicate");
    fetcher.mockResolvedValue(reply({ values: [{ ...pr(), state: "MERGED" }] }));
    await expect(client(fetcher).discover()).rejects.toThrow("outside the requested scope");
    fetcher.mockResolvedValue(
      reply({
        values: [
          {
            ...pr(),
            destination: { ...pr().destination, repository: { full_name: "team/other" } },
          },
        ],
      })
    );
    await expect(client(fetcher).discover()).rejects.toThrow("does not match");
  });

  it("bounds server errors, malformed response errors, and native transport errors without leaking credentials", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply({ secret: "private-token" }, 403));
    await expect(client(fetcher).discover()).rejects.toThrow(
      /^Bitbucket request failed with HTTP 403$/
    );
    fetcher.mockRejectedValue(new Error("private-token"));
    await expect(client(fetcher).discover()).rejects.toThrow(
      /^Bitbucket request failed \(network, timeout or redirect\)$/
    );
    fetcher.mockResolvedValue(reply({ values: [{ secret: "private-token" }] }));
    await expect(client(fetcher).discover()).rejects.toThrow(
      /^Bitbucket response does not satisfy the bounded observation schema$/
    );
  });

  it("bounds response bytes and accumulated results", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("x".repeat(1024 * 1024 + 1)));
    await expect(client(fetcher).discover()).rejects.toThrow("oversized");
  });

  it("reads repository, encoded branch and commit status endpoints using only GET", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(reply({ full_name: "team/project", mainbranch: { name: "main" } }))
      .mockResolvedValueOnce(reply({ name: "feature/slash", target: { hash: target } }))
      .mockResolvedValueOnce(reply({ values: [{ key: "lint", state: "SUCCESSFUL" }] }));
    const provider = client(fetcher);
    expect(await provider.getRepository()).toMatchObject({
      defaultBranch: "main",
      url: "https://bitbucket.org/team/project",
    });
    expect(await provider.getBranchHead("feature/slash")).toBe(target);
    expect(fetcher.mock.calls[1]![0]).toContain("feature%2Fslash");
    expect(await provider.getCommitStatuses(source)).toEqual([
      { key: "lint", state: "SUCCESSFUL" },
    ]);
    expect(fetcher.mock.calls.every((call) => call[1].method === "GET")).toBe(true);
  });
});

function observed(id = 1): ForgePullRequest {
  return {
    number: id,
    title: `PR ${id}`,
    description: "",
    branch: `feature/${id}`,
    sha: source,
    baseBranch: "main",
    baseSha: target,
    draft: false,
    author: "Author",
    labels: [],
    state: "open",
    sourceRepository: "team/project",
    destinationRepository: "team/project",
  };
}
function fixture(prs: ForgePullRequest[]): ForgeProvider {
  return {
    kind: "bitbucket",
    owner: "team",
    repo: "project",
    getRepository: async () => ({
      owner: "team",
      repo: "project",
      url: "https://bitbucket.org/team/project",
      defaultBranch: "main",
    }),
    getBranchHead: async () => target,
    discover: async () => prs,
  };
}

describe("forge planning", () => {
  it("freezes exact target/source inputs and declared Depends-on dependencies", async () => {
    const plan = await createForgePlan(
      fixture([observed(2), { ...observed(1), description: "Depends-on: #2" }])
    );
    expect(plan.gitInputs).toMatchObject({
      repository: "https://bitbucket.org/team/project.git",
      target: { ref: "refs/heads/main", commit: target },
    });
    expect(plan.items[0]).toMatchObject({ name: "PR-1", deps: ["PR-2"] });
    expect(plan.gitInputs!.sources[0]).toEqual({
      item: "PR-1",
      ref: "refs/heads/feature/1",
      commit: source,
    });
    expect(plan.items[0]!.gates.map((gate) => gate.run)).toEqual([
      "npm run lint",
      "npm run typecheck",
      "npm test",
    ]);
  });

  it("rejects forks, external dependencies, missing dependencies, cycles and target drift", async () => {
    await expect(
      createForgePlan(fixture([{ ...observed(), sourceRepository: "fork/project" }]))
    ).rejects.toThrow("same-repository");
    await expect(
      createForgePlan(fixture([{ ...observed(), description: "Depends-on: other/project#2" }]))
    ).rejects.toThrow("selected repository");
    await expect(
      createForgePlan(fixture([{ ...observed(), description: "Depends-on: #2" }]))
    ).rejects.toThrow("outside the selected plan");
    await expect(
      createForgePlan(fixture([{ ...observed(), description: "Depends-on: #1" }]))
    ).rejects.toThrow();
    await expect(createForgePlan(fixture([{ ...observed(), baseSha: source }]))).rejects.toThrow(
      "target changed"
    );
  });

  it("refuses Bitbucket apply before any runtime effect while permitting read-only levels", async () => {
    const plan = await createForgePlan(fixture([observed()]));
    const runtime = { isClean: vi.fn(), prepare: vi.fn(), resume: vi.fn() };
    const service = new MergeApplicationService(runtime);
    await expect(
      service.run({ plan, workingDir: ".", dryRun: false, mutationAuthorized: true })
    ).rejects.toMatchObject({ code: "MERGE_FORGE_UNSUPPORTED" });
    expect(runtime.isClean).not.toHaveBeenCalled();
    expect(runtime.prepare).not.toHaveBeenCalled();
    await expect(
      service.executePrepared({ plan, workingDir: ".", runId: "retained-bitbucket" })
    ).rejects.toMatchObject({ code: "MERGE_FORGE_UNSUPPORTED" });
    expect(runtime.resume).not.toHaveBeenCalled();
    const preview = await service.run({
      plan,
      workingDir: ".",
      dryRun: true,
      mutationAuthorized: false,
    });
    expect(preview.summary.levels).toEqual([["PR-1"]]);
  });

  it("adapts GitHub discovery without exposing mutation methods", async () => {
    const discoverPullRequests = vi.fn().mockResolvedValue([]);
    const provider = new GitHubForgeProvider({
      config: { owner: "team", repo: "project" },
      discoverPullRequests,
    } as unknown as GitHubAPI);
    expect(await provider.discover()).toEqual([]);
    expect(discoverPullRequests).toHaveBeenCalledWith("open");
    expect("updatePullRequestBranch" in provider).toBe(false);
  });

  it.each([
    "ssh://git@bitbucket.org:22/team/project.git",
    "git@bitbucket.org:team/project.git",
    "https://BITBUCKET.ORG:443/team/project.git",
  ])("refuses prepared execution for the normalized Bitbucket host %s", async (repository) => {
    const plan = await createForgePlan(fixture([observed()]));
    plan.gitInputs!.repository = repository;
    const runtime = { isClean: vi.fn(), prepare: vi.fn(), resume: vi.fn() };
    await expect(
      new MergeApplicationService(runtime).executePrepared({
        plan,
        workingDir: ".",
        runId: "retained",
      })
    ).rejects.toMatchObject({ code: "MERGE_FORGE_UNSUPPORTED" });
    expect(runtime.resume).not.toHaveBeenCalled();
  });
});
