import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.smartergpt/**",
      "**/coverage/**",
      // Retained diagnostic source snapshots are evidence, not executable tests.
      "**/artifacts*/**",
      "**/.artifacts*/**",
    ],
    // Limit concurrency to prevent WSL2 resource exhaustion/crashes
    maxWorkers: 1,
    minWorkers: 1,
  },
});
