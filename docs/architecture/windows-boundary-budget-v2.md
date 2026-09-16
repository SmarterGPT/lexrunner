# Windows boundary protocol v2 session budgets

Protocol `2.0.0` replaces the development v1 limits with an explicit fixed profile:

| Bound                                             | v1         | v2          |
| ------------------------------------------------- | ---------- | ----------- |
| Session requests, including acquisitions/releases | 15         | 128         |
| Incoming reply frames, including hello            | 16         | 129         |
| Owned command timeout ceiling                     | 22 seconds | 30 seconds  |
| Reply budget ceiling, including cleanup reserve   | 30 seconds | 38 seconds  |
| Explicit work window ceiling                      | 30 seconds | 300 seconds |

The native command limit remains 30 seconds. The owner now admits that full command
budget plus the existing eight-second reply reserve. Default work timeout remains
five seconds: callers must request a workload-appropriate window explicitly. Grace,
per-frame byte/output bounds, cleanup timeouts, replay rejection and one outstanding
request remain unchanged. Total accepted stream bytes grow with the bounded frame
count; native replay sets and held scopes remain bounded by the request ceiling.

These are limits, not a promise that every broker lifecycle fits. Admission must still
reserve releases for all held directories, and commands must fit the remaining original
work deadline. Root planning uses the same TypeScript request ceiling; native enforcement
is independently tested at 128 accepted requests and rejection of request 129. Callers
must not split custody, reset deadlines or truncate command requests to hide exhaustion.

Both launch arguments and every protocol message require version 2.0.0. Version 1
helpers/messages are explicitly incompatible; there is no fallback or opportunistic
upgrade. The workspace receipt schema stays at 1.0.0. An older helper's valid signature
or prior qualification does not establish compatibility with this owner.

The local NativeAOT build and native tests are development evidence. A new signed
artifact and signature/launch qualification are required before production use. The
resolver remains unavailable. Short commands supplied with 30-second budgets test
admission; they do not establish five-minute workload reliability or durable recovery.
