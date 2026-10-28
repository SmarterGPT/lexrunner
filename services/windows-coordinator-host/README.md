# Windows coordinator console peer probe

This is a **source-only, console-mode test fixture**. It is not an SCM service,
installed coordinator, admission issuer, protected selection, or execution path.
`--service` and every unrecognized mode refuse before pipe creation. The npm
package does not install or launch it.

`--probe --nonce <32 lowercase hex> --expected-sid <SID> --timeout-ms <1..30000>`
creates exactly one local byte-mode pipe at
`\\.\pipe\LexRunner.Coordinator.Probe.<nonce>`. Native `CreateNamedPipeW` uses an
explicit protected DACL, `FILE_FLAG_FIRST_PIPE_INSTANCE`, and
`PIPE_REJECT_REMOTE_CLIENTS`. The host accepts one LE32 request frame of at most
1 MiB, briefly impersonates after reading its header to observe the actual
client SID, then calls `RevertToSelf`. It returns only a framed
`WindowsCoordinatorDenial_v1` with `no_effect` and `authorizes_execution=false`.
One deadline covers connection, reads, and reply. Missing, malformed, oversized,
disconnected, and squatted endpoints never proceed to any effect.

Only the canonical ASCII `attempt.status` envelope is recognized and correlated
with a request ID. `attempt.prepare` returns `invalid_request` in this fixture:
the protected Node coordinator will own packet validation and admission. The
expected SID is caller-supplied for this console probe, so a matching SID does
**not** prove enrollment, operator intent, selected service identity, or trust in
the request. The fixture deliberately grants its own user SID pipe access to
exercise a wrong-expected-SID refusal; a production service must use a separately
reviewed DACL and identity arrangement. In particular, this fixture's `GRGW`
client ACE includes `FILE_CREATE_PIPE_INSTANCE` through `FILE_APPEND_DATA`, and
its host SID has `GA`. A permitted same-user peer can create a server instance
after the one-shot probe exits. `FILE_FLAG_FIRST_PIPE_INSTANCE` detects an
already-present instance when this probe starts; it does not authenticate a
server that appears later. This DACL must not be reused for a persistent
protected endpoint. A production client needs minimal specific open rights and
separate server authentication; this probe does not qualify those controls.

Build locally on Windows with the pinned .NET 8 SDK:

```powershell
$env:OS = 'Windows_NT' # only if the shell omitted the normal Windows OS marker
dotnet publish .\LexRunner.WindowsCoordinator.Host.csproj -c Release -r win-x64 -p:NuGetAudit=false -o ..\..\artifacts\windows-coordinator-host-probe\publish
```

No install, service registration, or protected machine change is part of this
build. `bin/` and `obj/` are ignored; the disposable test executable remains
under `artifacts/`.

For the focused build and live pipe gate, run `pwsh -NoLogo -NoProfile -File
.\verify.ps1` from this directory. It prints a bounded JSON result with the
retained executable's SHA-256, exact source/test file hashes and a candidate
digest, test status and duration, and removes only the
project's checked `bin/` and `obj/` directories. The image under `artifacts/`
is retained for review, without installation or selection.
