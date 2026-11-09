/**
 * Menubar IPC over a Unix domain socket.
 *
 * One plugin instance ("leader") owns the tray and `bind()`s a well-known
 * socket path; every other plugin instance ("reporter") `connect()`s to it
 * and pushes JSON snapshots of its vault's pi instances. The leader aggregates
 * reports into the tray menu and routes click messages back to the owning
 * reporter. If the leader dies, reporters detect the dropped socket, re-run
 * election (one wins `bind()`), and the tray passes to the new leader — the
 * icon is never duplicated.
 *
 * Framing reuses the strict JSONL codec from the transport layer
 * ({@link attachJsonlReader} / {@link serializeLine}), so messages are
 * newline-delimited JSON records — the same convention as the RPC subprocess.
 */

import * as fs from 'fs';
import { createConnection, createServer, type Server, type Socket } from 'net';
import * as os from 'os';
import * as path from 'path';
import { attachJsonlReader, serializeLine } from '../transport/JsonlCodec';
import type { MenubarReport, MenubarVaultSnapshot } from './menubarSnapshot';

/** Wire messages. Direction is implied by type (see each variant's doc). */
export type MenubarIpcMessage =
  /** Reporter → leader: announce this connection's identity + initial vault snapshot. */
  | { t: 'hello'; report: MenubarReport }
  /** Reporter → leader: an updated vault snapshot (state changed). */
  | { t: 'snapshot'; report: MenubarReport }
  /** Leader → reporter: the user clicked an instance row; open/focus it. */
  | { t: 'click'; instanceId: string; action: 'open' }
  /** Leader → reporter: the user clicked a global footer action. */
  | { t: 'action'; action: 'open-settings' }
  /** Reporter → leader: graceful disconnect (unload). */
  | { t: 'bye'; reporterId: string }
  /** Bidirectional: liveness probe. */
  | { t: 'heartbeat'; at: number };

/** A connected reporter as seen by the leader. */
interface ReporterConn {
  reporterId: string;
  socket: Socket;
  lastSeen: number;
}

/** Well-known socket path shared by all obsidian-pi plugin instances (same user). */
export function menubarSocketPath(): string {
  // macOS keeps per-user app support under ~/Library/Application Support.
  // The path length stays well under macOS's ~104-char sun_path limit.
  const dir =
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library/Application Support/obsidian-pi')
      : path.join(os.tmpdir(), 'obsidian-pi');
  return path.join(dir, 'menubar.sock');
}

/** Ensure the socket directory exists (best effort). */
function ensureSocketDir(): void {
  try {
    const dir = path.dirname(menubarSocketPath());
    fs.mkdirSync(dir, { recursive: true });
  } catch { /* non-fatal — bind() will surface a real error */ }
}

function writeMsg(socket: Socket | Server, msg: MenubarIpcMessage): void {
  try {
    (socket as Socket).write(serializeLine(msg));
  } catch { /* socket closed mid-write — ignore */ }
}

// ── Leader server ──────────────────────────────────────────────────────────

export interface MenubarLeaderCallbacks {
  /** A reporter announced itself (hello) or published an updated snapshot. */
  onReport: (report: MenubarReport) => void;
  /** A reporter disconnected (bye or socket close). */
  onReporterGone: (reporterId: string) => void;
}

/**
 * Leader side of the menubar IPC: owns the Unix socket server, tracks connected
 * reporters, and exposes `sendClick`/`sendAction` to route menu interactions
 * back to the owning reporter.
 */
export class MenubarLeaderServer {
  private server: Server | null = null;
  private reporters = new Map<string, ReporterConn>();
  private readonly conns = new Map<Socket, string>(); // socket → reporterId

  constructor(private readonly cb: MenubarLeaderCallbacks) {}

