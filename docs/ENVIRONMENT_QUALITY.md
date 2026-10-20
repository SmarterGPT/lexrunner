# Environment Quality: Hostility Scoring

This document describes the Environmental Hostility Scoring system implemented in lexrunner, based on the Environmental De-hostilization concept from the coordination cost compression thesis.

## Overview

**Definition 3.2 (Environmental Hostility):** The degree to which an environment impedes effective agent operation through unclear constraints, opaque requirements, unbounded problem surfaces, missing receipts, punitive error dynamics, fragmented state, and model switches without continuity protocols.

## Usage

### CLI

Run the environment quality check:

```bash
# Run hostility scoring only
lex-pr doctor --environment-quality

# Run full doctor with JSON output (includes hostility score)
lex-pr doctor --environment-quality --json
```

### MCP Tool

The `doctor` MCP tool supports an `environmentQuality` parameter:

```json
{
  "name": "doctor",
  "arguments": {
    "environmentQuality": true
  }
}
```

`environmentQuality` is optional, boolean, and defaults to `false`. The MCP schema is strict:
unknown fields (including ad hoc `repoRoot`, `cwd`, or `baseDir` selectors) and wrong-typed values
are invalid parameters. The server captures its startup working directory as the diagnostic root;
start the server in the repository you intend to inspect. Results report that root as
`diagnosticBase` and the separately resolved profile root as `configuration.profileDir`.

## Hostility Score

The hostility score ranges from 0 to 1, where:

- **0.0 - 0.3**: Low hostility (good) - Environment is well-configured for agent operation
- **0.3 - 0.6**: Medium hostility - Improvement recommended
- **0.6 - 1.0**: High hostility - Significant impediments to effective operation

### Component Breakdown

| Component                    | Description                                    | Checks                                        |
| ---------------------------- | ---------------------------------------------- | --------------------------------------------- |
| **Constraint Clarity**       | Are constraints explicit and machine-readable? | AGENTS.md, copilot instructions, policy files |
| **Requirement Explicitness** | Are requirements stated explicitly?            | scope.yml, intent.md, plan validation         |
| **Problem Boundedness**      | Is the problem surface bounded?                | Plan item count (recommend < 10)              |
| **Receipt Completeness**     | Are operations traced with receipts?           | Frame emission, deliverables directories      |
| **Error Recoverability**     | Are rollback paths defined?                    | gates.yml, retry config, git availability     |
| **State Coherence**          | Is state consolidated?                         | Standard vs. fragmented locations             |
| **Model Continuity**         | Are handoff protocols in place?                | HANDOFF.md, session state, intent.md          |

## Example Output

```
Environment Quality Report
==========================

Overall Hostility Score: 0.23 (low - good)

Component Breakdown:
  ✓ Constraint Clarity:      0.1  Found 3/4 constraint files: AGENTS.md, CLAUDE.md, .github/copilot-instructions.md
  ✓ Requirement Explicitness: 0.2  Plan validated with 5 items, 2 scope files found
  ~ Problem Boundedness:     0.3  Plan has 12 items (recommend < 10 for optimal parallelism)
  ✓ Receipt Completeness:    0.2  Frame emission enabled
  ✓ Error Recoverability:    0.1  Gates configured for structured error handling
  ~ State Coherence:         0.4  State in expected locations
  ~ Model Continuity:        0.3  Intent.md provides partial continuity context

Recommendations:
  1. Split plan into smaller batches (< 10 items each)
  2. Add HANDOFF.md or session state for model switch continuity
```

## Reducing Hostility

### Constraint Clarity

- Add `AGENTS.md` with machine-readable agent instructions
- Create `.github/copilot-instructions.md` for GitHub Copilot
- Define `lexmap.policy.json` for policy enforcement

### Requirement Explicitness

- Create `.smartergpt/scope.yml` with explicit scope definitions
- Write `.smartergpt/intent.md` describing project goals
- Generate `plan.json` with `lex-pr plan` command

### Problem Boundedness

- Keep plans under 10 items for optimal agent operation
- Split large work into smaller, focused batches
- Use dependencies to manage complexity

### Receipt Completeness

- Enable frame emission with `--emit-frames` flag
- Run autopilot to generate deliverables with receipts
- Review generated receipts for traceability

### Error Recoverability

- Create `.smartergpt/gates.yml` with quality gates
- Configure retry policies in plan.json
- Ensure git repository is initialized for rollback capability

### State Coherence

- Store all state in `.smartergpt/` or `.lexrunner/` directories
- Avoid temporary directories or cache locations
- Clean up fragmented state from non-standard locations

### Model Continuity

- Create `HANDOFF.md` documenting continuity protocols
- Maintain session state files for context preservation
- Write clear `intent.md` for handoff context

## JSON Schema

The hostility score follows this structure:

```typescript
interface HostilityScore {
  total: number; // 0-1, aggregate score
  status: "low" | "medium" | "high";
  components: {
    constraintClarity: HostilityComponent;
    requirementExplicitness: HostilityComponent;
    problemBoundedness: HostilityComponent;
    receiptCompleteness: HostilityComponent;
    errorRecoverability: HostilityComponent;
    stateCoherence: HostilityComponent;
    modelContinuity: HostilityComponent;
  };
  recommendations: string[];
}

interface HostilityComponent {
  score: number; // 0-1, component score
  status: "good" | "warning" | "critical";
  details: string;
  recommendation?: string;
}
```

## Cross-References

- **Thesis**: Section 3.2 - Environmental De-hostilization
- **CLI**: `lex-pr doctor --environment-quality`
- **MCP Tool**: `doctor` with `environmentQuality: true`
- **Source**: `src/hostility/` module
