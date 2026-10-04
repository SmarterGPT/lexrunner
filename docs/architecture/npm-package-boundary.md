# npm package boundary

Status: **Normative for LexRunner 1.2**

The published npm package contains executable runtime material, not a copy of
the development repository. `package.json#files` is the source boundary and
`scripts/validate-package-boundary.ts` enforces the resulting tarball.

## Allowed surface

- `dist/`: compiled ESM, CommonJS, and declarations;
- `schemas/`: runtime JSON schemas used by gate and integration validation;
- `mcp-server.mjs`: the published MCP stdio launcher;
- `package.json`, primary README/MCP README, changelog, notice, and license.

Tests, source, workflows, research deliverables, local databases, examples,
development scripts, and portable workspace contents are not package runtime
and must not enter the tarball.

## Two-track schema decision

The canonical portable definitions under `.smartergpt/schemas` remain workspace
material. Five public Zod schemas use small package build entries under
`src/package-schemas`; the build compiles their runtime JS and declarations into
`dist/package-schemas`. Package exports point only at those `dist/` artifacts.
No `.smartergpt` path is a published runtime dependency or tarball exception.

Top-level `schemas/` is different: it is an explicitly package-owned collection
of runtime JSON validation assets and is therefore allowed as a whole. Adding a
new top-level package directory requires updating both the `files` allowlist and
the boundary validator.

The package root also exposes the native-WSL projection Zod contracts,
canonical constructors, inventory schema, and pure planner. These APIs compile
into the existing `dist/cli` root entry and do not add a source-tree or
filesystem runtime dependency to the tarball.

## Enforced release checks

The packaging job:

1. builds every declared artifact;
2. checks every `bin`, `types`, and `exports` target against the dry-run tarball;
3. rejects npm-normalized metadata drift, including removable `bin` paths and non-canonical
   repository URLs;
4. rejects paths outside the allowlist, more than 120 files, or more than 7 MB
   unpacked;
5. installs the real tarball into a clean consumer with its own explicit strict
   script policy and refreshed registry metadata; and
6. smokes ESM imports and CommonJS require (including the projection contract
   and planner), the CLI bin, a bounded read-only Attempt status, and MCP
   `tools/list`, including all published Attempt lifecycle tools.

The check qualifies the actual pinned npm runtime and proves native SQLite
usability and refusal of an unreviewed script package that claims an approved
native package name/version. The inspected immutable Runner tarball receives
an exact owned loopback URL approval; Lex's scripts remain denied. The loopback
transport avoids npm 11.16.0's Windows `file:` policy mismatch, and preserves the
real installed executable shims that npm otherwise suppresses for a denied package.
See [local adoption and installation boundaries](../local-dogfood-install.md).

The separate `release:publish:check` gate runs npm's own publication dry-run and fails on metadata
normalization warnings. For a clean signed tag it prints the final command but never publishes;
the authenticated human release owner retains that authority.

The audited baseline before this boundary was 1,340 files, 3,243,620 bytes
packed, and 13,837,669 bytes unpacked. The initial bounded artifact is 90 files,
878,637 bytes packed, and 4,309,476 bytes unpacked. Content hashes and exact
compressed size may change as compiled code changes; the count and unpacked
budget remain enforced.
