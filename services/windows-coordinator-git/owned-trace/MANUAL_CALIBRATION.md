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
