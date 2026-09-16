import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceBoundaryDirectoryIdentity } from "../../src/workspaces/workspace-boundary.js";
const mocks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("../../src/workspaces/workspace-boundary-resolver.js", () => ({
  resolveWorkspaceBoundary: mocks.resolve,
}));
vi.mock("../../src/workspaces/linux-directory-identity.js", async (original) => {
  const actual =
    await original<typeof import("../../src/workspaces/linux-directory-identity.js")>();
  return {
    ...actual,
    captureDirectoryIdentity: () => {
      throw new Error("Linux capture must not run");
    },
  };
});
import { NodeGitWorktreeBroker } from "../../src/workspaces/node-git-worktree-broker.js";
const options = () => ({
  repositoryId: "repo",
  repositoryRoot: path.resolve("artifacts/bootstrap/repo"),
  worktreeRoot: path.resolve("artifacts/bootstrap/work"),
  hostId: "host",
  gitRuntime: "git-windows",
  pathComparison: "case-insensitive" as const,
});
const identity = (name: string, id: string) =>
  createWorkspaceBoundaryDirectoryIdentity({
    schema_version: "1.0.0",
    backend_kind: "windows-native",
    identity_kind: "windows-volume-file-id",
    canonical_path: `D:\\${name}`,
    path_comparison: "case-insensitive",
    file_id: id,
    volume_serial_number: "a",
  });
function fixture() {
  const repository = { identity: identity("repo", "1") };
  const allocation = { identity: identity("work", "2") };
  const git = { identity: identity("repo\\.git", "3") };
  const lease = {
    root: vi.fn((role: string) => (role === "repository" ? repository : allocation)),
    openChild: vi.fn(async () => ({ ok: true, value: git })),
    assertCurrent: vi.fn(async () => ({ ok: true })),
    close: vi.fn(async () => ({ phase: "released" })),
  };
  const boundary = {
    capability: { host: { path_comparison: "case-insensitive" } },
    acquire: vi.fn(async () => ({ ok: true, lease })),
  };
  mocks.resolve.mockReturnValue({ ok: true, boundary });
  return { lease, boundary };
}
beforeEach(() => vi.clearAllMocks());
describe("portable broker bootstrap", () => {
  it("captures through the boundary and closes before returning, without Linux capture", async () => {
    const { lease, boundary } = fixture();
    expect(await NodeGitWorktreeBroker.open(options())).toBeInstanceOf(NodeGitWorktreeBroker);
    expect(boundary.acquire).toHaveBeenCalledOnce();
    expect(lease.openChild.mock.calls[0][1]).toBe(".git");
    expect(lease.assertCurrent).toHaveBeenCalledOnce();
    expect(lease.close).toHaveBeenCalledWith("completed");
  });
  it("closes after a missing Git directory", async () => {
    const { lease } = fixture();
    lease.openChild.mockResolvedValueOnce({
      ok: false,
      error: { code: "operation_failed" },
    } as any);
    await expect(NodeGitWorktreeBroker.open(options())).rejects.toThrow("Git bootstrap failed");
    expect(lease.close).toHaveBeenCalledOnce();
  });
  it("refuses an unconfirmed release", async () => {
    const { lease } = fixture();
    lease.close.mockResolvedValueOnce({ phase: "expired" });
    await expect(NodeGitWorktreeBroker.open(options())).rejects.toThrow("release unconfirmed");
  });
  it("refuses changed identities and still closes", async () => {
    const { lease } = fixture();
    lease.assertCurrent.mockResolvedValueOnce({
      ok: false,
      error: { code: "identity_changed" },
    } as any);
    await expect(NodeGitWorktreeBroker.open(options())).rejects.toThrow("assertion failed");
    expect(lease.close).toHaveBeenCalledOnce();
  });
  it("keeps unavailable resolution explicit without acquiring", async () => {
    mocks.resolve.mockReturnValue({ ok: false, decision: { reason_code: "helper_missing" } });
    await expect(NodeGitWorktreeBroker.open(options())).rejects.toThrow("helper_missing");
  });
  it("validates roots before resolving and rejects injected bootstrap records", async () => {
    await expect(
      NodeGitWorktreeBroker.open({ ...options(), worktreeRoot: options().repositoryRoot })
    ).rejects.toThrow("overlap");
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(() => new NodeGitWorktreeBroker(options(), {} as any)).toThrow(
      "Invalid broker bootstrap"
    );
  });
});
