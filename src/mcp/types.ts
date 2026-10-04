/**
 * MCP server types and configurations
 */

import { z } from "zod";
import { getEnvWithAlias } from "../util/envUtils.js";

/**
 * Environment configuration for MCP server
 */
export interface MCPEnvironment {
  LEX_PR_PROFILE_DIR?: string;
  ALLOW_MUTATIONS: boolean;
}

/**
 * Get MCP environment configuration with defaults
 * Supports LEX_PR_PROFILE_DIR for profile resolution precedence
 * Supports LEXRUNNER_* aliases for backward compatibility
 */
export function getMCPEnvironment(): MCPEnvironment {
  return {
    LEX_PR_PROFILE_DIR: getEnvWithAlias("LEX_PR_PROFILE_DIR", "LEXRUNNER_PROFILE_DIR"),
    ALLOW_MUTATIONS: process.env.ALLOW_MUTATIONS === "true",
  };
}

/**
 * Validation schemas for MCP tool parameters
 */

/**
 * Single repository configuration for multi-repo discovery
 */
export const RepoTarget = z.object({
  owner: z.string(),
  repo: z.string(),
  priority: z.number().optional().default(1),
});
export type RepoTarget = z.infer<typeof RepoTarget>;

export const PlanCreateArgs = z.object({
  json: z.boolean().optional(),
  outDir: z.string().optional(),
  // GitHub auto-discovery options
  fromGithub: z.boolean().optional(),
  query: z.string().optional(),
  labels: z.array(z.string()).optional(),
  includeDrafts: z.boolean().optional(),
  excludePRs: z.array(z.number()).optional(),
  githubToken: z.string().optional(),
  // Single repo mode (backward compatible)
  owner: z.string().optional(),
  repo: z.string().optional(),
  // Multi-repo mode (issue #677)
  repos: z.array(RepoTarget).optional(),
  requiredGates: z.array(z.string()).optional(),
  maxWorkers: z.number().optional(),
  target: z.string().optional(),
});
export type PlanCreateArgs = z.infer<typeof PlanCreateArgs>;

export const GatesRunArgs = z.object({
  planFile: z.string().min(1).max(4096).optional(),
  repoRoot: z.string().min(1).max(4096).optional(),
  onlyItem: z.string().optional(),
  onlyGate: z.string().optional(),
  outDir: z.string().optional(),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60 * 1000)
    .optional(),
});
export type GatesRunArgs = z.infer<typeof GatesRunArgs>;

export const MergeApplyArgs = z.object({
  planFile: z.string().min(1).max(4096).optional(),
  dryRun: z.boolean().optional(),
});
export type MergeApplyArgs = z.infer<typeof MergeApplyArgs>;

export const InitLocalArgs = z.object({
  force: z.boolean().optional(),
});
export type InitLocalArgs = z.infer<typeof InitLocalArgs>;

export const ProfileResolveArgs = z.object({
  profileDir: z.string().optional(),
});
export type ProfileResolveArgs = z.infer<typeof ProfileResolveArgs>;

/**
 * MCP tool result types
 */

export interface PlanCreateResult {
  plan: object;
  outDir: string;
}

export interface GatesRunResult {
  contract: "bounded-ax-v1";
  items: Array<{
    name: string;
    status: string;
    gates: Array<{
      name: string;
      status: string;
    }>;
  }>;
  allGreen: boolean;
  artifactRefs: import("../application/gate-execution-service.js").BoundedGateRunResult["artifactRefs"];
  planArtifact: import("../application/plan-artifact-service.js").PlanArtifactIdentity;
}

export interface MergeApplyResult {
  allowed: boolean;
  message: string;
}

export interface InitLocalResult {
  created: boolean;
  path: string;
  config: {
    role: string;
    projectType: string;
    name?: string;
    version?: string;
  };
  copiedFiles: string[];
}

export interface ProfileResolveResult {
  path: string;
  source: string;
  manifest: {
    role: string;
    name?: string;
    version?: string;
  };
}

/**
 * AX-004 Parity tools - argument schemas
 */

export const DiscoverArgs = z.object({
  owner: z.string().optional(),
  repo: z.string().optional(),
  state: z.enum(["open", "closed", "all"]).optional(),
  suggest: z.boolean().optional(),
});
export type DiscoverArgs = z.infer<typeof DiscoverArgs>;

