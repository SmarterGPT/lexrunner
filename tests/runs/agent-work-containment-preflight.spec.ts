import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentWorkContainmentCapabilityService,
  createAgentWorkContainmentPreflightHandler,
  type AgentWorkContainmentPreflightRequest,
} from "../../src/runs/agent-work-containment-preflight.js";
import {
  evaluateDirectoryIdentityBoundarySupport,
  type DirectoryIdentityBoundarySupport,
  type DirectoryIdentityPathProbe,
} from "../../src/workspaces/linux-directory-identity.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("directory-identity boundary capability policy", () => {
  it.each([
    {
      platform: "linux",
      pathComparison: "case-sensitive",
      procfsAvailable: true,
      supported: true,
      reasonCode: "native_linux_ready",
    },
    {
      platform: "win32",
      pathComparison: "case-insensitive",
      procfsAvailable: false,
      supported: false,
      reasonCode: "windows_native_boundary_unavailable",
    },
    {
      platform: "darwin",
      pathComparison: "case-sensitive",
      procfsAvailable: false,
      supported: false,
      reasonCode: "macos_unsupported",
    },
    {
      platform: "linux",
      pathComparison: "case-insensitive",
      procfsAvailable: true,
      supported: false,
      reasonCode: "case_insensitive_runtime",
    },
    {
      platform: "linux",
      pathComparison: "case-sensitive",
      procfsAvailable: false,
      supported: false,
      reasonCode: "procfs_unavailable",
    },
  ] as const)(
    "reports $reasonCode distinctly",
    ({ platform, pathComparison, procfsAvailable, supported, reasonCode }) => {
      expect(
        evaluateDirectoryIdentityBoundarySupport({
          platform,
          pathComparison,
          procfsAvailable,
        })
      ).toEqual({ platform, pathComparison, supported, reasonCode });
    }
  );
});

