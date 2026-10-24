# Configuration Management

Complete guide to lexrunner configuration layering, inspection, and precedence rules.

> **📖 See Also**:
>
> - [Profile Resolution](./profile-resolution.md) - Profile directory resolution and management
> - [CLI Reference](./cli.md) - Complete CLI command reference

## Overview

The lexrunner uses a layered configuration system that allows you to:

- Define configuration in multiple files with clear precedence rules
- Inspect merged configuration with provenance tracking
- Understand which file sets each configuration value

## Configuration Files

Configuration is loaded from the `.smartergpt/` directory in the following precedence order (highest to lowest):

1. **`stack.yml`** - Highest precedence, defines complete stack configuration
2. **`scope.yml`** - Fallback for discovery and target settings
3. **`deps.yml`** - Future support for dependency-only definitions

### File Precedence Rules

- If `stack.yml` exists, it takes precedence for all settings
- If `stack.yml` doesn't exist, the system falls back to `scope.yml` + `deps.yml`
- Missing files are tracked but don't cause errors

## Configuration Inspection

### `config:inspect` Command

Display the merged configuration with provenance map showing which file provides each value.

```bash
lex-pr config:inspect [options]

Options:
  --json     Output canonical JSON format (deterministic, sorted keys)
  -h, --help Display help for command
```

### Human-Readable Output

```bash
$ lex-pr config:inspect

📋 Configuration Inspection

Configuration:
  Version: 1
  Target: main
  Items: 3

Provenance Map:
  target: stack.yml
  version: stack.yml

Configuration Sources:
  ✓ stack.yml
  ✗ scope.yml
  ✗ deps.yml
```

### JSON Output

The `--json` flag outputs deterministic JSON with sorted keys:

```bash
$ lex-pr config:inspect --json
```

This is a configuration-inspection envelope, not a Plan input.

<!-- lexrunner-non-executable-plan:config-inspect-envelope -->

```json
{
  "config": {
    "items": [...],
    "target": "main",
    "version": 1
  },
  "provenance": {
    "target": "stack.yml",
    "version": "stack.yml"
  },
  "sources": [
    {
      "exists": true,
      "file": "stack.yml"
    }
  ]
}
```

## Layering Examples

### Example 1: Stack-Only Configuration

When only historical `stack.yml` exists. This is a legacy layered-configuration example, not a
current executable Plan:

<!-- lexrunner-non-executable-plan:legacy-stack-only-config -->

```yaml
# .smartergpt/stack.yml
version: 1
target: main
items:
  - id: 1
    branch: feature/auth
    deps: []
    strategy: merge-weave
```

**Provenance:**

- `version`: stack.yml
- `target`: stack.yml
- All item settings from stack.yml

### Example 2: Scope Fallback

When `stack.yml` doesn't exist but `scope.yml` does:

```yaml
# .smartergpt/scope.yml
version: 1
target: staging
sources:
  - query: "is:open label:stack:*"
```

**Provenance:**

- `version`: scope.yml
- `target`: scope.yml

### Example 3: Stack Overrides Scope

When both files exist, `stack.yml` takes precedence:

```yaml
# .smartergpt/scope.yml
version: 2
target: staging
```

The overriding `stack.yml` remains a legacy configuration fragment, not a current Plan:

<!-- lexrunner-non-executable-plan:legacy-stack-override-config -->

```yaml
# .smartergpt/stack.yml
version: 1
target: main
items: []
```

**Result:**

- `version`: 1 (from stack.yml)
- `target`: main (from stack.yml)
- Stack completely overrides scope settings

## Use Cases

### Debugging Configuration

Understand where each configuration value comes from:

```bash
lex-pr config:inspect
```

### CI/CD Validation

Verify configuration in automated pipelines with deterministic output:

```bash
lex-pr config:inspect --json | jq '.config.target'
# Output: "main"
```

### Configuration Auditing

Track which files are being used:

```bash
lex-pr config:inspect --json | jq '.sources'
```

## Deterministic Output

The `config:inspect --json` command ensures:

- **Stable key ordering** - All object keys are sorted alphabetically
- **Consistent formatting** - 2-space indentation, trailing newline
- **Byte-for-byte identical output** - Same input always produces identical output

This makes it ideal for:

- CI/CD pipelines that check configuration changes
- Git diffs that track configuration evolution
- Automated testing and validation

## Best Practices

1. **Use stack.yml for complete definitions** - When you have a fully-defined stack
2. **Use scope.yml for discovery** - When auto-discovering PRs from GitHub
3. **Inspect before executing** - Always verify merged configuration before running gates
4. **Track provenance in issues** - Include provenance output when reporting configuration bugs

## Troubleshooting

### "No configuration found"

All configuration files are missing. Solution:

```bash
# Create a minimal stack.yml
cat > .smartergpt/stack.yml << EOF
version: 1
target: main
items: []
EOF
```

### Unexpected configuration values

Use `config:inspect` to understand precedence:

```bash
lex-pr config:inspect --json | jq '.provenance'
```

### Configuration not updating

Check which file has precedence:

```bash
lex-pr config:inspect
# Look for ✓ marks to see which files exist
```

---

**Next Steps:**

- Read [CLI Reference](./cli.md) for all command details
- See [Profile Resolution](./profile-resolution.md) for directory management
- Check [Troubleshooting](./troubleshooting.md) for common issues
