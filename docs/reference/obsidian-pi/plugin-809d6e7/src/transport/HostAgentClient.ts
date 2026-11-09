/**
 * HostAgentClient — M3 of the host-agent relay (plugin side).
 *
 * Registers this Mac's local stdio pi instances (the ones owned by
 * InstanceManager/PtyClient) with the Farm View server as a "host agent",
 * keeps the server's external-session catalogue in sync, and relays the local
 * PTY terminals to remote subscribers (M2 wire contract,
 * feature/farm-view-server @6fa277f3).
 *
 * WIRE CONTRACT (from M2 verification — follow exactly):
 *  - After initialize: `hostAgent.register {deviceName, token?}` → `{hostAgentId}`.
 *    Auth: the shared farm token is passed in initialize params.token (and
 *    register) when set — one trust domain for clients and host agents.
 *  - `hostAgent.syncInstances {instances:[…]}` is a FULL-STATE upsert: new ids
 *    create external sessions, existing ids update, missing ids are removed.
 *    Stable instanceIds → the server reuses the same URIs on reconnect (no churn).
 *  - `startTerminalStream` is a server→host REQUEST: ANY response (result or
 *    error) counts as the ack; a non-acking host gets its sessions greyed after
 *    ~5s. `stopTerminalStream`/`terminalInput`/`terminalResize` are
 *    server→host NOTIFICATIONS (no ack).
 *  - `hostAgent.terminalData/terminalResized/terminalExited` are host→server
 *    REQUESTS (server acks null; non-owned instanceId → -32602).
 *
 * MOBILE SAFETY: this module must NEVER value-import node-pty / child_process /
 * fs / path / os. It reaches the local PTYs via the InstanceManager (desktop-only
 * PtyClient instances already created elsewhere) and uses `import type` for
 * PtyClient/PiInstance. The WebSocket transport (AhpClient) is mobile-safe.
 * Construction happens ONLY on desktop (see main.ts: Platform.isDesktop &&
 * settings.hostAgentEnabled), and the module itself is loaded via a
 * desktop-gated dynamic import so its scope never runs on mobile.
 */

import { AhpClient, type JsonRpcRequest } from './AhpClient';
import { AHP_PROTOCOL_VERSION } from './AhpClient';
import { mapLocalStatus } from './ahpStatus';
import { Notice } from 'obsidian';
import type { InstanceManager, PiInstance } from '../instance/InstanceManager';
import type { PtyClient } from './PtyClient';
import type { AgentEvent } from '../notifications/AgentNotifier';

// The local-status → SessionStatus-bit encoder lives in `./ahpStatus` —
// re-exported here for existing consumers (HostAgentClient.mapLocalStatus).
export { mapLocalStatus } from './ahpStatus';

const HOST_AGENT_PROTOCOL_VERSION = AHP_PROTOCOL_VERSION;

/** Heartbeat cadence. The server's miss window is ~30s — do not skip. */
const HEARTBEAT_INTERVAL_MS = 15_000;

/** Initial connect+register retry schedule (ms): 2s, 4s, 8s, 16s, 30s capped. */
const START_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000];
/** Total initial start attempts (1 immediate + retries after each delay). */
const START_RETRY_ATTEMPTS = START_RETRY_DELAYS_MS.length + 1;

/** Grace window for the teardown unregister request. A dead/unreachable broker
 *  must not stall plugin unload for the full 30s RESPONSE_TIMEOUT_MS — the
 *  request is still sent, but dispose() proceeds after this window. */
const UNREGISTER_GRACE_MS = 3_000;

/** One entry of hostAgent.syncInstances — the full-state announcement. */
export interface HostAgentSyncInstance {
  instanceId: string;
  name: string;
  online: boolean;
  status: number;
  model?: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  turns: number;
  currentAction?: string;
  workingDirectory?: string;
}

export interface HostAgentClientOptions {
  /** WebSocket URL of the Farm View server (settings.ahpServerUrl). */
  url: string;
  /** deviceName announced via hostAgent.register (settings.hostAgentDeviceName). */
  deviceName: string;
  /** Shared farm token (settings.ahpServerToken) — optional. */
  token?: string;
  /** pi version string reported via hostAgent.register (plugin.binaryInfo.version) — optional. */
  piVersion?: string;
  /** Source of the local instances to announce. */
  instanceManager: InstanceManager;
}

