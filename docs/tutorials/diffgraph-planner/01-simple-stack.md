# Tutorial 1: Simple Stack Planning

Learn how to generate a plan for a linear dependency chain using diffgraph auto-discovery.

**Time to complete:** ~5 minutes

**Difficulty:** Beginner

---

## Goal

Generate and execute a plan for 3 PRs that build on each other sequentially (a "stack").

## Scenario

You have 3 open PRs that form a linear dependency chain:

1. **PR-100:** `feature/auth-api` - Add authentication API endpoints (foundation)
2. **PR-101:** `feature/auth-ui` - Add authentication UI components (depends on API)
3. **PR-102:** `feature/auth-tests` - Add E2E tests for authentication (depends on UI)

**Dependency graph:**

```
PR-100 → PR-101 → PR-102
```

## Prerequisites

- lexrunner installed (`npm install -g lexrunner`)
- GitHub repository with 3 open PRs
- GitHub token set: `export GITHUB_TOKEN=your_token_here`
- Basic understanding of Git and GitHub PRs

---

## Step 1: Prepare PR Descriptions

Update the PR descriptions with explicit `Depends-on:` footers.

### PR-100 (auth-api) Description

```markdown
# Add Authentication API

Implement core authentication endpoints:

- POST /api/auth/login
- POST /api/auth/logout
- GET /api/auth/session

## Changes

- Add auth routes
- Add session management
- Add password hashing

(No dependencies - this is the foundation)
```

### PR-101 (auth-ui) Description

```markdown
# Add Authentication UI

Implement authentication UI components:

- Login form
- Logout button
- Session indicator

## Dependencies

Depends-on: #100

## Changes

- Add LoginForm component
- Add LogoutButton component
- Add SessionStatus component
```

### PR-102 (auth-tests) Description

```markdown
# Add Authentication E2E Tests

Add end-to-end tests for the complete authentication flow:

- Login flow test
- Logout flow test
- Session persistence test

## Dependencies

Depends-on: #101

## Changes

- Add E2E test suite
- Add test fixtures
- Add test utilities
```

**Key points:**

- PR-100 has **no dependencies** (foundation)
- PR-101 **depends on PR-100** (`Depends-on: #100`)
- PR-102 **depends on PR-101** (`Depends-on: #101`)

---

## Step 2: Generate Plan

Run the planner to generate a plan from GitHub PRs:

```bash
lex-pr plan --from-github --output plan.json
```

**Expected output:**

```
🔍 Fetching open PRs from GitHub...
✓ Found 3 open PRs

📝 Parsing dependencies...
✓ Parsed dependencies: 2 explicit, 0 implicit

🔍 Validating plan...
✓ No cycles detected
✓ No orphan PRs
✓ No invalid references

📊 Plan statistics:
  - 3 nodes
  - 2 edges
  - 3 layers

✓ Plan generated successfully

Plan written to: plan.json
```

**What happened:**

1. Planner fetched 3 open PRs from GitHub
2. Parsed `Depends-on:` footers from PR descriptions
3. Validated the dependency graph (no cycles)
4. Computed merge layers using topological sort
5. Generated `plan.json`

---

## Step 3: Review Plan Structure

Inspect the generated plan file:

```bash
cat plan.json
```

**Expected content:**

<!-- lexrunner-plan-example:diffgraph-simple-stack-generated -->

```json
{
  "schemaVersion": "1.0.1",
  "target": "main",
  "items": [
    {
      "name": "PR-100",
      "deps": [],
      "gates": []
    },
    {
      "name": "PR-101",
      "deps": ["PR-100"],
      "gates": []
    },
    {
      "name": "PR-102",
      "deps": ["PR-101"],
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
        "item": "PR-100",
        "ref": "refs/pull/100/head",
        "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      },
      {
        "item": "PR-101",
        "ref": "refs/pull/101/head",
        "commit": "cccccccccccccccccccccccccccccccccccccccc"
      },
      {
        "item": "PR-102",
        "ref": "refs/pull/102/head",
        "commit": "dddddddddddddddddddddddddddddddddddddddd"
      }
    ]
  }
}
```

**Key observations:**

- `PR-100` has `deps: []` (no dependencies, Layer 0)
- `PR-101` depends on `["PR-100"]` (Layer 1)
- `PR-102` depends on `["PR-101"]` (Layer 2)
- All items are sorted deterministically

---

## Step 4: Review Merge Order

Visualize the computed merge order:

```bash
lex-pr merge-order plan.json
```

**Expected output:**

```
📊 Merge order for 3 items:

Layer 0 (ready to merge):
  → PR-100 (auth-api)

Layer 1 (after PR-100):
  → PR-101 (auth-ui)

Layer 2 (after PR-101):
  → PR-102 (auth-tests)
```

**Understanding layers:**

- **Layer 0:** PRs with no dependencies, can merge immediately
- **Layer 1:** PRs that depend on Layer 0, merge after Layer 0 completes
- **Layer 2:** PRs that depend on Layer 1, merge after Layer 1 completes

**Merge order:**

1. Merge PR-100 first
2. After PR-100 succeeds, merge PR-101
3. After PR-101 succeeds, merge PR-102

