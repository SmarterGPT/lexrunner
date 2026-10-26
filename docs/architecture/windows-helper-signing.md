# Windows helper signing qualification

Distribution disposition (2026-10-25, America/Chicago): the Windows helper is a
separate optional application, downloaded and installed explicitly by the user or
an authorized agent. npm installs LexRunner only. Neither its dependencies,
lifecycle scripts nor LexRunner commands acquire, install or update the helper.
Runtime inspection may report an absent/incompatible installation; it must not
turn that diagnosis into an automatic download or installation. The concrete
application installer and protected launch profile still require qualification.

Guff selected the MSI/direct-launch design on 2026-10-26. The
[MSI provisioning candidate](../../installers/windows-helper/README.md) preserves
that separate application boundary. Its catalog remains provisioned/unqualified;
it publishes no active selection and does not activate production execution.

The manual Windows helper signing workflow runs only from main. Its unsigned build
job has no OIDC permission. After native tests, it transfers only the explicitly named
win-x64 helper into the windows-release environment. That environment requires owner
review and allows main and v* tags; this workflow itself does not trigger on tags.
New package releases use vX.Y.Z, while historical lexrunner-v* releases remain immutable.

The signing job uses LexRunner's dedicated Azure OIDC application and the existing
stfcsidecarsign / stfc-sidecar-public profile. No client secret or certificate private
key is stored in GitHub. The profile-scoped grant and immutable environment subject
were provisioned with Guff's authorization on 2026-09-15. Actions are pinned to commits.

Verification uses Windows SDK SignTool Authenticode policy plus the exact publisher
subject, code-signing EKU, durable Azure identity EKU and timestamp. It admits a single
embedded PKCS7 primary signer, rejecting additional certificate-table entries and
nested secondary signatures instead of checking only the displayed primary signer.
The current scope is x64 PE32+ artifacts up to 64 MiB. A rotating leaf thumbprint is
recorded as an observation, not a pin. The final full-file SHA-256 is computed after
signing. Source revision is workflow context, not embedded source provenance.

This is trusted CI qualification tooling, not the protected runtime verifier or an
independent bootstrap root. The held file excludes ordinary writes/deletion during
local checks; it does not establish ancestor custody or launch continuity. A signed
artifact does not establish portable adapter readiness, durable receipt recovery or
production launch qualification. The receipt explicitly records production_ready:false.
The workflow retains the signed helper and receipt as a temporary Actions artifact;
it does not publish npm, create tags/releases or activate production resolution.

Existing workflow run [40273109069](https://github.com/SmarterGPT/lexrunner/actions/runs/40273109069)
succeeded at reviewed merge `4b29c8575e933c6abdcdfc03795323ab5cf3dc66`. Its exact signed
helper SHA-256 `6e372ad0f13b9791b1e7b30a065301b2ad504da0e301d804e7c0da673dafb272`
passed local publisher/timestamp/full-byte verification and 148 actual-native
regressions on each of this host's ReFS and NTFS fixture parents, with no skips.
These are helper signing/execution results, not an installed protected launch.

The extended workflow builds and inspects a separate MSI after signing its helper,
then signs the exact named MSI and emits source/workflow-bound attestations for
both final artifacts. The MSI verifier reads its bounded PKCS7 storage stream and
rejects multiple primary/nested signers. No extra signer identity or signing key is
provisioned. That extended workflow still needs exact-head execution evidence;
source changes alone do not claim the new MSI/attestation stages succeeded.
