# Install a reviewed local candidate

This repository helper installs an exact local LexRunner candidate for dogfood.
It requires native Node 24+, the exact npm version in `packageManager`, an
explicit absolute global prefix, and a matching source manifest and lockfile.
The helper is development tooling and is excluded from the npm package.

## Observe the npm runtime

The install-policy and packed-consumer checks observe the actual npm JavaScript
entry point, Node executable, versions, required policy capabilities and file
hashes. A `packageManager` declaration alone does not qualify the running npm.
The helper uses `npm_execpath` when invoked through npm, or the Node-adjacent npm
entry when invoked directly. An older system npm is refused before installation.
Each Node/npm capability probe runs once with a bounded deadline, hard termination
signal and per-stream output limit. Receipts retain its stable selector, exact
arguments, monotonic elapsed milliseconds, exit/signal/timeout result and the
observed runtime paths and hashes; they never retain probe stdout or stderr. A
failed probe is recorded as the partial `npmRuntimeObservation`, not a qualified
`npmRuntime`, and is neither retried nor treated as policy success.

When an isolated toolchain is needed, install the exact declared npm version
with scripts suppressed into a dedicated tooling directory. For example, from
PowerShell in the canonical checkout:

```powershell
$toolchain = Join-Path $PWD 'artifacts/local-toolchain'
npm install --prefix $toolchain --ignore-scripts --no-audit --no-fund npm@11.16.0
$npmCli = Join-Path $toolchain 'node_modules/npm/bin/npm-cli.js'
node $npmCli --version
node $npmCli run check:install-scripts
```

This leaves the system npm unchanged. Use the version declared by the current
source; do not approve new scripts merely to make an older runtime pass. Executable
Node preloads and ambiguous environment-key casing are refused by the policy check.

## Plan, review and install

First request a plan for the intended prefix. The default records source and
target observations and proposed commands; it does not build, pack or install.

```powershell
$prefix = Join-Path $env:APPDATA 'npm'
node $npmCli run install:local -- --prefix $prefix
```

Review the exact candidate and its command-gate evidence independently. Execution
requires a clean signed source checkpoint and successful `git verify-commit HEAD`.
The physical checkout must be its owning Git root, with `package.json` and
`package-lock.json` tracked at that HEAD. A plan made from changed manifest or
lockfile bytes records `inputsMatchHead: false` and cannot execute.
The helper checks source consistency but does not manufacture a review verdict.
After that review, execute against the same explicit prefix:

```powershell
node $npmCli run install:local -- --prefix $prefix --execute
```

Receipts and bounded command logs are retained beneath `artifacts/local-install/`.
An explicit absolute `--artifacts-dir` may select another receipt directory; it
must be outside the target prefix and cannot overwrite tracked source files.
The receipt binds the source HEAD/tree, manifest and lock hashes, actual npm/Node
runtime, physical target paths, packed bytes, commands and installed file checks.
Keep the receipt when an execution fails; a partial installation is not success.
Before the first target-mutating command, every packed `bin` target must exist and
begin with the exact LF-terminated `#!/usr/bin/env node` header. CRLF, BOM,
alternate interpreters, missing targets and ambiguous portable paths fail with
phase `packed_executable_admission`, error code
`LOCAL_INSTALL_PACKED_EXECUTABLE_HEADER_NONCANONICAL`, and
`targetMutationAttempted: false`. Restoring the committed LF bytes and repacking is
the recovery; exact post-install packed-file equality remains required.

## Script policy across installation boundaries

Global npm installation does not apply the source project's `allowScripts`
policy. The helper therefore installs its packed artifact globally with **all
scripts suppressed**, then uses the installed LexRunner package as a non-global
project. It retains the exact source lock there as deployment metadata, installs
that locked production dependency closure with scripts suppressed, and rebuilds
only the exact source-approved SQLite package under strict script policy.
`@smartergpt/lex` remains explicitly denied. It then checks pending script decisions,
native SQLite usability in a private fixture, and every installed packed file.

The selected SQLite 13.0.3 package ships N-API prebuilds and has no installation
script. Its exact native approval is retained as an explicit policy decision;
the helper's rebuild command currently executes no native build script. Treat
the private SQLite query as runtime evidence, not evidence of local compilation.
The ecosystem dogfood verifies the source and consumer's matching shipped
prebuild bytes for the active supported platform, version and registry identity;
it does not copy a 13.x binary into another package or repair a missing prebuild.

Lifecycle commands explicitly bind npm's `node-options` setting to the observed
nonexecuting Node options, or an effective empty value that survives nested npm.
An inherited environment variable or npmrc cannot inject a JavaScript preload
into an approved script. The observed Node runtime separately refuses executable
`NODE_OPTIONS` preloads. Source Git observations remove inherited `GIT_*` selectors
so another checkout cannot supply the candidate's HEAD or clean-state result.
These checks cover the installation policy and source binding; they do not qualify
protected loading or the complete executable dependency graph. Runtime probe
records establish bounded observation and packed-header records establish byte
canonicality only; neither grants execution authority, review, signature trust or
release qualification.

The public packed-consumer smoke is a separate check: its fresh consumer owns an
explicit strict policy. It approves only the inspected immutable LexRunner
artifact and exact reviewed native dependencies, and proves that a forged local
package claiming an approved native name/version cannot execute its script.
The smoke uses an owned loopback URL for packed bytes because npm 11.16.0 on
Windows mismatches local `file:` policy identities. Denying a package also
suppresses its executable shims in that npm version, so the inspected Runner
artifact receives an exact URL approval. These observations do not justify a
wildcard approval or relaxing Lex's denial.

## Check the active connection

Installing files does not reload an existing MCP process. Reconnect the intended
client after adoption, then verify its handshake, tool surface, explicit profile,
mutation denial and a read-only status request against the intended coordination
database. Keep those observations attached to the installed artifact and connection.

Local dogfood qualification does not establish full-suite success, merge
eligibility, protected-host qualification or public release. Public publishing
continues to follow the [signed release workflow](release-process.md).
