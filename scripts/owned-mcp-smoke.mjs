/** Observe release of a smoke fixture's own stdio server, using only public SDK APIs. */
export function ownMcpConnection(client, transport, { fixtureRoot, closeTimeoutMs = 10_000 }) {
  let resolveProcessClosed;
  const processClosed = new Promise((resolve) => {
    resolveProcessClosed = resolve;
  });
  let connectAttempted = false;
  let closing;
  const connection = {
    client,
    transport,
    closed: false,
    ownedProcessClosed: false,
    ownedProcessId: null,
    async connect(timeoutMs = 15_000) {
      connectAttempted = true;
      const pending = client.connect(transport);
      capturePid();
      try {
        await boundedSmoke(pending, timeoutMs, "owned MCP transport connect");
      } finally {
        capturePid();
      }
    },
    async close() {
      if (connection.closed) return;
      if (closing) return closing;
      capturePid();
      closing = (async () => {
        try {
          await boundedSmoke(
            Promise.all([
              Promise.resolve().then(() => client.close()),
              connectAttempted ? processClosed : Promise.resolve(),
            ]),
            closeTimeoutMs,
            "owned MCP process close"
          );
          connection.closed = true;
        } catch (cause) {
          throw uncertainSmokeCleanup(fixtureRoot, cause, connection);
        } finally {
          closing = undefined;
        }
      })();
      return closing;
    },
  };

  // Register before Client.connect wraps this callback. In the locked stdio SDK,
  // transport.onclose originates at the spawned ChildProcess `close` event.
  // client.onclose, transport.pid === null and close() resolution are not proof.
  const previousClose = transport.onclose;
  transport.onclose = () => {
    connection.ownedProcessClosed = true;
    resolveProcessClosed();
    previousClose?.();
  };
  return connection;

  function capturePid() {
    if (typeof transport.pid === "number") connection.ownedProcessId = transport.pid;
  }
}

/** Stop admission before recovering lost acknowledgements; never restart a producer. */
export async function drainGateOperationFixtures({
  fixtures,
  connections,
  release,
  recoverHandle,
  observeTerminal,
  fixtureRoot,
  failure,
}) {
  const errors = [];
  for (const current of fixtures) {
    for (const name of current.gates) {
      try {
        release(current, name);
      } catch (error) {
        errors.push(error);
      }
    }
  }
  const closed = await Promise.allSettled([...connections].map((connection) => connection.close()));
  const uncertainAdmission = closed.find(({ status }) => status === "rejected");
  if (uncertainAdmission) {
    // A timed-out start could still publish its descriptor. Do not recover once
    // and delete the fixture while that admission process remains unobserved.
    throw uncertainSmokeCleanup(
      fixtureRoot,
      failure ?? uncertainAdmission.reason,
      uncertainAdmission.reason
    );
  }
  for (const current of fixtures) {
    try {
      recoverHandle(current);
    } catch (error) {
      errors.push(error);
    }
  }
  const observed = await Promise.allSettled(
    fixtures.filter((current) => current.handle).map((current) => observeTerminal(current.handle))
  );
  for (const result of observed) {
    if (result.status === "rejected") errors.push(result.reason);
  }
  if (errors.length) throw uncertainSmokeCleanup(fixtureRoot, failure ?? errors[0]);
}

export async function drainBlockingGateFixtures({
  connections,
  unresolvedProducers,
  fixtureRoot,
  failure,
}) {
  const cleanup = await Promise.allSettled([...connections].map((current) => current.close()));
  const uncertain = cleanup.find(({ status }) => status === "rejected");
  if (uncertain) {
    throw uncertainSmokeCleanup(fixtureRoot, failure ?? uncertain.reason, uncertain.reason);
  }
  if (unresolvedProducers.size) {
    // Server closure stops further admission, but cannot prove release of
    // command descendants whose blocking producer outcome was never received.
    throw uncertainSmokeCleanup(
      fixtureRoot,
      failure ?? new Error("A blocking gate producer outcome remains unobserved")
    );
  }
}

export function uncertainSmokeCleanup(fixtureRoot, cause, connection) {
  const error = new Error(`Packed smoke cleanup was not confirmed; retain ${fixtureRoot}`, {
    cause,
  });
  error.resourceRelease = "uncertain";
  error.retainedFixtureRoot = fixtureRoot;
  if (connection) {
    error.ownedProcessClosed = connection.ownedProcessClosed;
    error.ownedProcessId = connection.ownedProcessId;
  }
  return error;
}

export async function boundedSmoke(operation, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + " exceeded its deadline")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
