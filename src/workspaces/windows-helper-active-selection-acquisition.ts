import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";

import {
  assessWindowsHelperSelectionConsistency,
  parseWindowsHelperActiveSelectionValue,
  type WindowsHelperSelectionConsistency,
} from "./windows-helper-active-selection.js";
import {
  observeWindowsHelperActiveSelection,
  observeWindowsHelperGenerationCatalog,
} from "./windows-helper-active-selection-reader.js";

export type WindowsHelperSelectionAcquisition =
  | {
      readonly state: "assessed";
      readonly consistency: WindowsHelperSelectionConsistency;
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

function readBoundedMetadata(file: string, limit: number): Uint8Array {
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
      held.size > BigInt(limit) ||
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
    throw new Error("Unsupported installed generation root");
  // The first observed direct-launch profile uses Program Files on the same
  // volume as Windows. A redirected Program Files location fails closed.
  const volumeRoot = path.win32.parse(systemRoot).root;
  const programFiles = path.win32.join(volumeRoot, "Program Files");
  const application = path.win32.join(programFiles, "SmarterGPT.LexRunner.WindowsHelper");
  const generations = path.win32.join(application, "generations");
  const generation = path.win32.join(generations, generationId);
  for (const component of [volumeRoot, programFiles, application, generations, generation]) {
    const observed = lstatSync(component, { bigint: true });
    if (
      !observed.isDirectory() ||
      observed.isSymbolicLink() ||
      observed.ino === 0n ||
      realpathSync.native(component).toLowerCase() !== component.toLowerCase()
    )
      throw new Error("Installed generation path unavailable");
  }
  return generation;
}

/**
 * Read only the selected fixed generation, then compare supplied metadata with
 * the existing consistency contract. Every result remains non-authorizing:
 * Node path reads and a repeated selection observation are not protected
 * registry custody, an atomic snapshot, or actual child/loader binding.
 */
export function observeWindowsHelperSelectionAcquisition(): WindowsHelperSelectionAcquisition {
  const stop = (
    reason: Extract<WindowsHelperSelectionAcquisition, { state: "unavailable" }>["reason"]
  ): WindowsHelperSelectionAcquisition => ({
    state: "unavailable",
    reason,
    authorizesLaunch: false,
  });
  const first = observeWindowsHelperActiveSelection();
  if (first.state !== "observed") return stop("selection_unavailable");
  let generationId: string;
  try {
    generationId = parseWindowsHelperActiveSelectionValue(first.selectionValue).generationId;
  } catch {
    return stop("selection_invalid");
  }
  const observedCatalog = observeWindowsHelperGenerationCatalog(generationId);
  if (observedCatalog.state !== "observed") return stop("catalog_unavailable");
  let manifestBytes: Uint8Array;
  let installationMarkerBytes: Uint8Array;
  try {
    const generation = fixedGenerationDirectory(observedCatalog.systemRoot, generationId);
    manifestBytes = readBoundedMetadata(path.win32.join(generation, "generation.json"), 16_384);
    installationMarkerBytes = readBoundedMetadata(
      path.win32.join(generation, "installed.json"),
      4096
    );
  } catch {
    return stop("metadata_unavailable");
  }
  const second = observeWindowsHelperActiveSelection();
  if (second.state !== "observed" || second.selectionValue !== first.selectionValue)
    return stop("selection_changed");
  return {
    state: "assessed",
    consistency: assessWindowsHelperSelectionConsistency({
      selectionValue: first.selectionValue,
      manifestBytes,
      catalog: observedCatalog.catalog,
      installationMarkerBytes,
    }),
    authorizesLaunch: false,
  };
}
