# Portable Windows checkout source verification

`verify-portable.ps1` is a hosted Windows source gate for the inactive checkout
fixture. It runs on `windows-latest` with PowerShell 7 and the .NET 8 Windows
NativeAOT toolchain. It does not require the local ReFS volume, a pinned Git for
Windows installation, a protected coordinator service, or a selected helper.

The script hashes its exact first-party inputs, copies the checkout project and
linked C# sources into a nonce-owned disposable root, then publishes two images:
a default normal image with no fixture constants and a fixture image built with
`CheckoutFixture=true`. Both are source builds. The normal image must refuse the
fixture flags. The fixture image must refuse a missing graph payload before it
can import a bundle or create a mirror or stage. Every child launch has a
deadline and bounded output; the receipt records both image hashes, command
outcomes, source hashes before and after, and checked cleanup.

Run from the repository root:

```powershell
pwsh -NoLogo -NoProfile -File services/windows-coordinator-checkout/verify-portable.ps1
```

The receipt is written under ignored `artifacts/windows-coordinator-checkout-portable/`.
Its `authorizesExecution` and `installedServiceQualified` fields are false.
This gate proves only that the hosted Windows source compiles and that these
pre-effect refusals hold. The local ReFS checkout/population evidence remains
in `verify.ps1` and its separate receipt. Neither gate proves installed
custody, selected graph authenticity, worker ACLs, or production execution.
