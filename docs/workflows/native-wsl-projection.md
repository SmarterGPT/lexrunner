# Native Windows to WSL Attempt projection

Use this workflow only when the Windows-to-WSL route is explicitly authorized and its
prerequisites are configured. `broker_required` alone does not authorize WSL installation,
projection or host switching. Native Windows Attempt execution remains unavailable until
its production boundary is qualified; the [external-worker workflow](external-workers.md)
preserves planning and verification without changing hosts. The projection is a disposable,
identity-anchored transport for one exact committed base. It is not another user-maintained
checkout and it never copies source worktree dirt.

The source checkout may remain active while the Attempt runs. Its later HEAD or dirty state does
not replace the `base_sha` captured in the projection request.

## Surfaces and authority

The CLI and MCP adapters call the same lifecycle handlers:

| Operation          | CLI                             | MCP tool                                   | Authority |
| ------------------ | ------------------------------- | ------------------------------------------ | --------- |
| Prepare or reuse   | `attempt projection prepare`    | `prepare_native_wsl_projection`            | Mutation  |
| Read status        | `attempt projection status`     | `get_native_wsl_projection_status`         | Read-only |
| Inspect quarantine | `attempt projection quarantine` | `inspect_native_wsl_projection_quarantine` | Read-only |
| Clean up           | `attempt projection cleanup`    | `cleanup_native_wsl_projection`            | Mutation  |

Every CLI operation requires `--input <file|-> --json`. Prepare and cleanup inputs require
`"mutation": {"authorized": true}`. The MCP server also requires its mutation gate to be enabled
for those two tools. Status and quarantine inspection never create projection, SQLite, lock, or
control state and do not require mutation authority.

## 1. Bind one exact source commit

Record the full commit object ID that the Attempt must consume. Do not use a branch name or assume
that the current source HEAD will remain stable.

Create the canonical projection request through
`createNativeWslProjectionRequest(...)`. A representative request body is:

```json
{
  "schema_version": "1.0.0",
  "request_id": "stfc-wl-006",
  "repository": {
    "id": "stfc-mod",
    "expected_remote_hash": "sha256:<canonical-remote-hash>"
  },
  "source": {
    "windows_runtime": "windows-git",
    "windows_repository_path": "D:\\dev\\stfc-mod",
    "wsl_distribution": "Ubuntu",
    "wsl_git_runtime": "wsl-ubuntu-git",
    "wsl_repository_path": "/mnt/d/dev/stfc-mod",
    "head_policy": "observe",
    "dirty_policy": "committed_base_only"
  },
  "native": {
    "host_id": "wsl-ubuntu-host",
    "git_runtime": "wsl-ubuntu-git",
    "projection_root": "/home/operator/.local/share/lexrunner/projections",
    "worktree_root": "/home/operator/.local/share/lexrunner/worktrees"
  },
  "base_sha": "<full-40-or-64-character-commit-id>",
  "request_digest": "sha256:<canonical-request-digest>"
}
```

The factory computes `request_digest`; callers should not construct or rehash it by hand. The
mapped source and both native roots must be disjoint. The native roots must be on a filesystem
that supports LexRunner's Linux directory-identity boundary.

`head_policy: "observe"` records source movement without replacing the requested base.
`dirty_policy: "committed_base_only"` records source dirt but publishes only the requested commit.
Use stricter policies when source movement or dirt should reject preparation.

## 2. Inspect, then prepare

Status input is read-only:

```json
{ "request": { "...": "canonical projection request" } }
```

```sh
lex-pr attempt projection status --input projection-status.json --json
```

An absent result returns `state: "absent"` and `nextActions: ["prepare_projection"]`. Prepare
requires explicit mutation authority:

```json
{
  "request": { "...": "canonical projection request" },
  "mutation": {
    "authorized": true,
    "reason": "Provision exact base for one fenced Attempt"
  }
}
```

```sh
lex-pr attempt projection prepare --input projection-prepare.json --json
```

