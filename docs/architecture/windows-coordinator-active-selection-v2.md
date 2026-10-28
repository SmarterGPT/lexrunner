# Windows coordinator ActiveSelection v2 (source candidate)

The optional Windows coordinator remains separately installed. This document
describes a proposed read-only v2 selection contract. No current MSI writes the
v2 registry values or installs the full v2 graph. The production resolver,
Attempt, CLI, and MCP paths do not use this source candidate; all observations
return `authorizesLaunch: false`, and `helper_missing` remains the correct
production result.

The distinct 64-bit HKLM key is
`Software\SmarterGPT.LexRunner.WindowsCoordinator`. Its `ActiveSelection`
`REG_SZ` contains canonical, compact, key-sorted JSON with exact fields:
`schemaVersion`, `profile`, `generationId`, `graphDigest`,
`manifestSha256`, `serviceImageSha256`, `serviceName`,
`coordinatorProtocolVersion`, and positive `revision`. The schema/profile are
`windows-coordinator-active-selection/2` and
`windows-coordinator-service-msi/2`. The `generationId` equals the v2
generation graph digest, not the service image digest. The manifest SHA-256 is
the digest of the complete canonical `generation-graph.json` bytes and is
separate from the graph digest. The service image digest must match the single
`service-image` member of that graph.

The proposed `Generations\<generationId>` catalog has exactly five `REG_SZ`
rows: `GraphDigest`, `ManifestDigest`, `ServiceImageDigest`, `State`, and
`ServiceName`. `State` is `provisioned-unqualified` or `qualified`. A matching
`qualified` claim makes supplied values structurally consistent only; it does
not authenticate the writer or qualify the host.

The source observer uses a fixed native `reg.exe` path and `/reg:64`, rejects
other output grammar, and requires the root's typed `HighWaterRevision`
`REG_QWORD` to equal the selected positive safe `revision` on both the initial
read and final recheck. Missing, mistyped, overflowing, mismatched, or changed
high-water observations fail closed. The native publisher fixture models a
retained high-water value, but this source reader does not authenticate that
writer or prove retained state on a deployed host. It reads only
`<system-volume>\Program Files\SmarterGPT.LexRunner.WindowsCoordinator\generations\<generationId>\generation-graph.json`.
It checks directory spelling/reparse observations, holds the manifest file
while reading bounded bytes, and compares the catalog, selection, and high-water
again afterward. These reads are not an atomic snapshot: same-value ABA,
registry links and key replacement, hard-link replacement, inherited ACLs,
SCM image/config changes, loader substitution, and an attacker-controlled old
but internally consistent selection/high-water pair remain unresolved. A
matching high-water number alone is no rollback defense; protected publication,
retention, and custody still require qualification. The v1 selection contract
is separate and cannot be promoted to v2 by the reader.

Before this contract can become authoritative, a reviewed installer and
provisioner must protect the full runtime graph, catalog, ActiveSelection,
service object and its image, close the dependency loader graph, prove
cross-account negative and positive access on supported NTFS/ReFS volumes,
and bind selection to a created process and Attempt lease. No source-only
structural comparison grants execution.
