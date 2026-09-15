# Native bound process execution

The development session now accepts `process_request` / `run-process`. It runs
an explicit absolute .exe through CreateProcessW without a shell. The cwd is a
live directory token; arguments are literal strings or live directory tokens with
an optional prefix represented explicitly on the wire. `relative_to_cwd` renders
`.` only for the exact cwd token. Child-component/suffix rendering is not exposed.
Explicit inherited or replacement command environments are supported as described below. Unknown/expired tokens and malformed
or noncanonical requests fail before process creation. Literal arguments are
trusted command input; this is not an arbitrary-command filesystem sandbox.

The helper asserts and retains the referenced directory chains across execution
and checks them again before acknowledgment. It renders the bound directory paths.
Executable/signer approval is still a separate launch-qualification requirement;
a caller-selected executable or successful run does not establish approved code.

## Ownership and terminal observations

A per-operation unnamed Windows Job Object has KILL_ON_JOB_CLOSE. The process is
assigned with PROC_THREAD_ATTRIBUTE_JOB_LIST during creation, before its initial
thread runs. There is no start-then-assign gap or suspended-child fallback.
Microsoft describes that failure window and the atomic alternative in
[creating a process in a job object](https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812).
Only the three dedicated stdio handles are inherited through HANDLE_LIST; the
command receives stdin EOF, not the coordinator protocol pipe. This implements a
native mechanism for the existing #837 ownership work, not a second supervisor API.

The helper waits for direct process exit or a bounded timeout/output-limit result.
It terminates the operation's job even after normal direct-child completion, then
observes zero active job processes, signaled direct-process exit and both output
readers completing. Consequently commands cannot leave an intentional background
service running through this operation. Process/thread/job handle close failures
prevent acknowledgment. Cleanup checks have separate bounded waits; command
timeout is not a bound on total reply serialization or every native API call.

Ordinary descendants remain in the job; helper loss closes its job handle and
requests termination. This does not qualify hostile escape, independently launched
external services, all spawn surfaces or the full #837 lifecycle matrix. Killing
the helper produces no completion or directory-release acknowledgment. A process
becoming unavailable by PID also does not prove immediate filesystem lock release.
The helper-loss test uses a bounded external observer for eventual fixture release;
it is not a product retry policy or proof of instantaneous cleanup.

A live reply records request/session correlation, cwd token, PID, exit code,
monotonic elapsed time, job-empty observation and one of exited/nonzero_exit/
timeout/output_limit. Output is byte-preserving base64 with per-stream truncation
flags. Command nonzero exit, timeout and overflow remain command outcomes, not
successful work or verification. Spawn/protocol/cleanup errors still end this
bounded development session without a typed operation reply; partial effects must
remain unresolved rather than being retried. The owned Node process method and
receipt projection are implemented below; explicit cancellation messages, stable
error mapping and durable receipt delivery remain pending.
EOF during a synchronous operation is read only after it completes or times out;
the owner may terminate the helper for cancellation. No responsive EOF cancellation
or durable recovery is claimed yet.

## Bounds and cost

- At most64 arguments, each rendered argument at most2048 characters, executable
  at most1024 characters and total quoted command at most30,000 characters.
- Explicit timeout1–30,000ms. This development cap is not full broker-timeout parity.
- Output bound1–262,144 bytes per stream; bytes beyond the limit cause an explicit
  output_limit result, retaining only the bounded prefix.
- Environment mode is explicitly inherit-helper or replace with validated name/value
  pairs. Raw environment values are omitted from attempt metadata. The portable
  env/extendEnv merge utility exists but awaits full boundary-adapter integration.
- Requests and ordinary replies remain96KiB, negotiation4KiB. Process results allow
  768KiB for two base64-encoded256KiB streams plus metadata.
- Session decoder payload storage starts4KiB and grows on a validated length header
  up to768KiB. Session lifetime remains16 frames, with a12,582,976-byte decoder
  ceiling. Native requests retain the smaller96KiB bound. Non-process payloads
  above96KiB are rejected after parsing. Canonical serialization and decoded copies
  have additional temporary allocation; this is not a performance improvement claim.
