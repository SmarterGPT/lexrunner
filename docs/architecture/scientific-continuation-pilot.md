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
   authority, and defaults to a decision view. Findings, conclusions, conditions,
   limitations, open choices, optional next experiments and every probe outcome
   remain verbatim. Experiment design, commands/timings, raw output, predecessor
   history and repeated framework explanations stay in the source. Larger views
   fail explicitly; findings are never selected or truncated to fit a budget.
   Exact-digest source hydration and an explicit evidence view remain available.
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
   The next source subdependency now captures worker questions into the same
   durable hold. Its core contract is app- and frontend-independent; the first
   protocol adapter is Codex. See [worker question persistence](worker-human-input.md)
   for commit-before-display, replay and delivery limitations. Captured questions
   cannot receive completed receipts until qualified admission/delivery exists.
   The next subdependency implements [signed host answer admission and single-send
   persistence](worker-human-answers.md), with an owned Codex response adapter.
   Its signature verifies a configured host's assertion; a real human channel,
   protected signing root, consumption reconciliation and action containment still
   need host qualification. Local writes never release a human hold. A bounded
   delivery-observation journal now retains exact claim-bound cleanup/output/
   uncertainty evidence and survives coordinator reopen. Its compact read-back
   explicitly refuses consumption qualification and resend authority. It supplies
   reconciliation data, not automatic hold release.
   A source-only Codex content matcher now compares the exact native item ID and
   answer-result bytes against the saved admission and records a matching output
   through the same journal. Content matching does not authenticate the evidence
   source, qualify consumption or grant dependent-action admission. A retained
   source composition now reads a pinned, sealed output envelope through the
   existing independent evidence reader before recording its compact locator.
   This supplies recoverable source bytes and fresh integrity checking; origin,
   human admission and worker action qualification remain separate dependencies.
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

## Collaboration and waiting

The implementation agent chooses methods, proposes alternatives and retains useful
failed experiments. Routine reversible work does not need a new approval ceremony.
Human holds preserve unanswered decisions, not a score for agent behavior. Compact
records exist for recovery and evidence reuse rather than transcript collection.

Every proposed activity should remain tied to the original request. While a needed
answer is pending, distinguish work needed under every plausible answer from work
whose value depends on that answer. Do not implement multiple speculative answers.
A short investigation may be useful if it can improve the decision; state its
question, expected useful finding and stopping condition, then stop when additional
work depends on the human. Failure is useful when its retained lesson changes the
next attempt. These are collaboration guidelines, not a mandatory experiment quota.

The current controller still conservatively holds the entire Run. It does not
yet classify or dispatch independent work during that hold. Selective continuation
requires explicit request/decision dependencies, bounded experiment admission and
invalidation when an answer changes direction; a claim of independence is not
execution authority. Independent inspection in the hosting collaboration remains
possible within the existing task and permission scope.

## Presentation recovery (source slice)

Question lifetime, presentation lifetime and execution permission are separate.
The portable human service now retains up to sixteen display claims per captured
question in the existing fenced Run state. A claim commits the exact challenge and
presentation before display. Replay, including after a lost storage acknowledgement,
is inspection only: newlyClaimed:false must never display again. A claim is not
proof that the host rendered the form. Capacity refuses further claims without
evicting questions or history.

Skip/decline, cancellation, expiry and transport failure close only the presentation.
They never create an answer or release the hold. The agreed timeout policy is to
pause as needed: retain the unanswered question and stop answer-dependent work
until explicit human return. Cancelling the task itself requires a separate
instruction. The whole-Run hold remains conservative; selective independent work
is not enabled by a display timeout. A protected host can explicitly
recover the same still-applicable question by naming the previous presentation,
using fresh presentation/challenge identities and rechecking context, workspace and
worker binding. This records explicit recovery intent; caller fields alone do not
authenticate that a human requested it. An unobserved expired display is retired
atomically with the next claim. An active display cannot be replaced. Closed and
superseded presentation replies cannot be admitted, and legacy challenge issuance
cannot bypass a managed presentation. Signed host answer admission atomically
marks the current display answered while retaining the worker hold.

Core APIs import no Codex UI, passkey or OIDC implementation. Configured host
attestation remains required for this source answer path; passkey/OIDC are optional
host trust implementations, not required ordinary user ceremonies. Protected host
integration and signer protection remain separate qualification work.

The live Codex desktop diagnostic established that an expired original form can
remain visible/selectable after its transport request has ended. This source slice
does not control Codex's renderer or qualify visible cleanup. Hosts must show clear
expired/pending status and recover with a fresh display; a stale option click cannot
answer the durable question. No automatic recovery prompt is enabled here.

Controlled memory/SQLite tests compose presentation outcomes, coordinator reopen,
host admission and local write with the real supervisor. Downstream observation,
launch, receipt, verification, acceptance and transition ports remain uninvoked
while held. This is controller-fence evidence, not live worker suspension, OS
containment, successful hold release or production delivery qualification. The
next slice is the native host adapter and consumption/action-boundary qualification.

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
node scripts/exploration-trail.mjs resume trail.json --decision --expect-digest sha256:TRAIL_DIGEST
node --import tsx scripts/compose-continuation.mjs packet.json sha256:PACKET_HASH trail.json sha256:TRAIL_DIGEST --evidence-view
node scripts/exploration-trail.mjs resume trail.json --expect-digest sha256:TRAIL_DIGEST
```

Both hashes must come from the explicitly selected inputs. The composer reads no
predecessor automatically, launches no worker and treats continuity as supplied
data. Digest consistency does not establish source authentication, relevance,
freshness or permission. The 64 KiB input, 32 KiB delivery and 16 KiB compact-trail
bounds are pilot limits, not claims about optimal model token budgets.

### Decision view contract

The default `exploration-decision-resumption-pilot/v1` projection keeps the
question, attempt, capture time, conditions, every observation, interpretation,
limitation, open question and suggested experiment. It keeps each probe's source
pointer, exact exit code (including null), termination and truncation flags.
It omits premise, experiment, predecessor reference, detailed commands/cwd/timing,
output counts and output excerpts. `detailsOmitted:true` and the exact source
location/digest identify the available full record. This is a fixed projection;
it performs no relevance inference, prose summarization or finding selection.
Source records stay unchanged. Interpretations remain supplied conclusions,
and incomplete/truncated evidence remains visible rather than being called success.

The legacy compact evidence view remains available through `--evidence-view`
or `compose({view:"evidence", ...})`; full `resume` hydrates the verified source.
Neither view establishes freshness or authenticates the source. The short default
notice states the current delivery requirement and keeps suggestions optional.
The full assignment remains unchanged, including scope, authority and criteria.
Selecting details requires the host/agent's judgment; the projection does not
promise that omitted experimental detail is irrelevant to every next decision.
Byte savings measure presentation size, not token counts or model decision quality.

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
