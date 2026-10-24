# Quickstart Guide

Get started with lexrunner in less than 5 minutes! This guide will walk you through setting up your workspace and completing your first successful merge.

## Prerequisites

- **Node.js**: 24 LTS or later
- **Git**: Properly configured with `user.name` and `user.email`
- **GitHub**: Repository access and optional personal access token

## Step 1: Install lexrunner

```bash
npm install -g lexrunner
```

Or use it directly in your project:

```bash
npm install --save-dev lexrunner
```

## Step 2: Initialize Your Workspace

Run the interactive setup wizard:

```bash
lex-pr init
```

The wizard will:

1. Detect your project type (Node.js, Python, Rust, Go, etc.)
2. Prompt for GitHub token (optional but recommended)
3. Validate repository access
4. Create workspace configuration in `.smartergpt.local/`

### What Gets Created

```
.smartergpt.local/
├── profile.yml                  # Profile metadata (role: development)
├── intent.md                    # Project goals and scope (config)
├── scope.yml                    # PR discovery rules (config)
├── deps.yml                     # Dependency relationships (config)
├── gates.yml                    # Quality gates configuration (config)
├── pull-request-template.md     # PR template with dependency syntax (config)
└── runner/                      # Working directory (gitignored)
    ├── plan.json                # Generated execution plan
    ├── cache/                   # Ephemeral cache
    └── logs/                    # Execution logs
```

**Note:** Configuration files are at the **profile root**, not in a `runner/` subdirectory. The `runner/` directory contains only working artifacts (plan.json, cache, logs), which are gitignored.

### Non-Interactive Setup

For CI/CD pipelines or automated setups:

```bash
# Use environment variables
export GITHUB_TOKEN=your_token_here
lex-pr init --non-interactive
```

## Step 3: Configure Your Workspace

### Edit `intent.md`

Describe your project goals and scope:

```markdown
# Project Intent

## Goals

- Implement feature X
- Refactor module Y
- Fix critical bug Z

## Success Criteria

- All tests pass
- Code coverage > 80%
- No security vulnerabilities
```

### Configure `scope.yml`

Define how to discover PRs:

```yaml
version: 1
target: main
sources:
  - query: "is:pr is:open"
selectors:
  include_labels:
    - "ready-to-merge"
    - "stack:*"
  exclude_labels:
    - "do-not-merge"
    - "work-in-progress"
defaults:
  strategy: merge-weave
  base: main
pin_commits: false
```

### Set Up Quality Gates in `gates.yml`

```yaml
version: 1
gates:
  - name: typecheck
    run: npm run typecheck
    runtime: local
  - name: test
    run: npm test
    runtime: local
  - name: lint
    run: npm run lint
    runtime: local
```

### Set Up Prompts (Optional)

Prompts are template files used for plan generation and automation. They support token expansion (`{{today}}`, `{{branch}}`, etc.) and cross-repository sharing.

#### Using Tracked Prompts (Default)

By default, prompts are loaded from `.smartergpt/prompts/`:

```bash
lex-pr plan --from-github
# Uses .smartergpt/prompts/create-project.md
```

#### Custom Local Prompts

Create custom prompts in `.smartergpt.local/prompts/`:

```bash
mkdir -p .smartergpt.local/prompts

# Copy and customize
cp .smartergpt/prompts/create-project.md .smartergpt.local/prompts/
vim .smartergpt.local/prompts/create-project.md

# Automatically uses local version
lex-pr plan --from-github
```

#### Cross-Repository Prompts

Share prompts across repositories using one of three methods:

**Method 1: Environment Variable (Recommended for CI/CD)**

```bash
export LEX_PROMPTS_DIR=/path/to/lex/.smartergpt/prompts
lex-pr plan --from-github
```

**Method 2: Symlink (Recommended for Development)**

```bash
ln -s ../../lex/.smartergpt/prompts .smartergpt.local/prompts
lex-pr plan --from-github
```

**Method 3: Copy (Recommended for Customization)**

```bash
cp -r ../lex/.smartergpt/prompts .smartergpt.local/
lex-pr plan --from-github
```

