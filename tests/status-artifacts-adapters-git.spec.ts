import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  GateOperationService,
  type GateOperationHandle,
} from "../src/application/gate-operation-service.js";
import {
  candidateFixture,
  routingPlan,
  type CandidateFixture,
} from "./helpers/gate-candidate-fixture.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const digest = `sha256:${"a".repeat(64)}`;
type Report = { status: "complete" | "incomplete"; authority: "unverified" };
type Observation = {
  operation?: GateOperationHandle;
  state?: string;
  outcome?: string;
  lastReportedState?: string;
  errorCode?: string;
  reason?: string;
  artifactVerification?: Report;
  evidence?: { artifactVerification?: Report };
  result?: { artifactRefs: Array<{ kind: string; path: string; sha256?: string }> };
};
type OwnedFixture = CandidateFixture & { handle?: GateOperationHandle; idempotencyKey?: string };
const fixtures: OwnedFixture[] = [];
const hash = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

function ownedFixture(): OwnedFixture {
  const fixture = candidateFixture();
  fixtures.push(fixture);
  return fixture;
}

// A lost start acknowledgement is recoverable from this fixture's exact key/path.
// Never delete a fixture while its worker has an unresolved lifecycle.
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    if (!fixture.handle && fixture.idempotencyKey) {
      const operationId = createHash("sha256").update(fixture.idempotencyKey).digest("hex");
      const operationFile = join(
        fixture.artifacts,
        "gate-operation-" + operationId,
        "operation.json"
      );
      if (existsSync(operationFile)) {
        fixture.handle = {
          repoRoot: fixture.a,
          operationFile,
          operationSha256: hash(readFileSync(operationFile)),
        };
      }
    }
    if (fixture.handle) {
      const deadline = Date.now() + 25_000;
      let settled = false;
      while (Date.now() < deadline) {
        const state = new GateOperationService().status(fixture.handle).state;
        if (["completed", "cancelled", "failed"].includes(String(state))) {
          settled = true;
          break;
        }
        await delay(50);
      }
      if (!settled)
        throw new Error(`Retaining unresolved owned operation fixture: ${fixture.root}`);
    }
    fixture.dispose();
  }
}, 30_000);

function privateEnvironment(fixture: CandidateFixture): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && !entry[0].toUpperCase().startsWith("GIT_")
      )
    ),
    ALLOW_MUTATIONS: "false",
    LEX_PR_PROFILE_DIR: join(fixture.root, "private-profile"),
  };
}

