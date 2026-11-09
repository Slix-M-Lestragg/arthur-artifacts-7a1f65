/**
 * AuthBridge — client for the `auth-bridge.mjs` subprocess.
 *
 * Bridges `AuthStorage` / `ModelRegistry` / `SettingsManager` from
 * `@earendil-works/pi-coding-agent` without bundling the SDK into `main.js`
 * (see TECHNICAL.md "Open questions" for the rationale). Mirrors RpcClient's
 * id-correlation pattern and reuses the strict LF-only JsonlCodec framing.
 *
 * Lifecycle: spawn-on-demand (created when a Provider/Settings/Model UI
 * surface opens), disposed when that surface closes. Short-lived by design —
 * this is not a long-running always-on process like RpcClient/PtyClient.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { attachJsonlReader, serializeLine } from './JsonlCodec';
import type { BinaryInfo } from '../binary';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AuthStatus {
  configured: boolean;
  source?: 'stored' | 'runtime' | 'environment' | 'fallback' | 'models_json_key' | 'models_json_command';
  label?: string;
  hasAuth: boolean;
}

export interface BridgeModel {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  input: Array<'text' | 'image'>;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface OAuthProviderSummary {
  id: string;
  name: string;
  usesCallbackServer: boolean;
}

/** Mirrors the SDK's OAuthLoginCallbacks, minus the parts the bridge handles internally. */
export interface AuthBridgeLoginCallbacks {
  onAuth: (info: { url: string; instructions?: string }) => void;
  onDeviceCode: (info: { userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }) => void;
  onProgress?: (message: string) => void;
  onPrompt: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
  onManualCodeInput?: () => Promise<string>;
  onSelect: (prompt: { message: string; options: Array<{ id: string; label: string }> }) => Promise<string | undefined>;
}

export interface SettingsSnapshot {
  global: Record<string, unknown>;
  project: Record<string, unknown>;
}

// ─── Helper: locate the SDK's dist/index.js from a detected pi binary ─────────

/**
 * Resolve the absolute path to `@earendil-works/pi-coding-agent`'s `dist/index.js`
 * from a detected `BinaryInfo`, bypassing npm module resolution entirely (the
 * package's `exports` map only exposes "." and "./rpc-entry", and Obsidian's
 * plugin process doesn't sit inside the npm-resolvable module tree anyway).
 *
 * Only works when pi was resolved as a Node script (`binaryInfo.nodeExe` set —
 * i.e. `.../node_modules/@earendil-works/pi-coding-agent/dist/cli.js`). Returns
 * null for standalone compiled binaries, where the SDK bridge isn't available.
 */
export function resolveSdkIndexPath(binaryInfo: BinaryInfo | null | undefined): string | null {
  if (!binaryInfo?.nodeExe) return null; // not a Node script — no accessible SDK
  const cliPath = binaryInfo.path;
  if (!cliPath.endsWith('.js')) return null;

  // cliPath ends in .../@earendil-works/pi-coding-agent/dist/cli.js
  const distDir = path.dirname(cliPath);
  const packageRoot = path.dirname(distDir);
  const indexPath = path.join(packageRoot, 'dist', 'index.js');
  return fs.existsSync(indexPath) ? indexPath : null;
}

/**
 * Path to the shipped `bridge/auth-bridge.mjs` script, given the plugin's
 * absolute install directory (vault path + manifest.dir, same pattern main.ts
 * already uses for node-pty/bridge-extension paths in ensurePtyClient()).
 * Deliberately NOT `__dirname` — Obsidian's plugin loader doesn't guarantee
 * `__dirname` resolves to the plugin's on-disk folder, and NOT
 * `require.resolve()` — esbuild would try to statically resolve/bundle that
 * target, which we don't want for this plain, unbundled ESM script.
 */
function resolveBridgeScriptPath(pluginDirAbs: string): string {
  return path.join(pluginDirAbs, 'bridge', 'auth-bridge.mjs');
}

// ─── AuthBridge ──────────────────────────────────────────────────────────────

