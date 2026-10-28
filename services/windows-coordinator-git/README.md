# Windows coordinator Git import source

This directory is a **non-authorizing source slice** for a possible optional
Windows coordinator service. It does not connect the production broker, select
or install a helper, create a service or account, change ACLs, or clear
`helper_missing`. The npm package neither contains nor downloads this component.

`GitBundleImport.ImportAsync` accepts a bundle path, an expected SHA-256, and an
exact 40/64-hex commit pin from a future protected slot. It creates a fresh
bare mirror, verifies that the bundle exposes exactly `refs/heads/main` at the
pin, imports only that ref to `refs/heads/imported`, reads the imported commit,
and checks the bundle digest again. The only Git image path is compiled into
the source. All Git verbs, refspecs, flags, config overrides and argument
positions are fixed. No caller-supplied executable, arbitrary Git command or
source repository config, hooks, info attributes or index is copied. Every
child receives a newly constructed environment with isolated HOME, temp and
template directories; ambient `GIT_CONFIG_*` values are not forwarded. The
Windows root, system directory, `COMSPEC` and system `PATH` entries come from
validated `GetSystemWindowsDirectoryW`/`GetSystemDirectoryW` results, not an
ambient `SystemRoot` value. Each
stdout/stderr stream has an 8,192-byte live cap, and a 30-second deadline covers
process exit and stream EOF. On failure, the mirror is preserved and the
outcome reports unknown effects instead of retrying or deleting it.

The candidate child launcher now uses the direct fixed
`C:\Program Files\Git\mingw64\bin\git.exe` image, holds it, creates it
suspended with a creation-time Job and a three-handle stdio allowlist, checks
the still-suspended image path, and resumes only the bound PID. It constructs
the complete environment block, bounds stdout/stderr to 8,192 bytes and one
30-second deadline, and checks cancellation/deadline before child creation and
again before resuming the suspended PID. A canceled suspended child is
terminated and drained without running Git. The launcher terminates and
drains the Job before returning. Command records report `Canceled` separately
from `TimedOut`; only the deadline sets `TimedOut`.
Every successful command record requires terminal Job/stream/process cleanup;
the ReFS fixture records bounded active Job process snapshots with PID, parent
PID and native image path. During mirror fetch it observes two
`mingw64\libexec\git-core\git.exe` children under the direct Git process, and
Windows `conhost.exe` also appears in the Job. Short-lived descendants can be
counted without appearing in a snapshot. This is a same-user
process control, not protected Git image/loader custody, installed token or
service authority. `ImportSlot` paths and bundle digest have no authenticated
provenance in this source build; path checks are not race-free. No service-token
Git command is authorized here. Even after the fixture reads back the expected
imported commit and drained Job, it reports `UnknownEffects=true` with
`fixture_imported_host_custody_unproven` until those host boundaries are proved.

Before each fixture Git child, the source opens and holds this exact Git image
and its five observed local static DLL imports: `libiconv-2.dll`,
`libintl-8.dll`, `libpcre2-8-0.dll`, `libwinpthread-1.dll`, and `zlib1.dll`.
It checks fixed SHA-256 pins and bounded PE import-name tables, then rehashes
the held files after the Job drains. The constructed PATH contains only the
fixed Git `mingw64\bin`, OS system and Windows directories, with a fixed
`GIT_EXEC_PATH` under `mingw64\libexec\git-core`. This is an offline static
inventory. It does not observe mapped DLL paths, delay/dynamic loads, loader
redirection or the child tool's bytes. The observed libexec child is a separate
image qualification gate; these checks do not close the installed graph.

## Same-user ReFS fixture

Run from this directory in native PowerShell 7:

```powershell
pwsh -NoLogo -NoProfile -File .\verify.ps1
```

