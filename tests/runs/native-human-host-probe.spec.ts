import { mkdtemp, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createNativeHumanHostProbe } from "../../scripts/probe-native-human-host.mjs";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.useRealTimers();
});
const parse = (result: any) => JSON.parse(result.content[0].text);
async function fixture(
  root?: string,
  reply: unknown = { action: "accept", content: { q0: "B" } },
  timeoutMs: number | undefined = undefined,
  supported = true
) {
  root ??= await mkdtemp(join(tmpdir(), "native-host-test-"));
  const probe = await createNativeHumanHostProbe(root, timeoutMs);
  const client = new Client(
    { name: "controlled-ui", version: "0.0.1" },
    {
      capabilities: { elicitation: supported ? { form: {} } : { url: {} } },
    }
  );
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  let shown = 0;
  client.setRequestHandler(ElicitRequestSchema, async () => {
    shown++;
    return reply as any;
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
    await probe.server.close();
    await probe.close();
  };
  cleanup.push(close);
  await Promise.all([probe.server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args = {}) =>
    parse(await client.callTool({ name, arguments: args }));
  return { root, probe, client, call, close, shown: () => shown };
}

describe("non-authorizing native human host qualification probe", () => {
  it("records valid protocol input without signing/admission, and recovers the same question after reopen", async () => {
    const f = await fixture();
    expect(await f.call("status")).toMatchObject({ questionCount: 0, inFlight: false });
    expect(f.shown()).toBe(0);
    const first = await f.call("present_sample");
    expect(first).toMatchObject({
      questionCount: 1,
      holdPending: true,
      answerAdmitted: false,
      result: { status: "pending", reason: "failed", boundary: "host_admission" },
      presentation: { presentationCount: 1 },
    });
    expect(first.observations.some((v: any) => v.kind === "valid_host_input_observed")).toBe(true);
    expect(JSON.stringify(first)).not.toContain('"value":"B"');
    expect((await f.call("present_sample")).result.reason).toBe("explicit_recovery_required");
    expect(f.shown()).toBe(1);
    await f.close();
    const reopened = await fixture(f.root);
    const persisted = await reopened.call("status");
    expect(persisted.requestId).toBe(first.requestId);
    expect(reopened.shown()).toBe(0);
    const recovered = await reopened.call("recover_sample");
    expect(recovered).toMatchObject({
      questionCount: 1,
      holdPending: true,
      answerAdmitted: false,
      presentation: { presentationCount: 2 },
    });
    expect(recovered.requestId).toBe(first.requestId);
    expect(recovered.presentation.presentationId).not.toBe(first.presentation.presentationId);
    expect(reopened.shown()).toBe(1);
  });

  it.each(["decline", "cancel"])(
    "keeps %s pending without manufacturing an answer",
    async (action) => {
      const f = await fixture(undefined, { action, content: null });
      const result = await f.call("present_sample");
      expect(result).toMatchObject({
        questionCount: 1,
        holdPending: true,
        answerAdmitted: false,
        result: { status: "pending", reason: action === "decline" ? "declined" : "cancelled" },
      });
      expect(result.observations.some((v: any) => v.kind === "valid_host_input_observed")).toBe(
        false
      );
    }
  );

  it("times out without admission or automatic redisplay, and ignores the original late reply", async () => {
    const f = await fixture(undefined, undefined, 150);
    let release!: () => void;
    f.client.setRequestHandler(ElicitRequestSchema, async () => {
      await new Promise<void>((done) => {
        release = done;
      });
      return { action: "accept", content: { q0: "B" } };
    });
    const result = await f.call("present_sample");
    expect(result).toMatchObject({
      questionCount: 1,
      holdPending: true,
      answerAdmitted: false,
      result: { status: "pending", reason: "expired" },
    });
    release();
    await new Promise((done) => setImmediate(done));
    const later = await f.call("status");
    expect(later.answerAdmitted).toBe(false);
    expect(later.observations.filter((v: any) => v.kind === "dispatch")).toHaveLength(1);
    expect(later.observations.some((v: any) => v.kind === "valid_host_input_observed")).toBe(false);
    expect((await f.call("present_sample")).result.reason).toBe("explicit_recovery_required");
  });

  it("rejects agent-supplied answers and unknown tools before creating a question", async () => {
    const f = await fixture();
    await expect(f.call("present_sample", { answer: "B" })).rejects.toThrow();
    await expect(f.call("admit_answer")).rejects.toThrow();
    expect(await f.call("status")).toMatchObject({ questionCount: 0, answerAdmitted: false });
    expect(f.shown()).toBe(0);
  });

  it("reports an unsupported channel with a pending question and no display", async () => {
    const f = await fixture(undefined, undefined, 30000, false);
    expect(await f.call("present_sample")).toMatchObject({
      questionCount: 1,
      holdPending: true,
      answerAdmitted: false,
      result: { status: "blocked", reason: "form_capability_unavailable" },
      presentation: { presentationCount: 0 },
    });
    expect(f.shown()).toBe(0);
  });

  it("refuses malformed option content without calling the observation port", async () => {
    const f = await fixture(undefined, { action: "accept", content: { q0: "unknown" } });
    const result = await f.call("present_sample");
    expect(result).toMatchObject({
      holdPending: true,
      answerAdmitted: false,
      result: { status: "pending", reason: "failed", boundary: "result_validation" },
    });
    expect(result.observations.some((v: any) => v.kind === "valid_host_input_observed")).toBe(
      false
    );
  });

  it("refuses a competing live controller and permits explicit recovery after orderly close", async () => {
    const first = await fixture(undefined, { action: "decline", content: null });
    await first.call("present_sample");
    const second = await fixture(first.root);
    expect((await second.call("recover_sample")).result.reason).toBe(
      "another_probe_controller_active"
    );
    expect(second.shown()).toBe(0);
    await first.close();
    expect(await second.call("recover_sample")).toMatchObject({
      questionCount: 1,
      presentation: { presentationCount: 2 },
      answerAdmitted: false,
    });
    expect(second.shown()).toBe(1);
  });

  it("puts directions and the two-minute window in the field without selecting an answer", async () => {
    const f = await fixture();
    let rendered: any;
    f.client.setRequestHandler(ElicitRequestSchema, async (request) => {
      rendered = request.params;
      return { action: "decline", content: null };
    });
    const first = await f.call("present_sample");
    expect(first.timeoutMs).toBe(120000);
    expect(rendered.requestedSchema.properties.q0).toMatchObject({
      title: "Select B, then submit (up to 120 seconds)",
      enum: ["A", "B"],
    });
    expect(rendered.requestedSchema.properties.q0).not.toHaveProperty("default");
    expect(rendered.requestedSchema.properties.q0.description).toContain("Use Skip to dismiss");
    expect(rendered.requestedSchema.properties.q0.description).toContain(
      "stop here and request recovery"
    );
    expect(rendered.message).toContain("up to 120 seconds");
    expect(first.observations.find((v: any) => v.kind === "dispatch")).toMatchObject({
      projection: "diagnostic-directions-v1",
      formDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await f.close();
    const reopened = await fixture(f.root, { action: "decline", content: null }, 30000);
    const recovered = await reopened.call("recover_sample");
    expect(recovered.requestId).toBe(first.requestId);
    expect(recovered).toMatchObject({ questionCount: 1, holdPending: true, answerAdmitted: false });
  });

  it("keeps the controller lease beyond a two-minute display window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const first = await fixture(undefined, { action: "decline", content: null });
    await first.call("present_sample");
    vi.setSystemTime(start + 121000);
    const second = await fixture(first.root);
    expect((await second.call("recover_sample")).result.reason).toBe(
      "another_probe_controller_active"
    );
    expect(second.shown()).toBe(0);
    await first.close();
    expect((await second.call("recover_sample")).presentation.presentationCount).toBe(2);
  });

  it("renews the same process lease for delayed recovery and closes after the original lease expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const first = await fixture(undefined, { action: "decline", content: null });
    const original = await first.call("present_sample");
    vi.setSystemTime(start + 121000);
    let opened!: () => void;
    let release!: () => void;
    const dispatched = new Promise<void>((done) => {
      opened = done;
    });
    const response = new Promise<void>((done) => {
      release = done;
    });
    first.client.setRequestHandler(ElicitRequestSchema, async () => {
      opened();
      await response;
      return { action: "decline", content: null };
    });
    const recovering = first.call("recover_sample");
    try {
      await dispatched;
      vi.setSystemTime(start + 200000);
      const competitor = await fixture(first.root);
      expect((await competitor.call("recover_sample")).result.reason).toBe(
        "another_probe_controller_active"
      );
      expect(competitor.shown()).toBe(0);
    } finally {
      release();
    }
    const recovered = await recovering;
    expect(recovered).toMatchObject({
      requestId: original.requestId,
      holdPending: true,
      answerAdmitted: false,
      result: { status: "pending", reason: "declined" },
      presentation: { presentationCount: 2, disposition: "declined" },
    });
  });

  it.each([149, 120001, Number.NaN])("refuses an invalid display window %s", async (timeout) => {
    const root = await mkdtemp(join(tmpdir(), "native-host-window-"));
    await expect(createNativeHumanHostProbe(root, timeout)).rejects.toThrow("150..120000ms");
    expect(await readdir(root)).toEqual([]);
  });

  it("preserves an unmarked nonempty directory instead of creating a probe over it", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-host-unmarked-"));
    await writeFile(join(root, "retained.json"), "retained");
    await expect(createNativeHumanHostProbe(root)).rejects.toThrow("preserve and reconcile");
    expect(await readdir(root)).toEqual(["retained.json"]);
  });

  it("starts the exact source probe over real stdio with bounded status and no UI request", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-host-stdio-"));
    const repo = resolve(".");
    const client = new Client(
      { name: "controlled-stdio-ui", version: "0.0.1" },
      { capabilities: { elicitation: { form: {} } } }
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        pathToFileURL(join(repo, "node_modules/tsx/dist/loader.mjs")).href,
        join(repo, "scripts/probe-native-human-host.mjs"),
        root,
        "30000",
      ],
      cwd: repo,
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (value) => {
      stderr = (stderr + value).slice(-4000);
    });
    cleanup.push(async () => {
      await client.close();
    });
    await client.connect(transport);
    expect(parse(await client.callTool({ name: "status", arguments: {} }))).toMatchObject({
      ready: true,
      questionCount: 0,
      answerAdmitted: false,
    });
    expect(stderr).toBe("");
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "status",
      "present_sample",
      "recover_sample",
    ]);
  });
});
