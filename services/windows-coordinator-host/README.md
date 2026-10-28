# Windows coordinator console fixtures

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

A separate admission fixture is compiled only with
`-p:CoordinatorAdmissionBridgeTests=true`. Its `--admission-probe` mode forwards
the exact bounded `attempt.prepare` frame and the SID observed by native pipe
impersonation over private inherited standard input. The Node fixture validates
the canonical frame and records a durable candidate, intent, and event with the
existing SQLite admission store. It sends only a canonical `no_effect` denial
to the caller. Replay uses the recorded candidate; every store rejection or
uncertain child completion closes without asserting `no_effect`. Neither image has an
execution or worktree effect.

The ordinary image recognizes only the canonical ASCII `attempt.status`
envelope and correlates it with a request ID. `attempt.prepare` returns
`invalid_request` in that image. The expected SID is caller-supplied for both
console probes, so a matching SID does
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

The admission fixture uses a constructed child environment, exact Node and
worker image hash checks, a fixed argument shape, bounded private frames and
stderr, a single deadline, and child-tree cleanup. These checks do not establish
protected image or loader custody. The `esbuild --packages=external` fixture
worker loads `zod` and
`better-sqlite3-multiple-ciphers` packages from the repository dependency tree,
including a native SQLite module. The fixture database, WAL, SHM, context file,
Node image, and worker are not protected service assets. The host and Node child
run under the same user, without atomic job assignment or a protected process
identity. The synthetic reservation context is supplied by the test, not an
authenticated service. This route must remain compile gated and unavailable in
the installed helper until those boundaries receive separate qualification.

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
retained normal and admission-fixture executables' SHA-256 values, bundled
worker hash, exact source/test file hashes and a candidate digest, test status
and duration, and removes only the
project's checked `bin/` and `obj/` directories. The image under `artifacts/`
is retained for review, without installation or selection.
