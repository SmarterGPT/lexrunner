/**
 * GitHub API integration for PR discovery and metadata extraction
 * Maintains deterministic ordering and stable output
 * Includes error recovery with retry and circuit breaker patterns
 */

import { Octokit } from "@octokit/rest";
import { simpleGit } from "simple-git";
import { stableSort } from "../util/canonicalJson.js";
import {
  retryWithBackoff,
  createGitHubCircuitBreaker,
  classifyError,
  formatErrorForUser,
  CircuitBreaker,
} from "../core/errorRecovery.js";

/**
 * Normalize a label entry returned by octokit into a string name.
 * Labels can be returned as plain strings or objects with a `name` property.
 */
export function extractLabelName(label: any): string {
  if (!label) return "";
  if (typeof label === "string") return label;
  if (typeof label.name === "string") return label.name;
  return "";
}

/**
 * Check if a PR has review requested based on requested_reviewers and requested_teams
 */
function hasReviewRequested(pull: {
  requested_reviewers?: any[] | null;
  requested_teams?: any[] | null;
}): boolean {
  return (pull.requested_reviewers?.length ?? 0) > 0 || (pull.requested_teams?.length ?? 0) > 0;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  branch: string;
  sha: string;
  state: "open" | "closed" | "merged";
  labels: string[];
  author: string;
  baseBranch: string;
  createdAt: string;
  updatedAt: string;
  mergeable?: boolean;
  body?: string | null;
  draft?: boolean;
  reviewRequested?: boolean;
}

export interface GitHubConfig {
  token?: string;
  owner: string;
  repo: string;
}

/**
 * GitHub API client for PR operations with error recovery
 */
export class GitHubAPI {
  private octokit: Octokit;
  public config: GitHubConfig;
  private circuitBreaker: CircuitBreaker;
  private normalized: boolean = false;

  constructor(config: GitHubConfig) {
    this.config = config;
    this.octokit = new Octokit({
      auth: config.token || process.env.GITHUB_TOKEN,
    });
    this.circuitBreaker = createGitHubCircuitBreaker();
  }

  /**
   * Get the underlying Octokit instance for advanced operations
   * Use with caution - prefer using typed methods when available
   */
  getOctokit(): Octokit {
    return this.octokit;
  }

  /**
   * Normalize repository owner and name to match GitHub's canonical casing.
   * This handles case-insensitive lookups where git remote URLs may have
   * different casing than the actual GitHub repository.
   */
  private async normalizeRepositoryName(): Promise<void> {
    if (this.normalized) {
      return;
    }

    try {
      const { data: repo } = await this.octokit.rest.repos.get({
        owner: this.config.owner,
        repo: this.config.repo,
      });

      // Update config with canonical names from GitHub (defensive null checks)
      if (repo.owner?.login) {
        this.config.owner = repo.owner.login;
      }
      if (repo.name) {
        this.config.repo = repo.name;
      }
      this.normalized = true;
    } catch (error) {
      // Extract status from error for better error messages
      const status = this.extractErrorStatus(error);

      if (status === 404) {
        throw new GitHubAPIError(
          `Repository ${this.config.owner}/${this.config.repo} not found. Check repository name and access permissions.`,
          status
        );
      }
      // For other errors (auth, rate limit, network), throw immediately
      // Don't set normalized flag - we want to retry on next call
      throw new GitHubAPIError(
        `Failed to normalize repository name: ${error instanceof Error ? error.message : String(error)}`,
        status
      );
    }
  }

  /**
   * Extract HTTP status code from error object
   */
  private extractErrorStatus(error: unknown): number | undefined {
    if (!error || typeof error !== "object") {
      return undefined;
    }

    if ("status" in error && typeof (error as { status: unknown }).status === "number") {
      return (error as { status: number }).status;
    }

    return undefined;
  }

