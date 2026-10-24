# AGENTS.md — lexrunner

> **North Star**
> **Fan-out tasks as multiple PRs in parallel, then build a merge pyramid from the blocks.
> Compute dependency order, run gates locally, and merge cleanly.**

This document orients all agents (human and automated) toward the same purpose and defines the
non‑negotiable operating rules for **lexrunner**. It is intentionally **non task‑specific** and
should remain stable even as implementation details evolve.

---

## 0) Core Premise (Do Not Drift)

1. **Deterministic Program for Merges.** At **integration time**, the runner consumes a **single frozen input** (`plan.json`, Schema v1), executes a **deterministic merge plan**, and emits verifiable artifacts.
   **Important scope note:** This “single input” constraint applies **only to the integration runner**. It **does not** limit how issues are defined or how implementation work is done.
2. **Merge Pyramid.** Decompose work into many small PRs, compute a **dependency‑ordered pyramid** (topological order), and integrate bottom‑up.
3. **Uniform Gates.** Execute the same **gates** (lint/type/test, policy checks, etc.) **locally and in CI**, with the same inputs and expectations.
4. **Two‑Track Separation (Firm).**
   - **Stateless integration core** is the plan/gate/status/weave portion of `src/*` plus its CLI and MCP adapters. It is **packageable** and reads no coordination state as integration truth.
   - **Coordination service** is explicitly stateful behind ADR-010 `CoordinationStore` and workspace-lifecycle adapters. It owns WorkItems, Runs, Attempts, leases, receipts, and verification during implementation, but is never an integration-time input.
   - **`.smartergpt/` is a portable user workspace** and canonical profile. It is **not read at runtime** by the runner. It can contain example profiles, prompts, policies, and developer tooling.
5. **Reproducibility Over Magic.** No hidden state, no “auto inference.” Integration inputs are explicit; outputs are traceable.
6. **Auditability.** Every decision is inspectable (plan, gates, logs, outcomes).
7. **Cumulative Intelligence.** Every execution advances the work or improves the next attempt.
   Terminal executions leave an inspectable durable delta; retries record a meaningful changed
   premise. See [LexRunner Principles](docs/PRINCIPLES.md).

> ### Clarification: Scope of “Only Runtime Truth”
>
> - **Integration-time (Runner):** `plan.json` is the **only** input the runner reads to compute order and merges.
> - **Development-time (Issues & Coding):** Implementation agents (humans/Copilot) are expected to use **Issue descriptions, specs, and project principles** to do the work. The runner does not constrain this phase.

---

## 1) Lifecycle & Surfaces (Who uses what, when)

**Stage A — Issue Definition**

- _Owners:_ PM/Author
- _Surfaces:_ GitHub Issues / ADRs / specs
- _Artifacts:_ Clear acceptance criteria, rationale, links

**Stage B — Implementation Work**

- _Owners:_ Humans & Copilot (implementation agents)
- _Surfaces:_ Branches/PRs, tests, docs, `.smartergpt/` workspace tools
- _Inputs:_ Issue descriptions + project principles (this document)
- _Outputs:_ One or more focused PRs per task
- _Optional coordination:_ ADR-010 services may persist WorkItems, Runs, Attempts, leases, worker
  sessions, receipts, and verification. Assisted control is implemented. The headless supervisor
  application boundary is tested, but public headless launch and Stage 5 native/reboot fault
  injection are not production claims.

**Stage C — Plan Synthesis (Out of Runner Scope)**

- _Owner:_ Plan‑generator tool or workflow
- _Inputs:_ Graph of PRs, declared dependencies, policy, optional metadata from Issues
- _Output:_ **`plan.json` (Schema v1)** — the frozen integration input

**Stage D — Integration Runner (This Project)**

- _Owner:_ lex‑pr‑runner (TS core)
- _Input:_ `plan.json` only
- _Behavior:_ Compute topo order, run command gates uniformly, and prepare an exact replayed
  candidate for review
- _Artifacts:_ Gate logs (JUnit/SARIF/etc.), status tables, PR comments

**Stage D.5 — Independent Review Gate (Mandatory by Default)**

- _Owner:_ A reviewer agent or human who did not implement the candidate under review
- _Input:_ Exact candidate head, exact base head, scoped review task, command-gate evidence
- _Behavior:_ Review the replayed diff, run targeted read-only checks, and return `PASS` or `BLOCK`
- _Artifacts:_ Findings with severity and file/line evidence, tested evidence, residual risks, and
  an auditable review receipt
- _Invalidation:_ Any candidate-head change invalidates the prior verdict and requires a fresh
  review
