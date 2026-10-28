# Portable Windows Git source verification

`verify-portable.ps1` is a source-only Windows x64 check suitable for hosted
`windows-latest`. It builds both normal and fixture NativeAOT images with the
linked v2 `GraphV2.cs` parser and verifies the normal image refuses the legacy
and graph fixture flags. The fixture image receives a deliberately absent
graph and must return a typed, non-authorizing refusal before any Git command.
The verifier does not run Git, require this machine's pinned Git or DLL bytes,
install a service, select a generation, or clear `helper_missing`.

Run from the LexRunner root:

```powershell
pwsh -NoLogo -NoProfile -File .\services\windows-coordinator-git\verify-portable.ps1
```

The verifier uses the separately loaded bounded process helper for builds and
image probes: it drains both streams while the direct child runs, keeps at
most 16 KiB per stream, enforces 64 KiB total output and finite deadlines,
and requests process-tree termination on overflow or timeout. It requires
the direct child to exit and its streams to drain; it does not prove every
descendant exited. The native Git fixture's Job proof is separate.

The verifier copies the hash-checked C# project and linked parser into a
nonce-marked root under `artifacts/windows-coordinator-git-portable/tmp/` and
builds from that copy. This keeps intermediate files outside the real project's
compile glob. Cleanup verifies the root's exact parent, marker and absence of
reparse entries before removing it. The ignored receipt in
`artifacts/windows-coordinator-git-portable/` records commands, bounded
output, image hashes, and before/after hashes of all first-party compiled C#
inputs, the linked parser, and verifier source. External .NET toolchain and
package bytes are outside that source hash claim. Successful source checks
do not qualify installed identity, protected loading, dependency closure,
service token, or governed execution.
