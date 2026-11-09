/**
 * PtyClient — node-pty subprocess manager for `pi` interactive mode.
 *
 * Spawns the real pi TUI under a pseudoterminal so xterm.js can render the full
 * interactive experience (header, messages, tools, footer) with genuine terminal
 * controls (scrollback, selection, resize, links, full keyboard). This is the
 * "pi terminal" view — the alternative to the DOM-based ChatView/RpcClient.
 *
 * Responsibilities
 * ────────────────
 * • Spawn pi interactive mode (no `--mode rpc`) under node-pty, with the bundled
 *   obsidian-bridge extension loaded via `-e`.
 * • Pipe stdout ANSI → listeners (xterm `write`); pipe keystrokes → PTY stdin.
 * • Resize the PTY when xterm recomputes cols/rows.
 * • submitPrompt(text): write a custom APC marker to the PTY that the bridge
 *   extension's stub editor recognizes and submits. Bracketed-paste fallback
 *   is available via submitPromptViaPaste().
 * • Recover from subprocess crashes with exponential back-off (mirrors RpcClient).
 *
 * NOTE: This intentionally reuses BinaryInfo (path + nodeExe) from binary.ts so the
 * argv is built exactly like RpcClient, minus `--mode rpc` and plus `-e bridge`.
 */

import type { IPty } from 'node-pty';
import * as fs from 'fs';
import * as path from 'path';
import type { BinaryInfo } from '../binary';
import { findNodeExecutable } from '../binary';
import {
  NO_PI_BINARY_ERROR, buildStartArgv,
} from './launcher';
import {
  SubprocessLifecycle,
  gracefulKill,
  type SubprocessState,
} from './SubprocessLifecycle';
import type { AgentEvent } from '../notifications/AgentNotifier';
// APC marker constants live in the Node-free `apc.ts` module so that
// `AhpTerminalAdapter` (loaded on mobile) can import them without dragging
// this file's top-level `require('fs'|'path')` into the mobile load path.
// Imported here for local use and re-exported for the existing local-PTY callers.
import {
  APC_PREFIX, APC_TERM, APC_PAYLOAD, APC_ANSWER_PREFIX,
  APC_RENDER_CANVAS_PREFIX, APC_RENDER_CANVAS_RESULT_PREFIX,
} from './apc';
export {
  APC_PREFIX, APC_TERM, APC_PAYLOAD, APC_ANSWER_PREFIX,
  APC_RENDER_CANVAS_PREFIX, APC_RENDER_CANVAS_RESULT_PREFIX,
};

// ─── Public API types ────────────────────────────────────────────────────────

export type PtyClientState = SubprocessState;

export type PtyStateListener = (state: PtyClientState, error?: Error) => void;
export type PtyDataListener  = (data: string) => void;
export type PtyNotifyListener = (event: AgentEvent) => void;
/** Fired with the new PTY size on every resize() call. */
export type PtyResizeListener = (cols: number, rows: number) => void;
/** Fired when the underlying process exits, with its exit code (and signal). */
export type PtyExitListener = (exitCode: number, signal?: number) => void;

