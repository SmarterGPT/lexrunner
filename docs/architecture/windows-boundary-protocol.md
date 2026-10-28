# Windows boundary negotiation codec

This implements the first wire-contract slice for ADR-011 / #890. It is a pure
codec and metadata comparison, not a launched broker, authenticated helper,
qualified boundary or new production route. The Windows resolver still reports
`helper_missing`. Existing #955 stable-file proof work is separate and untouched.

Each control frame contains a four-byte unsigned big-endian payload byte length
followed by UTF-8 canonical JSON using LexRunner's canonical serializer (sorted
object keys, two-space indentation and terminal newline). Payloads are limited to
4 KiB. The negotiation decoder retains fixed header/payload storage, accepts
fragmented or coalesced input and enforces a lifetime budget of 16 frames and
16 × (4 + 4096) bytes. It is for negotiation, not an unbounded operations stream.

The initial strict v1 message set is `hello` and `hello_result`. Both carry the
exact protocol version, request ID and a client-generated 256-bit nonce. The
response adds a fresh helper session nonce and reported artifact SHA-256,
architecture and process ID. Callers must generate nonces cryptographically;
the codec only validates their representation. Unknown fields, unsupported
versions, duplicate JSON keys, invalid UTF-8/BOM, noncanonical representations,
oversized frames and truncated EOF fail closed with fixed errors. Any decoding
failure is terminal. A failed coalesced push returns no messages from that push;
messages returned by earlier pushes remain historical input.

`assessWindowsBoundaryHello` compares the response's request/client nonce and
reported helper metadata with a specific caller-supplied launch record. Even a
match reports `verification: not_performed`. Matching claimed digests or PIDs is
not binary authentication, process ownership, release-signer trust, a self-probe
or proof that a nonce is fresh. No lease or filesystem capability is issued.

The [owned handshake probe](owned-windows-boundary-handshake.md) now exercises a
one-shot development child with private pipes, a deadline and explicit cleanup.
It remains non-authorizing and does not supply a production helper.

## Correlated no-effect file replies (2.2.0)

Protocol `2.1.0` added a strict `file_missing` reply for a `read-file` request.
The native helper emits it only when a handle-relative file open fails with
Windows error 2 or 3 and the held parent still passes `AssertCurrent`. It echoes
the session, lease token, request and operation identities, and request digest.
The caller accepts it only for the matching pending read. It carries no file
contents or file identity, means no file read effect, and keeps the helper and
child scopes live for later work and confirmed release. Other native errors and
unexpected or malformed replies remain terminal. The portable lease maps the
correlated absence to `invalid_path` with `no_effect`, allowing the broker to
preserve ambiguous ownership without removing a worktree.

Protocol `2.2.0` adds a strict `file_exists` reply for a `create-file` request.
The native helper emits it only for the exact `STATUS_OBJECT_NAME_COLLISION`
returned by an atomic handle-relative `FILE_CREATE`, after reasserting the held
parent chain. No target handle was opened and no bytes were written. The reply
echoes the session, lease token, request and operation identities, and request
digest; it carries no file content or identity. The caller accepts it only for
the matching pending creation, records an acknowledged no-effect attempt, and
keeps the helper session live. Other native create failures and malformed or
uncorrelated replies remain terminal.

Version checks remain exact. An installed `2.0.0` helper cannot negotiate with
the `2.2.0` client; it requires a separately reviewed upgrade. The `2.1.0`
development helper also cannot negotiate with the `2.2.0` client. This protocol
change does not activate a helper or establish production readiness.

Production integration must bind these frames to owned inherited private pipes, verify
the actual helper artifact against independently trusted release metadata and
signer policy before launch, correlate replies with the actual child, enforce a
handshake deadline and one accepted handshake, and retain explicit cleanup
uncertainty. Root handles, operation capabilities, native conformance, package
distribution and resolver readiness remain separate implementation gates. Do not
promote either the codec or the development proof into a ready backend.
