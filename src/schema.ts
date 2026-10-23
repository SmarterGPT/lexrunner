import { z } from "zod";
import { TierAssignment } from "./tiers/schema.js";
import { FrozenGitInputs } from "./git/input-schema.js";
import { AXErrorException, planValidationError, configInvalidError } from "./errors/index.js";

/**
 * Schema v1 for plan.json - the single frozen runtime input
 */

/**
 * Status tracking for gates and nodes
 */
export const GateStatus = z.enum(["pass", "fail", "blocked", "skipped", "retrying"]);
export type GateStatus = z.infer<typeof GateStatus>;

export const NodeStatus = z.enum(["pass", "fail", "blocked", "skipped", "retrying"]);
export type NodeStatus = z.infer<typeof NodeStatus>;

/**
 * Gate execution result
 */
export const GateResult = z.object({
  gate: z.string(),
  status: GateStatus,
  exitCode: z.number().optional(),
  duration: z.number().optional(), // milliseconds
  timeoutMs: z.number().int().positive().optional(), // effective timeout used for this gate
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  failureKind: z.enum(["nonzero_exit", "spawn_error", "timeout", "evidence_error"]).optional(),
  timeoutCleanup: z
    .object({
      method: z.enum(["process-group", "taskkill", "direct-child"]),
      forceKilled: z.boolean(),
      descendantsReaped: z.boolean(),
    })
    .optional(),
  artifacts: z.array(z.string()).optional(),
  attempts: z.number().default(1),
  lastAttempt: z.string().optional(), // ISO timestamp
});
export type GateResult = z.infer<typeof GateResult>;

/**
 * Node execution state
 */
export const NodeResult = z.object({
  name: z.string(),
  status: NodeStatus,
  gates: z.array(GateResult).default([]),
  blockedBy: z.array(z.string()).optional(), // names of nodes that blocked this one
  eligibleForMerge: z.boolean().default(false),
});
export type NodeResult = z.infer<typeof NodeResult>;

/**
 * Schema versioning according to SemVer
 * - Patch: additive, optional fields or docs only
 * - Minor: additive required fields with safe defaults
 * - Major: breaking changes to structure or semantics
 */
export const SchemaVersion = z
  .string()
  .regex(/^1\.\d+\.\d+$/, "Schema version must be 1.x.y format");

/**
 * Validate schema version compatibility
 */
export function validateSchemaVersion(version: string): void {
  const parsed = SchemaVersion.safeParse(version);
  if (!parsed.success) {
    const axError = configInvalidError(
      `Unsupported schema version: ${version}. This runner only supports schema version 1.x.y`,
      { version, expected: "1.x.y" }
    );
    throw new AXErrorException(axError.code, axError.message, axError.nextActions, axError.context);
  }

  const [major] = version.split(".").map(Number);
  if (major !== 1) {
    const axError = configInvalidError(
      `Incompatible schema major version: ${major}. This runner only supports major version 1.`,
      { version, major, expectedMajor: 1 }
    );
    throw new AXErrorException(axError.code, axError.message, axError.nextActions, axError.context);
  }
}

/**
 * Retry configuration for gates
 */
export const RetryConfig = z.object({
  maxAttempts: z.number().int().min(1).default(1),
  backoffSeconds: z.number().min(0).default(0),
});
export type RetryConfig = z.infer<typeof RetryConfig>;

/**
 * Admin override configuration
 */
export const AdminOverride = z.object({
  allowedUsers: z.array(z.string()).optional(),
  requireReason: z.boolean().default(false),
});
export type AdminOverride = z.infer<typeof AdminOverride>;

/**
 * Merge rule types
 */
export const MergeRule = z.object({
  type: z.enum(["strict-required"]).default("strict-required"),
  // Future: could add "best-effort", "admin-override-allowed", etc.
});
export type MergeRule = z.infer<typeof MergeRule>;

/**
 * Performance configuration for scale optimization
 */
export const PerformanceConfig = z
  .object({
    maxMemoryMB: z.number().int().min(128).optional(), // Memory limit in MB
    batchSize: z.number().int().min(1).default(50), // Batch size for large plans
    cacheTTLSeconds: z.number().int().min(0).default(3600), // Cache TTL in seconds
    enableCaching: z.boolean().default(true), // Enable operation caching
    throttleOnMemory: z.boolean().default(true), // Throttle workers when memory high
    memoryThresholdPercent: z.number().min(0).max(100).default(80), // Memory threshold %
  })
  .default(() => ({
    batchSize: 50,
    cacheTTLSeconds: 3600,
    enableCaching: true,
    throttleOnMemory: true,
    memoryThresholdPercent: 80,
  }));
