import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PlanArtifactService,
  PlanArtifactServiceError,
} from "../../src/application/plan-artifact-service.js";
import {
  ExecutionPlanArtifact_v1Schema,
  PlanArtifactReference_v1Schema,
  computeExecutionPlanArtifactDigest,
} from "../../src/application/execution-plan-artifact.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PlanArtifactService", () => {
  it("retains frozen Git inputs in canonical bytes and binds their identity", async () => {
    const root = await fixtureRoot();
    const original = {
      ...plan("bound"),
      schemaVersion: "1.0.1",
      gitInputs: {
        schemaVersion: "1.0.0",
        repository: "https://github.com/example/repo.git",
        checkoutRemote: "origin",
        acquisition: "local-only",
        target: { ref: "refs/heads/main", commit: "a".repeat(40) },
        sources: [{ item: "bound", ref: "refs/pull/123/head", commit: "b".repeat(40) }],
      },
    };
    await writePlan(join(root, "plan.json"), original);
    const service = new PlanArtifactService();
    const first = service.resolve({ workingDir: root });
    expect(first.plan.gitInputs).toEqual(original.gitInputs);
    expect(JSON.parse(first.artifact.canonicalBytes).gitInputs).toEqual(original.gitInputs);
    const changed = structuredClone(original);
    changed.gitInputs.sources[0].commit = "c".repeat(40);
    await writePlan(join(root, "plan.json"), changed);
    const second = service.resolve({ workingDir: root });
    expect(second.identity.digest).not.toBe(first.identity.digest);
    expect(second.artifact.identity.digest).not.toBe(first.artifact.identity.digest);
  });
  it("resolves explicit, repository-root, and profile plans in deterministic precedence order", async () => {
    const root = await fixtureRoot();
    const profile = join(root, "profile");
    await mkdir(join(profile, "runner"), { recursive: true });
    await writeFile(join(profile, "profile.yml"), "role: local\n", "utf8");
    await writePlan(join(profile, "runner", "plan.json"), plan("profile"));
    await writePlan(join(root, "plan.json"), plan("root"));
    await writePlan(join(root, "explicit.json"), plan("explicit"));

    const service = new PlanArtifactService();
    expect(service.resolve({ workingDir: root, profileDir: profile }).source).toBe(
      "repository-root"
    );
    expect(
      service.resolve({ planFile: "explicit.json", workingDir: root, profileDir: profile }).plan
        .items[0].name
    ).toBe("explicit");

    await rm(join(root, "plan.json"));
    expect(service.resolve({ workingDir: root, profileDir: profile }).source).toBe(
      "profile-runner"
    );
    expect(() =>
      service.resolve({
        workingDir: root,
        profileDir: profile,
        allowProfileFallback: false,
      })
    ).toThrowError(
      expect.objectContaining<Partial<PlanArtifactServiceError>>({ code: "PLAN_NOT_FOUND" })
    );
  });

  it("computes a path-independent canonical identity across JSON formatting", async () => {
    const root = await fixtureRoot();
    const first = join(root, "first.json");
    const second = join(root, "second.json");
    const value = plan("same");
    await writeFile(first, JSON.stringify(value), "utf8");
    await writeFile(second, `${JSON.stringify(value, null, 2)}\n`, "utf8");

    const service = new PlanArtifactService();
    const firstArtifact = service.resolve({ planFile: first, workingDir: root });
    const secondArtifact = service.resolve({ planFile: second, workingDir: root });

    expect(firstArtifact.identity).toEqual(secondArtifact.identity);
    expect(firstArtifact.identity).toMatchObject({
      contract: "plan-artifact-identity-v1",
      kind: "execution-plan",
      schema: "lexrunner.execution-plan",
      schemaVersion: "1.0.0",
      target: "main",
      itemCount: 1,
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(firstArtifact.identity)).not.toContain(root);
    expect(firstArtifact.artifact).toEqual(secondArtifact.artifact);
    expect(ExecutionPlanArtifact_v1Schema.safeParse(firstArtifact.artifact).success).toBe(true);
    expect(PlanArtifactReference_v1Schema.safeParse(firstArtifact.reference).success).toBe(true);
    expect(firstArtifact.artifact.identity).toMatchObject({
      contract: "lexrunner.execution-plan-artifact.v1",
      canonicalizationProfile: "lexrunner.execution-plan.canonical-json.v1",
      hashProfile: "lexrunner.execution-plan-artifact.sha256.v1",
      digestAlgorithm: "sha256",
      canonicalByteLength: Buffer.byteLength(firstArtifact.artifact.canonicalBytes, "utf8"),
      summary: { itemCount: 1, gateCount: 0 },
    });
    expect(firstArtifact.artifact.identity.digest).not.toBe(firstArtifact.identity.digest);
  });

  it("keeps portable content identity separate from registration scope", async () => {
    const root = await fixtureRoot();
    await writePlan(join(root, "plan.json"), plan("scoped"));
    const service = new PlanArtifactService();
    const first = service.resolve({
      planFile: "plan.json",
      workingDir: root,
      scope: scope("tenant-a"),
    });
    const second = service.resolve({
      planFile: "plan.json",
      workingDir: root,
      scope: scope("tenant-b"),
    });

    expect(first.artifact.identity).toEqual(second.artifact.identity);
    expect(first.reference.scope).not.toEqual(second.reference.scope);
    expect(first.acquisition).toEqual({
      contract: "lexrunner.plan-artifact-acquisition.v1",
      assurance: "portable-race-detection",
      authority: "unverified",
    });
  });

  it("runtime-validates scope and rejects ambiguous reference overrides", async () => {
    const root = await fixtureRoot();
    await writePlan(join(root, "plan.json"), plan("scope"));
    const service = new PlanArtifactService();
    const resolved = service.resolve({ planFile: "plan.json", workingDir: root });

    for (const invalidScope of [
      { ...scope("tenant"), tenant: "" },
      { ...scope("tenant"), tenant: "é".repeat(300) },
      { tenant: "tenant" },
      { ...scope("tenant"), unexpected: "field" },
    ]) {
      expect(() =>
        service.resolve({
          planFile: "plan.json",
          workingDir: root,
          scope: invalidScope as ReturnType<typeof scope>,
        })
      ).toThrowError(
        expect.objectContaining<Partial<PlanArtifactServiceError>>({
          code: "PLAN_REFERENCE_INVALID",
        })
      );
    }

    expect(() =>
      service.resolve({
        planReference: resolved.reference,
        workingDir: root,
        scope: scope("override"),
      })
    ).toThrowError(
      expect.objectContaining<Partial<PlanArtifactServiceError>>({
        code: "PLAN_REFERENCE_INVALID",
      })
    );
  });

  it("fails a mismatched immutable reference without falling through", async () => {
    const root = await fixtureRoot();
    await writePlan(join(root, "selected.json"), plan("selected"));
    await writePlan(join(root, "plan.json"), plan("fallback-must-not-load"));
    const service = new PlanArtifactService();
    const selected = service.resolve({ planFile: "selected.json", workingDir: root });
    const badReference = {
      ...selected.reference,
      artifact: { ...selected.reference.artifact, target: "different" },
    };

    expect(() => service.resolve({ planReference: badReference, workingDir: root })).toThrowError(
      expect.objectContaining<Partial<PlanArtifactServiceError>>({
        code: "PLAN_REFERENCE_MISMATCH",
        source: "explicit",
      })
    );
  });

  it("rejects self-consistent hashes over noncanonical or semantically mismatched bytes", async () => {
    const root = await fixtureRoot();
    await writePlan(join(root, "plan.json"), plan("artifact"));
    const artifact = new PlanArtifactService().resolve({
      planFile: "plan.json",
      workingDir: root,
    }).artifact;
    const noncanonicalBytes = JSON.stringify(JSON.parse(artifact.canonicalBytes));
    const noncanonical = {
      identity: {
        ...artifact.identity,
        digest: computeExecutionPlanArtifactDigest(noncanonicalBytes),
        canonicalByteLength: Buffer.byteLength(noncanonicalBytes, "utf8"),
      },
      canonicalBytes: noncanonicalBytes,
    };
    const falseSummary = {
      ...artifact,
      identity: { ...artifact.identity, summary: { itemCount: 0, gateCount: 0 } },
    };

    expect(ExecutionPlanArtifact_v1Schema.safeParse(noncanonical).success).toBe(false);
    expect(ExecutionPlanArtifact_v1Schema.safeParse(falseSummary).success).toBe(false);
  });

  it("fails closed on an invalid, missing, or unreadable explicit reference without path disclosure", async () => {
    const root = await fixtureRoot();
    await writePlan(join(root, "plan.json"), plan("fallback-must-not-load"));
    await mkdir(join(root, "not-a-file"));
    const service = new PlanArtifactService();

    for (const [planFile, code] of [
      ["", "PLAN_REFERENCE_INVALID"],
      ["private-missing-plan.json", "PLAN_NOT_FOUND"],
      ["not-a-file", "PLAN_UNREADABLE"],
    ] as const) {
      let failure: unknown;
      try {
        service.resolve({ planFile, workingDir: root });
      } catch (error) {
        failure = error;
      }
      expect(failure).toEqual(
        expect.objectContaining<Partial<PlanArtifactServiceError>>({ code, source: "explicit" })
      );
      expect((failure as Error).message).not.toContain(root);
      if (planFile) expect((failure as Error).message).not.toContain(planFile);
    }
  });

  it("preserves bounded malformed-JSON and schema-validation failures", async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, "malformed.json"), '{"secret":"TOPSECRET"', "utf8");
    await writeFile(
      join(root, "invalid.json"),
      JSON.stringify({ schemaVersion: "1.0.0", target: "main", items: "TOPSECRET" }),
      "utf8"
    );
    const service = new PlanArtifactService();

    expect(() => service.resolve({ planFile: "malformed.json", workingDir: root })).toThrowError(
      expect.objectContaining({ axError: expect.objectContaining({ code: "CONFIG_INVALID" }) })
    );
    expect(() => service.resolve({ planFile: "invalid.json", workingDir: root })).toThrowError(
      expect.objectContaining({ name: "SchemaValidationError" })
    );
  });

  it("rejects plans whose public identity would exceed bounded transport limits", async () => {
    const root = await fixtureRoot();
    await writePlan(join(root, "overlong.json"), {
      ...plan("item"),
      target: "x".repeat(513),
    });

    expect(() =>
      new PlanArtifactService().resolve({ planFile: "overlong.json", workingDir: root })
    ).toThrowError(
      expect.objectContaining<Partial<PlanArtifactServiceError>>({
        code: "PLAN_ARTIFACT_LIMIT_EXCEEDED",
        source: "explicit",
      })
    );
  });
});

function plan(itemName: string) {
  return {
    schemaVersion: "1.0.0",
    target: "main",
    items: [{ name: itemName, deps: [], gates: [] }],
  };
}

function scope(tenant: string) {
  return {
    tenant,
    workspace: "workspace",
    repository: "owner/repository",
    refNamespace: "refs/heads/main",
    policy: "policy-v1",
  };
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lexrunner-plan-artifact-"));
  roots.push(root);
  return root;
}

async function writePlan(filePath: string, value: object): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
