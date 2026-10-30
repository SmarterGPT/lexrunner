# Optional Windows coordinator native client source

This separate NativeAOT project is excluded from the npm package. It does not
install or activate a service, alter a registry selection or ACL, or send a
production Attempt packet. The ordinary image reports `helper_missing` for all
requests. `--status` reads the fixed `LexRunnerCoordinator` SCM entry for a
bounded diagnostic, but it still reports `helper_missing` even if that service
exists. No caller argument can supply a pipe name, PID, image path, or pin in
the ordinary image.

The ordinary `--status` path makes a read-only v3 observation of the fixed
64-bit `HKLM\Software\SmarterGPT.LexRunner.WindowsCoordinator` key through the
shared native selection-custody reader. It holds opened registry keys, refuses
registry links, checks the SYSTEM owner and protected exact DACL, requires
typed canonical v3 `ActiveSelection` and `HighWaterRevision` values, checks the
selected catalog including both fixed service names and image digests, and compares
two structural snapshots. After that candidate, it derives the fixed Program Files
generation path from the native system volume. It opens and holds each directory
from the volume root through `service` using a parent handle and fixed child
name, then retains the manifest and every graph-selected file (including Node,
JavaScript, addons, helper, Git and DLL/support files) relative to held parents
without write/delete sharing. It caches shared directory prefixes with a maximum
of 5,633 graph-directory entries. Each opened object must be non-reparse,
have a nonzero full file ID on the same volume, and report its exact final
path. It compares exact member lengths/SHA256 against the parsed graph, refuses
repeated physical leaf identities, and rechecks ancestry, manifest and all member
bytes before returning. It
observes both fixed SCM configurations, then rereads selection and SCM. The
result is only a
bounded diagnostic reason: even a structural match still reports
`helper_missing` and cannot construct a production endpoint or send a request.
The old v1 and v2 observations remain isolated as source/reference fixtures.
The initial MSI authors no v3 selection or catalog. This v3 observation does
not authenticate the publisher, retain an independent high-water across upgrades, close the
loader resolution/loaded modules beyond the supplied graph, bind running process images/tokens to the held files,
or prove cross-account access. Local NTFS and ReFS fixtures observed
`STATUS_SHARING_VIOLATION` on read-only `DELETE`-access probes against held
generation and image files; the promotion fixture dispatched no rename or
deletion. The installed Program Files profile still
needs qualification, and a later launch or loader step must retain custody
and independently verify ACLs and approved provenance.
The SCM observations
are sequential, read-only configuration comparisons; they do not prove the
service objects' DACLs, actual PIDs or loaded modules. Even an observed match
returns `helper_missing` and cannot create `SelectedEndpoint` or a generation
lease.

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
remain separate qualification work. The additional v3 pure route checks exact
graph/selection/image-role and two-service SCM comparisons with 19 synthetic
positive/negative cases. Its direct route creates no pipe or installed state;
the existing client fixture still exercises its own disposable pipe. A separate
fixture-only held-path route creates a nonce-marked directory below the fixture
image and process temp roots. It verifies handle-relative opens and that a
second same-user handle cannot acquire DELETE access to the generation or an
image while custody is held, then refuses an existing
system junction before looking for a missing descendant. It retains each
nonce-marked tiny fixture directory and reports its path: path-based cleanup
after releasing the handles would reenter a same-user mutable namespace. The
ordinary image excludes this route. Local runs on this host covered ReFS on
`D:` and NTFS on `C:`; hosted tests must report their observed filesystems
rather than imply both.

The fullgraph owner accepts one synchronous acquisition. A partial native open,
manifest/member mismatch or physical alias faults and closes the entire owner;
it cannot be retried. Acquisition, verification, bounded byte reads and Dispose
serialize under the same gate. Dispose waits for an in-flight graph operation.
No graph FileStream or SafeHandle escapes: ReadGraphMember reads at most32KiB
into a caller buffer using the retained member, and refuses after disposal.
The legacy structural OpenManifest/OpenCoordinator/OpenWorker streams still own
their own leaf handles; they are not generation capabilities. Future synchronous
WinTrust hFile/process binding must consume retained handles under this owner's
gate/lifetime without escaping borrowed references. Byte reads do not replace
that native custody or complete trusted launch. Share modes are not an ACL,
publisher/history, mapped-writer exclusion or signer qualification.

The separate fixture-only --v3-held-graph-fixture-selftest uses twelve tiny members
covering every role and nested/shared directories. Its eighteen cases (nine each
under the fixture image and process temp parents) exercise actual file/ancestor
rename and write refusal during custody, release after disposal, late hash/size/
missing-file partial failure, same-file hardlink alias, dot alias, an owned
directory junction and acquisition/read versus Dispose serialization. It retains
nonce-marked directories, including the owned junction; no path cleanup follows
released custody. It changes no installed path, service, ACL, registry or trust
store and executes none of the synthetic executable-named files. Host filesystems
are reported as observed, not inferred from drive letters. Fixture APIs and
routes are absent from normal builds, which continue to report helper_missing.

On native Windows with the .NET 8 SDK and npm dependencies, run:

```powershell
pwsh -NoLogo -NoProfile -File .\services\windows-coordinator-client\verify.ps1
```

The verifier builds normal and gated NativeAOT images under
`artifacts/windows-coordinator-client`, checks the ordinary refusal and gated
tests (including v2 registry-only no-send cases), runs the npm package boundary
validator, and records bounded command,
cwd, duration, exit, output hash/tail, source hashes, and image hashes in
`artifacts/windows-coordinator-client/verification-receipt.json`. These are
uninstalled review artifacts. It removes only this project's checked `bin/`
and `obj/` directories after the run; published review images are retained.