- _Bypass:_ Allowed only as an explicit authorized override. It must warn all acting agents,
  record authority and reason, and report `review_bypassed`; it MUST NOT be represented as
  `PASS`
- _Runbook:_ [Independent merge review gate](docs/review-gate.md)

**Stage E — Merge & Release**

- _Owner:_ Maintainers/automation
- _Artifacts:_ Changelog, tags, release notes
- _npm publication boundary:_ Agents may prepare candidates, run
  `npm run release:publish:check`, and create signed tags. The repository's exact
  `.github/workflows/release.yml` stable-tag job may execute non-dry-run `npm publish` only through
  npm's package-scoped GitHub OIDC trusted publisher after the target commit is signed by the
  authorized release-owner GPG fingerprint, is contained in `main`, and passes the signed tag,
  version, full gates, deterministic build, packed boundary, and dry-run checks. Agents, local
  shells, pull requests, branch builds, canaries, workflow dispatches, and self-hosted runners MUST
  NOT execute non-dry-run publication. A human maintainer owns the signing key, one-time npm trust
  configuration, tag authorization, and any manual recovery.

---

## 2) Runner Contract (Integration-Time)

- **Single Runtime Input (Scoped):** `plan.json` (Schema v1) is the **only** integration input the runner reads.
  _Development agents remain free to use Issues, ADRs, or other docs._
- **Outputs:** Deterministic artifacts (gate results, merge decisions). Post as **PR comments or CI artifacts**, **not** as code changes in the runner path.
- **Side‑Effects:** Only those declared in `plan.json` (e.g., which PR to merge, in what order). No implicit network calls or mutations.
- **Idempotence:** Same `plan.json` → same decisions (modulo external state, e.g., a PR already merged).
- **State boundary:** Integration services MUST NOT consult `CoordinationStore`. Coordination may
  produce verified PRs before plan synthesis, but it cannot alter dependency order, gates, or
  merge authority after the plan is frozen.

---

## 3) Plan Model (Schema v1 — High Level Contract)

- **Nodes:** PRs/commits with identifiers, metadata, and **declared dependencies**.
- **Edges:** Dependencies only (no implicit ordering).
- **Gates:** Named checks per node (e.g., `lint`, `type`, `unit`, `e2e`, `policy`). Each gate has a command/adapter reference and expected status semantics.
- **Policy:** Merge rules (e.g., “all required gates green,” “no fast‑forward across failing siblings,” “block on security policy violations”).
- **Outputs:** Expected artifacts per gate (logs, JUnit, coverage, SARIF, etc.).

#### Policy Examples (Non-Normative)

```yaml
requiredGates: ["lint", "type", "unit"]
optionalGates: ["e2e"]
maxWorkers: 2
retries:
  e2e: { maxAttempts: 2, backoffSeconds: 30 }
overrides:
  adminGreen:
    allowedUsers: ["repo-admins"]
    requireReason: true
security:
  # Fix ALL vulnerabilities when patches are available (see §16)
  blockOnFixableVulnerability: true
  trackSeverities: ["critical", "high", "moderate", "low"]
mergeRule:
  # “All required gates green; optional gates ignored unless specified”
  type: "strict-required"
```

#### Schema Versioning

- Plans must include `"schemaVersion": "1.x.y"`.
- Versioning follows SemVer:
  - **Patch:** additive, optional fields or docs only.
  - **Minor:** additive required fields with safe defaults.
  - **Major:** breaking changes to structure or semantics.
- The runner refuses plans with unknown **major** versions.

_Anything not in the plan is out of scope for the runner._

---

## 4) Merge Pyramid & Ordering Rules

1. **Topological Sort:** Compute an order from leaves → root such that a node runs only after all dependencies are green.
2. **Parallelism:** Independent subgraphs may run concurrently **up to the concurrency limits** specified by policy/plan.
3. **Promotion:** A node is eligible to merge when all **required gates** pass and **policy** authorizes.
4. **Short‑Circuiting:** If a dependency fails on required gates, **do not** run dependents (mark as blocked).

### Runner State Model (Statuses)

| Status     | Meaning                                              | Merge Eligibility |
| ---------- | ---------------------------------------------------- | ----------------- |
| `pass`     | All required gates passed                            | Eligible          |
| `fail`     | One or more required gates failed                    | Not eligible      |
| `blocked`  | A dependency failed/blocked; node not executed       | Not eligible      |
| `skipped`  | Policy or config excludes gates for this node        | Not eligible      |
| `retrying` | Gate marked retryable; attempt in progress (bounded) | Not eligible      |

### Umbrella Branch Pattern (When Main is Blocked)

