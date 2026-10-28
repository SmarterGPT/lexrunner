import { createHash } from "node:crypto";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";

import { build, type Plugin } from "esbuild";

const entry = fileURLToPath(
  new URL("../services/windows-coordinator-host/node/bundled-admission-probe.ts", import.meta.url)
);

const denyDefaultSqliteLookup: Plugin = {
  name: "deny-default-sqlite-binding-search",
  setup(context) {
    context.onResolve({ filter: /^bindings$/ }, () => ({
      path: "default-sqlite-binding-search",
      namespace: "lexrunner-denied-binding-search",
    }));
    context.onLoad({ filter: /.*/, namespace: "lexrunner-denied-binding-search" }, () => ({
      contents:
        "module.exports = function deniedBindingSearch() { throw new Error('default_sqlite_binding_search_denied'); };",
      loader: "js",
    }));
  },
};

/** Source-only artifact bytes; no service, installer, npm or selection action. */
export async function buildWindowsCoordinatorAdmissionBundle(): Promise<{
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly sourceInputCount: number;
  readonly externalImports: readonly string[];
  readonly authorizesLaunch: false;
}> {
  const result = await build({
    entryPoints: [entry],
    outfile: "bundled-admission-probe.mjs",
    bundle: true,
    packages: "bundle",
    platform: "node",
    target: "node24",
    format: "esm",
    // The bundled CommonJS SQLite wrapper still requires Node builtins. Keep
    // esbuild's CJS bridge closed to dynamic package or path lookup; the
    // worker's separate exact-path addon load does not use this bridge.
    banner: {
      js: "import { createRequire as __lexCreateRequire, isBuiltin as __lexIsBuiltin } from 'node:module'; const __lexBuiltinRequire = __lexCreateRequire(import.meta.url); const require = (specifier) => { if (typeof specifier !== 'string' || !__lexIsBuiltin(specifier)) throw new Error('bundled_dynamic_require_denied'); return __lexBuiltinRequire(specifier); };",
    },
    metafile: true,
    write: false,
    logLevel: "silent",
    plugins: [denyDefaultSqliteLookup],
  });
  if (result.errors.length !== 0 || result.warnings.length !== 0)
    throw new Error("Admission bundle build diagnostics");
  if (result.outputFiles?.length !== 1 || !result.metafile)
    throw new Error("Admission bundle output unavailable");
  const inputs = Object.keys(result.metafile.inputs);
  if (
    !inputs.some((path) => /node_modules[\\/]zod[\\/]/u.test(path)) ||
    !inputs.some((path) => /node_modules[\\/]better-sqlite3-multiple-ciphers[\\/]/u.test(path)) ||
    !inputs.some((path) => path.includes("lexrunner-denied-binding-search"))
  )
    throw new Error("Admission bundle dependency closure incomplete");
  const externalImports = Object.values(result.metafile.outputs).flatMap((output) =>
    output.imports.filter((item) => item.external).map((item) => item.path)
  );
  if (externalImports.some((specifier) => !isBuiltin(specifier)))
    throw new Error("Admission bundle contains an external package import");
  const bytes = result.outputFiles[0].contents;
  const emitted = Buffer.from(bytes).toString("utf8");
  if (emitted.includes("NODE_BINDINGS_COMPILED_DIR"))
    throw new Error("Admission bundle retained default addon path search");
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sourceInputCount: inputs.length,
    externalImports,
    authorizesLaunch: false,
  };
}
