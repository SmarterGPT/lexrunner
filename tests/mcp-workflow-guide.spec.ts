import { describe, it, expect } from "vitest";
import { WorkflowGuideArgs } from "../src/mcp/types.js";

describe("MCP Workflow Guide Types", () => {
  describe("WorkflowGuideArgs validation", () => {
    it("should validate valid workflow phases", () => {
      const validPhases = [
        "initial",
        "post-plan-creation",
        "post-gates-run",
        "pre-merge",
        "post-merge",
        "error-recovery",
      ];

      validPhases.forEach((phase) => {
        expect(() => WorkflowGuideArgs.parse({ phase })).not.toThrow();
      });
    });

    it("should reject invalid workflow phases", () => {
      const invalidPhases = ["invalid-phase", "", "INITIAL", "post_plan_creation"];

      invalidPhases.forEach((phase) => {
        expect(() => WorkflowGuideArgs.parse({ phase })).toThrow();
      });
    });

    it("should require phase parameter", () => {
      expect(() => WorkflowGuideArgs.parse({})).toThrow();
    });

    it("preserves an explicit repository and rejects invalid repository paths", () => {
      expect(WorkflowGuideArgs.parse({ phase: "initial", repoRoot: "../repository" })).toEqual({
        phase: "initial",
        repoRoot: "../repository",
      });
      for (const repoRoot of ["", " ", "bad\0path", "x".repeat(4097), 7, null]) {
        expect(() => WorkflowGuideArgs.parse({ phase: "initial", repoRoot })).toThrow();
      }
    });

    it("should reject non-string phase values", () => {
      expect(() => WorkflowGuideArgs.parse({ phase: 123 })).toThrow();
      expect(() => WorkflowGuideArgs.parse({ phase: true })).toThrow();
      expect(() => WorkflowGuideArgs.parse({ phase: null })).toThrow();
      expect(() => WorkflowGuideArgs.parse({ phase: undefined })).toThrow();
    });
  });

  describe("WorkflowGuideArgs type inference", () => {
    it("should infer correct type from valid input", () => {
      const args = WorkflowGuideArgs.parse({ phase: "initial" });

      // TypeScript should infer the correct type
      expect(args.phase).toBe("initial");

      // Verify the type matches expected structure
      const typedArgs: { phase: string } = args;
      expect(typedArgs).toEqual({ phase: "initial" });
    });
  });
});
