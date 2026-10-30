import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build, type Plugin } from "esbuild";

const entry = fileURLToPath(
  new URL("../services/windows-coordinator-host/node/bundled-admission-probe.ts", import.meta.url)
);
const requireSource = createRequire(import.meta.url);
const profiles = {
  "12.11.1": {
    sourceDigest: "f360d5e7b711cada5cd6761323ee735a6b841e4f78f9c1c384a9b4507b54385d",
    nativeMember: "build/Release/better_sqlite3.node",
    minimumNodeApi: null,
  },
  "13.0.3": {
    sourceDigest: "4506e25c0d93a1ad39fcefed4fdfcf01fc392c1892a54aa87aa258e9b41630e9",
    nativeMember: "prebuilds/win32-x64.node",
    minimumNodeApi: 10,
  },
} as const;
type SqliteVersion = keyof typeof profiles;
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function regular(file: string, limit: number): Buffer {
  const before = lstatSync(file, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 1n ||
    before.size > BigInt(limit)
  )
    throw new Error("sqlite_source_file_unavailable");
  const bytes = readFileSync(file);
  const after = lstatSync(file, { bigint: true });
  if (
    after.ino !== before.ino ||
    after.dev !== before.dev ||
    after.mtimeNs !== before.mtimeNs ||
    after.size !== before.size ||
    BigInt(bytes.length) !== before.size
  )
    throw new Error("sqlite_source_file_changed");
  return bytes;
}

/** A pinned source consistency profile, never vendor provenance or launch authority. */
export function inspectBundledSqliteSource(packageRoot?: string) {
  const root = path.resolve(
    packageRoot ??
      path.dirname(requireSource.resolve("better-sqlite3-multiple-ciphers/package.json"))
  );
  const directory = lstatSync(root);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    realpathSync.native(root).toLowerCase() !== root.toLowerCase()
  )
    throw new Error("sqlite_source_root_unavailable");
  const manifest = JSON.parse(regular(path.join(root, "package.json"), 32_768).toString("utf8"));
  if (
    manifest.name !== "better-sqlite3-multiple-ciphers" ||
    !Object.prototype.hasOwnProperty.call(profiles, manifest.version)
  )
    throw new Error("sqlite_source_version_unavailable");
  const version = manifest.version as SqliteVersion;
  const files = ["package.json"];
  const visit = (relative: string, depth: number) => {
    if (depth > 4) throw new Error("sqlite_source_inventory_bound");
    const directoryPath = path.join(root, relative);
    const attributes = lstatSync(directoryPath);
    if (
      !attributes.isDirectory() ||
      attributes.isSymbolicLink() ||
      realpathSync.native(directoryPath).toLowerCase() !== directoryPath.toLowerCase()
    )
      throw new Error("sqlite_source_link_unavailable");
    for (const item of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw new Error("sqlite_source_link_unavailable");
      const child = relative + "/" + item.name;
      if (item.isDirectory()) visit(child, depth + 1);
      else if (item.isFile() && item.name.endsWith(".js")) files.push(child);
      else throw new Error("sqlite_source_inventory_unavailable");
      if (files.length > 64) throw new Error("sqlite_source_inventory_bound");
    }
  };
  visit("lib", 0);
  const rows = files.sort().map((relative) => {
    const bytes = regular(path.join(root, relative), 65_536);
    return { path: relative, bytes: bytes.length, sha256: sha(bytes) };
  });
  const sourceDigest = sha(JSON.stringify(rows));
  if (sourceDigest !== profiles[version].sourceDigest)
    throw new Error("sqlite_source_consistency_mismatch");
  return {
    root,
    version,
    sourceDigest,
    nativeAddonPath: path.join(root, profiles[version].nativeMember),
    minimumNodeApi: profiles[version].minimumNodeApi,
    authorizesLaunch: false as const,
  };
}

