# Windows coordinator selection publisher source fixture

This directory is an **inactive NativeAOT source fixture** for the proposed
v2 selection publication order. It is not included in an MSI or npm package,
has no production HKLM publication route, and cannot clear `helper_missing`.
The normal image returns `no_production_publisher_entrypoint` for every
argument. Only a separately compiled fixture image recognizes one exact
`--fixture-hkcu-selftest` switch. No caller can supply a registry path,
selection, service name, executable, or manifest to that switch.

The fixture creates eight random, direct child keys below the current user's
`HKCU\Software`. It supplies a protected owner and DACL to `RegCreateKeyExW`
**at creation**, requires a `REG_CREATED_NEW_KEY` disposition, opens keys with
`REG_OPTION_OPEN_LINK` to refuse registry symbolic links, and uses the explicit
64-bit registry view. It reads back the owner/DACL, exact typed `REG_QWORD`
high-water and `REG_SZ` selection/catalog fields, and bounded key/value
counts. The synthetic candidate is compiled into the fixture image; it is
comparison data, not an authenticated approved artifact.

For each interruption point, the fixture writes/flushes a qualified catalog,
then advances/flushes `HighWaterRevision`, then writes/flushes
`ActiveSelection`. It closes and reopens the key before explicit recovery.
Recovery flushes even already visible matching catalog and selection values,
then checks the exact final state. An initial replay of a partial or completed
publication is refused. An injected failure immediately after root creation
checks that the held newly created key can be removed before it has a nonce or
`Generations` child. Each test deletes only its own nonce-bound direct child
and verifies no fixture key remains. Cleanup reopens while the original key is
held and rechecks owner, protected DACL, nonce, value types and exact child
shape before deleting; unexpected state is reported as uncertain.

The verifier requires an ordinary, non-link repository and artifact ancestry.
It creates a fresh nonce-named output directory with an exclusive create and
an exact owner marker. Build output and intermediate paths are dedicated to
that run. Cleanup touches only the four intermediate directories it created,
after checking the marker, absolute ancestry, and absence of reparse entries;
preexisting `bin` or `obj` in the source directory cause refusal and are
never removed. Normal/fixture images and the bounded receipt remain in
`artifacts/windows-selection-publisher-<nonce>/`. A failed or occupied cleanup
is left for manual inspection, never followed or replaced.

Run locally on a Windows x64 host:

```powershell
pwsh -NoLogo -NoProfile -File .\services\windows-coordinator-selection-publisher\verify.ps1
```

This fixture does **not** test production HKLM security, ordinary-client or
service-SID denial, signed installer provenance, machine reboot durability,
same-user protection, registry key rollback, MSI repair/uninstall retention,
or a running SCM service/PID. Its HKCU key is owned by the current user, so
the test cannot establish a same-user trust boundary. Revalidation cannot
remove a malicious same-user path-swap race in this fixture's registry or
filesystem cleanup. It cannot authenticate
the `qualified` claim or prove the multi-key publication atomic; a crash
between flushes requires explicit installed administrator recovery. A future
publisher must bind an independently approved signed generation, create and
retain protected HKLM keys/high-water, reject occupied/link keys, check real
worker/client tokens, and bind the running process separately from SCM's
configured next-start path. The v2 reader remains non-authorizing.

The relevant Windows contracts are
[RegCreateKeyExW](https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regcreatekeyexw),
[registry key security](https://learn.microsoft.com/en-us/windows/win32/sysinfo/registry-key-security-and-access-rights),
[RegOpenKeyExW link handling](https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regopenkeyexw),
and [RegFlushKey](https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regflushkey).