  /**
   * Discover open pull requests with stable ordering and error recovery
   */
  async discoverPullRequests(
    state: "open" | "closed" | "all" = "open"
  ): Promise<GitHubPullRequest[]> {
    // Normalize repository name before making API calls
    await this.normalizeRepositoryName();

    return retryWithBackoff(
      async () => {
        return this.circuitBreaker.execute(async () => {
          try {
            const { data: pulls } = await this.octokit.rest.pulls.list({
              owner: this.config.owner,
              repo: this.config.repo,
              state,
              sort: "updated",
              direction: "desc",
              per_page: 100,
            });

            // Transform to our interface and sort for deterministic output
            const pullRequests: GitHubPullRequest[] = pulls.map((pull) => ({
              number: pull.number,
              title: pull.title,
              branch: pull.head.ref,
              sha: pull.head.sha,
              state: pull.state as "open" | "closed" | "merged",
              labels: stableSort(pull.labels.map(extractLabelName)),
              author: pull.user?.login || "unknown",
              baseBranch: pull.base.ref,
              createdAt: pull.created_at,
              updatedAt: pull.updated_at,
              body: pull.body || null,
              draft: pull.draft ?? false,
              reviewRequested: hasReviewRequested(pull),
            }));

            // Sort by PR number for deterministic ordering
            pullRequests.sort((a, b) => a.number - b.number);
            return pullRequests;
          } catch (error) {
            const classified = classifyError(error, "Fetching pull requests");
            console.error(formatErrorForUser(classified));
            // Extract status from octokit error if available
            const status =
              error &&
              typeof error === "object" &&
              "status" in error &&
              typeof (error as { status: unknown }).status === "number"
                ? (error as { status: number }).status
                : undefined;
            throw new GitHubAPIError(
              `Failed to fetch pull requests: ${error instanceof Error ? error.message : String(error)}`,
              status
            );
          }
        });
      },
      {
        maxAttempts: 3,
        initialDelayMs: 1000,
        backoffMultiplier: 2,
      },
      (attempt, error, delayMs) => {
        console.warn(
          `Retrying GitHub API call (attempt ${attempt}): ${error.error.message}. Waiting ${delayMs}ms...`
        );
      }
    );
  }

