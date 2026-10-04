# CLI Reference

Complete reference for the lexrunner command-line interface, including all subcommands, options, and JSON output schemas.

> **📖 See Also**:
>
> - [Merge-Weave Quickstart](./merge-weave-quickstart.md) - End-to-end guide for merge-weave operations
> - [Autopilot Levels](./autopilot-levels.md) - Comprehensive guide to automation levels 0-4
> - [Advanced CLI Features](./advanced-cli.md) - Power user tools and interactive modes
> - [Command Creation Guide](./command-creation-guide.md) - How to add new commands to the CLI

## Architecture

The lexrunner CLI uses a **modular command architecture** that provides:

- **Maintainability**: Each command lives in its own module under `src/commands/`
- **Testability**: Business logic separated from CLI registration
- **Consistency**: Shared utilities for output, flags, and exit handling
- **Extensibility**: Easy to add new commands following established patterns

### Command Registration Flow

```
┌─────────────────┐
│   src/cli.ts    │  Entry point, parses global flags
└────────┬────────┘
         │ registerCommands()
         ↓
┌─────────────────────────────────────────────┐
│ src/commands/                               │
│  ├── init.ts         → registerInitCommand  │
│  ├── plan.ts         → registerPlanCommand  │
│  ├── execute.ts      → registerExecuteCmd   │
│  ├── merge.ts        → registerMergeCmd     │
│  └── ...                                    │
└─────────────────────────────────────────────┘
         │
         ↓ Each command registers with Commander
┌─────────────────┐
│  Commander.js   │  Handles argument parsing & dispatch
└────────┬────────┘
         │
         ↓ .action() handler
┌─────────────────────────────────────────────┐
│ Business Logic (pure functions)             │
│  • Separated from CLI concerns              │
│  • Unit testable                            │
│  • Returns typed results                    │
└─────────────────────────────────────────────┘
         │
         ↓
┌─────────────────────────────────────────────┐
│ Shared Utilities                            │
│  • src/cli/output.js    (JSON output)       │
│  • src/cli/flags.js     (global flags)      │
│  • src/cli/exitHandler.js (error handling)  │
└─────────────────────────────────────────────┘
```

### Command Module Pattern

Each command module exports a single registration function:

```typescript
// src/commands/myCommand.ts
import { Command } from "commander";

export function registerMyCommandCommand(program: Command): void {
  program
    .command("my-command")
    .description("Command description")
    .action(async (args, options) => {
      // Thin wrapper - delegates to business logic
      const result = await executeMyCommand(args, options);
      handleOutput(result, options);
    });
}

// Pure, testable business logic
async function executeMyCommand(args, options) {
  // All logic here
}
```

**Key Principles:**

- **Separation of Concerns**: CLI registration separate from business logic
- **Pure Functions**: Business logic has no side effects (testable)
- **Consistent Output**: All commands support `--json` and human-readable formats
- **Error Handling**: Use `throwExit()` from `src/cli/exitHandler.js`

### Shared Utilities

#### Output (`src/cli/output.js`)

```typescript
import { writeJsonOutput } from '../cli/output.js';

// Canonical JSON output to stdout
writeJsonOutput({ success: true, items: [...] });
```

#### Exit Handling (`src/cli/exitHandler.js`)

```typescript
import { throwExit, CLIExitSignal } from "../cli/exitHandler.js";

// Graceful exit with error message
throwExit(new Error("Operation failed"), 1);

// Exit with success
throw new CLIExitSignal(0, "Operation complete");
```

#### Global Flags (`src/cli/flags.js`)

```typescript
import { parseGlobalFlags } from "../cli/flags.js";

// Access global flags (--json, --no-color, etc.)
const globalOpts = parseGlobalFlags(process.argv);
```

### Adding New Commands

See the **[Command Creation Guide](./command-creation-guide.md)** for:

- Step-by-step command creation
- Templates and examples
- Testing patterns
- Documentation requirements
- Complete checklist

Quick reference:

1. Create `src/commands/myCommand.ts`
2. Export `registerMyCommandCommand(program: Command)`
3. Register in `src/cli.ts`
4. Add tests in `tests/commands/myCommand.spec.ts`
5. Update this file (`docs/cli.md`) with command reference

---

## Global Options

```bash
lex-pr [options] [command]

Options:
  -V, --version        Output the version number
  --no-color           Disable ANSI color codes in output
  --json               Enable JSON output mode (implies --no-color)
  --log-format <fmt>   Log output format: 'json' or 'human' (default: 'human')
  -h, --help           Display help for command
```

### Output Control Flags

#### `--no-color`

Unconditionally disables ANSI escape codes in output, regardless of TTY detection.

**Use cases:**

- Force plain text output when piping to tools that don't handle ANSI codes
- Debugging in environments where color codes interfere with output
- CI/CD pipelines where color codes are not needed

**Example:**

```bash
lexrunner --no-color config:inspect
```

#### `--json`

Enables JSON output mode and automatically disables colors. This flag:

- Forces JSON output to stdout for supported commands
- Disables ANSI color codes (implies `--no-color`)
- Suppresses human-friendly decorations (emojis, tips, progress indicators)
- Uses plain text prefixes in error messages (e.g., `[lexrunner]` instead of ❌)

**Use cases:**

- Machine-readable output for automation and scripting
- Clean JSON output for piping to `jq` or other JSON processors
- CI/CD pipelines and automated testing

**Example:**

```bash
lexrunner --json plan > plan.json
```

**Note:** The `--json` flag can be used either globally or at the command level:

```bash
# Global flag (affects all output)
lex-pr --json plan

# Command-level flag (some commands support this)
lex-pr plan --json
```

## Configuration Precedence

Configuration values are resolved in the following order (highest to lowest priority):

1. **Command-line flags** (`--out ./custom-dir`)
2. **Environment variables** (`LEX_PR_OUT_DIR=./custom-dir`)
3. **Configuration files** (`.smartergpt/config.json`)
4. **Built-in defaults**

### Environment Variables

| Variable             | Description                                   | Default              |
| -------------------- | --------------------------------------------- | -------------------- |
| `LEX_PR_OUT_DIR`     | Default output directory for artifacts        | `.smartergpt/runner` |
| `LEX_PR_MAX_WORKERS` | Maximum parallel gate execution               | `1`                  |
| `NO_COLOR`           | Disable ANSI color codes when set (any value) | unset                |
| `LOG_FORMAT`         | Log output format: 'json' or 'human'          | `human`              |

## Commands

### `init`

Initialize lexrunner workspace with interactive setup wizard.

```bash
lex-pr init [options]

Options:
  --force                 Overwrite existing configuration files
  --non-interactive       Run without prompts (use environment variables)
  --github-token <token>  GitHub token for authentication
  --profile-dir <dir>     Profile directory (default: .smartergpt.local)
  -h, --help              Display help for command
```

#### What Gets Created

The init command creates a complete workspace configuration:

```
.smartergpt.local/
├── profile.yml              # Profile metadata (role: local)
├── intent.md                # Project goals and scope
├── scope.yml                # PR discovery rules
├── deps.yml                 # Dependency relationships
├── gates.yml                # Quality gates configuration
└── pull-request-template.md # PR template with dependency syntax
```

#### Interactive Setup

When run without `--non-interactive`, the wizard will:

