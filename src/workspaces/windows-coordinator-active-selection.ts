import { createHash } from "node:crypto";

import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const serviceVersion = z.string().regex(/^\d+\.\d+\.\d+$/u);
const profile = z.literal("windows-coordinator-service-msi/1");
const serviceName = z.literal("LexRunnerCoordinator");
const generationState = z.enum(["provisioned-unqualified", "qualified"]);

/**
 * Proposed content of one distinct coordinator HKLM ActiveSelection value.
 * Parsing supplied text does not authenticate its registry source or authorize
 * a service/client launch.
 */
export const WindowsCoordinatorActiveSelection = z.strictObject({
  schemaVersion: z.literal("windows-coordinator-active-selection/1"),
  profile,
  generationId: sha256,
  manifestSha256: sha256,
  serviceImageSha256: sha256,
  serviceName,
  serviceVersion,
  protocolVersion: z.literal("1.0.0"),
  revision: z.number().int().positive().safe(),
});
export type WindowsCoordinatorActiveSelection = z.infer<typeof WindowsCoordinatorActiveSelection>;

const GenerationManifest = z.strictObject({
  schemaVersion: z.literal("lexrunner-windows-coordinator-generation/1"),
  profile,
  generationId: sha256,
  serviceName,
  serviceImageSha256: sha256,
  serviceVersion,
  state: generationState,
  productionReady: z.boolean(),
});

/** Proposed post-install catalog; the initial MSI does not author this key. */
const GenerationCatalog = z.strictObject({
  ManifestDigest: sha256,
  ImageDigest: sha256,
  State: generationState,
  ServiceName: serviceName,
});

const decoder = new TextDecoder("utf-8", { fatal: true });

/** Exact compact, sorted JSON rejects duplicate keys and alternate encodings. */
export function parseWindowsCoordinatorActiveSelectionValue(
  value: string
): WindowsCoordinatorActiveSelection {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 4096)
    throw new Error("Invalid coordinator ActiveSelection value size");
  const selection = WindowsCoordinatorActiveSelection.parse(JSON.parse(value) as unknown);
  if (
    JSON.stringify(sortJson(selection)) !== value ||
    selection.generationId !== selection.serviceImageSha256
  )
    throw new Error("Noncanonical coordinator ActiveSelection value");
  return selection;
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

function parseBoundedManifest(bytes: Uint8Array): z.infer<typeof GenerationManifest> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 16_384)
    throw new Error("Invalid coordinator manifest size");
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    throw new Error("Unexpected coordinator manifest BOM");
  const text = decoder.decode(bytes);
  const parsed = JSON.parse(text) as unknown;
  if (JSON.stringify(parsed) !== compactJson(text))
    throw new Error("Ambiguous coordinator manifest JSON");
  return GenerationManifest.parse(parsed);
}

export type WindowsCoordinatorSelectionConsistencyReason =
  | "selection_absent"
  | "selection_invalid"
  | "manifest_absent"
  | "manifest_invalid"
  | "manifest_digest_mismatch"
  | "selection_manifest_mismatch"
  | "generation_unqualified"
  | "catalog_invalid"
  | "catalog_mismatch";

export type WindowsCoordinatorSelectionConsistency =
  | { readonly state: "consistent"; readonly authorizesLaunch: false }
  | {
      readonly state: "inconsistent";
      readonly reason: WindowsCoordinatorSelectionConsistencyReason;
      readonly authorizesLaunch: false;
    };

/**
 * Structural comparison of supplied data. Even consistent, caller-forged
 * values prove neither protected provisioning nor actual SCM/image identity.
 */
export function assessWindowsCoordinatorSelectionConsistency(input: {
  readonly selectionValue: string | null;
  readonly manifestBytes: Uint8Array | null;
  readonly catalog: unknown;
}): WindowsCoordinatorSelectionConsistency {
  const stop = (
    reason: WindowsCoordinatorSelectionConsistencyReason
  ): WindowsCoordinatorSelectionConsistency => ({
    state: "inconsistent",
    reason,
    authorizesLaunch: false,
  });
  if (input.selectionValue === null) return stop("selection_absent");
  let selection: WindowsCoordinatorActiveSelection;
  try {
    selection = parseWindowsCoordinatorActiveSelectionValue(input.selectionValue);
  } catch {
    return stop("selection_invalid");
  }
  if (input.manifestBytes === null) return stop("manifest_absent");
  let manifest: z.infer<typeof GenerationManifest>;
  try {
    manifest = parseBoundedManifest(input.manifestBytes);
  } catch {
    return stop("manifest_invalid");
  }
  const digest = createHash("sha256").update(input.manifestBytes).digest("hex");
  if (digest !== selection.manifestSha256) return stop("manifest_digest_mismatch");
  if (
    manifest.generationId !== selection.generationId ||
    manifest.serviceImageSha256 !== selection.serviceImageSha256 ||
    manifest.serviceName !== selection.serviceName ||
    manifest.serviceVersion !== selection.serviceVersion ||
    manifest.profile !== selection.profile
  )
    return stop("selection_manifest_mismatch");
  // Matching claims in supplied metadata do not establish qualification.
  if (manifest.state !== "qualified" || !manifest.productionReady)
    return stop("generation_unqualified");
  const catalog = GenerationCatalog.safeParse(input.catalog);
  if (!catalog.success) return stop("catalog_invalid");
  if (
    catalog.data.ManifestDigest !== digest ||
    catalog.data.ImageDigest !== selection.serviceImageSha256 ||
    catalog.data.State !== manifest.state ||
    catalog.data.ServiceName !== selection.serviceName
  )
    return stop("catalog_mismatch");
  return { state: "consistent", authorizesLaunch: false };
}
