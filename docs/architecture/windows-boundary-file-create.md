# Bounded native file creation

This development operation serves trusted coworkers: shared visibility is expected;
accidental overwrite and uncertain completion are the problems addressed here.
It does not hide another worker's branch, restrict ordinary caller filesystem access,
or establish hostile-agent containment. Creation is an operation within a supplied
live directory scope, not a new approval ceremony.

`file_create_request` carries `create-file`, a live directory token, one component,
canonical base64 content and its SHA-256. Payloads are at most1024bytes. Canonical
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

Nine real-native tests cover empty/1/257/1024-byte creation, independent filesystem
readback and native read identity, handle release, preservation of existing content,
creation via a child whose parent token was released, and malformed content/component
rejection before creation. Tests do not inject partial writes, disk-full, flush/close
failures, process kill or power loss. Those remain qualification work, not implied
by a successful flush or the test count.

This operation currently uses the explicit test client. Next expose it through the
owned Node scope with conservative effect bookkeeping, then implement remaining
write semantics, process operations and the existing verifier receipt mapping.
General overwrite is not implemented by this create operation. Runtime choice and
production resolver readiness remain unchanged; `helper_missing` remains explicit.
