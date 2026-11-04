# Windows coordinator service source

This directory contains the first **source-only** NativeAOT SCM service host
for the selected optional Windows coordinator profile. The normal image accepts
`--service` through `StartServiceCtrlDispatcherW` and one exact private trust
child mode which refuses while its installed context is unavailable. Direct service
launch fails. The NativeAOT image uses the GUI subsystem so private children do not
create a separate console host. It requires the current user SID to resolve to
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

## Inactive private Node launch source

`CoordinatorPrivateNode.Run` is an internal launch primitive. The normal image
cannot construct its `ProtectedGenerationLease`: `TryOpenInstalled` always
refuses, and no service request calls the primitive. `Prepare` also refuses
before child creation because protected admission and a durable operation
intent are absent. The only fixture success returns the exact conservative
`attempt.status` frame, never an execution grant.

The compile-gated `--private-launch-selftest` opens its own disposable image,
then checks creation-time Job and inherited-handle binding, the suspended
child's Job membership, image path and token SID, a fixed command and newly
constructed environment, nonce-bound private pipes, bounded output and time,
and terminal process/Job drain. Bad nonce, output flood, nonzero exit, timeout,
cancelled or disposed lease, and duplicate child use remain uncertain or
refused. A pipe cleanup fault is classified as uncertain while the kill-on-close
Job handle is still released. These tests exercise source mechanics only; they
do not prove a signed installed Node/addon/loader graph, protected selection,
SCM process identity, service-owned store, or cross-account behavior.

The compile-gated `--protocol-selftest` checks canonical status parsing,
duplicate-key/noncanonical rejection, deterministic v2 indeterminate-status
encoding, and bounded v1 denial encoding for an isolated fixture;
`--pipe-selftest` exercises same-user status replay, malformed close and
mid-header disconnect recovery; `--lifecycle-selftest` checks the state order.
`--private-launch-selftest` exercises only the compile-gated private child.
That fixture's `no_effect` response is not reachable in the normal image.
Run `pwsh -NoLogo -NoProfile -File .\verify.ps1` from this directory for the
complete historical source gate, including pipe and private-launch fixtures. It
builds the actual shared native archive and both NativeAOT images with package
auditing enabled. `-PureOnly` runs the native policy, managed ABI, publication,
protocol and lifecycle pure tests plus normal closed-mode refusals; it explicitly
skips the SCM dispatcher, pipe and private-launch host checks and reports
`source_pure_only_pass`, not the full source gate. Neither mode installs a service.

Both modes use fresh `artifacts/windows-coordinator-service-source/qualification-<nonce>`
outputs, including separate intermediates. `-OutputDirectory` accepts a fresh absolute
path under repository artifacts. They do not delete project `bin/obj` or
overwrite old evidence. The engineering GUI capture reads both byte streams with
32 KiB retained per stream and 64 KiB total, strict UTF-8 and exact expected line
endings. It waits for direct process exit and stream settlement, attempts at most
one direct-process kill and refuses timeout/overflow/close or terminal uncertainty.
Unsettled managed owners remain retained until verifier exit. This is direct-parent
and stream evidence, not descendant terminal proof or native OS-close attestation.
`process-checks.json`, `build-checks.json`, native build evidence and
`verification-receipt.json` retain the scoped observations. An installer must
consume a separately reviewed and signed exact payload.

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

## Statically linked trust primitive, closed installed context

`NativeTrustAbi` links the private version2 C ABI through NativeAOT DirectPInvoke
to the actual `windows-coordinator-trust-native` archive. The fixed
`--private-trust-child` route cannot obtain `PrivateTrustChildContext`; it returns
`protected_bootstrap_unavailable` before any trust API. No request/path/hash/JSON
or selected helper can authenticate itself. `TryOpenInstalled` also remains false.
The compile-gated `--trust-contract-selftest` checks ABI layout and rejection facts
without SDK trust calls. Full selected-policy success is a one-use, start-relative
30-second observation requiring independent retained installed custody, not
execution/admission authority. Node continues to own policy and Attempt semantics.

The shared SDK and selected policy enforce explicit request/chain/purpose/current
revocation and once-close outcomes. `/DEPENDENTLOADFLAG:0x800` and static linkage
are build requirements, not proof of an independently protected initial loader.
No installed bootstrap/process/selection, broker or governed execution readiness
follows; helper_missing stays refused. npm never downloads or installs this
separately optional application.

## Native publication storage, closed installation origin

The service also links the fixed HKLM64 retained publication reader and History-only
compare/write/flush/readback owner. Its ephemeral exact-descriptor mutex is not a
persistent installer root. Preview facts never authorize work; the private live
administration Session and RequireLive remain closed without an independently
admitted installed origin. This source does not install, select, start or repair
the optional helper and does not clear helper_missing. The new publication routes
accept only their exact single argument; extra arguments retain prior refusal.

Run `tests/Verify-PublicationStorageSource.ps1` separately for the actual shared
fake-port/data-parser120 cases plus historical model74; it runs no native
publication, admin or preview entrypoint. The service verifier keeps its SDK
archive/ABI/private-context checks and records the complete combined source graph.
Use `-PureOnly` for local source-only service validation; historical pipe/private
launch fixtures remain separately scoped. Neither artifact review is an installed
origin, actual HKLM qualification, deployment approval or governed execution proof.

Both fixed service objects permanently refuse custom controls 128 through 255 with
ERROR_CALL_NOT_IMPLEMENTED (120) before payload access or product-state locks.
This is the selected staged-creation profile invariant, not a configurable verb
range. The fixture-only `--custom-control-selftest` invokes the actual callbacks
with poisoned payload pointers. The coordinator test also holds its registration
lock on another thread and checks that cancellation/status remain untouched; its
standard STOP and shutdown callbacks still follow the lifecycle path. Normal
images reject the fixture flag. Neither callback tests nor a fresh-open denial
qualify previously opened SCM handles: real retained-handle, creation/hardening,
start and queue-denial-of-service controls remain pending approved installation.
