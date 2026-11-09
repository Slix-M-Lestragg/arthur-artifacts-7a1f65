import type ObsidianPiPlugin from '../main';
import { deriveMenubarSnapshot, type MenubarReport } from './menubarSnapshot';
import {
  MenubarLeaderServer,
  MenubarReporterClient,
} from './MenubarIpc';
import { MenubarIcon } from './MenubarIcon';

/**
 * Per-plugin-instance facade that wires the menu bar together.
 *
 * On {@link start} it runs a leader election over the shared Unix socket:
 *  - **Leader** — owns the {@link MenubarIcon} (the single tray icon) and the
 *    {@link MenubarLeaderServer}; aggregates snapshots from all reporters
 *    (including itself) and rebuilds the context menu on every change.
 *  - **Reporter** — owns a {@link MenubarReporterClient}; pushes this vault's
 *    snapshot upstream and receives routed click messages.
 *
 * If the leader dies, a reporter's socket drops → it re-runs election; one
 * reporter wins the `bind()` and takes over the tray. The icon is never
 * duplicated because exactly one process owns the socket at a time.
 *
 * Only active on macOS (`process.platform === 'darwin'`) when the user opts
 * in via `settings.menubarEnabled`.
 */
export class MenubarCoordinator {
  readonly reporterId: string;
  private role: 'leader' | 'reporter' | 'idle' = 'idle';
  private leaderServer: MenubarLeaderServer | null = null;
  private reporterClient: MenubarReporterClient | null = null;
  private icon: MenubarIcon | null = null;
  /** Aggregated reports (leader only). keyed by reporterId. */
  private readonly reports = new Map<string, MenubarReport>();
  private detachInstanceManager: (() => void) | null = null;
  private publishTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private accentObserver: MutationObserver | null = null;
  private accentRefreshTimer: NodeJS.Timeout | null = null;

  constructor(private readonly plugin: ObsidianPiPlugin) {
    this.reporterId = globalThis.crypto.randomUUID();
  }

  /** Start: subscribe to instance changes and run election. */
  async start(): Promise<void> {
    this.detachInstanceManager = this.plugin.instanceManager.onChanged(() => this.schedulePublish());
    await this.elect();
  }

  // ── Election ──────────────────────────────────────────────────────────────

  private async elect(): Promise<void> {
    const server = new MenubarLeaderServer({
      onReport: (r) => this.onReport(r),
      onReporterGone: (id) => this.onReporterGone(id),
    });
    const won = await server.bind();
    if (won) {
      this.becomeLeader(server);
    } else {
      this.becomeReporter();
    }
  }

  private becomeLeader(server: MenubarLeaderServer): void {
    this.role = 'leader';
    this.leaderServer = server;
    this.icon = new MenubarIcon(this.plugin, {
      onOpenInstance: (reporterId, instanceId) => this.routeOpenInstance(reporterId, instanceId),
      onAction: (reporterId, action) => this.routeAction(reporterId, action),
      onTrayClick: () => this.focusThisWindow(),
    });
    if (!this.icon.start()) {
      // Electron Tray unavailable (e.g. restricted env) — stay leader for IPC
      // aggregation but render no icon. A reporter winning election elsewhere
      // would still produce the icon.
      console.warn('[obsidian-pi] menubar: Tray unavailable; leading IPC only.');
    }
    // Seed the aggregate with our own vault.
    this.reports.set(this.reporterId, deriveMenubarSnapshot(this.plugin, this.reporterId));
    this.rebuildMenu();
    // Refresh "Xm ago" timestamps every 30s while leading (also re-resolves the
    // icon's accent color as a fallback safety net — see accentObserver below).
    this.refreshTimer = setInterval(() => this.rebuildMenu(), 30_000);
    this.watchAccentColor();
  }

  /**
   * Live-refresh the tray icon when Obsidian's accent color changes (Settings
   * → Appearance → Accent color applies instantly via an inline CSS custom
   * property on <body>/<html>, with no dedicated workspace event to hook).
   * A MutationObserver on style/class attribute changes, debounced, is
   * cheaper and far more responsive than waiting for the 30s timer.
   */
  private watchAccentColor(): void {
    if (typeof MutationObserver === 'undefined') return;
    const schedule = (): void => {
      if (this.accentRefreshTimer) clearTimeout(this.accentRefreshTimer);
      this.accentRefreshTimer = setTimeout(() => this.rebuildMenu(), 150);
    };
    this.accentObserver = new MutationObserver(schedule);
    const opts: MutationObserverInit = { attributes: true, attributeFilter: ['style', 'class'] };
    this.accentObserver.observe(document.body, opts);
    this.accentObserver.observe(document.documentElement, opts);
  }

