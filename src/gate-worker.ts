import { runGateOperationWorker } from "./application/gate-operation-service.js";

// This executable owns gate work independently of the MCP transport lifetime.
const [, , operationFile, operationSha256] = process.argv;
if (!operationFile || !operationSha256) {
  process.exitCode = 2;
} else {
  void runGateOperationWorker(operationFile, operationSha256).catch(() => {
    // An unfinalized durable claim is unknown, never an automatic retry or PASS.
    process.exitCode = 1;
  });
}
