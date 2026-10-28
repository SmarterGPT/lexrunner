# Windows coordinator protected-root source fixture

This is a source-only, non-authorizing candidate for the optional protected
coordinator. The normal NativeAOT image has **no provisioning route** and
returns `protected_provisioning_unavailable`. It cannot install a service,
change fixed C:/D: anchors or ProgramData, select a generation, or clear
`helper_missing`. The npm package neither includes nor downloads it.

The compile-gated fixture creates a fresh nonce directory only under the
repository's `artifacts/windows-coordinator-root-provisioner/run-<nonce>`.
Within that disposable parent, `NtCreateFile(FILE_CREATE)` creates the fixture
container and seven recorded directories with a protected DACL at creation:
a store, two simulated volume
anchors, and `stage`/`final` under each anchor. It holds parent handles,
refuses an occupied name, and reads final path, volume/file ID, non-reparse
attributes, owner and DACL through each created handle. It compares the exact
read-back SDDL to the fixture's expected descriptor before reporting. The
fixture owner is the current user solely to permit bounded cleanup; this does
not model the installed service ownership boundary.

Run `pwsh -NoLogo -NoProfile -File .\verify.ps1` from this directory. The
verifier publishes separate normal and fixture images, checks that the normal
image rejects the fixture route, runs the creation and occupied-name cases,
checks all seven entries before removing only its fresh nonce fixture, and
records bounded command/cwd/duration/exit/output, image and stable source
hashes in an ignored `run-<nonce>/verification-receipt.json` receipt. It
preserves preexisting source `bin`/`obj` bytes, uses nonce-owned build paths,
and checks their cleanup. A failed or ambiguous fixture is retained at its
exact path. `verify-portable.ps1` runs only pre-effect refusal checks on a
hosted Windows runner; see [PORTABLE_SOURCE.md](PORTABLE_SOURCE.md).

For a real provisioning transaction, a reviewed installed v2 graph and service
identity are prerequisites. The fixed roots proposed by the control workspace
are `C:\ProgramData\SmarterGPT.LexRunner.WindowsCoordinator`,
`C:\SmarterGPT.LexRunner.WindowsCoordinator`, and
`D:\SmarterGPT.LexRunner.WindowsCoordinator`. A future approved provisioner
must resolve and verify the installed service SID, create every absent root
with SYSTEM or service ownership (never the approving user's SID), verify
the actual service token can read/execute the complete installed image and
write the store/anchors, and verify the ordinary requester cannot create,
rename, delete, change owner/DACL, or redirect any protected root. It must
refuse occupied or redirected paths, retain held ancestor/file identities,
and handle partial creation and restart without blind cleanup. User worker
leaf and `.git` permission handoff is a separate unresolved design choice.

Read-only host ACL inspection on 2026-10-28 observed ordinary-user create
rights on C:, D: and ProgramData, but no `FILE_DELETE_CHILD` in the relevant
non-inherited parent ACEs. `DELETE` on the D: root object is a distinct right.
This SDDL observation does not replace effective cross-account negative tests
under the installed profile. The local source fixture runs as one user on
ReFS D:; the portable gate can run on a separate Windows x64 checkout. Neither
qualifies service token, loader custody, crash behavior, cross-account denial,
or production provisioning.
