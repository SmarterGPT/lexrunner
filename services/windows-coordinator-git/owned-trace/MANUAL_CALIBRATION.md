# Manual owned ETW schema calibration

Status: source-only diagnostic; no ETW session or Git probe has run. This is a
diagnostic, not a protected helper, loader closure or execution authority.

The separate `windows-owned-etw-manual.yml` runs only through
`workflow_dispatch` on `main` on a fresh GitHub-hosted `windows-2022` VM.
It requires the exact reviewed commit and a previously read-back fixed Git
image SHA-256. The separate manual `windows-owned-etw-git-inventory.yml`
checks only four fixed `C:\Program Files\Git` PE candidate paths on a
hosted `windows-2022` runner. Its bounded receipt distinguishes absent,
reparse, unsafe present and PE present files; SHA-256 and byte count appear
only for safe PE candidates. A second step reads each fixed path again and
checks the receipt before one-day upload. The workflow uses no caller path or
`PATH` lookup and never starts Git. Initial hosted inventory run `40813845303`
refused the original `mingw64\bin\git.exe` path as missing, empty or reparse
and produced no artifact. Corrected inventory run `40816727040` on source
`9466951ecbb2fbda580c4b0c695e3f9bada4aa86` and Windows 2022 image
`win22`/`20261026.347.1` produced an 866-byte receipt (SHA-256
`DB6B8E0957A660DA14B52930135AF7B19EC2520207390A417CE742B02E57A41D`).
It observed `C:\Program Files\Git\bin\git.exe` and `cmd\git.exe` as
PE-present, each 44,872 bytes with SHA-256
`3b64043b9e4dc225225f43ff9c1173b57493ff72e5b729accfae051eb160cca3`;
both `mingw64` candidate paths were absent. The calibration now fixes only
the `bin\git.exe` path. Its dispatch still requires the receipt's exact digest,
and both the workflow and native diagnostic rehash that path on the later
runner, refusing any mismatch. This inventory is a point-in-time path
observation, not protected image binding or a stable selection record.
Neither workflow has a trace route during inventory. The calibration job has
read-only repository permission, no persisted
checkout credential, no npm/MSI/helper install and a 15-minute timeout.
An agent can dispatch it after exact-head independent review and required
source CI under the standing workspace authorization. No new install or
retention profile is proposed.

The `--capture-calibrate` command requires the exact manual runner argv and
checks the GitHub event, repository, main ref, HEAD, runner OS, x64 and
administrator token. These environment guards prevent accidental invocation;
they do not authenticate a caller. Ordinary `--capture` remains an exit-3
refusal. The source CI invokes only `--selftest` and bare invocation refusals.

The diagnostic creates a fresh ACL-restricted scratch directory under
`RUNNER_TEMP`, a fresh GUID and a fresh ETL path. Its logger name, flags and
buffer limits remain fixed. It queries only the exact successful StartTrace
handle, runs one fixed `git --version` fixture after ownership readback,
queries again and makes at most one STOP attempt. A failed/occupied Start,
invalid returned handle, mismatched query or failed STOP never authorizes a
different handle/name stop or automatic cleanup. The fixed Git fixture uses
`STARTUPINFOEXW` with `PROC_THREAD_ATTRIBUTE_JOB_LIST` at `CreateProcessW`,
`CREATE_SUSPENDED`, no breakaway permission, a held process handle,
`IsProcessInJob` and `GetProcessTimes` creation FILETIME before resuming.
Its compile-gated manual profile selects the observed `bin\git.exe` image
for the actual child launch. The child environment contains only the
OS-queried System32 and Windows directories on `PATH`, and omits
`GIT_EXEC_PATH`; it does not guess a Git support directory or use the runner's
ambient `PATH`. The normal Git import image and environment stay unchanged.
Any child process makes the one-command probe refuse. Support-file loads
remain census data and cannot turn this inventory into loader closure.
The expected Git SHA-256 is checked against a held file handle. The
fixture reports only bounded root PID/creation time, Job count/drain,
exit/output counts and hashes; any child makes this one-command probe refuse.
The workflow also watches the diagnostic process externally for 90 seconds
and kills its process tree on timeout or output overflow. If it must kill
the diagnostic, STOP and deletion cannot be proven and no summary uploads;
the disposable VM teardown is the residual cleanup boundary.

After a confirmed STOP, a separately killable subprocess opens the ETL with
`OpenTraceW`/`ProcessTrace`/TDH and returns only bounded schema metadata:
class GUID, opcode, version, event ID, classic flag, TDH status, decoding
source, property names and counts. It never copies event payloads or raw
process/file paths to the summary. Unknown emitted MOF schemas are discovery
data. A 35-second controller watchdog kills a parser stalled without callbacks.
The parser requires an x64 ABI match, valid finalized start/end timestamps,
exact sequential/system logger mode and 128-MiB header cap, zero ETL header
`EventsLost`/`BuffersLost`, a file strictly below the cap, and bounded event,
schema, property-name and output counts. Owned live, final-query and STOP
properties must each have zero events/log-buffer/real-time-buffer loss.

