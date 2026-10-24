# LexRunner MCP server

LexRunner publishes a stdio Model Context Protocol (MCP) server for workspace diagnosis, plan
creation, gate execution, merge orchestration, and the bounded Attempt lifecycle. The server uses
the same application services as the CLI; its tool names are the exact names returned by
`tools/list`.

Start with [installation and interface choices](docs/first-use-compatibility.md). Input schemas
and descriptions come from `tools/list`; do not infer an MCP schema from a similarly named CLI
command.

## Authority and mutation boundary

LexRunner guidance, plans, diagnostics, routing receipts, and observed status are evidence. They do
not independently authorize execution or merge.

`ALLOW_MUTATIONS=false` blocks protected mutations such as a non-dry-run merge. It does **not**
turn the server into a read-only sandbox: plan creation can write artifacts, local initialization
can create a profile overlay, and gates can execute commands from a plan. Review each tool's
declared effect and bind calls to the intended repository and plan artifact.

For tools that consult it, `ALLOW_MUTATIONS=true` satisfies only the server-side mutation gate.
Request-specific authorization or confirmation fields still apply where declared, and all other
policy, receipt, containment, and repository protections remain in force.

## Configure and start

LexRunner requires Node.js 24 or newer. A typical MCP client entry is:

```json
{
  "mcpServers": {
    "lexrunner": {
      "command": "node",
      "args": ["/absolute/path/to/node_modules/@smartergpt/lexrunner/mcp-server.mjs"],
      "env": {
        "LEX_PR_PROFILE_DIR": "/absolute/path/to/repository/.smartergpt.local",
        "ALLOW_MUTATIONS": "false"
      }
    }
  }
}
```

The server diagnoses its startup working directory. Start it in the repository you intend to use.
`LEX_PR_PROFILE_DIR` selects a profile root; it is not a per-call repository override. When a tool
supports `repoRoot`, provide it explicitly for repository-bound work.

Run the checked-out server with either command:

```sh
npm run mcp
node mcp-server.mjs
```

See [MCP-CONFIG.md](MCP-CONFIG.md) for client-specific setup.

### GitHub authentication

GitHub-mode `plan.create` requires `githubToken`, `GITHUB_TOKEN`, or `GH_TOKEN`, including for a
public repository. Other GitHub-backed tools require authentication for private repositories and
may otherwise encounter the unauthenticated API rate limit. Forward a token through the client
environment or a credential provider; do not commit a literal token.

## Recommended workflow

1. Call `doctor` and `workflow.guide` with phase `initial`. The guide reports observed doctor
   readiness and remains explicitly advisory and non-authorizing.
2. If configuration is absent, call `local.init`, then repeat `doctor`. Use `config.show` to inspect
   resolved values and provenance. Profile-root configuration is canonical; `runner/` is reserved
   for generated artifacts, with a compatibility read fallback for older overlays.
3. Call `plan.create` with explicit `repoRoot`, `profileDir`, and `outDir` when defaults would be
   ambiguous. Retain the returned `files.plan` path and routing receipt.
4. Pass that exact `planFile` to `status`, `merge-order`, gate operations, and `merge.apply`. These
   consumers validate the same strict Plan contract.
5. Use `gates.run` only for short synchronous work. Use `gates.start` for long or reconnectable
   work, and retain the returned operation path and hash for `gates.status` or `gates.cancel`.
6. Inspect merge order and gate evidence before calling `merge.apply`. Keep `dryRun` enabled until
   the exact candidate is eligible. A non-dry-run merge requires `ALLOW_MUTATIONS=true` and does
   not manufacture authority or eligibility.

Multi-repository `plan.create` output is an artifact-only synthesis. LexRunner refuses to execute
or apply that plan as though multiple repositories were one worktree.