describe("AgentWorkContainmentCapabilityService", () => {
  it("reports native readiness only after all three directory identities are verified", () => {
    const pathProbe = vi.fn(() => verifiedPath());
    const service = serviceFor(runtimeSupport("linux", "case-sensitive"), pathProbe);

    const result = service.preflight(request());

    expect(result).toMatchObject({
      schemaVersion: "1.0.0",
      operation: "agent-work.containment.preflight",
      state: "native_ready",
      reasonCode: "native_linux_ready",
      physicalContainmentAvailable: true,
      projectionRequired: false,
      runtime: { platform: "linux", pathComparison: "case-sensitive" },
      paths: {
        repositoryRoot: { inspection: "identity_verified", filesystem: "native_linux" },
        repositoryGitDirectory: {
          inspection: "identity_verified",
          filesystem: "native_linux",
        },
        worktreeRoot: { inspection: "identity_verified", filesystem: "native_linux" },
      },
      nextActions: ["construct_attempt_packet"],
    });
    expect(result.bindingDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(pathProbe).toHaveBeenCalledTimes(3);
  });

  it("returns a native Windows boundary requirement before touching either path", () => {
    const pathProbe = vi.fn(() => verifiedPath());
    const service = serviceFor(runtimeSupport("win32", "case-insensitive"), pathProbe);

    const result = service.preflight(
      request({
        repositoryRoot: "D:\\dev\\stfc-mod",
        worktreeRoot: "D:\\dev\\lexrunner-worktrees",
        pathComparison: "case-insensitive",
      })
    );

    expect(result).toMatchObject({
      state: "broker_required",
      reasonCode: "windows_native_boundary_unavailable",
      physicalContainmentAvailable: false,
      projectionRequired: false,
      runtime: { platform: "windows", pathComparison: "case-insensitive" },
      paths: {
        repositoryRoot: { inspection: "syntactic_only", filesystem: "unknown" },
        repositoryGitDirectory: { inspection: "not_checked", filesystem: "unknown" },
        worktreeRoot: { inspection: "syntactic_only", filesystem: "unknown" },
      },
      nextActions: ["review_windows_boundary_status", "use_external_worker_workflow"],
      prerequisite: {
        component: expect.stringContaining("native Windows WorkspaceBoundary"),
        status: "production_integration_pending",
        setupProcedure: "unavailable_in_this_release",
        message: expect.stringContaining("Optional helper installation alone does not enable"),
        documentation: "docs/architecture/windows-production-activation.md",
        alternativeWorkflow: "docs/workflows/external-workers.md",
      },
    });
    expect(pathProbe).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("stfc-mod");
  });

  it("does not misclassify distinct Windows drives as overlapping roots", () => {
    const pathProbe = vi.fn(() => verifiedPath());
    const service = serviceFor(runtimeSupport("win32", "case-insensitive"), pathProbe);

    const result = service.preflight(
      request({
        repositoryRoot: "D:\\dev\\stfc-mod",
        worktreeRoot: "C:\\lexrunner-worktrees",
        pathComparison: "case-insensitive",
      })
    );

    expect(result).toMatchObject({
      state: "broker_required",
      reasonCode: "windows_native_boundary_unavailable",
    });
    expect(pathProbe).not.toHaveBeenCalled();
  });

  it.each([
    ["darwin", "case-sensitive", "macos_unsupported"],
    ["linux", "case-insensitive", "case_insensitive_runtime"],
    ["linux", "case-sensitive", "procfs_unavailable"],
  ] as const)("returns unsupported for %s / %s with %s", (platform, pathComparison, reasonCode) => {
    const support =
      reasonCode === "procfs_unavailable"
        ? evaluateDirectoryIdentityBoundarySupport({
            platform,
            pathComparison,
            procfsAvailable: false,
          })
        : runtimeSupport(platform, pathComparison);
    const result = serviceFor(support).preflight(request({ pathComparison }));

    expect(result).toMatchObject({
      state: "unsupported",
      reasonCode,
      physicalContainmentAvailable: false,
      projectionRequired: false,
    });
  });

  it("identifies WSL DrvFS/9P roots and recommends native-WSL projection", () => {
    const pathProbe = vi.fn((_absolutePath: string, label: string) =>
      label === "repositoryRoot" || label === "worktreeRoot"
        ? unsupportedPath("wsl_drvfs_9p", "wsl_drvfs_9p")
        : verifiedPath()
    );
    const service = serviceFor(runtimeSupport("linux", "case-sensitive"), pathProbe);

    const result = service.preflight(request());

    expect(result).toMatchObject({
      state: "broker_required",
      reasonCode: "repository_root_wsl_drvfs_9p",
      projectionRequired: true,
      paths: {
        repositoryRoot: { inspection: "filesystem_verified", filesystem: "wsl_drvfs_9p" },
        repositoryGitDirectory: { inspection: "not_checked", filesystem: "unknown" },
        worktreeRoot: { inspection: "filesystem_verified", filesystem: "wsl_drvfs_9p" },
      },
      nextActions: ["provision_native_wsl_projection", "rerun_containment_preflight"],
    });
    expect(pathProbe).toHaveBeenCalledTimes(2);
  });

  it("rejects a repository Git directory mounted through WSL DrvFS/9P", () => {
    const service = serviceFor(
      runtimeSupport("linux", "case-sensitive"),
      vi.fn((_absolutePath: string, label: string) =>
        label === "repositoryGitDirectory"
          ? unsupportedPath("wsl_drvfs_9p", "wsl_drvfs_9p")
          : verifiedPath()
      )
    );

    const result = service.preflight(request());

    expect(result).toMatchObject({
      state: "broker_required",
      reasonCode: "repository_git_wsl_drvfs_9p",
      paths: {
        repositoryRoot: { inspection: "identity_verified" },
        repositoryGitDirectory: {
          inspection: "filesystem_verified",
          filesystem: "wsl_drvfs_9p",
        },
        worktreeRoot: { inspection: "identity_verified" },
      },
    });
  });

  it("bounds low-level path failures without echoing paths or OS text", () => {
    const secretPath = "/native/secret-customer/repository";
    const service = serviceFor(
      runtimeSupport("linux", "case-sensitive"),
      vi.fn((_absolutePath: string, label: string) =>
        label === "repositoryRoot" ? unsupportedPath("path_unavailable", "unknown") : verifiedPath()
      )
    );

    const result = service.preflight(request({ repositoryRoot: secretPath }));
    const encoded = JSON.stringify(result);

    expect(result).toMatchObject({
      state: "unsupported",
      reasonCode: "repository_root_unavailable",
      paths: { repositoryRoot: { inspection: "unverified", filesystem: "unknown" } },
    });
    expect(encoded).not.toContain(secretPath);
    expect(encoded).not.toContain("secret-customer");
    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThan(2_048);
  });

  it("rejects overlapping roots before any physical probe", () => {
    const pathProbe = vi.fn(() => verifiedPath());
    const service = serviceFor(runtimeSupport("linux", "case-sensitive"), pathProbe);

    const result = service.preflight(
      request({
        repositoryRoot: "/native/repository",
        worktreeRoot: "/native/repository/worktrees",
      })
    );

    expect(result).toMatchObject({ state: "unsupported", reasonCode: "path_roots_overlap" });
    expect(pathProbe).not.toHaveBeenCalled();
  });

  it("binds the result to exact inputs without exposing them", () => {
    const service = serviceFor(runtimeSupport("linux", "case-sensitive"));
    const first = service.preflight(request());
    const replay = service.preflight(request());
    const changed = service.preflight(request({ repositoryId: "repo-2" }));

    expect(replay.bindingDigest).toBe(first.bindingDigest);
    expect(changed.bindingDigest).not.toBe(first.bindingDigest);
    expect(JSON.stringify(first)).not.toContain("/native/repository");
  });
});

describe("containment preflight handler", () => {
  it("bounds hostile and overlong input without reflecting it", async () => {
    const hostile = "secret-".repeat(3_000);
    const output = await createAgentWorkContainmentPreflightHandler().preflight(
      request({ repositoryRoot: hostile })
    );
    const encoded = JSON.stringify(output);

    expect(output).toMatchObject({
      ok: false,
      error: {
        code: "invalid_input",
        message: "Invalid containment preflight input",
        issues: [{ path: "runtime.repositoryRoot" }],
      },
    });
    expect(encoded).not.toContain(hostile);
    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThan(2_048);
  });

  it("performs no filesystem, Git, branch, marker, worktree, or SQLite mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "lexrunner-containment-preflight-"));
    temporaryRoots.push(root);
    const repositoryRoot = join(root, "repository");
    const worktreeRoot = join(root, "worktrees");
    await mkdir(join(repositoryRoot, ".git"), { recursive: true });
    await mkdir(worktreeRoot);
    const before = await recursiveEntries(root);

    const output = await createAgentWorkContainmentPreflightHandler().preflight(
      request({ repositoryRoot, worktreeRoot })
    );
    const after = await recursiveEntries(root);

    expect(output).toMatchObject(
      platform() === "linux"
        ? {
            ok: true,
            result: { state: "native_ready", physicalContainmentAvailable: true },
          }
        : platform() === "win32"
          ? {
              ok: true,
              result: { state: "broker_required", physicalContainmentAvailable: false },
            }
          : {
              ok: true,
              result: { state: "unsupported", physicalContainmentAvailable: false },
            }
    );
    expect(after).toEqual(before);
    expect(after.some((entry) => /(?:\.db|lexrunner-attempt\.json)$/u.test(entry))).toBe(false);
  });
});