The raw ETL remains only on the disposable runner. After the Git fixture and
ETL consumer have both reached a confirmed terminal state, the diagnostic
hashes the raw file, deletes the raw ETL and scratch, and verifies path
absence before writing any summary under repo `artifacts/`. If either child
has uncertain termination, it leaves the scratch for VM teardown and refuses
upload. The path-based deletion/readback is a disposable-runner hygiene gate;
it is not a same-user rename/reparse-safe deletion proof for production.
The workflow separately verifies that the run's scratch directory is absent,
then validates strict UTF-8/LF, an 8-KiB cap, exact
head/run IDs, false authority fields, deletion readback and absence of raw
paths/outputs. Only that JSON is uploaded for one day. If ownership,
STOP or deletion is uncertain, no summary is written or uploaded. A crash
can leave raw bytes on the VM until GitHub decommissions it; the workflow
does not claim secure erasure.

`calibration_observed` means only that this bounded one-command schema
census completed. It does **not** establish that every process, image and
FileIo event for Git was decoded, that short-lived descendants were bound,
or that the installed helper's loader graph is closed. Full Process/Image/
FileIo grammar, child-lifetime binding, protected image/file-object
continuity, import/stage/publish coverage, real host conformance and the
governed Attempt/CLI/MCP dogfood attempt remain separate gates. Every
summary sets `authorizesLoaderClosure=false`,
`authorizesExecution=false`, `helperMissingCleared=false` and
`productionReady=false`.

## Sanitized refusal diagnostics

The first active hosted run40985948951 at reviewed main d61 refused before a
summary became available. Its captured status was not logged, so its exact cause
is unknown; `manual_summary_missing` is not evidence of a particular ETW failure.
The controller now logs only a validated status/3 reason and phase. Preflight
checks run in fixed order and report the first failed OS/x64/event/head/runner/
ID/elevation/layout/root/digest/fixture component. Exceptions map to that same
finite component code; no environment values, paths or exception text are copied.

Preflight or capture-uncertain statuses contain no trace-start/stop assertion,
no deletion proof and no summary digest. They cannot upload an artifact. Only a
status naming an existing bounded summary proceeds to the independent summary
and ETL-deletion checker; that checker still controls uploads. Status parsing
requires strict UTF-8/LF,2048bytes, exact keys/types, no duplicates, a finite phase
and reason pair, matching exit status and false authority fields. The watchdog
logs only a constant controller refusal code with unknown capture disposition.
Every refusal still fails the workflow. No diagnostic retries Start/Stop, sweeps
logger names, or repairs uncertain cleanup. Raw ETL never uploads.

When Start/Query/Stop returns a failing observation, the status also carries only
its unsigned32-bit adapter result code (which may be synthetic) and one fixed phase (`start`,
`initial_query`, `final_query`, or `stop`). An exception does not manufacture a code; the fields stay null unless a
failed native observation was already recorded.
The controller logs those values only after exact type/range/phase validation;
preflight cannot claim a native operation. Code0 does not prove ownership,
STOP, deletion or successful capture. No system error message is copied. The
source sanitizer includes49 positive and forged/noisy/encoding controls.

The status writer and sanitizer reject cross-field contradictions: calibration success has no native failure fields, and ownership, STOP, Job, census or cleanup uncertainty never supplies a summary. Only failed Start with an observed nonzero code can retain native failure fields in a deletion-proven refused summary. Pure controls cover every uncertainty reason, all four native phases with success, and incompatible refusal/native pairs.

The manual status/3 diagnostic adds an optional `queryDiagnostic` object for
initial/final query refusals only. Existing `nativeCode` remains the adapter
result (which can be synthetic); `nativeResultCode` is the actual ControlTrace
return only when the call completed. A null native result means no native
return was observed. Fixed stages distinguish precheck, import, native, parse,
identity and lifecycle-gate refusal. Fixed parser reasons distinguish capacity,
logger/file offset, bounds, empty and termination failures. The identity mask
uses name=1, GUID=2, ETL path=4, mode=8 and flags=16, computed inside the same
ownership lock with the same exact comparisons. Only numeric mode/flags may
accompany identity/gate failures. No names, paths, GUIDs, handles, buffers or
exception messages cross the status boundary. This does not explain the prior
code13 or weaken matching, STOP ownership, summary deletion or upload gates.

The strict writer and sanitizer validate the same finite cross-field grammar.
Actual native13 is distinguishable from native success followed by synthetic13.
Pure query diagnostic controls do not invoke ETW; the same source verifier runs
them under a separate bounded command. The capture status remains capped at
2048 bytes, source receipt at8192 bytes, and query selftest output at8192 bytes.

Primary API references used for this diagnostic contract:

