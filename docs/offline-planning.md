# Offline dependency planning

`lexrunner plan levels` validates a hand-authored `plan.json` and prints the work
items that can proceed at each dependency level. Items may represent PRs, tickets
or tasks. Every dependency refers to another item's `name`; the command does not
interpret names as Git refs or contact a tracker.

Start with the [manual plan in the README](../README.md#planning-and-gates-only),
or have your own tracker exporter produce the same schema. `gitInputs` is optional.
The schema still defaults `target` to `main` for compatibility; a planning query
does not access that branch or require it to exist.

```bash
lexrunner plan levels --plan plan.json
lexrunner plan levels --plan plan.json --json
```

The command reads the supplied file and writes its result to stdout. It requires
Node.js 24+ and the installed package; it requires no Git executable, checkout,
profile, network connection or forge token. It does not create a profile, emit
Frames, run gate commands, change repository state or establish merge eligibility.
JSON output includes `contract`, `levels`, `totalItems` and `maxParallelism`.
Levels and item names within each level have deterministic ordering.

The same schema validation and `MergeOrderQueryService` used by
`lexrunner weave merge-order` enforce the dependency graph: duplicate names,
cycles and missing dependencies fail with a nonzero exit status. JSON mode
returns a structured diagnostic. `on_cycle` and `on_missing_dep` belong to the
separate weave-policy configuration; they are not fields in the frozen Plan
schema and do not override this query's fail-closed behavior. Queries are bounded
to 256 items, dependencies per item and gates per item, 512 UTF-8 bytes per item
name, and a 256 KiB result.

## Execute reviewed verification separately

Planning does not execute a task or verify its acceptance. An item's empty
`gates` list performs no verification. To run a command, add an explicit command
gate such as `{ "name": "verify", "run": "node --version" }`, review it and
the intended candidate repository, then invoke the existing gate runner:

```bash
lexrunner gate run --plan plan.json --repo-root . --artifact-dir artifacts/planning-trial --json
```

Gate execution is a separate operation: it runs declared code and writes logs,
receipts and an evidence manifest. Use an existing local Git candidate repository
for the runner's repository routing; this is a different prerequisite from the
offline levels query. Review gate commands, working directories, environment and
artifact paths before execution. A manual plan without frozen `gitInputs` does
not provide immutable candidate binding, and a gate result alone does not grant
merge authority. See [the quickstart](../MERGE_WEAVE_QUICKSTART.md) for the
execution, independent review and merge boundaries.

`plan.json` can therefore serve as an interchange format without adding a tracker
provider: another tool produces named work, dependencies and reviewed gates, then
consumes LexRunner's ordering result or gate evidence. Tracker synchronization,
task execution and merge authorization remain explicit, separate operations.