export type PerformanceConfig = z.infer<typeof PerformanceConfig>;

/**
 * Security policy for vulnerability thresholds in vuln gate
 */
export const VulnPolicy = z
  .object({
    blockCritical: z.boolean().default(true),
    blockHigh: z.boolean().default(true),
    maxMedium: z.number().int().min(0).default(5),
    maxLow: z.number().int().min(0).default(10),
  })
  .default(() => ({
    blockCritical: true,
    blockHigh: true,
    maxMedium: 5,
    maxLow: 10,
  }));
export type VulnPolicy = z.infer<typeof VulnPolicy>;

/**
 * Policy configuration for the plan execution
 */
export const Policy = z.object({
  requiredGates: z.array(z.string()).default([]),
  optionalGates: z.array(z.string()).default([]),
  maxWorkers: z.number().int().min(1).default(1),
  retries: z.record(z.string(), RetryConfig).default(() => ({})),
  overrides: z
    .object({
      adminGreen: AdminOverride.optional(),
    })
    .default(() => ({})),
  blockOn: z.array(z.string()).default([]),
  mergeRule: MergeRule.default({ type: "strict-required" }),
  performance: PerformanceConfig.optional(), // Performance tuning options
  security: VulnPolicy.optional(), // Security/vulnerability thresholds for vuln gate
});
export type Policy = z.infer<typeof Policy>;

/**
 * Container mount specification
 */
export const ContainerMount = z.object({
  source: z.string(),
  target: z.string(),
  type: z.enum(["bind", "volume"]).default("bind"),
});
export type ContainerMount = z.infer<typeof ContainerMount>;

/**
 * Container specification for gate execution
 */
export const ContainerSpec = z.object({
  image: z.string(),
  entrypoint: z.array(z.string()).optional(),
  mounts: z.array(ContainerMount).optional(),
});
export type ContainerSpec = z.infer<typeof ContainerSpec>;

export const Gate = z
  .object({
    name: z.string(),
    run: z.string(),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).default(() => ({})),
    // Runtime configuration
    runtime: z.enum(["local", "container", "ci-service"]).default("local"),
    // Container spec (only used when runtime is "container")
    container: ContainerSpec.optional(),
    // Expected exact artifact paths (for output collection); patterns are never expanded.
    artifacts: z
      .array(
        z
          .string()
          .describe("Exact literal artifact path; glob, brace, and extglob syntax is unsupported")
      )
      .default([]),
    // Optional input data for gates that require structured inputs (validated against gate-specific schemas)
    input: z.record(z.string(), z.unknown()).optional(),
    // Exact per-gate timeout. Overrides the operation default after hostility adjustment.
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60 * 1000)
      .optional(),
  })
  .strict();
export type Gate = z.infer<typeof Gate>;

/**
 * Plan item with dependencies resolved by name.
 * Note: Input generator defaults name := id when name is unset.
 * All deps references must match item names in the final plan.
 */
export const PlanItem = z
  .object({
    name: z.string(),
    deps: z.string().array().default([]), // Dependency references by item name
    gates: z.array(Gate).default([]),
    // Tier routing for governance (optional - added during plan generation or execution)
    tier: TierAssignment.optional(),
  })
  .strict();
export type PlanItem = z.infer<typeof PlanItem>;

export const Plan = z
  .object({
    schemaVersion: SchemaVersion,
    target: z.string().default("main"),
    policy: Policy.optional(),
    items: z.array(PlanItem).default([]),
    gitInputs: FrozenGitInputs.optional(),
  })
  .strict()
  .superRefine((plan, context) => {
    const itemNames = new Set<string>();
    if (plan.gitInputs) {
      const sources = plan.gitInputs.sources.map((source) => source.item);
      if (
        plan.gitInputs.target.ref !== `refs/heads/${plan.target}` ||
        new Set(sources).size !== sources.length ||
        sources.length !== plan.items.length ||
        plan.items.some((item) => !sources.includes(item.name))
      ) {
        context.addIssue({
          code: "custom",
          path: ["gitInputs"],
          message: "Git inputs must bind the target and every plan item exactly once",
        });
      }
    }
    let duplicateItemNameFound = false;
    const duplicateGateNameItemIndexes: number[] = [];
    for (const [itemIndex, item] of plan.items.entries()) {
      if (itemNames.has(item.name)) {
        duplicateItemNameFound = true;
      }
      itemNames.add(item.name);

      const gateNames = new Set<string>();
      let duplicateGateNameFound = false;
      for (const gate of item.gates) {
        if (gateNames.has(gate.name)) {
          duplicateGateNameFound = true;
        }
        gateNames.add(gate.name);
      }
      if (duplicateGateNameFound) duplicateGateNameItemIndexes.push(itemIndex);
    }

    if (duplicateItemNameFound) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Plan item names must be unique",
        params: { validationCode: "DUPLICATE_NAMES" },
      });
    }
    for (const itemIndex of duplicateGateNameItemIndexes) {
      context.addIssue({
        code: "custom",
        path: ["items", itemIndex, "gates"],
        message: "Gate names must be unique within an item",
        params: { validationCode: "DUPLICATE_GATE_NAMES" },
      });
    }
  });
