# Manual Testing Guide for Scope.yml Auto-Detection Fix

This document provides manual testing steps to verify the fix for the empty plan.json issue.

## Issue Summary

**Original Problem:** When calling `mcp_lexrunner_plan_create` without `fromGithub: true`, the tool would return an empty `plan.json` even when `.smartergpt/scope.yml` contained GitHub discovery filters like `include_labels: ["ready-merge"]`.

**Root Cause:** The tool read scope.yml but didn't use the filters to discover PRs from GitHub.

**Fix:** Auto-detect GitHub mode when scope.yml has discovery filters.

## Prerequisites

1. GitHub repository with open PRs
2. GitHub token with repo access: `export GITHUB_TOKEN=ghp_...`
3. Working directory initialized as git repository

## Test Case 1: CLI - Auto-Detection from scope.yml

### Setup

```bash
cd /path/to/test-repo
mkdir -p .smartergpt

cat > .smartergpt/scope.yml << 'EOF'
version: 1
target: main
sources:
  - query: "is:open label:ready-merge"
selectors:
  include_labels: ["ready-merge"]
  exclude_labels: ["WIP"]
defaults:
  strategy: merge-weave
  base: main
pin_commits: false
EOF
```

### Execute

```bash
# Run plan command WITHOUT --from-github flag
lex-pr plan
```

### Expected Output

```
[plan] Auto-detected GitHub mode from scope.yml filters
✓ Auto-detected and discovered N PRs from GitHub
  Filtered by labels: ready-merge
  Using query: is:open label:ready-merge
✓ Generated plan artifacts:
  📁 .smartergpt/runner/plan.json
  📁 .smartergpt/runner/snapshot.md
```

### Verify

```bash
# Check that plan.json is NOT empty
cat .smartergpt/runner/plan.json
# Should contain items array with PR data
```

## Test Case 2: MCP Server - Auto-Detection

### Setup

Same as Test Case 1, plus start MCP server:

```bash
LEX_PR_PROFILE_DIR=/path/to/test-repo/.smartergpt \
ALLOW_MUTATIONS=true \
node /path/to/lexrunner/mcp-server.mjs
```

### Execute MCP Call

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "plan.create",
    "arguments": {}
  }
}
```

### Expected Stderr Output

```
[mcp:plan.create] Auto-detected GitHub mode from scope.yml filters
[mcp:plan.create] repo=owner/repo labels=ready-merge query="is:open label:ready-merge" discovered=N PRs
[mcp:plan.create] PRs included: PR-101, PR-102, PR-103
```

### Expected Response

The nested `plan` string below is an abridged response sketch with ellipses, not an executable Plan
fixture.

<!-- lexrunner-non-executable-plan:manual-mcp-plan-response -->

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"plan\":{\"schemaVersion\":\"1.0.0\",\"target\":\"main\",\"items\":[...]},\"outDir\":\"...\"}"
      }
    ]
  }
}
```

### Verify

```bash
# Check plan.json contains discovered PRs
cat /path/to/test-repo/.smartergpt/runner/plan.json | jq '.items | length'
# Should be > 0 if PRs exist
```

## Test Case 3: CLI - Explicit fromGithub Still Works

### Execute

```bash
# Explicit --from-github flag should override auto-detection
lex-pr plan --from-github --labels "feature,bugfix"
```

### Expected

- Should use explicit labels instead of scope.yml labels
- Should NOT show "Auto-detected" message (explicit mode)

## Test Case 4: Traditional Mode Still Works

### Setup

```bash
# Remove scope.yml, create stack.yml instead
rm .smartergpt/scope.yml

cat > .smartergpt/stack.yml << 'EOF'
version: 1
target: main
items:
  - branch: feature-a
    deps: []
    strategy: merge-weave
EOF
```

### Execute

```bash
lex-pr plan
```

### Expected

- Should use stack.yml (traditional mode)
- Should NOT enable GitHub auto-detection
- Plan should contain 1 item from stack.yml

## Test Case 5: Empty scope.yml (No Auto-Detection)

### Setup

```bash
cat > .smartergpt/scope.yml << 'EOF'
version: 1
target: main
sources: []
selectors:
  include_labels: []
  exclude_labels: []
defaults:
  strategy: merge-weave
  base: main
pin_commits: false
EOF
```

### Execute

```bash
lex-pr plan
```

### Expected

- Should NOT auto-detect GitHub mode
- Should return empty plan (no stack.yml, no PRs)
- Should NOT show auto-detection message

## Debugging

If tests fail, check:

1. **GitHub token:** `echo $GITHUB_TOKEN`
2. **Git remote:** `git remote -v` (should be GitHub URL)
3. **Open PRs exist:** `gh pr list --state open`
4. **Labels match:** PRs have the labels specified in scope.yml
5. **Stderr logs:** Look for `[plan]` or `[mcp:plan.create]` messages

## Success Criteria

✅ Auto-detection works when scope.yml has filters
✅ Plan.json contains discovered PRs (not empty)
✅ Diagnostic logs show which PRs were discovered
✅ Explicit --from-github still works
✅ Traditional mode (stack.yml) still works
✅ Empty scope.yml doesn't trigger auto-detection

## Notes

- Auto-detection only triggers when:
  - scope.yml exists
  - scope.yml has `include_labels` OR `sources[].query`
  - stack.yml does NOT exist (stack.yml takes precedence)
- Explicit `--from-github` or `fromGithub: true` always overrides auto-detection
- Labels from scope.yml can be overridden by CLI/MCP arguments
