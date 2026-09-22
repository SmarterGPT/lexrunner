import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Emit JSON reporter alongside default for AX-compliant output (ADR-009)
    reporters: ["default", ["json", { outputFile: "test-results.json" }]],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.smartergpt/**",
      "**/coverage/**",
      // Exclude tests that perform git commits (require LEX_GIT_MODE=live)
      "**/tests/release-prepare.spec.ts",
      "**/tests/e2e-comprehensive.test.ts",
      "**/tests/autopilot-e2e-level3-4.spec.ts",
      "**/tests/deterministic-build.test.ts",
      "**/tests/preflightConflicts.spec.ts",
      "**/tests/e2e-synthetic-6pr-weave.spec.ts",
      "**/tests/guardrails.spec.ts",
      "**/tests/promptsResolver.spec.ts",
      "**/tests/e2e-merge-resume.spec.ts",
      "**/tests/e2e-frozen-git-inputs.spec.ts",
      "**/tests/runs/worker-receipt-native-integration.spec.ts",
      "**/tests/workspaces/workspace-coordinator-sqlite-git.spec.ts",
      // Exclude slow CLI tests (run via test:cli:slow with LEX_ENABLE_SLOW_CLI_TESTS=true)
      "**/tests/cli-progress.spec.ts",
    ],
    // Limit concurrency to prevent WSL2 resource exhaustion/crashes
    maxWorkers: 1,
    minWorkers: 1,
  },
});
