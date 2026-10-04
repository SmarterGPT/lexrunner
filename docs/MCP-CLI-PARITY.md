# MCP/CLI Parity Matrix

**Status:** Complete  
**Issue:** AX-004  
**AX Principle:** Structured Over Conversational

This document provides a comprehensive parity matrix showing which LexRunner operations are available via both CLI and MCP surfaces, along with flag mapping and output format guarantees.

## Parity Matrix

### Core Operations

| Operation     | CLI                         | MCP                                | Notes                                                     |
| ------------- | --------------------------- | ---------------------------------- | --------------------------------------------------------- |
| plan create   | ✅ `lex-pr plan`            | ✅ `plan.create`                   | Both support GitHub auto-discovery, labels, gates, target |
| plan validate | ✅ `lex-pr schema validate` | ✅ `plan.create` (with validation) | MCP validates during creation                             |
| gates run     | ✅ `lex-pr execute`         | ✅ `gates.run`                     | MCP accepts external planFile or internal state           |
| merge apply   | ✅ `lex-pr merge`           | ✅ `merge.apply`                   | MCP enforces ALLOW_MUTATIONS for safety                   |
| health check  | ✅ `lex-pr doctor`          | ✅ `health` / `doctor`             | MCP has `health` tool, CLI uses `doctor`                  |
| discover PRs  | ✅ `lex-pr discover`        | ✅ `discover`                      | Both support GitHub PR discovery                          |
| status check  | ✅ `lex-pr status`          | ✅ `status`                        | Show execution status and merge eligibility               |
| merge order   | ✅ `lex-pr merge-order`     | ✅ `merge-order`                   | Compute dependency levels using Kahn's algorithm          |
| config show   | ✅ `lex-pr config show`     | ✅ `config.show`                   | Display configuration with precedence chain               |

### Configuration Operations

| Operation       | CLI                    | MCP                  | Notes                                         |
| --------------- | ---------------------- | -------------------- | --------------------------------------------- |
| init workspace  | ✅ `lex-pr init`       | ❌ CLI-only          | Interactive wizard requiring user input       |
| init local      | ✅ `lex-pr init-local` | ✅ `local.init`      | Auto-detected project configuration           |
| profile resolve | ❌ Internal            | ✅ `profile.resolve` | MCP-only: Internal profile resolution exposed |

### Senior Dev Executor Tools

| Operation       | CLI                                    | MCP                             | Notes                                          |
| --------------- | -------------------------------------- | ------------------------------- | ---------------------------------------------- |
| prepare context | ✅ `lex-pr senior-dev prepare-context` | ✅ `senior-dev.prepare-context` | Gather deterministic artifacts for code review |
| recall context  | ✅ `lex-pr senior-dev recall-context`  | ✅ `senior-dev.recall-context`  | Recall relevant Frames from Lex memory         |
| capture frame   | ✅ `lex-pr senior-dev capture-frame`   | ✅ `senior-dev.capture-frame`   | Capture review session as a Frame              |
| list modes      | ✅ `lex-pr senior-dev modes`           | ✅ `senior-dev.modes`           | List available executor modes                  |

### Run Management Operations

| Operation      | CLI         | MCP                          | Notes                                    |
| -------------- | ----------- | ---------------------------- | ---------------------------------------- |
| start run      | ❌ MCP-only | ✅ `lexrunner.startRun`      | Start a new procedure run                |
| get status     | ❌ MCP-only | ✅ `lexrunner.getStatus`     | Get current run state and next actions   |
| list runs      | ❌ MCP-only | ✅ `lexrunner.listRuns`      | List runs with optional filtering        |
| list artifacts | ❌ MCP-only | ✅ `lexrunner.listArtifacts` | Inspect artifacts and receipts for a run |

---

## Flag Mapping

### CLI Flag → MCP Parameter Mapping

| CLI Flag                   | MCP Parameter            | Description                                             |
| -------------------------- | ------------------------ | ------------------------------------------------------- |
| `--json`                   | N/A (always JSON)        | JSON output mode - MCP always returns JSON              |
| `--dry-run`                | `dryRun: true`           | Simulate operations without making changes              |
| `--plan <file>`            | `planFile`               | Path to plan.json file                                  |
| `--out <dir>`              | `outDir`                 | Output directory for artifacts                          |
| `--from-github`            | `fromGithub: true`       | Auto-discover PRs from GitHub API                       |
| `--query <query>`          | `query`                  | GitHub search query                                     |
| `--labels <labels>`        | `labels: ["..."]`        | Filter PRs by labels (CLI: comma-separated, MCP: array) |
| `--include-drafts`         | `includeDrafts: true`    | Include draft PRs in the plan                           |
| `--exclude-prs <numbers>`  | `excludePRs: [...]`      | Exclude specific PRs by number                          |
| `--github-token <token>`   | `githubToken`            | GitHub API token                                        |
| `--owner <owner>`          | `owner`                  | GitHub repository owner                                 |
| `--repo <repo>`            | `repo`                   | GitHub repository name                                  |
| `--required-gates <gates>` | `requiredGates: ["..."]` | List of required gates                                  |
| `--max-workers <n>`        | `maxWorkers`             | Maximum parallel workers                                |
| `--target <branch>`        | `target`                 | Target branch for merging PRs                           |
| `--force`                  | `force: true`            | Force operation (e.g., overwrite existing)              |
| `--only-item <item>`       | `onlyItem`               | Run gates for specific item only                        |
| `--only-gate <gate>`       | `onlyGate`               | Run specific gate only                                  |
| `--repo-root <dir>`        | `repoRoot`               | Explicit physical Git repository candidate root         |
| `--profile-dir <dir>`      | `profileDir`             | Profile directory override                              |
| `--include-metrics`        | `includeMetrics: true`   | Include detailed metrics in response                    |

