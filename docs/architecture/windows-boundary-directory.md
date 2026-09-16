# Native development directory leases

> Version note: the v1 limits/launch examples below are historical. Current protocol
> 2.0.0 requires a new helper; see [v2 session budgets](windows-boundary-budget-v2.md).

The explicit `--boundary-session 1.0.0` NativeAOT development peer supports one
initial directory chain per session, plus independently held children.
`directory_request` accepts `acquire` with a path,
then `assert` and `release` with the returned opaque lease token. Requests share
the status protocol's canonical digest, nonce/ID checks, replay rejection and
15-operation lifetime limit. Replies correlate the request and report the leaf's
file ID, volume serial, final path, filesystem, chain length and lease token.

Acquisition opens the drive root and every directory prefix, retaining each
SafeHandle with read/write sharing and without delete sharing. Reparse points and
non-directory targets are rejected. Every operation recaptures the held handles'
identities and paths before replying. Release closes the chain in reverse order;
an uncertain close cannot produce a successful release reply. EOF disposes a live
lease. A rejected operation terminates the helper; it does not return a typed
no-effect response. Missing acknowledgment requires reconciliation, never resend.

Native `open-child`, `try-open-child` and `create-child` accept a live parent token
and one component. A child reopens and retains its complete ancestor chain,
compares that prefix to the parent's held identities and revalidates the parent
before returning a distinct child token. Releasing a parent does not release a
completed child. Session EOF attempts to close every remaining chain; uncertain
closure prevents successful session completion. The existing 15-operation budget
bounds the number of live chains as well as messages.

`try-open-child` returns `child-missing` only after a native file/path-not-found
result and parent revalidation. Its identity/token fields identify the parent;
they must not be interpreted as a new child capability. Absence is a bounded
observation, not a durable guarantee. Reparse points and ordinary files fail the
session instead of being relabeled as absent. Other failures are terminal too.

`create-child` uses exclusive directory creation, then acquires the new chain.
Existing targets fail without being overwritten. Components cannot contain path
separators, streams, dot segments or trailing dots/spaces. Complete path/depth
limits are checked before creation. If creation succeeds but later acquisition
or acknowledgment fails, the new directory may remain: there is no implicit
rollback or retry. Creation failure is not a typed proof of no effect.

Eleven real native child tests cover parent-release independence, missing targets,
nested creation and EOF cleanup, existing-content preservation, invalid components,
and junction/file rejection. The owned Node scope now also exposes `openChild`,
`tryOpenChild` and `createChild`, returning child scopes with frozen identities.
Try-open maps validated absence to `null`, never to the parent as a child scope.
Nested scopes share the caller-work deadline and single outstanding request rule.
They all expire when work ends; reverse acquisition order releases children before
the initial directory. `releaseAcknowledged` means all those releases were matched.
Reports separately count children acquired and children with acknowledged releases.

The owner checks child path, depth, filesystem/volume and fresh live token before
exposing a scope. A missing reply must exactly identify its parent. This is protocol
consistency, not authenticated evidence of a child's identity. Each operation
reserves capacity for releasing all live directories, including a possible new
child. The bounded development session therefore permits at most six child opens
without other work, or thirteen assertions with only the initial directory.
Over-budget requests fail before sending; they do not weaken release requirements.

Paths must be absolute native drive paths, at most 1024 characters and 32 tail
components. UNC/device paths, dot segments, alternate streams, trailing dots/spaces
and reparse traversal are outside this profile. NTFS and ReFS are explicit code
profiles; tests qualify only their actual host, not all supported filesystems.
The 96 KiB session frame budget also applies to escaped paths and replies.

These handles constrain renames; they do not freeze directory contents or supply
CoW isolation. Sequential identity observations are not atomic namespace evidence,
ACL continuity or authenticated custody. Ancestor identities remain internal;
the reply exports leaf identity and count, not an entire chain evidence record.
An acknowledged release describes this operation; its returned token is no longer
live. An OS close failure is not retried or relabeled as successful cleanup.

The actual executable tests use a test-only client with the shared codec and
exchange tracker. They exercise Unicode paths, rename controls before/after a
lease, leaf/ancestor rename exclusion, EOF cleanup, wrong tokens, junctions and
partial acquisition cleanup for missing/file targets. They do not qualify the
production Node directory adapter, forced termination or hostile-code containment.

`withOwnedWindowsBoundaryDirectory(options, directory, work, signal)` now composes
these operations with the existing owned Node process lifecycle. It acquires one
directory, invokes asynchronous caller work with a frozen identity snapshot and
`assertCurrent()`, then requests release after work resolves. At most 13 sequential
assertions leave room for acquire and release within the 15-request budget.
Concurrent assertions, abandoned outstanding requests, callback exceptions and
budget exhaustion fail the scope. Captured scope methods reject after it ends.

Work has a separate bounded deadline (default five seconds, maximum 30 seconds).
Requests retain their individual deadlines. The helper receives fixed argv and
the existing constructed environment, not the caller's general environment.
Every response must match the expected operation status and, after acquisition,
the original token and identity as well as the exchange correlation fields.
Failure preserves outstanding request identity and never resends it.

The report separates acquisition, assertion count, release acknowledgment and
process cleanup. A clean helper exit after cancellation or a lost reply does not
become a release acknowledgment. Caller work is trusted same-process JavaScript:
timeouts invalidate the scope and close the helper, but cannot preempt arbitrary
callback code, undo its effects or interrupt synchronous event-loop blocking.
Ordinary caller file writes are not mediated by this directory adapter.

Seven actual-native adapter tests cover scoped work, the operation budget, callback
failure, timeout, cancellation, concurrent and unawaited assertions. Controlled peers test
wrong status, changed identity/token and lost release replies. These observations
do not qualify forced termination, close failure or authenticated loading.

The [bounded read profile](windows-boundary-file-read.md) is implemented in the
native helper and owned Node scopes, alongside exclusive file creation and bounded
process operations. Next complete the WorkspaceBoundary adapter and durable delivery
of projected receipts through the existing verifier.
Production resolution remains `helper_missing` until operations and the separately
reviewed launch/trust profile satisfy the actual verifier contract. This local
development executable is not authenticated installation or a release candidate.
