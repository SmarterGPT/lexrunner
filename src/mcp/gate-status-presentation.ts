import { z } from "zod";
import {
  GateOperationService,
  GateOperationStatusArgs,
} from "../application/gate-operation-service.js";
import type { RetainedGateEvidenceReport } from "../application/retained-gate-evidence.js";

export const McpGateOperationStatusArgs = GateOperationStatusArgs.extend({
  responseDetail: z
    .enum(["compact", "diagnostic"])
    .default("compact")
    .describe("Use diagnostic for every verified evidence reference and all read-back limits."),
});
export const McpGateOperationStatusJsonSchema = z.toJSONSchema(McpGateOperationStatusArgs);

/** Present a verified service observation without changing its status or authority. */
export function observeMcpGateOperationStatus(
  raw: unknown,
  service: Pick<GateOperationService, "status"> = new GateOperationService()
): Record<string, unknown> {
  const { responseDetail, ...input } = McpGateOperationStatusArgs.parse(raw);
  // Read-back completes before presentation; diagnostic selection never changes verification.
  const result = service.status(input);
  if (responseDetail === "diagnostic") return result;
  const report = result.artifactVerification as RetainedGateEvidenceReport | undefined;
  if (report?.contract !== "lexrunner-retained-gate-evidence/v1") return result;
  const { contract: _contract, references, limits, ...facts } = report;
  return {
    ...result,
    artifactVerification: {
      ...facts,
      contract: "lexrunner-retained-gate-evidence-summary/v1",
      referenceCount: references.length,
      issues: references.filter((reference) => reference.outcome !== "complete"),
      ...(report.reasonCodes.some((reason) => reason.endsWith("_LIMIT")) ? { limits } : {}),
      diagnosticAvailable: true,
    },
  };
}
