# Windows coordinator service source

This directory contains the first **source-only** NativeAOT SCM service host
for the selected optional Windows coordinator profile. The normal image accepts
only `--service` and calls `StartServiceCtrlDispatcherW`; direct console
launch fails. It requires the current user SID to resolve to
`NT SERVICE\LexRunnerCoordinator` and refuses an administrator token.
It registers stop/shutdown controls and reports SCM start, running, stop
pending, and stopped states. The stop handler attempts `STOP_PENDING` before
cancellation; the service disposes the pipe before its single terminal
`STOPPED` report. It gathers the failure code before that report and leaves
SCM's service-table name allocated until process exit, since SCM may terminate
the process immediately after terminal status. A compile-gated state-order
selftest checks normal stop,
stop during startup, and status-publication failure. An installed SCM
stop/drain test remains required.

The fixed endpoint is `\\.\pipe\LexRunner.Coordinator.Service.v1`.
`CreateNamedPipeW` uses one byte-mode overlapped instance, first-instance
protection, remote-client rejection, and a protected DACL granting full access
only to SYSTEM, Administrators, and the dedicated service SID. **No ordinary
client is enrolled in this source image.** The narrow
`0x00100083` client ACE is implemented only for a compile-gated disposable
fixture taking one exact test SID. It omits the pipe-instance-creation bit
`0x4`, DACL write and owner write. A future protected enrollment and
installed cross-account test must replace and qualify the actual client ACE
before any Attempt is sent.

The service reads at most one 1 MiB LE32 request frame per connection, with a
five-second client deadline. After the complete request read it briefly uses
`ImpersonateNamedPipeClient` to observe the peer SID and immediately calls
`RevertToSelf`; a failed revert terminates the process. It parses only the
canonical v1 `attempt.status` envelope. For that request alone, the normal
service sends a bounded v2 `kind: status` reply with `state: indeterminate`,
`effect_state: effect_unknown`, `reason_code: protected_store_unavailable`,
and `authorizes_execution: false`. These echoed identifiers are untrusted
correlation data. Without a protected store, the service cannot assert
`no_effect` for a historical Attempt or establish that one exists. Invalid or
incomplete requests close without a reply. No ordinary client can open the
current pipe; only SYSTEM, Administrators and the service SID have access.
There is no protected store, admission, Node launch, helper launch, Git launch, worktree effect, or
production client selection in this image.

The compile-gated `--protocol-selftest` checks canonical status parsing,
duplicate-key/noncanonical rejection, deterministic v2 indeterminate-status
encoding, and bounded v1 denial encoding for an isolated fixture;
`--pipe-selftest` exercises same-user status replay, malformed close and
mid-header disconnect recovery; `--lifecycle-selftest` checks the state order.
That fixture's `no_effect` response is not reachable in the normal image.
Run `pwsh -NoLogo -NoProfile -File .\verify.ps1` from this directory to
publish both images and run the selftest plus direct-launch refusals. It does
not register, start, stop, or install a service. After capturing hashes it
checks and removes only this project's `bin/` and `obj/` build directories.
The ordinary publish output is
`artifacts/windows-coordinator-service-source/publish/LexRunner.WindowsCoordinator.Service.exe`;
the bounded JSON receipt is saved at
`artifacts/windows-coordinator-service-source/verification-receipt.json`.
An installer must consume a separately reviewed and signed exact payload.

Unqualified installed gates include SCM image/configuration readback, service
SID and privilege token, mandatory integrity behavior, cross-account
Identification-level peer observation without `SeImpersonatePrivilege`,
exact client ACE, service stop/drain, protected selection, loader closure,
protected store, and service-owned worktree roots. Neither this source build
nor the existing pipe fixtures clear `helper_missing`.

Primary Windows API references:
[service dispatcher](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nf-winsvc-startservicectrldispatcherw),
[service status](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nf-winsvc-setservicestatus),
[named-pipe security](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights),
and [peer impersonation](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-impersonatenamedpipeclient).
