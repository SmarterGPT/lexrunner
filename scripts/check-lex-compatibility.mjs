import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const QUALIFIED_LEX_VERSION = "4.4.4";
export const QUALIFIED_SQLITE_VERSION = "13.0.3";
const lexName = "@smartergpt/lex";
const sqliteName = "better-sqlite3-multiple-ciphers";

/** Check the reviewed support claim, not an unqualified moving registry dist-tag. */
export function validateLexCompatibility(manifest, lock, installedLex, installedSqlite) {
  if (manifest.dependencies?.[lexName] !== QUALIFIED_LEX_VERSION) {
    throw new Error(`Lex compatibility requires exact ${lexName}@${QUALIFIED_LEX_VERSION}`);
  }
  if (manifest.dependencies?.[sqliteName] !== QUALIFIED_SQLITE_VERSION) {
    throw new Error(`Lex compatibility requires exact ${sqliteName}@${QUALIFIED_SQLITE_VERSION}`);
  }
  for (const name of [lexName, sqliteName]) {
    if (lock.packages?.[""]?.dependencies?.[name] !== manifest.dependencies[name]) {
      throw new Error(`Lex compatibility manifest/lock mismatch: ${name}`);
    }
  }
  for (const [name, version] of [
    [lexName, QUALIFIED_LEX_VERSION],
    [sqliteName, QUALIFIED_SQLITE_VERSION],
  ]) {
    const entries = Object.entries(lock.packages ?? {}).filter(
      ([entry]) => entry === `node_modules/${name}` || entry.endsWith(`/node_modules/${name}`)
    );
    if (
      entries.length !== 1 ||
      entries[0][0] !== `node_modules/${name}` ||
      entries[0][1].version !== version
    ) {
      throw new Error(`Lex compatibility requires one locked ${name}@${version}`);
    }
  }
  if (
    installedLex.version !== QUALIFIED_LEX_VERSION ||
    installedLex.dependencies?.[sqliteName] !== QUALIFIED_SQLITE_VERSION ||
    installedSqlite.version !== QUALIFIED_SQLITE_VERSION
  ) {
    throw new Error("Installed Lex/SQLite identity differs from the qualified compatibility set");
  }
  const approvals = Object.entries(manifest.allowScripts ?? {}).filter(
    ([specifier, allowed]) =>
      allowed && (specifier === sqliteName || specifier.startsWith(`${sqliteName}@`))
  );
  if (
    manifest.allowScripts?.[lexName] !== false ||
    approvals.length !== 1 ||
    approvals[0][0] !== `${sqliteName}@${QUALIFIED_SQLITE_VERSION}`
  ) {
    throw new Error(
      "Lex compatibility requires exact SQLite script approval and Lex script denial"
    );
  }
}

export function checkLexCompatibility(projectRoot = process.cwd()) {
  const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  const manifest = read(path.join(projectRoot, "package.json"));
  const lock = read(path.join(projectRoot, "package-lock.json"));
  const lexManifestPath = path.join(projectRoot, "node_modules", lexName, "package.json");
  const installedLex = read(lexManifestPath);
  const installedSqlite = read(path.join(projectRoot, "node_modules", sqliteName, "package.json"));
  validateLexCompatibility(manifest, lock, installedLex, installedSqlite);
  const lexSqlitePath = createRequire(pathToFileURL(lexManifestPath)).resolve(
    `${sqliteName}/package.json`
  );
  if (
    fs.realpathSync(lexSqlitePath) !==
    fs.realpathSync(path.join(projectRoot, "node_modules", sqliteName, "package.json"))
  ) {
    throw new Error("Lex resolves a separate SQLite installation");
  }
  return { status: "verified", lex: QUALIFIED_LEX_VERSION, sqlite: QUALIFIED_SQLITE_VERSION };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2)
      throw new Error("Lex compatibility check does not accept caller switches");
    console.log(JSON.stringify(checkLexCompatibility()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
