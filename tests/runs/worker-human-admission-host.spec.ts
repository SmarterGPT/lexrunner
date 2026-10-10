import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkerHumanAdmissionHost,
  WorkerHumanAdmissionInput,
  type QualifiedWorkerHumanInput,
  type QualifiedWorkerHumanInputSource,
  type WorkerHumanAnswerSigner,
} from "../../src/runs/worker-human-admission-host.js";
import {
  NativeMcpHumanPresentationHost,
  type NativeHumanFormChannel,
} from "../../src/runs/native-mcp-human-host.js";
import {
  humanActionSummary,
  readHumanActionState,
} from "../../src/runs/agent-work-human-action-service.js";
import { canonicalJSONStringify } from "../../src/util/canonicalJson.js";
import type { CoordinationStore } from "../../src/store/coordination-store.js";
import { humanAnswerFixture } from "../store/worker-human-answer-fixture.js";

type Fixture = Awaited<ReturnType<typeof humanAnswerFixture>>;
type QualificationWindow = Parameters<QualifiedWorkerHumanInputSource["qualify"]>[1];
const fixtures: Fixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});
function receipt(window: QualificationWindow, time: string, eventId = randomUUID()) {
  return {
    inputId: window.inputId,
    bindingHash: window.bindingHash,
    actorId: "human-1",
    authenticationEventId: eventId,
    qualifiedAt: time,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function setup(kind: "memory" | "sqlite" = "memory") {
  const f = await humanAnswerFixture(kind, new Date().toISOString());
  fixtures.push(f);
  const capture = f.capture();
  const requestId = await f.record(capture);
  const display = {
    ...(await f.mutation("display")),
    requestId,
    presentationId: randomUUID(),
    challengeId: randomUUID(),
    expiresAt: new Date(Date.parse(f.time) + 30_000).toISOString(),
  };
  const claim = await f.service.claimWorkerQuestionPresentation(display);
  if (!claim.ok || !("presentation" in claim)) throw new Error("test display claim failed");
  let time = f.time;
  let connection: object | null = {};
  const source: QualifiedWorkerHumanInputSource = {
    connection: vi.fn(() => connection),
    qualify: vi.fn(async (_input, window) => receipt(window, time)),
  };
  const signer: WorkerHumanAnswerSigner = {
    sign: vi.fn(async (input) =>
      sign(null, input.canonicalPayload, f.keys.privateKey).toString("base64url")
    ),
  };
  const trust = structuredClone(f.trust);
  const host = new WorkerHumanAdmissionHost(trust, source, signer, () => time);
  const input = WorkerHumanAdmissionInput.parse({
    presentation: claim.presentation,
    capture,
    answers: [{ questionId: "choice", value: "B" }],
    observedAt: f.time,
  });
  const signal = new AbortController();
  const window = { sourceConnection: connection, timeoutMs: 1000 };
  const held = async () => {
    expect(humanActionSummary((await f.store.getRunCoordination("run"))!.state, time)).toHaveLength(
      1
    );
  };
  return {
    f,
    display,
    input,
    host,
    source,
    signer,
    trust,
    signal,
    window,
    held,
    setTime: (value: string) => {
      time = value;
    },
    replaceConnection: () => {
      connection = {};
    },
    disconnected: () => {
      connection = null;
    },
  };
}
function privateSnapshot(host: WorkerHumanAdmissionHost, ...canaries: string[]) {
  const snapshot = host.snapshot();
  expect(Object.keys(snapshot).sort()).toEqual(
    ["state", "inFlight", "attempts", "qualifiedInputs", "verifiedAnswers", "lastFailure"].sort()
  );
  const json = JSON.stringify(snapshot);
  for (const canary of canaries) expect(json).not.toContain(canary);
  expect(json.length).toBeLessThan(512);
  return snapshot;
}
function lostAdmissionAck(store: CoordinationStore) {
  let lost = false;
  return new Proxy(store, {
    get(target, key) {
      if (key === "compareAndSetRunState")
        return async (input: Parameters<CoordinationStore["compareAndSetRunState"]>[0]) => {
          const result = await target.compareAndSetRunState(input);
          if (result.updated && input.event.type === "worker_answer_admitted" && !lost) {
            lost = true;
            throw new Error("synthetic lost admission ACK");
          }
          return result;
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("portable worker human admission host with controlled capabilities", () => {
  it.each(["memory", "sqlite"] as const)(
    "qualifies and signs exact input for existing %s admission while preserving the hold",
    async (kind) => {
      const h = await setup(kind);
      const answer = await h.host.admitInput(h.input, h.signal.signal, h.window);
      expect(answer).not.toBeNull();
      expect(h.f.verifier.verify(answer!)).toBe(true);
      expect(answer!.payload.answers).toEqual(h.input.answers);
      const [qualifiedInput, qualifiedWindow] = vi.mocked(h.source.qualify).mock.calls[0];
      expect(qualifiedInput).toEqual(h.input);
      expect(qualifiedWindow.sourceConnection).toBe(h.window.sourceConnection);
      expect(qualifiedWindow.inputId).toMatch(/^[a-f0-9-]{36}$/u);
      expect(qualifiedWindow.bindingHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(qualifiedWindow.timeoutMs).toBeGreaterThan(0);
      expect(qualifiedWindow.timeoutMs).toBeLessThanOrEqual(h.window.timeoutMs);
      const [signedInput, signingWindow] = vi.mocked(h.signer.sign).mock.calls[0];
      expect(Buffer.from(signedInput.canonicalPayload).toString("utf8")).toBe(
        canonicalJSONStringify(answer!.payload)
      );
      expect(signingWindow.sourceConnection).toBe(h.window.sourceConnection);
      expect(signingWindow.timeoutMs).toBeLessThanOrEqual(qualifiedWindow.timeoutMs);
      expect(
        await h.f.service.admitWorkerAnswer({
          ...(await h.f.mutation("admit")),
          answer: answer!,
        })
      ).toMatchObject({ ok: true });
      if (kind === "sqlite") await h.f.reopen();
      expect((await h.f.service.getWorkerAnswer("run", h.display.requestId))!.answer).toEqual(
        answer
      );
      await h.held();
      expect(
        privateSnapshot(h.host, answer!.signature, answer!.payload.authenticationEventId)
      ).toMatchObject({
        state: "ready",
        attempts: 1,
        qualifiedInputs: 1,
        verifiedAnswers: 1,
        lastFailure: null,
      });
    }
  );

  it("snapshots root identity and capability methods before asynchronous use", async () => {
    const h = await setup();
    const qualify = h.source.qualify,
      signing = h.signer.sign;
    h.trust.runId = "changed-run";
    h.trust.hostId = "changed-host";
    h.trust.keyId = "changed-key";
    h.trust.actorIds[0] = "changed-actor";
    h.source.connection = () => null;
    h.source.qualify = async () => null;
    h.signer.sign = async () => {
      throw new Error("replaced signer must not run");
    };
    const answer = await h.host.admitInput(h.input, h.signal.signal, h.window);
    expect(answer!.payload).toMatchObject({
      hostId: "human-host",
      keyId: "key-1",
      actorId: "human-1",
    });
    expect(h.f.verifier.verify(answer!)).toBe(true);
    expect(qualify).toHaveBeenCalledOnce();
    expect(signing).toHaveBeenCalledOnce();
  });

  it("snapshots exact answers across caller and capability mutation and preserves authored bytes", async () => {
    const h = await setup();
    h.input.capture.questions[0] = {
      ...h.input.capture.questions[0],
      id: "__proto__",
      options: null,
      allowOther: true,
    };
    const authored = "  <script>literal</script>\r\n界 e\u0301  ";
    h.input.answers = [{ questionId: "__proto__", value: authored }];
    const entered = deferred<void>();
    const release = deferred<void>();
    vi.mocked(h.source.qualify).mockImplementation(async (input, window) => {
      input.answers[0].value = "source mutation";
      input.capture.questions[0].id = "changed-question";
      entered.resolve();
      await release.promise;
      return receipt(window, h.f.time, "private-event-canary");
    });
    vi.mocked(h.signer.sign).mockImplementation(async (input) => {
      const bytes = Buffer.from(input.canonicalPayload);
      const result = sign(null, bytes, h.f.keys.privateKey).toString("base64url");
      input.qualification.actorId = "signer mutation";
      input.canonicalPayload.fill(0);
      return result;
    });
    const pending = h.host.admitInput(h.input, h.signal.signal, h.window);
    await entered.promise;
    h.input.answers[0].value = "caller mutation";
    h.input.presentation.challenge.requestId = "caller changed request";
    h.window.timeoutMs = 0;
    h.window.sourceConnection = {};
    release.resolve();
    const answer = await pending;
    expect(answer!.payload.answers).toEqual([{ questionId: "__proto__", value: authored }]);
    expect(answer!.payload.actorId).toBe("human-1");
    expect(h.f.verifier.verify(answer!)).toBe(true);
    privateSnapshot(h.host, authored, "private-event-canary", answer!.signature);
  });

  it.each(["run", "request", "closed", "future", "answer", "window"] as const)(
    "rejects inapplicable %s input before qualification or attempt consumption",
    async (attack) => {
      const h = await setup();
      if (attack === "run") h.input.presentation.challenge.runId = "other-run";
      if (attack === "request") h.input.presentation.challenge.requestId = "other-request";
      if (attack === "closed")
        h.input.presentation = {
          ...h.input.presentation,
          disposition: "cancelled",
          closedAt: h.f.time,
        };
      if (attack === "future")
        h.input.observedAt = new Date(Date.parse(h.f.time) + 1).toISOString();
      if (attack === "answer") h.input.answers[0].value = "not an authored option";
      if (attack === "window") h.window.timeoutMs = 0;
      expect(await h.host.admitInput(h.input, h.signal.signal, h.window)).toBeNull();
      expect(h.source.qualify).not.toHaveBeenCalled();
      expect(h.signer.sign).not.toHaveBeenCalled();
      expect(h.host.snapshot().attempts).toBe(0);
    }
  );

  it.each(["refuse", "throw", "binding", "input", "actor", "old", "future", "extra"] as const)(
    "rejects %s qualification without signing",
    async (attack) => {
      const h = await setup();
      vi.mocked(h.source.qualify).mockImplementation(async (_input, window) => {
        if (attack === "refuse") return null;
        if (attack === "throw") throw new Error("private source exception");
        const value = receipt(window, h.f.time);
        if (attack === "binding") value.bindingHash = "sha256:" + "f".repeat(64);
        if (attack === "input") value.inputId = randomUUID();
        if (attack === "actor") value.actorId = "not-authorized";
        if (attack === "old") value.qualifiedAt = new Date(Date.parse(h.f.time) - 1).toISOString();
        if (attack === "future")
          value.qualifiedAt = new Date(Date.parse(h.f.time) + 1).toISOString();
        return attack === "extra" ? { ...value, humanPresent: true } : value;
      });
      expect(await h.host.admitInput(h.input, h.signal.signal, h.window)).toBeNull();
      expect(h.signer.sign).not.toHaveBeenCalled();
      expect(privateSnapshot(h.host, "private source exception")).toMatchObject({
        state: "ready",
        attempts: 1,
        qualifiedInputs: 0,
        verifiedAnswers: 0,
      });
    }
  );

  it("reserves an authentication event once without allowing later signatures to reuse it", async () => {
    const h = await setup();
    vi.mocked(h.source.qualify).mockImplementation(async (_input, window) =>
      receipt(window, h.f.time, "same-consumed-event")
    );
    expect(await h.host.admitInput(h.input, h.signal.signal, h.window)).not.toBeNull();
    expect(await h.host.admitInput(h.input, h.signal.signal, h.window)).toBeNull();
    expect(h.source.qualify).toHaveBeenCalledTimes(2);
    expect(h.signer.sign).toHaveBeenCalledOnce();
    expect(h.host.snapshot()).toMatchObject({
      state: "ready",
      attempts: 2,
      qualifiedInputs: 1,
      verifiedAnswers: 1,
    });
  });

  it("serializes qualification and limits applicable attempts without evicting history", async () => {
    const h = await setup();
    const pendingReceipt = deferred<QualifiedWorkerHumanInput>();
    let window!: QualificationWindow;
    vi.mocked(h.source.qualify).mockImplementation(async (_input, value) => {
      window = value;
      return pendingReceipt.promise;
    });
    const first = h.host.admitInput(h.input, h.signal.signal, h.window);
    await vi.waitFor(() => expect(h.source.qualify).toHaveBeenCalledOnce());
    const busy = h.host.snapshot();
    expect(busy.inFlight).toBe(true);
    expect(await h.host.admitInput(h.input, h.signal.signal, h.window)).toBeNull();
    expect(h.host.snapshot()).toEqual(busy);
    pendingReceipt.resolve(receipt(window, h.f.time));
    expect(await first).not.toBeNull();
    vi.mocked(h.source.qualify).mockResolvedValue(null);
    for (let index = 1; index < 128; index++)
      expect(await h.host.admitInput(h.input, h.signal.signal, h.window)).toBeNull();
    expect(h.source.qualify).toHaveBeenCalledTimes(128);
    expect(await h.host.admitInput(h.input, h.signal.signal, h.window)).toBeNull();
    expect(h.source.qualify).toHaveBeenCalledTimes(128);
    expect(h.host.snapshot()).toMatchObject({
      state: "attempt_limit",
      attempts: 128,
      qualifiedInputs: 1,
    });
  });

  it.each(["abort", "reconnect", "expire"] as const)(
    "does not enter signing after %s during qualification",
    async (end) => {
      const h = await setup();
      vi.mocked(h.source.qualify).mockImplementation(async (_input, window) => {
        if (end === "abort") h.signal.abort();
        if (end === "reconnect") h.replaceConnection();
        if (end === "expire") h.setTime(h.input.presentation.challenge.expiresAt);
        return receipt(window, h.f.time);
      });
      expect(await h.host.admitInput(h.input, h.signal.signal, h.window)).toBeNull();
      expect(h.signer.sign).not.toHaveBeenCalled();
      expect(h.host.snapshot().state).toBe("ready");
    }
  );

  it("bounds stalled qualification and ignores a valid receipt that arrives after its deadline", async () => {
    const h = await setup();
    h.window.timeoutMs = 20;
    const late = deferred<QualifiedWorkerHumanInput>();
    let window!: QualificationWindow;
    vi.mocked(h.source.qualify).mockImplementation(async (_input, value) => {
      window = value;
      return late.promise;
    });
    expect(await h.host.admitInput(h.input, h.signal.signal, h.window)).toBeNull();
    expect(window.signal.aborted).toBe(true);
    late.resolve(receipt(window, h.f.time));
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.signer.sign).not.toHaveBeenCalled();
    expect(h.host.snapshot()).toMatchObject({ state: "ready", verifiedAnswers: 0 });
  });

  it("shares one monotonic budget across stages while the wall clock stays fixed", async () => {
    const h = await setup();
    const elapsed = vi.spyOn(performance, "now").mockReturnValue(100);
    vi.mocked(h.source.qualify).mockImplementation(async (_input, window) => {
      elapsed.mockReturnValue(100 + h.window.timeoutMs + 1);
      return receipt(window, h.f.time);
    });
    expect(await h.host.admitInput(h.input, h.signal.signal, h.window)).toBeNull();
    expect(h.signer.sign).not.toHaveBeenCalled();
  });

  it.each(["throw", "envelope", "wrong-key", "changed-payload"] as const)(
    "makes possible signing permanently uncertain after %s",
    async (attack) => {
      const h = await setup();
      vi.mocked(h.signer.sign).mockImplementation(async (input) => {
        if (attack === "throw") throw new Error("private signing error");
        if (attack === "envelope")
          return { signature: "A".repeat(86), privateKey: "private canary" };
        const key =
          attack === "wrong-key" ? generateKeyPairSync("ed25519").privateKey : h.f.keys.privateKey;
        const bytes =
          attack === "changed-payload"
            ? Buffer.from(
                Buffer.from(input.canonicalPayload).toString("utf8").replace('"B"', '"A"')
              )
            : input.canonicalPayload;
        return sign(null, bytes, key).toString("base64url");
      });
      expect(await h.host.admitInput(h.input, h.signal.signal, h.window)).toBeNull();
      expect(privateSnapshot(h.host, "private signing error", "private canary")).toMatchObject({
        state: "signing_unconfirmed",
        verifiedAnswers: 0,
        qualifiedInputs: 1,
      });
      expect(await h.host.admitInput(h.input, h.signal.signal, h.window)).toBeNull();
      expect(h.source.qualify).toHaveBeenCalledOnce();
      expect(h.signer.sign).toHaveBeenCalledOnce();
    }
  );

  it.each(["abort", "reconnect", "timeout"] as const)(
    "cannot accept a late valid signature after %s and blocks further attempts",
    async (end) => {
      const h = await setup();
      h.window.timeoutMs = 35;
      const late = deferred<string>();
      let signature = "",
        inner!: AbortSignal;
      vi.mocked(h.signer.sign).mockImplementation(async (input, window) => {
        signature = sign(null, input.canonicalPayload, h.f.keys.privateKey).toString("base64url");
        inner = window.signal;
        if (end === "abort") h.signal.abort();
        if (end === "reconnect") {
          h.replaceConnection();
          return signature;
        }
        return late.promise;
      });
      expect(await h.host.admitInput(h.input, h.signal.signal, h.window)).toBeNull();
      expect(inner.aborted).toBe(true);
      late.resolve(signature);
      await new Promise((resolve) => setImmediate(resolve));
      expect(await h.host.admitInput(h.input, new AbortController().signal, h.window)).toBeNull();
      expect(h.host.snapshot()).toMatchObject({ state: "signing_unconfirmed", verifiedAnswers: 0 });
      expect(h.source.qualify).toHaveBeenCalledOnce();
      expect(h.signer.sign).toHaveBeenCalledOnce();
    }
  );
});

describe("native presentation composition with controlled admission capabilities", () => {
  it.each(["memory", "sqlite"] as const)(
    "retains a %s answer and hold after a lost admission ACK without retrying the human or signer",
    async (kind) => {
      const h = await setup(kind);
      // Replace the setup's already claimed display through explicit close/recovery.
      expect(
        await h.f.service.closeWorkerQuestionPresentation({
          ...(await h.f.mutation("close-first")),
          requestId: h.display.requestId,
          presentationId: h.display.presentationId,
          disposition: "cancelled",
        })
      ).toMatchObject({ ok: true });
      const channel: NativeHumanFormChannel = {
        connection: () => h.window.sourceConnection,
        capabilities: () => ({ elicitation: { form: {} } }),
        request: vi.fn(async () => ({ action: "accept", content: { q0: "B" } })),
      };
      const store = lostAdmissionAck(h.f.store);
      const native = new NativeMcpHumanPresentationHost(
        h.f.serviceFor(store),
        store,
        channel,
        h.host,
        () => h.f.time
      );
      const display = {
        ...h.display,
        ...(await h.f.mutation("recover")),
        previousPresentationId: h.display.presentationId,
        presentationId: randomUUID(),
        challengeId: randomUUID(),
      };
      expect(await native.present(display, h.signal.signal)).toMatchObject({
        status: "reconciliation_required",
        reason: "persistence_or_admission_uncertain",
      });
      if (kind === "sqlite") await h.f.reopen();
      const answer = (await h.f.service.getWorkerAnswer("run", display.requestId))!.answer;
      expect(answer.payload.answers).toEqual([{ questionId: "choice", value: "B" }]);
      expect(h.f.verifier.verify(answer)).toBe(true);
      expect(
        readHumanActionState((await h.f.store.getRunCoordination("run"))!.state).entries[0]
          .presentations
      ).toMatchObject([
        { disposition: "cancelled" },
        { disposition: "answered", challenge: { generation: 2 } },
      ]);
      await h.held();
      const recovered = new NativeMcpHumanPresentationHost(
        h.f.service,
        h.f.store,
        channel,
        h.host,
        () => h.f.time
      );
      expect(await recovered.present(display, h.signal.signal)).toMatchObject({
        status: "reconciliation_required",
        reason: "presentation_already_claimed",
      });
      expect(channel.request).toHaveBeenCalledOnce();
      expect(h.source.qualify).toHaveBeenCalledOnce();
      expect(h.signer.sign).toHaveBeenCalledOnce();
      expect(h.host.snapshot()).toMatchObject({ verifiedAnswers: 1, qualifiedInputs: 1 });
    }
  );
});
