# Windows worktree removal qualification

Status: current broker guard implemented; removal transition remains unqualified.
Tracking: [#997](https://github.com/SmarterGPT/lexrunner/issues/997).

## Removal evidence and recovery assessment

`workspace-removal-evidence.ts` defines an internal, read-side contract for removal
intent and independently collected observations. Intent binds operation, Attempt,
lease revision, root identity, Git registration and preservation-evidence digests.
Observation binds that intent to separately observed root, contents and registration
state. Records use strict bounded canonical JSON and body digests; duplicate keys,
unknown fields, truncation, digest mismatch and inconsistent states fail assessment.

The caller supplies independently selected expected intent/observation digests, an
assessment time and maximum observation age. Old, future or pre-intent observations
require reconciliation. Digest equality associates records; it does not authenticate
their source, establish current fencing, prove persistence or reserve an allocation.
The caller remains responsible for selecting current independently observed evidence.

Assessment separates `contents_remaining`, `root_remaining`,
`registration_remaining` and `absence_observed`; uncertainty, changed identities,
locks and a root surviving without registration require reconciliation. Every result
has `authorizesMutation: false`. Even observed absence is not a native release receipt,
an authorized retry, or an automatically finalized lifecycle transition. No filesystem
or Git operation is dispatched. Records can be serialized with `canonicalJSONStringify`;
authenticated delivery and production lifecycle integration remain pending.
This contract is not exposed through the product protocol or public CLI.

`SqliteRemovalEvidenceStore` is an opt-in journal on the existing coordination
database. It validates canonical bytes and digests before appending immutable intents
and observations. Exact retries are idempotent; a conflicting intent cannot replace
the record for an operation. Observations require a recorded intent, and earlier
observations remain addressable by digest. Readback selects an explicit operation
and observation digest within one read transaction, validates both records and their
row bindings, and returns bytes for the existing assessor. Missing evidence remains
missing; corrupt evidence throws without repair. Read-only reopening is supported.

Persistence tests cover connection reopening and independent connection retries.
A separate disposable child-process fixture covers forced termination after an intent
commit, during an uncommitted observation, and after an observation commit. It uses
the real journal API; a test-only subclass keeps an outer transaction open around
the observation append for the uncommitted case. The parent waits for an IPC phase
marker, kills its child, waits for process close, checks that managed cleanup did not
run, and reopens the database through the ordinary writable store constructor.
Committed records survive these tested stops; the uncommitted observation is absent.
The existing assessor still returns `authorizesMutation: false`, including when the
fixture's supplied observation says both root and registration are absent. Re-appending
after readback is only a storage retry test, not permission to repeat filesystem work.
The default test suite and Windows bootstrap CI lane run the fixture.

This does not test power loss, termination inside a SQLite commit, all journal modes,
or actual filesystem removal coupled to database persistence. The observations are
synthetic fixture inputs; IPC markers are synchronization, not authenticated evidence.
A successful transaction is not evidence
of qualified storage durability, current lease ownership, authenticated provenance,
native handle release or removal completion. The journal does not acquire or release
allocations, select the latest observation, or dispatch recovery. Semantic consistency
and freshness remain assessor responsibilities; contradictory observations can be
retained as evidence without being accepted for recovery.

Allocation conflict checks retain quarantined leases as branch/path occupants in
both lifecycle stores. Quarantine stops execution; it does not free unresolved data
for another Attempt to adopt. A fresh branch/path remains available. This enforces
ADR-010's no-silent-reuse rule through store APIs, including SQLite's transactional
acquisition checks; it does not add an OS namespace lock or change terminal-state
reconciliation. Existing live-only database indexes remain unchanged. Historical
duplicate allocations are not rewritten. Full removal intent and reservation across
all removal/recovery phases remain pending.

The current native profile opens directories without delete sharing. A disposable
Windows/ReFS experiment demonstrated that Git can empty and unregister a worktree
before failing to delete its held directory. Retrying after release then reports
that the path is no longer a worktree. A separate unheld control removes normally.
The control-workspace `windows-held-remove-probe*` evidence retains both observations.
This is partial mutation, not a no-effect failure.

The broker now refuses the destructive Git removal step when the selected boundary
claims `rename_delete_exclusion`. It first performs normal observation/preservation
checks, so dirty, missing and ambiguous workspaces keep their existing outcomes.
A clean eligible target returns an explicit failure requiring a qualified removal
transition. Its files and registration remain intact. Linux profiles without this
claim retain the existing removal path.

The real native broker fixture exercises bootstrap, create, exact retry, observation,
dirty preservation and the guarded clean-removal result. It uses explicit test-only
resolver composition and an absolute Git executable; synthetic discovery metadata is
not production provisioning. The public resolver remains unavailable.

## Pre-mutation journal fixture

The optional four-argument native probe mode supplies absolute Node and
`scripts/checkpoint-removal-probe.ts` paths after the artifact parent and Git path.
The signing qualification lane selects this mode. Before the first target mutation,
the bridge writes the initial intent and observation to the real SQLite journal,
closes it, reopens a separate read-only connection, and checks exact readback before
acknowledging. A failed checkpoint stops the probe rather than proceeding with removal.

After each planned stop or confirmed child termination, the parent captures a new
native snapshot. A new Node process reads the persisted fixture selection, finds the
exact previous evidence pair, reuses its intent, appends the new observation and
verifies readback. Missing/conflicting evidence and older observation times fail.
Changed-identity observations are retained, but do not receive a success acknowledgement.
The caller selects observations explicitly; no timestamp-based "latest row" inference
or automatic filesystem retry is added.

The report retains all four exact journal record pairs per case. The existing verifier
checks them against the observed snapshots and initial fixture binding before replaying
assessment. Complete checkpoint reports are labeled `pre-mutation-journal-fixture`;
legacy two-argument reports remain `retrospective-fixture`. Mixed coverage is rejected.
These labels describe the inspected fixture path, not authenticated proof from arbitrary
report bytes. Journal files are removed with the disposable fixture; retain the report.

The Node bridge is internal test tooling, not a product protocol. The persisted selector
and known-file preservation association remain unauthenticated fixture data. SQLite
commit/readback and native child termination do not prove power-loss durability, parent
process restart, current fencing, allocation reservation, or atomic filesystem observations.
The parent remains alive during the native child stop. Production broker guard, helper
protocol and resolver are unchanged. Allocation reservation and authenticated delivery
remain prerequisites for production recovery wiring.

## Next bounded design and experiments

Removal must be a deliberate lifecycle transition, not an ordinary command whose
arguments happen to identify a directory. Before any mutation it needs a durable
intent binding the Attempt, lease revision, target identity, Git registration and
preservation observations. New work must stop on that workspace, and affected
descendant scopes must be accounted for. The terminal evidence must distinguish
registration removal, content removal, residual directory and uncertain effects.
Recovery uses those observations and the existing verifier, not an automatic retry
of `git worktree remove`.

A development-only `OwnedDirectoryRemoval` now acquires an explicit DELETE-capable
leaf handle beneath a held parent chain and checks it against an expected physical
identity. The expected identity is association data, not an authority grant. Tracked
leaf/direct-child readers keep the owner alive and prevent disposition until closed.
The primitive requests only empty-directory removal. It caches the first disposition
observation, separates handle release from subsequent name observation, and never
resends against a replacement at that name. Nonempty rejection is terminal too.

Run its disposable native lifecycle probe from `proofs/windows-workspace-boundary`:

```powershell
dotnet run --project tests/RemovalLeaseProbe -c Release -- ../../artifacts
```

Supply an absolute Git executable as a second argument to run three real-worktree
composition cases as well. They flush a fixture identity/registration association
file before mutation, close handles at planned stops after one content file, after
the `.git` file, or after root removal, and reload that file before resuming.
The remaining contents are observed separately from registration. Root removal uses
the native owner; exact known fixture files use ordinary file deletion. Final Git
registration cleanup preserves a second worktree. A repeated observation confirms
completion without dispatching removal again.

Three additional cases launch a separate probe child, which reads the flushed fixture
intent and holds the native owner while reaching the same boundaries. The parent waits
for a phase marker, forcibly terminates the child, confirms its nonzero exit and checks
that its managed `finally` marker was not written. It then reloads the fixture intent
and inspects/resumes the remaining work. Root removal precedes registration cleanup;
the second worktree remains intact. This tests actual process termination at selected
post-operation boundaries, not termination inside the native disposition call.

The phase marker proves fixture progress, not an authenticated receipt. Confirmed child
termination does not manufacture native close acknowledgements. No power-loss durability,
authenticated intent, concurrent allocation exclusion or production recovery is claimed.
The fixture file is not a production receipt or authority grant; authenticated restart
ingestion remains pending. No arbitrary recursive content deletion is qualified.
The signing qualification lane runs these cases, but the helper protocol still cannot
invoke this primitive.

With Git supplied, the probe also emits four raw snapshots for each of its six
worktree cases: initial state, planned/interrupted stop, root removed, and registration
removed. Each snapshot reads the root identity and contents, and separately reads
Git's registration listing plus the native registration-directory identity and its
`gitdir` backlink. Unexpected I/O failures stop the probe. These sequential reads are
not an atomic namespace snapshot or an authenticated production observation.

`node --import tsx scripts/verify-removal-probe-evidence.ts <report.json>` projects
these bounded fixture reports into removal intents/observations, appends them to a
temporary SQLite journal, reopens it, selects each exact record, and checks it through
the existing removal assessor. The output binds the exact source-report byte digest
to fixture intents and identifies every assessed observation. All results remain
non-authorizing and explicitly unauthenticated. Expected identities come from the
fixture's initial snapshot, not independent production provisioning; the preservation
digest denotes the disposable known-files fixture, not a verified preservation receipt.
These intents are reconstructed after the probe; their source timestamps do not prove
that a journal intent was persisted before filesystem mutation. The output labels
this retrospective fixture timing explicitly.
The temporary journal is removed after verification; retain the raw report and output
as qualification evidence. Changed identities, missing cases, malformed records and
inconsistent observations fail this fixture verifier. The signing qualification lane
runs it after the native probe. Authenticated capture, current fencing and production
recovery integration remain pending.

This primitive is not reachable through the helper protocol or production resolver.
It does not upgrade an existing read lease; that lease must already be absent before
acquisition. It is not recursive deletion, a Git registration transition, durable
receipt delivery, or crash recovery. Close failure paths retain uncertainty, but
real OS close-failure and interruption qualification remain outstanding. The linked
probe injects a missing close confirmation after actual fixture-handle cleanup to
check failed reader-acquisition uncertainty; that seam is excluded from the helper.
The existing broker guard stays in place. Full worktree removal still needs the
durable intent, preservation, effect verification and recovery design above.

Two tempting shortcuts are not justified by the API contract. Microsoft documents
that reopening an object cannot request access conflicting with an existing open
handle's sharing mode; POSIX-style disposition still requires DELETE access.
Therefore neither “upgrade the handle” nor “use POSIX delete” alone answers the
current profile mismatch. See [ReOpenFile](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-reopenfile)
and [FILE_DISPOSITION_INFORMATION_EX](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntddk/ns-ntddk-_file_disposition_information_ex).

Do not globally enable delete sharing, release all custody and race a pathname, or
make recursive deletion an implicit fallback. A different cooperative workspace
profile can be evaluated explicitly if it better serves trusted coworkers, with its
actual guarantees and recovery costs measured. This work concerns coordination and
mistake containment, not a new hostile-code sandbox.

## Coordinator process-exit qualification

The Git-backed test gate includes `workspace-coordinator-sqlite-git.spec.ts`.
Its restart cases run the real coordinator in a separate Node process, exiting
without coordinator/store cleanup immediately before or after portable Git removal.
A newly opened SQLite store must retain the prepared allocation and reject both
branch and path reuse. Before-effect recovery can complete release through exact
prepare replay; after-effect recovery quarantines the absent worktree and retains
both reservations across another database reopen. Only completed release permits
allocation reuse. The prepare event must remain unique.

This tests the existing Linux broker/coordinator lifecycle, not native Windows
removal or the removal-evidence journal selection protocol. The fixture reuses an
unexpired controller credential and supplies the original release request; controller
takeover, expired fencing, power loss, native partial effects, and authenticated
restart selection remain separate work. Windows production resolution still reports
`helper_missing`; do not bypass that boundary to run this portable qualification.

## Explicit recovery selection

The opt-in SQLite evidence journal now keeps a separate `removal_selections` cursor.
Immutable intent/observation records remain historical evidence; appending a record
never makes it the selected recovery checkpoint. Selection compares the expected
previous observation under an immediate transaction, validates the exact intent and
observation association, and refuses backward observation time. Repeating the
already-selected observation is idempotent. No timestamp-based "latest" lookup occurs.

The native fixture checkpoint bridge advances this cursor before acknowledgement and
reopens it for readback. Replaying initial preparation after the cursor has advanced,
or submitting a new observation with a stale previous selector, fails. Evidence
appended before a failed selection remains available without replacing the cursor.
A conflicting observation that wins selection is retained and selected, but still
fails the existing recovery assessor; selection never means successful removal.

A crash between append and selection leaves the old cursor. A crash after selection
but before acknowledgement can leave the sidecar stale; the bridge refuses to guess
or roll back. Explicit restart recovery can read the persisted selection with the
expected intent digest and must reassess actual filesystem state. Legacy journals
have no selected checkpoint until explicitly selected; reopening for writable use
adds the empty selection table, without choosing historical evidence. A read-only
pre-migration database cannot serve this new API.

This is local evidence selection, not authenticated provisioning, controller fencing,
allocation release, deletion authority, or power-loss qualification. Binding it to
current lifecycle reservations and restarting the native parent remain pending.

## Reservation-bound read-side assessment

`assessReservedRemovalRecovery` checks supplied Attempt/lease snapshots before
calling the existing evidence assessor. The intent must name the same Attempt and
lease, the Attempt must still name that lease, and both lifecycle records must agree
on run/revision, WorkItem/revision, packet/hash and base commit. The intent's exact
lease revision must match. Only reserved, active or quarantined leases represent a
retained allocation for this check; released, preserved and abandoned leases require
reconciliation. A newer lease revision is never adopted implicitly.

Tests create real controller, Attempt and reservation records plus selected removal
evidence in SQLite, reopen both stores read-only and assess the recovered records.
The absence observation is synthetic; no filesystem removal occurs. Assessment leaves
the reservation and event history unchanged. Negative variants exercise ownership,
revision, finished-state, missing-record and freshness failures. Quarantine still
means retained allocation; observed absence does not release it.

This is structural binding of supplied snapshots, not a transaction spanning lifecycle
and journal reads, authenticated provenance, a physical root-to-path binding, or current
controller fencing. It does not infer reservation retention from process exit or lease
TTL, renew an expired controller, or dispatch recovery. A caller must obtain current
state and fence any subsequent mutation. Native parent restart, independent provisioning
of the intent's physical identities, and production integration remain pending.

## Native parent-exit assessment qualification

`scripts/qualify-removal-parent-restart.ts` composes the development native probe,
real Git worktrees, SQLite lifecycle reservations and the selected removal journal.
It does not use the production resolver or add a deletion operation to the helper
protocol. Run it from the repository root on Windows after building the existing
`proofs/windows-workspace-boundary/tests/RemovalLeaseProbe` project:

```powershell
node --import tsx scripts/qualify-removal-parent-restart.ts run `
  (Resolve-Path artifacts).Path `
  (Resolve-Path proofs/windows-workspace-boundary/tests/RemovalLeaseProbe/bin/Release/net8.0/RemovalLeaseProbe.exe).Path `
  (Get-Command git.exe).Source
```

The harness creates a new disposable root under the selected parent and removes
only that exact root afterward. It supports both the framework build and a
NativeAOT publish of the same fixture. The manual signing qualification workflow
runs the framework build's assessment and retains its JSON report separately.

For each of three boundaries (one content file removed, `.git` removed, or the root
removed), a separate Node parent reserves the actual branch/path, commits the
initial intent/observation and selection, and independently reopens selection
before invoking the native known-file mutation. The native child completes and
closes its handles. The Node parent exits with code 73 without closing its live
SQLite connections. This is coordinator process exit after a completed native
call, not a kill inside that call, interrupted native cleanup, or power loss.

Fresh Node recovery processes read the persisted selection and reservation, acquire
fresh native identity/registration observations, and run the existing
`assessReservedRemovalRecovery`. Partial content and root-absence cases remain
distinct. The raw intent, selected old observation, fresh observation and lifecycle
snapshots are included in the report. The fresh observation is assessed explicitly;
it does not silently advance the persisted journal cursor.

Each boundary tests a current controller, an expired controller, and a replacement
controller with a newer fence. Expiration/takeover use the store's explicit clock
input advanced beyond expiry, not a claim about elapsed wall time. The old
credential's renewal and run-state write must fail in the latter two cases. The
same filesystem assessment can remain valid in all three cases: assessment is
not authority. Workspace reservation, Attempt, lifecycle events and journal
selection remain unchanged; the unrelated sibling worktree and remaining known
target files are checked.

Even the current-controller case does **not** resume deletion or release storage.
Controller renewal and native observation are separate operations. This fixture
does not close the check-to-use interval, transfer ownership to the replacement,
authenticate the supplied physical identity/selection, or prove a fenced native
mutation protocol. Those boundaries and production recovery remain pending.
