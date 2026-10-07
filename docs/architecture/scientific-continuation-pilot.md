# Scientific continuation pilot

This source pilot adds a durable human hold to ADR-010 supervision and composes
an existing assignment with explicitly selected compact exploration evidence.
It does not replace the frozen integration runner, create another Goal lifecycle,
or enable public headless execution. The existing Bridge release goal remains
outside this pilot.

## Boundaries and dependencies

1. **Durable decisions (this slice):** `AgentWorkHumanActionService` commits the
   full request and event through the existing fenced `CoordinationStore` before
   the host presents a question. State lives in Run metadata. The supervisor
   observes live workers before advancing siblings, blocks launch, receipt,
   verification and acceptance while held, and rechecks dispatch admission after
   adapter negotiation. Explicit cancellation remains available.
2. **Compact continuation (this slice):** `scripts/compose-continuation.mjs`
   validates the exact assignment and selected trail digests, preserves scope and
   authority, and reuses `exploration-trail.mjs` to omit raw output only. Findings,
   failures, interpretation, conditions, limitations, open questions and probe
   metadata remain visible. Larger views fail explicitly; nothing is silently
   removed to fit a budget. Source artifacts provide full hydration.
3. **Human-channel and worker qualification (next dependency):** connect persisted
   requests and receipts to an authenticated host human-response channel; qualify
   event delivery, actual interruption and enforcement at the worker's action
   boundary. The current owned Codex connection is still a one-send development
   transport. Do not weaken its scope, replay or isolation guards for this pilot.
   The first subdependency now exposes a bounded, exact-turn interruption and
   event-driven terminal wait on that source transport. A stop acknowledgement,
   cleared question and observed terminal event remain distinct. Controlled pipe
   tests and an idle native probe qualify only their stated boundaries; authenticated
   human admission and live worker/action-boundary qualification remain outstanding.
4. **Bounded science execution:** use existing WorkItems, immutable packets,
   Attempts, retry deltas and receipts to dispatch one next experiment selected by
   the agent. A changed premise, faithful replication or useful negative result
   can move the inquiry forward. No experiment quota or mandatory science phase
   applies to a direct fix. Preserve useful evidence while its inputs and tested
   conditions remain unchanged; investigate only the failing boundary.
5. **Delivery qualification:** record why a candidate was selected, then produce
   the smallest implementation meeting the original criteria. Reuse the existing
   deterministic gates and independent review against an exact base/head. A
   working experiment is neither acceptance nor permission to release.

The agent interprets evidence and proposes experiments. Deterministic services
persist and enforce bindings; they do not certify that an explanation is true or
that the first working candidate is optimal.

## Human hold semantics

Requests bind the Run, Attempt, workspace lease and worker session, the original
Run revision, workspace revision and observed head. Settlement checks the exact
request/receipt binding, current Run revision and unchanged non-hold Run context,
then independently observes the workspace. Human-state updates alone do not
invalidate another pending question. Expiry, decline and failure remain blocked.
Silence, lease takeover, restart and worker completion cannot approve a request.

An explicit replacement request can supersede a stale or declined question
atomically without an unheld interval. Old answers cannot release the replacement.
Requests and receipts remain inspectable in the coordination event/state history.
The pilot bounds retained requests to 128 and refuses further additions at that
limit; it never evicts a pending decision. The supervisor returns at most eight
240-character summaries plus the total count; retrieve full requests from stored
state by request ID. Summary truncation is explicit.

Only a host-admitted `completed` receipt releases its hold. `actor_id`, text and
matching hashes are not authentication. This source API deliberately has no MCP
or public CLI receipt-admission command. It cannot grant new packet authority.
Head-changing actions such as commit signing need a separately qualified
admission boundary and are rejected by this pilot.

If a worker still reports the same answered request, supervision requires
reconciliation rather than inventing another question or claiming that a receipt
resumed the worker. Providers should supply distinct full request IDs; the generic
fallback can capture one observed interruption but cannot infer the content of a
subsequent question.

Explicit cancellation runs before worker-question reconciliation in a dedicated
pass. Only the selected cancellations advance; every sibling remains deferred
until a subsequent reconciliation. A stale or completed question cannot suppress
the stop path, and cancellation cannot approve the original human decision.

This is a **controller progress hold**, not proof that a live worker stopped.
Already admitted work may be in flight when a question arrives. Production hosts
must suspend/cancel it through a qualified adapter and enforce the hold at its
action boundary. Workspace observation and CAS are separate boundaries; hosts
must retain lifecycle exclusion for target-dependent actions. The service neither
claims native containment nor acquires a game/runtime lock.

## Source use

Run with the owning repository as cwd:

```powershell
node --import tsx scripts/compose-continuation.mjs packet.json sha256:PACKET_HASH trail.json sha256:TRAIL_DIGEST
node scripts/exploration-trail.mjs resume trail.json --expect-digest sha256:TRAIL_DIGEST
```

Both hashes must come from the explicitly selected inputs. The composer reads no
predecessor automatically, launches no worker and treats continuity as supplied
data. Digest consistency does not establish source authentication, relevance,
freshness or permission. The 64 KiB input, 32 KiB delivery and 16 KiB compact-trail
bounds are pilot limits, not claims about optimal model token budgets.

## Validation

Focused tests cover memory/SQLite parity, durable request-before-presentation,
restart read-back, fencing/racing mutations, stale and cross-attempt answers,
expiry/decline/failure, replacement, compact failure/comparison retention, exact
hydration and malformed/overlarge inputs. The existing controlled supervisor
fixture additionally exercises a human hold across supervisor replacement and a
later worker completion before normal verification/acceptance.

Those controlled tests do not establish genuine human identity, live Codex
steering, reboot recovery, native Apple Silicon behavior or production readiness.
Qualification in step 3 must demonstrate a real pending human interaction surviving
restart, zero duplicate dispatch, acknowledgement by the worker, and refusal of
dependent actions before enabling that execution path.
