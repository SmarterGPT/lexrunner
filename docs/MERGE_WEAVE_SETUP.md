# Merge-Weave Setup Guide for Lex Ecosystem Repos

This guide explains how to set up and use LexRunner's merge-weave functionality in any Lex ecosystem repository (lex, lexsona, lex-pr-runner, etc.).

## Overview

LexRunner provides a powerful merge-weave CLI (`lex-pr merge`) that can:

- **Discover PRs** from GitHub using labels/queries
- **Compute merge order** based on dependencies
- **Run validation gates** (lint, typecheck, tests) before merging
- **Execute merge pyramid** with conflict detection and resolution
- **Create umbrella branches** automatically
- **Resume from failures** with state management
- **Track metrics** (Turn Cost, coordination overhead)

## Installation Options

### Option 1: Local Development Install (Recommended)

Clone LexRunner locally and link it for development:

```bash
# Clone LexRunner
git clone https://github.com/Guffawaffle/LexRunner.git
cd LexRunner

# Install dependencies and build
npm ci
npm run build

# Link globally for use in other repos
npm link

# In your other repo (lex, lexsona, etc.)
cd /path/to/your/repo
npm link lexrunner

# Now you can use lex-pr command
lex-pr merge --help
```

### Option 2: Direct from GitHub (npx)

Use `npx` to run without installation:

```bash
# In your repo directory
npx github:Guffawaffle/LexRunner merge --plan plan.json --dry-run
```

**Note**: This requires the repo to be built and committed, which may not always be current.

### Option 3: Add as Dev Dependency

Add to your repo's `package.json`:

```json
{
  "devDependencies": {
    "lexrunner": "github:Guffawaffle/LexRunner#main"
  },
  "scripts": {
    "merge-weave": "lex-pr merge",
    "merge-weave:dry-run": "lex-pr merge --dry-run",
    "merge-weave:execute": "lex-pr merge --execute"
  }
}
```

Then install:

```bash
npm install
npm run merge-weave -- --help
```

## Workspace Setup

Each repo needs a minimal LexRunner workspace profile. Create the following structure:

```
your-repo/
├── .smartergpt/              # LexRunner workspace profile
│   ├── intent.md             # Project goals and constraints
│   ├── scope.yml             # Scope configuration
│   ├── deps.yml              # Dependency mapping
│   ├── gates.yml             # Gate definitions
│   └── pull-request-template.md  # PR template
├── plan.json                 # Merge-weave plan (or generate from GitHub)
└── .gitignore                # Ignore runner artifacts
```

### Minimal Configuration

#### `.smartergpt/gates.yml`

Define validation gates for your project:

```yaml
gates:
  - name: lint
    run: npm run lint
    required: true

  - name: typecheck
    run: npm run typecheck
    required: true

  - name: test
    run: npm test
    required: false # Optional for merge-weave
```

#### `.smartergpt/scope.yml`

Define project scope:

```yaml
schemaVersion: "1.0.0"
scope:
  areas:
    - cli
    - core
    - docs
  boundaries:
    - "Do not modify third-party dependencies without explicit request"
    - "Keep changes minimal and focused"
```

#### `.gitignore` additions

Add to your `.gitignore`:

```gitignore
# LexRunner artifacts
.smartergpt.local/
.smartergpt/runner/
weave-lock.json
artifacts/
audit/
```

## Usage Workflows

### Workflow 1: Merge Multiple PRs (Automatic Discovery)

```bash
# Step 1: Discover open PRs with a specific label
lex-pr discover \
  --owner YourOrg \
  --repo your-repo \
  --labels "ready-to-merge" \
  --output plan.json

# Step 2: Preview the merge plan (dry-run)
lex-pr merge --plan plan.json --dry-run

# Step 3: Execute the merge
lex-pr merge --plan plan.json --execute
```

### Workflow 2: Merge Specific PRs (Manual Plan)

Create `plan.json` manually:

<!-- lexrunner-plan-example:merge-weave-setup-manual -->

```json
{
  "schemaVersion": "1.0.0",
  "target": "main",
  "policy": {
    "requiredGates": ["lint", "typecheck"],
    "mergeRule": { "type": "strict-required" }
  },
  "items": [
    {
      "name": "feature/a",
      "deps": [],
      "gates": [
        { "name": "lint", "run": "npm run lint" },
        { "name": "typecheck", "run": "npm run typecheck" }
      ]
    },
    {
      "name": "feature/b",
      "deps": [],
      "gates": [
        { "name": "lint", "run": "npm run lint" },
        { "name": "typecheck", "run": "npm run typecheck" }
      ]
    }
  ]
}
```

Then execute:

```bash
lex-pr merge --plan plan.json --execute
```

### Workflow 3: Merge with Conflict Resolution

```bash
# Dry-run with preflight conflict detection
lex-pr merge --plan plan.json --dry-run

# If conflicts are detected, choose resolution strategy:
# Option A: Minimal-hunk (AI-powered, default)
lex-pr merge --plan plan.json --execute --resolve-policy minimal-hunk

# Option B: Accept current branch (use with caution)
lex-pr merge --plan plan.json --execute --resolve-policy ours

# Option C: Accept incoming branch (use with caution)
lex-pr merge --plan plan.json --execute --resolve-policy theirs
```

