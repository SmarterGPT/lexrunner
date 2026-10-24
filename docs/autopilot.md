# Autopilot Levels

Autopilot provides progressive automation for merge-weave execution, from report-only analysis to full integration branch creation.

## Overview

The autopilot system implements a "ladder of automation" with increasing levels of capability:

- **Level 0**: Report-only analysis (no side effects) ✅ **Implemented**
- **Level 1**: Artifact generation (JSON/MD deliverables) ✅ **Implemented**
- **Level 2**: PR annotation + status checks ✅ **Implemented**
- **Level 3**: Integration branch creation + merge ✅ **Implemented**
- **Level 4**: Finalize + close superseded PRs ✅ **Implemented**

## Level 0: Report-Only Analysis

Analyzes the merge plan and provides recommendations without generating any artifacts or making any changes.

### Usage

```bash
# Basic usage
lex-pr autopilot plan.json --level 0

# JSON output mode
lex-pr autopilot plan.json --level 0 --json
```

### Output

Prints analysis to stdout including:

- Plan summary (items, levels)
- Merge order computation
- Recommendations for execution

### Use Cases

- Quick validation of plan structure
- CI/CD pipeline checks
- Development workflow verification

## Level 1: Artifact Generation

Extends Level 0 by generating structured JSON and Markdown deliverables to support both manual and automated workflows.

### Usage

```bash
# Generate artifacts (requires writable profile)
lex-pr autopilot plan.json --level 1 --profile-dir .smartergpt.local/

# Use custom profile directory
lex-pr autopilot plan.json --level 1 --profile-dir /path/to/profile

# JSON output mode
lex-pr autopilot plan.json --level 1 --json
```

### Write Protection

Level 1 respects the write protection discipline:

- **role=example**: Read-only, writes are rejected
- **role=local**: Writable, artifacts can be generated

To use Level 1, ensure you have a writable profile:

```bash
# Option 1: Use local profile override
mkdir -p .smartergpt.local
echo "role: local" > .smartergpt.local/profile.yml
lex-pr autopilot plan.json --level 1

# Option 2: Set environment variable
export LEX_PR_PROFILE_DIR=/path/to/writable/profile
lex-pr autopilot plan.json --level 1

# Option 3: Use --profile-dir flag
lex-pr autopilot plan.json --level 1 --profile-dir /path/to/writable/profile
```

### Generated Artifacts

All artifacts are generated in `.smartergpt/deliverables/weave-{timestamp}/`:

#### 1. `analysis.json`

Structured analysis data with schema versioning:

The nested `nodes` graph illustrates a historical analysis artifact, not the current executable
Plan schema.

<!-- lexrunner-non-executable-plan:autopilot-legacy-plan-graph -->

```json
{
  "schemaVersion": "1.0.0",
  "timestamp": "2025-10-02T15:30:00Z",
  "plan": {
    "nodes": [...],
    "policy": {...}
  },
  "mergeOrder": [["PR-123"], ["PR-456", "PR-789"]],
  "conflicts": [],
  "recommendations": [...]
}
```

#### 2. `weave-report.md`

Human-readable execution recommendations:

- Plan summary
- Merge order breakdown
- Item details with dependencies and gates
- Execution recommendations

#### 3. `gate-predictions.json`

Expected gate outcomes for verification:

```json
{
  "schemaVersion": "1.0.0",
  "timestamp": "2025-10-02T15:30:00Z",
  "predictions": [
    {
      "item": "feature-a",
      "gate": "lint",
      "expectedStatus": "pass",
      "reason": "Gate defined in plan"
    }
  ]
}
```

#### 4. `execution-log.md`

Template for manual execution tracking:

- Pre-execution checklist
- Level-by-level execution steps
- Post-execution verification

#### 5. `metadata.json`

Runtime metadata:

