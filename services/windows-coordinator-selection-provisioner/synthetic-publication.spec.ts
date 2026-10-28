import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createWindowsCoordinatorGenerationGraph } from "../../src/workspaces/windows-coordinator-generation-graph.js";
import { WINDOWS_BOUNDARY_PROTOCOL_VERSION } from "../../src/workspaces/windows-boundary-protocol.js";
import { WINDOWS_REMOVAL_VERSION } from "../../src/workspaces/windows-removal-protocol.js";
import {
  simulateExplicitSelectionRecovery,
  simulateInitialSelectionPublication,
  type SyntheticPublicationCandidate,
  type SyntheticSelectionStore,
} from "./synthetic-publication.js";

const roots = [
  ["bin/lexrunner-windows-boundary-helper.exe", "helper-image"],
  ["client/lexrunner-windows-coordinator-client.exe", "client-image"],
  ["git/cmd/git.exe", "git-entry"],
  ["node/better_sqlite3.node", "sqlite-addon"],
  ["node/node.exe", "node-image"],
  ["node/private-admission-worker.mjs", "admission-entry"],
  ["service/LexRunner.WindowsCoordinator.Service.exe", "service-image"],
] as const;

function candidate(seed = "first", revision = 1): SyntheticPublicationCandidate {
  const files = roots.map(([path, role]) => {
    const bytes = Buffer.from(`${seed}:${path}`, "utf8");
    return {
      path,
      role,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
  });
  const graph = createWindowsCoordinatorGenerationGraph({
    schemaVersion: "lexrunner-windows-coordinator-generation-graph/2",
    profile: "windows-coordinator-service-msi/2",
    architecture: "win-x64",
    serviceName: "LexRunnerCoordinator",
    coordinatorProtocolVersion: "1.0.0",
    boundaryProtocolVersion: WINDOWS_BOUNDARY_PROTOCOL_VERSION,
    removalProtocolVersion: WINDOWS_REMOVAL_VERSION,
    files,
  });
  const serviceImageSha256 = files.find((file) => file.role === "service-image")!.sha256;
  const selection = {
    schemaVersion: "windows-coordinator-active-selection/2",
    profile: "windows-coordinator-service-msi/2",
    generationId: graph.graphDigest,
    graphDigest: graph.graphDigest,
    manifestSha256: graph.manifestSha256,
    serviceImageSha256,
    serviceName: "LexRunnerCoordinator",
    coordinatorProtocolVersion: "1.0.0",
    revision,
  };
  return {
    selectionValue: JSON.stringify(
      Object.fromEntries(Object.entries(selection).sort(([a], [b]) => a.localeCompare(b)))
    ),
    manifestBytes: graph.manifestBytes,
    catalog: {
      GraphDigest: graph.graphDigest,
      ManifestDigest: graph.manifestSha256,
      ServiceImageDigest: serviceImageSha256,
      State: "qualified",
      ServiceName: "LexRunnerCoordinator",
    },
  };
}

type Snapshot = {
  catalogs: Record<string, unknown>;
  highWater: unknown;
  selection: unknown;
};

function copy(snapshot: Snapshot): Snapshot {
  return structuredClone(snapshot);
}

class MemoryRegistry implements SyntheticSelectionStore {
  current: Snapshot = { catalogs: {}, highWater: 0, selection: null };
  durable = copy(this.current);
  readonly effects: string[] = [];
  failAfter: string | null = null;
  private rootFlushes = 0;

  private effected(name: string): void {
    this.effects.push(name);
    if (this.failAfter === name) {
      this.failAfter = null;
      throw new Error("simulated_interruption_after_effect");
    }
  }

  listCatalogGenerationIds(): readonly string[] {
    return Object.keys(this.current.catalogs);
  }

  readCatalog(generationId: string): unknown {
    return this.current.catalogs[generationId] ?? null;
  }

  writeCatalog(generationId: string, catalog: unknown): void {
    this.current.catalogs[generationId] = structuredClone(catalog);
    this.effected("catalog_write");
  }

  flushCatalog(generationId: string): void {
    this.durable.catalogs[generationId] = structuredClone(this.current.catalogs[generationId]);
    this.effected("catalog_flush");
  }

  readHighWaterRevision(): unknown {
    return this.current.highWater;
  }

  writeHighWaterRevision(revision: number): void {
    this.current.highWater = revision;
    this.effected("high_water_write");
  }

  readActiveSelection(): unknown {
    return this.current.selection;
  }

  writeActiveSelection(value: string): void {
    this.current.selection = value;
    this.effected("selection_write");
  }

  flushRoot(): void {
    this.durable.highWater = this.current.highWater;
    this.durable.selection = this.current.selection;
    this.rootFlushes++;
    this.effected(`root_flush_${this.rootFlushes}`);
  }

  crash(): void {
    this.current = copy(this.durable);
  }
}

describe("source-only Windows selection publication transaction", () => {
  it("flushes catalog, high-water, then selection; every result stays non-authorizing", () => {
    const store = new MemoryRegistry();
    const input = candidate();
    expect(simulateInitialSelectionPublication(store, input)).toEqual({
      state: "simulated_published",
      authorizesLaunch: false,
    });
    expect(store.effects).toEqual([
      "catalog_write",
      "catalog_flush",
      "high_water_write",
      "root_flush_1",
      "selection_write",
      "root_flush_2",
    ]);
    store.crash();
    expect(store.current).toEqual(store.durable);
    expect(store.current.highWater).toBe(1);
    expect(store.current.selection).toBe(input.selectionValue);
    const count = store.effects.length;
    expect(simulateInitialSelectionPublication(store, input)).toEqual({
      state: "refused",
      reason: "recovery_required",
      authorizesLaunch: false,
    });
    expect(store.effects).toHaveLength(count);
    expect(simulateExplicitSelectionRecovery(store, input)).toEqual({
      state: "already_published",
      authorizesLaunch: false,
    });
    expect(store.effects.slice(count)).toEqual(["catalog_flush", "root_flush_3"]);
  });

  it.each([
    ["catalog_write", "catalog_write"],
    ["catalog_flush", "catalog_flush"],
    ["high_water_write", "high_water_write"],
    ["root_flush_1", "high_water_flush"],
    ["selection_write", "selection_write"],
    ["root_flush_2", "selection_flush"],
  ] as const)("records interruption after %s without retry", (failure, phase) => {
    const store = new MemoryRegistry();
    const input = candidate();
    store.failAfter = failure;
    expect(simulateInitialSelectionPublication(store, input)).toEqual({
      state: "uncertain",
      phase,
      authorizesLaunch: false,
    });
    const count = store.effects.length;
    expect(store.effects.slice(count)).toEqual([]);
    store.crash();
    if (failure === "catalog_write") {
      expect(store.current.catalogs).toEqual({});
      expect(simulateExplicitSelectionRecovery(store, input)).toMatchObject({
        state: "simulated_published",
        authorizesLaunch: false,
      });
    } else if (failure === "root_flush_2") {
      expect(simulateExplicitSelectionRecovery(store, input)).toEqual({
        state: "already_published",
        authorizesLaunch: false,
      });
    } else {
      expect(simulateInitialSelectionPublication(store, input)).toEqual({
        state: "refused",
        reason: "recovery_required",
        authorizesLaunch: false,
      });
      expect(simulateExplicitSelectionRecovery(store, input)).toMatchObject({
        state: "simulated_published",
        authorizesLaunch: false,
      });
    }
    store.crash();
    expect(store.current.highWater).toBe(1);
    expect(store.current.selection).toBe(input.selectionValue);
  });

  it("flushes a matching volatile catalog during explicit recovery before advancing high-water", () => {
    const store = new MemoryRegistry();
    const input = candidate();
    store.failAfter = "catalog_write";
    expect(simulateInitialSelectionPublication(store, input)).toEqual({
      state: "uncertain",
      phase: "catalog_write",
      authorizesLaunch: false,
    });
    expect(Object.keys(store.current.catalogs)).toHaveLength(1);
    expect(store.durable.catalogs).toEqual({});
    const effects = store.effects.length;
    expect(simulateExplicitSelectionRecovery(store, input)).toEqual({
      state: "simulated_published",
      authorizesLaunch: false,
    });
    expect(store.effects.slice(effects)).toEqual([
      "catalog_flush",
      "high_water_write",
      "root_flush_1",
      "selection_write",
      "root_flush_2",
    ]);
    store.crash();
    expect(Object.keys(store.current.catalogs)).toHaveLength(1);
    expect(store.current.highWater).toBe(1);
    expect(store.current.selection).toBe(input.selectionValue);
  });

  it("flushes a visible but volatile selection before returning already-published", () => {
    const store = new MemoryRegistry();
    const input = candidate();
    store.failAfter = "selection_write";
    expect(simulateInitialSelectionPublication(store, input)).toEqual({
      state: "uncertain",
      phase: "selection_write",
      authorizesLaunch: false,
    });
    expect(store.current.selection).toBe(input.selectionValue);
    expect(store.durable.selection).toBeNull();
    const count = store.effects.length;
    expect(simulateInitialSelectionPublication(store, input)).toEqual({
      state: "refused",
      reason: "recovery_required",
      authorizesLaunch: false,
    });
    expect(simulateExplicitSelectionRecovery(store, input)).toEqual({
      state: "already_published",
      authorizesLaunch: false,
    });
    expect(store.effects.slice(count)).toEqual(["catalog_flush", "root_flush_2"]);
    store.crash();
    expect(store.current.selection).toBe(input.selectionValue);
    expect(store.current.highWater).toBe(1);
  });

  it("snapshots mutable candidate getters and bytes once before any store effect", () => {
    const store = new MemoryRegistry();
    const input = candidate();
    const originalSelection = input.selectionValue;
    const mutableManifest = Uint8Array.from(input.manifestBytes);
    const mutableCatalog = structuredClone(input.catalog) as Record<string, unknown>;
    let selectionReads = 0;
    let manifestReads = 0;
    let catalogReads = 0;
    const supplied: SyntheticPublicationCandidate = {
      get selectionValue() {
        selectionReads++;
        return selectionReads === 1 ? originalSelection : "{}";
      },
      get manifestBytes() {
        manifestReads++;
        return manifestReads === 1 ? mutableManifest : new Uint8Array([0]);
      },
      get catalog() {
        catalogReads++;
        return catalogReads === 1 ? mutableCatalog : { State: "provisioned-unqualified" };
      },
    };
    const writeCatalog = store.writeCatalog.bind(store);
    store.writeCatalog = (generationId, catalog) => {
      mutableManifest.fill(0);
      mutableCatalog.State = "provisioned-unqualified";
      writeCatalog(generationId, catalog);
    };
    expect(simulateInitialSelectionPublication(store, supplied)).toEqual({
      state: "simulated_published",
      authorizesLaunch: false,
    });
    expect([selectionReads, manifestReads, catalogReads]).toEqual([1, 1, 1]);
    store.crash();
    expect(store.current.selection).toBe(originalSelection);
    expect(Object.values(store.current.catalogs)).toMatchObject([{ State: "qualified" }]);
  });

  it("refuses a different valid generation during recovery", () => {
    const store = new MemoryRegistry();
    const first = candidate();
    store.failAfter = "catalog_flush";
    expect(simulateInitialSelectionPublication(store, first).state).toBe("uncertain");
    store.crash();
    const effects = store.effects.length;
    expect(simulateExplicitSelectionRecovery(store, candidate("different"))).toEqual({
      state: "refused",
      reason: "catalog_conflict",
      authorizesLaunch: false,
    });
    expect(store.effects).toHaveLength(effects);
  });

  it("refuses stale selection after the protected high-water advances", () => {
    const store = new MemoryRegistry();
    const input = candidate();
    expect(simulateInitialSelectionPublication(store, input).state).toBe("simulated_published");
    store.current.highWater = 2;
    store.durable.highWater = 2;
    const effects = store.effects.length;
    expect(simulateExplicitSelectionRecovery(store, input)).toEqual({
      state: "refused",
      reason: "high_water_conflict",
      authorizesLaunch: false,
    });
    expect(store.effects).toHaveLength(effects);
  });

  it("refuses malformed high-water, conflicting selection and unknown catalog", () => {
    const input = candidate();
    for (const [change, reason] of [
      [(store: MemoryRegistry) => (store.current.highWater = "1"), "high_water_conflict"],
      [(store: MemoryRegistry) => (store.current.selection = "{}"), "selection_conflict"],
      [
        (store: MemoryRegistry) => (store.current.catalogs["a".repeat(64)] = input.catalog),
        "catalog_conflict",
      ],
      [(store: MemoryRegistry) => (store.current.highWater = 1), "catalog_conflict"],
    ] as const) {
      const store = new MemoryRegistry();
      change(store);
      expect(simulateInitialSelectionPublication(store, input)).toEqual({
        state: "refused",
        reason,
        authorizesLaunch: false,
      });
      expect(store.effects).toEqual([]);
    }
  });

  it("rejects unqualified catalog and non-initial revision without writes", () => {
    const store = new MemoryRegistry();
    const input = candidate();
    expect(
      simulateInitialSelectionPublication(store, {
        ...input,
        catalog: {
          ...(input.catalog as Record<string, unknown>),
          State: "provisioned-unqualified",
        },
      })
    ).toEqual({ state: "refused", reason: "invalid_candidate", authorizesLaunch: false });
    expect(simulateInitialSelectionPublication(store, candidate("first", 2))).toEqual({
      state: "refused",
      reason: "not_initial_revision",
      authorizesLaunch: false,
    });
    expect(
      simulateInitialSelectionPublication(store, null as unknown as SyntheticPublicationCandidate)
    ).toEqual({ state: "refused", reason: "invalid_candidate", authorizesLaunch: false });
    expect(store.effects).toEqual([]);
  });

  it("reports mismatched final readback as uncertain", () => {
    const store = new MemoryRegistry();
    const input = candidate();
    const originalFlush = store.flushRoot.bind(store);
    let flushes = 0;
    store.flushRoot = () => {
      originalFlush();
      flushes++;
      if (flushes === 2) store.current.selection = "corrupted_after_flush";
    };
    expect(simulateInitialSelectionPublication(store, input)).toEqual({
      state: "uncertain",
      phase: "final_readback",
      authorizesLaunch: false,
    });
  });
});