export interface PtyClientOptions {
  /**
   * Auto-detected pi location. Optional when `startCommand` is set — the command
   * string fully replaces the `[nodeExe, cli.js]` prefix in that case.
   */
  binaryInfo?:        BinaryInfo;
  /**
   * Custom command used to launch the agent (e.g. `sand-pi`). When set, it
   * replaces the detected pi binary and the standard pi flags are appended.
   */
  startCommand?:      string;
  /** Absolute path to the bundled obsidian-bridge.ts extension. */
  bridgeExtensionPath: string;
  /** Absolute path to the node-pty module folder (e.g. <plugin>/node_modules/node-pty).
   *  Required lazily by absolute path because Obsidian's renderer `require` does
   *  not resolve the plugin's node_modules on its own. */
  nodePtyPath:        string;
  cwd?:               string;        // vault path when vaultAsCwd is enabled
  model?:             string;        // --model flag
  thinkingLevel?:     string;        // --thinking flag
  agentDir?:          string;        // --agent-dir flag
  extraArgs?:         string[];
  env?:               Record<string, string>;
  /** Stable instance id for notification routing. */
  instanceId?:        string;
  /** Initial PTY size. Resized to match xterm after the view lays out. */
  cols?:              number;
  rows?:              number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

// STOP_GRACEFUL_MS and RESTART_DELAYS_MS live in ./SubprocessLifecycle (shared
// with RpcClient — this file's state machine used to "mirror" RpcClient's).

// APC submit marker format (must match the bridge extension parser):
//   ESC _ pi:prompt:<base64(text)> ESC \     (ST-terminated APC)
// (Constants imported from ./apc and re-exported above.)

// Reverse-direction get-text request (no payload). The bridge replies with:
//   ESC _ pi:text:<base64(text)> ESC \
const APC_GETTEXT_REQUEST = APC_PREFIX + 'pi:get-text' + APC_TERM;
const APC_CLEARTEXT_REQUEST = APC_PREFIX + 'pi:clear-text' + APC_TERM;
const APC_TEXT_RESPONSE_RE = /\x1b_pi:text:([A-Za-z0-9+/=]*)\x1b\\/;

// Agent notification marker emitted by the obsidian-bridge extension:
//   ESC _ pi:notify:<base64(JSON)> ESC \
const APC_NOTIFY_RE = /\x1b_pi:notify:([A-Za-z0-9+/=]*)\x1b\\/g;

// Agent answer marker written BY the plugin back to the PTY stdin so the
// obsidian-bridge proxy can resolve an in-flight question_user panel from a
// notification reply (terminal mode):
//   ESC _ pi:answer:<questionId>:<base64(JSON {answer,wasCustom})> ESC \
// (APC_ANSWER_PREFIX imported from ./apc and re-exported above.)

// Canvas native-capture round-trip markers:
//   request: ESC _ pi:render-canvas:<base64(JSON {requestId, canvasPath})> ESC \
//   result:  ESC _ pi:render-canvas-result:<base64(JSON {requestId, success, error?, pngB64?})> ESC \
const APC_RENDER_CANVAS_REQUEST_RE = /\x1b_pi:render-canvas:([A-Za-z0-9+/=]*)\x1b\\/;

// ─── PtyClient ───────────────────────────────────────────────────────────────

export class PtyClient {
  private proc: IPty | null = null;
  private dataSub: { dispose(): void } | null = null;
  private exitSub: { dispose(): void } | null = null;
  private ptyMod: typeof import('node-pty') | null = null;
  private helperFixed = false;

  /** Shared subprocess state machine (state set, listeners, restart backoff,
   *  dispose-guard, in-flight connect dedup — see SubprocessLifecycle). */
  private readonly lifecycle = new SubprocessLifecycle();
  private dataListeners:   PtyDataListener[]  = [];
  private notifyListeners: PtyNotifyListener[] = [];
  private resizeListeners: PtyResizeListener[] = [];
  private exitListeners:   PtyExitListener[]   = [];

  /** Last known PTY size, kept current by resize() and the spawn size. */
  private _cols: number;
  private _rows: number;

  private exitError: Error | null = null;
  /** Captures the first chunk(s) of PTY output for crash diagnostics. */
  private debugFirstData = '';
  /** Stable instance id used for agent notifications. */
  private readonly instanceId: string;
  /** Effective working directory used for agent notifications. */
  private readonly cwd: string;

  // ── Reverse APC: pull TUI editor text back into the plugin ──────────────
  /** Resolve function for an in-flight requestEditorText() call. */
  private pendingTextResolve: ((text: string) => void) | null = null;
  /** Reject function for an in-flight requestEditorText() call. */
  private pendingTextReject: ((err: Error) => void) | null = null;
  /** Timeout guard for requestEditorText(). */
  private pendingTextTimer: ReturnType<typeof setTimeout> | null = null;
  /** Held-back tail of a data chunk that may be the start of a partial APC
   *  pi:text response marker (reassembled with the next chunk). */
  private apcScanRemainder = '';
  /** Held-back tail of a data chunk that may be the start of a partial APC
   *  pi:notify marker (reassembled with the next chunk). */
  private notifyScanRemainder = '';

