import {
  withOwnedWindowsBoundaryDirectory,
  type OwnedWindowsBoundaryHandshakeOptions,
  type OwnedWindowsDirectoryIdentity,
  type OwnedWindowsDirectoryScope,
  type OwnedWindowsProcessAttempt,
  type OwnedWindowsDirectoryAttempt,
  type OwnedWindowsFileCreationAttempt,
  type WindowsBoundaryHandshakeReport,
} from "./owned-windows-boundary-handshake.js";

export interface OwnedWindowsDirectorySession {
  /** Historical acquisition observation, not a fresh assertion. */
  readonly identity: OwnedWindowsDirectoryIdentity;
  readonly completion: Promise<WindowsBoundaryHandshakeReport>;
  /** Immutable owner-wide history, available during work and after closure. */
  snapshotProcessAttempts(): readonly OwnedWindowsProcessAttempt[];
  snapshotDirectoryAttempts(): readonly OwnedWindowsDirectoryAttempt[];
  snapshotFileCreations(): readonly OwnedWindowsFileCreationAttempt[];
  /** One caller operation at a time; callers must await all scope work. */
  run<T>(work: (scope: OwnedWindowsDirectoryScope) => Promise<T>): Promise<T>;
  /** Stops admitting work, drains the current callback, then awaits owned cleanup. */
  close(): Promise<WindowsBoundaryHandshakeReport>;
}

/**
 * Callback-to-lease lifetime bridge for the forthcoming portable adapter.
 * The existing owner remains responsible for timeouts, native scopes and cleanup.
 * Acquisition or a caller-supplied artifact digest never establishes production readiness.
 */
export function acquireOwnedWindowsDirectorySession(
  options: OwnedWindowsBoundaryHandshakeOptions,
  directory: Parameters<typeof withOwnedWindowsBoundaryDirectory>[1],
  signal?: AbortSignal
): Promise<
  | { readonly ok: true; readonly session: OwnedWindowsDirectorySession }
  | { readonly ok: false; readonly report: WindowsBoundaryHandshakeReport }
> {
  return new Promise((resolve, reject) => {
    let state: "opening" | "open" | "closing" | "closed" = "opening";
    const hasEnded = () => state === "closed";
    let busy = false;
    let entered = false;
    let release!: () => void;
    let failWork!: (error: unknown) => void;
    const lifetime = new Promise<void>((done, fail) => {
      release = done;
      failWork = fail;
    });
    // The owner may finish before entering its callback (including pre-aborted signals).
    const completion = withOwnedWindowsBoundaryDirectory(
      options,
      directory,
      async (scope) => {
        entered = true;
        state = "open";
        const session: OwnedWindowsDirectorySession = Object.freeze({
          identity: scope.identity,
          snapshotProcessAttempts: () => scope.snapshotProcessAttempts(),
          snapshotDirectoryAttempts: () => scope.snapshotDirectoryAttempts(),
          snapshotFileCreations: () => scope.snapshotFileCreations(),
          completion,
          async run<T>(work: (scope: OwnedWindowsDirectoryScope) => Promise<T>): Promise<T> {
            if (state !== "open" || signal?.aborted) throw new Error("directory_session_closed");
            if (busy) throw new Error("directory_session_busy");
            if (typeof work !== "function") throw new Error("invalid_directory_work");
            busy = true;
            try {
              return await Promise.race([
                Promise.resolve().then(() => {
                  if (signal?.aborted) throw new Error("directory_session_ended");
                  return work(scope);
                }),
                completion.then(() => {
                  throw new Error("directory_session_ended");
                }),
              ]);
            } catch (error) {
              if (!hasEnded()) {
                state = "closing";
                failWork(error);
              }
              throw error;
            } finally {
              busy = false;
              if (state === "closing") release();
            }
          },
          close(): Promise<WindowsBoundaryHandshakeReport> {
            if (state === "open") state = "closing";
            if (!busy) release();
            return completion;
          },
        });
        resolve({ ok: true, session });
        await lifetime;
      },
      signal
    );
    void completion.then(
      (report) => {
        state = "closed";
        release();
        if (!entered) resolve({ ok: false, report });
      },
      (error: unknown) => {
        state = "closed";
        release();
        if (!entered) reject(error);
      }
    );
  });
}
