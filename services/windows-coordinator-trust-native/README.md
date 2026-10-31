# Windows coordinator shared trust core

This optional application build statically links one actual C++ SDK implementation
plus the fixed selected-policy verifier into the existing NativeAOT coordinator.
It does not add an installed DLL, program, service, account or npm lifecycle action.
The five operation/header files retain their independently reviewed bytes; the
build driver integrates audit-enabled normal/fixture publishing and the existing
pure test image. No copied diagnostic verifier or API-name-parity implementation.

From the repository root, run
`pwsh -NoLogo -NoProfile -File services/windows-coordinator-service/verify.ps1 -PureOnly`
for scoped pure/build/refusal evidence. Omit `-PureOnly` only when the historical
SCM/pipe/private-launch source fixtures are intended. Build artifacts and receipts
go in a fresh qualification directory. MSVC17 x64 and the project's pinned .NET
SDK are required; missing compiler/static library fails without a dynamic fallback.
Package security audit and warnings-as-errors remain enabled.

The private borrowed-handle ABI is version2 (request96/result272), not a public
request surface. The selected trust policy is
`AEAA82259B2AF8DD8353DD2B0CCABAD92C0C6F0F72A3A02502E9AF29BE87C62E`.
It combines identity/hash/path, fixed signature and timestamp, ordered provider/
primary/TSA chains, purpose status, current issuer/root validity, current network
revocation of all nonroot certificates, complete close and bounded clocks. API
success or a zeroed result never means completed checks; late cleanup uncertainty
is sticky and close is never retried through a recycled numeric handle.

The same-process caller must already hold independently authenticated protected
bootstrap/generation custody. Current installed context factories stay closed;
comparison data, an observed signer, fixtures and this build are not that origin.
A qualified actual diagnostic archive is different from a fresh application image.
Source/build/import checks do not authorize native network tests, installation,
selection, service activation or governed execution. Node owns policy/Attempt
semantics, and npm must never acquire or install this separate optional helper.
