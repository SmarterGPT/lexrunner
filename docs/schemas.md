# Schema Documentation

This document outlines the schema architecture for lexrunner, establishing the single source of truth and generation workflow.

## Schema Architecture

### Single Source of Truth: Zod Schemas

**The TypeScript Zod schemas in `src/schema.ts` are the authoritative schema definitions.**

All JSON schema files in `schemas/*.json` are **generated artifacts** derived from the Zod schemas. These generated files should never be manually edited.

### Schema Generation Workflow

Schema generation follows this pattern:

1. **Define**: Zod schemas in `src/schema.ts` (source of truth)
2. **Generate**: JSON schemas via `scripts/generate-*-schema.ts` scripts
3. **Validate**: Generated schemas against test cases
4. **Commit**: Both source and generated schemas together

#### Current Generation Scripts

- `scripts/generate-gate-schema.ts` - Generates `schemas/gate-report.schema.json`

#### Missing Generation Scripts

The following scripts need to be created to maintain schema consistency:

- `scripts/generate-plan-schema.ts` - Should generate `schemas/plan.schema.json` from Zod Plan schema
- CI integration to verify schemas are up-to-date

## Core Schemas

### Plan Schema (`src/schema.ts`)

The Plan schema defines the structure for `plan.json` files:

```typescript
// Core plan structure
export const Plan = z
  .object({
    schemaVersion: SchemaVersion, // "1.x.y" format
    target: z.string().default("main"),
    policy: Policy.optional(),
    items: z.array(PlanItem).default([]),
  })
  .strict();

// Plan items with dependency resolution
export const PlanItem = z
  .object({
    name: z.string(), // Unique identifier for dependency resolution
    deps: z.string().array().default([]), // References to other item names
    gates: z.array(Gate).default([]),
  })
  .strict();
```

**Key Design Decisions:**

- `name` field is required and used for dependency resolution
- `deps` array contains references to other item names (not IDs)
- Schema is strict - no additional properties allowed
- **Note**: Current `schemas/plan.schema.json` incorrectly requires `repo`/`branch` fields that don't exist in the Zod schema

Gate artifact declarations identify one exact path each. Durable execution rejects empty,
NUL-containing, glob, brace, and extglob declarations before admission. Absolute paths remain
supported; relative paths resolve against the gate execution directory.

### Gate Schema

```typescript
export const Gate = z
  .object({
    name: z.string(),
    run: z.string(),
    cwd: z.string().optional(),
    env: z.record(z.string()).default({}),
    runtime: z.enum(["local", "container", "ci-service"]).default("local"),
    container: ContainerSpec.optional(),
    // Exact literal paths only; glob, brace, and extglob syntax is not expanded.
    artifacts: z.array(z.string()).default([]),
  })
  .strict();
```

### Gate Report Schema

The Gate Report schema has been enhanced with versioning and artifact support:

```typescript
// Defined in src/schema/gateReport.ts
export const GateReport = z.object({
  schemaVersion: z
    .string()
    .regex(/^1\.\d+\.\d+$/)
    .optional(),
  item: z.string(),
  gate: z.string(),
  status: z.enum(["pass", "fail"]),
  duration_ms: z.number().min(0),
  started_at: z.string(), // ISO timestamp
  stderr_path: z.string().optional(),
  stdout_path: z.string().optional(),
  meta: z.record(z.string()).optional(),
  artifacts: z.array(ArtifactMetadata).optional(),
});

export const ArtifactMetadata = z.object({
  path: z.string(),
  type: z.string().optional(),
  size: z.number().min(0).optional(),
  description: z.string().optional(),
});
```

**Key Features:**

- **Schema Versioning**: Optional `schemaVersion` field for backward compatibility (format: `1.x.y`)
- **Artifact Metadata**: Track build outputs, reports, and logs with rich metadata
- **Enhanced Validation**: Detailed error messages with fix suggestions
- **Migration Support**: Utilities to migrate legacy report formats

**See Also:** [Gate Report Examples](./gate-report-examples.md) for complete usage examples.

### Behavior Rule Schema (`.smartergpt/schemas/behavior-rule.schema.ts`)

The Behavior Rule schema defines the structure for behavioral rules that provide guidance and policy enforcement for AI agents in the LexRunner ecosystem.

```typescript
// Rule scope for context filtering
const RuleScopeSchema = z
  .object({
    environment: z.string().optional(), // "development", "production"
    project: z.string().optional(), // Project identifier
    agentFamily: z.string().optional(), // "copilot", "claude"
  })
  .strict();

// Single behavioral rule
const BehaviorRuleItemSchema = z
  .object({
    id: z.string(), // Unique rule identifier
    title: z.string(), // Rule title/name
    description: z.string(), // Rule description
    content: z.string(), // Rule content/guidance
    scope: RuleScopeSchema.optional(), // Scope metadata
    priority: z.number().int().min(0).optional(), // Priority (higher = more important)
  })
  .strict();

// Behavior rules container
export const BehaviorRuleSchema = z
  .object({
    version: z.string().optional(), // Schema version
    rules: z.array(BehaviorRuleItemSchema).optional(),
  })
  .strict();
```

**Key Features:**