When branch protection or pending approvals block direct merges to `main`, use an **umbrella branch**:

1. **Create umbrella branch:** `integration/umbrella-YYYYMMDD` or similar
2. **Merge-weave into umbrella:** Apply normal topo-sort and gate execution
3. **Umbrella builds foundation:** All PRs merge to umbrella, conflicts resolved there
4. **Final umbrella → main:** This single PR goes through full gates and approval
5. **Authority:** Eager PM may authorize the final merge when local CI passes

**Key insight:** Individual PR blocks don't matter during weave—we're building a verified bundle.
The constraint applies only to the **final push to main**.

---

## 5) Gates — Uniform Execution

- **Same Everywhere:** Gate execution logic and defaults must match **local and CI**.
- **Stable Interfaces:** Each gate produces structured results (status, duration, artifacts, logs). Prefer machine‑readable outputs (JUnit, SARIF) in addition to human logs.
- **Exit Codes & Semantics:** `0` = pass, `>0` = fail; distinguish “blocked” vs “failed” in the runner’s state model.
- **Caching (Optional):** Allowed, but must not change semantics. Cache keys should derive from inputs/artifacts so replays are consistent.

---

## 6) Two‑Track Separation (Enforced)

- **Core Runner (Track A):** stateless plan/gate/weave services, CLI, MCP adapters, packaging, and CI recipes. _Never_ hard‑link or read `.smartergpt/` at runtime.
- **Coordination Service (explicit stateful boundary):** ADR-010 application services and their
  injected stores coordinate implementation Attempts. Durable state is authoritative only for
  that lifecycle and cannot become hidden input to Track A integration.
- **Portable Workspace (Track B):** `.smartergpt/` contains examples, profiles, prompts, policies, local tooling, and deliverables for **humans and agents**. It is **replaceable** and **repo‑portable**.

**Why this matters:** Repos can adopt lex‑pr‑runner without inheriting your personal workspace, and your workspace can travel across repos without changing the runner. This is the foundation for determinism and portability.

---

## 7) Agent Roles

- **Implementation Agents (Humans/Copilot):** Build the code guided by Issues and project principles; produce small PRs with explicit dependencies.
- **Plan Generator (Out of Runner Scope):** Transforms Issues/PR graph into `plan.json`. May live in a separate tool or workflow.
- **Runner Core Agent:** Maintains the TS source of truth (Zod schemas, topo logic, CLI). Guards determinism and contracts.
- **Gate Executors:** Implement gate adapters/commands; ensure uniform behavior local/CI; publish structured artifacts.
- **MCP Adapter Agent:** Provides a clean interface for external tools/orchestrators; adheres to the runner contract.
- **Documentation Agent:** Keeps `README.md`, `AGENTS.md`, and policy docs current with behavior and contracts (not implementation churn).

---

## 8) Operational Rules (Do / Don’t)

**Do**

- Treat `plan.json` as the **only integration‑time input** for the runner.
- Keep the runner **stateless**; derive integration state from inputs and external APIs declared in the plan.
- Keep coordination state behind explicit store interfaces, fenced revisions, bounded adapters,
  and independently verified evidence.
- Prefer **pure functions** and small modules. TS‑first with Zod schemas.
- Emit artifacts to **deliverables or PR comments**, not into source directories.
- Uphold **imperative commit messages** (e.g., “Add…”, “Fix…”, “Refactor…”).

**Don’t**

- Don’t read `.smartergpt/` at runtime.
- Don’t infer dependencies from file paths or heuristics. Only the plan decides.
- Don’t let WorkItem, Run, Attempt, worker-session, or receipt state influence a frozen integration
  plan except through an explicit plan-synthesis step before integration.
- Don’t hide side‑effects behind environment variables. All effects must be declared in the plan or policy.
- Don’t fork logic between local and CI paths.

---

## 9) Failure Handling & Recovery

- **Gate Failure:** Mark node `failed`; propagate `blocked` status to dependents. Surface logs and artifacts.
- **Flakes:** If a gate is marked “retryable” by policy, bound the retries and always record attempts.
- **External Errors (API/outage):** Classify separately from test failures; do not merge on ambiguous state.
- **Manual Overrides:** Allowed only through explicit policy hooks (e.g., “admin green”). All overrides are logged with rationale.

---

## 10) Observability & Artifacts

- **Where:** Post structured results as PR comments and/or CI artifacts. Keep **diagnostics out of the runner’s source tree**.
- **What:** Status tables, dependency graphs, gate summaries, links to detailed logs (JUnit, SARIF, coverage, HTML reports).
- **Why:** Auditable paper trail and reproducible investigations.

