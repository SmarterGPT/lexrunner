# Optional Windows coordinator native client source

This separate NativeAOT project is excluded from the npm package. It does not
install or activate a service, alter a registry selection or ACL, or send a
production Attempt packet. The ordinary image reports `helper_missing` for all
requests. `--status` reads the fixed `LexRunnerCoordinator` SCM entry for a
bounded diagnostic, but it still reports `helper_missing` even if that service
exists. No caller argument can supply a pipe name, PID, image path, or pin in
the ordinary image.

The source binding sequence for a future protected selection is:

1. Read `LexRunnerCoordinator` through SCM and require an exact RUNNING
   `SERVICE_WIN32_OWN_PROCESS` type and nonzero PID.
2. Open and hold that process before opening a pipe. Check process ID,
   liveness, and running image. The current image-path comparison is only
   fixture/source evidence; it is not protected image, loader, or file-identity
   custody.
3. Open the fixed `\\.\pipe\LexRunner.Coordinator.Service.v1` endpoint with
   `READ_DATA | WRITE_DATA | SYNCHRONIZE` (`0x00100003`), `FILE_FLAG_OVERLAPPED`,
   and Identification SQOS. Require the connected server PID to equal the held
   process PID. Failure to obtain that PID closes the route.
4. Re-read SCM type/state/PID and process liveness immediately before any
   write. Keep the process handle through the reply.

The source uses LE32 request frames from 1 byte to 1 MiB and caps replies at 4 KiB.
Each read/write checks one deadline before it starts. Byte counts come from
terminal `GetOverlappedResult`, including immediate completions. A pending operation's unmanaged buffer and
`OVERLAPPED` survive until terminal `GetOverlappedResult`; a timed-out operation
receives targeted `CancelIoEx`. If terminal completion cannot be proven, the
process fails fast to avoid releasing live kernel memory. Once a request write
has begun, a transport failure is `outcome_unknown`, never `no_effect`.

`-p:CoordinatorClientFixtureTests=true` compiles a separate synthetic,
same-user fixture. It uses a nonce-scoped pipe only in the fixture image and a
synthetic service snapshot source, so it does not prove SCM-to-pipe authority.
Its DACL grants the current user exact `0x00100083` client rights. The focused
tests cover exact reply, live-name second server instance denial, wrong server
zero-send, changed/missing service and expired pre-write deadline zero-send, malformed and oversized reply,
stalled read and write cancellation, and disconnect. This aligns with the
independently reviewed PIPE-RIGHTS-001 and PIPE-OVERLAPPED-001 controls on this
host; those controls were same-user and medium-integrity. Cross-account service
access, protected selection, image custody, activation, and effectful execution
remain separate qualification work.

On native Windows with the .NET 8 SDK and npm dependencies, run:

```powershell
pwsh -NoLogo -NoProfile -File .\services\windows-coordinator-client\verify.ps1
```

The verifier builds normal and gated NativeAOT images under
`artifacts/windows-coordinator-client`, checks the ordinary refusal and gated
tests, runs the npm package boundary validator, and records bounded command,
cwd, duration, exit, output hash/tail, source hashes, and image hashes in
`artifacts/windows-coordinator-client/verification-receipt.json`. These are
uninstalled review artifacts. It removes only this project's checked `bin/`
and `obj/` directories after the run; published review images are retained.
