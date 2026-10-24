# Merge-Weave Quickstart

This guide provides an end-to-end walkthrough for executing merge-weave operations using plan files. It covers creating plans, running gates, and executing merges with both dry-run and execute modes.

## Prerequisites

- **Clean working tree**: Your repository must have no uncommitted changes
- **Remote branches**: All branches in your plan must exist as remote branches
- **Node.js 24+**: Required for running lexrunner
- **Plan file location**: Store plan files outside your working tree (e.g., `/tmp/plan.json` or `.smartergpt.local/runner/plan.json`) to avoid dirty status

## Quick Reference

```bash
# Execute gates and capture artifacts
lex-pr execute --plan ./plan.json --artifact-dir ./artifacts --json

# Preview merge operations (dry-run, default)
lex-pr merge --plan ./plan.json --json

# Execute actual merge operations
lex-pr merge --plan ./plan.json --execute --json
```

---

## Step 1: Create a Minimal Plan

Create a `plan.json` file with 2-3 branches. **Important**: Branch names must match remote branch names exactly.

### Minimal Example (Schema v1)

> **Doc Lockdown note:** This quickstart uses **Plan Schema v1** (the stable, documented format in current releases).
> A separate forward-looking document may describe **Schema v2**; treat any v2 mentions as draft until the CLI and docs are versioned together.

> **💡 Tip**: Store this plan in `.smartergpt.local/runner/plan.json` (gitignored) or `/tmp/plan.json` to avoid working tree conflicts.

<!-- lexrunner-plan-example:merge-weave-quickstart -->

```json
{
  "schemaVersion": "1.0.0",
  "target": "main",
  "policy": {
    "requiredGates": ["lint", "typecheck"],
    "optionalGates": [],
    "mergeRule": { "type": "strict-required" }
  },
  "items": [
    {
      "name": "feature/auth",
      "deps": [],
      "gates": [
        { "name": "lint", "run": "npm run lint" },
        { "name": "typecheck", "run": "npm run typecheck" }
      ]
    },
    {
      "name": "feature/api",
      "deps": ["feature/auth"],
      "gates": [
        { "name": "lint", "run": "npm run lint" },
        { "name": "typecheck", "run": "npm run typecheck" }
      ]
    },
    {
      "name": "feature/ui",
      "deps": [],
      "gates": [
        { "name": "lint", "run": "npm run lint" },
        { "name": "typecheck", "run": "npm run typecheck" }
      ]
    }
  ]
}
```

### Field Explanations

| Field                  | Description                                               | Example                              |
| ---------------------- | --------------------------------------------------------- | ------------------------------------ |
| `schemaVersion`        | Plan schema version                                       | `"1.0.0"`                            |
| `target`               | Final merge target                                        | `"main"`                             |
| `policy.requiredGates` | Gate names that must pass                                 | `["lint", "typecheck"]`              |
| `policy.mergeRule`     | Supported merge rule                                      | `{ "type": "strict-required" }`      |
| `items[].name`         | Exact remote branch for a legacy-unbound plan             | `"feature/auth"`                     |
| `items[].deps`         | Item names this item depends on                           | `["feature/auth"]`                   |
| `items[].gates`        | Gate objects, each with a unique `name` and command `run` | `[{ "name": "lint", "run": "..." }]` |

The integration branch is an execution option, not a Plan Schema field. GitHub-generated plans
instead bind PR refs and commit IDs in `gitInputs`; see [Frozen Git inputs](./frozen-git-inputs.md).

### Concurrency Control

Control parallel execution with `policy.maxWorkers`. This is a policy fragment, not a complete
executable plan:

<!-- lexrunner-non-executable-plan:merge-weave-policy-fragment -->

```json
{
  "policy": {
    "requiredGates": ["lint", "typecheck"],
    "maxWorkers": 2
  }
}
```

- `maxWorkers: 1` - Sequential execution (default, safest)
- `maxWorkers: 2` - Run 2 gates in parallel
- `maxWorkers: 4` - Run up to 4 gates in parallel

---

## Step 2: Execute Gates (Validation)

Before merging, validate that all branches pass quality gates.

