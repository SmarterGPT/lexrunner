/**
 * Discover command - Discover open pull requests from GitHub
 */

import { Command } from "commander";
import { createGitHubAPI, GitHubAPI, GitHubAPIError } from "../github/api.js";
import { canonicalJSONStringify } from "../util/canonicalJson.js";
import { throwExit } from "../cli/exitHandler.js";
import { DiscoveryQueryService } from "../application/integration-query-services.js";
import { runBitbucketDiscovery } from "../forge/commands.js";

interface DiscoverCommandDeps {
  jsonModeActive: () => boolean;
}

/**
 * Register the discover command with the CLI program
 */
export function registerDiscoverCommand(program: Command, deps: DiscoverCommandDeps): void {
  program
    .command("discover")
    .description("Discover open pull requests from GitHub (canonical: lexrunner weave discover)")
    .option("--provider <forge>", "Read-only discovery provider (github|bitbucket)", "github")
    .option("--query <query>", "Bitbucket q filter (state is added inside q)")
    .option("--target <branch>", "Bitbucket destination branch filter")
    .option("--owner <owner>", "GitHub repository owner")
    .option("--repo <repo>", "GitHub repository name")
    .option("--state <state>", "PR state filter", "open")
    .option("--suggest", "Generate dependency/grouping suggestions using heuristics")
    .option("--json", "Output JSON format")
    .addHelpText(
      "after",
      `
Examples:
  $ lexrunner discover                             # Discover PRs from current repo
  $ lexrunner discover --suggest                   # Discover with dependency suggestions
  $ lexrunner discover --json > prs.json           # JSON output for processing
  $ lexrunner discover --owner org --repo project  # Specify repository explicitly
  $ lexrunner discover --state all                 # Include closed PRs

Common Issues:
  • "Could not detect repository": Set GITHUB_TOKEN or run from git repository
  • Rate limit errors: Wait or use authenticated token with higher limits
  • No PRs found: Check --state filter and repository permissions`
    )
    .action(async (opts) => {
      try {
        if (opts.provider === "bitbucket") {
          await runBitbucketDiscovery(opts);
          return;
        }
        if (opts.provider !== "github" || opts.query || opts.target) {
          throw new Error("Unsupported discovery provider or provider-specific filter");
        }
        let githubAPI = await createGitHubAPI();

        // Override with command line options if provided
        if (opts.owner && opts.repo) {
          githubAPI = new GitHubAPI({
            owner: opts.owner,
            repo: opts.repo,
            token: process.env.GITHUB_TOKEN,
          });
        }

        if (!githubAPI) {
          console.error("\n❌ Error: Could not detect GitHub repository\n");
          console.error("Solutions:");
          console.error("  1. Run from a Git repository with GitHub remote:");
          console.error("     git remote -v");
          console.error("\n  2. Specify repository explicitly:");
          console.error("     lexrunner discover --owner <owner> --repo <repo>\n");
          console.error("💡 Tip: Initialize your workspace first:");
          console.error("   lexrunner init\n");
          throwExit(1);
        }
        const resolvedAPI = githubAPI!;

        const result = await new DiscoveryQueryService().run({
          github: resolvedAPI,
          state: opts.state as "open" | "closed" | "all",
          suggest: opts.suggest,
        });
        if (!result.authenticated) {
          console.warn(
            "⚠️  Warning: GitHub API not authenticated. Set GITHUB_TOKEN environment variable for better rate limits.\n\n" +
              "To fix:\n" +
              "  export GITHUB_TOKEN=ghp_...\n\n" +
              "See: https://github.com/Guffawaffle/lexrunner#authentication\n"
          );
        }

        const pullRequests = result.pullRequests;

        if (opts.suggest) {
          const suggestions = result.suggestions as Array<{
            from: string;
            to: string;
            confidence: number;
            heuristic?: string;
            reason: string;
          }>;

          if (opts.json || deps.jsonModeActive()) {
            const { contract: _contract, ...legacyResult } = result;
            console.log(canonicalJSONStringify(legacyResult));
          } else {
            console.log(`🔍 Discovered ${pullRequests.length} ${opts.state} pull requests`);
            if (result.authenticated) {
              console.log(`✓ Authenticated as: ${result.user}`);
            }
            console.log("");

            if (suggestions.length === 0) {
              console.log("No dependency suggestions found.");
            } else {
              console.log(`\n📊 Dependency Suggestions (${suggestions.length} found):\n`);
              console.log("| From | To | Confidence | Heuristic | Reason |");
              console.log("|------|------|------------|-----------|--------|");

              for (const suggestion of suggestions) {
                const confidence = (suggestion.confidence * 100).toFixed(0) + "%";
                const heuristic = suggestion.heuristic || "unknown";
                const reason =
                  suggestion.reason.length > 50
                    ? suggestion.reason.substring(0, 47) + "..."
                    : suggestion.reason;
                console.log(
                  `| ${suggestion.from} | ${suggestion.to} | ${confidence} | ${heuristic} | ${reason} |`
                );
              }
            }
          }
        } else {
          // Original discover output
          if (opts.json || deps.jsonModeActive()) {
            const { contract: _contract, ...legacyResult } = result;
            console.log(canonicalJSONStringify(legacyResult));
          } else {
            console.log(`🔍 Discovered ${pullRequests.length} ${opts.state} pull requests`);
            if (result.authenticated) {
              console.log(`✓ Authenticated as: ${result.user}`);
            }
            console.log("");

            if (pullRequests.length === 0) {
              console.log("No pull requests found.");
            } else {
              console.log("| PR# | Title | Branch | Author | Labels |");
              console.log("|-----|-------|--------|--------|--------|");

              for (const pr of pullRequests) {
                const labels = pr.labels.length > 0 ? pr.labels.join(", ") : "none";
                const title = pr.title.length > 50 ? pr.title.substring(0, 47) + "..." : pr.title;
                console.log(
                  `| #${pr.number} | ${title} | ${pr.branch} | ${pr.author} | ${labels} |`
                );
              }
            }
          }
        }
      } catch (error) {
        if (error instanceof GitHubAPIError) {
          console.error(`GitHub API Error: ${error.message}`);
          throwExit(1);
        }
        console.error(
          `Error discovering pull requests: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        throwExit(1);
      }
    });
}
