# MCP Server for lexrunner

The Model Context Protocol (MCP) server for lexrunner provides tools for plan creation, gate execution, and merge operations.
Plan creation can write files and gate execution runs commands. `ALLOW_MUTATIONS=false`
blocks protected mutations such as merging; it is not a read-only sandbox.

Start with [installation and interface choices](docs/first-use-compatibility.md).

For long local gate plans, use `gates.start` with explicit `repoRoot`, `planFile`,
`outDir` and `idempotencyKey`. Retain the returned operation path/hash for
`gates.status` or `gates.cancel`; observer disconnect does not cancel the worker.
See [durable gate operations](docs/gates.md#long-running-operations-and-reconnects)
for idempotency scope, cooperative cancellation and unknown-state recovery.

**Architecture:** This server is aligned with LexBrain and LexMap MCP implementations, using direct stdio JSON-RPC 2.0 protocol handling for consistency and maintainability across the Lex ecosystem.

## Tool Naming Convention

Per [Lex NAMING_CONVENTIONS.md](https://github.com/Guffawaffle/lex/blob/main/docs/NAMING_CONVENTIONS.md), all MCP tools follow the pattern:

```
mcp_lexrunner_{category}_{action}
```

**Categories:**

| Category    | Purpose                           |
| ----------- | --------------------------------- |
| `plan`      | Plan creation and validation      |
| `gate`      | CI/gate execution                 |
| `weave`     | Merge-weave orchestration         |
| `workspace` | Local workspace management        |
| `run`       | Run lifecycle management          |
| `executor`  | Executor tools (Senior Dev, etc.) |
| `core`      | Cross-cutting utilities           |

**Deprecated Aliases:** Old tool names (e.g., `plan.create`, `discover`) still work but are deprecated. Use canonical names for new integrations.

## Quick Start

### Configuration

See [MCP-CONFIG.md](./MCP-CONFIG.md) for complete configuration details and alignment with lex-brain and lex-map.

**Quick MCP Config Entry:**

```json
{
  "mcpServers": {
    "lexrunner": {
      "command": "node",
      "args": ["/srv/lex-mcp/lexrunner/mcp-server.mjs"],
      "env": {
        "LEX_PR_PROFILE_DIR": "/path/to/.smartergpt"
      }
    }
  }
}
```

### Starting the Server

```bash
# Production mode (recommended)
npm run mcp

# Or directly
node mcp-server.mjs

# Via launcher script (for specific environments)
bash lexrunner-launcher.sh
```

The server communicates via stdio using the MCP JSON-RPC 2.0 protocol, aligned with LexBrain and LexMap.

### Environment Configuration

The MCP server respects these environment variables:

- `LEX_PR_PROFILE_DIR`: Directory containing configuration files (default: auto-resolved via precedence chain)
- `ALLOW_MUTATIONS`: Enable destructive operations like merging (default: `false`)
- `GITHUB_TOKEN`: GitHub API token for authenticated access (required for private repos)

```bash
# Example with custom configuration
LEX_PR_PROFILE_DIR=/custom/profile ALLOW_MUTATIONS=true npm run mcp
```

### GitHub Authentication

**Important:** The MCP server requires `GITHUB_TOKEN` to access private repositories. Without it:

- Private repos return "Repository not found" errors
- API rate limits are severely restricted (60 req/hr vs 5000 authenticated)

Add `GITHUB_TOKEN` to your MCP server configuration:

```json
{
  "mcpServers": {
    "lexrunner": {
      "command": "node",
      "args": ["/path/to/mcp-server.mjs"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  }
}
```

The `${GITHUB_TOKEN}` syntax passes through your shell's environment variable. Alternatively, use a literal token value (not recommended for version-controlled configs).

## Architecture Alignment

This MCP server follows the same architectural pattern as LexBrain and LexMap:

1. **Direct stdio JSON-RPC 2.0**: No SDK abstraction, simple line-delimited protocol
2. **Single entry point**: `mcp-server.mjs` handles protocol and imports built core functions
3. **Core separation**: Business logic in TypeScript (`src/**`), protocol adapter in JavaScript
4. **Consistent error handling**: JSON-RPC error codes (-32700, -32601, -32603)
5. **Graceful shutdown**: SIGINT/SIGTERM handlers

## Available Tools

### preflight_attempt_containment

Checks whether the current runtime and declared repository/worktree roots can host LexRunner's
physical directory-identity boundary before an Attempt packet is constructed. This tool is always
read-only and does not require `ALLOW_MUTATIONS`.

It returns `native_ready`, `broker_required`, or `unsupported` with stable reason codes, bounded
next actions, verification depth for each root, and a privacy-safe binding digest. Native Windows
and WSL DrvFS/9P inputs recommend a native-WSL projection without weakening the containment
boundary.

### Native WSL projection lifecycle

Four tools share one bounded lifecycle service with the matching
`lex-pr attempt projection <operation> --input <file|-> --json` commands:

- `get_native_wsl_projection_status` reads exact lifecycle state without creating control, lock,
  projection, or SQLite state.
- `inspect_native_wsl_projection_quarantine` reads privacy-bounded quarantine counts and entry
  digests.
- `prepare_native_wsl_projection` prepares or exactly reuses the requested committed base.
- `cleanup_native_wsl_projection` removes an exact idle projection and its matching quarantine
  state; active worktrees are refused.

Prepare and cleanup require both `"mutation": {"authorized": true}` in the input and the MCP
server mutation gate. Status and quarantine inspection remain available when mutations are
disabled. All results omit source/native paths and expose stable digests, reason codes, bounded
command evidence, counts, and next actions.

On success, pass the returned `selectionDigest` to projected `attempt prepare`. Launch resolves
the engine-authored selection, emits the machine-verifiable execution path mapping, and preserves
the request's exact `base_sha` even when the Windows source HEAD or dirty state later changes.
See the [native Windows-to-WSL projection workflow](docs/workflows/native-wsl-projection.md).

### mcp_lexrunner_plan_create

Creates a plan from configuration files or auto-discovers from GitHub PRs. This is a **convenience wrapper** that combines PR discovery (`pr_list`), plan generation, validation, and file writing into a single operation.

> **Deprecated alias:** `plan.create`
>
> **Note:** For more granular control, use `pr_list`, `plan_validate`, and `plan_analyze` tools individually.

**Parameters:**

- `json` (boolean, optional): Output plan as JSON to stdout
- `outDir` (string, optional): Output directory for plan artifacts

**GitHub Auto-Discovery Parameters:**

- `fromGithub` (boolean, optional): Enable auto-discovery of PRs from GitHub API
- `query` (string, optional): GitHub search query (e.g., 'is:open label:feature')
- `labels` (array of strings, optional): Filter PRs by labels
- `includeDrafts` (boolean, optional): Include draft PRs (default: true)
- `excludePRs` (array of numbers, optional): Exclude specific PR numbers
- `githubToken` (string, optional): GitHub API token (or use GITHUB_TOKEN env var)
- `owner` (string, optional): GitHub repository owner (auto-detected from git remote)
- `repo` (string, optional): GitHub repository name (auto-detected from git remote)
- `requiredGates` (array of strings, optional): Required gates (default: ["lint", "typecheck", "test"])
- `maxWorkers` (number, optional): Maximum parallel workers (default: 2)
- `target` (string, optional): Target branch for merging PRs (default: repo default branch)

**Returns:**

```json
{
  "plan": { ... },
  "outDir": "/path/to/output"
}
```

**Example - Traditional Mode (from configuration files):**

```json
{
  "name": "mcp_lexrunner_plan_create",
  "arguments": {
    "json": true,
    "outDir": ".smartergpt/runner"
  }
}
```

**Example - Auto-Detected GitHub Mode (from scope.yml):**

When `scope.yml` contains GitHub discovery filters (labels or query), the tool automatically enables GitHub mode:

```yaml
# .smartergpt/scope.yml
version: 1
target: main
sources:
  - query: "is:open label:stack:*"
selectors:
  include_labels: ["ready-merge"]
  exclude_labels: ["WIP"]
defaults:
  strategy: merge-weave
  base: main
pin_commits: false
```

Then call `mcp_lexrunner_plan_create` without any parameters - it will auto-detect and use GitHub mode:

```json
{
  "name": "mcp_lexrunner_plan_create",
  "arguments": {}
}
```

The tool will:

1. Detect that scope.yml has GitHub filters
2. Automatically enable GitHub mode
3. Use filters from scope.yml (`query`, `labels`, `target`)
4. Log to stderr: `[mcp:mcp_lexrunner_plan_create] Auto-detected GitHub mode from scope.yml filters`
5. Discover PRs matching the filters
6. Generate plan.json with discovered PRs

**Example - GitHub Auto-Discovery Mode (explicit):**

```json
{
  "name": "mcp_lexrunner_plan_create",
  "arguments": {
    "fromGithub": true,
    "labels": ["feature", "bugfix"],
    "excludePRs": [123, 456],
    "requiredGates": ["lint", "test", "security"],
    "maxWorkers": 4,
    "target": "develop",
    "outDir": "/tmp/lexrunner-plan"
  }
}
```

**Example - Complex GitHub Query:**

```json
{
  "name": "mcp_lexrunner_plan_create",
  "arguments": {
    "fromGithub": true,
    "query": "is:open label:stack:* -label:wip",
    "includeDrafts": false,
    "githubToken": "ghp_...",
    "owner": "myorg",
    "repo": "myrepo"
  }
}
```

### pr_list

Lists pull requests from GitHub without creating a plan. This is a granular tool that allows agents to discover PRs independently before deciding whether to create a plan.

**Parameters:**

- `owner` (string, optional): GitHub repository owner (auto-detected from git remote if not provided)
- `repo` (string, optional): GitHub repository name (auto-detected from git remote if not provided)
- `query` (string, optional): GitHub search query (e.g., 'is:open label:stack:\*')
- `labels` (array of strings, optional): Filter PRs by labels
- `includeDrafts` (boolean, optional): Include draft PRs in results (default: true)
- `excludePRs` (array of numbers, optional): Exclude specific PR numbers
- `githubToken` (string, optional): GitHub API token (or use GITHUB_TOKEN env var)
- `state` (string, optional): PR state filter - "open", "closed", or "all" (default: "open")

**Returns:**

```json
{
  "pullRequests": [
    {
      "number": 123,
      "title": "Add feature X",
      "branch": "feature/x",
      "author": "developer",
      "labels": ["feature", "ready"],
      "sha": "abc123def456",
      "draft": false
    }
  ],
  "total": 10,
  "filtered": 5,
  "owner": "myorg",
  "repo": "myrepo"
}
```

**Example:**

```json
{
  "name": "pr_list",
  "arguments": {
    "labels": ["ready-merge"],
    "includeDrafts": false,
    "excludePRs": [100, 101]
  }
}
```

**Use Cases:**

- **Pre-flight checks**: List PRs to verify what would be included before creating a plan
- **Human review**: Show PRs to user for manual selection before plan creation
- **Custom workflows**: Build multi-step workflows where PR discovery is separate from planning

### plan_validate

Validates a plan.json file for schema compliance and logical consistency without executing it. This granular tool allows checking plan validity independently of creation or execution.

**Parameters:**

- `planFile` (string, optional): Path to plan.json file (default: `<profile>/runner/plan.json`)
- `planContent` (string, optional): JSON string of plan content to validate (alternative to planFile)

**Returns:**

```json
{
  "valid": true,
  "errors": [],
  "warnings": ["Plan contains no items"],
  "plan": {
    "schemaVersion": "1.0.0",
    "target": "main",
    "itemCount": 5
  }
}
```

If validation fails:

```json
{
  "valid": false,
  "errors": [
    {
      "path": "items",
      "message": "Duplicate item names found: PR-1",
      "code": "DUPLICATE_NAMES"
    }
  ]
}
```

**Example (validate existing file):**

```json
{
  "name": "plan_validate",
  "arguments": {
    "planFile": "/tmp/test-plan.json"
  }
}
```

**Example (validate plan content directly):**

```json
{
  "name": "plan_validate",
  "arguments": {
    "planContent": "{\"schemaVersion\":\"1.0.0\",\"target\":\"main\",\"items\":[]}"
  }
}
```

**Use Cases:**

- **Pre-execution validation**: Check a plan before running gates
- **CI validation**: Validate plans in CI/CD pipelines
- **Manual plan editing**: Validate hand-edited plan.json files

### plan_analyze

Analyzes a plan for potential conflicts and dependency issues. Performs dry-run dependency resolution and conflict detection without execution. This granular tool provides detailed analysis of plan structure and dependencies.

**Parameters:**

- `planFile` (string, optional): Path to plan.json file (default: `<profile>/runner/plan.json`)

**Returns:**

```json
{
  "valid": true,
  "mergeOrder": [["PR-1", "PR-2"], ["PR-3"]],
  "conflicts": [],
  "dependencies": {
    "total": 2
  },
  "summary": {
    "totalItems": 3,
    "maxParallelism": 2,
    "hasIssues": false
  }
}
```

If issues are found:

```json
{
  "valid": false,
  "conflicts": [
    {
      "type": "cycle",
      "message": "Dependency cycle detected: PR-1 -> PR-2 -> PR-1",
      "items": ["PR-1", "PR-2"]
    }
  ],
  "dependencies": {
    "total": 3,
    "cycles": [["PR-1", "PR-2", "PR-1"]],
    "unknown": ["PR-99"]
  },
  "summary": {
    "totalItems": 3,
    "maxParallelism": 0,
    "hasIssues": true
  }
}
```

**Example:**

```json
{
  "name": "plan_analyze",
  "arguments": {
    "planFile": ".smartergpt/runner/plan.json"
  }
}
```

**Use Cases:**

- **Dependency validation**: Verify no circular dependencies before execution
- **Parallelism planning**: Understand maximum parallelism potential
- **Conflict prediction**: Identify potential merge conflicts early

### mcp_lexrunner_gate_run

Executes gates for plan items. Can work with either an internal plan (created via `mcp_lexrunner_plan_create`) or an external plan file.

> **Deprecated alias:** `gates.run`

All overlapping integration tools use the same plan-reference precedence:

1. `planFile`, when supplied. The explicit reference is authoritative and never falls through.
2. `plan.json` in the repository root.
3. `<profile>/runner/plan.json` as the backward-compatible `plan_create` fallback.

Their results include the same path-independent `planArtifact` identity. Compare its canonical
`digest` to verify that status, merge ordering, gate execution, and merge preview consumed the
same frozen plan.

**Parameters:**

- `planFile` (string, optional): Explicit path to an authored plan
- `onlyItem` (string, optional): Execute gates for this item only
- `onlyGate` (string, optional): Execute this gate only
- `outDir` (string, optional): Output directory for gate results
- `timeoutMs` (integer, optional): Operation-default timeout; a gate's own `timeoutMs` overrides it

**Returns:**

```json
{
  "items": [
    {
      "name": "item1",
      "status": "pass",
      "gates": [
        {
          "name": "test",
          "status": "pass",
          "timeoutMs": 45000
        }
      ]
    }
  ],
  "allGreen": true,
  "artifactRefs": [
    { "kind": "gate-results-directory", "path": "..." },
    {
      "kind": "gate-evidence-manifest",
      "path": ".../gate-evidence-manifest.json",
      "sha256": "sha256:..."
    }
  ],
  "planArtifact": {
    "contract": "plan-artifact-identity-v1",
    "kind": "execution-plan",
    "schema": "lexrunner.execution-plan",
    "schemaVersion": "1.0.0",
    "digest": "sha256:...",
    "target": "main",
    "itemCount": 1
  }
}
```

Pass the returned manifest `path` and `sha256` to published `status` (source alias `weave_status`) as `evidenceFile` and
`evidenceSha256`. Status does not scan the output directory or remember an active run. It validates
the plan, candidate, gate, receipt, timeout, and hash bindings and reports the matching gate
observations with `authority: "unverified"`. Those observations do not create merge eligibility:
that requires the separately trusted, plan-pinned verifier receipt tracked by #865. Each execution
uses a fresh unique child of `outDir`, and the returned artifact reference names that exact run.

To also read back the referenced artifact files, opt in with `verifyArtifacts: true`:

```json
{
  "name": "status",
  "arguments": {
    "repoRoot": "/path/to/candidate",
    "planFile": "plan.json",
    "evidenceFile": "/path/to/gate-evidence-manifest.json",
    "evidenceSha256": "sha256:<returned-manifest-digest>",
    "verifyArtifacts": true
  }
}
```

Only boolean values are accepted. Omitting `verifyArtifacts` or supplying `false` preserves
receipt-integrity status without artifact-file read-back. Supplying `true` requires the explicit
manifest path and hash; status never discovers evidence by scanning directories. The bounded
`evidence.artifactVerification` report says `complete` or `incomplete` and retains
`authority: "unverified"`. Missing, changed or unverifiable artifact bytes cannot be reported
as complete. This read-back is an observation of the referenced bytes, not merge authority or
proof of native runtime behavior.

The same option belongs to `gates.status` when observing an explicit durable operation handle.
Its report is at top-level `artifactVerification`. Incomplete read-back cannot report a passing
completed operation; it reports an unknown observation with
`GATE_OPERATION_ARTIFACTS_INCOMPLETE`. The immutable operation handle is unchanged.
`gates.start` and `gates.cancel` reject this status-only setting, including `false`.

**Example (using repository or profile fallback):**

```json
{
  "name": "mcp_lexrunner_gate_run",
  "arguments": {
    "onlyItem": "api-endpoints",
    "outDir": ".smartergpt/runner/gates"
  }
}
```

**Example (using external plan):**

```json
{
  "name": "mcp_lexrunner_gate_run",
  "arguments": {
    "planFile": "/tmp/batch5-plan.json",
    "outDir": "/tmp/gate-results"
  }
}
```

**Use Cases:**

- **Authored plan**: Run gates directly from a repository-root or explicitly referenced plan
- **Profile fallback**: Continue using a plan created via `mcp_lexrunner_plan_create`
- **External orchestration**: Run gates on programmatically-created or externally-managed plan files
- **Parallel workflows**: Execute gates on multiple independent plans in parallel merge-weave operations

### mcp_lexrunner_weave_apply

Applies merge operations with environment-based gating.

> **Deprecated alias:** `merge.apply`

**Parameters:**

- `planFile` (string, optional): Explicit path to an authored plan, using the same fallback precedence as gate execution
- `dryRun` (boolean, optional): Simulate merge without making changes (default: `true`)

**Returns:**

```json
{
  "mode": "dry-run",
  "dryRun": true,
  "ok": true,
  "status": "preview",
  "totalItems": 1,
  "levels": [["item1"]],
  "artifactRefs": [],
  "planArtifact": {
    "contract": "plan-artifact-identity-v1",
    "kind": "execution-plan",
    "schema": "lexrunner.execution-plan",
    "schemaVersion": "1.0.0",
    "digest": "sha256:...",
    "target": "main",
    "itemCount": 1
  }
}
```

**Example:**

```json
{
  "name": "mcp_lexrunner_weave_apply",
  "arguments": {
    "planFile": "plan.json",
    "dryRun": true
  }
}
```

## Safety Features

### Read-Only by Default

The MCP server is read-only by default:

- `mcp_lexrunner_weave_apply` requires `ALLOW_MUTATIONS=true` for actual merging
- All operations default to safe, non-destructive behavior
- Dry-run mode is available for testing merge eligibility

### Environment Gating

Destructive operations are gated by environment variables:

- `ALLOW_MUTATIONS=false` (default): Only read operations and dry runs
- `ALLOW_MUTATIONS=true`: Enables actual merge operations

### Error Handling

The server provides clear error messages for:

- Missing plan files (run `mcp_lexrunner_plan_create` first)
- Invalid parameters (validated using Zod schemas)
- Environment restrictions (mutations blocked when disabled)

## Integration Examples

### With MCP Client

```javascript
// Connect to the MCP server
const client = new Client({
  command: "npm",
  args: ["run", "mcp"],
  cwd: "/path/to/lexrunner",
});

// Create a plan from configuration files (traditional mode)
const planResult = await client.callTool("mcp_lexrunner_plan_create", {
  outDir: ".smartergpt/runner",
});

// Create a plan from GitHub PRs (auto-discovery mode)
const githubPlanResult = await client.callTool("mcp_lexrunner_plan_create", {
  fromGithub: true,
  labels: ["feature", "priority:high"],
  excludePRs: [100, 200],
  requiredGates: ["lint", "test", "security"],
  maxWorkers: 4,
  outDir: "/tmp/lexrunner-plan",
});

// Run gates on internal plan
const gatesResult = await client.callTool("mcp_lexrunner_gate_run", {
  outDir: ".smartergpt/runner/gates",
});

// Or run gates on external plan file
const externalGatesResult = await client.callTool("mcp_lexrunner_gate_run", {
  planFile: "/tmp/merge-batch/plan.json",
  outDir: "/tmp/merge-batch/gates",
});

// Check merge eligibility (dry run)
const mergeResult = await client.callTool("mcp_lexrunner_weave_apply", {
  planFile: "/tmp/merge-batch/plan.json",
  dryRun: true,
});
```

### External Plan Files (Merge-Weave Workflows)

The `planFile` parameter enables external orchestration workflows:

```javascript
// Programmatically create a plan
const externalPlan = {
  schemaVersion: "1.0.0",
  target: "main",
  items: [
    {
      name: "batch-item-1",
      deps: [],
      gates: [{ name: "lint", run: "npm run lint", env: {} }],
    },
  ],
};

// Write to disk
fs.writeFileSync("/tmp/batch1-plan.json", JSON.stringify(externalPlan));

// Execute gates on external plan
const result = await client.callTool("mcp_lexrunner_gate_run", {
  planFile: "/tmp/batch1-plan.json",
  outDir: "/tmp/batch1-gates",
});
```

### With Environment Variables

```bash
# Safe mode (default) - only read operations
npm run mcp

# Enable mutations for actual merging
ALLOW_MUTATIONS=true npm run mcp

# Custom profile directory
LEX_PROFILE_DIR=/my/project/.config npm run mcp
```

## Task Handoff Tools (ADR-007)

The task handoff tools implement the [Task Snapshot Contract (ADR-007)](docs/adr/ADR-007-task-snapshot-contract.md), enabling bounded work delegation to stochastic agents with rigorous verification.

### create_task_snapshot

Create a task snapshot for agent handoff with failure evidence, target files, and verification command.

**Canonical name:** `lexrunner_create_task_snapshot`

**Parameters:**

- `procedure` (required): Procedure identifier (e.g., `"post-merge-fix"`, `"fanout-issue"`)
- `determinism` (optional): Level `"D1"`, `"D2"`, or `"D3"` (default: `"D1"`)
- `failureMessage` (required): Short error description
- `failureFileRel` (required): Repo-relative path to failed file
- `failureLine` (optional): Line number if available
- `runnerOutputSnip` (required): Actual test runner output
- `failureExcerpt` (optional): Code context around failure
- `targetFiles` (required): Array of repo-relative paths to modify
- `verificationCmd` (required): Command to run for verification
- `expectedExitCode` (optional): Expected exit code (default: `0`)
- `taskId` (optional): Custom task ID (auto-generated if not provided)
- `repoRoot` (optional): Absolute repo path (auto-detected if not provided)
- `repoId` (optional): Repository ID `"owner/repo"` (auto-detected if not provided)
- `commitSha` (optional): Git commit SHA (auto-detected if not provided)

**Returns:** `TaskSnapshot_v1` JSON with task ID

**Example:**

```javascript
const result = await client.callTool("create_task_snapshot", {
  procedure: "post-merge-fix",
  determinism: "D1",
  failureMessage: "Expected 6, received 7",
  failureFileRel: "tests/unit/example.spec.ts",
  failureLine: 42,
  runnerOutputSnip: "FAIL tests/unit/example.spec.ts\n  Expected: 6\n  Received: 7",
  targetFiles: ["tests/unit/example.spec.ts"],
  verificationCmd: "npm test -- tests/unit/example.spec.ts",
});

console.log(result.taskId); // "01HQXYZ..."
console.log(result.snapshot.snapshot_hash); // "sha256:abc..."
```

### submit_task_receipt

Submit a task receipt after agent completes work. Returns acknowledgment and engine verification status.

**Canonical name:** `lexrunner_submit_task_receipt`

**Parameters:**

- `receipt` (required): `TaskReceipt_v1` JSON object

**Returns:** Verification result with trust gap detection

**Example:**

```javascript
const receipt = {
  schema_version: "1.0.0",
  task_id: snapshot.task_id,
  snapshot_hash: snapshot.snapshot_hash,
  claims: {
    success: true,
    patch: "--- a/test.ts\n+++ b/test.ts\n...",
    files_touched: ["test.ts"],
    rationale: "Updated assertion to match new count",
    confidence: "high",
    assumptions_made: [{ type: "test", text: "No other tests depend on this value" }],
  },
  search_activity: [],
  cost: { token_usage: { input: 1000, output: 200, total: 1200 } },
  blockers: [],
};

const result = await client.callTool("submit_task_receipt", { receipt });

console.log(result.verification.verified); // true/false
console.log(result.verification.trustGap); // false if agent claim matches engine
```

### get_task_status

Get current task state including snapshot, receipt, and verification info.

**Canonical name:** `lexrunner_get_task_status`

**Parameters:**

- `taskId` (required): Unique task identifier

**Returns:** Task status with state, snapshot, receipt, and verification

**Example:**

```javascript
const status = await client.callTool("get_task_status", {
  taskId: "01HQXYZ...",
});

console.log(status.state); // "pending" | "in_progress" | "completed" | "verified" | "failed"
console.log(status.snapshot); // TaskSnapshot_v1
console.log(status.receipt); // TaskReceipt_v1 (if submitted)
```

### list_pending_tasks

List pending task snapshots with optional filtering.

**Canonical name:** `lexrunner_list_pending_tasks`

**Parameters:**

- `procedure` (optional): Filter by procedure identifier
- `determinism` (optional): Filter by level `"D1"`, `"D2"`, or `"D3"`
- `limit` (optional): Maximum tasks to return

**Returns:** Array of pending tasks

**Example:**

```javascript
const tasks = await client.callTool("list_pending_tasks", {
  procedure: "post-merge-fix",
  determinism: "D1",
  limit: 10,
});

console.log(tasks.total); // Total count
console.log(tasks.tasks); // Array of task info
```

## Workflow

1. **Setup**: Configure your project in `LEX_PROFILE_DIR` (default: `.smartergpt/`)
2. **Plan**: Use `mcp_lexrunner_plan_create` to generate execution plan
3. **Execute**: Use `mcp_lexrunner_gate_run` to run gates and collect results
4. **Merge**: Use `mcp_lexrunner_weave_apply` to check eligibility or perform merges

The MCP server maintains the same deterministic behavior as the CLI, ensuring consistent results across different interfaces.
