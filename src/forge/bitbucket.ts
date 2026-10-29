import { z } from "zod";
import {
  ForgeError,
  assertForgeIdentity,
  type ForgeProvider,
  type ForgeDiscoveryOptions,
  type ForgePullRequest,
} from "./provider.js";

const label = z.string().min(1).max(512);
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const repository = z.object({ full_name: label });
const endpoint = z.object({
  branch: z.object({ name: label }),
  commit: z.object({ hash: commit }),
  repository,
});
const pullRequest = z.object({
  id: z.number().int().positive(),
  title: label,
  description: z
    .string()
    .max(64 * 1024)
    .nullish(),
  state: z.enum(["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]),
  draft: z.boolean().optional(),
  author: z.object({ display_name: label.optional(), nickname: label.optional() }),
  source: endpoint,
  destination: endpoint,
});
const MAX_RESPONSE_BYTES = 1024 * 1024;

function parseResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ForgeError("Bitbucket response does not satisfy the bounded observation schema");
  return parsed.data;
}

/** Bitbucket Cloud only, fixed origin, bounded GETs and no redirects or writes. */
export class BitbucketCloudProvider implements ForgeProvider {
  readonly kind = "bitbucket" as const;
  private readonly base: string;

  constructor(
    readonly owner: string,
    readonly repo: string,
    private readonly token?: string,
    private readonly fetcher: typeof fetch = fetch
  ) {
    assertForgeIdentity(owner, repo);
    if (token !== undefined && (!token || token.length > 8192 || /[\r\n]/u.test(token))) {
      throw new ForgeError("Invalid Bitbucket access token");
    }
    this.base = `https://api.bitbucket.org/2.0/repositories/${owner}/${repo}`;
  }

  async getRepository() {
    const data = parseResponse(
      z.object({ full_name: label, mainbranch: z.object({ name: label }) }),
      await this.get(this.base)
    );
    this.assertRepository(data.full_name);
    return {
      owner: this.owner,
      repo: this.repo,
      url: `https://bitbucket.org/${this.owner}/${this.repo}`,
      defaultBranch: data.mainbranch.name,
    };
  }

  async getBranchHead(branch: string) {
    if (!branch || branch.length > 512 || /[\x00-\x1f\x7f]/u.test(branch)) {
      throw new ForgeError("Invalid Bitbucket branch");
    }
    return parseResponse(
      z
        .object({ name: label, target: z.object({ hash: commit }) })
        .refine((value) => value.name === branch),
      await this.get(`${this.base}/refs/branches/${encodeURIComponent(branch)}`)
    ).target.hash;
  }

  async discover(options: ForgeDiscoveryOptions = {}): Promise<ForgePullRequest[]> {
    const state = options.state ?? "open";
    if (!["open", "closed", "all"].includes(state)) throw new ForgeError("Invalid PR state");
    if (options.query && Buffer.byteLength(options.query, "utf8") > 4096) {
      throw new ForgeError("Bitbucket query exceeds the 4096-byte limit");
    }
    if (
      options.target !== undefined &&
      (!options.target || Buffer.byteLength(options.target, "utf8") > 512)
    ) {
      throw new ForgeError("Bitbucket target branch is invalid or exceeds 512 bytes");
    }
    const filters = [
      ...(state === "open"
        ? ['state="OPEN"']
        : state === "closed"
          ? ['state!="OPEN"']
          : ['state IN ("OPEN","MERGED","DECLINED","SUPERSEDED")']),
      ...(options.target ? [`destination.branch.name=${JSON.stringify(options.target)}`] : []),
      ...(options.query ? [`(${options.query})`] : []),
    ];
    const url = new URL(`${this.base}/pullrequests`);
    url.searchParams.set("pagelen", "50");
    // Put state in q, including when the caller supplies another filter. A separate
    // state=OPEN can be ignored by the API when q is present.
    if (filters.length) url.searchParams.set("q", filters.join(" AND "));
    const values = await this.collection(url, pullRequest);
    const result = values.map((pr) => {
      this.assertRepository(pr.destination.repository.full_name);
      return {
        number: pr.id,
        title: pr.title,
        description: pr.description ?? "",
        branch: pr.source.branch.name,
        sha: pr.source.commit.hash,
        state: pr.state === "OPEN" ? "open" : pr.state === "MERGED" ? "merged" : "closed",
        draft: pr.draft ?? false,
        author: pr.author.display_name ?? pr.author.nickname ?? "unknown",
        baseBranch: pr.destination.branch.name,
        baseSha: pr.destination.commit.hash,
        sourceRepository: pr.source.repository.full_name,
        destinationRepository: pr.destination.repository.full_name,
        labels: [],
      } satisfies ForgePullRequest;
    });
    if (new Set(result.map((pr) => pr.number)).size !== result.length) {
      throw new ForgeError(
        "Bitbucket pagination returned duplicate pull requests; refresh discovery"
      );
    }
    // Do not trust server filtering alone for state/target selection.
    if (
      result.some(
        (pr) =>
          (state === "open" && pr.state !== "open") ||
          (state === "closed" && pr.state === "open") ||
          (options.target !== undefined && pr.baseBranch !== options.target)
      )
    ) {
      throw new ForgeError(
        "Bitbucket discovery returned a pull request outside the requested scope"
      );
    }
    return result.sort((a, b) => a.number - b.number);
  }

  async getCommitStatuses(sha: string) {
    if (!commit.safeParse(sha).success)
      throw new ForgeError("Bitbucket status lookup requires a full commit ID");
    return this.collection(
      new URL(`${this.base}/commit/${sha}/statuses?pagelen=50`),
      z.object({
        key: label,
        state: z.enum(["SUCCESSFUL", "FAILED", "INPROGRESS", "STOPPED"]),
        name: label.optional(),
      })
    );
  }

  private assertRepository(fullName: string) {
    if (fullName.toLowerCase() !== `${this.owner}/${this.repo}`.toLowerCase()) {
      throw new ForgeError("Bitbucket response repository does not match the requested repository");
    }
  }

  private async collection<T>(initial: URL, schema: z.ZodType<T>): Promise<T[]> {
    const result: T[] = [];
    const visited = new Set<string>();
    let current: URL | undefined = initial;
    while (current) {
      if (visited.size >= 8 || visited.has(current.href)) {
        throw new ForgeError(
          "Bitbucket pagination exceeded its bounded page limit or repeated a page"
        );
      }
      if (
        current.origin !== initial.origin ||
        current.pathname !== initial.pathname ||
        current.username ||
        current.password ||
        current.hash ||
        current.searchParams.get("q") !== initial.searchParams.get("q")
      ) {
        throw new ForgeError("Bitbucket pagination left the requested collection");
      }
      visited.add(current.href);
      const page: { values: T[]; next?: string } = parseResponse(
        z.object({ values: z.array(schema).max(100), next: z.string().max(8192).optional() }),
        await this.get(current.href)
      );
      result.push(...page.values);
      if (result.length > 256) throw new ForgeError("Forge discovery exceeds the 256-item limit");
      current = page.next ? new URL(page.next, initial) : undefined;
    }
    return result;
  }

  private async get(url: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          Accept: "application/json",
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
      });
    } catch {
      throw new ForgeError("Bitbucket request failed (network, timeout or redirect)");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ForgeError(`Bitbucket request failed with HTTP ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ForgeError("Bitbucket returned an empty response");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES)
          throw new ForgeError("Bitbucket response exceeds the 1 MiB limit");
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      await reader.cancel().catch(() => undefined);
      throw new ForgeError("Bitbucket returned invalid, oversized or incomplete JSON");
    } finally {
      reader.releaseLock();
    }
  }
}
