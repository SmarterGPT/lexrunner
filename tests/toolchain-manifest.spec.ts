import { describe, it, expect } from "vitest";
import {
  generateToolchainManifest,
  formatToolchainAsMarkdown,
} from "../src/orchestration/toolchainManifest";

describe("Toolchain Manifest", () => {
  describe("generateToolchainManifest", () => {
    it("should generate manifest with schema version", () => {
      const manifest = generateToolchainManifest();

      expect(manifest.schemaVersion).toBe("1.0.0");
    });

    it("should include generated timestamp", () => {
      const manifest = generateToolchainManifest();

      expect(manifest.generated).toBeDefined();
      expect(new Date(manifest.generated).getTime()).toBeGreaterThan(0);
    });

    it("should include tools array", () => {
      const manifest = generateToolchainManifest();

      expect(manifest.tools).toBeInstanceOf(Array);
      expect(manifest.tools.length).toBeGreaterThan(0);
    });

    it("should always include Node.js version", () => {
      const manifest = generateToolchainManifest();

      const nodejs = manifest.tools.find((t) => t.name === "Node.js");
      expect(nodejs).toBeDefined();
      expect(nodejs?.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(nodejs?.path).toBeDefined();
    });

    it("should include environment information", () => {
      const manifest = generateToolchainManifest();

      expect(manifest.environment).toBeDefined();
      expect(manifest.environment.timezone).toBeDefined();
      expect(manifest.environment.locale).toBeDefined();
      expect(manifest.environment.platform).toBeDefined();
      expect(manifest.environment.arch).toBeDefined();
      expect(manifest.environment.nodeVersion).toBeDefined();
    });

    it("should include git version if available", () => {
      const manifest = generateToolchainManifest();

      // Git should be available in CI environment
      const git = manifest.tools.find((t) => t.name === "git");
      if (git) {
        expect(git.version).toMatch(/^\d+\.\d+/);
      }
    });

    it("should include npm version if available", () => {
      const manifest = generateToolchainManifest();

      const npm = manifest.tools.find((t) => t.name === "npm");
      if (npm) {
        expect(npm.version).toMatch(/^\d+\.\d+/);
      }
    });

    it("should include TypeScript version from package.json", () => {
      const manifest = generateToolchainManifest();

      const typescript = manifest.tools.find((t) => t.name === "TypeScript");
      expect(typescript).toBeDefined();
      expect(typescript?.version).toMatch(/^\d+\.\d+/);
    });

    it("omits ESLint when it is not a declared source tool", () => {
      const manifest = generateToolchainManifest();

      const eslint = manifest.tools.find((t) => t.name === "ESLint");
      expect(eslint).toBeUndefined();
    });

    it("should use UTC timezone from environment", () => {
      const manifest = generateToolchainManifest();

      expect(manifest.environment.timezone).toBe("UTC");
    });
  });

  describe("formatToolchainAsMarkdown", () => {
    it("should format toolchain as markdown table", () => {
      const manifest = generateToolchainManifest();
      const markdown = formatToolchainAsMarkdown(manifest);

      expect(markdown).toContain("## Toolchain");
      expect(markdown).toContain("| Tool | Version |");
      expect(markdown).toContain("|------|---------|");
    });

    it("should include all tools in the table", () => {
      const manifest = generateToolchainManifest();
      const markdown = formatToolchainAsMarkdown(manifest);

      for (const tool of manifest.tools) {
        expect(markdown).toContain(`| ${tool.name} | ${tool.version} |`);
      }
    });

    it("should include environment information", () => {
      const manifest = generateToolchainManifest();
      const markdown = formatToolchainAsMarkdown(manifest);

      expect(markdown).toContain("**Environment:**");
      expect(markdown).toContain(`TZ=${manifest.environment.timezone}`);
      expect(markdown).toContain(`LANG=${manifest.environment.locale}`);
    });

    it("should reference toolchain-manifest.json file", () => {
      const manifest = generateToolchainManifest();
      const markdown = formatToolchainAsMarkdown(manifest);

      expect(markdown).toContain("Full manifest: `toolchain-manifest.json`");
    });

    it("should be valid markdown", () => {
      const manifest = generateToolchainManifest();
      const markdown = formatToolchainAsMarkdown(manifest);

      // Check basic markdown structure
      expect(markdown).toMatch(/^## Toolchain/m);
      expect(
        markdown.split("\n").filter((line) => line.includes("|")).length
      ).toBeGreaterThanOrEqual(3);
    });

    it("should produce consistent output for same manifest", () => {
      const manifest = generateToolchainManifest();
      const markdown1 = formatToolchainAsMarkdown(manifest);
      const markdown2 = formatToolchainAsMarkdown(manifest);

      expect(markdown1).toBe(markdown2);
    });
  });
});
