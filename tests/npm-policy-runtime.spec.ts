import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertNpmPolicyRuntimeUnchanged,
  observeNpmPolicyRuntime,
  validateObservedNodeRuntime,
} from "../scripts/npm-policy-runtime.mjs";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture({
  version = "11.16.0",
  approvalUsage = "npm approve-scripts --allow-scripts-pending",
  installUsage = "npm install --allow-scripts --strict-allow-scripts",
  versionExit = 0,
  changeDuringProbe = false,
  pendingOutput = "No packages with unreviewed install scripts.",
} = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lexrunner-npm-runtime-"));
  temporaryRoots.push(projectRoot);
  fs.writeFileSync(
    path.join(projectRoot, "package.json"),
    JSON.stringify({ packageManager: "npm@11.16.0", engines: { node: ">=24" } })
  );
  const npmCliPath = path.join(projectRoot, "npm-cli.cjs");
  fs.writeFileSync(
    npmCliPath,
    `
    const fs = require("node:fs");
    const command = process.argv[2];
    if (command === "--version") {
      ${changeDuringProbe ? 'fs.appendFileSync(__filename, "\\n// replaced during observation\\n");' : ""}
      console.log(${JSON.stringify(version)});
      process.exit(${versionExit});
    } else if (command === "approve-scripts") {
      console.log(process.argv[3] === "--usage" ? ${JSON.stringify(approvalUsage)} : ${JSON.stringify(pendingOutput)});
    } else if (command === "install") {
      console.log(${JSON.stringify(installUsage)});
    } else process.exit(2);
  `
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(?:node_options|npm_execpath)$/i.test(key))
  );
  env.npm_execpath = npmCliPath;
  return { projectRoot, npmCliPath, env };
}

