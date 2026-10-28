# Graph-selected Git import source fixture

`verify-graph.ps1` exercises a second, fixture-only Git import route. It authors
a synthetic canonical v2 generation graph with seven copied Git for Windows
members and six inert bytes-only members, then runs the existing fixed bundle
import under the existing creation-time Job launcher. The copied Git image and
its `git-core/git.exe` child must be selected from that graph. The normal
NativeAOT image refuses `--fixture-graph-import`.

Run on the qualified local Windows Git build from the LexRunner root:

```powershell
pwsh -NoLogo -NoProfile -File .\services\windows-coordinator-git\verify-graph.ps1
```

The profile requires a canonical graph matching a caller-supplied manifest
digest, exactly the declared payload files and directories, seven exact Git
roles and paths, no reparse entry or ancestor at the time of the check, held
file paths, sizes and hashes, and unchanged held bytes after each Git child.
The constructed child environment uses the selected payload's `mingw64\bin`
and `mingw64\libexec\git-core`, plus OS-provided Windows directories. The
verifier poisons ambient `PATH`, `GIT_EXEC_PATH` and `GIT_CONFIG_COUNT`, checks
five fixed import commands and terminal Job drain, observes a graph-local
`git-core/git.exe` child during fetch, and requires wrong manifest, changed
child image, and unlisted file to refuse before a mirror is created.

The outer verifier drains setup, build, Node, and NativeAOT child stdout and
stderr while each child runs. It keeps at most 16 KiB per stream, imposes a
64 KiB total output budget and a two-minute ordinary command deadline. On
overflow or timeout it requests process-tree termination, then requires the
direct child to exit and both streams to drain. It does not prove that every
descendant exited; the inner Git launcher has a separate Job drain check. The
outer harness tests a short-lived child that emits 70,000 bytes and exits zero, a
continuously noisy child, and an idle child. All three must retain bounded
output and return their typed overflow or timeout disposition.

The receipt under `artifacts/windows-coordinator-git-graph/` records the exact
first-party compiled C# and linked graph parser hashes, script and transitive
first-party graph-author hashes, and package lock/config hashes before the
build. It checks the same hashes again after the fixture and records whether
they stayed equal. External toolchain and installed `node_modules` bytes are
outside this source hash claim. The receipt also records image hashes,
commands, duration, exit codes and bounded output.
The temporary fixture is removed only after nonce, path and reparse checks;
failures preserve it for inspection. Every result is non-authorizing and a
successful import still has `UnknownEffects=true`.

This is an unprotected same-user fixture with a supplied digest, not an
authenticated selection or installed service. A file-path and hash comparison
does not bind every mapped image to the held file object. Job process snapshots
can miss short-lived descendants. The five DLLs cover the reviewed static PE
imports, not delay or dynamic loads, redirection, Git support files, OS DLL
resolution, or an exhaustive tool closure. Directory ancestry is checked but
not held against renames. The separate protected service identity, generation
ACLs, authenticated rollback-resistant selection, installed image loading,
cross-account access, and end-to-end Attempt route remain open. This fixture
does not clear `helper_missing` or make a v2 MSI installable.
