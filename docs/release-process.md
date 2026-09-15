# Release and public npm publishing

New release tags use `vX.Y.Z` (decision accepted 2026-09-15). Historical
`lexrunner-v*` tags and release links remain unchanged. The drift check recognizes
known pre-migration versions through 2.4.0; that compatibility does not authorize
new publication under the old prefix or retagging already published versions.

LexRunner is prepared for public npm distribution as `@smartergpt/lexrunner`.
The registry access transition and first Apache-2.0 package release are separate from
merging these source changes; earlier versions retain their applicable license terms. The release path
has one signed-tag authority chain:

1. GitHub Actions validates the exact release-owner-signed stable-tag candidate after it is
   contained in `main`.
2. The same stable-tag job publishes through npm's package-scoped GitHub OIDC trusted publisher.
3. The workflow creates the matching GitHub release and records the install command.

The workflow stores no npm token. Pull requests, branches, canaries, manual workflow dispatches,
self-hosted runners, and local agents cannot publish. A human maintainer owns the one-time npm
trusted-publisher configuration and any explicit recovery action.

## Release types

- **Canary candidate:** each merge to `main` validates a version shaped like
  `X.Y.Z-canary.<commit>`. Canary npm publication remains disabled.
- **Stable release:** a `vX.Y.Z` annotated tag and its target commit must both be signed
  by the authorized release-owner GPG fingerprint. Once that commit is contained in `main`, the
  workflow validates the matching package version and permits `.github/workflows/release.yml` to
  publish with the `latest` dist-tag through npm trusted publishing before creating the GitHub
  release.

LexRunner follows Semantic Versioning. Breaking changes normally require a major release; an
explicitly governed pre-release or ecosystem release may declare a narrower migration policy in
its release issue. Conventional commits guide the proposed bump, but the release owner reviews the
version and changelog before tagging.

## Human prerequisites

Use Node 24 and npm 11 as pinned by `.nvmrc` and `packageManager`. npm trusted-publisher management
requires npm 11.15.0 or newer, package write access, and account-level 2FA. Authenticate once and
bind this exact GitHub repository and workflow filename:

```bash
npm install --global npm@^11.15.0
npm login --scope=@smartergpt --registry=https://registry.npmjs.org/
npm whoami
npm trust list @smartergpt/lexrunner --json
npm trust github @smartergpt/lexrunner --file release.yml --repo SmarterGPT/lexrunner --allow-publish
npm trust list @smartergpt/lexrunner --json
```

If `npm trust list` already reports the exact GitHub repository and `release.yml`, do not create a
duplicate relationship. npm supports multiple trusted publisher connections. During a repository
migration, add and verify the replacement binding and repository identity before explicitly
revoking the obsolete relationship by its exact ID. The configuration command may require a
browser/2FA confirmation and is intentionally a human step.

Do not create or store an npm write token in GitHub. The public package can be installed without
a private-scope read credential. Trusted publishing authorizes only the CI `npm publish` operation;
public read access grants no publication authority.

## Prepare a stable candidate

```bash
git status --short
npm run release:prepare
git diff -- CHANGELOG.md package.json package-lock.json README.md docs/AX.md
npm run docs:surface
npm run build
npm test
```

Review the version, changelog, generated documentation, and package contents. The release owner
then signs the release commit with primary fingerprint
`65C94BA03E88F53D365C36CF7145A1CE635B1902`. Merge that exact commit into `main`, create a signed tag
whose version exactly matches `package.json`, and push the tag:

```bash
git add CHANGELOG.md package.json package-lock.json README.md docs/AX.md
git commit -S -m "chore(release): prepare X.Y.Z"
git verify-commit HEAD
# Merge the reviewed commit into main before tagging it.
git tag -s vX.Y.Z -m "Release X.Y.Z"
git tag -v vX.Y.Z
git push origin vX.Y.Z
```

