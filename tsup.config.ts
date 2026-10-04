import { defineConfig, type Options } from "tsup";

const entry = [
  "src/cli.ts",
  "src/sdk/index.ts",
  "src/frames/index.ts",
  "src/hooks/events.ts",
  "src/errors/index.ts",
  "src/package-schemas/behavior-rule.ts",
  "src/package-schemas/execution-plan-v1.ts",
  "src/package-schemas/gates.ts",
  "src/package-schemas/runner-scope.ts",
  "src/package-schemas/runner-stack.ts",
];

const shared: Options = {
  entry,
  outDir: "dist",
  target: "es2020",
  // Suppress expected warnings about import.meta in CJS builds.
  // See src/cli.ts entry point detection comments for rationale.
  esbuildOptions(options) {
    options.logOverride = {
      ...options.logOverride,
      "empty-import-meta": "silent",
    };
  },
};

export default defineConfig([
  {
    ...shared,
    entry: ["src/gate-worker.ts"],
    format: ["esm"],
    splitting: false,
    dts: false,
    clean: false,
  },
  {
    ...shared,
    format: ["esm"],
    dts: {
      // Public package-schema entries compile canonical portable definitions from
      // .smartergpt into package-owned dist/ artifacts without shipping the workspace.
      // tsup 8.5.1 also injects TypeScript 6-deprecated baseUrl into DTS builds.
      compilerOptions: { rootDir: ".", ignoreDeprecations: "6.0" },
    },
    clean: false,
  },
  {
    ...shared,
    format: ["cjs"],
    dts: false,
    clean: false,
    // Lex publishes ESM-only conditions. Bundle the Lex APIs used by
    // LexRunner only in CJS so the advertised require targets remain executable.
    noExternal: [/^@smartergpt\/lex(?:\/.*)?$/],
    esbuildOptions(options) {
      options.logOverride = {
        ...options.logOverride,
        "empty-import-meta": "silent",
      };
      // Bundled ESM dependencies may use import.meta.url at module scope. CJS has no
      // import.meta, so bind those calls to the emitted artifact URL instead of esbuild's
      // undefined compatibility shim.
      options.define = {
        ...options.define,
        "import.meta.url": "__lexrunnerImportMetaUrl",
      };
      options.banner = {
        ...options.banner,
        js: 'var __lexrunnerImportMetaUrl = require("node:url").pathToFileURL(__filename).href;',
      };
    },
  },
]);