---

## Step 5: Execute Gates

Run quality gates for all items in the plan:

```bash
lex-pr execute --plan plan.json
```

**Expected output:**

```
📦 Executing plan: 3 items, 3 layers

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Layer 0: 1 item
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Running gates for PR-100 (auth-api)...
  ✓ lint: passed (1.2s)
  ✓ typecheck: passed (2.5s)
  ✓ test: passed (8.3s)

All gates passed for PR-100 ✓

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Layer 1: 1 item
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Running gates for PR-101 (auth-ui)...
  ✓ lint: passed (1.1s)
  ✓ typecheck: passed (2.3s)
  ✓ test: passed (9.7s)

All gates passed for PR-101 ✓

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Layer 2: 1 item
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Running gates for PR-102 (auth-tests)...
  ✓ lint: passed (1.0s)
  ✓ typecheck: passed (2.1s)
  ✓ test: passed (15.8s)

All gates passed for PR-102 ✓

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✨ All gates passed! Ready to merge.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**What happened:**

1. Gates run in **dependency order** (Layer 0 → Layer 1 → Layer 2)
2. Each item's gates must **pass** before proceeding to the next layer
3. Results are saved to `.smartergpt/runner/gate-results/`
4. Exit code 0 indicates all gates passed

---

## Step 6: Execute Merge

Merge the PRs in the computed order:

```bash
# Preview merge operations (dry-run)
lex-pr merge --plan plan.json

# Execute merge for real
lex-pr merge --plan plan.json --execute
```

**Expected output (dry-run):**

```
🔍 Dry-run mode: Previewing merge operations

Layer 0:
  → PR-100 (auth-api): Would merge to main ✓

Layer 1:
  → PR-101 (auth-ui): Would merge to main (after PR-100) ✓

Layer 2:
  → PR-102 (auth-tests): Would merge to main (after PR-101) ✓

✓ All PRs would merge successfully
Run with --execute to perform actual merges
```

**Expected output (execute):**

```
🚀 Executing merge plan...

Merging PR-100 (auth-api)...
  ✓ Merged to main (sha: abc123)
  ✓ Deleted branch: feature/auth-api
  ✓ Closed PR #100

Merging PR-101 (auth-ui)...
  ✓ Merged to main (sha: def456)
  ✓ Deleted branch: feature/auth-ui
  ✓ Closed PR #101

Merging PR-102 (auth-tests)...
  ✓ Merged to main (sha: ghi789)
  ✓ Deleted branch: feature/auth-tests
  ✓ Closed PR #102

✨ All PRs merged successfully!
```

---

## Step 7: Verify Success

Confirm all PRs merged in the correct order:

```bash
# Check git log
git log --oneline --graph -10
```

**Expected output:**

```
*   abc1234 Merge PR #102: Add authentication E2E tests
|\
| * def5678 Add E2E test suite
*   ghi9012 Merge PR #101: Add authentication UI
|\
| * jkl3456 Add UI components
*   mno7890 Merge PR #100: Add authentication API
|\
| * pqr1234 Add auth endpoints
* stu5678 Previous commit on main
```

**Verification checklist:**

- ✅ All 3 PRs merged to `main`
- ✅ Merge order is correct (PR-100 → PR-101 → PR-102)
- ✅ No merge conflicts occurred
- ✅ All branches deleted (optional)
- ✅ All PRs closed

---

## Common Issues

### Issue: "Dependency cycle detected"

**Symptom:**

```
❌ Validation failed: Dependency cycle detected
```

**Cause:** Circular dependency in PR descriptions.

**Solution:**
Check PR descriptions for circular `Depends-on:` references. Remove the cycle by eliminating the weakest dependency.

### Issue: "Invalid dependency reference"

**Symptom:**

```
❌ Validation failed: Invalid dependency reference #100
```

**Cause:** Referenced PR doesn't exist or is not included in the plan.

**Solution:**

- Check that PR-100 exists: `gh pr view 100`
- Verify it's open and matches label filters
- Update the PR number if incorrect

### Issue: Gates fail for PR-101

**Symptom:**

```
❌ test: failed (exit code 1)
```

**Cause:** PR-101's tests depend on PR-100 being merged first.

**Solution:**
This is expected! The planner will:

1. Merge PR-100
2. Then re-run gates for PR-101 (which should now pass)
3. Then merge PR-101

---

## Next Steps

Congratulations! You've successfully planned and merged a simple stack. Next tutorials:

- **[Tutorial 2: Diamond Pattern](./02-diamond-pattern.md)** - Fan-out/fan-in dependencies
- **[Tutorial 3: Large Batch](./03-large-batch.md)** - Managing 20+ PRs
- **[Tutorial 4: Fixing Cycles](./04-fixing-cycles.md)** - Resolving circular dependencies
- **[Tutorial 5: Hybrid Workflow](./05-hybrid-workflow.md)** - Combining explicit + implicit dependencies

## Related Documentation

- **[Diffgraph Planner Guide](../../diffgraph-planner.md)** - Complete feature documentation
- **[CLI Reference](../../cli.md)** - Full command documentation
- **[Dependency Parser](../../dependency-parser.md)** - Parser details