function sqlitePlugin(source: ReturnType<typeof inspectBundledSqliteSource>): Plugin {
  const index = path.join(source.root, "lib", "index.js");
  const database = path.join(source.root, "lib", "database.js");
  return {
    name: "closed-sqlite-binding-source",
    setup(context) {
      context.onResolve({ filter: /^better-sqlite3-multiple-ciphers$/ }, () => ({ path: index }));
      context.onResolve({ filter: /^bindings$/ }, (args) => {
        if (source.version !== "12.11.1" || args.importer !== database)
          throw new Error("sqlite_binding_owner_mismatch");
        return {
          path: "default-sqlite-binding-search",
          namespace: "lexrunner-denied-binding-search",
        };
      });
      context.onLoad({ filter: /.*/, namespace: "lexrunner-denied-binding-search" }, () => ({
        contents:
          "module.exports = function deniedBindingSearch() { throw new Error('default_sqlite_binding_search_denied'); };",
        loader: "js",
      }));
      context.onResolve({ filter: /^\.\/binding$/ }, (args) => {
        if (args.importer !== index) return null;
        if (source.version !== "13.0.3") throw new Error("sqlite_binding_owner_mismatch");
        return { path: "sqlite-object-only-resolver", namespace: "lexrunner-sqlite-object-only" };
      });
      context.onLoad({ filter: /.*/, namespace: "lexrunner-sqlite-object-only" }, () => ({
        contents:
          "exports.getBinding = function objectOnlyBinding(value) { if (value === null || typeof value !== 'object') throw new Error('default_sqlite_binding_search_denied'); return value; };",
        loader: "js",
      }));
    },
  };
}

/** Source-only build input override for explicit fixtures; no installed selection override. */
export async function buildWindowsCoordinatorAdmissionBundle(
  options: { sqlitePackageRoot?: string } = {}
) {
  const sqlite = inspectBundledSqliteSource(options.sqlitePackageRoot);
  const result = await build({
    entryPoints: [entry],
    outfile: "bundled-admission-probe.mjs",
    bundle: true,
    packages: "bundle",
    platform: "node",
    target: "node24",
    format: "esm",
    define: { __LEX_BUNDLED_SQLITE_VERSION__: JSON.stringify(sqlite.version) },
    banner: {
      js: "import { createRequire as __lexCreateRequire, isBuiltin as __lexIsBuiltin } from 'node:module'; const __lexBuiltinRequire = __lexCreateRequire(import.meta.url); const require = (specifier) => { if (typeof specifier !== 'string' || !__lexIsBuiltin(specifier)) throw new Error('bundled_dynamic_require_denied'); return __lexBuiltinRequire(specifier); };",
    },
    metafile: true,
    write: false,
    logLevel: "silent",
    plugins: [sqlitePlugin(sqlite)],
  });
  if (result.errors.length !== 0 || result.warnings.length !== 0)
    throw new Error("Admission bundle build diagnostics");
  if (result.outputFiles?.length !== 1 || !result.metafile)
    throw new Error("Admission bundle output unavailable");
  const inputs = Object.keys(result.metafile.inputs);
  const requiredResolver =
    sqlite.version === "12.11.1"
      ? "lexrunner-denied-binding-search"
      : "lexrunner-sqlite-object-only";
  if (
    !inputs.some((file) => /node_modules[\\/]zod[\\/]/u.test(file)) ||
    !inputs.some((file) => path.resolve(file) === path.join(sqlite.root, "lib", "database.js")) ||
    !inputs.some((file) => file.includes(requiredResolver)) ||
    inputs.some((file) => path.resolve(file) === path.join(sqlite.root, "lib", "binding.js"))
  )
    throw new Error("Admission bundle dependency closure incomplete");
  const after = inspectBundledSqliteSource(sqlite.root);
  if (after.sourceDigest !== sqlite.sourceDigest)
    throw new Error("sqlite_source_changed_during_bundle");
  const externalImports = Object.values(result.metafile.outputs).flatMap((output) =>
    output.imports.filter((item) => item.external).map((item) => item.path)
  );
  if (externalImports.some((specifier) => !isBuiltin(specifier)))
    throw new Error("Admission bundle contains an external package import");
  const bytes = result.outputFiles[0].contents;
  if (Buffer.from(bytes).toString("utf8").includes("NODE_BINDINGS_COMPILED_DIR"))
    throw new Error("Admission bundle retained default addon path search");
  return {
    bytes,
    sha256: sha(bytes),
    sourceInputCount: inputs.length,
    externalImports,
    sqlite,
    lexPackageInputCount: inputs.filter((file) =>
      /node_modules[\\/]@smartergpt[\\/]lex[\\/]/u.test(file)
    ).length,
    authorizesLaunch: false as const,
  };
}
