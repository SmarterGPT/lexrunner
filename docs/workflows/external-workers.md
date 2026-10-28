# Planning and verification with external workers

Use this supported combination when Attempt preflight refuses governed execution,
including `windows_native_boundary_unavailable` / `broker_required`. LexRunner can
still create integration plans, compute dependency order, execute repository-bound
gates and inspect retained evidence. The human or external coordinator owns worker
assignment, implementation and integration. Describe the result as **LexRunner
planning and verification with externally coordinated execution and integration**.
It is not Runner-governed fanout, an accepted Attempt, or a Runner-governed merge.

## 1. Select the actual repository

Keep the preflight refusal and its declared runtime binding. Do not initialize the
shared container merely because an MCP server started there. For onboarding
guidance, call `workflow.guide` (source adapter: `workflow_guide`) with:

```json
{ "phase": "initial", "repoRoot": "D:\\dev\\actual-repository" }
```

`readiness.diagnosticBase` identifies the directory inspected. Relative `repoRoot`
values resolve against the server's captured startup directory; omitting it retains
that directory. This selects advisory diagnostics only, not execution/store/merge
authority. `doctor` itself continues to inspect its startup directory.

The `repoRoot` guide argument requires a release containing this update. On 2.5.0,
start a repository-specific MCP session in the actual repository; passing this
argument to that older guide does not retarget its diagnostics. Inspect the actual
profile before considering `local.init`, which is a write operation.

## 2. Plan and dispatch externally

Record features, dependencies, gate definitions, expected outputs and an integration
owner. The external coordinator assigns bounded work and records each worker's
repository, base and result commit, changed files, validation and unresolved issues.
Respect the repository's checkout and concurrency rules. This workflow does not
authorize new worktrees, concurrent edits to one index, containment changes or WSL.

Once actual PR inputs exist, `plan.create` can synthesize their integration plan.
Supply explicit `repoRoot`, `profileDir` and `outDir` where defaults are ambiguous;
retain `files.plan` and its routing receipt. `merge-order` computes that plan's
dependency levels. A plan's `maxWorkers` value is not evidence of worker dispatch.
External worker reports are review inputs, not manufactured Attempt receipts.

## 3. Integrate and freeze the candidate

The external integration owner combines reviewed changes in dependency order under
the repository's permissions. Record the resulting full commit SHA and exact
repository, review the combined diff and preserve any unresolved findings. Retain
the precise integration plan used to test it. Regenerate/review that plan if its
inputs changed; do not relabel evidence from an earlier candidate.

## 4. Run gates and read evidence back

Use `gates.run` for short synchronous gates or `gates.start` for reconnectable work.
Bind explicit `repoRoot`, `planFile` and `outDir`. Gates execute real commands and
need their own authorization even while Attempt execution is unavailable. A missing
gate definition or refused gate authority must be resolved before running it.

For `gates.start`, retain the returned `operationFile` and `operationSha256` and use
them with `gates.status`. Set `verifyArtifacts: true` to check the declared retained
artifacts. Inspect the terminal candidate binding and execution outcomes, then use
`status` with the exact plan and returned evidence path/hash when applicable. An
artifact reference or successful process exit alone is not verified evidence.

Reusing the same idempotency key, physical output directory and exact inputs returns
the existing operation. After a candidate/plan change, use a new operation/key;
changed inputs conflict with the old key. Unknown/interrupted admission does not
authorize automatic relaunch. See [durable gate recovery](../gates.md#long-running-operations-and-reconnects).

## 5. Report ownership and outcome

Retain the candidate SHA, plan, gate/evidence identities, artifact verification,
preflight refusal, external worker results, review disposition and integration
owner. If a merge was performed externally, record that explicitly. Passing gates
do not supply merge authorization or turn external execution into a governed Attempt.
Keep a refusal/unknown result visible instead of converting it to success.

## Windows prerequisite and installation status

The missing execution prerequisite is the **qualified native Windows
WorkspaceBoundary helper plus its production broker/selection integration**.
LexRunner 2.5.0 has no supported installation/configuration procedure that enables
native Windows Attempt execution. Its refusal does not establish whether a helper
file is present. No environment variable or caller digest enables this backend.

The optional signed MSI/direct-launch work and native executor tests are development
qualification. Installing that application alone does not connect the production
resolver or qualify the complete launch/Attempt path. The
[activation checklist](../architecture/windows-production-activation.md) records
what remains; [MSI engineering instructions](../../installers/windows-helper/README.md)
are not a supported end-user activation procedure. npm installs LexRunner only;
it never downloads, installs, repairs or updates the helper.

When native execution is required, wait for a release with a qualified deployment
profile and its explicit installation procedure. An already authorized
[Windows-to-WSL projection](native-wsl-projection.md) is a separate option with its
own prerequisites and acceptance checks; `broker_required` is not permission to
install WSL, move the checkout or silently switch execution hosts.
