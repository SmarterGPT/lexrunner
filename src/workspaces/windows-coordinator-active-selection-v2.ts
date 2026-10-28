import { createHash } from "node:crypto";

import { z } from "zod";

import { parseWindowsCoordinatorGenerationGraph } from "./windows-coordinator-generation-graph.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const state = z.enum(["provisioned-unqualified", "qualified"]);

/**
 * Proposed v2 value for the distinct coordinator HKLM ActiveSelection key.
 * A generation ID names the graph digest, not one image in the graph.
 */
export const WindowsCoordinatorActiveSelectionV2 = z
  .strictObject({
    schemaVersion: z.literal("windows-coordinator-active-selection/2"),
    profile: z.literal("windows-coordinator-service-msi/2"),
    generationId: digest,
    graphDigest: digest,
    manifestSha256: digest,
    serviceImageSha256: digest,
    serviceName: z.literal("LexRunnerCoordinator"),
    coordinatorProtocolVersion: z.literal("1.0.0"),
    revision: z.number().int().positive().safe(),
  })
  .refine((value) => value.generationId === value.graphDigest, {
    message: "Generation ID must identify the graph",
  });
export type WindowsCoordinatorActiveSelectionV2 = z.infer<
  typeof WindowsCoordinatorActiveSelectionV2
>;

/** Proposed catalog rows under Generations\\<generationId>; no current MSI writes them. */
export const WindowsCoordinatorGenerationCatalogV2 = z.strictObject({
  GraphDigest: digest,
  ManifestDigest: digest,
  ServiceImageDigest: digest,
  State: state,
  ServiceName: z.literal("LexRunnerCoordinator"),
});
export type WindowsCoordinatorGenerationCatalogV2 = z.infer<
  typeof WindowsCoordinatorGenerationCatalogV2
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

/** Exact compact JSON is needed because REG_SZ does not preserve source bytes. */
export function parseWindowsCoordinatorActiveSelectionV2Value(
  value: string
): WindowsCoordinatorActiveSelectionV2 {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 4096)
    throw new Error("Invalid v2 ActiveSelection value size");
  const selection = WindowsCoordinatorActiveSelectionV2.parse(JSON.parse(value) as unknown);
  if (JSON.stringify(sortedJson(selection)) !== value)
    throw new Error("Noncanonical v2 ActiveSelection value");
  return selection;
}

export type WindowsCoordinatorV2ConsistencyReason =
  | "selection_absent"
  | "selection_invalid"
  | "manifest_absent"
  | "manifest_invalid"
  | "manifest_digest_mismatch"
  | "selection_manifest_mismatch"
  | "catalog_invalid"
  | "catalog_mismatch"
  | "generation_unqualified";

export type WindowsCoordinatorV2Consistency =
  | { readonly state: "consistent"; readonly authorizesLaunch: false }
  | {
      readonly state: "inconsistent";
      readonly reason: WindowsCoordinatorV2ConsistencyReason;
      readonly authorizesLaunch: false;
    };

/**
 * Compare supplied bytes and values. A matching catalog is still only a claim:
 * this does not authenticate HKLM custody, installed files, SCM or rollback.
 */
export function assessWindowsCoordinatorV2SelectionConsistency(input: {
  readonly selectionValue: string | null;
  readonly manifestBytes: Uint8Array | null;
  readonly catalog: unknown;
}): WindowsCoordinatorV2Consistency {
  const stop = (
    reason: WindowsCoordinatorV2ConsistencyReason
  ): WindowsCoordinatorV2Consistency => ({
    state: "inconsistent",
    reason,
    authorizesLaunch: false,
  });
  if (input.selectionValue === null) return stop("selection_absent");
  let selection: WindowsCoordinatorActiveSelectionV2;
  try {
    selection = parseWindowsCoordinatorActiveSelectionV2Value(input.selectionValue);
  } catch {
    return stop("selection_invalid");
  }
  if (input.manifestBytes === null) return stop("manifest_absent");
  if (
    !(input.manifestBytes instanceof Uint8Array) ||
    input.manifestBytes.byteLength < 1 ||
    input.manifestBytes.byteLength > 262_144
  )
    return stop("manifest_invalid");
  if (createHash("sha256").update(input.manifestBytes).digest("hex") !== selection.manifestSha256)
    return stop("manifest_digest_mismatch");
  let parsed: ReturnType<typeof parseWindowsCoordinatorGenerationGraph>;
  try {
    parsed = parseWindowsCoordinatorGenerationGraph(input.manifestBytes, selection.manifestSha256);
  } catch {
    return stop("manifest_invalid");
  }
  const service = parsed.manifest.files.filter((file) => file.role === "service-image");
  if (
    parsed.manifest.graphDigest !== selection.graphDigest ||
    parsed.manifest.serviceName !== selection.serviceName ||
    parsed.manifest.coordinatorProtocolVersion !== selection.coordinatorProtocolVersion ||
    service.length !== 1 ||
    service[0]!.sha256 !== selection.serviceImageSha256
  )
    return stop("selection_manifest_mismatch");
  const catalog = WindowsCoordinatorGenerationCatalogV2.safeParse(input.catalog);
  if (!catalog.success) return stop("catalog_invalid");
  if (
    catalog.data.GraphDigest !== selection.graphDigest ||
    catalog.data.ManifestDigest !== selection.manifestSha256 ||
    catalog.data.ServiceImageDigest !== selection.serviceImageSha256 ||
    catalog.data.ServiceName !== selection.serviceName
  )
    return stop("catalog_mismatch");
  if (catalog.data.State !== "qualified") return stop("generation_unqualified");
  return { state: "consistent", authorizesLaunch: false };
}
