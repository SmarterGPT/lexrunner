# Windows coordinator graph v3 source fixture

This adds a distinct structural graph contract for the first one-slot worker
profile. It keeps the v2 graph and MSI builder unchanged. The v3 graph requires
exactly one `worker-service-image` at
`service/LexRunner.WindowsCoordinator.WorkerSlot.exe`, with the fixed
`LexRunnerWorkerSlot1` LocalService and service SID identity values. It also
requires the existing coordinator image at its fixed path. The source-only
fixture compares TypeScript and C# canonical parsing and digest bytes.

The manifest is supplied data. A matching graph digest does not authenticate
its source, installed image, loader graph, service configuration, token, ACL,
or active selection. No v3 installer or production resolver consumes this
graph. The v2 MSI builder keeps unconditional install denial, and the
installed readback keeps `TryOpenInstalled=false`. The fixture does not
install, start, select, or authorize either service.

`verify.ps1` uses the existing direct local Vitest and tsx launchers and .NET 8.
It does not run a package manager. It writes a bounded source receipt under
`artifacts/windows-worker-graph-draft/20261028/qualification-*` while this
remains an ignored draft. Its generated payload contains synthetic bytes only.
The six C# refusals use mutated graphs with recomputed matching digests, so a
mere digest mismatch cannot explain their results.