---

## 11) CI Alignment & Least-Privilege

- **Same entrypoints:** CI invokes the same runner CLI as local.
- **Tokens:** Grant only what's needed for status + merges (`contents:read`, `pull_requests:write`, `statuses:write`); avoid admin scopes.
- **Isolation:** Run gates in containers where feasible for reproducibility.
- **Failure is final:** Required gate failure fails the job; no silent retries unless policy permits.
- **Compose/workflow skeleton:** Provide templates that spin up only what's needed for gates.
- **Contract compliance:** Fail the job if any required gate fails or if the plan contract is violated.
- CI must run the **same** CLI entry points as local.
- Provide a **compose/workflow skeleton** that spins up only what’s needed for gates.
- Fail the job if **any required gate** fails or if the **plan contract** is violated.

---

## 12) Coding Conventions (TS‑First)

- **Language:** TypeScript.
- **Schemas:** Zod. Export parse/validate helpers.
- **CLI:** Commander (or equivalent) with stable flags; avoid breaking changes.
- **Style:** Small, testable modules; deterministic pure logic around topo/gates; adapters isolate side‑effects.
- **Tests:** Unit tests for topo/gates; fixture‑based tests for plan parsing and policy.

---

## 13) Checklists

### PR Author

- [ ] Break work into small, independently reviewable PRs.
- [ ] Declare dependencies explicitly in PR descriptions and/or `plan.json` pre‑cursor metadata.
- [ ] Ensure required gates are defined and runnable.

### Agent (Runner/Gate)

- [ ] Validate `plan.json` against Schema v1.
- [ ] Compute topo order; verify DAG (no cycles).
- [ ] Execute gates uniformly; collect artifacts.
- [ ] Replay the candidate onto the exact current base before review.
- [ ] Obtain an independent `PASS` review for the exact candidate head, or record an explicit
      authorized `review_bypassed` receipt.
- [ ] If review returns `BLOCK`, fix the finding and repeat replay, gates, and review.
- [ ] Respect policy; merge only when eligible.
- [ ] Emit artifacts/logs outside source; post results back to PR.

### Release

- [ ] Tag runner version & schema version.
- [ ] Changelog: note contract changes explicitly.
- [ ] Verify CI template and local flows match.

---

## 14) FAQ

**Q: Why doesn’t the runner read Issues directly?**
A: To keep integration **deterministic and replayable**. Issues can change without a commit; `plan.json` freezes the intent for a run.

**Q: Can the plan generator ingest Issues?**
A: Yes. The generator (separate tool) may read Issues/PR metadata to **produce** `plan.json`. The runner still only consumes the plan.

**Q: Does this block exploratory or Copilot‑led development?**
A: No. Implementation agents use Issues/specs as usual. The constraint applies only at **integration time**.

---

**How do I declare PR dependencies?**
Use a `Depends-on: #<PR>` footer (or labels). The plan generator resolves these into
`items[].deps` references.

**What if my gates need secrets?**
Provide them via CI secrets/env; do not let secrets alter gate semantics. Prefer containerized gates.

**Can I use this with our existing CI?**
Yes. Keep your CI; point it at the runner CLI. The runner remains deterministic because it only consumes `plan.json`.

## 15) Invariants (Quick Reference)

- Runner reads **only `plan.json`** at integration time.
- Coordination state is explicit and stateful during implementation; it is never integration truth.
- `.smartergpt/` is never a runtime dependency.
- Local and CI gate semantics are identical.
- No hidden side‑effects; everything is declared.
- Same inputs → same outputs.
- Review is mandatory by default and binds to the exact candidate/base pair.
- Review bypass is explicit, warned, justified, and never reported as a pass.
- Terminal executions leave an inspectable durable delta; retries identify their changed premise.

#### CI-Bound Resources & Environments

Some gates need secrets (e.g., databases, SaaS tokens) or services unavailable locally.

- **Runtime selector (suggested):** `gate.runtime = "local" | "container" | "ci-service"`
- **Containerization (recommended for parity):** If `runtime = container`, include `image`, `entrypoint`, and `mounts` in the plan or policy.
- **Secrets & env:** Gate adapters may read env vars **only** to locate credentials; secrets must not change gate semantics.
- **Example gate spec (non-normative):**

```json
{
  "name": "e2e",
  "runtime": "container",
  "image": "ghcr.io/acme/e2e:1.4.2",
  "command": ["npm", "run", "e2e"],
  "artifacts": ["junit.xml", "screenshots/"]
}
```

---

## Appendix C — Plan Generator Reference (Non-Normative)

