/**
 * Cryptographic hash utilities for deterministic artifacts
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Compute SHA-256 hash of buffer or string
 */
export const sha256 = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");

/**
 * Compute SHA-256 hash of file using raw bytes (no encoding normalization)
 */
export function sha256FileRaw(fp: string): string {
  const b = fs.readFileSync(fp); // raw bytes, no encoding
  return sha256(b);
}

/**
 * Redact environment variables with security-sensitive patterns
 */
const SECRET_KEY_RX = /(TOKEN|KEY|SECRET|PASS(WORD)?|CRED)/i;
export function redactEnv(env: NodeJS.ProcessEnv) {
  const keys = Object.keys(env).sort();
  return keys.map((k) => ({ key: k, value: SECRET_KEY_RX.test(k) ? "REDACTED" : "REDACTED" })); // never print values
}

/**
 * Generate stable environment fingerprint (redacted for security)
 */
export function environmentFingerprint(): {
  node: string;
  platform: string;
  arch: string;
  envKeys: string[];
  sensitiveRedacted: number;
} {
  const envKeys = Object.keys(process.env).sort();
  const sensitivePattern = /(TOKEN|KEY|SECRET|PASSWORD|AUTH|CREDENTIAL|PASS)/i;
  const sensitiveKeys = envKeys.filter((key) => sensitivePattern.test(key));

  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    envKeys: envKeys.filter((key) => !sensitivePattern.test(key)), // Only non-sensitive keys
    sensitiveRedacted: sensitiveKeys.length,
  };
}

/**
 * Generate deterministic lockfile hash (if available)
 */
export function lockfileHash(baseDir = process.cwd()): string | null {
  const lockfiles = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"];

  for (const lockfile of lockfiles) {
    try {
      return sha256FileRaw(path.join(baseDir, lockfile));
    } catch {
      // File doesn't exist, try next
      continue;
    }
  }

  return null;
}