```json
{
  "schemaVersion": "1.0.0",
  "timestamp": "2025-10-02T15:30:00Z",
  "runnerVersion": "0.1.0",
  "levelExecuted": 1,
  "profilePath": "/path/to/profile"
}
```

### Use Cases

- **Manual workflows**: Use generated reports and templates for guided execution
- **CI/CD integration**: Parse JSON artifacts for automated decision-making
- **Documentation**: Archive execution plans and recommendations
- **Debugging**: Compare planned vs. actual execution outcomes

## Artifact Versioning

All JSON artifacts include `schemaVersion` fields following semantic versioning:

- **Patch** (1.0.x): Additive optional fields or documentation changes
- **Minor** (1.x.0): Additive required fields with safe defaults
- **Major** (x.0.0): Breaking changes to structure or semantics

Consumers should validate schema versions before parsing artifacts.

## Timestamps

All artifacts use ISO 8601 timestamps (UTC) for consistency:

```
2025-10-02T15:30:00.123Z
```

Directory names use filesystem-safe format:

```
weave-2025-10-02T15-30-00-123
```

## Error Handling

### Write Protection Errors

```bash
$ lex-pr autopilot plan.json --level 1
Error: Cannot write autopilot artifacts: profile at "/path/to/profile" has role="example" (read-only).
Use a local profile (.smartergpt.local/) or set LEX_PR_PROFILE_DIR to a writable location.
```

### Invalid Level

```bash
$ lex-pr autopilot plan.json --level 99
Error: unsupported autopilot level 99 (supported: 0, 1)
```

### Missing Plan File

```bash
$ lex-pr autopilot --level 0
Error: plan file is required (use --plan <file> or provide as argument)
```

## Integration with Existing Workflows

### With plan Command

```bash
# Generate plan
lex-pr plan --from-github --query "is:open is:pr" --out .smartergpt.local/runner

# Run autopilot on generated plan
lex-pr autopilot .smartergpt.local/runner/plan.json --level 1
```

### With execute Command

```bash
# Generate autopilot artifacts first
lex-pr autopilot plan.json --level 1 --profile-dir .smartergpt.local/

# Review artifacts
cat .smartergpt.local/deliverables/weave-*/weave-report.md

# Execute plan with gate validation
lex-pr execute plan.json --artifact-dir ./gate-results
```

### CI/CD Pipeline

```yaml
# Example GitHub Actions workflow
- name: Generate autopilot artifacts
  run: |
    npm run cli -- autopilot plan.json --level 1 --profile-dir ./workspace --json > autopilot-result.json

- name: Upload artifacts
  uses: actions/upload-artifact@v7
  with:
    name: autopilot-deliverables
    path: ./workspace/deliverables/

- name: Check success
  run: |
    if ! jq -e '.success' autopilot-result.json > /dev/null; then
      echo "Autopilot failed"
      exit 1
    fi
```

## All Levels Implemented ✅

All autopilot levels (0-4) have been successfully implemented:

### Level 2: PR Annotation + Status Checks ✅

- Comment on PRs with gate results
- Update PR status checks
- Label PRs based on merge readiness

### Level 3: Integration Branch Creation + Merge ✅

- Create integration branch
- Perform actual merges following computed order
- Handle conflicts with mechanical rules

### Level 4: Finalize + Close Superseded PRs ✅

- Merge integration branch to target
- Close superseded PRs (with `--close-superseded` flag)
- Cleanup integration branches after successful merge
- Post-merge validation and verification
- Rollback capabilities for failed operations

For detailed usage, see [Autopilot Levels Documentation](./autopilot-levels.md).

## Related Documentation

- [Autopilot Levels](./autopilot-levels.md) - Complete autopilot documentation
- [Merge-Weave Analysis](./merge-weave-analysis.md) - Strategic planning and epic breakdown
- [Profile Resolver](../src/config/profileResolver.ts) - Write protection and profile precedence
- [Plan Schema](../src/schema.ts) - Plan structure and validation
