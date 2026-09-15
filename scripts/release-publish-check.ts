import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolveNpmCliPath, validatePackedBoundary } from "./validate-package-boundary.js";

export interface ReleaseManifest {
  name?: string;
  publishConfig?: { access?: string; registry?: string };
  version?: string;
}

const EXPECTED_PACKAGE = "@smartergpt/lexrunner";
const EXPECTED_REGISTRY = "https://registry.npmjs.org/";

export function releaseTagForVersion(version: string): string {
  return `v${version}`;
}

export function trustedPublishCommand(distTag = "latest"): string {
  if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(distTag)) {
    throw new Error(`Invalid npm dist-tag: ${distTag}`);
  }
  return `npm publish --access public --tag ${distTag}`;
}

export function validateReleaseManifest(
  manifest: ReleaseManifest
): asserts manifest is Required<Pick<ReleaseManifest, "name" | "version">> & ReleaseManifest {
  if (manifest.name !== EXPECTED_PACKAGE) {
    throw new Error(
      `Expected package ${EXPECTED_PACKAGE}, received ${manifest.name ?? "<missing>"}`
    );
  }
  if (!manifest.version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error(`Invalid package version: ${manifest.version ?? "<missing>"}`);
  }
  if (manifest.publishConfig?.access !== "public") {
    throw new Error("package.json publishConfig.access must be public");
  }
  if (manifest.publishConfig.registry !== EXPECTED_REGISTRY) {
    throw new Error(`package.json publishConfig.registry must be ${EXPECTED_REGISTRY}`);
  }
}

function verifyTaggedHead(projectRoot: string, version: string): void {
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (status.trim()) throw new Error("Publish gate requires a clean worktree");

  const expectedTag = releaseTagForVersion(version);
  const tags = execFileSync("git", ["tag", "--points-at", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
  if (!tags.includes(expectedTag)) {
    throw new Error(`Publish gate requires ${expectedTag} to point at HEAD`);
  }
}

export function runNpmPublishDryRun(projectRoot: string, distTag: string): void {
  const result = spawnSync(
    process.execPath,
    [resolveNpmCliPath(), "publish", "--dry-run", "--access", "public", "--tag", distTag, "--json"],
    { cwd: projectRoot, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }
  );
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`npm publish --dry-run failed with exit code ${result.status ?? "unknown"}`);
  }
  if (/npm warn publish/i.test(result.stderr ?? "")) {
    throw new Error("npm publish --dry-run reported package normalization warnings");
  }

  const report = JSON.parse(result.stdout) as Record<
    string,
    { filename?: string; id?: string; integrity?: string; files?: unknown[] }
  >;
  const packageReport = Object.values(report)[0];
  if (!packageReport) throw new Error("npm publish --dry-run returned no package report");
  process.stdout.write(
    `${JSON.stringify({
      status: "dry_run_passed",
      id: packageReport.id,
      filename: packageReport.filename,
      fileCount: packageReport.files?.length,
      integrity: packageReport.integrity,
      distTag,
    })}\n`
  );
}

function main(): void {
  const projectRoot = process.cwd();
  const allowUntagged = process.argv.includes("--allow-untagged");
  const tagIndex = process.argv.indexOf("--tag");
  const distTag = tagIndex >= 0 ? process.argv[tagIndex + 1] : "latest";
  if (!distTag) throw new Error("--tag requires a value");

  const manifest = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")
  ) as ReleaseManifest;
  validateReleaseManifest(manifest);
  validatePackedBoundary(projectRoot);
  if (!allowUntagged) verifyTaggedHead(projectRoot, manifest.version);
  runNpmPublishDryRun(projectRoot, distTag);

  if (allowUntagged) {
    process.stdout.write(
      "\nCandidate package passed npm publication checks. No publish command is authorized before the signed release tag.\n"
    );
    return;
  }

  process.stdout.write(
    `\nTAGGED CANDIDATE VALIDATED\nThe verified stable-tag workflow may now run this exact command through npm trusted publishing:\n${trustedPublishCommand(distTag)}\nDo not run non-dry-run publication from an agent or local shell.\n`
  );
}

const scriptPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (scriptPath === import.meta.url) main();
