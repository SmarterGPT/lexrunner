import { describe, it, expect } from "vitest";
import {
  WorkflowStateMachine,
  createWorkflowGuide,
  type WorkflowPhase,
} from "../src/mcp/workflow/state-machine.js";
import type { WorkflowGuide } from "../src/mcp/types/guided-response.js";

describe("WorkflowStateMachine", () => {
  describe("initialization", () => {
    it("should initialize with initial phase by default", () => {
      const sm = new WorkflowStateMachine();
      expect(sm.getCurrentPhase()).toBe("initial");
      expect(sm.getCompletedSteps()).toEqual([]);
    });

    it("should initialize with specified phase", () => {
      const sm = new WorkflowStateMachine("post-plan-creation");
      expect(sm.getCurrentPhase()).toBe("post-plan-creation");
    });
  });

  describe("phase transitions", () => {
    it("should allow valid transition from initial to post-plan-creation", () => {
      const sm = new WorkflowStateMachine();
      sm.transition("post-plan-creation");
      expect(sm.getCurrentPhase()).toBe("post-plan-creation");
    });

    it("should allow valid transition from post-plan-creation to post-gates-run", () => {
      const sm = new WorkflowStateMachine("post-plan-creation");
      sm.transition("post-gates-run");
      expect(sm.getCurrentPhase()).toBe("post-gates-run");
    });

    it("should allow transition to error-recovery from any phase", () => {
      const sm = new WorkflowStateMachine("post-plan-creation");
      sm.transition("error-recovery");
      expect(sm.getCurrentPhase()).toBe("error-recovery");
    });

    it("should throw error on invalid transition", () => {
      const sm = new WorkflowStateMachine("initial");
      expect(() => sm.transition("post-merge")).toThrow(/Invalid transition/);
    });

    it("should maintain completed steps across transitions", () => {
      const sm = new WorkflowStateMachine();
      sm.completeStep("plan.create");
      sm.transition("post-plan-creation");
      expect(sm.getCompletedSteps()).toContain("plan.create");
    });
  });

  describe("available actions", () => {
    it("should return plan.create action for initial phase", () => {
      const sm = new WorkflowStateMachine("initial");
      const actions = sm.getAvailableActions();
      expect(actions).toHaveLength(1);
      expect(actions[0].command).toBe("plan.create");
      expect(actions[0].required).toBe(true);
    });

    it("should return multiple actions for post-plan-creation phase", () => {
      const sm = new WorkflowStateMachine("post-plan-creation");
      const actions = sm.getAvailableActions();
      expect(actions.length).toBeGreaterThan(1);
      const commands = actions.map((a) => a.command);
      expect(commands).toContain("gates.run");
      expect(commands).toContain("status");
      expect(commands).toContain("merge-order");
      expect(commands).not.toContain("plan.validate");
      expect(commands).not.toContain("merge.order");
    });

    it("should return empty actions for post-merge phase", () => {
      const sm = new WorkflowStateMachine("post-merge");
      const actions = sm.getAvailableActions();
      expect(actions).toHaveLength(0);
    });
  });

  describe("canProceed", () => {
    it("should return true for valid action in current phase", () => {
      const sm = new WorkflowStateMachine("post-plan-creation");
      expect(sm.canProceed("gates.run")).toBe(true);
    });

    it("should return false for invalid action in current phase", () => {
      const sm = new WorkflowStateMachine("initial");
      expect(sm.canProceed("gates.run")).toBe(false);
    });
  });

  describe("step completion", () => {
    it("should track completed steps", () => {
      const sm = new WorkflowStateMachine();
      sm.completeStep("plan.create");
      expect(sm.getCompletedSteps()).toContain("plan.create");
    });

    it("should handle multiple completed steps", () => {
      const sm = new WorkflowStateMachine("post-plan-creation");
      sm.completeStep("gates.run");
      sm.completeStep("status");
      const completed = sm.getCompletedSteps();
      expect(completed).toContain("gates.run");
      expect(completed).toContain("status");
      expect(completed).toHaveLength(2);
    });

    it("should not duplicate completed steps", () => {
      const sm = new WorkflowStateMachine();
      sm.completeStep("plan.create");
      sm.completeStep("plan.create");
      expect(sm.getCompletedSteps()).toHaveLength(1);
    });
  });

  describe("getGuide", () => {
    it("should return workflow guide for current phase", () => {
      const sm = new WorkflowStateMachine("post-plan-creation");
      const guide = sm.getGuide();

      expect(guide.phase).toBe("post-plan-creation");
      expect(guide.nextSteps.length).toBeGreaterThan(0);
      expect(guide.commonIssues.length).toBeGreaterThan(0);
      expect(guide.recommendedAction).toBe("gates.run");
      expect(guide.documentation).toBe("docs/merge-weave-workflow.md");
      expect(guide).toMatchObject({
        authority: "advisory",
        authorizesExecution: false,
        authorizesMerge: false,
      });
    });

    it("should set canProceed to true when all required actions completed", () => {
      const sm = new WorkflowStateMachine("initial");
      sm.completeStep("plan.create");
      const guide = sm.getGuide();
      expect(guide.canProceed).toBe(true);
    });

    it("should set canProceed to false when required actions not completed", () => {
      const sm = new WorkflowStateMachine("post-plan-creation");
      const guide = sm.getGuide();
      expect(guide.canProceed).toBe(false);
    });

    it("should set canProceed to true for phases with no actions", () => {
      const sm = new WorkflowStateMachine("post-merge");
      const guide = sm.getGuide();
      expect(guide.canProceed).toBe(true);
    });
  });

  describe("reset", () => {
    it("should reset to initial state", () => {
      const sm = new WorkflowStateMachine("post-plan-creation");
      sm.completeStep("gates.run");
      sm.reset();

      expect(sm.getCurrentPhase()).toBe("initial");
      expect(sm.getCompletedSteps()).toHaveLength(0);
    });
  });
});

