import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repositoryRoot = resolve(import.meta.dirname, "..");
const previousPackageExportKeys = [
  ".",
  "./audit-sdk",
  "./errors",
  "./frames",
  "./schemas/behavior-rule",
  "./schemas/execution-plan-v1",
  "./schemas/gates",
  "./schemas/runner-scope",
  "./schemas/runner-stack",
];

describe("LexRunner current release readiness", () => {
  it("keeps package, runtime, dependency, and prior export identity aligned", async () => {
    const packageJson = await readJson<{
      version: string;
      engines: { node: string };
      dependencies: Record<string, string>;
      bin: Record<string, string>;
      exports: Record<string, unknown>;
      repository: { url: string };
      scripts: Record<string, string>;
    }>("package.json");

    expect(packageJson.version).toBe("2.4.0");
    expect(packageJson.engines.node).toBe(">=24");
    expect(packageJson.dependencies["@smartergpt/lex"]).toBe("4.0.3");
    expect(packageJson.bin["lexrunner"]).toBe("dist/cli.js");
    expect(packageJson.bin["lex-pr"]).toBe("dist/cli.js");
    expect(packageJson.bin["lexrunner-mcp"]).toBe("mcp-server.mjs");
    expect(packageJson.repository.url).toBe("git+https://github.com/SmarterGPT/lexrunner.git");
    expect(packageJson.scripts["release:publish:check"]).toBe(
      "tsx scripts/release-publish-check.ts"
    );
    expect(Object.keys(packageJson.exports).sort()).toEqual(previousPackageExportKeys.sort());
  });

  it("validates the installed Lex 4 line exposes every directly consumed public subpath", async () => {
    const lexPackage = await readJson<{
      version: string;
      exports: Record<string, unknown>;
    }>("node_modules/@smartergpt/lex/package.json");

    expect(lexPackage.version).toBe("4.0.3");
    for (const path of [
      ".",
      "./aliases",
      "./atlas",
      "./errors",
      "./module-ids",
      "./prompts",
      "./store",
      "./types",
    ]) {
      expect(Object.keys(lexPackage.exports), `Lex 4 omitted ${path}`).toContain(path);
    }
  });

  it("keeps release notes, migration guidance, and current version documentation consistent", async () => {
    const [
      readme,
      changelog,
      currentReleaseNotes,
      frozenInputReleaseNotes,
      openSourceReleaseNotes,
      releaseNotes,
      priorReleaseNotes,
      compatibilityDecision,
      migration,
      instructions,
      releaseWorkflow,
      releaseProcess,
      releaseDriftCheck,
    ] = await Promise.all([
      read("README.md"),
      read("CHANGELOG.md"),
      read("docs/releases/2.3.0.md"),
      read("docs/releases/2.2.0.md"),
      read("docs/releases/2.1.0.md"),
      read("docs/releases/2.0.0.md"),
      read("docs/releases/1.2.1.md"),
      read("docs/releases/1.2.0.md"),
      read("docs/node-24-migration.md"),
      read("AGENTS.md"),
      read(".github/workflows/release.yml"),
      read("docs/release-process.md"),
      read("scripts/check-release-drift.mjs"),
    ]);

    expect(readme).toContain("Current repository package version: **2.4.0**");
    const progressiveHelpNotes = await read("docs/releases/2.4.0.md");
    expect(progressiveHelpNotes).toContain("`--help-all`");
    expect(progressiveHelpNotes).toContain("clean registry consumer check");
    expect(readme).toContain("`lex-pr` executable remains an additive");
    expect(changelog).toContain("## [1.4.1] - 2026-08-04");
    expect(currentReleaseNotes).toContain("`materialize_attempt_input`");
    expect(currentReleaseNotes).toContain("`expectedPacketHash`");
    expect(currentReleaseNotes).toContain("Older strict");
    expect(currentReleaseNotes).toContain("Materialization does not write lifecycle state");
    expect(currentReleaseNotes).toContain("clean registry consumer check");
    expect(frozenInputReleaseNotes).toContain("Plan Schema 1.0.1");
    expect(frozenInputReleaseNotes).toContain("existing unbound plan support");
    expect(frozenInputReleaseNotes).toContain("Multi-repository plans remain legacy-unbound");
    expect(frozenInputReleaseNotes).toContain("Preparation does not publish the package");
    expect(openSourceReleaseNotes).toContain("Apache-2.0");
    expect(openSourceReleaseNotes).toContain("This minor release");
    expect(openSourceReleaseNotes).toContain("issue #947");
    expect(openSourceReleaseNotes).toContain("observed artifacts cannot grant merge eligibility");
    expect(openSourceReleaseNotes).toContain("Earlier immutable npm versions");
    expect(releaseNotes).toContain("release-owner-signed, trusted-workflow npm publication");
    expect(releaseNotes).toContain("`lexrunner`, `lex-pr`, and `lexrunner-mcp`");
    expect(releaseNotes).toContain("lexrunner-gate-execution-receipt/v2");
    expect(releaseNotes).toContain('authority: "unverified"');
    expect(releaseNotes).toContain("issue #865");
    expect(releaseNotes).toContain("container declaration is rejected as unsupported");
    expect(releaseNotes).toContain("schedule removal for 3.0.0");
    expect(releaseNotes).toContain("does not re-read retained gate artifacts after execution");
    expect(priorReleaseNotes).toContain("human-only publication gate");
    expect(compatibilityDecision).toContain("public unattended/headless worker-launch");
    expect(compatibilityDecision).toContain("separate explicitly authorized action");
    expect(compatibilityDecision).toContain("not published to npm");
    expect(migration).toContain("@smartergpt/lexrunner@2.0.0");
    expect(migration).not.toContain("@smartergpt/lexrunner@3.1.0");
    expect(instructions).toContain("MUST NOT");
    expect(instructions).toContain("npm's package-scoped GitHub OIDC trusted publisher");
    expect(releaseWorkflow).toContain('"v*.*.*"');
    expect(releaseWorkflow).not.toContain('"lexrunner-v*.*.*"');
    expect(releaseWorkflow).toContain("npm publish --access public --tag latest --json");
    expect(releaseWorkflow).toContain("id-token: write");
    expect(releaseWorkflow).toContain("package-manager-cache: false");
    expect(releaseWorkflow).toContain("github.event_name == 'push' &&");
    expect(releaseWorkflow).toContain("API_TARGET_TYPE=$(jq -r '.object.type'");
    expect(releaseWorkflow).toContain("API_TARGET_SHA=$(jq -r '.object.sha'");
    expect(releaseWorkflow).toContain(
      "RELEASE_SIGNER_FINGERPRINT: 65C94BA03E88F53D365C36CF7145A1CE635B1902"
    );
    expect(releaseWorkflow).toContain('verify-commit "$GITHUB_SHA"');
    expect(releaseWorkflow).toContain('verify-tag --raw "$TAG_NAME"');
    expect(releaseWorkflow).toContain("GNUPGHOME=$(mktemp -d)");
    expect(releaseWorkflow).toContain("VALIDSIG_COUNT=$(grep -c");
    expect(releaseWorkflow).toContain('"$VALIDSIG_COUNT" -ne 1');
    expect(releaseWorkflow).toContain("IMPORTED_PRIMARY_FINGERPRINT=");
    expect(releaseWorkflow).toContain(
      '"$IMPORTED_PRIMARY_FINGERPRINT" != "$RELEASE_SIGNER_FINGERPRINT"'
    );
    expect(releaseWorkflow).toContain("TAG_SIGNER_FINGERPRINT=");
    expect(releaseWorkflow).toContain('"$TAG_SIGNER_FINGERPRINT" != "$RELEASE_SIGNER_FINGERPRINT"');
    expect(releaseWorkflow).toContain(
      'gh api "repos/${GITHUB_REPOSITORY}/compare/${GITHUB_SHA}...${MAIN_SHA}"'
    );
    expect(releaseWorkflow).toContain('"$ANCESTRY_STATUS" != "ahead"');
    expect(releaseWorkflow).toContain('"$ANCESTRY_STATUS" != "identical"');
    expect(releaseWorkflow).not.toContain("git fetch --no-tags origin main");
    const workflow = parse(releaseWorkflow) as {
      jobs: Record<
        string,
        {
          permissions?: Record<string, string>;
          steps?: Array<{ uses?: string; run?: string; with?: Record<string, unknown> }>;
        }
      >;
    };
    const stableReleaseJob = workflow.jobs["stable-release"];
    const stableActionUses = stableReleaseJob.steps
      ?.map((step) => step.uses)
      .filter((uses): uses is string => Boolean(uses));
    expect(stableActionUses).toEqual([
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    ]);
    expect(stableActionUses?.every((uses) => /@[0-9a-f]{40}$/.test(uses))).toBe(true);
    expect(stableReleaseJob.steps?.[0]?.with?.["persist-credentials"]).toBe(false);
    expect(stableReleaseJob.permissions?.["id-token"]).toBe("write");
    expect(stableReleaseJob.permissions?.contents).toBe("write");
    const oidcJobs = Object.entries(workflow.jobs)
      .filter(([, job]) => job.permissions?.["id-token"] === "write")
      .map(([name]) => name);
    expect(oidcJobs).toEqual(["stable-release"]);
    const publishingJobs = Object.entries(workflow.jobs)
      .filter(([, job]) =>
        job.steps?.some((step) => step.run?.includes("npm publish --access public --tag latest"))
      )
      .map(([name]) => name);
    expect(publishingJobs).toEqual(["stable-release"]);
    expect(releaseWorkflow).not.toContain("NODE_AUTH_TOKEN");
    expect(releaseWorkflow).not.toContain("secrets.NPM_TOKEN");
    expect(releaseProcess).toContain("npm trust github @smartergpt/lexrunner --file release.yml");
    expect(releaseProcess).toContain("vX.Y.Z");
    expect(releaseProcess).toContain("runs only for push events");
    expect(releaseDriftCheck).toContain("v${version}");
  });
});

async function read(path: string): Promise<string> {
  return readFile(resolve(repositoryRoot, path), "utf8");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await read(path)) as T;
}
