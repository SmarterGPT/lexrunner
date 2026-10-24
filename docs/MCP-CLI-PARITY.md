# MCP/CLI Parity Guide

**Status:** Bounded selected-operation guide
**Issue:** AX-004
**AX Principle:** Structured Over Conversational

This document explains selected CLI/MCP mappings and shared contracts. It is not the published
tool inventory. The generated inventory in [README.mcp.md](../README.mcp.md#published-tool-inventory)
and its checked source, [cli-mcp-surface.json](architecture/cli-mcp-surface.json), are authoritative
for which tools currently exist. `npm run docs:surface:check` verifies that inventory against the
published `tools/list` surface in `mcp-server.mjs`.

## Parity Matrix

### Core Operations

<!-- lexrunner-mcp-parity-tools:start -->

| Operation     | CLI                              | MCP                    | Notes                                                                                      |
| ------------- | -------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------ |
| plan create   | ✅ `lexrunner weave plan`        | ✅ `plan.create`       | Shared repository-bound routing, discovery and receipt                                     |
| plan validate | ✅ `lexrunner schema validate`   | —                      | Standalone schema validation is CLI-only; `plan.create` validates only the Plan it creates |
| gates run     | ✅ `lexrunner gate run`          | ✅ `gates.run`         | Shared `GateExecutionService`                                                              |
| merge apply   | ✅ `lexrunner weave apply`       | ✅ `merge.apply`       | Non-dry-run MCP use also requires `ALLOW_MUTATIONS=true`                                   |
| health check  | ✅ `lexrunner workspace doctor`  | ✅ `doctor` / `health` | `health` is a deprecated compatibility tool                                                |
| discover PRs  | ✅ `lexrunner weave discover`    | ✅ `discover`          | Shared `DiscoveryQueryService`                                                             |
| status check  | ✅ `lexrunner weave status`      | ✅ `status`            | Shared `IntegrationStatusQueryService`                                                     |
| merge order   | ✅ `lexrunner weave merge-order` | ✅ `merge-order`       | Shared `MergeOrderQueryService`                                                            |
| config show   | ✅ `lexrunner config show`       | ✅ `config.show`       | Shared bounded configuration query                                                         |

### Configuration Operations

| Operation       | CLI                                             | MCP                  | Notes                                                                     |
| --------------- | ----------------------------------------------- | -------------------- | ------------------------------------------------------------------------- |
| init workspace  | ✅ `lexrunner workspace init --non-interactive` | ✅ `local.init`      | Shared deterministic non-interactive local-overlay path                   |
| profile resolve | ✅ `lexrunner config show` (overlap)            | ✅ `profile.resolve` | MCP returns the bounded resolved profile; CLI exposes broader config data |

<!-- lexrunner-mcp-parity-tools:end -->

### Internal CLI Surfaces

The legacy senior-dev command group is classified `internal-only` in the checked surface. It has
no published MCP tools and is intentionally omitted from the parity table. Internal command
presence must not be read as package or MCP support.

### Deprecated Integration-Record Adapters

These MCP-only compatibility tools operate on frozen integration records. They are not ADR-010
Run/Attempt orchestration authority and are scheduled for removal in 3.0.0.

| Operation                 | MCP                       | Replacement                                                                |
| ------------------------- | ------------------------- | -------------------------------------------------------------------------- |
| create integration record | `lexrunner.startRun`      | `plan.create`, `gates.run`, or `merge.apply`; `start_attempt` for Attempts |
| read integration status   | `lexrunner.getStatus`     | `status`; `get_attempt_status` for Attempts                                |
| list artifact metadata    | `lexrunner.listArtifacts` | Artifact references from the operation that created them                   |

---

## Flag Mapping

### CLI Flag → MCP Parameter Mapping

| CLI Flag                                 | MCP Parameter              | Description                                                   |
| ---------------------------------------- | -------------------------- | ------------------------------------------------------------- |
| `--json`                                 | N/A (always JSON)          | JSON output mode - MCP always returns JSON                    |
| `--dry-run`                              | `dryRun: true`             | Simulate operations without making changes                    |
| `--plan <file>`                          | `planFile`                 | Path to plan.json file                                        |
| `weave plan --output <file>`             | `outDir`                   | CLI selects the Plan file; MCP selects its artifact directory |
| `--from-github`                          | `fromGithub: true`         | Auto-discover PRs from GitHub API                             |
| `--query <query>`                        | `query`                    | GitHub search query                                           |
| `--labels <labels...>`                   | `labels: ["..."]`          | Filter PRs by labels (CLI: variadic values, MCP: array)       |
| `--include-drafts`                       | `includeDrafts: true`      | Include draft PRs in the plan                                 |
| `--exclude-prs <numbers...>`             | `excludePRs: [...]`        | Exclude specific PRs by number                                |
| `--owner <owner>`                        | `owner`                    | GitHub repository owner                                       |
| `--repo <repo>`                          | `repo`                     | GitHub repository name                                        |
| `--target <branch>`                      | `target`                   | Target branch for merging PRs                                 |
| `--force`                                | `force: true`              | Apply the command's documented existing-state behavior        |
| `--only-item <item>`                     | `onlyItem`                 | Run gates for specific item only                              |
| `--only-gate <gate>`                     | `onlyGate`                 | Run specific gate only                                        |
| `--repo-root <dir>`                      | `repoRoot`                 | Explicit physical Git repository candidate root               |
| `--profile-dir <dir>`                    | `profileDir`               | Profile directory override                                    |
| `workspace doctor --environment-quality` | `environmentQuality: true` | Run the optional environment-quality assessment               |

The published MCP `plan.create` schema also accepts `githubToken`, `requiredGates`, and
`maxWorkers`. Canonical `weave plan` intentionally has no equivalent flags: CLI authentication uses
the supported environment, and that route currently supplies its fixed required gates and worker
limit. Similar-looking options on the deprecated top-level `plan` alias are not canonical parity.

### Example Mappings

**Plan Creation:**

```bash
# CLI
lexrunner weave plan --from-github --repo-root /worktrees/repo --owner org --repo repo --query "is:pr is:open head:release" --output artifacts/plan/plan.json

# MCP
{ "name": "plan.create", "arguments": { "fromGithub": true, "repoRoot": "/worktrees/repo", "owner": "org", "repo": "repo", "query": "is:pr is:open head:release", "outDir": "artifacts/plan" } }
```

Both adapters call `PlanCreationOperationService`. Relative profiles and outputs anchor to the
selected physical Git root. Explicit repository identity must match its local `origin` remote
before API access or writes. Both MCP adapters require a GitHub token for GitHub-mode creation;
the CLI retains unauthenticated public discovery. Each creation writes
`routing-receipt.json`; that receipt is explicitly non-authorizing. See
[repository-bound plan creation](plan-routing.md).

**Gates Execution:**

```bash
# CLI
lex-pr execute plan.json --repo-root /worktrees/repo --json

# MCP
{ "name": "gates.run", "arguments": { "repoRoot": "/worktrees/repo", "planFile": "plan.json" } }
```

With `repoRoot`, both adapters resolve the relative plan, artifact output and local gate cwd from
that physical repository. A local gate cwd cannot escape into another repository. For MCP gate
execution, explicit `repoRoot` disables the ambient profile runner-plan fallback; use `planFile` or
the selected repository's `plan.json`.

**Merge Apply (Dry Run):**

```bash
# CLI
lex-pr merge --dry-run --json

# MCP
{ "name": "merge.apply", "arguments": { "dryRun": true } }
```

---

## Output Format Guarantees

For mappings owned by the same application service, equivalent inputs are expected to produce the
same bounded domain result. CLI JSON envelopes and MCP transport envelopes are not byte-identical,
and a table entry is not evidence that either operation ran.

### Selected shared domain projections

For the selected mappings below, the shared service exposes these domain fields. CLI and MCP
transport envelopes remain distinct, and each row is bounded by its operation-specific tests:

| Operation                     | Output Schema                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| `plan` / `plan.create`        | `{ "schemaVersion": "1.0.1", "target": "...", "items": [...], "policy": {...} }`    |
| `execute` / `gates.run`       | `{ "items": [...], "allGreen": boolean }`                                           |
| `discover` / `discover`       | `{ "pullRequests": [...], "total": N, "authenticated": boolean, "user": "..." }`    |
| `status` / `status`           | `{ "plan": {...}, "mergeSummary": {...} }`                                          |
| `doctor` / `doctor`           | `{ "hasErrors": boolean, "issues": [...], "suggestions": [...], ... }`              |
| `merge-order` / `merge-order` | `{ "levels": [[...]], "totalItems": N, "maxParallelism": N }`                       |
| `config show` / `config.show` | `{ "contract": "bounded-ax-v1", "precedenceChain": [...], "configuration": [...] }` |

### Corresponding domain fields

Shared service projections include the corresponding domain fields where applicable:

- **Plan items**: `name`, `deps`, `gates`
- **Gate results**: `name`, `status`, `exitCode`, `duration`
- **PR data**: `number`, `title`, `sha`, `author`, `labels`
- **AXError data**: `code`, `message`, `nextActions`, optional `context`

### AXError domain fields

Error responses follow the AXError contract:

```typescript
interface AXError {
  code: string;
  message: string;
  nextActions: string[];
  context?: Record<string, unknown>;
}
```

Transport adapters wrap this domain error differently. CLI exit status is command-specific; MCP
uses JSON-RPC protocol codes such as invalid parameters or internal error while retaining the
domain code in the AXError payload. JSON-RPC method-not-found is only for an unknown protocol
method/tool—it is not the automatic mapping for a domain object that was not found. Consult the
operation's checked adapter tests rather than inferring one universal transport table.

### Deterministic Output

Where a contract promises a deterministic projection, its checked invariants include:

1. **Stable key ordering**: Keys sorted alphabetically at all levels
2. **Consistent formatting**: 2-space indentation, no trailing whitespace
3. **Sorted arrays**: Dependencies, items, errors sorted by name/path
4. **Cross-platform consistency**: Same inputs produce identical outputs

The relevant JSON adapters use `canonicalJSONStringify()` where canonical ordering is part of the
contract; do not infer that every human or protocol envelope is byte-identical.

---

## Examples for Common Operations

### 1. Create a Plan from GitHub PRs

**CLI:**

```bash
lex-pr plan --from-github --labels "ready-to-merge" --target main --json
```

**MCP:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "plan.create",
    "arguments": {
      "fromGithub": true,
      "labels": ["ready-to-merge"],
      "target": "main"
    }
  }
}
```

**Shared Plan domain projection (transport wrappers omitted):**

<!-- lexrunner-plan-example:mcp-plan-output -->

```json
{
  "schemaVersion": "1.0.1",
  "target": "main",
  "items": [
    {
      "name": "PR-123",
      "deps": [],
      "gates": [
        { "name": "lint", "run": "npm run lint" },
        { "name": "typecheck", "run": "npm run typecheck" },
        { "name": "test", "run": "npm test" }
      ]
    }
  ],
  "policy": {
    "requiredGates": ["lint", "typecheck", "test"],
    "maxWorkers": 2
  },
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
        "item": "PR-123",
        "ref": "refs/pull/123/head",
        "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }
    ]
  }
}
```

### 2. Discover Open PRs

**CLI:**

```bash
lex-pr discover --json
```

**MCP:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "discover",
    "arguments": {}
  }
}
```

