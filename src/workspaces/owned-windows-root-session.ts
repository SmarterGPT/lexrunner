import { win32 } from "node:path";
import {
  acquireOwnedWindowsDirectorySession,
  type OwnedWindowsDirectorySession,
} from "./owned-windows-directory-session.js";
import type { OwnedWindowsDirectoryScope } from "./owned-windows-boundary-handshake.js";

/** Explicit development limits of the current owned protocol, including release requests. */
export function planOwnedWindowsRoots(
  roots: readonly { readonly role: string; readonly absolutePath: string }[],
  workOperations: number
) {
  if (
    !Array.isArray(roots) ||
    roots.length < 1 ||
    roots.length > 16 ||
    !Number.isSafeInteger(workOperations) ||
    workOperations < 1 ||
    workOperations > 13
  )
    throw new Error("invalid_root_budget");
  const roles = new Set<string>();
  const parsed = roots.map(({ role, absolutePath }) => {
    if (
      typeof role !== "string" ||
      !role ||
      role.length > 4096 ||
      role.includes("\0") ||
      roles.has(role)
    )
      throw new Error("invalid_root_role");
    roles.add(role);
    // UNC, device namespaces and relative paths need separate qualification.
    if (
      typeof absolutePath !== "string" ||
      absolutePath.length > 32768 ||
      !/^[a-z]:\\/iu.test(absolutePath) ||
      absolutePath.includes("/") ||
      absolutePath.includes("\0")
    )
      throw new Error("unsupported_root_path");
    const parts = absolutePath
      .slice(3)
      .replace(/\\$/u, "")
      .split("\\")
      .filter((part, index, all) => !(all.length === 1 && index === 0 && part === ""));
    if (
      parts.some(
        (part) =>
          !part ||
          part.length > 255 ||
          part === "." ||
          part === ".." ||
          /[<>:"/\\|?*\u0000-\u001f]/u.test(part) ||
          /[. ]$/u.test(part)
      )
    )
      throw new Error("unsupported_root_path");
    return { role, drive: absolutePath.slice(0, 3), parts };
  });
  if (parsed.some((root) => root.drive.toLowerCase() !== parsed[0].drive.toLowerCase()))
    throw new Error("cross_volume_roots_unsupported");
  let shared = parsed[0].parts.length;
  for (const root of parsed) {
    let length = 0;
    while (
      length < shared &&
      length < root.parts.length &&
      root.parts[length].toLowerCase() === parsed[0].parts[length].toLowerCase()
    )
      length++;
    shared = length;
  }
  const anchorPath = win32.join(parsed[0].drive, ...parsed[0].parts.slice(0, shared));
  const edges = new Set<string>();
  const selected = parsed.map((root) => {
    const components = root.parts.slice(shared);
    for (let i = 1; i <= components.length; i++)
      edges.add(components.slice(0, i).join("\\").toLowerCase());
    return Object.freeze({ role: root.role, components: Object.freeze(components) });
  });
  const setupOperations = 1 + edges.size;
  const releaseOperations = setupOperations;
  if (setupOperations + releaseOperations + workOperations > 15)
    throw new Error("insufficient_root_budget");
  return Object.freeze({
    anchorPath,
    roots: Object.freeze(selected),
    setupOperations,
    releaseOperations,
    workOperations,
    remainingOperations: 15 - setupOperations - releaseOperations,
  });
}

/** Development root-role acquisition. Never establishes a production capability decision. */
export async function acquireOwnedWindowsRootSession(
  options: Parameters<typeof acquireOwnedWindowsDirectorySession>[0],
  directory: Omit<Parameters<typeof acquireOwnedWindowsDirectorySession>[1], "path">,
  roots: readonly { readonly role: string; readonly absolutePath: string }[],
  workOperations: number,
  signal?: AbortSignal
): Promise<
  | {
      readonly ok: false;
      readonly reason: string;
      readonly report?: Awaited<OwnedWindowsDirectorySession["completion"]>;
    }
  | {
      readonly ok: true;
      readonly session: OwnedWindowsDirectorySession;
      readonly plan: ReturnType<typeof planOwnedWindowsRoots>;
      root(role: string): OwnedWindowsDirectoryScope;
    }
> {
  let plan: ReturnType<typeof planOwnedWindowsRoots>;
  try {
    plan = planOwnedWindowsRoots(roots, workOperations);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "invalid_roots" };
  }
  const acquired = await acquireOwnedWindowsDirectorySession(
    options,
    { ...directory, path: plan.anchorPath },
    signal
  );
  if (!acquired.ok)
    return { ok: false, reason: "root_acquisition_failed", report: acquired.report };
  const { session } = acquired;
  const selected = new Map<string, OwnedWindowsDirectoryScope>();
  try {
    await session.run(async (anchor) => {
      const opened = new Map<string, OwnedWindowsDirectoryScope>([["", anchor]]);
      for (const root of plan.roots) {
        let scope = anchor;
        for (let i = 0; i < root.components.length; i++) {
          const key = root.components
            .slice(0, i + 1)
            .join("\\")
            .toLowerCase();
          let child = opened.get(key);
          if (!child) {
            child = await scope.openChild(root.components[i]);
            opened.set(key, child);
          }
          scope = child;
        }
        selected.set(root.role, scope);
      }
    });
    return Object.freeze({
      ok: true as const,
      session,
      plan,
      root(role: string) {
        const scope = selected.get(role);
        if (!scope) throw new Error("unknown_root_role");
        return scope;
      },
    });
  } catch {
    return { ok: false, reason: "root_acquisition_failed", report: await session.close() };
  }
}
