# Windows worktree removal qualification

Status: current broker guard implemented; removal transition remains unqualified.
Tracking: [#997](https://github.com/SmarterGPT/lexrunner/issues/997).

The current native profile opens directories without delete sharing. A disposable
Windows/ReFS experiment demonstrated that Git can empty and unregister a worktree
before failing to delete its held directory. Retrying after release then reports
that the path is no longer a worktree. A separate unheld control removes normally.
The control-workspace `windows-held-remove-probe*` evidence retains both observations.
This is partial mutation, not a no-effect failure.

The broker now refuses the destructive Git removal step when the selected boundary
claims `rename_delete_exclusion`. It first performs normal observation/preservation
checks, so dirty, missing and ambiguous workspaces keep their existing outcomes.
A clean eligible target returns an explicit failure requiring a qualified removal
transition. Its files and registration remain intact. Linux profiles without this
claim retain the existing removal path.

The real native broker fixture exercises bootstrap, create, exact retry, observation,
dirty preservation and the guarded clean-removal result. It uses explicit test-only
resolver composition and an absolute Git executable; synthetic discovery metadata is
not production provisioning. The public resolver remains unavailable.

## Next bounded design and experiments

Removal must be a deliberate lifecycle transition, not an ordinary command whose
arguments happen to identify a directory. Before any mutation it needs a durable
intent binding the Attempt, lease revision, target identity, Git registration and
preservation observations. New work must stop on that workspace, and affected
descendant scopes must be accounted for. The terminal evidence must distinguish
registration removal, content removal, residual directory and uncertain effects.
Recovery uses those observations and the existing verifier, not an automatic retry
of `git worktree remove`.

A development-only `OwnedDirectoryRemoval` now acquires an explicit DELETE-capable
leaf handle beneath a held parent chain and checks it against an expected physical
identity. The expected identity is association data, not an authority grant. Tracked
leaf/direct-child readers keep the owner alive and prevent disposition until closed.
The primitive requests only empty-directory removal. It caches the first disposition
observation, separates handle release from subsequent name observation, and never
resends against a replacement at that name. Nonempty rejection is terminal too.

Run its disposable native lifecycle probe from `proofs/windows-workspace-boundary`:

```powershell
dotnet run --project tests/RemovalLeaseProbe -c Release -- ../../artifacts
```

This primitive is not reachable through the helper protocol or production resolver.
It does not upgrade an existing read lease; that lease must already be absent before
acquisition. It is not recursive deletion, a Git registration transition, durable
receipt delivery, or crash recovery. Close failure paths retain uncertainty, but
native close-failure injection and interruption qualification remain outstanding.
The existing broker guard stays in place. Full worktree removal still needs the
durable intent, preservation, effect verification and recovery design above.

Two tempting shortcuts are not justified by the API contract. Microsoft documents
that reopening an object cannot request access conflicting with an existing open
handle's sharing mode; POSIX-style disposition still requires DELETE access.
Therefore neither “upgrade the handle” nor “use POSIX delete” alone answers the
current profile mismatch. See [ReOpenFile](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-reopenfile)
and [FILE_DISPOSITION_INFORMATION_EX](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntddk/ns-ntddk-_file_disposition_information_ex).

Do not globally enable delete sharing, release all custody and race a pathname, or
make recursive deletion an implicit fallback. A different cooperative workspace
profile can be evaluated explicitly if it better serves trusted coworkers, with its
actual guarantees and recovery costs measured. This work concerns coordination and
mistake containment, not a new hostile-code sandbox.
