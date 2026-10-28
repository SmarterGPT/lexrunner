import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";

import {
  assessWindowsCoordinatorSelectionConsistency,
  parseWindowsCoordinatorActiveSelectionValue,
  type WindowsCoordinatorSelectionConsistency,
} from "./windows-coordinator-active-selection.js";
import {
  observeWindowsCoordinatorActiveSelection,
  observeWindowsCoordinatorGenerationCatalog,
} from "./windows-coordinator-active-selection-reader.js";

export type WindowsCoordinatorSelectionAcquisition =
  | {
      readonly state: "assessed";
      readonly consistency: WindowsCoordinatorSelectionConsistency;
      readonly authorizesLaunch: false;
    }
  | {
      readonly state: "unavailable";
      readonly reason:
        | "selection_unavailable"
        | "selection_invalid"
        | "catalog_unavailable"
        | "metadata_unavailable"
        | "selection_changed";
      readonly authorizesLaunch: false;
    };

function readBoundedMetadata(file: string): Uint8Array {
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
      held.size > 16_384n ||
      held.dev !== before.dev ||
      held.ino !== before.ino
    )
      throw new Error("Metadata identity or size unavailable");
    const bytes = Buffer.alloc(Number(held.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(handle, bytes, offset, bytes.byteLength - offset, offset);
      if (count <= 0) throw new Error("Incomplete metadata read");
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
      throw new Error("Metadata identity changed");
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
    throw new Error("Unsupported generation root");
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
      throw new Error("Generation path unavailable");
  }
  return components[components.length - 1]!;
}

/**
 * Describes metadata in one fixed selected generation. The initial MSI has no
 * selection or catalog, so this cannot assess it as qualified. Even an assessed
 * consistent result is non-authorizing: these reads are not protected custody,
 * an atomic snapshot, SCM image binding, or a launch decision.
 */
export function observeWindowsCoordinatorSelectionAcquisition(): WindowsCoordinatorSelectionAcquisition {
  const stop = (
    reason: Extract<WindowsCoordinatorSelectionAcquisition, { state: "unavailable" }>["reason"]
  ): WindowsCoordinatorSelectionAcquisition => ({
    state: "unavailable",
    reason,
    authorizesLaunch: false,
  });
  const first = observeWindowsCoordinatorActiveSelection();
  if (first.state !== "observed") return stop("selection_unavailable");
  let generationId: string;
  try {
    generationId = parseWindowsCoordinatorActiveSelectionValue(first.selectionValue).generationId;
  } catch {
    return stop("selection_invalid");
  }
  const observedCatalog = observeWindowsCoordinatorGenerationCatalog(generationId);
  if (observedCatalog.state !== "observed") return stop("catalog_unavailable");
  let manifestBytes: Uint8Array;
  try {
    const generation = fixedGenerationDirectory(observedCatalog.systemRoot, generationId);
    manifestBytes = readBoundedMetadata(path.win32.join(generation, "generation.json"));
  } catch {
    return stop("metadata_unavailable");
  }
  const second = observeWindowsCoordinatorActiveSelection();
  if (second.state !== "observed" || second.selectionValue !== first.selectionValue)
    return stop("selection_changed");
  return {
    state: "assessed",
    consistency: assessWindowsCoordinatorSelectionConsistency({
      selectionValue: first.selectionValue,
      manifestBytes,
      catalog: observedCatalog.catalog,
    }),
    authorizesLaunch: false,
  };
}
