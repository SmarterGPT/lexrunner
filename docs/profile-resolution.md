# Profile Resolution

**Status:** Stable (v0.1.0)
**Last Updated:** 2025-11-13

## Overview

Profile resolution is the mechanism by which `lexrunner` locates and selects the correct profile directory for execution. A **profile** contains configuration files (`intent.md`, `scope.yml`, `deps.yml`, `gates.yml`, etc.) that define how the runner operates.

The resolution system supports multiple environments and use cases through a clear **precedence chain**.

## Precedence Chain

Profile directories are resolved in the following order (highest to lowest priority):

1. **`--profile-dir` flag** - Explicit CLI override
2. **`LEX_PR_PROFILE_DIR` env variable** - Environment-based override
3. **`.smartergpt.local/`** - Local overlay (development, not tracked)
4. **`.smartergpt/`** - Tracked example profile (repository default)

The first existing profile directory in this chain is selected.

## Directory Structure

### Configuration File Placement

Configuration files (`intent.md`, `scope.yml`, `gates.yml`, `deps.yml`, etc.) are located at the **profile root**, not in a subdirectory:

```
.smartergpt/                  # Tracked profile
├── intent.md                 # ✅ Config at root
├── scope.yml                 # ✅ Config at root
├── gates.yml                 # ✅ Config at root
├── prompts/                  # Canon prompts directory
│   ├── create-project.md
│   └── idea.md
└── runner/                   # ✅ Working artifacts only
    ├── plan.json             # Generated plan
    ├── cache/                # Ephemeral cache
    └── logs/                 # Execution logs
```

### Working Directory vs Configuration

**Important distinction:**

- **Profile root** (`runner/`, NOT in a subdirectory) - Contains configuration files
- **`runner/` directory** - Contains only working artifacts (plan.json, cache, logs)

The `runner/` directory should be **gitignored** as it contains ephemeral working files, not configuration.

### Prompts Directory Precedence

Prompts are resolved using a **5-level precedence chain** separate from profiles:

1. **`LEX_PROMPTS_DIR`** (environment variable) - Explicit override for cross-repo usage
2. **`.smartergpt.local/prompts/`** - Local overlay (not tracked)
3. **`.smartergpt/prompts/`** - Workspace prompts (tracked)
4. **`@smartergpt/lex/prompts`** - Package defaults (if present)
5. **`@smartergpt/lex/canon/prompts`** - Canonical fallback from Lex package

**Key Features:**

- Independent from profile resolution (e.g., can use `.smartergpt/` profile with Lex prompts)
- Enables cross-repository prompt sharing
- Supports token expansion (`{{today}}`, `{{now}}`, `{{repo_root}}`, `{{branch}}`, `{{commit}}`)
- File-level overlay (entire prompt file is replaced, not merged)
- Package fallback provides canonical prompts when no local prompts exist

**See Also:** [Prompts Configuration](./prompts.md) for complete documentation on prompts precedence, token expansion, and cross-repo usage.

## Profile Roles

Each profile has a `role` defined in `profile.yml`:

- **`example`** - Read-only tracked profile (repository default)
- **`development`** - Local development profile (can be written to)
- **`local`** - Custom local profile (not tracked)

**Write Protection:** The runner will only write artifacts (deliverables, logs, etc.) to profiles with `role != example`. This prevents accidental commits of generated content.

## Use Cases

### Development Workflow

**Scenario:** Working on a feature branch, want local customization without polluting the repository.

```bash
# Initialize local overlay (one-time)
lexrunner init-local

# Normal workflow - automatically uses .smartergpt.local/
lexrunner plan --from-github "is:open label:ready"
lexrunner gates run
```

**Result:**

- `.smartergpt.local/` created with `role: development`
- Project type auto-detected (Python/JS/TypeScript/etc.)
- Relevant config files copied from `.smartergpt/` as templates
- All runner artifacts go to `.smartergpt.local/runner/`
- Git ignores `.smartergpt.local/` (via `.gitignore`)

### CI/CD Environment

**Scenario:** Running in CI, need isolated profile for pipeline execution.

```yaml
# .github/workflows/pr-weave.yml
env:
  LEX_PR_PROFILE_DIR: /tmp/ci-profile

steps:
  - name: Setup profile
    run: |
      mkdir -p /tmp/ci-profile
      cp -r .smartergpt/* /tmp/ci-profile/
      echo "role: local" > /tmp/ci-profile/profile.yml

  - name: Run gates
    run: lexrunner gates run
```

**Result:**