**Shared discovery domain projection (transport wrappers omitted):**

```json
{
  "pullRequests": [
    {
      "number": 123,
      "title": "Add feature X",
      "sha": "abc123...",
      "author": "developer",
      "labels": ["enhancement"]
    }
  ],
  "total": 1,
  "authenticated": true,
  "user": "bot-user"
}
```

### 3. Check Environment Health

**CLI:**

```bash
lex-pr doctor --json
```

**MCP:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "doctor",
    "arguments": {}
  }
}
```

**Shared diagnostics domain projection (transport wrappers omitted):**

```json
{
  "diagnosticBase": "/path/to/repository",
  "hasErrors": false,
  "issues": [],
  "suggestions": [],
  "configuration": { "profileDir": "/path/to/repository/.smartergpt" },
  "nodejs": { "status": "ok", "current": "v24.10.0" },
  "git": { "status": "ok", "isClean": true, "currentBranch": "main" },
  "github": { "detected": true, "authenticated": true }
}
```

MCP `doctor` accepts only optional boolean `environmentQuality` (default `false`). Unknown
properties and wrong-typed values return invalid parameters. It diagnoses the server startup
working directory rather than accepting a per-call root override; the result exposes both
`diagnosticBase` and `configuration.profileDir` so callers can verify the inspected roots.

### 4. Compute Merge Order

**CLI:**

```bash
lex-pr merge-order plan.json --json
```

**MCP:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "merge-order",
    "arguments": { "planFile": "plan.json" }
  }
}
```

