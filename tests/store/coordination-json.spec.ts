import { describe, expect, it } from "vitest";

import { coordinationJSONStringify } from "../../src/store/coordination-json.js";
import type { JsonValue } from "../../src/store/coordination-store.js";
import { canonicalJSONStringify } from "../../src/util/canonicalJson.js";

describe("coordination JSON serialization", () => {
  it("retains every own JSON key while preserving ordinary canonical bytes", () => {
    const ordinary = JSON.parse('{"z":1,"a":{"d":2,"b":3},"list":[{"z":4,"a":5}]}') as JsonValue;
    expect(coordinationJSONStringify(ordinary)).toBe(canonicalJSONStringify(ordinary));

    const special = JSON.parse(
      '{"z":1,"metadata":{"__proto__":{"changed":true},"a":2}}'
    ) as JsonValue;
    const roundTrip = JSON.parse(coordinationJSONStringify(special)) as Record<string, JsonValue>;
    const metadata = roundTrip.metadata as Record<string, JsonValue>;
    expect(Object.hasOwn(metadata, "__proto__")).toBe(true);
    expect(metadata["__proto__"]).toEqual({ changed: true });
    expect(JSON.stringify(roundTrip)).toBe(
      '{"metadata":{"__proto__":{"changed":true},"a":2},"z":1}'
    );
  });

  it("does not silently redefine the legacy own-constructor byte profile", () => {
    const value = JSON.parse('{"constructor":"marker","z":1,"a":2}') as JsonValue;
    expect(coordinationJSONStringify(value)).toBe(canonicalJSONStringify(value));
  });
});
