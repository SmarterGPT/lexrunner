import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GateOperationService,
  GateOperationStatusArgs,
} from "../src/application/gate-operation-service.js";
import {
  RETAINED_GATE_EVIDENCE_LIMITS,
  type RetainedGateEvidenceReport,
} from "../src/application/retained-gate-evidence.js";
import {
  McpGateOperationStatusArgs,
  observeMcpGateOperationStatus,
} from "../src/mcp/gate-status-presentation.js";
import { createServer } from "../src/mcp/server.js";
import { InMemoryRunStore } from "../src/store/inmemory/index.js";

const input = {
  repoRoot: "candidate",
  operationFile: "operation.json",
  operationSha256: `sha256:${"a".repeat(64)}`,
  verifyArtifacts: true,
};
const complete: RetainedGateEvidenceReport = {
  contract: "lexrunner-retained-gate-evidence/v1",
  status: "complete",
  authority: "unverified",
  scope: "referenced-evidence-closure",
  limits: RETAINED_GATE_EVIDENCE_LIMITS,
  reasonCodes: [],
  references: [
    {
      kind: "manifest",
      path: "manifest.json",
      sha256: input.operationSha256,
      bytes: 123,
      outcome: "complete",
    },
  ],
};
function observation(report?: RetainedGateEvidenceReport) {
  return {
    contract: "gate-operation-observation/v1",
    operation: input,
    authority: "unverified",
    candidate: { headSha: "b".repeat(40) },
    state: "completed",
    outcome: "pass",
    result: { allGreen: true, items: [{ id: "tests", gates: [{ gate: "test", status: "pass" }] }] },
    ...(report ? { artifactVerification: report } : {}),
  };
}
afterEach(() => vi.restoreAllMocks());

describe("gate status presentation", () => {
  it("verifies before projecting, preserves all non-report facts and leaves source immutable", () => {
    const raw = observation(complete);
    const before = structuredClone(raw);
    const status = vi.fn(() => raw);
    const actual = observeMcpGateOperationStatus(input, { status });
    expect(status).toHaveBeenCalledExactlyOnceWith(input);
    expect(actual).toEqual({
      ...raw,
      artifactVerification: {
        contract: "lexrunner-retained-gate-evidence-summary/v1",
        status: "complete",
        authority: "unverified",
        scope: "referenced-evidence-closure",
        reasonCodes: [],
        referenceCount: 1,
        issues: [],
        diagnosticAvailable: true,
      },
    });
    expect(raw).toEqual(before);
    expect(Buffer.byteLength(JSON.stringify(actual))).toBeLessThan(
      Buffer.byteLength(JSON.stringify(raw))
    );
  });
  it.each([
    "changed",
    "missing",
    "mismatched",
    "unsupported",
    "unreadable",
    "limit_exceeded",
  ] as const)("retains %s reference details and unknown state", (outcome) => {
    const issue = { ...complete.references[0]!, outcome };
    const report = {
      ...complete,
      status: "incomplete" as const,
      reasonCodes: ["FILE_CHANGED" as const],
      references: [...complete.references, issue],
    };
    const raw = {
      ...observation(report),
      state: "unknown",
      errorCode: "GATE_OPERATION_ARTIFACTS_INCOMPLETE",
      recordedOutcome: "pass",
    };
    const actual = observeMcpGateOperationStatus(input, { status: () => raw });
    expect(actual).toMatchObject({
      ...raw,
      artifactVerification: {
        contract: "lexrunner-retained-gate-evidence-summary/v1",
        reasonCodes: report.reasonCodes,
        referenceCount: 2,
        issues: [issue],
        status: "incomplete",
        authority: "unverified",
      },
    });
  });
  it("retains limit thresholds and incomplete reasons without individual references", () => {
    const report = {
      ...complete,
      status: "incomplete" as const,
      reasonCodes: ["REPORT_LIMIT" as const],
      references: [],
    };
    const actual = observeMcpGateOperationStatus(input, { status: () => observation(report) });
    expect(actual.artifactVerification).toMatchObject({
      status: "incomplete",
      reasonCodes: ["REPORT_LIMIT"],
      limits: RETAINED_GATE_EVIDENCE_LIMITS,
      referenceCount: 0,
    });
  });
  it("returns the exact original diagnostic object and core argument schema stays strict", () => {
    const raw = observation(complete);
    const status = vi.fn(() => raw);
    expect(
      observeMcpGateOperationStatus({ ...input, responseDetail: "diagnostic" }, { status })
    ).toBe(raw);
    expect(status).toHaveBeenCalledExactlyOnceWith(input);
    expect(() =>
      GateOperationStatusArgs.parse({ ...input, responseDetail: "diagnostic" })
    ).toThrow();
  });
  it.each([undefined, false])(
    "does not enable omitted/false verification (%s)",
    (verifyArtifacts) => {
      const args = { ...input, verifyArtifacts };
      const raw = observation();
      const status = vi.fn(() => raw);
      expect(observeMcpGateOperationStatus(args, { status })).toBe(raw);
      expect(status).toHaveBeenCalledExactlyOnceWith(args);
      expect(raw).not.toHaveProperty("artifactVerification");
    }
  );
  it("preserves unfamiliar report contracts, stale observations and errors verbatim", () => {
    const raw = {
      state: "unknown",
      errorCode: "GATE_OPERATION_STALE",
      observationAgeMs: 42,
      artifactVerification: { contract: "future/v2", detail: "retain" },
    };
    expect(observeMcpGateOperationStatus(input, { status: () => raw })).toBe(raw);
    const failure = new Error("read-back failed");
    expect(() =>
      observeMcpGateOperationStatus(input, {
        status: () => {
          throw failure;
        },
      })
    ).toThrow(failure);
  });
  it.each(["summary", null, 1, true])("rejects invalid detail %s before I/O", (responseDetail) => {
    const status = vi.fn();
    expect(() => observeMcpGateOperationStatus({ ...input, responseDetail }, { status })).toThrow();
    expect(status).not.toHaveBeenCalled();
  });
  it("rejects unknown fields and advertises compact as the explicit default", () => {
    expect(McpGateOperationStatusArgs.parse(input).responseDetail).toBe("compact");
    expect(() => McpGateOperationStatusArgs.parse({ ...input, extra: true })).toThrow();
  });
});

