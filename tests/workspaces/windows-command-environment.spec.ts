import { expect, it } from "vitest";
import { windowsCommandEnvironment } from "../../src/workspaces/windows-command-environment.js";
it("inherits and replaces Windows variables without duplicate case variants", () => {
  const parent = { Path: "old", KEEP: "yes" };
  expect(windowsCommandEnvironment({ env: { PATH: "new", EMPTY: "" } }, parent)).toEqual({
    PATH: "new",
    KEEP: "yes",
    EMPTY: "",
  });
  expect(parent.Path).toBe("old");
  expect(windowsCommandEnvironment({ env: { ONLY: "value" }, extendEnv: false }, parent)).toEqual({
    ONLY: "value",
  });
  expect(windowsCommandEnvironment({ extendEnv: false }, parent)).toEqual({});
});
it("rejects ambiguous names and malformed or oversized values", () => {
  for (const env of [
    { "2": "two" },
    { Path: "a", PATH: "b" },
    { "BAD=NAME": "x" },
    { GOOD: "x\0y" },
    { BIG: "x".repeat(32767) },
  ])
    expect(() => windowsCommandEnvironment({ env, extendEnv: false })).toThrow();
});