- Two independent synchronous pipe-reader threads prevent one full stream from
  blocking capture of the other. Their thread/serialization cost belongs in the
  runtime measurement checkpoint before fanout scaling.

Eleven actual-native cases cover real Git init/read, quoting/Unicode/empty argv,
bound cwd/prefixes, stdin EOF, exact256KiB on both streams, overflow, nonzero exit,
timeout, ordinary descendant cleanup, helper loss and foreign capability rejection.
Set LEXRUNNER_TEST_NATIVE_HELPER to the built helper and LEXRUNNER_TEST_GIT to the
actual Git executable for this suite. Skips without those inputs are not evidence.
Tests use disposable workspaces and no commits/signing. They do not qualify
power loss, all Windows filesystems/architectures, deployment or the production
resolver; helper_missing remains explicit.

## Owned Node development API

`OwnedWindowsDirectoryScope.runProcess` now invokes the native operation through
its existing owned helper session. Literal arguments are copied into a validated
request; directory arguments resolve only from scope objects registered in that
same live session. Environment mode is explicitly `inherit-helper` or `replace`
with a private copy of `env`. Unknown options are rejected before dispatch. Inherited
mode uses the helper environment; replacement mode uses the supplied block.

A request must fit the remaining work deadline and reserve room for all directory
releases. The development command timeout is 1–22,000 ms, with another 8,000 ms
reserved in the existing 30-second exchange ceiling for cleanup and transport.
This is an explicit development restriction, not full broker timeout parity or a
measurement proving eight seconds always sufficient. Expiry remains a failure
with unknown effects. Configure workTimeoutMs explicitly to cover that reservation;
the default 5-second directory work budget cannot admit process execution.

Before pipe write, the owner records a frozen in-memory attempt with request and
operation IDs, request digest and cwd identity. Only a correlated reply with valid
canonical output bytes, per-request bounds, consistent exit/status/truncation and
job-empty observation acknowledges it. Acknowledgment records a command outcome,
not task success. Nonzero exit, timeout and overflow remain explicit outcomes.
Later callback failure retains the acknowledged attempt. A lost/bad reply retains
the unacknowledged attempt; it never authorizes replay or claims no effects.

The result preserves stdout/stderr bytes in private arrays. Attempt records do not
include raw arguments/environment/output and are not durable receipts. The projection
below maps observations to existing CommandResult and boundary receipts. The full
adapter must connect those projections to durable services; it must not invent a second verifier or reconstruct authority
from these records. Whole-session cancellation uses the existing owner close/kill
path; command-specific cancellation and confirmed descendant cleanup on that path
remain unqualified. Production resolution remains helper_missing.

## Command and receipt projection

The pure development adapter `projectOwnedWindowsProcessReceipt` maps an owned
attempt and its correlated result to existing CommandResult and operation receipt
schemas. Results now carry request ID, operation ID and request digest so the
projection rejects a result from another attempt. It preserves text/newline behavior
at the CommandResult boundary; raw byte observations remain available to its caller.

A completed operation receipt means the command outcome was observed. Nonzero exit,
timeout and output limit still produce failed CommandResult values. A recorded
attempt without acknowledgment does not prove dispatch and produces an indeterminate operation receipt with
non-retryable effect_unknown. The schema now permits that spawn-process case with
not_applicable durability: managed filesystem durability and unknown command effects
are separate concerns. Existing valid receipts stay valid. The historical mutation
field classifies managed filesystem operations; false on spawn-process never means
a command cannot write files. Other indeterminate-operation rules remain unchanged.

The projection receives lease ID and timestamps from its caller and records the cwd
identity. This is not authenticated lease association, a complete command filesystem
footprint, persistence, verification or launch qualification. Wiring the durable
service must supply and validate its real lease/time association and retain request
provenance alongside the existing receipt; a valid receipt digest alone does not
prove those facts. No store writes or automatic replay are introduced here.

