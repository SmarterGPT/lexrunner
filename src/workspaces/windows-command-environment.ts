/** Snapshot the portable env/extendEnv contract using Windows case-insensitive names. */
export function windowsCommandEnvironment(
  request: { env?: Readonly<Record<string, string>>; extendEnv?: boolean },
  parent: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
  const values = new Map<string, { name: string; value: string }>();
  const add = (input: Readonly<Record<string, string | undefined>>) => {
    const seen = new Set<string>();
    for (const [name, value] of Object.entries(input)) {
      if (value === undefined) continue;
      const key = name.toUpperCase();
      if (
        !name ||
        /^[0-9]/u.test(name) ||
        Buffer.from(name, "utf8").toString("utf8") !== name ||
        /[=\0]/u.test(name) ||
        typeof value !== "string" ||
        value.includes("\0") ||
        Buffer.from(value, "utf8").toString("utf8") !== value ||
        seen.has(key)
      )
        throw new Error("Invalid or ambiguous Windows command environment");
      seen.add(key);
      values.set(key, { name, value });
    }
  };
  if (request.extendEnv !== false) add(parent);
  if (request.env) add(request.env);
  const entries = [...values.values()];
  if (
    entries.length > 256 ||
    entries.reduce((n, p) => n + p.name.length + p.value.length + 2, 1) > 32_767
  )
    throw new Error("Windows command environment exceeds supported bound");
  return Object.fromEntries(entries.map(({ name, value }) => [name, value]));
}
