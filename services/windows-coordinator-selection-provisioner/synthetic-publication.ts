import {
  assessWindowsCoordinatorV2SelectionConsistency,
  parseWindowsCoordinatorActiveSelectionV2Value,
  WindowsCoordinatorGenerationCatalogV2,
  type WindowsCoordinatorGenerationCatalogV2 as Catalog,
} from "../../src/workspaces/windows-coordinator-active-selection-v2.js";

/**
 * A registry-shaped injection point for an offline transaction exercise. This
 * interface does not authenticate a writer, protect a key, or write to HKLM.
 */
export interface SyntheticSelectionStore {
  listCatalogGenerationIds(): readonly string[];
  readCatalog(generationId: string): unknown;
  writeCatalog(generationId: string, catalog: Catalog): void;
  flushCatalog(generationId: string): void;
  readHighWaterRevision(): unknown;
  writeHighWaterRevision(revision: number): void;
  readActiveSelection(): unknown;
  writeActiveSelection(value: string): void;
  flushRoot(): void;
}

export interface SyntheticPublicationCandidate {
  readonly selectionValue: string;
  readonly manifestBytes: Uint8Array;
  readonly catalog: unknown;
}

export type SyntheticPublicationResult =
  | {
      readonly state: "simulated_published" | "already_published";
      readonly authorizesLaunch: false;
    }
  | {
      readonly state: "refused";
      readonly reason:
        | "invalid_candidate"
        | "not_initial_revision"
        | "recovery_required"
        | "catalog_conflict"
        | "high_water_conflict"
        | "selection_conflict";
      readonly authorizesLaunch: false;
    }
  | {
      readonly state: "uncertain";
      readonly phase:
        | "preflight"
        | "catalog_write"
        | "catalog_flush"
        | "catalog_readback"
        | "high_water_write"
        | "high_water_flush"
        | "high_water_readback"
        | "selection_write"
        | "selection_flush"
        | "final_readback";
      readonly authorizesLaunch: false;
    };

type Phase = Extract<SyntheticPublicationResult, { state: "uncertain" }>["phase"];
type Refusal = Extract<SyntheticPublicationResult, { state: "refused" }>["reason"];

const refuse = (reason: Refusal): SyntheticPublicationResult => ({
  state: "refused",
  reason,
  authorizesLaunch: false,
});

function sameCatalog(value: unknown, expected: Catalog): boolean {
  const parsed = WindowsCoordinatorGenerationCatalogV2.safeParse(value);
  if (!parsed.success) return false;
  return (
    parsed.data.GraphDigest === expected.GraphDigest &&
    parsed.data.ManifestDigest === expected.ManifestDigest &&
    parsed.data.ServiceImageDigest === expected.ServiceImageDigest &&
    parsed.data.State === expected.State &&
    parsed.data.ServiceName === expected.ServiceName
  );
}

function onlyCatalogIs(store: SyntheticSelectionStore, generationId: string): boolean {
  const ids = store.listCatalogGenerationIds();
  return Array.isArray(ids) && ids.length === 1 && ids[0] === generationId;
}

/**
 * Simulate only the first publication (revision 1). A partial transaction is
 * never retried by this entry point. Explicit recovery is a separate call and
 * must be gated by a future installed administrator/provenance boundary.
 */
export function simulateInitialSelectionPublication(
  store: SyntheticSelectionStore,
  candidate: SyntheticPublicationCandidate
): SyntheticPublicationResult {
  return simulatePublication(store, candidate, false);
}

/**
 * Exercise an explicit recovery of the exact partial candidate. Calling this
 * function is not evidence of administrator identity or artifact approval.
 */
export function simulateExplicitSelectionRecovery(
  store: SyntheticSelectionStore,
  candidate: SyntheticPublicationCandidate
): SyntheticPublicationResult {
  return simulatePublication(store, candidate, true);
}