export type AuthBridgeOauthEvent =
  | { event: 'auth'; url: string; instructions?: string }
  | { event: 'device_code'; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { event: 'progress'; message: string }
  | { event: 'prompt'; requestId: string; prompt: { message: string; placeholder?: string; allowEmpty?: boolean } }
  | { event: 'manual_code_input'; requestId: string }
  | { event: 'select'; requestId: string; prompt: { message: string; options: Array<{ id: string; label: string }> } };

export class AuthBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stopStdoutReader: (() => void) | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private requestSeq = 0;
  private stderr = '';
  private disposed = false;

  constructor(
    private readonly sdkIndexPath: string,
    private readonly opts: { cwd?: string; agentDir?: string; authPath?: string; modelsJsonPath?: string; nodeExe: string; pluginDirAbs: string },
  ) {}

  /** Spawn the bridge subprocess. Idempotent. */
  async connect(): Promise<void> {
    if (this.proc) return;
    const bridgeScriptPath = resolveBridgeScriptPath(this.opts.pluginDirAbs);
    if (!fs.existsSync(bridgeScriptPath)) {
      throw new Error(`auth-bridge.mjs not found at ${bridgeScriptPath}`);
    }
    const args = [
      bridgeScriptPath,
      this.sdkIndexPath,
      this.opts.cwd ?? '',
      this.opts.agentDir ?? '',
      this.opts.authPath ?? '',
      this.opts.modelsJsonPath ?? '',
    ];
    const child = spawn(this.opts.nodeExe, args, { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
    this.proc = child;

    // Capped so a chatty bridge can't grow the buffer without bound.
    child.stderr.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-8192);
    });
    child.once('exit', () => {
      if (this.proc !== child) return;
      this.proc = null;
      this.rejectAllPending(new Error(`auth-bridge exited unexpectedly. Stderr: ${this.stderr.slice(-500)}`));
    });

    this.stopStdoutReader = attachJsonlReader(child.stdout, (line) => this.handleLine(line));

    // Confirm it's alive before returning.
    await this.send('ping', {});
  }

  /** Terminate the bridge subprocess (SIGTERM, escalating to SIGKILL if it hangs). */
  dispose(): void {
    this.disposed = true;
    this.stopStdoutReader?.();
    this.stopStdoutReader = null;
    this.rejectAllPending(new Error('AuthBridge disposed'));
    const child = this.proc;
    this.proc = null;
    if (child) {
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      // Escalate if the bridge is wedged (e.g. mid-OAuth with a callback
      // server open) — don't leak the subprocess.
      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* fine */ }
      }, 1_000);
      child.once('exit', () => clearTimeout(killTimer));
    }
  }

  get isConnected(): boolean { return this.proc != null; }

  // ── Provider / auth commands ────────────────────────────────────────────

  async listProviders(): Promise<string[]> {
    const d = await this.send<{ providers: string[] }>('list_providers', {});
    return d.providers;
  }

  async getAuthStatus(provider: string): Promise<AuthStatus> {
    return this.send<AuthStatus>('get_auth_status', { provider });
  }

  async getAllAuthStatus(): Promise<Record<string, AuthStatus>> {
    const d = await this.send<{ statuses: Record<string, AuthStatus> }>('get_all_auth_status', {});
    return d.statuses;
  }

  async setApiKey(provider: string, apiKey: string): Promise<void> {
    await this.send('set_api_key', { provider, apiKey });
  }

  async removeCredential(provider: string): Promise<void> {
    await this.send('remove_credential', { provider });
  }

  async listOAuthProviders(): Promise<OAuthProviderSummary[]> {
    const d = await this.send<{ providers: OAuthProviderSummary[] }>('list_oauth_providers', {});
    return d.providers;
  }

  /**
   * Run the OAuth login flow for a provider. Resolves when login succeeds;
   * throws if login fails or is cancelled/aborted.
   */
  async login(provider: string, callbacks: AuthBridgeLoginCallbacks, signal?: AbortSignal): Promise<void> {
    const onOauthEvent = (ev: AuthBridgeOauthEvent) => {
      switch (ev.event) {
        case 'auth': callbacks.onAuth({ url: ev.url, instructions: ev.instructions }); break;
        case 'device_code': callbacks.onDeviceCode(ev); break;
        case 'progress': callbacks.onProgress?.(ev.message); break;
        case 'prompt':
          void callbacks.onPrompt(ev.prompt)
            .then((value) => this.write({ type: 'oauth_input', requestId: ev.requestId, value }))
            .catch(() => this.write({ type: 'oauth_input', requestId: ev.requestId, cancelled: true }));
          break;
        case 'manual_code_input':
          if (callbacks.onManualCodeInput) {
            void callbacks.onManualCodeInput()
              .then((value) => this.write({ type: 'oauth_input', requestId: ev.requestId, value }))
              .catch(() => this.write({ type: 'oauth_input', requestId: ev.requestId, cancelled: true }));
          } else {
            this.write({ type: 'oauth_input', requestId: ev.requestId, cancelled: true });
          }
          break;
        case 'select':
          void callbacks.onSelect(ev.prompt)
            .then((value) => this.write({ type: 'oauth_input', requestId: ev.requestId, value }))
            .catch(() => this.write({ type: 'oauth_input', requestId: ev.requestId, cancelled: true }));
          break;
      }
    };

    const unsub = this.onOauthEvent(onOauthEvent);
    const onAbort = () => { void this.abortLogin(); };
    signal?.addEventListener('abort', onAbort);
    try {
      await this.send('login', { provider }, 10 * 60_000); // logins can take a while (device code flows)
    } finally {
      unsub();
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async abortLogin(): Promise<void> {
    await this.send('abort_login', {});
  }

  async logout(provider: string): Promise<void> {
    await this.send('logout', { provider });
  }

  // ── Models ───────────────────────────────────────────────────────────────

  async getAvailableModels(): Promise<BridgeModel[]> {
    const d = await this.send<{ models: BridgeModel[] }>('get_available_models', {});
    return d.models;
  }

  async getAllModels(): Promise<BridgeModel[]> {
    const d = await this.send<{ models: BridgeModel[] }>('get_all_models', {});
    return d.models;
  }

  // ── Settings ─────────────────────────────────────────────────────────────

  async getSettings(): Promise<SettingsSnapshot> {
    return this.send<SettingsSnapshot>('get_settings', {});
  }

  async applySettingsOverrides(overrides: Record<string, unknown>): Promise<void> {
    await this.send('apply_settings', { overrides });
  }

  async flushSettings(): Promise<void> {
    await this.send('flush_settings', {}, 10_000);
  }

  async drainErrors(): Promise<{ auth: string[]; settings: Array<{ scope: string; message: string }> }> {
    return this.send('drain_errors', {});
  }

  // ── OAuth event subscription (internal to login(), exposed for advanced use) ──

  private oauthListeners: Array<(ev: AuthBridgeOauthEvent) => void> = [];
  onOauthEvent(listener: (ev: AuthBridgeOauthEvent) => void): () => void {
    this.oauthListeners.push(listener);
    return () => { this.oauthListeners = this.oauthListeners.filter((l) => l !== listener); };
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private handleLine(line: string): void {
    if (!line) return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    if (data['type'] === 'response' && typeof data['id'] === 'string') {
      const p = this.pending.get(data['id']);
      if (p) {
        this.pending.delete(data['id']);
        clearTimeout(p.timer);
        if (data['success']) p.resolve(data['data']);
        else p.reject(new Error((data['error'] as string) ?? 'auth-bridge command failed'));
      }
      return;
    }

    if (data['type'] === 'oauth_event') {
      for (const l of this.oauthListeners) l(data as unknown as AuthBridgeOauthEvent);
    }
  }

  private send<T = unknown>(type: string, payload: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    if (!this.proc) return Promise.reject(new Error('AuthBridge is not connected'));
    const id = `req_${++this.requestSeq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for auth-bridge response to '${type}' (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.write({ ...payload, type, id });
    });
  }

  private write(obj: Record<string, unknown>): void {
    if (!this.proc?.stdin || this.proc.stdin.destroyed) {
      throw new Error('auth-bridge stdin is not writable');
    }
    this.proc.stdin.write(serializeLine(obj));
  }

  private rejectAllPending(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
