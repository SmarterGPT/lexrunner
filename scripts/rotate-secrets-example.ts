#!/usr/bin/env tsx
/**
 * Secret Rotation Example Script
 *
 * Demonstrates rotation checks with deterministic JSON output.
 * Exit codes follow security CLI semantics:
 * - 0: All secrets within policy (ok)
 * - 1: Rotation needed (findings)
 * - 2: Internal error
 */

import { SecretsManager } from "../src/security/secrets.js";
import { pathToFileURL } from "node:url";
import { canonicalJSONStringify } from "../src/util/canonicalJson.js";

/**
 * Rotation check result structure (deterministic)
 */
interface RotationCheckResult {
  /** Command identifier */
  command: string;
  /** Status classification */
  status: "ok" | "findings" | "error";
  /** Exit code */
  exitCode: number;
  /** Findings payload */
  findings: {
    /** Secrets needing rotation (sorted) */
    needsRotation: string[];
    /** Secrets within policy (sorted) */
    ok: string[];
    /** Maximum age threshold in days */
    maxAgeDays: number;
  };
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Check secret rotation status
 */
async function checkRotation(
  secretIds: string[],
  maxAgeDays: number
): Promise<RotationCheckResult> {
  const secretsManager = new SecretsManager();
  const needsRotation: string[] = [];
  const ok: string[] = [];

  for (const secretId of secretIds) {
    try {
      const needs = await secretsManager.checkRotationNeeded(secretId, maxAgeDays);
      if (needs) {
        needsRotation.push(secretId);
      } else {
        ok.push(secretId);
      }
    } catch (e) {
      // Treat errors as findings (secret might be missing or inaccessible)
      needsRotation.push(secretId);
    }
  }

  // Sort arrays for deterministic output
  needsRotation.sort();
  ok.sort();

  // Determine status and exit code
  let status: "ok" | "findings" | "error" = "ok";
  let exitCode = 0;

  if (needsRotation.length > 0) {
    status = "findings";
    exitCode = 1;
  }

  return {
    command: "rotate-secrets-example",
    status,
    exitCode,
    findings: {
      needsRotation,
      ok,
      maxAgeDays,
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Main execution
 */
async function main() {
  try {
    // Configuration
    const secretIds = ["GITHUB_TOKEN", "API_KEY", "DATABASE_URL"];
    const maxAgeDays = 90;

    // Run rotation check
    const result = await checkRotation(secretIds, maxAgeDays);

    // Output deterministic JSON
    // canonicalJSONStringify ensures:
    // 1. Sorted object keys
    // 2. Consistent formatting
    // 3. Trailing newline
    process.stdout.write(canonicalJSONStringify(result));

    // Exit with appropriate code
    process.exit(result.exitCode);
  } catch (error) {
    // Internal error - exit code 2
    const errorResult: RotationCheckResult = {
      command: "rotate-secrets-example",
      status: "error",
      exitCode: 2,
      findings: {
        needsRotation: [],
        ok: [],
        maxAgeDays: 90,
      },
      timestamp: new Date().toISOString(),
    };

    process.stdout.write(canonicalJSONStringify(errorResult));
    process.exit(2);
  }
}

// Run if executed directly
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { checkRotation, RotationCheckResult };
