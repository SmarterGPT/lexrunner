# Owned Windows Git loader trace: manual calibration candidate

Status: **ignored source proposal, no active capture, not promoted**
(2026-10-28). The independently reviewed ownership seam is extended with
a guarded `--capture-calibrate` route for one manually dispatched disposable
GitHub Windows runner. Ordinary `--capture` still refuses. No ETW session,
Git fixture, installer, service, or registry selection was started or changed
while preparing this draft. Every result keeps
`authorizesLoaderClosure=false` and `authorizesExecution=false`.
See `MANUAL_CALIBRATION.md` for the privacy, Job-at-creation and later
loader-closure boundaries.

## Contract and correction to the older xperf plan

Use the fixed descriptive session name `LexRunner Windows Git Loader
Qualification`, a **fresh session GUID** per run, and a fresh restricted ETL
path. The name stays fixed: Microsoft says not to append random digits to ETW
session names. This is a system logger with `EVENT_TRACE_SYSTEM_LOGGER_MODE`,
not the deprecated `NT Kernel Logger` name or `SystemTraceControlGuid`. A
running session with this name, or any failed `StartTraceW`, is occupied or
uncertain and is never reused or stopped by this run. Do not implement an
automatic orphan cleanup; it would turn stale/foreign state into authority.

The proposed native fields are `EVENT_TRACE_FILE_MODE_SEQUENTIAL |
EVENT_TRACE_SYSTEM_LOGGER_MODE | EVENT_TRACE_STOP_ON_HYBRID_SHUTDOWN` (`0x02400001`), 64 KiB buffers, 64 minimum and
128 maximum buffers, and a 128 MiB file cap. `EnableFlags=0x16000307` selects
process, thread, image load, file IO, file IO init, disk IO and file-name
events, plus explicit suppression of unrelated system-configuration rundown. The `DISK_FILE_IO` file-name flag requires `DISK_IO`; the extra disk
events may make the 128 MiB limit or three lost counters fail, in which case
the capture refuses. The exact flags and limits need an isolated-host
calibration. Do not silently relax them to obtain a pass.

`StartTraceW` success yields a handle. The native adapter owns that handle in
a locked, one-shot state gate: it refuses a second start, foreign/replayed
query or stop handles, simultaneous queries, and a second stop. Query and stop
use the **exact owned handle** with a null name; no caller-supplied or
query-discovered name is a stop target. Each query invalidates the previous
match until it reads back the fixed name, fresh GUID, exact ETL path, mode and
flags. The ETL path must be strictly shorter than 1,024 UTF-16 code units so
the bounded reader can see its terminating NUL. A failed, incomplete or
mismatched query makes the gate uncertain: no stop or retry is attempted;
retain the dedicated host for operator inspection/reset. After confirmed
identity, one stop attempt is allowed even if counters show loss, because
loss invalidates analysis but does not make a known owned session foreign.
A nonzero stop result has uncertain disposition and cannot be retried:
Microsoft says `ERROR_MORE_DATA` on STOP can mean the session was already
stopped. No `-stopall`, xperf `-d`, update, alternate name, circular, append,
preallocate, or new-file mode.

The source-only `OwnedTraceTransaction` selftest still uses fake adapters.
The manual route uses `NativeTraceAdapter` and a source-built fixed Git
fixture for one `git --version`; it does not run import/stage/publish. Its
subprocess ETL parser records only bounded TDH schema metadata. Unknown
emitted schemas are diagnostic data; timeout, uncertain ownership, nonzero
loss, uncertain STOP, parser failure or uncertain raw ETL deletion refuses
upload. The fixed-name occupancy check is read-only. A failed Start never
owns the existing session.

The ETL is host-wide and can reveal unrelated process names and paths. The
manual workflow uploads only an at-most-8-KiB schema summary for one day
after verified raw ETL deletion. It never uploads host-wide paths, event
payloads, stdout, ETL or parser exports. This first capture is calibration:
unknown MOF schemas are bounded diagnostic data. A schema inventory and one
root creation FILETIME do not establish complete child/image/FileIo
correlation, loaded-byte continuity or protected loader closure.

## Local source evidence

Run from `D:\dev\lexrunner`:

```powershell
dotnet run --project .\services\windows-coordinator-git\owned-trace\OwnedTraceDraft.csproj -c Release -- --selftest
dotnet .\services\windows-coordinator-git\owned-trace\bin\Release\net8.0-windows\OwnedTraceDraft.dll --capture
dotnet .\services\windows-coordinator-git\owned-trace\bin\Release\net8.0-windows\OwnedTraceDraft.dll --capture-calibrate
```

The first command compiles the native binding and runs only synthetic tests.
On this Windows x64 host it returned exit 0, verified the
120-byte native property layout, and passed 42 cases: failed/occupied start,
zero/invalid or foreign handles, second start, overlapping or mismatched
query, all three nonzero loss counters, one clean stop, two no-retry uncertain
stop outcomes, the 1,023/1,024-code-unit path boundary, x64 ETL consumer ABI,
metadata-name bounds, and bare calibration refusal. The second and third
commands return exit 3 before ETW. This is source consistency, not a hosted
ETW capture or a qualified Git dependency graph.

## Hosted source gate

