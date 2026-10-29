import * as fs from "node:fs";
import { canonicalJSONStringify } from "../util/canonicalJson.js";
import { ForgeError } from "./provider.js";
import { BitbucketCloudProvider } from "./bitbucket.js";
import { createForgePlan } from "./plan.js";

/** Explicit provider selection avoids inferring Bitbucket credentials from GitHub configuration. */
export function bitbucketFromOptions(opts: { owner?: string; repo?: string }) {
  if (!opts.owner || !opts.repo) {
    throw new ForgeError("Bitbucket Cloud requires explicit --owner <workspace> and --repo <slug>");
  }
  return new BitbucketCloudProvider(opts.owner, opts.repo, process.env.BITBUCKET_TOKEN);
}

export async function runBitbucketDiscovery(opts: {
  owner?: string;
  repo?: string;
  state?: "open" | "closed" | "all";
  query?: string;
  target?: string;
  suggest?: boolean;
  output?: string;
}) {
  if (opts.suggest) throw new ForgeError("Dependency suggestions are currently GitHub-only");
  const provider = bitbucketFromOptions(opts);
  const prs = await provider.discover({
    state: opts.state,
    query: opts.query,
    target: opts.target,
  });
  const result = {
    contract: "bounded-ax-v1",
    provider: "bitbucket",
    authority: "unverified",
    authorizesExecution: false,
    authorizesMerge: false,
    pullRequests: prs.map(({ description: _description, ...pr }) => pr),
    total: prs.length,
  };
  const json = canonicalJSONStringify(result);
  if (Buffer.byteLength(json, "utf8") > 256 * 1024)
    throw new ForgeError("Discovery result exceeds 256 KiB");
  if (opts.output) fs.writeFileSync(opts.output, `${json}\n`);
  else console.log(json);
  return result;
}

export async function runBitbucketPlan(
  opts: {
    owner?: string;
    repo?: string;
    query?: string;
    target?: string;
    includeDrafts?: boolean;
    excludePrs?: string[] | string;
    requiredGates?: string;
    maxWorkers?: number;
    output?: string;
    json?: boolean;
    dryRun?: boolean;
    labels?: unknown;
    suggestDeps?: boolean;
    githubToken?: string;
    out?: string;
    repoRoot?: string;
    profileDir?: string;
    tierOverride?: unknown;
    showTiers?: boolean;
    optimize?: boolean;
    format?: string;
    threshold?: number;
  },
  globalJson = false
) {
  // Do not silently ignore GitHub/profile/heuristic routing options on a different forge.
  if (
    opts.labels ||
    opts.suggestDeps ||
    opts.githubToken ||
    opts.out ||
    opts.repoRoot ||
    opts.profileDir ||
    opts.tierOverride ||
    opts.showTiers ||
    opts.optimize ||
    opts.format ||
    opts.threshold
  ) {
    throw new ForgeError(
      "Bitbucket planning does not support GitHub, profile or dependency-suggestion options"
    );
  }
  const provider = bitbucketFromOptions(opts);
  const excluded =
    typeof opts.excludePrs === "string" ? opts.excludePrs.split(",") : opts.excludePrs;
  if (excluded?.some((value) => !/^[1-9][0-9]*$/u.test(value))) {
    throw new ForgeError("Excluded pull request IDs must be positive integers");
  }
  const plan = await createForgePlan(provider, {
    query: opts.query,
    target: opts.target,
    includeDrafts: opts.includeDrafts,
    excludePRs: excluded?.map(Number),
    requiredGates: opts.requiredGates?.split(",").map((gate) => gate.trim()),
    maxWorkers: opts.maxWorkers,
  });
  const json = canonicalJSONStringify(plan);
  if (Buffer.byteLength(json, "utf8") > 256 * 1024)
    throw new ForgeError("Generated plan exceeds 256 KiB");
  if (!opts.dryRun && opts.output) fs.writeFileSync(opts.output, `${json}\n`);
  if (opts.json || globalJson || !opts.output) console.log(json);
  else
    console.log(
      `${opts.dryRun ? "Validated" : "Wrote"} Bitbucket planning-only plan (${plan.items.length} items). Apply/merge is unsupported.`
    );
  return plan;
}