function request(
  overrides: Partial<AgentWorkContainmentPreflightRequest["runtime"]> = {}
): AgentWorkContainmentPreflightRequest {
  return {
    runtime: {
      repositoryId: "repo-1",
      repositoryRoot: "/native/repository",
      worktreeRoot: "/native/worktrees",
      gitRuntime: "wsl-ubuntu",
      pathComparison: "case-sensitive",
      ...overrides,
    },
  };
}

function runtimeSupport(
  platform: NodeJS.Platform,
  pathComparison: "case-sensitive" | "case-insensitive"
): DirectoryIdentityBoundarySupport {
  return evaluateDirectoryIdentityBoundarySupport({
    platform,
    pathComparison,
    procfsAvailable: true,
  });
}

function serviceFor(
  support: DirectoryIdentityBoundarySupport,
  pathProbe: (absolutePath: string, label: string) => DirectoryIdentityPathProbe = () =>
    verifiedPath()
): AgentWorkContainmentCapabilityService {
  return new AgentWorkContainmentCapabilityService({
    runtimeProbe: () => support,
    pathProbe,
  });
}

function verifiedPath(): DirectoryIdentityPathProbe {
  return { verified: true, filesystem: "native_linux", reasonCode: "directory_verified" };
}

function unsupportedPath(
  reasonCode: Exclude<DirectoryIdentityPathProbe["reasonCode"], "directory_verified">,
  filesystem: DirectoryIdentityPathProbe["filesystem"]
): DirectoryIdentityPathProbe {
  return { verified: false, filesystem, reasonCode };
}

async function recursiveEntries(root: string): Promise<string[]> {
  return (await readdir(root, { recursive: true })).map(String).sort();
}
