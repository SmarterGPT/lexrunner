# Frozen Git inputs for local integration

Contract shipped in [LexRunner 2.2.0](releases/2.2.0.md). This capability is absent
from 2.1.0.

Single-repository GitHub generation emits Schema `1.0.1` with explicit `gitInputs`.
Each `PR-123` remains a graph identity and display label. The source ref is
`refs/pull/123/head` in the target repository, including when the PR comes from a fork.
The expected source commit comes from PR metadata; the target branch commit is
queried independently. PRs targeting another branch and dependencies qualified to
another repository are rejected by this single-repository generator.

<!-- lexrunner-plan-example:frozen-git-inputs -->

```json
{
  "schemaVersion": "1.0.1",
  "target": "main",
  "items": [{ "name": "PR-123", "deps": [], "gates": [] }],
  "gitInputs": {
    "schemaVersion": "1.0.0",
    "repository": "https://github.com/example/repo.git",
    "checkoutRemote": "origin",
    "acquisition": "fetch",
    "target": { "ref": "refs/heads/main", "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    "sources": [
      {
        "item": "PR-123",
        "ref": "refs/pull/123/head",
        "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }
    ]
  }
}
```

The SHAs above illustrate the shape; use observed complete commit IDs in a real plan.
Bindings survive artifact loading and participate in both plan and artifact digests.
They are consistency expectations, not approval or authenticated repository custody.

## Preparation and execution

The shared CLI/MCP merge application service requires existing execute authority
and a clean checkout. Preview reports `gitInputBinding: frozen` or `legacy-unbound`
without contacting Git or proving that any input is available or current.

For a bound execution, preparation checks the declared checkout remote's repository
identity. HTTPS and SSH forms of the same repository can match; file URLs also support
explicit local repositories. Acquisition uses the URL in the plan rather than selecting
a remote from the item label. Normal host Git configuration and credential routing still
apply; an identity match is not an independent authentication guarantee.

- `fetch` (the generated default) permits fetching only the declared fully qualified
  refs into runner input refs. Tags and recursive submodule acquisition are disabled.
  Each fetched object must match its frozen commit ID and have Git object type `commit`.
  A failed fetch never falls back to a local branch. Resume repeats the declared
  acquisition and rejects moved refs.
- `local-only` performs no fetch. The declared refs and commit objects must already
  exist locally under their exact names. Select this through the generation API's
  `gitAcquisition` option or author it in a new plan before registering its digest.
  It verifies local observations, not current remote state.

Missing objects, moved refs, or a different checkout require an explicit remedy.
Do not overwrite expected SHAs to make an existing plan pass. Reassess and create a
new artifact if the intended inputs changed.

Gates check out the frozen source commit. Merges use that commit directly and build
a local integration branch from the frozen target. The target branch is not advanced.
Checkpoints reside under the selected working directory and validate the same plan
digest and source/target commits on resume. No additional label resolution or fetch
occurs inside a bound merge operation. Legacy `GitOperations.executeWeave` rejects
bound plans; use the shared application/resume service.

Bound operations verify clean index/worktree state, the expected HEAD and integration
branch at operation boundaries. A command that exits zero after changing tracked files,
staging changes or creating a commit does not pass the integration gate. Unexpected
changes remain available for inspection; the runner does not clean or reset them.
Post-check mutation also prevents a completed outcome, even if earlier merges succeeded.
These are bounded Git observations, not isolation against a concurrent hostile writer.

## Gates and evidence

Generated standard gates use actual npm commands and reject unknown selected gate
names. They do not guess project output paths such as `test-results.xml` or `coverage/`.
Execution receipts retain command, output and result evidence. If your check requires
additional files, author explicit `artifacts` in the plan; the existing evidence checker
still rejects missing, stale or unsupported declared outputs. Successful local integration
does not establish remote merge eligibility or waive independent review and required checks.

## Compatibility

This is an additive optional field under the repository's Schema v1 patch rule.
The binding itself requires every field; there are no guessed binding defaults.
Old parsers with strict unknown-field validation reject bound plans and must be upgraded;
do not strip the binding to make an old executor accept one.

Existing unbound v1 plans remain readable and keep their legacy execution semantics.
Status and merge summaries identify them as `legacy-unbound`, and newly prepared legacy
checkpoints carry a warning: their Git heads were selected at preparation, not synthesis.
Historical plan bytes and receipts are not rewritten. Produce and review a new bound plan
to migrate. Multi-repository generation remains legacy-unbound; this slice does not qualify
multi-checkout integration. No new public intent verb or major schema is accepted here.
