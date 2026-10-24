# Diffgraph Planner Guide

The diffgraph planner enables automatic dependency discovery and intelligent merge ordering for multiple PRs. This guide covers everything from basic usage to advanced workflows.

## Table of Contents

- [Introduction](#introduction)
- [Quick Start](#quick-start)
- [Dependency Syntax Reference](#dependency-syntax-reference)
- [File-Change Heuristics](#file-change-heuristics)
- [Validation & Troubleshooting](#validation--troubleshooting)
- [Workflows & Best Practices](#workflows--best-practices)
- [Advanced Topics](#advanced-topics)
- [API Reference](#api-reference)
- [Examples Gallery](#examples-gallery)

---

## Introduction

### What is Diffgraph Planning?

Diffgraph planning automatically discovers dependencies between pull requests and computes an optimal merge order. Instead of manually tracking which PRs depend on which, the planner:

1. **Parses explicit dependencies** from PR descriptions (e.g., `Depends-on: #123`)
2. **Analyzes file changes** to suggest implicit dependencies
3. **Validates the dependency graph** for cycles and orphans
4. **Computes merge layers** using topological sort
5. **Generates a deterministic plan** for execution

**Result:** A validated, executable plan that merges PRs in the correct order, respecting dependencies.

### When to Use Auto-Discovery vs Manual Planning

| Scenario                   | Recommended Approach        | Why                               |
| -------------------------- | --------------------------- | --------------------------------- |
| **Small team (2-5 devs)**  | Auto-discovery with review  | Fast, catches missed dependencies |
| **Large team (10+ devs)**  | Explicit deps + suggestions | Better control, human oversight   |
| **Complex feature stacks** | Hybrid (both)               | Combines precision with discovery |
| **Independent hotfixes**   | Manual planning             | No dependencies to discover       |
| **Batch refactors**        | Auto-discovery              | File overlap is reliable signal   |

### High-Level Workflow

```
┌─────────────────┐
│  Open PRs (GitHub)│
│  with descriptions│
└────────┬─────────┘
         │
         ▼
┌─────────────────────────┐
│ 1. Parse Dependencies   │ ← Explicit footers (Depends-on:)
│    (dependencyParser)   │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ 2. Analyze File Changes │ ← Implicit suggestions (shared files)
│    (fileAnalysis)       │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ 3. Score Dependencies   │ ← Combine explicit + implicit
│    (dependencyScoring)  │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ 4. Validate Plan        │ ← Check cycles, orphans, refs
│    (validation)         │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ 5. Generate plan.json   │ ← Deterministic, executable
└─────────────────────────┘
```

---

## Quick Start

This minimal example shows how to generate and execute a plan for 3 PRs with dependencies.

### Setup: PRs with Dependencies

You have 3 open PRs:

- **PR-100:** `feature/auth-api` - Add authentication API endpoints
- **PR-101:** `feature/auth-ui` - Add authentication UI (depends on API)
- **PR-102:** `feature/auth-tests` - Add E2E tests (depends on UI)

### Step 1: Add Dependency Footers

Update PR descriptions with explicit dependencies:

**PR-101 description:**

```markdown
Add authentication UI components.

Depends-on: #100
```

**PR-102 description:**

```markdown
Add E2E tests for authentication flow.

Depends-on: #101
```

### Step 2: Generate Plan

```bash
# Set GitHub token (if not already in environment)
export GITHUB_TOKEN=your_token_here

# Generate plan from GitHub PRs
lex-pr plan --from-github --output plan.json
```

**Expected output:**

```
✓ Fetched 3 open PRs
✓ Parsed dependencies: 2 explicit, 0 implicit
✓ Validated: no cycles, no orphans
✓ Generated plan: 3 nodes, 2 edges, 3 layers

Plan written to: plan.json
```

### Step 3: Review Plan

```bash
# Show merge order
lex-pr merge-order plan.json
```

**Expected output:**

```
📊 Merge order for 3 items:

Layer 0 (ready):
  → PR-100 (auth-api)

Layer 1 (after PR-100):
  → PR-101 (auth-ui)

Layer 2 (after PR-101):
  → PR-102 (auth-tests)
```

### Step 4: Execute

```bash
# Run gates and merge (dry-run first)
lex-pr merge --plan plan.json

# Execute for real
lex-pr merge --plan plan.json --execute
```

**What happens:**

1. PR-100 gates run → merge
2. PR-101 gates run → merge (after PR-100)
3. PR-102 gates run → merge (after PR-101)

---

## Dependency Syntax Reference

The planner recognizes multiple dependency formats in PR descriptions.

### Supported Keywords

| Keyword       | Example               | Notes                                 |
| ------------- | --------------------- | ------------------------------------- |
| `Depends-on:` | `Depends-on: #123`    | **Recommended** - explicit dependency |
| `Depends:`    | `Depends: #123, #456` | Alias for `Depends-on:`               |
| `Requires:`   | `Requires: #123`      | Alias for `Depends-on:`               |
| `Closes:`     | `Closes: #100`        | GitHub keyword (not a dependency)     |
| `Fixes:`      | `Fixes: #200`         | GitHub keyword (not a dependency)     |
| `Resolves:`   | `Resolves: #300`      | GitHub keyword (not a dependency)     |

**Note:** `Closes`, `Fixes`, and `Resolves` are GitHub issue-closing keywords and are **not treated as dependencies** by the planner.

### Single Dependency

```markdown
Depends-on: #123
```

### Multiple Dependencies

```markdown
Depends-on: #123, #456, #789
```

or split across lines:

```markdown
Depends-on: #123
Depends-on: #456
Depends-on: #789
```

### Cross-Repo References

```markdown
Depends-on: owner/repo#123
Depends-on: other-repo#456
```

**Normalization:** All references are normalized to `owner/repo#number` format internally.

### Invalid Syntax Examples

❌ **Don't do this:**

```markdown
# Missing PR number

Depends-on: feature-branch

# Using PR- prefix (not needed)

Depends-on: PR-123

# Using URLs (not supported)

Depends-on: https://github.com/owner/repo/pull/123
```

✅ **Do this instead:**

```markdown
Depends-on: #123
```

### Placement in PR Description

Dependencies can appear **anywhere** in the PR description:

```markdown
## Summary

Add new feature X.

## Dependencies

Depends-on: #100, #101

## Changes

- Feature implementation
- Tests added
```

The parser extracts all `Depends-on:` lines regardless of position.

---

## File-Change Heuristics

When explicit dependencies are missing, the planner uses file-change analysis to suggest implicit dependencies.

### How It Works

1. **Fetch file changes** for each PR (via GitHub API)
2. **Build intersection matrix** - which PRs touch the same files
3. **Calculate confidence scores** based on overlap patterns
4. **Generate suggestions** sorted by confidence (high to low)

### Confidence Scoring Explained

#### Shared File Modifications (0.6 - 1.0)

**Highest confidence** - both PRs modify the same file.

| Pattern                   | Confidence | Example                                                      |
| ------------------------- | ---------- | ------------------------------------------------------------ |
| Both modify same file     | 1.0        | PR-101 modifies `core.ts`, PR-102 modifies `core.ts`         |
| One modifies, one renames | 0.8        | PR-101 modifies `old.ts`, PR-102 renames `old.ts` → `new.ts` |
| Mixed (modify + delete)   | 0.6        | PR-101 modifies `utils.ts`, PR-102 deletes `utils.ts`        |

**Heuristic:** If two PRs modify overlapping files, they likely have a dependency relationship.

#### Directory Proximity (0.3 - 0.8)

**Medium confidence** - PRs work in the same area of the codebase.

```
Formula: min(commonDirs / totalDirs, 0.8)
```

| Scenario                    | Confidence | Example                                  |
| --------------------------- | ---------- | ---------------------------------------- |
| All files in same directory | 0.8        | Both modify files only in `src/planner/` |
| Majority overlap            | 0.6        | 3/5 directories in common                |
| Partial overlap             | 0.4        | 1/3 directories in common                |
| Minimal overlap             | 0.3        | Different directories, same parent       |

**Heuristic:** PRs working in the same module/directory often have dependencies.

#### Test Overlap (0.5 - 0.85)

**Medium-high confidence** - PRs test the same modules.

| Pattern            | Confidence | Example                                                    |
| ------------------ | ---------- | ---------------------------------------------------------- |
| Shared test file   | 0.85       | Both modify `tests/core.spec.ts`                           |
| Same module tested | 0.65       | PR-101: `tests/core.spec.ts`, PR-102: `tests/core.test.ts` |
| Related test files | 0.5        | Both modify tests in `tests/api/`                          |

**Heuristic:** If PRs test the same module, their implementations may be related.

### When to Trust Implicit Dependencies

✅ **High confidence (≥0.7)** - likely a real dependency:

- Both PRs modify the same critical file (`core.ts`, `schema.ts`)
- Extensive file overlap (5+ files)
- Test files overlap suggests implementation dependency

⚠️ **Medium confidence (0.4-0.7)** - requires human review:

- Partial file overlap (1-3 files)
- Directory proximity but different concerns
- Test overlap but different features

❌ **Low confidence (<0.4)** - probably coincidence:

- Minimal file overlap
- Common utility files (`utils.ts`, `types.ts`)
- Documentation changes

### When to Add Explicit Dependencies

Even with high-confidence suggestions, **always prefer explicit dependencies**:

1. **Clarity:** Human-readable intent in PR descriptions
2. **Determinism:** Explicit deps never change (file-based suggestions can)
3. **Debugging:** Easier to understand why PRs are ordered a certain way
4. **Trust:** Team members understand the relationship

**Best practice:** Use suggestions to **discover** missing dependencies, then **add explicit footers** to PR descriptions.

### Suggestion Output Formats

#### Table Format (Human-Readable)

```bash
lex-pr plan --suggest-deps
```

```
📊 Dependency Suggestions (3 found):

| From   | To     | Confidence | Heuristic          | Reason                              |
|--------|--------|------------|--------------------|-------------------------------------|
| PR-101 | PR-102 | 95%        | shared-files       | shared file modifications           |
| PR-201 | PR-202 | 65%        | test-overlap       | tests for same module               |
| PR-301 | PR-302 | 50%        | directory-proximity| both modify files in 1 common dir   |
```

#### JSON Format (Machine-Readable)

```bash
lex-pr plan --suggest-deps --json
```

```json
{
  "suggestions": [
    {
      "from": "PR-101",
      "to": "PR-102",
      "reason": "shared file modifications",
      "confidence": 0.95,
      "sharedFiles": ["src/core.ts", "src/utils.ts"],
      "heuristic": "shared-files"
    }
  ]
}
```

#### Markdown Format (Review-Friendly)

```bash
lex-pr plan --suggest-deps --format=markdown
```

```markdown
## Dependency Suggestions

### High Confidence (≥0.7)

- **PR-101 → PR-102** (95% confidence)
  - Heuristic: shared-files
  - Reason: shared file modifications
  - Files: `src/core.ts`, `src/utils.ts`

### Medium Confidence (0.4-0.7)

- **PR-201 → PR-202** (65% confidence)
  - Heuristic: test-overlap
  - Reason: tests for same module
```

---

## Validation & Troubleshooting

The planner validates plans before execution to catch errors early.

### Validation Checks

1. **Cycle detection** - no circular dependencies
2. **Reference validation** - all deps point to valid PRs
3. **Self-dependency check** - no PR depends on itself
4. **Orphan detection** - warn about isolated PRs

### Error: Dependency Cycle Detected

**Symptom:**

```
❌ Validation failed: Dependency cycle detected
Cycle path: PR-100 → PR-101 → PR-102 → PR-100
```

**Cause:** Circular dependency in the graph.

**Diagnosis:**

1. Review the cycle path from the error message
2. Check PR descriptions for circular `Depends-on:` footers
3. Check file overlap (might be false positive from heuristics)

**Solution:**

```bash
# Step 1: Identify the weakest link in the cycle
lex-pr plan --suggest-deps --json | jq '.suggestions[] | select(.from == "PR-100" and .to == "PR-101")'

# Step 2: If the dependency is weak (low confidence), remove it
# Edit PR description, remove "Depends-on: #100"

# Step 3: Regenerate plan
lex-pr plan --from-github --output plan.json
```

**Example fix:**

Before (cycle):

```
PR-100: Depends-on: #102
PR-101: Depends-on: #100
PR-102: Depends-on: #101
```

After (broken cycle):

```
PR-100: (no dependencies)
PR-101: Depends-on: #100
PR-102: Depends-on: #101
```

### Warning: Unreachable/Orphan PRs

**Symptom:**

```
⚠️  Warning: Orphan PRs detected (no dependencies, no dependents)
  - PR-999 (hotfix/security-patch)
```

**Cause:** PR has no dependencies and no other PRs depend on it.

**Is this a problem?**

Sometimes **NO** (valid scenarios):

- Independent hotfixes
- Parallel feature work
- Refactors with no dependencies

Sometimes **YES** (missing dependencies):

- PR should depend on foundation work
- PR is part of a stack but missing `Depends-on:` footer

**Diagnosis:**

```bash
# Check if suggestions exist for the orphan PR
lex-pr plan --suggest-deps | grep "PR-999"
```

**Solution:**

If suggestions exist:

```bash
# Add explicit dependency to PR description
# Edit PR-999, add "Depends-on: #100"
```

If truly independent:

```bash
# Ignore the warning - this is expected
```

### Low-Confidence Implicit Dependencies

**Symptom:**

```
📊 Dependency Suggestions (1 found):
| From   | To     | Confidence | Heuristic          |
|--------|--------|------------|-------------------|
| PR-101 | PR-102 | 35%        | directory-proximity|
```

**Cause:** File overlap is weak, heuristics are uncertain.

**Options:**

1. **Add explicit dependency** (if relationship exists):

   ```markdown
   # In PR-102 description

   Depends-on: #101
   ```

2. **Ignore suggestion** (if PRs are truly independent):

   ```bash
   # Use higher threshold to filter out low-confidence suggestions
   lex-pr plan --suggest-deps --threshold=0.5
   ```

3. **Investigate further**:
   ```bash
   # Get detailed file overlap info
   lex-pr plan --suggest-deps --json | jq '.suggestions[] | select(.confidence < 0.5)'
   ```

### Plan Differs Between Runs

**Symptom:** Running the same command twice produces different output.

**Cause:** This should **never happen** - it's a determinism bug.

**Diagnosis:**

```bash
# Generate plan twice, compare
lex-pr plan --from-github --output plan1.json
lex-pr plan --from-github --output plan2.json
diff plan1.json plan2.json
```

**If different:**

1. Check for timestamp fields (file them as a bug)
2. Check for random ordering (file them as a bug)
3. Check for network timing issues (file them as a bug)

**Workaround:**

```bash
# Pin specific commit SHAs in plan (not yet supported - file a feature request)
```

**Report:** This is a critical bug - please [file an issue](https://github.com/Guffawaffle/LexRunner/issues/new/choose) with:

- Commands run
- Diff of the two plans
- Environment details (OS, Node version, lex-pr version)

---

## Workflows & Best Practices

Choose the workflow that matches your team's size and trust level.

### Workflow 1: Full Auto (Trust the Planner)

**Best for:** Small teams (2-5 devs), high trust in tooling

```bash
# One-shot: generate and execute
lex-pr plan --from-github --output plan.json
lex-pr execute --plan plan.json
```

**Pros:**

- ✅ **Fast** - minimal overhead
- ✅ **No manual review** - trust heuristics
- ✅ **Catch implicit deps** - discovers missed relationships

**Cons:**

- ❌ **Potential errors** - heuristics can be wrong
- ❌ **Less control** - no human verification
- ❌ **Trust required** - team must trust the planner

**When to use:**

- Small codebase with clear module boundaries
- High test coverage (gates catch integration issues)
- Team is comfortable with automation

### Workflow 2: Review Before Execute

**Best for:** Medium teams (5-10 devs), safety-first culture

```bash
# Step 1: Generate suggestions for review
lex-pr plan --suggest-deps --format=markdown > review.md

# Step 2: Human reviews review.md
#   - Approve high-confidence suggestions
#   - Reject false positives
#   - Add missing explicit dependencies

# Step 3: Update PR descriptions with approved dependencies
# (Manual step: edit PR descriptions in GitHub)

# Step 4: Generate final plan (with updated explicit deps)
lex-pr plan --from-github --output plan.json

# Step 5: Execute
lex-pr execute --plan plan.json
```

**Pros:**

- ✅ **Human oversight** - catches errors early
- ✅ **Learning opportunity** - team understands dependencies
- ✅ **Trust building** - verify heuristics are working

**Cons:**

- ❌ **Slower** - requires review step
- ❌ **Manual updates** - editing PR descriptions
- ❌ **Cognitive load** - reviewing suggestions

**When to use:**

- Medium-sized team with complex dependencies
- High-stakes releases (production deployments)
- Building trust in the planner (early adoption)

### Workflow 3: Hybrid (Explicit + Suggestions)

**Best for:** Large teams (10+ devs), complex repos

```bash
# Step 1: PRs already have some explicit dependencies
# (Team discipline: always add Depends-on: for known deps)

# Step 2: Generate suggestions for missing dependencies
lex-pr plan --suggest-deps --threshold=0.7 > suggestions.md

# Step 3: Review high-confidence suggestions only (≥0.7)
# Add them to PR descriptions

# Step 4: Generate plan (combines explicit + reviewed implicit)
lex-pr plan --from-github --output plan.json

# Step 5: Execute
lex-pr execute --plan plan.json
```

**Pros:**

- ✅ **Best of both worlds** - explicit control + discovery
- ✅ **Scales well** - clear rules for large teams
- ✅ **High confidence** - only trust strong signals

**Cons:**

- ❌ **Requires discipline** - team must add explicit deps
- ❌ **Configuration needed** - threshold tuning
- ❌ **More steps** - review + update cycle

**When to use:**

- Large codebase with many concurrent PRs
- Established team with good practices
- Complex dependency patterns (stacks, diamonds, etc.)

### Best Practices Summary

| Practice                 | Why                     | How                                    |
| ------------------------ | ----------------------- | -------------------------------------- |
| **Prefer explicit deps** | Clarity and determinism | Always add `Depends-on:` when known    |
| **Use high thresholds**  | Filter noise            | `--threshold=0.7` for hybrid workflow  |
| **Review suggestions**   | Catch errors            | Generate `review.md` before execution  |
| **Test heuristics**      | Build trust             | Compare suggestions to ground truth    |
| **Document decisions**   | Team alignment          | Add comments in PR descriptions        |
| **Validate early**       | Catch cycles            | Run `plan --validate` before execution |
| **Commit plans**         | Reproducibility         | Store `plan.json` in version control   |

---

## Advanced Topics

### Custom Scoring Weights

Adjust the weights for different heuristics:

```typescript
import { scoreDependencies } from "./planner/dependencyScoring.js";

const scores = await scoreDependencies(prs, fileAnalyzer, {
  weights: {
    explicit: 1.0, // Explicit deps always win
    sharedFiles: 0.8, // Lower weight for file overlap
    directoryProximity: 0.5, // Lower weight for directory proximity
    testOverlap: 0.6, // Medium weight for test overlap
  },
  threshold: 0.5, // Filter out scores below 0.5
});
```

**Use case:** Tune weights based on your codebase characteristics.

### Filtering PRs by Label

```bash
# Only include PRs with specific labels
lex-pr plan --from-github --labels "ready-to-merge,stack:*"

# Exclude PRs with specific labels
lex-pr plan --from-github --exclude-labels "do-not-merge,wip"
```

**Use case:** Focus on a subset of PRs (e.g., only "ready" PRs).

### Excluding Stale PRs

```bash
# Only include PRs updated in the last 7 days
lex-pr plan --from-github --since 7d

# Only include PRs created after a specific date
lex-pr plan --from-github --created-after 2024-01-01
```

**Use case:** Ignore old PRs that are no longer relevant.

### Plan Diffing

Compare two plans to see what changed:

```bash
# Generate plan at two different times
lex-pr plan --from-github --output plan-old.json
# (PRs are updated)
lex-pr plan --from-github --output plan-new.json

# Diff the plans
lex-pr plan-diff plan-old.json plan-new.json
```

**Output:**

```
📊 Plan Diff:

Added PRs:
  + PR-105 (new-feature)

Removed PRs:
  - PR-99 (merged)

Changed dependencies:
  ~ PR-101: added dep on PR-104
```

**Use case:** Understand how plan evolved as PRs are added/merged.

### Incremental Planning

Add new PRs to an existing plan without regenerating:

```bash
# Start with existing plan
lex-pr plan --from-github --output plan.json

# Add a new PR manually
# (Edit plan.json, add new item)

# Validate the updated plan
lex-pr plan --validate plan.json
```

**Use case:** Quick updates without full regeneration.

---

## API Reference

This section documents the public APIs in the planner modules. Each function includes TypeScript signatures, examples, and links to source code.

### `parsePRDescription()`

Parse dependencies and metadata from a PR description.

**Module:** `src/planner/dependencyParser.ts`

**Signature:**

```typescript
function parsePRDescription(
  prNumber: number,
  description: string | null,
  options?: ParserOptions
): ParsedDependency;
```

**Parameters:**

- `prNumber` - PR number (e.g., `123`)
- `description` - PR body text (can be `null`)
- `options` - Parsing options
  - `repository?: string` - Owner/repo for normalization (e.g., `"owner/repo"`)
  - `partialExtraction?: boolean` - Continue on errors (default: `false`)

**Returns:** `ParsedDependency` object with:

- `prId: string` - Normalized PR ID (e.g., `"PR-123"`)
- `dependencies: string[]` - Array of dependency references
- `gates?: { skip?: string[], required?: string[] }` - Gate overrides
- `metadata?: { priority?: string, labels?: string[], ... }` - Extracted metadata

**Example:**

```typescript
import { parsePRDescription } from "./planner/dependencyParser.js";

const description = `
Add authentication API.

Depends-on: #100, #101
Required: security-scan
`;

const result = parsePRDescription(123, description, {
  repository: "owner/repo",
});

console.log(result);
// {
//   prId: "PR-123",
//   dependencies: ["#100", "#101"],
//   gates: { required: ["security-scan"] }
// }
```

**See also:** [Dependency Syntax Reference](#dependency-syntax-reference)

### `scoreDependencies()`

Score and rank dependencies by combining explicit and implicit signals.

**Module:** `src/planner/dependencyScoring.ts`

**Signature:**

```typescript
async function scoreDependencies(
  prs: Array<{ number: number; name: string; body: string; sha: string }>,
  fileAnalyzer: FileAnalyzer,
  options?: ScoringOptions
): Promise<DependencyScore[]>;
```

**Parameters:**

- `prs` - Array of PRs with number, name, body, sha
- `fileAnalyzer` - File analyzer instance (from `createFileAnalyzer()`)
- `options` - Scoring options
  - `weights?: { explicit?, sharedFiles?, directoryProximity?, testOverlap? }` - Custom weights
  - `threshold?: number` - Filter out scores below this value (default: `0.3`)

**Returns:** Array of `DependencyScore` objects, sorted by confidence (descending), then from/to (ascending).

**Example:**

```typescript
import { scoreDependencies } from "./planner/dependencyScoring.js";
import { createFileAnalyzer } from "./planner/fileAnalysis.js";
import { Octokit } from "@octokit/rest";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const fileAnalyzer = createFileAnalyzer(octokit, "owner", "repo");

const scores = await scoreDependencies(
  [
    { number: 101, name: "PR-101", body: "Depends-on: #100", sha: "abc123" },
    { number: 102, name: "PR-102", body: "", sha: "def456" },
  ],
  fileAnalyzer,
  {
    weights: { explicit: 1.0, sharedFiles: 0.8 },
    threshold: 0.5,
  }
);

console.log(scores);
// [
//   {
//     from: "PR-101",
//     to: "PR-100",
//     score: 1.0,
//     reason: "explicit-footer",
//     evidence: { explicit: ["Depends-on: #100"] }
//   }
// ]
```

**See also:** [File-Change Heuristics](#file-change-heuristics)

### `validatePlan()`

Validate a plan for cycles, invalid references, and orphans.

**Module:** `src/planner/validation.ts`

**Signature:**

```typescript
function validatePlan(plan: Plan): {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  diagnostics: ValidationDiagnostics;
};
```

**Parameters:**

- `plan` - Plan object (from `generatePlan()` or loaded from JSON)

**Returns:** Validation result with:

- `valid: boolean` - `true` if no errors
- `errors: ValidationError[]` - Array of validation errors (cycles, invalid refs, etc.)
- `warnings: ValidationWarning[]` - Array of warnings (orphans, low confidence, etc.)
- `diagnostics: ValidationDiagnostics` - Plan statistics (nodes, edges, layers)

**Example:**

```typescript
import { validatePlan } from "./planner/validation.js";
import { loadPlan } from "./core/plan.js";

const plan = await loadPlan("plan.json");
const result = validatePlan(plan);

if (!result.valid) {
  console.error("Validation errors:");
  result.errors.forEach((err) => {
    console.error(`  - ${err.message}`);
    console.error(`    Suggestion: ${err.suggestion}`);
  });
  process.exit(1);
}

if (result.warnings.length > 0) {
  console.warn("Validation warnings:");
  result.warnings.forEach((warn) => {
    console.warn(`  - ${warn.message}`);
    console.warn(`    Affected PRs: ${warn.affectedPRs.join(", ")}`);
  });
}

console.log(
  `✓ Plan is valid: ${result.diagnostics.nodes} nodes, ${result.diagnostics.edges} edges`
);
```

**See also:** [Validation & Troubleshooting](#validation--troubleshooting)

### `createFileAnalyzer()`

Create a file analyzer for detecting implicit dependencies.

**Module:** `src/planner/fileAnalysis.ts`

**Signature:**

```typescript
function createFileAnalyzer(octokit: Octokit, owner: string, repo: string): FileAnalyzer;
```

**Parameters:**

- `octokit` - Authenticated Octokit instance
- `owner` - Repository owner
- `repo` - Repository name

**Returns:** `FileAnalyzer` instance with methods:

- `getPRFileChanges(prNumber, sha?)` - Fetch file changes for a PR
- `analyzeFiles(prs)` - Perform complete file analysis
- `clearCache()` - Clear the internal cache
- `getCacheStats()` - Get cache statistics

**Example:**

```typescript
import { createFileAnalyzer } from "./planner/fileAnalysis.js";
import { Octokit } from "@octokit/rest";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const analyzer = createFileAnalyzer(octokit, "owner", "repo");

const analysis = await analyzer.analyzeFiles([
  { number: 101, name: "PR-101", sha: "abc123" },
  { number: 102, name: "PR-102", sha: "def456" },
]);

console.log("File intersections:", analysis.fileIntersections);
console.log("Suggestions:", analysis.suggestions);
console.log("Conflicts:", analysis.conflicts);
```

**See also:** [File-Change Heuristics](#file-change-heuristics), [`src/planner/README.md`](../src/planner/README.md)

---

## Examples Gallery

Real-world examples demonstrating different dependency patterns.

### Example 1: Simple Stack (Linear)

**Scenario:** 3 PRs building on each other sequentially.

**PRs:**

- PR-100: Add auth API (foundation)
- PR-101: Add auth UI (depends on API)
- PR-102: Add auth tests (depends on UI)

**Dependencies:**

```
PR-100 → PR-101 → PR-102
```

**Plan:**

<!-- lexrunner-plan-example:diffgraph-linear -->

```json
{
  "schemaVersion": "1.0.0",
  "target": "main",
  "items": [
    { "name": "PR-100", "deps": [], "gates": [] },
    { "name": "PR-101", "deps": ["PR-100"], "gates": [] },
    { "name": "PR-102", "deps": ["PR-101"], "gates": [] }
  ]
}
```

**Merge order:**

```
Layer 0: PR-100
Layer 1: PR-101
Layer 2: PR-102
```

**Tutorial:** [01-simple-stack.md](./tutorials/diffgraph-planner/01-simple-stack.md)

### Example 2: Diamond Pattern (Fan-out/Fan-in)

**Scenario:** UI depends on both auth and API (which are independent).

**PRs:**

- PR-100: Add auth system
- PR-101: Add API endpoints
- PR-102: Add UI (depends on both PR-100 and PR-101)

**Dependencies:**

```
    PR-102 (UI)
    /        \
PR-100    PR-101
(auth)    (API)
```

**Plan:**

<!-- lexrunner-plan-example:diffgraph-diamond -->

```json
{
  "schemaVersion": "1.0.0",
  "target": "main",
  "items": [
    { "name": "PR-100", "deps": [], "gates": [] },
    { "name": "PR-101", "deps": [], "gates": [] },
    { "name": "PR-102", "deps": ["PR-100", "PR-101"], "gates": [] }
  ]
}
```

**Merge order:**

```
Layer 0: PR-100, PR-101 (parallel)
Layer 1: PR-102
```

**Tutorial:** [02-diamond-pattern.md](./tutorials/diffgraph-planner/02-diamond-pattern.md)

### Example 3: Large Batch (20+ PRs)

**Scenario:** Major refactor with 20 PRs, mixed explicit and implicit dependencies.

**Approach:**

1. Generate suggestions: `lex-pr plan --suggest-deps --threshold=0.7`
2. Review high-confidence suggestions
3. Add explicit deps to PR descriptions
4. Generate final plan: `lex-pr plan --from-github`

**Result:** Complex graph with 5-7 layers, parallel execution within each layer.

**Tutorial:** [03-large-batch.md](./tutorials/diffgraph-planner/03-large-batch.md)

### Example 4: Cycle Error (Before/After Fix)

**Before (error):**

```
PR-100: Depends-on: #102
PR-101: Depends-on: #100
PR-102: Depends-on: #101

❌ Cycle detected: PR-100 → PR-102 → PR-101 → PR-100
```

**Fix:** Remove weakest dependency (PR-100 → PR-102).

**After (valid):**

```
PR-100: (no dependencies)
PR-101: Depends-on: #100
PR-102: Depends-on: #101

✓ Valid: 3 nodes, 2 edges, 3 layers
```

**Tutorial:** [04-fixing-cycles.md](./tutorials/diffgraph-planner/04-fixing-cycles.md)

### Example 5: Mixed Explicit + Implicit

**Scenario:** Some PRs have explicit deps, others rely on file-based suggestions.

**PRs:**

- PR-100: Explicit: `Depends-on: #99`
- PR-101: No explicit deps, but modifies same files as PR-100
- PR-102: Explicit: `Depends-on: #101`

**Suggestions:**

```
PR-101 → PR-100 (0.95 confidence, shared files)
```

**Workflow:**

1. Review suggestion
2. Add to PR-101: `Depends-on: #100`
3. Regenerate plan

**Tutorial:** [05-hybrid-workflow.md](./tutorials/diffgraph-planner/05-hybrid-workflow.md)

---

## Related Documentation

- **[Dependency Parser](./dependency-parser.md)** - Detailed parser documentation
- **[Troubleshooting Planner](./troubleshooting-planner.md)** - Common errors and solutions
- **[CLI Reference](./cli.md)** - Complete CLI documentation
- **[Quickstart Guide](./quickstart.md)** - Initial setup and configuration
- **[Tutorials](./tutorials/diffgraph-planner/)** - Step-by-step tutorials

## Feedback and Support

- **Issues:** [GitHub Issues](https://github.com/Guffawaffle/LexRunner/issues)
- **Discussions:** [GitHub Discussions](https://github.com/Guffawaffle/LexRunner/discussions)
- **Epic:** [#75 - Diffgraph Planner & Dependency Auto-Discovery](https://github.com/Guffawaffle/LexRunner/issues/75)