export type Plan = z.infer<typeof Plan>;

/**
 * Machine-readable validation error
 */
export interface ValidationError {
  path: string;
  message: string;
  code: string;
}

export interface PlanValidationFailure {
  contract: "bounded-ax-v1";
  valid: false;
  code: string;
  message: string;
  errorCount: number;
  errors: ValidationError[];
  errorsTruncated: boolean;
  nextActions: string[];
  context: {
    errorCount: number;
    errorsTruncated: boolean;
  };
}

const MAX_SCHEMA_VALIDATION_ERRORS = 50;
const MAX_SCHEMA_VALIDATION_PATH_BYTES = 256;
const MAX_SCHEMA_VALIDATION_MESSAGE_BYTES = 512;
const MAX_SCHEMA_VALIDATION_ACTION_BYTES = 512;

/**
 * Schema validation error - thrown when Zod validation fails
 * Now extends AXErrorException to provide structured error with nextActions
 */
export class SchemaValidationError extends AXErrorException {
  public readonly issues: z.ZodIssue[];
  public readonly errors: ValidationError[];
  public readonly errorCount: number;
  public readonly errorsTruncated: boolean;

  constructor(issues: z.ZodIssue[]) {
    const errorCount = issues.length;
    const errors = issues.slice(0, MAX_SCHEMA_VALIDATION_ERRORS).map(normalizeValidationIssue);
    const errorsTruncated = errorCount > errors.length;

    const errorStrings = errors.map((e) => `${e.path}: ${e.message}`);
    const axError = planValidationError({
      errors: errorStrings,
      errorCount,
      errorsTruncated,
      // planPath is omitted as it's not available in this context
    });

    super(axError.code, axError.message, axError.nextActions, axError.context);
    this.name = "SchemaValidationError";
    this.issues = issues;
    this.errors = errors;
    this.errorCount = errorCount;
    this.errorsTruncated = errorsTruncated;
  }

  /**
   * Get legacy machine-readable error format for backward compatibility
   */
  toLegacyJSON(): { valid: false; errors: ValidationError[] } {
    return {
      valid: false,
      errors: this.errors,
    };
  }
}

/**
 * Return the stable, bounded validation envelope used by CLI and MCP surfaces.
 *
 * Raw Zod issues are intentionally not returned because they can contain the
 * rejected input. The normalized error list retains only path, message, and
 * code, with deterministic count and byte limits.
 */
export function formatPlanValidationFailure(error: SchemaValidationError): PlanValidationFailure {
  const nextActions = error.axError.nextActions
    .filter((action) => !action.startsWith("Errors:"))
    .slice(0, 10)
    .map((action) => boundDiagnostic(action, MAX_SCHEMA_VALIDATION_ACTION_BYTES));

  return {
    contract: "bounded-ax-v1",
    valid: false,
    code: error.axError.code,
    message: boundDiagnostic(error.message, MAX_SCHEMA_VALIDATION_MESSAGE_BYTES),
    errorCount: error.errorCount,
    errors: error.errors,
    errorsTruncated: error.errorsTruncated,
    nextActions:
      nextActions.length > 0 ? nextActions : ["Review each validation path and update the plan"],
    context: {
      errorCount: error.errorCount,
      errorsTruncated: error.errorsTruncated,
    },
  };
}

export function asPlanValidationFailure(error: unknown): PlanValidationFailure | undefined {
  if (error instanceof SchemaValidationError) return formatPlanValidationFailure(error);
  if (!(error instanceof AXErrorException) || error.axError.code !== "CONFIG_INVALID") {
    return undefined;
  }

  const message = boundDiagnostic(error.message, MAX_SCHEMA_VALIDATION_MESSAGE_BYTES);
  return {
    contract: "bounded-ax-v1",
    valid: false,
    code: error.axError.code,
    message,
    errorCount: 1,
    errors: [{ path: "root", message, code: error.axError.code }],
    errorsTruncated: false,
    nextActions: error.axError.nextActions
      .slice(0, 10)
      .map((action) => boundDiagnostic(action, MAX_SCHEMA_VALIDATION_ACTION_BYTES)),
    context: {
      errorCount: 1,
      errorsTruncated: false,
    },
  };
}

