# Windows production activation path

This is an implementation checklist for #890/#894, not an activation or capability
claim. The delivery target is the real NodeGitWorktreeBroker create → observe →
preserve/remove flow on a disposable Windows repository, followed by interruption
and restart reconciliation through the existing receipt verifier. Passing helper
unit tests alone does not satisfy this target.

## Remaining gates

1. **Portable broker bootstrap — implemented, native qualification pending.**
   `NodeGitWorktreeBroker.open` resolves the actual host boundary, acquires repository
   and allocation roots, opens `.git`, asserts their identities and awaits release
   before returning. The read-only bootstrap lease has distinct discovery lineage,
   not worker execution authority. Subsequent operations acquire fresh leases and
   compare observations. No public boundary override or caller-supplied identity is
   accepted by the factory. The legacy synchronous constructor remains for Linux
   callers. Agent-work adapters now await `openAgentWorkRuntime`; the existing
   synchronous exported factory remains compatible. The real Linux broker integration
   fixture uses async bootstrap; Windows still requires the qualified adapter/launch
   below before this path can run against a production native boundary.
2. **Portable lease adapter — implemented, production composition pending.**
   `acquireOwnedWindowsWorkspaceLease` maps the complete lease method surface onto
   owned native scopes, including broker/native operation associations, exclusive
   file creation, process results, cancellation and unknown effects. See the
   [adapter contract](owned-windows-workspace-lease.md). Connect it through verified
   artifact selection and qualify all real broker-used options and operation sequences.
   Its supplied decision digest is association data, not production authority.
   A projected receipt is not durable delivery, and `not_requested` durability is
   not `committed`.
3. **Workload budgets — v2 profile implemented, broker workload qualification pending.**
   Protocol 2.0.0 permits 128 requests, 30-second command budgets plus reply reserve,
   and an explicitly selected work window up to five minutes. Defaults are unchanged.
   See [v2 bounds and qualification](windows-boundary-budget-v2.md). Exercise actual
   broker command sequences before claiming fit; do not silently shorten command
   budgets, reset deadlines or split custody. The previous signed v1 artifact does
   not qualify this version.
4. **Runtime launch.** Select an approved signed artifact and qualify the protected
   launch path. The existing Azure signing run proves artifact qualification only;
   it does not establish an installed runtime selection or launch guarantee.
5. **End-to-end outcomes.** Exercise create, exact retry/observe, dirty preservation,
   and safe removal against disposable native Git repositories. Check isolation,
   marker/receipt provenance, bounded graceful deadlines and cleanup observations.
6. **Recovery.** Interrupt before/after dispatch, mutation, acknowledgment and receipt
   delivery. Reconcile through durable state and the existing verifier without replaying
   an unknown mutation or inferring success from process exit.

## Activation condition

Only report native readiness after the selected artifact, adapter, broker lifecycle
and recovery checks pass for the qualified host/profile. Keep unsupported hosts and
options explicit. No production enable flag or manually supplied digest may stand
in for these results. Record exact source/artifact identities, command evidence and
known limitations; retain failed observations. No release is implied by completing
an individual gate.
