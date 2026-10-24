/**
 * Interactive initialization command for setting up lexrunner workspace
 */

import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import {
  createMinimalWorkspace,
  detectProjectType,
  bootstrapWorkspace,
} from "../core/bootstrap.js";
import {
  WriteProtectionError,
  resolveProfile,
  logProfileMessage,
  validateWriteOperation,
} from "../config/profileResolver.js";
import { createGitHubClient, GitHubAuthError } from "../github/client.js";
import {
  detectEnvironment,
  getAuditProfileConfig,
  getPolicyTemplateConfig,
  createEnterpriseWorkspace,
  generateCopilotInstructions,
  type EnterpriseConfig,
  type AuditProfile,
  type PolicyTemplate,
} from "../core/enterprise.js";

interface InitOptions {
  force?: boolean;
  nonInteractive?: boolean;
  githubToken?: string;
  profileDir?: string;
  jsonMode?: boolean;
  enterprise?: boolean;
  auditProfile?: AuditProfile;
  policyTemplate?: PolicyTemplate;
}

export interface InitResult {
  success: boolean;
  profileDir: string;
  message: string;
}

interface PathIdentity {
  realPath: string;
  link: string;
  target: string;
}

interface ExistingProfileState {
  profileIdentity: PathIdentity;
  manifestIdentity: PathIdentity;
  manifestContent: string;
}

interface AbsentProfileState {
  ancestorPath: string;
  ancestorIdentity: PathIdentity;
}

type ProfileWriteGuard =
  | { kind: "absent"; profileDir: string; state: AbsentProfileState }
  | { kind: "existing"; profileDir: string; state: ExistingProfileState };

/**
 * Run interactive initialization wizard
 */
