# Windows operation exchange bookkeeping

`WindowsBoundaryExchange` is local correlation state for the next persistent
owned-helper transport. It does not open that transport, extend the current hello
wire format, expose a native lease, perform operations, or change the resolver.
The [bounded development session](windows-boundary-session.md) now uses it in the
owned Node process for sequential status requests. The one-shot hello path remains
unchanged; no directory operations or native lease are supplied by this tracker.

The owning transport must obtain client/session nonces from its single matched
handshake, generate fresh request IDs, bind an operation ID and digest to the
exact request bytes, and reserve before attempting a write. This slice checks
representations and equality; it neither computes the digest nor authenticates
the supplied session. Future wire parsing must remain strict and byte-bounded.

Only one request may be outstanding. A second reservation cannot replace it.
Request and operation identities cannot be reused during the session, including
after a matched reply. At4096 reservations the session refuses further work;
draining/replacing the owned session and its leases is a separate lifecycle action,
not permission to discard live handles or resend pending work.

The transport passes only the decoded reply's correlation fields to `correlate`.
Client nonce, helper-session nonce, request ID, operation ID and request digest
must all match. Unexpected, duplicate, malformed or mismatched replies terminate
this exchange state. A reply after the local monotonic deadline is rejected even
if a timer callback was delayed. Invalid/backward clocks also terminate state.
The first failure and outstanding identity are preserved, and no later reply can
revive it. Returned identity/failure records are immutable snapshots.

`correlated: true` means correspondence only. The operation-specific decoder and
adapter must still assess the result, its reported effects, receipt binding and
native custody. This tracker cannot establish authorization, execution, success,
verification or cleanup. Historical correspondence is not revoked by a later
session failure, but it never certifies a native handle's ongoing validity.

Connection loss after reservation requires reconciliation, including when the
write acknowledgement was lost. It does not infer no effect or retry. The owner
must call `disconnect` on loss/cancellation and enforce idle/no-reply timers and
process cleanup; this class has no timers or I/O. A failure with no outstanding
operation still says nothing about previously acquired native resources.

Next integrate these rules with a separately bounded persistent operation codec
and native lease handling, retaining the existing process-ownership and receipt
contracts. Production readiness and the protected deployment profile remain gated.