### Workflow 4: Resume After Failure

```bash
# If merge fails mid-execution, resume from last successful state
lex-pr merge --resume

# Or resume a specific run by ID
lex-pr merge --resume abc123de
```

## Convenience Scripts

Create a `scripts/merge-weave.sh` wrapper in your repo:

```bash
#!/usr/bin/env bash
# Convenience wrapper for merge-weave operations

set -e

PLAN_FILE="${1:-plan.json}"
MODE="${2:-dry-run}"

case "$MODE" in
  dry-run)
    echo "🔍 Previewing merge operations..."
    lex-pr merge --plan "$PLAN_FILE" --dry-run --json
    ;;

  execute)
    echo "🚀 Executing merge pyramid..."
    lex-pr merge --plan "$PLAN_FILE" --execute --json
    ;;

  discover)
    echo "📋 Discovering PRs from GitHub..."
    OWNER="${GITHUB_OWNER:-$(git remote get-url origin | sed -E 's|.*github.com[:/]([^/]+)/.*|\1|')}"
    REPO="${GITHUB_REPO:-$(basename $(git remote get-url origin) .git)}"

    lex-pr discover \
      --owner "$OWNER" \
      --repo "$REPO" \
      --labels "ready-to-merge" \
      --output "$PLAN_FILE"

    echo "✅ Plan generated: $PLAN_FILE"
    ;;

  *)
    echo "Usage: $0 [plan.json] [dry-run|execute|discover]"
    exit 1
    ;;
esac
```

Make it executable:

```bash
chmod +x scripts/merge-weave.sh
```

Usage:

```bash
# Discover PRs and generate plan
./scripts/merge-weave.sh plan.json discover

# Preview merge
./scripts/merge-weave.sh plan.json dry-run

# Execute merge
./scripts/merge-weave.sh plan.json execute
```

## Repository-Specific Examples

### Example: lex repository

```bash
# In lex repo root
cd /path/to/lex

# Discover PRs labeled "merge-ready"
lex-pr discover \
  --owner Guffawaffle \
  --repo lex \
  --labels "merge-ready" \
  --base main \
  --output plan.json

# Execute merge with frame emission for observability
lex-pr merge \
  --plan plan.json \
  --execute \
  --emit-frames \
  --track-turncost
```

### Example: lexsona repository

In the LexSona repository root, save this as `plan.json`:

<!-- lexrunner-plan-example:merge-weave-setup-lexsona -->

```json
{
  "schemaVersion": "1.0.0",
  "target": "main",
  "policy": {
    "requiredGates": ["lint", "typecheck"]
  },
  "items": [
    {
      "name": "feature/governance-v2",
      "deps": [],
      "gates": [
        { "name": "lint", "run": "npm run lint" },
        { "name": "typecheck", "run": "npm run typecheck" }
      ]
    }
  ]
}
```

```bash
# Execute with cleanup
lex-pr merge --plan plan.json --execute --cleanup
```

### Example: lex-pr-runner repository

```bash
# In lex-pr-runner repo root (this is LexRunner itself!)
cd /path/to/LexRunner

# Use the existing dogfood script
./scripts/dogfood-merge-weave.sh \
  --from-github \
  --owner Guffawaffle \
  --repo LexRunner \
  --labels "ready-to-merge" \
  --execute
```

## Common Flags Reference

| Flag                           | Description                                           | Example                         |
| ------------------------------ | ----------------------------------------------------- | ------------------------------- |
| `--plan <file>`                | Path to plan.json                                     | `--plan ./plans/wave1.json`     |
| `--dry-run`                    | Preview without executing (default)                   | `--dry-run`                     |
| `--execute`                    | Actually perform merge operations                     | `--execute`                     |
| `--cleanup`                    | Remove integration branches after success             | `--cleanup`                     |
| `--force`                      | Override lock hash check                              | `--force`                       |
| `--resume [runId]`             | Resume from failure                                   | `--resume` or `--resume abc123` |
| `--json`                       | Output JSON format                                    | `--json`                        |
| `--skip-preflight`             | Skip conflict detection                               | `--skip-preflight`              |
| `--fail-on-preflight-conflict` | Abort if conflicts detected                           | `--fail-on-preflight-conflict`  |
| `--track-turncost`             | Track coordination overhead metrics                   | `--track-turncost`              |
| `--resolve-policy <policy>`    | Conflict resolution: `minimal-hunk`, `ours`, `theirs` | `--resolve-policy ours`         |
| `--branch-prefix <prefix>`     | Integration branch name prefix                        | `--branch-prefix integration/`  |

## Conflict Resolution Strategies

### minimal-hunk (Default, Recommended)

AI-powered conflict resolution that:

- Identifies precise conflict boundaries
- Merges both sides intelligently
- Preserves intent from both branches
- Falls back to manual resolution if unsure

```bash
lex-pr merge --execute --resolve-policy minimal-hunk
```

### ours (Use with Caution)

