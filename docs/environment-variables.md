# Environment Variables & CI Safety

**Status:** Stable (v0.1.0)
**Last Updated:** 2025-11-13

## Overview

lexrunner supports environment variables for configuration and includes special safety mechanisms for CI/CD environments. This document covers:

- Environment variable reference
- Environment variable aliasing (backward compatibility)
- CI role safety defaults
- Migration guide

## Environment Variables Reference

### Profile Configuration

#### `LEX_PR_PROFILE_DIR`

Specifies the profile directory to use for execution.

- **Type:** String (path)
- **Default:** Uses precedence chain (`.smartergpt.local/` → `.smartergpt/`)
- **Precedence:** Second (after `--profile-dir` flag)
- **Aliases:** `LEXRUNNER_PROFILE_DIR` (deprecated, will be removed in v3.0.0)

**Example:**

```bash
export LEX_PR_PROFILE_DIR=/workspace/.smartergpt.local
lex-pr plan --from-github
```

**CI Usage:**

```yaml
# GitHub Actions
env:
  LEX_PR_PROFILE_DIR: /tmp/ci-profile
```

### Mutation Control

#### `ALLOW_MUTATIONS`

Controls protected mutation operations that explicitly consult this gate, such as a non-dry-run
MCP merge. It does not make the MCP server read-only: plan creation can write artifacts, local
initialization can create a profile overlay, and gate execution can run Plan commands.

- **Type:** Boolean (`true` or `false`)
- **Default:** `false`
- **CI Role Behavior:** Force `false` by default (see CI Safety section)
- **MCP Server:** Required for merge operations via MCP

**Example:**

```bash
# Enable protected mutations for local development
export ALLOW_MUTATIONS=true
lexrunner weave apply --plan plan.json --execute

# Dry-run merge preview does not require protected mutation admission
lexrunner weave apply --plan plan.json --dry-run
```

**MCP Server:**

```bash
# MCP server respects ALLOW_MUTATIONS
export ALLOW_MUTATIONS=true
lexrunner-mcp
```

### Git Runtime Control

#### `LEX_GIT_MODE`

Controls whether git operations are enabled. Default is "off" for safe CI/ephemeral environment behavior.

- **Type:** String (`"off"` | `"live"`)
- **Default:** `"off"`
- **Case Sensitivity:** Case-insensitive

**Behavior:**

| Value           | Git Operations                        | Use Case                                   |
| --------------- | ------------------------------------- | ------------------------------------------ |
| `off` (default) | Disabled, returns safe fallbacks      | CI/CD, ephemeral environments, testing     |
| `live`          | Enabled, executes actual git commands | Local development, git-dependent workflows |

**Example:**

```bash
# Enable git operations for local development
export LEX_GIT_MODE=live
lex-pr plan

# CI/CD (default - git disabled)
# LEX_GIT_MODE not set → defaults to "off"
```

#### `LEX_DEFAULT_BRANCH`

Fallback branch name when git is disabled or unavailable.

- **Type:** String
- **Default:** `"main"`
- **Used When:** `LEX_GIT_MODE=off` or git commands fail

**Example:**

```bash
export LEX_GIT_MODE=off
export LEX_DEFAULT_BRANCH=develop
# Branch tokens will resolve to "develop"
```

#### `LEX_DEFAULT_COMMIT`

Fallback commit SHA when git is disabled or unavailable.

- **Type:** String (typically 40-character hex)
- **Default:** `"0000000000000000000000000000000000000000"` (40 zeros)
- **Used When:** `LEX_GIT_MODE=off` or git commands fail

**Example:**

```bash
export LEX_GIT_MODE=off
export LEX_DEFAULT_COMMIT=abc123def456789012345678901234567890abcd
# Commit tokens will resolve to the custom value
```

**See Also:** [Git Feature Flag Spec](specs/git-feature-flag-redesign.md)

### CI/CD Integration

#### `GITHUB_TOKEN` / `GH_TOKEN`

GitHub API authentication token. **Required for CI role profiles**.

