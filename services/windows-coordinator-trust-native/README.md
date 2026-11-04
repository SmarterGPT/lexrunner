# Windows coordinator shared trust core

The optional application statically links the native SDK implementation and one
selected13-fact policy. V2 remains PE-only with request96/result272. Additive private
V3 request128/result320 names PE or MSI and exact required features, rejects unknown
version/kind/size/reserved/features, and shares V2's single-use latch. ABI support
does not qualify an MSI, bootstrap, installation or execution authority.

The MSI adapter requires the independently selected MSI subject GUID
`{000C10F1-0000-0000-C000-000000000046}`. This supported Windows SDK route requires
its returned dispatch entry to be the exact `CryptSIPGetSignedDataMsg` export of
System32 Crypt32.dll. A FROM_ADDRESS reference retains that module through both
size and data calls via the validated typed callback and closes once. It does not
compare against this executable's public-symbol import thunk or accept an
arbitrary observed module. Different dispatch routes explicitly refuse. hSIP is
reserved and is never treated as an owned HMODULE.

This is SDK dispatch binding, not proof of the underlying MSI SIP provider's
identity or protected loading. The observed registration names System32 MSISIP,
but the actual mapped provider/loader graph and pre-load custody remain
unqualified. A module pathname is neither mapped file-ID nor independent custody.

SIP signature extraction uses its documented filename/INVALID_HANDLE_VALUE form
and index0; it does not borrow the verification hFile. WinTrust uses the separately
retained hFile and full path through the same core. Both formats share CMS bounds,
publisher/EKU, RFC3161, ordered provider/primary/TSA chains, purposes, current
issuer/root validity, current network revocation, clocks and sticky close results.
The required mask remains0x1fff. No missing MSI fact is waived and no cached/offline
fallback is added. Full raw pins complement the provider's covered-byte signature.

Default source qualification (no actual SIP/WinTrust or installer operation):

```powershell
pwsh -NoLogo -NoProfile -File services/windows-coordinator-trust-native/verify-msi-subject.ps1
```

This builds a fresh actual static archive, the existing75 policy fault cases plus14
new header/layout vectors, and the native probe. Eight separate ABI-refusal children
test real V2/V3 single-use behavior with zero SDK trust calls. The fixed previously
approved signed-f59 MSI and PE helper are read as data; a bounded CFB/DER fixture
reader records exact future mutation offsets without calling Windows Installer.
Original data is never modified. Artifacts, failures and source hashes are retained.

**Stop before functional probes.** Root must first review the exact source/build,
probe bytes and complete functional command profile. `-Functional` invokes real
SIP/WinTrust on data and fresh owned negative copies; that switch is not authority
or permission. The profile must establish actual MSI hFile/path object consumption
and all selected facts before any MSI qualification claim. This is a bounded
observation subset, not a complete qualification profile: raw-only outside-SIP
coverage, unsigned/truncated containers and injected actual close/deadline failures
remain explicit pending controls.
The negative fixture walks the bounded pinned CMS to the single primary SignerInfo
encryptedHash value before mutating it; arbitrary signature-stream offsets do not
prove a primary-signature tamper.
Every verifier invocation rebuilds a fresh archive/probe and binds their actual
hashes; reviewing an earlier probe is not admission of silently different bytes. Unsupported provider,
format, cardinality, timestamp/chain or custody observations refuse. Existing PE
qualification does not transfer to this fresh archive or new subject format.

MSVC17 x64, fixed arguments, warnings-as-errors, fresh owned outputs and explicit
source bindings remain required. The builder generates audit-enabled service
publish commands but this verifier does not run them. The unchanged V2 consumer
may receive an affected compile/pure-ABI check after source changes; no production
context factory opens. Never run the historical service defaults merely to test
this decoder.

O's independent bootstrap and one fixed deferred primary-SYSTEM initializer remain
future integration. Type17/File-table sequencing alone proves no birth/loader
protection. No service, account, registry value, ACL, installer recipe, selection,
SYSTEM Node or npm acquisition is introduced here. Current installed factories,
publication Session and `helper_missing` stay closed; all-gates acceptance remains
false while the existing install-script and broader CI failures remain unresolved.
The corrected dispatch has actual data-only observations: the pinned MSI and PE
(V3 and legacy V2) satisfied all 13 cryptographic/identity comparison predicates;
covered payload, decoded primary signature and timestamp mutations refused.
The MSI conflicting-object control did not qualify: a good held MSI with a
corrupted filename target returned TRUST_E_BAD_DIGEST, with native state closure
successful. This does not establish handle-based MSI consumption. The verifier
stops there, before the reverse control, and the production MSI route remains
unsupported. Do not reverse that expected outcome to manufacture qualification.
A future trusted primitive must prove and retain path-to-held-object equivalence
under the selected same-user rename/reparse threat model for every SDK operation.
The current borrowed-handle comparisons and module path observation do not supply
that namespace or loader custody. ChecksSatisfied is diagnostic predicate evidence,
not MSI authority, protected-origin acceptance or a cleared helper_missing.
