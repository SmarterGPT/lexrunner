# Windows coordinator selection publication model

This is a source-only, **non-authorizing** transaction exercise for the first
`windows-coordinator-active-selection/2` publication. It writes no registry,
service, installer, root, or user state. Its injected `SyntheticSelectionStore`
is deliberately registry-shaped so interruption ordering can be tested. All
results, including `simulated_published`, carry `authorizesLaunch: false`.
No production resolver, Attempt, CLI, or MCP code imports this model.

The model accepts a canonical revision-1 selection, matching v2 graph bytes
and a `qualified` catalog claim, and requires an empty initial catalog,
`HighWaterRevision = 0`, and no `ActiveSelection`. These supplied values are
**comparison data, not authentication or host qualification**. It writes and
flushes the catalog first, then advances and flushes the high-water revision,
then writes and flushes `ActiveSelection`. Each stage is read back. An
exception or mismatched readback is `uncertain`; the function does not retry.
The initial path refuses a durable partial state. A separate explicit
recovery simulation flushes even a matching catalog again before high-water,
since the observed catalog may be volatile after an interrupted first flush.
The model snapshots each candidate field once before validation and uses the
snapshot throughout the transaction. Recovery may finish the same candidate
after readback. A merely visible `ActiveSelection` is not assumed durable:
explicit recovery flushes it before reporting `already_published`. Recovery is not
an administrator credential or permission to activate a helper. A changed
generation, conflicting selection, malformed high-water value, extra catalog,
or stale revision is refused.

Run the isolated suite with:

```powershell
npx --no-install vitest run services/windows-coordinator-selection-provisioner/synthetic-publication.spec.ts
```

This model intentionally supports initial publication only. Upgrade,
revocation, rollback, retirement, and lease retention require separate
transactions. A future installed publisher must independently authenticate
the reviewed artifact and administrative operator, create protected registry
keys and owner/DACL at creation, keep ordinary clients and workers read-only,
verify SCM/image/loader/root host gates, persist both flushes on the actual
host, and test interrupted publication across process and machine restarts.
The current v2 MSI neither writes selection nor installs this model. This
fixture does not justify changing `helper_missing`.
