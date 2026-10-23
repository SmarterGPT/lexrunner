# Contributing to lexrunner

Thanks for your interest in contributing! This project builds a deterministic CLI that fans out work across many PRs, computes a merge pyramid, runs gates uniformly, and merges cleanly.

This guide keeps contributions small, deterministic, and easy to review.

## Quick start

- Node.js: 24.x (see `.nvmrc` and `package.json` engines)
- npm: 11.16.0 (see `package.json` packageManager)

Setup:

- `npx --yes npm@11.16.0 ci`
- `npx --yes npm@11.16.0 run build`
- `npx --yes npm@11.16.0 test`

The checked-in `allowScripts` policy permits the locked native SQLite and esbuild installers and
denies Lex's informational postinstall. A dependency update that changes an approved installer
version must be reviewed explicitly; `npm approve-scripts --allow-scripts-pending` should report no
unreviewed scripts after a clean install.

Useful scripts:

- Dev CLI (ts): `npm run cli -- <command>`
- Build artifacts: `npm run build`
- Types: `npm run typecheck`
- Tests: `npm test`

## Project layout

- `src/**`: TypeScript source for the Runner CLI and MCP adapter
- `docs/**`: Documentation
- `.smartergpt/**`: Portable example workspace profile (not read at runtime)
- `tests/**`: Vitest unit/integration tests

Two-track separation (firm): The core runner never stores user/work artifacts. Portable example profiles live under `.smartergpt/**` only.

## Commit style

Use imperative, descriptive commit messages. Optional prefixes:

- `runner:` core CLI changes under `src/**`
- `mcp:` adapter changes
- `schema:` schema updates and regeneration
- `tests:` test-only changes
- `docs:` documentation
- `ci:` CI/workflow changes
- `workspace:` portable profile assets under `.smartergpt/**`

Examples:

- `runner: Add retry/backoff to gate executor`
- `docs: Document plan schema validation CLI`

## ⚠️ Formatting Drift Prevention

**Common issue:** VS Code auto-formats files on save, creating unstaged changes that get added in a separate commit after push.

**Pre-commit hook** warns you if formatting changes exist but aren't staged:

```
⚠️  WARNING: Unstaged formatting changes detected
...
Options:
  1. Stage these changes:    git add <files>
  2. Discard them:           git checkout -- <files>
  3. Continue anyway:        git commit --no-verify
```

**To avoid this:**

- Either include formatting in your commit, or
- Run `git checkout -- <files>` to discard them before committing

This keeps your commits clean and prevents "formatting commit" noise in history.

## PR guidelines

Keep PRs small and focused. One PR = one chat/task. Include a "How to verify" section with exact commands and expected outcomes.

Acceptance checklist per PR:

- [ ] Clear scope and acceptance criteria
- [ ] Deterministic outputs (stable order, sorted keys)
- [ ] Scripts/types/tests green (`build`, `typecheck`, `test`)
- [ ] Docs updated (README/docs) when public behavior changes

## Running the CLI locally

Examples:

- `npm run cli -- plan --from-github --json` → prints plan JSON to stdout
- `npm run cli -- execute plan.json --json` → runs gates with policy
- `npm run cli -- report ./gate-results --out md` → aggregates gate results

See `docs/cli.md` for the full command reference.

## Tests

- Run all tests: `npm test`
- Run a specific file: `npm test -- tests/<file>.spec.ts`

Native Windows CI validates clean installation, dependency policy, lint, build, and focused
cross-platform regressions. It does not claim full runtime parity. The shared native Windows/Linux
workspace-boundary conformance lane will replace that limitation as part of the native-host runtime
program; platform skips are not an accepted substitute.

If adding public behavior or fixing a bug, prefer tests first (happy path + 1-2 edge cases). Ensure outputs are deterministic.

### Slow CLI Tests

Some CLI tests are excluded from the default `npm test` run because they involve long-running operations (e.g., sleep commands, extensive git operations). These tests run on a scheduled CI workflow instead.

**To run slow CLI tests locally:**