Wait for the release workflow to finish. It rejects workflow dispatch, verifies the annotated tag
and its exact API-reported target through GitHub, verifies both tag and target commit against the
authorized release-owner GPG fingerprint, verifies target containment in `origin/main`, runs
`npm test`, builds, checks determinism and version alignment, and validates npm's exact dry-run
publication behavior. Its privileged third-party action revisions are pinned to reviewed commit
SHAs. It then executes:

```bash
npm publish --access public --tag latest --json
```

The npm CLI obtains a short-lived OIDC credential for this workflow; no `NODE_AUTH_TOKEN` or npm
secret is configured. If npm accepts the package, the job creates the GitHub release. The
pre-publication gate itself remains dry-run-only and may be replayed locally:

```bash
npm run release:publish:check
```

For pre-tag candidate work, `npm run release:publish:check -- --allow-untagged` runs the package and
dry-run checks but does not authorize publication.

Canary candidates are not published. Use the packed-package smoke or an explicit local tarball
consumer when pre-stable validation is required:

```bash
npm run test:package
```

The `publishConfig` in `package.json` pins the npm registry and public access; the explicit
flags make the workflow's intent visible in the receipt. Agents and local shells must not execute,
proxy, or retry non-dry-run publication. If trusted publishing fails, inspect the workflow filename,
repository, tag, OIDC permission, npm version, and package trust configuration before rerunning the
exact failed tag workflow.

## Consumer proof

The release is not complete at “npm accepted the package.” The release issue owns the final proof
(#881 for 1.3.0):

1. install the scoped package from the public npm registry in a clean native Windows consumer;
2. verify ESM, CommonJS, CLI version/help, and MCP startup/tool inventory;
3. exercise the bounded read-only smoke path; and
4. record versions, commands, outcomes, and cleanup without recording credentials.

The consumer install shape is:

```bash
npm install @smartergpt/lexrunner@X.Y.Z
```

## LexSona is a separate release

LexSona is versioned, built, and published from the LexSona repository under its own package name
and release gates. The same authenticated SmarterGPT npm identity may be reused, but LexRunner's
scripts, tag, workflow, and changelog must never publish or version LexSona. Coordinate compatible
versions in the ecosystem release receipt rather than coupling the two publish operations.

## Rollback and recovery

Prefer deprecation plus a fixed patch over unpublishing:

```bash
npm deprecate @smartergpt/lexrunner@X.Y.Z "Critical issue; use X.Y.Z+1"
```

If npm policy permits and the release owner explicitly approves unpublishing:

```bash
npm unpublish @smartergpt/lexrunner@X.Y.Z
```

Revert faulty repository changes with a normal signed revert and publish a corrected release. Do
not silently retarget an existing version or rewrite a published tag.

## Automation boundary

Only the `stable-release` job in `.github/workflows/release.yml` receives `id-token: write`, and it
runs only for push events on `v*.*.*` tags. The job requires a GitHub-verified annotated
tag and exact API-reported target commit, both signed by release-owner primary fingerprint
`65C94BA03E88F53D365C36CF7145A1CE635B1902`, containment of that commit in `origin/main`, exact
tag/manifest version agreement, `npm test`, deterministic source, the package boundary, and the
npm dry run before publishing. Privileged third-party actions are pinned to reviewed commit SHAs.
All other jobs inherit read-only repository permissions and cannot request an OIDC publish
credential.

## Related records

- [LexRunner 1.3.0 release (#881)](https://github.com/Guffawaffle/lexrunner/issues/881)
- [Real Windows-to-native-WSL replay (#863)](https://github.com/Guffawaffle/lexrunner/issues/863)
- [Ecosystem release and native Windows proof (#795)](https://github.com/Guffawaffle/lexrunner/issues/795)
- [Node 24 runtime migration (#823)](https://github.com/Guffawaffle/lexrunner/issues/823)
- [npm publish documentation](https://docs.npmjs.com/cli/commands/npm-publish)
- [Semantic Versioning](https://semver.org/)
