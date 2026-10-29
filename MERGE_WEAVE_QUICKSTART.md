# Your first merge-weave plan

Turn open GitHub PRs into a frozen plan you can inspect before executing anything.
The first useful result is a validated dependency order and a gate preview. There
is no fixed five-minute promise: repository access and dependency setup vary.

## 1. Install and discover

Use an existing local Git checkout with a GitHub remote, Node.js 24+ and Git.
This guide uses the published 2.5.0 release. For authored tasks without GitHub,
start with the packaged [offline planning guide](docs/offline-planning.md).
Run these commands from that repository's root:

```bash
npm install --save-dev @smartergpt/lexrunner@2.5.0
npx lexrunner --version
npx lexrunner weave discover --json
```

The install updates `package.json`, the lockfile and `node_modules`. Use your
repository's package-manager policy if it does not use npm. No separate Lex, AXF,
LexSona or MCP install is needed. The CLI does not require the optional protected
policy-host service for this ordinary workflow.

Discovery reads GitHub and prints PR metadata. For private repositories, provide
an authorized `GITHUB_TOKEN` to this process through your credential manager or
shell environment. Signing into `gh` alone does not export it to LexRunner. Never
put a token in a tracked file or command example. Public unauthenticated discovery
may work within GitHub's API limits. A permissions or rate-limit failure is a
setup issue, not an empty PR list.

If repository detection fails, supply `--owner OWNER --repo REPOSITORY` to discovery
and planning. Both commands currently use GitHub; another forge is not supported
by this walkthrough. If there are no suitable PRs, stop here or use a repository
with real integration-order work. Do not create artificial PRs just to adopt it.

## 2. Freeze a plan

Choose an unused output filename so an earlier plan is not overwritten:

```bash
npx lexrunner weave plan --from-github --output plan.json --json
```

This reads GitHub again and **writes `plan.json` locally**. The JSON printed to
stdout is a summary, not the plan; use `--output`, not shell redirection, to save
it. Discovery and planning are separate observations of changing PRs.

Open the saved file. Confirm the repository, target branch, selected PRs and
recorded heads, declared dependencies and gate definitions. Planning includes
drafts by default. Use `--labels LABEL`, `--exclude-prs NUMBER`, or `--target BRANCH`
when needed, then inspect the replacement plan. `discover --suggest` produces
heuristic suggestions; inspect dependencies rather than treating suggestions as
accepted requirements.

The generated required gates are `lint`, `typecheck` and `test`. Review their actual
commands and make them match executable checks in this repository before running
anything. Generated defaults do not prove that those scripts exist or are adequate.
After edits, repeat validation and review; prior evidence belongs to the old plan.

## 3. Inspect and preview

```bash
npx lexrunner schema validate plan.json --json
npx lexrunner weave merge-order plan.json --json
npx lexrunner gate run plan.json --dry-run --json
```

Validation must succeed; the order must reflect the dependencies you intended.
A cycle or missing dependency must be resolved before continuing. The final command
previews the gate execution order without running gate commands. Preview paths may
write local diagnostic artifacts; use an appropriate writable workspace.

**This is the first-use stopping point:** retain the inspected plan and preview
with your work artifacts. Nothing in this walkthrough so far merges PRs, and a
successful preview is not a passed test, independent review or merge authorization.

## 4. Run the reviewed gates

When the commands and their effects are authorized, run them in the intended
checkout with its dependencies and required tools installed:

```bash
npx lexrunner gate run plan.json --artifact-dir artifacts/first-use --json
```

This executes the plan's commands and writes results. Read failures and artifact
references; never substitute an empty or always-successful command to get green
status. These local results describe the checkout tested; they do not prove that
every proposed merged candidate passed. Repository CI and candidate review remain
required. See [gate and review policy](docs/review-gate.md).

## 5. Integrate the frozen inputs locally

Since 2.2.0, the single-repository generator records explicit repository, target and source
refs/commits in `gitInputs`. Local integration uses those commits rather than resolving
`PR-123` as a branch name. Older 2.1.0 executors do not support this contract; upgrade
instead of stripping bindings from a new plan. See [frozen inputs](docs/frozen-git-inputs.md).

Before execution, select the intended clean checkout and settle installation changes
under repository policy. Keep the reviewed plan and other untracked outputs outside
the checkout or in paths already covered by its ignore policy. Verify repository
identity, current PR heads/base, protections, required checks and independent review.
Changed inputs require a new plan and renewed evidence; do not rewrite frozen SHAs
merely to make execution succeed. Authorization must cover fetching, checkout changes,
gate commands and local merges.

From that clean checkout, with the reviewed plan's absolute path:

```bash
npx lexrunner weave apply --plan "<absolute-path-to-reviewed-plan.json>" --execute --json
```

Execution fetches the declared refs by default, verifies their exact commits, checks
out frozen sources for gates and builds a local integration branch with receipts.
Moved or missing inputs fail explicitly. A passing command that changes tracked files,
staging, HEAD or the integration branch fails the operation boundary; unexpected
changes are preserved for inspection. This is bounded local evidence, not isolation
from concurrent hostile writers or remote merge eligibility. Remote PR integration
still follows its own exact-candidate review, checks and authorization.

The `--execute` flag selects the shared merge application service. Without it,
`weave apply` runs gates without applying merges. Multi-repository generation remains
legacy-unbound and is outside this frozen-input walkthrough.

## Next choices

- [CLI/MCP setup and component compatibility](docs/first-use-compatibility.md)
- [Independent review contract](docs/review-gate.md)
- [Assisted and headless limits](docs/architecture/headless-supervisor.md), if you
  are moving beyond integration planning into agent execution
- [SmarterGPT starting guide](https://smartergpt.dev/docs/how-to-use/), if your need
  is memory or repeatable workspace capabilities rather than PR integration