function simulatePublication(
  store: SyntheticSelectionStore,
  candidate: SyntheticPublicationCandidate,
  explicitRecovery: boolean
): SyntheticPublicationResult {
  let selection: ReturnType<typeof parseWindowsCoordinatorActiveSelectionV2Value>;
  let selectionValue: string;
  let catalog: Catalog;
  try {
    selectionValue = candidate.selectionValue;
    const suppliedManifest = candidate.manifestBytes;
    const suppliedCatalog = candidate.catalog;
    if (typeof selectionValue !== "string" || !(suppliedManifest instanceof Uint8Array))
      return refuse("invalid_candidate");
    const manifestBytes = Uint8Array.from(suppliedManifest);
    catalog = Object.freeze(WindowsCoordinatorGenerationCatalogV2.parse(suppliedCatalog));
    const consistency = assessWindowsCoordinatorV2SelectionConsistency({
      selectionValue,
      manifestBytes,
      catalog,
    });
    if (consistency.state !== "consistent") return refuse("invalid_candidate");
    selection = parseWindowsCoordinatorActiveSelectionV2Value(selectionValue);
  } catch {
    return refuse("invalid_candidate");
  }
  if (selection.revision !== 1) return refuse("not_initial_revision");
  const generationId = selection.generationId;

  let phase: Phase = "preflight";
  try {
    const catalogIds = store.listCatalogGenerationIds();
    const observedCatalog = store.readCatalog(generationId);
    const highWater = store.readHighWaterRevision();
    const active = store.readActiveSelection();
    if (
      !Array.isArray(catalogIds) ||
      catalogIds.length > 1 ||
      catalogIds.some((id) => !/^[a-f0-9]{64}$/u.test(id) || id !== generationId) ||
      (catalogIds.length === 0) !== (observedCatalog === null)
    )
      return refuse("catalog_conflict");
    if (observedCatalog !== null && !sameCatalog(observedCatalog, catalog))
      return refuse("catalog_conflict");
    if (highWater !== 0 && highWater !== 1) return refuse("high_water_conflict");
    if (active !== null && active !== selectionValue) return refuse("selection_conflict");
    const selectionAlreadyPresent = active === selectionValue;
    if (selectionAlreadyPresent && (highWater !== 1 || observedCatalog === null))
      return refuse("high_water_conflict");
    if (highWater === 1 && observedCatalog === null) return refuse("catalog_conflict");
    if (observedCatalog !== null && !explicitRecovery) return refuse("recovery_required");
    if (highWater === 1 && !explicitRecovery) return refuse("recovery_required");

    if (observedCatalog === null) {
      phase = "catalog_write";
      store.writeCatalog(generationId, { ...catalog });
    }
    // A matching in-memory catalog may not have survived an interrupted flush.
    // Explicit recovery must flush it again before advancing high-water.
    phase = "catalog_flush";
    store.flushCatalog(generationId);
    phase = "catalog_readback";
    if (
      !onlyCatalogIs(store, generationId) ||
      !sameCatalog(store.readCatalog(generationId), catalog) ||
      store.readHighWaterRevision() !== highWater ||
      store.readActiveSelection() !== active
    )
      return { state: "uncertain", phase, authorizesLaunch: false };

    if (highWater === 0) {
      phase = "high_water_write";
      store.writeHighWaterRevision(1);
      phase = "high_water_flush";
      store.flushRoot();
    }
    phase = "high_water_readback";
    if (
      !onlyCatalogIs(store, generationId) ||
      store.readHighWaterRevision() !== 1 ||
      store.readActiveSelection() !== active ||
      !sameCatalog(store.readCatalog(generationId), catalog)
    )
      return { state: "uncertain", phase, authorizesLaunch: false };

    if (!selectionAlreadyPresent) {
      phase = "selection_write";
      store.writeActiveSelection(selectionValue);
    }
    phase = "selection_flush";
    store.flushRoot();
    phase = "final_readback";
    if (
      !onlyCatalogIs(store, generationId) ||
      store.readHighWaterRevision() !== 1 ||
      store.readActiveSelection() !== selectionValue ||
      !sameCatalog(store.readCatalog(generationId), catalog)
    )
      return { state: "uncertain", phase, authorizesLaunch: false };
    return {
      state: selectionAlreadyPresent ? "already_published" : "simulated_published",
      authorizesLaunch: false,
    };
  } catch {
    // A write or flush may have taken effect before throwing. Never infer a
    // no-effect result, automatically retry, or claim a durable publication.
    return { state: "uncertain", phase, authorizesLaunch: false };
  }
}
