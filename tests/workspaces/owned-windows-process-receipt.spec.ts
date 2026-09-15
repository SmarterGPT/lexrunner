import { describe, expect, it } from "vitest";
import { projectOwnedWindowsProcessReceipt } from "../../src/workspaces/owned-windows-process-receipt.js";
import {
  WorkspaceBoundaryOperationReceipt_v1,
  createWorkspaceBoundaryOperationReceipt,
} from "../../src/workspaces/workspace-boundary.js";
import type {
  OwnedWindowsProcessAttempt,
  OwnedWindowsProcessResult,
} from "../../src/workspaces/owned-windows-boundary-handshake.js";
const context = {
  leaseId: "lease-1",
  startedAt: "2026-09-15T05:00:00.000Z",
  completedAt: "2026-09-15T05:00:01.000Z",
};
const attempt: OwnedWindowsProcessAttempt = {
  requestId: "request-1",
  operationId: "operation-1",
  requestDigest: `sha256:${"a".repeat(64)}`,
  cwd: {
    path: "D:\\fixture",
    file_id: "b".repeat(32),
    volume_serial_number: "c".repeat(16),
    filesystem: "ReFS",
    chain_length: 1,
  },
  acknowledged: false,
};
const result: OwnedWindowsProcessResult = {
  kind: "process_completed",
  requestId: attempt.requestId,
  operationId: attempt.operationId,
  requestDigest: attempt.requestDigest,
  status: "exited",
  exitCode: 0,
  processId: 42,
  durationMs: 5,
  stdout: Buffer.from("hello\n"),
  stderr: Buffer.from([255]),
  stdoutTruncated: false,
  stderrTruncated: false,
};
describe("owned process receipt projection", () => {
  it("represents lost acknowledgment without asserting no effects or retryability", () => {
    const projected = projectOwnedWindowsProcessReceipt(context, attempt);
    expect(projected).toMatchObject({
      ok: false,
      error: { effect_state: "effect_unknown", retryable: false },
      receipt: {
        operation: "spawn-process",
        outcome: "indeterminate",
        durability: "not_applicable",
      },
    });
    expect(
      WorkspaceBoundaryOperationReceipt_v1.parse(JSON.parse(JSON.stringify(projected.receipt)))
    ).toEqual(projected.receipt);
  });
  it.each(["exited", "nonzero_exit", "timeout", "output_limit"] as const)(
    "maps %s without equating completed receipt to command success",
    (status) => {
      const projected = projectOwnedWindowsProcessReceipt(
        context,
        { ...attempt, acknowledged: true, status },
        {
          ...result,
          status,
          stdoutTruncated: status === "output_limit",
          exitCode: status === "exited" ? 0 : 7,
        }
      );
      expect(projected).toMatchObject({
        ok: true,
        value: { ok: status === "exited", stdout: "hello\n", stderr: "�" },
        receipt: { outcome: "completed", durability: "not_applicable" },
      });
      expect(WorkspaceBoundaryOperationReceipt_v1.parse(projected.receipt)).toEqual(
        projected.receipt
      );
    }
  );
  it.each(["requestId", "operationId", "requestDigest", "status"] as const)(
    "rejects mismatched %s",
    (key) => {
      expect(() =>
        projectOwnedWindowsProcessReceipt(
          context,
          { ...attempt, acknowledged: true, status: "exited" },
          { ...result, [key]: "different" } as any
        )
      ).toThrow();
    }
  );
  it("rejects contradictory successful exit", () => {
    expect(() =>
      projectOwnedWindowsProcessReceipt(
        context,
        { ...attempt, acknowledged: true, status: "exited" },
        { ...result, exitCode: 7 }
      )
    ).toThrow(/Inconsistent/u);
  });
  it("rejects missing or unexpected result", () => {
    expect(() =>
      projectOwnedWindowsProcessReceipt(context, { ...attempt, acknowledged: true })
    ).toThrow();
    expect(() => projectOwnedWindowsProcessReceipt(context, attempt, result)).toThrow();
  });
  it("does not extend the process exception to other operations or claim known effects", () => {
    const { receipt_digest: _, ...body } = projectOwnedWindowsProcessReceipt(
      context,
      attempt
    ).receipt;
    expect(() =>
      createWorkspaceBoundaryOperationReceipt({ ...body, operation: "assert-current" })
    ).toThrow();
    expect(() =>
      createWorkspaceBoundaryOperationReceipt({
        ...body,
        error: { ...body.error!, effect_state: "no_effect" },
      })
    ).toThrow();
  });
});