1. Detect project type (Node.js, Python, Rust, Go, etc.)
2. Prompt for GitHub token (optional)
3. Validate repository access if token provided
4. Create workspace configuration files
5. Display next steps

#### Examples

```bash
# Interactive setup with prompts
lex-pr init

# Non-interactive setup (use environment variables)
export GITHUB_TOKEN=your_token_here
lex-pr init --non-interactive

# Force overwrite existing configuration
lex-pr init --force

# Use custom profile directory
lex-pr init --profile-dir .smartergpt.custom

# Provide GitHub token via CLI
lex-pr init --github-token ghp_your_token_here
```

#### Environment Variables

| Variable       | Description                  | Used When            |
| -------------- | ---------------------------- | -------------------- |
| `GITHUB_TOKEN` | GitHub personal access token | Token authentication |
| `GH_TOKEN`     | Alternative GitHub token     | Token authentication |

#### Exit Codes

- `0`: Initialization successful
- `1`: Initialization failed (general error)
- `2`: Write protection error (tried to write to read-only profile)

#### Profile Directory Selection

The init command automatically selects the appropriate profile directory:

1. If `--profile-dir` is specified, uses that directory
2. If `.smartergpt` exists (tracked example), uses `.smartergpt.local`
3. Otherwise, uses `.smartergpt.local` for new setups

This ensures local development work doesn't overwrite tracked example configurations.

#### See Also

- [Quickstart Guide](./quickstart.md) - Complete onboarding workflow
- [Profile Resolution](./profile-resolution.md) - Understanding profile directories
- `lex-pr doctor` - Validate environment after initialization

---

### `schema validate`

Validate plan.json files against the schema with enhanced cycle detection and diagnostics.

```bash
lex-pr schema validate [options] [file]

Arguments:
  file              Path to plan.json file

Options:
  --json            Output machine-readable JSON errors
  --verbose         Show detailed diagnostics (layers, warnings, full dependency graph)
  -h, --help        Display help for command
```

#### Validation Checks

The validator performs comprehensive checks:

1. **Schema validation** - Ensures plan follows correct structure
2. **Cycle detection** - Identifies circular dependencies with full path details
3. **Orphan detection** - Warns about items with no dependencies/dependents
4. **Reference validation** - Ensures all dependencies exist
5. **Self-dependency detection** - Catches items depending on themselves
6. **Topology analysis** - Computes merge layers and identifies bottlenecks

#### Examples

```bash
# Basic validation with human-readable output
lex-pr schema validate plan.json

# Detailed validation with layer information
lex-pr schema validate plan.json --verbose

# Validate with JSON output for CI
lex-pr schema validate --json plan.json

# Example output (human-readable):
=== Plan Validation Report ===

❌ Errors:

Dependency cycle detected in plan

Cycle path: feat-a → feat-b → feat-c → feat-a

Dependency chain:
  feat-a               depends on feat-b
  feat-b               depends on feat-c
  feat-c               depends on feat-a

Suggestion: Consider removing the dependency from 'feat-c' to 'feat-a' to break the cycle

❌ Plan has 1 error(s) that must be fixed

# Example verbose output:
=== Plan Validation Report ===

Nodes: 6 items
Edges: 4 dependencies

Layers (topological sort):
  Layer 0: feat-a, feat-b, feat-f
  Layer 1: feat-c, feat-d
  Layer 2: feat-e

⚠️  Warnings:

Item 'feat-f' has no dependencies and no dependents (orphan)
Suggestion: Consider if these items should have dependencies or dependents.

✅ Plan is valid and ready for execution
```

#### JSON Output Schema

**Success Response:**

```json
{
  "valid": true,
  "errors": [],
  "warnings": [],
  "diagnostics": {
    "nodes": 5,
    "edges": 4,
    "layers": [
      { "level": 0, "prs": ["feat-a", "feat-b"] },
      { "level": 1, "prs": ["feat-c"] }
    ],
    "orphans": []
  }
}
```

**Error Response (Cycle):**

```json
{
  "valid": false,
  "errors": [
    {
      "type": "cycle",
      "message": "Dependency cycle detected in plan\n\nCycle path: feat-a → feat-b → feat-a\n\nDependency chain:\n  feat-a depends on feat-b\n  feat-b depends on feat-a",
      "details": {
        "cyclePath": ["feat-a", "feat-b", "feat-a"]
      },
      "suggestion": "Consider removing the dependency from 'feat-b' to 'feat-a' to break the cycle"
    }
  ],
  "warnings": [],
  "diagnostics": {
    "nodes": 2,
    "edges": 2,
    "layers": [],
    "orphans": []
  }
}
```

**Warning Response (Orphans):**

```json
{
  "valid": true,
  "errors": [],
  "warnings": [
    {
      "type": "orphan",
      "message": "2 items have no dependencies and no dependents (orphans): orphan-1, orphan-2",
      "affectedPRs": ["orphan-1", "orphan-2"],
      "suggestion": "Consider if these items should have dependencies or dependents. Use labels to mark intentional orphans."
    }
  ],
  "diagnostics": {
    "nodes": 4,
    "edges": 1,
    "layers": [
      { "level": 0, "prs": ["feat-a", "orphan-1", "orphan-2"] },
      { "level": 1, "prs": ["feat-b"] }
    ],
    "orphans": ["orphan-1", "orphan-2"]
  }
}
```

**Error Types:**

- `cycle` - Circular dependency detected
- `invalid-ref` - Reference to non-existent item
- `self-dependency` - Item depends on itself

**Warning Types:**

- `orphan` - Item has no dependencies and no dependents
- `large-layer` - Layer has too many items (potential merge conflicts)

**Exit Codes:**

- `0`: Validation successful (may have warnings)
- `1`: Validation failed with errors or system error
- `2`: Validation failed

---

### `plan`

Generate merge plan from workspace configuration or GitHub PRs with automatic dependency discovery.

```bash
lex-pr plan [options]

Options:
  --out <dir>               Output directory for artifacts (default: ".smartergpt/runner")
  --json                    Output canonical plan JSON to stdout only
  --dry-run                 Validate inputs and show what would be written
  --from-github             Auto-discover PRs from GitHub API with dependency detection
  --suggest-deps            Generate dependency suggestions from file analysis
  --threshold <float>       Confidence threshold for suggestions (0.0-1.0, default: 0.3)
  --no-suggestions          Disable file-based dependency suggestions
  --query <query>           GitHub search query (e.g., 'is:open label:stack:*')
  --labels <labels>         Filter PRs by comma-separated labels
  --exclude-labels <l>      Exclude PRs with labels (comma-separated)
  --include-drafts          Include draft PRs in the plan
  --exclude-prs <numbers>   Exclude specific PRs by comma-separated PR numbers
  --github-token <token>    GitHub API token (or use GITHUB_TOKEN env var)
  --owner <owner>           GitHub repository owner (auto-detected from git remote)
  --repo <repo>             GitHub repository name (auto-detected from git remote)
  --required-gates <gates>  Comma-separated list of required gates (default: lint,typecheck,test)
  --max-workers <n>         Maximum parallel workers for execution (default: 2)
  --target <branch>         Target branch for merging PRs (default: repo default branch)
  --validate                Validate plan after generation (cycles, orphans, refs)
  --validate-cycles         Enable dependency cycle detection (default: true)
  --optimize                Optimize plan for parallel execution
  --format <type>           Output format: json|markdown|dot (default: json)
  --output <file>           Output file path (alternative to --out, for single file)
  -h, --help                Display help for command
```