## Lifecycle association

The process owner now assigns a random boundary lease ID to its process session and
records wall-clock startedAt before pipe write. A validated acknowledgment records
observedAt; terminal session handling timestamps unresolved attempts without marking
them acknowledged. Times are clamped not to precede startedAt, as in the existing
boundary receipt implementation. They are local observations, not trusted time or
proof of dispatch. The boundary lease ID is distinct from the orchestration lease ID.

`bindOwnedWindowsProcessObservation` snapshots inputs before asynchronously looking
up the existing WorkspaceLifecycleStore lease. It checks exact expected lease revision,
attempt and host, case-insensitive normalized cwd/worktree equality, active status,
and that the recorded interval and lookup time fit the stored lease interval. This
initial binding supports the exact worktree root, not arbitrary child scopes or
filesystem alias resolution. The projection uses the owner's boundary ID and times;
the binding carries the stored workspace lease identity/revision and provenance fields.

Missing/changed/expired leases, lookup failure or invalid observations return an
unbound observation. Binding failure is not a no-effect execution result and never
permits automatic replay. A successful binding may still contain an indeterminate
process receipt. Input/result copies prevent caller changes during the asynchronous
lookup from replacing the observation. The store read is a point-in-time association;
it does not prove historical or continuous fencing, OS host identity, authorization,
protected launch, durable storage of the binding or full workspace readiness.

Current tests exercise the store interface with controlled lease records and retain
actual-native owner timestamp coverage. An actual durable store write/readback and
crash recovery through the existing services remain pending. Do not treat this lookup
adapter as another lease authority or a replacement for the existing verifier.

## Explicit command environment transfer

The native request now also supports environment: replace with an explicit list
of canonical UTF-8 base64 name/value pairs. This avoids Node/.NET JSON escaping
differences for non-BMP Unicode and avoids object-key ordering/prototype semantics
on the wire. The helper decodes strictly, rejects malformed/duplicate names, builds
a sorted UTF-16 environment block, passes CREATE_UNICODE_ENVIRONMENT to CreateProcessW,
and releases the allocation on every exit. Its own bootstrap environment is unchanged.

The owned API snapshots an explicit env object before dispatch. Missing env in
replace mode, env in inherit-helper mode, NUL/equal-sign names, invalid Unicode,
case-ambiguous duplicates and oversized blocks fail. Current bounds are 256 entries
and 32,767 UTF-16 code units, additionally subject to the existing request-frame bound.
Names beginning with an ASCII digit are explicitly unsupported: controlled native
observations did not preserve these through the chosen consumers, including an
independent ProcessStartInfo control. This is not a universal claim about Windows
variable-name rules. Further qualification can broaden that support explicitly.

windowsCommandEnvironment implements the portable merge: parent snapshot by default,
case-insensitive override by env, and exact replacement when extendEnv:false. It
validates rather than silently dropping ambiguous or unsupported entries. The
portable boundary adapter must use this function and replace mode; existence of
this function is not evidence that the still-missing adapter is wired. Values travel
in the command request and may affect normal program behavior; base64 is not encryption.
Raw values are not added to attempt/lease receipt metadata. Child output is controlled
by the child and is not a secret-redaction mechanism.

Tests retain the initial failed environment run. A non-BMP canonicalization mismatch
was repaired in the wire encoding. Node could not run cleanly with a fully empty
environment, so an explicit cmd.exe fixture checks the absence of TEMP without
injecting it or SystemRoot. An inherited-environment control must observe TEMP.
That control exposed a false positive in the first fixture: unconditional CRT quoting
made cmd reject the command in both environments. Arguments without whitespace or
quotes now remain unquoted, preserving CRT argv semantics; this is not a general
cmd shell-escaping contract. The original failure remains recorded.
This does not guarantee every program supports an empty
environment. Production signing, protected launch, full adapter, deadlines and
cancellation remain separate delivery prerequisites.
