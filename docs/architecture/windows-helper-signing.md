# Windows helper signing qualification

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

First successful OIDC exchange, signature verification and downloaded-byte readback
remain required evidence. Until the reviewed workflow reaches main and runs, local
validation cannot claim those steps succeeded.
