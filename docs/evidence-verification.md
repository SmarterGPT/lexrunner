# Evidence verification

## Compact JSON digest

The package root exports the existing compact JSON digest helper and an explicit
name for its representation:

```ts
import { COMPACT_JSON_HASH_PROFILE, computeCanonicalHash } from "@smartergpt/lexrunner";

const profile = COMPACT_JSON_HASH_PROFILE; // "lexrunner.compact-json.sha256.v1"
const digest = computeCanonicalHash({ b: 2, a: 1 });
// sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777
```

CommonJS consumers can obtain the same exports with
`require("@smartergpt/lexrunner")`. The result is lowercase hexadecimal SHA256
prefixed with `sha256:`. The profile names the existing bytes; it adds no domain
prefix and changes no existing schema hashes. Record the profile alongside a
digest when a new contract needs an explicit representation. Adding that label
inside an existing hashed object would change its digest.

The preimage is the UTF-8 encoding of the existing `JSON.stringify` call with its
recursive object-key sorter. It has no indentation or trailing newline. Arrays
retain their order. JavaScript's JSON number formatting and property enumeration
still apply: numeric index keys enumerate numerically, `-0` becomes `0`, and
exponents retain JSON's native spelling. Strings receive JSON escaping without
Unicode normalization, so composed and decomposed Unicode can hash differently.
This profile is not RFC 8785 JSON Canonicalization Scheme (JCS).

Use this export to reproduce known existing contract hashes. Validate values
against the owning schema and use that contract's field selection and exclusions;
hashing an entire wrapper is not necessarily the contract's digest. The helper
accepts `unknown` for compatibility, but it is not a validator, a general-purpose
JSON hash tool or a safe serializer for arbitrary JavaScript objects.

Supported public caller input is normal JSON under a known contract: finite
numbers, dense arrays and plain data objects, without accessors, custom `toJSON`
methods or an own `__proto__` key. Schema validation alone does not establish that
boundary. Existing record schemas, including `Gate.input`, can admit a
`__proto__` key in parsed JSON. Public callers must separately refuse that input
rather than use this digest to authenticate it. No existing schema or hashing
behavior is changed by this export.

Existing JavaScript behavior remains observable outside that supported input.
Undefined object properties are omitted, sparse array holes and nonfinite numbers
become `null`, and `toJSON`, getters or proxies can execute during serialization.
BigInt and cycles can throw. The existing sorter uses ordinary objects: an own
`__proto__` property can disappear from the preimage. Such inputs must be refused
by the caller's input policy even if a schema accepts them. This export does not
silently repair those quirks or recalculate historical hashes. The pretty JSON
helper also has different behavior
for an own `constructor` field, so it cannot substitute for the compact helper.

## Select the owning byte representation

Several existing digests use SHA256 but bind different preimages:

| Representation                                | Bytes that are hashed                                                                         | Existing use                                                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `lexrunner.compact-json.sha256.v1`            | Compact sorted JSON in UTF-8, without a newline or domain prefix                              | Snapshot and receipt contracts using `computeCanonicalHash`                        |
| Pretty JSON                                   | `canonicalJSONStringify`: two-space indentation and a final LF                                | Descriptor request bindings and other contracts that explicitly use this helper    |
| Raw artifact bytes                            | The exact file or byte sequence, without JSON parsing or normalization                        | Descriptor, manifest, execution receipt and retained artifact byte references      |
| `lexrunner.execution-plan-artifact.sha256.v1` | `lexrunner:execution-plan-artifact:v1\0` followed by the existing pretty canonical plan bytes | Execution-plan artifacts, paired with `lexrunner.execution-plan.canonical-json.v1` |

The `\0` in the plan domain denotes one NUL byte. These representations are not
interchangeable. For example, the compact JSON bytes `{"a":1,"b":2}` have the
digest shown above; their pretty JSON representation has digest
`sha256:080d51f49b27c73d17f51f3b808515a425d16218aa40021eed2ca1d204e59224`.
A file containing another key order has its own raw-byte digest even if parsing
and compact hashing would produce the same object digest. Do not parse and
reserialize a retained file when checking a raw artifact reference.

The lower-level compact-byte helper remains internal to the supported package
surface. Execution-plan artifact validation also checks the plan schema, declared
profiles, byte length and canonical representation; a matching hash alone does
not create a valid plan artifact.

