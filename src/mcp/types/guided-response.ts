/**
 * Guided workflow response types for MCP server
 *
 * These types enable context-aware workflow guidance without modifying
 * existing tool response structures. Per LPR-037 and Guff's Option 1 approach.
 */

/**
 * Workflow action that can be taken in the current phase
 */
export interface WorkflowAction {
  /** MCP tool command name (e.g., 'gates_run', 'plan_validate') */
  command: string;
  /** Human-readable description of what this action does */
  description: string;
  /** Whether this action must be performed before proceeding */
  required: boolean;
}

/**
 * Common issue and its resolution in a workflow phase
 */
export interface CommonIssue {
  /** Symptom or error message pattern */
  symptom: string;
  /** Recommended solution or next step */
  solution: string;
}

/**
 * Guided workflow response from the workflow_guide tool
 */
export interface WorkflowGuide {
  /** Guidance is advisory and does not grant execution or merge authority. */
  authority: "advisory";
  authorizesExecution: false;
  authorizesMerge: false;
  /** Current workflow phase identifier */
  phase: string;
  /** Available next steps in this phase */
  nextSteps: WorkflowAction[];
  /** Common issues that occur in this phase */
  commonIssues: CommonIssue[];
  /** Link to relevant documentation */
  documentation?: string;
  /** Whether agent can proceed to next phase */
  canProceed: boolean;
  /** Optional recommendation for the most common next action */
  recommendedAction?: string;
  /** Optional observed workspace readiness used by the published MCP adapter. */
  readiness?: {
    source: "doctor";
    hasErrors: boolean;
    missingFiles: string[];
    compatibilityFiles: string[];
    issues: string[];
    suggestions: string[];
  };
}

export interface WorkflowReadiness {
  canProceed: boolean;
  commonIssues?: CommonIssue[];
  recommendedAction?: string;
  observation?: WorkflowGuide["readiness"];
}

/**
 * Decision point in a workflow requiring agent choice
 */
export interface WorkflowDecision {
  /** Checkpoint identifier where decision is needed */
  checkpoint: string;
  /** Available options at this decision point */
  options: Array<{
    /** Action to take for this option */
    action: string;
    /** Description of what this option does */
    description: string;
    /** Whether this option requires explicit confirmation */
    requiresConfirmation?: boolean;
  }>;
}

/**
 * Guided MCP response wrapper (for future enhancement)
 *
 * This interface shows how existing responses could be enhanced
 * with workflow guidance, but is not used in the initial implementation.
 *
 * @template T - The original response data type
 */
export interface GuidedMCPResponse<T> {
  /** Original deterministic data */
  data: T;

  /** Workflow state tracking */
  workflow: {
    phase: string;
    completedSteps: string[];
    availableActions: string[];
    recommendedAction?: string;
    canProceed: boolean;
  };

  /** Contextual prompt for the agent */
  prompt?: {
    id: string;
    template: string;
    rendered: string;
  };

  /** Decision points for branching workflows */
  decisions?: WorkflowDecision[];
}
