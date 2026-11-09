/**
 * swarmDispatch — route a task from the Obsidian Farm View to a swarm worker
 * (host-agent device, e.g. arthur) via the AHP broker relay and stream the
 * result back.
 *
 *   Obsidian (this util) → broker (settings.ahpServerUrl, ws://localhost:4500)
 *     → host-agent daemon on the worker box → `pi -p "<task>"` (headless)
 *     → terminalData stream → terminalExited → result
 *
 * The task is delivered as a `command` on the terminal subscribe request; the
 * broker stores it on the terminal state and forwards it in startTerminalStream,
 * so the host-agent daemon spawns `$SHELL -c 'pi -p "<task>"'` instead of the
 * default interactive `pi`. If the daemon is an older build (or the terminal is
 * already streaming interactively) and ignores the command field, the dispatcher
 * falls back to typing the task into the spawned interactive `pi` and detecting
 * the completed turn.
 *
 * This is a TS port of /home/ulysse/homeserver/swarm-dispatcher/dispatch.js. It
 * uses the *global* `WebSocket` (like AhpClient) so it runs in Obsidian's
 * Electron renderer — and on mobile — without a runtime dependency on the `ws`
 * npm package. It deliberately opens a SHORT-LIVED connection rather than
 * reusing the plugin's shared AhpClient: the broker only forwards the command
 * on a 0→1 subscriber transition (maybeStartExternalTerminalStream), so a
 * second subscribe on an already-subscribed shared client would store the
 * command but never spawn the headless pi — and the shared client would keep
 * the terminal subscription (and its stream) alive after the dispatch ends.
 */

import { AHP_PROTOCOL_VERSION } from './AhpClient';

export interface DispatchOptions {
  /** Broker WebSocket URL (settings.ahpServerUrl, e.g. ws://localhost:4500). */
  brokerUrl: string;
  /** Worker pool = host-agent device name, e.g. 'arthur'. */
  pool: string;
  /** Optional instance id suffix, e.g. 'arthur-default'. */
  instance?: string;
  /** The task to run headless on the worker: `pi -p "<task>"`. */
  task: string;
  /** Overall deadline in ms (default 300s). */
  timeoutMs?: number;
}

export interface DispatchResult {
  /** The extracted answer (ANSI stripped, TUI chrome removed). */
  text: string;
  /** Exit code from terminalExited, when the headless path completed. */
  exitCode: number | null;
  /** True when the deadline elapsed with no terminalExited / completed turn. */
  timedOut: boolean;
  /** True when the interactive-input fallback was used (old daemon / already-streaming terminal). */
  interactiveFallback: boolean;
  /** The external terminal URI the task was dispatched to. */
  terminalUri: string;
  /** Error message when the dispatch failed before producing a result. */
  error?: string;
}

const PROTOCOL_VERSION = AHP_PROTOCOL_VERSION;
const DEFAULT_TIMEOUT_MS = 300_000;
/** How long to wait for terminalExited before assuming the daemon is old (interactive). */
const INTERACTIVE_FALLBACK_GRACE_MS = 10_000;
/** Quiet period (no terminalData) after which an interactive turn is considered done. */
const INTERACTIVE_QUIET_MS = 6_000;

// ─── Shell quoting ──────────────────────────────────────────────────────────

/** Single-quote a string for use inside `$SHELL -c '…'`. */
export function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// ─── ANSI / result extraction ───────────────────────────────────────────────

const ANSI_RE = /\x1b\[[0-9;?<>]*[a-zA-Z]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[()][0-9A-Z]|\x1b[=>]|\x1b[78]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '').replace(/\r/g, '').replace(/\x07/g, '');
}

/** Lines that are pi TUI chrome (status bars, spinners, help, our own logs). */
const CHROME_RE =
  /^(~|─|⬡|📊|✓|⏳|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|⠋|↑|↓|\d+s\s|Ollama Cloud|0\.0%\/|pi v|escape interrupt|more$|Press ctrl|Pi can explain|extend Pi|\[Prompts\]|\[Extensions\]|@senad|ollama-cloud,|Package Updates|Package updates|Packages:|^- @senad|\[dispatch\]|\[pi-agents\]|\[pi-ahp-client\]|→ dispatching|\[usage|Warning:)/;

/**
 * True when the streamed output looks like the interactive `pi` TUI (as opposed
 * to clean headless `pi -p` log output). Only then is the interactive-input
 * fallback safe — headless runs must simply wait for terminalExited.
 */
export function looksInteractive(raw: string): boolean {
  return /───|⬡|pi v\d|escape interrupt|Press ctrl\+o|↑\d+k|📊 \d{4}-/.test(raw);
}

/**
 * Pull the answer out of the streamed transcript.
 *
 * Headless `pi -p` output is clean: the answer is the meaningful line(s) after
 * pi's own log lines. Interactive TUI output is full of chrome; there the
 * answer is the meaningful line(s) after the last echo of the task text.
 */
export function extractAnswer(clean: string, task: string): string {
  const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);
  const meaningful = lines.filter((l) => !CHROME_RE.test(l));
  let lastEcho = -1;
  for (let i = 0; i < meaningful.length; i++) {
    if (task && meaningful[i].includes(task)) lastEcho = i;
  }
  const after = lastEcho >= 0 ? meaningful.slice(lastEcho + 1) : meaningful;
  return after.join('\n').trim() || meaningful.join('\n').trim();
}

// ─── JSON-RPC plumbing (short-lived broker client) ─────────────────────────

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  method: string;
  timer: ReturnType<typeof setTimeout>;
}

interface BrokerActionParams {
  action?: Record<string, unknown>;
}

class BrokerClient {
  private ws?: WebSocket;
  private seq = 0;
  private pending = new Map<number, PendingRpc>();
  onAction: ((params: BrokerActionParams) => void) | null = null;

