# Windows coordinator admission journal source

`SqliteWindowsCoordinatorAdmissionStore` owns the single reservation and
uncertainty transaction implementation. This directory keeps synthetic tests
and a thin compatibility wrapper; it no longer implements a second SQLite
transition. The store can append an `effect_unknown` intent before a future
effectful phase and read a verified historical intent for an exact Run, Attempt
and observed client SID. Every result has `authorizes_execution: false`.

The latch verifies the recorded admission, recomputed request binding, complete event chain, packet,
current enrollment, controller lease/fence/expiry, and supplied current
repository/root/volume and helper/Git selection digests. The final event and
current-row compare-and-set share one immediate SQLite transaction. A lost
reply after commit replays historical `effect_unknown`; a failed update rolls
back the event. Status returns `effect_unknown` for missing or peer-mismatched
records and throws on corruption so the service can fail closed. No public
endpoint consumes this store yet.

These checks do not establish that the caller supplied observations came from
held protected native scopes or that the database, WAL/SHM, parent directories,
Node/addon loader, or service identity is protected. The existing admission
record is literally `source_only_candidate`; it cannot authorize dispatch.
Before production effects, the service must independently check the exact
current Attempt, workspace lease, removal reservation and selected observation
with the controller fence, own the exclusion through executor quiescence, and
commit an intent before dispatch. The latch alone is never a dispatch grant.
Power-loss durability, restart reconciliation and installed cross-account
access remain host qualification gates.

The optional helper remains separate from npm. No service installation,
selection, Git operation or governed execution is performed by these tests.
