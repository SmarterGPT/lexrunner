# Bounded native file reads

The development session accepts `file_request` with operation `read-file`, a live
directory token, one `component` and integer `max_bytes` from 0 through 1024. This
small binary read profile fits the existing 4096-byte frame limit. It is not the
final arbitrary-size file transport or production WorkspaceBoundary adapter.
File requests share the directory/status replay sets and 15-operation budget.

The helper validates the canonical request, nonces, IDs and digest before opening
anything. It validates the single component and parent chain, opens a disk file
without following a reparse point, and shares read access only. Ordinary concurrent
write/delete access conflicts are rejected by this handle profile. It checks the
final path, volume/filesystem, file identity and size, reads at most the bound plus
one rejection byte, and checks size/identity and parent handles again afterward.
Oversized content produces failure, never a truncated successful reply.

The file handle is closed before emitting success. An uncertain close prevents
success. The directory lease remains live after a successful read. Failure is
terminal for this development session and returns no partial-content frame; caller
cleanup/outstanding-operation evidence still applies. No automatic retry is added.

`file_result` binds the originating request and directory token and includes exact
base64 bytes, byte length, content SHA-256, file ID and volume serial. The content
digest describes those returned bytes; it is not a trusted expectation, signature,
verification result or reusable file capability. Consumers must check canonical
base64, length against the requested bound, digest, correlation and parent binding;
the structural codec alone does not establish those semantic relationships.

This is bounded observation, not an atomic snapshot or a claim against existing
writable mappings, kernel access or every filesystem race. File identity is checked
on the held file handle; content continuity after close is not promised. Access
may affect OS access metadata. The file can be renamed again after the read handle
closes, while directory/ancestor handles remain held.

Eleven real native tests cover 0/1/257/1024 binary bytes, Unicode filenames, file
handle release, missing/oversized targets, directories and junctions, stream and
traversal rejection, and an already-open writer. Tests run on the actual ReFS host;
they do not qualify all NTFS/ReFS versions or file-symlink/forced-close failure cases.

The owned Node scope now exposes `readFile(component, maxBytes)` on initial and
child scopes. Its frozen result contains `bytes`, `contentSha256`, `fileId` and
`volumeSerialNumber`, marked `kind: file_read`. It checks canonical base64, byte
length, the requested bound, digest, parent token/volume and full request correlation
before resolving the caller's promise. A directory-result frame cannot complete a
read. Bad or missing replies fail the session with outstanding identity preserved;
there is no resend or partial-content delivery.

The bytes are a separate caller-owned Uint8Array and may be modified. The digest
describes the original returned bytes, not subsequent caller edits; a consumer
must recompute it before relying on modified content. This result remains an
observation, not a WorkspaceBoundary verification or authority receipt.

Reads share the existing one-outstanding-operation rule, work and request deadlines,
scope expiration and release capacity. Their input bounds and component syntax are
checked before sending. Unawaited reads fail the scope without an unhandled promise
rejection. Reports count matched reads and bytes separately from release acknowledgment;
those counts remain historical observations if later work or cleanup fails.

Three actual-native owned tests cover nested binary reads, private returned bytes,
empty reads and unawaited-request disposition. Nine controlled-peer cases exercise
wrong length/digest/token/volume/operation/kind, noncanonical base64, over-bound data
and unanswered requests. Existing raw native tests remain regression evidence.

Next implement writes, process operations and existing verifier receipt
mapping. Production resolution remains `helper_missing`; launch trust and full
operation guarantees remain independently required.
