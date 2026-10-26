/** Public configuration-location variables used by the broker's ordinary Git.
 * Credential variables and the general parent environment are never projected.
 * Inline Git config can contain credentials/command overrides and is unsupported.
 */
export const WINDOWS_REMOVAL_GIT_ENVIRONMENT_NAMES = [
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "XDG_CONFIG_HOME",
  "PROGRAMDATA",
  "ALLUSERSPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_ATTR_NOSYSTEM",
] as const;

export function windowsRemovalGitEnvironment(
  parent: Readonly<Record<string, string | undefined>> = process.env
) {
  const values = new Map<string, string>();
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    const key = name.toUpperCase();
    if (/^GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/u.test(key))
      throw new Error("Inline Git configuration is unsupported for native removal");
    if (!WINDOWS_REMOVAL_GIT_ENVIRONMENT_NAMES.some((allowed) => allowed === key)) continue;
    if (
      values.has(key) ||
      value.includes("\0") ||
      Buffer.byteLength(value, "utf8") > 8192 ||
      Buffer.from(value, "utf8").toString("utf8") !== value
    )
      throw new Error("Invalid native removal Git configuration environment");
    values.set(key, value);
  }
  return WINDOWS_REMOVAL_GIT_ENVIRONMENT_NAMES.flatMap((name) => {
    const value = values.get(name);
    return value === undefined
      ? []
      : [{ name, value_base64: Buffer.from(value, "utf8").toString("base64") }];
  });
}
