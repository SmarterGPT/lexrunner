# Inactive Windows worker-slot source

This is a **non-installable, non-authorizing** source slice for the selected
one-slot Windows worker design. The normal NativeAOT image accepts only
`--service` and the exact `LexRunnerWorkerSlot1` SCM name. A direct console
launch refuses. Even when SCM starts this image, it reports terminal failure
without a RUNNING state, public pipe, child process, worker lease, filesystem
change, Git operation or selection route. The fixture-only policy and token
probes are excluded from the normal image.

The proposed service token is LocalService (`S-1-5-19`) with the exact worker
service SID in enabled and restricting SID sets. It must not carry an enabled
administrator or another service-specific SID. The well-known
`NT SERVICE\ALL SERVICES` group is allowed as token context but must never
receive a protected-view or authority ACL grant. The source reads the process
primary token and refuses a thread impersonation token. A future **child**
token additionally must have sensitive privileges removed, not merely
disabled. The pure fixture
tests cover that policy; the current-token fixture proves the ordinary
interactive token fails it. These checks do not establish installed SCM token
behavior. The coordinator virtual-account TokenUser rule is different and
must not be copied here.

Run `pwsh -NoLogo -NoProfile -File services/windows-coordinator-worker-slot/verify.ps1`
on Windows x64 to publish normal and fixture NativeAOT images under ignored
`artifacts/windows-coordinator-worker-slot-source`. The receipt records
bounded command results and source/image hashes. No service is registered,
installed, started, selected or granted filesystem rights by this gate.
Command output is capped for retained evidence after each process exits;
the verifier does not impose a per-process timeout. The hosted
`windows-bootstrap` job has a finite 45-minute ceiling.

Next reviews must establish a protected one-slot coordinator lease, exact
worker child/token/Job launch, an actual editing adapter, private-view ACL and
CoW behavior, cross-account ReFS/NTFS cleanup, GraphV2/MSI second-service
packaging, and separately approved installation. The current Codex app-server
adapter is read-only under its caller token; this source does not solve its
authentication or write route. Production `helper_missing` remains correct.
