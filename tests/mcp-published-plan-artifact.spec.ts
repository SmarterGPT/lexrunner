import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const mcpPath = join(repositoryRoot, "mcp-server.mjs");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  );
});

describe("published plan artifact parity", () => {
  it("advertises and consumes one explicit repository plan across every integration tool", async () => {
    const root = await fixtureRepository();
    const planPath = join(root, "plan.json");
    const env = { LEX_PR_PROFILE_DIR: join(root, "profile"), ALLOW_MUTATIONS: "false" };

    const inventory = await invokeMcp(root, env, "tools/list");
    const planCreateTool = inventory.result.tools.find(
      (candidate: { name: string }) => candidate.name === "plan.create"
    );
    expect(planCreateTool.description).toContain("GITHUB_TOKEN");
    expect(planCreateTool.inputSchema.properties).toMatchObject({
      repoRoot: { type: "string", minLength: 1, maxLength: 4096 },
      profileDir: { type: "string", minLength: 1, maxLength: 4096 },
    });
    expect(planCreateTool.inputSchema.properties.repos).toBeUndefined();
    for (const name of ["status", "merge-order", "gates.run", "merge.apply"]) {
      const tool = inventory.result.tools.find(
        (candidate: { name: string }) => candidate.name === name
      );
      expect(tool?.inputSchema.properties.planFile).toMatchObject({ type: "string" });
    }
    const statusTool = inventory.result.tools.find(
      (candidate: { name: string }) => candidate.name === "status"
    );
    expect(statusTool.inputSchema.properties).toMatchObject({
      evidenceFile: { type: "string", minLength: 1, maxLength: 4096 },
      evidenceSha256: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    });
    const gatesTool = inventory.result.tools.find(
      (candidate: { name: string }) => candidate.name === "gates.run"
    );
    expect(gatesTool.inputSchema.properties).toMatchObject({ timeoutMs: { type: "integer" } });

    const calls = [
      ["status", { planFile: planPath }],
      ["merge-order", { planFile: planPath }],
      ["merge.apply", { planFile: planPath, dryRun: true }],
      [
        "gates.run",
        {
          planFile: planPath,
          onlyItem: "selected",
          outDir: join(root, "gate-artifacts"),
        },
      ],
    ] as const;
    const results: Record<string, any> = {};
    for (const [name, args] of calls) {
      const response = await invokeMcp(root, env, "tools/call", {
        name,
        arguments: args,
      });
      expect(response.error).toBeUndefined();
      expect(response, name).toHaveProperty("result.content");
      results[name] = JSON.parse(response.result.content[0].text);
    }

    expect(results.status.plan.itemCount).toBe(2);
    expect(results["merge-order"].levels.flat()).toEqual(["selected", "unselected"]);
    expect(results["merge.apply"]).toMatchObject({ mode: "dry-run", totalItems: 2 });
    expect(results["gates.run"]).toMatchObject({
      items: [
        {
          name: "selected",
          status: "pass",
          gates: [{ name: "selected-gate", status: "pass" }],
        },
      ],
      allGreen: true,
    });
    expect(results.status.mergeSummary.pending).toEqual(["selected", "unselected"]);
    const evidence = results["gates.run"].artifactRefs.find(
      ({ kind }: { kind: string }) => kind === "gate-evidence-manifest"
    );
    const evidenceResponse = await invokeMcp(root, env, "tools/call", {
      name: "status",
      arguments: {
        planFile: planPath,
        evidenceFile: evidence.path,
        evidenceSha256: evidence.sha256,
      },
    });
    const evidenceStatus = JSON.parse(evidenceResponse.result.content[0].text);
    expect(evidenceStatus).toMatchObject({
      evidence: {
        kind: "gate-evidence-manifest",
        applied: 1,
        authority: "unverified",
        observations: { passed: ["selected/selected-gate"], failed: [], other: [] },
      },
      mergeSummary: { eligible: [], pending: ["selected", "unselected"], failed: [] },
    });

    const identities = calls.map(([name]) => results[name].planArtifact);
    expect(
      identities.every((identity) => JSON.stringify(identity) === JSON.stringify(identities[0]))
    ).toBe(true);
    expect(identities[0]).toMatchObject({
      contract: "plan-artifact-identity-v1",
      kind: "execution-plan",
      schema: "lexrunner.execution-plan",
      itemCount: 2,
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
  }, 15_000);

  it("creates configuration plans through the shared non-authorizing routing contract", async () => {
    const root = await fixtureRepository();
    const response = await invokeMcp(
      root,
      { LEX_PR_PROFILE_DIR: join(root, "profile"), ALLOW_MUTATIONS: "false" },
      "tools/call",
      {
        name: "plan.create",
        arguments: { outDir: join(root, "generated") },
      }
    );
    expect(response.error).toBeUndefined();
    const result = JSON.parse(response.result.content[0].text);
    expect(result).toMatchObject({
      contract: "bounded-ax-v1",
      routing: {
        contract: "lexrunner-plan-routing-v1",
        authority: "unverified",
        authorizesExecution: false,
        authorizesMerge: false,
        resolvedRepository: { root },
        profile: { root: join(root, "profile"), precedence: "environment-or-local" },
        output: { root: join(root, "generated"), source: "explicit" },
        gate: { cwd: ".", repositoryRoot: root },
      },
      files: {
        plan: join(root, "generated", "plan.json"),
        snapshot: join(root, "generated", "snapshot.md"),
        routingReceipt: join(root, "generated", "routing-receipt.json"),
      },
    });
  });

  it("resolves a relative gate plan from the explicit repository root", async () => {
    const startup = await fixtureRepository();
    const target = await fixtureRepository();
    await writeFile(
      join(target, "plan.json"),
      `${JSON.stringify(
        {
          schemaVersion: "1.0.0",
          target: "main",
          items: [
            {
              name: "target-only",
              deps: [],
              gates: [
                {
                  name: "target-gate",
                  run: 'node -e "process.exit(0)"',
                  cwd: ".",
                  env: {},
                },
              ],
            },
          ],
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const response = await invokeMcp(
      startup,
      { LEX_PR_PROFILE_DIR: join(startup, "profile"), ALLOW_MUTATIONS: "false" },
      "tools/call",
      {
        name: "gates.run",
        arguments: {
          repoRoot: target,
          planFile: "plan.json",
          onlyItem: "target-only",
          outDir: "target-gates",
        },
      }
    );
    expect(response.error).toBeUndefined();
    expect(JSON.parse(response.result.content[0].text)).toMatchObject({
      items: [{ name: "target-only", status: "pass" }],
      allGreen: true,
    });
  });

  it("maps bounded plan routing failures to invalid MCP parameters", async () => {
    const root = await fixtureRepository();
    const response = await invokeMcp(
      root,
      { LEX_PR_PROFILE_DIR: join(root, "profile"), ALLOW_MUTATIONS: "false" },
      "tools/call",
      {
        name: "plan.create",
        arguments: { owner: "SmarterGPT" },
      }
    );

    expect(response.error.code).toBe(-32602);
    expect(JSON.parse(response.error.message)).toMatchObject({
      code: "PLAN_CREATION_ARGUMENTS_INVALID",
      context: { tool: "plan.create" },
    });
    expect(Buffer.byteLength(response.error.message, "utf8")).toBeLessThan(4_096);
  });

  it("returns stable privacy-safe errors for bad explicit published references", async () => {
    const root = await fixtureRepository();
    const env = { LEX_PR_PROFILE_DIR: join(root, "profile"), ALLOW_MUTATIONS: "false" };
    await mkdir(join(root, "private-unreadable-plan"));
    await writeFile(join(root, "private-malformed-plan.json"), '{"secret":"TOPSECRET"', "utf8");
    await writeFile(
      join(root, "private-invalid-plan.json"),
      JSON.stringify({ schemaVersion: "1.0.0", target: "main", items: "TOPSECRET" }),
      "utf8"
    );

    for (const [reference, code] of [
      ["private-missing-plan.json", "PLAN_NOT_FOUND"],
      ["private-unreadable-plan", "PLAN_UNREADABLE"],
    ] as const) {
      const response = await invokeMcp(root, env, "tools/call", {
        name: "status",
        arguments: { planFile: join(root, reference) },
      });
      const failure = JSON.parse(response.error.message);
      expect(failure).toMatchObject({
        code,
        context: { tool: "status", operation: "resolve plan artifact", source: "explicit" },
      });
      expect(response.error.message).not.toContain(root);
      expect(response.error.message).not.toContain(reference);
      expect(Buffer.byteLength(response.error.message, "utf8")).toBeLessThan(4_096);
    }

    for (const [reference, code] of [
      ["private-malformed-plan.json", "CONFIG_INVALID"],
      ["private-invalid-plan.json", "PLAN_VALIDATION_FAILED"],
    ] as const) {
      const response = await invokeMcp(root, env, "tools/call", {
        name: "status",
        arguments: { planFile: join(root, reference) },
      });
      const failure = JSON.parse(response.result.content[0].text);
      expect(failure).toMatchObject({ contract: "bounded-ax-v1", valid: false, code });
      expect(JSON.stringify(failure)).not.toContain("TOPSECRET");
      expect(JSON.stringify(failure)).not.toContain(root);
    }
  });

  it("retains the profile runner plan as the final fallback", async () => {
    const root = await fixtureRepository({ writeRootPlan: false });
    const response = await invokeMcp(
      root,
      { LEX_PR_PROFILE_DIR: join(root, "profile"), ALLOW_MUTATIONS: "false" },
      "tools/call",
      { name: "merge-order", arguments: {} }
    );
    const result = JSON.parse(response.result.content[0].text);

    expect(result.levels).toEqual([["profile-only"]]);
    expect(result.planArtifact.itemCount).toBe(1);
  });
});

async function fixtureRepository(options: { writeRootPlan?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lexrunner-published-plan-"));
  roots.push(root);
  const profile = join(root, "profile");
  await mkdir(join(profile, "runner"), { recursive: true });
  await writeFile(join(profile, "profile.yml"), "role: local\n", "utf8");
  await writeFile(
    join(profile, "runner", "plan.json"),
    `${JSON.stringify(profilePlan(), null, 2)}\n`,
    "utf8"
  );
  if (options.writeRootPlan !== false) {
    await writeFile(join(root, "plan.json"), `${JSON.stringify(rootPlan(), null, 2)}\n`, "utf8");
  }
  await execa("git", ["init", "-b", "main"], { cwd: root });
  await execa("git", ["add", "."], { cwd: root });
  await execa(
    "git",
    [
      "-c",
      "user.name=LexRunner Test",
      "-c",
      "user.email=lexrunner@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "fixture",
    ],
    { cwd: root }
  );
  return root;
}

function rootPlan() {
  return {
    schemaVersion: "1.0.0",
    target: "main",
    items: [
      {
        name: "selected",
        deps: [],
        gates: [
          {
            name: "selected-gate",
            run: 'node -e "process.exit(0)"',
            env: {},
          },
        ],
      },
      {
        name: "unselected",
        deps: [],
        gates: [
          {
            name: "unselected-gate",
            run: 'node -e "process.exit(1)"',
            env: {},
          },
        ],
      },
    ],
  };
}

function profilePlan() {
  return {
    schemaVersion: "1.0.0",
    target: "main",
    items: [
      {
        name: "profile-only",
        deps: [],
        gates: [
          {
            name: "profile-gate",
            run: "node -e \"require('node:fs').writeFileSync('profile.marker','yes')\"",
            env: {},
          },
        ],
      },
    ],
  };
}

async function invokeMcp(
  root: string,
  environment: Record<string, string>,
  method: "tools/list" | "tools/call",
  params?: object
): Promise<any> {
  const subprocess = execa("node", [mcpPath], {
    cwd: root,
    env: { ...process.env, ...environment },
  });
  let stdout = "";
  const response = new Promise<any>((resolveResponse, rejectResponse) => {
    subprocess.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf("\n");
      if (newline >= 0) resolveResponse(JSON.parse(stdout.slice(0, newline)));
    });
    subprocess.once("error", rejectResponse);
  });
  subprocess.stdin?.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      ...(params ? { params } : {}),
    })}\n`
  );
  const result = await response;
  subprocess.stdin?.end();
  await subprocess;
  return result;
}