describe.each(["source", "published"] as const)("%s MCP gate presentation", (surface) => {
  it("advertises detail selection, returns compact by default and full diagnostics on request", async () => {
    const root = mkdtempSync(join(tmpdir(), "gate-presentation-"));
    const client = new Client({ name: "gate-presentation-test", version: "1.0.0" });
    const raw = observation(complete);
    const store = new InMemoryRunStore();
    const server = surface === "source" ? createServer({ runStore: store }) : undefined;
    try {
      if (server) {
        vi.spyOn(GateOperationService.prototype, "status").mockImplementation((args) => ({
          ...raw,
          observedInput: args,
        }));
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        await client.connect(clientTransport);
      } else {
        const repo = resolve(import.meta.dirname, "..");
        const bootstrap = join(root, "server.mjs");
        writeFileSync(
          bootstrap,
          `import { GateOperationService } from ${JSON.stringify(pathToFileURL(join(repo, "dist/cli.js")).href)};
GateOperationService.prototype.status = (args) => ({...${JSON.stringify(raw)}, observedInput: args});
await import(${JSON.stringify(pathToFileURL(join(repo, "mcp-server.mjs")).href)});
`
        );
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [bootstrap],
            cwd: root,
            env: {
              ...Object.fromEntries(
                Object.entries(process.env).filter(
                  (entry): entry is [string, string] => entry[1] !== undefined
                )
              ),
              ALLOW_MUTATIONS: "false",
              LEX_PR_PROFILE_DIR: join(root, "profile"),
            },
            stderr: "pipe",
          })
        );
      }
      const name = surface === "source" ? "gates_status" : "gates.status";
      const inventory = await client.listTools();
      expect(
        inventory.tools.find((tool) => tool.name === name)?.inputSchema.properties
      ).toMatchObject({
        responseDetail: { enum: ["compact", "diagnostic"], default: "compact" },
        verifyArtifacts: { type: "boolean" },
      });
      const call = async (args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).not.toBe(true);
        return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
      };
      expect(await call(input)).toMatchObject({
        observedInput: input,
        artifactVerification: {
          contract: "lexrunner-retained-gate-evidence-summary/v1",
          referenceCount: 1,
          issues: [],
        },
      });
      expect(await call({ ...input, responseDetail: "diagnostic" })).toEqual({
        ...raw,
        observedInput: input,
      });
    } finally {
      await client.close();
      await server?.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
