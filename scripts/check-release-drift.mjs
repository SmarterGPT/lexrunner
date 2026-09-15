#!/usr/bin/env node
/**
 * Release Drift Check
 *
 * Detects misalignment between package.json version and Git tags.
 *
 * Usage:
 *   npm run check:release-drift
 *   node scripts/check-release-drift.mjs
 *
 * Exit codes:
 *   0 - No drift (tag exists for current version)
 *   1 - Drift detected (tag missing for current version)
 *   2 - Script error
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

function getPackageVersion() {
  const pkgPath = join(rootDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  return pkg.version;
}

function getGitTags() {
  try {
    const output = execSync('git tag -l "v*" "lexrunner-v*"', {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function main() {
  const version = getPackageVersion();
  const expectedTag = `v${version}`;
  // Immutable pre-migration releases are observations, never new publication authority.
  const historicalVersions = new Set([
    "1.0.0",
    "1.2.1",
    "1.3.0",
    "1.4.0",
    "1.4.1",
    "1.5.0",
    "1.5.1",
    "1.5.2",
    "2.0.0",
    "2.0.1",
    "2.0.2",
    "2.1.0",
    "2.2.0",
    "2.3.0",
    "2.4.0",
  ]);
  const tags = getGitTags();

  console.log(`📦 package.json version: ${version}`);
  console.log(`🏷️  Expected tag: ${expectedTag}`);

  if (historicalVersions.has(version) && tags.includes(`lexrunner-v${version}`)) {
    console.log(`Historical tag lexrunner-v${version} exists; no retagging required.`);
    process.exit(0);
  }

  if (tags.includes(expectedTag)) {
    console.log(`✅ Tag ${expectedTag} exists. No drift detected.`);
    process.exit(0);
  } else {
    console.log(`\n❌ DRIFT DETECTED: Tag ${expectedTag} does not exist.`);
    console.log(`\nExisting tags:`);
    const semverTags = tags.filter((t) => /^(?:lexrunner-)?v\d+\.\d+\.\d+$/.test(t));
    if (semverTags.length > 0) {
      semverTags.slice(-5).forEach((t) => console.log(`  - ${t}`));
      if (semverTags.length > 5) {
        console.log(`  ... and ${semverTags.length - 5} more`);
      }
    } else {
      console.log("  (none matching release version patterns)");
    }

    console.log(`\nTo fix, create the missing tag:`);
    console.log(`  git tag -s "${expectedTag}" -m "Release ${expectedTag}"`);
    console.log(`  git push origin "${expectedTag}"`);

    process.exit(1);
  }
}

try {
  main();
} catch (err) {
  console.error("❌ Script error:", err.message);
  process.exit(2);
}
