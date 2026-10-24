# LexRunner (`lexrunner`)

LexRunner turns a changing set of pull requests into a reviewable integration program: discover
the work, freeze a dependency plan, run bounded gates, preserve evidence, and merge only with
explicit authority.

It is useful when a repository has concurrent PRs, dependencies between changes, repeated local
and CI checks, or agent-assisted implementation that needs a durable handoff. It is usually not a
fit for a repository with one occasional PR and no integration-order problem.

> **Ask your agent:** “Read [`docs/agent-evaluation.md`](docs/agent-evaluation.md), evaluate this
> repository without installing or changing anything, and return `adopt`, `pilot`, `defer`, or
> `not a fit` with the smallest reversible trial.”

That evaluation is deliberately read-only. Installing the package, writing a plan, creating a
branch, pushing, opening a PR, or merging requires separate approval.

## Start here

The [2.5.0 release](docs/releases/2.5.0.md) adds durable gate operations, bounded retained-evidence
inspection, safer repository-bound planning, and preservation-first workspace onboarding. The progressive
help introduced in 2.4.0 remains available: use `lexrunner --help-all` for every family and
compatibility alias, or `lexrunner <command> --help` for full options and nested operations.
Presentation, guidance, and retained evidence do not grant execution or merge authority.

For your first trial, install **LexRunner only** in a GitHub repository with open
PRs. Node.js 24+ and Git are required. npm installs LexRunner's dependencies; you
do not need to install Lex, AXF, LexSona, a policy-host service, or an MCP server
separately for this CLI workflow. These examples target 2.5.0; verify registry availability rather
than inferring publication from this repository.

```bash
npm install --save-dev @smartergpt/lexrunner@2.5.0
npx lexrunner --version
npx lexrunner weave discover --json
```

Installation changes your package manifest, lockfile and dependencies. Discovery
reads GitHub; private repositories need an authorized `GITHUB_TOKEN` supplied to
the process. See the [merge-weave quickstart](MERGE_WEAVE_QUICKSTART.md) for setup,
authentication and the complete first-use journey:

**Discover → freeze a plan → inspect dependencies → preview gates.**

The first useful result is an inspected plan and gate preview. A dry run neither
executes gates nor proves merge eligibility. The quickstart separates local writes,
command execution, independent review and the explicit merge boundary. Single-repository
GitHub plans bind explicit refs and commits for local integration. The walkthrough
explains clean-checkout preparation, exact-input checks and separately authorized execution.

