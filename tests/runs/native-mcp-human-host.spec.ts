import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  NativeMcpHumanPresentationHost,
  mcpHumanFormChannel,
  projectNativeHumanForm,
  type NativeHumanFormChannel,
  type NativeHumanAdmissionPort,
} from "../../src/runs/native-mcp-human-host.js";
import {
  humanActionSummary,
  readHumanActionState,
} from "../../src/runs/agent-work-human-action-service.js";
import { humanAnswerFixture } from "../store/worker-human-answer-fixture.js";
import type { CoordinationStore } from "../../src/store/coordination-store.js";

const fixtures: Awaited<ReturnType<typeof humanAnswerFixture>>[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});
async function setup(
  kind: "memory" | "sqlite",
  configure?: (
    capture: ReturnType<Awaited<ReturnType<typeof humanAnswerFixture>>["capture"]>
  ) => void
) {
  const f = await humanAnswerFixture(kind, new Date().toISOString());
  fixtures.push(f);
  const initialCapture = f.capture();
  configure?.(initialCapture);
  const requestId = await f.record(initialCapture);
  let connection: object | null = {};
  const channel: NativeHumanFormChannel = {
    connection: () => connection,
    capabilities: () => ({ elicitation: { form: {} } }),
    request: vi.fn(async () => ({ action: "accept", content: { q0: "B" } })),
  };
  const admission: NativeHumanAdmissionPort = {
    admitInput: vi.fn(async (input) =>
      f.signed(input.presentation.challenge, {
        answers: input.answers,
        answeredAt: input.observedAt,
      })
    ),
  };
  const input = {
    ...(await f.mutation("display")),
    requestId,
    presentationId: randomUUID(),
    challengeId: randomUUID(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  };
  const host = () => new NativeMcpHumanPresentationHost(f.service, f.store, channel, admission);
  const signal = new AbortController();
  const held = async () => {
    expect(
      humanActionSummary((await f.store.getRunCoordination("run"))!.state, new Date().toISOString())
    ).toHaveLength(1);
  };
  return {
    f,
    input,
    channel,
    admission,
    signal,
    host,
    held,
    replaceConnection: () => {
      connection = {};
    },
  };
}
function lostAck(store: CoordinationStore, type: string) {
  let lost = false;
  return new Proxy(store, {
    get(target, key) {
      if (key === "compareAndSetRunState")
        return async (input: Parameters<CoordinationStore["compareAndSetRunState"]>[0]) => {
          const result = await target.compareAndSetRunState(input);
          if (result.updated && input.event.type === type && !lost) {
            lost = true;
            throw new Error("lost ACK");
          }
          return result;
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe.each(["memory", "sqlite"] as const)("native MCP human host (%s)", (kind) => {
  it("presents committed data once and persists the host-attested answer without releasing its hold", async () => {
    const h = await setup(kind);
    vi.mocked(h.channel.request).mockImplementation(async (form, window) => {
      const state = readHumanActionState((await h.f.store.getRunCoordination("run"))!.state);
      expect(state.entries[0].presentations).toHaveLength(1);
      expect(form.mode).toBe("form");
      expect(form.requestedSchema.properties.q0.enum).toEqual(["A", "B"]);
      expect(form.requestedSchema.properties.q0).not.toHaveProperty("default");
      expect(window.timeoutMs).toBeGreaterThan(0);
      expect(window.timeoutMs).toBeLessThanOrEqual(30_000);
      return { action: "accept", content: { q0: "B" } };
    });
    expect(await h.host().present(h.input, h.signal.signal)).toMatchObject({
      status: "admitted_hold_pending",
    });
    if (kind === "sqlite") await h.f.reopen();
    expect(
      (await h.f.service.getWorkerAnswer("run", h.input.requestId))!.answer.payload.answers
    ).toEqual([{ questionId: "choice", value: "B" }]);
    await h.held();
    expect(await h.host().present(h.input, h.signal.signal)).toMatchObject({
      status: "reconciliation_required",
      reason: "presentation_already_claimed",
    });
    expect(h.channel.request).toHaveBeenCalledOnce();
    expect(h.admission.admitInput).toHaveBeenCalledOnce();
  });

  it.each(["decline", "cancel"])(
    "keeps %s pending and explicitly recovers the same question",
    async (action) => {
      const h = await setup(kind);
      vi.mocked(h.channel.request).mockResolvedValueOnce({ action, content: null });
      expect(await h.host().present(h.input, h.signal.signal)).toMatchObject({
        status: "pending",
        reason: action === "decline" ? "declined" : "cancelled",
      });
      expect(h.admission.admitInput).not.toHaveBeenCalled();
      if (kind === "sqlite") await h.f.reopen();
      const recovery = {
        ...h.input,
        ...(await h.f.mutation("recover")),
        presentationId: randomUUID(),
        challengeId: randomUUID(),
        previousPresentationId: h.input.presentationId,
      };
      expect(await h.host().present(recovery, h.signal.signal)).toMatchObject({
        status: "admitted_hold_pending",
      });
      expect(
        readHumanActionState((await h.f.store.getRunCoordination("run"))!.state).entries[0]
          .presentations
      ).toMatchObject([
        { disposition: action === "decline" ? "declined" : "cancelled" },
        { disposition: "answered", challenge: { generation: 2 } },
      ]);
      await h.held();
    }
  );

  it.each([
    { action: "accept", content: {} },
    { action: "accept", content: { q0: "C" } },
    { action: "accept", content: { q0: "A", extra: "B" } },
    { action: "accept", content: { q0: true } },
    { action: "accept", content: { q0: "A" }, remembered: true },
    { action: "decline", content: { q0: "A" } },
  ])("refuses malformed, cached-approval-only or mismatched reply %#", async (reply) => {
    const h = await setup(kind);
    vi.mocked(h.channel.request).mockResolvedValue(reply);
    expect(await h.host().present(h.input, h.signal.signal)).toMatchObject({
      status: "pending",
      reason: "failed",
    });
    expect(h.admission.admitInput).not.toHaveBeenCalled();
    expect(await h.f.service.getWorkerAnswer("run", h.input.requestId)).toBeNull();
    await h.held();
  });

  it("rejects input that the protected host does not qualify", async () => {
    const h = await setup(kind);
    vi.mocked(h.admission.admitInput).mockResolvedValue(null);
    expect(await h.host().present(h.input, h.signal.signal)).toMatchObject({
      status: "pending",
      reason: "failed",
    });
    expect(await h.f.service.getWorkerAnswer("run", h.input.requestId)).toBeNull();
    await h.held();
  });

  it("rejects a host attestation that changes an entered answer", async () => {
    const h = await setup(kind);
    vi.mocked(h.admission.admitInput).mockImplementation(async (input) =>
      h.f.signed(input.presentation.challenge, {
        answeredAt: input.observedAt,
        answers: [{ questionId: "choice", value: "A" }],
      })
    );
    expect(await h.host().present(h.input, h.signal.signal)).toMatchObject({
      status: "pending",
      reason: "failed",
    });
    expect(await h.f.service.getWorkerAnswer("run", h.input.requestId)).toBeNull();
    await h.held();
  });

  it("does not prompt or attest twice after a lost claim ACK", async () => {
    const h = await setup(kind);
    const store = lostAck(h.f.store, "worker_question_presentation_claimed");
    const host = new NativeMcpHumanPresentationHost(
      h.f.serviceFor(store),
      store,
      h.channel,
      h.admission
    );
    expect(await host.present(h.input, h.signal.signal)).toMatchObject({
      status: "reconciliation_required",
    });
    expect(await h.host().present(h.input, h.signal.signal)).toMatchObject({
      reason: "presentation_already_claimed",
    });
    expect(h.channel.request).not.toHaveBeenCalled();
    expect(h.admission.admitInput).not.toHaveBeenCalled();
    await h.held();
  });

  it("reconciles a lost admission ACK without overwriting the persisted answer", async () => {
    const h = await setup(kind);
    const store = lostAck(h.f.store, "worker_answer_admitted");
    const host = new NativeMcpHumanPresentationHost(
      h.f.serviceFor(store),
      store,
      h.channel,
      h.admission
    );
    expect(await host.present(h.input, h.signal.signal)).toMatchObject({
      status: "reconciliation_required",
      reason: "persistence_or_admission_uncertain",
    });
    if (kind === "sqlite") await h.f.reopen();
    expect(await h.f.service.getWorkerAnswer("run", h.input.requestId)).not.toBeNull();
    await h.held();
    expect(await h.host().present(h.input, h.signal.signal)).toMatchObject({
      reason: "presentation_already_claimed",
    });
    expect(h.channel.request).toHaveBeenCalledOnce();
    expect(h.admission.admitInput).toHaveBeenCalledOnce();
  });

  it("refuses dispatch when a reconnect occurs after preflight", async () => {
    const h = await setup(kind);
    const original = h.channel.connection;
    let reads = 0;
    h.channel.connection = () => {
      const identity = original();
      if (++reads === 3) queueMicrotask(() => h.replaceConnection());
      return identity;
    };
    expect(await h.host().present(h.input, h.signal.signal)).toMatchObject({
      status: "pending",
      reason: "failed",
    });
    expect(h.channel.request).not.toHaveBeenCalled();
    expect(h.admission.admitInput).not.toHaveBeenCalled();
    await h.held();
  });

  it.each(["freshness", "storage"] as const)(
    "fences cancellation, expiry and reconnect after delayed %s entry",
    async (boundary) => {
      // Three fresh journals isolate each refusal and exercise both concrete stores.
      for (const end of ["cancel", "expire", "reconnect"] as const) {
        const h = await setup(kind);
        let release!: () => void;
        let entered = false;
        let admitting = false;
        const pause = new Promise<void>((resolve) => {
          release = resolve;
        });
        const elapsed = vi.spyOn(performance, "now").mockReturnValue(100);
        const observer = h.f.observer.observe.bind(h.f.observer);
        vi.spyOn(h.f.observer, "observe").mockImplementation(async () => {
          if (boundary === "freshness" && admitting) {
            entered = true;
            await pause;
          }
          return observer();
        });
        const store = new Proxy(h.f.store, {
          get(target, key) {
            if (key === "compareAndSetRunState")
              return async (input: Parameters<CoordinationStore["compareAndSetRunState"]>[0]) => {
                if (boundary === "storage" && input.event.type === "worker_answer_admitted") {
                  entered = true;
                  await pause;
                }
                return target.compareAndSetRunState(input);
              };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const service = h.f.serviceFor(store);
        const admit = service.admitWorkerAnswer.bind(service);
        let settling: ReturnType<typeof admit> | undefined;
        vi.spyOn(service, "admitWorkerAnswer").mockImplementation((...args) => {
          admitting = true;
          return (settling = admit(...args));
        });
        const host = new NativeMcpHumanPresentationHost(service, store, h.channel, h.admission);
        try {
          const pending = host.present(h.input, h.signal.signal);
          await vi.waitFor(() => expect(entered).toBe(true));
          if (end === "cancel") h.signal.abort();
          if (end === "expire") elapsed.mockReturnValue(30_100);
          if (end === "reconnect") h.replaceConnection();
          release();
          expect(await pending).toMatchObject({
            status: "reconciliation_required",
          });
          await settling;
          if (kind === "sqlite") await h.f.reopen();
          expect(await h.f.service.getWorkerAnswer("run", h.input.requestId)).toBeNull();
          expect(
            (await h.f.store.listRunCoordinationEvents("run")).some(
              (event) => event.type === "worker_answer_admitted"
            )
          ).toBe(false);
          await h.held();
        } finally {
          release();
          elapsed.mockRestore();
        }
      }
    }
  );

  it("bounds a stalled core admission and fences its eventual write", async () => {
    const h = await setup(kind);
    h.input.expiresAt = new Date(Date.now() + 250).toISOString();
    let release!: () => void;
    let entered = false;
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new Proxy(h.f.store, {
      get(target, key) {
        if (key === "compareAndSetRunState")
          return async (input: Parameters<CoordinationStore["compareAndSetRunState"]>[0]) => {
            if (input.event.type === "worker_answer_admitted") {
              entered = true;
              await pause;
            }
            return target.compareAndSetRunState(input);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const service = h.f.serviceFor(store);
    const admit = service.admitWorkerAnswer.bind(service);
    let settling: ReturnType<typeof admit> | undefined;
    vi.spyOn(service, "admitWorkerAnswer").mockImplementation(
      (...args) => (settling = admit(...args))
    );
    const host = new NativeMcpHumanPresentationHost(service, store, h.channel, h.admission);
    const pending = host.present(h.input, h.signal.signal);
    await vi.waitFor(() => expect(entered).toBe(true));
    expect(await pending).toMatchObject({
      status: "reconciliation_required",
      reason: "persistence_or_admission_uncertain",
    });
    release();
    expect(await settling).toMatchObject({ ok: false, reason: "commit_condition_failed" });
    if (kind === "sqlite") await h.f.reopen();
    expect(await h.f.service.getWorkerAnswer("run", h.input.requestId)).toBeNull();
    await h.held();
  });

  it("discards a response from a replaced connection", async () => {
    const h = await setup(kind);
    vi.mocked(h.channel.request).mockImplementation(async () => {
      h.replaceConnection();
      return { action: "accept", content: { q0: "B" } };
    });
    expect(await h.host().present(h.input, h.signal.signal)).toMatchObject({
      status: "pending",
      reason: "failed",
    });
    expect(h.admission.admitInput).not.toHaveBeenCalled();
    await h.held();
  });

  it("aborts a nonconforming channel and ignores its late valid reply", async () => {
    const h = await setup(kind);
    let resolve!: (reply: unknown) => void;
    let inner!: AbortSignal;
    vi.mocked(h.channel.request).mockImplementation((_form, window) => {
      inner = window.signal;
      return new Promise((done) => {
        resolve = done;
      });
    });
    const pending = h.host().present(h.input, h.signal.signal);
    await vi.waitFor(() => expect(h.channel.request).toHaveBeenCalledOnce());
    h.signal.abort();
    expect(await pending).toMatchObject({ status: "pending", reason: "cancelled" });
    expect(inner.aborted).toBe(true);
    resolve({ action: "accept", content: { q0: "B" } });
    await new Promise((done) => setImmediate(done));
    expect(h.admission.admitInput).not.toHaveBeenCalled();
    expect(await h.f.service.getWorkerAnswer("run", h.input.requestId)).toBeNull();
    await h.held();
  });

  it("rejects workspace changes during the native interaction", async () => {
    const h = await setup(kind);
    vi.mocked(h.channel.request).mockImplementation(async () => {
      h.f.observed.headSha = "b".repeat(40);
      return { action: "accept", content: { q0: "B" } };
    });
    expect(await h.host().present(h.input, h.signal.signal)).toMatchObject({
      status: "reconciliation_required",
      reason: "stale_workspace_binding",
    });
    expect(await h.f.service.getWorkerAnswer("run", h.input.requestId)).toBeNull();
    await h.held();
  });

  it("prevents a concurrent call and snapshots caller inputs across the interaction", async () => {
    const h = await setup(kind);
    let resolve!: (reply: unknown) => void;
    vi.mocked(h.channel.request).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const host = h.host();
    const input = structuredClone(h.input);
    const pending = host.present(input, h.signal.signal);
    await vi.waitFor(() => expect(h.channel.request).toHaveBeenCalledOnce());
    input.requestId = "changed-by-caller";
    input.controller.runId = "changed-run";
    expect(await host.present(h.input, h.signal.signal)).toMatchObject({
      reason: "presentation_in_progress",
    });
    resolve({ action: "accept", content: { q0: "B" } });
    expect(await pending).toMatchObject({ status: "admitted_hold_pending" });
    expect(await h.f.service.getWorkerAnswer("run", h.input.requestId)).not.toBeNull();
    await h.held();
  });

  it("does not admit a response after the protected signer is cancelled", async () => {
    const h = await setup(kind);
    let resolve!: (answer: unknown) => void;
    let signed: unknown;
    vi.mocked(h.admission.admitInput).mockImplementation((input) => {
      signed = h.f.signed(input.presentation.challenge, {
        answers: input.answers,
        answeredAt: input.observedAt,
      });
      return new Promise((done) => {
        resolve = done as never;
      });
    });
    const pending = h.host().present(h.input, h.signal.signal);
    await vi.waitFor(() => expect(h.admission.admitInput).toHaveBeenCalledOnce());
    h.signal.abort();
    expect(await pending).toMatchObject({ status: "pending", reason: "cancelled" });
    resolve(signed);
    await new Promise((done) => setImmediate(done));
    expect(await h.f.service.getWorkerAnswer("run", h.input.requestId)).toBeNull();
    await h.held();
  });

  it("rejects a late reply after another host has closed the display", async () => {
    const h = await setup(kind);
    vi.mocked(h.channel.request).mockImplementation(async () => {
      const closed = await h.f.service.closeWorkerQuestionPresentation({
        ...(await h.f.mutation("external-close", new Date().toISOString())),
        requestId: h.input.requestId,
        presentationId: h.input.presentationId,
        disposition: "cancelled",
      });
      expect(closed.ok).toBe(true);
      return { action: "accept", content: { q0: "B" } };
    });
    expect(await h.host().present(h.input, h.signal.signal)).toMatchObject({
      status: "reconciliation_required",
    });
    expect(h.admission.admitInput).not.toHaveBeenCalled();
    await h.held();
  });

  it("does not claim a display for unsupported capabilities or an already aborted call", async () => {
    const h = await setup(kind);
    h.channel.capabilities = () => ({ elicitation: { url: {} } });
    expect(await h.host().present(h.input, h.signal.signal)).toMatchObject({
      reason: "form_capability_unavailable",
    });
    h.signal.abort();
    expect(await h.host().present(h.input, h.signal.signal)).toMatchObject({
      reason: "cancelled_before_claim",
    });
    expect(await h.f.store.listRunCoordinationEvents("run")).toHaveLength(1);
    expect(h.channel.request).not.toHaveBeenCalled();
  });
});

describe("form projection and SDK transport conformance", () => {
  it("preserves Other and free text byte-for-byte while keeping authored IDs out of property names", async () => {
    const h = await setup("memory", (capture) => {
      capture.questions[0].id = "__proto__";
      capture.questions[0].allowOther = true;
    });
    const requestId = h.input.requestId;
    const input = h.input;
    const capture = readHumanActionState((await h.f.store.getRunCoordination("run"))!.state)
      .entries[0].workerInput!;
    const authored = "  my other answer\nunchanged  ";
    const form = projectNativeHumanForm(capture, input.expiresAt);
    expect(Object.keys(form.requestedSchema.properties)).toEqual(["q0"]);
    expect(form.requestedSchema.properties.q0).not.toHaveProperty("enum");
    expect(form.requestedSchema.properties.q0.description).toContain("A: Candidate A");
    vi.mocked(h.channel.request).mockResolvedValue({ action: "accept", content: { q0: authored } });
    expect(await h.host().present(input, h.signal.signal)).toMatchObject({
      status: "admitted_hold_pending",
    });
    expect((await h.f.service.getWorkerAnswer("run", requestId))!.answer.payload.answers).toEqual([
      { questionId: "__proto__", value: authored },
    ]);
  });

  it("qualifies the standard form route over actual SDK protocol messages", async () => {
    const h = await setup("sqlite");
    const server = new Server(
      { name: "controlled-human-host", version: "0.0.1" },
      { capabilities: {} }
    );
    const client = new Client(
      { name: "controlled-form-client", version: "0.0.1" },
      { capabilities: { elicitation: { form: {} } } }
    );
    closers.push(async () => {
      await client.close();
      await server.close();
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    let shown = 0;
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      shown++;
      expect(request.params.mode).toBe("form");
      expect((request.params as any).requestedSchema.properties.q0.enum).toEqual(["A", "B"]);
      return { action: "accept", content: { q0: "B" } };
    });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const host = new NativeMcpHumanPresentationHost(
      h.f.service,
      h.f.store,
      mcpHumanFormChannel(server),
      h.admission
    );
    expect(await host.present(h.input, h.signal.signal)).toMatchObject({
      status: "admitted_hold_pending",
    });
    expect(shown).toBe(1);
    await h.held();
  });

  it("binds SDK dispatch to the expected transport without sending on a replacement", async () => {
    const request = vi.fn();
    const replacement = {};
    const server = {
      transport: replacement,
      getClientCapabilities: () => ({ elicitation: { form: {} } }),
      request,
    } as unknown as Parameters<typeof mcpHumanFormChannel>[0];
    const h = await setup("memory");
    const capture = readHumanActionState((await h.f.store.getRunCoordination("run"))!.state)
      .entries[0].workerInput!;
    const channel = mcpHumanFormChannel(server);
    await expect(
      channel.request(
        { ...projectNativeHumanForm(capture, h.input.expiresAt), mode: "form" },
        { signal: h.signal.signal, timeoutMs: 1000, connection: {} }
      )
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("negotiates the tested OpenAI form extension without inventing a standard capability", async () => {
    const h = await setup("memory");
    h.channel.capabilities = () => ({ elicitation: {}, extensions: { "openai/form": {} } });
    expect(await h.host().present(h.input, h.signal.signal)).toMatchObject({
      status: "admitted_hold_pending",
    });
    expect(vi.mocked(h.channel.request).mock.calls[0][0].mode).toBe("openai/form");
  });

  it("does not extend the admission window when the wall clock is held back", async () => {
    const h = await setup("memory");
    const clock = () => h.f.time;
    const elapsed = vi.spyOn(performance, "now").mockReturnValue(100);
    vi.mocked(h.admission.admitInput).mockImplementation(async (input) => {
      elapsed.mockReturnValue(60_100);
      return h.f.signed(input.presentation.challenge, {
        answers: input.answers,
        answeredAt: input.observedAt,
      });
    });
    try {
      const host = new NativeMcpHumanPresentationHost(
        h.f.service,
        h.f.store,
        h.channel,
        h.admission,
        clock
      );
      expect(await host.present(h.input, h.signal.signal)).toMatchObject({
        status: "pending",
        reason: "failed",
      });
      expect(h.admission.admitInput).toHaveBeenCalledOnce();
      expect(await h.f.service.getWorkerAnswer("run", h.input.requestId)).toBeNull();
      await h.held();
    } finally {
      elapsed.mockRestore();
    }
  });

  it("expires a channel that never responds and cannot attest its later reply", async () => {
    const h = await setup("memory");
    let resolve!: (reply: unknown) => void;
    let inner!: AbortSignal;
    h.input.expiresAt = new Date(Date.now() + 250).toISOString();
    vi.mocked(h.channel.request).mockImplementation((_form, window) => {
      inner = window.signal;
      return new Promise((done) => {
        resolve = done;
      });
    });
    expect(await h.host().present(h.input, h.signal.signal)).toMatchObject({
      status: "pending",
      reason: "expired",
    });
    expect(inner.aborted).toBe(true);
    resolve({ action: "accept", content: { q0: "B" } });
    await new Promise((done) => setImmediate(done));
    expect(h.admission.admitInput).not.toHaveBeenCalled();
    await h.held();
  });
});