/** Map the last observed agent lifecycle event onto a currentAction label. */
export function mapCurrentAction(lastEventType?: AgentEvent['type']): string | undefined {
  switch (lastEventType) {
    case 'start':       return 'running';
    case 'question':    return 'needs-input';
    case 'end':         return 'done';
    case 'error':       return 'error';
    case 'abort':       return 'idle';
    default:            return undefined;
  }
}

export class HostAgentClient extends AhpClient {
  /**
   * InstanceIds currently announced to the server via syncInstances. M4's
   * FarmView local-rows reconcile reads this to dedup local rows against the
   * remote external-session rows.
   */
  readonly announcedIds = new Set<string>();

  /** M4 FarmView local-row reconcile listeners — fired after every successful
   *  syncInstances (and when the set is cleared on dispose). */
  private readonly announcedListeners: Array<() => void> = [];

  private readonly instanceManager: InstanceManager;
  private deviceName: string;
  private token?: string;
  private piVersion?: string;
  private hostAgentId?: string;
  private lastSyncAt?: number;
  private starting = false;
  private disposedFlag = false;
  private startRetryToken?: symbol;

  /**
   * Per-instance cumulative rollups (tokens/cost/turns since this relay
   * started), seeded from every 'end' AgentEvent observed via the stats
   * snapshot diff (a new completed turn ⇒ stats.turns increased).
   */
  private readonly accumulators = new Map<
    string,
    { tokensIn: number; tokensOut: number; cost: number; turns: number }
  >();
  private readonly lastSeenTurns = new Map<string, number>();

  /** Active terminal-tee attachments: per-instance unsubs for onData/onResize/onExit. */
  private readonly tees = new Map<
    string,
    { unsubData: () => void; unsubResize: () => void; unsubExit: () => void }
  >();

  private unsubChanged?: () => void;
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(opts: HostAgentClientOptions) {
    super(`obsidian-pi-host-${globalThis.crypto.randomUUID()}`);
    this.url = opts.url;
    this.instanceManager = opts.instanceManager;
    this.deviceName = opts.deviceName;
    this.token = opts.token;
    this.piVersion = opts.piVersion;
    this.initializeParams = { ...(this.token ? { token: this.token } : {}) };
    // Server→host NOTIFICATIONS (no ack): terminal relay control + input.
    this.onNotification('stopTerminalStream', (p) => this.handleStopTerminalStream(p ?? {}));
    this.onNotification('terminalInput', (p) => this.handleTerminalInput(p ?? {}));
    this.onNotification('terminalResize', (p) => this.handleTerminalResize(p ?? {}));
  }

  /** Server-assigned hostAgentId from hostAgent.register (undefined pre-register). */
  get agentId(): string | undefined {
    return this.hostAgentId;
  }

  /**
   * Subscribe to announcedIds changes (M4 FarmView local-row reconcile). The
   * listener fires after every successful syncInstances and when dispose()
   * clears the set, so the Farm view can re-run its local-row dedup live.
   * Returns an unsubscribe handle.
   */
  onAnnouncedIdsChanged(listener: () => void): () => void {
    this.announcedListeners.push(listener);
    return () => {
      const idx = this.announcedListeners.indexOf(listener);
      if (idx >= 0) this.announcedListeners.splice(idx, 1);
    };
  }

  private notifyAnnouncedChanged(): void {
    for (const l of [...this.announcedListeners]) {
      try {
        l();
      } catch (err) {
        console.error('[HostAgentClient] announcedIds listener error:', err instanceof Error ? err.message : err);
      }
    }
  }

  /** Epoch ms of the last successful syncInstances (undefined until the first sync). */
  get lastSyncAtMs(): number | undefined {
    return this.lastSyncAt;
  }