  /**
   * Bind the socket. Resolves `true` if this caller won leadership, `false`
   * if the address is already in use (caller should become a reporter instead).
   *
   * Safe against a live leader: it does NOT unlink a socket that an existing
   * leader is actively listening on. On `EADDRINUSE` it probes the socket — if
   * something is listening, we become a reporter; only if the probe is refused
   * (stale file from a crashed leader) do we unlink and retry once.
   */
  async bind(): Promise<boolean> {
    ensureSocketDir();
    const sockPath = menubarSocketPath();

    return new Promise<boolean>((resolve) => {
      const tryListen = (alreadyUnlinked: boolean): void => {
        const server = createServer((socket) => this.onConnection(socket));
        let settled = false;
        const done = (ok: boolean): void => {
          if (settled) return;
          settled = true;
          resolve(ok);
        };
        server.once('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE' && !alreadyUnlinked) {
            // Live leader listening, or a stale socket file from a crash?
            const probe = createConnection(sockPath);
            probe.once('connect', () => {
              probe.destroy(); // live leader → become a reporter
              try { server.close(); } catch { /* */ }
              done(false);
            });
            probe.once('error', () => {
              // Stale file → remove it and retry the bind once.
              try { fs.unlinkSync(sockPath); } catch { /* */ }
              try { server.close(); } catch { /* */ }
              tryListen(true);
            });
          } else {
            try { server.close(); } catch { /* */ }
            done(false); // any other bind failure → fall back to reporter
          }
        });
        server.listen(sockPath, () => {
          this.server = server;
          done(true);
        });
      };
      tryListen(false);
    });
  }

  private onConnection(socket: Socket): void {
    const detach = attachJsonlReader(socket, (line) => {
      let msg: MenubarIpcMessage;
      try { msg = JSON.parse(line); } catch { return; }
      this.handleMessage(socket, msg);
    });
    socket.once('close', () => {
      detach();
      const id = this.conns.get(socket);
      if (id) {
        this.reporters.delete(id);
        this.conns.delete(socket);
        this.cb.onReporterGone(id);
      }
    });
    socket.on('error', () => { /* swallow; close handler cleans up */ });
  }

  private handleMessage(socket: Socket, msg: MenubarIpcMessage): void {
    switch (msg.t) {
      case 'hello':
      case 'snapshot': {
        const id = msg.report.reporterId;
        this.conns.set(socket, id);
        this.reporters.set(id, { reporterId: id, socket, lastSeen: Date.now() });
        this.cb.onReport(msg.report);
        break;
      }
      case 'bye': {
        socket.end();
        break;
      }
      case 'heartbeat': {
        const id = this.conns.get(socket);
        if (id) this.reporters.get(id)!.lastSeen = msg.at;
        break;
      }
      default:
        // 'click'/'action' are leader → reporter only; ignore inbound.
        break;
    }
  }

  /** Route a menu click to the reporter that owns the instance. */
  sendClick(reporterId: string, instanceId: string): void {
    const conn = this.reporters.get(reporterId);
    if (conn) writeMsg(conn.socket, { t: 'click', instanceId, action: 'open' });
  }

  /** Route a global footer action to a reporter. */
  sendAction(reporterId: string, action: 'open-settings'): void {
    const conn = this.reporters.get(reporterId);
    if (conn) writeMsg(conn.socket, { t: 'action', action });
  }

  /** Reporter ids currently connected (for menu row enable/disable). */
  connectedReporterIds(): Set<string> {
    return new Set(this.reporters.keys());
  }

  /** Stop the server and drop all reporters. */
  close(): void {
    for (const conn of this.reporters.values()) {
      try { writeMsg(conn.socket, { t: 'bye', reporterId: conn.reporterId }); } catch { /* */ }
      try { conn.socket.destroy(); } catch { /* */ }
    }
    this.reporters.clear();
    this.conns.clear();
    try { this.server?.close(); } catch { /* */ }
    this.server = null;
    try { fs.unlinkSync(menubarSocketPath()); } catch { /* */ }
  }
}

// ── Reporter client ───────────────────────────────────────────────────────

export interface MenubarReporterCallbacks {
  /** Leader routed a menu click to us. */
  onClick: (instanceId: string, action: 'open') => void;
  /** Leader routed a global action to us. */
  onAction: (action: 'open-settings') => void;
  /** The socket dropped (leader died) — coordinator should re-run election. */
  onLeaderLost: () => void;
  /** Successfully (re)connected and sent hello. */
  onConnected: () => void;
}

/**
 * Reporter side: connects to the leader's socket, sends `hello`, pushes
 * snapshots, and receives routed click/action messages. Reconnects with
 * exponential backoff on leader loss.
 */
export class MenubarReporterClient {
  private socket: Socket | null = null;
  private detach: (() => void) | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private stopped = false;

  constructor(
    private readonly report: () => MenubarReport,
    private readonly cb: MenubarReporterCallbacks,
  ) {}

  /** Connect (or reconnect) to the leader. Sends `hello` on success. */
  async connect(): Promise<void> {
    if (this.stopped) return;
    if (this.socket) return;
    const socket = createConnection(menubarSocketPath());
    socket.once('connect', () => {
      this.attempt = 0;
      this.socket = socket;
      this.send({ t: 'hello', report: this.report() });
      this.cb.onConnected();
    });
    socket.once('error', () => { /* swallow; close handles reconnect */ });
    socket.once('close', () => this.handleClose());

    this.detach = attachJsonlReader(socket, (line) => {
      let msg: MenubarIpcMessage;
      try { msg = JSON.parse(line); } catch { return; }
      this.handleInbound(msg);
    });
  }

  private handleInbound(msg: MenubarIpcMessage): void {
    switch (msg.t) {
      case 'click': this.cb.onClick(msg.instanceId, msg.action); break;
      case 'action': this.cb.onAction(msg.action); break;
      case 'heartbeat': break; // leader liveness
      default: break;
    }
  }

  /** Push a fresh snapshot of this reporter's vault to the leader. */
  publishSnapshot(): void {
    this.send({ t: 'snapshot', report: this.report() });
  }

  private send(msg: MenubarIpcMessage): void {
    if (this.socket) writeMsg(this.socket, msg);
  }

  /** Graceful disconnect (plugin unload). */
  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.socket) {
      try { this.send({ t: 'bye', reporterId: this.report().reporterId }); } catch { /* */ }
    }
    this.detach?.();
    try { this.socket?.destroy(); } catch { /* */ }
    this.socket = null;
    this.detach = null;
  }

  private handleClose(): void {
    this.detach?.();
    this.socket = null;
    this.detach = null;
    if (this.stopped) return;
    // Leader lost — re-run election after backoff (caller may become leader).
    this.cb.onLeaderLost();
    const delay = Math.min(1000 * 2 ** this.attempt, 8000);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

/** The vault snapshot portion of a report (convenience for tests). */
export type { MenubarVaultSnapshot };