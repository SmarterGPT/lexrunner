import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceDoctorArgsJsonSchema } from "../src/application/workspace-config-services.js";
import { createServer } from "../src/mcp/server.js";
import { InMemoryRunStore } from "../src/store/inmemory/index.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeFixtureRoot(root)));
});

describe("published MCP workspace/config parity", () => {
  it("shares deterministic non-interactive initialization across CLI and MCP", async () => {
    const cliRoot = fixtureRoot();
    const mcpRoot = fixtureRoot();
    for (const root of [cliRoot, mcpRoot]) {
      fs.mkdirSync(path.join(root, ".smartergpt"), { recursive: true });
      fs.writeFileSync(path.join(root, ".smartergpt", "scope.yml"), "version: 1\ntarget: main\n");
    }

    const cli = JSON.parse(
      (
        await execa(
          "node",
          [
            path.join(repositoryRoot, "dist", "cli.js"),
            "workspace",
            "init",
            "--non-interactive",
            "--json",
          ],
          { cwd: cliRoot }
        )
      ).stdout
    ).data;
    const mcp = await invoke(mcpRoot, {
      id: 10,
      method: "tools/call",
      params: { name: "local.init", arguments: {} },
    });
    const mcpResult = JSON.parse(mcp.result.content[0].text);
    const { path: _cliPath, ...cliComparable } = cli;
    const { path: _mcpPath, ...mcpComparable } = mcpResult;

    expect(mcpComparable).toEqual(cliComparable);
    expect(mcpResult.contract).toBe("bounded-ax-v1");
  });

  it("preserves protected-write failures across CLI and MCP adapters", async () => {
    const root = fixtureRoot();
    const profile = path.join(root, ".smartergpt.local");
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, "profile.yml"), "role: example\nname: Protected\n");
    fs.writeFileSync(path.join(profile, "gates.yml"), "AUTHORED-GATES-SENTINEL\n");

    const cli = await execa(
      "node",
      [
        path.join(repositoryRoot, "dist", "cli.js"),
        "workspace",
        "init",
        "--non-interactive",
        "--json",
      ],
      { cwd: root, reject: false }
    );
    const published = await invoke(root, {
      id: 11,
      method: "tools/call",
      params: { name: "local.init", arguments: {} },
    });
    const source = await withoutProfileEnvironment(() => invokeSourceLocalInitError(root));
    const publishedError = normalizeMcpError(published.error);
    const cliError = JSON.parse(cli.stdout).error;

    expect(cli.exitCode).toBe(2);
    expect(JSON.parse(cli.stdout)).toMatchObject({
      success: false,
      error: { code: "EWRITE_PROTECTED" },
    });
    expect(source).toEqual(publishedError);
    expect(source).toEqual({
      protocolCode: -32602,
      code: "WRITE_PROTECTION_ERROR",
      message: cliError.message,
      data: null,
      actions: [
        "Use a local overlay profile (.smartergpt.local/) for write operations",
        "Set role to 'local' or 'ci' in profile.yml",
        "Run 'local.init' to create a writable profile",
      ],
      context: { operation: "local.init" },
    });
    expect(fs.readFileSync(path.join(profile, "gates.yml"), "utf8")).toBe(
      "AUTHORED-GATES-SENTINEL\n"
    );
  });

  it("rejects missing and invalid workflow phases identically across MCP entrypoints", async () => {
    const root = fixtureRoot();
    const invalidArguments = [{}, { phase: "not-a-phase" }];
    const responses = await invokeMany(root, [
      {
        id: 12,
        method: "tools/call",
        params: { name: "workflow.guide", arguments: {} },
      },
      {
        id: 13,
        method: "tools/call",
        params: { name: "workflow.guide", arguments: { phase: "not-a-phase" } },
      },
    ]);

    for (const [index, response] of responses.entries()) {
      const error = normalizeMcpError(response.error);
      const source = await invokeSourceToolError(root, "workflow_guide", invalidArguments[index]);
      expect(source).toEqual(error);
      expect(error).toMatchObject({
        protocolCode: -32602,
        code: "WORKFLOW_GUIDE_ARGUMENTS_INVALID",
        context: { operation: "workflow.guide" },
      });
      expect(error.message).toContain("published phase values");
      expect(JSON.stringify(error)).not.toContain("Cannot read properties");
      expect(JSON.stringify(error)).not.toContain("not-a-phase");
    }
  });

  it("routes CLI and MCP configuration queries through the same bounded result", async () => {
    const root = fixtureRoot();
    fs.mkdirSync(path.join(root, ".smartergpt"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".smartergpt", "scope.yml"),
      "version: 1\ntarget: main\ncredentials:\n  token: never-print-this\n"
    );

    const cli = JSON.parse(
      (
        await execa(
          "node",
          [path.join(repositoryRoot, "dist", "cli.js"), "config", "show", "--json"],
          {
            cwd: root,
          }
        )
      ).stdout
    );
    const mcp = await invoke(root, {
      id: 1,
      method: "tools/call",
      params: { name: "config.show", arguments: {} },
    });
    const mcpResult = JSON.parse(mcp.result.content[0].text);

    expect(mcpResult).toEqual(cli);
    expect(mcpResult.contract).toBe("bounded-ax-v1");
    expect(JSON.stringify(mcpResult)).not.toContain("never-print-this");
  });

  it("publishes the health removal window and delegates compatibility output to doctor", async () => {
    const root = fixtureRoot();
    fs.writeFileSync(path.join(root, ".nvmrc"), `${process.versions.node.split(".")[0]}\n`);
    const tools = await invoke(root, { id: 2, method: "tools/list", params: {} });
    const healthTool = tools.result.tools.find((tool: { name: string }) => tool.name === "health");
    expect(healthTool.description).toContain("DEPRECATED: use doctor");
    expect(healthTool.description).toContain("3.0.0");

    const doctor = await invoke(root, {
      id: 3,
      method: "tools/call",
      params: { name: "doctor", arguments: {} },
    });
    const health = await invoke(root, {
      id: 4,
      method: "tools/call",
      params: { name: "health", arguments: {} },
    });
    const doctorResult = JSON.parse(doctor.result.content[0].text);
    const healthResult = JSON.parse(health.result.content[0].text);

    expect(doctorResult.contract).toBe("bounded-ax-v1");
    expect(healthResult).toMatchObject(doctorResult);
    expect(healthResult.deprecation).toEqual({
      tool: "health",
      replacement: "doctor",
      removeIn: "3.0.0",
    });
  });

  it("shares one strict doctor contract and binds diagnostics to server startup", async () => {
    const startupRoot = fixtureRoot();
    const laterRoot = fixtureRoot();
    prepareDiagnosticRoot(startupRoot, "startup");
    prepareDiagnosticRoot(laterRoot, "later");
    fs.writeFileSync(path.join(startupRoot, ".smartergpt", "scope.yml"), "version: 1\n");
    fs.writeFileSync(path.join(laterRoot, "AGENTS.md"), "# Later root only\n");
    const bootstrap = path.join(startupRoot, "doctor-server-bootstrap.mjs");
    fs.writeFileSync(
      bootstrap,
      `await import(${JSON.stringify(pathToFileURL(path.join(repositoryRoot, "mcp-server.mjs")).href)});\nprocess.chdir(${JSON.stringify(laterRoot)});\n`
    );

    await withoutProfileEnvironment(async () => {
      const controlArguments = [undefined, {}, { environmentQuality: true }];
      const invalidArguments = [
        { repoRoot: laterRoot },
        { environmentQuality: "true" },
        JSON.parse('{"__proto__":"never-print-this"}'),
      ];
      const publishedResponses = await invokeMany(
        startupRoot,
        [
          { id: 20, method: "tools/list", params: {} },
          ...controlArguments.map((arguments_, index) => ({
            id: 21 + index,
            method: "tools/call",
            params: {
              name: "doctor",
              ...(arguments_ === undefined ? {} : { arguments: arguments_ }),
            },
          })),
          ...invalidArguments.map((arguments_, index) => ({
            id: 24 + index,
            method: "tools/call",
            params: { name: "doctor", arguments: arguments_ },
          })),
        ],
        bootstrap
      );
      const [publishedTools, ...publishedCalls] = publishedResponses;
      const publishedDoctor = publishedTools.result.tools.find(
        (tool: { name: string }) => tool.name === "doctor"
      );
      expect(publishedDoctor.inputSchema).toEqual(WorkspaceDoctorArgsJsonSchema);

      for (const [index, arguments_] of controlArguments.entries()) {
        const published = publishedCalls[index];
        const result = JSON.parse(published.result.content[0].text);
        expect(result).toMatchObject({
          diagnosticBase: path.resolve(startupRoot),
          configuration: { profileDir: path.join(startupRoot, ".smartergpt") },
        });
        assertEnvironmentQualityRoot(result, arguments_);
      }

      for (const [index] of invalidArguments.entries()) {
        const response = publishedCalls[controlArguments.length + index];
        expect(response.error.code).toBe(-32602);
        expect(JSON.parse(response.error.message)).toMatchObject({
          code: "WORKSPACE_DIAGNOSTICS_ARGUMENTS_INVALID",
          context: { tool: "doctor" },
        });
        expect(response.error.message).not.toContain("never-print-this");
      }

      const previousCwd = process.cwd();
      let server;
      try {
        process.chdir(startupRoot);
        server = createServer({ runStore: new InMemoryRunStore() });
      } finally {
        process.chdir(previousCwd);
      }
      const client = new Client({ name: "doctor-contract-test", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        process.chdir(laterRoot);

        const sourceTools = await client.listTools();
        expect(sourceTools.tools.find((tool) => tool.name === "doctor")?.inputSchema).toEqual(
          WorkspaceDoctorArgsJsonSchema
        );

        for (const arguments_ of [undefined, {}, { environmentQuality: true }]) {
          const response = await client.callTool({
            name: "doctor",
            ...(arguments_ === undefined ? {} : { arguments: arguments_ }),
          });
          const result = JSON.parse((response.content[0] as { text: string }).text);
          expect(result).toMatchObject({
            diagnosticBase: path.resolve(startupRoot),
            configuration: { profileDir: path.join(startupRoot, ".smartergpt") },
          });
          assertEnvironmentQualityRoot(result, arguments_);
        }

        // The SDK client drops an own __proto__ key before transport; the raw
        // standalone transport and shared parser cover that JSON-specific case.
        for (const arguments_ of [{ repoRoot: laterRoot }, { environmentQuality: "true" }]) {
          await expect(
            client.callTool({ name: "doctor", arguments: arguments_ })
          ).rejects.toMatchObject({
            code: -32602,
            message: expect.stringContaining("WORKSPACE_DIAGNOSTICS_ARGUMENTS_INVALID"),
          });
        }

        const initialGuideResponse = await client.callTool({
          name: "workflow_guide",
          arguments: { phase: "initial" },
        });
        const initialGuide = JSON.parse((initialGuideResponse.content[0] as { text: string }).text);
        expect(initialGuide).toMatchObject({
          authority: "advisory",
          authorizesExecution: false,
          authorizesMerge: false,
          phase: "initial",
          canProceed: false,
          recommendedAction: "local.init",
          readiness: { source: "doctor", hasErrors: true },
        });
        expect(initialGuide.readiness.suggestions.join(" ")).toContain(startupRoot);
        expect(initialGuide.readiness.suggestions.join(" ")).not.toContain(laterRoot);

        const laterGuideResponse = await client.callTool({
          name: "workflow_guide",
          arguments: { phase: "post-plan-creation" },
        });
        const laterGuide = JSON.parse((laterGuideResponse.content[0] as { text: string }).text);
        expect(laterGuide).toMatchObject({
          authority: "advisory",
          authorizesExecution: false,
          authorizesMerge: false,
          phase: "post-plan-creation",
          canProceed: true,
          recommendedAction: "gates.run",
        });
        expect(laterGuide).not.toHaveProperty("readiness");
      } finally {
        process.chdir(previousCwd);
        await client.close();
        await server.close();
      }
    });
  });

  it("maps shared service failures to stable bounded AX errors", async () => {
    const response = await invoke(fixtureRoot(), {
      id: 5,
      method: "tools/call",
      params: { name: "config.show", arguments: { key: "missing.key" } },
    });
    const error = JSON.parse(response.error.message);

    expect(error).toMatchObject({
      code: "CONFIG_KEY_NOT_FOUND",
      context: { tool: "config.show" },
    });
    expect(error.nextActions.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(response.error.message, "utf8")).toBeLessThan(4096);
  });
});