export const StatusArgs = z
  .object({
    planFile: z.string().optional(),
    repoRoot: z.string().min(1).max(4096).optional(),
    evidenceFile: z.string().min(1).max(4096).optional(),
    evidenceSha256: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .optional(),
  })
  .refine((value) => Boolean(value.evidenceFile) === Boolean(value.evidenceSha256), {
    message: "evidenceFile and evidenceSha256 must be supplied together",
  });
export type StatusArgs = z.infer<typeof StatusArgs>;

export const MergeOrderArgs = z.object({
  planFile: z.string().optional(),
});
export type MergeOrderArgs = z.infer<typeof MergeOrderArgs>;

export const ConfigShowArgs = z.object({
  key: z.string().optional(),
});
export type ConfigShowArgs = z.infer<typeof ConfigShowArgs>;

export const WorkflowGuideArgs = z.object({
  phase: z.enum([
    "initial",
    "post-plan-creation",
    "post-gates-run",
    "pre-merge",
    "post-merge",
    "error-recovery",
  ]),
});
export type WorkflowGuideArgs = z.infer<typeof WorkflowGuideArgs>;

/**
 * AX-004 Parity tools - result types
 */

export interface DiscoverResult {
  pullRequests: Array<{
    number: number;
    title: string;
    branch: string;
    author: string;
    labels: string[];
    sha: string;
  }>;
  suggestions?: Array<{
    from: string;
    to: string;
    confidence: number;
    heuristic: string;
    reason: string;
  }>;
  total: number;
  suggestionsCount?: number;
  authenticated: boolean;
  user?: string;
}

export interface StatusResult {
  plan: {
    schemaVersion: string;
    target: string;
    itemCount: number;
    policy?: object;
  };
  mergeSummary: {
    eligible: string[];
    pending: string[];
    blocked: string[];
    failed: string[];
  };
}

export interface DoctorResult {
  hasErrors: boolean;
  issues: string[];
  suggestions: string[];
  nodejs?: { status: string; current: string; expected?: string };
  configuration?: {
    hasConfiguration: boolean;
    missingFiles: string[];
    suggestions: string[];
  };
  projectType?: string;
  environmentSuggestions?: string[];
  github?: {
    detected: boolean;
    authenticated?: boolean;
    user?: string;
    error?: string;
  };
  git?: {
    status: string;
    isClean?: boolean;
    currentBranch?: string;
    error?: string;
  };
}

export interface MergeOrderResult {
  levels: string[][];
  totalItems: number;
  maxParallelism: number;
}

export interface ConfigShowResult {
  config?: {
    items: unknown[];
    target: string;
    version: string;
  };
  provenance?: Record<string, string>;
  sources?: Array<{ exists: boolean; file: string }>;
  key?: string;
  value?: unknown;
}

/**
 * AX-016 Granular plan tools - argument schemas
 */

export const PrListArgs = z.object({
  owner: z.string().optional(),
  repo: z.string().optional(),
  query: z.string().optional(),
  labels: z.array(z.string()).optional(),
  includeDrafts: z.boolean().optional(),
  excludePRs: z.array(z.number()).optional(),
  githubToken: z.string().optional(),
  state: z.enum(["open", "closed", "all"]).optional(),
});
export type PrListArgs = z.infer<typeof PrListArgs>;

export const PlanValidateArgs = z.object({
  planFile: z.string().optional(),
  planContent: z.string().optional(),
});
export type PlanValidateArgs = z.infer<typeof PlanValidateArgs>;

export const PlanAnalyzeArgs = z.object({
  planFile: z.string().optional(),
});
export type PlanAnalyzeArgs = z.infer<typeof PlanAnalyzeArgs>;

/**
 * AX-016 Granular plan tools - result types
 */

export interface PrListResult {
  pullRequests: Array<{
    number: number;
    title: string;
    branch: string;
    author: string;
    labels: string[];
    sha: string;
    draft?: boolean;
  }>;
  total: number;
  filtered: number;
  owner: string;
  repo: string;
}

export interface PlanValidateResult {
  contract: "bounded-ax-v1";
  valid: boolean;
  code?: string;
  message?: string;
  errorCount?: number;
  errors?: Array<{
    path: string;
    message: string;
    code?: string;
  }>;
  errorsTruncated?: boolean;
  nextActions?: string[];
  context?: {
    errorCount: number;
    errorsTruncated: boolean;
  };
  warnings?: string[];
  plan?: {
    schemaVersion: string;
    target: string;
    itemCount: number;
  };
}

