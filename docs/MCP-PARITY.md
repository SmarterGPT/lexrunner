# MCP/CLI Selected Mapping Guide

**Status:** Bounded selected-operation guide
**Issue:** AX-004
**AX Principle:** Structured Over Conversational

This guide documents selected CLI/MCP routes that share an application service. It is not the
published tool inventory and does not claim command-for-tool symmetry. The generated inventory in
[README.mcp.md](../README.mcp.md#published-tool-inventory) and its checked source,
[cli-mcp-surface.json](architecture/cli-mcp-surface.json), are authoritative for current names,
dispositions, owners, and intentional exceptions. `npm run docs:surface:check` verifies them against
the server's published `tools/list` response.

## Selected mappings

<!-- lexrunner-mcp-parity-tools:start -->

| Operation            | CLI route                                        | MCP tool          | Shared owner / boundary                                                   |
| -------------------- | ------------------------------------------------ | ----------------- | ------------------------------------------------------------------------- |
| create Plan          | `lexrunner weave plan`                           | `plan.create`     | `PlanCreationService`; MCP returns its own transport envelope             |
| run gates            | `lexrunner gate run`                             | `gates.run`       | `GateExecutionService`; external-plan routing is explicitly tested        |
| apply merge          | `lexrunner weave apply`                          | `merge.apply`     | `MergeApplicationService`; MCP mutations also require `ALLOW_MUTATIONS`   |
| discover PRs         | `lexrunner weave discover`                       | `discover`        | `DiscoveryQueryService`                                                   |
| integration status   | `lexrunner weave status`                         | `status`          | `IntegrationStatusQueryService`                                           |
| diagnostics          | `lexrunner workspace doctor`                     | `doctor`          | `WorkspaceDiagnosticsService`; startup/repository scope remains explicit  |
| merge order          | `lexrunner weave merge-order`                    | `merge-order`     | `MergeOrderQueryService`                                                  |
| configuration        | `lexrunner config show`                          | `config.show`     | `ConfigurationQueryService`                                               |
| initialize workspace | `lexrunner workspace init --non-interactive`     | `local.init`      | deterministic non-interactive `WorkspaceInitializationService` route only |
| resolve profile      | `lexrunner config show` (overlapping projection) | `profile.resolve` | bounded profile projection, not identical command output                  |

<!-- lexrunner-mcp-parity-tools:end -->

The interactive `workspace init` path is human-only. The mapping above is explicitly the shared
non-interactive route. Likewise, the legacy senior-dev CLI group is classified `internal-only` and
has no published MCP tools. Deprecated `health` and dotted legacy compatibility tools are omitted
from this selected table; the generated inventory remains authoritative, and they are not canonical
orchestration authority.

## Domain projection versus transport

Mappings above identify shared service/domain behavior for equivalent inputs. They do not promise
byte-identical output, identical command flags, a common transport envelope, or proof that an
operation ran. CLI JSON, human CLI formatting, and MCP JSON-RPC/content envelopes are distinct.
Protected mutations also retain adapter-specific admission checks. Exact equivalence belongs to the
operation-specific tests and contract profile recorded in the generated surface.

### Selected input/output sketches

#### `plan` / `plan.create`

The combined command/output block below is an abbreviated mapping sketch, not an executable Plan;
the returned object uses ellipses and omits required fields.

<!-- lexrunner-non-executable-plan:mcp-parity-plan-output-fragment -->

```
CLI:  lexrunner weave plan --from-github --labels "ready" --json
MCP:  { name: "plan.create", arguments: { fromGithub: true, labels: ["ready"] } }

Shared domain projection sketch (transport wrappers omitted):
{
  "schemaVersion": "1.0.1",
  "target": "main",
  "items": [...],
  "policy": {...}
}
```

#### `execute` / `gates.run`

The result sketch uses placeholders and omits transport fields; it is not an executable Plan.

<!-- lexrunner-non-executable-plan:mcp-parity-gate-output-fragment -->

```
CLI:  lexrunner gate run plan.json --json
MCP:  { name: "gates.run", arguments: { planFile: "plan.json" } }

Shared domain projection sketch (transport wrappers omitted):
{
  "items": [{ "name": "...", "status": "pass", "gates": [...] }],
  "allGreen": true
}
```

#### `discover` / `discover`

```
CLI:  lexrunner weave discover --json
MCP:  { name: "discover", arguments: {} }

Shared domain projection sketch (transport wrappers omitted):
{
  "pullRequests": [...],
  "total": N,
  "authenticated": true,
  "user": "..."
}
```

#### `status` / `status`

The nested `plan` value below is an abbreviated status summary, not an executable Plan document.

<!-- lexrunner-non-executable-plan:mcp-parity-status-plan-summary -->

```
CLI:  lexrunner weave status plan.json --json
MCP:  { name: "status", arguments: { planFile: "plan.json" } }

Shared domain projection sketch (transport wrappers omitted):
{
  "plan": { "schemaVersion": "...", "target": "...", "itemCount": N },
  "mergeSummary": { "eligible": [...], "pending": [...], "failed": [...] }
}
```

#### `doctor` / `doctor`

```
CLI:  lexrunner workspace doctor --json
MCP:  { name: "doctor", arguments: {} }

Shared domain projection sketch (transport wrappers omitted):
{
  "hasErrors": false,
  "issues": [],
  "suggestions": [],
  "nodejs": { "status": "ok", ... },
  "git": { "status": "ok", ... },
  ...
}
```

#### `merge-order` / `merge-order`

```
CLI:  lexrunner weave merge-order plan.json --json
MCP:  { name: "merge-order", arguments: { planFile: "plan.json" } }

Shared domain projection sketch (transport wrappers omitted):
{
  "levels": [["item-a"], ["item-b"]],
  "totalItems": N,
  "maxParallelism": N
}
```

#### `config show` / `config.show`

```
CLI:  lexrunner config show --json
MCP:  { name: "config.show", arguments: {} }

Shared domain projection sketch (transport wrappers omitted):
{
  "contract": "bounded-ax-v1",
  "precedenceChain": [...],
  "configuration": [...]
}
```

## Error mapping boundary

Shared services expose bounded AX error data (`code`, `message`, `nextActions`, and optional
`context`). Adapters project that domain failure differently: the CLI selects a command-specific
exit status and output envelope, while MCP uses a JSON-RPC error/content envelope. JSON-RPC
method-not-found applies only to an unknown protocol method or tool; it is not the mapping for a
domain object that was not found. Use the operation-specific adapter tests for exact mappings.

## Testing Parity

Run the generated-surface check and the real focused mapping tests:

```bash
npm run docs:surface:check
npx vitest run tests/architecture/cli-mcp-surface.spec.ts \
  tests/mcp-workspace-config-parity.spec.ts \
  tests/mcp-published-merge-application.spec.ts
```

Or manually verify:

```bash
# CLI
lexrunner weave discover --json > /tmp/cli-discover.json

# MCP (via test script)
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"discover","arguments":{}}}' | node mcp-server.mjs 2>/dev/null | jq -r '.result.content[0].text' > /tmp/mcp-discover.json

# Inspect the transport-specific top-level structures; this is not a byte-equality assertion.
jq 'keys' /tmp/cli-discover.json
jq 'keys' /tmp/mcp-discover.json
```

## Version History

| Version | Date       | Changes                       |
| ------- | ---------- | ----------------------------- |
| 1.0.0   | 2025-12-02 | Initial parity audit (AX-004) |

## References

- [CLI Reference](./cli.md)
- [MCP Migration Guide](./MCP-MIGRATION.md)
- [AX Contract](../AX-CONTRACT.v0.1.yaml)
