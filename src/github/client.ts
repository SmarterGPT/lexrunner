/**
 * GitHub API client for PR discovery and metadata extraction
 * Implements the GitHubClient interface with authentication and rate limiting
 */

import { Octokit } from "@octokit/rest";
import { createTokenAuth } from "@octokit/auth-token";
import type {
  PullRequest,
  PullRequestDetails,
  PRQueryOptions,
  RepositoryInfo,
  GitHubIssue,
  IssueQueryOptions,
  GitHubCheckRun,
  CheckRunsOptions,
} from "./types.js";
import { GitHubAPIError, GitHubRateLimitError, GitHubAuthError } from "./types.js";
import { parsePRDescription, normalizeDependencyRef } from "../planner/index.js";
import { parseRemoteUrl } from "../git/parseRemote.js";

export type {
  PullRequest,
  PullRequestDetails,
  PRQueryOptions,
  RepositoryInfo,
  GitHubIssue,
  IssueQueryOptions,
  GitHubCheckRun,
  CheckRunsOptions,
};
export { GitHubAPIError, GitHubRateLimitError, GitHubAuthError };

export function buildRepositoryBoundPullRequestQuery(input: {
  query?: string;
  owner: string;
  repo: string;
  base?: string;
  state?: "open" | "closed" | "all";
}): string {
  const query = input.query?.trim() ?? "";
  if (
    !/^[A-Za-z0-9_.-]{1,255}$/u.test(input.owner) ||
    !/^[A-Za-z0-9_.-]{1,255}$/u.test(input.repo)
  ) {
    throw new GitHubAPIError("GitHub repository identity is invalid");
  }
  if (
    input.base !== undefined &&
    (Buffer.byteLength(input.base, "utf8") > 512 ||
      !/^[^\s"'\\:]+$/u.test(input.base) ||
      input.base.includes("..") ||
      input.base.includes("@{"))
  ) {
    throw new GitHubAPIError("GitHub target branch is unsafe for repository-bound search");
  }
  if (Buffer.byteLength(query, "utf8") > 4096) {
    throw new GitHubAPIError("GitHub PR query exceeds the 4096-byte limit");
  }
  const tokens = unquotedSearchTokens(query);
  if (tokens.some((token) => token.toUpperCase() === "OR")) {
    throw new GitHubAPIError("GitHub PR query cannot contain an unquoted OR expression");
  }
  if (tokens.some((token) => /^(?:repo|org|user|type):/iu.test(token))) {
    throw new GitHubAPIError(
      "GitHub PR query cannot override repository, organization, user, or result type"
    );
  }
  if (tokens.some((token) => /^is:issue$/iu.test(token))) {
    throw new GitHubAPIError("GitHub PR query cannot select issues");
  }

  const requestedState = input.state ?? "open";
  const stateTokens = tokens
    .filter((token) => /^is:(?:open|closed|merged)$/iu.test(token))
    .map((token) => token.slice(3).toLowerCase());
  if (
    requestedState !== "all" &&
    stateTokens.some(
      (state) => state !== requestedState && !(requestedState === "closed" && state === "merged")
    )
  ) {
    throw new GitHubAPIError("GitHub PR query state conflicts with the requested state");
  }

  const baseTokens = tokens
    .filter((token) => /^base:/iu.test(token))
    .map((token) => token.slice(5));
  if (input.base && baseTokens.some((base) => base.toLowerCase() !== input.base!.toLowerCase())) {
    throw new GitHubAPIError("GitHub PR query base conflicts with the requested target branch");
  }

  const qualifiers = [query];
  qualifiers.push(`repo:${input.owner}/${input.repo}`);
  if (!tokens.some((token) => /^is:pr$/iu.test(token))) qualifiers.push("is:pr");
  if (
    requestedState !== "all" &&
    !tokens.some((token) => /^is:(?:open|closed|merged)$/iu.test(token))
  ) {
    qualifiers.push(`is:${requestedState}`);
  }
  if (input.base && baseTokens.length === 0) qualifiers.push(`base:${input.base}`);
  return qualifiers.filter(Boolean).join(" ");
}

function unquotedSearchTokens(query: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: '"' | "'" | undefined;
  let hasUnquotedCharacters = false;
  const flush = () => {
    if (token && hasUnquotedCharacters) tokens.push(token);
    token = "";
    hasUnquotedCharacters = false;
  };
  for (const character of query) {
    if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/u.test(character) || character === "(" || character === ")") {
      flush();
      continue;
    }
    token += character;
    hasUnquotedCharacters = true;
  }
  if (quote) throw new GitHubAPIError("GitHub PR query contains an unterminated quote");
  flush();
  return tokens;
}

