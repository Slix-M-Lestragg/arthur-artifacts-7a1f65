import { Notice, Platform } from 'obsidian';
import type ObsidianPiPlugin from '../main';
import type { PiInstanceConfig } from '../types';
import type { PtyClient } from '../transport/PtyClient';
import type { TerminalView } from '../views/TerminalView';
import { PromptPopout } from '../views/PromptPopout';
import type { PiTerminalIconState } from '../views/TerminalIcon';
import type { AgentEvent } from '../notifications/AgentNotifier';
import { type InstanceStats, updateInstanceStats } from './InstanceStats';
import {
  instanceSessionsDir,
  instanceWorkingDir,
  getPluginBasePaths,
  resolveNodePtyPath,
} from './InstancePaths';

/** Runtime object bundling a single instance's PTY, view, and popout. */
export class PiInstance {
  config: PiInstanceConfig;
  ptyClient: PtyClient | null = null;
  terminalView: TerminalView | null = null;
  promptPopout: PromptPopout | null = null;
  pendingResumeSessionPath: string | null = null;
  stateNoticesWired = false;
  /** True while the agent is blocked on a question_user-style tool call.
   *  Drives the red "?" badge on the terminal view when it's not focused. */
  awaitingInput = false;
  /** Live tab-icon state, mirrored onto the bound TerminalView (if open) so a
   *  freshly (re)opened leaf can restore it immediately. See TerminalIcon.ts. */
  iconState: PiTerminalIconState = 'idle';
  /** Rolling snapshot of last-known activity, used to build hover tooltips (see InstanceStats.ts). */
  stats: InstanceStats = {};

  constructor(config: PiInstanceConfig) {
    this.config = config;
  }
}

/**
 * Owns the per-instance terminal lifecycle: one PTY client, one terminal view
 * reference, one prompt popout, and one pending resume session per instance.
 *
 * The "default" instance preserves the legacy single-terminal behavior while
 * the API is designed so multi-leaf TerminalView support is a follow-on.
 */
export class InstanceManager {
  private readonly instances = new Map<string, PiInstance>();
  private readonly changedListeners: Array<() => void> = [];

  constructor(private readonly plugin: ObsidianPiPlugin) {}

  /** Return the runtime object for an instance, or undefined if it was never touched. */
  get(id: string): PiInstance | undefined {
    return this.instances.get(id);
  }

  /**
   * Subscribe to any instance state change: per-instance agent lifecycle events
   * (start/end/error/abort/question), PTY connection-state changes, icon-state
   * transitions, and explicit {@link notifyChanged} pings (e.g. after settings
   * instance-list edits). Used by the menu-bar coordinator to push fresh
   * snapshots. Returns an unsubscribe function.
   */
  onChanged(cb: () => void): () => void {
    this.changedListeners.push(cb);
    return () => {
      const i = this.changedListeners.indexOf(cb);
      if (i >= 0) this.changedListeners.splice(i, 1);
    };
  }

  /** Fire all registered change listeners (defensively). External callers (e.g.
   *  main.ts after a settings instance-list edit) may invoke this directly. */
  notifyChanged(): void {
    this.emitChanged();
  }

  private emitChanged(): void {
    for (const cb of this.changedListeners) cb();
  }

  /** Return the PromptPopout for an instance, if it has been created. */
  getPromptPopout(id: string): PromptPopout | null {
    return this.instances.get(id)?.promptPopout ?? null;
  }

  /** Return the PromptPopout for an instance, creating it lazily if needed.
   *  Unlike getPromptPopout, this guarantees a non-null PromptPopout for any
   *  registered instance — including ones added at runtime after onload (which
   *  otherwise never get a PromptPopout and whose prompt-editor open button is
   *  a silent no-op). */
  ensurePromptPopout(id: string): PromptPopout {
    const instance = this.getOrCreate(id);
    if (!instance.promptPopout) {
      instance.promptPopout = new PromptPopout(this.plugin.app, this.plugin, id);
    }
    return instance.promptPopout;
  }