- **Type:** String (GitHub token)
- **Default:** None
- **Aliases:** `GH_TOKEN` (alternative)
- **CI Role:** Required (validation enforced)

**Example:**

```bash
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
lex-pr plan --from-github "is:open label:ready"
```

**GitHub Actions:**

```yaml
env:
  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## Environment Variable Aliasing

For backward compatibility, lexrunner supports deprecated `LEXRUNNER_*` prefixes.

### Supported Aliases

| Primary Variable     | Deprecated Alias        | Status                        |
| -------------------- | ----------------------- | ----------------------------- |
| `LEX_PR_PROFILE_DIR` | `LEXRUNNER_PROFILE_DIR` | Deprecated, removed in v3.0.0 |

### Deprecation Behavior

When a deprecated alias is used:

1. **Precedence:** Primary variable takes precedence if both are set
2. **Warning:** One-time deprecation notice shown to stderr
3. **Functionality:** Full backward compatibility maintained
4. **Timeline:** Aliases will be removed in v3.0.0

**Example Warning:**

```
⚠️  Environment variable LEXRUNNER_PROFILE_DIR is deprecated.
Use LEX_PR_PROFILE_DIR instead. Support for LEXRUNNER_PROFILE_DIR will be removed in v3.0.0.
```

### Migration Guide

#### Step 1: Identify Usage

Search your codebase for deprecated variables:

```bash
# Find deprecated environment variable usage
grep -r "LEXRUNNER_" .github/ scripts/ docs/
```

#### Step 2: Update Configuration

Replace deprecated variables:

```diff
# Before (.github/workflows/merge-weave.yml)
env:
-  LEXRUNNER_PROFILE_DIR: /tmp/ci-profile
+  LEX_PR_PROFILE_DIR: /tmp/ci-profile
```

```diff
# Before (scripts/ci-setup.sh)
- export LEXRUNNER_PROFILE_DIR=/workspace/.smartergpt.local
+ export LEX_PR_PROFILE_DIR=/workspace/.smartergpt.local
```

#### Step 3: Verify Migration

Run with verbose logging to confirm:

```bash
# Should not show deprecation warnings
LEX_PR_PROFILE_DIR=/tmp/test lex-pr plan 2>&1 | grep -i deprecated
```

## CI Safety Defaults

### CI Role Overview

Profiles with `role: ci` in `profile.yml` have enhanced safety mechanisms to prevent accidental mutations in CI/CD environments.

**Profile Manifest Example:**

```yaml
# /tmp/ci-profile/profile.yml
role: ci
name: CI Pipeline Profile
version: 1.0.0
```

### Safety Mechanisms

#### 1. Mutation Policy

**Default Behavior:** `ALLOW_MUTATIONS` is forced to `false` for CI role profiles.

```typescript
// CI role: ALLOW_MUTATIONS defaults to false
profile.role === 'ci'
→ ALLOW_MUTATIONS = false (safe default)
```

**Explicit Override:**

```bash
# Requires explicit override with warning
export ALLOW_MUTATIONS=true

# Warning shown:
# ⚠️  CI role with ALLOW_MUTATIONS=true (explicit override)
```

**Invalid Values:**

```bash
export ALLOW_MUTATIONS=yes

# Warning shown:
# ⚠️  Invalid ALLOW_MUTATIONS value: "yes" (using false for CI)
```

#### 2. Required GitHub Token

CI role profiles **require** `GITHUB_TOKEN` or `GH_TOKEN` to be set.

**Validation Error:**

```bash
# Missing token in CI role
lex-pr plan --from-github

# Output:
# ❌ CI environment validation failed:
#   - Missing GITHUB_TOKEN (required for CI role)
# Error: CI environment validation failed
```

**Valid Configuration:**

```bash
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
lex-pr plan --from-github  # ✓ Succeeds
```

#### 3. Dangerous Configuration Warning

CI role profiles warn when `ALLOW_MUTATIONS=true` is set.

```bash
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
export ALLOW_MUTATIONS=true

