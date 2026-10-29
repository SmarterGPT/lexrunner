# Owned Windows Git loader trace: ignored source draft

Status: **source-only, not executed, not promoted** (2026-10-28). The source
files in this directory are an independently reviewable ownership seam
for a future disposable-host ETW capture. `Program` exposes only `--selftest`;
all other argv refuses. `NativeTraceAdapter` compiles but is unreachable from
this executable. No ETW session, Git fixture, installer, service, or registry
selection was started or changed while preparing this draft. Every result
keeps `authorizesLoaderClosure=false` and `authorizesExecution=false`.

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
EVENT_TRACE_SYSTEM_LOGGER_MODE` (`0x02000001`), 64 KiB buffers, 64 minimum and
128 maximum buffers, and a 128 MiB file cap. `EnableFlags=0x06000307` selects
process, thread, image load, file IO, file IO init, disk IO and file-name
events. The `DISK_FILE_IO` file-name flag requires `DISK_IO`; the extra disk
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

The synthetic `OwnedTraceTransaction` currently starts, queries, and stops
without any work between them. A later reviewed orchestrator must insert the
fixed Git verifiers between start and final query, enforce a wall deadline
(proposed 90 seconds per trace), monitor the ETL file cap, capture command/job
receipts, and retain uncertain roots. It must preflight the reviewed commit
and native image, Windows x64 disposable host, privilege, protected fresh
directory with no reparse ancestors, source-only/no-secret job, and available
disk. The fixed-name occupancy check must be read-only. The earlier
`NT Kernel Logger` query source is useful discovery but does not check this
new fixed name.

The ETL is host-wide and can reveal unrelated process names and paths. Keep
the raw ETL on restricted disposable storage only after a specific retention
and access decision. Do not upload it as a public artifact. A bounded public
receipt can contain hashes, counts and disposition, not unrelated raw paths.
The eventual parser needs an independently reviewed raw event grammar,
ProcessTrace/ETL header evidence, three present zero live and stopped-log loss
counters, exact root-command intervals and Job identity, unique process
lifetime keys, complete child/image/FileIo event handling and synthetic
negative controls. A path from `Image_Load` is discovery, not a handle to the
loaded bytes. Captured paths and post-trace hashes alone cannot prove file
object continuity or installed loader closure.

## Local source evidence

Run from `D:\dev\lexrunner`:

```powershell
dotnet run --project .\artifacts\windows-owned-trace-draft\20261028\OwnedTraceDraft.csproj -c Release -- --selftest
dotnet .\artifacts\windows-owned-trace-draft\20261028\bin\Release\net8.0-windows\OwnedTraceDraft.dll --capture
```

The first command compiles the unreachable native binding and runs the pure
fake-adapter tests. On this Windows x64 host it returned exit 0, verified the
120-byte native property layout, and passed 28 cases: failed/occupied start,
zero/invalid or foreign handles, second start, overlapping or mismatched
query, all three nonzero loss counters, one clean stop, two no-retry uncertain
stop outcomes, and the 1,023/1,024-code-unit path boundary. The second
command returns child exit 3 with `source_only_selftest_required`; it cannot
start a trace. This is source consistency, not a hosted ETW capture or a
qualified Git dependency graph.

## Hosted source gate

The proposed `windows-bootstrap` CI step invokes `verify.ps1` on the hosted
Windows x64 runner. It builds the .NET project, runs `--selftest`, invokes
`--capture` only to require its exit-3 refusal, and records command, cwd,
duration, exit code and bounded output hashes. The verifier checks all 28
individual selftest results. `Test-ReceiptBounds.ps1` checks the exact
source-only schema, case count, three expected command results, false
trace/authority fields, strict UTF-8
with LF and a receipt at most 4 KiB. The upload action receives only the
verified `verification-receipt.json` for one day **only when both the source
gate and receipt-bounds gate pass**; it never uploads raw stdout, ETL or
host-wide paths. It uses the existing .NET SDK setup; no helper, service,
registry selection or npm install is part of this source gate.

Local verifier command (use a **fresh** destination under the repo's ignored
`artifacts` directory):

```powershell
$stage = Join-Path 'D:\dev\lexrunner\artifacts\windows-owned-etw-source' ('qualification-local-' + [guid]::NewGuid().ToString('N'))
pwsh -NoLogo -NoProfile -File .\artifacts\windows-owned-trace-draft\20261028\verify.ps1 -ArtifactDirectory $stage
pwsh -NoLogo -NoProfile -File .\artifacts\windows-owned-trace-draft\20261028\Test-ReceiptBounds.ps1 -ArtifactDirectory $stage
```

The ignored draft's local build, selftest, refusal, and receipt-bounds gates
passed. Its exact command and receipt hashes are in `DRAFT_CI_RECEIPT.json`.
This is local source evidence; hosted CI has not run this proposed step.

## Primary sources

- [SystemTraceProvider session configuration](https://learn.microsoft.com/en-us/windows/win32/etw/configuring-and-starting-a-systemtraceprovider-session)
- [EVENT_TRACE_PROPERTIES and fixed descriptive names](https://learn.microsoft.com/en-us/windows/win32/api/evntrace/ns-evntrace-event_trace_properties)
- [StartTraceW and system logger limits](https://learn.microsoft.com/en-us/windows/win32/api/evntrace/nf-evntrace-starttracew)
- [ControlTraceW STOP semantics](https://learn.microsoft.com/en-us/windows/win32/api/evntrace/nf-evntrace-controltracew)