### Command

```bash
lex-pr execute --plan ./plan.json --artifact-dir ./artifacts --json
```

### Flags

| Flag                   | Description                         | Default                    |
| ---------------------- | ----------------------------------- | -------------------------- |
| `--plan <file>`        | Path to plan.json                   | `plan.json`                |
| `--artifact-dir <dir>` | Where to store gate outputs         | `.smartergpt.local/runner` |
| `--json`               | Output JSON format (for automation) | `false`                    |
| `--dry-run`            | Validate plan without running gates | `false`                    |
| `--max-workers <n>`    | Override `policy.maxWorkers`        | From plan                  |

### Sample JSON Output (Success)

This is an execution-result envelope whose nested `plan` value is only a summary; it is not an
executable Plan document.

<!-- lexrunner-non-executable-plan:merge-weave-execute-success-output -->

```json
{
  "mode": "execute",
  "status": "completed",
  "plan": {
    "items": 3,
    "requiredGates": ["lint", "typecheck"]
  },
  "results": {
    "successful": 3,
    "failed": 0,
    "skipped": 0
  },
  "items": [
    {
      "id": "feature-auth",
      "branch": "feature/auth",
      "gates": {
        "lint": { "status": "passed", "duration": 1234 },
        "typecheck": { "status": "passed", "duration": 2345 }
      }
    },
    {
      "id": "feature-api",
      "branch": "feature/api",
      "gates": {
        "lint": { "status": "passed", "duration": 1567 },
        "typecheck": { "status": "passed", "duration": 2234 }
      }
    },
    {
      "id": "feature-ui",
      "branch": "feature/ui",
      "gates": {
        "lint": { "status": "passed", "duration": 1432 },
        "typecheck": { "status": "passed", "duration": 2189 }
      }
    }
  ],
  "artifactsDir": "./artifacts"
}
```

### Sample JSON Output (Failure)

This is an execution-result envelope whose nested `plan` value is only a summary; it is not an
executable Plan document.

<!-- lexrunner-non-executable-plan:merge-weave-execute-failure-output -->

```json
{
  "mode": "execute",
  "status": "failed",
  "plan": {
    "items": 3,
    "requiredGates": ["lint", "typecheck"]
  },
  "results": {
    "successful": 2,
    "failed": 1,
    "skipped": 0
  },
  "items": [
    {
      "id": "feature-auth",
      "branch": "feature/auth",
      "gates": {
        "lint": { "status": "passed", "duration": 1234 },
        "typecheck": { "status": "passed", "duration": 2345 }
      }
    },
    {
      "id": "feature-api",
      "branch": "feature/api",
      "gates": {
        "lint": { "status": "failed", "duration": 1567, "exitCode": 1 },
        "typecheck": { "status": "skipped", "reason": "required-gate-failed" }
      },
      "error": "Required gate 'lint' failed"
    },
    {
      "id": "feature-ui",
      "branch": "feature/ui",
      "gates": {
        "lint": { "status": "passed", "duration": 1432 },
        "typecheck": { "status": "passed", "duration": 2189 }
      }
    }
  ],
  "exitCode": 1
}
```

### Inspecting Artifacts

Gate outputs are stored in `--artifact-dir`:

```bash
# View artifacts
ls -la ./artifacts/

# Example structure:
# artifacts/
# ├── feature-auth/
# │   ├── lint.log
# │   └── typecheck.log
# ├── feature-api/
# │   ├── lint.log
# │   └── typecheck.log
# └── feature-ui/
#     ├── lint.log
#     └── typecheck.log

# View specific gate output
cat ./artifacts/feature-api/lint.log
```

---

## Step 3: Merge Operations

### Dry-Run Mode (Preview, Default)

Preview merge operations without executing them. **Dry-run is the default mode.**

```bash
lex-pr merge --plan ./plan.json --json
```

**Note**: `--dry-run` is enabled by default. You must use `--execute` to actually perform merges.

#### Sample Dry-Run Output

