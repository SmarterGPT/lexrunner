# Windows coordinator generation graph v2 (source candidate)

This is a proposed byte contract for one immutable, separately installed Windows
coordinator generation. It is not used by the current MSI, v1 ActiveSelection,
SCM service, CLI, MCP or production resolver. Its successful comparisons always
return `authorizesLaunch: false`; Windows execution continues to report
`helper_missing`.

The optional helper remains an ordinary, separately approved program install.
The npm package does not contain, download, select or install this graph.

## Bound content

`lexrunner-windows-coordinator-generation-graph/2` has exact fields:
`schemaVersion`, `profile`, `architecture`, `serviceName`,
`coordinatorProtocolVersion`, `boundaryProtocolVersion`,
`removalProtocolVersion`, `files`, and `graphDigest`. The profile is
`windows-coordinator-service-msi/2`, architecture `win-x64`, service name
`LexRunnerCoordinator`, and protocol versions are fixed by the source contract.
Each file has exactly `path`, `role`, `sha256` and positive `bytes`.

Seven singleton root roles are required: `service-image`, `client-image`,
`node-image`, `admission-entry`, `sqlite-addon`, `helper-image`, and `git-entry`.
The finite additional roles are `javascript-module`, `native-dll`, `git-tool`
and `git-support-file`. A release must enumerate every executable or
execution-influencing member it actually needs. Adding a role requires a
reviewed schema change. The manifest alone cannot establish that the Git for
Windows tool/DLL closure, Node loader closure or OS-protected dependency set is
complete; those inventories and launch controls remain qualification work.

Paths are generation-relative with `/` separators, ordinary ASCII components,
at least one directory, no device basename, ADS colon, drive/UNC prefix,
traversal, empty segment, trailing dot, short-name tilde, or ambiguous Unicode
case spelling. Entries must be ordered by lowercase path and unique after
ASCII case folding. Directory spelling must be consistent, and a listed file
cannot also be a parent directory. This prevents textual aliases in the
manifest. It does **not** detect a reparse point, hard-link replacement,
unexpected loader search path or writable ancestor on disk. Installed readback
must inspect and retain native file/ancestor identity under protected ACLs.

The graph digest is SHA-256 of the UTF-8 bytes
`lexrunner-windows-coordinator-generation-graph/2\n` followed by canonical
compact JSON of all fields except `graphDigest`. Canonical JSON recursively
sorts object keys; the file array remains in its required path order. The
distinct **manifest digest** is SHA-256 of the complete canonical manifest
bytes, including `graphDigest`. A future protected selection would bind that
manifest digest and immutable generation identity; this module does not define
or publish such a selection. A caller-supplied expected digest is comparison
data, not authenticated provisioning.

`createWindowsCoordinatorGenerationGraph` authors canonical bytes from a
strict body. `parseWindowsCoordinatorGenerationGraph` checks canonical UTF-8,
schema, graph digest and an expected manifest digest. The
`verifyWindowsCoordinatorGraphBytes` fixture compares an exact, complete set
of supplied file bytes to each size and SHA-256. These APIs do not read a
filesystem, verify signatures, validate a running image, assign a Job, or
authorize an Attempt.

`scripts/verify-windows-coordinator-generation-payload.ts` is an offline
source preflight for a candidate v2 payload directory. Given a normalized,
fully qualified directory and an independently selected manifest SHA-256, it requires the
canonical `generation-graph.json`, the exact listed relative files and no
unlisted entries; it streams directory enumeration with an entry cap and hashes
the file bytes with a total byte budget. Run it
with `npx tsx scripts/verify-windows-coordinator-generation-payload.ts
<absolute-payload-directory> <expected-manifest-sha256>`. The returned
`authorizesLaunch` is always `false`. This check is not part of the current
v1 MSI builder and does not prove protected custody, all Windows reparse
types, race-free installed readback or that the declared loader closure is
complete. The caller's digest is comparison data, not a trust root.

## Integration and remaining proof

The current MSI packages only the NativeAOT service and v1 `generation.json`.
The source admission child uses repository `node_modules` for `zod` and
`better-sqlite3-multiple-ciphers`, including a native SQLite addon. The Git
import fixture fixes `C:\Program Files\Git\cmd\git.exe`, which may delegate to
other Git executables, tools and DLLs. None is a protected installed graph.

Before v2 can be selected, a separate change must close and inventory the
exact Node, JavaScript, native addon, Git and helper loader graphs; package
or independently protect every dependency; constrain startup argv,
environment, working directory and module search; bind the protected MSI,
manifest, SCM image and client to one generation; and prove installed
cross-account execution and recovery on supported volumes. The v1 MSI and
selection remain inactive and unchanged by this source candidate.
