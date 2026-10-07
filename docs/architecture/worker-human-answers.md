# Host-attested worker answers

The portable ADR-010 human hold now supports signed host attestations and a
durable, single-send answer journal. Its schemas and service have no Codex or UI
dependency. The owned Codex connection is the first delivery adapter. This is
source-only: it installs no signer, enrolls no identity, exposes no worker-facing
CLI/MCP answer route and enables no autonomous controller.

## Host trust and human authentication

`TrustedHumanAnswerVerifier` receives immutable trust entries from the host at
construction: exact Run, host ID, key ID, allowed actors and an Ed25519 SPKI public
key. Answers cannot supply or change those keys. Private-key PEM, other key
algorithms, duplicate key identities and duplicate actors are refused. Each
attestation signs the exact schema-validated payload using the repository's
canonical JSON rendering, including its trailing newline, and canonical unpadded
base64url Ed25519 signature. The versioned challenge domain separates this message
from other host statements. Payloads contain only fixed object keys and arrays;
question IDs remain string values rather than dynamic canonicalization keys.

A signature authenticates the configured host's assertion that it admitted a
human answer. It does not independently authenticate the human, establish that
the person saw the intended question, or prove that the host kept its private key
outside worker access. A production host must implement and qualify that human
channel and protect its signing key, trust configuration and coordinator. An
agent-supplied actor name, authentication-event ID, digest or self-signed key cannot
replace that root. Authentication-event IDs are signed audit references only.
Revocation requires rebuilding the verifier from independently authorized trust;
stored signatures are reverified before a new send claim.

Codex UI, a separate inbox and other applications remain possible human hosts.
No public authenticated Codex-app answer hook has been established. This slice
adds neither a UI nor a secret-prompt channel. A host must render the persisted
question as untrusted text and preserve its exact options and Other behavior.

## Persistence and replay

The question and hold must already be committed before the host issues a
challenge. A challenge binds the full portable request, exact capture and Run
context hash, plus a host-generated UUID, generation and a positive lifetime of
at most fifteen minutes. A live challenge cannot be silently replaced. An expired
challenge may be renewed only before an answer is admitted, with a new generation;
the hold stays active throughout. Old signed answers cannot satisfy the renewal.

Admission verifies the signature and allowed actor, exact current challenge,
answer time, request expiry, context, workspace/head and live worker identity.
Every captured question needs exactly one answer. A closed option set accepts its
labels only; free text and Other retain authored bytes. Duplicate question IDs
and answer payloads over 16 KiB are refused. Run context hashing retains special
JSON keys as data properties; ordinary compact hashes remain compatible. The
separate historical generic serializer's special-key limitation is not changed.
Its broader persistence defect is tracked in [#1033](https://github.com/SmarterGPT/lexrunner/issues/1033).

The signed answer commits before any send is attempted. Exact admission replay
confirms the existing record; different answers conflict. One immutable delivery
slot then commits under the current controller fence before transport writes.
The slot binds the whole signed answer, controller lease/fence and bounded send
deadline. Deadline is the earliest of lease expiry, challenge expiry and thirty
seconds after claim. A replayed claim is inspection, never permission to send.
Lost claim acknowledgement, takeover and SQLite reopen cannot create another
send slot. The source transport does not retry an uncertain response.

The adapter rechecks its own connection, exact typed native request ID, question
bytes, thread/turn, absence of interruption/cleanup, abort signal and deadline
after claiming. Caller inputs and windows are snapshotted before asynchronous
reads. Its response body comes only from the persisted admission; no raw
JSON-RPC answer API is exposed. String and numeric request IDs stay distinct.

The journal records `claimed`, `written`, `not_sent` or `uncertain`. `written`
means the local pipe callback completed, not that the worker consumed the answer.
A write failure or timeout can have reached the worker and is never replayed.
A lost observation acknowledgement leaves the durable claim for reconciliation.
New controllers can record uncertainty under their own fence, but cannot resend.
This does not provide atomic exclusion between a storage lease and an external
pipe, remote exactly-once delivery, descendant cleanup or native action containment.

Signed admission, a local write, native prompt cleanup and worker termination do
not release the portable hold. Captured-question completed receipts remain
refused. Qualified consumption reconciliation and dependent-action admission
are separate dependencies; timeout, silence and restarts cannot approve them.

## Evidence

Focused memory/SQLite tests exercise host signature tampering, untrusted
host/key/actor/Run, stale workspace/session/context, expiry/renewal, revoked trust,
lost persistence acknowledgements, concurrent claims, takeover and reopen.
Controlled transport tests cover typed IDs, input/window mutation, interruption
races, mismatched claims and pipe failure without replay. These use synthetic
signers and workspace ports, not a real human authentication flow.

A separate installed Codex 0.145.0 probe uses an isolated home/workspace, a local
non-inferencing Responses fixture, an ephemeral controlled signer and isolated
SQLite. The source writes its persisted answer once; Codex's next provider request
contains that exact answer as the matching tool output. The hold survives reopen
and subsequent interruption. This is bounded native conformance evidence, not a
production acknowledgement, human-authentication qualification, real workspace
lease, OS reboot, inference or action-containment proof. No account credentials
are copied. Failed and successful probe receipts remain outside the source tree.