Success is `outcome: "prepared"` or `"reused"` with `state: "ready"`. Persist the returned
`selectionDigest` in the Attempt prepare input as:

```json
{
  "envelope": {
    "projection": {
      "selectionDigest": "sha256:<engine-authored-selection-digest>"
    }
  }
}
```

Set the Attempt runtime repository and worktree roots to the native projection allocation named
by the returned `projectionId`. `attempt prepare` resolves the selection from the
identity-anchored native Git directory and emits one machine-verifiable execution path mapping.
It rechecks repository, base, host, runtime, native roots, worktree identity, manifest, receipt,
and fresh source observation. A caller-supplied manifest or matching hash cannot substitute for
that engine-owned selection.

The public lifecycle responses intentionally omit source and native paths. They expose stable
digests, bounded command evidence, counts, reason codes, and next actions. The immutable Attempt
envelope is the durable machine-verifiable path mapping.

## 3. Run the normal fenced Attempt lifecycle

After projected `attempt prepare`, continue through the normal public surfaces:

1. attach the worker to the exact envelope;
2. heartbeat and end the worker session;
3. submit its receipt;
4. run independent engine verification;
5. apply acceptance; and
6. fan in only the persisted terminal Attempt, receipt, and verification evidence.

Every authority-bearing boundary consumes and revalidates the persisted canonical path mapping.
Source HEAD movement or new source dirt during this sequence cannot change the packet's committed
base.

## 4. Inspect and recover

Use status first, then quarantine inspection when directed:

```sh
lex-pr attempt projection quarantine --input projection-status.json --json
```

| State or outcome               | Meaning                                          | Next action                                                    |
| ------------------------------ | ------------------------------------------------ | -------------------------------------------------------------- |
| `absent`                       | No matching projection exists                    | Prepare it                                                     |
| `preparing`                    | Matching owned staging is present                | Retry status or prepare                                        |
| `ready`                        | Current engine selection verifies                | Prepare the Attempt                                            |
| `ready_unselected`             | Material exists without current launch authority | Prepare again to publish fresh selection                       |
| `stale`, `invalid`             | State cannot authorize launch                    | Inspect quarantine, then explicitly clean up and prepare again |
| `conflicting`                  | Ownership or identity is ambiguous               | Stop and correct the request or host state                     |
| cleanup `refused`              | Active projected worktrees still exist           | End/release/remove them, then retry cleanup                    |
| cleanup `quarantined`/`failed` | Removal lacked a complete identity-safe result   | Inspect bounded quarantine evidence and retry or escalate      |

Quarantine output contains only bounded entry digests and counts. It cannot be used to select or
launch a projection.

## 5. Tear down in ownership order

End the worker, preserve required receipts and verification evidence, release/remove the Attempt
worktree, and only then clean up the projection:

```json
{
  "request": { "...": "canonical projection request" },
  "mutation": {
    "authorized": true,
    "reason": "Attempt evidence is durable and projected worktrees are removed"
  },
  "includeQuarantine": true
}
```

```sh
lex-pr attempt projection cleanup --input projection-cleanup.json --json
```

Cleanup is idempotent: a replay after successful removal returns `outcome: "absent"` and
`reasonCode: "projection_absent"`. It refuses active worktrees and never follows caller-selected
paths. A failed partial removal remains visible and recoverable on retry.

## Dogfood proof

The hermetic end-to-end test declares `D:\dev\stfc-mod` as the Windows view, models the mapped
source in a temporary Linux fixture, advances and dirties that source after selecting the base,
then proves:

- the projected repository and immutable packet remain at the original commit;
- the envelope carries the declared Windows view, observed WSL view, and three native
  directory-identity roots;
- a worker can attach, produce a receipt, pass independent verification, and reach accepted
  fan-in-ready evidence; and
- cleanup refuses while that Attempt worktree remains active.

See `tests/runs/agent-work-attempt-receipt-adapters.spec.ts`.
