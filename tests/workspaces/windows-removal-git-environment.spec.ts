import { describe, expect, it } from "vitest";
import { windowsRemovalGitEnvironment } from "../../src/workspaces/windows-removal-git-environment.js";

describe("native removal Git configuration locations", () => {
  it("projects only configuration locations and preserves Unicode and caller spelling of values", () => {
    const result = windowsRemovalGitEnvironment({
      home: "C:\\café",
      Git_Config_Global: "C:\\config",
      GH_TOKEN: "fixture-secret",
      PATH: "unrelated",
      NODE_OPTIONS: "unrelated",
    });
    expect(result).toEqual([
      { name: "HOME", value_base64: Buffer.from("C:\\café").toString("base64") },
      { name: "GIT_CONFIG_GLOBAL", value_base64: Buffer.from("C:\\config").toString("base64") },
    ]);
  });
  it.each(["GIT_CONFIG_COUNT", "git_config_parameters", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"])(
    "refuses inline configuration %s instead of projecting arbitrary values",
    (name) => {
      expect(() => windowsRemovalGitEnvironment({ [name]: "fixture" })).toThrow(
        "Inline Git configuration is unsupported"
      );
    }
  );
  it("rejects duplicate Windows names, invalid text and unbounded values", () => {
    for (const env of [
      { HOME: "one", home: "two" },
      { HOME: "bad\0value" },
      { HOME: "\ud800" },
      { HOME: "a".repeat(8193) },
    ])
      expect(() => windowsRemovalGitEnvironment(env)).toThrow(
        "Invalid native removal Git configuration environment"
      );
  });
});
