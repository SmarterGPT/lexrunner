# Terminal worker event capture

The owned Codex connection now queues `turn/completed` notifications for its own
thread and single observed turn after a dispatch attempt. The owned turn is bound
by dispatch acknowledgement, start notification or an early terminal event;
conflicting turn IDs/statuses terminate the connection without enqueuing the
conflicting report. Repeated consistent terminal reports remain bounded queue
entries. Only terminal `completed`, `failed` and
`interrupted` statuses are accepted. This is a minimal event projection checked
against locally generated Codex 0.145.0 schemas, not verification of the full turn
body or the provider's conclusions.

Installed Codex 0.145.0 also emits a top-level `emittedAtMs` value on native
notifications. Terminal and final-message projections accept this optional
nonnegative safe integer explicitly and retain it in the original frame bytes.
Other unknown top-level fields remain rejected. This provider timing value does
not replace the host's `observedAt` or establish freshness, identity or permission.

The queue retains each original valid UTF-8 JSON frame, excluding its newline
delimiter. Invalid UTF-8 fails instead of replacing bytes. EOF finalizes the decoder
and reports incomplete UTF-8 or an unterminated frame, preserving earlier queued
events. Child close performs the same check if stdout EOF was not observed.
A connection UUID and
sequence give each captured event a stable observation ID for persistence retries;
neither is an authenticated identity. Capture time is the host's observation time.
The snapshot exposes counts and byte totals, never the notification body.

`persistNextTurnCapture` accepts an explicit existing dispatch binding and a trusted
host-selected evidence store. The host remains responsible for selecting that
binding and controlling store access. The store checks session, claim, request hash
and worker identity. Capture can persist after child exit or lease expiry. It does
not send another turn, change the live dispatch acknowledgment, or verify completion.
Only one persistence operation runs at a time. Queue removal follows a successful
store response; rejection or an exception leaves the event available. A retry after
a lost response returns the original immutable observation and artifact.

The memory and SQLite observation adapters retain the raw frame and derive its
SHA-256 evidence digest, terminal status, turn ID and fixed summary. SQLite migration
19 adds an artifact table referencing the observation. Artifact and observation
writes share the existing `BEGIN IMMEDIATE` transaction: an artifact write failure
rolls back the new observation. Memory publishes both synchronously. Artifact
retrieval checks the retained bytes against the observation digest. This detects
inconsistency, not malicious coordinated edits to the database; it is not an
independent trust root or an authenticated provider signature.

Limits are explicit: 1 MiB per frame, 128 queued events or 2 MiB of queued raw
frames, and 8 MiB of retained raw frames per dispatch session. Journal entry limits
still apply. These budgets exclude database overhead and existing unrestricted
canonical identity domains. Queue overflow terminates the connection and preserves
earlier queued events; the overflowing event and later output are not captured.
Storage capacity rejection retains the event in the queue. Neither failure permits
claiming complete evidence. Queue contents are volatile until persisted; parent
process loss can lose them. Child exit alone does not flush the queue automatically.

Terminal notification bodies can contain sensitive task output. They remain in the
explicitly selected local store and are not printed or published by this API.
Operators must apply appropriate access and retention policy. Command output,
streaming item deltas, referenced files and separate artifacts are not captured;
the retained notification is only one bounded evidence artifact.

Tests cover late notification before dispatch acknowledgment, interrupted delivery,
lost persistence responses, conflicting reports, byte/count limits, exact-byte
retention, invalid UTF-8, transaction rollback, and read-only reopen/hash checking.
The native idle probe still submits no turn. Live terminal-event conformance,
complete task receipts, conflict reconciliation and native workspace qualification
remain outstanding. No public command, default store, release or runtime upgrade.