export interface GitHubClient {
  listOpenPRs(options?: PRQueryOptions): Promise<PullRequest[]>;
  getPRDetails(number: number): Promise<PullRequestDetails>;
  getPRDependencies(pr: PullRequest): Promise<string[]>;
  validateRepository(): Promise<RepositoryInfo>;
  getBranchHead(branch: string): Promise<string>;
  // Issue operations
  listIssues(options?: IssueQueryOptions): Promise<GitHubIssue[]>;
  // File analysis support
  getOctokit(): any; // Returns Octokit instance for advanced operations
  getOwner(): string;
  getRepo(): string;
  // Minimal context support
  getPRDiff(prNumber: number): Promise<string>;
  getPRFiles(prNumber: number): Promise<Array<{ path: string; content: string }>>;
  // Check runs support
  getCheckRuns(ref: string, options?: CheckRunsOptions): Promise<GitHubCheckRun[]>;
  // PR branch operations
  updatePullRequestBranch(prNumber: number): Promise<void>;
}

export class GitHubClientImpl implements GitHubClient {
  private octokit: Octokit;
  private owner: string;
  private repo: string;
  private normalized: boolean = false;

  constructor(options: { token?: string; owner: string; repo: string; octokit?: Octokit }) {
    this.owner = options.owner;
    this.repo = options.repo;

    // Use injected Octokit if provided (for testing)
    if (options.octokit) {
      this.octokit = options.octokit;
    } else if (options.token) {
      // Initialize Octokit with authentication if token provided
      this.octokit = new Octokit({
        auth: options.token,
      });
    } else {
      // Try to get token from environment
      const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      if (token) {
        this.octokit = new Octokit({
          auth: token,
        });
      } else {
        // Unauthenticated client (rate limited)
        this.octokit = new Octokit();
      }
    }
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
      const response = await this.octokit.rest.repos.get({
        owner: this.owner,
        repo: this.repo,
      });

      // Update with canonical names from GitHub (defensive null checks)
      if (response.data.owner?.login) {
        this.owner = response.data.owner.login;
      }
      if (response.data.name) {
        this.repo = response.data.name;
      }
      this.normalized = true;
    } catch (error: unknown) {
      // Extract status from error
      const status = this.extractErrorStatus(error);
      const message = error instanceof Error ? error.message : String(error);

      // If normalization fails with 404, throw immediately
      if (status === 404) {
        throw new GitHubAPIError(
          `Repository ${this.owner}/${this.repo} not found. Check repository name and access permissions.`
        );
      }
      // For other errors (auth, rate limit, network), throw immediately
      // Don't set normalized flag - we want to retry on next call
      throw new GitHubAPIError(`Failed to normalize repository name: ${message}`, status);
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

  async getBranchHead(branch: string): Promise<string> {
    const response = await this.octokit.rest.repos.getBranch({
      owner: this.owner,
      repo: this.repo,
      branch,
    });
    return response.data.commit.sha;
  }

  async validateRepository(): Promise<RepositoryInfo> {
    try {
      const response = await this.octokit.rest.repos.get({
        owner: this.owner,
        repo: this.repo,
      });

      // Normalize after successful fetch (if data available)
      if (response.data.owner?.login) {
        this.owner = response.data.owner.login;
      }
      if (response.data.name) {
        this.repo = response.data.name;
      }
      this.normalized = true;

      return {
        owner: this.owner,
        repo: this.repo,
        defaultBranch: response.data.default_branch,
        url: response.data.html_url,
      };
    } catch (error: any) {
      if (error.status === 401) {
        throw new GitHubAuthError("GitHub authentication failed. Please provide a valid token.");
      }
      if (error.status === 403 && error.response?.headers?.["x-ratelimit-remaining"] === "0") {
        const resetTime = new Date(parseInt(error.response.headers["x-ratelimit-reset"]) * 1000);
        throw new GitHubRateLimitError("GitHub API rate limit exceeded", resetTime);
      }
      if (error.status === 404) {
        throw new GitHubAPIError(
          `Repository ${this.owner}/${this.repo} not found or not accessible`
        );
      }
      throw new GitHubAPIError(`Failed to validate repository: ${error.message}`, error.status);
    }
  }

  async listOpenPRs(options: PRQueryOptions = {}): Promise<PullRequest[]> {
    if (options.query) {
      // Reject scope-broadening syntax before repository normalization performs
      // the first API request.
      buildRepositoryBoundPullRequestQuery({
        query: options.query,
        owner: this.owner,
        repo: this.repo,
        base: options.base,
        state: options.state ?? "open",
      });
    }
    // Normalize repository name before making API calls
    await this.normalizeRepositoryName();

    try {
      const params: any = {
        owner: this.owner,
        repo: this.repo,
        state: options.state || "open",
        sort: options.sort || "created",
        direction: options.direction || "desc",
        per_page: options.per_page || 30,
        page: options.page ?? 1,
      };

      if (options.base) params.base = options.base;
      if (options.head) params.head = options.head;

      if (options.query) {
        const q = buildRepositoryBoundPullRequestQuery({
          query: options.query,
          owner: this.owner,
          repo: this.repo,
          base: options.base,
          state: options.state ?? "open",
        });
        const searchParams: any = {
          q,
          per_page: options.per_page || 30,
          page: options.page ?? 1,
          ...(options.sort === "created" || options.sort === "updated"
            ? { sort: options.sort }
            : {}),
          ...(options.direction ? { order: options.direction } : {}),
        };
        const search = (this.octokit as any).rest.search?.issuesAndPullRequests;
        if (typeof search !== "function") {
          throw new GitHubAPIError("GitHub search is unavailable for the requested PR query");
        }
        const searchItems =
          typeof (this.octokit as any).paginate === "function"
            ? await (this.octokit as any).paginate(search, searchParams)
            : ((await search(searchParams)).data.items ?? []);
        const numbers = [
          ...new Set<number>(
            searchItems
              .map((item: any) => item.number)
              .filter((number: unknown): number is number => Number.isInteger(number))
          ),
        ];
        const pullResponses = await Promise.all(
          numbers.map((pull_number) =>
            this.octokit.rest.pulls.get({ owner: this.owner, repo: this.repo, pull_number })
          )
        );
        let prs = pullResponses.map(({ data }) => data);
        if (options.labels && options.labels.length > 0) {
          prs = prs.filter((pr: any) =>
            options.labels!.some((label: string) =>
              pr.labels.some((prLabel: any) => prLabel.name === label)
            )
          );
        }
        return prs.map(this.transformPR);
      }

      // Use octokit.paginate to follow pagination automatically if available
      let allPRs: any[];
      if (typeof (this.octokit as any).paginate === "function") {
        allPRs = await (this.octokit as any).paginate(
          (this.octokit as any).rest.pulls.list,
          params
        );

        // Some test fakes return minimal objects (e.g., [{ number: 1 }]). If items are incomplete
        // (missing expected fields like 'title'), fallback to a single REST list call which
        // most mocks provide with full PR objects.
        if (allPRs.length > 0 && allPRs.some((item) => typeof item.title === "undefined")) {
          const response = await this.octokit.rest.pulls.list(params as any);
          allPRs = response.data || [];
        }
      } else {
        // Fallback: single page request
        const response = await this.octokit.rest.pulls.list(params as any);
        allPRs = response.data || [];
      }

      // Filter by labels if specified
      let prs = allPRs;
      if (options.labels && options.labels.length > 0) {
        prs = prs.filter((pr: any) =>
          options.labels!.some((label: string) =>
            pr.labels.some((prLabel: any) => prLabel.name === label)
          )
        );
      }

      return prs.map(this.transformPR);
    } catch (error: any) {
      return this.handleAPIError(error);
    }
  }

  async getPRDetails(number: number): Promise<PullRequestDetails> {
    try {
      const response = await this.octokit.rest.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: number,
      });

      const pr = this.transformPR(response.data);
      const dependencies = await this.getPRDependencies(pr);
      const tags = this.extractTags(pr);
      const requiredGates = this.extractRequiredGates(pr);

      // Parse PR description for additional metadata and gate overrides
      const parsed = parsePRDescription(pr.number, pr.body, {
        repository: `${this.owner}/${this.repo}`,
        partialExtraction: true,
      });

      return {
        ...pr,
        dependencies,
        tags,
        requiredGates,
        ...(parsed.metadata && Object.keys(parsed.metadata).length > 0
          ? { metadata: parsed.metadata }
          : {}),
        ...(parsed.gates ? { gateOverrides: parsed.gates } : {}),
      };
    } catch (error: any) {
      return this.handleAPIError(error);
    }
  }

  async getPRDependencies(pr: PullRequest): Promise<string[]> {
    if (!pr.body) {
      return [];
    }

    // Use the new dependency parser for comprehensive parsing
    const parsed = parsePRDescription(pr.number, pr.body, {
      repository: `${this.owner}/${this.repo}`,
      partialExtraction: true,
    });

    // Normalize all dependencies to full format (owner/repo#123)
    const normalizedDeps = parsed.dependencies.map((dep) =>
      normalizeDependencyRef(dep, `${this.owner}/${this.repo}`)
    );

    // Remove duplicates and sort for deterministic output
    return [...new Set(normalizedDeps)].sort();
  }

  async listIssues(options: IssueQueryOptions = {}): Promise<GitHubIssue[]> {
    try {
      const params: any = {
        owner: this.owner,
        repo: this.repo,
        state: options.state || "open",
        per_page: options.per_page || 100,
        page: options.page || 1,
        sort: options.sort || "created",
        direction: options.direction || "desc",
      };

      if (options.labels && options.labels.length > 0) {
        params.labels = options.labels.join(",");
      }

      if (options.assignee) {
        params.assignee = options.assignee;
      }

      if (options.creator) {
        params.creator = options.creator;
      }

      if (options.mentioned) {
        params.mentioned = options.mentioned;
      }

      const response = await this.octokit.rest.issues.listForRepo(params);

      // Filter out pull requests (GitHub API includes PRs in issues endpoint)
      const issues = response.data.filter((item: any) => !item.pull_request);

      return issues.map((issue: any) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels.map((label: any) => ({
          name: label.name,
          color: label.color,
        })),
        user: {
          login: issue.user.login,
        },
        assignees: issue.assignees.map((assignee: any) => ({
          login: assignee.login,
        })),
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
      }));
    } catch (error: any) {
      return this.handleAPIError(error);
    }
  }

  private transformPR(prData: any): PullRequest {
    return {
      number: prData.number,
      title: prData.title,
      body: prData.body,
      head: {
        ref: prData.head.ref,
        sha: prData.head.sha,
      },
      base: {
        ref: prData.base.ref,
        sha: prData.base.sha,
      },
      state: prData.state,
      labels: prData.labels.map((label: any) => ({
        name: label.name,
        color: label.color,
      })),
      draft: prData.draft || false,
      mergeable: prData.mergeable,
      user: {
        login: prData.user.login,
      },
      createdAt: prData.created_at,
      updatedAt: prData.updated_at,
    };
  }

  private extractTags(pr: PullRequest): string[] {
    // Extract tags from labels, filtering for stack-related labels
    const tags = pr.labels
      .map((label) => label.name)
      .filter((name) => name.startsWith("stack:") || name.startsWith("tag:"))
      .map((name) => name.replace(/^(stack:|tag:)/, ""));

    return [...new Set(tags)].sort();
  }

  private extractRequiredGates(pr: PullRequest): string[] {
    const gates: string[] = [];

    // Extract from labels like "gate:lint", "gate:test"
    const gateLabels = pr.labels
      .map((label) => label.name)
      .filter((name) => name.startsWith("gate:"))
      .map((name) => name.replace(/^gate:/, ""));

    gates.push(...gateLabels);

    // Use the dependency parser to extract gate overrides from PR body
    if (pr.body) {
      const parsed = parsePRDescription(pr.number, pr.body, { partialExtraction: true });
      if (parsed.gates?.required) {
        gates.push(...parsed.gates.required);
      }
    }

    return [...new Set(gates)].sort();
  }

  private handleAPIError(error: any): never {
    if (error.status === 401) {
      throw new GitHubAuthError("GitHub authentication failed. Please provide a valid token.");
    }
    if (error.status === 403 && error.response?.headers?.["x-ratelimit-remaining"] === "0") {
      const resetTime = new Date(parseInt(error.response.headers["x-ratelimit-reset"]) * 1000);
      throw new GitHubRateLimitError("GitHub API rate limit exceeded", resetTime);
    }
    throw new GitHubAPIError(`GitHub API error: ${error.message}`, error.status);
  }

  // File analysis support methods
  getOctokit(): any {
    return this.octokit;
  }

  getOwner(): string {
    return this.owner;
  }

  getRepo(): string {
    return this.repo;
  }

  /**
   * Get unified diff for a pull request
   */
  async getPRDiff(prNumber: number): Promise<string> {
    try {
      // Use the GitHub API to get the diff in unified format
      const response = await this.octokit.rest.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        mediaType: {
          format: "diff",
        },
      });

      // The response data will be the diff as a string when format is 'diff'
      return response.data as unknown as string;
    } catch (error: any) {
      return this.handleAPIError(error);
    }
  }

  /**
   * Get files from a pull request with their content
   */
  async getPRFiles(prNumber: number): Promise<Array<{ path: string; content: string }>> {
    try {
      // Get list of files changed in the PR
      const { data: files } = await this.octokit.rest.pulls.listFiles({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        per_page: 100,
      });

      // Get the PR details to find the head SHA
      const { data: pr } = await this.octokit.rest.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
      });

      const headSha = pr.head.sha;

      // Fetch content for each file
      const filesWithContent = await Promise.all(
        files
          .filter((file) => {
            // Only fetch TypeScript/JavaScript files for symbol extraction
            return /\.(ts|tsx|js|jsx)$/.test(file.filename);
          })
          .filter((file) => {
            // Skip deleted files
            return file.status !== "removed";
          })
          .slice(0, 20) // Limit to 20 files to avoid rate limits
          .map(async (file) => {
            try {
              const { data: content } = await this.octokit.rest.repos.getContent({
                owner: this.owner,
                repo: this.repo,
                path: file.filename,
                ref: headSha,
              });

              // Content is base64 encoded
              if ("content" in content && typeof content.content === "string") {
                const decoded = Buffer.from(content.content, "base64").toString("utf-8");
                return {
                  path: file.filename,
                  content: decoded,
                };
              }
              return null;
            } catch (error) {
              // File might not exist or be too large
              return null;
            }
          })
      );

      return filesWithContent.filter((f): f is { path: string; content: string } => f !== null);
    } catch (error: any) {
      return this.handleAPIError(error);
    }
  }

  /**
   * Get check runs for a specific Git reference (commit SHA, branch, or tag)
   */
  async getCheckRuns(ref: string, options?: CheckRunsOptions): Promise<GitHubCheckRun[]> {
    try {
      const params: any = {
        owner: this.owner,
        repo: this.repo,
        ref,
      };

      if (options?.check_name) {
        params.check_name = options.check_name;
      }
      if (options?.status) {
        params.status = options.status;
      }
      if (options?.filter) {
        params.filter = options.filter;
      }

      const response = await this.octokit.rest.checks.listForRef(params);

      return response.data.check_runs.map((check: any) => ({
        id: check.id,
        name: check.name,
        status: check.status,
        conclusion: check.conclusion,
        started_at: check.started_at,
        completed_at: check.completed_at,
        html_url: check.html_url,
        app: {
          name: check.app?.name || "GitHub App",
        },
      }));
    } catch (error: any) {
      return this.handleAPIError(error);
    }
  }

  /**
   * Update a pull request's branch with the latest changes from the base branch
   */
  async updatePullRequestBranch(prNumber: number): Promise<void> {
    try {
      await this.octokit.rest.pulls.updateBranch({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
      });
    } catch (error: any) {
      this.handleAPIError(error);
    }
  }
}

