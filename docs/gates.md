# Gates

Gates are quality checks that must pass before code can be merged. This document describes gate execution, validation, and best practices.

## Overview

## Long-running operations and reconnects

Use CLI `gate start` or MCP `gates.start` for local command gates that may outlive an
MCP caller timeout. The existing `gate run` / `gates.run` interfaces remain synchronous.

```powershell
lexrunner gate start --repo-root D:/dev/project --plan plan.json --out artifacts/gates --idempotency-key qualification-1 --json
lexrunner gate status --repo-root D:/dev/project --operation <operationFile> --operation-sha256 sha256:<digest> --json
lexrunner gate cancel --repo-root D:/dev/project --operation <operationFile> --operation-sha256 sha256:<digest> --json
```

Start returns an immutable descriptor path and SHA-256. Retain both. The worker
owns the frozen plan snapshot and bound repository candidate; it continues when
the observer disconnects or the MCP server exits. No coordination database is used.
Use an ignored artifact directory or one outside the checkout so unrelated artifact
writes do not change the candidate being tested.

The idempotency key is scoped to the physical output directory. Repeating the same
key, directory and exact inputs returns the original operation without spawning
commands again. A changed candidate, plan, selection, timeout or worker binding
conflicts. An interrupted admission or stale heartbeat is unknown; it never
authorizes automatic relaunch. Status validates terminal execution receipts and
candidate identity rather than treating a saved success field as proof.

Cancellation uses `after-active-gates`: the request stops new items, commands and
retries, while active commands finish under their declared timeouts. The request
response reports `cancelRequested`; only the worker reports terminal `cancelled`
after admitted commands settle. Completed publication can win a race with an
unobserved cancellation request. This mode has no prompt-termination or additional
descendant-cleanup guarantee.
Worker loss without a terminal artifact remains unknown, including after cancellation.

On Windows, a status reader can briefly prevent heartbeat-file replacement. The
worker retains the previous complete snapshot and retries on its next heartbeat;
the collision does not cancel active work. Terminal diagnostics record deferred
heartbeat publications. A stale snapshot still reports unknown worker freshness.

Durable operations support local command gates with execution receipts. Container,
CI-service, the special `vuln` gate and pre-execution `input` validators are refused
before launch. The artifact filesystem must support atomic rename and hard links
for complete, exclusive record publication. An incomplete admission is retained
for inspection and never automatically relaunched. The ordinary
portable execution contract does not establish protected native custody or merge
authority. All operation observations retain `authority: "unverified"`.

To read an existing synchronous gate manifest from a shared startup folder, pass
`--repo-root` to `weave status`, or `repoRoot` to MCP `status`, together with its
explicit evidence path and `sha256:` digest.

## Command gates

Gates in lexrunner execute commands to verify code quality, run tests, perform security scans, and more. Each gate can have:

- A command to execute (`run`)
- Environment variables (`env`)
- Input validation schema (`input`)
- Runtime configuration (local, container, or CI service)
- Artifact collection paths

## Gate Input Validation

Starting in v0.1.0, gates support runtime input validation using JSON schemas. This ensures that gate inputs are validated before execution, providing fast feedback when inputs are malformed.

### How It Works

When a gate has an `input` field, it will be validated against a schema in `schemas/gates/{gate-name}.schema.json` before execution:

```json
{
  "name": "lint",
  "run": "npm run lint",
  "input": {
    "files": ["src/**/*.ts"],
    "linter": "eslint",
    "fix": true
  }
}
```

If validation fails, the gate immediately returns a failure status with a clear error message, avoiding wasted execution time.

### Built-in Gate Schemas

The following gates have predefined input schemas:

#### Lint Gate (`lint.schema.json`)

Validates linting operations:

```json
{
  "files": ["src/**/*.ts"], // Required: array of file paths or patterns (min 1 item)
  "linter": "eslint", // Required: eslint, tslint, pylint, or ruff
  "fix": true, // Optional: auto-fix violations
  "config": ".eslintrc.json" // Optional: path to config file
}
```

#### Test Gate (`test.schema.json`)

Validates test execution:

```json
{
  "framework": "vitest", // Required: vitest, jest, mocha, pytest, or junit
  "files": ["tests/**/*.spec.ts"], // Required: array of test file patterns (min 1 item)
  "coverage": true, // Optional: enable coverage collection
  "timeout": 30000 // Optional: test timeout in ms
}
```

#### Build Gate (`build.schema.json`)

Validates build operations:

```json
{
  "command": "npm run build", // Required: build command
  "outputDir": "dist", // Optional: output directory
  "clean": true, // Optional: clean before build
  "targets": ["main", "worker"] // Optional: build targets
}
```

#### Security Scan Gate (`security-scan.schema.json`)

Validates security scanning:

```json
{
  "scanner": "npm-audit", // Required: npm-audit, snyk, trivy, or codeql
  "severity": "high", // Optional: critical, high, medium, or low
  "failOn": "critical", // Optional: severity to fail on (default: high)
  "outputFormat": "sarif" // Optional: sarif, json, or text (default: sarif)
}
```

#### Coverage Gate (`coverage.schema.json`)

Validates coverage collection:

```json
{
  "tool": "vitest", // Required: istanbul, nyc, jest, vitest, or pytest-cov
  "threshold": 80, // Required: coverage percentage (0-100)
  "files": ["src/**/*.ts"], // Optional: files to include
  "exclude": ["**/*.test.ts"], // Optional: files to exclude
  "reportFormat": "lcov" // Optional: lcov, html, text, or cobertura (default: lcov)
}
```

### Backward Compatibility