The script creates a disposable nonce root under this directory's ignored
`tmp/` on ReFS D:, with a synthetic source repository. Its source config
defines a hostile hook, fsmonitor and clean filter; `.git/info/attributes`
selects the filter, and the index has an `assume-unchanged` flag. A direct
source status runs a canary. A separate bare control imports under poisoned
ambient `GIT_CONFIG_*` and runs the hook. With the same poison still present in
the parent, the compiled fixture imports the pinned bundle into a fresh mirror
and must run zero canaries. The fixture also poisons parent `SystemRoot` while
running its native image and verifies the Windows root, `WINDIR`, `COMSPEC` and
`PATH` digest in the constructed launch blocks against a separate OS API query.
These fields are configured values passed to `CreateProcessW`, not independent
readback from inside Git or its descendants.
The script checks the mirror's config, index,
attributes and `FETCH_HEAD`. A deliberately wrong commit pin must preserve its
partial mirror with an unknown-effects disposition. The script publishes a
normal NativeAOT image and checks that it refuses the fixture route. It also
tests cancellation after bundle preflight before child creation and again
while the bound child is suspended. Both cases must leave the mirror absent;
the suspended case must prove terminal Job drain without resuming the thread.
The fixture-only cancellation routes are absent from the normal image. It then
verifies nonce containment, marker and absence
of reparse descendants before recursive fixture cleanup. A failed run retains
the exact fixture for inspection.

`GitWorktreeStage.StageAsync` is a separate source-only continuation from an
existing imported mirror. It refuses an occupied stage slot, rereads the bundle
digest, checks the imported commit and a sole bare-mirror inventory, then runs
one fixed `worktree add --no-checkout --detach` under the same creation-time
Job launcher. It reads back the stage `.git` pointer, pinned HEAD and exact
two-entry mirror/worktree registration. A positive fixture still reports
`UnknownEffects=true` and `fixture_staged_host_custody_unproven`; a failed
post-add operation retains the stage and registration with unknown effects.
These string/path observations are not held-handle or protected-slot custody.
The normal NativeAOT image has no stage or import entrypoint.

`GitWorktreePublish.PublishAsync` is compiled only in the fixture image and
requires that image to run inside its own nonce-marked fixture root. It checks
the stage pin and exact registration under the Job launcher, then opens the
stage, source parent and final parent without delete sharing. It refuses a
reparse parent, wrong-volume identity, a held final path that differs from its
exact stage or parent input, and a pre-existing final child. A native
handle-relative `NtSetInformationFile(FileRenameInformation)` call uses the
held final parent and `ReplaceIfExists=false`. The moved stage and both parent
handles remain held through fixed Job-bound `git worktree repair`, final HEAD
and registration readback. The fixture records before, after and post-repair
64-bit volume serials and full 128-bit `FILE_ID_INFO` file IDs from held and
fresh handles. It rechecks held final paths after repair. A mismatch or failure retains the observed state with
`UnknownEffects=true`; a positive result also retains that uncertainty because
the supplied roots, mirror, Git loader graph and service identity are not
protected. The ordinary NativeAOT image has no native publish entrypoint.

The fixture checks occupied stage, occupied final, junction final and canceled
pre-effect refusals. It creates no external root. Its published final contains
only a `.git` pointer because `--no-checkout` leaves tracked files absent.
Cleanup verifies the exact nonce marker, Git registration, final contents,
outside canary and reparse state before using `git worktree remove --force`
**only on that disposable empty final**; no production or worker worktree is
force-removed. The native wrong-volume branch is present but not yet exercised
with a separate volume. The remaining creation gates are a protected final
parent and service token, installed Git/loader custody, durable journal and
restart recovery, interrupted repair reconciliation, and worker ACL handoff.

The ignored `artifacts/windows-coordinator-git-source/receipt-<nonce>.json`
records exact setup and import commands,
working directories, commit, command durations and exit codes, bounded child
output and hashes, source/native image hashes and cleanup result. The verifier
drains stdout and stderr while each direct setup, build, normal-image and
fixture child runs. It caps total output at 64 KiB, captures at most 16 KiB
per stream for setup/build/refusal and 32 KiB for fixture JSON, and applies
finite deadlines. The outer result proves direct-child
exit and stream drain; it does not prove all descendants exited. The native
fixture separately checks its Git Job drain. A short-lived exit-zero noisy
child, a continuously noisy child and an idle child test the outer bounds.
NativeAOT builds use a nonce-owned copy of the C# project and linked graph
parser inside the disposable fixture root. Cleanup checks its marker, exact
ancestry and reparse state before deleting that root. Existing source-project
`bin/` and `obj/` directories are preserved.
The reviewed predecessor
is `D:\dev\smartergpt-windows\docs\experiments\windows-git-bundle-import-001`.

Remaining qualification: trusted source enrollment/freshness and bundle
custody; protected same-volume slot and mirror; installed Git image and loader
closure; cross-account ReFS and NTFS tests; malicious pack/object and
alternates/submodule cases; worker file-only handoff, observation, removal,
interruption and crash recovery. Only a complete installed-host review may
open service Git or production broker selection.
