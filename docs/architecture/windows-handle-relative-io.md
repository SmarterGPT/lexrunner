# Windows handle-relative capability I/O

This #997 qualification delta changes the development helper's directory and file
operations. It does not activate the production resolver or qualify process launch.

`DirectoryLease.Acquire` compares an ordinary drive-root handle with the OS global
drive-root handle and rejects a different DOS alias. It retains the global root and
opens each remaining component relative to its already-held parent. The supported
input remains an absolute local drive path on the qualified NTFS/ReFS profile;
caller device paths, UNC paths and reserved DOS device components are rejected.

Child acquisition duplicates the parent's ancestor handles before opening or
creating the child. Completed children independently retain the chain after parent
closure. Exclusive creation uses `NtCreateFile(FILE_CREATE)`, without a separate
pathname-based directory creation. File reads and creates also use single-component
native opens against the retained leaf. Existing sharing, no-follow, identity,
bounded-content and checked-release requirements still apply. Removal preparation
keeps its different sharing requirements.

The distinction matters even while rename/delete exclusion handles remain open:
an ordinary user can attach a junction to a held empty directory. A later absolute
pathname operation can follow that junction before its post-operation identity
check. Relative lookup either addresses the retained directory object or refuses;
it must not create or read through the newly attached junction. A failed final
assertion remains a failed/unknown operation, not an instruction to repeat creation.

`RemovalLeaseProbe` adds seven actual native cases to the existing qualification
entrypoint, `proofs/windows-workspace-boundary/verify-removal.ps1`:

- Independent child retention, read/create and preservation of an existing file.
- Conflicting writer refusal followed by successful read and handle release.
- Reserved DOS device-name refusal before creation.
- Rejection of a process-private drive alias, with successful retained-handle I/O
  after the process's drive map changes.
- Three junction-race cases for child creation, file creation and file reads,
  each paired with an ordinary pathname control that reaches an outside canary.

Every test owns its disposable roots. The drive-alias fixture uses an anonymous
object directory and relative symbolic-link names, selects it only for its own
short-lived process, restores the original map, and checks handle closure. It never
modifies shared DOS names or calls `DefineDosDevice`. Junction tags are removed
before recursive fixture cleanup. The script records source SHA/dirty state, native
artifact hashes, command, cwd, duration, exit code and bounded output.

Process launch remains a separate obligation: `DirectorySession.RunProcess` still
renders DOS path strings for child cwd and directory arguments. This change does
not claim that a parent process's device map is inherited by its children, protect
arbitrary command behavior, or establish installed selection, launch authority,
reboot recovery or complete Windows execution qualification. An installed signed
generation built from an earlier source revision does not acquire these changes.