  /** Ensure the instance's dedicated prompt note file exists (creates it if
   *  missing). Best-effort — a creation failure is non-fatal. */
  async ensureInstancePromptNote(id: string): Promise<void> {
    try {
      await this.ensurePromptPopout(id).ensureNote();
    } catch {
      /* best-effort — note creation failure is non-fatal */
    }
  }

  /** Ensure every configured instance has its dedicated prompt note file in
   *  the vault, so each instance shows its own 'pi prompt' note in the file
   *  explorer. */
  async ensureAllPromptNotes(): Promise<void> {
    for (const cfg of this.plugin.settings.instances) {
      await this.ensureInstancePromptNote(cfg.id);
    }
  }

  /** Return the runtime object, creating it from the current settings if needed. */
  getOrCreate(id: string): PiInstance {
    let instance = this.instances.get(id);
    if (!instance) {
      const config = this.plugin.settings.instances.find((i) => i.id === id);
      instance = new PiInstance(config ?? { id, name: id, cwd: '' });
      this.instances.set(id, instance);
    }
    return instance;
  }

  /** All currently known runtime instances. */
  all(): PiInstance[] {
    return Array.from(this.instances.values());
  }

  /** Effective cwd for an instance. */
  resolveCwd(instance: PiInstance): string {
    return instanceWorkingDir(this.plugin, instance.config);
  }

  /** Effective agent directory for an instance (falls back to global). */
  resolveAgentDir(instance: PiInstance): string | undefined {
    return instance.config.agentDir || this.plugin.settings.agentDir || undefined;
  }

  /** Effective model for an instance (falls back to global). */
  resolveModel(instance: PiInstance): string | undefined {
    return instance.config.model || this.plugin.settings.defaultModel || undefined;
  }

  /** Effective thinking level for an instance (falls back to global). */
  resolveThinkingLevel(instance: PiInstance): string | undefined {
    const level = instance.config.thinkingLevel || this.plugin.settings.thinkingLevel;
    return level !== 'none' ? level : undefined;
  }

  /**
   * Ensure the PTY client for an instance exists, creating it from settings +
   * cached binaryInfo if needed. Does NOT connect — callers subscribe first,
   * then call connectTty().
   */
  async ensurePtyClient(instanceId: string): Promise<PtyClient | null> {
    if (!Platform.isDesktop) {
      new Notice('obsidian-pi: pi terminal requires the Obsidian desktop app.', 6000);
      return null;
    }
    const { PtyClient, bridgeExtensionAbsPath } = await import('../transport/PtyClient');
    const fs = require('fs') as typeof import('fs');
    const instance = this.getOrCreate(instanceId);
    if (instance.ptyClient) return instance.ptyClient;

    const startCommand = this.plugin.settings.startCommand.trim();
    if (!startCommand && !this.plugin.binaryInfo) {
      await this.plugin.detectBinary(true);
      if (!this.plugin.binaryInfo) return null;
    }

    const { vaultPath, pluginDir } = getPluginBasePaths(this.plugin);
    const sessionsDir = instanceSessionsDir(this.plugin, instance.config);
    fs.mkdirSync(sessionsDir, { recursive: true });

    const extraArgs = ['--session-dir', sessionsDir];
    if (instance.pendingResumeSessionPath) {
      extraArgs.push('--session', instance.pendingResumeSessionPath);
      instance.pendingResumeSessionPath = null;
    }

    instance.ptyClient = new PtyClient(
      {
        binaryInfo: this.plugin.binaryInfo ?? undefined,
        startCommand: startCommand || undefined,
        bridgeExtensionPath: bridgeExtensionAbsPath(vaultPath, pluginDir),
        nodePtyPath: resolveNodePtyPath(this.plugin),
        instanceId: instance.config.id,
        cwd: this.resolveCwd(instance),
        model: this.resolveModel(instance),
        thinkingLevel: this.resolveThinkingLevel(instance),
        agentDir: this.resolveAgentDir(instance),
        extraArgs,
        env:
          this.plugin.settings.authStrategy === 'runtime-key' && this.plugin.runtimeApiKey
            ? { ANTHROPIC_API_KEY: this.plugin.runtimeApiKey }
            : undefined,
        cols: 80,
        rows: 24,
      },
      this.plugin.settings.promptSubmitMode,
    );
    instance.ptyClient.setRenderCanvasHandler(async (canvasPath: string) => {
      const { captureCanvasToPng } = await import('../canvas/obsidianCapture');
      return captureCanvasToPng(canvasPath);
    });

    instance.ptyClient.onNotify((event) => {
      if (event.type === 'session_start' && event.sessionFile) {
        void this.recordTerminalSessionFile(instance, event.sessionFile);
        return;
      }
      // 'question' means the agent is now blocked waiting on user input;
      // any other lifecycle event (start/end/abort/error) means it isn't.
      // Drives the terminal view's unfocused-badge (see TerminalView.setAwaitingInput).
      instance.awaitingInput = event.type === 'question';
      instance.terminalView?.setAwaitingInput(instance.awaitingInput);
      updateInstanceStats(instance.stats, event);

      const nextIconState = this.computeIconState(instance, event.type);
      if (nextIconState) {
        instance.iconState = nextIconState;
        instance.terminalView?.setVisualState(nextIconState);
      }

      this.plugin.agentNotifier.handle(event);
      this.emitChanged();
    });

    return instance.ptyClient;
  }

