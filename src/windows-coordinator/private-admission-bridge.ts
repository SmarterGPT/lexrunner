import { Buffer } from "node:buffer";

import { z } from "zod";

import { canonicalJSONStringify } from "../util/canonicalJson.js";
import { WindowsCoordinatorReservationInput_v1 } from "./admission-contract.js";
import {
  parseWindowsCoordinatorClientFrame,
  WINDOWS_COORDINATOR_CLIENT_PROTOCOL_VERSION,
} from "./client-protocol.js";
import {
  WindowsCoordinatorDenial_v1,
  type WindowsCoordinatorDenial_v1 as Denial,
} from "./deny-first-dispatcher.js";
import type { PrivatePeerObservation } from "./private-peer-protocol.js";
import type { SqliteWindowsCoordinatorAdmissionStore } from "./sqlite-admission-store.js";

const fixtureReservationContext = WindowsCoordinatorReservationInput_v1.omit({
  observed_client_sid: true,
  client_idempotency_key: true,
  packet: true,
});

/** Explicitly synthetic source-fixture data, not protected service provisioning. */
export const PrivateAdmissionFixtureConfig_v1 = z.strictObject({
  schema_version: z.literal("windows-private-admission-fixture/1"),
  database_path: z.string().min(3).max(1024),
  reservation_context: fixtureReservationContext,
});
export type PrivateAdmissionFixtureConfig_v1 = z.infer<typeof PrivateAdmissionFixtureConfig_v1>;

function deny(requestId: string | null, reasonCode: Denial["reason_code"]): Denial {
  return WindowsCoordinatorDenial_v1.parse({
    schema_version: WINDOWS_COORDINATOR_CLIENT_PROTOCOL_VERSION,
    kind: "denial",
    request_id: requestId,
    reason_code: reasonCode,
    effect_state: "no_effect",
    authorizes_execution: false,
  });
}

/**
 * Source-only private child seam. The SID comes from the native peer envelope,
 * never the client frame. A direct caller can forge this object; only a future
 * protected native launcher, private handle graph and store can give it authority.
 */
export function handlePrivateAdmissionObservation(
  observation: PrivatePeerObservation,
  fixtureValue: unknown,
  store: Pick<SqliteWindowsCoordinatorAdmissionStore, "recordCandidate">
): Denial {
  const fixture = PrivateAdmissionFixtureConfig_v1.parse(fixtureValue);
  const parsed = parseWindowsCoordinatorClientFrame(observation.clientFrame);
  if (!parsed.ok) return deny(null, parsed.reason);
  // TextDecoder strips a leading UTF-8 BOM. Require the original payload bytes
  // to equal canonical bytes, rather than trusting only decoded-text equality.
  if (
    !observation.clientFrame
      .subarray(4)
      .equals(Buffer.from(canonicalJSONStringify(parsed.request), "utf8"))
  )
    return deny(null, "invalid_frame");
  if (parsed.request.verb !== "attempt.prepare")
    return deny(parsed.request.request_id, "admission_unavailable");

  const result = store.recordCandidate({
    ...fixture.reservation_context,
    observed_client_sid: observation.observedClientSid,
    client_idempotency_key: parsed.request.client_idempotency_key,
    packet: parsed.request.packet,
  });
  // Every rejection lacks a verified intent. An earlier effect_unknown operation
  // may exist even when validation or read-only checks mask its replay key.
  if (result.kind === "rejected") throw new Error("private_admission_historical_state_unverified");
  if (result.authorizes_execution !== false || result.intent.effect_state !== "no_effect")
    throw new Error("private_admission_effect_uncertain");
  // Only a recorded or verified historical no-effect intent permits this denial.
  // No durable operation or policy detail crosses the public pipe.
  return deny(parsed.request.request_id, "admission_unavailable");
}
