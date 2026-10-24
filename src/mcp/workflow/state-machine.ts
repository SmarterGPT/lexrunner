/**
 * Workflow state machine for guided MCP workflows
 *
 * Tracks workflow phases and valid transitions for deterministic guidance.
 * Per LPR-037 implementation.
 */

import type {
  WorkflowGuide,
  WorkflowAction,
  CommonIssue,
  WorkflowReadiness,
} from "../types/guided-response.js";

/**
 * Valid workflow phases
 */
export type WorkflowPhase =
  | "initial"
  | "post-plan-creation"
  | "post-gates-run"
  | "pre-merge"
  | "post-merge"
  | "error-recovery";

/**
 * Workflow phase definition with metadata
 */
interface PhaseDefinition {
  /** Human-readable description of this phase */
  description: string;
  /** Valid actions in this phase */
  actions: WorkflowAction[];
  /** Common issues in this phase */
  commonIssues: CommonIssue[];
  /** Recommended next action */
  recommendedAction?: string;
  /** Link to documentation */
  documentation?: string;
  /** Valid transitions from this phase */
  validTransitions: WorkflowPhase[];
}

/**
 * Workflow definitions for each phase
 */
const PHASE_DEFINITIONS: Record<WorkflowPhase, PhaseDefinition> = {
  initial: {
    description: "Starting point before any operations",
    actions: [
      {
        command: "plan.create",
        description: "Create execution plan from configuration or GitHub PRs",
        required: true,
      },
    ],
    commonIssues: [],
    recommendedAction: "plan.create",
    validTransitions: ["post-plan-creation", "error-recovery"],
  },
  "post-plan-creation": {
    description: "Plan has been created, ready for validation and gate execution",
    actions: [
      {
        command: "gates.run",
        description: "Execute gates to validate PRs before merging",
        required: true,
      },
      {
        command: "status",
        description: "Validate the selected plan and report its current integration status",
        required: false,
      },
      {
        command: "merge-order",
        description: "Calculate dependency-based merge order",
        required: false,
      },
    ],
    commonIssues: [
      {
        symptom: "Plan schema validation errors",
        solution: "Use status with the explicit planFile to check schema compliance",
      },
      {
        symptom: "Unknown dependencies in plan",
        solution: "Check PR dependency declarations and ensure all referenced PRs exist",
      },
    ],
    recommendedAction: "gates.run",
    documentation: "docs/merge-weave-workflow.md",
    validTransitions: ["post-gates-run", "error-recovery"],
  },
  "post-gates-run": {
    description: "Gates have been executed, check results before merge",
    actions: [
      {
        command: "status",
        description: "Check gate execution results and merge eligibility",
        required: true,
      },
      {
        command: "merge.apply",
        description: "Apply merge operations (use dryRun: true first)",
        required: false,
      },
    ],
    commonIssues: [
      {
        symptom: "Gate failures",
        solution: "Check artifacts/PR-XXX/gateName/ for detailed failure logs",
      },
      {
        symptom: "Some PRs blocked from merge",
        solution: "Use status tool to see which PRs are blocked and why",
      },
    ],
    recommendedAction: "status",
    documentation: "docs/merge-weave-workflow.md",
    validTransitions: ["pre-merge", "error-recovery"],
  },
  "pre-merge": {
    description: "Ready to merge, perform final checks",
    actions: [
      {
        command: "merge.apply",
        description: "Apply merge operations (consider dryRun: true first)",
        required: true,
      },
    ],
    commonIssues: [
      {
        symptom: "Merge conflicts detected",
        solution: "Resolve conflicts manually or use AI conflict resolution",
      },
      {
        symptom: "Branch protection prevents merge",
        solution: "Ensure all required status checks pass and approvals are obtained",
      },
    ],
    recommendedAction: "merge.apply",
    documentation: "docs/merge-weave-workflow.md",
    validTransitions: ["post-merge", "error-recovery"],
  },
  "post-merge": {
    description: "Merge completed successfully",
    actions: [],
    commonIssues: [],
    validTransitions: ["initial"],
  },
  "error-recovery": {
    description: "Error occurred, attempting recovery",
    actions: [
      {
        command: "doctor",
        description: "Run diagnostics to identify configuration issues",
        required: false,
      },
      {
        command: "status",
        description: "Check current state of plan and gates",
        required: false,
      },
    ],
    commonIssues: [
      {
        symptom: "Command execution failed",
        solution: "Check error messages and use doctor tool for diagnostics",
      },
    ],
    validTransitions: ["initial", "post-plan-creation", "post-gates-run"],
  },
};

