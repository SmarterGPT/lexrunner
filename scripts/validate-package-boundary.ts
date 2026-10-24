import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { collectPackageArtifactTargets } from "./validate-build-artifacts.js";

export interface PackageManifest {
  bin?: string | Record<string, string>;
  exports?: unknown;
  files?: string[];
  name?: string;
  repository?: { type?: string; url?: string } | string;
  types?: string;
}

interface PackFile {
  path: string;
  size: number;
}

interface PackResult {
  filename: string;
  files: PackFile[];
  size: number;
  unpackedSize: number;
}

export const PACKAGE_FILES_ALLOWLIST = [
  "dist/",
  "schemas/",
  "mcp-server.mjs",
  "README.md",
  "README.mcp.md",
  "CHANGELOG.md",
  "NOTICE.md",
  "LICENSE.md",
  "GOVERNANCE.md",
  "BRAND.md",
] as const;

const ALLOWED_EXACT_PATHS = new Set([
  "BRAND.md",
  "CHANGELOG.md",
  "GOVERNANCE.md",
  "LICENSE.md",
  "NOTICE.md",
  "README.md",
  "README.mcp.md",
  "mcp-server.mjs",
  "package.json",
]);
const ALLOWED_PREFIXES = ["dist/", "schemas/"];
const FORBIDDEN_RUNTIME_PATHS = [
  /(^|\/)(?:tests?|__tests__|research|deliverables|\.github)(\/|$)/,
  /\.(?:db|sqlite|sqlite3|log)$/,
];
const REQUIRED_RUNTIME_ASSETS = [
  "mcp-server.mjs",
  "schemas/gates/build.schema.json",
  "schemas/gates/coverage.schema.json",
  "schemas/gates/lint.schema.json",
  "schemas/gates/security-scan.schema.json",
  "schemas/gates/test.schema.json",
];
const MAX_FILE_COUNT = 120;
// The 2.5 line adds reviewed runtime contracts while keeping a fixed, low-growth package budget.
const MAX_UNPACKED_SIZE = 7_125_000;

const CANONICAL_REPOSITORY_URL = "git+https://github.com/SmarterGPT/lexrunner.git";

export function resolveNpmCliPath(
  env: NodeJS.ProcessEnv = process.env,
  nodeExecutable = process.execPath
): string {
  const configured = env.npm_execpath?.trim();
  if (configured) {
    if (path.win32.isAbsolute(configured) || path.posix.isAbsolute(configured)) return configured;
    return path.resolve(configured);
  }

  const pathApi = path.posix.isAbsolute(nodeExecutable)
    ? path.posix
    : path.win32.isAbsolute(nodeExecutable)
      ? path.win32
      : path;
  return pathApi.join(pathApi.dirname(nodeExecutable), "node_modules", "npm", "bin", "npm-cli.js");
}

export function validatePackageManifestForPublish(
  manifest: PackageManifest,
  projectRoot = process.cwd()
): void {
  const bins =
    typeof manifest.bin === "string"
      ? { [manifest.name ?? "package"]: manifest.bin }
      : (manifest.bin ?? {});

  for (const [name, target] of Object.entries(bins)) {
    if (target.startsWith("./")) {
      throw new Error(
        `package.json bin.${name} must omit the leading './' so npm publish does not remove it`
      );
    }
    if (target.includes("\\")) {
      throw new Error(`package.json bin.${name} must use portable forward slashes`);
    }

    const targetPath = path.join(projectRoot, target);
    if (!fs.existsSync(targetPath)) {
      throw new Error(`package.json bin.${name} target does not exist: ${target}`);
    }
    const firstLine = fs.readFileSync(targetPath, "utf8").split(/\r?\n/, 1)[0];
    if (!firstLine?.startsWith("#!")) {
      throw new Error(`package.json bin.${name} target must begin with a shebang: ${target}`);
    }
  }

  const repositoryUrl =
    typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  if (repositoryUrl !== CANONICAL_REPOSITORY_URL) {
    throw new Error(
      `package.json repository.url must use npm's canonical form: ${CANONICAL_REPOSITORY_URL}`
    );
  }
}

export function inspectPackedBoundary(projectRoot = process.cwd()): PackResult {
  const output = execFileSync(
    process.execPath,
    [resolveNpmCliPath(), "pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    }
  );
  const parsed = JSON.parse(output) as PackResult[];
  if (parsed.length !== 1)
    throw new Error(`Expected one npm pack result, received ${parsed.length}`);
  return parsed[0];
}

export function validatePackedBoundary(projectRoot = process.cwd()): PackResult {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")
  ) as PackageManifest;
  if (JSON.stringify(manifest.files) !== JSON.stringify(PACKAGE_FILES_ALLOWLIST)) {
    throw new Error("package.json files allowlist does not match the enforced package boundary");
  }
  validatePackageManifestForPublish(manifest, projectRoot);

  const packed = inspectPackedBoundary(projectRoot);
  const paths = new Set(packed.files.map((file) => file.path));
  const unexpected = [...paths].filter(
    (file) =>
      !ALLOWED_EXACT_PATHS.has(file) && !ALLOWED_PREFIXES.some((prefix) => file.startsWith(prefix))
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Unexpected files in npm package:\n${unexpected.map((file) => `- ${file}`).join("\n")}`
    );
  }
  const forbidden = [...paths].filter(
    (file) =>
      FORBIDDEN_RUNTIME_PATHS.some((pattern) => pattern.test(file)) ||
      (file.startsWith("schemas/") && !file.endsWith(".json"))
  );
  if (forbidden.length > 0) {
    throw new Error(`Forbidden runtime files in npm package:\n${forbidden.join("\n")}`);
  }

  const requiredTargets = collectPackageArtifactTargets(manifest).map(({ source, target }) => ({
    source,
    target: target.replace(/^\.\//, ""),
  }));
  const missing = [
    ...requiredTargets,
    ...REQUIRED_RUNTIME_ASSETS.map((target) => ({ source: "runtime", target })),
  ].filter(({ target }) => !paths.has(target));
  if (missing.length > 0) {
    throw new Error(
      `Required package targets are missing:\n${missing
        .map(({ source, target }) => `- ${source}: ${target}`)
        .join("\n")}`
    );
  }

  if (packed.files.length > MAX_FILE_COUNT) {
    throw new Error(`Package has ${packed.files.length} files; maximum is ${MAX_FILE_COUNT}`);
  }
  if (packed.unpackedSize > MAX_UNPACKED_SIZE) {
    throw new Error(
      `Package unpacked size is ${packed.unpackedSize} bytes; maximum is ${MAX_UNPACKED_SIZE}`
    );
  }

  return packed;
}

function main(): void {
  const packed = validatePackedBoundary();
  process.stdout.write(
    `${JSON.stringify({
      filename: packed.filename,
      fileCount: packed.files.length,
      packedSize: packed.size,
      unpackedSize: packed.unpackedSize,
    })}\n`
  );
}

const scriptPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (scriptPath === import.meta.url) main();