  /**
   * Map an agent lifecycle event to the next terminal tab-icon visual state
   * (see TerminalIcon.ts). 'end' resolves to 'seen' (static green) instead of
   * 'done-unseen' (breathing gold) when the instance's terminal leaf is
   * already the focused one — there's nothing to "catch up on".
   */
  private computeIconState(instance: PiInstance, eventType: AgentEvent['type']): PiTerminalIconState | null {
    switch (eventType) {
      case 'start':    return 'running';
      case 'question': return 'awaiting-input';
      case 'error':    return 'error';
      case 'abort':    return 'idle';
      case 'end': {
        const isFocused = !!instance.terminalView && this.plugin.app.workspace.activeLeaf === instance.terminalView.leaf;
        return isFocused ? 'seen' : 'done-unseen';
      }
      default: return null;
    }
  }

  /** Connect (spawn) the PTY client for an instance if not already connected. */
  async connectTty(instanceId: string, notify = false): Promise<void> {
    if (!Platform.isDesktop) {
      new Notice('obsidian-pi: pi terminal requires the Obsidian desktop app.', 6000);
      return;
    }
    const instance = this.getOrCreate(instanceId);
    const client = await this.ensurePtyClient(instanceId);
    if (!client) return;
    this.wireStateNotices(instance);
    if (client.state === 'connected' || client.state === 'connecting') {
      if (notify) new Notice('pi terminal already connected');
      return;
    }
    try {
      await client.connect();
      if (notify) new Notice('✓ pi terminal connected');
    } catch (err) {
      new Notice(
        `pi terminal failed to connect: ${err instanceof Error ? err.message : String(err)}`,
        8000,
      );
    }
  }

  /**
   * Restart the PTY subprocess for an instance, optionally loading a specific
   * session file directly via `--session <path>`.
   */
  async restartTerminalSession(instanceId: string, sessionPath?: string): Promise<void> {
    const instance = this.getOrCreate(instanceId);
    instance.pendingResumeSessionPath = sessionPath ?? null;
    await instance.ptyClient?.dispose();
    instance.ptyClient = null;
    instance.stateNoticesWired = false;
    if (instance.terminalView) {
      await instance.terminalView.restart();
    } else {
      await this.ensurePtyClient(instanceId);
    }
  }

