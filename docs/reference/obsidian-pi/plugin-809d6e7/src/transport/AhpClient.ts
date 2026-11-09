/**
 * AhpClient — WebSocket JSON-RPC 2.0 transport for the AHP protocol.
 *
 * Uses the *global* `WebSocket` and `crypto.randomUUID()` so it runs in
 * Obsidian's Electron renderer without adding a runtime dependency on the
 * `ws` npm package.  Implements the shared `PiClient` interface so the AHP
 * terminal adapter (AhpTerminalAdapter) consumes a remote AHP session through
 * the same event/render path as a local
 * RPC session.
 *
 * Wire shapes mirror the proven pi-ahp-thin-client (src/client.ts).  Incoming
 * `action` notifications are adapted through AhpActionMapper into the plugin's
 * existing RpcEvent shape.
 */

import type {
  PiClient,
  PiClientState,
  PiEventListener,
  PiStateListener,
} from './RpcClient';
import type {
  RpcEvent,
  RpcSlashCommand,
  ImageContent,
} from '../types/rpc';
import { mapAhpAction } from './AhpActionMapper';
import { AhpError } from './AhpError';
import { DEFAULT_AHP_SERVER_URL } from '../constants';
import { Notice } from 'obsidian';

export type URI = string;

export interface ChatOrigin {
  kind: 'user' | 'tool';
  toolCallId?: string;
  parentChat?: URI;
}

/**
 * Lightweight chat entry surfaced in a session snapshot, kept live by
 * session/chat* notifications.  The `origin` field distinguishes subagent
 * child chats (origin.kind === 'tool').
 */
export interface ChatSummary {
  resource: URI;
  title?: string;
  status?: number;
  origin?: ChatOrigin;
  model?: string;
  modelProvider?: string;
  tokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cost?: number;
  turns?: number;
  currentAction?: string;
  modifiedAt?: string;
  workingDirectory?: URI;
  [key: string]: unknown;
}

export interface ActionOrigin {
  clientId: string;
  clientSeq: number;
}

/** Per-session chat subscriber state (see subscribeSessionChats). */
interface SessionChatSub {
  /** Last known chat list for the session (all origins; tool chats are filtered on notify). */
  snapshot: ChatSummary[];
  listeners: Array<(chats: ChatSummary[]) => void>;
  /** Apply a broker `session/chat*` action envelope for this session channel. */
  applyChatAction(action: Record<string, unknown>): void;
}

export interface ActionEnvelope {
  channel: URI;
  action: Record<string, unknown>;
  serverSeq: number;
  origin: ActionOrigin;
  rejectionReason?: string;
}

/**
 * Minimal surface the AHP terminal adapter needs from a client. Extends the
 * generic PiClient so chat-mode calls (prompt) keep working while adding the
 * AHP-specific action helpers used in terminal (PTY) mode.
 */
export interface AhpTerminalApi extends PiClient {
  clientId: string;
  dispatchAction(channel: URI, action: Record<string, unknown>): { clientSeq: number };
  onNotification(method: string, handler: NotificationHandler): () => void;
  subscribe(channel: URI, command?: string): Promise<Record<string, unknown>>;
  sendTerminalInput(terminalUri: URI, data: string): void;
  resizeTerminal(terminalUri: URI, cols: number, rows: number): void;
}

/**
 * Lightweight catalog entry for one AHP session, surfaced on the root channel
 * via `listSessions` and kept live by `root/sessionAdded` /
 * `root/sessionRemoved` / `root/sessionSummaryChanged` notifications.
 *
 * Only the fields the thin-client cares about are typed; the index signature
 * forwards provider-defined extras (`changes`, `_meta`, …) untouched.
 */
export interface SessionSummary {
  resource: URI;
  title: string;
  status: number;
  provider?: string;
  terminalMode?: 'server-spawned' | 'external';
  activity?: string;
  createdAt?: string;
  modifiedAt?: string;
  workingDirectory?: URI;
  /** Rollup fields pushed by the server via `sessionSummaryChanged` changes. */
  model?: string;
  modelProvider?: string;
  tokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cost?: number;
  turns?: number;
  currentAction?: string;
  childChatCount?: number;
  waitingOnCount?: number;
  /** Scheduler state: pause-between-turns and per-session priority. */
  paused?: boolean;
  priority?: number;
  /** Session taxonomy (M1 wire contract): 'hosted' (server-spawned agent
   *  backend), 'external' (registered by a host agent via syncInstances), or
   *  'relay' (provider-less archive/echo). Absent on older servers. */
  kind?: 'hosted' | 'external' | 'relay' | 'archive';
  /** Server-assigned id of the owning host agent (kind === 'external'). */
  hostAgentId?: string;
  /** Human-readable device name of the owning host agent (kind === 'external'). */
  hostAgentName?: string;
  /** pi version string reported by the owning host agent at register. */
  piVersion?: string;
  /** Live-connection flag for external sessions: false when the host agent's
   *  WS is closed or its heartbeats are missed (catalogue shows it greyed).
   *  Undefined for non-external sessions. */
  hostOnline?: boolean;
  /** URI of the parent session that spawned this one via the subagent tool
   *  (`ahp-session:/…`). Absent-key when undefined: a missing key means
   *  top-level (never fall back to ''). The server includes it in
   *  `root/sessionAdded` summaries and `listSessions` items, but NOT in
   *  `sessionSummaryChanged.changes` (the diff baseline is seeded with it at
   *  creation), so only full-summary paths carry it — after a server restart
   *  consumers must re-fetch via `listSessions` to rebuild the nesting tree.
   *  Relay sessions (provider pi-ahp-server) carry it too. */
  parentSessionUri?: string;
  [key: string]: unknown;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type NotificationHandler = (params: Record<string, unknown>) => void;

/** The AHP wire-protocol version this client speaks. Single source of truth —
 *  every initialize() call site (AhpClient, HostAgentClient, swarmDispatch,
 *  main.ts) derives from this constant. */
export const AHP_PROTOCOL_VERSION = '0.3.0';
const SUPPORTED_PROTOCOL_VERSION = AHP_PROTOCOL_VERSION;
const RESPONSE_TIMEOUT_MS = 30_000;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_MAX_ATTEMPTS = 10;

export class AhpClient implements PiClient, AhpTerminalApi {
  protected ws?: WebSocket;
  private nextId = 1;
  private nextClientSeq = 1;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private handlers = new Map<string, NotificationHandler[]>();
  private lastServerSeq = new Map<URI, number>();

