import { describe, it, expect, vi } from "vitest";
import { buildRepositoryBoundPullRequestQuery, GitHubClientImpl } from "../src/github/client.js";

function makeFakePR(n: number) {
  return {
    number: n,
    title: `PR ${n}`,
    body: "",
    head: { ref: `branch-${n}`, sha: `sha-${n}` },
    base: { ref: "main", sha: `base-${n}` },
    state: "open",
    labels: [],
    draft: false,
    mergeable: true,
    user: { login: "author" },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

describe("GitHubClientImpl (pagination & discovery)", () => {
  it("executes an explicit query through repository-bound PR search", async () => {
    const search = vi.fn();
    const get = vi.fn(({ pull_number }) => ({ data: makeFakePR(pull_number) }));
    const paginate = vi.fn(async (method: unknown, params: { q?: string }) => {
      expect(method).toBe(search);
      expect(params.q).toBe("is:pr is:open head:codex/release repo:Owner/Repo base:main");
      return [{ number: 821 }];
    });
    const fakeOctokit = {
      rest: {
        pulls: { list: vi.fn(), get },
        search: { issuesAndPullRequests: search },
        repos: {
          get: vi.fn(() => ({
            data: {
              owner: { login: "Owner" },
              name: "Repo",
              default_branch: "main",
              html_url: "https://github.com/Owner/Repo",
            },
          })),
        },
      },
      paginate,
    };
    const client = new GitHubClientImpl({
      owner: "owner",
      repo: "repo",
      octokit: fakeOctokit as any,
    });

    const prs = await client.listOpenPRs({
      query: "is:pr is:open head:codex/release",
      base: "main",
    });

    expect(prs.map(({ number }) => number)).toEqual([821]);
    expect(get).toHaveBeenCalledWith({ owner: "Owner", repo: "Repo", pull_number: 821 });
  });

  it.each([
    "repo:other/repo is:pr",
    "org:other is:pr",
    "user:other is:pr",
    "type:issue",
    'repo:"other/repo" is:pr',
    "org:'other' is:pr",
    'type:"issue"',
    'is:"closed"',
    'base:"other"',
    "is:issue",
    "is:pr OR is:issue",
    "(repo:other/repo)",
    "((org:other))",
    "(base:other)",
    "(is:issue)",
    "(is:pr OR is:issue)",
    "is:pr is:closed",
    "is:pr base:other",
  ])("rejects unsafe or conflicting query %s", (query) => {
    expect(() =>
      buildRepositoryBoundPullRequestQuery({
        query,
        owner: "Owner",
        repo: "Repo",
        base: "main",
        state: "open",
      })
    ).toThrow();
  });

  it.each(["bad owner", "repo:escape", "main repo:other/repo", 'main" repo:other/repo'])(
    "rejects unsafe repository or target interpolation %s",
    (value) => {
      expect(() =>
        buildRepositoryBoundPullRequestQuery({
          owner: value === "bad owner" ? value : "Owner",
          repo: value === "repo:escape" ? value : "Repo",
          base: value.startsWith("main") ? value : "main",
          state: "open",
        })
      ).toThrow();
    }
  );

  it("aggregates paginated PRs via paginate", async () => {
    // Create fake octokit with paginate that returns two pages
    const prsPage1 = Array.from({ length: 100 }, (_, i) => makeFakePR(i + 1));
    const prsPage2 = [makeFakePR(101), makeFakePR(102)];

    const fakeOctokit = {
      rest: {
        pulls: {
          list: () => ({ data: prsPage1 }),
        },
        repos: {
          get: () => ({
            data: {
              default_branch: "main",
              html_url: "https://github.com/Owner/Repo",
            },
          }),
        },
      },
      paginate: async (_fn: any, _params: any) => {
        return [...prsPage1, ...prsPage2];
      },
    };

    const client = new GitHubClientImpl({
      owner: "Owner",
      repo: "Repo",
      octokit: fakeOctokit as any,
    });

    const prs = await client.listOpenPRs({});
    expect(prs.length).toBe(102);
    expect(prs[0].number).toBe(1);
    expect(prs[101].number).toBe(102);
  });

  it("returns empty array for no PRs", async () => {
    const fakeOctokit = {
      rest: {
        pulls: { list: () => ({ data: [] }) },
        repos: {
          get: () => ({
            data: {
              default_branch: "main",
              html_url: "https://github.com/Owner/Repo",
            },
          }),
        },
      },
      paginate: async () => [],
    };

    const client = new GitHubClientImpl({
      owner: "Owner",
      repo: "Repo",
      octokit: fakeOctokit as any,
    });

    const prs = await client.listOpenPRs({});
    expect(prs).toEqual([]);
  });

  it("uses injected Octokit instead of creating new instance", async () => {
    // Create a fake with a spy to track calls
    let reposGetCalled = false;
    const fakeOctokit = {
      rest: {
        pulls: {
          list: () => ({ data: [makeFakePR(1)] }),
        },
        repos: {
          get: () => {
            reposGetCalled = true;
            return {
              data: {
                default_branch: "main",
                html_url: "https://github.com/test/test",
              },
            };
          },
        },
      },
    };

    // Inject via constructor
    const client = new GitHubClientImpl({
      owner: "Test",
      repo: "Repo",
      octokit: fakeOctokit as any,
    });

    // Verify it uses the injected instance
    expect(client.getOctokit()).toBe(fakeOctokit);

    // Verify it actually uses the fake for API calls
    const repo = await client.validateRepository();
    expect(reposGetCalled).toBe(true);
    expect(repo.owner).toBe("Test");
    expect(repo.repo).toBe("Repo");
    expect(repo.defaultBranch).toBe("main");
  });
});