**See Also:** [Prompts Configuration](./prompts.md) for complete documentation on token expansion, frontmatter, and cross-repo usage.

## Step 5: Verify Your Setup

Run the doctor command to ensure everything is configured correctly:

```bash
lex-pr doctor
```

Expected output:

```
🩺 Doctor - Environment and config sanity checks

✓ Node.js version: v24.x.x (matches .nvmrc)
✓ npm version: 11.16.0 (matches packageManager)
✓ Git config: user.name="Your Name", user.email="you@example.com"
✓ Platform: linux
✓ Working directory: /path/to/your/project
✓ .smartergpt.local: all expected files present
📁 Project type: nodejs
✓ GitHub: authenticated as your-username
✓ Git: working directory clean
✓ Git: current branch 'main'

✅ All checks passed - environment looks good!
```

## Step 6: Discover PRs

Find open pull requests that match your scope:

```bash
lex-pr discover
```

This will show you PRs that can be merged based on your configuration.

## Step 7: Generate a Merge Plan

Create a merge plan from discovered PRs. You have several options:

### Option 1: Auto-Discovery with Diffgraph Planner (Recommended)

Automatically discover dependencies from PR descriptions and file changes:

```bash
# Generate plan with dependency auto-discovery
lex-pr plan --from-github
```

**What this does:**

1. Fetches all open PRs matching your scope filters
2. Parses explicit dependencies from PR descriptions (e.g., `Depends-on: #42`)
3. Analyzes file changes to suggest implicit dependencies
4. Validates the dependency graph (detects cycles)
5. Computes merge layers using topological sort
6. Generates `plan.json`

**Example PR description with explicit dependency:**

```markdown
# Add Authentication UI

UI components for the auth system.

## Dependencies

Depends-on: #42

## Changes

- Add LoginForm component
- Add LogoutButton component
```

**Review dependency suggestions before generating final plan:**

```bash
# See file-based dependency suggestions
lex-pr plan --suggest-deps --threshold=0.7 > suggestions.md

# Review suggestions, add to PR descriptions, then regenerate plan
lex-pr plan --from-github
```

See the **[Diffgraph Planner Guide](./diffgraph-planner.md)** for complete documentation on:

- Dependency syntax reference
- File-change heuristics
- Validation & troubleshooting
- Best practices and workflows

### Option 2: Basic Planning from GitHub

Generate a simple plan without file analysis:

```bash
lex-pr plan --from-github --no-suggestions
```

### Option 3: Manual Planning

Create `plan.json` manually for full control:

<!-- lexrunner-plan-example:quickstart-manual -->

```json
{
  "schemaVersion": "1.0.0",
  "target": "main",
  "items": [
    {
      "name": "feature/auth",
      "deps": [],
      "gates": []
    }
  ]
}
```

**Generated plan structure:**

- Dependency graph
- Merge order (topologically sorted)
- Policy configuration

## Step 8: Execute Quality Gates

Run quality gates on your plan:

```bash
lex-pr execute plan.json
```

Gates run in dependency order, ensuring:

- Dependencies pass before dependents
- Parallel execution where possible
- Clear status reporting

## Step 9: Merge PRs

Once all gates pass, merge your PRs:

```bash
lex-pr merge plan.json --dry-run
```

Remove `--dry-run` when ready to execute:

```bash
lex-pr merge plan.json
```

## Using Autopilot (Advanced)

For automated workflows, use autopilot levels:

### Level 0: Report Only

```bash
lex-pr autopilot plan.json --level 0
```

### Level 1: Artifact Generation

```bash
lex-pr autopilot plan.json --level 1
```

Generates:

- `analysis.json` - Structured merge analysis
- `weave-report.md` - Human-readable report
- `gate-predictions.json` - Expected outcomes
- `execution-log.md` - Tracking template

### Level 2: Branch Creation (requires writable profile)

```bash
lex-pr autopilot plan.json --level 2 --profile-dir .smartergpt.local/
```

## Common Workflows

### Workflow 1: Manual Review

```bash
lex-pr init
lex-pr doctor
lex-pr discover
lex-pr plan --from-github
lex-pr execute plan.json
lex-pr merge plan.json --dry-run
# Review, then:
lex-pr merge plan.json
```

