/**
 * SubprocessLifecycle — the shared subprocess state machine.
 *
 * RpcClient and PtyClient both drive the same lifecycle: a 5-value state set
 * with listener registration, the same crash-restart backoff schedule, the
 * same graceful-kill (SIGTERM → grace → SIGKILL) dance, and a dispose-guard
 * that stops recovery timers after permanent teardown. PtyClient's header
 * used to admit it "mirrors RpcClient" — the logic lives here now, exactly
 * once, parametrized by the concrete spawn callback.
 *
 * The `connectPromise` bookkeeping (Slice D fix for the connect race) is part
 * of the shared machine: callers arriving while a connect/crash-recovery
 * spawn is in flight join the SAME promise instead of spawning a second
 * subprocess.
 */

// ─── Shared constants ───────────────────────────────────────────────────────

/** Graceful-stop window: SIGTERM, then SIGKILL after this delay. */
export const STOP_GRACEFUL_MS = 1_000;

/** Back-off for crash recovery: 1 s, 2 s, 4 s, 8 s (cap at 4 retries before giving up). */
export const RESTART_DELAYS_MS = [1_000, 2_000, 4_000, 8_000];

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Lifecycle states shared by RpcClient and PtyClient.
 * (`RpcClientState` / `PtyClientState` alias this — their public names and
 * values are unchanged.)
 */
export type SubprocessState =
  | 'disconnected' | 'connecting' | 'connected' | 'crashed' | 'reconnecting';

export type SubprocessStateListener = (state: SubprocessState, error?: Error) => void;

/** Spawn callback: start (or restart) the subprocess and resolve when it is
 *  connected; reject if the spawn failed. Provided by the owning client. */
export type SubprocessSpawner = () => Promise<void>;

// ─── Lifecycle machine ──────────────────────────────────────────────────────

export class SubprocessLifecycle {
  private _state: SubprocessState = 'disconnected';
  private stateListeners: SubprocessStateListener[] = [];
  private restartAttempt = 0;
  private disposed = false;

  /** In-flight connect/spawn promise — lets racing connect() callers await
   *  the SAME handshake instead of short-circuiting with a resolved no-op
   *  while the subprocess is still half-started (orphaned subprocess hazard). */
  connectPromise: Promise<void> | null = null;

  get state(): SubprocessState { return this._state; }
  get isDisposed(): boolean { return this.disposed; }

  /** Transition the lifecycle state and notify listeners. Public because the
   *  owning client drives a few transitions itself (dispose → 'disconnected'). */
  setState(next: SubprocessState, error?: Error): void {
    if (this._state === next) return;
    this._state = next;
    for (const l of this.stateListeners) l(next, error);
  }

  /** Subscribe to lifecycle state changes. Returns an unsubscribe function. */
  onStateChange(listener: SubprocessStateListener): () => void {
    this.stateListeners.push(listener);
    return () => { this.stateListeners = this.stateListeners.filter(l => l !== listener); };
  }

  /**
   * Spawn the subprocess and wait until it is ready. Idempotent: no-op if
   * already connected; while a connect/spawn is in flight ('connecting', or a
   * crash-recovery spawn) callers join the SAME in-flight promise instead of
   * returning early or spawning a second child.
   */
  async connect(spawn: SubprocessSpawner): Promise<void> {
    if (this._state === 'connected') return;
    if (this._state === 'connecting') {
      // Join the in-flight handshake. Returning a resolved no-op here made
      // racing reconnects proceed against a half-started subprocess.
      if (this.connectPromise) return this.connectPromise;
      return;
    }
    if (this._state === 'reconnecting' && this.connectPromise) {
      // A crash-recovery spawn is pending — join it rather than racing it.
      return this.connectPromise;
    }
    this.disposed = false;
    this.restartAttempt = 0;
    const p = Promise.resolve(spawn()).finally(() => { this.connectPromise = null; });
    this.connectPromise = p;
    await p;
  }

  /** Mark the subprocess connected and reset the restart backoff counter. */
  markConnected(): void {
    // Listeners may read the restart attempt before it is cleared, so the
    // state transition happens first.
    this.setState('connected');
    this.restartAttempt = 0;
  }

  /** Permanently dispose: future recovery timers become no-ops. */
  markDisposed(): void {
    this.disposed = true;
  }

  /** Drop all state listeners — used by dispose paths that must not emit a
   *  final transition notification (PtyClient.dispose historically silenced it). */
  clearStateListeners(): void {
    this.stateListeners = [];
  }

  /**
   * Schedule a crash-recovery spawn with exponential backoff. After
   * {@link RESTART_DELAYS_MS.length} attempts the state becomes 'crashed' and
   * no further restarts are scheduled. The spawn runs through the same
   * connectPromise tracking as a normal connect, so a racing connect() joins
   * the recovery spawn instead of duplicating it.
   */
  scheduleRestart(cause: Error, spawn: SubprocessSpawner): void {
    if (this.restartAttempt >= RESTART_DELAYS_MS.length) {
      this.setState('crashed', cause);
      return;
    }

    this.setState('reconnecting', cause);
    const delay = RESTART_DELAYS_MS[this.restartAttempt++];

    setTimeout(async () => {
      if (this.disposed) return;
      // Track the recovery spawn so a racing connect() joins it instead of
      // spawning a second (orphaned) subprocess.
      const p = Promise.resolve(spawn()).finally(() => { this.connectPromise = null; });
      this.connectPromise = p;
      try {
        await p;
      } catch (err) {
        this.scheduleRestart(err instanceof Error ? err : new Error(String(err)), spawn);
      }
    }, delay);
  }
}

// ─── Graceful kill ──────────────────────────────────────────────────────────

export interface GracefulKillTarget {
  /** Register a callback fired when the process exits (may fire before kill). */
  onExit(cb: () => void): void;
  /** Send a signal to the process. May throw if the process is already dead. */
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}

/**
 * SIGTERM the process, wait up to {@link STOP_GRACEFUL_MS} for it to exit,
 * then SIGKILL and resolve. Resolves early on exit — the full grace window is
 * never burned when the process dies promptly.
 */
export function gracefulKill(target: GracefulKillTarget, graceMs = STOP_GRACEFUL_MS): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try { target.onExit(finish); } catch { /* already dead */ }
    try {
      target.kill('SIGTERM');
    } catch { finish(); return; }
    setTimeout(() => {
      try { target.kill('SIGKILL'); } catch { /* fine */ }
      finish();
    }, graceMs);
  });
}