### Example Mappings

**Plan Creation:**

```bash
# CLI
lex-pr plan --from-github --labels "ready" --json

# MCP
{ "name": "plan.create", "arguments": { "fromGithub": true, "labels": ["ready"] } }
```

**Gates Execution:**

```bash
# CLI
lex-pr execute plan.json --json

# MCP
{ "name": "gates.run", "arguments": { "planFile": "plan.json" } }
```

**Merge Apply (Dry Run):**

```bash
# CLI
lex-pr merge --dry-run --json

# MCP
{ "name": "merge.apply", "arguments": { "dryRun": true } }
```

---

## Output Format Guarantees

Both CLI (`--json`) and MCP surfaces produce **semantically identical JSON** for equivalent operations:

### Same Schema

All parity operations return the same JSON structure:

| Operation                     | Output Schema                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `plan` / `plan.create`        | `{ "schemaVersion": "1.0.0", "target": "...", "items": [...], "policy": {...} }` |
| `execute` / `gates.run`       | `{ "items": [...], "allGreen": boolean }`                                        |
| `discover` / `discover`       | `{ "pullRequests": [...], "total": N, "authenticated": boolean, "user": "..." }` |
| `status` / `status`           | `{ "plan": {...}, "mergeSummary": {...} }`                                       |
| `doctor` / `doctor`           | `{ "hasErrors": boolean, "issues": [...], "suggestions": [...], ... }`           |
| `merge-order` / `merge-order` | `{ "levels": [[...]], "totalItems": N, "maxParallelism": N }`                    |
| `config show` / `config.show` | `{ "config": {...}, "provenance": {...}, "sources": [...] }`                     |

### Same Fields

Both surfaces include identical fields in their responses:

- **Plan items**: `name`, `deps`, `gates`
- **Gate results**: `name`, `status`, `exitCode`, `duration`
- **PR data**: `number`, `title`, `sha`, `author`, `labels`
- **Error data**: `error`, `code`, `message`, `details`

### Same Error Shapes (AXError)

Error responses follow the AXError contract:

```typescript
interface AXError {
  error: true;
  code: string; // e.g., "ECYCLE", "ESCHEMA", "ENOTFOUND"
  message: string; // Human-readable description
  details?: {
    // Context-specific details
    path?: string[]; // For cycle errors
    cyclePath?: string[];
    affectedPRs?: string[];
  };
}
```

| Error Type       | CLI Exit Code | MCP Error Code            |
| ---------------- | ------------- | ------------------------- |
| Success          | 0             | No error                  |
| System error     | 1             | -32603 (Internal)         |
| Validation error | 2             | -32602 (Invalid params)   |
| Not found        | 1             | -32601 (Method not found) |

### Deterministic Output

Both surfaces guarantee deterministic JSON output:

1. **Stable key ordering**: Keys sorted alphabetically at all levels
2. **Consistent formatting**: 2-space indentation, no trailing whitespace
3. **Sorted arrays**: Dependencies, items, errors sorted by name/path
4. **Cross-platform consistency**: Same inputs produce identical outputs

All JSON output uses `canonicalJSONStringify()` for determinism.

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

**Output (both):**

```json
{
  "schemaVersion": "1.0.0",
  "target": "main",
  "items": [
    {
      "name": "PR-123",
      "deps": [],
      "gates": [
        { "name": "lint", "run": "npm run lint" },
        { "name": "test", "run": "npm test" }
      ]
    }
  ],
  "policy": {
    "requiredGates": ["lint", "typecheck", "test"],
    "maxWorkers": 2
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

**Output (both):**

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

**Output (both):**

```json
{
  "hasErrors": false,
  "issues": [],
  "suggestions": [],
  "nodejs": { "status": "ok", "current": "v20.10.0" },
  "git": { "status": "ok", "isClean": true, "currentBranch": "main" },
  "github": { "detected": true, "authenticated": true }
}
```

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

**Output (both):**

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

| Command          | Reason                                  |
| ---------------- | --------------------------------------- |
| `init`           | Interactive wizard requiring user input |
| `bootstrap`      | Local filesystem bootstrap              |
| `view`           | Interactive TUI requiring terminal      |
| `plan-review`    | Interactive review with prompts         |
| `completion`     | Shell-specific completion scripts       |
| `retry`          | Requires local execution state          |
| `query`          | Interactive query interface             |
| `plan-diff`      | Local file comparison                   |
| `idea`           | Interactive ideation workflow           |
| `create-project` | Interactive project creation            |

### MCP-Only Tools

These tools are intentionally MCP-only for orchestration purposes:

| Tool                      | Reason                                      |
| ------------------------- | ------------------------------------------- |
| `lexrunner.startRun`      | Run lifecycle management for agents         |
| `lexrunner.getStatus`     | Agent status queries                        |
| `lexrunner.listRuns`      | Run enumeration for orchestration           |
| `lexrunner.listArtifacts` | Artifact inspection for agents              |
| `profile.resolve`         | Internal resolution exposed for MCP clients |

---

## Testing Parity

To verify parity between CLI and MCP:

```bash
# Run parity tests
npm test -- --grep "mcp-parity"

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
