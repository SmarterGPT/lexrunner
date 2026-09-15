import { describe, expect, it } from "vitest";
import { projectOwnedWindowsFileCreationReceipt } from "../../src/workspaces/owned-windows-file-receipt.js";
import { WorkspaceBoundaryOperationReceipt_v1 } from "../../src/workspaces/workspace-boundary.js";
const context = {
  leaseId: "lease-1",
  startedAt: "2026-09-15T05:00:00.000Z",
  completedAt: "2026-09-15T05:00:01.000Z",
};
const attempt = {
  requestId: "request-1",
  operationId: "operation-1",
  requestDigest: `sha256:${"a".repeat(64)}`,
  parent: {
    path: "D:\\fixture",
    file_id: "b".repeat(32),
    volume_serial_number: "c".repeat(16),
    filesystem: "ReFS" as const,
    chain_length: 1,
  },
  component: "marker",
  byteLength: 1,
  contentSha256: `sha256:${"d".repeat(64)}`,
  acknowledged: true,
  fileId: "e".repeat(32),
};
const result = {
  kind: "file_created" as const,
  requestId: attempt.requestId,
  operationId: attempt.operationId,
  requestDigest: attempt.requestDigest,
  byteLength: 1,
  contentSha256: attempt.contentSha256,
  fileId: attempt.fileId,
  volumeSerialNumber: attempt.parent.volume_serial_number,
};
describe("owned file creation receipt projection", () => {
  it("records completion without promoting flush to crash durability", () => {
    const projected = projectOwnedWindowsFileCreationReceipt(context, attempt, result);
    expect(projected).toMatchObject({
      ok: true,
      receipt: {
        operation: "write-owned-file",
        mutation: true,
        outcome: "completed",
        durability: "not_requested",
      },
    });
    expect(WorkspaceBoundaryOperationReceipt_v1.safeParse(projected.receipt).success).toBe(true);
  });
  it("preserves unacknowledged creation as unknown and non-retryable", () => {
    const projected = projectOwnedWindowsFileCreationReceipt(context, {
      ...attempt,
      acknowledged: false,
      fileId: undefined,
    });
    expect(projected).toMatchObject({
      ok: false,
      error: { effect_state: "effect_unknown", retryable: false },
      receipt: { outcome: "indeterminate", durability: "indeterminate" },
    });
  });
  it.each([
    "requestId",
    "operationId",
    "requestDigest",
    "contentSha256",
    "fileId",
    "volumeSerialNumber",
  ] as const)("rejects swapped %s", (field) => {
    expect(() =>
      projectOwnedWindowsFileCreationReceipt(context, attempt, { ...result, [field]: "different" })
    ).toThrow();
  });
  it("rejects missing results, invented acknowledgments and invalid lengths", () => {
    expect(() => projectOwnedWindowsFileCreationReceipt(context, attempt)).toThrow();
    expect(() =>
      projectOwnedWindowsFileCreationReceipt(context, { ...attempt, acknowledged: false }, result)
    ).toThrow();
    expect(() =>
      projectOwnedWindowsFileCreationReceipt(
        context,
        { ...attempt, byteLength: -1 },
        { ...result, byteLength: -1 }
      )
    ).toThrow();
  });
});
