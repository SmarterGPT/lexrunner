# Optional Windows coordinator v3 two-service MSI source

This is an **offline, non-installable source fixture** for the selected
one-slot profile. It accepts a canonical `windows-coordinator-service-msi/3`
graph and exactly its listed bytes, authors a cabinet and MSI, then reads the
committed cabinet and database back. The source fixture uses synthetic text
payloads. It does not sign, install, repair, select, start, stop or remove a
service, change a registry value or ACL, or clear `helper_missing`.

The `LaunchCondition` table contains an unconditional `0`, sequenced before
`InstallServices`. The MSI has no `StartServices`, `ServiceControl`, custom
action or name-based service retirement. Removing the denial requires a
separate reviewed release builder and exact installation approval. The npm
package never includes or invokes this optional helper operation.

| Fixed row                    | Coordinator                                                         | Worker slot                                                                   |
| ---------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Graph role and image         | `service-image`, `service/LexRunner.WindowsCoordinator.Service.exe` | `worker-service-image`, `service/LexRunner.WindowsCoordinator.WorkerSlot.exe` |
| SCM name                     | `LexRunnerCoordinator`                                              | `LexRunnerWorkerSlot1`                                                        |
| Account                      | `NT SERVICE\LexRunnerCoordinator`                                   | `NT AUTHORITY\LocalService`                                                   |
| Service kind/start/arguments | own process, demand start, `--service`                              | own process, demand start, `--service`                                        |
| Service SID                  | restricted, exact coordinator SID                                   | restricted, exact worker SID                                                  |
| Required privileges          | `SeChangeNotifyPrivilege` only                                      | `SeChangeNotifyPrivilege` only                                                |

The worker SCM descriptor gives SYSTEM and Administrators full access,
ordinary Builtin Users query/read rights only (`CC`, `LC`, `LO`, `RC`), and the
coordinator service SID the fixed start, stop, query, interrogate and read
rights (`CC`, `LC`, `RP`, `WP`, `LO`, `RC`). It grants ordinary users no
`SERVICE_START`, `SERVICE_STOP`, configuration change, user-defined control,
write-DACL or write-owner right. The coordinator service descriptor retains
the v2 restricted user rights. Program Files generation files and directories
grant only read/execute to both service SIDs and Builtin Users, while SYSTEM
and Administrators receive full access. An installed host must still prove
effective ACL, service object, primary/child token and loader behavior.

The worker service source currently stops without a RUNNING state, editor,
private view, Git route or public endpoint. A worker child would need a
separately qualified restricted derivative of the LocalService worker token;
the MSI privilege row alone does not establish that child token. Neither
service is qualified by authoring two table rows.

Both service names have read-only point-in-time `RegLocator` collision checks,
and ActiveSelection and the Program Files root remain collision inputs. MSI
property searches cannot prove service-object/key absence or protect their
values. Full uninstall remains unavailable until a protected retirement
authority binds and drains both exact service objects and installed images,
retires selection and effects, deletes the same held SCM handles, then proves
absence. This source does not implement that authority. The MSI contains no
name-based `ServiceControl` action.

The offline verifier runs on native Windows x64 with local Node/tsx and .NET 8:

```powershell
pwsh -NoLogo -NoProfile -File .\installers\windows-coordinator\v3\verify-msi-offline.ps1
```

It runs bounded child commands, leaves a fresh synthetic MSI and receipt under
`artifacts/windows-coordinator-v3-msi-offline`, checks both deterministic
service SIDs and independent descriptor owner/group, protected DACL, ACE flag
and right masks, performs exact committed table/cabinet readback, and exercises
wrong digest, recipe, worker bytes/SID, extra payload and output-overwrite
refusals. It does not invoke Windows Installer. The source recipe hash and
manifest digest are caller-supplied comparison data, not signed provenance.
Staging uses checked paths rather than protected native parent handles; it
cannot serve as release authority against a concurrent same-user rename or
reparse substitution. The existing v2 source and MSI bytes remain separate.

Next gates are independent review, hosted source CI, a complete signed
loader/image graph, protected staging and selection, exact installed
cross-account service/ACL/token readback on ReFS and NTFS, and separate
approval for a concrete artifact and its additional service identity.