  /**
   * Get repository information
   */
  async getRepositoryInfo() {
    // Normalize repository name before making API calls
    await this.normalizeRepositoryName();

    try {
      const { data: repo } = await this.octokit.rest.repos.get({
        owner: this.config.owner,
        repo: this.config.repo,
      });

      return {
        name: repo.name,
        fullName: repo.full_name,
        defaultBranch: repo.default_branch,
        private: repo.private,
      };
    } catch (error) {
      throw new GitHubAPIError(
        `Failed to fetch repository info: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Check if authentication is working
   */
  async checkAuth(): Promise<{ authenticated: boolean; user?: string }> {
    try {
      const { data: user } = await this.octokit.rest.users.getAuthenticated();
      return {
        authenticated: true,
        user: user.login,
      };
    } catch (error) {
      return {
        authenticated: false,
      };
    }
  }

  /**
   * Get a specific pull request by number
   */
  async getPullRequest(prNumber: number): Promise<GitHubPullRequest | null> {
    try {
      const { data: pull } = await this.octokit.rest.pulls.get({
        owner: this.config.owner,
        repo: this.config.repo,
        pull_number: prNumber,
      });

      return {
        number: pull.number,
        title: pull.title,
        branch: pull.head.ref,
        sha: pull.head.sha,
        state: pull.state as "open" | "closed" | "merged",
        labels: stableSort(pull.labels.map(extractLabelName)),
        author: pull.user?.login || "unknown",
        baseBranch: pull.base.ref,
        createdAt: pull.created_at,
        updatedAt: pull.updated_at,
        mergeable: pull.mergeable ?? undefined,
        body: pull.body || null,
        draft: pull.draft ?? false,
        reviewRequested: hasReviewRequested(pull),
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Update a pull request (e.g., to undraft it)
   */
  async updatePullRequest(
    owner: string,
    repo: string,
    prNumber: number,
    updates: { draft?: boolean; title?: string; body?: string }
  ): Promise<void> {
    try {
      await this.octokit.rest.pulls.update({
        owner,
        repo,
        pull_number: prNumber,
        ...updates,
      });
    } catch (error) {
      throw new GitHubAPIError(
        `Failed to update PR #${prNumber}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Add a label to a pull request
   */
  async addLabel(prNumber: number, label: string): Promise<void> {
    try {
      await this.octokit.rest.issues.addLabels({
        owner: this.config.owner,
        repo: this.config.repo,
        issue_number: prNumber,
        labels: [label],
      });
    } catch (error) {
      throw new GitHubAPIError(
        `Failed to add label to PR #${prNumber}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Remove a label from a pull request
   */
  async removeLabel(prNumber: number, label: string): Promise<void> {
    try {
      await this.octokit.rest.issues.removeLabel({
        owner: this.config.owner,
        repo: this.config.repo,
        issue_number: prNumber,
        name: label,
      });
    } catch (error) {
      throw new GitHubAPIError(
        `Failed to remove label from PR #${prNumber}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get labels for a pull request
   */
  async getLabels(prNumber: number): Promise<string[]> {
    try {
      const { data: issue } = await this.octokit.rest.issues.get({
        owner: this.config.owner,
        repo: this.config.repo,
        issue_number: prNumber,
      });

      return stableSort(issue.labels.map(extractLabelName));
    } catch (error) {
      throw new GitHubAPIError(
        `Failed to get labels for PR #${prNumber}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get repository info (for harvest)
   */
  async getRepository(): Promise<{ default_branch: string; [key: string]: any }> {
    await this.normalizeRepositoryName();
    const { data } = await this.octokit.rest.repos.get({
      owner: this.config.owner,
      repo: this.config.repo,
    });
    return data;
  }

  /**
   * Get a git reference (branch/tag SHA)
   */
  async getRef(ref: string): Promise<{ object: { sha: string } }> {
    await this.normalizeRepositoryName();
    const { data } = await this.octokit.rest.git.getRef({
      owner: this.config.owner,
      repo: this.config.repo,
      ref,
    });
    return data;
  }

  /**
   * Get check runs for a commit SHA
   */
  async getCheckRuns(sha: string): Promise<{
    total_count: number;
    check_runs: Array<{ status: string; conclusion: string | null }>;
  }> {
    await this.normalizeRepositoryName();
    const { data } = await this.octokit.rest.checks.listForRef({
      owner: this.config.owner,
      repo: this.config.repo,
      ref: sha,
    });
    return data;
  }

  /**
   * Get reviews for a pull request
   */
  async getReviews(
    prNumber: number
  ): Promise<Array<{ user: { login: string } | null; state: string }>> {
    await this.normalizeRepositoryName();
    const { data } = await this.octokit.rest.pulls.listReviews({
      owner: this.config.owner,
      repo: this.config.repo,
      pull_number: prNumber,
    });
    return data;
  }

  /**
   * Compare two commits
   */
  async compare(base: string, head: string): Promise<{ merge_base_commit?: { sha: string } }> {
    await this.normalizeRepositoryName();
    const { data } = await this.octokit.rest.repos.compareCommits({
      owner: this.config.owner,
      repo: this.config.repo,
      base,
      head,
    });
    return data;
  }

  /**
   * List issues (excluding PRs if filtered by caller)
   */
  async listIssues(options: { state: "open" | "closed" | "all" }): Promise<any[]> {
    await this.normalizeRepositoryName();
    const { data } = await this.octokit.rest.issues.listForRepo({
      owner: this.config.owner,
      repo: this.config.repo,
      state: options.state,
      per_page: 100,
    });
    return data;
  }

  /**
   * Update a pull request's branch with the latest changes from the base branch
   * This is typically used after merging another PR to keep branches up to date
   */
  async updatePullRequestBranch(owner: string, repo: string, prNumber: number): Promise<void> {
    try {
      await this.octokit.rest.pulls.updateBranch({
        owner,
        repo,
        pull_number: prNumber,
      });
    } catch (error) {
      throw new GitHubAPIError(
        `Failed to update PR #${prNumber} branch: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Merge a pull request
   */
  async mergePullRequest(
    owner: string,
    repo: string,
    prNumber: number,
    options: { method: "squash" | "merge" | "rebase"; commitTitle?: string }
  ): Promise<boolean> {
    try {
      await this.octokit.rest.pulls.merge({
        owner,
        repo,
        pull_number: prNumber,
        merge_method: options.method,
        commit_title: options.commitTitle,
      });
      return true;
    } catch (error) {
      throw new GitHubAPIError(
        `Failed to merge PR #${prNumber}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get commit status for a SHA
   */
  async getCommitStatus(
    owner: string,
    repo: string,
    ref: string
  ): Promise<{ state: string; statuses: any[] }> {
    try {
      const { data } = await this.octokit.rest.repos.getCombinedStatusForRef({
        owner,
        repo,
        ref,
      });
      return {
        state: data.state,
        statuses: data.statuses,
      };
    } catch (error) {
      throw new GitHubAPIError(
        `Failed to get commit status for ${ref}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

export class GitHubAPIError extends Error {
  public readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "GitHubAPIError";
    this.status = status;
  }
}

/**
 * Create GitHub API client from environment and config
 */
export async function createGitHubAPI(baseDir: string = process.cwd()): Promise<GitHubAPI | null> {
  // Try to detect GitHub repository from the caller's diagnostic or working directory.
  const repoInfo = await detectGitHubRepository(baseDir);
  if (!repoInfo) {
    return null;
  }

  return new GitHubAPI({
    owner: repoInfo.owner,
    repo: repoInfo.repo,
    token: process.env.GITHUB_TOKEN,
  });
}

/**
 * Detect GitHub repository information from git remote
 */
async function detectGitHubRepository(
  baseDir: string
): Promise<{ owner: string; repo: string } | null> {
  try {
    const git = simpleGit(baseDir);
    const remotes = await git.getRemotes(true);

    // Look for origin remote first, then any GitHub remote
    const githubRemote =
      remotes.find(
        (remote) => remote.name === "origin" && remote.refs.fetch.includes("github.com")
      ) || remotes.find((remote) => remote.refs.fetch.includes("github.com"));

    if (!githubRemote) {
      return null;
    }

    // Parse GitHub URL (supports both HTTPS and SSH formats)
    const url = githubRemote.refs.fetch;
    const match = url.match(/github\.com[\/:]([^\/]+)\/([^\/\.]+)/);

    if (!match) {
      return null;
    }

    return {
      owner: match[1],
      repo: match[2],
    };
  } catch {
    return null;
  }
}
