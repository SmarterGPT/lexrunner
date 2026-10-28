# lexrunner Documentation

Complete documentation for LexRunner's dependency-aware integration and coordination workflows.

## 🚀 Getting Started

New to LexRunner? Start here:

1. **[Read-only agent evaluation](./agent-evaluation.md)**
   - Decide `adopt`, `pilot`, `defer`, or `not a fit`
   - Compare existing automation, authority, platform limits, and operating cost
   - Define the smallest reversible trial without installing or editing anything

2. **[Quickstart Guide](./quickstart.md)** (5 minutes)
   - Installation and setup
   - First successful merge
   - Basic workflow

3. **[Architecture Overview](./architecture.md)**
   - System design and philosophy
   - Core components
   - Data flow

4. **[LexRunner Principles](./PRINCIPLES.md)**
   - Leave the work better than you found it
   - Durable-delta and retry-delta invariants
   - Ecosystem responsibilities and executable follow-ups

5. **[CLI Reference](./cli.md)**
   - Complete command documentation
   - Options and flags
   - JSON output schemas

## 📚 Core Concepts

### Planning & Execution

- **[Dependency Parser](./dependency-parser.md)** - Understanding PR dependencies
- **[Schemas](./schemas.md)** - Plan and configuration schemas
- **[Gates](./gates.md)** - Quality gates and input validation
- **[Independent Review Gate](./review-gate.md)** - Mandatory-by-default exact-head review between
  validation and merge
- **[Error Taxonomy](./errors.md)** - Error codes and handling
- **[Counter-Examples](./counter-examples.md)** - Failure learning and capture

### Merge Strategies

- **[Weave Contract](./weave-contract.md)** - Conflict resolution rules
- **[Merge-Weave Analysis](./merge-weave-analysis.md)** - Strategy selection
- **[Weave Execution Log](./weave-execution-log.md)** - Real-world example

### Automation

- **[Autopilot](./autopilot.md)** - Automation overview
- **[Autopilot Levels](./autopilot-levels.md)** - Levels 0-4 explained

### Architecture

- **[LexRunner Principles](./PRINCIPLES.md)** - Normative cumulative-intelligence and fail-forward design guidance
- **[Headless Supervisor](./architecture/headless-supervisor.md)** - Restart reconciliation, bounded control, and retry-delta enforcement
- **[Ecosystem dogfood](./architecture/ecosystem-dogfood.md)** - Packet-owned provisioning, published-package smoke, inspection, and containment-safe reap
- **[Orchestration primitive decisions](./architecture/orchestration-primitives.md)** - Primary-source `adopt | adapt | defer | reject` record for leading agent orchestrators
- **[Canonical CLI and MCP surface](./architecture/canonical-cli-mcp-surface.md)** - Registration-verified dispositions, parity, and ownership

### Agent safety

- **[External-worker workflow](./workflows/external-workers.md)** - Planning, externally coordinated implementation/integration, and verification when governed Attempt execution is unavailable
- **[Agent worktree physical containment](./security/agent-worktree-containment.md)** - Directory-identity guarantees and platform restrictions

## 🔧 Configuration

### Workspace Setup

- **[SmartGPT Structure v1 Spec](./specs/smartergpt-structure-v1.md)** - Complete structure specification
- **[Profile Resolution](./profile-resolution.md)** - Configuration precedence
- **[Prompts Configuration](./prompts.md)** - Prompts precedence, cross-repo usage, token expansion
- **[SmartGPT Structure v1 Specification](./specs/smartergpt-structure-v1.md)** - Complete directory structure spec
- **[TERMS](./TERMS.md)** - Canonical terminology

### File Reference

| File          | Purpose                       | Priority   |
| ------------- | ----------------------------- | ---------- |
| `stack.yml`   | Explicit plan with items/deps | Highest    |
| `scope.yml`   | PR selection criteria         | Fallback   |
| `deps.yml`    | Dependency definitions        | Supporting |
| `gates.yml`   | Quality gate configuration    | Supporting |
| `profile.yml` | Profile metadata              | Metadata   |

## 🎓 Learning Resources

### Tutorials

- **[Quick Merge Pyramid](./tutorials/quick-merge-pyramid.md)** - Complete workflow guide (10 min)
  - Discover → Plan → Execute → Merge
  - Dependency management
  - Gate execution and verification
- **[Video Tutorial Scripts](./tutorials/)** - Complete video guides
  - Getting Started (5 min)
  - Understanding Dependencies (8 min)
  - Quality Gates (10 min)
  - CI/CD Integration (12 min)
  - Advanced Workflows (15 min)