export interface PlanAnalyzeResult {
  valid: boolean;
  mergeOrder?: string[][];
  conflicts?: Array<{
    type: string;
    message: string;
    items?: string[];
  }>;
  dependencies?: {
    total: number;
    cycles?: string[][];
    unknown?: string[];
  };
  summary: {
    totalItems: number;
    maxParallelism: number;
    hasIssues: boolean;
  };
}

/**
 * ADR-007 Task Handoff Tools - argument schemas
 */

export const CreateTaskSnapshotArgs = z.object({
  taskId: z.string().optional(),
  procedure: z.string(),
  determinism: z.enum(["D1", "D2", "D3"]).optional(),
  failureMessage: z.string(),
  failureFileRel: z.string(),
  failureLine: z.number().int().positive().optional(),
  runnerOutputSnip: z.string(),
  failureExcerpt: z.string().optional(),
  targetFiles: z.array(z.string()),
  verificationCmd: z.string(),
  expectedExitCode: z.number().int().optional(),
  repoRoot: z.string().optional(),
  repoId: z.string().optional(),
  commitSha: z.string().optional(),
});
export type CreateTaskSnapshotArgs = z.infer<typeof CreateTaskSnapshotArgs>;

export const SubmitTaskReceiptArgs = z.object({
  receipt: z.any(), // Accept any object - will be validated by parseTaskReceipt
});
export type SubmitTaskReceiptArgs = z.infer<typeof SubmitTaskReceiptArgs>;

export const GetTaskStatusArgs = z.object({
  taskId: z.string(),
});
export type GetTaskStatusArgs = z.infer<typeof GetTaskStatusArgs>;

export const ListPendingTasksArgs = z.object({
  procedure: z.string().optional(),
  determinism: z.enum(["D1", "D2", "D3"]).optional(),
  limit: z.number().int().positive().optional(),
});
export type ListPendingTasksArgs = z.infer<typeof ListPendingTasksArgs>;

/**
 * ADR-007 Task Handoff Tools - result types
 */

export interface CreateTaskSnapshotResult {
  snapshot: object; // TaskSnapshot_v1
  taskId: string;
}

export interface SubmitTaskReceiptResult {
  acknowledged: boolean;
  taskId: string;
  verification: {
    verified: boolean;
    trustGap: boolean;
    patchApplied: boolean;
  };
}

export interface GetTaskStatusResult {
  taskId: string;
  state: "pending" | "in_progress" | "completed" | "verified" | "failed";
  snapshot?: object;
  receipt?: object;
  verification?: object;
}

export interface ListPendingTasksResult {
  tasks: Array<{
    taskId: string;
    procedure: string;
    determinism: string;
    state: string;
    snapshot?: object;
  }>;
  total: number;
}

/**
 * Fanout AX Tools - D0/D1 Pipeline (Epic #654 Layer 2)
 */

export const FanoutHarvestArgs = z.object({
  owner: z.string().optional(),
  repo: z.string().optional(),
  state: z.enum(["open", "closed", "all"]).optional(),
  includeIssues: z.boolean().optional(),
  maxBody: z.number().int().positive().optional(),
  githubToken: z.string().optional(),
});
export type FanoutHarvestArgs = z.infer<typeof FanoutHarvestArgs>;

export const FanoutAnalyzeArgs = z.object({
  harvestBundle: z.any(), // Accept HarvestBundle JSON object
  fromFile: z.string().optional(), // Alternative: path to harvest bundle file
});
export type FanoutAnalyzeArgs = z.infer<typeof FanoutAnalyzeArgs>;

export interface FanoutHarvestResult {
  schemaVersion: string;
  phase: string;
  timestamp: string;
  inputDigest: string;
  bundle: {
    repository: {
      owner: string;
      name: string;
      defaultBranch: string;
      defaultBranchSha: string;
    };
    pullRequests: Array<object>;
    issues: Array<object>;
    harvestedAt: string;
  };
  outputDigest: string;
}

export interface FanoutAnalyzeResult {
  schemaVersion: string;
  phase: string;
  timestamp: string;
  inputDigest: string;
  pool: {
    entities: Array<object>;
    relations: Array<object>;
    conflicts: Array<object>;
    blockers: Array<object>;
  };
  outputDigest: string;
}
