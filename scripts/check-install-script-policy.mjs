import { spawnSync } from "node:child_process";
import { observeNpmPolicyRuntime, assertNpmPolicyRuntimeUnchanged } from "./npm-policy-runtime.mjs";

try {
  if (process.argv.length !== 2)
    throw new Error("Install-script policy check does not accept caller switches.");
  const npmRuntime = observeNpmPolicyRuntime({ projectRoot: process.cwd() });
  assertNpmPolicyRuntimeUnchanged(npmRuntime);

  const result = spawnSync(
    npmRuntime.nodeExecutable,
    [npmRuntime.npmCliPath, "approve-scripts", "--allow-scripts-pending"],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false }
  );
  assertNpmPolicyRuntimeUnchanged(npmRuntime);

  if (result.error)
    throw new Error(`Unable to inspect npm install-script policy: ${result.error.message}`);

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (
    result.status !== 0 ||
    result.stdout?.trim() !== "No packages with unreviewed install scripts."
  ) {
    throw new Error(output || "npm did not return an install-script policy result.");
  }
  console.log(JSON.stringify({ status: "verified", pendingInstallScripts: 0, npmRuntime }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
