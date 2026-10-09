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

## Bounded delivery reconciliation

`recordWorkerAnswerObservation` retains up to sixteen immutable host observations
per send claim in the existing Run journal. Each strict observation binds the Run,
question, full capture hash, admitted answer hash and delivery claim; it carries an
observation ID, timestamp, evidence digest and a bounded kind. Exact replay reads
the existing record, even after a lost storage acknowledgement; a conflicting ID
or full history is refused without eviction. Current controller fencing and Run
revision still guard mutations. Observation times precede neither claim nor
admission and cannot be in the future at recording.

`request_cleared`, `matching_answer_output` and `delivery_uncertain` are host
observations, not consumption certificates. Their kind and digest do not prove
provenance or truth. A protected host must retain the referenced evidence itself
and qualify its interpretation. Recording remains possible after the delivery
deadline, worker termination or workspace change because it preserves history;
it does not authorize action against that historical context. A superseded or
settled question, wrong binding, stale controller/revision or `not_sent` delivery
is refused. No completed worker-question receipt is enabled.

`inspectWorkerAnswerDelivery` provides bounded read-back without answer bodies,
signatures or raw event text. It reports the hold, delivery disposition and
observations with `consumptionQualified:false` and `resendAllowed:false`. No
observation turns a local write into confirmed consumption or removes uncertainty
from the delivery journal.

The owned Codex adapter captures its first exact typed `serverRequest/resolved`
event after an answer write was attempted. It binds that cleanup observation to
the persisted claim before sending, retains it in a bounded queue and offers
`persistNextAnswerObservation` to the protected host. String and numeric IDs stay
distinct. Pre-answer cleanup creates no answer observation; duplicate cleanup is
ignored. Lost storage acknowledgements retain the queued record for exact replay,
without another native answer. This event can describe prompt cleanup, so even
its successfully persisted observation keeps the human hold active. Process loss
before persistence can lose this diagnostic event; it never permits a resend or
inferred consumption. This source slice installs no host and exposes no CLI/MCP
answer or observation route.

## Exact native answer-output content

`matchCodexHumanAnswerOutput` checks a strict, bounded Responses
`function_call_output` against a persisted Codex question capture and signed
answer. It requires the captured native item ID as `call_id`, the exact portable
request/Run binding, and the exact JSON result bytes emitted by the owned adapter.
It refuses additional source fields, missing/extra answers, duplicate JSON keys,
changed whitespace inside authored text, Unicode normalization and alternate
JSON rendering. It deliberately checks this adapter's serialization rather than
normalizing arbitrary provider bodies. String and numeric server request IDs
remain distinct in capture validation; neither is substituted for the item ID.

The result exposes bounded hashes only. Signature syntax is validated, but this
pure content matcher does not authenticate a signature, the source connection,
the provider request, or a human. Its `sourceAuthenticated:false`,
`consumptionQualified:false` and `resendAllowed:false` fields remain explicit.
Even fabricated matching bytes can pass the content check; a protected host must
separately retain and authenticate the source evidence and qualify its origin.
The evidence digest uses the existing compact canonical hash of the strict
three-field output object. Authored output text is a string and is never parsed
or normalized; a retained source object can reproduce the digest.

`recordCodexHumanAnswerOutput` is a protected source-only composition. It reads
the saved admission and existing delivery claim, runs the content check and
records a `matching_answer_output` observation through the portable service's
existing controller/revision guards. Caller inputs are snapshotted before reads.
Exact replay after a lost storage acknowledgement does not send another answer.
`not_sent` remains refused, and `uncertain` remains uncertain. The content record
neither authenticates its source nor changes the hold or authorizes an action.
No host installation, public CLI/MCP route, completed receipt or automatic retry
is enabled. Source-body retention and origin qualification remain host work.

## Retained answer-output source

`CodexHumanAnswerOutputEvidence` defines a strict, at-most-32-KiB envelope for a
host observer to append as `control_evidence` through the existing protected
capture. It retains the exact output object plus Run/question/capture/answer/send
claim bindings and observation identity/time. Encode the envelope with
`canonicalJSONStringify`, including its newline, then seal and index the capture.
The inner output string preserves authored bytes. The source-only composition
adds no automatic provider interception or new capture lifecycle.

`recordRetainedCodexHumanAnswerOutput` uses the separate host-owned independent
reader before journaling. It requires a complete, unexpired pinned capture root,
one selected frame with the exact chain digest and absolute observation time, and
canonical envelope bytes. Missing, changed, incomplete, untrusted or conflicting
evidence cannot create a new observation. It then checks the saved admission and
delivery binding through the existing output recorder and controller/revision
guards. Coordination retains only the optional opaque `sourceEvidence` locator:
capture ID/root and frame sequence/hash. The existing `evidenceHash` still hashes
the output object, rather than the container or frame. Legacy observations without
the locator remain inspectable. Locators are data; freshly hydrate and verify them
before relying on retained content. Direct protected-core callers do not acquire
verified-source status merely by supplying a locator.

A successful read reports `sourceEvidenceVerified:true`, meaning integrity
read-back only. `sourceAuthenticated:false`, `consumptionQualified:false` and
`resendAllowed:false` remain explicit. Fabricated matching bytes can still be
retained; producer origin and genuine human input remain separate host
qualification. The existing local evidence profile is Stage-1 synthetic and its
default OS protection/durability dependencies fail closed. Controlled attestors
and temporary-file tests do not qualify production isolation. No signer or
mandatory passkey/OIDC workflow is introduced.

