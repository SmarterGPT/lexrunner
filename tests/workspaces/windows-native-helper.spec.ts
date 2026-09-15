import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  probeOwnedWindowsBoundaryHandshake,
  probeOwnedWindowsBoundarySession,
} from "../../src/workspaces/owned-windows-boundary-handshake.js";
import {
  encodeWindowsBoundaryControl,
  encodeWindowsBoundarySession,
  WindowsBoundaryControlDecoder,
} from "../../src/workspaces/windows-boundary-protocol.js";
import { canonicalJSONStringify } from "../../src/util/canonicalJson.js";
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
    it.each([2, 15])(
      "keeps one actual native process for %i correlated status requests",
      async (rounds) => {
        const report = await probeOwnedWindowsBoundarySession(
          {
            executable: executable!,
            cwd: dirname(executable!),
            expectedArtifactSha256: `sha256:${createHash("sha256").update(readFileSync(executable!)).digest("hex")}`,
            architecture: "x64",
          },
          rounds
        );
        expect(report).toMatchObject({
          outcome: "matched",
          verification: "not_performed",
          sessionOperations: { requested: rounds, correlated: rounds },
          cleanup: { processExited: true, exitCode: 0, terminationRequested: false },
        });
      }
    );
    it.each(["wrong-session", "wrong-digest", "duplicate"])(
      "native session rejects %s",
      async (mode) => {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(executable!, ["--boundary-session", "1.0.0"], {
            windowsHide: true,
            stdio: "pipe",
          });
          const decoder = new WindowsBoundaryControlDecoder(true);
          let frame: Buffer;
          let replies = 0;
          const timer = setTimeout(() => {
            child.kill();
            reject(new Error("native rejection timed out"));
          }, 3000);
          child.stdin.on("error", () => {}); // Exit3 may race pipe closure after rejection.
          child.stderr.resume();
          child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.stdout.on("data", (chunk) => {
            try {
              for (const message of decoder.push(chunk)) {
                if (message.kind === "hello_result") {
                  const body = {
                    client_nonce: request.client_nonce,
                    kind: "session_request" as const,
                    operation: "session-status" as const,
                    operation_id: "op1",
                    protocol_version: "1.0.0" as const,
                    request_id: "r1",
                    session_nonce:
                      mode === "wrong-session" ? "f".repeat(64) : message.session_nonce,
                  };
                  const digest =
                    mode === "wrong-digest"
                      ? `sha256:${"0".repeat(64)}`
                      : `sha256:${createHash("sha256").update(canonicalJSONStringify(body)).digest("hex")}`;
                  frame = encodeWindowsBoundarySession({ ...body, request_digest: digest });
                  child.stdin.write(frame);
                } else if (message.kind === "session_result") {
                  replies++;
                  child.stdin.write(frame); // Exact replay must be rejected by native state.
                } else throw new Error("Unexpected native message");
              }
            } catch (error) {
              child.kill();
              clearTimeout(timer);
              reject(error);
            }
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            try {
              decoder.end();
              expect(code).toBe(3);
              expect(replies).toBe(mode === "duplicate" ? 1 : 0);
              resolve();
            } catch (error) {
              reject(error);
            }
          });
          child.stdin.write(encodeWindowsBoundaryControl(request));
        });
      }
    );
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
