import { describe, expect, it } from "vitest";
import {
  planOwnedWindowsRoots,
  acquireOwnedWindowsRootSession,
} from "../../src/workspaces/owned-windows-root-session.js";
describe("owned Windows root planning", () => {
  it("shares common paths and reserves every release", () => {
    const plan = planOwnedWindowsRoots(
      [
        { role: "repository", absolutePath: "D:\\project\\repo" },
        { role: "allocation", absolutePath: "D:\\project\\workers" },
      ],
      9
    );
    expect(plan).toMatchObject({
      anchorPath: "D:\\project",
      setupOperations: 3,
      releaseOperations: 3,
      remainingOperations: 122,
    });
    expect(Object.isFrozen(plan.roots[0].components)).toBe(true);
    expect(() =>
      planOwnedWindowsRoots(
        [
          { role: "a", absolutePath: "D:\\a" },
          { role: "b", absolutePath: "D:\\b" },
        ],
        123
      )
    ).toThrow("insufficient_root_budget");
  });
  it("reuses identical roots and common intermediate components", () => {
    expect(
      planOwnedWindowsRoots(
        [
          { role: "a", absolutePath: "D:\\a" },
          { role: "b", absolutePath: "d:\\a" },
        ],
        13
      ).setupOperations
    ).toBe(1);
    expect(
      planOwnedWindowsRoots(
        [
          { role: "a", absolutePath: "D:\\a" },
          { role: "b", absolutePath: "D:\\b\\c" },
          { role: "c", absolutePath: "D:\\b\\d" },
        ],
        1
      ).setupOperations
    ).toBe(5);
  });
  it.each(["D:relative", "\\\\server\\share", "D:\\a\\..\\b", "D:\\a\\\\b", "D:\\a.", "D:/a"])(
    "rejects unsupported path %s",
    (absolutePath) => {
      expect(() => planOwnedWindowsRoots([{ role: "a", absolutePath }], 1)).toThrow();
    }
  );
  it("rejects cross-drive roots and repeated roles before helper acquisition", async () => {
    const roots = [
      { role: "a", absolutePath: "C:\\a" },
      { role: "b", absolutePath: "D:\\b" },
    ];
    expect(() => planOwnedWindowsRoots(roots, 1)).toThrow("cross_volume_roots_unsupported");
    expect(await acquireOwnedWindowsRootSession({} as any, {}, roots, 1)).toEqual({
      ok: false,
      reason: "cross_volume_roots_unsupported",
    });
    expect(() => planOwnedWindowsRoots([roots[0], roots[0]], 1)).toThrow("invalid_root_role");
  });
});