**Shared merge-order domain projection (transport wrappers omitted):**

```json
{
  "levels": [["PR-100"], ["PR-101", "PR-102"], ["PR-103"]],
  "totalItems": 4,
  "maxParallelism": 2
}
```

---

## Intentional Gaps

### CLI-Only Commands

These commands are intentionally CLI-only due to their interactive or local-only nature:

| Command                        | Reason                                                                |
| ------------------------------ | --------------------------------------------------------------------- |
| `workspace init` (interactive) | Prompt-driven human workflow; MCP maps only the non-interactive route |
| `bootstrap`                    | Local filesystem bootstrap                                            |
| `view`                         | Interactive TUI requiring terminal                                    |
| `plan-review`                  | Interactive review with prompts                                       |
| `completion`                   | Shell-specific completion scripts                                     |
| `retry`                        | Requires local execution state                                        |
| `query`                        | Interactive query interface                                           |
| `plan-diff`                    | Local file comparison                                                 |
| `idea`                         | Interactive ideation workflow                                         |
| `create-project`               | Interactive project creation                                          |

### MCP-Only Tools

`workflow.guide` is the intentional canonical MCP-only exception for agent guidance. The three
legacy `lexrunner` compatibility tools listed above are deprecated adapters, not orchestration
authority. Consult the generated inventory for the complete current surface.

---

## Testing Parity

To verify parity between CLI and MCP:

```bash
# Run current workspace/config and operation parity tests
npx vitest run tests/architecture/cli-mcp-surface.spec.ts \
  tests/mcp-workspace-config-parity.spec.ts \
  tests/mcp-published-merge-application.spec.ts

# Manual verification
# CLI
lex-pr discover --json > /tmp/cli-discover.json

# MCP (via test script)
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"discover","arguments":{}}}' \
  | node mcp-server.mjs 2>/dev/null \
  | jq -r '.result.content[0].text' > /tmp/mcp-discover.json

# Compare structure
jq 'keys' /tmp/cli-discover.json
jq 'keys' /tmp/mcp-discover.json
```

---

## Version History

| Version | Date       | Changes                               |
| ------- | ---------- | ------------------------------------- |
| 1.0.0   | 2025-12-03 | Initial parity documentation (AX-004) |

---

## References

- [CLI Reference](./cli.md) - Complete CLI command reference
- [MCP Server Architecture](./MCP-MIGRATION.md) - MCP server architecture and implementation
- [MCP Parity Audit](./MCP-PARITY.md) - Detailed parity audit
- [Error Taxonomy](./errors.md) - Error codes, exit codes, and error handling patterns