/**
 * Factory function to create GitHub client with auto-detection of repository info
 */
export async function createGitHubClient(
  options: {
    token?: string;
    owner?: string;
    repo?: string;
    octokit?: Octokit;
  } = {}
): Promise<GitHubClient> {
  let owner = options.owner;
  let repo = options.repo;

  // Auto-detect repository info from git remote if not provided
  if (!owner || !repo) {
    try {
      const { execa } = await import("execa");

      // Prefer origin; fall back to first push remote from `git remote -v`
      let remoteUrl: string | undefined;
      try {
        const r = await execa("git", ["remote", "get-url", "origin"]);
        remoteUrl = r.stdout.trim();
      } catch (e) {
        // fallback: parse git remote -v for a push url
        const r = await execa("git", ["remote", "-v"]);
        const lines = r.stdout.trim().split(/\r?\n/);
        for (const line of lines) {
          // format: <name> <url> (fetch|push)
          const m = line.match(/^([^\s]+)\s+([^\s]+)\s+\((fetch|push)\)$/);
          if (m && m[3] === "push") {
            remoteUrl = m[2];
            break;
          }
        }
        // if still not found, try first remote entry
        if (!remoteUrl && lines.length > 0) {
          const m = lines[0].match(/^([^\s]+)\s+([^\s]+)\s+\((fetch|push)\)$/);
          if (m) remoteUrl = m[2];
        }
      }

      if (remoteUrl) {
        const parsed = parseRemoteUrl(remoteUrl);
        owner = owner || parsed.owner;
        repo = repo || parsed.repo;
      }
    } catch (error) {
      // Ignore git command errors - user will need to provide explicit values
    }
  }

  if (!owner || !repo) {
    throw new GitHubAPIError(
      "Repository owner and name must be provided or detectable from git remote"
    );
  }

  // Support test injection via global fake Octokit (for CLI subprocess testing)
  let octokitToInject = options.octokit;
  if (!octokitToInject && process.env.LEX_PR_FAKE_OCTOKIT === "1") {
    const globalFake = (global as any).__FAKE_OCTOKIT;
    if (globalFake && typeof globalFake === "object") {
      octokitToInject = globalFake;
    }
  }

  return new GitHubClientImpl({
    token: options.token,
    owner,
    repo,
    octokit: octokitToInject,
  });
}