  private _state: PiClientState = 'disconnected';
  private stateListeners: PiStateListener[] = [];
  private eventListeners: PiEventListener[] = [];

  public clientId: string;
  protected url = DEFAULT_AHP_SERVER_URL;
  /** Extra params merged into every `initialize` call (e.g. `{ token }` for
   *  token-authenticated servers). HostAgentClient sets this before connecting
   *  so both the initial handshake AND AhpClient's auto-reconnect carry auth. */
  protected initializeParams: Record<string, unknown> = {};
  private sessionUri?: URI;
  private chatUri?: URI;

  /** Root-channel session catalogue, keyed by session URI. Seeded from the
   *  `ahp-root://` subscribe snapshot (when the server includes sessions) and
   *  `listSessions`, then kept live by `root/session*` notifications. */
  private sessions = new Map<URI, SessionSummary>();
  /** Subscribers that want live catalogue snapshots (e.g. FarmView). */
  private catalogListeners: Array<(sessions: SessionSummary[]) => void> = [];
  /** Per-session chat subscribers, used by FarmView to render nested subagent rows. */
  private sessionChatSubs = new Map<URI, SessionChatSub>();
  /** Terminal channel URIs (`ahp-terminal:`) subscribed by the attach flows.
   *  The server drops ALL WS-scoped subscriptions on disconnect, so these are
   *  re-subscribed on reconnect (via the reconnect endpoint's snapshot mode) to
   *  resume streaming into open AHP terminal views. Add-only: the AHP protocol
   *  has no channel unsubscribe and the plugin keeps one client for its
   *  lifetime. */
  private terminalSubs = new Set<URI>();
  /** True once `subscribeRoot()` has successfully wired root handlers. */
  private rootSubscribed = false;

  get isRootSubscribed(): boolean {
    return this.rootSubscribed;
  }
  /** Lightweight active-session count from `root/activeSessionsChanged`. */
  private activeSessionCount?: number;
  /** Unsubscribe handle for the root-channel notification handlers. */
  private unsubRoot?: () => void;

  private disposed = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;

  private lastUsage: {
    input: number;
    output: number;
    cacheRead: number;
    model: string;
  } | null = null;

  constructor(clientId?: string) {
    this.clientId = clientId ?? globalThis.crypto.randomUUID();
  }

  // ─── PiClient interface: state ─────────────────────────────────────────────

  get state(): PiClientState {
    return this._state;
  }

  /** URI of the active AHP session, once createSession() succeeds. */
  getSessionUri(): URI | undefined {
    return this.sessionUri;
  }

  /** URI of the active AHP chat, once createChat() succeeds. */
  getChatUri(): URI | undefined {
    return this.chatUri;
  }

  private setState(next: PiClientState, error?: Error): void {
    if (this._state === next) return;
    this._state = next;
    for (const l of this.stateListeners) l(next, error);
  }

  // ─── PiClient interface: subscriptions ─────────────────────────────────────

  onEvent(listener: PiEventListener): () => void {
    this.eventListeners.push(listener);
    return () => {
      this.eventListeners = this.eventListeners.filter((l) => l !== listener);
    };
  }

  onStateChange(listener: PiStateListener): () => void {
    this.stateListeners.push(listener);
    return () => {
      this.stateListeners = this.stateListeners.filter((l) => l !== listener);
    };
  }

  // ─── AHP lifecycle ─────────────────────────────────────────────────────────

  /**
   * Open the WebSocket.  Accepts an optional URL so it satisfies the shared
   * `connect()` signature while the plugin can still pass a concrete server URL.
   */
  connect(url?: string): Promise<void> {
    if (this._state === 'connected') return Promise.resolve();
    if (this._state === 'connecting' && this.ws) return Promise.resolve();
    if (url) this.url = url;
    this.disposed = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    this.setState('connecting');
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        this.setState('crashed', e);
        reject(e);
        return;
      }

      let opened = false;

      this.ws.onopen = () => {
        opened = true;
        this.setState('connected');
        resolve();
      };

