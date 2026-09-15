# Bounded native file creation

This development operation serves trusted coworkers: shared visibility is expected;
accidental overwrite and uncertain completion are the problems addressed here.
It does not hide another worker's branch, restrict ordinary caller filesystem access,
or establish hostile-agent containment. Creation is an operation within a supplied
live directory scope, not a new approval ceremony.

## Creation permissions

The Attempt marker is identity metadata, not a credential or authorization grant.
The broker requests exclusive creation using backend-default permissions; it no
longer supplies a POSIX `0600` requirement. Linux still defaults to `0600` (subject
to its existing operating-system creation semantics). This change does not alter
the Linux backend or existing files.

The native Windows helper supplies null security attributes to `CreateFileW`.
Windows therefore applies the default security descriptor with ACL inheritance
from the parent directory, as described in Microsoft's
[File Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights).
The helper does not install or rewrite ACLs, guarantee a particular reader set,
or claim equivalence to POSIX `0600`. Existing workspace permissions still apply;
this operation neither broadens them nor requires read isolation between workers.
The no-sharing flag applies only while the short-lived creation handle is open;
it is not a persistent read-access policy.

The portable write request's optional `mode` is an explicit POSIX creation request.
A future Windows WorkspaceBoundary adapter must reject an explicit unsupported
mode before creating a file; it must not silently discard it. The development
helper exposes no mode argument. Supporting the broker's default case does not
require implementing POSIX-mode emulation or another ACL-management surface.
Permission observations do not authenticate marker contents: existing attempt
matching, held-directory identity and independent verification remain necessary.

## Bounded operation

`file_create_request` carries `create-file`, a live directory token, one component,
canonical base64 content and its SHA-256. Payloads are at most 65,536 bytes. Canonical
request/digest, content encoding/digest, component and parent checks precede creation.
The request shares session nonces, operation identities, replay rejection and the
existing 15-operation budget. The structural codec alone does not validate the
content's semantic relationship to its digest.

The helper uses CREATE_NEW with read/write access and no sharing, preserving an
existing target rather than truncating it. It checks the new disk-file identity and
parent relationship, handles partial writes within the content bound, calls
FlushFileBuffers, seeks and reads back through the same handle, and compares exact
bytes, size, identity and parent observations. The file handle closes before a
successful reply. Uncertain close prevents acknowledgment.

`file_create_result` reports `created`, content length/digest, file identity and
volume, bound to the request and directory token. This records a completed create,
flush call and same-handle readback at that time. It is not a crash-durability,
atomic-publication, later-content-continuity or authorization receipt. Another
coworker may subsequently inspect or change the file through ordinary access.

Failure after creation may leave an empty, partial or complete file. This profile
terminates the session without automatic deletion, rollback or retry. A missing
acknowledgment is not proof that no file was created. Existing-file collisions also
terminate this development session; typed recoverable error replies are still pending.

Real-native tests cover empty/1/257/1024/16384/65536-byte creation, independent filesystem
readback and native read identity, handle release, preservation of existing content,
creation via a child whose parent token was released, and malformed content/component
rejection before creation. Tests do not inject partial writes, disk-full, flush/close
failures, process kill or power loss. Those remain qualification work, not implied
by a successful flush or the test count.

Owned initial and child scopes now expose `createFile(component, content)`. Input
must be a Uint8Array of at most 65,536 bytes. The owner copies the bytes synchronously
before encoding/hashing and dispatch, so later caller edits do not change the
request. Acknowledgment must match request correlation, parent token/volume and
the exact submitted length/digest before the caller receives frozen `file_created`
metadata. No general overwrite option is added.

The returned session report includes bounded, frozen `fileCreations` records:
request and operation IDs, request digest, parent identity, component, content
length/digest, acknowledgment flag and observed file ID when acknowledged. Records
are reserved before the pipe write. An unacknowledged record therefore does not
prove dispatch, execution or absence of effects; it preserves what needs
reconciliation. It never triggers an automatic retry or rollback. A matched creation
remains acknowledged if later caller work or scope cleanup fails.

These records are in-memory observations returned by the live process owner, not
a durable intent journal or existing WorkspaceBoundary receipts. Parent-crash
recovery still requires the later durable receipt integration. Payload bytes and
live native tokens are not retained in these report records.

Reads, creates and child operations share request/deadline and release budgets.
Five actual-native owned tests cover private byte capture, empty files, collisions,
oversized input before dispatch and later work failure. Seven controlled reply
cases cover mismatched fields/kind and lost acknowledgments, including preserved
request identity without resend. They do not establish forced-failure durability.

Process operations and receipt projection are implemented. Next complete remaining
write semantics, full adapter integration and durable delivery through the existing verifier.
General overwrite is not implemented by this create operation. Runtime choice and
production resolver readiness remain unchanged; `helper_missing` remains explicit.

## Portable creation receipt projection

`projectOwnedWindowsFileCreationReceipt` maps recorded owned creation observations
into the existing `write-owned-file` result/receipt shape. Validated creation results
now retain request ID, operation ID and request digest; projection checks those
against the attempt as well as length, content digest, file identity and volume.
This prevents pairing another operation's result merely because its bytes match.

An acknowledged create is `completed` with `mutation: true` and
`durability: not_requested`: the current native operation offers bounded flush and
readback observations, not the portable crash-durability contract. Consumers requiring
committed durability must not treat this receipt as satisfying that requirement.
An unanswered attempt is `indeterminate`, with indeterminate durability, unknown
effects and no automatic retry. It does not assert that dispatch or creation occurred.

This pure development projection accepts explicit caller-supplied lease and time
association; it does not authenticate those associations or persist anything. Retain
the source attempt/result with the projected receipt: the existing portable receipt
binds the parent directory identity but does not encode file content identity. The
projection neither grants live directory capability nor promises later byte continuity.
Complete write-option semantics, directory-method mapping, lifecycle binding and
durable delivery remain outstanding. Production selection is unchanged.
