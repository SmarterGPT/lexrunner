import { createHash } from "node:crypto";
import { z } from "zod";

import { WINDOWS_BOUNDARY_PROTOCOL_VERSION } from "./windows-boundary-protocol.js";
import { WINDOWS_REMOVAL_VERSION } from "./windows-removal-protocol.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const sourceRevision = z.string().regex(/^[a-f0-9]{40}$/u);
const generationState = z.enum(["provisioned-unqualified", "qualified"]);
const profile = z.literal("windows-helper-msi-direct/1");
const source = z.strictObject({
  repository: z.literal("SmarterGPT/lexrunner"),
  revision: sourceRevision,
  signingRunId: z.number().int().positive().safe(),
});

/**
 * Proposed content of one HKLM ActiveSelection REG_SZ value. This parser receives
 * an already decoded string; it does not read or authenticate the registry.
 */
export const WindowsHelperActiveSelection = z.strictObject({
  schemaVersion: z.literal("windows-helper-active-selection/1"),
  profile,
  generationId: sha256,
  manifestSha256: sha256,
  publisherPolicyId: z.literal("lexrunner-azure-helper-publisher/1"),
  protocolVersion: z.literal(WINDOWS_BOUNDARY_PROTOCOL_VERSION),
  removalVersion: z.literal(WINDOWS_REMOVAL_VERSION),
  source,
  revision: z.number().int().positive().safe(),
});
export type WindowsHelperActiveSelection = z.infer<typeof WindowsHelperActiveSelection>;

const GenerationManifest = z.strictObject({
  schemaVersion: z.literal("windows-helper-generation/1"),
  profile,
  generationId: sha256,
  helperVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
  helper: z.strictObject({
    file: z.literal("lexrunner-windows-boundary-helper.exe"),
    sha256,
    bytes: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024),
    architecture: z.literal("x64"),
    protocolVersion: z.literal(WINDOWS_BOUNDARY_PROTOCOL_VERSION),
    removalVersion: z.literal(WINDOWS_REMOVAL_VERSION),
  }),
  source: source.extend({ basis: z.string().min(1).max(512) }),
  publisherPolicy: z.strictObject({
    id: z.literal("lexrunner-azure-helper-publisher/1"),
    subject: z.string().min(1).max(512),
    identityEku: z.literal("1.3.6.1.4.1.311.97.664386437.910814316.510550690.722133748"),
  }),
  state: generationState,
  productionReady: z.boolean(),
});

const GenerationCatalog = z.strictObject({
  ManifestDigest: sha256,
  State: generationState,
  ProductCode: z.string().regex(/^\{[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}\}$/u),
});

const InstallationMarker = z.strictObject({
  schemaVersion: z.literal("windows-helper-installation/1"),
  generationId: sha256,
  manifestSha256: sha256,
  state: generationState,
  productionReady: z.boolean(),
});

const decoder = new TextDecoder("utf-8", { fatal: true });

/** Exact, compact, sorted JSON rejects duplicate keys and alternate encodings. */
export function parseWindowsHelperActiveSelectionValue(
  value: string
): WindowsHelperActiveSelection {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 4096 || value.length === 0)
    throw new Error("Invalid ActiveSelection value size");
  const parsed = WindowsHelperActiveSelection.parse(JSON.parse(value) as unknown);
  if (JSON.stringify(sortJson(parsed)) !== value)
    throw new Error("Noncanonical ActiveSelection value");
  return parsed;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortJson(record[key])])
    );
  }
  return value;
}

function parseBoundedJson(bytes: Uint8Array, maxBytes: number): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > maxBytes)
    throw new Error("Invalid metadata size");
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    throw new Error("Unexpected metadata BOM");
  const value = decoder.decode(bytes);
  const parsed = JSON.parse(value) as unknown;
  // Keep the installer's authored key order while rejecting duplicate keys,
  // alternate escapes and number encodings that JSON.parse would collapse.
  if (JSON.stringify(parsed) !== compactJson(value)) throw new Error("Ambiguous metadata JSON");
  return parsed;
}