[Start the walkthrough](MERGE_WEAVE_QUICKSTART.md) ·
[Choose another SmarterGPT workflow](https://smartergpt.dev/docs/how-to-use/)

## Add capabilities when needed

LexRunner’s supported workflow has grown in layers. A normal user can stop at any layer.

| Layer               | Current capability                                                                                           | First surface                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| Deterministic plan  | Freeze PRs and declared dependencies into schema-versioned `plan.json`                                       | `lexrunner weave plan`                    |
| Merge-weave         | Compute merge order, preview integration, run gates, and apply authorized merges                             | `lexrunner weave *`, `lexrunner gate run` |
| Run and evidence    | Persist bounded receipts, independent verification, acceptance, and artifacts                                | `lexrunner attempt *`                     |
| Fanout              | Harvest and analyze issue/PR evidence for parallel work planning                                             | `lexrunner fanout *`                      |
| Assisted agent work | Prepare an immutable packet and workspace envelope, attach a foreground-owned worker, then verify its claims | CLI/MCP Attempt lifecycle                 |

The ADR-010 coordination model is accepted and its assisted Attempt lifecycle is implemented.
LexRunner also has a tested headless reconciliation **application boundary**, but it is not a
general production supervisor: there is no approved public headless launch surface, native
host/reboot recovery remains release evidence, and Stage 5 fault-injection and authority expansion
remain unproven. See [ADR-010](docs/adr/ADR-010-agent-work-orchestration-protocol.md) and the
[headless proof boundary](docs/architecture/headless-supervisor.md).

## Architecture boundary

LexRunner has two contracts that must not be blurred:

- **Stateless integration core:** plan, gate, status, and weave services consume frozen inputs.
  At integration time, `plan.json` is the sole authority for dependency order and merge intent.
  The integration core never reads coordination state or `.smartergpt/` as hidden truth.
- **Explicitly stateful coordination service:** ADR-010 WorkItems, Runs, Attempts, controller
  leases, workspace leases, receipts, and verification live behind `CoordinationStore` and
  workspace lifecycle adapters. That state coordinates implementation work; it does not authorize
  the integration core or silently alter a frozen plan.

`.smartergpt/` is a portable example profile, not a runtime dependency. User/work artifacts belong
in explicit stores, ignored local deliverables, CI artifacts, or PR comments—not in the package
source tree. Canonical terms live in [`docs/TERMS.md`](docs/TERMS.md).

## Authority and safety

- Discovery, status, planning, schema validation, merge-order calculation, and dry runs are
  non-merging operations.
- Gate commands execute the commands declared by the reviewed plan; inspect them before running.
- Git/GitHub writes, delivery, release, and merge are separate authority lanes.
- Worker receipts are claims. LexRunner-owned verification and acceptance are the evidence used by
  the coordinator.
- Assisted and headless control share durable nouns and fencing rules; neither mode gains implicit
  merge, credential, release, or external-service authority.

## Install and authenticate

Ecosystem 3.1 requires Node.js 24 or newer. The npm package is publicly readable without
an npm login. Current source uses Apache-2.0; 2.1.0 is the first public npm release under those terms. Earlier published versions retain their applicable licenses.

```bash
npm install --save-dev @smartergpt/lexrunner
npx lexrunner --version
```

Global installation is also supported:

```bash
npm install --global @smartergpt/lexrunner
lexrunner --version
```

Do not place npm tokens in the repository or a chat transcript. Windows/private-package validation
is documented in the [Node 24 migration guide](docs/node-24-migration.md).

`lexrunner` is the canonical CLI name. The existing `lex-pr` executable remains an additive
compatibility alias and invokes the same program, so existing automation does not need to change.

The checked-in package version is the single source for `lexrunner --version` and
`lex-pr --version`.

<!-- BEGIN GENERATED PACKAGE VERSION -->

Current repository package version: **2.5.0**. npm availability and dist-tags are separate
release evidence; inspect the registry rather than inferring publication from source metadata.
<!-- END GENERATED PACKAGE VERSION -->

See the [2.5.0 durable-operations release](docs/releases/2.5.0.md), the
[2.4.0 progressive-help release](docs/releases/2.4.0.md), the
[2.3.0 selected-work release](docs/releases/2.3.0.md), the
[2.2.0 frozen-input release](docs/releases/2.2.0.md), the
[2.1.0 open-source release](docs/releases/2.1.0.md), the
[2.0.2 generated timeout correction](docs/releases/2.0.2.md), the
[2.0.1 MCP identity correction](docs/releases/2.0.1.md), the
[2.0.0 plan-bound evidence release](docs/releases/2.0.0.md), the
[1.5.2 exact Lex alignment release](docs/releases/1.5.2.md), the
[1.5.1 release correction](docs/releases/1.5.1.md), the
[1.4.1 canonical CLI release](docs/releases/1.4.1.md), the
[1.4.0 native-host boundary release](docs/releases/1.4.0.md), the
[1.3.0 dogfood release](docs/releases/1.3.0.md), the
[1.2.1 publication repair](docs/releases/1.2.1.md), and the underlying
[1.2.0 compatibility decision](docs/releases/1.2.0.md) for package disposition, semver rationale,
supported assisted behavior, and deferred guarantees.

## Choose a surface

- **Human CLI:** follow the [first-use walkthrough](MERGE_WEAVE_QUICKSTART.md).
- **Agent/MCP:** LexRunner ships `lexrunner-mcp`; use it for plans, gates and
  integration. No MCP setup is needed for the CLI trial. Tool calls can write
  artifacts or run commands even when merge mutations are disabled. See the
  [compatibility and setup guide](docs/first-use-compatibility.md), plus
  [`docs/AX.md`](docs/AX.md) and [`README.mcp.md`](README.mcp.md).
- **Assisted agent work:** run `attempt preflight` before packet construction. When it reports
  `broker_required`, use `attempt projection status|prepare` to bind the exact committed base into
  native WSL, then continue with `attempt prepare`, `attempt start`, worker
  attachment/heartbeat, receipt submission, verification, and acceptance. The foreground host
  still owns worker launch. Follow the
  [native Windows-to-WSL projection workflow](docs/workflows/native-wsl-projection.md) for recovery
  and cleanup.
- **Advanced operators:** read the
  [orchestration primitives](docs/architecture/orchestration-primitives.md),
  [headless supervisor boundary](docs/architecture/headless-supervisor.md), and
  [security guidance](docs/security/agent-worktree-containment.md).

The normative CLI/MCP inventory is generated from live registrations and stored in
[`docs/architecture/cli-mcp-surface.json`](docs/architecture/cli-mcp-surface.json). Deprecated
top-level aliases remain migration aids, not recommended entry points.

## Reading order

1. [Agent fit evaluation](docs/agent-evaluation.md) — decide whether to adopt, pilot, defer, or
   decline.
2. [Merge-weave quickstart](MERGE_WEAVE_QUICKSTART.md) — run the smallest integration workflow.
3. [Canonical CLI/MCP surface](docs/architecture/canonical-cli-mcp-surface.md) — choose stable
   commands and tools.
4. [AX contract](docs/AX.md) — understand bounded output, errors, parity, and exceptions.
5. [ADR-010](docs/adr/ADR-010-agent-work-orchestration-protocol.md) — understand assisted agent-work
   ownership and maturity.
6. [Documentation index](docs/README.md) — browse operator, fanout, MCP, audit, security, and
   contributor material.

Historical v2 design drafts are retained for provenance only. They do not describe a sibling
package, active migration, or current runtime contract.

## Development

```bash
nvm use
npm ci
npm run lint
npm run build
```

For implementation work, use the touched/adjacent gate selector and let CI prove the full suite on
high-risk changes:

```bash
lexrunner gate select --base <base-sha> --head <head-sha> --json
```

Release validation remains exhaustive. See [`AGENTS.md`](AGENTS.md),
[`CONTRIBUTING.md`](CONTRIBUTING.md), and the
[implementation gate contract](docs/architecture/implementation-gates.md).

## Package and licensing

- Package: `@smartergpt/lexrunner`
- CLI: `lexrunner` (`lex-pr` compatibility alias)
- MCP bin: `lexrunner-mcp`
- Runtime dependency: `@smartergpt/lex` (MIT)
- LexRunner source license: Apache-2.0; earlier releases retain their applicable terms

See [`LICENSE.md`](LICENSE.md), [`NOTICE.md`](NOTICE.md), and
[ADR-008](docs/adr/ADR-008-lex-packaging.md).

SmarterGPT was founded by Joseph Gustavson (Guffawaffle). See
[stewardship](GOVERNANCE.md), [contributing](CONTRIBUTING.md), and
[project identity](BRAND.md). Commercial use and forks are permitted under the
license; code licensing grants no credentials, tenant access or runtime authority.
