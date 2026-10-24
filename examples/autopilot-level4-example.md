# Autopilot Level 4 Example

This example demonstrates how to use Level 4 autopilot for fully automated merge-weave execution.

## Prerequisites

- GitHub repository with open PRs
- GitHub token with appropriate permissions
- Local profile configured (not example profile)

## Step-by-Step Guide

### 1. Initialize Local Profile

```bash
# Create writable local profile
lex-pr init-local
```

### 2. Create a Merge Plan

```bash
# Generate plan from GitHub PRs
lex-pr plan --from-github --out plan.json
```

Or save this manual plan as `plan.json`:

<!-- lexrunner-plan-example:autopilot-level4-manual -->

```json
{
  "schemaVersion": "1.0.0",
  "target": "main",
  "items": [
    {
      "name": "PR-101",
      "deps": [],
      "gates": [
        { "name": "lint", "run": "npm run lint", "env": {} },
        { "name": "test", "run": "npm test", "env": {} }
      ]
    },
    {
      "name": "PR-102",
      "deps": ["PR-101"],
      "gates": [{ "name": "lint", "run": "npm run lint", "env": {} }]
    }
  ]
}
```

### 3. Test at Lower Levels First

**Level 0 - Report Only:**

```bash
# Safe dry-run to validate plan
lex-pr execute plan.json --max-level 0
```

**Level 1 - Artifact Generation:**

```bash
# Generate artifacts for review
lex-pr execute plan.json --max-level 1
```

**Level 2 - PR Annotations:**

```bash
# Post status comments (requires GITHUB_TOKEN)
export GITHUB_TOKEN=ghp_xxxxx
lex-pr execute plan.json --max-level 2 --execute
```

**Level 3 - Integration Branches:**

```bash
# Create integration branch and run gates
lex-pr execute plan.json --max-level 3 --execute \
  --branch-prefix "integration/"
```

### 4. Run Level 4 - Full Automation

```bash
# Full automation with all features
export GITHUB_TOKEN=ghp_xxxxx
export LEX_CLOSE_SUPERSEDED=true

lex-pr execute plan.json \
  --max-level 4 \
  --execute \
  --branch-prefix "weave/" \
  --close-superseded
```

## What Level 4 Does

1. **Executes Level 3**: Creates integration branch, merges PRs, runs gates
2. **Merges Integration Branch**: Merges validated integration branch to target (e.g., `main`)
3. **Closes Superseded PRs**: Closes source PRs with finalization comments (if `--close-superseded`)
4. **Posts Finalization Comments**: Adds completion comments with merge details
5. **Cleans Up**: Deletes integration branch after successful merge
6. **Rollback on Failure**: Reverts failed merge and preserves integration branch for debugging

## Configuration Options

### Environment Variables

- `GITHUB_TOKEN`: GitHub API token for PR operations
- `LEX_CLOSE_SUPERSEDED`: Set to `true` to close PRs after merge
- `LEX_BRANCH_PREFIX`: Custom prefix for integration branches (default: `integration/`)

### CLI Flags

- `--max-level 4`: Enable Level 4 autopilot
- `--execute`: Actually perform operations (required for write operations)
- `--close-superseded`: Close source PRs after successful integration
- `--branch-prefix <prefix>`: Custom integration branch prefix
- `--dry-run`: Preview operations without execution (default: true)

## Safety Notes

⚠️ **Important Safety Guidelines:**

1. **Always test at lower levels first** (0 → 1 → 2 → 3 → 4)
2. **Use dry-run mode** to preview operations: `--dry-run`
3. **Review Level 3 results** before proceeding to Level 4
4. **Ensure proper permissions** are set on GitHub repository
5. **Have rollback plan** in case of issues
6. **Monitor closely** during first Level 4 runs

## Rollback

If Level 4 fails:

1. Integration branch is preserved for debugging
2. Failed merge is automatically reverted
3. Source PRs remain open (unless already closed)
4. Check logs for failure details

To manually rollback:

```bash
# List integration branches
git branch -a | grep integration/

# Inspect failed integration branch
git checkout integration/2025-01-02T10-30-00-abc123def

# Review what went wrong
git log
git diff main
```

## Monitoring

Check autopilot status:

```bash
# View deliverables
ls -la .smartergpt.local/deliverables/

# Check latest weave report
cat .smartergpt.local/deliverables/weave-*/weave-report.md

# Review gate results
cat .smartergpt.local/deliverables/weave-*/gate-predictions.json
```

## Troubleshooting

### "Not on integration branch - cannot finalize"

Level 3 must complete successfully before Level 4 runs. Check:

1. Integration branch was created
2. All merges succeeded
3. All gates passed

### "GitHub API error"

Ensure:

1. `GITHUB_TOKEN` is set and valid
2. Token has required permissions (contents: write, pull_requests: write)
3. Repository is accessible

### "Git repository is not clean"

Commit or stash local changes before running autopilot:

```bash
git status
git stash
# or
git commit -am "WIP"
```

## Example Output

Successful Level 4 execution:

```
Level 3: Creating integration branch: weave/2025-01-02T10-30-00-abc123def
Level 3: Successfully created branch: weave/2025-01-02T10-30-00-abc123def
Level 3: Executing merge weave with 2 levels
Level 3: Merge weave complete - 2 succeeded, 0 failed, 0 conflicts
Level 3: Executing gates on integration branch
Level 3: Gate execution complete - 3 passed, 0 failed

Level 4: Starting finalization workflow
Level 4: Merging weave/2025-01-02T10-30-00-abc123def to main
Level 4: Successfully merged to main
Level 4: Closing superseded PRs
Level 4: Closed PR #101
Level 4: Closed PR #102
Level 4: Cleaning up integration branch weave/2025-01-02T10-30-00-abc123def

Level 4: Full automation complete ✅
  • Merged to: main
  • Merge SHA: a1b2c3d4
  • Closed PRs: 2
  • Cleaned up: weave/2025-01-02T10-30-00-abc123def

Merge-weave execution complete! 🎉
```

## See Also

- [Autopilot Levels Documentation](../docs/autopilot-levels.md)
- [Autopilot Guide](../docs/autopilot.md)
- [CLI Reference](../docs/cli.md)
