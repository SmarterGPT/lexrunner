import { Plan } from "../schema.js";
import { computeMergeOrder } from "../mergeOrder.js";
import { getStandardGateCommand } from "../core/standardGateCommands.js";
import { ForgeError, type ForgeProvider } from "./provider.js";

export interface ForgePlanOptions {
  query?: string;
  target?: string;
  includeDrafts?: boolean;
  excludePRs?: number[];
  requiredGates?: string[];
  maxWorkers?: number;
}

/** Freeze observations only. No checkout, Git command, gate command, merge or forge write. */
export async function createForgePlan(provider: ForgeProvider, options: ForgePlanOptions = {}) {
  const repository = await provider.getRepository();
  const target = options.target ?? repository.defaultBranch;
  const targetCommit = await provider.getBranchHead(target);
  const prs = (await provider.discover({ state: "open", query: options.query, target })).filter(
    (pr) => (options.includeDrafts || !pr.draft) && !options.excludePRs?.includes(pr.number)
  );
  const fullName = `${provider.owner}/${provider.repo}`.toLowerCase();
  const names = new Set(prs.map((pr) => `PR-${pr.number}`));
  const gates = options.requiredGates ?? ["lint", "typecheck", "test"];
  if (new Set(gates).size !== gates.length || gates.length > 64) {
    throw new ForgeError("Required gate names must be unique and bounded");
  }
  const items = prs
    .map((pr) => {
      if (
        pr.sourceRepository.toLowerCase() !== fullName ||
        pr.destinationRepository.toLowerCase() !== fullName ||
        pr.baseBranch !== target
      ) {
        throw new ForgeError(
          "Forge plans currently require same-repository pull requests on the selected target"
        );
      }
      if (pr.baseSha !== targetCommit) {
        throw new ForgeError("The target changed during discovery; refresh the Bitbucket plan");
      }
      const dependencies: string[] = [];
      for (const match of pr.description.matchAll(/^\s*Depends-on:\s*(.+)$/gimu)) {
        for (const reference of match[1]!.split(/[\s,]+/u).filter(Boolean)) {
          const parsed = /^(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#([1-9][0-9]*)$/u.exec(reference);
          if (!parsed || (parsed[1] && parsed[1].toLowerCase() !== fullName)) {
            throw new ForgeError(
              "Depends-on references must identify pull requests in the selected repository"
            );
          }
          const dependency = `PR-${parsed[2]}`;
          if (!names.has(dependency))
            throw new ForgeError("A Depends-on pull request is outside the selected plan");
          dependencies.push(dependency);
        }
      }
      return {
        name: `PR-${pr.number}`,
        deps: [...new Set(dependencies)].sort(),
        gates: gates.map((name) => ({
          name,
          run: getStandardGateCommand(name),
          cwd: ".",
          ...(name === "test" || name === "unit" ? { timeoutMs: 300000 } : {}),
        })),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const plan = Plan.parse({
    schemaVersion: "1.0.1",
    target,
    policy: { requiredGates: gates, maxWorkers: options.maxWorkers ?? 2 },
    gitInputs: {
      schemaVersion: "1.0.0",
      repository: `${repository.url.replace(/\.git$/u, "").replace(/\/$/u, "")}.git`,
      checkoutRemote: "origin",
      acquisition: "fetch",
      target: { ref: `refs/heads/${target}`, commit: targetCommit },
      sources: prs
        .map((pr) => ({ item: `PR-${pr.number}`, ref: `refs/heads/${pr.branch}`, commit: pr.sha }))
        .sort((a, b) => a.item.localeCompare(b.item)),
    },
    items,
  });
  computeMergeOrder(plan);
  return plan;
}