#### Plan Generation Modes

**1. GitHub Auto-Discovery Mode (Recommended)**

Generate plan from GitHub PRs with automatic dependency detection:

```bash
# Basic auto-discovery with dependency parsing
lex-pr plan --from-github

# With file-based dependency suggestions
lex-pr plan --from-github --suggest-deps --threshold=0.7

# Filter by labels
lex-pr plan --from-github --labels "ready-to-merge,stack:feature"

# Exclude certain labels
lex-pr plan --from-github --exclude-labels "wip,draft"
```

**What auto-discovery does:**

1. Fetches open PRs from GitHub
2. Parses `Depends-on:` footers from PR descriptions
3. Analyzes file changes to suggest implicit dependencies (if `--suggest-deps`)
4. Validates dependency graph (detects cycles, orphans)
5. Computes merge layers using topological sort
6. Generates deterministic `plan.json`

**2. Dependency Suggestions Only**

Generate file-based dependency suggestions without creating a plan:

```bash
# High-confidence suggestions (≥0.7)
lex-pr plan --suggest-deps --threshold=0.7

# Output as markdown for review
lex-pr plan --suggest-deps --format=markdown > suggestions.md

# JSON format for automation
lex-pr plan --suggest-deps --format=json | jq '.suggestions'
```

**3. Configuration Files Mode (Default)**

```bash
# Generate from .smartergpt/ configuration files
lex-pr plan
```

#### Dependency Syntax

The planner recognizes these dependency formats in PR descriptions:

```markdown
# Single dependency

Depends-on: #123

# Multiple dependencies

Depends-on: #123, #456, #789

# Cross-repo references

Depends-on: owner/repo#123

# Alternative keywords (aliases)

Depends: #123
Requires: #456
```

**Note:** `Closes`, `Fixes`, and `Resolves` are GitHub keywords for closing issues and are **not** treated as dependencies.

#### File-Based Heuristics

When `--suggest-deps` is used, the planner analyzes file changes to suggest dependencies:

| Heuristic               | Confidence Range | Description                      |
| ----------------------- | ---------------- | -------------------------------- |
| **Shared files**        | 0.6 - 1.0        | Both PRs modify the same files   |
| **Directory proximity** | 0.3 - 0.8        | PRs work in the same directories |
| **Test overlap**        | 0.5 - 0.85       | PRs test the same modules        |

**Threshold guidelines:**

- `≥0.8`: Very high confidence, almost always valid
- `≥0.7`: High confidence, recommended for hybrid workflow
- `≥0.5`: Medium confidence, requires manual review
- `<0.5`: Low confidence, likely false positive

#### Examples

```bash
# Generate plan with default output directory
lex-pr plan

# Generate plan to custom directory
lex-pr plan --out ./my-artifacts

# JSON-only output for piping/processing
lex-pr plan --json

# Validate inputs without writing files
lex-pr plan --dry-run

# GitHub mode: Auto-discover and generate plan
lex-pr plan --from-github --github-token $GITHUB_TOKEN

# Custom policy configuration
lex-pr plan --from-github \
  --required-gates "lint,test,build" \
  --max-workers 4 \
  --target develop

# Optimize and validate plan
lex-pr plan --from-github --optimize --validate-cycles

# Search for specific PRs
lex-pr plan --from-github \
  --query "is:open label:stack:*" \
  --labels "priority-high"
```

#### Dependency Validation and Optimization

The plan command automatically validates dependencies when using `--from-github`:

- **Cycle Detection**: Detects circular dependencies between PRs (enabled by default with `--validate-cycles` or `--validate`)
- **Orphan Detection**: Warns about PRs with no dependencies/dependents
- **Reference Validation**: Ensures all dependencies exist in the plan
- **Optimization**: Shows parallelization levels with `--optimize` flag

```bash
# Full validation (recommended)
lex-pr plan --from-github --validate

# Show optimization levels and merge layers
lex-pr plan --from-github --optimize

# Disable cycle detection (not recommended)
lex-pr plan --from-github --validate-cycles=false
```

Example output with `--optimize`:

```
✓ Auto-discovered 5 PRs from GitHub
✓ Parsed dependencies: 3 explicit, 1 implicit
✓ Dependency validation passed (no cycles detected)
✓ Plan optimized for parallel execution: 3 layers
  Layer 0: PR-100 (ready to merge)
  Layer 1: PR-101, PR-102 (after PR-100, parallel)
  Layer 2: PR-103, PR-104 (after Layer 1, parallel)
```

#### Exit Codes

- `0`: Plan generated successfully
- `1`: Plan generation failed (general error)
- `2`: Validation failed (cycles, invalid refs, orphans)

#### See Also

- **[Diffgraph Planner Guide](./diffgraph-planner.md)** - Complete feature documentation
- **[Troubleshooting](./troubleshooting-planner.md)** - Common errors and solutions
- **[Dependency Parser](./dependency-parser.md)** - Parser documentation
- **[Tutorials](./tutorials/diffgraph-planner/)** - Step-by-step guides
- `lex-pr schema validate` - Validate existing plan
- `lex-pr merge-order` - Review merge layers

---

#### JSON Output Schema (`--json` flag)

**Success Response:**

```json
{
  "schemaVersion": "1.0.0",
  "target": "main",
  "policy": {
    "requiredGates": ["string"],
    "optionalGates": ["string"],
    "maxWorkers": 1,
    "retries": {},
    "overrides": {},
    "blockOn": ["string"],
    "mergeRule": {
      "type": "strict-required"
    }
  },
  "items": [
    {
      "name": "string",
      "deps": ["string"],
      "gates": [
        {
          "name": "string",
          "run": "string",
          "cwd": "string",
          "env": {},
          "runtime": "local|container|ci-service",
          "container": {
            "image": "string",
            "entrypoint": ["string"],
            "mounts": [
              {
                "source": "string",
                "target": "string",
                "type": "bind|volume"
              }
            ]
          },
          "artifacts": ["string"]
        }
      ]
    }
  ]
}
```

**Deterministic Guarantees:**

- Keys sorted alphabetically at all levels
- Arrays maintain stable ordering (deps sorted, items by name)
- No runtime timestamps or random values
- Cross-platform identical output

**Exit Codes:**

- `0`: Plan generated successfully
- `1`: System error (filesystem, permissions)
- `2`: Configuration validation failed

---

### `merge-order`

Compute dependency levels and merge order using Kahn's algorithm.

```bash
lex-pr merge-order [options] [file]

Arguments:
  file              Path to plan.json file (alternative to --plan)

Options:
  --plan <file>     Path to plan.json file
  --json            Output JSON format
  -h, --help        Display help for command
```

#### Examples

```bash
# Human-readable merge order
lex-pr merge-order plan.json

# JSON output for automation
lex-pr merge-order --json plan.json

# Using --plan flag
lex-pr merge-order --plan ./configs/plan.json
```

#### JSON Output Schema (`--json` flag)

**Success Response:**

```json
{
  "levels": [
    ["item-a", "item-c"], // Level 0: No dependencies
    ["item-b"], // Level 1: Depends on level 0
    ["item-d"] // Level 2: Depends on level 1
  ],
  "totalItems": 4,
  "maxParallelism": 2
}
```

