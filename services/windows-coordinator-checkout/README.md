# Windows coordinator checkout source fixture

This directory is a disposable, inactive qualification fixture for populating a
Windows Git worktree from an exact pinned commit. It links the reviewed Git bundle,
bounded-child, worktree-stage, and graph-selection sources. It has no service
route, installed selection, worker access grant, or Attempt authority. The
default image exposes only `no_production_checkout_entrypoint`. Building with
`CheckoutFixture=true` enables the `--fixture-populate` and `--fixture-observe`
test routes.

## Fixed operation

`--fixture-populate` validates a caller-supplied slot and synthetic graph, imports
the digest-pinned bundle into a fresh bare mirror, and preflights the exact commit
tree. The small tree profile accepts only nonempty regular `100644` blobs with
conservative ASCII path names, at most 32 files, 8 KiB per file, 64 KiB total,
and eight path components. It refuses symlinks, gitlinks/submodules, attributes,
and ambiguous Windows names before creating a stage.

The fixture then creates a detached `--no-checkout` worktree, verifies its `.git`
pointer and mirror registration, and invokes fixed `read-tree --reset` and
`checkout-index --all --force` commands through the graph-selected Git child.
Each Git child must be assigned to a Job before resume and drain the terminal
Job and bounded output. The fixture holds native handles to the root, mirror,
stage and `.git` pointer across the checkout. It compares ReFS file IDs, final
paths, attributes, owner and DACL before and after the commands. It then reads
each tracked file through a held handle and compares bytes to its Git blob ID,
rejecting missing, extra, redirected, or changed content. Unexpected empty
directories are also rejected.

The Git child gets a constrained environment, empty hooks/template directories,
disabled system and global Git config/attributes, and fixed configuration for
hooks, fsmonitor, filters through the tree restriction, line endings, protocols,
and symlinks. Source repository config and hooks do not cross the bundle. The
graph profile holds and checks the selected Git image and DLLs, but the supplied
graph and installed loader closure have no independent protected root here.

`--fixture-observe` performs read-only reconciliation of the stage, mirror,
registration, and tree after a lost reply. It reports exact observation or
`preserve_unknown_effects`; it never replays, removes, promotes, or authorizes
the stage. Every post-entry report conservatively sets `UnknownEffects=true`.
The verifier alone removes its marked disposable roots after checking path,
marker, reparse, and workspace containment.

## Local qualification

Run from the LexRunner root on native Windows PowerShell 7:

```powershell
pwsh -NoLogo -NoProfile -File services/windows-coordinator-checkout/verify.ps1
```

The bounded verifier authors a synthetic graph and source bundle, publishes a
NativeAOT image, reads back the fixture drive with a bounded `Get-Volume` child
and requires `FileSystem=ReFS`, populates one tracked file, observes
it exactly, and refuses a tampered file. It also refuses filter attributes,
symlinks, gitlinks, and an occupied hooks directory before stage/import effects
as applicable. Each command records executable, cwd, argv, start, duration,
exit, bounded stdout/stderr and direct-child drain. The receipt under ignored
`artifacts/windows-coordinator-checkout/` records the Git command summaries,
source pin, graph digest, ReFS volume readback, 18 source hashes (including the
graph author's first-party inputs), bounded repository HEAD readbacks, and
checked cleanup. The receipt explicitly states
`authorizesExecution=false` and `installedServiceQualified=false`.

## Remaining boundary

This is development evidence only. The checkout is not under an installed
coordinator identity or protected ancestry. The graph selection is supplied
by the caller; service installation, authenticated selection, loader custody,
worker ACLs, intentional worker-edit mediation, crash journal, and protected
Git promotion are still required. An exact observation does not prove
uninterrupted custody or grant retry authority. It must not clear production
`helper_missing`.
