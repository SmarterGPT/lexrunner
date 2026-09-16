import { describe, expect, it } from "vitest";
import { WindowsBoundaryExchange } from "../../src/workspaces/windows-boundary-exchange.js";

const binding = { client_nonce: "a".repeat(64), session_nonce: "b".repeat(64) };
const operation = {
  request_id: "r1",
  operation_id: "op1",
  request_digest: `sha256:${"c".repeat(64)}`,
};
describe("Windows operation correlation (no native authority)", () => {
  it("correlates exact identity and prevents both request and operation reuse", () => {
    const exchange = new WindowsBoundaryExchange(binding, () => 1);
    const reply = exchange.reserve(operation, 100);
    expect(exchange.correlate(reply)).toEqual({ correlated: true, identity: operation });
    expect(() => exchange.reserve({ ...operation, operation_id: "op2" }, 100)).toThrow(
      "operation_reuse"
    );
    expect(() => exchange.reserve({ ...operation, request_id: "r2" }, 100)).toThrow(
      "operation_reuse"
    );
  });
  it("does not overwrite an outstanding operation with another reservation", () => {
    const exchange = new WindowsBoundaryExchange(binding, () => 1);
    const reply = exchange.reserve(operation, 100);
    expect(() => exchange.reserve({ ...operation, request_id: "r2" }, 100)).toThrow(
      "exchange_busy"
    );
    expect(exchange.correlate(reply).correlated).toBe(true);
  });
  it.each(["client_nonce", "session_nonce", "request_id", "operation_id", "request_digest"])(
    "rejects mismatched %s and never accepts a later reply on that session",
    (key) => {
      const exchange = new WindowsBoundaryExchange(binding, () => 1);
      const reply = exchange.reserve(operation, 100);
      const different = {
        client_nonce: "d".repeat(64),
        session_nonce: "e".repeat(64),
        request_id: "other-request",
        operation_id: "other-operation",
        request_digest: `sha256:${"f".repeat(64)}`,
      };
      const failed = exchange.correlate({
        ...reply,
        [key]: different[key as keyof typeof different],
      });
      expect(failed).toMatchObject({
        correlated: false,
        failure: { reason: "reply_mismatch", outstanding: operation },
      });
      expect(exchange.correlate(reply)).toEqual(failed);
      expect(() => exchange.reserve(operation, 100)).toThrow("exchange_terminal");
    }
  );
  it("rejects a valid old reply while a newer request is outstanding", () => {
    const exchange = new WindowsBoundaryExchange(binding, () => 1);
    const old = exchange.reserve(operation, 100);
    expect(exchange.correlate(old).correlated).toBe(true);
    const next = { ...operation, request_id: "r2", operation_id: "op2" };
    exchange.reserve(next, 100);
    expect(exchange.correlate(old)).toMatchObject({
      correlated: false,
      failure: { outstanding: next },
    });
  });
  it("checks deadline at receipt even when a timer callback has not run", () => {
    let now = 0;
    const exchange = new WindowsBoundaryExchange(binding, () => now);
    const reply = exchange.reserve(operation, 10);
    now = 10;
    expect(exchange.correlate(reply)).toMatchObject({
      correlated: false,
      failure: { reason: "deadline", outstanding: operation },
    });
  });
  it("preserves unknown in-flight outcome after disconnect and the first failure", () => {
    const exchange = new WindowsBoundaryExchange(binding, () => 1);
    exchange.reserve(operation, 100);
    const failure = exchange.disconnect();
    expect(failure).toMatchObject({
      reason: "connection_lost",
      outstanding: operation,
      disposition: "reconciliation_required",
    });
    expect(exchange.correlate({})).toEqual({ correlated: false, failure });
    expect(exchange.disconnect()).toBe(failure);
  });
  it.each([NaN, Infinity, -1, Number.MAX_SAFE_INTEGER])("fails with invalid clock %s", (value) => {
    const exchange = new WindowsBoundaryExchange(binding, () => value);
    expect(() => exchange.reserve(operation, 10)).toThrow("exchange_terminal");
  });
  it("rejects a clock moving backward", () => {
    let now = 10;
    const exchange = new WindowsBoundaryExchange(binding, () => now);
    const reply = exchange.reserve(operation, 10);
    now = 9;
    expect(exchange.correlate(reply)).toMatchObject({
      correlated: false,
      failure: { reason: "clock_invalid" },
    });
  });
  it("bounds retained replay identities per session", () => {
    const exchange = new WindowsBoundaryExchange(binding, () => 1);
    for (let i = 0; i < 4096; i++) {
      const reply = exchange.reserve(
        { ...operation, request_id: `r${i}`, operation_id: `op${i}` },
        10
      );
      expect(exchange.correlate(reply).correlated).toBe(true);
    }
    expect(() =>
      exchange.reserve({ ...operation, request_id: "next", operation_id: "next" }, 10)
    ).toThrow("session_budget");
  });
  it("admits the v2 reply reserve but rejects exceeding its ceiling", () => {
    const exchange = new WindowsBoundaryExchange(binding, () => 0);
    const reply = exchange.reserve(operation, 38_000);
    expect(exchange.correlate(reply).correlated).toBe(true);
    expect(() =>
      exchange.reserve({ ...operation, request_id: "next", operation_id: "next" }, 38_001)
    ).toThrow("invalid_timeout");
  });
});