A digest binds content under its owning contract. It does not establish an
execution, trusted producer, stable input closure, native-host qualification or
merge/release authority. Preserve those claims and their independent evidence
when verifying a receipt.

## Retained gate artifact read-back

Use the existing read-only status surfaces with the optional `verifyArtifacts`
boolean. CLI calls use `--verify-artifacts`:

```text
lexrunner weave status --repo-root <repo> --plan <plan> --evidence <manifest> --evidence-sha256 sha256:<digest> --verify-artifacts --json
lexrunner gate status --repo-root <repo> --operation <descriptor> --operation-sha256 sha256:<digest> --verify-artifacts --json
```

Published MCP `status` accepts the explicit manifest/hash pair and
`verifyArtifacts: true`; `gates.status` accepts the explicit operation handle/hash
and that boolean. The SDK uses the same `IntegrationStatusQueryService.run`
and `GateOperationService.status` services. Omitted or false leaves existing
behavior unchanged and emits no read-back report. Start and cancel do not accept
this read-only setting. True without an explicit manifest/hash is invalid for
integration status; the service does not search for recent receipts.

The optional `artifactVerification` report is nested in integration
`evidence`, and at the top level of a durable operation observation. Its version
is `lexrunner-retained-gate-evidence/v1`, its authority is `unverified`, and its
scope is `referenced-evidence-closure`. It lists checked owner-relative paths,
raw SHA256 digests, byte counts and precise outcomes. Unsafe references omit
paths. Report diagnostics do not include command/output content or historical
absolute source, executable or artifact paths. Existing explicit operation
handles and manifest references retain their existing path contract.

The shared evidence loader verifies the manifest and selected execution receipts.
The opt-in reader additionally compares the receipt's declared command, cwd,
runtime, ordered artifact declarations and shell argv with the plan/executor
shape. It compares retained identity bytes/hash with their collection source
metadata, then opens and hashes only the referenced retained copies. Operation
status includes its known descriptor and terminal references in the same closure.
Historical collection source and shell executable identities are metadata; their
current bytes are never opened by this reader. Source/latest outputs are not a
fallback for missing retained copies.

Acquisition uses held descriptors, bounded streaming reads, observed pathname
ancestry and file identity checks, and a final rehash/recheck before closing.
Candidate drift, missing/changed files, mismatched bytes, partial collection,
unsupported references, budget exhaustion and cleanup uncertainty prevent a
complete read-back. These checks provide portable byte-consistency observations.
They are not native handle custody, writer exclusion, an authenticated producer,
a stable lease or protection against every transient concurrent namespace change.
Node does not expose every Windows reparse tag; symlink/junction/escape checks
must not be represented as refusal of all possible reparse drivers or tags.

The published fixed budget covers 256 references, 4 MiB per metadata file,
32 MiB per artifact, 128 MiB of actual reads including the final rehash, and a
256 KiB report. Limits include manifest, receipt and optional operation metadata,
not just retained artifacts. A budget failure is explicit and never a successful
skip. Retained v2 absolute paths must resolve directly within the owning receipt
directory; they are not automatically relocated. Relative references are confined
to the owning evidence directory. Observed symlinks, junctions, hardlink aliases,
namespace escapes and invalid path forms are refused.

`complete` means the explicitly referenced closure was consistent during this
bounded observation. It does not mean omitted gates ran, every required gate
passed, a product package was accepted, or its host/runtime/release was qualified.
The caller retains those policies. A consistent failed gate can have complete
byte read-back while its recorded gate outcome remains failed.

Integration status keeps caller-supplied observations non-authorizing and merge
eligibility unchanged. For a terminal durable operation, an incomplete requested
read-back returns `state: unknown`, `lastReportedState: completed` and
`GATE_OPERATION_ARTIFACTS_INCOMPLETE`, with the original `recordedOutcome` and the
bounded diagnostic report when the original outcome projection is valid. If that
projection cannot be established, the report remains available without a recorded
outcome. It does not report completed/pass for that request.
The read-only observation neither edits the persisted terminal result nor reruns
commands. Existing outer schema/hash/binding errors keep their existing error
behavior. Native qualification, trusted eligibility, execution permission and
release authority require their separate owning evidence and protocols.
