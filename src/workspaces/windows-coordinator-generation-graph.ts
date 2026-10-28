import { createHash } from "node:crypto";

import { z } from "zod";

import { WINDOWS_BOUNDARY_PROTOCOL_VERSION } from "./windows-boundary-protocol.js";
import { WINDOWS_REMOVAL_VERSION } from "./windows-removal-protocol.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const requiredRoles = [
  "service-image",
  "client-image",
  "node-image",
  "admission-entry",
  "sqlite-addon",
  "helper-image",
  "git-entry",
] as const;

/** A finite vocabulary. Adding a dependency role requires review of this contract. */
export const WindowsCoordinatorGraphRole = z.enum([
  ...requiredRoles,
  "javascript-module",
  "native-dll",
  "git-tool",
  "git-support-file",
]);
export type WindowsCoordinatorGraphRole = z.infer<typeof WindowsCoordinatorGraphRole>;

const nativeImageRoles = new Set<WindowsCoordinatorGraphRole>([
  "service-image",
  "client-image",
  "node-image",
  "helper-image",
  "git-entry",
  "git-tool",
]);
const reservedDevice = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/iu;
const componentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** This filters textual aliases only; it cannot observe filesystem reparse points. */
function safeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 240 || path.includes("\\")) return false;
  const components = path.split("/");
  if (components.length < 2 || components.length > 12) return false;
  return components.every(
    (component) =>
      component.length <= 64 &&
      componentPattern.test(component) &&
      !component.includes("..") &&
      !component.endsWith(".") &&
      !component.includes("~") &&
      !reservedDevice.test(component.split(".", 1)[0]!)
  );
}

const member = z.strictObject({
  path: z.string().refine(safeRelativePath, "Unsafe generation-relative file path"),
  role: WindowsCoordinatorGraphRole,
  sha256: digest,
  bytes: z
    .number()
    .int()
    .positive()
    .safe()
    .max(2 * 1024 * 1024 * 1024),
});
export type WindowsCoordinatorGraphMember = z.infer<typeof member>;

function validateMembers(
  files: readonly WindowsCoordinatorGraphMember[],
  context: z.RefinementCtx
): void {
  const roleCounts = new Map<string, number>();
  const names = new Set<string>();
  const directories = new Map<string, string>();
  let previous = "";
  for (const [index, file] of files.entries()) {
    const folded = file.path.toLowerCase();
    if (names.has(folded) || (previous !== "" && folded <= previous)) {
      context.addIssue({ code: "custom", message: "Duplicate or unordered generation path" });
    }
    names.add(folded);
    previous = folded;

    const parts = file.path.split("/");
    for (let part = 1; part < parts.length; part++) {
      const directory = parts.slice(0, part).join("/");
      const key = directory.toLowerCase();
      const existing = directories.get(key);
      if (existing !== undefined && existing !== directory) {
        context.addIssue({ code: "custom", message: "Directory spelling collision" });
      }
      directories.set(key, directory);
    }
    roleCounts.set(file.role, (roleCounts.get(file.role) ?? 0) + 1);
    const suffix = file.path.slice(file.path.lastIndexOf("/") + 1).toLowerCase();
    const validSuffix = nativeImageRoles.has(file.role)
      ? suffix.endsWith(".exe")
      : file.role === "sqlite-addon"
        ? suffix.endsWith(".node")
        : file.role === "native-dll"
          ? suffix.endsWith(".dll")
          : file.role === "admission-entry" || file.role === "javascript-module"
            ? /\.(?:mjs|cjs|js)$/u.test(suffix)
            : true;
    if (!validSuffix) {
      context.addIssue({
        code: "custom",
        path: [index, "path"],
        message: "Role and file suffix disagree",
      });
    }
  }
  for (const name of names) {
    if (directories.has(name)) {
      context.addIssue({ code: "custom", message: "File is also a directory prefix" });
    }
  }
  for (const role of requiredRoles) {
    if (roleCounts.get(role) !== 1) {
      context.addIssue({ code: "custom", message: `Expected one ${role} member` });
    }
  }
  for (const [role, count] of roleCounts) {
    if (requiredRoles.some((required) => required === role) && count !== 1) {
      context.addIssue({ code: "custom", message: `Repeated root role ${role}` });
    }
  }
}

const bodyShape = {
  schemaVersion: z.literal("lexrunner-windows-coordinator-generation-graph/2"),
  profile: z.literal("windows-coordinator-service-msi/2"),
  architecture: z.literal("win-x64"),
  serviceName: z.literal("LexRunnerCoordinator"),
  coordinatorProtocolVersion: z.literal("1.0.0"),
  boundaryProtocolVersion: z.literal(WINDOWS_BOUNDARY_PROTOCOL_VERSION),
  removalProtocolVersion: z.literal(WINDOWS_REMOVAL_VERSION),
  files: z.array(member).min(requiredRoles.length).max(512),
};

