/**
 * RpcClient — Obsidian-native subprocess manager for `pi --mode rpc`.
 *
 * Responsibilities
 * ────────────────
 * • Spawn pi using the resolved BinaryInfo (node + cli.js or direct binary).
 * • Drive strict JSONL framing (JsonlCodec) — never Node readline.
 * • Correlate commands ↔ responses by `id`; dispatch events to listeners.
 * • Recover from subprocess crashes with exponential back-off.
 * • Expose the narrow typed command API the plugin still uses.
 *
 * Note: the old chat-era command surface (steer/fork/clone/compact/model
 * cycling/session stats/…) was removed — the plugin no longer drives agent
 * turns over this client (terminals do, via PtyClient / AhpClient). Only
 * `prompt`, `getCommands` and lifecycle plumbing survive; extension-UI
 * requests emitted by pi are ignored (see handleLine).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import { attachJsonlReader, serializeLine } from './JsonlCodec';
import {
  SubprocessLifecycle,
  gracefulKill,
  type SubprocessState,
} from './SubprocessLifecycle';
import { NO_PI_BINARY_ERROR, buildStartArgv } from './launcher';
import type { BinaryInfo } from '../binary';
import { findNodeExecutable } from '../binary';
import type {
  RpcCommand, RpcResponse, RpcSuccessResponse,
  RpcEvent, ThinkingLevel, ImageContent, RpcSlashCommand,
} from '../types/rpc';

// ─── Public API types ────────────────────────────────────────────────────────

export type RpcClientState = SubprocessState;

export type RpcEventListener  = (event: RpcEvent) => void;
export type RpcStateListener  = (state: RpcClientState, error?: Error) => void;

// Shared transport interface — implemented by the local subprocess client
// (RpcClient) and the remote AHP WebSocket client (AhpClient).
export type PiClientState = RpcClientState;
export type PiEventListener = RpcEventListener;
export type PiStateListener = RpcStateListener;

/**
 * Shared transport interface — implemented by the local subprocess client
 * (RpcClient) and the remote AHP WebSocket client (AhpClient). Deliberately
 * narrow (chat-era methods removed; AUDIT §6.1): prompt + command listing +
 * lifecycle/event plumbing is all the plugin exercises today.
 */
export interface PiClient {
  readonly state: PiClientState;
  onEvent(listener: PiEventListener): () => void;
  onStateChange(listener: PiStateListener): () => void;
  connect(): Promise<void>;
  dispose(): Promise<void>;
  prompt(message: string, opts?: { images?: ImageContent[]; streamingBehavior?: 'steer' | 'followUp' }): Promise<void>;
  getCommands(): Promise<RpcSlashCommand[]>;
}

export interface RpcClientOptions {
  /**
   * Auto-detected pi location. Optional when `startCommand` is set — the command
   * string fully replaces the `[nodeExe, cli.js]` prefix in that case.
   */
  binaryInfo?:   BinaryInfo;
  /** Custom command used to launch the agent (e.g. `sand-pi`); replaces the detected binary. */
  startCommand?: string;
  cwd?:         string;        // vault path when vaultAsCwd is enabled
  model?:       string;        // --model flag
  thinkingLevel?: ThinkingLevel;  // --thinking flag
  agentDir?:    string;        // --agent-dir flag
  extraArgs?:   string[];
  env?:         Record<string, string>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const RESPONSE_TIMEOUT_MS  = 30_000;
const STARTUP_SETTLE_MS    = 100;
/** Max retained stderr bytes (tail) — only the last 500 are ever surfaced. */
const STDERR_CAP           = 8_192;

// STOP_GRACEFUL_MS and RESTART_DELAYS_MS live in ./SubprocessLifecycle (shared
// with PtyClient).

// ─── RpcClient ───────────────────────────────────────────────────────────────

export class RpcClient implements PiClient {
  private proc:            ChildProcessWithoutNullStreams | null = null;
  private stopStdoutReader: (() => void) | null = null;

  /** Shared subprocess state machine (state set, listeners, restart backoff,
   *  dispose-guard, in-flight connect dedup — see SubprocessLifecycle). */
  private readonly lifecycle = new SubprocessLifecycle();
  private eventListeners:  RpcEventListener[] = [];

  /** Pending command promises keyed by generated id. */
  private pending = new Map<string, {
    resolve: (r: RpcResponse) => void;
    reject:  (e: Error) => void;
    timer:   ReturnType<typeof setTimeout>;
  }>();

  private requestSeq      = 0;
  private stderr          = '';
  private exitError:      Error | null = null;

  readonly options: RpcClientOptions;