Accepts all changes from current branch, discarding incoming:

```bash
lex-pr merge --execute --resolve-policy ours
```

**When to use**: Reverting unwanted changes, emergency rollbacks

### theirs (Use with Caution)

Accepts all changes from incoming branch, discarding current:

```bash
lex-pr merge --execute --resolve-policy theirs
```

**When to use**: Force-accepting external updates, dependency upgrades

## Troubleshooting

### Issue: "Working directory is not clean"

**Cause**: Uncommitted changes in working tree

**Solution**:

```bash
# Option 1: Commit changes
git add .
git commit -m "WIP: Save work before merge-weave"

# Option 2: Stash changes
git stash

# Run merge-weave
lex-pr merge --execute

# Restore stash
git stash pop
```

### Issue: "Plan file not found"

**Cause**: Missing plan.json

**Solution**:

```bash
# Generate from GitHub
lex-pr discover --owner YourOrg --repo your-repo --output plan.json

# Or create manually (see examples above)
```

### Issue: "Branch not found"

**Cause**: Branch name in plan doesn't match remote

**Solution**:

```bash
# List remote branches
git branch -r

# Update plan.json with correct branch names
```

### Issue: "Lock hash mismatch"

**Cause**: PR heads changed since last run

**Solution**:

```bash
# Remove lock file
rm weave-lock.json

# Or force re-execution
lex-pr merge --execute --force
```

## Advanced Features

### Turn Cost Tracking

Measure coordination overhead:

```bash
lex-pr merge --execute --track-turncost
```

Outputs metrics:

- **Latency**: Time spent waiting
- **Renegotiation**: Number of conflicts
- **Attention Switches**: Context switches between PRs
- **Weighted Score**: Overall coordination cost

### Frame Emission

Enable observability:

```bash
lex-pr merge --execute --emit-frames
```

Emits execution frames for:

- State transitions
- Batch processing
- Conflict detection
- Gate validation

### Autopilot Levels

Automate PR management:

```bash
# Level 0: Report only (default)
lex-pr merge --max-level 0

# Level 1: Generate deliverables
lex-pr merge --max-level 1

# Level 2: Add PR comments
lex-pr merge --max-level 2

# Level 3: Create integration PRs
lex-pr merge --max-level 3 --open-pr

# Level 4: Auto-merge and cleanup
lex-pr merge --max-level 4 --open-pr --close-superseded
```

## Integration with CI/CD

### GitHub Actions Example

```yaml
name: Merge-Weave

on:
  workflow_dispatch:
    inputs:
      plan_file:
        description: "Path to plan.json"
        required: true
        default: "plan.json"

jobs:
  merge-weave:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0 # Need full history

      - uses: actions/setup-node@v7
        with:
          node-version: "24"

      - name: Install LexRunner
        run: |
          git clone https://github.com/Guffawaffle/LexRunner.git /tmp/lexrunner
          cd /tmp/lexrunner
          npm ci
          npm run build
          npm link

      - name: Run merge-weave
        run: |
          lex-pr merge --plan ${{ inputs.plan_file }} --execute --json
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## Best Practices

1. **Always dry-run first**:

   ```bash
   lex-pr merge --dry-run
   ```

2. **Use preflight conflict detection**:

   ```bash
   lex-pr merge --fail-on-preflight-conflict
   ```

3. **Track metrics for large merges**:

   ```bash
   lex-pr merge --execute --track-turncost
   ```

4. **Enable cleanup for successful merges**:

   ```bash
   lex-pr merge --execute --cleanup
   ```

5. **Version control your plans**:

   ```bash
   git add plan.json
   git commit -m "Add merge-weave plan for wave 1"
   ```

6. **Document conflict resolution choices**:
   ```bash
   # In PR description or commit message
   echo "Used --resolve-policy ours for dependency conflicts" >> merge-notes.md
   ```

## Support and Resources

- **LexRunner Repository**: https://github.com/Guffawaffle/LexRunner
- **Full CLI Reference**: [docs/cli.md](./cli.md)
- **Merge-Weave Quickstart**: [docs/merge-weave-quickstart.md](./merge-weave-quickstart.md)
- **State Machine Documentation**: [docs/merge-weave-state-machine.md](./merge-weave-state-machine.md)
- **Plan Schema Reference**: [docs/schemas.md](./schemas.md)

## Quick Reference Card

```bash
# Common workflows
lex-pr discover --owner Org --repo repo --output plan.json  # Discover PRs
lex-pr merge --dry-run                                      # Preview
lex-pr merge --execute                                      # Execute
lex-pr merge --resume                                       # Resume
lex-pr merge --execute --cleanup                            # Execute + cleanup

# Conflict resolution
lex-pr merge --execute --resolve-policy minimal-hunk        # AI-powered (default)
lex-pr merge --execute --resolve-policy ours                # Accept current
lex-pr merge --execute --resolve-policy theirs              # Accept incoming

# Advanced
lex-pr merge --execute --track-turncost                     # Track metrics
lex-pr merge --execute --emit-frames                        # Observability
lex-pr merge --execute --fail-on-preflight-conflict         # Strict validation
```
