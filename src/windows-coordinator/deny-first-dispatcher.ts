import { z } from "zod";

import {
  parseWindowsCoordinatorClientFrame,
  WINDOWS_COORDINATOR_CLIENT_PROTOCOL_VERSION,
} from "./client-protocol.js";

export const WindowsCoordinatorDenial_v1 = z
  .object({
    schema_version: z.literal(WINDOWS_COORDINATOR_CLIENT_PROTOCOL_VERSION),
    kind: z.literal("denial"),
    request_id: z.string().min(1).max(128).nullable(),
    reason_code: z.enum(["invalid_frame", "invalid_request", "admission_unavailable"]),
    effect_state: z.literal("no_effect"),
    authorizes_execution: z.literal(false),
  })
  .strict();

export type WindowsCoordinatorDenial_v1 = z.infer<typeof WindowsCoordinatorDenial_v1>;

/**
 * Source-only deny-first seam. It has no store, broker, transport or launch
 * dependency. A future installed coordinator must replace this disposition
 * only after independent protected admission and durable intent are proven.
 */
export function dispatchWindowsCoordinatorFrame(frame: Uint8Array): WindowsCoordinatorDenial_v1 {
  const parsed = parseWindowsCoordinatorClientFrame(frame);
  return WindowsCoordinatorDenial_v1.parse({
    schema_version: WINDOWS_COORDINATOR_CLIENT_PROTOCOL_VERSION,
    kind: "denial",
    request_id: parsed.ok ? parsed.request.request_id : null,
    reason_code: parsed.ok ? "admission_unavailable" : parsed.reason,
    effect_state: "no_effect",
    authorizes_execution: false,
  });
}
