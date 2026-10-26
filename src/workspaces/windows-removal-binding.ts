import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJSONStringify } from "../util/canonicalJson.js";
import {
  WindowsRemovalDigest,
  WindowsRemovalExecutorId,
  WindowsRemovalIdentity,
  WindowsRemovalCleanGit,
} from "./windows-removal-protocol.js";
import type { WorkspaceIdentity } from "../store/workspace-lifecycle-store.js";

const id = z.string().min(1).max(128);
export const WindowsRemovalBinding = z.strictObject({
  schemaVersion: z.literal("windows-removal-binding/1"),
  operationId: id,
  intentDigest: WindowsRemovalDigest,
  workspaceLeaseId: id,
  executorId: WindowsRemovalExecutorId,
  selectionSha256: WindowsRemovalDigest,
  rootParent: WindowsRemovalIdentity,
  registrationParent: WindowsRemovalIdentity,
  slotParent: WindowsRemovalIdentity,
  root: WindowsRemovalIdentity,
  registration: WindowsRemovalIdentity,
  slot: WindowsRemovalIdentity,
  rootComponent: z.string().min(1).max(255),
  registrationComponent: z.string().min(1).max(255),
  slotComponent: z.string().min(1).max(255),
  slotContentSha256: WindowsRemovalDigest,
  markerSha256: WindowsRemovalDigest,
  cleanGit: WindowsRemovalCleanGit,
});
export type WindowsRemovalBinding = z.infer<typeof WindowsRemovalBinding>;
export function windowsRemovalMarkerSha256(lease: WorkspaceIdentity & { baseSha: string }) {
  const content = Buffer.from(
    `${JSON.stringify({
      schemaVersion: 1,
      repositoryId: lease.repositoryId,
      attemptId: lease.attemptId,
      hostId: lease.hostId,
      gitRuntime: lease.gitRuntime,
      projectRoot: lease.projectRoot,
      worktreePath: lease.worktreePath,
      branch: lease.branch,
      baseSha: lease.baseSha,
    })}\n`,
    "utf8"
  );
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
export function windowsRemovalSlot(leaseId: string) {
  id.parse(leaseId);
  const content = Buffer.from(
    canonicalJSONStringify({ schemaVersion: "windows-removal-slot/1", workspaceLeaseId: leaseId }),
    "utf8"
  );
  return Object.freeze({
    component: `${createHash("sha256").update(leaseId).digest("hex")}.lock`,
    content,
    contentSha256: `sha256:${createHash("sha256").update(content).digest("hex")}`,
  });
}
