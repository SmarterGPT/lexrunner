# Worker questions and human hosts

The scientific continuation pilot uses the existing ADR-010 human hold as its
portable lifecycle. `WorkerHumanInputCapture` records adapter-supplied worker,
connection, turn and request identities, normalized questions, host observation
time, and exact source JSON with its SHA-256. These are evidence bindings; none
authenticate a human or grant permission. The core service imports no Codex
protocol or frontend code. A second-runtime fixture exercises the same hold.

The first adapter is the owned Codex source transport. It accepts only bounded
`item/tool/requestUserInput` requests for the already observed owned turn. It
preserves question IDs, text, options and Other behavior, rejects duplicate IDs,
explicitly secret-marked questions, automatic resolution and unknown fields,
and accepts answers only through the separate protected-host delivery composition.
Omitted or null options become portable free text. The
projection is narrower than the experimental native schema; unsupported requests
fail closed rather than being silently rewritten. Secret authentication remains
a separate host flow. Text in a question is untrusted display content.

Installed Codex 0.145.0 exposes this native tool in Plan mode. The source transport
can explicitly select that experimental mode at connection creation with a
verified model; ordinary connections retain their existing behavior. Plan-mode
receipt dispatch is refused until canonical dispatch inputs bind the mode. Other
runtimes or hosts can produce portable questions without adopting Codex's
collaboration modes; mode selection is solely an adapter concern.

The queue keeps at most 128 request identities for the connection lifetime and
2 MiB of pending capture data. Each source JSON is at most 16 KiB, each portable
capture at most 32 KiB, with at most eight questions and 16 options per question.
Only one unanswered native request may be active. Identical pending frames are
deduplicated; conflicting bytes or reuse after cleanup fail closed. String and
numeric request IDs remain distinct. There is no eviction of pending questions.

`persistNextHumanInputCapture` generates the portable request and commits both
the hold and capture in one fenced Run-state transaction through
`AgentWorkHumanActionService`. The service checks the current workspace binding
and worker runtime/identity. It returns only the portable request ID after
storage confirms success; a host can retrieve its full question from stored
state. It never presents volatile question content. A lost storage acknowledgement
leaves the queue intact; exact retry confirms the existing commit without another
event. Failed or stale persistence also retains the capture. Uncommitted volatile
captures do not survive process death; they must not be presented or treated as
durable holds. Captures can be persisted after owned-child closure.

Native `serverRequest/resolved`, terminal observation and child exit do not remove
the portable hold. The [official Codex protocol](https://learn.chatgpt.com/docs/app-server#toolrequestuserinput)
emits the same resolution notification for an answer and for pending-request
cleanup. [Host-attested answers](worker-human-answers.md) now persist signed
admission and one send claim before an owned transport write. A completed receipt for a
captured worker question is rejected until the real human channel, worker
consumption and dependent-action admission are qualified; persisted completed worker-question receipts
are invalid state. A generic replacement cannot bypass this guard. Declined,
expired and failed receipts remain held as before. Explicit task cancellation
remains a distinct supervisor action.

UI and human authentication are host boundaries. Codex UI, a separate inbox or another
app may later consume the portable question without changing its core lifecycle.
An agent-facing CLI/MCP argument, actor ID, local OS username, digest match or
prompt cleanup is not a qualified human-answer channel. A future host must qualify
its authentication implementation and protect the signing root. The source core
binds the host attestation to the exact question and durably claims one send;
production hosts must reconcile uncertain consumption and separately qualify dependent
action refusal. Interruption clears native request IDs; an old prompt cannot be
answered after restart by replaying its response or assignment.

## Native form host source composition

The source-only NativeMcpHumanPresentationHost connects persisted portable
questions to a negotiated MCP form channel. The portable service remains independent
of MCP and UI code. The SDK bridge selects standard form or the declared OpenAI form
extension, binds the current transport object, and bounds each channel/admission wait
by the display deadline and cancellation signal. A process-local monotonic budget spans
both stages, so progress or a wall-clock rollback cannot extend the original wait.
Connection identity is rechecked at dispatch, including at the SDK bridge immediately
before its synchronous transport send. Core admission carries a protected process-local
veto into coordination CAS. Both source stores check cancellation, connection and the
shared deadline inside the mutation critical section immediately before a new write,
including after delayed freshness checks or delayed storage entry. This veto adds refusal,
never authentication or permission. It is not serialized as answer or integration data.
Once the synchronous atomic mutation begins, later cancellation cannot undo that commit;
a delayed acknowledgement remains a persistence observation, not a new admission.
The adapter also bounds the core-admission wait. A timeout/cancelled wait after admission
begins reports reconciliation required and never closes over a possibly committed answer;
the store veto prevents a still-pending mutation from committing after that boundary.
Custom stores must enforce the same CAS guard contract before this composition is qualified.
A changed connection or closed display makes its reply unusable. A nonconforming
port that ignores cancellation cannot trigger a later admission after its wait ends.

Only a newly committed display claim can invoke the channel. Lost claim acknowledgement
or replay requires reconciliation without redisplay. Safe generated fields preserve
authored question IDs as values. Closed options have no authored default; Other and
free text retain entered bytes, with original questions/options in display descriptions.
Ambiguous labels and unsupported replies fail closed. Bare approval, missing fields,
unknown fields and option mismatches cannot constitute an answer. A schema-valid
cached answer cannot be distinguished from fresh human input by schema alone.

The injected protected admission port must qualify human input and own identity,
trust and signer selection. It can decline to attest. The adapter verifies that the
returned attestation preserves the exact display challenge, entered answers and
observation time before the portable service verifies trust, current request context,
workspace and worker binding. This introduces no passkey ceremony or signer installation;
native UI, passkey/OIDC and other hosts remain deployment choices. Connection identity
and capability negotiation alone do not establish human identity or trustworthy input.

Skip, cancellation, expiry, malformed response and channel failure close only the
display. A lost admission acknowledgement retains uncertain durable state for inspection,
without a contradictory failure receipt or another prompt. Compact failure boundaries
identify persistence, projection, binding, transport, validation or host admission;
results do not echo answer bodies or raw exception details. No delivery, consumption
reconciliation or completed hold receipt is performed by this adapter.

Memory/SQLite tests cover direct and rejected input, explicit same-question recovery,
lost acknowledgements, connection replacement, caller mutation, concurrent calls,
cancelled signer and late reply. Actual in-memory SDK protocol messages qualify the
standard form route; controlled capabilities qualify OpenAI extension selection. These
are synthetic clients/signers, not a fresh desktop UX or protected host qualification.
Codex visible expiration/cleanup remains host-owned. No public worker-facing tool,
automatic retry, agent answer argument, production signer, endpoint or controller is
enabled. Live worker suspension, dependent-action containment and consumption remain
separate requirements before any hold can be released.

Focused tests qualify capture, typed ID fencing, lost-storage-ACK replay,
memory/SQLite retention, controller lease takeover, corrupted hold rejection and
real child pipes with a controlled Node fixture. A separate installed-Codex
0.145.0 probe with a deterministic local provider qualified native Plan-mode
prompt capture, lost-storage-ACK replay and SQLite retention through interruption.
Its workspace binding was simulated. Neither test runs inference, demonstrates
an authenticated host or proves native containment. The transport remains
one-dispatch, read-only development
code with fixed child argv and bounded output. No public endpoint, default
autonomous controller, installation, release or Bridge Goal change is enabled.
