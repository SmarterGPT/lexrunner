import type { JsonValue } from "./coordination-store.js";

/**
 * Serialize coordination data without rewriting valid JSON property names.
 *
 * This intentionally preserves the legacy canonical byte profile for ordinary
 * values, including its handling of an own `constructor` property. The only
 * behavioral change is that every JSON-representable own string key, including
 * `__proto__`, survives sorting and serialization. Arrays retain authored order.
 */
export function coordinationJSONStringify(value: JsonValue): string {
  const cloned = JSON.parse(JSON.stringify(value)) as JsonValue;
  return JSON.stringify(sortRecursively(cloned), null, 2) + "\n";
}

function sortRecursively(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortRecursively);
  if (value && typeof value === "object" && value.constructor === Object) {
    const output: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      Object.defineProperty(output, key, {
        value: sortRecursively(value[key]!),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return output;
  }
  return value;
}