```json
{
  "mode": "dry-run",
  "lockHash": "abc123de",
  "plan": {
    "items": 3,
    "targetBranch": "main",
    "integrationBranch": "integration/wave-1"
  },
  "batches": [
    {
      "level": 0,
      "items": ["feature-auth", "feature-ui"],
      "dependencies": []
    },
    {
      "level": 1,
      "items": ["feature-api"],
      "dependencies": ["feature-auth"]
    }
  ],
  "preflight": {
    "enabled": true,
    "conflictsDetected": 0,
    "items": [
      {
        "id": "feature-auth",
        "branch": "feature/auth",
        "conflicts": []
      },
      {
        "id": "feature-ui",
        "branch": "feature/ui",
        "conflicts": []
      },
      {
        "id": "feature-api",
        "branch": "feature/api",
        "conflicts": []
      }
    ]
  },
  "estimatedDuration": "~2-3 minutes",
  "warnings": []
}
```

#### Dry-Run with Conflicts Detected

```json
{
  "mode": "dry-run",
  "lockHash": "abc123de",
  "plan": {
    "items": 3,
    "targetBranch": "main",
    "integrationBranch": "integration/wave-1"
  },
  "batches": [
    {
      "level": 0,
      "items": ["feature-auth", "feature-ui"]
    },
    {
      "level": 1,
      "items": ["feature-api"]
    }
  ],
  "preflight": {
    "enabled": true,
    "conflictsDetected": 2,
    "items": [
      {
        "id": "feature-auth",
        "branch": "feature/auth",
        "conflicts": []
      },
      {
        "id": "feature-ui",
        "branch": "feature/ui",
        "conflicts": ["src/components/Header.tsx", "src/styles/main.css"]
      },
      {
        "id": "feature-api",
        "branch": "feature/api",
        "conflicts": []
      }
    ]
  },
  "warnings": ["feature-ui has 2 potential conflicts. Review and resolve before executing."]
}
```

#### Interpreting Dry-Run Output

| Field                         | Meaning                                                              |
| ----------------------------- | -------------------------------------------------------------------- |
| `lockHash`                    | Unique hash of plan + PR head commits (idempotency key)              |
| `batches`                     | Execution order grouped by dependency level                          |
| `batches[].level`             | Dependency level (0 = no dependencies, 1 = depends on level 0, etc.) |
| `preflight.enabled`           | Whether preflight conflict detection ran                             |
| `preflight.conflictsDetected` | Number of items with potential conflicts                             |
| `warnings`                    | Issues to address before executing                                   |

### Execute Mode (Actual Merge)

Perform the actual merge operations.

```bash
lex-pr merge --plan ./plan.json --execute --json
```

#### Flags

| Flag                           | Description                             | Default |
| ------------------------------ | --------------------------------------- | ------- |
| `--execute`                    | Actually perform merge operations       | `false` |
| `--cleanup`                    | Remove integration branch after success | `false` |
| `--force`                      | Execute even if same lock hash exists   | `false` |
| `--skip-preflight`             | Skip preflight conflict detection       | `false` |
| `--fail-on-preflight-conflict` | Abort if conflicts detected             | `false` |

#### Sample Execute Output (Success)

```json
{
  "mode": "execute",
  "status": "completed",
  "lockHash": "abc123de",
  "result": {
    "successful": 3,
    "failed": 0,
    "conflicts": 0,
    "totalOperations": 3
  },
  "operations": [
    {
      "item": "feature-auth",
      "success": true,
      "conflicts": [],
      "message": "Merged feature/auth into integration/wave-1",
      "sha": "a1b2c3d4"
    },
    {
      "item": "feature-ui",
      "success": true,
      "conflicts": [],
      "message": "Merged feature/ui into integration/wave-1",
      "sha": "e5f6g7h8"
    },
    {
      "item": "feature-api",
      "success": true,
      "conflicts": [],
      "message": "Merged feature/api into integration/wave-1",
      "sha": "i9j0k1l2"
    }
  ]
}
```

#### Sample Execute Output (With Conflicts)

