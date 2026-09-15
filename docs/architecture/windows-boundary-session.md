# Bounded persistent development session

`probeOwnedWindowsBoundarySession(options, rounds)` connects the reviewed exchange
tracker to the existing owned-process lifecycle and the actual NativeAOT peer.
It performs hello followed by up to15 sequential session-status requests in one
process, then closes stdin and observes cleanup. Zero rounds retains the original
hello-only probe. This Node probe exposes status only; the native development peer
also supports the separate [directory lease profile](windows-boundary-directory.md).

This uses fixed `--boundary-session 1.0.0` arguments. The original
`--boundary-protocol 1.0.0` remains hello-only and rejects extra input. The Node
decoder accepts session frames only when explicitly constructed in session mode;
negotiation parsing remains closed to these messages by default. Negotiation retains its 4 KiB frame limit; explicit session mode allows 96 KiB
frames and at most 16 frames (1,572,928 framed bytes per direction). This is a bounded
development conversation, not the final unbounded worker operations service.

Each `session_request` binds client/session nonces, request ID, operation ID,
protocol version and literal operation `session-status`. `request_digest` is SHA-256
of the canonical request with that digest field omitted. The native peer validates
the digest and exact canonical complete request, rejects reused request/operation
IDs, and replies `session_result` with those correlation fields and `status: alive`.
The owner strips only the separately validated kind/version/status fields before
passing correlation to the exchange tracker. `alive` describes this response;
it is neither a lease receipt nor ongoing liveness, authentication or custody.

The owner reserves before writing, allows one outstanding operation, sets a fresh
operation deadline, and checks the tracker deadline at reply receipt. Timeout,
malformed response, EOF or clean child exit with missing operations fails the run.
No request is resent. Failure retains the outstanding identity as requiring
reconciliation. Matched counts remain historical observations even if later cleanup
fails. EOF/termination uses the existing owner, constructed environment, pipe and
cleanup handling; no second process ownership mechanism is introduced.

The native helper has no standalone idle timer: the owning Node process enforces
deadlines. Partial input and parent death remain subject to inherited-pipe lifetime;
this does not qualify escaped descendants, active leases or hostile containment.
Self-reported digest and supplied expectation remain non-authenticating. Production
resolution stays unavailable. The protected installation profile is still separate.

Validation adds real native2/15-round sessions and native rejection of wrong session,
wrong digest and duplicate requests. Controlled Node peers separately exercise
unanswered-operation timeout and exit0 before reply, asserting no resend. The
existing native negotiation, codec and exchange suites remain regression checks.
Build/run using the explicit native executable described in
[native helper negotiation](../security/windows-native-helper-negotiation.md).

The directory profile is also available through a scoped owned Node adapter;
see its linked contract for deadlines, failure disposition and remaining operations.
Do not advertise WorkspaceBoundary readiness
or route the verifier based on this status-only development probe.
