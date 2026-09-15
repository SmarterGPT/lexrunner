import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  type PackageManifest,
  resolveNpmCliPath,
  validatePackageManifestForPublish,
} from "../scripts/validate-package-boundary.js";
import {
  releaseTagForVersion,
  trustedPublishCommand,
  validateReleaseManifest,
} from "../scripts/release-publish-check.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

describe("npm publication boundary", () => {
  it("accepts the canonical package manifest", () => {
    const manifest = readManifest();
    expect(() => validatePackageManifestForPublish(manifest, repositoryRoot)).not.toThrow();
    expect(() => validateReleaseManifest(manifest)).not.toThrow();
  });

  it("rejects bin targets that npm publish would normalize away", () => {
    const manifest = readManifest();
    manifest.bin = { lexrunner: "./mcp-server.mjs" };
    expect(() => validatePackageManifestForPublish(manifest, repositoryRoot)).toThrow(
      "must omit the leading './'"
    );
  });

  it("rejects repository metadata that npm publish would normalize", () => {
    const manifest = readManifest();
    manifest.repository = { url: "https://github.com/SmarterGPT/lexrunner.git" };
    expect(() => validatePackageManifestForPublish(manifest, repositoryRoot)).toThrow(
      "must use npm's canonical form"
    );
  });

  it("rejects bin targets without executable shebangs", () => {
    const manifest = readManifest();
    manifest.bin = { lexrunner: "package.json" };
    expect(() => validatePackageManifestForPublish(manifest, repositoryRoot)).toThrow(
      "must begin with a shebang"
    );
  });

  it("prints the stable command reserved for the trusted workflow without executing it", () => {
    expect(trustedPublishCommand()).toBe("npm publish --access public --tag latest");
    expect(trustedPublishCommand("canary")).toBe("npm publish --access public --tag canary");
    expect(() => trustedPublishCommand("not a tag")).toThrow("Invalid npm dist-tag");
  });

  it("uses the repository-scoped release tag prefix", () => {
    expect(releaseTagForVersion("1.2.1")).toBe("v1.2.1");
  });

  it("rejects a return to restricted package access", () => {
    const manifest = readManifest();
    manifest.publishConfig = { ...manifest.publishConfig, access: "restricted" };
    expect(() => validateReleaseManifest(manifest)).toThrow("publishConfig.access must be public");
  });

  it("preserves a configured absolute Windows npm CLI path on every host", () => {
    expect(
      resolveNpmCliPath({ npm_execpath: "C:\\toolchain\\npm-cli.js" }, "C:\\node\\node.exe")
    ).toBe("C:\\toolchain\\npm-cli.js");
  });

  it("derives the npm CLI beside a Windows Node executable on every host", () => {
    expect(resolveNpmCliPath({}, "C:\\node\\node.exe")).toBe(
      "C:\\node\\node_modules\\npm\\bin\\npm-cli.js"
    );
  });

  it("preserves a configured absolute POSIX npm CLI path on every host", () => {
    expect(resolveNpmCliPath({ npm_execpath: "/toolchain/npm-cli.js" }, "/node/bin/node")).toBe(
      "/toolchain/npm-cli.js"
    );
  });

  it("derives the npm CLI beside a POSIX Node executable on every host", () => {
    expect(resolveNpmCliPath({}, "/node/bin/node")).toBe(
      "/node/bin/node_modules/npm/bin/npm-cli.js"
    );
  });
});

function readManifest(): PackageManifest & {
  publishConfig?: { access?: string; registry?: string };
  version?: string;
} {
  return JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
}
