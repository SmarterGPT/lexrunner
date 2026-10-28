# Portable root source gate

`verify-portable.ps1` builds distinct normal and compile-gated NativeAOT fixture
images in a fresh, marker-owned directory under this repository's `artifacts`.
It checks the normal image's refusal, an invalid nonce, and a missing fixture
run root. These are pre-effect checks: no protected root, service, registry
selection, or installed directory is created. The gate can run on an ordinary
Windows x64 CI checkout without the local ReFS volume.

The gate bounds child time, stdout and stderr; compares source hashes and any
preexisting source `bin`/`obj` tree before and after; checks cleanup of only the
nonce-owned intermediate build directories; and retains a bounded receipt at
`artifacts/windows-coordinator-root-provisioner/run-<nonce>/verification-receipt.json`.
It proves direct child exit and stream drain, not every descendant's termination.
The normal and fixture executable bytes and their hashes are retained for
review. A passing portable receipt reports `portable_pre_effect_pass` and
`authorizesExecution: false`.

The separate `verify.ps1` exercises the protected fixture container and seven
recorded descendants under the same disposable run root. Neither verifier
tests the installed service token,
protected C:/D: roots, cross-account denial, worker access, or restart recovery.
The disposable run root is owned by the test user; checked path cleanup does
not prove containment against a concurrent malicious process with that same
user identity.
