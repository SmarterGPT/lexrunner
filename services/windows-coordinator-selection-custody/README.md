# Windows coordinator selection custody observation

This is an inactive, read-only NativeAOT source candidate for the optional
Windows coordinator. The normal image has one fixed `--observe` route. Every
other argument, including `--publish`, returns `publisher_unavailable`. It
cannot create or modify registry values, install or start a service, activate
a helper, authorize launch, or clear production `helper_missing`. It is not
packaged in npm or the MSI.

The candidate opens the fixed 64-bit `HKLM\SOFTWARE\SmarterGPT.LexRunner.WindowsCoordinator`
key, its `Generations` child, and one digest-named catalog with
`REG_OPTION_OPEN_LINK`, holding each handle while it reads. It refuses a
`SymbolicLinkValue` on `SOFTWARE` or any opened descendant. It reads the owner
and DACL through those handles. Each selected key must have SYSTEM ownership,
a protected DACL, and exactly these non-inherited allow ACEs:

| SID                                | Access mask                     |
| ---------------------------------- | ------------------------------- |
| Local SYSTEM                       | `KEY_ALL_ACCESS` (`0x000F003F`) |
| Built-in Administrators            | `KEY_ALL_ACCESS` (`0x000F003F`) |
| Built-in Users                     | `KEY_READ` (`0x00020019`)       |
| `LexRunnerCoordinator` service SID | `KEY_READ` (`0x00020019`)       |

The service SID is fixed to the reviewed `LexRunnerCoordinator` derivation.
This ACL is a **candidate** for the future installed selection publisher; a
source probe cannot establish how the key was created or whether its ACL is
effective for the running service and ordinary users. Protected owner/DACL
must be supplied at creation by a separately reviewed, approved publisher;
adopting or repairing an occupied machine key is outside this source slice.

The root has one `Generations` subkey and exactly `ActiveSelection` (`REG_SZ`)
and `HighWaterRevision` (`REG_QWORD`) values. The latter must be a positive
JavaScript-safe integer equal to the selected revision. The v2 selection is
canonical key-sorted JSON with the exact nine fields in the existing v2
contract. `Generations` has exactly one digest-named child and no values; its
catalog has no children and exactly the five typed `REG_SZ` values from that
contract. The catalog must claim `qualified`, and its digests and service name
must match the selection. The probe rereads the fixed path and requires both
complete structural snapshots to agree. Absent, malformed, occupied, linked,
mistyped, unqualified, or changed observations return a bounded unavailable
reason. Even `observed` sets `authorizesLaunch`, `productionReady`, and
`helperMissingCleared` to `false`.

The in-process ObserveSelected API now returns only a structural candidate:
the exact selected generation, graph, manifest and service-image digests plus
revision after two matching fixed-path reads. A refusal returns no candidate.
The CLI diagnostic still emits no selection bytes, and no caller path or digest
is accepted. A service can later link this source into its own protected image
for comparison against independently authenticated installed release bytes.
No current service imports it; the candidate cannot construct
ProtectedGenerationLease, and production still reports helper_missing.

The version-isolated v3 reader adds a second structural candidate with the
fixed `LexRunnerWorkerSlot1` name and worker service-image digest. The ordinary
native client status path calls that fixed v3 reader and still returns
`helper_missing`. The v2 parser and standalone `--observe` route remain intact.
Neither v3 snapshot opens the generation graph or service image files, inspects
the second SCM object, or returns a launch lease.

This source deliberately accepts only one selected generation. It does not
model retired generations, update/repair, or uninstall retention. A matching
high-water number is not evidence that it survived a previous installation or
rollback; the source has no authenticated history. The readbacks are not an
atomic registry snapshot and cannot rule out same-value replacement. They do
not bind signed MSI provenance, protected graph bytes and loader closure,
actual SCM PID/image/token, service access, or an Attempt lease. No production
publisher transaction is callable here. Those checks and separate approval of
the exact installed artifact are needed before selection can grant execution.

The compile-gated fixture build has one `--fixture-selftest` route. Its tests
are pure in-memory snapshots; they do not write HKCU or HKLM. The bounded
verifier builds normal and fixture images in a fresh, nonce-owned ignored
artifact directory, checks normal-route refusal, runs the synthetic negative
cases, performs one read-only host observation, and records the exact command,
cwd, HEAD, duration, exit, bounded output, source/image digests, and checked
build cleanup. Run from the LexRunner checkout:

```powershell
pwsh -NoLogo -NoProfile -File .\services\windows-coordinator-selection-custody\verify.ps1
```

The installed-host qualification must separately prove creation-time custody,
cross-account denial, retention across repair/uninstall, interrupted publish
recovery, signed graph custody, and running process binding. A clean source
fixture result does not qualify those claims.