Capture persistence and coordination mutation are separate operations. If the
source is retained but journal acknowledgement is lost, keep the sealed artifact
and replay the exact locator/observation under a current controller. This re-reads
evidence and confirms the immutable observation; it never sends another answer.
Changed locators conflict with a recorded observation. Retention loss or expiry
cannot be bypassed by an old successful read. The hold and uncertain delivery
disposition remain unchanged throughout.

## Host-owned provider ingress observation

`CodexProviderHumanAnswerObserver` is a source-only adapter for a host-owned HTTP
Responses ingress. Construct it with a write-only existing evidence capture and
the persisted question, admitted answer and exact send claim. The observer
snapshots those bindings and creates its own observation identity and time.
Attach it as the first body reader to the actual `IncomingMessage`; it does not
create a server, proxy inference, forward credentials or configure a provider.

The observer accepts only complete `POST /v1/responses` JSON requests, with fatal
UTF-8 decoding, at most 1 MiB, nesting depth 64 and 4096 input items. Each instance
serializes observation, permits at most 128 attempts, and bounds each body/append
window to at most 30 seconds. Encoded or previously consumed streams, unsupported
content types/encodings, duplicate JSON keys including escaped-equivalent names,
and duplicate/missing target outputs are refused. The selected output must have
exactly the existing three fields; optional native item metadata is refused
rather than silently discarded. Authored output text remains byte-exact.

After content matching, one canonical output envelope is appended through the
existing capture. Optional `providerRequest` metadata retains the host-created
observer ID, attempt sequence and raw request byte count/digest. No whole
prompt-bearing request body or HTTP headers are retained. This is a selected-item
projection; the digest alone cannot reproduce or independently reparse the full
request. The host seals/indexes the existing capture and uses
`recordRetainedCodexHumanAnswerOutput` for fresh read-back and fenced recording.
An uncertain append or mismatched acknowledgement blocks further use of that
observer; retain the capture and independently reconcile it instead of retrying
the append. Cancellation or stream failure while reading the body destroys the
supplied request and its underlying HTTP connection, which can affect other
pipelined or keep-alive requests. The host must own and recover that connection
lifecycle as well as its HTTP response and overall ingress.

A capture proves this observer received matching bytes. Loopback address, request
digest, constructor context and even a matching output do not authenticate the
sender as the intended Codex child, establish fresh human input, prove remote
provider receipt, qualify worker consumption or release a hold. Authority fields
remain false. Production sender/session protection and human-channel admission
are separate qualifications; this adapter introduces no mandatory passkey/OIDC
workflow, protected service installation or public CLI/MCP route.

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

## Local provider session credential

The optional source-only `CodexProviderIngressSession` allocates a fresh 256-bit
capability in host memory for one owned child launch. Allocate it with the Run ID
before spawn. `OwnedCodexConnection.open(options, session)` privately claims it
once using the connection's own capture UUID, then injects only the fixed
`LEXRUNNER_PROVIDER_SESSION` environment variable. The host separately configures
the fixed `x-lexrunner-provider-session` header through the isolated child's
provider configuration. No arbitrary environment map, ambient credential
forwarding, user-level configuration edit or provider server is added.

The transport binding hashes the Run and connection. Question and delivery claim
IDs do not exist at spawn; each later answer observer independently binds their
persisted capture, admission and claim. Its optional fourth constructor argument
must be the same session with the exact Run/capture connection binding. This keeps
the bootstrap transport identity separate from each answer's identity.

Before reading the HTTP body, the gate requires exactly one fixed header in
`rawHeaders`, canonical 32-byte base64url encoding and constant-time credential
comparison. Missing, wrong, duplicate or comma-folded credentials are refused.
The host disposes rejected requests; refusal does not drain or close their body.
A finite monotonic lifetime of at most fifteen minutes has no silent renewal.
Expiry, explicit close, bootstrap/transport failure and child exit revoke the
capability. Exit revocation precedes stdio closure, which descendants can delay.
Revocation aborts an active observer body read and may close its HTTP connection;
revocation during a possible append retains the existing uncertain disposition.
It never permits a repeat send or capture retry after an uncertain append.

The canonical output envelope retains only an optional session UUID, nonsecret
Run/connection binding hash and `credentialPossessionVerified:true`. It retains
neither the credential, its digest, headers nor environment. Fresh sealed-source
read-back and coordination journaling still use the existing composition. An
ordinary observer without the optional session remains usable; omitting the gate
does not satisfy a requirement for trusted-origin verification.

Possession is the entire guarantee. A child can copy the capability to another
client; descendants or sufficiently privileged processes may obtain it. The
controlled native 0.145 compatibility experiment explicitly accepts a separate
client holding the capability. Neither private class fields nor clearing one
buffer establishes OS custody, secrecy of copied strings/environments, protected
loading or human presence. The tested header mapping and owned lifecycle do not
qualify all Codex versions or remote provider receipt. `sourceAuthenticated`,
`intendedChildQualified` and consumption remain false. Human admission, signing
custody and action/hold-release qualification remain separate dependencies.
No signer, service, passkey/OIDC enrollment or installed package is enabled.
