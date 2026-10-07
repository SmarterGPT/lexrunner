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
and sends no answer. Omitted or null options become portable free text. The
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
cleanup. This source slice has no answer-send method. A completed receipt for a
captured worker question is rejected until authenticated human admission and
fenced delivery are implemented; persisted completed worker-question receipts
are invalid state. A generic replacement cannot bypass this guard. Declined,
expired and failed receipts remain held as before. Explicit task cancellation
remains a distinct supervisor action.

UI and authentication are host boundaries. Codex UI, a separate inbox or another
app may later consume the portable question without changing its core lifecycle.
An agent-facing CLI/MCP argument, actor ID, local OS username, digest match or
prompt cleanup is not a qualified human-answer channel. A future host must bind
its authenticated answer to the exact persisted question, durably claim one send,
reconcile uncertain outcomes across takeover, and separately qualify dependent
action refusal. Interruption clears native request IDs; an old prompt cannot be
answered after restart by replaying its response or assignment.

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