  // ── Reverse APC: canvas native-capture request from pi ────────────────────
  /** Handler invoked when a `pi:render-canvas` request marker arrives. */
  private renderCanvasHandler: ((canvasPath: string) => Promise<Buffer>) | null = null;
  /** Held-back tail of a partial `pi:render-canvas` request marker. */
  private renderCanvasScanRemainder = '';

  readonly options: PtyClientOptions;
  readonly submitMode: 'apc' | 'paste';

  constructor(options: PtyClientOptions, submitMode: 'apc' | 'paste' = 'apc') {
    this.options = options;
    this.submitMode = submitMode;
    this.instanceId = options.instanceId ?? 'default';
    this.cwd = options.cwd ?? '';
    this._cols = options.cols ?? 80;
    this._rows = options.rows ?? 24;
  }

  // ── State ────────────────────────────────────────────────────────────────

  get state(): PtyClientState { return this.lifecycle.state; }

  // ── Subscription ─────────────────────────────────────────────────────────

  onStateChange(listener: PtyStateListener): () => void {
    return this.lifecycle.onStateChange(listener);
  }

  /** Subscribe to ANSI data streamed from the pi TUI. Returns unsub. */
  onData(listener: PtyDataListener): () => void {
    this.dataListeners.push(listener);
    return () => { this.dataListeners = this.dataListeners.filter(l => l !== listener); };
  }

  /** Subscribe to agent lifecycle events forwarded from the pi TUI. Returns unsub. */
  onNotify(listener: PtyNotifyListener): () => void {
    this.notifyListeners.push(listener);
    return () => { this.notifyListeners = this.notifyListeners.filter(l => l !== listener); };
  }

  /** Subscribe to local PTY resizes (every resize() call). Returns unsub. */
  onResize(listener: PtyResizeListener): () => void {
    this.resizeListeners.push(listener);
    return () => { this.resizeListeners = this.resizeListeners.filter(l => l !== listener); };
  }

  /** Subscribe to process exit (exit code + signal). Returns unsub. */
  onExit(listener: PtyExitListener): () => void {
    this.exitListeners.push(listener);
    return () => { this.exitListeners = this.exitListeners.filter(l => l !== listener); };
  }

  /** Current PTY width (cols) — the last resize() or spawn size. */
  get cols(): number { return this._cols; }
  /** Current PTY height (rows) — the last resize() or spawn size. */
  get rows(): number { return this._rows; }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Spawn the pi subprocess. Idempotent: joins any in-flight connect/recovery
   *  spawn; no-op if already connected. */
  async connect(): Promise<void> {
    await this.lifecycle.connect(() => this.spawn());
  }

  /** Tear down the subprocess permanently. */
  async dispose(): Promise<void> {
    this.lifecycle.markDisposed();
    await this.kill();
    this.dataListeners = [];
    // Historical behavior: PtyClient.dispose clears its state listeners before
    // the final transition, so dispose itself emits no 'disconnected' event.
    this.lifecycle.clearStateListeners();
    this.lifecycle.setState('disconnected');
  }

  // ── I/O ──────────────────────────────────────────────────────────────────

  /** Write raw bytes/keystrokes to the PTY stdin (from xterm.onData). */
  write(data: string): void {
    this.proc?.write(data);
  }

  /** Resize the PTY to match the xterm viewport. */
  resize(cols: number, rows: number): void {
    try { this.proc?.resize(cols, rows); } catch { /* process may have exited */ }
    if (cols > 0) this._cols = cols;
    if (rows > 0) this._rows = rows;
    for (const l of this.resizeListeners) l(this._cols, this._rows);
  }

  /**
   * Submit a prompt from the floating Obsidian editor to pi.
   * Default mode writes the APC marker; the bridge stub editor decodes and
   * submits it via pi's normal path.
   */
  submitPrompt(text: string): void {
    if (this.submitMode === 'paste') {
      this.submitPromptViaPaste(text);
    } else {
      this.submitPromptViaApc(text);
    }
  }

  /** APC marker submit (default). */
  private submitPromptViaApc(text: string): void {
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    this.write(APC_PREFIX + APC_PAYLOAD + b64 + APC_TERM);
  }