- Runner uses `/tmp/ci-profile/` (ephemeral, write-safe)
- No conflicts with repository tracked files
- Clean workspace between runs

### Multi-Repository Setup

**Scenario:** Developing lexrunner itself, want separate profiles for testing.

```bash
# Override profile for testing
lexrunner plan --profile-dir /path/to/test-profile
```

**Result:**

- Explicit override takes precedence
- Useful for testing different configurations
- Safe isolation between projects

### MCP Server Context

**Scenario:** Using lexrunner as an MCP server, need environment-based configuration.

```bash
# Start MCP server with custom profile
export LEX_PR_PROFILE_DIR=/workspace/.smartergpt.local
lexrunner mcp

# Or in MCP client configuration
{
  "mcpServers": {
    "lexrunner": {
      "command": "lexrunner",
      "args": ["mcp"],
      "env": {
        "LEX_PR_PROFILE_DIR": "/workspace/.smartergpt.local"
      }
    }
  }
}
```

**MCP Tools:**

```typescript
// Resolve current profile
{
  "name": "profile.resolve",
  "arguments": {}
}
// Returns: { "path": "...", "source": "LEX_PR_PROFILE_DIR", "manifest": {...} }

// Initialize local overlay
{
  "name": "local.init",
  "arguments": { "force": false }
}
// Returns: { "created": true, "path": "...", "config": {...}, "copiedFiles": [...], "backupPath"?: "..." }
```

Forced recreation never recursively deletes the live overlay. LexRunner atomically stages the
existing directory, creates the replacement through exclusive file admission, and retains the
prior profile under the new `.smartergpt.local/runner/force-backups/` directory. The CLI and MCP
result report its exact `backupPath`. Temporary staging uses the repository's Git metadata when
available, which cannot be tracked as worktree content, or a same-volume parent directory outside
the workspace. If a concurrent writer changes the staged manifest to a protected or malformed
profile, initialization stops and reports the retained staging path. LexRunner does not attempt a
check-then-rename restoration because directory replacement semantics differ across platforms; it
never deletes or overwrites either writer's data.

## Migration Guide

### From compatibility `runner/` configuration

Configuration belongs at the profile root; `runner/` is reserved for generated artifacts. Older
LexRunner releases could place configuration under `runner/`. Those files remain readable as a
compatibility fallback, but they never override a same-named profile-root file.

Inspect and migrate a writable profile explicitly:

```bash
lexrunner migrate-profile --from-runner --profile-dir .smartergpt.local --dry-run
lexrunner migrate-profile --from-runner --profile-dir .smartergpt.local
```

The migration creates a backup, refuses to overwrite root files, and reports any file whose
rollback disposition cannot be confirmed. A tracked `role: example` profile remains write
protected; update such repository configuration through normal reviewed source changes.

### From Hardcoded `.smartergpt/`

**Before:**

```typescript
// Old code hardcoded profile path
const profilePath = path.join(process.cwd(), ".smartergpt");
```

**After:**

```typescript
import { resolveProfile } from "./config/profileResolver.js";

// New code uses resolution chain
const resolved = resolveProfile();
const profilePath = resolved.path;
const role = resolved.manifest.role;
```

### From Custom Profile Logic

**Before:**

```bash
# Manual profile management
cp -r .smartergpt .smartergpt.local
# Edit .smartergpt.local/...
```

**After:**

```bash
# Automated local overlay
lexrunner init-local

# Runner automatically uses .smartergpt.local/
lexrunner plan
```

## API Reference

### CLI

```bash
# Resolve and display current profile
lexrunner doctor  # Shows profile info

# Override profile directory
lexrunner plan --profile-dir /custom/path

# Initialize local overlay
lexrunner init-local [--force]
```

### TypeScript

```typescript
import { resolveProfile, validateWriteOperation } from "./config/profileResolver.js";

// Resolve profile with optional override
const resolved = resolveProfile(profileDirOverride?, baseDir?);

// Result
interface ResolvedProfile {
  path: string;           // Absolute path to profile directory
  source: string;         // Resolution source ("--profile-dir", "LEX_PR_PROFILE_DIR", etc.)
  manifest: {
    role: string;         // "example", "development", "local"
    name?: string;
    version?: string;
  };
}

// Validate write operation
try {
  validateWriteOperation(profilePath, role, "write deliverables");
} catch (WriteProtectionError) {
  // Handle read-only profile
}
```

### MCP Server