  /**
   * Connect → initialize → register → sync. Also subscribes to instance
   * changes (every change re-syncs) and starts the heartbeat. Idempotent.
   *
   * The initial connect+register sequence is retried with exponential
   * backoff so transient failures (stale -32602 registrations, WebSocket open
   * errors, timeouts) self-heal without dropping the whole relay.
   */
  async start(): Promise<void> {
    if (this.starting) return;
    if (this.state === 'connected' && this.hostAgentId) return;
    this.starting = true;

    const token = Symbol();
    this.startRetryToken = token;

    this.subscribeInstanceChanges();
    this.startHeartbeat();

    let lastErr: unknown;
    for (let attempt = 1; attempt <= START_RETRY_ATTEMPTS; attempt++) {
      if (this.disposedFlag || this.startRetryToken !== token) {
        this.starting = false;
        return;
      }

      const delay = attempt === 1 ? 0 : START_RETRY_DELAYS_MS[attempt - 2]!;
      if (delay > 0) {
        await this.sleep(delay, token);
      }

      if (this.disposedFlag || this.startRetryToken !== token) {
        this.starting = false;
        return;
      }

      try {
        await this.connect(this.url);
        await this.hostAgentHandshake();
        this.starting = false;
        return;
      } catch (err) {
        if (this.disposedFlag || this.startRetryToken !== token) {
          this.starting = false;
          return;
        }
        lastErr = err;
        const reason = err instanceof Error ? err.message : String(err);
        if (attempt < START_RETRY_ATTEMPTS) {
          const nextDelay = START_RETRY_DELAYS_MS[attempt - 1]!;
          console.warn(
            `[HostAgentClient] register attempt ${attempt} failed: ${reason}; retrying in ${nextDelay / 1000}s`,
          );
        } else {
          console.warn(`[HostAgentClient] register attempt ${attempt} failed: ${reason}; giving up`);
        }
      }
    }

    this.starting = false;
    // Roll back the listeners — the caller drops the client on failure.
    this.unsubChanged?.();
    this.unsubChanged = undefined;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    throw lastErr;
  }