async function connectedClient(
  fixture: CandidateFixture,
  surface: "source" | "published"
): Promise<Client> {
  const bootstrap = join(fixture.root, "artifacts-source-server.mts");
  if (surface === "source") {
    writeFileSync(
      bootstrap,
      `import { createServer } from ${JSON.stringify(pathToFileURL(join(repositoryRoot, "src/mcp/server.ts")).href)};
import { InMemoryRunStore } from ${JSON.stringify(pathToFileURL(join(repositoryRoot, "src/store/inmemory/index.ts")).href)};
import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(join(repositoryRoot, "node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js")).href)};
const store = new InMemoryRunStore();
const server = createServer({ runStore: store });
await server.connect(new StdioServerTransport());
process.stdin.on('end', async () => { await server.close(); store.close(); });
`
    );
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args:
      surface === "source"
        ? [
            "--import",
            pathToFileURL(join(repositoryRoot, "node_modules/tsx/dist/loader.mjs")).href,
            bootstrap,
          ]
        : [join(repositoryRoot, "mcp-server.mjs")],
    cwd: fixture.startup,
    env: privateEnvironment(fixture),
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk) => {
    diagnostics = (diagnostics + String(chunk)).slice(-32_768);
  });
  const client = new Client({ name: "artifact-readback-adapter-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await transport.close();
    throw new Error(`Owned MCP connection failed: ${String(error)}\n${diagnostics}`);
  }
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<Observation> {
  const response = await client.callTool({ name, arguments: args });
  const content = response.content as Array<{ type?: string; text?: string }>;
  const text = content.find((entry) => entry.type === "text")?.text;
  if (response.isError || !text) throw new Error(text ?? "Missing MCP response text");
  return JSON.parse(text) as Observation;
}

function cli(fixture: CandidateFixture, args: string[]) {
  return spawnSync(
    process.execPath,
    [join(repositoryRoot, "dist/cli.js"), "--no-emit-frames", ...args],
    {
      cwd: fixture.startup,
      env: privateEnvironment(fixture),
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    }
  );
}

function cliJson(fixture: CandidateFixture, args: string[]): Observation {
  const result = cli(fixture, [...args, "--json"]);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Observation;
}

function operationArgs(handle: GateOperationHandle) {
  return [
    "gate",
    "status",
    "--repo-root",
    handle.repoRoot,
    "--operation",
    handle.operationFile,
    "--operation-sha256",
    handle.operationSha256,
  ];
}

function shellQuote(value: string): string {
  return process.platform === "win32"
    ? "'" + value.replaceAll("'", "''") + "'"
    : "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

describe("published CLI/source and published stdio MCP artifact read-back parity", () => {
  it("reads one actual completed operation, preserves defaults, and refuses tampered retained bytes without rerunning or mutating evidence", async () => {
    const fixture = ownedFixture();
    const artifact = join(fixture.root, "produced.json");
    const marker = join(fixture.root, "gate-marker.log");
    const script = join(fixture.root, "produce.cjs");
    writeFileSync(
      script,
      `const fs = require('node:fs');
fs.appendFileSync(process.argv[2], 'executed\\n');
fs.writeFileSync(process.argv[3], JSON.stringify({ complete: true }));
console.log('fixture artifact produced');
`
    );
    const plan = routingPlan();
    plan.items[0]!.gates[0]!.run =
      (process.platform === "win32" ? "& " : "") +
      [process.execPath, script, marker, artifact].map(shellQuote).join(" ");
    plan.items[0]!.gates[0]!.artifacts = [artifact];
    const planFile = join(fixture.a, "plan.json");
    writeFileSync(planFile, JSON.stringify(plan));
    const published = await connectedClient(fixture, "published");
    let source: Client | undefined;
    let retainedPath: string | undefined;
    let retainedBytes: Buffer | undefined;
    try {
      fixture.idempotencyKey = "artifact-parity-operation";
      const started = await call(published, "gates.start", {
        repoRoot: fixture.a,
        planFile,
        outDir: fixture.artifacts,
        idempotencyKey: fixture.idempotencyKey,
        timeoutMs: 10_000,
      });
      expect(started.operation).toBeDefined();
      fixture.handle = started.operation!;
      let completed: Observation | undefined;
      let lastObservation: Observation | undefined;
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        const observed = await call(published, "gates.status", fixture.handle);
        lastObservation = observed;
        if (observed.state === "completed") {
          completed = observed;
          break;
        }
        // Spawn acknowledgement can precede the worker's first retained observation.
        // Observe that exact startup uncertainty within the deadline; never restart it.
        const awaitingFirstObservation =
          observed.state === "unknown" &&
          observed.reason === "No worker observation; do not relaunch" &&
          observed.lastReportedState === undefined &&
          observed.errorCode === undefined;
        if (
          ["failed", "cancelled"].includes(String(observed.state)) ||
          (observed.state === "unknown" && !awaitingFirstObservation)
        )
          throw new Error(`Owned operation could not complete: ${JSON.stringify(observed)}`);
        await delay(50);
      }
      if (!completed)
        throw new Error(
          `Owned operation did not settle within 25000ms: ${JSON.stringify(lastObservation)}`
        );
      expect(completed).toMatchObject({ state: "completed", outcome: "pass" });
      const manifestRef = completed!.result!.artifactRefs.find(
        ({ kind }) => kind === "gate-evidence-manifest"
      )!;
      expect(manifestRef.sha256).toBeDefined();
      const manifest = JSON.parse(readFileSync(manifestRef.path, "utf8")) as {
        entries: Array<{ receipt: { path: string } }>;
      };
      const receiptFile = resolve(dirname(manifestRef.path), manifest.entries[0]!.receipt.path);
      const receipt = JSON.parse(readFileSync(receiptFile, "utf8")) as {
        artifacts: Array<{ status: string; retainedPath: string }>;
      };
      expect(receipt.artifacts).toHaveLength(1);
      expect(receipt.artifacts[0]!.status).toBe("collected");
      retainedPath = receipt.artifacts[0]!.retainedPath;
      retainedBytes = readFileSync(retainedPath);
      const custodyFiles = [
        fixture.handle.operationFile,
        join(dirname(fixture.handle.operationFile), "terminal.json"),
        manifestRef.path,
        receiptFile,
      ];
      const before = custodyFiles.map((file) => hash(readFileSync(file)));
      const integration = {
        repoRoot: fixture.a,
        planFile,
        evidenceFile: manifestRef.path,
        evidenceSha256: manifestRef.sha256!,
      };
      const integrationArgs = [
        "--repo-root",
        fixture.a,
        "--plan",
        planFile,
        "--evidence",
        manifestRef.path,
        "--evidence-sha256",
        manifestRef.sha256!,
      ];
      source = await connectedClient(fixture, "source");
      for (const tampered of [false, true]) {
        if (tampered)
          writeFileSync(retainedPath, Buffer.concat([retainedBytes, Buffer.from("tampered\n")]));
        const expectedStatus = tampered ? "incomplete" : "complete";
        let integrationReport: Report | undefined;
        let operationReport: Report | undefined;
        for (const [client, integrationTool, operationTool] of [
          [published, "status", "gates.status"],
          [source, "weave_status", "gates_status"],
        ] as const) {
          const defaultIntegration = await call(client, integrationTool, integration);
          expect(defaultIntegration.evidence).not.toHaveProperty("artifactVerification");
          expect(
            (await call(client, integrationTool, { ...integration, verifyArtifacts: false }))
              .evidence
          ).toEqual(defaultIntegration.evidence);
          const checkedIntegration = await call(client, integrationTool, {
            ...integration,
            verifyArtifacts: true,
          });
          expect(checkedIntegration).toMatchObject({ mergeSummary: { eligible: [] } });
          expect(checkedIntegration.evidence?.artifactVerification).toMatchObject({
            status: expectedStatus,
            authority: "unverified",
          });
          if (integrationReport)
            expect(checkedIntegration.evidence?.artifactVerification).toEqual(integrationReport);
          integrationReport = checkedIntegration.evidence!.artifactVerification;
          const defaultOperation = await call(client, operationTool, fixture.handle);
          expect(defaultOperation).toMatchObject({
            state: "completed",
            outcome: "pass",
            operation: fixture.handle,
          });
          expect(defaultOperation).not.toHaveProperty("artifactVerification");
          expect(
            await call(client, operationTool, { ...fixture.handle, verifyArtifacts: false })
          ).toEqual(defaultOperation);
          const checkedOperation = await call(client, operationTool, {
            ...fixture.handle,
            verifyArtifacts: true,
          });
          expect(checkedOperation.operation).toEqual(fixture.handle);
          expect(checkedOperation.operation).not.toHaveProperty("verifyArtifacts");
          expect(checkedOperation.artifactVerification).toMatchObject({
            status: expectedStatus,
            authority: "unverified",
          });
          if (operationReport)
            expect(checkedOperation.artifactVerification).toEqual(operationReport);
          operationReport = checkedOperation.artifactVerification;
          if (tampered) {
            expect(checkedOperation).toMatchObject({
              state: "unknown",
              lastReportedState: "completed",
              errorCode: "GATE_OPERATION_ARTIFACTS_INCOMPLETE",
            });
            expect(checkedOperation).not.toHaveProperty("outcome");
            expect(checkedOperation).not.toHaveProperty("result");
          } else expect(checkedOperation).toMatchObject({ state: "completed", outcome: "pass" });
        }
        for (const statusPath of [["status"], ["weave", "status"]]) {
          const defaultStatus = cliJson(fixture, [...statusPath, ...integrationArgs]);
          expect(defaultStatus.evidence).not.toHaveProperty("artifactVerification");
          expect(
            cliJson(fixture, [...statusPath, ...integrationArgs, "--verify-artifacts"]).evidence
              ?.artifactVerification
          ).toEqual(integrationReport);
          const human = cli(fixture, [...statusPath, ...integrationArgs, "--verify-artifacts"]);
          expect(human.status, human.stderr).toBe(0);
          expect(human.stdout).toContain(`Artifact read-back: ${expectedStatus}`);
          expect(human.stdout.indexOf("Evidence:")).toBeLessThan(
            human.stdout.indexOf("Artifact read-back:")
          );
        }
        expect(cliJson(fixture, operationArgs(fixture.handle))).not.toHaveProperty(
          "artifactVerification"
        );
        const gateStatus = cliJson(fixture, [
          ...operationArgs(fixture.handle),
          "--verify-artifacts",
        ]);
        expect(gateStatus.artifactVerification).toEqual(operationReport);
        expect(gateStatus.state).toBe(tampered ? "unknown" : "completed");
      }
      expect(readFileSync(marker, "utf8")).toBe("executed\n");
      expect(custodyFiles.map((file) => hash(readFileSync(file)))).toEqual(before);
      expect(existsSync(join(dirname(fixture.handle.operationFile), "cancel.json"))).toBe(false);
      expect(existsSync(join(fixture.startup, ".smartergpt"))).toBe(false);
    } finally {
      if (retainedPath && retainedBytes) writeFileSync(retainedPath, retainedBytes);
      await source?.close();
      await published.close();
    }
  }, 90_000);

  it.each(["source", "published"] as const)(
    "%s stdio rejects invalid types/missing explicit evidence before IO and keeps start/cancel strict",
    async (surface) => {
      const fixture = ownedFixture();
      const client = await connectedClient(fixture, surface);
      const status = surface === "source" ? "weave_status" : "status";
      const gateStatus = surface === "source" ? "gates_status" : "gates.status";
      const gateStart = surface === "source" ? "gates_start" : "gates.start";
      const gateCancel = surface === "source" ? "gates_cancel" : "gates.cancel";
      const missing = join(fixture.root, "missing-repo");
      const handle = {
        repoRoot: missing,
        operationFile: "missing-operation.json",
        operationSha256: digest,
      };
      const integration = {
        repoRoot: missing,
        planFile: "missing-plan.json",
        evidenceFile: "missing-evidence.json",
        evidenceSha256: digest,
      };
      try {
        const inventory = await client.listTools();
        for (const name of [status, gateStatus]) {
          const schema = inventory.tools.find((tool) => tool.name === name)!.inputSchema;
          expect(schema.properties).toMatchObject({ verifyArtifacts: { type: "boolean" } });
          expect(schema.required ?? []).not.toContain("verifyArtifacts");
        }
        for (const name of [gateStart, gateCancel]) {
          const schema = inventory.tools.find((tool) => tool.name === name)!.inputSchema;
          expect(schema.properties).not.toHaveProperty("verifyArtifacts");
          expect(schema.additionalProperties).toBe(false);
        }
        for (const verifyArtifacts of [null, 0, 1, "true", "false", "", [], {}]) {
          await expect(call(client, status, { ...integration, verifyArtifacts })).rejects.toThrow(
            "verifyArtifacts"
          );
          await expect(call(client, gateStatus, { ...handle, verifyArtifacts })).rejects.toThrow(
            "verifyArtifacts"
          );
        }
        await expect(
          call(client, status, {
            repoRoot: missing,
            planFile: "missing-plan",
            verifyArtifacts: true,
          })
        ).rejects.toThrow("verifyArtifacts requires explicit evidenceFile and evidenceSha256");
        for (const verifyArtifacts of [false, true]) {
          await expect(call(client, gateCancel, { ...handle, verifyArtifacts })).rejects.toThrow(
            "verifyArtifacts"
          );
          await expect(
            call(client, gateStart, {
              repoRoot: missing,
              planFile: "missing-plan",
              outDir: fixture.artifacts,
              idempotencyKey: "must-not-admit",
              verifyArtifacts,
            })
          ).rejects.toThrow("verifyArtifacts");
        }
        const planFile = join(fixture.root, "evidence-free-plan.json");
        writeFileSync(planFile, JSON.stringify(routingPlan()));
        const omitted = await call(client, status, { planFile });
        expect(omitted).not.toHaveProperty("evidence");
        const explicitlyFalse = await call(client, status, { planFile, verifyArtifacts: false });
        expect(explicitlyFalse).not.toHaveProperty("evidence");
        expect(explicitlyFalse).toMatchObject({
          plan: (omitted as unknown as { plan: unknown }).plan,
        });
        expect(
          existsSync(
            join(
              fixture.artifacts,
              "gate-operation-" + createHash("sha256").update("must-not-admit").digest("hex")
            )
          )
        ).toBe(false);
      } finally {
        await client.close();
      }
    },
    45_000
  );

  it("published CLI accepts only status opt-ins and rejects missing evidence before missing repo/plan IO", () => {
    const fixture = ownedFixture();
    const missing = join(fixture.root, "missing-repo");
    for (const statusPath of [["status"], ["weave", "status"]]) {
      const absent = cli(fixture, [
        ...statusPath,
        "--repo-root",
        missing,
        "--plan",
        "missing-plan",
        "--verify-artifacts",
        "--json",
      ]);
      expect(absent.status).toBe(1);
      expect(absent.stderr).toContain(
        "--verify-artifacts requires explicit --evidence and --evidence-sha256"
      );
      const invalid = cli(fixture, [...statusPath, "--verify-artifacts=false"]);
      expect(invalid.status).not.toBe(0);
    }
    for (const name of ["start", "cancel"]) {
      const help = cli(fixture, ["gate", name, "--help"]);
      expect(help.status).toBe(0);
      expect(help.stdout).not.toContain("--verify-artifacts");
      const requiredArguments =
        name === "start"
          ? [
              "--repo-root",
              missing,
              "--plan",
              "missing-plan",
              "--out",
              fixture.artifacts,
              "--idempotency-key",
              "must-not-admit-cli",
            ]
          : [
              "--repo-root",
              missing,
              "--operation",
              "missing-operation",
              "--operation-sha256",
              digest,
            ];
      const refused = cli(fixture, ["gate", name, ...requiredArguments, "--verify-artifacts"]);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("unknown option '--verify-artifacts'");
    }
    expect(cli(fixture, ["gate", "status", "--help"]).stdout).toContain("--verify-artifacts");
  }, 30_000);
});
