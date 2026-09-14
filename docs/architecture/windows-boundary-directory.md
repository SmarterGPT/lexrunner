# Native development directory leases

The explicit `--boundary-session 1.0.0` NativeAOT development peer supports one
held directory chain per session. `directory_request` accepts `acquire` with a path,
then `assert` and `release` with the returned opaque lease token. Requests share
the status protocol's canonical digest, nonce/ID checks, replay rejection and
15-operation lifetime limit. Replies correlate the request and report the leaf's
file ID, volume serial, final path, filesystem, chain length and lease token.

Acquisition opens the drive root and every directory prefix, retaining each
SafeHandle with read/write sharing and without delete sharing. Reparse points and
non-directory targets are rejected. Every operation recaptures the held handles'
identities and paths before replying. Release closes the chain in reverse order;
an uncertain close cannot produce a successful release reply. EOF disposes a live
lease. A rejected operation terminates the helper; it does not return a typed
no-effect response. Missing acknowledgment requires reconciliation, never resend.

Paths must be absolute native drive paths, at most 1024 characters and 32 tail
components. UNC/device paths, dot segments, alternate streams, trailing dots/spaces
and reparse traversal are outside this profile. NTFS and ReFS are explicit code
profiles; tests qualify only their actual host, not all supported filesystems.
The existing 4096-byte frame budget also applies to escaped paths and replies.

These handles constrain renames; they do not freeze directory contents or supply
CoW isolation. Sequential identity observations are not atomic namespace evidence,
ACL continuity or authenticated custody. Ancestor identities remain internal;
the reply exports leaf identity and count, not an entire chain evidence record.
An acknowledged release describes this operation; its returned token is no longer
live. An OS close failure is not retried or relabeled as successful cleanup.

The actual executable tests use a test-only client with the shared codec and
exchange tracker. They exercise Unicode paths, rename controls before/after a
lease, leaf/ancestor rename exclusion, EOF cleanup, wrong tokens, junctions and
partial acquisition cleanup for missing/file targets. They do not qualify the
production Node directory adapter, forced termination or hostile-code containment.

Next compose these operations with the existing owned Node process lifecycle and
WorkspaceBoundary adapter, preserving outstanding-operation evidence on failure.
Production resolution remains `helper_missing` until operations and the separately
reviewed launch/trust profile satisfy the actual verifier contract. This local
development executable is not authenticated installation or a release candidate.