      this.ws.onmessage = (event: MessageEvent<unknown>) => {
        const raw = typeof event.data === 'string' ? event.data : String(event.data ?? '');
        this.handleMessage(raw);
      };

      this.ws.onerror = (_event: Event) => {
        if (!opened) {
          this.setState('crashed', new Error('WebSocket error'));
          reject(new Error('WebSocket error'));
        }
      };

      this.ws.onclose = (_event: CloseEvent) => {
        if (!opened && this._state === 'connecting') {
          reject(new Error('WebSocket closed before open'));
        }
        this.onDisconnect();
      };

      // Safety net in case the browser/engine never fires any event.
      setTimeout(() => {
        if (!opened && this._state === 'connecting') {
          this.ws?.close();
          this.setState('crashed', new Error('WebSocket open timeout'));
          reject(new Error('WebSocket open timeout'));
        }
      }, RESPONSE_TIMEOUT_MS);
    });
  }

  dispose(): Promise<void> {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.ws?.close();
    this.onDisconnect();
    return Promise.resolve();
  }

  close(): void {
    this.ws?.close();
  }

  private onDisconnect(): void {
    const wasConnected = this._state === 'connected';
    this.rejectPending(new Error('AHP WebSocket disconnected'));
    this.ws = undefined;
    // Root-channel catalogue is ephemeral (not replayed on reconnect) — drop it.
    this.unsubRoot?.();
    this.unsubRoot = undefined;
    this.rootSubscribed = false;
    this.sessions.clear();
    this.activeSessionCount = undefined;
    if (this._state !== 'disconnected' && this._state !== 'crashed') {
      this.setState('disconnected');
    }
    if (!this.disposed && wasConnected) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      this.setState('disconnected', new Error('AHP reconnect attempts exhausted'));
      return;
    }
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempts);
    this.setState('connecting');
    this.reconnectTimer = setTimeout(() => void this.attemptReconnect(), delay);
    this.reconnectAttempts++;
  }

  /**
   * Hook for subclasses: called after a successful reconnect handshake
   * (connect + initialize + resume), before the state flips back to
   * 'connected'. HostAgentClient re-registers + re-syncs here. Base is a no-op.
   */
  protected onReconnected(): void {}

  private async attemptReconnect(): Promise<void> {
    if (this.disposed) return;
    try {
      await this.connect(this.url);
    } catch (err) {
      this.reconnectAttempts++;
      this.scheduleReconnect();
      return;
    }

    try {
      await this.initialize([SUPPORTED_PROTOCOL_VERSION], this.clientId, this.initializeParams);
      const subscriptions: URI[] = ['ahp-root://'];
      if (this.sessionUri) subscriptions.push(this.sessionUri);
      if (this.chatUri) subscriptions.push(this.chatUri);
      // Re-establish FarmView's per-session chat subscriptions and tracked
      // terminal channels: the server drops ALL WS-scoped subscriptions on
      // disconnect, so without this open AHP terminals silently stop streaming
      // after a broker blip. (Terminal snapshot replay of cols/rows/screenText
      // happens in the attach flow; here we only need the subscription restored
      // so terminal/data envelopes flow again.)
      for (const uri of this.sessionChatSubs.keys()) {
        if (!subscriptions.includes(uri)) subscriptions.push(uri);
      }
      for (const uri of this.terminalSubs) {
        if (!subscriptions.includes(uri)) subscriptions.push(uri);
      }
      try {
        await this.resumeFromReconnect(subscriptions);
      } catch {
        await this.subscribeRoot();
        if (this.sessionUri) await this.subscribe(this.sessionUri);
        if (this.chatUri) await this.subscribe(this.chatUri);
      }
      this.onReconnected();
      if (!this.disposed) {
        this.reconnectAttempts = 0;
        this.setState('connected');
        try {
          new Notice('✓ Reconnected to AHP server', 3000);
        } catch {
          /* Obsidian API may not be available in test harnesses */
        }
      }
    } catch (err) {
      if (err instanceof AhpError && err.code === -32005) {
        // Protocol version mismatch is permanent — retrying can never succeed.
        // Surface the mismatch and stop reconnecting instead of looping.
        console.error('[AhpClient] reconnect aborted — protocol version mismatch:', err.message);
        this.setState('crashed');
        try {
          new Notice(`AHP reconnect failed: ${err.message}`, 8000);
        } catch {
          /* Obsidian API may not be available in test harnesses */
        }
        return;
      }
      this.reconnectAttempts++;
      this.scheduleReconnect();
    }
  }

  // ─── JSON-RPC helpers ──────────────────────────────────────────────────────

  protected request(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not open'));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for response to '${method}' (${RESPONSE_TIMEOUT_MS}ms)`));
      }, RESPONSE_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      this.ws.send(JSON.stringify(req));
    });
  }

  protected notify(method: string, params: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not open');
    }
    const note: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.ws.send(JSON.stringify(note));
  }

  protected handleMessage(raw: string): void {
    let msg: JsonRpcResponse | JsonRpcNotification;
    try {
      msg = JSON.parse(raw) as JsonRpcResponse | JsonRpcNotification;
    } catch {
      console.error('[AhpClient] parse error:', raw);
      return;
    }

    if ('id' in msg && msg.id !== undefined && msg.id !== null) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if ('error' in msg && msg.error) {
        // Structured rejection (audit 2026-09-01 remediation 3): preserve the
        // wire `code` + `data` so callers can branch on code equality instead
        // of regex-sniffing the formatted message. `.message` still embeds the
        // code so existing Notice text stays readable.
        pending.reject(new AhpError(msg.error.code, msg.error.message, msg.error.data));
      } else {
        pending.resolve('result' in msg ? msg.result : undefined);
      }
      return;
    }

    if ('method' in msg && msg.method) {
      const params = msg.params ?? {};
      const list = this.handlers.get(msg.method) ?? [];
      for (const handler of list) {
        try {
          handler(params);
        } catch (err) {
          console.error('[AhpClient] notification handler error:', err);
        }
      }
    }
  }

  private rejectPending(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  // ─── AHP public API (kept thin, matching pi-ahp-thin-client) ───────────────

  onNotification(method: string, handler: NotificationHandler): () => void {
    const list = this.handlers.get(method) ?? [];
    list.push(handler);
    this.handlers.set(method, list);
    return () => {
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  async initialize(protocolVersions: string[], clientId: string, extra?: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.clientId = clientId;
    const result = (await this.request('initialize', { protocolVersions, clientId, ...extra })) as Record<string, unknown>;
    // Verify the negotiated protocol version (audit 2026-09-01 remediation 3):
    // the server picks ONE version from the offered `protocolVersions`; a
    // server that returns something outside that set is incompatible — fail
    // loudly with a structured AhpError instead of silently talking a
    // mismatched wire contract.
    const negotiated = result?.protocolVersion;
    if (typeof negotiated === 'string' && !protocolVersions.includes(negotiated)) {
      throw new AhpError(
        -32005,
        `Server negotiated AHP protocol version '${negotiated}' which this client does not support`,
        { supportedVersions: protocolVersions, negotiatedVersion: negotiated },
      );
    }
    return result;
  }

  createSession(channel: URI, opts?: { provider?: string; workingDirectory?: string; title?: string }): Promise<unknown> {
    this.sessionUri = channel;
    const params: Record<string, unknown> = { channel };
    if (opts?.provider) params.provider = opts.provider;
    if (opts?.workingDirectory) params.workingDirectory = opts.workingDirectory;
    if (opts?.title) params.title = opts.title;
    return this.request('createSession', params);
  }

  /** List archived (past) pi sessions from the broker's archive dir(s). Returns
   *  lightweight summaries (no live terminal) for browse-only display in the
   *  session picker. Requires broker-side listArchives support + AHP_ARCHIVE_DIR. */
  async listArchives(limit = 200): Promise<SessionSummary[]> {
    try {
      const res = await this.request('listArchives', { limit });
      const items = (res as { items?: SessionSummary[] }).items ?? [];
      return items;
    } catch {
      return [];
    }
  }

  createChat(sessionUri: URI, chatUri: URI, options?: { workingDirectory?: URI; initialMessage?: Record<string, unknown> }): Promise<unknown> {
    this.chatUri = chatUri;
    const params: Record<string, unknown> = { channel: sessionUri, chat: chatUri };
    if (options?.workingDirectory) params.workingDirectory = options.workingDirectory;
    if (options?.initialMessage) params.initialMessage = options.initialMessage;
    return this.request('createChat', params);
  }

  /**
   * Subscribe to a channel. An optional `command` (swarm dispatch) is stored on
   * the terminal state by the broker and forwarded to the owning host agent in
   * startTerminalStream, so the host can spawn a headless process (e.g.
   * `pi -p "<task>"`) instead of the default interactive binary. Backward
   * compatible: no command → identical behavior to before.
   */
  subscribe(channel: URI, command?: string): Promise<Record<string, unknown>> {
    // Track terminal-channel subscriptions so attemptReconnect can restore
    // them after a reconnect (see terminalSubs).
    if (channel.startsWith('ahp-terminal:')) this.terminalSubs.add(channel);
    const params: Record<string, unknown> = { channel };
    if (command) params.command = command;
    return this.request('subscribe', params) as Promise<Record<string, unknown>>;
  }

  dispatchAction(channel: URI, action: Record<string, unknown>): { clientSeq: number } {
    const clientSeq = this.nextClientSeq++;
    this.notify('dispatchAction', { channel, clientSeq, action });
    return { clientSeq };
  }

  sendTerminalInput(terminalUri: URI, data: string): void {
    this.dispatchAction(terminalUri, { type: 'terminal/input', data });
  }

  resizeTerminal(terminalUri: URI, cols: number, rows: number): void {
    try {
      this.dispatchAction(terminalUri, { type: 'terminal/resized', cols, rows });
    } catch {
      // best-effort; the server may ignore or reject unknown action names
    }
  }

  reconnect(channels: URI[], lastSeenServerSeq: number): Promise<unknown> {
    return this.request('reconnect', {
      channel: 'ahp-root://',
      clientId: this.clientId,
      lastSeenServerSeq,
      subscriptions: channels,
    });
  }

  ping(): Promise<unknown> {
    return this.request('ping', {});
  }

  getLastServerSeq(channel: URI): number | undefined {
    return this.lastServerSeq.get(channel);
  }

  /**
   * Resume subscriptions via the server's `reconnect` endpoint using the
   * smallest per-channel `lastServerSeq` we've observed. Handles both replay
   * and snapshot responses; on gaps or errors it falls back to fresh
   * `subscribe` calls.
   */
  private async resumeFromReconnect(subscriptions: URI[]): Promise<void> {
    const lastSeen = subscriptions.length > 0
      ? Math.min(...subscriptions.map((c) => this.lastServerSeq.get(c) ?? 0))
      : 0;

    let result: unknown;
    try {
      result = await this.reconnect(subscriptions, lastSeen);
    } catch {
      await this.fallbackSubscribe(subscriptions);
      return;
    }

    const r = result as Record<string, unknown> | undefined;
    if (r?.missing) {
      await this.fallbackSubscribe(subscriptions);
      return;
    }

    if (r?.type === 'replay' && Array.isArray(r.actions)) {
      for (const raw of r.actions) {
        const env = raw as ActionEnvelope;
        if (env && typeof env.channel === 'string' && typeof env.action === 'object') {
          this.applyActionEnvelope(env);
        }
      }
    } else if (r?.type === 'snapshot' && r.snapshots && typeof r.snapshots === 'object') {
      const snaps = r.snapshots as Record<URI, Record<string, unknown>>;
      const rootSnap = snaps['ahp-root://'];
      if (rootSnap) {
        const state = (rootSnap.state ?? rootSnap) as Record<string, unknown>;
        if (Array.isArray(state.sessions)) {
          for (const entry of state.sessions) {
            const summary = entry as SessionSummary | undefined;
            if (summary && typeof summary.resource === 'string') {
              this.sessions.set(summary.resource, summary);
            }
          }
        }
        if (typeof state.activeSessions === 'number') {
          this.activeSessionCount = state.activeSessions;
        }
      }
      this.notifyCatalogChanged();
      // Session/chat snapshots restore the channel state; apply them to any
      // registered sessionChatSubs so FarmView's subagent rows refresh after a
      // reconnect (the server drops all WS-scoped subscription state, so
      // without this the chat list stays stale/empty until a manual refresh).
      for (const ch of subscriptions) {
        if (ch === 'ahp-root://') continue;
        const snap = snaps[ch];
        if (!snap) continue;
        this.applySessionChatsSnapshot(ch, snap);
      }
    } else {
      // Unknown reconnect result shape — fall back to fresh subscriptions.
      await this.fallbackSubscribe(subscriptions);
      return;
    }

    // Root handlers were cleared on disconnect; re-wire them if needed.
    if (!this.unsubRoot) {
      await this.subscribeRoot();
    }
  }

  private async fallbackSubscribe(subscriptions: URI[]): Promise<void> {
    for (const ch of subscriptions) {
      if (ch === 'ahp-root://') {
        await this.subscribeRoot();
      } else {
        const snapshot = await this.subscribe(ch);
        // A fresh session subscribe returns the full chat list — apply it to
        // any registered sessionChatSubs (same shape as the resume path).
        this.applySessionChatsSnapshot(ch, snapshot);
      }
    }
  }

  /**
   * Apply a session channel's snapshot chat list to the registered
   * sessionChatSub listeners — same shape as the initial subscribeSessionChats
   * snapshot delivery. No-op when the channel has no chat subscribers or the
   * snapshot carries no chat list. Tolerates both the state-bearing channel
   * wrapper (`{ snapshot: { state: { chats } } }`) and flatter responses.
   */
  private applySessionChatsSnapshot(channel: URI, snapshot: unknown): void {
    const entry = this.sessionChatSubs.get(channel);
    if (!entry) return;
    const r = (snapshot ?? {}) as Record<string, unknown>;
    const state = ((r.snapshot as Record<string, unknown> | undefined)?.state ??
      r.state ??
      r) as Record<string, unknown>;
    if (!Array.isArray(state.chats)) return;
    entry.snapshot = state.chats.filter(
      (c): c is ChatSummary => !!c && typeof (c as ChatSummary).resource === 'string',
    );
    this.notifySessionChatEntry(entry);
  }

  /** Notify a sessionChatSub's listeners with the current filtered tool-chat list. */
  private notifySessionChatEntry(entry: SessionChatSub): void {
    const toolChats = this.filterToolChats(entry.snapshot);
    for (const l of entry.listeners) {
      try {
        l(toolChats);
      } catch (err) {
        console.error('[AhpClient] session chat listener error:', err);
      }
    }
  }

  // ─── Root channel: session catalogue ─────────────────────────────────────────

  /**
   * Subscribe to the root channel (`ahp-root://`), seed the session catalogue
   * from the snapshot (when the server includes one) and `listSessions`, then
   * keep it live via `root/session*` + `root/activeSessionsChanged` events.
   *
   * Per the AHP spec the session list is NOT part of `RootState` — it is fetched
   * imperatively via `listSessions` and patched by `root/*` notifications — so
   * this performs both: an authoritative `listSessions` fetch AND the live
   * notification wiring.  Returns the raw root subscribe result.
   */
  async subscribeRoot(): Promise<Record<string, unknown>> {
    // A full root (re)subscription seeds the catalogue from a fresh server
    // snapshot. Clear any stale entries first so sessions dropped by a server
    // restart do not linger as ghost rows.
    this.sessions.clear();
    const snapshot = await this.subscribe('ahp-root://');

    // Parse the root snapshot defensively: the result shape is
    // `{ snapshot: { state: RootState, fromSeq } }` for state-bearing channels,
    // but some servers may omit the wrapper.
    const snap = (snapshot ?? {}) as Record<string, unknown>;
    const rootSnap = (snap.snapshot ?? snap) as Record<string, unknown>;
    const state = (rootSnap.state ?? {}) as Record<string, unknown>;
    if (Array.isArray(state.sessions)) {
      for (const entry of state.sessions) {
        const summary = entry as SessionSummary | undefined;
        if (summary && typeof summary.resource === 'string') {
          this.sessions.set(summary.resource, summary);
        }
      }
    }
    if (typeof state.activeSessions === 'number') {
      this.activeSessionCount = state.activeSessions;
    }

    // Wire root notifications once.
    if (!this.unsubRoot) this.unsubRoot = this.attachRootHandlers();
    this.rootSubscribed = true;

    // Authoritative initial catalogue fetch (merge — root/sessionAdded may have
    // already populated entries the in-flight listSessions page predates).
    await this.refreshSessions();
    this.notifyCatalogChanged();

    return snapshot;
  }

  /**
   * Fetch the session catalogue via `listSessions` (first page, most-recently-
   * modified first) and merge it into the cache.  Tolerates servers that do not
   * implement `listSessions` yet (the Phase-9 root-catalog server discovers
   * sessions live via `root/sessionAdded` instead) — on such servers this is a
   * no-op and the catalogue is kept live by the `root/session*` handlers.
   */
  async refreshSessions(): Promise<SessionSummary[]> {
    // Treat a full listSessions fetch as authoritative: start from a clean
    // cache so removed sessions do not survive a server restart.
    this.sessions.clear();
    try {
      const items = await this.listSessions();
      for (const s of items) {
        if (s && typeof s.resource === 'string') this.sessions.set(s.resource, s);
      }
    } catch (err) {
      // listSessions is optional; fall back to the live root/session* catalogue.
      console.debug(
        '[AhpClient] listSessions unavailable, relying on root/session* notifications:',
        err instanceof Error ? err.message : err,
      );
    }
    this.notifyCatalogChanged();
    return this.getSessions();
  }

  /**
   * Imperative catalogue fetch (`listSessions`).  Returns the first page of
   * `SessionSummary` entries; the server SHOULD order them most-recently-
   * modified first.  Pagination (`nextCursor`) is not chased — the thin-client
   * only needs the first page for the picker.
   */
  async listSessions(limit = 200): Promise<SessionSummary[]> {
    const result = await this.request('listSessions', { channel: 'ahp-root://', limit });
    const r = result as { items?: SessionSummary[]; nextCursor?: string } | undefined;
    return Array.isArray(r?.items) ? (r!.items as SessionSummary[]) : [];
  }

  /**
   * Current cached session list, sorted most-recently-modified first.
   * This is the live view the picker consumes.
   */
  getSessions(): SessionSummary[] {
    return Array.from(this.sessions.values()).sort((a, b) =>
      String(b.modifiedAt ?? '').localeCompare(String(a.modifiedAt ?? '')),
    );
  }

  /** Lightweight active-session count from `root/activeSessionsChanged`. */
  getActiveSessionCount(): number | undefined {
    return this.activeSessionCount;
  }

  /**
   * Subscribe to live catalogue mutations. The listener is invoked immediately
   * with the current catalogue and again whenever a session is added, changed,
   * or removed. Returns an unsubscribe handle.
   */
  onCatalogChanged(listener: (sessions: SessionSummary[]) => void): () => void {
    this.catalogListeners.push(listener);
    listener(this.getSessions());
    return () => {
      this.catalogListeners = this.catalogListeners.filter((l) => l !== listener);
    };
  }

  /** Notify all catalogue subscribers with the current sorted session list. */
  private notifyCatalogChanged(): void {
    const sessions = this.getSessions();
    for (const l of this.catalogListeners) {
      try {
        l(sessions);
      } catch (err) {
        console.error('[AhpClient] catalogue listener error:', err);
      }
    }
  }

  /**
   * Subscribe to a session's chat list and receive live updates for chats whose
   * `origin.kind === 'tool'` (subagent child chats).  Mirrors `onCatalogChanged`:
   * the listener is called immediately with the current filtered list and again
   * whenever a chat is added, updated, or removed.  Returns an unsubscribe handle.
   */
  subscribeSessionChats(
    sessionUri: URI,
    listener: (chats: ChatSummary[]) => void,
  ): () => void {
    const existing = this.sessionChatSubs.get(sessionUri);
    if (existing) {
      existing.listeners.push(listener);
      listener(this.filterToolChats(existing.snapshot));
      return () => {
        existing.listeners = existing.listeners.filter((l) => l !== listener);
        if (existing.listeners.length === 0) {
          this.sessionChatSubs.delete(sessionUri);
        }
      };
    }

    const entry: SessionChatSub = {
      snapshot: [],
      listeners: [listener],
      applyChatAction: () => undefined,
    };

    const notify = (): void => this.notifySessionChatEntry(entry);

    const applyChatChanges = (uri: URI, changes: Partial<ChatSummary>): void => {
      const idx = entry.snapshot.findIndex((c) => c.resource === uri);
      if (idx >= 0) {
        entry.snapshot[idx] = { ...entry.snapshot[idx], ...changes };
      } else {
        entry.snapshot.push({ resource: uri, ...changes } as ChatSummary);
      }
      notify();
    };

    const applyUpdate = (chat: ChatSummary | undefined): void => {
      if (!chat || typeof chat.resource !== 'string') return;
      applyChatChanges(chat.resource, chat);
    };

    /**
     * Apply a broker `session/chat*` action envelope (see pi-ahp-server
     * dispatchServerAction). The server delivers chat mutations ONLY as
     * `action` envelopes on the session channel — never as JSON-RPC
     * notification methods — so this (not onNotification) is the live path
     * that keeps FarmView's subagent rows fresh. Payload shapes match the
     * server reducers, with defensive fallbacks for unknown fields:
     *   chatAdded:   { summary: ChatSummary }
     *   chatUpdated: { chat: URI, changes: Partial<ChatSummary> }
     *   chatRemoved: { chat: URI }
     */
    const applyChatAction = (action: Record<string, unknown>): void => {
      const type = action.type as string | undefined;
      if (type === 'session/chatAdded') {
        const chat = (action.summary ?? action.chat ?? action.chatSummary) as ChatSummary | undefined;
        applyUpdate(chat);
      } else if (type === 'session/chatUpdated') {
        // Server form for session/chatUpdated: { chat: URI, changes: Partial<ChatSummary> }
        if (typeof action.chat === 'string' && action.changes && typeof action.changes === 'object') {
          applyChatChanges(action.chat, action.changes as Partial<ChatSummary>);
          return;
        }
        // Legacy/fallback form: full chat object in chat/chatSummary.
        const chat = (action.chat ?? action.chatSummary) as ChatSummary | undefined;
        applyUpdate(chat);
      } else if (type === 'session/chatRemoved') {
        const removed = action.chat ?? action.chatSummary ?? action.resource;
        const uri = typeof removed === 'string' ? removed : (removed as ChatSummary | undefined)?.resource;
        if (typeof uri !== 'string') return;
        entry.snapshot = entry.snapshot.filter((c) => c.resource !== uri);
        notify();
      }
    };
    entry.applyChatAction = applyChatAction;

    this.sessionChatSubs.set(sessionUri, entry);

    // Fetch the initial session snapshot asynchronously.  We tolerate both the
    // state-bearing channel wrapper (`{ snapshot: { state: { chats } } }`) and
    // flatter server responses.
    this.subscribe(sessionUri)
      .then((result) => {
        this.applySessionChatsSnapshot(sessionUri, result);
      })
      .catch((err) => {
        console.error('[AhpClient] subscribeSessionChats failed:', err);
      });

    return () => {
      entry.listeners = entry.listeners.filter((l) => l !== listener);
      if (entry.listeners.length === 0) {
        this.sessionChatSubs.delete(sessionUri);
      }
    };
  }

  private filterToolChats(chats: ChatSummary[]): ChatSummary[] {
    return chats.filter((c) => c.origin?.kind === 'tool');
  }

  /**
   * Ask the server to dispose/remove a session. The local catalogue will drop the
   * row when `root/sessionRemoved` arrives.
   */
  disposeSession(uri: URI): Promise<unknown> {
    return this.request('disposeSession', { channel: uri });
  }

  /**
   * Set the user-level archive flag on a session. The server will reflect the
   * change through `root/sessionSummaryChanged`; the local catalogue is updated
   * by the existing notification handler.
   */
  async setSessionStatus(uri: URI, status: 'archived' | 'active'): Promise<void> {
    await this.request('setSessionStatus', { channel: uri, status });
  }

  /** Pause the session between turns (new turns rejected, in-flight not interrupted). */
  pauseSession(uri: URI): Promise<unknown> {
    return this.request('pauseSession', { channel: uri });
  }

  /** Clear the paused flag on a session. */
  resumeSession(uri: URI): Promise<unknown> {
    return this.request('resumeSession', { channel: uri });
  }

  /** Set the scheduler priority for a session. */
  setSessionPriority(uri: URI, priority: number): Promise<unknown> {
    return this.request('setSessionPriority', { channel: uri, priority });
  }

  /** Re-dispatch the last turn on a session. */
  retryTurn(uri: URI): Promise<unknown> {
    return this.request('retryTurn', { channel: uri });
  }

  /**
   * Store per-provider max-concurrency caps on the server.
   * The server returns the stored caps.
   */
  setProviderCaps(caps: Record<string, number>): Promise<Record<string, number>> {
    return this.request('setProviderCaps', { caps }) as Promise<Record<string, number>>;
  }

  /** Set the idle-cull timeout (null/0 disables culling). */
  setAutoCullConfig(idleMinutes: number | null): Promise<unknown> {
    return this.request('setAutoCullConfig', { idleMinutes });
  }

  /**
   * Attach to an EXISTING session + chat without creating them: sets the active
   * URIs and subscribes to both channels so live actions flow through the
   * attached action mapper into the AHP terminal adapter.  Used by the "open
   * remote session"
   * command to render a session the D3 emitter already created.
   */
  async attachSession(sessionUri: URI, chatUri: URI): Promise<void> {
    this.sessionUri = sessionUri;
    this.chatUri = chatUri;
    await this.subscribe(sessionUri);
    await this.subscribe(chatUri);
  }

  /** Wire the root-channel catalogue notifications.  Idempotent via `unsubRoot`. */
  private attachRootHandlers(): () => void {
    const unsubs: Array<() => void> = [];

    unsubs.push(this.onNotification('root/sessionAdded', (params) => {
      const summary = params.summary as SessionSummary | undefined;
      if (summary && typeof summary.resource === 'string') {
        this.sessions.set(summary.resource, summary);
        this.notifyCatalogChanged();
      }
    }));

    unsubs.push(this.onNotification('root/sessionRemoved', (params) => {
      const session = params.session as URI | undefined;
      if (typeof session === 'string') {
        this.sessions.delete(session);
        this.notifyCatalogChanged();
      }
    }));

    unsubs.push(this.onNotification('root/sessionSummaryChanged', (params) => {
      const session = params.session as URI | undefined;
      if (typeof session === 'string' && this.sessions.has(session)) {
        const changes = (params.changes ?? {}) as Record<string, unknown>;
        const existing = this.sessions.get(session)!;
        this.sessions.set(session, { ...existing, ...changes } as SessionSummary);
        this.notifyCatalogChanged();
      }
    }));

    // `root/activeSessionsChanged` is delivered as an `action` envelope on ahp-root://.
    unsubs.push(this.onNotification('action', (params) => {
      if (params.channel !== 'ahp-root://') return;
      const action = (params.action ?? {}) as Record<string, unknown>;
      if (action.type === 'root/activeSessionsChanged' && typeof action.activeSessions === 'number') {
        this.activeSessionCount = action.activeSessions as number;
      }
    }));

    return () => {
      for (const u of unsubs) {
        try { u(); } catch { /* ignore */ }
      }
    };
  }

  // ─── PiClient command API ──────────────────────────────────────────────────

  async prompt(message: string, _opts?: { images?: ImageContent[]; streamingBehavior?: 'steer' | 'followUp' }): Promise<void> {
    if (!this.chatUri) throw new Error('AHP chat not created');
    const turnId = `turn-${globalThis.crypto.randomUUID()}`;
    this.dispatchAction(this.chatUri, {
      type: 'chat/turnStarted',
      turnId,
      message: {
        text: message,
        origin: { kind: 'user' },
      },
    });
  }

  async getCommands(): Promise<RpcSlashCommand[]> {
    return [];
  }

  // ─── Internal wiring ─────────────────────────────────────────────────────

  private applyActionEnvelope(envelope: ActionEnvelope): void {
    if (typeof envelope.serverSeq === 'number' && typeof envelope.channel === 'string') {
      const prev = this.lastServerSeq.get(envelope.channel) ?? 0;
      // Replay dedup: skip envelopes already applied. Live serverSeq is monotonic per
      // channel (single ordered WebSocket), so this never skips live actions; it only
      // suppresses re-delivery when reconnect replays from a single min-seq scalar
      // across channels that progressed independently (server B.1 caveat).
      if (envelope.serverSeq <= prev) return;
      this.lastServerSeq.set(envelope.channel, envelope.serverSeq);
    }

    if (envelope.action?.type === 'chat/usage') {
      const usage = (envelope.action.usage as Record<string, unknown>) ?? {};
      this.lastUsage = {
        input: (usage.inputTokens as number) ?? 0,
        output: (usage.outputTokens as number) ?? 0,
        cacheRead: (usage.cacheReadTokens as number) ?? 0,
        model: (usage.model as string) ?? this.lastUsage?.model ?? 'unknown',
      };
    } else if (envelope.action?.type === 'chat/turnComplete') {
      // Turn lifecycle bookkeeping only — the mapper below re-derives events.
    }

    // The broker delivers chat-list mutations as `action` envelopes (see
    // pi-ahp-server dispatchServerAction) — NEVER as JSON-RPC notification
    // methods. Route them to this session's chat subscribers so FarmView's
    // subagent rows update live.
    const actionType = envelope.action?.type as string | undefined;
    if (
      actionType === 'session/chatAdded' ||
      actionType === 'session/chatUpdated' ||
      actionType === 'session/chatRemoved'
    ) {
      this.sessionChatSubs.get(envelope.channel)?.applyChatAction(envelope.action);
    }

    const events = mapAhpAction(envelope.action, { lastUsage: this.lastUsage ?? undefined });
    for (const ev of events) {
      for (const l of this.eventListeners) l(ev);
    }
  }

  /** Bootstrap the action → plugin-event adapter.  Called by AHP connection flows. */
  attachActionMapper(): () => void {
    return this.onNotification('action', (params) => {
      this.applyActionEnvelope(params as unknown as ActionEnvelope);
    });
  }
}

/** Convenience: create an AhpClient already wired to the live server. */
export async function createAhpClient(
  url: string,
  clientId = `obsidian-pi-${globalThis.crypto.randomUUID()}`,
): Promise<AhpClient> {
  const client = new AhpClient(clientId);
  await client.connect(url);
  await client.initialize([SUPPORTED_PROTOCOL_VERSION], clientId);
  return client;
}
