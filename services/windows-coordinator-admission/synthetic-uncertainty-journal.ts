import type {
  SqliteWindowsCoordinatorAdmissionStore,
  WindowsAdmissionEffectIntentResult,
} from "../../src/windows-coordinator/sqlite-admission-store.js";

export type SyntheticUncertaintyLatchResult = Extract<
  WindowsAdmissionEffectIntentResult,
  { kind: "effect_unknown_latched" | "historical_effect_unknown" }
>;

/**
 * Compatibility wrapper for the synthetic fixture. The admission store now
 * owns the single transaction implementation. Supplied fixture observations
 * never prove protected custody or authorize an effect.
 */
export function latchSyntheticEffectUnknown(
  store: Pick<SqliteWindowsCoordinatorAdmissionStore, "latchEffectUnknown">,
  inputValue: unknown
): SyntheticUncertaintyLatchResult {
  const result = store.latchEffectUnknown(inputValue);
  if (result.kind === "rejected") throw new Error(`synthetic_admission_${result.reason}`);
  return result;
}
