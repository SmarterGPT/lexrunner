# Native bound process execution

The development session now accepts `process_request` / `run-process`. It runs
an explicit absolute .exe through CreateProcessW without a shell. The cwd is a
live directory token; arguments are literal strings or live directory tokens with
an optional prefix represented explicitly on the wire. `relative_to_cwd` renders
`.` only for the exact cwd token. Child-component/suffix rendering and arbitrary
environment overrides are not yet exposed. Unknown/expired tokens and malformed
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
remain unresolved rather than being retried. The owned Node process method,
explicit cancellation message, stable error mapping and durable receipts are next.
EOF during a synchronous operation is read only after it completes or times out;
the owner may terminate the helper for cancellation. No responsive EOF cancellation
or durable recovery is claimed yet.

## Bounds and cost

- At most64 arguments, each rendered argument at most2048 characters, executable
  at most1024 characters and total quoted command at most30,000 characters.
- Explicit timeout1–30,000ms. This development cap is not full broker-timeout parity.
- Output bound1–262,144 bytes per stream; bytes beyond the limit cause an explicit
  output_limit result, retaining only the bounded prefix.
- The explicit environment mode is inherit-helper. It inherits the helper's
  environment; no raw environment values are emitted as evidence. This is not yet
  the portable env/extendEnv contract or a provider launch profile.
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
same live session. Environment mode must explicitly be `inherit-helper`; unknown
options (including portable env overrides) are rejected before dispatch. This
mode does not imply the command inherits the coordinator's full environment.

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
include raw arguments/environment/output and are not durable receipts. The next
adapter must map these observations to existing CommandResult, boundary receipts
and durable services; it must not invent a second verifier or reconstruct authority
from these records. Whole-session cancellation uses the existing owner close/kill
path; command-specific cancellation and confirmed descendant cleanup on that path
remain unqualified. Production resolution remains helper_missing.
