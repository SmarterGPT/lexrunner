# CLI/MCP Weave Reporting & Matrix Generation

**Status:** Planned (v0.2)
**Last Updated:** 2025-10-02

## Overview

This document formalizes how the CLI and MCP server provide integration matrix data and artifacts for merge-weave operations. It defines the JSON output shapes, artifact paths, and consumption patterns for external tools and CI/CD pipelines.

## Integration Matrix

The **integration matrix** is a structured representation of the merge-weave execution plan and results. It enables:

- CI/CD pipeline orchestration (which gates to run, in what order)
- Status dashboards (progress tracking, gate results)
- Artifact aggregation (collect outputs from distributed gate execution)
- Auditing and compliance (full execution trace)

### Matrix JSON Shape

```typescript
interface IntegrationMatrix {
  schemaVersion: string; // "1.0.0"
  generated: string; // ISO 8601 timestamp
  plan: {
    target: string; // Target branch (e.g., "main")
    itemCount: number;
    levels: number; // Merge pyramid levels
  };
  execution: {
    levels: Array<{
      level: number; // 1-indexed level number
      items: string[]; // Item names in this level
      parallel: boolean; // Can items in this level run in parallel?
    }>;
    gates: Array<{
      item: string;
      gate: string;
      command: string;
      env?: Record<string, string>;
      timeout?: number;
    }>;
  };
  policy?: {
    maxWorkers?: number;
    retryConfigs?: Array<{
      gate: string;
      maxAttempts: number;
      backoffSeconds: number;
    }>;
  };
}
```

### Example Matrix

This is an illustrative `IntegrationMatrix` projection, not a Plan input. Its nested `plan` and
`execution` summaries are not accepted by the Plan schema.

<!-- lexrunner-non-executable-plan:integration-matrix-projection -->

```json
{
  "schemaVersion": "1.0.0",
  "generated": "2025-10-02T10:30:00Z",
  "plan": {
    "target": "main",
    "itemCount": 3,
    "levels": 2
  },
  "execution": {
    "levels": [
      {
        "level": 1,
        "items": ["auth-foundation"],
        "parallel": false
      },
      {
        "level": 2,
        "items": ["api-endpoints", "user-management"],
        "parallel": true
      }
    ],
    "gates": [
      {
        "item": "auth-foundation",
        "gate": "lint",
        "command": "npm run lint",
        "timeout": 30000
      },
      {
        "item": "auth-foundation",
        "gate": "type",
        "command": "npm run typecheck",
        "timeout": 60000
      },
      {
        "item": "auth-foundation",
        "gate": "unit",
        "command": "npm test",
        "timeout": 120000
      },
      {
        "item": "api-endpoints",
        "gate": "lint",
        "command": "npm run lint",
        "timeout": 30000
      }
    ]
  },
  "policy": {
    "maxWorkers": 2,
    "retryConfigs": [
      {
        "gate": "e2e",
        "maxAttempts": 2,
        "backoffSeconds": 30
      }
    ]
  }
}
```

## CLI Output Artifacts

### Artifact Paths

All artifacts are written to the resolved profile directory under `runner/`:

```
<profile-dir>/
  runner/
    plan.json                    # Plan definition (input to weave)
    matrix.json                  # Integration matrix (NEW)
    snapshot.md                  # Human-readable plan summary
    gates/                       # Gate execution results
      <item>-<gate>.json         # Per-gate results (schema-validated)
    deliverables/                # Autopilot artifacts (Level 1+)
      analysis.json              # Analysis data
      weave-report.md            # Human-readable report
      gate-predictions.json      # Predicted gate outcomes
      execution-log.md           # Execution trace
      metadata.json              # Run metadata
```

### Matrix Generation

The CLI generates the integration matrix when running weave operations:

