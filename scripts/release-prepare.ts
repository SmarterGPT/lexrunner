#!/usr/bin/env tsx
/**
 * Release preparation script
 *
 * Responsibilities:
 * - Parse conventional commits since last tag
 * - Compute next semantic version (major.minor.patch)
 * - Update CHANGELOG.md with new version section
 * - Update package.json version (executes npm version command)
 * - Output instructions for signed tag creation
 *
 * Does NOT:
 * - Create tags (manual step for security)
 * - Push to remote (manual step)
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

interface CommitInfo {
  hash: string;
  type: string;
  scope?: string;
  subject: string;
  body?: string;
  breaking: boolean;
  raw: string;
}

interface VersionBump {
  current: string;
  next: string;
  type: "major" | "minor" | "patch";
}

interface ChangelogSection {
  breaking: string[];
  features: string[];
  fixes: string[];
  docs: string[];
  chore: string[];
  other: string[];
}

/**
 * Get the last git tag or return null if no tags exist
 */
function getLastTag(): string | null {
  try {
    return execSync("git describe --tags --abbrev=0", { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

/**
 * Get current version from package.json
 */
function getCurrentVersion(): string {
  const pkgPath = path.join(process.cwd(), "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  return pkg.version;
}

/**
 * Get commits since last tag (or all commits if no tag)
 */
function getCommitsSinceLastTag(lastTag: string | null): string[] {
  const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
  try {
    const output = execSync(`git log ${range} --format=%H`, { encoding: "utf-8" });
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Parse a single commit following conventional commits format
 */
function parseCommit(hash: string): CommitInfo | null {
  const message = execSync(`git log -1 --format=%B ${hash}`, { encoding: "utf-8" }).trim();

  // Match conventional commit format: type(scope)!: subject
  const match = message.match(/^(\w+)(?:\(([^)]+)\))?(!)?: (.+)/);

  if (!match) {
    return {
      hash,
      type: "other",
      subject: message.split("\n")[0],
      body: message.split("\n").slice(1).join("\n").trim(),
      breaking: message.toLowerCase().includes("breaking change"),
      raw: message,
    };
  }

  const [, type, scope, breakingMarker, subject] = match;
  const body = message.split("\n").slice(1).join("\n").trim();
  const breaking = !!breakingMarker || body.toLowerCase().includes("breaking change");

  return {
    hash,
    type: type.toLowerCase(),
    scope,
    subject,
    body,
    breaking,
    raw: message,
  };
}

/**
 * Determine version bump type based on commits
 */
function determineVersionBump(commits: CommitInfo[]): VersionBump["type"] {
  // Check for breaking changes
  if (commits.some((c) => c.breaking)) {
    return "major";
  }

  // Check for features
  if (commits.some((c) => c.type === "feat")) {
    return "minor";
  }

  // Default to patch
  return "patch";
}

/**
 * Calculate next version based on bump type
 */
function calculateNextVersion(current: string, bumpType: VersionBump["type"]): string {
  const parts = current.split(".").map((n) => parseInt(n, 10));

  switch (bumpType) {
    case "major":
      return `${parts[0] + 1}.0.0`;
    case "minor":
      return `${parts[0]}.${parts[1] + 1}.0`;
    case "patch":
      return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  }
}

/**
 * Group commits by type for changelog
 */
function groupCommitsForChangelog(commits: CommitInfo[]): ChangelogSection {
  const sections: ChangelogSection = {
    breaking: [],
    features: [],
    fixes: [],
    docs: [],
    chore: [],
    other: [],
  };

  for (const commit of commits) {
    const line = commit.scope
      ? `- **${commit.scope}**: ${commit.subject} (${commit.hash.substring(0, 7)})`
      : `- ${commit.subject} (${commit.hash.substring(0, 7)})`;

    if (commit.breaking) {
      const breakingLine = `- **BREAKING**: ${commit.subject} (${commit.hash.substring(0, 7)})`;
      sections.breaking.push(breakingLine);
    } else if (commit.type === "feat") {
      sections.features.push(line);
    } else if (commit.type === "fix") {
      sections.fixes.push(line);
    } else if (commit.type === "docs") {
      sections.docs.push(line);
    } else if (commit.type === "chore" || commit.type === "ci" || commit.type === "build") {
      sections.chore.push(line);
    } else {
      sections.other.push(line);
    }
  }

  return sections;
}

/**
 * Generate changelog entry for new version
 */
function generateChangelogEntry(version: string, sections: ChangelogSection): string {
  const date = new Date().toISOString().split("T")[0];
  const lines: string[] = [];

  lines.push(`## [${version}] - ${date}`);
  lines.push("");

  if (sections.breaking.length > 0) {
    lines.push("### ⚠ BREAKING CHANGES");
    lines.push("");
    lines.push(...sections.breaking);
    lines.push("");
  }

  if (sections.features.length > 0) {
    lines.push("### Added");
    lines.push("");
    lines.push(...sections.features);
    lines.push("");
  }

  if (sections.fixes.length > 0) {
    lines.push("### Fixed");
    lines.push("");
    lines.push(...sections.fixes);
    lines.push("");
  }

  if (sections.docs.length > 0) {
    lines.push("### Documentation");
    lines.push("");
    lines.push(...sections.docs);
    lines.push("");
  }

  if (sections.chore.length > 0) {
    lines.push("### Internal");
    lines.push("");
    lines.push(...sections.chore);
    lines.push("");
  }

  if (sections.other.length > 0) {
    lines.push("### Other");
    lines.push("");
    lines.push(...sections.other);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Update CHANGELOG.md with new version entry
 */
function updateChangelog(newEntry: string): void {
  const changelogPath = path.join(process.cwd(), "CHANGELOG.md");
  const changelog = fs.readFileSync(changelogPath, "utf-8");

  // Find the [Unreleased] section and insert after it
  const unreleasedMatch = changelog.match(/## \[Unreleased\][^\n]*\n/);

  if (!unreleasedMatch) {
    throw new Error("Could not find [Unreleased] section in CHANGELOG.md");
  }

  const insertIndex = unreleasedMatch.index! + unreleasedMatch[0].length;

  // Insert new entry after [Unreleased] section
  const updatedChangelog =
    changelog.slice(0, insertIndex) + "\n" + newEntry + "\n" + changelog.slice(insertIndex);

  fs.writeFileSync(changelogPath, updatedChangelog, "utf-8");
}

/**
 * Main function
 */
function main(): void {
  console.log("🔍 Analyzing commits for release preparation...\n");

  // Get last tag and current version
  const lastTag = getLastTag();
  const currentVersion = getCurrentVersion();

  console.log(`📌 Last tag: ${lastTag || "(none)"}`);
  console.log(`📦 Current version: ${currentVersion}\n`);

  // Get commits since last tag
  const commitHashes = getCommitsSinceLastTag(lastTag);

  if (commitHashes.length === 0) {
    console.log("✅ No commits since last release. Nothing to do.");
    process.exit(0);
  }

  console.log(`📝 Found ${commitHashes.length} commit(s) since last release:\n`);

  // Parse commits
  const commits = commitHashes.map(parseCommit).filter((c): c is CommitInfo => c !== null);

  // Display parsed commits
  for (const commit of commits) {
    const prefix = commit.breaking
      ? "⚠️  BREAKING"
      : commit.type === "feat"
        ? "✨"
        : commit.type === "fix"
          ? "🐛"
          : "📝";
    console.log(
      `  ${prefix} ${commit.type}${commit.scope ? `(${commit.scope})` : ""}: ${commit.subject}`
    );
  }
  console.log("");

  // Determine version bump
  const bumpType = determineVersionBump(commits);
  const nextVersion = calculateNextVersion(currentVersion, bumpType);

  console.log(`🎯 Version bump type: ${bumpType.toUpperCase()}`);
  console.log(`📈 Next version: ${currentVersion} → ${nextVersion}\n`);

  // Group commits for changelog
  const sections = groupCommitsForChangelog(commits);
  const changelogEntry = generateChangelogEntry(nextVersion, sections);

  console.log("📄 Changelog entry:\n");
  console.log("─".repeat(60));
  console.log(changelogEntry);
  console.log("─".repeat(60));
  console.log("");

  // Update CHANGELOG.md
  updateChangelog(changelogEntry);
  console.log("✅ Updated CHANGELOG.md\n");

  // Update package.json version
  execSync(`npm version ${nextVersion} --no-git-tag-version`, { stdio: "inherit" });
  console.log(`✅ Updated package.json to version ${nextVersion}\n`);

  // Output next steps
  console.log("📋 Next steps:\n");
  console.log("1. Review the changes:");
  console.log("   git diff CHANGELOG.md package.json\n");
  console.log("2. Commit the changes:");
  console.log(`   git add CHANGELOG.md package.json`);
  console.log(`   git commit -m "chore(release): prepare ${nextVersion}"\n`);
  console.log("3. Create a signed tag:");
  console.log(`   git tag -s v${nextVersion} -m "Release ${nextVersion}"\n`);
  console.log("4. Push the changes and tag:");
  console.log(`   git push origin main`);
  console.log(`   git push origin v${nextVersion}\n`);
  console.log("5. Create a GitHub release from the tag\n");
}

// Run main function
try {
  main();
} catch (error) {
  console.error("❌ Error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}
