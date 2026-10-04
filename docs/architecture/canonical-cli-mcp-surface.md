# Canonical CLI and MCP surface

Status: **Normative surface decision for LexRunner v1.1**

The machine-readable source of truth is
[`cli-mcp-surface.json`](./cli-mcp-surface.json). It is checked against the live
Commander tree and the published MCP `tools/list` response. This document
explains the decisions behind that inventory.

## Dispositions

The audited registration set contains 126 CLI entries and 29 published MCP
tools. Exact disposition counts are generated into [`../AX.md`](../AX.md).

| Surface | Canonical | Compatibility | Deprecated | Internal only | Remove |
| ------- | --------: | ------------: | ---------: | ------------: | -----: |
| CLI     |        87 |             9 |         15 |            15 |      0 |
| MCP     |        25 |             0 |          4 |             0 |      0 |

- **canonical** is supported vocabulary. Machine-facing canonical operations
  must resolve to a contract profile in the JSON matrix.
- **compatibility** is retained because it has distinct existing callers, but
  it has an explicit canonical replacement.
- **deprecated** is a legacy alias that should warn and be removed after its
  migration window.
- **internal-only** is developer/governance machinery, not a public parity
  promise.
- **remove** is reserved for a registration that should disappear without a
  replacement. No current entry received that disposition.

CLI warning and removal behavior is centralized in the
[CLI alias migration policy](cli-alias-policy.md). Compatibility and deprecation guidance is
always written to stderr, preserving canonical JSON stdout.

Implementation-time test selection and release-wide verification are separated by the
[implementation gate contract](implementation-gates.md).

Full CLI/MCP symmetry is not the goal. Semantic parity is required for approved
machine operations. Interactive review, ideation, local administration, and
terminal navigation remain deliberately CLI-only. `workflow.guide` remains
deliberately MCP-only because humans have CLI help and checked-in documentation.

## Canonical nouns and ownership

`WorkItem`, `Run`, and `Attempt` are ADR-010 durable orchestration nouns.
`CoordinationStore` and the workspace lifecycle stores are their operational
authority. Current public orchestration is rooted at `attempt`: preparation may
create/bind the WorkItem and Run, but no separate Work or Run adapter is
approved yet.

`attempt preflight` and MCP `preflight_attempt_containment` run before that durable lifecycle.
They share `AgentWorkContainmentCapabilityService`, inspect only the declared runtime and
repository/worktree roots, and never open `CoordinationStore`, invoke Git, or acquire mutation
authority.

When preflight reports `broker_required`, CLI `attempt projection
prepare|status|cleanup|quarantine` and the four native-WSL projection MCP tools call
`NativeWslProjectionLifecycleHandlers`. Status and quarantine inspection are read-only. Prepare
and cleanup require explicit mutation authority, and all results are path-private bounded
projections. A successful selection digest is resolved into the immutable Attempt execution
mapping; the adapter never accepts caller-supplied projection evidence as launch authority.

The frozen `RunStore` is different. It records stateless integration runs,
steps, receipts, and artifacts; it cannot authorize or advance ADR-010 state.
The three published `lexrunner.*` MCP tools are deprecated bounded IntegrationRun
record adapters. They are scheduled for removal in `3.0.0`; the checked-in
[migration decision](integration-run-compatibility.md) names the owning integration and Attempt
replacements rather than inventing another generic Run surface.

ADR-007 `TaskSnapshot_v1` and `TaskReceipt_v1` remain supported contracts for
bounded repair procedures. There is no currently registered `task` CLI command
or MCP tool. The parity project will not resurrect a generic Task lifecycle or
silently alias Task to Work/Run/Attempt.

`Plan`, `Gate`, and `Weave` belong to the stateless integration core. Their
services consume frozen inputs and must not read CoordinationStore authority.
Overlapping MCP integration operations resolve one immutable plan artifact by
explicit reference, repository-root `plan.json`, then the legacy profile runner
fallback. Their path-independent canonical identity lets callers prove that
status, ordering, gate execution, and merge preview consumed the same content
without introducing mutable active-plan state.

## Adapter rule

CLI and MCP adapters do transport work only:

1. validate and bound input;
2. call one owning application service;
3. project that service result into the selected transport; and
4. map failure to the operation's declared bounded error contract.

No adapter implements a lifecycle transition. The existing Attempt adapters
already follow this rule. Several inline merge-weave/workspace MCP handlers do
not yet share a service with their CLI counterpart; the matrix records the
intended owner so follow-up work can be independently tested.

## Output contracts

The JSON matrix defines three profiles:

- `agent-work-handler-v1` is the current bounded JSON-safe result used by the
  Attempt CLI and MCP handlers. Canonical bodies stay in durable storage.
- `bounded-ax-v1` is the target for all other canonical machine operations.
  Large collections and logs use bounded summaries plus artifact references;
  failures use stable AXError codes, bounded context, and recovery actions.
- `human-local-v1` covers explicitly interactive or local-only CLI operations.
  These are not MCP parity gaps.

A canonical designation does not pretend that every legacy implementation is
already conformant. It states the target contract. The focused child issues
listed in the matrix own implementation gaps.

## Audit findings

- Canonical `gate run` and MCP `gates.run` share `GateExecutionService` and its
  bounded summary. `gate execute` and top-level `execute` remain migration aliases.
  CLI `--repo-root`, `--only-item`, and `--only-gate` map to MCP `repoRoot`,
  `onlyItem`, and `onlyGate`. Invocation-local working directories are validated
  against the physical candidate repository without rewriting frozen plan inputs.
  Item dependencies require completed passing gates; selected subsets retain their
  evidence scope and cannot qualify omitted required work.
- Discovery, plan creation, integration status, and merge-order pairs now share bounded
  transport-neutral query services. Human output and legacy alias JSON remain adapter projections.
- Canonical `weave apply`, MCP `merge.apply`, and compatibility `merge` share the persisted
  `MergeApplicationService`; previews cannot enter its mutation runtime, and execution requires
  explicit authority.
- Workspace initialization, diagnostics, configuration queries, and profile resolution now share
  bounded application services across CLI and MCP. Interactive initialization remains CLI-only.
- The old AX page lists MCP tools such as `plan_validate`, `fanout_analyze`, and
  ADR-007 task tools that are not published by `mcp-server.mjs`.
- `health` delegates to `doctor`, emits a replacement warning, and is scheduled for removal in
  `3.0.0`.
- Top-level `discover`, `plan`, `status`, `report`, `merge-order`, `execute`,
  `doctor`, and `init` remain deprecated aliases for category/action commands.
- `orchestrate:*` commands are legacy aliases; `senior-dev`, budget,
  counter-example, and fanout-monitor commands are internal-only.

The full per-registration disposition, parity mapping, contract profile, and
implementation issue is deliberately kept in the JSON matrix so CI can detect
drift.

## Focused implementation issues

| Issue | Boundary                                                        |
| ----- | --------------------------------------------------------------- |
| #781  | Shared merge application service and authority                  |
| #782  | Shared workspace/config services and retirement of MCP `health` |
| #783  | Bounded IntegrationRun compatibility adapters                   |
| #784  | CLI alias warnings and removal windows                          |
| #822  | Touched/adjacent implementation gate selection                  |

These focused slices are merged. Documentation reconciliation is owned by #772;
release-wide evidence and the final version remain owned by #795.