export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  const baseDir = process.cwd();

  // Determine profile directory first (before calling bootstrapWorkspace)
  let profileDir: string;
  if (options.profileDir) {
    profileDir = path.isAbsolute(options.profileDir)
      ? options.profileDir
      : path.resolve(baseDir, options.profileDir);
  } else {
    // Default to .smartergpt.local (either as override or new setup)
    profileDir = path.join(baseDir, ".smartergpt.local");

    // Only log in non-JSON mode
    if (!options.jsonMode) {
      // Check if .smartergpt exists (tracked example)
      const trackedExample = path.join(baseDir, ".smartergpt");
      if (fs.existsSync(trackedExample)) {
        logProfileMessage(
          "Found tracked example profile, using .smartergpt.local for your workspace"
        );
      }
    }
  }

  // Existing profiles must pass central write validation before any initializer
  // creates runner/, rewrites configuration, or emits enterprise files outside
  // the profile. The captured state is a point-in-time write guard, not custody
  // or a portable lock. Missing or malformed manifests fail closed; --force
  // changes continuation intent but never bypasses write validation.
  const writeGuard = captureProfileWriteGuard(baseDir, profileDir);

  // Check if configuration already exists (only if directory and manifest exist)
  if (fs.existsSync(profileDir) && fs.existsSync(path.join(profileDir, "profile.yml"))) {
    try {
      const bootstrap = bootstrapWorkspace(baseDir, options.profileDir);
      if (bootstrap.hasConfiguration && !options.force) {
        return {
          success: false,
          profileDir: bootstrap.profileDir,
          message: `Configuration already exists at ${bootstrap.profileDir}. Use --force to continue initialization for this writable profile.`,
        };
      }
    } catch (error) {
      // If bootstrap fails, we'll create from scratch (might be missing files)
      if (!options.force && !options.jsonMode) {
        logProfileMessage(
          `Profile directory exists but is incomplete. Use --force to complete it.`
        );
      }
    }
  }

  // Detect project type
  const projectType = detectProjectType(baseDir);
  if (!options.jsonMode) {
    console.log(`\n🔍 Detected project type: ${projectType}\n`);
  }

  // Enterprise setup flow
  if (options.enterprise) {
    return await runEnterpriseInit(baseDir, profileDir, options, writeGuard);
  }

  // Interactive setup
  if (!options.nonInteractive && !options.jsonMode) {
    console.log("Welcome to lexrunner setup! 🚀\n");
    console.log("This wizard will help you configure your workspace.\n");

    // GitHub token setup
    const githubToken = options.githubToken || (await promptGitHubToken());

    if (githubToken) {
      try {
        // Validate token by creating a client
        const client = await createGitHubClient({ token: githubToken });
        const repoInfo = await client.validateRepository();
        console.log(`✓ GitHub: Connected to ${repoInfo.owner}/${repoInfo.repo}\n`);

        // Store token suggestion
        console.log("💡 Tip: Store your GitHub token in an environment variable:");
        console.log("   export GITHUB_TOKEN=your_token_here\n");
      } catch (error) {
        if (error instanceof GitHubAuthError) {
          console.log("✗ GitHub authentication failed. Continuing without GitHub integration.\n");
        } else {
          console.log(`ℹ GitHub: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
    }
  }

  assertProfileWriteGuard(baseDir, writeGuard);

  // Create workspace. An initially absent profile is claimed with a
  // non-recursive mkdir so a concurrent initializer cannot silently win the
  // leaf between the final guard check and creation.
  claimAbsentProfileDirectory(writeGuard);

  // Create the profile manifest before any other content in a newly claimed
  // profile. Existing profiles were required to have a validated manifest by
  // captureProfileWriteGuard().
  const manifestPath = path.join(profileDir, "profile.yml");
  if (writeGuard.kind === "absent") {
    const manifestContent = `role: local
name: Local Development Profile
description: Auto-generated workspace for local development
`;
    writeNewGuardedFile(manifestPath, manifestContent, profileDir);
  }

  // Ensure runner/ subdirectory exists for working artifacts
  const runnerDir = path.join(profileDir, "runner");
  fs.mkdirSync(runnerDir, { recursive: true });

  // Create minimal workspace (config at root per v1 spec)
  createMinimalWorkspace(baseDir, profileDir);

  // Create pull-request-template.md at profile root
  const templatePath = path.join(profileDir, "pull-request-template.md");
  if (!fs.existsSync(templatePath)) {
    const templateContent = getPRTemplateContent();
    writeFileIfAbsent(templatePath, templateContent);
  }

  // Only show console output if not in JSON mode
  if (!options.jsonMode) {
    console.log(`\n✅ Workspace initialized successfully!\n`);
    console.log(`📂 Profile directory: ${profileDir}`);
    console.log(`\n📝 Created files:`);
    console.log(`   - intent.md (project goals and scope)`);
    console.log(`   - scope.yml (PR discovery rules)`);
    console.log(`   - deps.yml (dependency relationships)`);
    console.log(`   - gates.yml (quality gates configuration)`);
    console.log(`   - pull-request-template.md (PR template with dependency syntax)`);
    console.log(`   - runner/ (working artifacts directory)`);

    console.log(`\n📚 Next steps:`);
    console.log(`   1. Edit ${profileDir}/intent.md to describe your project`);
    console.log(`   2. Configure ${profileDir}/scope.yml for PR discovery`);
    console.log(`   3. Set up quality gates in ${profileDir}/gates.yml`);
    console.log(`   4. Run 'lex-pr doctor' to verify your setup`);
    console.log(`   5. Run 'lex-pr discover' to find open PRs\n`);
  }

  return {
    success: true,
    profileDir,
    message: "Workspace initialized successfully",
  };
}

function captureProfileWriteGuard(baseDir: string, profileDir: string): ProfileWriteGuard {
  if (!pathEntryExists(profileDir)) {
    return { kind: "absent", profileDir, state: captureAbsentProfileState(profileDir) };
  }

  let initialState: ExistingProfileState;
  try {
    initialState = captureExistingProfileState(profileDir);
  } catch (captureError) {
    try {
      const resolved = resolveProfile(profileDir, baseDir, { ignoreEnvironment: true });
      validateWriteOperation(profileDir, resolved.manifest.role, "initialize workspace");
    } catch (validationError) {
      if (validationError instanceof WriteProtectionError) throw validationError;
      throw validationError;
    }
    throw writeGuardChangedError(profileDir, captureError);
  }

  try {
    const resolved = resolveProfile(profileDir, baseDir, { ignoreEnvironment: true });
    validateWriteOperation(profileDir, resolved.manifest.role, "initialize workspace");
  } catch (error) {
    if (error instanceof WriteProtectionError) throw error;
    throw error;
  }

  let validatedState: ExistingProfileState;
  try {
    validatedState = captureExistingProfileState(profileDir);
  } catch (error) {
    throw writeGuardChangedError(profileDir, error);
  }
  if (!sameProfileState(initialState, validatedState)) {
    throw writeGuardChangedError(profileDir);
  }

  return { kind: "existing", profileDir, state: validatedState };
}

function assertProfileWriteGuard(baseDir: string, writeGuard: ProfileWriteGuard): void {
  if (writeGuard.kind === "absent") {
    let currentState: AbsentProfileState;
    try {
      currentState = captureAbsentProfileState(writeGuard.profileDir);
    } catch (error) {
      if (error instanceof WriteProtectionError) throw error;
      throw writeGuardChangedError(writeGuard.profileDir, error);
    }
    if (!sameAbsentProfileState(writeGuard.state, currentState)) {
      throw writeGuardChangedError(writeGuard.profileDir);
    }
    return;
  }

  let beforeValidation: ExistingProfileState;
  try {
    beforeValidation = captureExistingProfileState(writeGuard.profileDir);
  } catch (error) {
    throw writeGuardChangedError(writeGuard.profileDir, error);
  }
  if (!sameProfileState(writeGuard.state, beforeValidation)) {
    throw writeGuardChangedError(writeGuard.profileDir);
  }

  try {
    const resolved = resolveProfile(writeGuard.profileDir, baseDir, { ignoreEnvironment: true });
    validateWriteOperation(writeGuard.profileDir, resolved.manifest.role, "initialize workspace");
  } catch (error) {
    if (error instanceof WriteProtectionError) throw error;
    throw writeGuardChangedError(writeGuard.profileDir, error);
  }

  let afterValidation: ExistingProfileState;
  try {
    afterValidation = captureExistingProfileState(writeGuard.profileDir);
  } catch (error) {
    throw writeGuardChangedError(writeGuard.profileDir, error);
  }
  if (!sameProfileState(writeGuard.state, afterValidation)) {
    throw writeGuardChangedError(writeGuard.profileDir);
  }
}

function claimAbsentProfileDirectory(writeGuard: ProfileWriteGuard): void {
  if (writeGuard.kind === "existing") return;

  const parentDir = path.dirname(writeGuard.profileDir);
  fs.mkdirSync(parentDir, { recursive: true });

  // Creating missing intermediate parents must not obscure a change to the
  // existing ancestor observed by the point-in-time guard.
  let currentAncestor: PathIdentity;
  try {
    currentAncestor = capturePathIdentity(writeGuard.state.ancestorPath);
  } catch (error) {
    throw writeGuardChangedError(writeGuard.profileDir, error);
  }
  if (!samePathIdentity(writeGuard.state.ancestorIdentity, currentAncestor)) {
    throw writeGuardChangedError(writeGuard.profileDir);
  }

  try {
    fs.mkdirSync(writeGuard.profileDir);
  } catch (error) {
    if (isFileSystemError(error, "EEXIST")) {
      throw writeGuardChangedError(writeGuard.profileDir, error);
    }
    throw error;
  }
}

function writeNewGuardedFile(targetPath: string, content: string, profileDir: string): void {
  try {
    fs.writeFileSync(targetPath, content, { flag: "wx" });
  } catch (error) {
    if (isFileSystemError(error, "EEXIST")) {
      throw writeGuardChangedError(profileDir, error);
    }
    throw error;
  }
}

function writeFileIfAbsent(targetPath: string, content: string): void {
  try {
    fs.writeFileSync(targetPath, content, { flag: "wx" });
  } catch (error) {
    if (!isFileSystemError(error, "EEXIST")) throw error;
  }
}

function captureExistingProfileState(profileDir: string): ExistingProfileState {
  const manifestPath = path.join(profileDir, "profile.yml");
  const profileIdentityBefore = capturePathIdentity(profileDir);
  const manifestIdentityBefore = capturePathIdentity(manifestPath);
  const manifestContent = fs.readFileSync(manifestPath).toString("base64");
  const manifestIdentityAfter = capturePathIdentity(manifestPath);
  const profileIdentityAfter = capturePathIdentity(profileDir);

  if (
    !samePathIdentity(profileIdentityBefore, profileIdentityAfter) ||
    !samePathIdentity(manifestIdentityBefore, manifestIdentityAfter)
  ) {
    throw writeGuardChangedError(profileDir);
  }

  return {
    profileIdentity: profileIdentityAfter,
    manifestIdentity: manifestIdentityAfter,
    manifestContent,
  };
}

function captureAbsentProfileState(profileDir: string): AbsentProfileState {
  try {
    if (pathEntryExists(profileDir)) {
      throw writeGuardChangedError(profileDir);
    }

    const ancestorPath = findNearestExistingAncestor(profileDir);
    const ancestorIdentityBefore = capturePathIdentity(ancestorPath);

    if (pathEntryExists(profileDir)) {
      throw writeGuardChangedError(profileDir);
    }
    const confirmedAncestorPath = findNearestExistingAncestor(profileDir);
    const ancestorIdentityAfter = capturePathIdentity(confirmedAncestorPath);

    if (
      confirmedAncestorPath !== ancestorPath ||
      !samePathIdentity(ancestorIdentityBefore, ancestorIdentityAfter)
    ) {
      throw writeGuardChangedError(profileDir);
    }

    return { ancestorPath, ancestorIdentity: ancestorIdentityAfter };
  } catch (error) {
    if (error instanceof WriteProtectionError) throw error;
    throw writeGuardChangedError(profileDir, error);
  }
}

function findNearestExistingAncestor(profileDir: string): string {
  let candidate = path.dirname(profileDir);

  while (!pathEntryExists(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      throw writeGuardChangedError(profileDir);
    }
    candidate = parent;
  }

  return candidate;
}

function capturePathIdentity(targetPath: string): PathIdentity {
  const link = fs.lstatSync(targetPath, { bigint: true });
  const target = fs.statSync(targetPath, { bigint: true });
  return {
    realPath: fs.realpathSync.native(targetPath),
    link: statIdentity(link),
    target: statIdentity(target),
  };
}

function statIdentity(stat: fs.BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.birthtimeNs].join(":");
}

function sameProfileState(left: ExistingProfileState, right: ExistingProfileState): boolean {
  return (
    samePathIdentity(left.profileIdentity, right.profileIdentity) &&
    samePathIdentity(left.manifestIdentity, right.manifestIdentity) &&
    left.manifestContent === right.manifestContent
  );
}

function sameAbsentProfileState(left: AbsentProfileState, right: AbsentProfileState): boolean {
  return (
    left.ancestorPath === right.ancestorPath &&
    samePathIdentity(left.ancestorIdentity, right.ancestorIdentity)
  );
}

function samePathIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return (
    left.realPath === right.realPath && left.link === right.link && left.target === right.target
  );
}

function pathEntryExists(targetPath: string): boolean {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return false;
    throw writeGuardChangedError(targetPath, error);
  }
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function writeGuardChangedError(profileDir: string, cause?: unknown): WriteProtectionError {
  void cause;
  return new WriteProtectionError(
    `Cannot initialize workspace: the point-in-time profile write guard at "${profileDir}" changed. ` +
      "Restart initialization and review the current profile before retrying; this guard is not a portable lock."
  );
}

/**
 * Prompt for GitHub token
 */
async function promptGitHubToken(): Promise<string> {
  // Check environment first
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken) {
    console.log("✓ GitHub token found in environment variables\n");
    return envToken;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question("GitHub token (optional, press Enter to skip): ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Get PR template content with dependency syntax examples
 */
function getPRTemplateContent(): string {
  return `# Pull Request Template

## Description
<!-- Describe your changes -->

## Dependencies
<!-- Use this section to declare dependencies on other PRs -->
<!-- Syntax examples: -->

<!-- Single dependency -->
<!-- Depends-On: #123 -->

<!-- Multiple dependencies -->
<!-- Depends-On: #123, #456 -->

<!-- Block syntax -->
<!-- Depends-On: -->
<!-- - #123 -->
<!-- - #456 -->

## Checklist
- [ ] Tests added/updated
- [ ] Documentation updated
- [ ] All quality gates pass

## Notes
<!-- Any additional context or notes -->
`;
}

/**
 * Run enterprise initialization workflow
 */
async function runEnterpriseInit(
  baseDir: string,
  profileDir: string,
  options: InitOptions,
  writeGuard: ProfileWriteGuard
): Promise<InitResult> {
  if (!options.jsonMode) {
    console.log("\n🏢 Enterprise Setup Wizard\n");
  }

  // Detect environment
  const envDetection = detectEnvironment(baseDir);

  if (!options.jsonMode) {
    console.log("📊 Environment Detection:");
    console.log(`   Project structure: ${envDetection.projectStructure}`);
    console.log(`   CI provider: ${envDetection.ciProvider}`);
    console.log(`   Detected CI: ${envDetection.detectedCI.join(", ") || "none"}\n`);
  }

  // Determine audit profile
  const auditProfile: AuditProfile = options.auditProfile || "soc2";

  // Determine policy template
  const policyTemplate: PolicyTemplate = options.policyTemplate || "enterprise-standard";

  const enterpriseConfig: EnterpriseConfig = {
    audit: getAuditProfileConfig(auditProfile),
    policy: getPolicyTemplateConfig(policyTemplate),
    environment: {
      projectStructure: envDetection.projectStructure,
      ciProvider: envDetection.ciProvider,
    },
  };

  if (!options.jsonMode) {
    console.log("⚙️  Configuration:");
    console.log(`   Audit profile: ${auditProfile}`);
    console.log(`   Policy template: ${policyTemplate}`);
    console.log(`   Required gates: ${enterpriseConfig.policy.requiredGates.join(", ")}`);
    if (enterpriseConfig.policy.approvalRules) {
      console.log(
        `   Min approvers: ${enterpriseConfig.policy.approvalRules.minApprovers || "N/A"}`
      );
      console.log(
        `   Require code owner: ${enterpriseConfig.policy.approvalRules.requireCodeOwner ? "Yes" : "No"}`
      );
    }
    console.log("");
  }

  assertProfileWriteGuard(baseDir, writeGuard);

  // Create workspace structure with the same exclusive absent-leaf admission
  // used by standard initialization.
  claimAbsentProfileDirectory(writeGuard);

  // Create the profile manifest before any other content in a newly claimed
  // profile. Existing profiles already passed manifest validation.
  const manifestPath = path.join(profileDir, "profile.yml");
  if (writeGuard.kind === "absent") {
    const manifestContent = `role: local
name: Enterprise Development Profile
description: Auto-generated enterprise workspace with audit and compliance
`;
    writeNewGuardedFile(manifestPath, manifestContent, profileDir);
  }

  // Ensure runner/ subdirectory exists for working artifacts
  const runnerDir = path.join(profileDir, "runner");
  fs.mkdirSync(runnerDir, { recursive: true });

  // Install enterprise gates before the standard bootstrap fills missing files.
  // Without --force, exclusive creation preserves any admitted authored file;
  // with --force, this enterprise-managed file is deliberately replaced.
  const gatesPath = path.join(profileDir, "gates.yml");
  const gatesContent = `version: 1
levels:
  default:
${enterpriseConfig.policy.requiredGates
  .map(
    (gate) => `    - name: ${gate}
      run: "npm run ${gate}"`
  )
  .join("\n")}
`;
  if (options.force) {
    fs.writeFileSync(gatesPath, gatesContent);
  } else {
    writeFileIfAbsent(gatesPath, gatesContent);
  }

  // Create basic workspace first
  createMinimalWorkspace(baseDir, profileDir);

  // Create enterprise workspace additions
  createEnterpriseWorkspace(baseDir, profileDir, enterpriseConfig, {
    force: options.force === true,
  });

  // Create pull-request-template.md at profile root
  const templatePath = path.join(profileDir, "pull-request-template.md");
  if (!fs.existsSync(templatePath)) {
    const templateContent = getPRTemplateContent();
    writeFileIfAbsent(templatePath, templateContent);
  }

  // Only show console output if not in JSON mode
  if (!options.jsonMode) {
    const managedFileDisposition = options.force ? "created or replaced" : "created or preserved";
    console.log(`\n✅ Enterprise workspace initialized successfully!\n`);
    console.log(`📂 Profile directory: ${profileDir}`);
    console.log(`\n📝 Workspace structure after initialization:`);
    console.log(`   ${profileDir}/`);
    console.log(`   ├── .lexrunner/`);
    console.log(`   │   ├── config.yaml (enterprise configuration; ${managedFileDisposition})`);
    console.log(`   │   ├── gate-mapping.yaml (CI integration; ${managedFileDisposition})`);
    console.log(`   │   ├── personas/ (team personas)`);
    if (enterpriseConfig.audit.profile !== "off") {
      console.log(`   │   └── audit/ (audit logs)`);
    }
    console.log(`   ├── intent.md (project goals)`);
    console.log(`   ├── scope.yml (PR discovery rules)`);
    console.log(`   ├── deps.yml (dependency relationships)`);
    console.log(`   ├── gates.yml (quality gates; ${managedFileDisposition})`);
    console.log(`   └── runner/ (working artifacts)`);

    if (enterpriseConfig.environment.ciProvider === "github-actions") {
      console.log(`\n   .github/`);
      console.log(
        `   ├── copilot-instructions.md (GitHub Copilot setup; ${managedFileDisposition})`
      );
      console.log(`   └── workflows/`);
      console.log(`       └── merge-weave.yaml (CI workflow template; created or preserved)`);
    }

    console.log(`\n📚 Next steps:`);
    console.log(`   1. Review enterprise configuration in ${profileDir}/.lexrunner/config.yaml`);
    console.log(`   2. Configure gate mapping in ${profileDir}/.lexrunner/gate-mapping.yaml`);
    if (enterpriseConfig.environment.ciProvider === "github-actions") {
      console.log(`   3. Review GitHub Copilot instructions in .github/copilot-instructions.md`);
      console.log(`   4. Customize CI workflow in .github/workflows/merge-weave.yaml`);
    }
    console.log(`   5. Run 'lex-pr doctor' to verify your setup`);
    console.log(`   6. Run 'lex-pr discover' to find open PRs\n`);

    console.log(`💡 Tip: You can customize personas in ${profileDir}/.lexrunner/personas/\n`);
  }

  return {
    success: true,
    profileDir,
    message: "Enterprise workspace initialized successfully",
  };
}