```bash
# Generate matrix during plan creation
npm run cli -- plan --json > plan.json
# Future: npm run cli -- matrix --from-plan plan.json > matrix.json

# Dry-run shows matrix without execution
npm run cli -- execute plan.json --dry-run --json
# Output includes execution.levels structure

# Autopilot Level 1+ generates matrix in deliverables
npm run cli -- autopilot plan.json --level 1
# Creates .smartergpt.local/runner/deliverables/analysis.json
```

### Matrix Consumption Patterns

#### CI/CD Pipeline Generation

```yaml
# Example: GitHub Actions matrix strategy
name: Integration Gates

on:
  workflow_dispatch:
    inputs:
      matrix_json:
        description: "Integration matrix JSON"
        required: true

jobs:
  generate-matrix:
    runs-on: ubuntu-latest
    outputs:
      matrix: ${{ steps.parse.outputs.matrix }}
    steps:
      - uses: actions/checkout@v7
      - id: parse
        run: |
          MATRIX=$(echo '${{ inputs.matrix_json }}' | jq -c '.execution.gates | map({item, gate, command})')
          echo "matrix=$MATRIX" >> $GITHUB_OUTPUT

  run-gates:
    needs: generate-matrix
    runs-on: ubuntu-latest
    strategy:
      matrix:
        gate: ${{ fromJSON(needs.generate-matrix.outputs.matrix) }}
    steps:
      - uses: actions/checkout@v7
      - name: Run gate ${{ matrix.gate.gate }} for ${{ matrix.gate.item }}
        run: ${{ matrix.gate.command }}
```

#### Status Dashboard

```typescript
// Example: Parse matrix for progress tracking
import { IntegrationMatrix } from "./types";

function calculateProgress(matrix: IntegrationMatrix, results: GateResult[]): Progress {
  const totalGates = matrix.execution.gates.length;
  const completed = results.filter((r) => r.status === "pass" || r.status === "fail").length;
  const passing = results.filter((r) => r.status === "pass").length;

  return {
    percent: (completed / totalGates) * 100,
    passing: passing,
    failing: completed - passing,
    pending: totalGates - completed,
  };
}
```

## Weave Reporting Hooks

### Report Aggregation

The `report` command aggregates gate results into a comprehensive summary:

```bash
# Aggregate gate results from directory
npm run cli -- report ./runner/gates --out json > summary.json
npm run cli -- report ./runner/gates --out md > summary.md
```

### Report JSON Shape

```typescript
interface ReportSummary {
  schemaVersion: string;
  generated: string;
  summary: {
    totalItems: number;
    totalGates: number;
    passing: number;
    failing: number;
    allGreen: boolean;
  };
  items: Array<{
    name: string;
    status: "pass" | "fail" | "pending";
    gates: Array<{
      name: string;
      status: "pass" | "fail" | "pending";
      duration_ms?: number;
      started_at?: string;
    }>;
  }>;
}
```

### Markdown Report Format

```markdown
# Gate Execution Report

**Generated:** 2025-10-02T10:45:00Z
**Status:** ✅ All gates passed

## Summary

- **Total Items:** 3
- **Total Gates:** 10
- **Passing:** 10
- **Failing:** 0

## Items

### auth-foundation ✅

- ✅ lint (1.2s)
- ✅ type (3.4s)
- ✅ unit (12.3s)

### api-endpoints ✅

- ✅ lint (1.1s)
- ✅ type (3.2s)
- ✅ unit (8.9s)

### user-management ✅

- ✅ lint (1.0s)
- ✅ type (2.8s)
- ✅ unit (7.5s)
- ✅ e2e (45.2s)
```

## MCP Server Integration

### Matrix Generation Tool

```typescript
// MCP tool: matrix.generate
{
  "name": "matrix.generate",
  "description": "Generate integration matrix from plan",
  "inputSchema": {
    "type": "object",
    "properties": {
      "planPath": {
        "type": "string",
        "description": "Path to plan.json file"
      },
      "outputFormat": {
        "type": "string",
        "enum": ["json", "yaml"],
        "default": "json"
      }
    }
  }
}
```

### Report Aggregation Resource

