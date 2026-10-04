import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import {
  COMPACT_JSON_HASH_PROFILE,
  computeCanonicalHash as publicComputeCanonicalHash,
} from "../src/cli.js";
import {
  EXECUTION_PLAN_HASH_PROFILE,
  computeExecutionPlanArtifactDigest,
} from "../src/application/execution-plan-artifact.js";
import {
  computeCanonicalHash,
  computeCanonicalHashFromCompactJSON,
} from "../src/schemas/task-contract.js";
import { canonicalJSONStringify } from "../src/util/canonicalJson.js";

const compactVectors = [
  {
    name: "empty object",
    value: {},
    bytes: "{}",
    digest: "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
  },
  {
    name: "object key order",
    value: { b: 2, a: 1 },
    bytes: '{"a":1,"b":2}',
    digest: "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
  },
  {
    name: "nested arrays, null, boolean and UTF-8",
    value: { z: [3, { b: false, a: null }], a: "é\n" },
    bytes: '{"a":"é\\n","z":[3,{"a":null,"b":false}]}',
    digest: "sha256:dd0349b7ed85d4ed8b8ab227a24530c2c5cb82b8440da0009597054afd70f03a",
  },
  {
    name: "JavaScript numeric property enumeration",
    value: { "10": "ten", "2": "two", "01": "one", a: "z" },
    bytes: '{"2":"two","10":"ten","01":"one","a":"z"}',
    digest: "sha256:730b97e5d912a457a65c38c7e4e26e03fffba0b108d882e5ba71e2b777fc6082",
  },
  {
    name: "JavaScript signed zero and exponent formatting",
    value: [-0, 1e-7, 1e21],
    bytes: "[0,1e-7,1e+21]",
    digest: "sha256:1b90241aaef4c632cb16fc580bf76008dd15b1f99ee4ff37965fd7ff507e76d6",
  },
  {
    name: "array order ascending",
    value: [1, 2, 3],
    bytes: "[1,2,3]",
    digest: "sha256:a615eeaee21de5179de080de8c3052c8da901138406ba71c38c032845f7d54f4",
  },
  {
    name: "array order descending",
    value: [3, 2, 1],
    bytes: "[3,2,1]",
    digest: "sha256:30c8681f9b840aceee56b737f3b126ae67ec4eb71d2881db831f86014fba016d",
  },
  {
    name: "composed Unicode",
    value: { text: "é" },
    bytes: '{"text":"é"}',
    digest: "sha256:42d3cbf59fdccced04e5dff14433fb52d34d58e385e9770ffd896ff517d63b92",
  },
  {
    name: "decomposed Unicode",
    value: { text: "e\u0301" },
    bytes: '{"text":"e\u0301"}',
    digest: "sha256:9b53287cd41955684903378d2b1b4a3ddea9d80d67dcd026319a7c5a9a8a8b42",
  },
] as const;

describe("versioned compact JSON digest", () => {
  it("exports the existing implementation under its explicit profile", () => {
    expect(COMPACT_JSON_HASH_PROFILE).toBe("lexrunner.compact-json.sha256.v1");
    expect(publicComputeCanonicalHash).toBe(computeCanonicalHash);
  });

  it.each(compactVectors)("preserves the $name golden vector", ({ value, bytes, digest }) => {
    expect(computeCanonicalHash(value)).toBe(digest);
    expect(publicComputeCanonicalHash(value)).toBe(digest);
    expect(computeCanonicalHashFromCompactJSON(bytes)).toBe(digest);
  });

  it("sorts alternate nested object order without changing array order", () => {
    expect(computeCanonicalHash({ a: "é\n", z: [3, { a: null, b: false }] })).toBe(
      "sha256:dd0349b7ed85d4ed8b8ab227a24530c2c5cb82b8440da0009597054afd70f03a"
    );
  });

  it("keeps raw, pretty JSON and domain-separated plan preimages distinct", () => {
    const value = { b: 2, a: 1 };
    const pretty = '{\n  "a": 1,\n  "b": 2\n}\n';
    expect(canonicalJSONStringify(value)).toBe(pretty);
    expect(computeCanonicalHash(value)).toBe(
      "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"
    );
    expect(`sha256:${createHash("sha256").update(pretty, "utf8").digest("hex")}`).toBe(
      "sha256:080d51f49b27c73d17f51f3b808515a425d16218aa40021eed2ca1d204e59224"
    );
    expect(`sha256:${createHash("sha256").update('{"b":2,"a":1}', "utf8").digest("hex")}`).toBe(
      "sha256:3fb75453225c732a76b7899ea2096dda1455189c89817239732182f73fe5a09f"
    );
    expect(EXECUTION_PLAN_HASH_PROFILE).toBe("lexrunner.execution-plan-artifact.sha256.v1");
    // This is a byte-profile vector, not a schema-valid execution plan artifact.
    expect(computeExecutionPlanArtifactDigest(pretty)).toBe(
      "sha256:93fccd814a124502d3385f74ff460596d7c982c543dc34a9a15c0a0fcf9446dc"
    );
  });
});

describe("legacy serialization compatibility", () => {
  it("preserves omission of undefined object properties", () => {
    expect(computeCanonicalHash({ a: undefined, b: 1 })).toBe(
      "sha256:eb8ed3ccb5023093b56f490a46501e88d09736687e609fdbc1c71b3df8b9ccd3"
    );
  });

  it("preserves the existing own __proto__ key omission", () => {
    // Existing record schemas can admit this key. Public callers must reject it;
    // this regression fixture preserves old bytes without approving the input.
    const value = JSON.parse('{"__proto__":{"secret":1},"a":2}');
    expect(Object.hasOwn(value, "__proto__")).toBe(true);
    expect(computeCanonicalHash(value)).toBe(
      "sha256:7e8059f495589fcd981232cc11d00b00da3802c01d688fa1cf1f6bed6e5bb33c"
    );
  });

  it("does not replace compact serialization with the pretty helper", () => {
    const value = { constructor: "authored", b: 2, a: 1 };
    expect(computeCanonicalHash(value)).toBe(
      "sha256:b9b3984e0cbf986eebd61e8f56da6c17c78997fadd79d44c353716dd1e23bc7d"
    );
    expect(canonicalJSONStringify(value)).toBe(
      '{\n  "constructor": "authored",\n  "b": 2,\n  "a": 1\n}\n'
    );
  });
});

describe("built package root digest exports", () => {
  const packageName = "@smartergpt/lexrunner";
  const require = createRequire(import.meta.url);

  function checkRootExports(entry: Record<string, unknown>): void {
    expect(entry.COMPACT_JSON_HASH_PROFILE).toBe("lexrunner.compact-json.sha256.v1");
    expect(entry.computeCanonicalHash).toBeTypeOf("function");
    const digest = entry.computeCanonicalHash as (value: unknown) => string;
    expect(digest({ b: 2, a: 1 })).toBe(
      "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"
    );
    expect(entry.computeCanonicalHashFromCompactJSON).toBeUndefined();
    expect(entry.canonicalJSONStringify).toBeTypeOf("function");
    const pretty = entry.canonicalJSONStringify as (value: unknown) => string;
    expect(pretty({ b: 2, a: 1 })).toBe('{\n  "a": 1,\n  "b": 2\n}\n');
  }

  it("exposes the compact profile through the ESM package export map", async () => {
    checkRootExports(await import(packageName));
  });

  it("exposes the compact profile through the CommonJS package export map", () => {
    checkRootExports(require(packageName));
  });
});
