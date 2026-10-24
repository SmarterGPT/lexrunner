# Enterprise Onboarding Guide

This guide explains how to use lexrunner's enterprise onboarding wizard to set up your workspace with appropriate security, compliance, and team collaboration features.

## Overview

The enterprise onboarding wizard provides:

- **Unified setup** for lex, lexsona, and lexrunner packages
- **Environment detection** (monorepo vs multi-repo, CI provider)
- **Audit profiles** for compliance (SOC2, HIPAA, etc.)
- **Policy templates** with pre-configured quality gates
- **GitHub Copilot instructions** generation
- **CI workflow templates**

## Quick Start

### Basic Enterprise Setup

```bash
npx lex-pr workspace init --enterprise --non-interactive
```

This creates an enterprise workspace with default settings:

- Audit profile: SOC2
- Policy template: enterprise-standard
- Auto-detected environment

### Custom Configuration

```bash
npx lex-pr workspace init --enterprise \
  --enterprise-audit-profile hipaa-strict \
  --policy-template strict \
  --non-interactive
```

## Audit Profiles

Choose an audit profile based on your compliance requirements:

### `off` - No Audit

- Retention: None
- Encryption: No
- Use case: Development environments, personal projects

### `basic` - Basic Audit

- Retention: 30 days
- Encryption: No
- Use case: Small teams, internal projects

### `soc2` - SOC 2 Compliance (Default)

- Retention: 90 days
- Encryption: Yes
- Use case: Enterprise SaaS, customer data handling

### `hipaa-strict` - HIPAA Compliance

- Retention: 365 days
- Encryption: Yes
- Use case: Healthcare applications, PHI handling

## Policy Templates

Policy templates define required quality gates and approval rules:

### `basic`

- **Required gates**: lint, typecheck
- **Approval rules**: None
- Use case: Simple projects, fast iteration

### `enterprise-standard` (Default)

- **Required gates**: lint, typecheck, test, security-scan
- **Approval rules**:
  - Minimum approvers: 2
  - Require code owner: Yes
- Use case: Standard enterprise applications

### `strict`

- **Required gates**: lint, typecheck, test, security-scan, e2e
- **Approval rules**:
  - Minimum approvers: 3
  - Require code owner: Yes
- Use case: Mission-critical applications, regulated industries

## Generated Structure

The enterprise wizard creates the following structure:

```
.smartergpt.local/                    # Your workspace
├── .lexrunner/                       # Enterprise configuration
│   ├── config.yaml                   # Unified enterprise config
│   ├── gate-mapping.yaml             # CI integration mapping
│   ├── personas/                     # Team personas (for LexSona)
│   └── audit/                        # Audit logs (if enabled)
├── intent.md                         # Project goals
├── scope.yml                         # PR discovery rules
├── deps.yml                          # Dependency relationships
├── gates.yml                         # Quality gates
└── runner/                           # Working artifacts

.github/                              # GitHub integration (if detected)
├── copilot-instructions.md           # GitHub Copilot setup
└── workflows/
    └── merge-weave.yaml              # CI workflow template
```

## Environment Detection

The wizard automatically detects your project environment:

### Project Structure

- **monorepo**: Detected via `lerna.json`, `nx.json`, `pnpm-workspace.yaml`, or package.json workspaces
- **single-repo**: Standard single-package repository

### CI Provider

- **github-actions**: Detected via `.github/workflows/`
- **gitlab-ci**: Detected via `.gitlab-ci.yml`
- **circleci**: Detected via `.circleci/config.yml`
- **jenkins**: Detected via `Jenkinsfile`
- **other**: No CI detected or custom CI

## GitHub Copilot Instructions

When GitHub Actions is detected, the wizard generates `.github/copilot-instructions.md` containing:

- Project configuration (structure, CI provider)
- Required quality gates
- Code review requirements
- Audit & compliance settings
- Merge process documentation
- Common commands

This helps GitHub Copilot understand your project's requirements and constraints.

## CI Workflow Templates

For GitHub Actions, a `.github/workflows/merge-weave.yaml` template is created with:

- PR discovery and analysis
- Dependency graph computation
- Gate execution
- Merge-weave workflow
- Artifact upload

### Customizing the Workflow

Edit `.github/workflows/merge-weave.yaml` to:

- Add environment variables
- Configure secrets
- Adjust trigger conditions
- Add custom steps

## Gate Mapping

The `gate-mapping.yaml` file maps lexrunner gates to your CI provider:

### GitHub Actions Example

```yaml
version: 1
provider: github-actions

gates:
  lint:
    workflow: .github/workflows/lint.yml
    check: lint
  test:
    workflow: .github/workflows/test.yml
    check: test
```

### Custom CI Example

```yaml
version: 1
provider: custom

gates:
  lint:
    command: npm run lint
  test:
    command: npm test
```

## Interactive Setup

Omit `--non-interactive` for a guided setup:

```bash
npx lex-pr workspace init --enterprise
```

The wizard will:

1. Detect your environment
2. Prompt for GitHub token (optional)
3. Display detected configuration
4. Create workspace structure
5. Show next steps

## Reinitializing

To reinitialize an existing workspace:

```bash
npx lex-pr workspace init --enterprise --force
```

Without `--force`, enterprise initialization may fill missing files in an incomplete writable
profile, but it preserves existing authored files. With `--force`, it replaces the
enterprise-managed `gates.yml`, `.lexrunner/config.yaml`, `.lexrunner/gate-mapping.yaml`, and (for
GitHub Actions) `.github/copilot-instructions.md`. An existing
`.github/workflows/merge-weave.yaml` is always preserved.

## Examples

### Healthcare Application (HIPAA)

```bash
npx lex-pr workspace init \
  --enterprise \
  --enterprise-audit-profile hipaa-strict \
  --policy-template strict \
  --non-interactive
```

### Financial Services (SOC2)

```bash
npx lex-pr workspace init \
  --enterprise \
  --enterprise-audit-profile soc2 \
  --policy-template enterprise-standard \
  --non-interactive
```

### Internal Tools (Basic)

```bash
npx lex-pr workspace init \
  --enterprise \
  --enterprise-audit-profile basic \
  --policy-template basic \
  --non-interactive
```

## Next Steps

After initialization:

1. **Review configuration**: Check `.smartergpt.local/.lexrunner/config.yaml`
2. **Configure gates**: Update `.smartergpt.local/gates.yml` with your CI commands
3. **Verify setup**: Run `npx lex-pr doctor`
4. **Discover PRs**: Run `npx lex-pr discover`
5. **Execute workflow**: Run `npx lex-pr weave`

## Troubleshooting

### Audit directory not created

- Check that you're using an audit profile other than `off`
- Verify the `.smartergpt.local/.lexrunner/config.yaml` file

### GitHub files not generated

- Ensure `.github/workflows/` directory exists
- The wizard detects GitHub Actions by this directory

### Wrong audit profile applied

- Use `--enterprise-audit-profile` (not `--audit-profile`)
- The global `--audit-profile` flag is for runtime audit logging

### Configuration already exists

- Use `--force` to replace the documented enterprise-managed files in the existing writable profile
- Or manually remove `.smartergpt.local/` directory

## See Also

- [MERGE_WEAVE_QUICKSTART.md](../MERGE_WEAVE_QUICKSTART.md) - Getting started with merge-weave
- [docs/security/](../docs/security/) - Security implementation details
- [AGENTS.md](../AGENTS.md) - Project principles and operating rules
