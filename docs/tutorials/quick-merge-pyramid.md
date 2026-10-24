# Quick Tutorial: Merge Pyramid Workflow

This tutorial walks you through the complete lexrunner workflow: **discover → plan → execute → merge**. You'll learn how to manage multiple PRs as a cohesive merge pyramid.

**Time to complete:** ~10 minutes

## Prerequisites

- Node.js 24+ installed
- Git configured with your name and email
- A GitHub repository with open PRs (or use our sample)
- GitHub token (optional but recommended for discovery)

## Step 1: Discover Open PRs

First, discover what PRs are available to merge:

```bash
# Discover PRs from GitHub
lex-pr discover --owner myorg --repo myrepo

# Or use environment variable
export GITHUB_TOKEN=your_token_here
lex-pr discover
```

**What you'll see:**

- List of open PRs
- PR titles, numbers, and labels
- Dependency hints from PR descriptions

**Example output:**

```
🔍 Discovering open PRs...
Found 3 PRs:
  #42: Add authentication system [ready-to-merge]
  #43: Add API endpoints [stack:auth]
  #44: Add dashboard UI [stack:api]
```

## Step 2: Generate a Plan

Create a merge plan from discovered PRs:

```bash
# Generate plan from GitHub PRs
lex-pr plan --from-github

# Or generate from workspace configuration
lex-pr plan
```

The planner will:

1. Parse PR dependencies from descriptions (e.g., "Depends-On: #42")
2. Detect dependency cycles and validate relationships
3. Compute merge order using topological sort
4. Generate `plan.json` with deterministic output

**Plan structure:**

<!-- lexrunner-plan-example:quick-merge-pyramid-generated -->

```json
{
  "schemaVersion": "1.0.1",
  "target": "main",
  "items": [
    {
      "name": "PR-42",
      "deps": [],
      "gates": []
    },
    {
      "name": "PR-43",
      "deps": ["PR-42"],
      "gates": []
    },
    {
      "name": "PR-44",
      "deps": ["PR-43"],
      "gates": []
    }
  ],
  "gitInputs": {
    "schemaVersion": "1.0.0",
    "repository": "https://github.com/example/repository.git",
    "checkoutRemote": "origin",
    "acquisition": "fetch",
    "target": {
      "ref": "refs/heads/main",
      "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    "sources": [
      {
        "item": "PR-42",
        "ref": "refs/pull/42/head",
        "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      },
      {
        "item": "PR-43",
        "ref": "refs/pull/43/head",
        "commit": "cccccccccccccccccccccccccccccccccccccccc"
      },
      {
        "item": "PR-44",
        "ref": "refs/pull/44/head",
        "commit": "dddddddddddddddddddddddddddddddddddddddd"
      }
    ]
  }
}
```

## Step 3: Review the Merge Order

Verify the computed dependency levels:

```bash
# Show merge order
lex-pr merge-order plan.json
```

**Example output:**

```
📊 Merge order for 3 items:

Level 0 (no dependencies):
  → PR-42

Level 1 (depends on Level 0):
  → PR-43

Level 2 (depends on Level 1):
  → PR-44
```

**Understanding levels:**

- **Level 0**: Independent PRs, can merge first
- **Level 1+**: PRs with dependencies, merge after prerequisites
- Items at the same level can be processed in parallel

## Step 4: Execute Quality Gates

Run quality gates before merging:

```bash
# Execute gates for all items in plan
lex-pr execute plan.json

# Or use --plan flag
lex-pr execute --plan plan.json

# Dry run to preview
lex-pr execute plan.json --dry-run
```

**What happens:**

1. Gates run in dependency order (Level 0 → Level 1 → ...)
2. Each item's gates must pass before proceeding
3. Results saved to `.smartergpt/runner/gate-results/`
4. Exit code 0 if all gates pass, 1 if any fail

**Gate result example:**

```json
{
  "item": "auth-system",
  "gate": "test",
  "status": "pass",
  "duration_ms": 1234,
  "started_at": "2024-01-15T10:30:00Z"
}
```

## Step 5: Check Merge Eligibility

Review which PRs are ready to merge:

```bash
# Show merge status
lex-pr status plan.json
```

**Example output:**

```
✅ Eligible for merge:
  → auth-system (all gates passed)

⏳ Waiting:
  → api-endpoints (gates pending)
  → dashboard-ui (dependencies not merged)

❌ Blocked:
  (none)
```

