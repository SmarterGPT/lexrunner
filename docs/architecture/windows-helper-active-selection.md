# Proposed Windows helper ActiveSelection content

Status: source-only consistency and observation contracts. No protected selection
producer or launch binding is connected, and these modules cannot authorize native
execution.

The selected optional MSI/direct-launch profile proposes one coherent `REG_SZ`
value named `ActiveSelection` under
`HKLM\Software\SmarterGPT.LexRunner.WindowsHelper` in the 64-bit registry view.
`parseWindowsHelperActiveSelectionValue` accepts its **already decoded** string
content as compact JSON with sorted keys and a 4 KiB limit. The strict versioned
shape binds the generation and manifest SHA-256 digests, profile, publisher policy
identifier, protocol/removal versions, source repository/revision/signing run, and
selection revision. Extra fields, duplicate keys and alternate JSON encodings are
refused. Registry transport and protected acquisition remain separate work.

`assessWindowsHelperSelectionConsistency` compares only supplied selection content,
exact manifest bytes, a generation catalog object, and exact `installed.json`
marker bytes. It checks the manifest digest, generation identity, source and
protocol agreement, the catalog ProductCode derived by the MSI builder from the
generation digest, and matching `qualified`/`productionReady` claims. The marker
must be present; retained generation files and catalog alone cannot match after
uninstall. Manifest and marker JSON may contain cosmetic whitespace, but duplicate
keys and ambiguous encodings are refused. Every result has
`authorizesLaunch: false`, including `state: "consistent"`.

This result does not authenticate any input. A caller can forge matching values,
including `productionReady: true`, and still receive only a structural consistency
result. Before resolver readiness, a reviewed installer must publish the protected
selection after independent artifact/provenance verification. The trusted Node
coordinator must read the real protected HKLM value, establish installed bytes and
loader/ancestor protection through actual launch, bind the created helper process,
and qualify publication races, update, rollback, drain and uninstall behavior.
The current MSI publishes no `ActiveSelection`; production Windows resolution
continues to refuse execution.

## Bounded registry observation

`observeWindowsHelperActiveSelection()` reads only the dedicated 64-bit HKLM
`ActiveSelection` value. It has no caller-selected path or command. On native x64
Windows, it resolves `reg.exe` through the true OS-root `GLOBALROOT` spelling,
requires an ordinary drive-qualified `System32\reg.exe` real path, and compares
BigInt file identity with that resolved DOS path before querying. It runs that
path with fixed argv, System32 cwd, constructed `SystemRoot`/`WINDIR`, no shell,
5-second timeout and 8 KiB output cap. It accepts exactly one ASCII
`ActiveSelection REG_SZ` line from the dedicated key whose content passes the
canonical selection parser. Nonzero exit, output or identity ambiguity, wrong
type, malformed content and unsupported hosts all return unavailable.

Every result has `authorizesLaunch: false`. The path comparison is a momentary
preflight: Node does not retain a handle that binds the actual `reg.exe` child
image. A private DOS-device map or a later namespace/protection change can still
redirect a path-based launch. This reader does not verify registry ACL continuity,
authenticate its contents or qualify the NativeAOT image and loader through
launch. No production resolver imports it; absence of the current selection still
reports `helper_missing`. The control workspace's
`docs/experiments/windows-selection-reader-001` read-only host probe motivated
this strict system-reader shape. On the tested Windows build, a read-only query of
the installed generation's `ManifestDigest` returned exactly four spaces before
the value name and between its columns. That is an observed format, not a claim
for every Windows version or locale; other output refuses closed. Production
readiness still requires protected launch and publication-race qualification.