**Purpose:** Show how teams can go from Issues/PRs → `plan.json` without constraining the runner.

### Dependency Declaration (PR metadata)

- Footer syntax (suggested): `Depends-on: #123, #456`
- Label-based (alternative): `dep:123`, `dep:456`
- The generator resolves PR numbers → node IDs.

### Field Mapping (example)

| Source                     | Final Plan field              |
| -------------------------- | ----------------------------- |
| Selected PR or branch      | `items[].name`                |
| `Depends-on:` footer       | `items[].deps[]`              |
| Required checks            | `items[].gates[]`             |
| Target branch              | `target`                      |
| Frozen repository and SHAs | `gitInputs` (generated plans) |

### Minimal `plan.json` example

<!-- lexrunner-plan-example:agents-minimal -->

```json
{
  "schemaVersion": "1.0.0",
  "target": "main",
  "policy": {
    "requiredGates": ["lint", "type", "unit"],
    "maxWorkers": 2,
    "mergeRule": { "type": "strict-required" }
  },
  "items": [
    {
      "name": "feature/core-utils",
      "deps": [],
      "gates": [
        { "name": "lint", "run": "npm run lint" },
        { "name": "type", "run": "npm run typecheck" },
        { "name": "unit", "run": "npm test" }
      ]
    },
    {
      "name": "feature/a",
      "deps": ["feature/core-utils"],
      "gates": [
        { "name": "lint", "run": "npm run lint" },
        { "name": "type", "run": "npm run typecheck" },
        { "name": "unit", "run": "npm test" }
      ]
    }
  ]
}
```

---

## Appendix D — Quick Start (Happy Path)

1. **Open Issues** with crisp acceptance criteria.
2. **Implement** in **small PRs**; add `Depends-on:` footers if needed.
3. **Generate plan:** Run your plan generator to emit `plan.json`.
4. **Validate and order:** `lex-pr schema validate plan.json` then `lex-pr weave merge-order plan.json`.
5. **Dry run locally:** `lex-pr gate run plan.json --dry-run`.
6. **Run gates:** Same canonical CLI locally and in CI; confirm bounded results and artifact references.
7. **Review exact candidates:** Follow the
   [independent merge review gate](docs/review-gate.md); fix every blocking finding and re-review
   the replacement head.
8. **Merge pyramid:** `lex-pr weave apply --execute` only with explicit mutation authority and a
   `PASS` review receipt (or an explicit authorized `review_bypassed` receipt).
9. **Commit messages:** Imperative mood (e.g., “Add…”, “Fix…”).

## 16) Security Dependency Policy

**Always fix security vulnerabilities when a fix is available.**

This applies to all severity levels (critical, high, moderate, low). Rationale:

- **No severity is "safe to ignore."** Even low-severity issues can be chained or escalated.
- **Fixes are cheap.** If `npm audit fix` or equivalent resolves it, do it immediately.
- **Technical debt compounds.** Deferred security fixes become harder to untangle over time.

### Workflow

1. **Check for vulnerabilities:** `npm audit` (or equivalent for your package manager)
2. **If fix available:** Apply it (`npm audit fix`) and commit immediately
3. **If no fix available:** Document in a tracking issue with rationale for deferral
4. **Dependabot PRs:** Merge promptly when CI passes (or is pending, not failing)

### Policy Configuration (Non-Normative)

```yaml
security:
  # Block merges when ANY unfixed vulnerability has an available patch
  blockOnFixableVulnerability: true
  # Severity levels to track (all by default)
  trackSeverities: ["critical", "high", "moderate", "low"]
  # Auto-merge dependabot PRs when CI is green or pending
  autoMergeDependabot: true
```

---

## 17) Environment Stability (WSL2/CI)

- **Resource Limits:** Test runners (Vitest) must be configured with explicit concurrency limits (`maxWorkers: 1`) to prevent resource exhaustion in constrained environments like WSL2 or shared CI runners.
- **Crash Prevention:** Avoid unbounded recursion or excessive memory allocation in tests.
- **Process Isolation:** Ensure tests clean up temporary directories and processes.
- **Git Configuration:** Tests creating git repositories MUST explicitly disable GPG signing (`git config commit.gpgsign false`) to prevent interactive prompts that hang the test runner and crash the environment.
- **Git Tests:** Tests that perform git commits or require a git environment are EXCLUDED from the default `npm test` run. Run them explicitly with `npm run test:git`, including the existing isolated `git-backed-tests` CI job. Use disposable repositories, disabled GPG signing and bounded workers; never exercise these tests against a live working checkout. This matches the required Git-backed lifecycle/recovery lane in `.github/workflows/ci.yml`.
