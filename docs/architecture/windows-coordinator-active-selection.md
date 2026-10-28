# Windows coordinator ActiveSelection observation (source-only)

This slice defines a **proposed**, service-specific selection and read-only
observation contract. It does not publish a selection, install or start a
service, or clear production `helper_missing`. Every public result carries
`authorizesLaunch: false`. The existing WindowsHelper direct-launch selection
uses a different profile and registry key and cannot authorize this service.

## Proposed selection

The distinct 64-bit location is
`HKLM\Software\SmarterGPT.LexRunner.WindowsCoordinator`, value
`ActiveSelection` (`REG_SZ`). Its value is compact JSON with keys in lexical
order, no duplicate or extra fields, and a 4096-byte UTF-8 limit. The exact
versioned shape is:

```json
{
  "generationId": "<lowercase image sha256>",
  "manifestSha256": "<lowercase manifest sha256>",
  "profile": "windows-coordinator-service-msi/1",
  "protocolVersion": "1.0.0",
  "revision": 1,
  "schemaVersion": "windows-coordinator-active-selection/1",
  "serviceImageSha256": "<same image sha256>",
  "serviceName": "LexRunnerCoordinator",
  "serviceVersion": "2.5.0"
}
```

`serviceVersion` is a three-component version matching the selected image's
manifest. `revision` is a positive safe integer, but comparison alone does not
provide rollback protection. The selection includes no caller-selected pipe,
PID, image path, command line, or workspace. The service pipe and SCM identity
remain separate fixed native contracts.

## Proposed catalog and metadata comparison

The observer queries only
`HKLM\Software\SmarterGPT.LexRunner.WindowsCoordinator\Generations\<validated digest>`
through the 64-bit registry view. A future catalog would have exactly four
`REG_SZ` rows: `ManifestDigest`, `ImageDigest`, `State`, and `ServiceName`.
It reads `generation.json` only from the fixed
`%SystemDrive%\Program Files\SmarterGPT.LexRunner.WindowsCoordinator\generations\<validated digest>`
layout. The query uses an OS-root-derived `reg.exe` with identity preflight,
fixed arguments and environment, a five-second timeout, and an 8192-byte
output limit. Metadata reads are bounded and check file identity before and
after. A second selection read detects a changed value during acquisition.

Structural consistency requires the manifest digest and all service/image
claims to match, a `qualified` and `productionReady: true` manifest, and a
matching catalog. The currently proposed MSI instead authors
`provisioned-unqualified` / `productionReady: false` and **does not create a
catalog or ActiveSelection**. Thus its installed files cannot produce a
consistent current selection through this observer.

Even hypothetical consistency only compares observed claims. These Node
reads do not establish protected registry custody, ACL ownership, independent
provenance, rollback resistance, atomic observation, the actual SCM service
image, loader graph, live peer identity, or execution/recovery authority. A
service-specific protected provisioning and native binding path needs its own
review and qualification before a production resolver can consume a selection.
This module is deliberately not imported by the production resolver or client.
