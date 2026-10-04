import type { Command } from "commander";
import {
  GateOperationService,
  type GateOperationHandle,
} from "../application/gate-operation-service.js";
import { writeJsonOutput } from "../cli/output.js";
import { throwExit } from "../cli/exitHandler.js";

export function registerGateOperationCommands(gate: Command): void {
  gate
    .command("start")
    .description("Start durable gate work and return a reconnectable operation handle")
    .requiredOption("--repo-root <path>", "Owning repository")
    .requiredOption("--plan <path>", "Frozen plan input")
    .requiredOption("--out <path>", "Operation artifacts and idempotency scope")
    .requiredOption(
      "--idempotency-key <key>",
      "Reuse this key and the same inputs after a lost acknowledgement"
    )
    .option("--only-item <name>", "Selected item")
    .option("--only-gate <name>", "Selected gate")
    .option("--timeout-ms <milliseconds>", "Default gate timeout", Number)
    .option("--json", "Output JSON")
    .action(async (options) => {
      try {
        writeJsonOutput(
          await new GateOperationService().start({
            repoRoot: options.repoRoot,
            planFile: options.plan,
            outDir: options.out,
            idempotencyKey: options.idempotencyKey,
            onlyItem: options.onlyItem,
            onlyGate: options.onlyGate,
            timeoutMs: options.timeoutMs,
          })
        );
      } catch (error) {
        operationError(error);
      }
    });
  for (const name of ["status", "cancel"] as const) {
    const command = gate
      .command(name)
      .description(
        name === "status"
          ? "Observe one explicitly referenced gate operation"
          : "Request cancellation after active gates settle"
      )
      .requiredOption("--repo-root <path>", "Owning repository")
      .requiredOption("--operation <path>", "Immutable operation descriptor")
      .requiredOption("--operation-sha256 <digest>", "Expected sha256: descriptor digest")
      .option("--json", "Output JSON");
    if (name === "status") {
      command.option("--verify-artifacts", "Read back this operation's referenced artifact bytes");
    }
    command.action((options) => {
      const handle: GateOperationHandle = {
        repoRoot: options.repoRoot,
        operationFile: options.operation,
        operationSha256: options.operationSha256,
      };
      try {
        const service = new GateOperationService();
        writeJsonOutput(
          name === "status"
            ? service.status({ ...handle, verifyArtifacts: options.verifyArtifacts })
            : service.cancel(handle)
        );
      } catch (error) {
        operationError(error);
      }
    });
  }
}
function operationError(error: unknown): never {
  writeJsonOutput({
    ok: false,
    error: {
      code:
        error && typeof error === "object" && "code" in error
          ? error.code
          : "GATE_OPERATION_INVALID",
      message: error instanceof Error ? error.message : "Gate operation failed",
    },
  });
  return throwExit(1);
}