**Human-Readable Output:**

```
Merge Order (3 levels):
  Level 0: item-a, item-c
  Level 1: item-b
  Level 2: item-d

Total items: 4, Max parallelism: 2
```

**Exit Codes:**

- `0`: Merge order computed successfully
- `1`: System error (file not readable)
- `2`: Dependency cycle or unknown dependency detected

---

### `orchestrate:predict-conflicts`

Predict merge conflicts using conflict graphs, Maximal Independent Set (MIS) computation, and git merge-tree simulation.

```bash
lex-pr orchestrate:predict-conflicts [options]

Options:
  --prs <numbers>       Comma-separated list of PR numbers (e.g., 166,167,168) [required]
  --base <branch>       Base branch for conflict analysis (default: "main")
  --skip-merge-tree     Skip git merge-tree simulation
  -h, --help            Display help for command
```

#### Algorithm Overview

1. **Conflict Graph**: Build undirected graph where nodes are PRs and edges represent shared files
2. **MIS Computation**: Use greedy algorithm to find Maximal Independent Set (PRs with no conflicts)
3. **Merge Simulation**: Run `git merge-tree` to validate predicted conflicts

**Greedy MIS Algorithm:**

- Sort nodes by degree (fewest conflicts first), then by PR number
- Greedily select nodes that don't conflict with already selected nodes
- Result: Maximum set of PRs that can merge in parallel

#### Examples

```bash
# Predict conflicts for specific PRs (human-readable)
lex-pr orchestrate:predict-conflicts --prs 166,167,168

# JSON output for automation
lex-pr --json orchestrate:predict-conflicts --prs 166,167,168

# Skip merge-tree simulation (faster, file-based analysis only)
lex-pr orchestrate:predict-conflicts --prs 166,167,168 --skip-merge-tree

# Custom base branch
lex-pr orchestrate:predict-conflicts --prs 100,101,102 --base develop
```

#### JSON Output Schema (`--json` flag)

**Success Response:**

```json
{
  "analyzedAt": "2025-10-13T02:00:00Z",
  "baseBranch": "main",
  "conflictGraph": {
    "nodes": ["166", "167", "168"],
    "edges": [
      {
        "from": "166",
        "to": "167",
        "sharedFiles": ["src/cli.ts"]
      },
      {
        "from": "167",
        "to": "168",
        "sharedFiles": ["src/gates.ts"]
      }
    ]
  },
  "misBatches": [
    {
      "id": "mis-1",
      "prs": ["166", "168"],
      "reason": "No shared files"
    },
    {
      "id": "mis-2",
      "prs": ["167"],
      "reason": "Conflicts with #166 and #168"
    }
  ],
  "mergeTreeSimulation": {
    "166-168": {
      "status": "clean",
      "conflicts": []
    },
    "166-167": {
      "status": "conflict",
      "conflicts": [
        {
          "file": "src/cli.ts",
          "lines": "125-140",
          "type": "both-modified"
        }
      ]
    }
  },
  "recommendations": {
    "safeBatch": ["166", "168"],
    "sequential": ["167"]
  }
}
```

**Human-Readable Output:**

```
🔍 Conflict Analysis
============================================================

📊 Conflict Graph:
  - #166 ↔ #167: src/cli.ts
  - #167 ↔ #168: src/gates.ts

🔀 MIS Batches (safe parallel groups):
  - mis-1: [#166, #168]
    No shared files
  - mis-2: [#167]
    Conflicts with #166 and #168

🧪 git merge-tree Simulation:
  - #166 + #168: ✅ Clean merge
  - #166 + #167: ❌ Conflict
    ↳ src/cli.ts (both-modified)

💡 Recommendations:
  ✓ Safe parallel batch: #166, #168
  ⚠ Merge sequentially: #167
```

**Exit Codes:**

- `0`: Conflict analysis completed successfully
- `1`: Missing required parameters or system error

#### Use Cases

- **Batch Planning**: Determine which PRs can be merged in parallel
- **Conflict Avoidance**: Identify potential conflicts before merging
- **Optimization**: Maximize parallelism in merge pyramid execution
- **CI/CD Integration**: Automate conflict detection in merge workflows

---

### `plan-review`

Interactively review and edit a plan with human-in-the-loop validation.

```bash
lex-pr plan-review [options] [file]

Arguments:
  file                  Path to plan.json file (alternative to --plan)

Options:
  --plan <file>         Path to plan.json file
  --non-interactive     Non-interactive mode (auto-approve)
  --profile-dir <dir>   Profile directory for history tracking
  --save-history        Save plan versions to history
  --output <file>       Output file for approved/modified plan
  -h, --help            Display help for command
```

#### Features

- **Interactive Review**: View plan summary, dependency graph, and merge order
- **Plan Editing**: Add/remove items, modify dependencies, change target branch
- **Validation**: Automatic validation of dependencies and cycles during editing
- **Approval Workflow**: Approve or reject plans with optional reason
- **History Tracking**: Save plan versions with metadata for audit trail
- **Diff View**: See changes made during interactive session

#### Examples

```bash
# Interactive review with prompts
lex-pr plan-review plan.json

# Auto-approve in non-interactive mode
lex-pr plan-review plan.json --non-interactive

# Review and save to new file
lex-pr plan-review plan.json --output approved-plan.json

# Review with history tracking
lex-pr plan-review plan.json --save-history --profile-dir .smartergpt.local
```

#### Interactive Options

When running in interactive mode, you'll see:

1. **Plan Summary**: Items count, target branch, dependencies overview
2. **Dependency Graph**: ASCII visualization of item dependencies
3. **Merge Order**: Computed execution levels

Then you can choose:

- `[a]` Approve plan - Accept the plan as-is
- `[r]` Reject plan - Reject with optional reason
- `[e]` Edit plan - Interactively modify the plan
- `[v]` View plan details - See full JSON
- `[d]` Show diff - Compare original vs modified
- `[q]` Quit without saving

#### Edit Operations

When editing, you can:

- Add new items with dependencies
- Remove items (validated against dependents)
- Modify item dependencies (cycle detection)
- Change target branch
- Gates editing (planned for future release)

#### Exit Codes

- `0`: Plan approved
- `1`: Plan rejected or operation failed

---

### `plan-diff`

Compare two plans and show differences.

```bash
lex-pr plan-diff [options] <plan1> <plan2>

Arguments:
  plan1       First plan file
  plan2       Second plan file

Options:
  --json      Output JSON format
  -h, --help  Display help for command
```

#### Examples

```bash
# Human-readable diff
lex-pr plan-diff plan-v1.json plan-v2.json

# JSON output for automation
lex-pr plan-diff plan-v1.json plan-v2.json --json
```

#### Human-Readable Output

```
📊 Plan Comparison

Plan 1: plan-v1.json
Plan 2: plan-v2.json

Target Branch: main → develop

Added Items:
  + feature-d
    deps: feature-b
    gates: 2

Removed Items:
  - feature-c

Modified Items:
  ~ feature-b
    deps: [feature-a] → [feature-a, feature-x]
```

#### JSON Output Schema

