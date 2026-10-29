import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_VERSIONS,
  DOGFOOD_INSTALL_POLICY,
  assertExactPublishedVersions,
  assertRegistryOnlyPackageLock,
  inspectDogfoodRun,
  verifyReviewedNativePrebuild,
  reapDogfoodRun,
  reviewedNativePrebuildRelative,
  resolveOrdinaryPackageRoot,
  scrubRuntimeEnvironment,
} from "../scripts/dogfood-ecosystem.js";
import { computeCanonicalHash } from "../src/schemas/task-contract.js";
import { canonicalJSONStringify } from "../src/util/canonicalJson.js";

const temporaryRoots: string[] = [];
const directoryLinkType = process.platform === "win32" ? "junction" : "dir";

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("ecosystem dogfood allocation lifecycle", () => {
  async function nativeFixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), "lexrunner-native-prebuild-"));
    temporaryRoots.push(root);
    const roots = [path.join(root, "source"), path.join(root, "consumer")];
    for (const directory of roots) {
      const packageRoot = path.join(directory, "node_modules", "better-sqlite3-multiple-ciphers");
      await mkdir(path.join(packageRoot, "prebuilds"), { recursive: true });
      await writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: "better-sqlite3-multiple-ciphers", version: "13.0.3" })
      );
      await writeFile(
        path.join(packageRoot, reviewedNativePrebuildRelative()),
        "reviewed-prebuild-fixture"
      );
      await writeFile(
        path.join(directory, "package-lock.json"),
        JSON.stringify({
          packages: {
            "node_modules/better-sqlite3-multiple-ciphers": {
              version: "13.0.3",
              resolved:
                "https://registry.npmjs.org/better-sqlite3-multiple-ciphers/-/better-sqlite3-multiple-ciphers-13.0.3.tgz",
              integrity: "sha512-fixture",
            },
          },
        })
      );
    }
    return {
      source: roots[0]!,
      consumer: roots[1]!,
      target: path.join(roots[1]!, "node_modules", "better-sqlite3-multiple-ciphers"),
    };
  }

  it("verifies the shipped N-API prebuild without a generated build directory or copying bytes", async () => {
    const f = await nativeFixture();
    expect(await verifyReviewedNativePrebuild(f.source, f.consumer)).toMatch(
      /^sha256:[a-f0-9]{64}$/
    );
    expect(await readFile(path.join(f.target, reviewedNativePrebuildRelative()), "utf8")).toBe(
      "reviewed-prebuild-fixture"
    );
    await expect(
      readFile(path.join(f.target, "build", "Release", "better_sqlite3.node"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(reviewedNativePrebuildRelative("linux", "arm64", true)).toBe(
      path.join("prebuilds", "linuxmusl-arm64.node")
    );
    expect(() => reviewedNativePrebuildRelative("win32", "ia32", false)).toThrow(
      "platform_unsupported"
    );
  });

  it("refuses missing, replaced and mismatched native prebuilds rather than repairing them", async () => {
    const f = await nativeFixture();
    const target = path.join(f.target, reviewedNativePrebuildRelative());
    await writeFile(target, "different native bytes");
    await expect(verifyReviewedNativePrebuild(f.source, f.consumer)).rejects.toThrow(
      "prebuild_bytes_mismatch"
    );
    await rm(target);
    await expect(verifyReviewedNativePrebuild(f.source, f.consumer)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const directory = path.join(f.target, "prebuilds");
    await rm(directory, { recursive: true });
    await symlink(
      path.join(f.source, "node_modules", "better-sqlite3-multiple-ciphers", "prebuilds"),
      directory,
      directoryLinkType
    );
    await expect(verifyReviewedNativePrebuild(f.source, f.consumer)).rejects.toThrow(
      "prebuild_directory_invalid"
    );
  });

  it("refuses old package versions and registry identity mismatches before native selection", async () => {
    const f = await nativeFixture();
    const lockPath = path.join(f.consumer, "package-lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    lock.packages["node_modules/better-sqlite3-multiple-ciphers"].version = "12.11.1";
    await writeFile(lockPath, JSON.stringify(lock));
    await expect(verifyReviewedNativePrebuild(f.source, f.consumer)).rejects.toThrow(
      "version_mismatch"
    );
    lock.packages["node_modules/better-sqlite3-multiple-ciphers"].version = "13.0.3";
    lock.packages["node_modules/better-sqlite3-multiple-ciphers"].integrity = "sha512-other";
    await writeFile(lockPath, JSON.stringify(lock));
    await expect(verifyReviewedNativePrebuild(f.source, f.consumer)).rejects.toThrow(
      "registry_identity_mismatch"
    );
  });

  it("defaults to the coordinated published ecosystem", () => {
    expect(DEFAULT_VERSIONS).toEqual({
      lex: "4.4.4",
      lexMcp: "4.4.4",
      axf: "2.1.1",
      lexsona: "2.0.2",
    });
  });

  it("forbids package lifecycle scripts during the credentialed registry install", () => {
    expect(DOGFOOD_INSTALL_POLICY).toEqual({
      network: "registry_only",
      registries: ["https://registry.npmjs.org/"],
      cache: "read_write",
      lifecycle_scripts: "forbidden",
    });
  });

  it("rejects non-exact package selections before installation", () => {
    expect(() => assertExactPublishedVersions(DEFAULT_VERSIONS)).not.toThrow();
    for (const version of [
      "^4.0.3",
      "latest",
      "npm:@smartergpt/lex@4.0.3",
      "file:../lex",
      "git+https://github.com/Guffawaffle/lex.git",
      "github:Guffawaffle/lex",
      "https://example.test/lex.tgz",
      "4.0.3-beta.1",
    ]) {
      expect(() => assertExactPublishedVersions({ lex: version })).toThrow("non_exact_version_lex");
    }
  });

  it("accepts only registry lock entries plus the staged LexRunner tarball", () => {
    const valid = {
      "": {},
      "node_modules/example": {
        version: "1.2.3",
        resolved: "https://registry.npmjs.org/example/-/example-1.2.3.tgz",
        integrity: "sha512-example",
      },
      "node_modules/@smartergpt/lexrunner": {
        version: "1.5.2",
        resolved: "file:../../stage/smartergpt-lexrunner-1.5.2.tgz",
        integrity: "sha512-candidate",
      },
    };
    const expectedCandidate = valid["node_modules/@smartergpt/lexrunner"];
    expect(
      assertRegistryOnlyPackageLock(valid, "https://registry.npmjs.org/", expectedCandidate)
    ).toHaveLength(2);
    expect(() =>
      assertRegistryOnlyPackageLock(
        {
          ...valid,
          "node_modules/@smartergpt/lexrunner": {
            ...expectedCandidate,
            resolved: "file:../../outside-attacker.tgz",
            integrity: "sha512-attacker",
          },
        },
        "https://registry.npmjs.org/",
        expectedCandidate
      )
    ).toThrow("registry_lock_candidate_identity_invalid");
    for (const resolved of [
      "https://example.test/package.tgz",
      "git+https://github.com/example/package.git",
      "file:../../outside.tgz",
    ]) {
      expect(() =>
        assertRegistryOnlyPackageLock(
          {
            ...valid,
            "node_modules/escape": { version: "1.0.0", resolved, integrity: "sha512-x" },
          },
          "https://registry.npmjs.org/",
          expectedCandidate
        )
      ).toThrow("registry_lock_external_resolution");
    }
  });

  it("rejects linked source and target package roots outside physical node_modules", async () => {
    for (const role of ["source", "target"]) {
      const root = await mkdtemp(path.join(os.tmpdir(), `lexrunner-native-${role}-root-test-`));
      temporaryRoots.push(root);
      const nodeModules = path.join(root, "node_modules");
      const outside = path.join(root, "outside-package");
      await Promise.all([mkdir(nodeModules), mkdir(outside)]);
      await symlink(outside, path.join(nodeModules, "native-package"), directoryLinkType);
      await expect(
        resolveOrdinaryPackageRoot(nodeModules, "native-package", `native_${role}_root_invalid`)
      ).rejects.toThrow(`native_${role}_root_invalid`);
    }
  });

  it("scrubs registry and GitHub credentials from post-install runtime commands", () => {
    const environment = scrubRuntimeEnvironment(
      {
        PATH: "safe-path",
        NPM_TOKEN: "secret",
        NODE_AUTH_TOKEN: "secret",
        GH_TOKEN: "secret",
        NPM_CONFIG_USERCONFIG: "credentialed.npmrc",
      },
      "disposable-home",
      "disposable-temp",
      "empty-user.npmrc",
      "empty-global.npmrc"
    );
    expect(environment).toMatchObject({
      PATH: "safe-path",
      HOME: "disposable-home",
      USERPROFILE: "disposable-home",
      TEMP: "disposable-temp",
      NPM_CONFIG_USERCONFIG: "empty-user.npmrc",
      NPM_CONFIG_GLOBALCONFIG: "empty-global.npmrc",
    });
    expect(environment).not.toHaveProperty("NPM_TOKEN");
    expect(environment).not.toHaveProperty("NODE_AUTH_TOKEN");
    expect(environment).not.toHaveProperty("GH_TOKEN");
  });

  it("inspects compact status, exposes bounded diagnostics explicitly, and reaps idempotently", async () => {
    const { allocationRoot, runRoot } = await fixture();
    await expect(inspectDogfoodRun({ allocationRoot, runRoot })).resolves.toEqual({
      ok: true,
      runId: path.basename(runRoot),
      status: "interrupted",
      phase: "prepare",
      passed: 1,
      total: 1,
    });
    const diagnostic = await inspectDogfoodRun({ allocationRoot, runRoot, diagnostics: true });
    expect(diagnostic).toMatchObject({
      ok: true,
      versions: { "@smartergpt/lex": "4.0.0" },
      steps: [{ id: "prepare", outcome: "passed" }],
    });
    expect(JSON.stringify(diagnostic)).not.toContain(allocationRoot);

    await expect(reapDogfoodRun({ allocationRoot, runRoot })).resolves.toMatchObject({
      ok: true,
      outcome: "removed",
    });
    await expect(reapDogfoodRun({ allocationRoot, runRoot })).resolves.toEqual({
      ok: true,
      outcome: "absent",
    });
  });

  it("refuses cleanup outside a direct marked allocation child", async () => {
    const { allocationRoot, runRoot } = await fixture();
    await expect(reapDogfoodRun({ allocationRoot, runRoot: allocationRoot })).rejects.toThrow(
      "cleanup_containment_violation"
    );
    await expect(
      reapDogfoodRun({ allocationRoot, runRoot: path.join(runRoot, "nested") })
    ).rejects.toThrow("cleanup_containment_violation");
  });

  it("refuses symlinked run roots and forged ownership markers", async () => {
    const { allocationRoot, runRoot } = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "lexrunner-dogfood-outside-"));
    temporaryRoots.push(outside);
    const link = path.join(allocationRoot, "run-link");
    await symlink(outside, link, directoryLinkType);
    await expect(reapDogfoodRun({ allocationRoot, runRoot: link })).rejects.toThrow(
      "allocation_not_directory"
    );

    const markerPath = path.join(runRoot, ".lexrunner-dogfood-allocation.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
    marker.run_id = "forged";
    await writeFile(markerPath, `${canonicalJSONStringify(marker)}\n`);
    await expect(reapDogfoodRun({ allocationRoot, runRoot })).rejects.toThrow(
      "allocation_marker_mismatch"
    );
  });
});

async function fixture(): Promise<{ allocationRoot: string; runRoot: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "lexrunner-dogfood-test-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, "alloc"));
  const actualAllocationRoot = await realpath(path.join(root, "alloc"));
  const runRoot = path.join(actualAllocationRoot, "run-test");
  await mkdir(runRoot);
  const runId = path.basename(runRoot);
  await writeFile(
    path.join(runRoot, ".lexrunner-dogfood-allocation.json"),
    `${canonicalJSONStringify({
      schema_version: 1,
      kind: "LexRunnerEcosystemDogfoodAllocation",
      run_id: runId,
      allocation_root_hash: hashText(actualAllocationRoot),
      created_at: "2026-07-20T10:00:00.000Z",
    })}\n`
  );
  const receiptWithoutHash = {
    schema_version: 1,
    kind: "LexRunnerEcosystemDogfoodReceipt",
    run_id: runId,
    status: "interrupted",
    phase: "prepare",
    allocation_root_hash: hashText(actualAllocationRoot),
    versions: { "@smartergpt/lex": "4.0.0" },
    steps: [{ id: "prepare", outcome: "passed", evidence_hash: hashText("passed") }],
    started_at: "2026-07-20T10:00:00.000Z",
    completed_at: "2026-07-20T10:01:00.000Z",
    error_code: "fault_after_prepare",
  };
  await writeFile(
    path.join(runRoot, "dogfood-receipt.json"),
    `${canonicalJSONStringify({
      ...receiptWithoutHash,
      receipt_hash: computeCanonicalHash(receiptWithoutHash),
    })}\n`
  );
  return { allocationRoot: actualAllocationRoot, runRoot };
}

function hashText(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
