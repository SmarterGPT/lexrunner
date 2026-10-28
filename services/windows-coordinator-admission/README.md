# Windows coordinator admission: source-only uncertainty transaction

This directory exercises one missing transition in the existing admission
fixture: atomically changing a recorded no-effect candidate to an
effect_unknown intent before a future effectful phase. It is not a service
entrypoint, protected store or execution grant. The only exported function
takes a caller-supplied SQLite connection and clock, returns
authorizes_execution=false, and has no Git, helper, worker or broker call.
No CLI/MCP or installed host imports it.

## Exact gap at this source slice

- The #1077 native/Node private bridge is a console probe. Its expected SID,
  image hashes, fixture path and SQLite path are supplied to the probe. The
  native code observes the pipe client's token, but the fixture does not
  authenticate enrollment or an installed service.
- The existing SQLite admission store atomically records a
  source_only_candidate and no_effect intent. Test code inserts enrollment
  rows directly. There is no protected administration path, protected database
  root or migration of user-writable Run/Attempt state.
- The prior store can replay a synthetically inserted effect_unknown event
  but cannot create that transition. This slice tests a monotonic transaction:
  verify the candidate, packet, current enrollment and controller fence;
  append revision 1 and replace the current intent in one immediate
  transaction. A failed current-row update rolls back the event. A lost reply
  after commit replays effect_unknown, including after policy revocation or
  lease expiry. Missing or corrupt history throws and yields no public
  no_effect claim.

## Unqualified host gates

1. Select and review a protected provisioning path for the enrolled SID,
   repository/roots, operation ceiling, selection and revisions; install a
   service-owned root/DB with independently verified ancestry, ACL and loader
   custody. Existing user-writable records cannot be relabeled as protected.
2. Connect a persistent SCM service and authenticated local endpoint to a
   token-derived peer SID. The console probe's argv SID, path and image pins
   are fixture input, not authority.
3. Derive current repository/allocation identity from held service-side
   handles. Qualify the protected stage, Git image/environment/config for
   every verb, helper selection, process ownership, worktree handoff and
   recovery under the dedicated nonadmin identity.
4. Bind the protected transaction to the real Run/Attempt/packet/workspace
   store and applied worker/gate authority. Review the effect state machine and
   read-only status parity before exposing any production constructor or
   effectful adapter.

Until those gates pass, production continues to report the unavailable
Windows native boundary. The optional helper is installed separately from npm
only after approval of an exact artifact; this slice does not install or select
anything.

## Evidence (2026-10-28)

All commands ran in D:\dev\lexrunner, with no real Attempt effects:

| Command                                                                                                                                                                                                                                                                                                                | Exit | Bounded result         | Wall time |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---: | ---------------------- | --------: |
| npx --no-install vitest run services/windows-coordinator-admission/synthetic-uncertainty-journal.spec.ts                                                                                                                                                                                                               |    0 | 1 file, 3 tests passed |    2.47 s |
| npx --no-install tsc --ignoreConfig --noEmit --target ES2020 --module NodeNext --moduleResolution NodeNext --strict --esModuleInterop --skipLibCheck --types node services/windows-coordinator-admission/synthetic-uncertainty-journal.ts services/windows-coordinator-admission/synthetic-uncertainty-journal.spec.ts |    0 | No diagnostics         |    2.96 s |

SHA-256 source hashes at this evidence point (not an authenticated bootstrap
root or a claim about installed bytes):

| Source                                                                       | SHA-256                                                          |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| src/windows-coordinator/admission-contract.ts                                | 6060b36c16a28d51e1a0e5158d773b744a5616a77a4c8fca99f35f5a7882acfb |
| src/windows-coordinator/sqlite-admission-store.ts                            | 457f268662a466cf4bbcf169a25bed3082764ea08813b19aa55e0aeabf6163d3 |
| src/windows-coordinator/private-admission-bridge.ts                          | 55e3362e46856f382f4386a1e4eb18b47ac2fdb7f009a67387516cf58f1eba8a |
| services/windows-coordinator-host/Program.cs                                 | d8d57c3361cfb48517b73fd94eac42e33747861709fe557d7b3cf2965fb03b06 |
| services/windows-coordinator-host/node/private-admission-worker.ts           | 2f6fb6331836e4d265585657aa2b4b33c5c324171dc59cf97da04a0739fa13f5 |
| services/windows-coordinator-admission/synthetic-uncertainty-journal.ts      | af0ed95cfc82d6b4fb2b0a5f45e0f51dd2fc71bcc049168732b7eaac0f34279b |
| services/windows-coordinator-admission/synthetic-uncertainty-journal.spec.ts | db8bc13a011b4300b92b92a57e79f0b1881bbb539a34c8108aeaf945f5ce6f61 |