  /**
   * Resolve the `.jsonl` session file to resume for an instance.
   *
   * If `preferredName` is given, returns the newest session file whose display
   * name (or bare filename) matches it — this lets a Farm View relay row titled
   * "NP300-Equipements" resume the exact same local session rather than the
   * most recently touched one. If no match is found, or no name is provided,
   * falls back to the newest session file in the instance's `--session-dir`.
   *
   * Returns `null` when the instance has no prior session files.
   */
  async resolveLocalSessionResumePath(
    instanceId: string,
    preferredName?: string,
  ): Promise<string | null> {
    if (!Platform.isDesktop) return null;
    const instance = this.getOrCreate(instanceId);
    const sessionsDir = instanceSessionsDir(this.plugin, instance.config);
    const { listSessionFilesInDir, newestSessionFileInDir } = await import(
      '../transport/sessionFiles'
    );
    if (preferredName) {
      const files = listSessionFilesInDir(sessionsDir);
      const match = files.find(
        (f) => f.displayName === preferredName || f.name === preferredName,
      );
      if (match) return match.path;
    }
    return newestSessionFileInDir(sessionsDir);
  }

  /** Wire crash/reconnect notices for an instance's PTY client once. */
  wireStateNotices(instance: PiInstance): void {
    if (instance.stateNoticesWired) return;
    const client = instance.ptyClient;
    if (!client) return;
    instance.stateNoticesWired = true;

    const prefix = instance.config.name === 'Default'
      ? 'pi terminal'
      : `pi [${instance.config.name}]`;

    client.onStateChange((state, err) => {
      if (state === 'crashed') {
        new Notice(`${prefix} crashed and could not recover.\n${err?.message ?? ''}`, 10000);
      } else if (state === 'reconnecting') {
        new Notice(`${prefix} disconnected — reconnecting…`, 3000);
      } else if (state === 'connected') {
        setTimeout(() => { void this.recordTerminalSessionFile(instance); }, 1500);
      }
      this.emitChanged();
    });
  }

  /**
   * Record the active terminal session file for an instance. If an explicit
   * path is supplied (e.g. from a session_start notify event) it is used
   * authoritatively; otherwise the newest `.jsonl` in the sessions dir is used
   * as a fallback. For the default instance this also keeps the legacy
   * `settings.lastTerminalSessionFile` in sync.
   */
  async recordTerminalSessionFile(
    instance: PiInstance,
    explicitPath?: string | null,
  ): Promise<void> {
    if (!Platform.isDesktop) return;
    if (!this.plugin.settings.restoreSessionOnRestart) return;
    const { newestSessionFileInDir } = await import('../transport/sessionFiles');
    const sessionsDir = instanceSessionsDir(this.plugin, instance.config);
    const newest = explicitPath ? explicitPath : newestSessionFileInDir(sessionsDir);
    if (instance.config.lastSessionFile === newest) return;
    instance.config.lastSessionFile = newest ?? undefined;
    if (instance.config.id === 'default') {
      this.plugin.settings.lastTerminalSessionFile = newest;
    }
    await this.plugin.saveSettings();
  }

  /** Tear down one instance's PTY and popout, removing it from the manager.
   *  Async so the PTY kill is actually awaited (a fire-and-forget dispose let
   *  pty children outlive the plugin on unload — AUDIT §3 findings 5/9) and
   *  wrapped in try/catch so a kill rejection can't escape as an unhandled
   *  rejection. The instance is removed synchronously; only the kill awaits. */
  async dispose(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) return;
    try { instance.promptPopout?.close(); } catch { /* ignore */ }
    const pty = instance.ptyClient;
    instance.ptyClient = null;
    instance.terminalView = null;
    instance.promptPopout = null;
    this.instances.delete(instanceId);
    this.emitChanged();
    try {
      await pty?.dispose();
    } catch { /* best-effort kill — SIGKILL escalation already ran inside */ }
  }

  /** Tear down every instance. Called from `onunload`. */
  async disposeAll(): Promise<void> {
    for (const id of Array.from(this.instances.keys())) {
      await this.dispose(id);
    }
  }
}
