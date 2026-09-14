# Native Windows helper negotiation

The development NativeAOT peer lives in
`proofs/windows-workspace-boundary/src/LexRunner.WindowsBoundary.Helper`.
It is a separate project and does not compile the unfinished directory proof.
It accepts only `--boundary-protocol 1.0.0`, one canonical framed hello and EOF.
No workspace operations, leases, process execution service or production readiness
are exposed. The production resolver remains unavailable.

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

The peer bounds request allocation to4096bytes, rejects noncanonical JSON,
duplicate/unknown fields, malformed UTF-8, truncation and extra frames, and writes
no stdout diagnostics. It waits for EOF after replying. The owning parent provides
the deadline and termination behavior; standalone partial-input invocations have
no internal timer and are not a public launcher. No descendants are created.

The first actual native run exposed Windows writer newline differences and an
uncaught InvalidDataException rejection. Normalize canonical output toLF and catch
that exception explicitly; failed evidence is retained in the control workspace.

Next implement the accepted live directory lease/operation contract behind this
transport and qualify ownership/failure behavior. Do not advertise ready after
hello. The verifier's operational path and protected deployment remain pending.