### Workflow 2: CI/CD Pipeline

```bash
#!/bin/bash
set -e

# Initialize (if needed)
lex-pr init --non-interactive

# Validate environment
lex-pr doctor --json > doctor-results.json

# Generate and execute plan
lex-pr plan --from-github --out plan.json
lex-pr execute plan.json --json > gate-results.json

# Merge if all gates pass
if [ $? -eq 0 ]; then
  lex-pr merge plan.json
fi
```

### Workflow 3: Stack Merging

```bash
# For PR stacks with dependencies
lex-pr plan --from-github --stack

# Execute with dependency-aware gating
lex-pr execute plan.json

# Merge in correct order
lex-pr merge plan.json
```

## Troubleshooting

### Configuration Issues

**Problem**: "Configuration already exists"

```bash
# Solution: Use --force to overwrite
lex-pr init --force
```

**Problem**: "Write protection error"

```bash
# Solution: Use .smartergpt.local instead
lex-pr init --profile-dir .smartergpt.local
```

### GitHub Integration Issues

**Problem**: "GitHub authentication failed"

```bash
# Solution: Set up GitHub token
export GITHUB_TOKEN=ghp_your_token_here
lex-pr init
```

**Problem**: "Repository not detected"

```bash
# Solution: Ensure you're in a Git repository with GitHub remote
git remote -v
```

### Quality Gate Failures

**Problem**: Gates fail unexpectedly

```bash
# Solution 1: Run gates locally first
npm run typecheck
npm test
npm run lint

# Solution 2: Check gate configuration
cat .smartergpt.local/gates.yml

# Solution 3: View detailed logs
lex-pr execute plan.json --json
```

## Next Steps

- **Read the full CLI documentation**: `docs/cli.md`
- **Explore advanced CLI features**: `docs/advanced-cli.md` - Interactive viewer, query language, bulk operations
- **Explore autopilot levels**: `docs/autopilot.md`
- **Understand profile resolution**: `docs/profile-resolution.md`
- **Learn about weave strategies**: `docs/weave-contract.md`

## Pro Tips

1. **Use environment variables for tokens**:

   ```bash
   export GITHUB_TOKEN=your_token
   export GH_TOKEN=your_token  # Alternative
   ```

2. **Keep `.smartergpt.local/` in .gitignore**:

   ```gitignore
   .smartergpt.local/
   .smartergpt/runner/
   .smartergpt/cache/
   ```

3. **Track `.smartergpt/` as example**:
   - Use `.smartergpt/` for team examples
   - Use `.smartergpt.local/` for local work

4. **Validate before committing**:

   ```bash
   lex-pr schema validate plan.json
   lex-pr doctor --bootstrap
   ```

5. **Use JSON mode for automation**:

   ```bash
   lex-pr doctor --json | jq '.hasErrors'
   lex-pr execute plan.json --json | jq '.results'
   ```

6. **Power user shortcuts**:

   ```bash
   # Interactive plan exploration
   lex-pr view plan.json

   # Query and analyze plans
   lex-pr query plan.json --stats
   lex-pr query plan.json "level eq 1"

   # Batch operations
   lex-pr merge --batch --levels "1,2" --execute

   # Shell completion
   eval "$(lex-pr completion bash)"
   ```

## Success! 🎉

You've completed the quickstart guide. You should now be able to:

- ✅ Initialize a workspace
- ✅ Configure PR discovery and gates
- ✅ Generate merge plans
- ✅ Execute quality gates
- ✅ Merge PRs safely
- ✅ Use advanced CLI features for power users

## Next Steps

- **[Merge-Weave Quickstart](./merge-weave-quickstart.md)** - Detailed guide for merge-weave operations with plan files
- **[CLI Reference](./cli.md)** - Complete command reference
- **[Advanced CLI Features](./advanced-cli.md)** - Power user features
- **[Autopilot Levels](./autopilot-levels.md)** - Automation levels 0-4
- **[Troubleshooting](./troubleshooting.md)** - Common issues and solutions

Need help? Check the full documentation in the `docs/` directory or run `lex-pr --help`.
