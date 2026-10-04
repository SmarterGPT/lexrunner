/**
 * Audit Logger Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { AuditLogger, createAuditLogger } from "../../../src/weave/metrics/logger.js";

describe("AuditLogger", () => {
  let tempDir: string;
  let auditPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "metrics-test-"));
    auditPath = path.join(tempDir, "audit.ndjson");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("logIntervention", () => {
    it("writes entry to NDJSON file", async () => {
      const logger = new AuditLogger({ auditPath });

      await logger.logIntervention({
        interventionId: "INT-007",
        success: true,
        durationMs: 1234,
      });

      const content = fs.readFileSync(auditPath, "utf-8");
      const entry = JSON.parse(content.trim());

      expect(entry.intervention_id).toBe("INT-007");
      expect(entry.success).toBe(true);
      expect(entry.time_to_complete_ms).toBe(1234);
    });

    it("creates directory if needed", async () => {
      const nestedPath = path.join(tempDir, "deep", "nested", "audit.ndjson");
      const logger = new AuditLogger({ auditPath: nestedPath });

      await logger.logIntervention({
        interventionId: "INT-001",
        success: true,
        durationMs: 100,
      });

      expect(fs.existsSync(nestedPath)).toBe(true);
    });

    it("appends multiple entries", async () => {
      const logger = new AuditLogger({ auditPath });

      await logger.logIntervention({
        interventionId: "INT-001",
        success: true,
        durationMs: 100,
      });
      await logger.logIntervention({
        interventionId: "INT-002",
        success: false,
        durationMs: 200,
      });

      const content = fs.readFileSync(auditPath, "utf-8");
      const lines = content.trim().split("\n");

      expect(lines.length).toBe(2);
    });

    it("includes optional fields", async () => {
      const logger = new AuditLogger({ auditPath });

      await logger.logIntervention({
        interventionId: "INT-012",
        success: false,
        durationMs: 500,
        modelTier: "mid",
        humanOverride: true,
        repo: "lexrunner",
        error: "CI failed",
        context: { pr: 123 },
      });

      const content = fs.readFileSync(auditPath, "utf-8");
      const entry = JSON.parse(content.trim());

      expect(entry.model_tier_used).toBe("mid");
      expect(entry.required_human_override).toBe(true);
      expect(entry.repo).toBe("lexrunner");
      expect(entry.error_message).toBe("CI failed");
      expect(entry.context.pr).toBe(123);
    });
  });

  describe("startIntervention", () => {
    it("tracks timing automatically", async () => {
      const logger = new AuditLogger({ auditPath });
      const now = vi.spyOn(Date, "now").mockReturnValue(1000);

      try {
        const tracker = logger.startIntervention("INT-007");
        now.mockReturnValue(1123);

        await tracker.success();

        const content = fs.readFileSync(auditPath, "utf-8");
        const entry = JSON.parse(content.trim());

        expect(entry.success).toBe(true);
        expect(entry.time_to_complete_ms).toBe(123);
      } finally {
        now.mockRestore();
      }
    });

    it("handles failure with error", async () => {
      const logger = new AuditLogger({ auditPath });

      const tracker = logger.startIntervention("INT-007");
      await tracker.fail("Something went wrong");

      const content = fs.readFileSync(auditPath, "utf-8");
      const entry = JSON.parse(content.trim());

      expect(entry.success).toBe(false);
      expect(entry.error_message).toBe("Something went wrong");
    });

    it("handles human override", async () => {
      const logger = new AuditLogger({ auditPath });

      const tracker = logger.startIntervention("INT-012");
      await tracker.humanOverride("Manual approval needed");

      const content = fs.readFileSync(auditPath, "utf-8");
      const entry = JSON.parse(content.trim());

      expect(entry.success).toBe(true);
      expect(entry.required_human_override).toBe(true);
      expect(entry.context.override_reason).toBe("Manual approval needed");
    });

    it("only logs once even if called multiple times", async () => {
      const logger = new AuditLogger({ auditPath });

      const tracker = logger.startIntervention("INT-007");
      await tracker.success();
      await tracker.fail("Should not log");
      await tracker.success();

      const content = fs.readFileSync(auditPath, "utf-8");
      const lines = content.trim().split("\n");

      expect(lines.length).toBe(1);
    });
  });

  describe("readEntries", () => {
    it("reads all entries from file", async () => {
      const logger = new AuditLogger({ auditPath });

      await logger.logIntervention({ interventionId: "INT-001", success: true, durationMs: 100 });
      await logger.logIntervention({ interventionId: "INT-002", success: false, durationMs: 200 });
      await logger.logIntervention({ interventionId: "INT-003", success: true, durationMs: 300 });

      const entries = await logger.readEntries();

      expect(entries.length).toBe(3);
    });

    it("returns empty array for non-existent file", async () => {
      const logger = new AuditLogger({ auditPath: "/nonexistent/path/audit.ndjson" });
      const entries = await logger.readEntries();
      expect(entries).toEqual([]);
    });

    it("skips invalid lines", async () => {
      // Write some entries including an invalid one
      fs.writeFileSync(
        auditPath,
        '{"intervention_id":"INT-001","intervention_name":"Test","determinism_level":"D1","model_tier_used":"frontier","success":true,"time_to_complete_ms":100,"timestamp":"2025-12-19T05:00:00.000Z"}\n' +
          "invalid json line\n" +
          '{"intervention_id":"INT-002","intervention_name":"Test2","determinism_level":"D2","model_tier_used":"mid","success":true,"time_to_complete_ms":200,"timestamp":"2025-12-19T05:00:00.000Z"}\n'
      );

      const logger = new AuditLogger({ auditPath });
      const entries = await logger.readEntries();

      expect(entries.length).toBe(2);
    });
  });

  describe("getEntriesForRun", () => {
    it("filters by run ID", async () => {
      const logger1 = new AuditLogger({ auditPath, runId: "run-001" });
      const logger2 = new AuditLogger({ auditPath, runId: "run-002" });

      await logger1.logIntervention({ interventionId: "INT-001", success: true, durationMs: 100 });
      await logger2.logIntervention({ interventionId: "INT-002", success: true, durationMs: 200 });
      await logger1.logIntervention({ interventionId: "INT-003", success: true, durationMs: 300 });

      const entries = await logger1.getEntriesForRun("run-001");

      expect(entries.length).toBe(2);
      expect(entries.every((e) => e.run_id === "run-001")).toBe(true);
    });
  });

  describe("getEntriesForIntervention", () => {
    it("filters by intervention ID", async () => {
      const logger = new AuditLogger({ auditPath });

      await logger.logIntervention({ interventionId: "INT-007", success: true, durationMs: 100 });
      await logger.logIntervention({ interventionId: "INT-008", success: true, durationMs: 200 });
      await logger.logIntervention({ interventionId: "INT-007", success: false, durationMs: 300 });

      const entries = await logger.getEntriesForIntervention("INT-007");

      expect(entries.length).toBe(2);
    });
  });

  describe("createAuditLogger", () => {
    it("creates logger with default options", () => {
      const logger = createAuditLogger({ auditPath });

      expect(logger).toBeInstanceOf(AuditLogger);
      expect(logger.getRunId()).toMatch(/^run-/);
    });
  });
});
