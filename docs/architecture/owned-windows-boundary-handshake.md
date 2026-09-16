# Owned Windows boundary handshake probe

> Version note: the v1 limits/launch examples below are historical. Current protocol
> 2.0.0 requires a new helper; see [v2 session budgets](windows-boundary-budget-v2.md).

This is an explicit development transport probe for ADR-011 / #890. It composes
the [negotiation codec](windows-boundary-protocol.md) with one owned stdio child.
It is not the production native helper, a persistent boundary lease, executable
authentication or a resolver route. No public CLI/MCP command is added.

The caller supplies an absolute executable and cwd, expected reported digest and
architecture. The probe starts that executable with fixed arguments
`--boundary-protocol 1.0.0`, fresh stdin/stdout/stderr pipes, no shell and a hidden
Windows window. It forwards only SystemRoot/WINDIR/TEMP/TMP environment keys;
general ambient variables, loader overrides and caller-provided arguments are
excluded. The executable and its load graph are still unverified. Use this only
with an explicitly selected development peer; a production caller must first
establish independently trusted artifact/signer and loading guarantees.

One hello carries a cryptographically generated 256-bit client nonce and fresh
request ID. One matching result must echo that request and report the actual
spawned child's PID plus the supplied architecture/digest. The helper's session
nonce is returned only as a digest. A match is reported with
`verification: not_performed`; claimed identity is not authenticated identity.
Freshness of the helper's nonce remains a peer obligation, not a proven property.

After a valid result, the probe closes stdin. A conforming one-shot peer must
finish output and exit zero. The probe waits for process and pipe closure before
reporting success, rejecting duplicate replies, trailing truncated bytes, invalid
UTF-8, incompatible messages and nonzero exit even after a matching hello. A
matching hello remains historical evidence if later validation or cleanup fails.
There is no retry or second hello. The codec retains its stream budget; stderr
is counted (saturating at limit+1) and capped at 64 KiB without retaining content.

## Deadlines and cleanup

The handshake deadline is at most 30 seconds. Success or failure begins one
bounded graceful-close interval (at most 5 seconds), then one termination attempt
against the owned child if exit has not been observed. A final bounded wait (at
most 5 seconds) reports `cleanup.disposition: unknown` if close is not observed.
The original failure reason is retained separately from cleanup disposition.
Cancellation follows the same cleanup path; prior cancellation prevents spawn.
Unknown cleanup destroys local pipes and unreferences the child without claiming
it exited. Fixed errors do not include child stderr or underlying spawn messages.

`closed` records observed local child/pipe closure; it is not a general OS-resource
or descendant-process cleanup guarantee. Descendants are explicitly
`not_assessed`. This probe sends no work or capability requests and does not own a
new process-tree model. Production operations must integrate the existing #837
process-ownership contract before this transport can retain authoritative leases.

Tests substitute a controlled Node peer at the spawn boundary while checking the
requested fixed launch options. They exercise actual private pipes and processes
on Windows/Linux; fault fixtures separately simulate missing close and EOF events.
The controlled peer does no filesystem or worker work. These results do not
authenticate a NativeAOT binary or qualify NTFS/ReFS workspace behavior.

Next: actual helper artifact/signer/architecture verification, a conforming native
peer and held-root capability integration, followed by native hostile conformance.
The production Windows resolver continues to report `helper_missing`.