## Step 6: Execute the Merge

Merge PRs in the computed order:

```bash
# Preview merge operations (dry run is default)
lex-pr merge --plan plan.json

# Execute merge (requires --execute flag)
lex-pr merge --plan plan.json --execute
```

The final Plan Schema does not contain a per-item merge strategy. Do not add `strategy` fields to
Plan items; synthesis configuration and execution options are separate contracts.

**What happens:**

1. Merges items in dependency order (Level 0 first)
2. Waits for each level to complete before proceeding
3. Updates local and remote branches
4. Records merge results

## Step 7: Verify Success

Check that everything merged successfully:

```bash
# Final status check
lex-pr status plan.json

# View aggregated gate reports
lex-pr report .smartergpt/runner/gate-results --out md
```

## Complete Example Workflow

Here's the full workflow in one script:

```bash
#!/bin/bash
set -e

# 1. Discover PRs
echo "🔍 Discovering PRs..."
lex-pr discover --owner myorg --repo myrepo

# 2. Generate plan
echo "📋 Generating plan..."
lex-pr plan --from-github

# 3. Review merge order
echo "📊 Reviewing merge order..."
lex-pr merge-order plan.json

# 4. Execute gates
echo "🚦 Running quality gates..."
lex-pr execute plan.json

# 5. Check eligibility
echo "✅ Checking merge eligibility..."
lex-pr status plan.json

# 6. Dry run merge (default behavior)
echo "🔍 Previewing merge..."
lex-pr merge --plan plan.json

# 7. Execute merge
echo "🚀 Executing merge..."
lex-pr merge --plan plan.json --execute

# 8. Verify success
echo "✓ Verifying results..."
lex-pr status plan.json

echo "✨ Merge pyramid complete!"
```

## Tips and Best Practices

### Dependency Management

**In PR descriptions**, use dependency syntax:

```markdown
Depends-On: #42
Depends-On: #43, #44
```

**In `stack.yml`**, use explicit deps:

```yaml
items:
  - id: api-endpoints
    deps: ["auth-system"] # References item name
```

### Gate Configuration

Create `.smartergpt/gates.yml`:

```yaml
gates:
  - name: lint
    run: npm run lint
  - name: test
    run: npm test
  - name: security
    run: npm audit
    required: true
```

### Parallel Execution

Items at the same dependency level can run in parallel. Parallelism is controlled by the `--max-workers` setting during plan generation:

```bash
# Configure max parallel workers during plan generation
lex-pr plan --from-github --max-workers 3

# Items execute in parallel according to:
# 1. Dependency level (items at same level can run in parallel)
# 2. Max workers limit from the plan
# Note: Gates within each item run sequentially, but multiple items can execute concurrently
lex-pr execute plan.json
```

### Error Recovery

If a gate fails:

```bash
# Fix the issue in your code, then re-run gates
lex-pr execute plan.json

# Gates are defined in .smartergpt/gates.yml
# Individual gate re-runs are handled by fixing code and re-executing
```

## Common Patterns

### Pattern 1: Feature Stack

Branch: `feat/auth` → `feat/api` → `feat/ui`

1. Each PR builds on the previous
2. Dependencies form a linear chain
3. Merge in strict order

### Pattern 2: Parallel Features

Branches: `feat/auth`, `feat/logging`, `feat/config` (independent)

1. No dependencies between PRs
2. All at Level 0
3. Can merge in any order or parallel

### Pattern 3: Diamond Dependencies

```
      feat/ui
     /        \
feat/auth   feat/api
     \        /
      main
```

1. `feat/ui` depends on both `feat/auth` and `feat/api`
2. Auth and API can merge in parallel (both Level 0)
3. UI merges last (Level 1)

## Next Steps

- **Advanced workflows**: See [docs/workflows/](../workflows/) for team-specific examples
- **CI/CD integration**: See [docs/integrations/](../integrations/) for GitHub Actions setup
- **Troubleshooting**: See [docs/troubleshooting.md](../troubleshooting.md) for common issues
- **Interactive review**: Try `lex-pr plan-review plan.json` for guided validation

## Related Documentation

- [Quickstart Guide](../quickstart.md) - Initial setup and configuration
- [CLI Reference](../cli.md) - Complete command documentation
- [Architecture Overview](../architecture.md) - System design and concepts
- [Issue #134](https://github.com/Guffawaffle/LexRunner/issues/134) - Contributor onboarding and adoption tracking
