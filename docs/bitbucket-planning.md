# Bitbucket Cloud discovery and planning

LexRunner can read Bitbucket Cloud pull requests and freeze a Schema v1 plan.
This path does not check out code, run gates, trigger pipelines, write to Bitbucket,
or apply merges. Bitbucket `weave apply --execute` refuses before runtime effects;
read-only dependency previews remain available. Bitbucket Data Center is unsupported.

Supply the workspace and repository slug explicitly. No Git checkout, GitHub token,
or LexRunner profile is needed for this path:

```sh
lexrunner weave discover --provider bitbucket --owner my-workspace --repo my-repo --json
lexrunner weave discover --provider bitbucket --owner my-workspace --repo my-repo --query 'title~"feature"' --target main --json
lexrunner weave plan --from-bitbucket --owner my-workspace --repo my-repo --output plan.json
lexrunner plan levels --plan plan.json --json
lexrunner weave apply --plan plan.json --dry-run --json
```

`discover` and `plan --from-bitbucket` are compatibility entry points for the same
Bitbucket implementations. Discovery prints JSON, including provider and explicit
non-authorizing scope; `--output` is available on `weave discover`. Plans print JSON
when no output file is supplied. `weave plan` defaults its output to `plan.json`;
top-level `plan` accepts `--output` and `--dry-run` (validate without writing).

Anonymous requests work for public repositories where Bitbucket allows them. For
private repositories, set `BITBUCKET_TOKEN` in the process environment using your
credential tooling. This must be a Bitbucket Cloud bearer access token, such as a
repository access token with read repository and pull-request scopes. Atlassian API
tokens that require email/basic authentication are not accepted by this bearer-only
adapter. Do not pass a token in a command argument, repository URL, plan or issue.
The adapter sends it only to the fixed `https://api.bitbucket.org` origin.

Discovery supports `--state open|closed|all`, `--query` using Bitbucket's `q` syntax,
and `--target`. The mandatory state predicate is included inside `q` even when a
caller filter is present: a separate `state=OPEN` was observed to be ignored with
`q`. The returned state, target and repository are checked independently. The
provider uses bounded GET requests, rejects redirects, and refuses pagination
outside the exact collection/filter. It returns at most 256 records across eight
pages; an over-limit or uncertain response fails instead of returning a partial plan.

Planning uses the current target branch's full commit ID and each selected source
commit. It refuses a changed target observation, fork source repositories, missing
dependency PRs, cycles and unsafe schema inputs. Dependency declarations use a
`Depends-on: #123, #456` line, optionally with same-repository `workspace/repo#123`
references. Select the required PR set together; dependencies outside that set are
not silently discarded. Drafts are excluded by default by top-level `plan`; the
existing `weave plan` default includes drafts and `--include-drafts` retains that
compatibility behavior. Exclusions and target selection are supported on both.
Top-level `plan` also accepts `--required-gates` and `--max-workers`.

Standard gates resolve to actual command definitions (lint, typecheck, test, unit,
build and format). They are declarations, not evidence that any command ran.
GitHub-specific labels, suggestions, profile and repository-root routing options
are rejected on the Bitbucket path rather than silently ignored.

`init` environment detection recognizes root `bitbucket-pipelines.yml`; its gate
mapping suggests step names for review. It does not read pipeline results or verify
those mappings. The provider's bounded commit-status reader observes statuses only.
A PR pipeline has an explicit `destination_commit` in its target: a successful old
pipeline or a rerun is not proof against a newer target commit. Refreshing a PR
pipeline for a new target requires a separately authorized new pipeline run with
that target; this adapter never triggers one or promotes statuses into gate evidence.

The implementation is qualified with synthetic API responses and CLI tests. A live
authenticated Bitbucket run has not been performed; credentials, rate limits and
repository-specific API behavior remain live qualification requirements.

Official references: [pull requests](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/),
[filtering and pagination](https://developer.atlassian.com/cloud/bitbucket/rest/intro/),
[authentication](https://developer.atlassian.com/cloud/bitbucket/rest/intro/#authentication),
[commit statuses](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-commit-statuses/),
and [pipeline targets](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pipelines/).
