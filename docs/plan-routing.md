# Repository-bound plan creation

Plan synthesis is a development-time operation, but its repository and filesystem scope must be
explicit before it can safely produce the frozen integration input. `lexrunner plan`,
`lexrunner weave plan`, source MCP `plan_create`, and packaged MCP `plan.create` therefore share
`PlanCreationOperationService`.

## Routing order

The service copies and strictly validates caller input, then:

1. resolves `repoRoot` against the adapter's captured startup directory and finds its physical
   root;
2. reads the local `origin` remote without credentials or network access and requires it to
   identify the actual `github.com` host;
3. rejects a supplied `owner`/`repo` pair that does not match that remote;
4. resolves an explicit profile, otherwise a repository-local profile for explicit routing;
5. applies explicit query, label, target and output arguments ahead of profile defaults;
6. rejects colliding plan/snapshot/receipt output paths;
7. performs single-repository GitHub discovery, verifies that the synthesized frozen plan still
   matches the local worktree, and only then permits the adapter to write;
8. writes `plan.json`, `snapshot.md`, and `routing-receipt.json` together.

For a cross-repository call, provide all three binding fields:

```powershell
lexrunner weave plan --from-github `
  --repo-root D:\dev\lex `
  --owner SmarterGPT `
  --repo lex `
  --query "is:pr is:open head:codex/release" `
  --output artifacts\release-plan.json
```

An explicit query is converted to a repository-bound PR search. LexRunner adds the selected
`repo:`, `is:pr`, state and target branch qualifiers when absent. Caller-supplied `repo:`, `org:`,
`user:`, `type:`, unquoted `OR`, issue selection, or conflicting state/base qualifiers are
rejected before search, including qualifiers with quoted values. Labels remain an additional
intersection filter. Both MCP plan-creation adapters require `githubToken`, `GITHUB_TOKEN`, or
`GH_TOKEN` for GitHub mode; the CLI may use GitHub's unauthenticated public API.

The MCP `repos` array retains the existing multi-repository synthesis surface. Each explicit query
is bounded to its declared repository before client construction. Its receipt identifies the
physical output host, lists the requested repositories, and records `gate.executable: false` with
no repository cwd. The snapshot omits a single-worktree lockfile hash because no one worktree owns
that synthesis.

## Receipt and execution boundary

The routing receipt exposes requested and observed repository identity, physical root, normalized
remote, profile root and precedence, resolved target, output root, and generated gate cwd. When an
explicit or profile query selects GitHub search, it also records the exact repository-bound query.
When discovery uses the repository-scoped pull-request listing endpoint, no search query is claimed.
It always declares:

```json
{
  "authority": "unverified",
  "authorizesExecution": false,
  "authorizesMerge": false
}
```

Generated standard gates use `cwd: "."`, interpreted relative to the selected physical repository
root. The snapshot lockfile fingerprint is read from that same selected worktree, while the footer
reports the bundled LexRunner version rather than a caller repository's package version. Before
creating artifacts or starting commands, both `GateExecutionService` and the raw
`executeGatesWithPolicy` compatibility path compare a frozen plan's repository with the selected
worktree remote and confine local gate cwd to that worktree. CLI and MCP gate adapters resolve a
relative plan and artifact directory from explicit `repoRoot`, not the server startup repository.
An explicit MCP `repoRoot` also disables the ambient profile-plan fallback: callers must provide a
plan reference or place `plan.json` in that repository. CLI dry-run, cache maintenance, audit setup,
checkpoint creation and resume all perform the same binding checks before emitting results or
creating mutable evidence.
Legacy plans without `gitInputs` remain compatible with existing single-worktree execution.
Multi-repository plans remain synthesis artifacts only; new apply, checkpoint creation and persisted
resume all fail closed rather than guessing per-item repositories.
