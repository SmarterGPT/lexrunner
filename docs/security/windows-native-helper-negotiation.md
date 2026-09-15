# Native Windows helper negotiation

The development NativeAOT peer lives in
`proofs/windows-workspace-boundary/src/LexRunner.WindowsBoundary.Helper`.
It is a separate project and does not compile the unfinished directory proof.
The `--boundary-protocol 1.0.0` profile accepts one canonical framed hello and EOF.
The explicit [session profile](../architecture/windows-boundary-session.md) accepts
hello followed by bounded requests in the same process. The owned Node probe
exposes status; a scoped owned Node adapter and an explicit test client exercise the native
[directory lease profile](../architecture/windows-boundary-directory.md).
Native [bounded reads](../architecture/windows-boundary-file-read.md) are tested
through the explicit client and owned Node scopes. Native
[exclusive file creation](../architecture/windows-boundary-file-create.md) uses
the explicit client and owned Node scopes. [Bound process execution](../architecture/windows-boundary-process.md)
is available through the explicit client and owned Node scopes. General writes,
full adapter integration and production readiness remain pending. The production
resolver remains unavailable.

From `proofs/windows-workspace-boundary` (so global.json selects the pinned SDK):

```powershell
dotnet publish src/LexRunner.WindowsBoundary.Helper/LexRunner.WindowsBoundary.Helper.csproj -c Release -r win-x64 --self-contained true -o ../../artifacts/windows-helper/win-x64
```

Then from the repository root:

```powershell
$env:LEXRUNNER_TEST_NATIVE_HELPER = (Resolve-Path artifacts/windows-helper/win-x64/lexrunner-windows-boundary-helper.exe).Path
node node_modules/vitest/vitest.mjs run tests/workspaces/windows-native-helper.spec.ts tests/workspaces/owned-windows-boundary-handshake.spec.ts tests/workspaces/windows-boundary-protocol.spec.ts --maxWorkers=1
Remove-Item Env:LEXRUNNER_TEST_NATIVE_HELPER
```

The explicit test variable selects a test artifact only. Native tests skip without
it or off Windows; portable protocol tests remain separate. This qualification is
Windows x64, not an arm64 claim. Production discovery accepts no such override.

The real owned Node launcher supplies fixed arguments, private pipes, bounded
negotiation/cleanup and actual PID comparison. The peer returns its architecture,
image SHA-256 and a random session nonce. Its self-reported digest is not signature
verification, independently approved provenance or protection through launch.
The supplied expected digest is consistency data. The result explicitly retains
`verification: not_performed`. No certificate or trusted installation is needed
for this development-only test; production deployment remains separately gated.

The peer bounds hello allocation to 4 KiB and subsequent session requests to 96 KiB, rejects noncanonical JSON,
duplicate/unknown fields, malformed UTF-8, truncation and extra frames, and writes
no stdout diagnostics. The hello-only profile waits for EOF after replying; the
session profile accepts up to 15 subsequent requests. The owning parent provides
the deadline and termination behavior; standalone partial-input invocations have
no internal timer and are not a public launcher. Hello/status operations create no
descendants; explicit process operations use the bounded job-ownership profile.

The first actual native run exposed Windows writer newline differences and an
uncaught InvalidDataException rejection. Normalize canonical output toLF and catch
that exception explicitly; failed evidence is retained in the control workspace.

Next complete the remaining WorkspaceBoundary operations and qualify
ownership/failure behavior. Do not
advertise ready after hello or directory tests. The verifier's operational path
and protected deployment remain pending.