function compactJson(value: string): string {
  let quoted = false;
  let escaped = false;
  let result = "";
  for (const character of value) {
    if (quoted) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') {
      quoted = true;
      result += character;
    } else if (!/\s/u.test(character)) {
      result += character;
    }
  }
  return result;
}

export type WindowsHelperSelectionConsistencyReason =
  | "selection_absent"
  | "selection_invalid"
  | "manifest_absent"
  | "manifest_invalid"
  | "manifest_digest_mismatch"
  | "selection_manifest_mismatch"
  | "generation_unqualified"
  | "catalog_invalid"
  | "catalog_mismatch"
  | "installation_marker_absent"
  | "installation_marker_invalid"
  | "installation_marker_mismatch";

export type WindowsHelperSelectionConsistency =
  | { readonly state: "consistent"; readonly authorizesLaunch: false }
  | {
      readonly state: "inconsistent";
      readonly reason: WindowsHelperSelectionConsistencyReason;
      readonly authorizesLaunch: false;
    };

/**
 * Compare only caller-supplied values. Even a `consistent` result does not prove
 * a protected HKLM read, authorized publisher, installed bytes, ACLs, loader
 * closure, actual process identity or permission to launch the helper.
 */
export function assessWindowsHelperSelectionConsistency(input: {
  readonly selectionValue: string | null;
  readonly manifestBytes: Uint8Array | null;
  readonly catalog: unknown;
  readonly installationMarkerBytes: Uint8Array | null;
}): WindowsHelperSelectionConsistency {
  const stop = (
    reason: WindowsHelperSelectionConsistencyReason
  ): WindowsHelperSelectionConsistency => ({
    state: "inconsistent",
    reason,
    authorizesLaunch: false,
  });
  if (input.selectionValue === null) return stop("selection_absent");
  let selection: WindowsHelperActiveSelection;
  try {
    selection = parseWindowsHelperActiveSelectionValue(input.selectionValue);
  } catch {
    return stop("selection_invalid");
  }
  if (input.manifestBytes === null) return stop("manifest_absent");
  let manifest: z.infer<typeof GenerationManifest>;
  try {
    manifest = GenerationManifest.parse(parseBoundedJson(input.manifestBytes, 16_384));
  } catch {
    return stop("manifest_invalid");
  }
  const digest = createHash("sha256").update(input.manifestBytes).digest("hex");
  if (digest !== selection.manifestSha256) return stop("manifest_digest_mismatch");
  if (
    manifest.generationId !== selection.generationId ||
    manifest.helper.sha256 !== selection.generationId ||
    manifest.profile !== selection.profile ||
    manifest.helper.protocolVersion !== selection.protocolVersion ||
    manifest.helper.removalVersion !== selection.removalVersion ||
    manifest.publisherPolicy.id !== selection.publisherPolicyId ||
    manifest.source.repository !== selection.source.repository ||
    manifest.source.revision !== selection.source.revision ||
    manifest.source.signingRunId !== selection.source.signingRunId
  )
    return stop("selection_manifest_mismatch");
  // These are matching claims in supplied metadata, not evidence of qualification.
  if (manifest.state !== "qualified" || manifest.productionReady !== true)
    return stop("generation_unqualified");
  const catalog = GenerationCatalog.safeParse(input.catalog);
  if (!catalog.success) return stop("catalog_invalid");
  if (catalog.data.ManifestDigest !== digest || catalog.data.State !== manifest.state)
    return stop("catalog_mismatch");
  if (input.installationMarkerBytes === null) return stop("installation_marker_absent");
  let marker: z.infer<typeof InstallationMarker>;
  try {
    marker = InstallationMarker.parse(parseBoundedJson(input.installationMarkerBytes, 4096));
  } catch {
    return stop("installation_marker_invalid");
  }
  if (
    marker.generationId !== selection.generationId ||
    marker.manifestSha256 !== digest ||
    marker.state !== manifest.state ||
    marker.productionReady !== manifest.productionReady
  )
    return stop("installation_marker_mismatch");
  return { state: "consistent", authorizesLaunch: false };
}
