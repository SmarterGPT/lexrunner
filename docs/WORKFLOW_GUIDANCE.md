# Workflow Guidance (LPR-037)

## Overview

The public `workflow.guide` MCP tool returns phase-specific next steps, common issues, a
recommended action, and an optional documentation pointer. The command names in `nextSteps` use
the canonical published MCP surface: `plan.create`, `gates.run`, `status`, `merge-order`,
`merge.apply`, and `doctor`.

Every response is explicitly advisory:

- `authority` is always `"advisory"`.
- `authorizesExecution` is always `false`.
- `authorizesMerge` is always `false`.
- `canProceed` reports only the readiness observation or local workflow bookkeeping described
  below. It does not prove plan validity, gate success, merge eligibility, or authority.
- `required: true` identifies a required phase action. It does not mean that command ran or that
  the caller may run it.

Use the generated inventory in [README.mcp.md](../README.mcp.md#published-tool-inventory) as the
source of truth for all public MCP tool names.

## Workflow Phases

### 1. Initial

Starting point before any operations.

**Next steps:**

- `plan.create` (required) - Create execution plan

**Default recommended action:** `plan.create`

For the published MCP tool, this phase also runs `doctor` against the server's diagnostic base.
If required workspace files are missing, the recommendation becomes `local.init`; for other
doctor errors it becomes `doctor`. See [Initial readiness](#initial-readiness) for the exact
meaning of that observation.

### 2. Post-Plan-Creation

Plan has been created, ready for validation and gate execution.

**Next steps:**

- `gates.run` (required) - Execute gates to validate PRs
- `status` (optional) - Validate the selected plan and report its current integration status
- `merge-order` (optional) - Calculate dependency-based merge order

**Common issues:**

- Plan schema validation errors → Use `status` with an explicit `planFile`
- Unknown dependencies → Check PR dependency declarations

**Recommended action:** `gates.run`

### 3. Post-Gates-Run

Gates have been executed, check results before merge.

**Next steps:**

- `status` (required) - Check gate execution results
- `merge.apply` (optional) - Apply merge operations (use `dryRun: true` first)

**Common issues:**

- Gate failures → Check `artifacts/PR-XXX/gateName/` for logs
- PRs blocked from merge → Use `status` tool to see why

**Recommended action:** `status`

### 4. Pre-Merge

Ready to merge, perform final checks.

**Next steps:**

- `merge.apply` (required) - Apply merge operations (consider `dryRun: true` first)

**Common issues:**

- Merge conflicts detected → Resolve manually or use AI conflict resolution
- Branch protection prevents merge → Ensure status checks pass and approvals obtained

**Recommended action:** `merge.apply`

### 5. Post-Merge

Merge completed successfully.

**Next steps:** None (workflow complete)

### 6. Error-Recovery

Error occurred, attempting recovery.

**Next steps:**

- `doctor` (optional) - Run diagnostics
- `status` (optional) - Check current state

**Common issues:**

- Command execution failed → Check error messages and use `doctor`

## Initial Readiness

The published `workflow.guide` adapter obtains an actual `doctor` result only for the `initial`
phase and includes it as `readiness`:

```typescript
{
  source: "doctor";
  hasErrors: boolean;
  missingFiles: string[];
  compatibilityFiles: string[];
  issues: string[];
  suggestions: string[];
}
```

For this phase, `canProceed` is `!readiness.hasErrors`. Missing required files recommend
`local.init`; other errors recommend `doctor`; a healthy workspace keeps the phase default of
`plan.create`. Compatibility-file observations may add a common issue without changing
`canProceed` when `doctor` reports no errors.

Other published phases are stateless and do not contain a `readiness` observation. Their default
`canProceed: true` means only that the guide has no observed readiness blocker. Call the named
tools and inspect their receipts to establish plan validity, gate results, merge eligibility, and
any separate execution authority.

The internal `WorkflowStateMachine.getGuide()` instead derives `canProceed` from its in-memory
completed-step set: all required actions must be marked complete, unless the phase has no actions.
That local bookkeeping still does not execute a command or create authoritative evidence.

## Usage

### MCP Tool

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "workflow.guide",
    "arguments": {
      "phase": "post-plan-creation"
    }
  }
}
```

The response payload is JSON encoded in `result.content[0].text`. After decoding that text, the
example above returns:

```json
{
  "authority": "advisory",
  "authorizesExecution": false,
  "authorizesMerge": false,
  "phase": "post-plan-creation",
  "nextSteps": [
    {
      "command": "gates.run",
      "description": "Execute gates to validate PRs before merging",
      "required": true
    },
    {
      "command": "status",
      "description": "Validate the selected plan and report its current integration status",
      "required": false
    },
    {
      "command": "merge-order",
      "description": "Calculate dependency-based merge order",
      "required": false
    }
  ],
  "commonIssues": [
    {
      "symptom": "Plan schema validation errors",
      "solution": "Use status with the explicit planFile to check schema compliance"
    },
    {
      "symptom": "Unknown dependencies in plan",
      "solution": "Check PR dependency declarations and ensure all referenced PRs exist"
    }
  ],
  "documentation": "README.mcp.md",
  "canProceed": true,
  "recommendedAction": "gates.run"
}
```

Here `canProceed` is the stateless default, not evidence that `gates.run`, `status`, or
`merge-order` has executed.

### Programmatic Usage (TypeScript)

The package root exports the stateless helper:

```typescript
import { createWorkflowGuide } from "@smartergpt/lexrunner";