```json
{
  "targetChanged": true,
  "originalTarget": "main",
  "modifiedTarget": "develop",
  "addedItems": [
    {
      "name": "feature-d",
      "deps": ["feature-b"],
      "gates": []
    }
  ],
  "removedItems": [
    {
      "name": "feature-c",
      "deps": ["feature-a"],
      "gates": []
    }
  ],
  "modifiedItems": [
    {
      "name": "feature-b",
      "originalDeps": ["feature-a"],
      "modifiedDeps": ["feature-a", "feature-x"],
      "originalGatesCount": 1,
      "modifiedGatesCount": 2
    }
  ],
  "hasChanges": true
}
```

#### Exit Codes

- `0`: No changes detected (plans are identical)
- `1`: Changes detected or comparison successful

---

<a id="execute"></a>

### `gate run` (compatibility: `execute`)

Execute plan with policy-aware gate running and status tracking.

```bash
lexrunner gate run [options] [file]

Arguments:
  file                       Path to plan.json file (alternative to --plan)

Options:
  --plan <file>              Path to plan.json file
  --repo-root <dir>          Explicit repository candidate root (default: current directory)
  --only-item <name>         Run only the selected item; omitted dependencies must already pass
  --only-gate <name>         Run only the selected gate; omitted gates remain unqualified
  --artifact-dir <dir>       Output directory for artifacts (default: "./artifacts")
  --timeout <ms>             Gate timeout in milliseconds (default: "30000")
  --dry-run                  Validate plan and show execution order without running gates
  --json                     Output results in JSON format
  --status-table             Generate status table for PR comments
  --max-level <level>        Maximum autopilot level (0-4) (default: "0")
  --open-pr                  Open pull requests for integration branches (Level 3+)
  --close-superseded         Close superseded PRs after integration (Level 4)
  --comment-template <path>  Path to PR comment template (Level 2+)
  --branch-prefix <prefix>   Prefix for integration branch names (default: "integration/")
  -h, --help                 Display help for command
```

> **📖 Autopilot Levels**: See [Autopilot Levels](./autopilot-levels.md) for details on automation levels 0-4.

#### Examples

```bash
# Execute entire plan
lexrunner gate run plan.json

# Execute specific item only
lexrunner gate run --only-item item-a plan.json

# Run a selected gate in an explicit repository from a shared non-Git workspace
lexrunner gate run --plan plan.json --repo-root /path/to/repo --only-item item-a --only-gate unit

# JSON output for monitoring
lexrunner gate run --json plan.json

# Execute plan with vulnerability scanning
lexrunner gate run plan-with-vuln.json
```

Item and gate selections use the same validation as MCP `gates.run`. Unknown items,
unknown gates, or a gate absent from the selected item fail before commands run.
Relative gate working directories resolve from the candidate repository root; each
selected local command must belong to that same physical Git repository. Execution
does not change the declared plan or gate digests.

Dependencies must finish with every required gate passing before dependent commands
start. A selected item whose omitted prerequisite has no passing execution evidence
is blocked; the runner does not launch omitted prerequisites. `maxWorkers` bounds
the number of simultaneously executing items. A selected gate does not qualify
omitted required gates. The evidence manifest records the selection and full plan
identity; a passing subset is not whole-plan merge eligibility. Dry runs validate
selectors and report the full dependency graph with the requested selection.

#### Built-in Gates

##### Vulnerability Gate (`vuln`)

The `vuln` gate is a special built-in gate that scans for security vulnerabilities using artifact-based detection:

- **Artifact Detection**: Automatically looks for `scan-results.sarif` (SARIF 2.1.0 format) or `npm-audit.json` in the item's artifact directory
- **Policy Enforcement**: Applies thresholds from `plan.policy.security`
- **Deterministic Output**: Provides consistent, structured vulnerability counts

**Policy Configuration:**

```json
{
  "policy": {
    "requiredGates": ["vuln"],
    "security": {
      "blockCritical": true,
      "blockHigh": true,
      "maxMedium": 5,
      "maxLow": 10
    }
  }
}
```

**Example Gate:**

```json
{
  "gates": [
    {
      "name": "vuln",
      "run": "trivy fs --format sarif --output scan-results.sarif ."
    }
  ]
}
```

**Supported Scanners:**

- Trivy: `trivy fs --format sarif`
- Snyk: `snyk test --sarif`
- CodeQL: `codeql database analyze --format=sarif-latest`
- npm audit: `npm audit --json > npm-audit.json`

