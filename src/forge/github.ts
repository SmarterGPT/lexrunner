import type { GitHubAPI } from "../github/api.js";
import { ForgeError, type ForgeProvider, type ForgeDiscoveryOptions } from "./provider.js";

/** Adapter over the existing GitHub client; mutation methods are intentionally unexposed. */
export class GitHubForgeProvider implements ForgeProvider {
  readonly kind = "github" as const;
  readonly owner: string;
  readonly repo: string;

  constructor(private readonly client: GitHubAPI) {
    this.owner = client.config.owner;
    this.repo = client.config.repo;
  }

  async getRepository() {
    const { data } = await this.client
      .getOctokit()
      .repos.get({ owner: this.owner, repo: this.repo });
    return {
      owner: this.owner,
      repo: this.repo,
      url: data.html_url,
      defaultBranch: data.default_branch,
    };
  }

  async getBranchHead(branch: string) {
    const { data } = await this.client
      .getOctokit()
      .repos.getBranch({ owner: this.owner, repo: this.repo, branch });
    return data.commit.sha;
  }

  async discover(options: ForgeDiscoveryOptions = {}) {
    if (options.query || options.target)
      throw new ForgeError("GitHub discovery filters require the GitHub plan query service");
    const prs = await this.client.discoverPullRequests(options.state ?? "open");
    if (prs.length > 256) throw new ForgeError("Forge discovery exceeds the 256-item limit");
    return prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      description: pr.body ?? "",
      branch: pr.branch,
      sha: pr.sha,
      state: pr.state,
      ...(pr.draft !== undefined ? { draft: pr.draft } : {}),
      author: pr.author,
      baseBranch: pr.baseBranch,
      baseSha: "",
      // The legacy normalized client does not expose fork identity. Planning through
      // this adapter is deliberately unavailable until that observation is explicit.
      sourceRepository: "",
      destinationRepository: `${this.owner}/${this.repo}`,
      labels: pr.labels,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      ...(pr.mergeable !== undefined ? { mergeable: pr.mergeable } : {}),
      ...(pr.reviewRequested !== undefined ? { reviewRequested: pr.reviewRequested } : {}),
    }));
  }
}