  constructor(options: RpcClientOptions) {
    this.options = options;
  }

  // ── State ────────────────────────────────────────────────────────────────

  get state(): RpcClientState { return this.lifecycle.state; }

  // ── Subscription ─────────────────────────────────────────────────────────

  /** Subscribe to lifecycle state changes. Returns an unsubscribe function. */
  onStateChange(listener: RpcStateListener): () => void {
    return this.lifecycle.onStateChange(listener);
  }

  /** Subscribe to all agent events (streamed from pi stdout). Returns unsub. */
  onEvent(listener: RpcEventListener): () => void {
    this.eventListeners.push(listener);
    return () => { this.eventListeners = this.eventListeners.filter(l => l !== listener); };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Spawn the pi subprocess and wait until it is ready to accept commands.
   * Idempotent: no-op if already connected; while a connect/spawn is in flight
   * ('connecting', or a crash-recovery spawn) callers join the SAME in-flight
   * promise instead of returning early or spawning a second child.
   */
  async connect(): Promise<void> {
    await this.lifecycle.connect(() => this.spawn());
  }

  /**
   * Tear down the subprocess permanently.  After dispose() the client cannot
   * be restarted — create a new instance if needed.
   */
  async dispose(): Promise<void> {
    this.lifecycle.markDisposed();
    this.lifecycle.setState('disconnected');
    await this.kill();
  }

  // ── Command API ──────────────────────────────────────────────────────────
  // Each method sends the corresponding RPC command and awaits the response.
  // Errors (success: false) are thrown as plain Error instances.
  // Chat-era methods (steer/fork/clone/compact/models/…) were removed — see
  // the header note.

  async prompt(message: string, opts?: { images?: ImageContent[]; streamingBehavior?: 'steer' | 'followUp' }): Promise<void> {
    await this.send({ type: 'prompt', message, ...opts });
  }

  async getCommands(): Promise<RpcSlashCommand[]> {
    const d = await this.send<{ commands: RpcSlashCommand[] }>({ type: 'get_commands' });
    return d!.commands;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Collected stderr output — useful for debugging on crash. */
  getStderr(): string { return this.stderr; }

  // ─── Internal ───────────────────────────────────────────────────────────

  /** Build the spawn argv from BinaryInfo + options. */
  private buildArgv(): { exe: string; args: string[] } {
    const { binaryInfo, startCommand, model, thinkingLevel, agentDir, extraArgs } = this.options;
    const rpcArgs: string[] = ['--mode', 'rpc'];
    if (model)         rpcArgs.push('--model', model);
    if (thinkingLevel) rpcArgs.push('--thinking', thinkingLevel);
    if (agentDir)      rpcArgs.push('--agent-dir', agentDir);
    if (extraArgs)     rpcArgs.push(...extraArgs);

    // Custom start command (e.g. `sand-pi`) replaces the detected pi binary prefix.
    const cmd = startCommand?.trim();
    if (cmd) {
      return buildStartArgv(cmd, rpcArgs); // throws a helpful error if missing/invalid
    }

    if (binaryInfo?.nodeExe) {
      return { exe: binaryInfo.nodeExe, args: [binaryInfo.path, ...rpcArgs] };
    }
    if (binaryInfo) {
      return { exe: binaryInfo.path, args: rpcArgs };
    }
    throw new Error(NO_PI_BINARY_ERROR);
  }

  /** Prepend the node executable's directory to PATH so `#!/usr/bin/env node` shebangs resolve. */
  private async ensureNodeOnPath(env: Record<string, string | undefined>): Promise<void> {
    let nodeExe = this.options.binaryInfo?.nodeExe;
    if (!nodeExe) {
      try { nodeExe = await findNodeExecutable(); } catch { return; }
    }
    if (!nodeExe) return;
    const dir = path.dirname(nodeExe);
    const cur = env.PATH ?? '';
    if (!cur.split(':').includes(dir)) {
      env.PATH = dir + (cur ? ':' + cur : '');
    }
  }

  private async spawn(): Promise<void> {
    this.stderr    = '';
    this.exitError = null;
    this.lifecycle.setState('connecting');

    const { exe, args } = this.buildArgv();
    const childEnv = { ...process.env, ...this.options.env };
    // Ensure `node` is resolvable for wrapper scripts (e.g. sand-pi run.sh) whose
    // inner pi uses a `#!/usr/bin/env node` shebang.
    await this.ensureNodeOnPath(childEnv);

    const child = spawn(exe, args, {
      cwd:   this.options.cwd,
      env:   childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    this.proc = child;

    // Collect stderr for diagnostics. Capped so a chatty long-lived process
    // can't grow the buffer without bound — only the tail is ever surfaced.
    child.stderr.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-STDERR_CAP);
    });

    // Watch for exit.
    child.once('exit', (code, signal) => {
      if (this.proc !== child) return; // stale reference from a previous spawn
      const err = new Error(
        `pi process exited (code=${code} signal=${signal}). Stderr: ${this.stderr.slice(-500)}`,
      );
      // A clean exit (code 0, no signal) means pi shut down intentionally —
      // don't resurrect it via the crash-restart loop.
      this.onProcessExit(err, code === 0 && !signal);
    });

    child.once('error', (err: Error) => {
      if (this.proc !== child) return;
      const wrapped = new Error(`pi process error: ${err.message}. Stderr: ${this.stderr.slice(-500)}`);
      this.onProcessExit(wrapped);
    });

    child.stdin.on('error', (err: Error) => {
      if (this.proc !== child) return;
      const wrapped = this.exitError ?? new Error(`pi stdin error: ${err.message}`);
      this.onProcessExit(wrapped);
    });

    // Attach the strict JSONL reader to stdout.
    this.stopStdoutReader = attachJsonlReader(child.stdout, (line) => this.handleLine(line));

    // Brief settle delay — mirrors pi's own RpcClient behaviour.
    await new Promise<void>((r) => setTimeout(r, STARTUP_SETTLE_MS));

    if (child.exitCode !== null) {
      const err = this.exitError ?? new Error(
        `pi process exited immediately (code=${child.exitCode}). Stderr: ${this.stderr.slice(-500)}`,
      );
      this.lifecycle.setState('crashed', err);
      throw err;
    }

    this.lifecycle.markConnected();  // listeners read the restart counter before it clears
  }

  private onProcessExit(err: Error, cleanExit = false): void {
    this.exitError = err;
    this.stopStdoutReader?.();
    this.stopStdoutReader = null;
    this.proc = null;
    this.rejectPending(err);

    if (this.lifecycle.isDisposed || cleanExit) {
      this.lifecycle.setState('disconnected');
      return;
    }

    this.lifecycle.scheduleRestart(err, () => this.spawn());
  }

  private async kill(): Promise<void> {
    this.stopStdoutReader?.();
    this.stopStdoutReader = null;
    const child = this.proc;
    this.proc = null;

    if (!child) return;

    this.rejectPending(new Error('RpcClient disposed'));

    await gracefulKill({
      onExit: (cb) => child.once('exit', cb),
      kill: (signal) => child.kill(signal),
    });
  }

  // ── Protocol ─────────────────────────────────────────────────────────────

  private handleLine(line: string): void {
    if (!line) return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // ignore malformed lines
    }

    // ── Response correlation ──────────────────────────────────────────────
    if (data['type'] === 'response' && typeof data['id'] === 'string') {
      const p = this.pending.get(data['id']);
      if (p) {
        this.pending.delete(data['id']);
        clearTimeout(p.timer);
        p.resolve(data as unknown as RpcResponse);
        return;
      }
    }

    // ── Agent events ──────────────────────────────────────────────────────
    // (extension_ui_request is no longer handled — the plugin never drives
    // agent turns over this client, so pi has no reason to surface its UI
    // sub-protocol here; the PTY/AHP terminal flows handle UI via APC
    // markers in the obsidian-bridge extension.)
    for (const l of this.eventListeners) l(data as unknown as RpcEvent);
  }

  private send<T = undefined>(command: RpcCommand): Promise<T | undefined> {
    if (this.state !== 'connected') {
      return Promise.reject(new Error(`RpcClient is not connected (state: ${this.state})`));
    }

    const id = `req_${++this.requestSeq}`;
    const full = { ...command, id };

    return new Promise<T | undefined>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for response to '${command.type}' (${RESPONSE_TIMEOUT_MS}ms)`));
      }, RESPONSE_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (res: RpcResponse) => {
          if (!res.success) {
            reject(new Error((res as { error: string }).error ?? `Command '${command.type}' failed`));
          } else {
            resolve((res as RpcSuccessResponse<T>).data as T | undefined);
          }
        },
        reject,
        timer,
      });

      try {
        this.write(serializeLine(full));
      } catch (err) {
        const p = this.pending.get(id);
        this.pending.delete(id);
        clearTimeout(timer);
        p?.reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private write(line: string): void {
    if (!this.proc?.stdin || this.proc.stdin.destroyed) {
      throw new Error('pi subprocess stdin is not writable');
    }
    this.proc.stdin.write(line);
  }

  private rejectPending(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