describe("createWorkflowGuide", () => {
  it("should create guide for initial phase", () => {
    const guide = createWorkflowGuide("initial");

    expect(guide.phase).toBe("initial");
    expect(guide.nextSteps).toHaveLength(1);
    expect(guide.nextSteps[0].command).toBe("plan.create");
    expect(guide.recommendedAction).toBe("plan.create");
    expect(guide.canProceed).toBe(true); // Stateless version
  });

  it("should create guide for post-plan-creation phase", () => {
    const guide = createWorkflowGuide("post-plan-creation");

    expect(guide.phase).toBe("post-plan-creation");
    expect(guide.nextSteps.length).toBeGreaterThan(1);
    expect(guide.recommendedAction).toBe("gates.run");
    expect(guide.documentation).toBe("docs/merge-weave-workflow.md");
  });

  it("should create guide for post-gates-run phase", () => {
    const guide = createWorkflowGuide("post-gates-run");

    expect(guide.phase).toBe("post-gates-run");
    expect(guide.recommendedAction).toBe("status");
    expect(guide.commonIssues.length).toBeGreaterThan(0);
  });

  it("should create guide for pre-merge phase", () => {
    const guide = createWorkflowGuide("pre-merge");

    expect(guide.phase).toBe("pre-merge");
    expect(guide.recommendedAction).toBe("merge.apply");
  });

  it("should create guide for post-merge phase", () => {
    const guide = createWorkflowGuide("post-merge");

    expect(guide.phase).toBe("post-merge");
    expect(guide.nextSteps).toHaveLength(0);
  });

  it("should create guide for error-recovery phase", () => {
    const guide = createWorkflowGuide("error-recovery");

    expect(guide.phase).toBe("error-recovery");
    const commands = guide.nextSteps.map((a) => a.command);
    expect(commands).toContain("doctor");
    expect(commands).toContain("status");
  });

  it("should include common issues for relevant phases", () => {
    const guide = createWorkflowGuide("post-gates-run");

    expect(guide.commonIssues.length).toBeGreaterThan(0);
    const symptoms = guide.commonIssues.map((i) => i.symptom);
    expect(symptoms).toContain("Gate failures");
  });

  it("should include documentation links for relevant phases", () => {
    const guide = createWorkflowGuide("post-plan-creation");

    expect(guide.documentation).toBeDefined();
    expect(guide.documentation).toContain("docs/");
  });

  it("uses observed doctor readiness without turning guidance into authority", () => {
    const guide = createWorkflowGuide("initial", {
      canProceed: false,
      commonIssues: [
        {
          symptom: "Configuration is missing required profile-root files: gates.yml",
          solution: "Create C:\\repo\\.smartergpt.local\\gates.yml to define quality gates",
        },
      ],
      recommendedAction: "local.init",
      observation: {
        source: "doctor",
        hasErrors: true,
        missingFiles: ["gates.yml"],
        compatibilityFiles: [],
        issues: ["Configuration is missing required profile-root files: gates.yml"],
        suggestions: ["Create C:\\repo\\.smartergpt.local\\gates.yml to define quality gates"],
      },
    });

    expect(guide).toMatchObject({
      authority: "advisory",
      authorizesExecution: false,
      authorizesMerge: false,
      canProceed: false,
      recommendedAction: "local.init",
      readiness: {
        source: "doctor",
        hasErrors: true,
        missingFiles: ["gates.yml"],
      },
    });
    expect(guide.commonIssues.at(-1)?.solution).toContain("gates.yml");
  });

  it("allows an observed healthy workspace to proceed while remaining advisory", () => {
    const guide = createWorkflowGuide("initial", {
      canProceed: true,
      observation: {
        source: "doctor",
        hasErrors: false,
        missingFiles: [],
        compatibilityFiles: [],
        issues: [],
        suggestions: [],
      },
    });

    expect(guide).toMatchObject({
      authority: "advisory",
      authorizesExecution: false,
      authorizesMerge: false,
      canProceed: true,
      readiness: { source: "doctor", hasErrors: false },
    });
  });
});