- **Schema $id**: `https://github.com/Guffawaffle/LexRunner/schemas/behavior-rule.schema.json`
- **Scope Filtering**: Rules can be scoped to specific environments, projects, or agent families
- **Priority Ordering**: Rules with higher priority values take precedence
- **Strict Validation**: No additional properties allowed

**Example:**

```json
{
  "version": "1.0.0",
  "rules": [
    {
      "id": "code-review-required",
      "title": "Code Review Required",
      "description": "All code changes must be reviewed before merge",
      "content": "Before merging any pull request, ensure at least one peer review has been completed.",
      "priority": 10
    },
    {
      "id": "no-force-push",
      "title": "No Force Push to Main",
      "description": "Prevent force pushing to protected branches",
      "content": "Never use git push --force on main or release branches.",
      "scope": {
        "environment": "production"
      },
      "priority": 100
    }
  ]
}
```

**Export Path:** `lexrunner/schemas/behavior-rule`

## Schema Versioning

Schemas follow semantic versioning principles:

- **Major (1.x.y → 2.x.y)**: Breaking changes to structure or semantics
- **Minor (1.1.y → 1.2.y)**: Additive required fields with safe defaults
- **Patch (1.1.1 → 1.1.2)**: Additive optional fields or documentation only

Current supported version: **1.x.y** (major version 1 only)

### Gate Report Schema Evolution

The gate report schema supports versioning and migration:

- **Schema Version Field**: Optional `schemaVersion` field (format: `1.x.y`)
- **Backward Compatibility**: Reports without schema version are treated as `1.0.0`
- **Migration Utilities**: Automatic migration from legacy formats

#### Legacy Field Mapping

| Legacy Field        | Current Field    | Migration Rule |
| ------------------- | ---------------- | -------------- |
| `result: "success"` | `status: "pass"` | Direct mapping |
| `result: "failure"` | `status: "fail"` | Direct mapping |
| `duration`          | `duration_ms`    | Field rename   |
| `start_time`        | `started_at`     | Field rename   |

#### Migration Commands

```bash
# Check if report needs migration
lex-pr gate-report validate report.json

# Migrate and show converted format
lex-pr gate-report validate legacy-report.json --migrate

# Migrate with JSON output
lex-pr gate-report validate legacy-report.json --migrate --json
```

## Validation and Error Handling

### Zod Validation

```typescript
// Validate plan data
const result = Plan.safeParse(planData);
if (!result.success) {
  throw new SchemaValidationError(result.error.issues);
}
```

### Schema Validation Error Format

```typescript
export interface ValidationError {
  path: string; // Dot-notation path to invalid field
  message: string; // Human-readable error message
  code: string; // Zod error code
}

export class SchemaValidationError extends Error {
  public readonly issues: z.ZodIssue[];
  public readonly errors: ValidationError[];

  toJSON(): { valid: false; errors: ValidationError[] };
}
```

## Deterministic Behavior

All schema operations must produce deterministic outputs:

- **Canonical JSON**: Use `canonicalJSONStringify()` for stable key ordering
- **Stable timestamps**: Avoid runtime timestamps in generated schemas
- **Sorted arrays**: Dependencies and items sorted alphabetically where possible

## CLI Integration

Schema validation is exposed via CLI commands:

```bash
# Validate plan against schema
npm run cli -- schema validate plan.json

# JSON output for CI integration
npm run cli -- schema validate plan.json --json

# Validate gate report
npm run cli -- gate-report validate report.json

# Validate with JSON output
npm run cli -- gate-report validate report.json --json

# Migrate and validate legacy gate report
npm run cli -- gate-report validate legacy-report.json --migrate
```

Expected JSON output format for plan validation:

```json
// Success
{ "valid": true }

// Failure
{
  "valid": false,
  "errors": [
    {
      "path": "items.0.name",
      "message": "Required",
      "code": "invalid_type"
    }
  ]
}
```

Expected JSON output format for gate report validation:

```json
// Success
{ "valid": true }

// Failure with suggestions
{
  "valid": false,
  "errors": [
    {
      "path": "status",
      "message": "Invalid enum value. Expected 'pass' | 'fail', received 'invalid-status'",
      "code": "invalid_enum_value",
      "suggestion": "Valid values: \"pass\" or \"fail\""
    },
    {
      "path": "started_at",
      "message": "Required",
      "code": "invalid_type",
      "suggestion": "Use ISO 8601 format: \"2024-01-15T10:30:00Z\""
    }
  ]
}

// Migration success
{
  "valid": true,
  "migrated": true,
  "data": {
    "schemaVersion": "1.0.0",
    "item": "feature-payment",
    "gate": "test",
    "status": "pass",
    "duration_ms": 3500,
    "started_at": "2024-01-15T11:00:00Z"
  }
}
```

## MCP Integration

The MCP server exposes schema validation through tools but does not define separate schemas. All MCP tools use the same Zod schemas defined in `src/schema.ts`.

## Future Work

1. **Schema Generation CI**: Add workflow to verify generated schemas match source
2. **Additional Generators**: Create missing generation scripts for plan schema
3. **Schema Registry**: Consider external schema registry for cross-tool compatibility
4. **Validation Performance**: Optimize schema validation for large plans
