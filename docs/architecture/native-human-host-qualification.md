# Native human host qualification probe

This source-only probe composes the reviewed native presentation adapter and
SQLite human-question service with MCP. It tests the host display and durable
recovery path with one synthetic question. It has no signer or trusted verifier;
the observation port always returns null. No captured input can become an
authenticated answer, a worker response, a completed receipt or action permission.
The workspace and worker observations are explicit fixtures. No worker exists.

The next desktop observation should establish whether the actual host renders the
source adapter's exact form and returns its response. It does not establish that
schema-valid content is fresh human input, prove human identity or isolate the
coordinator from a hostile same-user process. Protected admission and actual worker
containment/consumption remain separate dependencies. Passkey/OIDC remain optional
host choices. See [host answer trust](worker-human-answers.md) and
[source adapter boundaries](worker-human-input.md).

## Run in an isolated diagnostic directory

Use the canonical checkout and its installed, pinned Node/tsx dependencies:

```text
node --import ./node_modules/tsx/dist/loader.mjs scripts/probe-native-human-host.mjs <absolute-native-host-directory> [timeout-ms]
```

The directory basename must be `native-host-*`. Use a new, empty folder dedicated
to this diagnostic, separate from the shared Runner database and historical UI
samples. Existing unmarked nonempty directories, invalid markers and changed
sample specifications are refused. A marker, a private synthetic coordination
database and a separate telemetry database are retained there. Never reset an
existing sample to repeat a test. A source or dependency change requires fresh
review and a recorded artifact/runtime comparison before drawing new conclusions.

The server offers three tools with strict empty input objects:

1. `status` reads bounded state and the last sixteen protocol observations. It
   never presents a question. Server restart also never presents one.
2. `present_sample` is for explicit human readiness. It claims one display through
   the source service before sending. A second call after that display refuses
   with `explicit_recovery_required`.
3. `recover_sample` is for explicit human return/recovery intent. It retains the
   same question and creates a fresh presentation/challenge. An active display,
   competing controller, stale binding or exhausted history still blocks recovery.

There are no answer, actor, key, approval or default-selection arguments. Tool
description/intent fields do not independently authenticate human readiness.
Operators must not treat a model-initiated call as proof that a human requested it.

Timeout is explicit, 150..30000 milliseconds; the desktop default is thirty seconds.
Skip/decline, cancellation and expiry retain the question and its hold. If a host
returns valid selected content, `valid_host_input_observed` records only answer
count and digest; it is not authenticated human evidence. The source adapter then
closes that display with `failed` at `host_admission`, because this probe deliberately
has no qualified admission port. This expected result does not invalidate a
successful form observation. No raw answer body is returned in compact status.

Each process uses a distinct controller identity and a sixty-second lease.
Orderly shutdown cancels any active presentation, then releases its own lease and
closes the stores. After an abrupt crash, a competing live lease can delay recovery;
no forced takeover or automatic prompt occurs. A visible expired desktop form may
remain selectable: use a fresh explicit recovery, and keep the old form observation
separate from answer admission.

## Evidence and limitations

Controlled tests exercise protocol accept/decline/cancel, malformed content,
unsupported capabilities, strict argument rejection, timeout/late reply, SQLite
reopen, competing controllers and explicit recovery. A real stdio child tests the
source CLI startup, bounded status and tool inventory without a UI request. These
are synthetic clients, not desktop human qualification. Preserve exact source,
dependency and runtime evidence alongside any later desktop observation.

The desktop probe's local files are diagnostic data, not production human trust,
worker containment or frozen integration inputs. No public package entrypoint,
default controller, game process, shared Run/Attempt or Goal is enabled.