const guide = createWorkflowGuide("post-gates-run");
console.log(guide.nextSteps);
console.log(guide.commonIssues);
```

`WorkflowStateMachine` is an internal implementation class, not a public package export. Do not
import package-private `src/` paths. The helper does not run `doctor`; the doctor-backed initial
observation belongs to the published MCP adapter.

## API Reference

### WorkflowGuide

```typescript
interface WorkflowGuide {
  authority: "advisory";
  authorizesExecution: false;
  authorizesMerge: false;
  phase: WorkflowPhase;
  nextSteps: WorkflowAction[];
  commonIssues: CommonIssue[];
  documentation?: string;
  canProceed: boolean;
  recommendedAction?: string;
  readiness?: {
    source: "doctor";
    hasErrors: boolean;
    missingFiles: string[];
    compatibilityFiles: string[];
    issues: string[];
    suggestions: string[];
  };
}
```

The three authority fields are required on every guide. `readiness` is optional and is currently
populated by the published MCP adapter only for the `initial` phase.

### WorkflowAction

```typescript
interface WorkflowAction {
  command: string; // Canonical public MCP tool name
  description: string; // What this action does
  required: boolean; // Required by the phase model, not an authority grant
}
```

### CommonIssue

```typescript
interface CommonIssue {
  symptom: string; // Error message or symptom pattern
  solution: string; // Recommended solution
}
```

## Implementation Map

- `src/mcp/types/guided-response.ts` defines the response contracts.
- `src/mcp/workflow/state-machine.ts` owns phase definitions and the stateless helper.
- `mcp-server.mjs` is the published MCP adapter and supplies initial doctor readiness.
- `src/mcp/server.ts` keeps the source-server adapter aligned with the published behavior.
- `src/cli.ts` exports `createWorkflowGuide` from the package root.
- `tests/workflow-state-machine.spec.ts`, `tests/mcp-workflow-guide.spec.ts`, and
  `tests/docs-current.spec.ts` cover the phase, validation, authority, and documentation contracts.
- `tests/mcp-workspace-onboarding-git.spec.ts` covers the doctor-backed published onboarding path.

## Testing

```sh
npx vitest run tests/workflow-state-machine.spec.ts tests/mcp-workflow-guide.spec.ts tests/docs-current.spec.ts
npx vitest run -c vitest.git.config.ts tests/mcp-workspace-onboarding-git.spec.ts
```

## Future Enhancements

`GuidedMCPResponse<T>` in `guided-response.ts` is a future response-wrapper shape. It is not part
of the current published response and must not be documented as active workflow tracking.

This would enable:

- **Contextual prompts**: AI-generated suggestions based on current state
- **Decision points**: Branching workflows with multiple options
- **Progress tracking**: History of completed steps

These enhancements are not implemented.

## Design Rationale

The phase definitions remain deterministic. The published `initial` response additionally reports
the current doctor's bounded workspace observation, so that response can change when the workspace
configuration changes. Guidance stays separate from command receipts and protected authority.

## Related Documentation

- [Published MCP Tool Inventory](../README.mcp.md#published-tool-inventory) - Packaged guidance
  returned by the tool and the canonical public names
- [Merge-Weave Quickstart](./merge-weave-quickstart.md) - Source-tree walkthrough
- [MCP CLI Parity](./MCP-CLI-PARITY.md) - MCP tool alignment
- [Terms](./TERMS.md) - Canonical terminology