export function formatPlanValidationFailureText(failure: PlanValidationFailure): string {
  const lines = [failure.message];
  for (const error of failure.errors) {
    lines.push(`  - ${error.path} [${error.code}]: ${error.message}`);
  }
  if (failure.errorsTruncated) {
    lines.push(
      `  - … ${failure.errorCount - failure.errors.length} additional validation error(s) omitted`
    );
  }
  return lines.join("\n");
}

function normalizeValidationIssue(issue: z.ZodIssue): ValidationError {
  const path = normalizeValidationPath(issue.path);
  const stableCustomIssue = safeCustomValidationIssue(issue);
  return {
    path: boundDiagnostic(path, MAX_SCHEMA_VALIDATION_PATH_BYTES),
    message: boundDiagnostic(
      stableCustomIssue?.message ?? safeValidationMessage(issue.code),
      MAX_SCHEMA_VALIDATION_MESSAGE_BYTES
    ),
    code: stableCustomIssue?.code ?? issue.code,
  };
}

function safeCustomValidationIssue(
  issue: z.ZodIssue
): { code: string; message: string } | undefined {
  if (issue.code !== "custom") return undefined;

  switch (issue.params?.validationCode) {
    case "DUPLICATE_NAMES":
      return { code: "DUPLICATE_NAMES", message: "Plan item names must be unique" };
    case "DUPLICATE_GATE_NAMES":
      return {
        code: "DUPLICATE_GATE_NAMES",
        message: "Gate names must be unique within an item",
      };
    default:
      return undefined;
  }
}

function normalizeValidationPath(segments: PropertyKey[]): string {
  if (segments.length === 0) return "root";

  return segments
    .map((segment, index) => {
      const previous = segments[index - 1];
      if (previous === "retries" || previous === "env" || previous === "input") {
        return "<key>";
      }
      return String(segment);
    })
    .join(".");
}

function safeValidationMessage(code: string): string {
  switch (code) {
    case "invalid_type":
      return "Value has an invalid type";
    case "invalid_value":
      return "Value is not an allowed option";
    case "too_big":
      return "Value exceeds the allowed maximum";
    case "too_small":
      return "Value is below the allowed minimum";
    case "invalid_format":
      return "Value does not match the required format";
    case "not_multiple_of":
      return "Value is not an allowed multiple";
    case "unrecognized_keys":
      return "Object contains one or more unrecognized keys";
    case "invalid_union":
      return "Value does not match any allowed shape";
    case "invalid_key":
      return "Object contains an invalid key";
    case "invalid_element":
      return "Collection contains an invalid element";
    case "custom":
      return "Value failed schema validation";
    default:
      return "Value does not satisfy schema requirements";
  }
}

function boundDiagnostic(value: string, maxBytes: number): string {
  const singleLine = value.replace(/[\u0000-\u001f\u007f]/g, (character) =>
    JSON.stringify(character).slice(1, -1)
  );
  const encoded = Buffer.from(singleLine, "utf8");
  if (encoded.length <= maxBytes) return singleLine;

  const suffix = "… [truncated]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  let end = Math.max(0, maxBytes - suffixBytes);
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return `${encoded.subarray(0, end).toString("utf8")}${suffix}`;
}

/**
 * Validate a plan object against the schema
 */
export function validatePlan(planData: unknown): Plan {
  // First validate the basic structure
  const result = Plan.safeParse(planData);
  if (!result.success) {
    throw new SchemaValidationError(result.error.issues);
  }

  // Then validate schema version compatibility
  validateSchemaVersion(result.data.schemaVersion);

  return result.data;
}

/**
 * Load and validate a plan.json file
 */
export function loadPlan(planContent: string): Plan {
  try {
    const planData = JSON.parse(planContent);
    return validatePlan(planData);
  } catch (error) {
    if (error instanceof SyntaxError) {
      const axError = configInvalidError("Invalid JSON: plan content could not be parsed", {
        parseError: "MALFORMED_JSON",
      });
      throw new AXErrorException(
        axError.code,
        axError.message,
        axError.nextActions,
        axError.context
      );
    }
    throw error;
  }
}
