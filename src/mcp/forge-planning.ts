import { z } from "zod";

import { PlanCreationOperationArgsSchema } from "../application/plan-creation-operation-service.js";
import { BitbucketCloudProvider } from "../forge/bitbucket.js";
import { createForgePlan } from "../forge/plan.js";
import { canonicalJSONStringify } from "../util/canonicalJson.js";

const repositoryName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_.-]+$/u);
const label = z.string().min(1).max(512);

export class McpForgeArgumentsError extends Error {
  readonly code = "FORGE_ARGUMENTS_INVALID";
  constructor() {
    super("Forge arguments are invalid or unsupported for the explicitly selected provider");
    this.name = "McpForgeArgumentsError";
  }
}

const discoverySchema = z
  .object({
    provider: z.enum(["github", "bitbucket"]).optional(),
    owner: repositoryName.optional(),
    repo: repositoryName.optional(),
    state: z.enum(["open", "closed", "all"]).optional(),
    suggest: z.boolean().optional(),
    query: z.string().min(1).max(4096).optional(),
    target: label.optional(),
  })
  .strict();

const planSchema = z
  .object({
    ...PlanCreationOperationArgsSchema.shape,
    fromBitbucket: z.boolean().optional(),
  })
  .strict();

export const McpDiscoverJsonSchema = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    provider: {
      type: "string" as const,
      enum: ["github", "bitbucket"],
      description: "Explicit forge (default: github); Bitbucket requires owner and repo",
    },
    owner: { type: "string" as const, minLength: 1, maxLength: 255 },
    repo: { type: "string" as const, minLength: 1, maxLength: 255 },
    state: { type: "string" as const, enum: ["open", "closed", "all"], default: "open" },
    suggest: { type: "boolean" as const, description: "GitHub-only dependency suggestions" },
    query: {
      type: "string" as const,
      minLength: 1,
      maxLength: 4096,
      description: "Bitbucket q filter",
    },
    target: {
      type: "string" as const,
      minLength: 1,
      maxLength: 512,
      description: "Bitbucket target branch",
    },
  },
};

/** Select before any GitHub token lookup, repository inference, network call or write. */
export function parseMcpDiscoveryArgs(raw: unknown) {
  const parsed = discoverySchema.safeParse(raw);
  if (!parsed.success) throw new McpForgeArgumentsError();
  const args = parsed.data;
  if (
    Boolean(args.owner) !== Boolean(args.repo) ||
    (args.provider === "bitbucket" && (!args.owner || !args.repo || args.suggest === true)) ||
    (args.provider !== "bitbucket" && (args.query !== undefined || args.target !== undefined))
  ) {
    throw new McpForgeArgumentsError();
  }
  return args;
}

export function parseMcpPlanCreationArgs(raw: unknown) {
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) throw new McpForgeArgumentsError();
  const { fromBitbucket, ...args } = parsed.data;
  if (fromBitbucket === true) {
    if (
      !args.owner ||
      !args.repo ||
      args.fromGithub === true ||
      [
        args.outDir,
        args.planFile,
        args.repoRoot,
        args.profileDir,
        args.labels,
        args.githubToken,
        args.repos,
      ].some((value) => value !== undefined)
    ) {
      throw new McpForgeArgumentsError();
    }
  }
  return { fromBitbucket: fromBitbucket === true, args };
}

function provider(owner: string, repo: string) {
  return new BitbucketCloudProvider(owner, repo, process.env.BITBUCKET_TOKEN);
}

function boundedResult<T>(result: T): T {
  if (Buffer.byteLength(canonicalJSONStringify(result), "utf8") > 256 * 1024) {
    throw new Error("Bitbucket MCP result exceeds 256 KiB");
  }
  return result;
}

export async function discoverBitbucketForMcp(raw: unknown) {
  const args = parseMcpDiscoveryArgs(raw);
  if (args.provider !== "bitbucket" || !args.owner || !args.repo)
    throw new McpForgeArgumentsError();
  const pullRequests = await provider(args.owner, args.repo).discover(args);
  return boundedResult({
    contract: "bounded-ax-v1",
    provider: "bitbucket",
    authority: "unverified",
    authorizesExecution: false,
    authorizesMerge: false,
    pullRequests: pullRequests.map(({ description: _description, ...pullRequest }) => pullRequest),
    total: pullRequests.length,
  });
}

/** Return a frozen plan in the response only; no profile, checkout or output artifact is inferred. */
export async function createBitbucketPlanForMcp(raw: unknown) {
  const selected = parseMcpPlanCreationArgs(raw);
  const args = selected.args;
  if (!selected.fromBitbucket || !args.owner || !args.repo) throw new McpForgeArgumentsError();
  const plan = await createForgePlan(provider(args.owner, args.repo), {
    query: args.query,
    target: args.target,
    includeDrafts: args.includeDrafts ?? true,
    excludePRs: args.excludePRs,
    requiredGates: args.requiredGates,
    maxWorkers: args.maxWorkers,
  });
  return boundedResult({
    contract: "bounded-ax-v1",
    provider: "bitbucket",
    authority: "unverified",
    authorizesExecution: false,
    authorizesMerge: false,
    plan,
  });
}