The `windows-bootstrap` CI step invokes `verify.ps1` on the hosted Windows
x64 runner. It builds the .NET project, runs `--selftest`, invokes bare
`--capture` and `--capture-calibrate` only to require exit-3 refusals, and
records command, cwd, duration, exit code and bounded output hashes. The verifier checks all 42
individual selftest results, plus 39 pure ordered-preflight/status-grammar cases and49
status sanitizer controls. No extra selftest starts ETW. `Test-ReceiptBounds.ps1` checks the exact
source-only schema, case counts, five expected command results, false
trace/authority fields, strict UTF-8
with LF and a receipt at most 8 KiB. The upload action receives only the
verified `verification-receipt.json` for one day **only when both the source
gate and receipt-bounds gate pass**; it never uploads raw stdout, ETL or
host-wide paths. It uses the existing .NET SDK setup; no helper, service,
registry selection or npm install is part of this source gate.

Local verifier command (use a **fresh** destination under the repo's ignored
`artifacts` directory):

```powershell
$stage = Join-Path 'D:\dev\lexrunner\artifacts\windows-owned-etw-source' ('qualification-local-' + [guid]::NewGuid().ToString('N'))
pwsh -NoLogo -NoProfile -File .\services\windows-coordinator-git\owned-trace\verify.ps1 -ArtifactDirectory $stage
pwsh -NoLogo -NoProfile -File .\services\windows-coordinator-git\owned-trace\Test-ReceiptBounds.ps1 -ArtifactDirectory $stage
```

The ignored manual candidate's local build, selftest and bare-refusal checks
passed. No active route was invoked. Hosted source CI and exact-head review
remain required for this candidate.

## Primary sources

- [SystemTraceProvider session configuration](https://learn.microsoft.com/en-us/windows/win32/etw/configuring-and-starting-a-systemtraceprovider-session)
- [EVENT_TRACE_PROPERTIES and fixed descriptive names](https://learn.microsoft.com/en-us/windows/win32/api/evntrace/ns-evntrace-event_trace_properties)
- [StartTraceW and system logger limits](https://learn.microsoft.com/en-us/windows/win32/api/evntrace/nf-evntrace-starttracew)
- [ControlTraceW STOP semantics](https://learn.microsoft.com/en-us/windows/win32/api/evntrace/nf-evntrace-controltracew)

The first active manual hosted calibration run40985948951 produced no uploadable
summary. Its unsurfaced status cannot identify the failing component. The current
status/2 controller logs only finite validated reason and phase codes, then keeps
the workflow failed. No summary or raw ETL is uploaded for preflight or uncertain
capture outcomes. See `MANUAL_CALIBRATION.md` for the exact diagnostic boundary.

The status writer and sanitizer reject cross-field contradictions: calibration success has no native failure fields, and ownership, STOP, Job, census or cleanup uncertainty never supplies a summary. Only failed Start with an observed nonzero code can retain native failure fields in a deletion-proven refused summary. Pure controls cover every uncertainty reason, all four native phases with success, and incompatible refusal/native pairs.

The hosted terminal profile requires exactly flags0 after successful owned-handle
STOP; at that correction both active queries required exactly0x06000307.
The newer no-system-configuration profile below supersedes that active value. Name, GUID, path and
mode stay exact. Zero terminal flags were observed on the qualified disposable
host and are not a universal ControlTrace API guarantee. Other terminal values
refuse; no active-or-zero allowlist or ignored flag bits are used. See
MANUAL_CALIBRATION.md for the exact observed run and status/5 phase grammar.

## Explicit no-system-configuration diagnostic profile

The current requested and active read-back profile is exactly0x16000307:
the former0x06000307 required event bits plus EVENT_TRACE_FLAG_NO_SYSCONFIG
0x10000000. It retains Process, Thread, Image, disk/file-name and FileIo events
while explicitly omitting automatic system-configuration rundown that is outside
this Git diagnostic's purpose. Post-STOP flags remain exactly0. Old active
flags, missing required bits and unknown additional bits refuse; no flag mask or
alternative profile is accepted. Private status/6 binds the mismatch grammar to
this active value and rejects older private status versions.

Run41156593717 atd45e13c6 confirmed owned STOP, terminal Job drain and deletion
of its raw ETL, but its unfiltered schema census refused the aggregate4096
property-name character budget. The failing provider/schema was not retained;
system configuration is not proven to have caused that overflow. Omitting it is
scope/privacy minimization, not a guaranteed cure. All parser/allocation/schema/
name/output/time/loss/header/cleanup caps and gates remain unchanged. The parser
still processes all captured schema families; it does not filter inconvenient
events or report a partial census as complete. Required event payload grammar,
lifetime/image/file binding and volume-map qualification remain separate work.

The refused census replaces its header/count fields with defaults. Its zero
header-loss fields and false header-end validity therefore do not establish raw
header observations. The same run's three Job processes also fail the existing
one-process fixed Git profile independently of census. That refusal remains;
neither their identities nor a permitted count increase is inferred here.

No ETW or Git child runs during source qualification. One new exact-main
disposable observation may follow independent review and required CI. All
execution/loader/helper-readiness fields remain false. Earlier uncertain runs
gain no retroactive cleanup proof, and npm never installs the optional helper.

Primary references:
https://learn.microsoft.com/en-us/windows/win32/api/evntrace/ns-evntrace-event_trace_properties_v2
Windows SDK10.0.26100 shared/evntrace.h defines NO_SYSCONFIG as0x10000000.