  /**
   * Resolve an in-flight question_user panel (terminal mode) from a
   * notification reply by writing a `pi:answer:<questionId>:` APC marker to
   * the PTY stdin. The obsidian-bridge proxy component (which holds the
   * panel's `done` resolver for this questionId) intercepts it and feeds the
   * answer back to the tool. No-op if the PTY isn't connected.
   */
  sendQuestionAnswer(questionId: string, answer: string, wasCustom: boolean): void {
    if (this.state !== 'connected' || !this.proc) return;
    const json = JSON.stringify({ answer, wasCustom });
    const b64 = Buffer.from(json, 'utf8').toString('base64');
    this.write(APC_PREFIX + APC_ANSWER_PREFIX + questionId + ':' + b64 + APC_TERM);
  }

  /**
   * Bracketed-paste + Enter fallback (used if APC ever fails to pass through).
   * ESC bytes are stripped from the text first: prompt text can embed resolved
   * note content, and a note containing the paste-end sequence (`ESC [201~`)
   * would otherwise break out of the bracketed paste and inject raw keystrokes
   * into the pi TUI (terminal input injection). APC mode is immune (base64).
   */
  private submitPromptViaPaste(text: string): void {
    const sanitized = text.replace(/\x1b/g, '');
    this.write('\x1b[200~' + sanitized + '\x1b[201~' + '\r');
  }

  // ── Reverse APC: pull TUI editor text ─────────────────────────────────────

