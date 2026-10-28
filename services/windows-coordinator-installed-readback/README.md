# Windows coordinator installed-state readback

This source-only PowerShell probe is strictly read-only with respect to Windows
service, registry, files, and ACL state. It does not install, start, stop, repair,
uninstall, select, or activate the optional coordinator. It never clears
production helper_missing or returns execution authority. The separate
optional MSI still requires approval for one exact reviewed signed artifact
before installation.

Read-InstalledCoordinator.ps1 accepts only the expected normal service image
SHA-256, generation manifest SHA-256, and three-part version. It derives the
fixed image/manifest path from the OS system directory and image digest; callers
cannot choose an executable, pipe, service, registry key, or filesystem path.
It reads the 64-bit HKLM service and coordinator selection keys, obtains one
Win32_Service SCM observation, and requires the initial MSI's own-process,
demand-start, stopped virtual-account configuration. It checks the requested
restricted service SID and sole SeChangeNotifyPrivilege, the exact quoted
image command line, and absence of ActiveSelection.

If those structural checks pass, it rejects reparse entries in the fixed path
chain, hashes the held image and manifest, and requires the initial MSI's exact
eight-field provisioned-unqualified manifest spelling. It then reads the
service object's DACL via the OS-root sc.exe sdshow and records DACL,
owner/group observations for the application, generation, image, and manifest.
ACL observations are bounded evidence for a later review, **not** a proof of
effective service-token or ordinary-user access. It does not request audit
SACLs or SeSecurityPrivilege.

Every result is one bounded JSON object with state equal to unavailable,
inconsistent, or observed_unqualified, and always has
authorizesExecution=false, productionReady=false, and
helperMissingCleared=false. A missing service is unavailable/service_absent.
The synthetic -SelfTest mode is explicitly unavailable/synthetic_contract_pass
and does not inspect a service. It tests exact config, ActiveSelection
presence, wrong start type/kind, canonical manifest, escaped-name refusal, and
long/out-of-range MSI version refusal, and fixed minimal output fallback.

For a source check before installing anything, run from the LexRunner root
with the actual offline candidate's image and manifest digests:

```powershell
pwsh -NoLogo -NoProfile -File .\services\windows-coordinator-installed-readback\verify.ps1 -ExpectedImageSha256 <64-lowercase-hex> -ExpectedManifestSha256 <64-lowercase-hex> -ExpectedVersion 2.5.0 -ExpectAbsentService
```

The verifier requires exactly one of -ExpectAbsentService or
-ExpectObservedService. It records exact commands, cwd, duration, exit codes, bounded output,
source hashes, and the machine observation in the ignored
artifacts/windows-coordinator-installed-readback/verification-receipt.json.
It writes no installed service or registry state. When later used after a
**separately approved** installation, use -ExpectObservedService and bind the
parameters to the signed MSI receipt, not to a stale unsigned fixture. That
assertion requires an observed-unqualified structural result, never readiness.

This readback does not prove MSI signature/provenance, installer execution,
service token privileges, an effective ACL, protected loader graph, live
cross-account pipe access, start/stop drain, ProgramData/per-volume roots,
admission/Attempt binding, Git/helper execution, or recovery. It cannot promote
the initial unqualified manifest to qualified; a later reviewed generation
and provisioning protocol are required. All Windows governed execution remains
closed until those gates and an end-to-end dogfood Attempt pass.
