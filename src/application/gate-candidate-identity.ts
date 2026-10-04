import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { fileIdentity, resolveSpawnExecutable } from "../gates/execution-receipt.js";

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 16_384;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export const GateCandidateIdentitySchema = z
  .object({
    repositoryRoot: z.string().min(1),
    head: z.string().regex(/^[a-f0-9]{40,64}$/u),
    worktreeDigest: z.string().regex(SHA256_PATTERN),
  })
  .strict();
export type GateCandidateIdentity = z.infer<typeof GateCandidateIdentitySchema>;

export class GateCandidateIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateCandidateIdentityError";
  }
}

/** Resolve the physical Git root without hashing a candidate or changing process cwd. */
export function resolveGateRepositoryRoot(cwd: string): string {
  try {
    const git = createGitRunner(cwd);
    const root = realpathSync(git.text(cwd, ["rev-parse", "--show-toplevel"]).trim());
    git.assertUnchanged();
    return root;
  } catch {
    throw new GateCandidateIdentityError("Gate repository root is unavailable");
  }
}

/** Capture the exact Git candidate tested by a gate without mutating the index or worktree. */
export function captureGateCandidateIdentity(
  cwd: string,
  excludedArtifactRoot?: string
): GateCandidateIdentity {
  try {
    const git = createGitRunner(cwd);
    const repositoryRoot = realpathSync(git.text(cwd, ["rev-parse", "--show-toplevel"]).trim());
    const head = git.text(repositoryRoot, ["rev-parse", "--verify", "HEAD"]).trim();
    const pathspec = candidatePathspec(git.bytes, repositoryRoot, excludedArtifactRoot);
    const status = git.bytes(repositoryRoot, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      ...pathspec,
    ]);
    const diff = git.bytes(repositoryRoot, [
      "diff",
      "--binary",
      "--no-ext-diff",
      "HEAD",
      ...pathspec,
    ]);
    const untracked = splitNullTerminated(
      git.bytes(repositoryRoot, ["ls-files", "--others", "--exclude-standard", "-z", ...pathspec])
    );
    if (untracked.length > MAX_UNTRACKED_FILES) {
      throw new Error(`candidate has more than ${MAX_UNTRACKED_FILES} untracked files`);
    }

    const digest = createHash("sha256");
    digest.update("lexrunner-gate-candidate/v1\0", "utf8");
    digest.update(head, "utf8");
    digest.update("\0status\0", "utf8");
    digest.update(status);
    digest.update("\0diff\0", "utf8");
    digest.update(diff);
    for (const relativePath of untracked.sort()) {
      digest.update("\0untracked\0", "utf8");
      digest.update(relativePath, "utf8");
      digest.update("\0", "utf8");
      hashFileInto(digest, resolve(repositoryRoot, relativePath));
    }
    git.assertUnchanged();
    return GateCandidateIdentitySchema.parse({
      repositoryRoot,
      head,
      worktreeDigest: `sha256:${digest.digest("hex")}`,
    });
  } catch (error) {
    throw new GateCandidateIdentityError(
      `Gate candidate identity is unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function candidatePathspec(
  gitBytes: (cwd: string, args: string[]) => Buffer,
  repositoryRoot: string,
  excludedArtifactRoot?: string
): string[] {
  if (!excludedArtifactRoot) return [];
  const relativeArtifactRoot = relative(repositoryRoot, resolve(excludedArtifactRoot));
  if (
    relativeArtifactRoot === "" ||
    relativeArtifactRoot === ".." ||
    relativeArtifactRoot.startsWith(`..${sep}`) ||
    isAbsolute(relativeArtifactRoot)
  ) {
    return [];
  }
  const portable = relativeArtifactRoot.split(sep).join("/");
  const tracked = gitBytes(repositoryRoot, ["ls-files", "-z", "--", portable, `${portable}/**`]);
  if (tracked.length > 0) {
    throw new Error("the gate artifact root contains tracked candidate files");
  }
  return ["--", ".", `:(exclude)${portable}`, `:(exclude)${portable}/**`];
}

export function sameGateCandidate(
  left: GateCandidateIdentity,
  right: GateCandidateIdentity
): boolean {
  return (
    normalizeRoot(left.repositoryRoot) === normalizeRoot(right.repositoryRoot) &&
    left.head === right.head &&
    left.worktreeDigest === right.worktreeDigest
  );
}

function createGitRunner(cwd: string): {
  bytes: (runCwd: string, args: string[]) => Buffer;
  text: (runCwd: string, args: string[]) => string;
  assertUnchanged: () => void;
} {
  const executable = resolveSpawnExecutable("git", process.env, cwd, process.platform);
  const identity = fileIdentity(executable);
  if (!identity) throw new Error("resolved Git executable is not evidence-bindable");
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase().startsWith("GIT_")) delete environment[key];
  }
  const bytes = (runCwd: string, args: string[]) =>
    execFileSync(executable, args, {
      cwd: runCwd,
      env: environment,
      encoding: "buffer",
      windowsHide: true,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    });
  return {
    bytes,
    text: (runCwd, args) => bytes(runCwd, args).toString("utf8"),
    assertUnchanged: () => {
      const after = fileIdentity(executable);
      if (!after || after.sha256 !== identity.sha256 || after.bytes !== identity.bytes) {
        throw new Error("Git executable identity changed during candidate capture");
      }
    },
  };
}

function splitNullTerminated(value: Buffer): string[] {
  return value.toString("utf8").split("\0").filter(Boolean);
}

function hashFileInto(hash: ReturnType<typeof createHash>, filePath: string): void {
  const descriptor = openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const bytes = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(descriptor);
  }
}

function normalizeRoot(value: string): string {
  const resolved = resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
