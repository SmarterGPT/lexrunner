/**
 * Tests for checkpoint storage layer
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import {
  saveCheckpoint,
  loadCheckpoint,
  listCheckpoints,
  getLatestCheckpoint,
  deleteCheckpoint,
  cleanupOldCheckpoints,
  checkpointExists,
  ensureCheckpointDir,
  getCheckpointPath,
  CHECKPOINT_RETENTION_DAYS,
  MAX_CHECKPOINT_BYTES,
} from "../../../src/weave/checkpoint/storage.js";
import type { WeaveCheckpoint } from "../../../src/weave/checkpoint/types.js";
import { WeaveState } from "../../../src/weave/types.js";

describe("Checkpoint Storage", () => {
  const testDir = path.join("/tmp", "lexrunner-checkpoint-tests", Date.now().toString());

  beforeEach(() => {
    // Ensure clean test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  const createTestCheckpoint = (overrides: Partial<WeaveCheckpoint> = {}): WeaveCheckpoint => ({
    runId: "test-run-123",
    timestamp: new Date().toISOString(),
    phase: "merge",
    state: WeaveState.MERGING,
    planHash: "abc123",
    plan: { target: "main", items: [] },
    completedItems: ["item1", "item2"],
    pendingItems: ["item3"],
    failedItems: [],
    currentBatchIndex: 0,
    totalBatches: 2,
    successfulMerges: 2,
    failedMerges: 0,
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    ...overrides,
  });

  describe("ensureCheckpointDir", () => {
    it("should create checkpoint directory if it doesn't exist", () => {
      const dir = ensureCheckpointDir(testDir);
      expect(fs.existsSync(dir)).toBe(true);
    });

    it("should not fail if directory already exists", () => {
      ensureCheckpointDir(testDir);
      const dir = ensureCheckpointDir(testDir);
      expect(fs.existsSync(dir)).toBe(true);
    });
  });

  describe("getCheckpointPath", () => {
    it("rejects path-like run identities", () => {
      expect(() => getCheckpointPath("../outside", testDir)).toThrow("Invalid checkpoint run ID");
      expect(() => getCheckpointPath("nested/run", testDir)).toThrow("Invalid checkpoint run ID");
    });

    it("resolves without creating a checkpoint directory", () => {
      const missingDir = path.join(testDir, "read-only-resolution");
      expect(getCheckpointPath("run-1", missingDir)).toBe(path.join(missingDir, "run-1.json"));
      expect(fs.existsSync(missingDir)).toBe(false);
    });
  });

  describe("saveCheckpoint", () => {
    it("should save checkpoint to disk", async () => {
      const checkpoint = createTestCheckpoint();
      await saveCheckpoint(checkpoint, { checkpointDir: testDir, skipCleanup: true });

      const filePath = getCheckpointPath(checkpoint.runId, testDir);
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it("should write valid JSON", async () => {
      const checkpoint = createTestCheckpoint();
      await saveCheckpoint(checkpoint, { checkpointDir: testDir, skipCleanup: true });

      const filePath = getCheckpointPath(checkpoint.runId, testDir);
      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(content);

      expect(parsed.runId).toBe(checkpoint.runId);
      expect(parsed.phase).toBe(checkpoint.phase);
    });

    it("should overwrite existing checkpoint", async () => {
      const checkpoint1 = createTestCheckpoint({ completedItems: ["item1"] });
      const checkpoint2 = createTestCheckpoint({ completedItems: ["item1", "item2"] });

      await saveCheckpoint(checkpoint1, { checkpointDir: testDir, skipCleanup: true });
      await saveCheckpoint(checkpoint2, { checkpointDir: testDir, skipCleanup: true });

      const loaded = await loadCheckpoint(checkpoint1.runId, { checkpointDir: testDir });
      expect(loaded.completedItems).toEqual(["item1", "item2"]);
    });

    it("rejects unbounded checkpoint payloads", async () => {
      const checkpoint = createTestCheckpoint({
        metadata: { warnings: ["x".repeat(MAX_CHECKPOINT_BYTES)] },
      });
      await expect(
        saveCheckpoint(checkpoint, { checkpointDir: testDir, skipCleanup: true })
      ).rejects.toThrow(`Checkpoint exceeds ${MAX_CHECKPOINT_BYTES} bytes`);
    });
  });

  describe("loadCheckpoint", () => {
    it("should load saved checkpoint", async () => {
      const checkpoint = createTestCheckpoint();
      await saveCheckpoint(checkpoint, { checkpointDir: testDir, skipCleanup: true });

      const loaded = await loadCheckpoint(checkpoint.runId, { checkpointDir: testDir });
      expect(loaded.runId).toBe(checkpoint.runId);
      expect(loaded.completedItems).toEqual(checkpoint.completedItems);
    });

    it("should throw error if checkpoint not found", async () => {
      await expect(loadCheckpoint("nonexistent", { checkpointDir: testDir })).rejects.toThrow(
        "Checkpoint not found"
      );
    });

    it("does not create a missing directory while loading", async () => {
      const missingDir = path.join(testDir, "missing-load");
      await expect(loadCheckpoint("nonexistent", { checkpointDir: missingDir })).rejects.toThrow(
        "Checkpoint not found"
      );
      expect(fs.existsSync(missingDir)).toBe(false);
    });

    it("should validate plan hash if provided", async () => {
      const checkpoint = createTestCheckpoint({ planHash: "abc123" });
      await saveCheckpoint(checkpoint, { checkpointDir: testDir, skipCleanup: true });

      await expect(
        loadCheckpoint(checkpoint.runId, {
          checkpointDir: testDir,
          expectedPlanHash: "wrong-hash",
        })
      ).rejects.toThrow("Plan hash mismatch");
    });

    it("should not validate plan hash if validation disabled", async () => {
      const checkpoint = createTestCheckpoint({ planHash: "abc123" });
      await saveCheckpoint(checkpoint, { checkpointDir: testDir, skipCleanup: true });

      const loaded = await loadCheckpoint(checkpoint.runId, {
        checkpointDir: testDir,
        validatePlanHash: false,
        expectedPlanHash: "wrong-hash",
      });

      expect(loaded.runId).toBe(checkpoint.runId);
    });
  });

  describe("listCheckpoints", () => {
    it("should return empty array if no checkpoints", async () => {
      const entries = await listCheckpoints({ checkpointDir: testDir });
      expect(entries).toEqual([]);
    });

    it("does not create a missing directory while listing", async () => {
      const missingDir = path.join(testDir, "missing-list");
      await expect(listCheckpoints({ checkpointDir: missingDir })).resolves.toEqual([]);
      expect(fs.existsSync(missingDir)).toBe(false);
    });

    it("should list all checkpoints", async () => {
      const cp1 = createTestCheckpoint({ runId: "run-1" });
      const cp2 = createTestCheckpoint({ runId: "run-2" });

      await saveCheckpoint(cp1, { checkpointDir: testDir, skipCleanup: true });
      await saveCheckpoint(cp2, { checkpointDir: testDir, skipCleanup: true });

      const entries = await listCheckpoints({ checkpointDir: testDir });
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.runId).sort()).toEqual(["run-1", "run-2"]);
    });

    it("should sort by timestamp descending", async () => {
      const now = Date.now();
      const cp1 = createTestCheckpoint({
        runId: "run-1",
        timestamp: new Date(now - 2000).toISOString(),
      });
      const cp2 = createTestCheckpoint({
        runId: "run-2",
        timestamp: new Date(now - 1000).toISOString(),
      });
      const cp3 = createTestCheckpoint({ runId: "run-3", timestamp: new Date(now).toISOString() });

      await saveCheckpoint(cp1, { checkpointDir: testDir, skipCleanup: true });
      await saveCheckpoint(cp2, { checkpointDir: testDir, skipCleanup: true });
      await saveCheckpoint(cp3, { checkpointDir: testDir, skipCleanup: true });

      const entries = await listCheckpoints({ checkpointDir: testDir });
      expect(entries[0].runId).toBe("run-3");
      expect(entries[1].runId).toBe("run-2");
      expect(entries[2].runId).toBe("run-1");
    });

    it("should filter by phase", async () => {
      const cp1 = createTestCheckpoint({ runId: "run-1", phase: "merge" });
      const cp2 = createTestCheckpoint({ runId: "run-2", phase: "gates" });

      await saveCheckpoint(cp1, { checkpointDir: testDir, skipCleanup: true });
      await saveCheckpoint(cp2, { checkpointDir: testDir, skipCleanup: true });

      const entries = await listCheckpoints({ checkpointDir: testDir, phase: "merge" });
      expect(entries).toHaveLength(1);
      expect(entries[0].runId).toBe("run-1");
    });

    it("should apply limit", async () => {
      const cp1 = createTestCheckpoint({ runId: "run-1" });
      const cp2 = createTestCheckpoint({ runId: "run-2" });
      const cp3 = createTestCheckpoint({ runId: "run-3" });

      await saveCheckpoint(cp1, { checkpointDir: testDir, skipCleanup: true });
      await saveCheckpoint(cp2, { checkpointDir: testDir, skipCleanup: true });
      await saveCheckpoint(cp3, { checkpointDir: testDir, skipCleanup: true });

      const entries = await listCheckpoints({ checkpointDir: testDir, limit: 2 });
      expect(entries).toHaveLength(2);
    });
  });

  describe("getLatestCheckpoint", () => {
    it("should return null if no checkpoints", async () => {
      const latest = await getLatestCheckpoint(testDir);
      expect(latest).toBeNull();
    });

    it("should return most recent checkpoint", async () => {
      const now = Date.now();
      const cp1 = createTestCheckpoint({
        runId: "run-1",
        timestamp: new Date(now - 1000).toISOString(),
      });
      const cp2 = createTestCheckpoint({ runId: "run-2", timestamp: new Date(now).toISOString() });

      await saveCheckpoint(cp1, { checkpointDir: testDir, skipCleanup: true });
      await saveCheckpoint(cp2, { checkpointDir: testDir, skipCleanup: true });

      const latest = await getLatestCheckpoint(testDir);
      expect(latest?.runId).toBe("run-2");
    });
  });

  describe("deleteCheckpoint", () => {
    it("should delete checkpoint file", async () => {
      const checkpoint = createTestCheckpoint();
      await saveCheckpoint(checkpoint, { checkpointDir: testDir, skipCleanup: true });

      const deleted = await deleteCheckpoint(checkpoint.runId, testDir);
      expect(deleted).toBe(true);
      expect(checkpointExists(checkpoint.runId, testDir)).toBe(false);
    });

    it("should return false if checkpoint doesn't exist", async () => {
      const deleted = await deleteCheckpoint("nonexistent", testDir);
      expect(deleted).toBe(false);
    });
  });

  describe("cleanupOldCheckpoints", () => {
    it("should remove checkpoints older than retention period", async () => {
      const now = Date.now();
      const oldDate = new Date(now - (CHECKPOINT_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000);
      const recentDate = new Date(now);

      const cpOld = createTestCheckpoint({ runId: "old-run", timestamp: oldDate.toISOString() });
      const cpRecent = createTestCheckpoint({
        runId: "recent-run",
        timestamp: recentDate.toISOString(),
      });

      await saveCheckpoint(cpOld, { checkpointDir: testDir, skipCleanup: true });
      await saveCheckpoint(cpRecent, { checkpointDir: testDir, skipCleanup: true });

      const result = await cleanupOldCheckpoints(testDir);

      expect(result.removed).toBe(1);
      expect(result.retained).toBe(1);
      expect(result.removedRunIds).toContain("old-run");
      expect(checkpointExists("old-run", testDir)).toBe(false);
      expect(checkpointExists("recent-run", testDir)).toBe(true);
    });

    it("should not remove recent checkpoints", async () => {
      const cp1 = createTestCheckpoint({ runId: "run-1" });
      const cp2 = createTestCheckpoint({ runId: "run-2" });

      await saveCheckpoint(cp1, { checkpointDir: testDir, skipCleanup: true });
      await saveCheckpoint(cp2, { checkpointDir: testDir, skipCleanup: true });

      const result = await cleanupOldCheckpoints(testDir);

      expect(result.removed).toBe(0);
      expect(result.retained).toBe(2);
    });
  });

  describe("checkpointExists", () => {
    it("should return true if checkpoint exists", async () => {
      const checkpoint = createTestCheckpoint();
      await saveCheckpoint(checkpoint, { checkpointDir: testDir, skipCleanup: true });

      expect(checkpointExists(checkpoint.runId, testDir)).toBe(true);
    });

    it("should return false if checkpoint doesn't exist", () => {
      expect(checkpointExists("nonexistent", testDir)).toBe(false);
    });
  });
});
