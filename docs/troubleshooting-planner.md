# Troubleshooting Guide: Diffgraph Planner

This guide covers common errors and warnings when using the diffgraph planner, with step-by-step solutions.

## Table of Contents

- [Error: Dependency Cycle Detected](#error-dependency-cycle-detected)
- [Warning: Unreachable/Orphan PRs](#warning-unreachableorphan-prs)
- [Low-Confidence Implicit Dependencies](#low-confidence-implicit-dependencies)
- [Plan Differs Between Runs](#plan-differs-between-runs)
- [Error: Invalid Dependency Reference](#error-invalid-dependency-reference)
- [Error: Self-Dependency Detected](#error-self-dependency-detected)
- [Warning: Large Merge Layer](#warning-large-merge-layer)
- [File Analysis Timeout](#file-analysis-timeout)
- [GitHub API Rate Limiting](#github-api-rate-limiting)

---

## Error: Dependency Cycle Detected

### Symptom

Plan generation fails with a cycle error:

```
❌ Validation failed: Dependency cycle detected
Cycle path: PR-100 → PR-101 → PR-102 → PR-100

Suggestion: Remove one of the dependencies in the cycle to break it.
```

### Root Cause

Circular dependencies in the PR graph. This can happen due to:

1. **Explicit cycles** - PR descriptions have circular `Depends-on:` footers
2. **Implicit cycles** - File-based heuristics create a false circular dependency
3. **Mixed cycles** - Combination of explicit and implicit dependencies

### Diagnosis Steps

#### Step 1: Examine the Cycle Path

The error message shows the cycle path. For example:

```
PR-100 → PR-101 → PR-102 → PR-100
```

This means:

- PR-100 depends on PR-101
- PR-101 depends on PR-102
- PR-102 depends on PR-100 (cycle!)

#### Step 2: Check Explicit Dependencies

Review each PR's description:

```bash
# For each PR in the cycle, check its dependencies
gh pr view 100 --json body --jq '.body'
gh pr view 101 --json body --jq '.body'
gh pr view 102 --json body --jq '.body'
```

Look for `Depends-on:` lines.

#### Step 3: Check Implicit Dependencies

If no explicit cycle is found, check file-based suggestions:

```bash
# Generate suggestions to see implicit dependencies
lex-pr plan --suggest-deps --json | jq '.suggestions[] | select(.from == "PR-100" or .from == "PR-101" or .from == "PR-102")'
```

Look for high-confidence suggestions that might create the cycle.

### Solution

#### Option 1: Remove Explicit Dependency

If the cycle is due to explicit dependencies, remove the weakest link:

**Before:**

```markdown
# PR-100 description

Depends-on: #102

# PR-101 description

Depends-on: #100

# PR-102 description

Depends-on: #101
```

**After (break cycle by removing PR-100 → PR-102):**

```markdown
# PR-100 description

(no Depends-on)

# PR-101 description

Depends-on: #100

# PR-102 description

Depends-on: #101
```

Then regenerate the plan:

```bash
lex-pr plan --from-github --output plan.json
```

#### Option 2: Remove Implicit Dependency

If the cycle is due to file-based suggestions, increase the threshold to filter them out:

```bash
# Use higher threshold to filter low-confidence suggestions
lex-pr plan --from-github --threshold=0.7 --output plan.json
```

Or disable implicit dependencies entirely:

```bash
# Only use explicit dependencies
lex-pr plan --from-github --no-suggestions --output plan.json
```

#### Option 3: Restructure the Work

If the cycle represents a real circular dependency in the code:

1. **Merge PRs into one** - combine the circular work into a single PR
2. **Refactor the approach** - break the circular dependency in the code design
3. **Use a feature branch** - merge all PRs to a feature branch first, then merge to main

### Example

**Scenario:** Three PRs refactoring a module create a cycle.

**Before:**

- PR-100: Refactor `core.ts` (depends on PR-102 for types)
- PR-101: Refactor `utils.ts` (depends on PR-100)
- PR-102: Refactor `types.ts` (depends on PR-101)

**Solution:** Combine into a single PR or use a feature branch:

```bash
# Create feature branch
git checkout -b refactor/module-cleanup

# Merge all PRs to feature branch (no dependencies)
lex-pr merge pr-100 pr-101 pr-102 --target refactor/module-cleanup

# Then merge feature branch to main
git checkout main
git merge refactor/module-cleanup
```

### Prevention

- **Review dependencies** before adding them
- **Use `plan --validate`** early in the process
- **Keep stacks linear** when possible (avoid diamonds and complex graphs)

---

## Warning: Unreachable/Orphan PRs

### Symptom

Plan generation succeeds but warns about orphan PRs:

```
✓ Plan generated successfully

⚠️  Warning: Orphan PRs detected (no dependencies, no dependents)
  - PR-999 (hotfix/security-patch)
  - PR-888 (refactor/cleanup)

These PRs can be merged independently but are not part of any dependency chain.
```

### Root Cause

A PR has:

- **No dependencies** (doesn't depend on other PRs)
- **No dependents** (no other PRs depend on it)

### Is This a Problem?

**Often NO** - valid scenarios:

- ✅ Independent hotfixes
- ✅ Parallel feature work
- ✅ Refactors with no dependencies
- ✅ Documentation updates

**Sometimes YES** - missing dependencies:

- ❌ PR is part of a stack but missing `Depends-on:` footer
- ❌ PR should depend on foundation work but doesn't declare it
- ❌ Other PRs should depend on this PR but don't declare it

### Diagnosis Steps

#### Step 1: Review the PR's Purpose

```bash
# View PR details
gh pr view 999 --json title,body,labels
```

Ask yourself:

- Is this PR truly independent?
- Does it build on other work?
- Do other PRs build on this?

#### Step 2: Check for Implicit Dependencies

```bash
# See if suggestions exist for the orphan PR
lex-pr plan --suggest-deps | grep "PR-999"
```

If suggestions exist with high confidence (≥0.7), you might be missing a dependency.

#### Step 3: Check for Reverse Dependencies

```bash
# See if other PRs should depend on this one
lex-pr plan --suggest-deps | grep "to.*PR-999"
```

### Solution

#### Option 1: Add Missing Dependency

If the PR should depend on another PR:

```markdown
# In PR-999 description, add:

Depends-on: #100
```

Then regenerate the plan:

```bash
lex-pr plan --from-github --output plan.json
```

#### Option 2: Ignore the Warning

If the PR is truly independent:

```bash
# The warning is informational - you can safely ignore it
lex-pr execute --plan plan.json
```

Orphan PRs will be placed in Layer 0 and can be merged immediately.

#### Option 3: Separate Independent PRs

If you want to focus on the dependency chain and exclude orphans:

```bash
# Filter by label to exclude orphan PRs
lex-pr plan --from-github --labels "stack:feature" --output plan.json
```

### Example

**Scenario:** Security hotfix is flagged as orphan.

**PR-999:** Fix XSS vulnerability in input validation

**Analysis:**

- No dependencies (doesn't need other PRs)
- No dependents (other PRs don't need this)
- **This is valid!** - Security hotfixes are often independent

**Action:** Ignore the warning and merge immediately.

---

## Low-Confidence Implicit Dependencies

### Symptom

Suggestions have low confidence scores (<0.5):

```
📊 Dependency Suggestions (2 found):

| From   | To     | Confidence | Heuristic          | Reason                    |
|--------|--------|------------|--------------------|---------------------------|
| PR-101 | PR-102 | 35%        | directory-proximity| 1 common directory        |
| PR-201 | PR-202 | 28%        | shared-files       | both modify utils.ts      |
```

### Root Cause

File overlap is weak or heuristics are uncertain:

- PRs modify different parts of the same directory
- PRs both modify common utility files (`utils.ts`, `types.ts`)
- Minimal file overlap (1-2 files)
- Directory proximity but different concerns

### Is This a Problem?

**Usually NO** - low confidence means the relationship is uncertain:

- ✅ Heuristics are working correctly (filtering weak signals)
- ✅ PRs are likely independent
- ✅ No action needed in most cases

**Sometimes YES** - legitimate dependency with weak signal:

- ❌ New code with no tests (weak file overlap)
- ❌ Small changes to critical files
- ❌ Documentation changes that don't show up in heuristics

### Diagnosis Steps

#### Step 1: Review the Shared Files

```bash
# Get detailed info about the suggestion
lex-pr plan --suggest-deps --json | jq '.suggestions[] | select(.confidence < 0.5)'
```

Check the `sharedFiles` field to see what files overlap.

#### Step 2: Examine the File Changes

```bash
# Review what each PR actually changes
gh pr diff 101 | grep "utils.ts"
gh pr diff 102 | grep "utils.ts"
```

Ask yourself:

- Do these changes actually conflict?
- Is there a logical dependency?
- Are they just coincidentally touching the same file?

#### Step 3: Review PR Descriptions

```bash
# Read the PR descriptions to understand the intent
gh pr view 101 --json title,body
gh pr view 102 --json title,body
```

### Solution

#### Option 1: Add Explicit Dependency (If Valid)

If after review you determine there IS a dependency:

```markdown
# In PR-102 description, add:

Depends-on: #101
```

Then regenerate:

```bash
lex-pr plan --from-github --output plan.json
```

#### Option 2: Ignore the Suggestion

If the PRs are truly independent:

```bash
# Use higher threshold to filter out low-confidence suggestions
lex-pr plan --from-github --threshold=0.5 --output plan.json
```

This will exclude suggestions below 50% confidence.

#### Option 3: Investigate Further

If you're unsure:

```bash
# Generate detailed analysis
lex-pr plan --suggest-deps --format=markdown > review.md

# Review the markdown file
cat review.md
```

### Example

**Scenario:** Two PRs both modify `utils.ts` but for unrelated reasons.

**PR-101:** Add `formatDate()` helper to `utils.ts`
**PR-102:** Add `validateEmail()` helper to `utils.ts`

**Suggestion:** `PR-101 → PR-102` (35% confidence)

**Analysis:**

- Both modify `utils.ts` (weak signal)
- Different functions (no real dependency)
- No conflict (different parts of file)

**Action:** Ignore the suggestion - these PRs are independent.

```bash
# Filter it out with threshold
lex-pr plan --from-github --threshold=0.5 --output plan.json
```

### Prevention

- **Use explicit dependencies** for known relationships
- **Set appropriate thresholds** for your codebase
- **Review suggestions** before trusting them
- **Document independent work** in PR descriptions

---

## Plan Differs Between Runs

### Symptom

Running the same command twice produces different output:

```bash
$ lex-pr plan --from-github --output plan1.json
✓ Plan generated

$ lex-pr plan --from-github --output plan2.json
✓ Plan generated

$ diff plan1.json plan2.json
< "timestamp": "2024-01-15T10:30:00Z"
> "timestamp": "2024-01-15T10:31:00Z"
```

### Root Cause

**This should NEVER happen** - it indicates a determinism bug. Possible causes:

1. **Timestamp fields** - non-deterministic timestamps in output
2. **Random ordering** - items not sorted deterministically
3. **Network timing** - different GitHub API response order
4. **Cache issues** - stale cache affecting results

### Diagnosis Steps

#### Step 1: Generate Plans Twice

```bash
lex-pr plan --from-github --output plan1.json
lex-pr plan --from-github --output plan2.json
diff plan1.json plan2.json
```

#### Step 2: Identify the Differences

Check what fields are different:

- **Timestamps?** - Should be excluded from output
- **Item order?** - Should be deterministically sorted
- **Dependency order?** - Should be deterministically sorted
- **Metadata?** - Should be stable

#### Step 3: Clear Cache and Retry

```bash
# Clear any cached data
rm -rf .smartergpt/runner/cache/

# Regenerate
lex-pr plan --from-github --output plan.json
```

### Solution

#### Option 1: Strip Timestamps (Workaround)

If only timestamps differ:

```bash
# Remove timestamp fields with jq
lex-pr plan --from-github --json | jq 'del(.timestamp, .items[].timestamp)' > plan.json
```

#### Option 2: Report the Bug

If other fields differ:

1. **Capture evidence:**

   ```bash
   lex-pr --version > bug-report.txt
   node --version >> bug-report.txt
   uname -a >> bug-report.txt
   diff plan1.json plan2.json >> bug-report.txt
   ```

2. **File an issue:** [GitHub Issues](https://github.com/Guffawaffle/LexRunner/issues/new)
   - Title: "Non-deterministic plan generation"
   - Include: Commands run, diff output, environment details
   - Label: `bug`, `determinism`

#### Option 3: Pin Commit SHAs (Future Feature)

Once supported, pin specific commit SHAs in the plan:

This future-format fragment omits the current Plan document fields and is not executable input.

<!-- lexrunner-non-executable-plan:troubleshooting-future-plan-fragment -->

```json
{
  "items": [
    {
      "id": "pr-100",
      "name": "auth-api",
      "sha": "abc123def456",
      "deps": []
    }
  ]
}
```

This ensures the plan is tied to specific commits.

### Prevention

- **Always use `--json` flag** for deterministic output
- **Avoid manual plan editing** (regenerate instead)
- **Test determinism** in CI (generate twice, compare)

---

## Error: Invalid Dependency Reference

### Symptom

```
❌ Validation failed: Invalid dependency reference
Item: PR-101
Invalid reference: #999 (PR does not exist)

Suggestion: Check that the referenced PR exists and is included in the plan.
```

### Root Cause

A PR depends on another PR that doesn't exist or isn't included in the plan.

### Diagnosis Steps

#### Step 1: Check if the Referenced PR Exists

```bash
# Check if PR-999 exists
gh pr view 999
```

If it doesn't exist:

- It was closed/merged
- The PR number is wrong
- It's in a different repository

#### Step 2: Check if the Referenced PR is Included

```bash
# List all PRs in the current plan
lex-pr plan --from-github --json | jq '.items[].id'
```

If PR-999 exists but isn't in the list:

- It doesn't match the label filters
- It was excluded by other criteria

### Solution

#### Option 1: Remove the Invalid Dependency

If the referenced PR no longer exists:

```markdown
# In PR-101 description, remove:

Depends-on: #999
```

Then regenerate:

```bash
lex-pr plan --from-github --output plan.json
```

#### Option 2: Include the Referenced PR

If the PR exists but is excluded:

```bash
# Check why it's excluded
gh pr view 999 --json labels,state

# If it needs a label, add it
gh pr edit 999 --add-label "ready-to-merge"

# Regenerate plan
lex-pr plan --from-github --output plan.json
```

#### Option 3: Fix the Reference

If the PR number is wrong:

```markdown
# In PR-101 description, fix the number:

Depends-on: #998 # Was #999
```

### Example

**Scenario:** PR-101 depends on PR-100, which was already merged.

**Error:**

```
❌ Invalid reference: #100 (PR does not exist or is closed)
```

**Solution:** Remove the dependency since it's already merged:

```markdown
# PR-101 description before:

Depends-on: #100

# PR-101 description after:

(remove the Depends-on line)
```

---

## Error: Self-Dependency Detected

### Symptom

```
❌ Validation failed: Self-dependency detected
Item: PR-101
Cannot depend on itself.

Suggestion: Remove the self-dependency from the PR description.
```

### Root Cause

A PR's description includes a `Depends-on:` reference to itself.

### Diagnosis Steps

#### Step 1: Check the PR Description

```bash
# View the PR description
gh pr view 101 --json body --jq '.body'
```

Look for `Depends-on: #101` (self-reference).

### Solution

Remove the self-dependency:

```markdown
# Before:

Depends-on: #100, #101, #102

# After:

Depends-on: #100, #102
```

Then regenerate:

```bash
lex-pr plan --from-github --output plan.json
```

### Example

**Scenario:** Copy-paste error in PR description.

**Before:**

```markdown
Depends-on: #101, #102
```

**Fix:**

```markdown
Depends-on: #102
```

---

## Warning: Large Merge Layer

### Symptom

```
⚠️  Warning: Large merge layer detected
Layer 0 contains 25 PRs (threshold: 10)

This may indicate missing dependencies or overly parallel work.
Consider adding explicit dependencies to reduce layer size.
```

### Root Cause

Too many PRs at the same dependency level (all marked as "ready to merge").

### Is This a Problem?

**Sometimes NO** - valid scenarios:

- ✅ Batch refactor with truly independent PRs
- ✅ Parallel feature work by different teams
- ✅ Hotfixes and small fixes

**Sometimes YES** - missing dependencies:

- ❌ PRs have implicit dependencies not declared
- ❌ File-based heuristics didn't catch relationships
- ❌ Team forgot to add `Depends-on:` footers

### Solution

#### Option 1: Add Missing Dependencies

Review the PRs and add explicit dependencies:

```bash
# Generate suggestions for Layer 0 PRs
lex-pr plan --suggest-deps --threshold=0.6 | grep "Layer 0"
```

If suggestions exist, add them to PR descriptions.

#### Option 2: Split into Batches

If PRs are truly independent, process them in smaller batches:

```bash
# First batch: PRs 1-10
lex-pr plan --from-github --pr-numbers 1,2,3,4,5,6,7,8,9,10

# Second batch: PRs 11-20
lex-pr plan --from-github --pr-numbers 11,12,13,14,15,16,17,18,19,20
```

#### Option 3: Ignore the Warning

If you're confident the PRs are independent:

```bash
# Proceed with execution
lex-pr execute --plan plan.json
```

---

## File Analysis Timeout

### Symptom

```
❌ Error: File analysis timed out after 60 seconds
Failed to fetch file changes for PR-101

Suggestion: Increase timeout or reduce the number of PRs.
```

### Root Cause

- Large PRs with many file changes
- Slow GitHub API responses
- Rate limiting

### Solution

#### Option 1: Increase Timeout

```bash
# Set longer timeout (in seconds)
export LEX_PR_FILE_ANALYSIS_TIMEOUT=120

lex-pr plan --from-github --output plan.json
```

#### Option 2: Reduce PR Count

```bash
# Process fewer PRs at once
lex-pr plan --from-github --labels "ready-to-merge" --output plan.json
```

#### Option 3: Disable File Analysis

```bash
# Skip file-based suggestions (explicit deps only)
lex-pr plan --from-github --no-suggestions --output plan.json
```

---

## GitHub API Rate Limiting

### Symptom

```
❌ Error: GitHub API rate limit exceeded
Remaining: 0/5000
Resets at: 2024-01-15T11:00:00Z

Suggestion: Wait for rate limit reset or use authentication.
```

### Root Cause

- Too many API requests
- Unauthenticated requests (lower rate limit)
- Large number of PRs

### Solution

#### Option 1: Use Authentication

```bash
# Set GitHub token for higher rate limits
export GITHUB_TOKEN=your_token_here

lex-pr plan --from-github --output plan.json
```

Authenticated: 5,000 requests/hour
Unauthenticated: 60 requests/hour

#### Option 2: Wait for Reset

```bash
# Check rate limit status
gh api rate_limit

# Wait until reset time, then retry
```

#### Option 3: Cache Results

```bash
# Use cached file analysis (if available)
lex-pr plan --from-github --use-cache --output plan.json
```

---

## Getting Help

If you encounter an issue not covered here:

1. **Check existing issues:** [GitHub Issues](https://github.com/Guffawaffle/LexRunner/issues)
2. **Search discussions:** [GitHub Discussions](https://github.com/Guffawaffle/LexRunner/discussions)
3. **File a new issue:** Include:
   - Commands run
   - Error messages (full output)
   - Environment details (OS, Node version, lex-pr version)
   - Plan file (if applicable)

## Related Documentation

- **[Diffgraph Planner Guide](./diffgraph-planner.md)** - Complete feature guide
- **[CLI Reference](./cli.md)** - Command documentation
- **[Dependency Parser](./dependency-parser.md)** - Parser details
- **[General Troubleshooting](./troubleshooting.md)** - Other issues
