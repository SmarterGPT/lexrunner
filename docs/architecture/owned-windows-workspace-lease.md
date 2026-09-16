# Owned Windows portable lease adapter

`acquireOwnedWindowsWorkspaceLease` composes the existing live native root session
with the complete `WorkspaceBoundaryLease` method surface. It is a development
entrypoint, absent from production resolution. The supplied capability-decision
digest is association data; it does not authenticate provisioning or establish
readiness. The signed helper's qualification also does not establish protected
runtime selection or launch. No caller-supplied receipt reconstructs a native scope.

The adapter captures repository/allocation roles, opens or creates children, asserts
identities, reads files, creates exclusive files, runs processes and closes the
original owner. It maps native volume/file IDs into existing portable identity
receipts. Operations are serialized by rejection of concurrent calls, not queued.
Portable operation IDs cannot be reused within a lease.

Broker operation IDs and native request/operation IDs remain distinct. Immutable
owner snapshots retain native request digests and acknowledgment observations;
`snapshotAssociations` returns detached copies of their association with each
portable operation. The completed report retains acquisition and release attempts,
file creation evidence and process attempts. These are observations, not durable
delivery or verifier acceptance. The next integration must retain these records
alongside portable receipts through the existing delivery/recovery boundary.

File and process completions pass through the existing native receipt projectors
before a portable success is returned. Explicit POSIX creation modes, nonexclusive
writes, and process directory-argument components/suffixes are unsupported and
rejected before native dispatch. File bytes, command arguments and environment are
snapshotted before asynchronous work. Environment merging follows the existing
Windows case-insensitive environment helper. Ordinary process nonzero exit remains
a completed boundary exchange with a failed command result.

Pre-aborted commands do not dispatch. Cancellation after dispatch aborts the owned
session; it does not promise graceful child completion. A missing acknowledgment
leaves potential mutation/process effects unknown and nonretryable. The raw owner
report remains available via `completion`. Ordinary work-window expiry preserves
the existing bounded graceful drain. Close awaits the original session and requires
all release acknowledgments and closed transport before issuing a terminal lease
receipt. Unconfirmed release rejects rather than manufacturing a released receipt.
Repeated close returns the same completion; requesting reconciliation does not prove
reconciliation and therefore does not produce a `reconciled` receipt.

Actual native tests cover directory/file operations, held-cwd Node/Git execution,
snapshot behavior, unsupported options, foreign capability objects, operation-ID
reuse, concurrency, cancellation and expiry. This is not yet the complete broker
create/observe/preserve/remove lifecycle, crash recovery or installed production
qualification. No native source or protocol change is needed for this adapter.
