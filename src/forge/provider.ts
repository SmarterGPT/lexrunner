/** Read-only forge observations. None of these methods can apply or merge a plan. */
export type ForgeKind = "github" | "bitbucket";
export type PullRequestState = "open" | "closed" | "all";

export interface ForgeRepository {
  owner: string;
  repo: string;
  url: string;
  defaultBranch: string;
}

export interface ForgePullRequest {
  number: number;
  title: string;
  description: string;
  branch: string;
  sha: string;
  state: "open" | "closed" | "merged";
  draft?: boolean;
  author: string;
  baseBranch: string;
  baseSha: string;
  sourceRepository: string;
  destinationRepository: string;
  labels: string[];
  createdAt?: string;
  updatedAt?: string;
  mergeable?: boolean;
  reviewRequested?: boolean;
}

export interface ForgeDiscoveryOptions {
  state?: PullRequestState;
  query?: string;
  target?: string;
}

export interface ForgeProvider {
  readonly kind: ForgeKind;
  readonly owner: string;
  readonly repo: string;
  getRepository(): Promise<ForgeRepository>;
  getBranchHead(branch: string): Promise<string>;
  discover(options?: ForgeDiscoveryOptions): Promise<ForgePullRequest[]>;
}

export class ForgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForgeError";
  }
}

export function assertForgeIdentity(owner: string, repo: string): void {
  if (![owner, repo].every((part) => /^[A-Za-z0-9_.-]{1,255}$/u.test(part))) {
    throw new ForgeError("Forge repository owner and name must be explicit safe identifiers");
  }
}