```bash
LEX_ENABLE_SLOW_CLI_TESTS=true npm run test:cli:slow
```

**Test categorization:**

| Category            | Command                 | CI Lane          |
| ------------------- | ----------------------- | ---------------- |
| Default tests       | `npm test`              | Every PR, fast   |
| Slow CLI tests      | `npm run test:cli:slow` | Scheduled/manual |
| Git-dependent tests | `npm run test:git`      | Manual           |

**Adding new slow tests:**

1. Add the test file to `vitest.slow-cli.config.ts` `include` array
2. Add exclusion to `vitest.config.ts` `exclude` array
3. Document why the test is slow in the test file

### Testing Planner Features

When working on diffgraph planner features (`src/planner/`), follow these guidelines:

**Test Coverage Requirements:**

- Dependency parser: Test all supported syntax variations
- File analysis: Test intersection detection, confidence scoring
- Dependency scoring: Test weight combinations, threshold filtering
- Validation: Test cycle detection, orphan warnings, invalid refs

**E2E Test Fixtures:**
Located in `tests/fixtures/` - use realistic PR structures:

- Simple stacks (linear dependencies)
- Diamond patterns (fan-out/fan-in)
- Complex graphs (10+ PRs with mixed dependencies)
- Edge cases (cycles, orphans, self-dependencies)

**Example test structure:**

```typescript
import { parsePRDescription } from "../src/planner/dependencyParser.js";

describe("Dependency Parser", () => {
  it("should parse single dependency", () => {
    const result = parsePRDescription(101, "Depends-on: #100");
    expect(result.dependencies).toEqual(["#100"]);
  });

  it("should parse multiple dependencies", () => {
    const result = parsePRDescription(101, "Depends-on: #100, #102");
    expect(result.dependencies).toEqual(["#100", "#102"]);
  });

  // Test determinism
  it("should produce stable sorted output", () => {
    const result1 = parsePRDescription(101, "Depends-on: #103, #100, #102");
    const result2 = parsePRDescription(101, "Depends-on: #102, #103, #100");
    expect(result1.dependencies).toEqual(result2.dependencies);
  });
});
```

**Run planner-specific tests:**

```bash
# All planner tests
npm test -- tests/batch-planner.spec.ts

# Dependency parser tests
npm test -- tests/dependencyParser.spec.ts

# File analysis tests
npm test -- tests/fileAnalysis.spec.ts
```

**Documentation Tests:**
Ensure examples in documentation work:

```bash
# Test examples from tutorials
cd docs/tutorials/diffgraph-planner/
# Run commands from 01-simple-stack.md, etc.
```

See [Diffgraph Planner Guide](./docs/diffgraph-planner.md) for feature documentation.

## Code style & types

- TypeScript-first; strict types preferred
- Keep modules small and pure where possible; isolate side-effects
- Use Zod for schemas and validation in `src/schema.ts`

### CLI Development Conventions

When adding or modifying CLI commands, follow these critical patterns:

- **Exit handling**: Use `throwExit()` or throw `CLIExitSignal` - never call `process.exit()` directly
- **JSON purity**: Keep stdout clean - all diagnostics to stderr, use `canonicalJSONStringify()` for JSON output
- **Stream configuration**: Use Commander's `configureOutput()` to separate data from diagnostics
- **Exit codes**: 0 = success, 1 = system error, 2 = user/validation error