See [Use Cases - MCP Server Context](#mcp-server-context) above.

## Best Practices

### Do ✅

- **Use `init-local` for development** - Automatic setup, safe defaults
- **Rely on precedence chain** - Explicit overrides when needed, defaults otherwise
- **Track `.smartergpt/` as examples** - Provides working defaults for new users
- **Ignore `.smartergpt.local/`** - Keep local customizations out of version control
- **Use `LEX_PR_PROFILE_DIR` in CI** - Environment isolation without repository changes

### Don't ❌

- **Don't hardcode profile paths** - Use `resolveProfile()` instead
- **Don't commit `.smartergpt.local/`** - Local overrides should stay local
- **Don't write to `role: example` profiles** - Respect write protection
- **Don't assume `.smartergpt/` exists** - Always use resolution chain
- **Don't skip `init-local` in development** - Manual setup is error-prone

## Troubleshooting

### "Profile directory not found"

**Symptom:** Runner exits with "No profile directory found in precedence chain"

**Solution:**

```bash
# Check current resolution
lexrunner doctor

# Initialize local overlay
lexrunner init-local

# Or use explicit override
lexrunner plan --profile-dir .smartergpt
```

### "Write operation failed: role=example is read-only"

**Symptom:** Runner refuses to write artifacts to profile

**Solution:**

```bash
# Initialize local overlay for development
lexrunner init-local

# Or update profile.yml in custom profile
echo "role: development" > /path/to/profile/profile.yml
```

### Profile resolution uses wrong directory

**Symptom:** Runner picks unexpected profile

**Diagnosis:**

```bash
# Check precedence chain
lexrunner doctor  # Shows resolved path and source

# Check environment
echo $LEX_PR_PROFILE_DIR

# List candidates
ls -la .smartergpt.local/ .smartergpt/
```

**Solution:** Clear higher-priority overrides or use explicit `--profile-dir`.

## Related Documentation

- [SmartGPT Structure v1 Spec](./specs/smartergpt-structure-v1.md) - Complete structure specification
- [Prompts Configuration](./prompts.md) - Prompts precedence and token expansion
- [CLI Usage](./cli.md) - Command-line interface and flags
- [MCP Server](../README.mcp.md) - Model Context Protocol integration
- [Terms](./TERMS.md) - Canonical terminology
- [AGENTS.md](../AGENTS.md) - Two-track separation and portable workspace

## Schema

Profile directories must contain `profile.yml`:

```yaml
# Minimum profile.yml
role: development # "example" | "development" | "local"

# Optional metadata
name: my-project
version: 1.0.0
projectType: typescript # Auto-detected by init-local
```

## Examples

### Example 1: Quick Start

```bash
# Clone repository
git clone https://github.com/Guffawaffle/LexRunner.git
cd lexrunner

# Initialize local overlay
npm run cli -- init-local

# Verify resolution
npm run cli -- doctor
# Output: "using profile: /abs/path/.smartergpt.local (role: development)"

# Work normally
npm run cli -- plan
# Artifacts go to .smartergpt.local/runner/
```

### Example 2: Testing Different Configs

```bash
# Create test profiles
mkdir -p /tmp/profile-a /tmp/profile-b
cp -r .smartergpt/* /tmp/profile-a/
cp -r .smartergpt/* /tmp/profile-b/

# Edit configurations differently
echo "role: local" > /tmp/profile-a/profile.yml
echo "role: local" > /tmp/profile-b/profile.yml

# Test with profile A
lexrunner plan --profile-dir /tmp/profile-a

# Test with profile B
lexrunner plan --profile-dir /tmp/profile-b
```

### Example 3: CI Pipeline

```yaml
# .github/workflows/integration.yml
name: Integration Tests

on: [pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    env:
      LEX_PR_PROFILE_DIR: /tmp/ci-profile
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

    steps:
      - uses: actions/checkout@v7

      - name: Setup profile
        run: |
          mkdir -p $LEX_PR_PROFILE_DIR
          cp -r .smartergpt/* $LEX_PR_PROFILE_DIR/
          cat > $LEX_PR_PROFILE_DIR/profile.yml << EOF
          role: local
          name: ci-pipeline
          EOF

      - name: Discover PRs
        run: npm run cli -- plan --from-github "is:open label:ready"

      - name: Run gates
        run: npm run cli -- gates run

      - name: Upload artifacts
        uses: actions/upload-artifact@v7
        with:
          name: gate-results
          path: ${{ env.LEX_PR_PROFILE_DIR }}/runner/gates/
```

---

**Next Steps:**

- Read [Environment Variables](./environment-variables.md) for environment configuration and CI safety
- Read [CLI Usage](./cli.md) for command details
- See [AGENTS.md](../AGENTS.md) for architectural context
- Check [examples/](../examples/) for more use cases
