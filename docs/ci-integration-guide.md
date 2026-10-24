# CI Integration Guide

This guide explains how to integrate lexrunner with GitHub Actions and other CI systems to automatically import gate results from CI checks.

## Overview

Instead of running gates locally or duplicating them in CI, you can:

1. Run gates in your CI system (GitHub Actions, CircleCI, etc.)
2. Import the results into lexrunner using `gate import-checks`
3. Use the imported results for merge eligibility evaluation

This approach:

- ✅ Avoids duplicate gate execution
- ✅ Leverages CI parallelization and caching
- ✅ Provides audit trail through CI logs
- ✅ Reduces local resource usage

## GitHub Actions Integration

### Step 1: Configure Gate Mapping

Create `.lexrunner/gate-mapping.yaml` to map your GitHub Actions job names to gate names:

```yaml
version: "1.0.0"
mappings:
  # Exact matches
  - pattern: "CI / build"
    gate: build
  - pattern: "CI / test"
    gate: test
  - pattern: "CI / lint"
    gate: lint
  - pattern: "CI / typecheck"
    gate: typecheck

  # Pattern matches with wildcards
  - pattern: "test*"
    gate: test
  - pattern: "*security*"
    gate: vuln
```

### Step 2: Run Gates in GitHub Actions

Example `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  build:
    name: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - run: npm ci
      - run: npm run build

  test:
    name: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - run: npm ci
      - run: npm test

  lint:
    name: lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - run: npm ci
      - run: npm run lint

  typecheck:
    name: typecheck
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - run: npm ci
      - run: npm run typecheck
```

**Important:** Job names in your workflow must match the patterns in your gate mapping configuration.

### Step 3: Import Checks in Merge Workflow

Add a step to import checks in your merge weave workflow:

```yaml
name: Merge Weave

on:
  workflow_dispatch:
    inputs:
      pr_number:
        description: "PR number to merge"
        required: true

jobs:
  merge:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - name: Setup Node.js
        uses: actions/setup-node@v7
        with:
          node-version: 24

      - name: Install lexrunner
        run: npm install -g lexrunner

      - name: Import gate results from CI
        run: |
          lex-pr gate import-checks \
            --ref ${{ github.event.inputs.pr_number }} \
            --item pr-${{ github.event.inputs.pr_number }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Merge weave
        run: lex-pr weave merge --plan merge-plan.json
```

### Step 4: Verify Integration

```bash
# Trigger merge workflow
gh workflow run merge-weave.yml -f pr_number=123

# Check imported results
lex-pr gate report --item pr-123

# Output:
# Gate Results for pr-123
# ✅ build: pass (imported from GitHub)
# ✅ test: pass (imported from GitHub)
# ✅ lint: pass (imported from GitHub)
# ✅ typecheck: pass (imported from GitHub)
```

## Hybrid Mode: Local + Remote Gates

You can run some gates locally and import others from CI:

```bash
# Run critical gates locally for fast feedback
lex-pr gate execute --gates lint,typecheck

# Import expensive gates from CI
lex-pr gate import-checks --ref $PR_NUMBER

# Both results are available for merge eligibility
lex-pr weave status
```

### Example Configuration

In your `plan.json`, specify which gates should run locally vs. remotely:

<!-- lexrunner-plan-example:ci-runtime-gates -->

```json
{
  "schemaVersion": "1.0.0",
  "target": "main",
  "items": [
    {
      "name": "pr-123",
      "gates": [
        {
          "name": "lint",
          "run": "npm run lint",
          "runtime": "local"
        },
        {
          "name": "test",
          "run": "echo 'Import from CI'",
          "runtime": "ci-service"
        }
      ]
    }
  ],
  "policy": {
    "requiredGates": ["lint", "test"]
  }
}
```

## Common Patterns

### Pattern 1: Import All Checks

Import all CI checks and let gate mapping determine which to use:

```bash
lex-pr gate import-checks --ref $COMMIT_SHA
```

### Pattern 2: Selective Import

Only import specific checks by configuring gate mapping to include only desired patterns:

```yaml
mappings:
  - pattern: "CI / test"
    gate: test
  # Other checks are ignored
```

### Pattern 3: Multi-Branch Integration

Import checks from different branches:

```bash
# Import from feature branch
lex-pr gate import-checks --ref feature/new-feature --item feature-branch

# Import from main branch
lex-pr gate import-checks --ref main --item main-branch
```

## Troubleshooting

### Check Runs Not Found

**Problem:** `No completed check runs found`

**Solutions:**

1. Verify the commit SHA or PR number is correct
2. Check that CI workflows have completed
3. Ensure GITHUB_TOKEN has permission to read checks

```bash
# Debug: List check runs
gh api repos/{owner}/{repo}/commits/{sha}/check-runs
```

### Checks Not Mapped

**Problem:** `No check runs matched gate mappings`

**Solutions:**

1. Verify job names in GitHub Actions workflow
2. Check gate mapping patterns
3. Use `--create-mapping` to see default patterns

```bash
# Create default mapping as reference
lex-pr gate import-checks --create-mapping

# View your workflow job names
gh run list --workflow=ci.yml
```

### Permission Denied

**Problem:** `GitHub authentication failed`

**Solutions:**

1. Set GITHUB_TOKEN environment variable
2. Use `--token` flag
3. Verify token has `repo` scope

```bash
# Set token
export GITHUB_TOKEN=ghp_xxx

# Or pass directly
lex-pr gate import-checks --ref 123 --token $GITHUB_TOKEN
```

## Best Practices

### 1. Use Descriptive Job Names

Match job names to gate names for clarity:

```yaml
# Good: Clear gate name
jobs:
  build:
    name: build

# Avoid: Ambiguous names
jobs:
  job1:
    name: "Build Step 1"
```

### 2. Separate Fast and Slow Gates

Run fast gates locally for quick feedback, import slow gates from CI:

```bash
# Fast feedback loop
lex-pr gate execute --gates lint,typecheck  # ~10s

# Import slow gates from CI
lex-pr gate import-checks --ref $PR  # test, e2e (~5m)
```

### 3. Version Gate Mappings

Track gate mapping changes in version control:

```bash
git add .lexrunner/gate-mapping.yaml
git commit -m "Add security-scan gate mapping"
```

### 4. Validate Mappings in CI

Add a step to validate gate mappings in CI:

```yaml
- name: Validate gate mappings
  run: |
    # Check that all CI jobs have mappings
    lex-pr gate import-checks --ref ${{ github.sha }} --dry-run
```

## Advanced: Custom CI Systems

For CI systems other than GitHub Actions, you can:

1. Export check results to JSON
2. Convert to gate report format
3. Use `lex-pr gate import` to import

Example for CircleCI:

```bash
# Export CircleCI results
circleci tests results --format json > results.json

# Convert to gate report format (custom script)
./scripts/convert-circleci-to-gate-report.sh results.json

# Import
lex-pr gate import --input gate-report.json
```

## Related Documentation

- [Gates](./gates.md) - Gate execution and validation
- [GitHub Automation](./github-automation.md) - GitHub API integration
- [Merge Weave](../MERGE_WEAVE_SUMMARY.md) - Merge weave workflow
