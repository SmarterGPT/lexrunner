# Optional Windows helper MSI qualification

Guff selected the separate MSI/direct-launch profile on 2026-10-26. This is its
provisioning candidate, not an installed or production-ready backend. npm does not
bundle, depend on, download, install, update or repair this application.

The build uses the pinned .NET 8 SDK, Windows Installer database APIs and the
Windows `makecab` utility. No third-party installer compiler or custom MSI action
is required. .NET and PowerShell are development/qualification tools; the MSI
contains the self-contained NativeAOT helper and two JSON metadata files.

## Build and inspect

Select the exact signed helper and receipt from one successful, reviewed
`windows-helper-signing.yml` run. Supply its full source revision and run ID;
there is no latest-artifact lookup, automatic download or local-signature bypass.

```powershell
pwsh -NoLogo -NoProfile -File scripts/Build-WindowsHelperMsi.ps1 `
  -HelperExecutable D:\selected\lexrunner-windows-boundary-helper.exe `
  -WorkflowSignatureReceipt D:\selected\signature-receipt.json `
  -HelperSourceRevision <full-helper-source-sha> -SigningRunId <exact-run-id> `
  -OutputDirectory D:\new\package-artifacts
```

The script checks the existing approved publisher, identity EKU, timestamp and raw
image digest under held read/no-write/no-delete custody, compares the workflow
receipt, then copies exactly those bytes. Receipt-supplied source context is an
association; the separate post-sign artifact attestation supplies workflow/source
binding. Nothing treats a caller-selected receipt as installation authority.

The native builder writes only a new MSI database/cabinet. It has no install,
configure-product, service, account, shortcut, environment or custom-action API.
Package SQL is fixed; row data use parameter records. Three payload streams remain
held while the cabinet/database are created. Windows Installer file-hash records
cover the copied files. The unsigned CFB root-storage and SummaryInformation times,
and staged cabinet timestamps, are canonical build metadata. These are normalized
before signing; signed inputs are never edited. Equal inputs and recipe produced
equal unsigned MSI bytes in the offline lane. This does not claim reproducible
timestamped signatures or every Windows Installer/toolchain version.

`Inspect-WindowsHelperMsi.ps1` opens the MSI through read-only Windows Installer
APIs. It checks the exact table/file/directory surface, per-machine scope,
generation retention, authored SYSTEM/administrator/user permissions, registry
boundary, overwrite/repair refusal and lack of activation mechanisms. It extracts
the embedded cabinet into a fresh artifact directory through SetupAPI, accepting
only the three fixed member identifiers, then compares full SHA-256 payload bytes.
Neither inspection nor extraction executes Windows Installer installation actions.

## Authored installation behavior

The intended root is
`%ProgramFiles%\SmarterGPT.LexRunner.WindowsHelper\generations\<signed-helper-sha256>`.
The application root, generation directories/files and descriptive machine catalog
have authored protected SYSTEM ownership: SYSTEM/administrators maintain them;
ordinary users receive read/execute. This is authored policy, not observed ACL
enforcement. Real installation and ordinary-worker tamper controls remain required.

The MSI writes only its own
`HKLM\Software\SmarterGPT.LexRunner.WindowsHelper\Generations\<sha256>` catalog.
It publishes **no ActiveSelection**. Catalog and manifest state are
`provisioned-unqualified`, with `productionReady:false`. Installed files, a valid
signature and passing build tests do not enable production preflight.

In-place modification/repair and reprovisioning an existing generation are refused.
There is no automatic major upgrade or removal of another generation. Generation
files/catalog are permanent recovery resources; normal uninstall removes the
installation marker and application registration. Actual active-generation drain
and explicit retirement must be qualified before deletion is implemented. Retained
files alone do not authorize new launches. No workspace store/profile/history is
an installer resource, and no process is killed or scheduled for deletion at reboot.

## Qualification and signing

Run the offline lane with an explicitly selected existing helper file and a new
artifact directory:

```powershell
pwsh -NoLogo -NoProfile -File scripts/Test-WindowsHelperMsi.ps1 `
  -HelperExecutable D:\selected\lexrunner-windows-boundary-helper.exe `
  -ArtifactDirectory D:\new\offline-msi-tests
```

The recipe supplies explicit short/long filename pairs as required by the
[Windows Installer Filename contract](https://learn.microsoft.com/en-us/windows/win32/msi/filename).
It refuses `SHORTFILENAMES` so the installed layout always uses the selected long
names. A short-alias collision must fail installation rather than select a different
generation. Inspection compares the complete authored permission rows, component
destinations/conditions and standard-action sequences before extracting payloads.

The fixture artifact is deliberately unqualified. Cases include repeat-build byte
equality, real embedded-payload readback, wrong input identity, weakened retention,
registry/directory/file escapes, unexpected selection publication, unsigned MSI
refusal, real MSI PKCS7 stream parsing and rejection of an ephemeral untrusted
fixture signer. The temporary key is not enrolled into any certificate store.
Commands, cwd, commit, duration, exit and bounded output are retained. No MSI is
installed by this lane. The required Windows CI job runs it natively.

The separate `Test-WindowsHelperMsiInstall.ps1 -EphemeralCi` lane performs actual
installation on an existing administrative, disposable GitHub-hosted Windows
runner. It refuses local hosts or existing application/catalog state before any
mutation. It checks installed payload/owner/DACL, native image loading, refusal of
repair, marker-removing uninstall and refusal to reprovision a retained generation.
Its fixture remains unqualified and has no active selection. It neither deletes
retained generations nor establishes ordinary-worker denial or production trust.
The runner is discarded by CI. Logs/receipts are retained, including failures.

The actual first local install exposed missing required `Signature` table metadata
for `AppSearch`, despite passing offline inspection. The recipe now includes that
empty standard table; it must contain no file-signature rows for the raw registry
lookup. The offline missing-table negative control and hosted real installation
lane cover this boundary. Offline metadata checks alone never establish that the
Windows Installer engine can execute the package.

The manual main-only signing workflow signs the helper first, builds/inspects the
MSI around those exact signed bytes, signs only the named MSI with the existing
Azure identity, and verifies its publisher/EKUs/timestamp/one embedded signer and
raw file digest. It attests both final signed artifacts. Verification should bind
repository, workflow, source ref and source digest, for example with
`gh attestation verify --repo SmarterGPT/lexrunner --signer-workflow
SmarterGPT/lexrunner/.github/workflows/windows-helper-signing.yml --source-ref
refs/heads/main --source-digest <exact-source-sha> <artifact>`.

Actual machine installation is a separate explicit action against the concrete
reviewed signed artifact. Installed protection/loader closure, qualification and
active-selection publication, update/rollback/drain/uninstall behavior, production
resolver routing and real native Attempt/CLI/MCP conformance remain activation
gates. No service or identity is installed by this implementation.

Native formats/APIs: [Windows Installer database](https://learn.microsoft.com/en-us/windows/win32/msi/database-functions),
[permissions](https://learn.microsoft.com/en-us/windows/win32/msi/msilockpermissionsex-table),
[standard sequencing](https://learn.microsoft.com/en-us/windows/win32/msi/using-standard-actions),
[compound-file directory entries](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-cfb/).