For long-running gate idempotency, cooperative cancellation, reconnects, and unknown-state
recovery, see [durable gate operations](docs/gates.md#long-running-operations-and-reconnects).

## Published tool inventory

<!-- BEGIN GENERATED MCP TOOL INVENTORY -->

Published inventory: **33 canonical tools** and **4 deprecated tools**. This block is generated from `docs/architecture/cli-mcp-surface.json`, whose MCP inventory is checked against the published `tools/list` surface in `mcp-server.mjs`.

### Canonical tools

| MCP tool                                   | CLI counterpart                           | Owner or intentional exception                                                                        |
| ------------------------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `accept_attempt`                           | `lexrunner attempt acceptance apply`      | `AgentWorkAttemptAcceptanceService`                                                                   |
| `attach_attempt_worker`                    | `lexrunner attempt worker attach`         | `AgentWorkWorkerSessionService`                                                                       |
| `cleanup_native_wsl_projection`            | `lexrunner attempt projection cleanup`    | `NativeWslProjectionLifecycleHandlers`                                                                |
| `config.show`                              | `lexrunner config show`                   | `ConfigurationQueryService`                                                                           |
| `discover`                                 | `lexrunner weave discover`                | `DiscoveryQueryService`                                                                               |
| `doctor`                                   | `lexrunner workspace doctor`              | `WorkspaceDiagnosticsService`                                                                         |
| `end_attempt_worker`                       | `lexrunner attempt worker end`            | `AgentWorkWorkerSessionService`                                                                       |
| `gates.run`                                | `lexrunner gate run`                      | `GateExecutionService`                                                                                |
| `gates.start`                              | `lexrunner gate start`                    | `GateOperationService`                                                                                |
| `gates.status`                             | `lexrunner gate status`                   | `GateOperationService`                                                                                |
| `gates.cancel`                             | `lexrunner gate cancel`                   | `GateOperationService`                                                                                |
| `get_attempt_acceptance`                   | `lexrunner attempt acceptance status`     | `AgentWorkAttemptAcceptanceService`                                                                   |
| `get_attempt_receipt`                      | `lexrunner attempt receipt status`        | `AgentWorkAttemptReceiptService`                                                                      |
| `get_attempt_status`                       | `lexrunner attempt status`                | `AgentWorkLifecycleService`                                                                           |
| `get_attempt_verification`                 | `lexrunner attempt verification status`   | `AgentWorkAttemptVerificationService`                                                                 |
| `get_attempt_worker`                       | `lexrunner attempt worker status`         | `AgentWorkWorkerSessionService`                                                                       |
| `get_native_wsl_projection_status`         | `lexrunner attempt projection status`     | `NativeWslProjectionLifecycleHandlers`                                                                |
| `heartbeat_attempt_worker`                 | `lexrunner attempt worker heartbeat`      | `AgentWorkWorkerSessionService`                                                                       |
| `local.init`                               | `lexrunner workspace init`                | `WorkspaceInitializationService`                                                                      |
| `merge-order`                              | `lexrunner weave merge-order`             | `MergeOrderQueryService`                                                                              |
| `merge.apply`                              | `lexrunner weave apply`                   | `MergeApplicationService`                                                                             |
| `plan.create`                              | `lexrunner weave plan`                    | `PlanCreationService`                                                                                 |
| `preflight_attempt_containment`            | `lexrunner attempt preflight`             | `AgentWorkContainmentCapabilityService`                                                               |
| `prepare_native_wsl_projection`            | `lexrunner attempt projection prepare`    | `NativeWslProjectionLifecycleHandlers`                                                                |
| `materialize_attempt_input`                | `lexrunner attempt materialize`           | `materializeAttemptInput`                                                                             |
| `prepare_attempt`                          | `lexrunner attempt prepare`               | `AgentWorkLifecycleService`                                                                           |
| `profile.resolve`                          | `lexrunner config show`                   | `ConfigurationQueryService`                                                                           |
| `start_attempt`                            | `lexrunner attempt start`                 | `AgentWorkLifecycleService`                                                                           |
| `status`                                   | `lexrunner weave status`                  | `IntegrationStatusQueryService`                                                                       |
| `submit_attempt_receipt`                   | `lexrunner attempt receipt submit`        | `AgentWorkAttemptReceiptService`                                                                      |
| `inspect_native_wsl_projection_quarantine` | `lexrunner attempt projection quarantine` | `NativeWslProjectionLifecycleHandlers`                                                                |
| `verify_attempt`                           | `lexrunner attempt verification run`      | `AgentWorkAttemptVerificationService`                                                                 |
| `workflow.guide`                           | —                                         | Intentional exception: agent-only workflow guidance; humans use CLI help and checked-in documentation |

### Deprecated tools

| MCP tool                  | Replacement                                                                                     | Removal |
| ------------------------- | ----------------------------------------------------------------------------------------------- | ------- |
| `lexrunner.getStatus`     | status for integration; get_attempt_status for ADR-010 orchestration                            | 3.0.0   |
| `lexrunner.listArtifacts` | bounded artifact references from the owning plan.create, gates.run, or merge.apply operation    | 3.0.0   |
| `lexrunner.startRun`      | plan.create, gates.run, or merge.apply for integration; start_attempt for ADR-010 orchestration | 3.0.0   |
| `health`                  | doctor                                                                                          | 3.0.0   |

<!-- END GENERATED MCP TOOL INVENTORY -->

The inventory above is generated. The canonical surface matrix is checked against the live
published `tools/list`, and `npm run docs:surface:check` verifies this README has not drifted from
that matrix. Deprecated tools remain compatibility surfaces only until their declared removal
release.

## Attempt and native WSL projection tools

The Attempt tools expose bounded ADR-010 lifecycle operations. They preserve distinctions among
preflight capability evidence, prepared inputs, worker sessions, verification, receipts, and
acceptance. None of those observations alone grants authority for a later phase.

Native Windows-to-WSL projection tools share one lifecycle with the corresponding CLI operations:
status and quarantine inspection are read-only; prepare and cleanup require both the tool's
explicit mutation authorization and the server mutation gate. Returned paths are privacy-bounded,
and a `selectionDigest` identifies the exact prepared projection. See the
[native projection workflow](docs/workflows/native-wsl-projection.md).

## Protocol and implementation

The server uses stdio JSON-RPC 2.0 with one request or response per line. `mcp-server.mjs` is the
published protocol adapter; domain behavior lives in the TypeScript application services used by
both MCP and CLI surfaces. SIGINT and SIGTERM trigger graceful shutdown.

Protocol errors use standard JSON-RPC codes where applicable. When a tool exposes a structured
application error or remediation field, clients should inspect that field rather than matching
prose.