```typescript
// MCP resource: reports/summary
{
  "uri": "reports://summary",
  "name": "Gate Results Summary",
  "description": "Aggregated gate execution results",
  "mimeType": "application/json"
}
```

## Testing Strategy

### Unit Tests

Test matrix generation logic in isolation:

```typescript
describe("Matrix Generation", () => {
  it("should generate correct level structure", () => {
    const plan = loadPlan(simplePlanJson);
    const matrix = generateMatrix(plan);

    expect(matrix.execution.levels).toHaveLength(2);
    expect(matrix.execution.levels[0].items).toEqual(["auth-foundation"]);
    expect(matrix.execution.levels[1].items).toEqual(["api-endpoints", "user-management"]);
  });

  it("should mark parallel levels correctly", () => {
    const plan = loadPlan(parallelPlanJson);
    const matrix = generateMatrix(plan);

    expect(matrix.execution.levels[0].parallel).toBe(false); // Single item
    expect(matrix.execution.levels[1].parallel).toBe(true); // Multiple independent items
  });
});
```

### Integration Tests

Test end-to-end CLI output:

```typescript
describe("CLI Matrix Output", () => {
  it("should output valid matrix JSON", () => {
    const output = execSync("npm run cli -- execute plan.json --dry-run --json", {
      encoding: "utf8",
    });

    const result = JSON.parse(output);
    expect(result).toHaveProperty("execution.levels");
    expect(result.execution.levels).toBeInstanceOf(Array);
  });

  it("should have deterministic matrix output", () => {
    const output1 = execSync("npm run cli -- execute plan.json --dry-run --json", {
      encoding: "utf8",
    });
    const output2 = execSync("npm run cli -- execute plan.json --dry-run --json", {
      encoding: "utf8",
    });

    expect(output1).toBe(output2);
  });
});
```

### Test Placeholders

The following test stubs document planned functionality:

```typescript
describe("Weave Reporting (Planned)", () => {
  it.skip("should generate integration matrix from plan", () => {
    // TODO: Implement matrix.generate CLI command
    // Expected: npm run cli -- matrix --from-plan plan.json
  });

  it.skip("should include gate timing predictions in matrix", () => {
    // TODO: Add historical timing data to matrix
    // Expected: matrix.execution.gates[].estimatedDuration
  });

  it.skip("should support matrix filtering by item/gate", () => {
    // TODO: Add filtering options
    // Expected: npm run cli -- matrix --items auth-foundation,api-endpoints
  });

  it.skip("should generate GitHubActions workflow from matrix", () => {
    // TODO: Add workflow template generation
    // Expected: npm run cli -- matrix --format github-actions
  });
});
```

## Implementation Roadmap

### Phase 1: Core Matrix Structure (Current)

- ✅ Plan loading and validation
- ✅ Merge order computation
- ✅ Gate execution framework
- ✅ Report aggregation

### Phase 2: Matrix Generation (Planned)

- [ ] `matrix.generate` CLI command
- [ ] JSON output with stable schema
- [ ] Level parallelism detection
- [ ] Policy integration

### Phase 3: Advanced Features (Future)

- [ ] Historical timing predictions
- [ ] Workflow template generation
- [ ] Real-time progress streaming
- [ ] Matrix filtering and projections

## Alignment with Weave v0.2

This specification aligns with [weave-contract.md](./weave-contract.md) by:

- Providing structured execution data for CI/CD orchestration
- Enabling gate-level parallelism where safe
- Supporting retry policies and timeout configuration
- Maintaining deterministic, reproducible outputs
- Facilitating audit trails and compliance reporting

## Related Documentation

- [Weave Contract v0.2](./weave-contract.md) - Merge-weave execution rules
- [CLI Usage](./cli.md) - Command-line interface reference
- [MCP Server](../README.mcp.md) - Model Context Protocol integration
- [Schemas](./schemas.md) - JSON schema definitions

---

**Next Steps:**

- Implement `matrix.generate` command
- Add test coverage for matrix generation
- Create CI/CD workflow examples
- Document consumption patterns for popular CI platforms
