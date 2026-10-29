# Manual owned ETW schema calibration

Status: ignored source candidate based on LexRunner `5dd3d5e` main; no ETW
session, Git probe or workflow has run while preparing it. This is a
diagnostic, not a protected helper, loader closure or execution authority.

The separate `windows-owned-etw-manual.yml` runs only through
`workflow_dispatch` on `main` on a fresh GitHub-hosted `windows-2022` VM.
It requires the exact reviewed commit and a previously read-back fixed Git
image SHA-256. The separate manual `windows-owned-etw-git-inventory.yml`
reads only `C:\Program Files\Git\mingw64\bin\git.exe` on a hosted
`windows-2022` runner and uploads a bounded digest receipt for one day. Its
readback digest supplies `expected_git_sha256` for a later calibration
dispatch; the later runner rehashes the image and refuses if it changed.
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