interface JsonRpcResponse {
  result: any;
  error: any;
}

interface NormalizedMcpError {
  protocolCode: number;
  code: string;
  message: string;
  data: unknown;
  actions: string[];
  context: Record<string, unknown>;
}

async function invokeSourceLocalInitError(cwd: string): Promise<NormalizedMcpError> {
  return invokeSourceToolError(cwd, "local_init", {});
}

async function invokeSourceToolError(
  cwd: string,
  name: string,
  args: Record<string, unknown>
): Promise<NormalizedMcpError> {
  const previousCwd = process.cwd();
  let server;
  let client: Client | undefined;
  let captured: unknown;
  try {
    process.chdir(cwd);
    server = createServer({ runStore: new InMemoryRunStore() });
    client = new Client({ name: "workspace-config-parity-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      await client.callTool({ name, arguments: args });
    } catch (error) {
      captured = error;
    }
  } finally {
    try {
      if (client) await client.close();
      if (server) await server.close();
    } finally {
      process.chdir(previousCwd);
    }
  }

  if (!captured) throw new Error(`Expected source ${name} to reject invalid arguments`);
  return normalizeMcpError(captured);
}

function normalizeMcpError(error: unknown): NormalizedMcpError {
  if (
    error === null ||
    typeof error !== "object" ||
    !("code" in error) ||
    typeof error.code !== "number" ||
    !("message" in error) ||
    typeof error.message !== "string"
  ) {
    throw new Error("Expected a structured MCP error");
  }
  const envelopeStart = error.message.indexOf("{");
  if (envelopeStart < 0) throw new Error("Expected an AXError JSON envelope in the MCP error");
  const envelope = JSON.parse(error.message.slice(envelopeStart)) as {
    code: string;
    message: string;
    context: Record<string, unknown>;
    nextActions: string[];
  };
  return {
    protocolCode: error.code,
    code: envelope.code,
    message: envelope.message,
    data: ("data" in error ? error.data : undefined) ?? null,
    actions: envelope.nextActions,
    context: envelope.context,
  };
}

async function invoke(
  cwd: string,
  request: { id: number; method: string; params: Record<string, unknown> },
  entrypoint = path.join(repositoryRoot, "mcp-server.mjs")
): Promise<JsonRpcResponse> {
  return (await invokeMany(cwd, [request], entrypoint))[0];
}

async function invokeMany(
  cwd: string,
  requests: Array<{ id: number; method: string; params: Record<string, unknown> }>,
  entrypoint = path.join(repositoryRoot, "mcp-server.mjs")
): Promise<JsonRpcResponse[]> {
  const subprocess = execa("node", [entrypoint], {
    cwd,
    env: { ...process.env, ALLOW_MUTATIONS: "false" },
  });
  let stdout = "";
  const responses: JsonRpcResponse[] = [];
  const complete = new Promise<JsonRpcResponse[]>((resolve, reject) => {
    subprocess.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      let newline = stdout.indexOf("\n");
      while (newline >= 0) {
        responses.push(JSON.parse(stdout.slice(0, newline)) as JsonRpcResponse);
        stdout = stdout.slice(newline + 1);
        if (responses.length === requests.length) resolve(responses);
        newline = stdout.indexOf("\n");
      }
    });
    subprocess.once("error", reject);
    subprocess.once("exit", (code) => {
      if (responses.length !== requests.length) {
        reject(
          new Error(
            `MCP server exited ${code ?? "without a code"} after ${responses.length}/${requests.length} responses`
          )
        );
      }
    });
  });
  subprocess.stdin?.write(
    requests.map((request) => JSON.stringify({ jsonrpc: "2.0", ...request })).join("\n") + "\n"
  );
  const result = await complete;
  subprocess.stdin?.end();
  await subprocess;
  return result;
}

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lexrunner-mcp-workspace-"));
  roots.push(root);
  return root;
}

