/**
 * Enterprise onboarding wizard with unified setup
 * Provides guided setup for teams adopting the Lex ecosystem
 */

import * as fs from "fs";
import * as path from "path";
import YAML from "yaml";

export type AuditProfile = "off" | "basic" | "soc2" | "hipaa-strict";
export type PolicyTemplate = "basic" | "enterprise-standard" | "strict";
export type CIProvider = "github-actions" | "gitlab-ci" | "circleci" | "jenkins" | "other";
export type ProjectStructure = "monorepo" | "multi-repo" | "single-repo";

export interface EnterpriseConfig {
  audit: {
    profile: AuditProfile;
    retention: string;
    encryption: boolean;
  };
  policy: {
    template: PolicyTemplate;
    requiredGates: string[];
    approvalRules?: {
      minApprovers?: number;
      requireCodeOwner?: boolean;
    };
  };
  environment: {
    projectStructure: ProjectStructure;
    ciProvider: CIProvider;
  };
}

export interface EnvironmentDetectionResult {
  projectStructure: ProjectStructure;
  ciProvider: CIProvider;
  workspaceRoot: string;
  isMonorepo: boolean;
  detectedCI: string[];
}

export interface CreateEnterpriseWorkspaceOptions {
  /** Replace enterprise-managed files. Existing CI workflows are always preserved. */
  force?: boolean;
}

/**
 * Detect project environment (monorepo vs multi-repo, CI provider)
 */
export function detectEnvironment(baseDir: string): EnvironmentDetectionResult {
  const detectedCI: string[] = [];
  let ciProvider: CIProvider = "other";

  // Detect CI provider
  if (fs.existsSync(path.join(baseDir, ".github", "workflows"))) {
    detectedCI.push("github-actions");
    ciProvider = "github-actions";
  }
  if (fs.existsSync(path.join(baseDir, ".gitlab-ci.yml"))) {
    detectedCI.push("gitlab-ci");
    if (ciProvider === "other") ciProvider = "gitlab-ci";
  }
  if (fs.existsSync(path.join(baseDir, ".circleci", "config.yml"))) {
    detectedCI.push("circleci");
    if (ciProvider === "other") ciProvider = "circleci";
  }
  if (fs.existsSync(path.join(baseDir, "Jenkinsfile"))) {
    detectedCI.push("jenkins");
    if (ciProvider === "other") ciProvider = "jenkins";
  }

  // Detect monorepo
  const hasLerna = fs.existsSync(path.join(baseDir, "lerna.json"));
  const hasNxJson = fs.existsSync(path.join(baseDir, "nx.json"));
  const hasPnpmWorkspace = fs.existsSync(path.join(baseDir, "pnpm-workspace.yaml"));
  const hasYarnWorkspaces = (() => {
    try {
      const pkgPath = path.join(baseDir, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        return !!pkg.workspaces;
      }
    } catch {
      return false;
    }
    return false;
  })();

  const isMonorepo = hasLerna || hasNxJson || hasPnpmWorkspace || hasYarnWorkspaces;
  const projectStructure: ProjectStructure = isMonorepo ? "monorepo" : "single-repo";

  return {
    projectStructure,
    ciProvider,
    workspaceRoot: baseDir,
    isMonorepo,
    detectedCI,
  };
}

/**
 * Get audit profile configuration
 */
export function getAuditProfileConfig(profile: AuditProfile): EnterpriseConfig["audit"] {
  const configs: Record<AuditProfile, EnterpriseConfig["audit"]> = {
    off: {
      profile: "off",
      retention: "0d",
      encryption: false,
    },
    basic: {
      profile: "basic",
      retention: "30d",
      encryption: false,
    },
    soc2: {
      profile: "soc2",
      retention: "90d",
      encryption: true,
    },
    "hipaa-strict": {
      profile: "hipaa-strict",
      retention: "365d",
      encryption: true,
    },
  };

  return configs[profile];
}

/**
 * Get policy template configuration
 */
