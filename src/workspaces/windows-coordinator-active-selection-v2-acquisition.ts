import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";

import {
  assessWindowsCoordinatorV2SelectionConsistency,
  parseWindowsCoordinatorActiveSelectionV2Value,
  type WindowsCoordinatorV2Consistency,
} from "./windows-coordinator-active-selection-v2.js";
import {
  observeWindowsCoordinatorV2ActiveSelection,
  observeWindowsCoordinatorV2GenerationCatalog,
  observeWindowsCoordinatorV2HighWater,
  type WindowsCoordinatorV2CatalogObservation,
} from "./windows-coordinator-active-selection-reader.js";

export type WindowsCoordinatorV2SelectionAcquisition =
  | {
      readonly state: "assessed";
      readonly consistency: WindowsCoordinatorV2Consistency;
      readonly authorizesLaunch: false;
    }
  | {
      readonly state: "unavailable";
      readonly reason:
        | "selection_unavailable"
        | "selection_invalid"
        | "high_water_unavailable"
        | "high_water_mismatch"
        | "high_water_changed"
        | "catalog_unavailable"
        | "metadata_unavailable"
        | "catalog_changed"
        | "selection_changed";
      readonly authorizesLaunch: false;
    };

function readBoundedManifest(file: string): Uint8Array {
  const handle = openSync(file, "r");
  try {
    const before = lstatSync(file, { bigint: true });
    const held = fstatSync(handle, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      !held.isFile() ||
      held.ino === 0n ||
      held.size <= 0n ||
      held.size > 262_144n ||
      held.dev !== before.dev ||
      held.ino !== before.ino
    )
      throw new Error("Graph manifest identity or size unavailable");
    const bytes = Buffer.alloc(Number(held.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(handle, bytes, offset, bytes.byteLength - offset, offset);
      if (count <= 0) throw new Error("Incomplete graph manifest read");
      offset += count;
    }
    const after = lstatSync(file, { bigint: true });
    const heldAfter = fstatSync(handle, { bigint: true });
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      after.dev !== held.dev ||
      after.ino !== held.ino ||
      heldAfter.dev !== held.dev ||
      heldAfter.ino !== held.ino ||
      !heldAfter.isFile() ||
      heldAfter.size !== held.size
    )
      throw new Error("Graph manifest identity changed");
    return bytes;
  } finally {
    closeSync(handle);
  }
}

function fixedGenerationDirectory(systemRoot: string, generationId: string): string {
  if (
    !/^[A-Za-z]:\\/u.test(systemRoot) ||
    path.win32.normalize(systemRoot) !== systemRoot ||
    !/^[a-f0-9]{64}$/u.test(generationId)
  )
    throw new Error("Unsupported v2 generation root");
  const volumeRoot = path.win32.parse(systemRoot).root;
  const components = [
    volumeRoot,
    path.win32.join(volumeRoot, "Program Files"),
    path.win32.join(volumeRoot, "Program Files", "SmarterGPT.LexRunner.WindowsCoordinator"),
    path.win32.join(
      volumeRoot,
      "Program Files",
      "SmarterGPT.LexRunner.WindowsCoordinator",
      "generations"
    ),
    path.win32.join(
      volumeRoot,
      "Program Files",
      "SmarterGPT.LexRunner.WindowsCoordinator",
      "generations",
      generationId
    ),
  ];
  for (const component of components) {
    const observed = lstatSync(component, { bigint: true });
    if (
      !observed.isDirectory() ||
      observed.isSymbolicLink() ||
      observed.ino === 0n ||
      realpathSync.native(component).toLowerCase() !== component.toLowerCase()
    )
      throw new Error("V2 generation path unavailable");
  }
  return components[components.length - 1]!;
}

function sameCatalog(
  first: Extract<WindowsCoordinatorV2CatalogObservation, { state: "observed" }>,
  second: Extract<WindowsCoordinatorV2CatalogObservation, { state: "observed" }>
): boolean {
  return (
    first.systemRoot === second.systemRoot &&
    first.catalog.GraphDigest === second.catalog.GraphDigest &&
    first.catalog.ManifestDigest === second.catalog.ManifestDigest &&
    first.catalog.ServiceImageDigest === second.catalog.ServiceImageDigest &&
    first.catalog.State === second.catalog.State &&
    first.catalog.ServiceName === second.catalog.ServiceName
  );
}

/**
 * Read-only, source-only observation. Fixed-path and re-read checks do not
 * establish protected registry/loader custody or an atomic selection snapshot.
 */
export function observeWindowsCoordinatorV2SelectionAcquisition(): WindowsCoordinatorV2SelectionAcquisition {
  const stop = (
    reason: Extract<WindowsCoordinatorV2SelectionAcquisition, { state: "unavailable" }>["reason"]
  ): WindowsCoordinatorV2SelectionAcquisition => ({
    state: "unavailable",
    reason,
    authorizesLaunch: false,
  });
  const first = observeWindowsCoordinatorV2ActiveSelection();
  if (first.state !== "observed") return stop("selection_unavailable");
  let generationId: string;
  let revision: number;
  try {
    const selection = parseWindowsCoordinatorActiveSelectionV2Value(first.selectionValue);
    generationId = selection.generationId;
    revision = selection.revision;
  } catch {
    return stop("selection_invalid");
  }
  const highWater = observeWindowsCoordinatorV2HighWater();
  if (highWater.state !== "observed") return stop("high_water_unavailable");
  if (highWater.revision !== revision) return stop("high_water_mismatch");
  const catalog = observeWindowsCoordinatorV2GenerationCatalog(generationId);
  if (catalog.state !== "observed") return stop("catalog_unavailable");
  let manifestBytes: Uint8Array;
  try {
    const generation = fixedGenerationDirectory(catalog.systemRoot, generationId);
    manifestBytes = readBoundedManifest(path.win32.join(generation, "generation-graph.json"));
  } catch {
    return stop("metadata_unavailable");
  }
  const catalogAfter = observeWindowsCoordinatorV2GenerationCatalog(generationId);
  if (catalogAfter.state !== "observed" || !sameCatalog(catalog, catalogAfter))
    return stop("catalog_changed");
  const selectionAfter = observeWindowsCoordinatorV2ActiveSelection();
  if (selectionAfter.state !== "observed" || selectionAfter.selectionValue !== first.selectionValue)
    return stop("selection_changed");
  const highWaterAfter = observeWindowsCoordinatorV2HighWater();
  if (highWaterAfter.state !== "observed" || highWaterAfter.revision !== revision)
    return stop("high_water_changed");
  return {
    state: "assessed",
    consistency: assessWindowsCoordinatorV2SelectionConsistency({
      selectionValue: first.selectionValue,
      manifestBytes,
      catalog: catalog.catalog,
    }),
    authorizesLaunch: false,
  };
}