async function removeFixtureRoot(root: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.promises.rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 30 || (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY")) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function prepareDiagnosticRoot(root: string, role: string): void {
  const profile = path.join(root, ".smartergpt");
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, "profile.yml"), `role: ${role}\n`);
  fs.writeFileSync(path.join(root, ".nvmrc"), `${process.versions.node.split(".")[0]}\n`);
}

function assertEnvironmentQualityRoot(
  result: Record<string, any>,
  arguments_: undefined | Record<string, unknown>
): void {
  if (arguments_?.environmentQuality === true) {
    expect(result.environmentQuality.components.constraintClarity.details).toBe(
      "No constraint files found"
    );
    expect(result.environmentQuality.components.requirementExplicitness.details).toBe(
      "Scope files found but no valid plan.json"
    );
  } else {
    expect(result).not.toHaveProperty("environmentQuality");
  }
}

async function withoutProfileEnvironment<T>(operation: () => Promise<T>): Promise<T> {
  const previousPrimary = process.env.LEX_PR_PROFILE_DIR;
  const previousAlias = process.env.LEXRUNNER_PROFILE_DIR;
  delete process.env.LEX_PR_PROFILE_DIR;
  delete process.env.LEXRUNNER_PROFILE_DIR;
  try {
    return await operation();
  } finally {
    if (previousPrimary === undefined) delete process.env.LEX_PR_PROFILE_DIR;
    else process.env.LEX_PR_PROFILE_DIR = previousPrimary;
    if (previousAlias === undefined) delete process.env.LEXRUNNER_PROFILE_DIR;
    else process.env.LEXRUNNER_PROFILE_DIR = previousAlias;
  }
}