See [CLI Conventions](./docs/cli.md#cli-conventions) for detailed patterns and examples.

## Adding New Commands

The lexrunner CLI uses a **modular command architecture** where each command lives in its own module. This makes the codebase maintainable and testable.

### Quick Start

1. **Create command module** in `src/commands/myCommand.ts`
2. **Export registration function**: `registerMyCommandCommand(program: Command)`
3. **Register in `src/cli.ts`**: Add import and call registration function
4. **Add tests** in `tests/commands/myCommand.spec.ts`
5. **Update documentation** in `docs/cli.md`

### Command Module Pattern

```typescript
// src/commands/myCommand.ts
import { Command } from "commander";
import { writeJsonOutput } from "../cli/output.js";
import { throwExit } from "../cli/exitHandler.js";

export function registerMyCommandCommand(program: Command): void {
  program
    .command("my-command")
    .description("Brief description")
    .argument("<arg>", "Argument description")
    .option("--json", "Output as JSON")
    .action(async (arg, options) => {
      try {
        const result = await executeMyCommand(arg, options);

        if (options.json) {
          writeJsonOutput(result);
        } else {
          console.log(formatOutput(result));
        }
      } catch (error) {
        throwExit(error, 1);
      }
    });
}

// Pure, testable business logic
async function executeMyCommand(arg: string, options: any) {
  // Implementation here
  return { success: true };
}

function formatOutput(result: any): string {
  return `✅ ${result.success ? "Success" : "Failed"}`;
}
```

### Best Practices

✅ **DO:**

- Separate business logic from CLI handling (pure functions)
- Support both `--json` and human-readable output
- Use `throwExit()` for error handling
- Write unit tests for business logic
- Add JSDoc comments to exported functions
- Keep commands focused and single-purpose

❌ **DON'T:**

- Mix business logic into `.action()` handlers
- Call `process.exit()` directly
- Output to stdout when `--json` is used (except JSON itself)
- Create commands with implicit dependencies

### Examples

- **Simple command**: `src/commands/completion.ts` (~50 lines)
- **Medium command**: `src/commands/discover.ts` (~150 lines)
- **Complex command**: `src/commands/execute.ts` (~300+ lines)

### Full Guide

For comprehensive documentation including:

- Command templates
- Testing patterns
- Common utilities
- Documentation requirements
- Complete checklist

See **[Command Creation Guide](./docs/command-creation-guide.md)**

## Opening an issue

Use the issue templates (Bug report / Feature request). Include acceptance criteria and reproduce steps. Link related docs/PRs.

## Security

Never commit secrets. See `docs/SECURITY_IMPLEMENTATION.md`. Use the `lex-pr security` subcommands for scanning and validation.

## Release determinism

After `npm run build && npm run format`, the tree should be clean (`git diff --exit-code`). If generation changes are intentional, include them in the PR.

## Releasing

LexRunner uses its own signed-tag/OIDC release path. See
[Release and public npm publishing](docs/release-process.md) for the normative process.

### Version Alignment Check

Before releasing, verify package.json and Git tags are aligned:

```bash
npm run check:release-drift
```

### Quick Release Checklist

1. Create a release branch from fresh `main` and run
   `corepack npm@11.16.0 run release:prepare`.
2. Curate `CHANGELOG.md` and the versioned release notes, then run the complete release gates.
3. Create one signed release commit, open a PR, and require independent exact-head review and green CI.
4. After merge, verify that exact reviewed commit is contained in `origin/main`.
5. Create and verify `vX.Y.Z` as a signed tag pointing to that reviewed commit, then push only the tag.
6. Let the stable-tag workflow publish through npm OIDC and create the GitHub release.
7. Verify the public npm record and a clean native Windows consumer. Do not publish or create the
   release manually from a local shell.

---

Thank you for helping improve lexrunner! 💙

## Contribution rights and provenance

Submit only material you created or have the right to contribute. Preserve author
and third-party notices, identify reused material and its license, and keep
credentials, private company code and confidential or regulated data out of commits,
issues, pull requests and build artifacts.

Certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/)
with a Signed-off-by trailer on contributions (for example, git commit -s). This is
a provenance and right-to-submit certification, not copyright assignment. Do not
sign for another contributor.

Intentionally submitted contributions follow the project's Apache-2.0 license and
section 5 unless explicitly stated otherwise or covered by a separate agreement.
DCO certification does not supply broader relicensing rights. A separately justified
CLA or assignment must be agreed explicitly; none is implied here. AI-assisted
changes retain these same duties and normal review and verification requirements.

See [GOVERNANCE.md](GOVERNANCE.md) and [BRAND.md](BRAND.md).
