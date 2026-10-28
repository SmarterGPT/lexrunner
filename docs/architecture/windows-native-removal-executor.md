# Native Windows removal executor and recovery

This is the explicit development connection for [#997](https://github.com/SmarterGPT/lexrunner/issues/997).
It connects the actual broker, owned Node/native session, bounded native deletion and existing
SQLite admission/recovery verifier. Production discovery remains unavailable. This connection
does not install, download, activate or authenticate a helper.

## Transition and durable binding

`NodeGitWorktreeBroker` accepts an explicit `NativeWorktreeRemovalTransition`. Without that port,
its existing refusal to run destructive Git under delete-excluding scopes remains in force.
The broker observes identity/registration/cleanliness and preserves dirty or ambiguous work.
For a selected clean Windows target it confirms ordinary-scope release before invoking the
transition with the selected root and repository-Git identities. Releasing read scopes does not
authorize mutation: the transition reacquires and compares those identities before any effect.

`createOwnedWindowsRemovalTransition` binds one retained lifecycle lease, operation ID, existing
slot and original physical selection. The native session independently retains root, registration
and slot ancestor chains. The stable, exclusive slot is selected by the SHA-256 of the workspace
lease ID; its original physical identity and contents must match. It is provisioned explicitly
before execution, never recreated when missing or replaced. Raw tokens stay in the live session.

`createDurableWindowsRemovalProvider` is a separate per-operation recovery connection. Given an
operation ID, it reads the immutable admission and Windows binding, then reads the referenced
workspace lease, Attempt and current run controller. It checks the recorded paths, marker and
deterministic slot against the durable lease before opening any native owner. Recovery acquires
the recorded parent directories, compares their original identities in the native recovery path,
and derives the current controller credential and run revision from the store. A stale controller
or changed record fails the existing resolver fence. A completed operation returns historical
status; no second commit is dispatched. The owner must close with confirmed child exit before
the provider returns a resolution result.

This provider deliberately refuses **fresh** removal. The durable lease does not contain the
registration and slot physical identities needed for first dispatch, and a fresh helper
observation cannot create its own approved expectation. Its injected owner-opening callback is
not authenticated by this module. A separately qualified protected selection, slot-provisioning
and launch authority must supply those expectations before production can connect first dispatch
or treat recovery as an authenticated result. The production resolver remains unavailable.

Preparation opens every selected child relative to retained native parent handles. It refuses
reparse points, unsupported filesystems/names, identity mismatches, open writers and inventory
budget failures. Read handles allow Git inspection before DELETE access is acquired. The target
`.git`, registration `gitdir`/`commondir`, exact broker Attempt marker and branch HEAD must agree.
A registration `locked` marker or `.lock` file prevents preparation. Fixed native Git status
includes untracked and ignored files, disables optional locks/hooks/fsmonitor, uses explicit Git
routing/environment, and runs under the existing native process Job Object. Its command, cwd,
process, duration, exit and output digests are bound into the prepared selection.
Public Git configuration-location variables match the broker, including global newline
normalization. Their digest is recorded; general credential variables are not forwarded.
Inline Git environment configuration is explicitly unsupported rather than projected blindly.

Before Git observes cleanliness, the helper reopens every selected root and registration entry
relative to its retained parent with a no-DELETE-sharing observation handle and compares the
complete identity. These handles stay live until Git exits. Only then does the helper close each
observation handle and acquire its DELETE handle while retaining the original identity handle.
A failed observation or identity comparison refuses removal. The original preparation handles
alone are insufficient: an owned-fixture control on NTFS and ReFS moved a dirty tracked file,
put clean bytes at its name for Git status, then restored the dirty original before identity
recheck. Git reported clean in that weakened sequence. The observation handles denied the move
and Git reported dirty in the guarded sequence. The control preserves the dirty file and never
deletes it.

DELETE handles are acquired parent-first relative to retained parents. Each original handle stays
live until the new handle's complete identity matches. A replacement cannot reuse that still-live
object's ID. An incompatible ordinary scope or competing seal refuses before deletion.

`SqliteWindowsRemovalStore` adds opt-in migration 25, associating immutable native binding metadata
with the existing immutable intent. It checks paths and marker against the stored workspace,
rather than trusting a changed caller snapshot. Existing controller/revision/worker/verification
fences and the single-unresolved-operation rule remain in the same SQLite writer ordering.
Only fresh `admitted` sends commit. Admission replay is historical status, never another effect.
Wire selection hashes use the existing indented LF wire bytes; journal identity/binding digests
retain their existing compact canonical byte contract. These are association digests, not authority.

Commit consumes the prepared selection once and deletes only selected objects, child-first, by
native handle disposition. Registration deletion starts only after the selected root tree was
removed. Entry/time budgets and native errors produce explicit partial outcomes; there is no
pathname sweep, destructive Git fallback or automatic retry. A stopwatch cannot interrupt an
arbitrary kernel call. A lost/thrown reply leaves unresolved durable admission. The peer caches
an identical live-token commit's historical result without rebuilding targets from current names.

The owner closes the operation and actual child before a new recovery session. Recovery holds
the original stable slot and compares retained parents. It opens the recorded process identity
with a Windows process handle, compares creation time and PID, and observes termination. Active
or uninspectable executors do not resolve even when names look absent. EOF, PID alone and terminal
worker metadata are not cessation evidence.

Fresh root/registration observations remain held through `resolveRemoval`. The existing verifier
records remaining contents/root/registration or observed absence. Changed roots, replaced slots,
locked registration, unknown observations or stale credentials retain the unresolved record.
Resolution never releases the workspace, advances selection or authorizes deletion. The broker
returns `removed` only after resolved absence and another fresh broker observation of absence.

## Reproducible qualification

From native PowerShell 7, select an existing disposable test parent explicitly:

```powershell
pwsh -NoLogo -NoProfile -File proofs/windows-workspace-boundary/verify-removal.ps1 `
  -FixtureParent D:\explicit\existing\disposable-test-parent
```

The script builds NativeAOT x64 peers and runs real Git, custody, broker, SQLite and recovery
tests in newly generated disposable directories. It never moves a real checkout. Receipts/logs
under `proofs/windows-workspace-boundary/artifacts/removal/<filesystem>/` record source HEAD/dirty
state, exact commands/cwd, durations/exits, bounded output, log hashes and executable hashes.
The required Windows CI bootstrap job runs this lane on its actual filesystem.

`RemovalSessionProbe` links the production sources with compile-time test hooks. The production
helper has no fault-file hook. File barriers establish five termination points: before effects,
partial root content, root removed, partial registration and effects complete before acknowledgement.
The existing owner terminates its own helper; a fresh store connection and native session recover
through the verifier without another commit. Other cases cover actual broker
create/observe/dirty-preserve/remove, read-only/nested content, budgets, replacements before seal,
competing seals, stale admission, locked registration, replaced slot, live-executor refusal and
historical replay preserving a replacement. Uncertain ownership prevents fixture cleanup.

## Remaining qualification and shipping

These are cooperative coordination/correctness tests, not hostile-code containment. Caller pins,
local slot provisioning, synthetic test discovery and SQLite digests do not authenticate deployment,
the helper, its launch graph or authority. Production resolution/public worker availability are
unchanged. Outer execution admission, installed-helper discovery, approved signature/provenance/
launch profile and full supported-host worker conformance remain separate qualification. Power
loss/reboot, arbitrary filesystem versions, kernel stalls, cross-volume roots and ARM64 are not
established by this x64 lane.

npm installs only LexRunner. The native helper remains a separately downloaded, completely
optional normal application, installed by a user or explicitly authorized agent. No npm dependency,
lifecycle script or package command downloads, installs, repairs or updates it. Normal tooling
works without it. This distribution decision does not install services, identities or trust roots.

Microsoft documents [relative native opens](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile),
[directory enumeration](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_full_dir_info),
[disposition flags](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntddk/ns-ntddk-_file_disposition_information_ex)
and [process times](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes).
Supported-driver behavior requires actual qualification, not documentation alone.