export function getPolicyTemplateConfig(template: PolicyTemplate): EnterpriseConfig["policy"] {
  const configs: Record<PolicyTemplate, EnterpriseConfig["policy"]> = {
    basic: {
      template: "basic",
      requiredGates: ["lint", "typecheck"],
    },
    "enterprise-standard": {
      template: "enterprise-standard",
      requiredGates: ["lint", "typecheck", "test", "security-scan"],
      approvalRules: {
        minApprovers: 2,
        requireCodeOwner: true,
      },
    },
    strict: {
      template: "strict",
      requiredGates: ["lint", "typecheck", "test", "security-scan", "e2e"],
      approvalRules: {
        minApprovers: 3,
        requireCodeOwner: true,
      },
    },
  };

  return configs[template];
}

/**
 * Generate GitHub Copilot instructions
 */
export function generateCopilotInstructions(config: EnterpriseConfig): string {
  const { audit, policy, environment } = config;

  return `# GitHub Copilot Instructions for lexrunner

## Project Configuration

**Project Structure:** ${environment.projectStructure}
**CI Provider:** ${environment.ciProvider}

## Quality Gates

This project requires the following quality gates to pass:
${policy.requiredGates.map((gate) => `- ${gate}`).join("\n")}

## Code Review Requirements

${
  policy.approvalRules
    ? `- Minimum approvers: ${policy.approvalRules.minApprovers || "N/A"}
- Require code owner approval: ${policy.approvalRules.requireCodeOwner ? "Yes" : "No"}`
    : "- Standard review process applies"
}

## Audit & Compliance

**Audit Profile:** ${audit.profile}
**Retention:** ${audit.retention}
**Encryption:** ${audit.encryption ? "Required" : "Not required"}

## Merge Process

This repository uses lexrunner's merge-weave workflow:

1. PRs are discovered and analyzed for dependencies
2. A dependency graph is computed
3. Quality gates are executed in topological order
4. Eligible PRs are merged following the merge pyramid pattern

## Commands

- \`npx lex-pr init\` - Initialize workspace
- \`npx lex-pr discover\` - Discover open PRs
- \`npx lex-pr weave\` - Execute merge-weave workflow
- \`npx lex-pr doctor\` - Verify configuration

## Guidelines

- Always declare PR dependencies using \`Depends-On: #<PR>\` syntax
- Keep PRs small and focused
- Ensure all required gates pass before requesting review
- Follow the team's coding standards and conventions
`;
}

/**
 * Generate gate mapping configuration for CI integration
 */
export function generateGateMappingConfig(ciProvider: CIProvider, requiredGates: string[]): string {
  const mappings: Record<CIProvider, (gates: string[]) => string> = {
    "github-actions": (gates) => `# GitHub Actions Gate Mapping
# Maps lexrunner gates to GitHub Actions workflows

version: 1
provider: github-actions

gates:
${gates
  .map(
    (gate) => `  ${gate}:
    workflow: .github/workflows/${gate}.yml
    check: ${gate}`
  )
  .join("\n")}

# Example workflow for a gate:
# .github/workflows/lint.yml
# ---
# name: Lint
# on: [pull_request]
# jobs:
#   lint:
#     runs-on: ubuntu-latest
#     steps:
#       - uses: actions/checkout@v4
#       - uses: actions/setup-node@v4
#       - run: npm ci
#       - run: npm run lint
`,

    "gitlab-ci": (gates) => `# GitLab CI Gate Mapping
version: 1
provider: gitlab-ci

gates:
${gates
  .map(
    (gate) => `  ${gate}:
    job: ${gate}
    stage: test`
  )
  .join("\n")}
`,

    circleci: (gates) => `# CircleCI Gate Mapping
version: 1
provider: circleci

gates:
${gates
  .map(
    (gate) => `  ${gate}:
    job: ${gate}
    workflow: test`
  )
  .join("\n")}
`,

    jenkins: (gates) => `# Jenkins Gate Mapping
version: 1
provider: jenkins

gates:
${gates
  .map(
    (gate) => `  ${gate}:
    job: ${gate}
    stage: test`
  )
  .join("\n")}
`,

    other: (gates) => `# Custom CI Gate Mapping
version: 1
provider: custom

gates:
${gates
  .map(
    (gate) => `  ${gate}:
    command: npm run ${gate}
    # Configure your CI to run these commands`
  )
  .join("\n")}
