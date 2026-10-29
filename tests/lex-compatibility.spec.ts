import { describe, expect, it } from "vitest";
import { validateLexCompatibility } from "../scripts/check-lex-compatibility.mjs";

function fixture() {
  const dependencies = {
    "@smartergpt/lex": "4.4.4",
    "better-sqlite3-multiple-ciphers": "13.0.3",
  };
  return {
    manifest: {
      dependencies,
      allowScripts: { "@smartergpt/lex": false, "better-sqlite3-multiple-ciphers@13.0.3": true },
    },
    lock: {
      packages: {
        "": { dependencies: { ...dependencies } },
        "node_modules/@smartergpt/lex": { version: "4.4.4" },
        "node_modules/better-sqlite3-multiple-ciphers": { version: "13.0.3" },
      } as Record<string, any>,
    },
    lex: { version: "4.4.4", dependencies: { "better-sqlite3-multiple-ciphers": "13.0.3" } },
    sqlite: { version: "13.0.3" },
  };
}

describe("qualified Lex dependency set", () => {
  it("accepts the exact manifest, lock, installed dependencies and script decisions", () => {
    const f = fixture();
    expect(() => validateLexCompatibility(f.manifest, f.lock, f.lex, f.sqlite)).not.toThrow();
  });

  it("refuses widened or stale direct support claims and stale lock roots", () => {
    for (const name of ["@smartergpt/lex", "better-sqlite3-multiple-ciphers"] as const) {
      const f = fixture();
      f.manifest.dependencies[name] = `^${f.manifest.dependencies[name]}`;
      expect(() => validateLexCompatibility(f.manifest, f.lock, f.lex, f.sqlite)).toThrow(
        "requires exact"
      );
      const stale = fixture();
      stale.lock.packages[""].dependencies[name] = "4.0.3";
      expect(() =>
        validateLexCompatibility(stale.manifest, stale.lock, stale.lex, stale.sqlite)
      ).toThrow("manifest/lock mismatch");
    }
  });

  it("refuses duplicate native or Lex builds, including a nested old Lex", () => {
    for (const name of ["@smartergpt/lex", "better-sqlite3-multiple-ciphers"]) {
      const f = fixture();
      f.lock.packages[`node_modules/other/node_modules/${name}`] = { version: "4.0.3" };
      expect(() => validateLexCompatibility(f.manifest, f.lock, f.lex, f.sqlite)).toThrow(
        "requires one locked"
      );
    }
  });

  it("refuses installed package and Lex native dependency drift", () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.lex.version = "4.0.3";
      },
      (f: ReturnType<typeof fixture>) => {
        f.lex.dependencies["better-sqlite3-multiple-ciphers"] = "^12.6.2";
      },
      (f: ReturnType<typeof fixture>) => {
        f.sqlite.version = "12.11.1";
      },
    ]) {
      const f = fixture();
      mutate(f);
      expect(() => validateLexCompatibility(f.manifest, f.lock, f.lex, f.sqlite)).toThrow(
        "Installed Lex/SQLite identity"
      );
    }
  });

  it("refuses old native approvals or enabled Lex lifecycle scripts", () => {
    const f = fixture();
    Object.assign(f.manifest.allowScripts, { "better-sqlite3-multiple-ciphers@12.11.1": true });
    expect(() => validateLexCompatibility(f.manifest, f.lock, f.lex, f.sqlite)).toThrow(
      "exact SQLite script approval"
    );
    const enabled = fixture();
    enabled.manifest.allowScripts["@smartergpt/lex"] = true;
    expect(() =>
      validateLexCompatibility(enabled.manifest, enabled.lock, enabled.lex, enabled.sqlite)
    ).toThrow("Lex script denial");
  });
});
