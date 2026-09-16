# Windows owned session lifetime bridge

The portable WorkspaceBoundary returns a lease whose methods are called after acquisition.
The existing Windows owner accepts scoped work in a callback. acquireOwnedWindowsDirectorySession
bridges those lifetimes: it resolves acquisition when the owner enters work, then keeps that
callback open until close or the owner's existing terminal failure handling.

Callers use session.run for one awaited callback at a time. Acquired child scopes can be
retained for subsequent calls in that same session; native capability binding remains in
the existing owner. Concurrent run calls are rejected without queueing or discarding the
admitted work. close immediately stops admitting new run calls, drains the admitted callback,
and returns the original owner completion promise. It is idempotent. Callbacks must await
all scope operations; unawaited native work remains an owner error, not implicit background work.

A failed callback fails the owner lifetime even if close was requested concurrently. Early
acquisition failure returns the owner's report without manufacturing a lease. Cancellation
and timeout retain their original report and release uncertainty. run also settles when the
owner completes while caller code is still awaiting: this does not cancel arbitrary JavaScript
or reverse its effects. Already invoked caller code must cooperate with cancellation; later
scope calls are still checked by the existing owner. The wrapper checks an aborted signal
before admitting or invoking queued callback code. It adds no new process or cleanup policy.

identity is the acquisition observation, not current validity. completion is the original
terminal report; a failed or unacknowledged close does not become a successful release. No
receipt persistence, portable adapter, production readiness or trusted lease authority is
introduced here. Existing 15-operation, 30-second owner lifetime, command deadline and signed
artifact selection/launch limits remain. This bridge is the adapter's lifecycle prerequisite;
next map the portable methods and receipts while resolving those explicit bounds.

## Graceful work-deadline handling

The work deadline stops admission of native scope operations. The owner then allows
up to deadlineGraceMs for an already admitted operation's valid acknowledgment and
reverse-order release of held directories. The default is 1,000 ms; callers can
choose 0–5,000 ms. Zero preserves immediate shutdown. Grace is measured from the
original monotonic work deadline, not from whenever a delayed timer runs; late
response processing cannot restart or extend that budget.

A missed work deadline remains outcome:failed / reason:work_timeout, even if every
release is acknowledged. The report includes deadline.graceMs and graceExpired,
alongside the existing per-operation and release observations. An idle or blocked
JavaScript callback does not prevent releasing idle native handles. Already invoked
JavaScript is not forcibly cancelled; it must cooperate, and subsequent native calls
are refused. Grace drains native operations; it does not authorize new work.

An outstanding request is never overlapped with release. A valid late mutation
acknowledgment is retained as historical evidence before cleanup. Missing or invalid
replies, earlier operation timeouts, cancellation and I/O/protocol failures still
use the existing bounded pipe-close/termination path; unknown effects remain unknown.
The grace budget precedes existing close/kill budgets, so total completion can exceed
the work timeout. This is bounded cleanup, not guaranteed graceful application shutdown,
durable recovery or a new command cancellation protocol.

## Process observations during a session

Scopes and the session bridge expose `snapshotProcessAttempts()`: a synchronous,
immutable copy of the owner's bounded process-attempt history. It covers the whole
owner, including child-directory commands, and remains readable after close. Reading
it sends no protocol request and does not refresh identity, extend a deadline,
acknowledge a pending request, or establish authority.

An admitted attempt appears before its transport write with `acknowledged: false`.
That entry is intent; dispatch and effects are unconfirmed. A validated reply replaces
the owner's entry with its acknowledgment and observation time. Earlier snapshots
remain unchanged. Unanswered attempts receive their terminal observation time only
when the existing owner finalizes; an intermediate snapshot cannot establish a
terminal unknown outcome by itself.

A consumer may pair a result with the matching attempt through the existing process
receipt projector before closing the session. The projector's identity checks still
apply. This is in-memory observation access, not durable receipt delivery, a lifecycle
lease binding, or the completed portable WorkspaceBoundary adapter. Snapshots carry
no command arguments, environment values, or output bytes.

## Development root-role acquisition

`acquireOwnedWindowsRootSession` captures one common ancestor, opens requested
repository/allocation paths beneath it and reuses shared intermediate scopes. It
returns role-bound native scopes and the existing session, not a portable production
lease or capability decision. Roots must exist. Missing roots fail acquisition and
await owner cleanup; process exit is not promoted to acknowledged directory release.

The pure planner accepts 1–16 unique roles and ordinary drive-absolute Windows paths.
Cross-drive roots, UNC/device namespaces, relative paths and ambiguous components are
explicitly unsupported. The existing case-insensitive directory profile applies;
this planner does not independently qualify filesystem behavior. Native opens remain
the source of actual directory identity and filesystem support.

The protocol-v2 128-request session budget includes acquisition and reverse releases.
Planning charges one acquisition and one release for each unique held scope, then
requires room for the caller's declared work-request budget. That budget must include
any additional releases caused by work-created child scopes. It is a preflight count,
not a time guarantee or a reservation enforceable against other caller operations.
Existing owner checks remain authoritative; the returned remaining count is an initial
estimate, not live capacity. No implicit splitting across helpers or renewed deadlines.

Role lookup retains historical scopes after close; invoking their operations still
fails through the existing owner. Full portable method/receipt mapping, write-option
semantics, durable recovery and protected production launch remain pending.