```json
{
  "mode": "execute",
  "status": "completed",
  "lockHash": "abc123de",
  "result": {
    "successful": 2,
    "failed": 0,
    "conflicts": 1,
    "totalOperations": 3
  },
  "operations": [
    {
      "item": "feature-auth",
      "success": true,
      "conflicts": [],
      "message": "Merged feature/auth into integration/wave-1",
      "sha": "a1b2c3d4"
    },
    {
      "item": "feature-ui",
      "success": true,
      "conflicts": ["src/components/Header.tsx", "src/styles/main.css"],
      "message": "Merged with conflicts - manual resolution required",
      "sha": null
    },
    {
      "item": "feature-api",
      "success": false,
      "conflicts": [],
      "message": "Skipped due to previous failures",
      "sha": null
    }
  ],
  "exitCode": 1
}
```

---

## Troubleshooting

### Clean Working Tree Requirement

**Problem**: `Error: Working directory is not clean. Please commit or stash changes.`

**Cause**: Merge operations require a clean working tree to safely execute git operations.

**Solutions**:

1. **Move plan file to `/tmp`**:

   ```bash
   # If plan.json is causing dirty status
   mv plan.json /tmp/plan.json
   lex-pr merge --plan /tmp/plan.json --execute
   ```

2. **Check git status**:

   ```bash
   git status

   # Example output showing dirty tree:
   # On branch main
   # Changes not staged for commit:
   #   modified:   plan.json
   #   modified:   src/index.ts
   ```

3. **Commit or stash changes**:

   ```bash
   # Option 1: Commit changes
   git add .
   git commit -m "WIP: Changes before merge-weave"

   # Option 2: Stash changes
   git stash push -m "Before merge-weave"

   # Run merge-weave
   lex-pr merge --plan ./plan.json --execute

   # Option 3: Restore stash after completion
   git stash pop
   ```

4. **Use gitignored directory for plans**:
   ```bash
   # Store plans in .smartergpt.local/runner (already gitignored)
   mkdir -p .smartergpt.local/runner
   cp plan.json .smartergpt.local/runner/plan.json
   lex-pr merge --plan .smartergpt.local/runner/plan.json --execute
   ```

### Conflict Handling

**Problem**: Merge resulted in conflicts

**What happens**:

- Merge operation pauses in conflicted state
- `weave-lock.json` is created to track progress
- Conflicted files are marked in git

**Resolution steps**:

1. **Check conflict status**:

   ```bash
   git status

   # Example output:
   # On branch integration/wave-1
   # You have unmerged paths.
   #   (fix conflicts and run "git commit")
   #
   # Unmerged paths:
   #   (use "git add <file>..." to mark resolution)
   #     both modified:   src/components/Header.tsx
   #     both modified:   src/styles/main.css
   ```

2. **View conflicted files**:

   ```bash
   git diff --name-only --diff-filter=U

   # Output:
   # src/components/Header.tsx
   # src/styles/main.css
   ```

3. **Resolve conflicts manually**:

   ```bash
   # Edit files to resolve conflicts
   vim src/components/Header.tsx
   vim src/styles/main.css

   # Mark as resolved
   git add src/components/Header.tsx src/styles/main.css

   # Complete merge
   git commit -m "Merge feature/ui with conflict resolution"
   ```

4. **Or abort the merge**:

   ```bash
   # Abort current merge
   git merge --abort

   # Delete integration branch
   git branch -D integration/wave-1

   # Remove lock file
   rm weave-lock.json
   ```

### Branch Not Found

**Problem**: `Error: Branch 'feature/xyz' not found`

**Cause**: Branch name in plan doesn't match remote branch

**Solutions**:

1. **List remote branches**:

   ```bash
   git branch -r | grep feature

   # Example output:
   # origin/feature/auth
   # origin/feature/api-endpoints  # Note: not 'feature/api'
   # origin/feature/ui
   ```

2. **Update the item name to the exact branch** (for a legacy-unbound plan):

   <!-- lexrunner-plan-example:merge-weave-correct-branch -->

   ```json
   {
     "schemaVersion": "1.0.0",
     "target": "main",
     "items": [
       {
         "name": "feature/api-endpoints",
         "deps": [],
         "gates": []
       }
     ]
   }
   ```

3. **Fetch latest branches**:
   ```bash
   git fetch --all
   ```