### Workflows by Team Size

- **[Solo Developer](./workflows/solo-developer.md)** - Personal projects
- **[Small Team](./workflows/small-team.md)** - 2-5 developers
- **Medium Team** - 6-20 developers (guide planned)
- **Large Team** - 20+ developers (guide planned)
- **[Enterprise](./workflows/enterprise.md)** - Multi-repository

### Workflows by Project Type

- **Open Source** - Community projects (guide planned)
- **SaaS Application** - Continuous deployment (guide planned)
- **Mobile App** - Platform-specific gates (guide planned)
- **Library/SDK** - API compatibility (guide planned)

### Workflows by Strategy

- **Trunk-Based Development** - Short-lived branches (guide planned)
- **GitFlow** - Release branches (guide planned)
- **GitHub Flow** - Deploy from main (guide planned)

## 🔌 Integrations

### CI/CD Platforms

- **[GitHub Actions](./integrations/README.md#github-actions)** - Native integration
- **[GitLab CI](./integrations/README.md#gitlab-ci)** - GitLab pipelines
- **[Jenkins](./integrations/README.md#jenkins)** - Industry standard
- **[CircleCI](./integrations/README.md#circleci)** - Cloud CI/CD
- **[Azure DevOps](./integrations/README.md#azure-devops)** - Microsoft ecosystem
- **[More platforms...](./integrations/README.md)** - Complete list

### Memory & Lex Integration

- **[Memory Tools Guide](./MEMORY_TOOLS.md)** - Understanding Lex vs LexRunner memory tools
  - When to use `mcp_lex_frame_recall` vs `executor_recall_context`
  - Avoiding split-brain confusion
  - Performance and feature comparisons
- **[Lex Integration](./LEX_INTEGRATION.md)** - How LexRunner integrates with Lex
- **[Lex Public API](./LEX_PUBLIC_API.md)** - Lex API surface for LexRunner

### Communication Tools

- **Slack Notifications** - Post merge results
- **Microsoft Teams** - Integration examples
- **Email Reports** - Automated summaries

## 🛠️ Operations

### Security

- **[Security Implementation](./SECURITY_IMPLEMENTATION.md)** - Enterprise security features
- **[Secret Rotation Guide](./security/rotation-guide.md)** - Rotation patterns and best practices
  - Recommended rotation cadences
  - Compliance framework requirements
  - Step-by-step rotation workflows
  - Automation and CI/CD integration
  - Emergency rotation procedures

### Monitoring

- **[Monitoring Implementation](./monitoring-implementation.md)** - Setup guide
- **[Monitoring Examples](./monitoring-examples.md)** - Real-world usage
- **[CLI/MCP/Weave Reporting](./cli-mcp-weave-reporting.md)** - Reporting patterns

### Troubleshooting

- **[Troubleshooting Guide](./troubleshooting.md)** - Common issues and solutions
  - Installation problems
  - Configuration errors
  - GitHub API issues
  - Gate execution failures
  - Merge operation problems
  - Debugging techniques

### Migration

- **[Node 24 Migration](./node-24-migration.md)** - Ecosystem 3.1 runtime and Windows consumer validation
- **[Migration Guide](./migration-guide.md)** - From manual to automated
  - Migration paths (gradual vs big bang)
  - Scenario mapping
  - Team training
  - Rollback strategies
  - Success metrics

### Release and distribution

- **[LexRunner 1.3.0 dogfood release](./releases/1.3.0.md)** - plan diagnostics, explicit plan
  references, independent review gates, and broker-owned native-WSL projection
- **[LexRunner 1.2.1 publication repair](./releases/1.2.1.md)** - npm metadata repair and explicit
  human publication gate
- **[LexRunner 1.2.0 release decision](./releases/1.2.0.md)** - Compatibility inventory, semver,
  maturity boundary, issue disposition, and required evidence
- **[Release and public npm publishing](./release-process.md)** - Scoped package, signed-tag OIDC,
  candidate validation, LexSona boundary, and native Windows consumer proof

## 📖 Reference

### Commands

| Command       | Description          | Documentation                         |
| ------------- | -------------------- | ------------------------------------- |
| `init`        | Initialize workspace | [CLI Reference](./cli.md#init)        |
| `doctor`      | Validate environment | [CLI Reference](./cli.md#doctor)      |
| `discover`    | Find PRs             | [CLI Reference](./cli.md#discover)    |
| `plan`        | Generate merge plan  | [CLI Reference](./cli.md#plan)        |
| `execute`     | Run quality gates    | [CLI Reference](./cli.md#execute)     |
| `merge`       | Execute merges       | [CLI Reference](./cli.md#merge)       |
| `merge-order` | Show merge order     | [CLI Reference](./cli.md#merge-order) |
| `report`      | Aggregate results    | [CLI Reference](./cli.md#report)      |
| `status`      | Check system status  | [CLI Reference](./cli.md#status)      |
| `schema`      | Validate schemas     | [CLI Reference](./cli.md#schema)      |

### Exit Codes

- **`0`** - Success
- **`2`** - Validation errors (user input)
- **`1`** - System errors (unexpected)

See [Error Taxonomy](./errors.md) for details.

## 🎯 Quick Links

### Common Tasks

- **[First Time Setup](./quickstart.md#step-1-install-lexrunner)** - Install and initialize
- **[Create a PR Stack](./workflows/small-team.md#scenario-3-pr-stack)** - Dependent PRs
- **[Configure Quality Gates](./workflows/small-team.md#3-configure-quality-gates)** - Add checks
- **[Set Up CI/CD](./integrations/README.md#github-actions)** - Automation
- **[Debug Failures](./troubleshooting.md#debugging-techniques)** - Find issues

### Use Cases

- "I want to merge 10 PRs automatically" → [Small Team Workflow](./workflows/small-team.md)
- "I have dependent PRs to merge" → [Dependency Parser](./dependency-parser.md)
- "I need CI/CD integration" → [Integrations](./integrations/README.md)
- "Something's not working" → [Troubleshooting](./troubleshooting.md)
- "Migrating from manual process" → [Migration Guide](./migration-guide.md)

## 🤝 Contributing

### Documentation

Found an issue or want to improve docs?

1. **File an issue** - Report problems or suggest improvements
2. **Submit a PR** - Fix typos, add examples, clarify concepts
3. **Share workflows** - Contribute your team's workflow

### Code Examples

Help others by sharing:

- Configuration examples
- Custom gate scripts
- CI/CD pipeline templates
- Automation workflows

## 📦 Resources

### Downloads

- **[Latest Release](https://github.com/SmarterGPT/lexrunner/releases/latest)**
- **[Example Configurations](../examples/)**
- **[Sample Fixtures](../tests/fixtures/)**

### External Links

- **[GitHub Repository](https://github.com/SmarterGPT/lexrunner)**
- **[Issue Tracker](https://github.com/SmarterGPT/lexrunner/issues)**
- **[Discussions](https://github.com/SmarterGPT/lexrunner/discussions)**
- **[npm Package](https://www.npmjs.com/package/@smartergpt/lexrunner)**

## 📝 Document Index

### Core Documentation (Already Exists)

- [Quickstart Guide](./quickstart.md) ✅
- [CLI Reference](./cli.md) ✅
- [Autopilot](./autopilot.md) ✅
- [Autopilot Levels](./autopilot-levels.md) ✅
- [Profile Resolution](./profile-resolution.md) ✅
- [Dependency Parser](./dependency-parser.md) ✅
- [Schemas](./schemas.md) ✅
- [Errors](./errors.md) ✅
- [Weave Contract](./weave-contract.md) ✅
- [Merge-Weave Analysis](./merge-weave-analysis.md) ✅
- [Weave Execution Log](./weave-execution-log.md) ✅
- [Monitoring Implementation](./monitoring-implementation.md) ✅
- [Monitoring Examples](./monitoring-examples.md) ✅
- [CLI/MCP/Weave Reporting](./cli-mcp-weave-reporting.md) ✅
- [TERMS](./TERMS.md) ✅

### New Documentation (C3)

- [Architecture Overview](./architecture.md) ✅
- [Troubleshooting Guide](./troubleshooting.md) ✅
- [Migration Guide](./migration-guide.md) ✅
- [Video Tutorials](./tutorials/README.md) ✅
- [Workflows](./workflows/README.md) ✅
- [Integrations](./integrations/README.md) ✅

## 🔍 Search Tips

Use GitHub's search or your editor's search to find:

```bash
# Find command examples
grep -r "lex-pr plan" docs/

# Find configuration examples
grep -r "gates.yml" docs/

# Find troubleshooting tips
grep -r "Issue:" docs/troubleshooting.md
```

---

**Last Updated:** 2024
**Version:** 0.1.0
**Maintainers:** lexrunner team
