# Windows coordinator bundled admission source probe

This source-only probe is a possible v2 installed-profile Node entry. It is not
launched by the SCM service, native client, resolver, Attempt, CLI or MCP.
Running it never authorizes execution. The npm package does not include or
install the optional coordinator.

`buildWindowsCoordinatorAdmissionBundle()` bundles the admission store, Zod and
the JavaScript half of `better-sqlite3-multiple-ciphers` into one ESM file. The
builder rejects external imports other than Node builtins and replaces the
package's default `bindings` addon lookup with a throwing module. A fixed
`createRequire(import.meta.url)` bridge serves only Node builtin imports from
the bundled CommonJS wrapper; it throws on dynamic package/path lookups. A
separate exact-path `createRequire` loads the explicit `.node` addon. A missing
`nativeBinding` inside this bundle cannot silently search `node_modules` for
an addon.

The fixture entry accepts a caller-supplied canonical v2 generation graph and
manifest digest. It compares the graph's `admission-entry` member with its own
file and the `sqlite-addon` member with the exact generation-relative addon
path, size and SHA-256. It requires Node ABI 137 and loads that absolute addon
as an object through `createRequire`; the SQLite store passes the object to
`better-sqlite3` as `nativeBinding`. The upstream JavaScript runtime supports
the object branch, although its current type declaration only lists a string.
The probe opens and closes an in-memory admission store and emits a bounded
`authorizesLaunch: false` result. Wrong graph, entry or addon bytes fail without
a no-effect claim.

The isolated test runs the built ESM file under a temporary generation outside
the repository with poisoned `zod` and SQLite package paths. Its Node
environment is constructed for the probe. The test's other graph members are
synthetic fixtures; it does not validate an installable full graph. Exact
temporary-root and reparse checks precede recursive test cleanup.

This does not prove registry or manifest custody, atomic file-to-loader
identity, DLL loading, native addon ABI beyond this host, Node image binding,
protected SQLite state, cross-account access, service process ownership, or
safe restart/recovery. A production entry must obtain the graph expectation
from protected selection and retain the executable/addon identity through
launch and load; caller-supplied manifest bytes are comparison data only.
