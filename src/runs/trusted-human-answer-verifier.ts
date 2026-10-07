import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { canonicalJSONStringify } from "../util/canonicalJson.js";
import { SignedWorkerHumanAnswer } from "../schemas/worker-human-answer.js";

const id = z.string().min(1).max(512);
const trust = z
  .object({
    runId: id,
    hostId: id,
    keyId: id,
    actorIds: z.array(id).min(1).max(128),
    publicKeyPem: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/u),
  })
  .strict();
export type HumanAnswerHostTrust = z.infer<typeof trust>;

/**
 * Immutable host trust supplied by the protected application, never answer input.
 * A valid signature authenticates the configured host's human-admission assertion;
 * it does not independently prove the host's UI/authentication implementation.
 */
export class TrustedHumanAnswerVerifier {
  private readonly keys = new Map<string, { key: KeyObject; actors: ReadonlySet<string> }>();
  constructor(input: readonly HumanAnswerHostTrust[]) {
    const entries = z.array(trust).min(1).max(128).parse(input);
    for (const entry of entries) {
      const key = createPublicKey(entry.publicKeyPem);
      const identity = JSON.stringify([entry.runId, entry.hostId, entry.keyId]);
      if (
        key.asymmetricKeyType !== "ed25519" ||
        this.keys.has(identity) ||
        new Set(entry.actorIds).size !== entry.actorIds.length
      ) {
        throw new TypeError("Invalid or duplicate human host trust");
      }
      this.keys.set(identity, { key, actors: new Set(entry.actorIds) });
    }
  }

  verify(input: SignedWorkerHumanAnswer): boolean {
    const parsed = SignedWorkerHumanAnswer.safeParse(input);
    if (!parsed.success) return false;
    const { payload, signature } = parsed.data;
    const entry = this.keys.get(
      JSON.stringify([payload.challenge.runId, payload.hostId, payload.keyId])
    );
    if (!entry?.actors.has(payload.actorId)) return false;
    const bytes = Buffer.from(signature, "base64url");
    return (
      bytes.length === 64 &&
      bytes.toString("base64url") === signature &&
      verify(null, Buffer.from(canonicalJSONStringify(payload), "utf8"), entry.key, bytes)
    );
  }
}