  constructor(
    private readonly url: string,
    readonly clientId: string,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('websocket error'));
      this.ws.onmessage = (event: MessageEvent<unknown>) => {
        const raw = typeof event.data === 'string' ? event.data : String(event.data ?? '');
        this.onMessage(raw);
      };
    });
  }

  private onMessage(raw: string): void {
    let msg: {
      id?: number | null;
      method?: string;
      result?: unknown;
      error?: { message?: string };
      params?: BrokerActionParams;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.id !== null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method}: ${JSON.stringify(msg.error)}`));
      else p.resolve(msg.result ?? null);
      return;
    }
    if (msg.method === 'action' && this.onAction) {
      this.onAction(msg.params ?? {});
    }
  }

  rpc(method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not open'));
        return;
      }
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not open');
    }
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
  }
}

// ─── Main dispatch ──────────────────────────────────────────────────────────

/**
 * Dispatch a task to a swarm worker and collect the streamed result.
 *
 * Opens a short-lived broker connection, finds the worker's external terminal
 * (by deviceName/hostAgentName === pool), subscribes with
 * `command: "pi -p '<task>'"`, collects `terminalData` until `terminalExited`
 * (with the interactive-input fallback for older daemons), strips ANSI, and
 * returns the extracted result text. Timeout ~300s.
 */
export async function dispatchTaskToWorker(opts: DispatchOptions): Promise<DispatchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = new BrokerClient(opts.brokerUrl, `obsidian-pi-dispatch-${Date.now()}`);
  const deadline = Date.now() + timeoutMs;

  try {
    await client.connect();
    await client.rpc('initialize', {
      channel: 'ahp-root://',
      protocolVersions: [PROTOCOL_VERSION],
      clientId: client.clientId,
    });

    // 1. Subscribe to the root catalogue to find the worker's external terminal.
    const rootSnap = (await client.rpc('subscribe', { channel: 'ahp-root://' })) as
      | Record<string, unknown>
      | undefined;
    const state = (rootSnap?.snapshot as Record<string, unknown> | undefined)?.state as
      | Record<string, unknown>
      | undefined;
    const terminals = (state?.terminals ?? []) as Array<{ resource?: string; title?: string }>;
    const match = terminals.find((t) => {
      const uri = t.resource ?? '';
      if (opts.instance) {
        return uri === `ahp-terminal:/ext-${opts.pool}-${opts.instance}` || uri.endsWith(`-${opts.instance}`);
      }
      return uri.startsWith(`ahp-terminal:/ext-${opts.pool}-`);
    });
    if (!match?.resource) {
      return {
        text: '',
        exitCode: null,
        timedOut: false,
        interactiveFallback: false,
        terminalUri: '',
        error: `no external terminal for pool '${opts.pool}' (available: ${terminals.map((t) => t.resource).join(', ') || 'none'})`,
      };
    }
    const terminalUri = match.resource;

    // 2. Build the headless command: `pi -p "<task>"` (shell-quoted for the daemon's `$SHELL -c`).
    const command = `pi -p ${shq(opts.task)}`;

    // 3. Subscribe to the terminal WITH the command. The broker stores it and
    //    forwards it in startTerminalStream → the daemon spawns `$SHELL -c command`.
    let streamStarted = false;
    let exited = false;
    let exitCode: number | null = null;
    let rawOutput = '';
    let lastDataAt = Date.now();
    let interactiveMode = false;
    let interactiveSent = false;
    let interactiveDone = false;

    client.onAction = (params) => {
      const action = params?.action;
      if (!action) return;
      if (action.type === 'terminal/data' && typeof action.data === 'string') {
        streamStarted = true;
        lastDataAt = Date.now();
        rawOutput += action.data;
      } else if (action.type === 'terminal/exited') {
        exited = true;
        exitCode = typeof action.exitCode === 'number' ? action.exitCode : null;
      }
    };

    await client.rpc('subscribe', { channel: terminalUri, command });

    // 4. Wait for terminalExited (headless path) with an interactive fallback for
    //    older daemons that ignore the command field.
    while (!exited && Date.now() < deadline) {
      if (
        !interactiveMode &&
        !exited &&
        streamStarted &&
        Date.now() - lastDataAt > INTERACTIVE_FALLBACK_GRACE_MS &&
        looksInteractive(rawOutput)
      ) {
        // No exit after the stream started AND the output looks like the interactive
        // `pi` TUI → the daemon ignored the command (old build / already streaming).
        // Type the task into it and watch for the completed turn.
        interactiveMode = true;
        client.notify('dispatchAction', {
          channel: terminalUri,
          clientSeq: 1,
          action: { type: 'terminal/input', data: `${opts.task}\r` },
        });
        interactiveSent = true;
        lastDataAt = Date.now();
      }
      if (interactiveMode && interactiveSent && !interactiveDone && Date.now() - lastDataAt > INTERACTIVE_QUIET_MS) {
        // Quiet period after the turn started → the interactive pi finished responding.
        interactiveDone = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    if (!exited && !interactiveDone) {
      return {
        text: '',
        exitCode: null,
        timedOut: true,
        interactiveFallback: interactiveMode,
        terminalUri,
        error: `timed out after ${Math.round(timeoutMs / 1000)}s (no terminalExited, no completed turn)`,
      };
    }

    // 5. Extract the result.
    const clean = stripAnsi(rawOutput);
    const text = extractAnswer(clean, opts.task);
    return { text, exitCode, timedOut: false, interactiveFallback: interactiveMode, terminalUri };
  } catch (err) {
    return {
      text: '',
      exitCode: null,
      timedOut: false,
      interactiveFallback: false,
      terminalUri: '',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    client.close();
  }
}
