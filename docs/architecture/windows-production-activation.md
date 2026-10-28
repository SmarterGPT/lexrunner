# Windows production activation path

This is an implementation checklist for #890/#894/#997, not an activation or
capability claim. On 2026-10-28, Guff selected the optional protected-coordinator
Windows service profile in [ADR-011](../adr/ADR-011-native-host-workspace-boundary.md).
The delivery target is a protected, admitted real `NodeGitWorktreeBroker`
create → observe → preserve/remove flow on a disposable Windows repository,
followed by interruption and restart reconciliation and public Attempt/CLI/MCP
parity. Passing helper unit tests alone does not satisfy this target.

## Current installation status

The prerequisite is a qualified protected coordinator service, its independent
admission and durable store, the native Windows WorkspaceBoundary helper, and
their production selection/broker integration. LexRunner 2.5.0 has no supported
installation or configuration procedure that enables this path. Public preflight
reports an unavailable backend; it does not inspect helper installation. The
production resolver still reports `helper_missing`. The previously installed
qualification-only MSI has no active selection and does not implement the selected
service profile. Supplying a hash/path cannot activate it. `npm install` installs
LexRunner only; it never downloads, installs, starts, repairs, updates, or selects
the optional service/helper. Use the
[external-worker workflow](../workflows/external-workers.md) while these gates remain
open; WSL projection requires separate explicit authorization and configuration.

## Remaining gates

1. **Protected coordinator and admission — selected architecture, not implemented.**
   A separately installed demand-start SCM service under a dedicated
   non-administrator identity must host the trusted Node coordinator, protected
   enrollment/policy and durable Attempt/operation store. CLI/MCP are untrusted
   local clients. Authenticate the enrolled client SID, then independently derive
   a bounded `WindowsAttemptAdmission_v1` from protected policy, repository and
   packet/base identity, allowed operation, supported volume and current fence.
   Persist admission and operation intent before any Git/helper/worker effect;
   refuse missing enrollment, changed-input replay, stale fence, or unknown effect.
   An enrolled same-user process cannot be distinguished from the intended agent
   by pipe ACL, PID or image; per-agent intent requires a separate grant issuer.
   Review the exact service/IPC/store contract and hostile controls before
   giving the service any effectful verb. No service is installed or selected.
2. **Portable broker bootstrap — implemented, native qualification pending.**
   `NodeGitWorktreeBroker.open` resolves the actual host boundary, acquires repository
   and allocation roots, opens `.git`, asserts their identities and awaits release
   before returning. The read-only bootstrap lease has distinct discovery lineage,
   not worker execution authority. Subsequent operations acquire fresh leases and
   compare observations. No public boundary override or caller-supplied identity is
   accepted by the factory. The legacy synchronous constructor remains for Linux
   callers. Agent-work adapters now await `openAgentWorkRuntime`; the existing
   synchronous exported factory remains compatible. The real Linux broker integration
   fixture uses async bootstrap; Windows still requires protected service/admission
   and the qualified adapter/launch below before this path can run against a
   production native boundary.
3. **Portable lease adapter — implemented, production composition pending.**
   `acquireOwnedWindowsWorkspaceLease` maps the complete lease method surface onto
   owned native scopes, including broker/native operation associations, exclusive
   file creation, process results, cancellation and unknown effects. See the
   [adapter contract](owned-windows-workspace-lease.md). Connect it through verified
   artifact selection and qualify all real broker-used options and operation sequences.
   Its supplied decision digest is association data, not production authority.
   A projected receipt is not durable delivery, and `not_requested` durability is
   not `committed`. A development composition with a synthetic ready resolver
   never qualifies the installed service or a public execution route.
4. **Workload budgets — v2 profile implemented, broker workload qualification pending.**
   Protocol 2.2.0 retains 128 requests, 30-second command budgets plus reply reserve,
   and an explicitly selected work window up to five minutes. Defaults are unchanged.
   See [v2 bounds and qualification](windows-boundary-budget-v2.md). A disposable
   ReFS actual-broker probe exercised 13 Git child calls across six short native
   sessions, each below the 128-request ceiling. It did not test service identity, creation or
   public Attempt execution. Qualify the complete service workload and interruption
   budget; do not silently shorten command budgets, reset deadlines or split
   custody. The previous signed v1 artifact does not qualify this version.
5. **Protected selection and runtime launch.** Select a reviewed signed optional
   application artifact and qualify the SCM image/configuration, service token,
   protected Node/native/Git loader graph, enrollment and active selection. Bind
   the actual helper image to one owned PID/Job and private pipes from creation
   through protocol close; retain and classify OS companion processes and loader
   mappings. The existing Azure signing run and inactive MSI prove bounded
   artifact/installation facts only. A service path, signature or matching helper
   hello does not establish protected launch or admission. A new concrete MSI
   installation and protected machine changes require separate approval.
6. **Service-owned creation and end-to-end outcomes.** Create an initially empty
   stage and final allocation parent outside the enrolled user's write authority
   on the same supported worktree volume before the first Git child. Hold exact
   identities through Git registration, native no-replace publication, repair,
   access handoff and recovery. Define a fixed Git image/token/cwd/argv/environment
   and per-command configuration. The actual broker executed an ambient
   `GIT_CONFIG_*` fsmonitor canary during disposable status inspections; it also
   ran three read-oriented Git commands before refusing fresh creation. Do not
   forward the request client's Git configuration into a service-token process.
   A disposable ReFS status probe also confirmed that the exact broker `git status`
   command can launch a repository-selected clean filter with a constructed
   environment and fixed hooks/fsmonitor overrides. An empty-tree attribute
   source suppressed worktree `.gitattributes` in that fixture, but a user-owned
   `.git/info/attributes` restored the filter. The development Git profile only
   closes ambient configuration inheritance; it is not safe for a service token.
   Keep privileged status and automatic removal closed until the Git metadata
   or execution-token boundary is independently qualified.
   Exercise create, exact retry/observe, dirty preservation and safe removal
   against disposable native Git repositories. Check isolation,
   marker/receipt provenance, bounded graceful deadlines and cleanup observations.
   Explicit native test composition now covers create/retry/observe and dirty
   preservation. The [native removal executor](windows-native-removal-executor.md)
   now implements the deliberate #997 transition with actual removal/recovery tests.
   Its explicit development composition does not connect production selection or
   establish complete public Attempt/CLI/MCP qualification.
7. **Recovery and public route.** Interrupt before/after admission, dispatch,
   creation, publication, access handoff, removal, acknowledgment and receipt
   delivery. Reconcile through service-owned durable state and the existing
   verifier without replaying an unknown mutation or inferring success from
   process exit. Bind public Attempt, CLI and MCP to the same protected service
   admission and lifecycle. A direct user-writable database, development helper,
   or WSL fallback cannot stand in for selected service authority.

## Activation condition

Only report native readiness after protected service selection and enrollment,
actual process/loader binding, fixed Git execution, service-owned worktree
lifecycle, durable recovery and public Attempt/CLI/MCP checks pass for the exact
qualified host, volume and profile. Keep unsupported hosts and options explicit.
No production enable flag, caller-selected path, synthetic capability or manually
supplied digest may stand in for these results. Record exact source/artifact
identities, commands, bounded output, effect receipts and known limitations;
retain failed observations. Until then, `helper_missing` and public native
containment refusal remain correct. No release is implied by an individual gate.