`,
  };

  return mappings[ciProvider](requiredGates);
}

/**
 * Generate enterprise configuration YAML
 */
export function generateEnterpriseConfigYAML(config: EnterpriseConfig): string {
  return YAML.stringify({
    version: 1,
    enterprise: {
      audit: config.audit,
      policy: {
        template: config.policy.template,
        requiredGates: config.policy.requiredGates,
        ...(config.policy.approvalRules && { approvalRules: config.policy.approvalRules }),
      },
      environment: config.environment,
    },
  });
}

/**
 * Generate CI workflow template (GitHub Actions example)
 */
export function generateCIWorkflowTemplate(config: EnterpriseConfig): string {
  if (config.environment.ciProvider !== "github-actions") {
    return `# CI workflow template for ${config.environment.ciProvider}
# Please configure according to your CI provider's documentation
`;
  }

  return `name: Merge Weave

on:
  pull_request:
    types: [opened, synchronize, reopened, labeled]
  workflow_dispatch:
    inputs:
      dry_run:
        description: 'Run in dry-run mode'
        required: false
        default: 'false'

permissions:
  contents: write
  pull-requests: write
  statuses: write

jobs:
  merge-weave:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: \${{ secrets.GITHUB_TOKEN }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Install lexrunner
        run: npm install -g lexrunner

      - name: Discover PRs
        run: npx lex-pr discover --json > discovered-prs.json
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}

      - name: Generate plan
        run: npx lex-pr plan --input discovered-prs.json --output plan.json

      - name: Execute merge weave
        run: npx lex-pr weave --plan plan.json\${{ github.event.inputs.dry_run == 'true' && ' --dry-run' || '' }}
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}

      - name: Upload artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: merge-weave-results
          path: |
            plan.json
            .smartergpt*/runner/
            .smartergpt*/gate-results/
`;
}

/**
 * Create enterprise workspace structure
 */
export function createEnterpriseWorkspace(
  baseDir: string,
  profileDir: string,
  config: EnterpriseConfig,
  options: CreateEnterpriseWorkspaceOptions = {}
): void {
  // Create .lexrunner directory structure
  const lexrunnerDir = path.join(profileDir, ".lexrunner");
  fs.mkdirSync(lexrunnerDir, { recursive: true });

  // Create audit directory if audit is enabled
  if (config.audit.profile !== "off") {
    const auditDir = path.join(lexrunnerDir, "audit");
    fs.mkdirSync(auditDir, { recursive: true });
  }

  // Create personas directory
  const personasDir = path.join(lexrunnerDir, "personas");
  fs.mkdirSync(personasDir, { recursive: true });

  // Write enterprise config
  const configPath = path.join(lexrunnerDir, "config.yaml");
  writeManagedFile(configPath, generateEnterpriseConfigYAML(config), options.force === true);

  // Write gate mapping
  const gateMappingPath = path.join(lexrunnerDir, "gate-mapping.yaml");
  writeManagedFile(
    gateMappingPath,
    generateGateMappingConfig(config.environment.ciProvider, config.policy.requiredGates),
    options.force === true
  );

  // Create .github directory if using GitHub Actions
  if (config.environment.ciProvider === "github-actions") {
    const githubDir = path.join(baseDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });

    // Generate Copilot instructions
    const copilotInstructionsPath = path.join(githubDir, "copilot-instructions.md");
    writeManagedFile(
      copilotInstructionsPath,
      generateCopilotInstructions(config),
      options.force === true
    );

    // Generate workflow template
    const workflowsDir = path.join(githubDir, "workflows");
    fs.mkdirSync(workflowsDir, { recursive: true });

    const workflowPath = path.join(workflowsDir, "merge-weave.yaml");
    writeFileIfAbsent(workflowPath, generateCIWorkflowTemplate(config));
  }
}

function writeManagedFile(targetPath: string, content: string, force: boolean): void {
  if (force) {
    fs.writeFileSync(targetPath, content);
    return;
  }
  writeFileIfAbsent(targetPath, content);
}

function writeFileIfAbsent(targetPath: string, content: string): void {
  try {
    fs.writeFileSync(targetPath, content, { flag: "wx" });
  } catch (error) {
    if (!isFileSystemError(error, "EEXIST")) throw error;
  }
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
