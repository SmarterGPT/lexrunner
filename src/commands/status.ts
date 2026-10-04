/**
 * Status command - Show current execution status and merge eligibility
 */

import { Command } from "commander";
import { asPlanValidationFailure, formatPlanValidationFailureText, loadPlan } from "../schema.js";
import { CycleError, UnknownDependencyError } from "../mergeOrder.js";
import { writeJsonOutput } from "../cli/output.js";
import { throwExit } from "../cli/exitHandler.js";
import { canonicalJSONStringify } from "../util/canonicalJson.js";
import { IntegrationStatusQueryService } from "../application/integration-query-services.js";
import { resolveGateRepositoryRoot } from "../application/gate-candidate-identity.js";
import * as fs from "fs";
import * as path from "node:path";

/**
 * Register the status command with the CLI program
 */
export function registerStatusCommand(program: Command, jsonModeActive: () => boolean): void {
  program
    .command("status")
    .description(
      "Show current execution status and merge eligibility (canonical: lexrunner weave status)"
    )
    .option("--plan <file>", "Path to plan.json file", "plan.json")
    .option("--repo-root <path>", "Explicit candidate repository root (default: current directory)")
    .option("--evidence <file>", "Explicit gate evidence manifest from execute/gates_run")
    .option("--evidence-sha256 <sha256>", "Expected SHA-256 for --evidence")
    .argument("[file]", "Path to plan.json file (alternative to --plan)")
    .option("--json", "Output JSON format")
    .addHelpText(
      "after",
      `
Examples:
  $ lexrunner status plan.json                     # Show plan status
  $ lexrunner status --evidence gates/gate-evidence-manifest.json --evidence-sha256 sha256:<digest>
  $ lexrunner status --json                        # JSON output for dashboards
  $ lexrunner status --json | jq '.mergeSummary'   # Extract merge summary

Common Issues:
  • "Plan file not found": Verify path to plan.json
  • Passing gates remain pending without explicit --evidence and --evidence-sha256 inputs`
    )
    .action((file: string | undefined, opts) => {
      const planFile = opts.plan || file || "plan.json";

      try {
        if (
          opts.repoRoot !== undefined &&
          (!opts.repoRoot ||
            opts.repoRoot.includes("\0") ||
            Buffer.byteLength(opts.repoRoot, "utf8") > 4096)
        ) {
          throw new Error("--repo-root is invalid");
        }
        const repoRoot =
          opts.repoRoot === undefined ? process.cwd() : resolveGateRepositoryRoot(opts.repoRoot);
        const planContent = fs.readFileSync(path.resolve(repoRoot, planFile), "utf-8");
        const plan = loadPlan(planContent);

        if (Boolean(opts.evidence) !== Boolean(opts.evidenceSha256)) {
          throw new Error("--evidence and --evidence-sha256 must be supplied together");
        }
        const result = new IntegrationStatusQueryService().run(
          plan,
          opts.evidence
            ? {
                evidenceFile: path.resolve(repoRoot, opts.evidence),
                evidenceSha256: opts.evidenceSha256,
                repoRoot,
              }
            : undefined
        );
        const mergeSummary = result.mergeSummary;

        if (opts.json || jsonModeActive()) {
          console.log(
            canonicalJSONStringify(
              program.name() === "weave"
                ? result
                : {
                    plan: result.plan,
                    mergeSummary: result.mergeSummary,
                    ...(result.evidence ? { evidence: result.evidence } : {}),
                  }
            )
          );
        } else {
          console.log(`Plan: ${plan.items.length} items targeting ${plan.target}`);
          console.log(`Schema version: ${plan.schemaVersion}`);
          if (plan.policy) {
            console.log(
              `Policy: ${plan.policy.maxWorkers} max workers, merge rule: ${plan.policy.mergeRule.type}`
            );
          }
          console.log(
            `Status: ${mergeSummary.eligible.length} eligible, ${mergeSummary.pending.length} pending, ${mergeSummary.failed.length} failed`
          );
          if (result.evidence) {
            console.log(
              `Evidence: ${result.evidence.observations.passed.length} passed, ${result.evidence.observations.failed.length} failed (${result.evidence.authority})`
            );
          }
        }
      } catch (error) {
        const failure = asPlanValidationFailure(error);
        if (failure) {
          if (opts.json || jsonModeActive()) {
            console.log(canonicalJSONStringify(failure));
          } else {
            console.error(formatPlanValidationFailureText(failure));
          }
          throwExit(2);
        }

        console.error(
          `Error getting status: ${error instanceof Error ? error.message : String(error)}`
        );
        // Use exit code 2 for validation errors, 1 for others
        if (error instanceof CycleError || error instanceof UnknownDependencyError) {
          throwExit(2);
        } else {
          throwExit(1);
        }
      }
    });
}
