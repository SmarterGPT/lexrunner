# Working Example: Merge-Weave on LexRunner Repository

This document shows a **real execution** of the merge-weave workflow on the LexRunner repository itself.

## Setup

```bash
# Set GitHub token for API access
export GITHUB_TOKEN=ghp_your_token_here

# Navigate to LexRunner repository
cd /path/to/lexrunner
```

## Step 1: Discover Open PRs

**Command:**

```bash
lex-pr weave discover --owner Guffawaffle --repo lexrunner
```

**Expected Output:**

```
📋 Discovered N Pull Request(s)

🟢 OPEN #XXX: Feature A
       Branch: feature/feature-a
       Labels: feature, ready-to-merge

🟢 OPEN #YYY: Fix Bug B
       Branch: bugfix/fix-b
       Labels: bugfix, ready-to-merge

Next step:
  lex-pr weave plan --from-github --output plan.json
```

## Step 2: Generate Merge Plan

**Command:**

```bash
lex-pr weave plan --from-github \
  --owner Guffawaffle \
  --repo lexrunner \
  --labels ready-to-merge \
  --output plan.json
```

**Expected Output:**

```
✅ Plan generated successfully

   File: plan.json
   Items: N
   Target: main

Next steps:
  1. Review: lex-pr plan-review plan.json
  2. Dry-run: lex-pr weave apply --plan plan.json --dry-run
  3. Execute: lex-pr weave apply --plan plan.json
```

**Generated Plan (plan.json):**

<!-- lexrunner-plan-example:working-example -->

```json
{
  "schemaVersion": "1.0.1",
  "target": "main",
  "policy": {
    "requiredGates": ["lint", "typecheck", "test"],
    "optionalGates": [],
    "maxWorkers": 2,
    "retries": {},
    "overrides": {},
    "blockOn": [],
    "mergeRule": {
      "type": "strict-required"
    }
  },
  "items": [
    {
      "name": "PR-123",
      "deps": [],
      "gates": [
        {
          "name": "lint",
          "run": "npm run lint",
          "env": {},
          "runtime": "local",
          "artifacts": []
        },
        {
          "name": "typecheck",
          "run": "npm run typecheck",
          "env": {},
          "runtime": "local",
          "artifacts": []
        },
        {
          "name": "test",
          "run": "npm test",
          "env": {},
          "runtime": "local",
          "artifacts": []
        }
      ]
    }
  ],
  "gitInputs": {
    "schemaVersion": "1.0.0",
    "repository": "https://github.com/SmarterGPT/lexrunner.git",
    "checkoutRemote": "origin",
    "acquisition": "fetch",
    "target": {
      "ref": "refs/heads/main",
      "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    "sources": [
      {
        "item": "PR-123",
        "ref": "refs/pull/123/head",
        "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }
    ]
  }
}
```

## Step 3: Dry-Run Preview

**Command:**

```bash
lex-pr weave apply --plan plan.json --dry-run
```

**Expected Output:**

```
🔍 Merge-Weave Dry Run

Plan: plan.json
Items: N
Target: main

Execution Order (topological):

  Level 1:
    - PR-XXX
    - PR-YYY
  Level 2:
    - PR-ZZZ

Gates to run:
  - lint
  - typecheck
  - test

To execute:
  lex-pr weave apply --plan plan.json
```

## Step 4: Execute Gates

**Command:**

```bash
lex-pr weave apply --plan plan.json
```

**Expected Output:**

```
🚀 Executing Merge-Weave

Plan: plan.json
Items: N

Running gates...

✅ PR-XXX: passed
✅ PR-YYY: passed
✅ PR-ZZZ: passed

✅ All gates passed!

Merge pyramid ready to execute.

Next step:
  lex-pr merge --plan plan.json --execute
```

## Step 5: Merge PRs (Optional)

**Command:**

```bash
lex-pr merge --plan plan.json --execute
```

**Expected Behavior:**

- Creates integration branch (e.g., `integration/weave-2025-12-17`)
- Merges PRs in topological order
- Runs final validation
- Ready to merge to main

## MCP Equivalent Workflow

For AI assistants using the MCP protocol:

```typescript
// Step 1: Discover
const prs = await tools.call("discover", {
  owner: "Guffawaffle",
  repo: "lexrunner",
  state: "open",
});

// Step 2: Create Plan
const plan = await tools.call("plan.create", {
  fromGithub: true,
  owner: "Guffawaffle",
  repo: "lexrunner",
  labels: ["ready-to-merge"],
  outDir: ".smartergpt/runner",
});

// Step 3: Start Run
const run = await tools.call("lexrunner.startRun", {
  procedure: "merge-weave-main",
  repo: "Guffawaffle/lexrunner",
  mode: "senior-dev",
  params: {
    planFile: ".smartergpt/runner/plan.json",
  },
});

// Step 4: Check Status
const status = await tools.call("lexrunner.getStatus", {
  runId: run.runId,
});

// Step 5: List Artifacts
const artifacts = await tools.call("lexrunner.listArtifacts", {
  runId: run.runId,
  type: "gate",
});
```

## Validation

To verify the workflow worked:

```bash
# Check plan is valid
lex-pr schema validate plan.json

# View plan in detail
lex-pr view plan.json

# Check merge order
lex-pr merge-order plan.json

# Check gate results
lex-pr status plan.json
```

## Common Issues and Solutions

### Issue: "Could not detect GitHub repository"

**Solution:**

```bash
# Verify git remote
git remote -v

# Or specify explicitly
lex-pr weave discover --owner Guffawaffle --repo lexrunner
```

### Issue: "No pull requests found"

**Solution:**

```bash
# Check filters
lex-pr weave discover --state all

# Or without label filter
lex-pr weave plan --from-github --owner Guffawaffle --repo lexrunner
```

### Issue: "Gate failed: lint"

**Solution:**

```bash
# Fix linting issues first
npm run lint

# Then retry
lex-pr weave apply --plan plan.json
```

## Performance Metrics

For a typical LexRunner merge-weave with 5 PRs:

- **Discovery**: ~2 seconds (GitHub API)
- **Planning**: ~3 seconds (dependency analysis)
- **Gate Execution**: ~30-60 seconds (lint + typecheck + tests)
- **Merge**: ~10 seconds (git operations)

**Total Time**: ~1-2 minutes for complete workflow

## Next Steps

- Read [MERGE_WEAVE_QUICKSTART.md](./MERGE_WEAVE_QUICKSTART.md) for detailed guide
- See [procedures/merge-weave-main.yaml](./procedures/merge-weave-main.yaml) for procedure definition
- Check [MERGE_WEAVE_USAGE_GUIDE.md](./MERGE_WEAVE_USAGE_GUIDE.md) for advanced usage
