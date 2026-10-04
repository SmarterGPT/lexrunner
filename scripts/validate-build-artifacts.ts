import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

interface PackageManifest {
  bin?: string | Record<string, string>;
  exports?: unknown;
  types?: string;
}

export interface PackageArtifactTarget {
  source: string;
  target: string;
}

const REQUIRED_INTERNAL_BUILD_ARTIFACTS: PackageArtifactTarget[] = [
  { source: "Detached gate worker", target: "./dist/gate-worker.js" },
  { source: "Frame emission CI", target: "./dist/hooks/events.js" },
  { source: "Frame emission CI", target: "./dist/hooks/events.d.ts" },
];

function collectExportTargets(
  value: unknown,
  source: string,
  targets: PackageArtifactTarget[]
): void {
  if (typeof value === "string") {
    targets.push({ source, target: value });
    return;
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const nestedSource = key.startsWith(".")
      ? `${source}[${JSON.stringify(key)}]`
      : `${source}.${key}`;
    collectExportTargets(nestedValue, nestedSource, targets);
  }
}

export function collectPackageArtifactTargets(manifest: PackageManifest): PackageArtifactTarget[] {
  const targets: PackageArtifactTarget[] = [];

  if (manifest.types) {
    targets.push({ source: "types", target: manifest.types });
  }

  if (typeof manifest.bin === "string") {
    targets.push({ source: "bin", target: manifest.bin });
  } else if (manifest.bin) {
    for (const [name, target] of Object.entries(manifest.bin)) {
      targets.push({ source: `bin.${name}`, target });
    }
  }

  collectExportTargets(manifest.exports, "exports", targets);

  const uniqueTargets = new Map<string, PackageArtifactTarget>();
  for (const target of [...targets, ...REQUIRED_INTERNAL_BUILD_ARTIFACTS]) {
    uniqueTargets.set(`${target.source}:${target.target}`, target);
  }

  return [...uniqueTargets.values()];
}

export function findMissingBuildArtifacts(
  projectRoot: string,
  manifest: PackageManifest
): PackageArtifactTarget[] {
  return collectPackageArtifactTargets(manifest).filter(({ target }) => {
    if (!target.startsWith("./")) {
      return false;
    }
    return !fs.existsSync(path.resolve(projectRoot, target));
  });
}

export function validateBuildArtifacts(projectRoot = process.cwd()): void {
  const packagePath = path.join(projectRoot, "package.json");
  const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8")) as PackageManifest;
  const missing = findMissingBuildArtifacts(projectRoot, manifest);

  if (missing.length > 0) {
    const details = missing.map(({ source, target }) => `- ${source}: ${target}`).join("\n");
    throw new Error(`Build is missing declared artifacts:\n${details}`);
  }

  console.log(
    `Validated ${collectPackageArtifactTargets(manifest).length} declared build artifacts.`
  );
}

const scriptPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (scriptPath === import.meta.url) {
  validateBuildArtifacts();
}