Gates without the `input` field work exactly as before - no validation is performed. This ensures backward compatibility with existing plans.

### Skipping Validation

In rare cases where you need to bypass validation (e.g., testing edge cases), use the `--skip-input-validation` flag:

```bash
lex-pr execute plan.json --skip-input-validation
```

⚠️ **Warning**: Skipping validation can lead to cryptic failures during gate execution. Use only when absolutely necessary.

## Error Messages

When validation fails, you'll see clear, actionable error messages:

```
❌ Gate execution failed

Invalid input for gate "lint":
  - input/files must NOT have fewer than 1 items
  - input/linter must be equal to one of the allowed values

Suggestion: Check the gate input schema documentation for the correct format
```

## Creating Custom Gate Schemas

To add validation for custom gates:

1. Create a schema file: `schemas/gates/{gate-name}.schema.json`
2. Define the input structure using JSON Schema draft-07
3. Add the `input` field to your gate configuration

Example custom gate schema:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://github.com/Guffawaffle/LexRunner/schemas/gates/custom-check.schema.json",
  "title": "Custom Check Gate Input Schema",
  "description": "Input contract for custom check gate",
  "type": "object",
  "required": ["target"],
  "properties": {
    "target": {
      "type": "string",
      "minLength": 1,
      "description": "Target to check"
    },
    "strict": {
      "type": "boolean",
      "default": false,
      "description": "Enable strict mode"
    }
  },
  "additionalProperties": false
}
```

## Best Practices

1. **Always validate inputs**: Use the `input` field with schemas for complex gates
2. **Fail fast**: Validation happens before execution, saving time on invalid inputs
3. **Clear error messages**: Schema validation provides specific error details
4. **Test your schemas**: Write tests to verify your gate schemas work correctly
5. **Document your schemas**: Add descriptions to all schema properties

## CLI Reference

### Execute with Validation

```bash
# Execute with validation (default)
lex-pr execute plan.json

# Skip validation (not recommended)
lex-pr execute plan.json --skip-input-validation
```

### Import Gate Results from GitHub Checks

Starting in v0.6.0, you can automatically import gate results from GitHub check runs, reducing manual work when gates are already running in CI.

#### Quick Start

```bash
# Import checks for a PR
lex-pr gate import-checks --ref 123

# Import checks for a specific commit
lex-pr gate import-checks --ref abc123def

# Create default gate mapping configuration
lex-pr gate import-checks --create-mapping
```

#### Gate Mapping Configuration

Create a `.lexrunner/gate-mapping.yaml` file to map CI check names to gate names:

```yaml
version: "1.0.0"
mappings:
  - pattern: "CI / build"
    gate: build
  - pattern: "CI / test"
    gate: test
  - pattern: "lint"
    gate: lint
  - pattern: "typecheck"
    gate: typecheck
  - pattern: "security-scan"
    gate: vuln
```

Patterns support wildcards:

```yaml
mappings:
  - pattern: "test*"
    gate: test
  - pattern: "*lint*"
    gate: lint
```

#### Command Options

```bash
lex-pr gate import-checks --ref <ref> [options]

Options:
  --ref <ref>           Git reference (commit SHA, branch, or PR number) [required]
  --item <name>         Item name (defaults to ref value)
  --out-dir <dir>       Output directory for gate results (default: .smartergpt/gate-results)
  --mapping <file>      Path to gate mapping config (default: .lexrunner/gate-mapping.yaml)
  --owner <owner>       GitHub repository owner (auto-detected if not provided)
  --repo <repo>         GitHub repository name (auto-detected if not provided)
  --token <token>       GitHub token (uses GITHUB_TOKEN env var if not provided)
  --create-mapping      Create default gate mapping configuration file and exit
```

#### How It Works

1. Fetches check runs from GitHub for the specified commit/PR
2. Filters to completed checks only
3. Maps check names to gate names using the mapping configuration
4. Converts check results to gate results format
5. Saves gate results to the output directory

#### Status Mapping

GitHub check conclusions are mapped to gate statuses:

| GitHub Conclusion | Gate Status |
| ----------------- | ----------- |
| `success`         | `pass`      |
| `failure`         | `fail`      |
| `skipped`         | `skipped`   |
| `neutral`         | `skipped`   |
| `timed_out`       | `fail`      |
| `cancelled`       | `fail`      |
| `action_required` | `fail`      |

#### Example Workflow

```bash
# 1. Create gate mapping configuration
lex-pr gate import-checks --create-mapping

# 2. Edit .lexrunner/gate-mapping.yaml to match your CI check names

# 3. Import checks for a PR
lex-pr gate import-checks --ref 123

# 4. Verify imported gate results
ls .smartergpt/gate-results/
# Output:
# 123-build.json
# 123-test.json
# 123-lint.json
```

#### Integration with Merge Eligibility

Imported gate results are automatically used in merge eligibility evaluation:

```bash
# After importing checks
lex-pr weave status

# Output will include imported gate results:
# ✅ build: pass (imported from GitHub)
# ❌ test: fail (imported from GitHub)
# ✅ lint: pass (imported from GitHub)
```

### Help

```bash
lex-pr execute --help
lex-pr gate import-checks --help
```

## Related Documentation

- [Gate Report Examples](./gate-report-examples.md) - Output formats and examples
- [Schema Documentation](./schemas.md) - Overall schema architecture
- [CLI Reference](./cli.md) - Complete CLI documentation
- [Error Handling](./errors.md) - Error taxonomy and recovery
- [CI/CD Integration](./ci-cd-integration.md) - Integrating with GitHub Actions and other CI systems