/**
 * Workflow state machine for tracking and guiding workflow phases
 */
export class WorkflowStateMachine {
  private currentPhase: WorkflowPhase;
  private completedSteps: Set<string>;

  constructor(initialPhase: WorkflowPhase = "initial") {
    this.currentPhase = initialPhase;
    this.completedSteps = new Set();
  }

  /**
   * Transition to a new workflow phase
   * @throws Error if transition is not valid
   */
  transition(toPhase: WorkflowPhase): void {
    const currentDef = PHASE_DEFINITIONS[this.currentPhase];
    if (!currentDef.validTransitions.includes(toPhase)) {
      throw new Error(
        `Invalid transition from ${this.currentPhase} to ${toPhase}. ` +
          `Valid transitions: ${currentDef.validTransitions.join(", ")}`
      );
    }
    this.currentPhase = toPhase;
    // Note: We don't clear completedSteps to maintain history
  }

  /**
   * Get available actions for the current phase
   */
  getAvailableActions(): WorkflowAction[] {
    return PHASE_DEFINITIONS[this.currentPhase].actions;
  }

  /**
   * Check if an action is valid for the current phase
   */
  canProceed(action: string): boolean {
    const actions = this.getAvailableActions();
    return actions.some((a) => a.command === action);
  }

  /**
   * Mark a step as completed
   */
  completeStep(step: string): void {
    this.completedSteps.add(step);
  }

  /**
   * Get workflow guide for the current phase
   */
  getGuide(): WorkflowGuide {
    const def = PHASE_DEFINITIONS[this.currentPhase];
    const requiredActions = def.actions.filter((a) => a.required);
    const allRequiredCompleted = requiredActions.every((a) => this.completedSteps.has(a.command));

    return {
      authority: "advisory",
      authorizesExecution: false,
      authorizesMerge: false,
      phase: this.currentPhase,
      nextSteps: def.actions,
      commonIssues: def.commonIssues,
      documentation: def.documentation,
      canProceed: allRequiredCompleted || def.actions.length === 0,
      recommendedAction: def.recommendedAction,
    };
  }

  /**
   * Get the current phase
   */
  getCurrentPhase(): WorkflowPhase {
    return this.currentPhase;
  }

  /**
   * Get all completed steps
   */
  getCompletedSteps(): string[] {
    return Array.from(this.completedSteps);
  }

  /**
   * Reset the state machine to initial state
   */
  reset(): void {
    this.currentPhase = "initial";
    this.completedSteps.clear();
  }
}

/**
 * Create a workflow guide for a given phase without managing state
 *
 * This is a stateless helper for the MCP server that doesn't require
 * maintaining a state machine instance.
 */
export function createWorkflowGuide(
  phase: WorkflowPhase,
  readiness?: WorkflowReadiness
): WorkflowGuide {
  const def = PHASE_DEFINITIONS[phase];
  return {
    authority: "advisory",
    authorizesExecution: false,
    authorizesMerge: false,
    phase,
    nextSteps: def.actions,
    commonIssues: [...def.commonIssues, ...(readiness?.commonIssues ?? [])],
    documentation: def.documentation,
    canProceed: readiness?.canProceed ?? true,
    recommendedAction: readiness?.recommendedAction ?? def.recommendedAction,
    ...(readiness?.observation ? { readiness: readiness.observation } : {}),
  };
}