- https://learn.microsoft.com/en-us/windows/win32/api/evntrace/nf-evntrace-controltracew
- https://learn.microsoft.com/en-us/windows/win32/api/evntrace/ns-evntrace-event_trace_properties
- https://learn.microsoft.com/en-us/windows/win32/api/evntrace/nf-evntrace-starttracew
- https://learn.microsoft.com/en-us/windows/win32/etw/wnode-header

The declared x64 layout, allocation and exact-handle query form are unchanged.
The diagnostics distinguish raw API failure from rejected returned properties;
they do not establish which occurred on run40994639904. A started trace with
an uncertain initial query still receives no STOP, summary or upload claim.

### Explicit hybrid-shutdown behavior

Run40998465985/job123877038320 at15a827c returned native success and a sole
mode mismatch: observed0x02400001 versus requested0x02000001; the flags and
other identity checks matched. The fixed diagnostic profile now explicitly
requests sequential file + system logger + STOP_ON_HYBRID_SHUTDOWN, exactly
0x02400001. Microsoft documents that when neither STOP nor PERSIST is supplied,
ETW chooses a hybrid-shutdown default according to Session0. The installed
Windows SDK10.0.26100 evntrace.h defines STOP as0x00400000. See:
https://learn.microsoft.com/en-us/windows/win32/etw/logging-mode-constants

The capture request, native preflight, ownership observations, diagnostic
consistency grammar and offline ETL-header profile all require the same fixed
mode. No mode mask, normalization or alternative-mode allowlist is used.
Pure controls reject the old implicit mode, PERSIST instead, both hybrid bits,
an unknown mode bit, missing sequential mode, conflicting file-mode bits,
and an unknown EnableFlags bit. The status may report mismatching numeric mode
values only with the corresponding identity mismatch bit; that remains refusal.
Exact handle/name/GUID/path/mode/flags comparisons and STOP eligibility are
unchanged. This source correction does not prove new host calibration or cleanup
of the older uncertain trace; summary, loss, deletion, upload and capture bounds
remain unchanged. No local trace was started for these pure controls.

### STOP result origin diagnostic

Run41001651151/job123887205608 on9bf86cb2 passed initial and final query
matching, then refused STOP adapter code13. That code alone cannot distinguish
a raw ControlTrace return from rejected final properties. The private status/4
contract replaces queryDiagnostic with nativeActionDiagnostic for initial query,
final query and STOP refusals. The same finite fields distinguish actual native
return, parser failure and exact identity mismatch; a lifecycle-gate diagnostic
is query-only. STOP precheck/import/native/parse/identity failures remain refusals.
No names, paths, GUIDs, handles or raw returned buffers are logged.

Microsoft documents that STOP returns final properties/statistics, invalidates
the handle, and can return ERROR_MORE_DATA after stopping. These facts do not
prove this run's cause or justify accepting changed fields. The one-shot STOP
gate, exact field equality, query count, mode, flags, allocation, terminal drain,
summary/deletion/upload controls and capture/status/receipt caps are unchanged.
No STOP retry or cleanup claim is inferred from native success plus decode
failure. The versioned strict writer/parser rejects legacy query-only fields,
impossible STOP gate-stage combinations and uncertain summary claims.

Primary references:
https://learn.microsoft.com/en-us/windows/win32/api/evntrace/nf-evntrace-controltracew
https://learn.microsoft.com/en-us/windows/win32/api/evntrace/nf-evntrace-stoptracew

### Hosted terminal observation profile

Run41005438193/job123899165230 at4f9bad13 observed successful native STOP,
exact name/GUID/path/mode, and flags0 after both active queries matched
0x06000307. For this explicit hosted profile the post-STOP decoder now requires
exactly flags0. Active initial/final queries still require exactly0x06000307.
Retained active flags, partial flags, unknown bits and all other nonzero
terminal flags refuse; there is no active-or-zero allowlist and no masking.

Microsoft documents EnableFlags as provider configuration and successful STOP
as invalidating the handle. It does not promise flags0 on every Windows host.
Zero is the observed hosted terminal profile, not a universal API guarantee.
Future differing terminal states remain explicit refusals. The original owned
handle, fresh final active query, one-shot STOP, exact name/GUID/path/mode,
nonzero-native-result refusal, loss counters, deadlines, deletion, summary and
upload guards remain in force. Earlier uncertain-run cleanup is not inferred.

Private status/5 validates mismatch bits against the action's expected flags:
active for initial/final query and zero for STOP. Status/4 is rejected so its
old STOP flags grammar cannot be silently reinterpreted. Pure32-mask STOP
controls use nonzero terminal mismatches and retain both matched active queries.
No new ETW or worker child was run for this source qualification.

Primary source:
https://learn.microsoft.com/en-us/windows/win32/api/evntrace/nf-evntrace-controltracew
https://learn.microsoft.com/en-us/windows/win32/api/evntrace/ns-evntrace-event_trace_properties
