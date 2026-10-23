import { describe, expect, it } from "vitest";

import { weavePlanNextSteps } from "../../src/commands/weave.js";

describe("weave plan follow-up guidance", () => {
  it("uses the resolved cross-repository plan path for every follow-up command", () => {
    const planFile = "D:\\dev\\target-repository\\plans\\candidate.json";

    expect(weavePlanNextSteps(planFile)).toEqual([
      `  1. Review: lex-pr plan-review ${planFile}`,
      `  2. Dry-run: lex-pr weave apply --plan ${planFile} --dry-run`,
      `  3. Execute: lex-pr weave apply --plan ${planFile} --execute`,
    ]);
  });
});