export const WindowsCoordinatorGenerationGraphBody = z
  .strictObject(bodyShape)
  .superRefine((value, context) => validateMembers(value.files, context));
export type WindowsCoordinatorGenerationGraphBody = z.infer<
  typeof WindowsCoordinatorGenerationGraphBody
>;

export const WindowsCoordinatorGenerationGraphManifest = z
  .strictObject({ ...bodyShape, graphDigest: digest })
  .superRefine((value, context) => validateMembers(value.files, context));
export type WindowsCoordinatorGenerationGraphManifest = z.infer<
  typeof WindowsCoordinatorGenerationGraphManifest
>;

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortedJson(record[key])])
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortedJson(value));
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The graph digest excludes itself and the distinct digest of the manifest bytes. */
export function computeWindowsCoordinatorGraphDigest(body: unknown): string {
  const parsed = WindowsCoordinatorGenerationGraphBody.parse(body);
  return sha256(`lexrunner-windows-coordinator-generation-graph/2\n${canonicalJson(parsed)}`);
}

/** Source-only authoring helper. It neither signs files nor makes them installable. */
export function createWindowsCoordinatorGenerationGraph(body: unknown): {
  readonly manifestBytes: Uint8Array;
  readonly graphDigest: string;
  readonly manifestSha256: string;
  readonly authorizesLaunch: false;
} {
  const parsed = WindowsCoordinatorGenerationGraphBody.parse(body);
  const graphDigest = computeWindowsCoordinatorGraphDigest(parsed);
  const manifestBytes = Buffer.from(canonicalJson({ ...parsed, graphDigest }), "utf8");
  return {
    manifestBytes,
    graphDigest,
    manifestSha256: sha256(manifestBytes),
    authorizesLaunch: false,
  };
}

/** Compare supplied canonical bytes and an independent expected manifest digest. */
export function parseWindowsCoordinatorGenerationGraph(
  manifestBytes: Uint8Array,
  expectedManifestSha256: string
): {
  readonly manifest: WindowsCoordinatorGenerationGraphManifest;
  readonly manifestSha256: string;
  readonly authorizesLaunch: false;
} {
  digest.parse(expectedManifestSha256);
  if (
    !(manifestBytes instanceof Uint8Array) ||
    manifestBytes.byteLength < 1 ||
    manifestBytes.byteLength > 262_144
  )
    throw new Error("Invalid generation graph manifest size");
  if (manifestBytes[0] === 0xef && manifestBytes[1] === 0xbb && manifestBytes[2] === 0xbf)
    throw new Error("Manifest BOM unsupported");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
  const manifest = WindowsCoordinatorGenerationGraphManifest.parse(JSON.parse(text) as unknown);
  if (canonicalJson(manifest) !== text) throw new Error("Noncanonical generation graph manifest");
  const { graphDigest, ...body } = manifest;
  if (computeWindowsCoordinatorGraphDigest(body) !== graphDigest)
    throw new Error("Generation graph digest mismatch");
  const manifestSha256 = sha256(manifestBytes);
  if (manifestSha256 !== expectedManifestSha256)
    throw new Error("Generation graph manifest digest mismatch");
  return { manifest, manifestSha256, authorizesLaunch: false };
}

/** Byte comparison fixture; this does not inspect installed ACLs, reparse points or loader activity. */
export function verifyWindowsCoordinatorGraphBytes(
  manifestBytes: Uint8Array,
  expectedManifestSha256: string,
  artifacts: readonly { readonly path: string; readonly bytes: Uint8Array }[]
): {
  readonly graphDigest: string;
  readonly manifestSha256: string;
  readonly authorizesLaunch: false;
} {
  const parsed = parseWindowsCoordinatorGenerationGraph(manifestBytes, expectedManifestSha256);
  if (artifacts.length !== parsed.manifest.files.length)
    throw new Error("Generation graph artifact count mismatch");
  const byPath = new Map<string, Uint8Array>();
  for (const artifact of artifacts) {
    if (!safeRelativePath(artifact.path) || !(artifact.bytes instanceof Uint8Array))
      throw new Error("Invalid generation graph artifact");
    const key = artifact.path.toLowerCase();
    if (byPath.has(key)) throw new Error("Duplicate generation graph artifact");
    byPath.set(key, artifact.bytes);
  }
  for (const file of parsed.manifest.files) {
    const bytes = byPath.get(file.path.toLowerCase());
    if (
      bytes === undefined ||
      artifacts.find((artifact) => artifact.path.toLowerCase() === file.path.toLowerCase())
        ?.path !== file.path ||
      bytes.byteLength !== file.bytes ||
      sha256(bytes) !== file.sha256
    )
      throw new Error(`Generation graph artifact mismatch: ${file.path}`);
  }
  return {
    graphDigest: parsed.manifest.graphDigest,
    manifestSha256: parsed.manifestSha256,
    authorizesLaunch: false,
  };
}