### Lock Hash Conflict

**Problem**: `Skipping execution - identical lock hash found`

**Cause**: Same plan with same PR heads already executed (idempotency)

**Solutions**:

1. **Use `--force` to override**:

   ```bash
   lex-pr merge --plan ./plan.json --execute --force
   ```

2. **Remove lock file manually**:

   ```bash
   rm weave-lock.json
   lex-pr merge --plan ./plan.json --execute
   ```

3. **Check if previous execution completed**:

   ```bash
   cat weave-lock.json

   # Example:
   # {
   #   "lockHash": "abc123de",
   #   "status": "completed",
   #   "timestamp": "2024-12-13T02:00:00Z"
   # }
   ```

### Where Artifacts Go

Artifacts (gate outputs, logs, cache) are stored in `--artifact-dir`:

```bash
# Default location
ls -la .smartergpt.local/runner/

# Custom location
lex-pr execute --plan ./plan.json --artifact-dir /tmp/artifacts
ls -la /tmp/artifacts/

# Typical structure:
# artifacts/
# ├── <item-id>/
# │   ├── <gate-name>.log
# │   ├── <gate-name>.exitcode
# │   └── <gate-name>.duration
# ├── cache/
# └── logs/
```

To inspect specific gate output:

```bash
# View gate log
cat .smartergpt.local/runner/feature-auth/lint.log

# Check exit code
cat .smartergpt.local/runner/feature-auth/lint.exitcode

# Check duration (milliseconds)
cat .smartergpt.local/runner/feature-auth/lint.duration
```

---

## CI Integration Example

Use dry-run mode in CI to validate merge plans before execution:

```yaml
# .github/workflows/merge-weave-gate.yml
name: Merge-Weave Gate

on:
  pull_request:
    paths:
      - "plan.json"

jobs:
  validate-plan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0 # Need full history for branch checks

      - uses: actions/setup-node@v7
        with:
          node-version: "24"

      - name: Install lexrunner
        run: npm install -g lexrunner

      - name: Dry-run merge-weave
        run: |
          set -e
          lex-pr merge --plan ./plan.json --json --fail-on-preflight-conflict > dry-run.json
          jq . dry-run.json

      - name: Check for conflicts
        run: |
          set -e
          CONFLICTS=$(jq -r '.preflight.conflictsDetected' dry-run.json)
          if [ "$CONFLICTS" -gt 0 ]; then
            echo "❌ Preflight detected $CONFLICTS potential conflicts"
            jq '.preflight.items[] | select(.conflicts | length > 0)' dry-run.json
            exit 1
          fi
          echo "✅ No conflicts detected"

      - name: Upload dry-run results
        uses: actions/upload-artifact@v7
        with:
          name: merge-weave-dry-run
          path: dry-run.json
```

---

## Reference Links

- **Historical graph fixture (not a current Plan)**:
  [`merge-weave-plan.json`](../merge-weave-plan.json) uses the retired `nodes` / `dependsOn` shape
  and is rejected by the current strict Plan schema. Use the validated examples earlier in this
  guide instead.
- **Plan Schema**: [Plan Schema Documentation](./schemas.md#plan-schema-srcschemats) - Full schema reference for plan.json
- **State Machine**: [Merge-Weave State Machine](./merge-weave-state-machine.md) - Execution state transitions and resume capability
- **Advanced CLI**: [Advanced CLI Features](./advanced-cli.md) - Advanced merge-weave options and automation
- **Autopilot Levels**: [Autopilot Levels](./autopilot-levels.md) - Automated PR creation and management

---

## Next Steps

1. **Create your first plan**: Start with 2-3 branches to get familiar
2. **Run gates locally**: Validate branches pass quality checks
3. **Preview with dry-run**: Always dry-run first to check for conflicts
4. **Execute merge**: Run actual merge operations
5. **Automate in CI**: Set up CI gates to validate plans on PR changes

For production use:

- Use `--fail-on-preflight-conflict` in CI to catch conflicts early
- Store plans in version control for audit trail
- Use `--track-turncost` to measure coordination overhead
- Enable `--cleanup` to remove integration branches automatically
