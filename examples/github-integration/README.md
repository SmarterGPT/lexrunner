# GitHub Integration Examples

This directory contains examples of using the GitHub API integration.

## Basic Usage

### Auto-discover PRs from GitHub

```bash
# Discover all open PRs
lex-pr plan --from-github

# Filter by labels
lex-pr plan --from-github --labels "stack:feature,enhancement"

# Use GitHub search query
lex-pr plan --from-github --query "is:open label:stack:* -label:WIP"

# Include draft PRs
lex-pr plan --from-github --include-drafts
```

### Output Options

```bash
# Generate artifacts (plan.json + snapshot.md)
lex-pr plan --from-github --out ./artifacts

# JSON output only
lex-pr plan --from-github --json > integration-plan.json

# Dry run - validate without writing files
lex-pr plan --from-github --dry-run
```

## PR Dependency Declaration

Add dependency footers to PR descriptions:

```markdown
## PR Description

This feature implements the user authentication system.

Depends-on: #123, #456
Required-gates: lint, test, security-scan

## Implementation Details

...
```

## Environment Setup

Set GitHub authentication:

```bash
export GITHUB_TOKEN="ghp_your_token_here"
# or
export GH_TOKEN="ghp_your_token_here"
```

Or pass token directly:

```bash
lex-pr plan --from-github --github-token "ghp_your_token_here"
```

## Generated Plan Structure

The generated `plan.json` has this general structure. This is an abridged, non-executable display:
the ellipsis omits gates, and current GitHub-generated plans use Schema `1.0.1` with complete
`gitInputs` bindings as shown in [Frozen Git inputs](../../docs/frozen-git-inputs.md).

<!-- lexrunner-non-executable-plan:github-generated-plan-abridged -->

```json
{
  "schemaVersion": "1.0.1",
  "target": "main",
  "policy": {
    "requiredGates": ["lint", "typecheck", "test"],
    "maxWorkers": 2,
    "optionalGates": [],
    "retries": {},
    "overrides": {},
    "blockOn": [],
    "mergeRule": { "type": "strict-required" }
  },
  "items": [
    {
      "name": "PR-123",
      "deps": [],
      "gates": [
        {
          "name": "lint",
          "run": "npm run lint",
          "env": {
            "PR_NUMBER": "123",
            "PR_BRANCH": "feature-auth",
            "PR_SHA": "abc123def"
          },
          "runtime": "local",
          "artifacts": ["lint-results.txt"]
        }
      ]
    },
    {
      "name": "PR-456",
      "deps": ["PR-123"],
      "gates": [...]
    }
  ]
}
```