lex-pr merge plan.json

# Warnings shown:
# ⚠️  CI role with ALLOW_MUTATIONS=true (explicit override)
# ❌ CI environment validation failed:
#   - ALLOW_MUTATIONS=true in CI role (dangerous)
```

**Note:** This is a **warning**, not an error. Mutations will proceed if token is present.

### CI Role Setup Examples

#### GitHub Actions - Safe Default

```yaml
name: Merge Weave (Safe)

on:
  workflow_dispatch:

jobs:
  merge-weave:
    runs-on: ubuntu-latest

    env:
      LEX_PR_PROFILE_DIR: /tmp/ci-profile
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      # ALLOW_MUTATIONS not set → defaults to false (safe)

    steps:
      - uses: actions/checkout@v7

      - name: Setup CI Profile
        run: |
          mkdir -p /tmp/ci-profile
          cp -r .smartergpt/* /tmp/ci-profile/
          cat > /tmp/ci-profile/profile.yml << EOF
          role: ci
          name: GitHub Actions CI
          version: 1.0.0
          EOF

      - name: Run Gates (Protected Merge Mutations Disabled)
        run: lex-pr gates run plan.json
```

**Result:** Protected mutations are blocked by default. Gate commands and their declared artifact
writes still execute; this is not a read-only sandbox.

#### GitHub Actions - Explicit Mutations

```yaml
name: Merge Weave (Mutations Enabled)

on:
  workflow_dispatch:

jobs:
  merge-weave:
    runs-on: ubuntu-latest

    env:
      LEX_PR_PROFILE_DIR: /tmp/ci-profile
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      ALLOW_MUTATIONS: true # Explicit override

    steps:
      - uses: actions/checkout@v7

      - name: Setup CI Profile
        run: |
          mkdir -p /tmp/ci-profile
          cp -r .smartergpt/* /tmp/ci-profile/
          cat > /tmp/ci-profile/profile.yml << EOF
          role: ci
          name: GitHub Actions CI (Mutations)
          version: 1.0.0
          EOF

      - name: Execute Merge
        run: lex-pr merge plan.json --execute
```

**Output:**

```
⚠️  CI role with ALLOW_MUTATIONS=true (explicit override)
❌ CI environment validation failed:
  - ALLOW_MUTATIONS=true in CI role (dangerous)

🔄 Executing merge...
```

**Result:** Mutations enabled with explicit acknowledgment.

#### GitLab CI - CI Role

```yaml
# .gitlab-ci.yml
variables:
  LEX_PR_PROFILE_DIR: /tmp/ci-profile
  GITHUB_TOKEN: $GITHUB_TOKEN # From CI/CD variables

merge-weave:
  stage: deploy
  script:
    - mkdir -p /tmp/ci-profile
    - cp -r .smartergpt/* /tmp/ci-profile/
    - echo "role: ci" > /tmp/ci-profile/profile.yml
    - lex-pr plan --from-github
    - lex-pr gates run
    # Mutations blocked by default (ALLOW_MUTATIONS not set)
  only:
    - main
```

### CI Role Best Practices

#### ✅ Recommended

1. **Use CI role for all CI/CD pipelines**

   ```yaml
   role: ci
   ```

2. **Never set `ALLOW_MUTATIONS=true` by default**

   ```yaml
   # ❌ Bad
   env:
     ALLOW_MUTATIONS: true

   # ✅ Good
   # (omit ALLOW_MUTATIONS, defaults to false)
   ```

3. **Set `GITHUB_TOKEN` explicitly**

   ```yaml
   env:
     GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
   ```

4. **Use dry-run for validation**

   ```bash
   lex-pr merge plan.json --dry-run
   ```

5. **Enable mutations only in protected workflows**
   ```yaml
   # Only in deploy workflow, not in PR checks
   on:
     push:
       branches: [main]
   ```

#### ❌ Avoid

1. **Setting `ALLOW_MUTATIONS=true` in PR workflows**

   ```yaml
   # Dangerous: PR workflows should be read-only
   on:
     pull_request:
   env:
     ALLOW_MUTATIONS: true # ❌ Bad
   ```

2. **Using non-CI roles in CI/CD**

   ```yaml
   # .smartergpt.local/profile.yml
   role: development # ❌ Use 'ci' instead
   ```

3. **Hardcoding tokens**
   ```bash
   export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx  # ❌ Never
   ```

## MCP Server Integration

The MCP server respects all environment variables and CI safety mechanisms.

### MCP Environment Setup

```bash
# Terminal 1: Start MCP server
export LEX_PR_PROFILE_DIR=/workspace/.smartergpt.local
export ALLOW_MUTATIONS=false  # Protected mutations disabled; server is not read-only
lexrunner-mcp
```

### MCP with CI Role

```bash
# Setup CI profile
mkdir -p /tmp/ci-profile
echo "role: ci" > /tmp/ci-profile/profile.yml
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx

# Start MCP server (CI safety enforced)
export LEX_PR_PROFILE_DIR=/tmp/ci-profile
lexrunner-mcp
```

**MCP Tool Behavior:**

- `merge.apply` requires `ALLOW_MUTATIONS=true` or `dryRun=true`
- CI role forces `ALLOW_MUTATIONS=false` unless explicitly overridden
- `GITHUB_TOKEN` validation enforced for CI role

## Troubleshooting

### Deprecation Warnings

**Problem:** Seeing deprecation warnings for `LEXRUNNER_*` variables.

**Solution:** Migrate to `LEX_PR_*` prefix (see Migration Guide).

### CI Environment Validation Failed

**Problem:**

```
❌ CI environment validation failed:
  - Missing GITHUB_TOKEN (required for CI role)
```

**Solution:** Set `GITHUB_TOKEN` or `GH_TOKEN`:

```bash
export GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }}
```

### Mutations Disabled in CI

**Problem:** Merge operations fail with "Mutations not allowed".

**Solution:**

1. **Recommended:** Use `--dry-run` for validation
2. **If mutations needed:** Set `ALLOW_MUTATIONS=true` explicitly (with caution)

### Invalid ALLOW_MUTATIONS Value

**Problem:**

```
⚠️  Invalid ALLOW_MUTATIONS value: "yes" (using false for CI)
```

**Solution:** Use `true` or `false`:

```bash
export ALLOW_MUTATIONS=true  # or false
```

## Complete Example

### Local Development

```bash
# Setup local profile
lex-pr init-local

# Enable mutations for local work
export ALLOW_MUTATIONS=true
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx

# Normal workflow
lex-pr plan --from-github "is:open label:stack:*"
lex-pr gates run
lex-pr merge plan.json --execute
```

### CI/CD Pipeline

```yaml
# .github/workflows/pr-gates.yml
name: PR Quality Gates

on:
  pull_request:

jobs:
  gates:
    runs-on: ubuntu-latest

    env:
      LEX_PR_PROFILE_DIR: /tmp/ci-profile
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      # ALLOW_MUTATIONS not set → defaults to false

    steps:
      - uses: actions/checkout@v7

      - name: Setup CI Profile
        run: |
          mkdir -p /tmp/ci-profile
          cp -r .smartergpt/* /tmp/ci-profile/
          cat > /tmp/ci-profile/profile.yml << EOF
          role: ci
          name: PR Gates CI
          version: 1.0.0
          EOF

      - name: Install lexrunner
        run: npm install -g lexrunner

      - name: Generate Plan
        run: lex-pr plan --from-github --json > plan.json

      - name: Run Gates
        run: lex-pr gates run plan.json

      - name: Dry Run Merge
        run: lex-pr merge plan.json --dry-run
```

## See Also

- [Profile Resolution](profile-resolution.md) - Profile precedence and resolution
- [CI/CD Integration](ci-cd-integration.md) - CI/CD platform integration examples
- [MCP Server](../README.mcp.md) - MCP server configuration
- [Security Implementation](SECURITY_IMPLEMENTATION.md) - Security best practices