describe("WorkflowGuide structure", () => {
  it("should have consistent structure across all phases", () => {
    const phases: WorkflowPhase[] = [
      "initial",
      "post-plan-creation",
      "post-gates-run",
      "pre-merge",
      "post-merge",
      "error-recovery",
    ];

    phases.forEach((phase) => {
      const guide = createWorkflowGuide(phase);

      // All guides should have these properties
      expect(guide).toHaveProperty("phase");
      expect(guide).toHaveProperty("nextSteps");
      expect(guide).toHaveProperty("commonIssues");
      expect(guide).toHaveProperty("canProceed");
      expect(guide).toMatchObject({
        authority: "advisory",
        authorizesExecution: false,
        authorizesMerge: false,
      });

      // Validate types
      expect(typeof guide.phase).toBe("string");
      expect(Array.isArray(guide.nextSteps)).toBe(true);
      expect(Array.isArray(guide.commonIssues)).toBe(true);
      expect(typeof guide.canProceed).toBe("boolean");

      // Each action should have required properties
      guide.nextSteps.forEach((action) => {
        expect(action).toHaveProperty("command");
        expect(action).toHaveProperty("description");
        expect(action).toHaveProperty("required");
        expect(typeof action.command).toBe("string");
        expect(typeof action.description).toBe("string");
        expect(typeof action.required).toBe("boolean");
      });

      // Each issue should have required properties
      guide.commonIssues.forEach((issue) => {
        expect(issue).toHaveProperty("symptom");
        expect(issue).toHaveProperty("solution");
        expect(typeof issue.symptom).toBe("string");
        expect(typeof issue.solution).toBe("string");
      });
    });
  });
});
