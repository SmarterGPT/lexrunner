# Proposed Windows helper ActiveSelection content

Status: source-only consistency contract. No protected selection reader or producer
is connected, and this module cannot authorize native execution.

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
protocol agreement, and matching `qualified`/`productionReady` claims. The marker
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