  /**
   * Request the current text from pi's in-terminal editor and resolve with it.
   *
   * Writes the `pi:get-text` APC marker to the PTY; the obsidian-bridge
   * extension's editor replies on stdout with `pi:text:<base64>` (see
   * obsidian-bridge.ts). The response is intercepted in the data stream
   * (stripApcTextResponse) before it reaches xterm.js, decoded, and used to
   * resolve this promise.
   *
   * @param timeoutMs  Reject if no response arrives within this window.
   * @returns The editor's current text (paste-marker-expanded).
   */
  requestEditorText(timeoutMs = 2000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (this.state !== 'connected') {
        reject(new Error('pi terminal is not connected'));
        return;
      }
      if (this.pendingTextResolve) {
        reject(new Error('A pull-from-TUI request is already in progress'));
        return;
      }
      this.pendingTextResolve = resolve;
      this.pendingTextReject = reject;
      this.write(APC_GETTEXT_REQUEST);
      this.pendingTextTimer = setTimeout(() => {
        // Flush any held-back partial-marker data so xterm isn't starved.
        if (this.apcScanRemainder) {
          const held = this.apcScanRemainder;
          this.apcScanRemainder = '';
          for (const l of this.dataListeners) l(held);
        }
        this.cancelPendingTextRequest();
        reject(new Error('Timed out waiting for TUI editor text'));
      }, timeoutMs);
    });
  }

  /**
   * Clear the pi in-terminal editor by sending a reverse APC marker.
   * The obsidian-bridge extension empties its text and moves the cursor to col 0.
   */
  clearTuiEditor(): void {
    if (!this.proc || this.state !== 'connected') return;
    this.write(APC_CLEARTEXT_REQUEST);
  }

  /**
   * Register the handler that satisfies `pi:render-canvas` requests from the
   * pi side. The handler receives the vault-relative canvas path and must
   * resolve with a PNG buffer; PtyClient will write the `pi:render-canvas-result`
   * marker back to the PTY.
   */
  setRenderCanvasHandler(handler: (canvasPath: string) => Promise<Buffer>): void {
    this.renderCanvasHandler = handler;
  }

  /** Clear an in-flight request without rejecting it (caller already rejected/resolved). */
  private cancelPendingTextRequest(): void {
    this.pendingTextResolve = null;
    this.pendingTextReject = null;
    if (this.pendingTextTimer) { clearTimeout(this.pendingTextTimer); this.pendingTextTimer = null; }
  }

  /**
   * Scan a PTY data chunk for complete `pi:notify:<base64(JSON)>` APC markers
   * emitted by the obsidian-bridge extension. When found: decode the JSON,
   * stamp it with this instance's id/cwd, emit to notify listeners, and strip
   * the marker so xterm never sees it. Partial prefixes are held back and
   * reassembled with the next chunk.
   */
  private stripApcNotifyMarkers(data: string): string {
    const combined = this.notifyScanRemainder + data;
    this.notifyScanRemainder = '';

    const matches = [...combined.matchAll(APC_NOTIFY_RE)];
    for (const m of matches) {
      try {
        const json = Buffer.from(m[1] ?? '', 'base64').toString('utf8');
        const event = JSON.parse(json) as AgentEvent;
        event.instanceId = this.instanceId;
        event.cwd = this.cwd;
        for (const l of this.notifyListeners) l(event);
      } catch {
        // Malformed notify marker — ignore quietly.
      }
    }

    const cleaned = combined.replace(APC_NOTIFY_RE, '');

    const held = this.extractPartialNotifyPrefix(cleaned);
    if (held) {
      this.notifyScanRemainder = held;
      return cleaned.slice(0, cleaned.length - held.length);
    }
    return cleaned;
  }

  /**
   * If `data` ends with what could be the start of an APC `pi:notify:` marker
   * (without its ST terminator), return that trailing fragment so it can be
   * reassembled with the next chunk. Returns '' when the tail is not a
   * candidate partial prefix.
   */
  private extractPartialNotifyPrefix(data: string): string {
    const prefix = '\x1b_pi:notify:';
    const start = data.lastIndexOf('\x1b_');
    if (start !== -1) {
      const tail = data.slice(start);
      // Already ST-terminated → the regex above would have matched; not partial.
      if (tail.includes('\x1b\\')) return '';
      // Candidate if the tail is a prefix of the marker, or the marker plus a
      // partial base64 payload (base64 never contains ESC, so a payload can't
      // hide a later APC start).
      if (prefix.startsWith(tail) || tail.startsWith(prefix)) return tail;
      return '';
    }
    // A lone trailing ESC could be the first byte of `ESC _`.
    if (data.endsWith('\x1b')) return '\x1b';
    return '';
  }

  /**
   * Scan a PTY data chunk for a complete `pi:text:<base64>` APC response
   * marker. When found: decode the text, resolve the pending
   * requestEditorText() promise, and strip the marker so xterm never sees it.
   * A potential partial-marker prefix at the tail is held back for the next
   * chunk. When no request is pending, data passes through untouched (zero
   * overhead on the normal streaming path).
   */
  private stripApcTextResponse(data: string): string {
    // Fast path: no pending request and no held-back remainder → passthrough.
    if (!this.pendingTextResolve && !this.apcScanRemainder) return data;

    const combined = this.apcScanRemainder + data;
    this.apcScanRemainder = '';

    const m = combined.match(APC_TEXT_RESPONSE_RE);
    if (m) {
      const text = Buffer.from(m[1] ?? '', 'base64').toString('utf8');
      const out = combined.replace(m[0], '');
      const resolve = this.pendingTextResolve;
      this.cancelPendingTextRequest();
      resolve?.(text);
      return out;
    }

    // No complete marker yet. Only hold back a possible partial prefix when a
    // request is actually in flight (otherwise forward everything immediately).
    if (this.pendingTextResolve) {
      const held = this.extractPartialApcPrefix(combined);
      if (held) {
        this.apcScanRemainder = held;
        return combined.slice(0, combined.length - held.length);
      }
    }
    return combined;
  }

  /**
   * If `data` ends with what could be the start of an APC `pi:text:` response
   * marker (without its ST terminator), return that trailing fragment so it can
   * be reassembled with the next chunk. Returns '' when the tail is not a
   * candidate partial prefix.
   *
   * The base64 payload can be long (the whole TUI editor text), so a response
   * marker routinely straddles PTY chunk boundaries mid-payload. We therefore
   * scan the ENTIRE chunk for the last APC start (`ESC _`) — not just an
   * 11-char tail — and hold back everything from there when it is an
   * unterminated `pi:text:` marker. An over-long hold-back cannot starve xterm:
   * the requestEditorText() timeout flushes any held remainder.
   */
  private extractPartialApcPrefix(data: string): string {
    const prefix = '\x1b_pi:text:';
    const start = data.lastIndexOf('\x1b_');
    if (start !== -1) {
      const tail = data.slice(start);
      // Already ST-terminated → the regex above would have matched; not partial.
      if (tail.includes('\x1b\\')) return '';
      // Candidate if the tail is a prefix of the marker, or the marker plus a
      // partial base64 payload (base64 never contains ESC, so a payload can't
      // hide a later APC start).
      if (prefix.startsWith(tail) || tail.startsWith(prefix)) return tail;
      return '';
    }
    // A lone trailing ESC could be the first byte of `ESC _`.
    if (data.endsWith('\x1b')) return '\x1b';
    return '';
  }

  /**
   * Scan a PTY data chunk for a complete `pi:render-canvas:` request marker
   * emitted by the obsidian-bridge extension. When found: decode the JSON
   * payload, invoke the registered capture handler, and write back a
   * `pi:render-canvas-result` marker with the PNG (base64) or an error. The
   * request marker is stripped so xterm never sees it. Partial markers are
   * held back for reassembly across chunks.
   */
  private stripApcRenderCanvasRequest(data: string): string {
    const combined = this.renderCanvasScanRemainder + data;
    this.renderCanvasScanRemainder = '';

    const m = combined.match(APC_RENDER_CANVAS_REQUEST_RE);
    if (m) {
      const payload = Buffer.from(m[1] ?? '', 'base64').toString('utf8');
      let request: { requestId?: string; canvasPath?: string } = {};
      try {
        request = JSON.parse(payload);
      } catch {
        // Malformed payload — strip and ignore.
        return combined.replace(m[0], '');
      }
      const out = combined.replace(m[0], '');
      const { requestId, canvasPath } = request;
      if (
        typeof requestId === 'string' &&
        typeof canvasPath === 'string' &&
        this.renderCanvasHandler
      ) {
        void (async () => {
          try {
            const png = await this.renderCanvasHandler!(canvasPath);
            const pngB64 = png.toString('base64');
            const result = JSON.stringify({ requestId, success: true, pngB64 });
            this.write(
              APC_PREFIX + APC_RENDER_CANVAS_RESULT_PREFIX + Buffer.from(result, 'utf8').toString('base64') + APC_TERM,
            );
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            const result = JSON.stringify({ requestId, success: false, error });
            this.write(
              APC_PREFIX + APC_RENDER_CANVAS_RESULT_PREFIX + Buffer.from(result, 'utf8').toString('base64') + APC_TERM,
            );
          }
        })();
      }
      return out;
    }

    const held = this.extractPartialRenderCanvasPrefix(combined);
    if (held) {
      this.renderCanvasScanRemainder = held;
      return combined.slice(0, combined.length - held.length);
    }
    return combined;
  }

  /**
   * If `data` ends with what could be the start of an APC `pi:render-canvas:`
   * request marker (without its ST terminator), return that trailing fragment
   * so it can be reassembled with the next chunk.
   */
  private extractPartialRenderCanvasPrefix(data: string): string {
    const prefix = '\x1b_pi:render-canvas:';
    const start = data.lastIndexOf('\x1b_');
    if (start !== -1) {
      const tail = data.slice(start);
      if (tail.includes('\x1b\\')) return '';
      if (prefix.startsWith(tail) || tail.startsWith(prefix)) return tail;
      return '';
    }
    if (data.endsWith('\x1b')) return '\x1b';
    return '';
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  /**
   * Lazily require node-pty by absolute path. Obsidian's renderer require does
   * not resolve the plugin's node_modules, so we pass the absolute module path.
   * node-pty's internal requires (its JS + native binding) resolve from its own
   * __dirname, so loading via the package folder works correctly.
   */
  private getPtyModule(): typeof import('node-pty') {
    if (this.ptyMod) return this.ptyMod;
    let mod: typeof import('node-pty');
    try {
      mod = require(this.options.nodePtyPath);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error('[obsidian-pi:pty] node-pty load failed from', this.options.nodePtyPath, err);
      throw new Error(
        'Failed to load node-pty from ' + this.options.nodePtyPath +
        '. Ensure node-pty is installed in the plugin folder (npm install). Details: ' + detail,
      );
    }
    this.ptyMod = mod;
    return mod;
  }

  /**
   * On macOS, node-pty execs a `spawn-helper` binary via posix_spawnp. The
   * prebuilt helpers are sometimes extracted without the execute bit (mode 644),
   * which makes posix_spawnp fail with EACCES ("posix_spawnp failed."). We
   * self-heal by chmod 0o755-ing every spawn-helper shipped under node-pty.
   * Idempotent (runs once per client).
   */
  private ensureHelperExecutable(): void {
    if (this.helperFixed) return;
    this.helperFixed = true;
    const base = this.options.nodePtyPath;
    const targets: string[] = [path.join(base, 'build', 'Release', 'spawn-helper')];
    try {
      const prebuildsDir = path.join(base, 'prebuilds');
      if (fs.existsSync(prebuildsDir)) {
        for (const sub of fs.readdirSync(prebuildsDir)) {
          targets.push(path.join(prebuildsDir, sub, 'spawn-helper'));
        }
      }
    } catch { /* ignore */ }
    for (const t of targets) {
      try {
        if (fs.existsSync(t)) {
          fs.chmodSync(t, 0o755);
          console.log('[obsidian-pi:pty] chmod +x spawn-helper:', t);
        }
      } catch (e) {
        console.warn('[obsidian-pi:pty] could not chmod spawn-helper', t, e);
      }
    }
  }

  /** Build the spawn argv from BinaryInfo + options (mirrors RpcClient.buildArgv). */
  private buildArgv(): { exe: string; args: string[] } {
    const { binaryInfo, startCommand, model, thinkingLevel, agentDir, extraArgs, bridgeExtensionPath } = this.options;
    const args: string[] = [];
    if (model)         args.push('--model', model);
    if (thinkingLevel) args.push('--thinking', thinkingLevel);
    if (agentDir)      args.push('--agent-dir', agentDir);
    // Load the bundled bridge extension that swaps in the stub editor.
    args.push('-e', bridgeExtensionPath);
    if (extraArgs)     args.push(...extraArgs);

    // Custom start command (e.g. `sand-pi`) replaces the detected pi binary prefix.
    const cmd = startCommand?.trim();
    if (cmd) {
      return buildStartArgv(cmd, args); // throws a helpful error if missing/invalid
    }

    if (binaryInfo?.nodeExe) {
      return { exe: binaryInfo.nodeExe, args: [binaryInfo.path, ...args] };
    }
    if (binaryInfo) {
      return { exe: binaryInfo.path, args };
    }
    throw new Error(NO_PI_BINARY_ERROR);
  }

  /** Prepend the node executable's directory to PATH so `#!/usr/bin/env node` shebangs resolve. */
  private async ensureNodeOnPath(env: { [key: string]: string | undefined }): Promise<void> {
    let nodeExe = this.options.binaryInfo?.nodeExe;
    if (!nodeExe) {
      try { nodeExe = await findNodeExecutable(); } catch { /* no node found; leave PATH as-is */ return; }
    }
    if (!nodeExe) return;
    const dir = path.dirname(nodeExe);
    const cur = env.PATH ?? '';
    if (!cur.split(':').includes(dir)) {
      env.PATH = dir + (cur ? ':' + cur : '');
    }
  }

  private async spawn(): Promise<void> {
    this.exitError = null;
    this.lifecycle.setState('connecting');

    const { exe, args } = this.buildArgv();
    const childEnv = { ...process.env, ...this.options.env } as { [key: string]: string | undefined };
    // A TTY needs a TERM cap pi's TUI recognises; xterm-256color is safe.
    childEnv['TERM'] = childEnv['TERM'] || 'xterm-256color';
    // Mark the subprocess as being hosted by the obsidian-pi plugin so the
    // render_canvas extension tool can prefer native Obsidian capture instead
    // of the SVG fallback (and skip the native timeout when running standalone).
    childEnv['OBSIDIAN_PI_HOST'] = '1';
    // Ensure `node` is resolvable for wrapper scripts (e.g. sand-pi run.sh) whose
    // inner pi uses a `#!/usr/bin/env node` shebang.
    await this.ensureNodeOnPath(childEnv);

    const cols = this.options.cols ?? 80;
    const rows = this.options.rows ?? 24;

    let proc: IPty;
    try {
      const pty = this.getPtyModule();
      this.ensureHelperExecutable();
      proc = pty.spawn(exe, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: this.options.cwd,
        env: childEnv,
        encoding: 'utf8',
      });
    } catch (err) {
      const e = new Error(
        `Failed to spawn pi PTY: ${err instanceof Error ? err.message : String(err)}`,
      );
      console.error('[obsidian-pi:pty] spawn failed:', err);
      console.error('[obsidian-pi:pty] argv:', exe, args);
      this.lifecycle.setState('crashed', e);
      throw e;
    }

    this.proc = proc;

    this.dataSub = proc.onData((data: string) => {
      if (this.debugFirstData.length < 2000) {
        this.debugFirstData = (this.debugFirstData + data).slice(0, 2000);
      }
      // Intercept agent-lifecycle `pi:notify` markers (Phase 12) before xterm.
      const afterNotify = this.stripApcNotifyMarkers(data);
      // Intercept reverse-APC `pi:text` response markers (Pull from TUI)
      // before forwarding to xterm, so the marker never renders and the
      // requestEditorText() promise resolves.
      const afterText = this.stripApcTextResponse(afterNotify);
      // Intercept `pi:render-canvas` requests from the pi side, run the
      // native capture, and write back `pi:render-canvas-result`.
      const cleaned = this.stripApcRenderCanvasRequest(afterText);
      if (cleaned) for (const l of this.dataListeners) l(cleaned);
    });

    this.exitSub = proc.onExit(({ exitCode, signal }) => {
      if (this.proc !== proc) return; // stale reference from a previous spawn
      for (const l of this.exitListeners) l(exitCode, signal);
      const err = new Error(`pi process exited (code=${exitCode} signal=${signal})`);
      // A clean exit (code 0, no signal) means the user quit pi intentionally
      // (/quit, Ctrl+C, `exit`) — don't resurrect it via the crash-restart loop.
      this.onProcessExit(err, exitCode === 0 && !signal);
    });

    // node-pty does not expose a synchronous "still alive" check, so we mark
    // connected immediately. If it died instantly, onExit will fire and recover.
    this.lifecycle.markConnected();
  }

  private onProcessExit(err: Error, cleanExit = false): void {
    // A clean exit (code 0, no signal) is intentional (/quit, Ctrl+C, exit) —
    // log it at debug level so it doesn't show as a red error in the dev console.
    // Real crashes (non-zero exit / signal) stay at console.error.
    if (cleanExit) {
      console.debug('[obsidian-pi:pty] process exited cleanly:', err.message);
    } else {
      console.error('[obsidian-pi:pty] process exit:', err.message);
      console.debug('[obsidian-pi:pty] first output:', JSON.stringify(this.debugFirstData.slice(0, 1000)));
    }
    this.debugFirstData = '';
    this.exitError = err;
    this.dataSub?.dispose();
    this.exitSub?.dispose();
    this.dataSub = null;
    this.exitSub = null;
    this.proc = null;

    // Abandon any in-flight Pull-from-TUI request so its promise rejects
    // promptly rather than waiting for the timeout.
    if (this.pendingTextReject) {
      this.pendingTextReject(new Error('pi process exited'));
    }
    this.cancelPendingTextRequest();
    this.apcScanRemainder = '';
    this.notifyScanRemainder = '';
    this.renderCanvasScanRemainder = '';

    if (this.lifecycle.isDisposed || cleanExit) {
      this.lifecycle.setState('disconnected');
      return;
    }

    this.lifecycle.scheduleRestart(err, () => this.spawn());
  }

  private async kill(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    this.dataSub?.dispose();
    this.exitSub?.dispose();
    this.dataSub = null;
    this.exitSub = null;
    if (!proc) return;

    // Resolve as soon as the process actually exits (don't always burn the
    // full grace window — dispose()/restartTerminalSession() await this).
    await gracefulKill({
      onExit: (cb) => {
        try { proc.onExit(() => cb()); } catch { /* already dead */ }
      },
      kill: (signal) => {
        try { proc.kill(signal); } catch { /* fine — a throw is handled by gracefulKill */ }
      },
    });
  }
}

/** Resolve the absolute path to the bundled bridge extension inside the plugin dir. */
export function bridgeExtensionAbsPath(vaultPath: string, pluginDir: string): string {
  return path.join(vaultPath, pluginDir, 'extensions', 'obsidian-bridge.ts');
}