describe("observed npm install-policy runtime", () => {
  it("enforces the observed Node floor with valid current/higher versions", () => {
    expect(() => validateObservedNodeRuntime("v23.11.0", ">=24")).toThrow(
      "requires Node >=24; observed v23.11.0"
    );
    expect(validateObservedNodeRuntime("v24.14.1", ">=24")).toBe(24);
    expect(validateObservedNodeRuntime("v26.0.0", ">=24")).toBe(24);
  });

  it("refuses missing/unsupported engine ranges and malformed observed Node versions", () => {
    for (const range of [undefined, "24", "^24", ">=24 <27", ">=999999999999999999"]) {
      expect(() => validateObservedNodeRuntime("v24.14.1", range)).toThrow(
        "supported source engines.node floor"
      );
    }
    for (const version of [
      undefined,
      "24.14.1",
      "v24",
      "v24.14.1\nv23.0.0",
      "v24.0.0-nightly",
      "v024.0.0",
    ]) {
      expect(() => validateObservedNodeRuntime(version, ">=24")).toThrow("malformed version");
    }
  });

  it("checks the actual Node engine floor before qualifying npm version/capabilities", () => {
    const input = fixture();
    fs.writeFileSync(
      path.join(input.projectRoot, "package.json"),
      JSON.stringify({ packageManager: "npm@11.16.0", engines: { node: ">=999" } })
    );
    expect(() => observeNpmPolicyRuntime(input)).toThrow("requires Node >=999; observed");
  });
  it("retains actual physical paths, version and hashes after read-only capability probes", () => {
    const input = fixture();
    const observation = observeNpmPolicyRuntime(input);
    expect(observation).toMatchObject({
      npmVersion: "11.16.0",
      requiredNpmVersion: "11.16.0",
      npmCliPath: fs.realpathSync(input.npmCliPath),
      nodeExecutable: fs.realpathSync(process.execPath),
      selection: "explicit",
      policyCapabilities: ["approve-scripts", "allow-scripts", "strict-allow-scripts"],
      requiredNodeMajor: 24,
      nodeEngine: ">=24",
      lifecycleNodeOptions: '""',
    });
    expect(observation.npmCliSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(observation.nodeExecutableSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(observation.manifestSha256).toBe(
      createHash("sha256")
        .update(fs.readFileSync(path.join(input.projectRoot, "package.json")))
        .digest("hex")
    );
    expect(Object.isFrozen(observation)).toBe(true);
    expect(() => assertNpmPolicyRuntimeUnchanged(observation)).not.toThrow();
  });

  it("selects npm_execpath deterministically without searching PATH", () => {
    const { projectRoot, npmCliPath, env } = fixture();
    const observation = observeNpmPolicyRuntime({ projectRoot, env });
    expect(observation.selection).toBe("npm_execpath");
    expect(observation.npmCliPath).toBe(fs.realpathSync(npmCliPath));
  });

  it("refuses npm 11.11 before capability or install-policy qualification", () => {
    expect(() => observeNpmPolicyRuntime(fixture({ version: "11.11.0" }))).toThrow(
      "requires npm 11.16.0; observed 11.11.0"
    );
  });

  it("refuses claimed pinned npm without approve-scripts or strict allowScripts capability", () => {
    expect(() => observeNpmPolicyRuntime(fixture({ approvalUsage: "Unknown command" }))).toThrow(
      "lacks the required"
    );
    expect(() =>
      observeNpmPolicyRuntime(fixture({ installUsage: "npm install --ignore-scripts" }))
    ).toThrow("lacks the required");
  });

  it("refuses failed, malformed and oversized version responses", () => {
    expect(() => observeNpmPolicyRuntime(fixture({ versionExit: 1 }))).toThrow(
      "Unable to observe npm version"
    );
    expect(() => observeNpmPolicyRuntime(fixture({ version: "11.16.0\n11.11.0" }))).toThrow(
      "malformed version"
    );
    expect(() => observeNpmPolicyRuntime(fixture({ version: "1".repeat(32 * 1024) }))).toThrow(
      "Unable to observe npm version"
    );
  });

  it("refuses changed executable bytes between observation and policy use", () => {
    const input = fixture();
    const observation = observeNpmPolicyRuntime(input);
    fs.appendFileSync(input.npmCliPath, "\n// replacement\n");
    expect(() => assertNpmPolicyRuntimeUnchanged(observation)).toThrow("npm CLI changed since");
  });

  it("refuses executable replacement during a version probe", () => {
    expect(() => observeNpmPolicyRuntime(fixture({ changeDuringProbe: true }))).toThrow(
      "npm CLI changed since"
    );
  });

  it("refuses missing or mismatched paths without executing an alternative", () => {
    const input = fixture();
    const observation = observeNpmPolicyRuntime(input);
    expect(() =>
      assertNpmPolicyRuntimeUnchanged({ ...observation, npmCliPath: process.execPath })
    ).toThrow("npm CLI changed since");
    expect(() =>
      assertNpmPolicyRuntimeUnchanged({ ...observation, nodeExecutable: input.npmCliPath })
    ).toThrow("Node executable changed since");
    fs.unlinkSync(input.npmCliPath);
    expect(() => assertNpmPolicyRuntimeUnchanged(observation)).toThrow("Unable to observe npm CLI");
  });

  it("rejects command switches as executable selectors and injectable Node preloads", () => {
    const input = fixture();
    expect(() =>
      observeNpmPolicyRuntime({ ...input, npmCliPath: "--eval=console.log('11.16.0')" })
    ).toThrow("not command-line switches");
    expect(() => observeNpmPolicyRuntime({ ...input, npmCliPath: "" })).toThrow(
      "not command-line switches"
    );
    for (const option of [
      "--require ./preload.js",
      "-r./preload.js",
      "--import=data:text/javascript,x",
      "--loader ./preload.js",
    ]) {
      expect(() =>
        observeNpmPolicyRuntime({ ...input, env: { ...input.env, NODE_OPTIONS: option } })
      ).toThrow("refuses executable preloads");
    }
  });

  it("permits ordinary non-executable Node options", () => {
    const input = fixture();
    const observation = observeNpmPolicyRuntime({
      ...input,
      env: { ...input.env, NODE_OPTIONS: "--max-old-space-size=512" },
    });
    expect(observation.npmVersion).toBe("11.16.0");
    expect(observation.lifecycleNodeOptions).toBe("--max-old-space-size=512");
  });

  it("rejects executable preloads in lowercase/mixed-case Windows environment keys", () => {
    const input = fixture();
    for (const key of ["node_options", "Node_Options", "NODE_options"]) {
      expect(() =>
        observeNpmPolicyRuntime({
          ...input,
          env: { ...input.env, [key]: "--import=data:text/javascript,x" },
        })
      ).toThrow("refuses executable preloads");
    }
  });

  it("rejects ambiguous case-insensitive option duplicates and permits one memory-only key", () => {
    const input = fixture();
    expect(() =>
      observeNpmPolicyRuntime({
        ...input,
        env: {
          ...input.env,
          NODE_OPTIONS: "--max-old-space-size=512",
          node_options: "--max-old-space-size=512",
        },
      })
    ).toThrow("ambiguous duplicate NODE_OPTIONS");
    const observation = observeNpmPolicyRuntime({
      ...input,
      env: { ...input.env, node_options: "--max-old-space-size=512" },
    });
    expect(observation.npmVersion).toBe("11.16.0");
    expect(observation.lifecycleNodeOptions).toBe("--max-old-space-size=512");
  });

  it("requires an exact package-manager pin rather than accepting injected switches", () => {
    const input = fixture();
    fs.writeFileSync(
      path.join(input.projectRoot, "package.json"),
      JSON.stringify({ packageManager: "npm@11.16.0 --ignore-scripts" })
    );
    expect(() => observeNpmPolicyRuntime(input)).toThrow(
      "requires an exact npm packageManager pin"
    );
  });

  it("qualifies pending-policy results with observed runtime and refuses ambiguous output", () => {
    const script = fileURLToPath(
      new URL("../scripts/check-install-script-policy.mjs", import.meta.url)
    );
    const input = fixture();
    const result = spawnSync(process.execPath, [script], {
      cwd: input.projectRoot,
      env: input.env,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "verified",
      pendingInstallScripts: 0,
      npmRuntime: { npmVersion: "11.16.0", npmCliPath: fs.realpathSync(input.npmCliPath) },
    });

    const ambiguous = fixture({
      pendingOutput: "No packages with unreviewed install scripts.\n1 package pending",
    });
    const refused = spawnSync(process.execPath, [script], {
      cwd: ambiguous.projectRoot,
      env: ambiguous.env,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("1 package pending");
  });

  it("refuses policy-check caller switches before runtime or pending-policy qualification", () => {
    const script = fileURLToPath(
      new URL("../scripts/check-install-script-policy.mjs", import.meta.url)
    );
    const input = fixture({ version: "11.11.0" });
    const result = spawnSync(process.execPath, [script, "--dangerously-allow-all-scripts"], {
      cwd: input.projectRoot,
      env: input.env,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("does not accept caller switches");
  });
});
