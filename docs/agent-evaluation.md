# Read-only agent evaluation

Use this evaluation before installing LexRunner or adding it to a repository. Its purpose is to
answer whether LexRunner belongs in the normal workflow, not to manufacture an adoption case.

## Safety boundary

The evaluation is read-only. The agent may inspect supplied files and run non-mutating repository
queries such as `git status`, `git branch --show-current`, `git log`, `git remote -v`, and existing
tool `--help` or `--version` commands. It must not:

- install a package or change a lockfile;
- create or edit files, plans, branches, worktrees, commits, tags, or stashes;
- call a mutating GitHub, issue, PR, release, package, or messaging API;
- push, merge, publish, authenticate, or request broader credentials; or
- execute repository-defined gates or scripts without separate approval.

If evidence is unavailable without one of those actions, record the uncertainty instead of
crossing the boundary.

## Evidence to inspect

1. **Workflow shape:** PR volume, concurrent branches, dependency ordering, integration branches,
   release cadence, and frequency of conflict or sequencing problems. Also inspect epics or
   backlogs whose tickets share prerequisites, and repeated verification commands that need
   retained evidence. These can fit the planning/gates layer without GitHub or concurrent PRs.
2. **Existing automation:** CI, merge queues, dependency bots, task runners, agent tools, and any
   current plan/gate/evidence system. Identify overlap instead of assuming replacement.
3. **Authority:** who may run code, create branches, push, open PRs, merge, publish, access secrets,
   and operate external services. Note which LexRunner layer would need each lane.
4. **Platform constraints:** Node/runtime policy, Windows/WSL/native boundaries, containers,
   self-hosted runners, network restrictions, and worktree support.
5. **Operational cost:** package access, configuration ownership, plan review, gate duration,
   artifact retention, support burden, and migration work.
6. **Evidence quality:** what is directly observed, what is inferred, what is stale, and what cannot
   be established read-only.

## Decision rubric

- **`adopt`** — dependency-aware multi-PR integration, task planning, or gated verification is routine, existing automation has a clear
  gap, authority is understood, and the maintenance cost is proportionate.
- **`pilot`** — there is a plausible fit, but one bounded repository/workflow trial is needed to
  validate overlap, cost, platform behavior, or authority.
- **`defer`** — the need may exist later, but a prerequisite such as runtime migration, package
  access, CI ownership, or workflow stabilization is missing now.
- **`not a fit`** — the repository lacks a dependency-planning, verification, or integration gap, existing automation
  already solves it with lower cost, or required authority/platform constraints conflict with the
  operating model.

Evaluate each layer independently. A Bitbucket-hosted repository or ticket-only
backlog can use a hand-authored `plan.json` and `lexrunner plan levels --plan
plan.json --json` without Git, forge access, a profile or tokens. Gates execute
declared commands and write evidence, so they require separate authorization and
an explicit local candidate. Do not run them as part of this evaluation. Neither
levels nor manual-plan receipts establish merge eligibility. See the packaged
[offline planning guide](offline-planning.md) and the README's
[Planning and gates only](../README.md#planning-and-gates-only) section before
rejecting a repository solely for its forge or lack of concurrent PRs.

## Required response

Return this compact report:

```yaml
decision: adopt | pilot | defer | not a fit
confidence: high | medium | low
fit:
  observed_problem: "..."
  useful_layers: [plan, merge-weave, evidence, fanout, assisted-agent-work]
overlap:
  existing_automation: ["..."]
  replace_or_complement: "..."
authority:
  currently_available: [read-repo, read-github]
  separately_required_for_trial: [write-local-plan]
  separately_required_for_adoption: [run-gates, push, open-pr, merge]
operational_cost:
  setup: low | medium | high
  recurring: low | medium | high
  notes: "..."
platform_constraints: ["..."]
uncertainty:
  - claim: "..."
    missing_evidence: "..."
smallest_reversible_trial:
  scope: "one repository, one frozen plan, dry-run only"
  preconditions: ["explicit approval to install", "explicit approval to write plan.json"]
  success_signal: "dependency order and gate preview add useful evidence"
  rollback: "remove the local package/config/artifact; no push or merge"
```

The recommendation must explain why the trial is smaller than full adoption and which new approval
would be required to run it. Do not convert a read-only evaluation into the trial automatically.

## Copy/paste prompt

> Evaluate this repository for LexRunner using `docs/agent-evaluation.md`. Stay read-only. Inspect
> workflow, PR concurrency, existing automation, authority, platform constraints, operating cost,
> and uncertainty. Return exactly one of `adopt`, `pilot`, `defer`, or `not a fit`, plus overlap,
> required authority, and the smallest reversible trial. Do not install, edit, push, open a PR,
> merge, publish, or authenticate without separate approval.