  private becomeReporter(): void {
    this.role = 'reporter';
    this.reporterClient = new MenubarReporterClient(
      () => deriveMenubarSnapshot(this.plugin, this.reporterId),
      {
        onClick: (instanceId) => this.focusInstance(instanceId),
        onAction: (action) => this.handleLocalFooter(action),
        onLeaderLost: () => this.handleLeaderLost(),
        onConnected: () => this.reporterClient?.publishSnapshot(),
      },
    );
    this.reporterClient.connect();
  }

  private handleLeaderLost(): void {
    // Old reporter client is dead; re-run election. If we win the bind we
    // become the new leader (and take over the tray); otherwise we reconnect
    // as a reporter to whoever did win.
    this.reporterClient = null;
    void this.elect();
  }

  // ── Aggregation (leader) ───────────────────────────────────────────────────

  private onReport(report: MenubarReport): void {
    this.reports.set(report.reporterId, report);
    this.rebuildMenu();
  }

  private onReporterGone(reporterId: string): void {
    this.reports.delete(reporterId);
    this.rebuildMenu();
  }

  private rebuildMenu(): void {
    if (!this.icon || !this.leaderServer) return;
    const connected = new Set<string>([this.reporterId, ...this.leaderServer.connectedReporterIds()]);
    this.icon.update(this.reports, {
      thisReporterId: this.reporterId,
      showIdle: this.plugin.settings.menubarShowIdleInstances,
      connectedReporterIds: connected,
    });
  }

  // ── Publishing (both roles) ───────────────────────────────────────────────

  private schedulePublish(): void {
    if (this.publishTimer) return; // coalesce: one publish per tick
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      this.publish();
    }, 200);
  }

  private publish(): void {
    const snap = deriveMenubarSnapshot(this.plugin, this.reporterId);
    if (this.role === 'leader') {
      this.reports.set(this.reporterId, snap);
      this.rebuildMenu();
    } else if (this.reporterClient) {
      // The client's report() closure re-derives fresh data on each publish;
      // we just trigger the send.
      this.reporterClient.publishSnapshot();
    }
  }

  // ── Click routing + window focus ──────────────────────────────────────────

  /** Leader: a menu instance row was clicked. Route to the owning reporter. */
  private routeOpenInstance(reporterId: string, instanceId: string): void {
    if (reporterId === this.reporterId) {
      void this.focusInstance(instanceId);
    } else {
      this.leaderServer?.sendClick(reporterId, instanceId);
    }
  }

  /** Leader: a footer action was clicked. Route to a reporter (or self). */
  private routeAction(reporterId: string | undefined, action: 'open-settings'): void {
    if (!reporterId) return;
    if (reporterId === this.reporterId) {
      this.handleLocalFooter(action);
    } else {
      this.leaderServer?.sendAction(reporterId, action);
    }
  }

  /** Open/focus an instance terminal in THIS Obsidian window. */
  private async focusInstance(instanceId: string): Promise<void> {
    this.focusThisWindow();
    await this.plugin.activateTerminalView(instanceId);
  }

  /** Bring this Obsidian window to the front. */
  private focusThisWindow(): void {
    try {
      const w = globalThis as any;
      const remote =
        (w.require ? (() => { try { return w.require('@electron/remote'); } catch { try { return w.require('electron').remote; } catch { return null; } } })() : null);
      const win = remote?.getCurrentWindow?.();
      win?.show?.();
      win?.focus?.();
    } catch (err) {
      console.warn('[obsidian-pi] menubar: could not focus window', err);
    }
  }

  private handleLocalFooter(action: 'open-settings'): void {
    if (action !== 'open-settings') return;
    this.focusThisWindow();
    const settingApi = (
      this.plugin.app as unknown as { setting: { open(): void; openTabById(id: string): void } }
    ).setting;
    settingApi?.open();
    settingApi?.openTabById(this.plugin.manifest.id);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async stop(): Promise<void> {
    this.detachInstanceManager?.();
    this.detachInstanceManager = null;
    if (this.publishTimer) { clearTimeout(this.publishTimer); this.publishTimer = null; }
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
    if (this.accentRefreshTimer) { clearTimeout(this.accentRefreshTimer); this.accentRefreshTimer = null; }
    this.accentObserver?.disconnect();
    this.accentObserver = null;
    this.icon?.destroy();
    this.icon = null;
    this.leaderServer?.close();
    this.leaderServer = null;
    this.reporterClient?.close();
    this.reporterClient = null;
    this.reports.clear();
    this.role = 'idle';
  }

  /** Snapshot of the coordinator's runtime state, for the debug command. */
  status(): {
    role: string;
    reporterId: string;
    reports: number;
    connectedReporters: string[];
    trayPresent: boolean;
  } {
    return {
      role: this.role,
      reporterId: this.reporterId,
      reports: this.reports.size,
      connectedReporters: this.leaderServer ? Array.from(this.leaderServer.connectedReporterIds()) : [],
      trayPresent: !!this.icon,
    };
  }
}