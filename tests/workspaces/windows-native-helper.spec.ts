import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { probeOwnedWindowsBoundaryHandshake } from "../../src/workspaces/owned-windows-boundary-handshake.js";
import { encodeWindowsBoundaryControl } from "../../src/workspaces/windows-boundary-protocol.js";
import { resolveWorkspaceBoundary } from "../../src/workspaces/workspace-boundary-resolver.js";

// Explicit test-only executable; never an override of production resolution.
const executable = process.env.LEXRUNNER_TEST_NATIVE_HELPER;
describe.skipIf(process.platform !== "win32" || !executable)(
  "real NativeAOT negotiation peer",
  () => {
    const request = {
      kind: "hello",
      protocol_version: "1.0.0",
      request_id: "native-test",
      client_nonce: "a".repeat(64),
    };
    function run(input: Buffer, args = ["--boundary-protocol", "1.0.0"]) {
      return spawnSync(executable!, args, {
        input,
        timeout: 3000,
        maxBuffer: 8192,
        windowsHide: true,
      });
    }
    it("matches through the real owned launcher and closes without forced termination", async () => {
      const digest = `sha256:${createHash("sha256").update(readFileSync(executable!)).digest("hex")}`;
      expect(
        await probeOwnedWindowsBoundaryHandshake({
          executable: executable!,
          cwd: dirname(executable!),
          expectedArtifactSha256: digest,
          architecture: "x64",
        })
      ).toMatchObject({
        outcome: "matched",
        verification: "not_performed",
        cleanup: {
          disposition: "closed",
          processExited: true,
          terminationRequested: false,
          exitCode: 0,
        },
      });
    });
    it("rejects a mismatched expected image digest", async () => {
      expect(
        await probeOwnedWindowsBoundaryHandshake({
          executable: executable!,
          cwd: dirname(executable!),
          expectedArtifactSha256: `sha256:${"0".repeat(64)}`,
          architecture: "x64",
        })
      ).toMatchObject({
        outcome: "failed",
        reason: "metadata_mismatch",
        verification: "not_performed",
      });
    });
    it.each([
      Buffer.from([0, 0]),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from([0, 0, 16, 1]),
      Buffer.from([0, 0, 0, 1, 255]),
      Buffer.from([0, 0, 0, 2, 123]),
      (() => {
        const text = Buffer.from(JSON.stringify(request));
        const size = Buffer.alloc(4);
        size.writeUInt32BE(text.length);
        return Buffer.concat([size, text]);
      })(),
    ])("rejects malformed, truncated or noncanonical input %#", (input) => {
      const result = run(input);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(3);
      expect(result.stdout.length).toBe(0);
    });
    it("rejects extra frames after its single exchange", () => {
      const frame = encodeWindowsBoundaryControl(request);
      const result = run(Buffer.concat([frame, frame]));
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(3);
    });
    it("rejects unsupported launch arguments without speaking protocol", () => {
      const result = run(Buffer.alloc(0), ["--boundary-protocol", "2.0.0"]);
      expect(result.status).toBe(2);
      expect(result.stdout.length).toBe(0);
    });
    it("does not change production readiness", () => {
      expect(resolveWorkspaceBoundary({ mode: "native" })).toMatchObject({
        ok: false,
        decision: { state: "unavailable", reason_code: "helper_missing" },
      });
    });
  }
);
