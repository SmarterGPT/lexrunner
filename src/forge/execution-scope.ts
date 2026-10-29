import { repositoryIdentity } from "../git/input-schema.js";
import type { Plan } from "../schema.js";

/** Shared feature-availability check, independent of transport and caller authority. */
export function unsupportedForgeExecutionReason(plan: Pick<Plan, "gitInputs">): string | undefined {
  if (!plan.gitInputs) return undefined;
  const host = repositoryIdentity(plan.gitInputs.repository).split("/")[0]!.split(":")[0];
  return host === "bitbucket.org"
    ? "Bitbucket Cloud plans support discovery and planning only; apply/merge is unavailable"
    : undefined;
}

export function assertForgeExecutionSupported(plan: Pick<Plan, "gitInputs">): void {
  const reason = unsupportedForgeExecutionReason(plan);
  if (reason) throw new Error(reason);
}
