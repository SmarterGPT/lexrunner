# Optional Windows coordinator v2 MSI source

This is an **inactive source-only MSI candidate** for a complete
`windows-coordinator-service-msi/2` generation graph. The current verifier
uses seven text placeholder files. Its MSI is synthetic and **must not be
installed or signed as a helper**. The npm package does not include, download,
install, start, repair, select, or invoke this optional application.

The source builder now always authors an unconditional false MSI launch
condition. Even if supplied a complete graph, its output is a **non-installable
offline fixture**. The authored service table remains available for database
audit, but cannot register a service through a normal install. A production
builder needs a separate reviewed release path and cannot infer permission to
remove the guard from a caller-supplied graph or digest.

The builder accepts an exact canonical `generation-graph.json` and every
listed file, with no extra payload. It holds input bytes, copies them to a new
stage, writes one removable 64-bit component per file and directory, and
reads every cabinet member back from the committed MSI. Its database audit
binds Media, File sequence/size, MsiFileHash, component GUID/keypath, ACL,
service account and standard-action rows. The expected digest and recipe
remain caller-supplied comparison data; this source pass is not provenance.
Output staging and cleanup use checked paths rather than retained native
parent handles. They are not safe release-authority operations against a
concurrent same-user rename or reparse substitution. This offline source gate
cannot supply a signing input; a release builder needs native handle-relative
staging or an independently qualified isolated release host.

The MSI authors only the `LexRunnerCoordinator` demand-start own-process
service under `NT SERVICE\LexRunnerCoordinator`, with a restricted service
SID and `SeChangeNotifyPrivilege` required privilege list. The fixed Program
Files files and directories grant read/execute to that exact service SID as
well as Users, with SYSTEM and Administrators full access. An installed host
must still prove effective token and ACL behavior. The package authors no
`StartServices`, ActiveSelection, root provisioning, arbitrary custom action,
download, or governed execution endpoint. **It has no `ServiceControl` row.**
Windows Installer must never stop or delete a service solely by the shared
production name during package removal.

Only fresh install and full **retired** uninstall are authored; repair,
reinstall, partial maintenance, and automatic upgrade are refused. The MSI
checks an existing service `ImagePath`, nonempty ActiveSelection and occupied
Program Files root; `preflight.ps1` is a stronger read-only operator check
using SCM and the explicit 64-bit registry view. Those checks are point-in-time
observations. Windows Installer `RegLocator` cannot prove a key or service
object absent when its searched value is absent, and public properties are not
protected authority. No direct `msiexec /x` is approved by this source pass.

## Guarded retirement contract

A future reviewed retirement authority must bind the exact installed signed
MSI and graph, authenticated selection and current service object/PID/image,
drain admitted work and durable effects, remove ActiveSelection through its
protected protocol, stop the bound service, call `DeleteService` on that same
held SCM handle, and wait for service/key absence. It must retain uncertain
state rather than retry or delete by name. Only after that transaction and a
fresh read-only `preflight.ps1 -Mode RetiredUninstall` match should an approved
operator run this MSI's full uninstall. The MSI then removes its own file and
folder components without a name-based service action. An uninstall failure
after external service deletion leaves the application inactive and requires
explicit recovery; MSI rollback cannot recreate a retired service. A later
selection or different service object always blocks retirement.

The current source does **not** implement that protected retirement authority.
Its `preflight.ps1` can only observe absence and exact expected product/manifest
metadata. It cannot authorize an install or uninstall, make the observations
atomic with MSI execution, or replace installed-host collision and rollback
tests. Do not use the synthetic MSI on any host.

## Offline source verification

Run from the existing LexRunner checkout in native 64-bit PowerShell:

```powershell
$id = [guid]::NewGuid().ToString('N')
$artifact = "D:\dev\lexrunner\artifacts\windows-coordinator-v2-msi-offline\source-$id"
pwsh -NoLogo -NoProfile -File .\installers\windows-coordinator\v2\verify.ps1 -ArtifactDirectory $artifact
```

The verifier builds under nonce-owned intermediate paths, uses bounded child
processes and output, checks its cleanup ancestry/markers/reparse state, and
retains the synthetic unsigned MSI and receipt. It tests wrong manifest/graph,
missing and extra members, noncanonical graph, output overwrite, newline
suffixes on digest/version selectors, output overflow and timeout. The receipt
records HEAD, source hashes, command/cwd/duration/exit and bounded output,
graph/manifest/recipe/MSI SHA-256, checked cleanup, and explicit
`installed=false`, `started=false`, `selected=false`,
`productionReady=false`. It never removes shared source `bin`/`obj` or
unrelated artifacts.

## Full-graph and installed dependencies

A separate reviewed release assembly must supply the normal signed service,
client and NativeAOT helper images; fixed Node entry/modules and native SQLite
addon; and a complete Git image, DLL, tool and support-file set. The current
graph parser proves canonical listed bytes, not dynamic loader closure,
publisher identity or independent selection. The v1 signing workflow packages
only the two-file v1 MSI; v2 needs its own main-only signed-byte graph and MSI
workflow, provenance and independent review. An exact signed MSI still needs
separate installation approval.

Even an installed static v2 package would not clear `helper_missing`. The
normal service currently answers only indeterminate status and has no ordinary
client enrollment, protected admission/store, Node/helper/Git effect route,
service-owned ProgramData/per-volume roots, protected selection, or durable
recovery. These are separate installed and end-to-end gates on ReFS and NTFS.

Relevant Microsoft contracts:
[permanent components](https://learn.microsoft.com/en-us/windows/win32/msi/component-table),
[restricted service SID](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/ns-winsvc-service_sid_info),
[ServiceControl](https://learn.microsoft.com/en-us/windows/win32/msi/servicecontrol-table),
[REMOVE sequencing](https://learn.microsoft.com/en-us/windows/win32/msi/conditioning-actions-to-run-during-removal),
[DeleteService handle](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nf-winsvc-deleteservice),
[RemoveFiles](https://learn.microsoft.com/en-us/windows/win32/msi/removefiles-action),
and [RemoveFolders](https://learn.microsoft.com/en-us/windows/win32/msi/removefolders-action).