  private sleep(ms: number, token: symbol): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(() => {
        if (this.startRetryToken === token) {
          resolve();
        }
      }, ms);
    });
  }

  /**
   * deviceName/token changed while connected → unregister so the server drops
   * the old registration (and closes the connection); AhpClient's reconnect
   * loop then re-registers with the new identity via onReconnected(). When
   * disconnected, the next reconnect picks up the new identity automatically.
   */
  updateIdentity(deviceName: string, token?: string, piVersion?: string): void {
    if (this.deviceName === deviceName && this.token === token && this.piVersion === piVersion) return;
    this.deviceName = deviceName;
    this.token = token;
    this.piVersion = piVersion;
    this.initializeParams = { ...(this.token ? { token: this.token } : {}) };
    if (this.state === 'connected') {
      this.request('hostAgent.unregister', {}).catch(() => {
        /* offline — the reconnect loop will re-register with the new identity */
      });
    }
  }

  /** Graceful teardown: unregister, detach tees, stop heartbeat, disconnect.
   *  The unregister request is sent but raced against a short grace window —
   *  awaiting the full RESPONSE_TIMEOUT_MS on a dead broker stalled onunload
   *  for up to 30s (AUDIT §3 findings 4/9). A late response/rejection is
   *  swallowed by the race; the result-then-close ordering below is kept. */
  async dispose(): Promise<void> {
    this.disposedFlag = true;
    try {
      await Promise.race([
        this.request('hostAgent.unregister', {}),
        new Promise<void>((resolve) => setTimeout(resolve, UNREGISTER_GRACE_MS)),
      ]);
    } catch {
      /* ws already closed / server unreachable — nothing to unregister */
    }
    this.unsubChanged?.();
    this.unsubChanged = undefined;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    for (const id of [...this.tees.keys()]) this.detachTee(id);
    this.announcedIds.clear();
    this.notifyAnnouncedChanged();
    await super.dispose();
  }

  // ─── Reconnect seam (AhpClient) ────────────────────────────────────────────

  /** After AhpClient's auto-reconnect: re-register + re-sync. Stable
   *  instanceIds → the server reuses the same external URIs (no churn). */
  protected onReconnected(): void {
    void this.hostAgentHandshake().catch((err) => {
      console.warn('[HostAgentClient] post-reconnect handshake failed:', err instanceof Error ? err.message : err);
    });
  }

  // ─── Handshake ─────────────────────────────────────────────────────────────

  private async hostAgentHandshake(): Promise<void> {
    await this.initialize([HOST_AGENT_PROTOCOL_VERSION], this.clientId, this.initializeParams);
    await this.register();
    await this.syncInstances();
  }

  private async register(): Promise<void> {
    const params: Record<string, unknown> = { deviceName: this.deviceName };
    if (this.token) params.token = this.token;
    if (this.piVersion) params.piVersion = this.piVersion;
    const result = (await this.request('hostAgent.register', params)) as
      | { hostAgentId?: unknown }
      | undefined;
    if (result && typeof result.hostAgentId === 'string') {
      this.hostAgentId = result.hostAgentId;
    } else {
      throw new Error('hostAgent.register: server did not return a hostAgentId');
    }
  }

  /**
   * Full-state instance announcement. Recomputes the instance set (skipping the
   * synthetic config.ahp === true entry), sends it, and refreshes announcedIds.
   * Returns the server's sessionUris for the synced instances.
   */
  async syncInstances(): Promise<string[]> {
    const instances = this.computeInstances();
    const result = (await this.request('hostAgent.syncInstances', { instances })) as
      | { sessionUris?: unknown }
      | undefined;
    this.announcedIds.clear();
    for (const inst of instances) this.announcedIds.add(inst.instanceId);
    this.lastSyncAt = Date.now();
    this.notifyAnnouncedChanged();
    return Array.isArray(result?.sessionUris) ? (result.sessionUris as string[]) : [];
  }

  // ─── Instance catalogue (the sync side) ────────────────────────────────────

  private subscribeInstanceChanges(): void {
    if (this.unsubChanged) return;
    this.unsubChanged = this.instanceManager.onChanged(() => {
      this.syncInstances().catch((err) => {
        console.warn('[HostAgentClient] syncInstances failed:', err instanceof Error ? err.message : err);
      });
    });
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.notify('hostAgent.heartbeat', { ts: Date.now() });
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private computeInstances(): HostAgentSyncInstance[] {
    const out: HostAgentSyncInstance[] = [];
    for (const instance of this.instanceManager.all()) {
      if (instance.config.ahp === true) continue; // synthetic AHP-bridge entry
      const id = instance.config.id;
      this.accumulate(instance);
      const acc =
        this.accumulators.get(id) ?? { tokensIn: 0, tokensOut: 0, cost: 0, turns: 0 };
      out.push({
        instanceId: id,
        name: instance.config.name || id,
        online: instance.ptyClient?.state === 'connected',
        status: mapLocalStatus(instance),
        model: instance.stats.model,
        tokensIn: acc.tokensIn,
        tokensOut: acc.tokensOut,
        cost: acc.cost,
        turns: acc.turns,
        currentAction: mapCurrentAction(instance.stats.lastEventType),
        workingDirectory: instance.config.cwd || undefined,
      });
    }
    return out;
  }

  /** Fold a completed turn ('end' ⇒ stats.turns increased) into the accumulator. */
  private accumulate(instance: PiInstance): void {
    const stats = instance.stats;
    if (stats.lastEventType !== 'end' || typeof stats.turns !== 'number') return;
    const prevTurns = this.lastSeenTurns.get(instance.config.id) ?? 0;
    if (stats.turns <= prevTurns) return;
    this.lastSeenTurns.set(instance.config.id, stats.turns);
    const acc =
      this.accumulators.get(instance.config.id) ??
      { tokensIn: 0, tokensOut: 0, cost: 0, turns: 0 };
    acc.turns = stats.turns;
    acc.tokensOut += stats.tokens ?? 0;
    acc.cost += stats.cost ?? 0;
    this.accumulators.set(instance.config.id, acc);
  }

  // ─── Inbound: server→host REQUEST interception (startTerminalStream) ───────

  /** Intercept server→host requests (id + method). Everything else falls
   *  through to the base JSON-RPC handling (responses resolve pending
   *  requests, notifications dispatch to onNotification handlers). */
  protected handleMessage(raw: string): void {
    let msg: {
      jsonrpc?: string;
      id?: unknown;
      method?: unknown;
      params?: Record<string, unknown>;
    };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      console.error('[HostAgentClient] parse error:', raw);
      return;
    }
    if (msg.id !== undefined && msg.id !== null && typeof msg.method === 'string') {
      this.handleHostRequest({
        jsonrpc: '2.0',
        id: msg.id as number,
        method: msg.method,
        params: msg.params ?? {},
      });
      return;
    }
    super.handleMessage(raw);
  }

  private handleHostRequest(req: JsonRpcRequest): void {
    const params = req.params ?? {};
    switch (req.method) {
      case 'startTerminalStream':
        this.handleStartTerminalStream(req.id, params);
        return;
      default:
        this.respondToHost(req.id, null, {
          code: -32601,
          message: `Method not found: ${req.method}`,
        });
    }
  }

  /** Send the ack for a server→host request (ANY response counts as the ack —
   *  a non-acking host gets its sessions greyed after ~5s). The optional
   *  `data` payload is preserved on the wire so remote clients can branch on
   *  structured error data instead of parsing the message string. */
  private respondToHost(
    id: number,
    result: unknown,
    error?: { code: number; message: string; data?: unknown },
  ): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg = error
      ? { jsonrpc: '2.0', id, error }
      : { jsonrpc: '2.0', id, result };
    this.ws.send(JSON.stringify(msg));
  }

  // ─── Terminal tee (M2 relay) — NO extra PTY, passive tee on the local PTY ──

  private handleStartTerminalStream(id: number, params: Record<string, unknown>): void {
    const instanceId = typeof params.instanceId === 'string' ? params.instanceId : '';
    const instance = this.instanceManager.get(instanceId);
    const pty = instance?.ptyClient;

    if (!pty || pty.state !== 'connected') {
      // Error ack — the server counts ANY response as the stream ack, so the
      // session is NOT greyed after the 5s window; we simply don't stream
      // until the local PTY is running. Do NOT spawn a PTY here — the Mac's
      // own terminal lifecycle owns that.
      this.respondToHost(id, null, {
        code: -32000,
        message: `pi terminal '${instanceId}' is not running`,
        data: { instanceId },
      });
      // M4: surface the -32000 locally. The remote Farm View opened a
      // terminal for this instance (session shows online, hostOnline:true) but
      // the local PTY is down, so nothing will stream; the server treats the
      // error ack as a stream ack and sends no further signal to the
      // subscriber. Tell the user here, on the machine that owns the PTY.
      try {
        new Notice(
          `Host terminal not running on ${this.deviceName} — start the pi terminal for '${instanceId}' first`,
          6000,
        );
      } catch {
        /* Obsidian API may not be available in test harnesses */
      }
      return;
    }

    if (this.tees.has(instanceId)) {
      this.respondToHost(id, null); // already streaming — idempotent ack
      return;
    }

    const unsubData = pty.onData((data) => {
      this.request('hostAgent.terminalData', { instanceId, data }).catch(() => {
        /* stream stopped or offline — next start re-attaches */
      });
    });
    const unsubResize = pty.onResize((cols, rows) => {
      this.request('hostAgent.terminalResized', { instanceId, cols, rows }).catch(() => {});
    });
    const unsubExit = pty.onExit((exitCode) => {
      this.request('hostAgent.terminalExited', { instanceId, exitCode }).catch(() => {});
    });
    this.tees.set(instanceId, { unsubData, unsubResize, unsubExit });

    // Report the local PTY size so the subscriber's xterm matches the real one.
    this.request('hostAgent.terminalResized', {
      instanceId,
      cols: pty.cols,
      rows: pty.rows,
    }).catch(() => {});

    this.respondToHost(id, null);
  }

  private detachTee(instanceId: string): void {
    const tee = this.tees.get(instanceId);
    if (!tee) return;
    try { tee.unsubData(); } catch { /* ignore */ }
    try { tee.unsubResize(); } catch { /* ignore */ }
    try { tee.unsubExit(); } catch { /* ignore */ }
    this.tees.delete(instanceId);
  }

  /** stopTerminalStream (server→host NOTIFICATION): detach the tee. The local
   *  PTY STAYS ALIVE — the Mac's own terminal is unaffected. */
  private handleStopTerminalStream(params: Record<string, unknown>): void {
    const instanceId = typeof params.instanceId === 'string' ? params.instanceId : '';
    this.detachTee(instanceId);
  }

  /** terminalInput (server→host NOTIFICATION): forward keystrokes to the local PTY. */
  private handleTerminalInput(params: Record<string, unknown>): void {
    const instanceId = typeof params.instanceId === 'string' ? params.instanceId : '';
    const data = typeof params.data === 'string' ? params.data : '';
    if (data === '') return;
    const pty: PtyClient | undefined = this.instanceManager.get(instanceId)?.ptyClient ?? undefined;
    pty?.write(data); // no-op if the local PTY is gone — best-effort
  }

  /** terminalResize (server→host NOTIFICATION): resize the local PTY (best-effort). */
  private handleTerminalResize(params: Record<string, unknown>): void {
    const instanceId = typeof params.instanceId === 'string' ? params.instanceId : '';
    const cols = params.cols;
    const rows = params.rows;
    if (typeof cols !== 'number' || typeof rows !== 'number') return;
    const pty: PtyClient | undefined = this.instanceManager.get(instanceId)?.ptyClient ?? undefined;
    pty?.resize(cols, rows);
  }
}