See [Gate Report Examples](./gate-report-examples.md#vulnerability-gate-vuln) for detailed output examples.

#### JSON Output Schema (`--json` flag)

**Success Response:**

```json
{
  "executionId": "string", // Unique execution identifier
  "startedAt": "2024-01-15T10:30:00Z",
  "completedAt": "2024-01-15T10:35:00Z",
  "status": "completed|failed|running",
  "totalItems": 4,
  "completedItems": 4,
  "failedItems": 0,
  "items": [
    {
      "name": "item-a",
      "status": "pass|fail|blocked|skipped|retrying",
      "gates": [
        {
          "gate": "test",
          "status": "pass|fail|blocked|skipped|retrying",
          "exitCode": 0,
          "duration": 1500, // milliseconds
          "stdout": "string",
          "stderr": "string",
          "artifacts": ["coverage.json"],
          "attempts": 1,
          "lastAttempt": "2024-01-15T10:32:00Z"
        }
      ],
      "blockedBy": [], // Items that blocked this one
      "eligibleForMerge": true
    }
  ]
}
```

**Exit Codes:**

- `0`: All gates passed successfully
- `1`: System error during execution
- `2`: One or more gates failed

---

### `merge`

Execute merge pyramid with git operations. Supports dry-run preview, conflict detection, and resumable execution.

```bash
lex-pr merge [options]

Options:
  --plan <file>                      Path to plan.json file (default: "plan.json")
  --dry-run                          Show what would be merged without executing (default: true)
  --execute                          Actually perform merge operations
  --resume [runId]                   Resume from the persisted operation checkpoint
  --cleanup                          Clean up integration branches after execution
  --force                            Force execution even if same lock hash exists
  --json                             Output JSON format
  --batch                            Enable batch mode for multiple items
  --filter <query>                   Filter items using query language
  --levels <levels>                  Comma-separated list of levels to merge
  --items <items>                    Comma-separated list of items to merge
  --max-level <level>                Maximum autopilot level (0-4) (default: "0")
  --open-pr                          Open pull requests for integration branches (Level 3+)
  --close-superseded                 Close superseded PRs after integration (Level 4)
  --comment-template <path>          Path to PR comment template (Level 2+)
  --branch-prefix <prefix>           Prefix for integration branch names (default: "integration/")
  --skip-preflight                   Skip preflight conflict detection in dry-run mode
  --fail-on-preflight-conflict       Exit with error if preflight conflict detection finds conflicts
  --track-turncost                   Track Turn Cost metrics during execution (coordination overhead)
  -h, --help                         Display help for command
```

> **📖 Quick Start**: See [Merge-Weave Quickstart](./merge-weave-quickstart.md) for an end-to-end walkthrough with examples.
>
> **📖 Autopilot Levels**: See [Autopilot Levels](./autopilot-levels.md) for details on automation levels 0-4.

#### Basic Examples

```bash
# Dry-run: preview merge operations (default)
lex-pr merge

# Dry-run with explicit flag
lex-pr merge --plan ./plan.json --dry-run --json

# Execute merge pyramid
lex-pr merge --execute

# Execute and clean up integration branches
lex-pr merge --execute --cleanup

# Resume from previous execution
lex-pr merge --resume

# Force execution even if already executed
lex-pr merge --execute --force
```

#### Batch Operations

```bash
# Merge specific items only
lex-pr merge --batch --items "pr-123,pr-456" --execute

# Merge specific dependency levels
lex-pr merge --batch --levels "1,2" --execute

# Merge items matching a query
lex-pr merge --batch --filter "level eq 1" --execute
```

#### Conflict Detection

```bash
# Skip preflight conflict detection
lex-pr merge --skip-preflight

# Fail if conflicts detected in dry-run
lex-pr merge --fail-on-preflight-conflict

# Execute even if conflicts detected
lex-pr merge --execute  # Will pause on conflicts for manual resolution
```

#### State Management

The merge command uses two deliberately separate artifacts:

- **Lock Hash**: Computed from `plan.json` + PR head commits
- **Idempotency**: Duplicate runs with same lock hash are skipped (use `--force` to override)
- **Duplicate-run marker**: `weave-lock.json` records the frozen plan/head lock hash
- **Resume journal**: `.lexrunner/checkpoints/<run-id>.json` records every operation boundary
- **Resume**: `merge --resume` and `weave resume` invoke the same recovery service

**Lock File Example:**

```json
{
  "lockHash": "abc123de",
  "planHash": "def456gh",
  "prHeads": [
    { "name": "feature/auth", "sha": "a1b2c3d4" },
    { "name": "feature/api", "sha": "e5f6g7h8" }
  ],
  "timestamp": "2024-12-13T02:00:00Z",
  "status": "completed"
}
```

#### Preflight Conflict Detection

Enabled by default in dry-run mode. Uses `git merge-tree` to simulate merges without modifying the working tree.

**Benefits:**

- Detects conflicts early before actual merge execution
- No working tree modifications
- Fast simulation of merge operations

**Example Dry-Run Output with Conflicts:**

```json
{
  "mode": "dry-run",
  "lockHash": "abc123de",
  "preflight": {
    "enabled": true,
    "conflictsDetected": 2,
    "items": [
      {
        "id": "feature-ui",
        "branch": "feature/ui",
        "conflicts": ["src/components/Header.tsx", "src/styles/main.css"]
      }
    ]
  },
  "warnings": ["feature-ui has 2 potential conflicts. Review and resolve before executing."]
}
```

#### Turn Cost Tracking

Track coordination overhead during merge-weave operations:

```bash
lex-pr merge --execute --track-turncost
```

**Components:**

- **Latency (L)**: Total execution time
- **Renegotiation (R)**: Conflicts requiring manual resolution
- **Token Bloat (T)**: Token usage overhead (future)
- **Attention (A)**: Context switches during execution

**Weighted Score**: `λL + γC + ρR + τT + αA`

See [Governance Metrics](./governance-metrics.md) for details on Turn Cost calculation.

#### Exit Codes

- `0`: Success (merge completed or dry-run successful)
- `1`: Merge failed or conflicts detected (with `--fail-on-preflight-conflict`)
- `2`: Configuration or validation error

#### See Also

- [Merge-Weave Quickstart](./merge-weave-quickstart.md) - Complete walkthrough with troubleshooting
- [Merge-Weave State Machine](./merge-weave-state-machine.md) - Execution state transitions
- [Advanced CLI Features](./advanced-cli.md) - Advanced merge-weave options
- [Autopilot Levels](./autopilot-levels.md) - Automated PR creation and management

---

### `status`

Show current execution status and merge eligibility.

```bash
lex-pr status [options] [file]

Arguments:
  file              Path to plan.json file (alternative to --plan)

Options:
  --plan <file>     Path to plan.json file
  --json            Output JSON format
  --state-dir <dir> Directory containing execution state (default: ".smartergpt/runner")
  -h, --help        Display help for command
```

#### Examples

```bash
# Show human-readable status
lex-pr status plan.json

# JSON status for dashboards
lex-pr status --json plan.json
```

#### JSON Output Schema (`--json` flag)

**Success Response:**

```json
{
  "executionStatus": "not_started|running|completed|failed",
  "lastUpdated": "2024-01-15T10:35:00Z",
  "summary": {
    "totalItems": 4,
    "passedItems": 2,
    "failedItems": 1,
    "blockedItems": 1,
    "eligibleForMerge": 2
  },
  "items": [
    {
      "name": "item-a",
      "status": "pass",
      "eligibleForMerge": true,
      "gatesSummary": {
        "total": 2,
        "passed": 2,
        "failed": 0
      }
    }
  ]
}
```

**Exit Codes:**

- `0`: Status retrieved successfully
- `1`: System error (state files not readable)
- `2`: No execution state found

---

### `report`

Aggregate gate reports from directory of JSON files.

```bash
lex-pr report [options] <dir>

Arguments:
  dir               Directory containing gate report JSON files

Options:
  --out <format>    Output format: json|md (default: "json")
  --validate        Validate reports against schema before aggregating
  -h, --help        Display help for command
```

#### Examples

```bash
# JSON summary of gate results
lex-pr report ./gate-results

# Markdown report for humans
lex-pr report --out md ./gate-results

# Validate reports first
lex-pr report --validate ./gate-results
```

#### JSON Output Schema (`--out json`)

**Success Response:**

```json
{
  "summary": {
    "totalReports": 8,
    "totalItems": 4,
    "totalGates": 12,
    "passedGates": 10,
    "failedGates": 2,
    "allGreen": false
  },
  "items": [
    {
      "name": "item-a",
      "gates": [
        {
          "name": "test",
          "status": "pass",
          "duration_ms": 1500,
          "started_at": "2024-01-15T10:30:00Z"
        }
      ],
      "summary": {
        "totalGates": 3,
        "passedGates": 3,
        "failedGates": 0
      }
    }
  ]
}
```

**Markdown Output (`--out md`):**

```markdown
# Gate Execution Report

## Summary

- **Total Items**: 4
- **Total Gates**: 12
- **Passed**: 10 ✅
- **Failed**: 2 ❌
- **Overall Status**: ❌ FAILED

## Item Results

### item-a ✅

- test: ✅ PASS (1.5s)
- lint: ✅ PASS (0.8s)
- build: ✅ PASS (12.3s)
```

**Exit Codes:**

- `0`: All gates passed (allGreen: true)
- `1`: System error (directory not readable, invalid reports)
- `2`: One or more gates failed

---

### `doctor`

Environment and configuration sanity checks.

```bash
lex-pr doctor [options]

Options:
  --json            Output JSON format
  -h, --help        Display help for command
```

#### Examples

```bash
# Human-readable environment check
lex-pr doctor

# JSON output for automation
lex-pr doctor --json
```

#### JSON Output Schema (`--json` flag)

**Success Response:**

```json
{
  "status": "healthy|warning|error",
  "timestamp": "2024-01-15T10:30:00Z",
  "checks": [
    {
      "name": "node_version",
      "status": "pass|warn|fail",
      "message": "Node.js 24.18.0 (OK; required >=24)",
      "expected": ">=18.0.0",
      "actual": "20.10.0"
    },
    {
      "name": "config_files",
      "status": "pass",
      "message": "All configuration files found",
      "details": [".smartergpt/intent.md: ✓", ".smartergpt/scope.yml: ✓"]
    }
  ],
  "summary": {
    "totalChecks": 5,
    "passed": 4,
    "warnings": 1,
    "failures": 0
  }
}
```

**Exit Codes:**

- `0`: All checks passed or warnings only
- `1`: System error during checks
- `2`: One or more critical checks failed

## Deterministic Output Requirements

All CLI commands with `--json` output must guarantee:

1. **Stable key ordering**: All JSON objects have keys sorted alphabetically
2. **Consistent formatting**: Use 2-space indentation, no trailing whitespace
3. **Reproducible timestamps**: Avoid runtime timestamps except where semantically required
4. **Sorted arrays**: Dependencies, items, errors sorted by name/path
5. **Cross-platform consistency**: Same inputs produce identical outputs on Windows/macOS/Linux

### Verification

```bash
# Determinism check - should be byte-identical
npm run build && npm run format
git diff --exit-code  # Must be clean

# Cross-platform verification
lex-pr plan --json > output1.json
lex-pr plan --json > output2.json
cmp output1.json output2.json     # Should be identical
```

---

## CLI Conventions

This section documents internal patterns for CLI development. Follow these conventions to ensure consistent behavior across all commands.

### Exit Handling

**Core Principle**: Never call `process.exit()` directly. Use `throwExit()` or throw `CLIExitSignal` instead.

#### The CLIExitSignal Pattern

The CLI uses a custom error class for all exits:

```typescript
class CLIExitSignal extends Error {
  exitCode: number;

  constructor(code: number, message?: string) {
    super(message ?? `CLI exited with code ${code}`);
    this.exitCode = code;
  }
}

const throwExit = (code: number): never => {
  throw new CLIExitSignal(code);
};
```

**Why**: This approach allows:

- Centralized exit handling in the main error handler
- Proper cleanup of resources before exit
- Testability (errors can be caught in tests)
- Consistent error formatting

#### Commander Exit Override

All Commander exits are intercepted centrally:

```typescript
program.exitOverride((err: CommanderError) => {
  // Help/version often exit with code 0; normalize through CLIExitSignal
  throw new CLIExitSignal(err.exitCode ?? 1, err.message);
});
```

**Why**: Commander's default exit behavior calls `process.exit()` directly. Overriding ensures:

- All exits go through the same path
- Help/version commands work correctly with exit code 0
- No bypassing of error handlers

#### Exit Code Discipline

Use the standard exit codes consistently:

```typescript
throwExit(0); // Success
throwExit(1); // System/infrastructure errors
throwExit(2); // User/validation errors
```

**Examples**:

✅ **Correct**:

```typescript
try {
  const plan = loadPlan(planPath);
  // ... process plan
  throwExit(0);
} catch (e) {
  if (e instanceof SchemaValidationError) {
    console.error(`Validation failed: ${e.message}`);
    throwExit(2); // User can fix this
  }
  console.error(`Unexpected error: ${e.message}`);
  throwExit(1); // System error
}
```

❌ **Incorrect**:

```typescript
// DON'T: Direct process.exit
process.exit(1);

// DON'T: Throw generic errors for exit
throw new Error("exit");

// DON'T: Return exit codes
return 1;
```

### JSON Purity

**Core Principle**: Keep stdout clean for JSON output. All diagnostics, progress messages, and errors go to stderr.

#### Output Stream Configuration

Configure Commander to use explicit streams:

```typescript
program.configureOutput({
  writeOut: (str) => process.stdout.write(str),
  writeErr: (str) => process.stderr.write(str),
});
```

**Why**: This ensures:

- Help/version output goes to stderr (Commander default)
- stdout remains pure for JSON or data output
- Pipeable commands work correctly

#### JSON Mode Discipline

Commands with `--json` flag must follow strict rules:

```typescript
let jsonModeActive = false;

command.action(async (opts) => {
  const previousJsonMode = jsonModeActive;
  jsonModeActive = !!opts.json;

  try {
    if (opts.json) {
      // ONLY write JSON to stdout, nothing else
      process.stdout.write(canonicalJSONStringify(result));
      return;
    }

    // Human-readable output
    console.log("✓ Success!");
    console.log(summary);
  } finally {
    jsonModeActive = previousJsonMode;
  }
});
```

**Rules for JSON mode**:

1. **No console.log** in JSON mode - use `process.stdout.write()` directly
2. **No progress messages** - suppress all diagnostics in JSON mode
3. **No emojis or formatting** - JSON only
4. **Always use canonicalJSONStringify** - ensures deterministic output

**Examples**:

✅ **Correct**:

```typescript
if (opts.json) {
  // Pure JSON to stdout
  process.stdout.write(canonicalJSONStringify({ status: "ok", data }));
  return;
}

// Human mode: rich output to stdout/stderr
console.log("✓ Operation complete");
console.error("ℹ️ Note: Some items were skipped");
```

❌ **Incorrect**:

```typescript
if (opts.json) {
  console.log("Processing..."); // DON'T: breaks JSON purity
  console.log(JSON.stringify(data)); // DON'T: use canonicalJSONStringify
  console.error(JSON.stringify(error)); // DON'T: errors to stderr, not JSON mixed in
}
```

#### Diagnostic Output

Even in normal mode, separate data from diagnostics:

```typescript
// Diagnostics and progress → stderr
console.error("🔍 Analyzing plan...");
console.error(`Found ${items.length} items`);

// Final output → stdout
console.log(canonicalJSONStringify(result));
```

**Why**: Allows users to pipe output while still seeing progress:

```bash
lex-pr plan --json > plan.json  # Progress visible, JSON piped
```

### Output Modes

#### Canonical JSON Output

Always use `canonicalJSONStringify()` for JSON output:

```typescript
import { canonicalJSONStringify } from "./util/canonicalJson.js";

// Automatically includes trailing newline
process.stdout.write(canonicalJSONStringify(data));
```

**Note**: Import path shown is from `src/` directory. Adjust relative path based on your file location. Use `.js` extension in imports even for TypeScript source files (required for ES modules - TypeScript doesn't rewrite extensions).

**Why**: Ensures deterministic output:

- Keys sorted alphabetically at all levels
- Consistent 2-space indentation
- Always includes trailing newline
- Same output every time (no timestamps, no random ordering)

#### Human-Readable Output

For human output, use rich formatting:

```typescript
console.log("\n✓ Plan generated successfully\n");
console.log(`📁 Output: ${planPath}`);
console.log(`📊 Items: ${items.length}`);
console.log("");
console.log(generatePlanSummary(plan));
```

**Guidelines**:

- Use emojis for visual clarity
- Include spacing for readability
- Provide actionable next steps
- Use colors (via chalk) sparingly

### Error Handling Patterns

#### The exitWith() Helper

Use the `exitWith()` helper for consistent error handling:

```typescript
function exitWith(e: unknown, schemaCode = "ESCHEMA") {
  // Let CLIExitSignal propagate - don't treat it as an error
  if (e instanceof CLIExitSignal) {
    throw e;
  }

  const err: any = e;

  // Schema-specific error handling
  if (err?.code === schemaCode && Array.isArray(err.issues)) {
    console.log(JSON.stringify({ errors: err.issues }, null, 2));
    console.error(err.message);
    throwExit(2);
  }

  // Handle known validation errors (exit 2)
  if (
    e instanceof SchemaValidationError ||
    e instanceof CycleError ||
    e instanceof UnknownDependencyError ||
    e instanceof WriteProtectionError ||
    e instanceof AutopilotConfigError
  ) {
    console.error(`\n❌ Error: ${err.message}\n`);

    // Add contextual help based on error type
    // e.g., for WriteProtectionError: suggest using local profile
    // e.g., for CycleError: suggest checking dependency declarations

    throwExit(2);
  }

  // Handle system errors (exit 1)
  console.error(`\n❌ Unexpected error: ${err.message}\n`);
  throwExit(1);
}
```

**Note**: Simplified example. See `src/cli.ts` for the full implementation with contextual error messages.

**Usage**:

```typescript
try {
  const plan = await generatePlan();
  process.stdout.write(canonicalJSONStringify(plan));
} catch (error) {
  exitWith(error);
}
```

#### Error Context

Provide helpful context in error messages:

```typescript
if (e instanceof WriteProtectionError) {
  console.error(`\n❌ Error: ${e.message}\n`);
  console.error("💡 Tip: Use a local profile directory for development:");
  console.error("   lex-pr init --profile-dir .smartergpt.local\n");
  throwExit(2);
}
```

### Testing CLI Commands

Write tests that verify exit behavior:

```typescript
import { describe, it, expect } from "vitest";
import { CLIExitSignal } from "../src/cli.js";

describe("CLI exit codes", () => {
  it("should throw CLIExitSignal on validation error", () => {
    // Test that validation errors throw CLIExitSignal with code 2
    expect(() => {
      throw new CLIExitSignal(2, "Validation failed");
    }).toThrow(CLIExitSignal);
  });

  it("should have correct exit code in signal", () => {
    const signal = new CLIExitSignal(2, "Validation error");
    expect(signal.exitCode).toBe(2);
  });
});
```

**Note**: Testing the full CLI requires mocking process.exit or using child processes. The above shows testing the CLIExitSignal class itself.

### Summary

**Key Takeaways**:

1. **Exit Discipline**: Always use `throwExit()` or throw `CLIExitSignal`, never `process.exit()`
2. **JSON Purity**: stdout for data, stderr for diagnostics - configure Commander explicitly
3. **Deterministic Output**: Use `canonicalJSONStringify()` for all JSON output
4. **Error Codes**: 0 = success, 1 = system error, 2 = user error
5. **Stream Separation**: Commander's `configureOutput()` ensures help/errors don't pollute stdout

**Related Documentation**:

- [Error Taxonomy](./errors.md) - Complete error code reference
- [Deterministic Output](#deterministic-output-requirements) - JSON output guarantees
- Source: `src/cli.ts` - See `CLIExitSignal`, `throwExit()`, `exitWith()`

---

## Advanced Commands

### `view`

Interactive plan viewer with keyboard navigation and filtering.

```bash
lex-pr view [options] [file]

Arguments:
  file              Path to plan.json file (alternative to --plan)

Options:
  --plan <file>     Path to plan.json file
  --filter <text>   Initial filter text
  --no-deps         Hide dependencies by default
  --no-gates        Hide gates by default
  -h, --help        Display help for command
```

**Keyboard Navigation:**

- `↑/↓` - Navigate items
- `/` - Enter filter mode
- `d` - Toggle dependencies
- `g` - Toggle gates
- `q` - Quit

#### Examples

```bash
# Open interactive viewer
lex-pr view plan.json

# Start with a filter
lex-pr view plan.json --filter "feature"

# Hide gates by default
lex-pr view plan.json --no-gates
```

---

### `query`

Advanced query and analysis of plan using SQL-like syntax.

```bash
lex-pr query [file] [query] [options]

Arguments:
  file              Path to plan.json file (alternative to --plan)
  query             Query string (e.g., 'level eq 1', 'name contains feature')

Options:
  --plan <file>     Path to plan.json file
  --format <fmt>    Output format: json, table, csv (default: "table")
  --output <file>   Output file (default: stdout)
  --stats           Show plan statistics
  --roots           Show root nodes (no dependencies)
  --leaves          Show leaf nodes (no dependents)
  --level <level>   Filter by merge level
  -h, --help        Display help for command
```

**Query Syntax:**

```
field operator value [AND field operator value]
```

**Operators:** `eq`, `ne`, `contains`, `in`, `gt`, `lt`, `gte`, `lte`

**Fields:** `name`, `level`, `depsCount`, `gatesCount`, `dependentsCount`

#### Examples

```bash
# Find all items at merge level 1
lex-pr query plan.json "level eq 1"

# Find items with specific name pattern
lex-pr query plan.json "name contains feature"

# Find items with more than 2 dependencies
lex-pr query plan.json "depsCount gt 2"

# Complex queries with AND
lex-pr query plan.json "level eq 1 AND depsCount eq 0"

# Show plan statistics
lex-pr query plan.json --stats

# Output as JSON
lex-pr query plan.json "level eq 1" --format json

# Save to file
lex-pr query plan.json --roots --output roots.json --format json
```

---

### `retry`

Retry failed gates with selective filtering.

```bash
lex-pr retry [options]

Options:
  --state-dir <dir>  State directory (default: ".smartergpt/runner")
  --filter <text>    Filter items/gates to retry
  --items <items>    Comma-separated list of items to retry
  --dry-run          Show what would be retried without executing
  --json             Output JSON format
  -h, --help         Display help for command
```

#### Examples

```bash
# Show all failed gates
lex-pr retry --dry-run

# Retry all failed gates
lex-pr retry

# Retry specific items
lex-pr retry --items "item1,item2"

# Retry with filter
lex-pr retry --filter "integration"

# JSON output
lex-pr retry --json
```

---

### `completion`

Generate shell completion scripts for bash and zsh.

```bash
lex-pr completion [shell] [options]

Arguments:
  shell             Shell type: bash, zsh (default: "bash")

Options:
  --install         Show installation instructions
  -h, --help        Display help for command
```

#### Examples

```bash
# Generate bash completion
lex-pr completion bash

# Generate zsh completion
lex-pr completion zsh

# Show installation instructions
lex-pr completion bash --install
```

**Installation:**

For bash:

```bash
# Add to ~/.bashrc
eval "$(lex-pr completion bash)"
```

For zsh:

```bash
# Add to ~/.zshrc
eval "$(lex-pr completion zsh)"
```

---

### Enhanced `merge` Options

The `merge` command now supports batch operations:

```bash
lex-pr merge [options]

Additional Batch Options:
  --batch               Enable batch mode for multiple items
  --filter <query>      Filter items using query language
  --levels <levels>     Comma-separated list of levels to merge
  --items <items>       Comma-separated list of items to merge
```

#### Batch Examples

```bash
# Merge specific items
lex-pr merge plan.json --batch --items "item1,item2" --execute

# Merge all items at specific levels
lex-pr merge plan.json --batch --levels "1,2" --execute

# Merge items matching a query
lex-pr merge plan.json --batch --filter "level eq 1" --execute
```

---

## Error Handling

All commands follow consistent error handling:

- **Exit code 0**: Success
- **Exit code 1**: System/infrastructure errors
- **Exit code 2**: User/validation errors

JSON error responses use consistent format:

```json
{
  "error": true,
  "code": "ERROR_CODE",
  "message": "Human-readable error message",
  "details": {
    // Command-specific error context
  }
}
```

See [Error Taxonomy](./errors.md) for complete error code reference.
