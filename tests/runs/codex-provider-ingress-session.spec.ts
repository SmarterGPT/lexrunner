import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexProviderIngressSession } from "../../src/runs/codex-provider-ingress-session.js";
import { computeCanonicalHash } from "../../src/schemas/task-contract.js";

type Authorization = ReturnType<CodexProviderIngressSession["authorize"]>;
const sessions: CodexProviderIngressSession[] = [];
const header = "x-lexrunner-provider-session";

afterEach(() => {
  for (const session of sessions.splice(0)) session.revoke();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function allocated(ttlMs = 10000, runId = "run") {
  const session = new CodexProviderIngressSession({ runId }, { ttlMs });
  sessions.push(session);
  return session;
}

function bound(ttlMs = 10000, runId = "run") {
  const session = allocated(ttlMs, runId);
  const connectionId = randomUUID();
  const environment = session.claimChildEnvironment(connectionId);
  return { session, connectionId, token: environment.LEXRUNNER_PROVIDER_SESSION };
}

/** Authorizes a genuine IncomingMessage on loopback without launching any child. */
async function authorize(
  session: CodexProviderIngressSession,
  headers: readonly string[] = []
): Promise<Authorization> {
  let accept!: (value: Authorization) => void;
  let decline!: (error: unknown) => void;
  const result = new Promise<Authorization>((resolve, reject) => {
    accept = resolve;
    decline = reject;
  });
  const server = createServer((incoming: IncomingMessage, response) => {
    try {
      const didRead = incoming.readableDidRead;
      const authorized = session.authorize(incoming);
      // Authorization must leave the body available to the actual observer.
      expect(incoming.readableDidRead).toBe(didRead);
      accept(authorized);
    } catch (error) {
      decline(error);
    } finally {
      incoming.resume();
      response.end();
    }
  });
  let client: ReturnType<typeof httpRequest> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    client = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/v1/responses",
        // Raw outgoing pairs preserve duplicate names through Node's server
        // parser; tests must not normalize a duplicate into a single entry.
        headers: ["Host", "127.0.0.1:" + port, "Content-Type", "application/json", ...headers],
      },
      (response) => response.resume()
    );
    client.on("error", () => undefined);
    client.end("{}");
    return await result;
  } finally {
    client?.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function privateReport(value: unknown, token: string) {
  const encoded = JSON.stringify(value);
  expect(encoded).not.toContain(token);
  expect(encoded).not.toContain("LEXRUNNER_PROVIDER_SESSION");
  expect(encoded).not.toContain("x-lexrunner-provider-session");
}

describe("Codex provider ingress session", () => {
  it("allocates without authorizing or claiming an intended child", async () => {
    const session = allocated();
    expect(session.snapshot()).toMatchObject({
      bindingHash: null,
      state: "allocated",
      credentialPossessionVerified: false,
      intendedChildQualified: false,
      sourceAuthenticated: false,
    });
    expect(session.snapshot().sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
    );
    expect(session.signal.aborted).toBe(false);
    expect(session.matchesBinding({ runId: "run", connectionId: randomUUID() })).toBe(false);
    expect(await authorize(session, [header, "A".repeat(43)])).toBeNull();
    expect(session.snapshot().state).toBe("allocated");
  });

  it("exports one fixed child environment entry and pins an exact transport binding", () => {
    const { session, connectionId, token } = bound();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(Buffer.from(token, "base64url").toString("base64url")).toBe(token);
    expect(session.snapshot()).toMatchObject({
      bindingHash: computeCanonicalHash({ runId: "run", connectionId }),
      state: "bound",
      credentialPossessionVerified: false,
      intendedChildQualified: false,
      sourceAuthenticated: false,
    });
    expect(session.matchesBinding({ runId: "run", connectionId })).toBe(true);
    expect(session.matchesBinding({ runId: "another-run", connectionId })).toBe(false);
    expect(session.matchesBinding({ runId: "run", connectionId: randomUUID() })).toBe(false);
    try {
      session.claimChildEnvironment(connectionId);
      throw new Error("unexpected second claim");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(token);
      expect((error as Error).message).not.toBe("unexpected second claim");
    }
    privateReport(session.snapshot(), token);
  });

  it("snapshots the host run binding before caller mutation", () => {
    const binding = { runId: "original-run" };
    const session = new CodexProviderIngressSession(binding, { ttlMs: 10000 });
    sessions.push(session);
    binding.runId = "changed";
    const connectionId = randomUUID();
    session.claimChildEnvironment(connectionId);
    expect(session.matchesBinding({ runId: "original-run", connectionId })).toBe(true);
    expect(session.matchesBinding(binding as never)).toBe(false);
    expect(session.snapshot().bindingHash).toBe(
      computeCanonicalHash({ runId: "original-run", connectionId })
    );
  });

  it.each(["x-lexrunner-provider-session", "X-LexRunner-Provider-Session"])(
    "recognizes one exact credential using header name %s",
    async (name) => {
      const { session, connectionId, token } = bound();
      const result = await authorize(session, [name, token]);
      expect(result).toEqual({
        sessionId: session.snapshot().sessionId,
        bindingHash: computeCanonicalHash({ runId: "run", connectionId }),
        credentialPossessionVerified: true,
      });
      privateReport(result, token);
      expect(session.snapshot()).toMatchObject({
        credentialPossessionVerified: false,
        intendedChildQualified: false,
        sourceAuthenticated: false,
      });
    }
  );

  it.each([
    "missing",
    "wrong",
    "short",
    "padding",
    "non-url-alphabet",
    "inner-whitespace",
    "comma-folded",
    "other-header",
    "uncanonical-tail",
  ] as const)("refuses a %s observable credential without retaining it", async (failure) => {
    const { session, token } = bound();
    let values: string[] = [header, token];
    if (failure === "missing") values = [];
    else if (failure === "other-header") values = ["Authorization", "Bearer " + token];
    else if (failure === "wrong")
      values = [header, token[0] === "A" ? "B" + token.slice(1) : "A" + token.slice(1)];
    else if (failure === "short") values = [header, token.slice(0, -1)];
    else if (failure === "padding") values = [header, token + "="];
    else if (failure === "non-url-alphabet") values = [header, "+" + token.slice(1)];
    else if (failure === "inner-whitespace")
      values = [header, token.slice(0, 20) + " " + token.slice(20)];
    else if (failure === "comma-folded") values = [header, token + ", " + token];
    else {
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      // Preserve the decoded bytes while changing unused low bits: decoding alone
      // is insufficient to establish canonical base64url representation.
      values = [
        header,
        token.slice(0, -1) + alphabet[alphabet.indexOf(token[token.length - 1]!) + 1],
      ];
    }
    expect(await authorize(session, values)).toBeNull();
    expect(session.snapshot().state).toBe("bound");
    privateReport(session.snapshot(), token);
    expect(await authorize(session, [header, token])).toMatchObject({
      credentialPossessionVerified: true,
    });
  });

  it.each([
    ["x-lexrunner-provider-session", "x-lexrunner-provider-session"],
    ["X-LexRunner-Provider-Session", "x-lexrunner-provider-session"],
  ])(
    "refuses duplicate raw headers %s and %s even when their values agree",
    async (first, second) => {
      const { session, token } = bound();
      expect(await authorize(session, [first, token, second, token])).toBeNull();
      expect(session.snapshot().state).toBe("bound");
      expect(await authorize(session, [header, token])).not.toBeNull();
    }
  );

  it("keeps credentials and transport/session identities isolated", async () => {
    const first = bound();
    const second = bound();
    expect(first.token).not.toBe(second.token);
    expect(first.session.snapshot().sessionId).not.toBe(second.session.snapshot().sessionId);
    expect(first.session.snapshot().bindingHash).not.toBe(second.session.snapshot().bindingHash);
    expect(await authorize(first.session, [header, second.token])).toBeNull();
    expect(await authorize(second.session, [header, first.token])).toBeNull();
    expect(await authorize(first.session, [header, first.token])).not.toBeNull();
    expect(await authorize(second.session, [header, second.token])).not.toBeNull();
  });

  it("expires on finite elapsed time despite a wall-clock rollback", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { session, token } = bound(20);
    vi.setSystemTime(Date.now() - 24 * 60 * 60 * 1000);
    await new Promise<void>((resolve) => setTimeout(resolve, 35));
    expect(await authorize(session, [header, token])).toBeNull();
    expect(session.snapshot().state).toBe("expired");
    expect(session.signal.aborted).toBe(true);
    expect(session.matchesBinding({ runId: "run", connectionId: randomUUID() })).toBe(false);
    privateReport(session.snapshot(), token);
  });

  it("refuses child export after an allocated session expires", async () => {
    const session = allocated(5);
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    expect(() => session.claimChildEnvironment(randomUUID())).toThrow();
    expect(session.snapshot().state).toBe("expired");
    expect(session.signal.aborted).toBe(true);
  });

  it.each(["allocated", "bound"] as const)(
    "revokes a %s session permanently and idempotently",
    async (state) => {
      const session = allocated();
      const connectionId = randomUUID();
      const token =
        state === "bound"
          ? session.claimChildEnvironment(connectionId).LEXRUNNER_PROVIDER_SESSION
          : "A".repeat(43);
      const signal = session.signal;
      session.revoke();
      session.revoke();
      expect(session.signal).toBe(signal);
      expect(signal.aborted).toBe(true);
      expect(session.snapshot().state).toBe("revoked");
      expect(session.matchesBinding({ runId: "run", connectionId })).toBe(state === "bound");
      expect(await authorize(session, [header, token])).toBeNull();
      expect(() => session.claimChildEnvironment(randomUUID())).toThrow();
      privateReport(session.snapshot(), token);
    }
  );

  it.each([0, 900001, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid finite TTL %s",
    (ttlMs) => expect(() => new CodexProviderIngressSession({ runId: "run" }, { ttlMs })).toThrow()
  );

  it.each(["", "x".repeat(513)])("rejects invalid run binding of length %s", (runId) => {
    expect(() => new CodexProviderIngressSession({ runId }, { ttlMs: 10000 })).toThrow();
  });

  it("bounds exported state and permits the maximum supported finite TTL", () => {
    const session = allocated(900000);
    const connectionId = randomUUID();
    const environment = session.claimChildEnvironment(connectionId);
    expect(Object.keys(environment)).toEqual(["LEXRUNNER_PROVIDER_SESSION"]);
    expect(Buffer.byteLength(JSON.stringify(session.snapshot()), "utf8")).toBeLessThan(1024);
    privateReport(session.snapshot(), environment.LEXRUNNER_PROVIDER_SESSION);
  });
});
