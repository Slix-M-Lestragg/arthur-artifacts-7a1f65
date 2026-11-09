import { ItemView, Notice, Platform, setIcon, WorkspaceLeaf } from 'obsidian';
import type ObsidianPiPlugin from '../main';
import type { ChatSummary, SessionSummary } from '../transport/AhpClient';
import type { PiInstance } from '../instance/InstanceManager';
import type { HostAgentClient } from '../transport/HostAgentClient';
import { TextInputModal } from './TextInputModal';
import { formatCost } from '../instance/instancePresentation';
import { STATUS_DONE, statusInfo } from '../transport/ahpStatus';
import { matchLocalRelaySession } from '../transport/localRelay';
import { errorMessage } from '../utils/errors';

export const VIEW_TYPE_FARM_VIEW = 'farm-view';

// The session-status bitmask decoder lives in `../transport/ahpStatus` —
// re-exported here for existing consumers (FarmView.statusInfo).
export { statusInfo } from '../transport/ahpStatus';

export type FarmRow =
  | (SessionSummary & { rowKind: 'remote' })
  | {
      rowKind: 'local';
      instanceId: string;
      name: string;
      status: number;
      awaitingInput: boolean;
    };

export interface LocalStatusInfo {
  label: string;
  cls: string;
}

export function localStatusInfo(instance: PiInstance): LocalStatusInfo {
  if (instance.awaitingInput) {
    return { label: 'input', cls: 'pi-farm-status-input' };
  }
  const state = instance.ptyClient?.state;
  if (state === 'connected') {
    return { label: 'running', cls: 'pi-farm-status-running' };
  }
  if (state === 'crashed') {
    return { label: 'error', cls: 'pi-farm-status-error' };
  }
  return { label: 'idle', cls: 'pi-farm-status-idle' };
}

function formatTokens(
  s?: { tokensIn?: number; tokensOut?: number; cacheReadTokens?: number },
  hideTokensIn = false,
): string {
  const parts: string[] = [];
  // External sessions always report tokensIn 0 (the HostAgentClient only
  // accumulates out-side tokens) — omit the misleading 'in 0' for them.
  if (!hideTokensIn && s?.tokensIn != null) parts.push(`in ${s.tokensIn}`);
  if (s?.tokensOut != null) parts.push(`out ${s.tokensOut}`);
  if (s?.cacheReadTokens != null) parts.push(`cache ${s.cacheReadTokens}`);
  return parts.join(' / ') || '—';
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  return new Date(at).toLocaleString();
}

function formatWorkingDirectory(uri?: string): string {
  if (!uri) return '—';
  const raw = uri.replace(/^file:\/\//i, '');
  try {
    const decoded = decodeURIComponent(raw);
    const parts = decoded.split('/').filter(Boolean);
    if (parts.length === 0) return raw;
    const tail = parts.slice(-2).join('/');
    return parts.length > 2 ? `…/${tail}` : tail;
  } catch {
    return raw;
  }
}

function deriveProjectName(uri?: string): string {
  if (!uri) return '—';
  const raw = uri.replace(/^file:\/\//i, '');
  try {
    const decoded = decodeURIComponent(raw);
    const parts = decoded.split('/').filter(Boolean);
    return parts[parts.length - 1] || '—';
  } catch {
    return raw;
  }
}

interface RegisteredDevice {
  name: string;
  online: boolean;
  sessionCount: number;
  model?: string;
  workingDirectory?: string;
  terminalMode?: string;
  piVersion?: string;
}

function formatDeviceValue(value: string | undefined): string {
  return value ?? '—';
}

interface FarmColumn {
  id: string;
  label: string;
}

const ALL_COLUMNS: FarmColumn[] = [
  { id: 'name', label: 'Name' },
  { id: 'status', label: 'Status' },
  { id: 'modifiedAt', label: 'Last edit' },
  { id: 'workingDirectory', label: 'Working dir' },
  { id: 'model', label: 'Model' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'cost', label: 'Cost' },
  { id: 'turns', label: 'Turns' },
  { id: 'activity', label: 'Activity' },
  { id: 'subagents', label: 'Subagents' },
  { id: 'actions', label: 'Actions' },
];

const DEFAULT_COLUMN_VISIBILITY = ALL_COLUMNS.map((c) => c.id);

/**
 * Persistent live-updating render-farm table for AHP session management.
 *
 * This view is intentionally mobile-safe: it uses only the AhpClient WebSocket
 * transport and Obsidian DOM helpers. Local pi instances are surfaced through
 * the plugin's instanceManager property using type-only imports — no node-pty,
 * child_process, fs, path, or os imports are present in this file.
 */
export class FarmView extends ItemView {
  private readonly plugin: ObsidianPiPlugin;
  private rootEl!: HTMLElement;
  private devicesEl!: HTMLElement;
  private selectionCountEl!: HTMLElement;
  private unsubCatalog?: () => void;
  private unsubInstances?: () => void;
  /** M4 local-row reconcile: subscription to the host agent's announcedIds
   *  changes, rebound if the plugin ever constructs a new HostAgentClient. */
  private unsubAnnounced?: () => void;
  private announcedClient?: HostAgentClient;
  private sessions: SessionSummary[] = [];
  private localInstances: PiInstance[] = [];
  private selected = new Set<string>();
  private connected = false;
  private connectError: string | null = null;
  /** Guard to prevent re-entrant renderTable calls (e.g. synchronous subscribeSessionChats callbacks). */
  private rendering = false;
  /** A render was requested while one was in progress — re-render after it finishes. */
  private renderPending = false;
  /** Sessions explicitly collapsed by the user. All sessions with child chats start expanded. */
  private collapsedSessions = new Set<string>();
  private sessionChats = new Map<string, ChatSummary[]>();
  private sessionChatUnsubs = new Map<string, () => void>();

  constructor(leaf: WorkspaceLeaf, plugin: ObsidianPiPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_FARM_VIEW;
  }

  getDisplayText(): string {
    return 'Farm';
  }

  getIcon(): string {
    return 'tractor';
  }

  /** Public re-render entry point used by settings changes. */
  refresh(): void {
    this.renderTable();
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('pi-farm-view');
    this.renderShell();
    this.subscribeInstances();
    try {
      const client = await this.plugin.ensureAhpCatalogConnection();
      this.connected = !!client && client.state === 'connected';
      if (!this.connected) {
        this.connectError = 'AHP client not connected';
      } else {
        this.connectError = null;
        this.unsubCatalog = client!.onCatalogChanged((sessions) => {
          this.sessions = sessions;
          // External sessions appear/update in the catalogue whenever the host
          // agent syncs; make sure the local-row reconcile is wired to the
          // (possibly just-constructed) host agent client.
          this.ensureHostAgentSubscribed();
          // Cache any newly-seen external host names so they remain visible
          // even after the broker culls/disconnects them.
          this.maybeCacheKnownDevices();
          this.renderTable();
        });
      }
    } catch (err) {
      this.connectError = errorMessage(err);
      this.connected = false;
      new Notice(`Farm view connection failed: ${this.connectError}`, 5000);
    }
    this.renderTable();
  }

  private subscribeInstances(): void {
    if (this.plugin.instanceManager && typeof this.plugin.instanceManager.onChanged === 'function') {
      this.unsubInstances = this.plugin.instanceManager.onChanged(() => {
        this.rebuildLocalInstances();
      });
      this.rebuildLocalInstances();
    }
  }

  /**
   * Wire the M4 local-row reconcile to the plugin's host agent client. The
   * client is constructed asynchronously after onload (desktop + opt-in), so
   * this is called from several refresh paths and idempotently rebinds when the
   * plugin swaps in a new client (e.g. after a settings re-enable).
   */
  private ensureHostAgentSubscribed(): void {
    const client = this.plugin.hostAgentClient;
    if (!client) return;
    if (this.announcedClient === client) return;
    if (this.unsubAnnounced) {
      try {
        this.unsubAnnounced();
      } catch {
        /* ignore */
      }
      this.unsubAnnounced = undefined;
    }
    if (typeof client.onAnnouncedIdsChanged !== 'function') return;
    this.announcedClient = client;
    this.unsubAnnounced = client.onAnnouncedIdsChanged(() => {
      this.rebuildLocalInstances();
    });
  }

  private rebuildLocalInstances(): void {
    const all = this.plugin.instanceManager?.all?.() ?? [];
    const hostClient = this.plugin.hostAgentClient;
    // M4 reconcile: an instance the host agent has announced is already
    // surfaced as an external catalogue row (tagged with hostAgentName) —
    // suppress the client-side local row so it never appears twice. When the
    // host agent is null/disabled/unreachable (mobile, hostAgentEnabled false,
    // server down) the local row REAPPEARS as the instant offline fallback.
    //
    // During a host-agent reconnect, the client object may exist while
    // announcedIds is momentarily empty and no sync has completed yet
    // (lastSyncAtMs undefined). In that window we temporarily hide local rows
    // instead of showing them unfiltered, which would duplicate the external
    // rows that are already in the catalogue. The first onAnnouncedIdsChanged
    // after sync completes rebuilds with the correct dedup set.
    const announced = hostClient?.announcedIds;
    const firstSyncPending =
      hostClient && hostClient.lastSyncAtMs === undefined && (!announced || announced.size === 0);
    this.localInstances = firstSyncPending
      ? []
      : all.filter((inst) => {
          if (inst.config?.ahp) return false;
          if (announced?.has(inst.config.id)) return false;
          return true;
        });
    this.ensureHostAgentSubscribed();
    this.renderTable();
  }

  async onClose(): Promise<void> {
    this.unsubCatalog?.();
    this.unsubCatalog = undefined;
    this.unsubInstances?.();
    this.unsubInstances = undefined;
    this.unsubAnnounced?.();
    this.unsubAnnounced = undefined;
    this.announcedClient = undefined;
    for (const unsub of this.sessionChatUnsubs.values()) {
      try {
        unsub();
      } catch {
        /* ignore */
      }
    }
    this.sessionChatUnsubs.clear();
    this.sessionChats.clear();
    this.collapsedSessions.clear();
  }

  private renderShell(): void {
    const header = this.contentEl.createDiv({ cls: 'pi-farm-header' });
    header.createEl('h2', { text: 'Farm', cls: 'pi-farm-title' });
    this.renderToolbar(header);
    this.devicesEl = this.contentEl.createDiv({ cls: 'pi-farm-devices-wrap' });
    this.rootEl = this.contentEl.createDiv({ cls: 'pi-farm-table-wrap' });
  }

  private renderToolbar(header: HTMLElement): void {
    const toolbar = header.createDiv({ cls: 'pi-farm-toolbar' });
    // Mirrors toggle: show/hide local pi session mirrors (relay sessions)
    const mirrorsWrap = toolbar.createDiv({ cls: 'pi-farm-toolbar-item' });
    const mirrorsLabel = mirrorsWrap.createEl('label', { text: 'Mirrors ', cls: 'pi-farm-toolbar-label' });
    const mirrorsToggle = mirrorsWrap.createEl('input', { type: 'checkbox' });
    mirrorsToggle.checked = this.farmView?.showMirrors ?? false;
    mirrorsToggle.addEventListener('change', () => {
      this.farmView.showMirrors = mirrorsToggle.checked;
      this.renderTable();
    });
    mirrorsLabel.appendChild(mirrorsToggle);

    // External toggle: show/hide external (host-agent relay) sessions.
    const externalWrap = toolbar.createDiv({ cls: 'pi-farm-toolbar-item' });
    const externalLabel = externalWrap.createEl('label', { text: 'External ', cls: 'pi-farm-toolbar-label' });
    const externalToggle = externalWrap.createEl('input', { type: 'checkbox' });
    externalToggle.checked = this.farmView?.showExternal ?? true;
    externalToggle.addEventListener('change', () => {
      this.farmView.showExternal = externalToggle.checked;
      void this.plugin.saveSettings();
      this.renderTable();
    });
    externalLabel.appendChild(externalToggle);

    const killBtn = toolbar.createEl('button', {
      text: 'Kill selected',
      cls: 'pi-farm-kill-btn',
    });
    killBtn.addEventListener('click', () => void this.killSelected());

    // Phase 3 scheduler controls: present but visibly disabled.
    const deferred = ['Pause', 'Resume', 'Retry', 'Reprioritize'] as const;
    for (const label of deferred) {
      const btn = toolbar.createEl('button', {
        text: label,
        cls: 'pi-farm-batch-btn is-disabled',
      });
      btn.disabled = true;
      btn.title = 'requires server scheduler (Phase 3)';
    }

    this.selectionCountEl = toolbar.createEl('span', { cls: 'pi-farm-selection-count' });
    this.updateSelectionCount();

    const filters = toolbar.createDiv({ cls: 'pi-farm-filters' });
    this.renderFilterToggle(filters, 'Show archived', this.farmView?.showArchived ?? false, (checked) => {
      this.plugin.settings.farmView.showArchived = checked;
      void this.plugin.saveSettings();
      this.renderTable();
    });
    // Local pi rows only exist on desktop — hide the toggle on mobile.
    if (Platform.isDesktop) {
      this.renderFilterToggle(filters, 'Show local', this.farmView?.showLocal ?? true, (checked) => {
        this.plugin.settings.farmView.showLocal = checked;
        void this.plugin.saveSettings();
        this.renderTable();
      });
    }
  }

  private renderFilterToggle(
    container: HTMLElement,
    label: string,
    checked: boolean,
    onChange: (checked: boolean) => void,
  ): void {
    const wrap = container.createEl('label', { cls: 'pi-farm-filter-toggle' });
    const input = wrap.createEl('input', { type: 'checkbox' });
    input.checked = checked;
    input.addEventListener('change', () => {
      onChange(input.checked);
    });
    wrap.createSpan({ text: label });
  }

  private updateSelectionCount(): void {
    const count = this.selected.size;
    this.selectionCountEl.textContent = count === 0 ? 'No sessions selected' : `${count} selected`;
  }

  private get farmView() {
    return this.plugin.settings.farmView;
  }

  /**
   * Auto-populate settings.knownDevices with any new external hostAgentName
   * seen in the catalogue. Writes settings only when a new name appears.
   */
  private maybeCacheKnownDevices(): void {
    const known = this.plugin.settings.knownDevices ?? [];
    const seen = new Set(known);
    let changed = false;
    for (const session of this.sessions) {
      if (session.kind !== 'external' || !session.hostAgentName) continue;
      const name = session.hostAgentName;
      if (!seen.has(name)) {
        seen.add(name);
        known.push(name);
        changed = true;
      }
    }
    if (changed) {
      void this.plugin.saveSettings();
    }
  }

  private computeRegisteredDevices(): RegisteredDevice[] {
    // Group currently-registered external sessions by device name.
    const groups = new Map<string, SessionSummary[]>();
    for (const session of this.sessions) {
      if (session.kind !== 'external' || !session.hostAgentName) continue;
      const list = groups.get(session.hostAgentName) ?? [];
      list.push(session);
      groups.set(session.hostAgentName, list);
    }

    const localName = (this.plugin.settings.hostAgentDeviceName || 'Voyager').trim();
    const known = (this.plugin.settings.knownDevices ?? []).filter((n) => n.trim().length > 0);

    // Unique device set: local device + persisted known devices + any currently
    // registered external hosts.
    // Deduplicate device names case-insensitively (e.g. "Voyager" local +
    // "voyager" external → one entry, not two).
    const allNames = new Map<string, string>();
    for (const n of [localName, ...known, ...groups.keys()]) {
      const key = n.toLowerCase();
      if (!allNames.has(key)) allNames.set(key, n);
    }

    const devices: RegisteredDevice[] = [];
    for (const [, name] of allNames) {
      const sessions = groups.get(name);
      const isLocal = name === localName;
      // Local device is always online (this Obsidian instance is running).
      // External devices are online only if the broker reports them as live.
      const online = isLocal || (sessions != null && sessions.some((s) => s.hostOnline === true));
      const sessionCount = sessions?.length ?? 0;
      devices.push({
        name,
        online,
        sessionCount,
        model: sessions?.find((s) => s.model)?.model,
        workingDirectory: sessions?.find((s) => s.workingDirectory)?.workingDirectory,
        terminalMode: sessions?.find((s) => s.terminalMode)?.terminalMode,
        piVersion: sessions?.find((s) => s.piVersion)?.piVersion,
      });
    }

    // Online devices first, then alphabetically by name.
    return devices.sort((a, b) => {
      if (a.online && !b.online) return -1;
      if (!a.online && b.online) return 1;
      return a.name.localeCompare(b.name);
    });
  }

  /** Render a header of registered host-agent devices above the session table. */
  private devicesCollapsed = false;

  private renderDevicesHeader(): void {
    this.devicesEl.empty();
    const container = this.devicesEl.createDiv({ cls: 'pi-farm-devices-header' });
    const devices = this.computeRegisteredDevices();

    // Collapsible header: click to toggle. When collapsed, show a compact
    // one-line summary (important on mobile — the full cards take space).
    const header = container.createDiv({ cls: 'pi-farm-devices-toggle' });
    header.createEl('span', { text: this.devicesCollapsed ? '▸' : '▾', cls: 'pi-farm-devices-arrow' });
    header.createEl('span', { text: 'Registered Devices', cls: 'pi-farm-devices-title' });

    if (this.devicesCollapsed) {
      const online = devices.filter((d) => d.online);
      const offline = devices.filter((d) => !d.online);
      const summary = header.createEl('span', { cls: 'pi-farm-devices-compact' });
      if (online.length > 0) summary.createSpan({ text: online.map((d) => d.name).join(', '), cls: 'pi-farm-devices-compact-online' });
      if (offline.length > 0) summary.createSpan({ text: ` (${offline.map((d) => d.name).join(', ')})`, cls: 'pi-farm-devices-compact-offline' });
      if (devices.length === 0) summary.setText('No registered host agents.');
    }

    header.addEventListener('click', () => {
      this.devicesCollapsed = !this.devicesCollapsed;
      this.renderDevicesHeader();
    });

    if (this.devicesCollapsed || devices.length === 0) return;

    const list = container.createDiv({ cls: 'pi-farm-devices-list' });
    for (const device of devices) {
      const card = list.createDiv({
        cls: `pi-farm-device-card${device.online ? '' : ' pi-farm-device-offline'}`,
      });

      const meta = card.createDiv({ cls: 'pi-farm-device-meta' });
      meta.createSpan({
        cls: `pi-farm-device-status ${device.online ? 'pi-farm-device-online' : 'pi-farm-device-offline-dot'}`,
        text: device.online ? '● online' : '● offline',
      });
      meta.createSpan({ cls: 'pi-farm-device-name', text: device.name });
      meta.createSpan({
        cls: 'pi-farm-device-count',
        text: device.sessionCount > 0
          ? `${device.sessionCount} session${device.sessionCount === 1 ? '' : 's'}`
          : '—',
      });

      const details = card.createDiv({ cls: 'pi-farm-device-details' });
      details.createSpan({
        cls: 'pi-farm-device-detail',
        text: `model ${formatDeviceValue(device.model)}`,
      });
      details.createSpan({
        cls: 'pi-farm-device-detail',
        text: `dir ${formatDeviceValue(device.workingDirectory ? formatWorkingDirectory(device.workingDirectory) : undefined)}`,
      });
      details.createSpan({
        cls: 'pi-farm-device-detail',
        text: `term ${formatDeviceValue(device.terminalMode)}`,
      });
      details.createSpan({
        cls: 'pi-farm-device-detail',
        text: `pi ${formatDeviceValue(device.piVersion)}`,
      });
    }
  }

  private getVisibleColumns(): FarmColumn[] {
    const visibleIds = this.farmView?.columnVisibility ?? DEFAULT_COLUMN_VISIBILITY;
    const set = new Set(visibleIds);
    return ALL_COLUMNS.filter((c) => set.has(c.id));
  }

  private sortColumn: string | null = null;
  private sortDirection: 'asc' | 'desc' = 'desc';

  private sortSessions<T extends SessionSummary>(sessions: T[]): T[] {
    const copy = [...sessions];
    if (this.sortColumn) {
      const col = this.sortColumn;
      const dir = this.sortDirection === 'asc' ? 1 : -1;
      copy.sort((a, b) => {
        const av = (a as Record<string, unknown>)[col];
        const bv = (b as Record<string, unknown>)[col];
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
        return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
      });
      return copy;
    }
    const sort = this.farmView?.defaultSort ?? 'modifiedAt-desc';
    switch (sort) {
      case 'modifiedAt-desc':
        return copy.sort((a, b) =>
          String(b.modifiedAt ?? '').localeCompare(String(a.modifiedAt ?? '')),
        );
      case 'status':
        return copy.sort((a, b) => a.status - b.status);
      case 'cost':
        return copy.sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));
      case 'model':
        return copy.sort((a, b) =>
          String(a.model ?? '').localeCompare(String(b.model ?? '')),
        );
      default:
        return copy;
    }
  }

  private buildRows(): FarmRow[] {
    const showLocal = this.farmView?.showLocal ?? true;

    // N3 session-nesting: sessions whose parentSessionUri points at a session
    // in the visible catalogue are NOT top-level rows — they render dimmed
    // under their parent. A child whose parent is filtered out (e.g. archived
    // and hidden) falls back to a top-level row so it never disappears.
    const visible = this.visibleSessions();
    const visibleResources = new Set(visible.map((s) => s.resource));
    const remoteRows: FarmRow[] = visible
      .filter((s) => {
        if (!s.parentSessionUri) return true;
        if (visibleResources.has(s.parentSessionUri)) return false;
        const isAgentTask = /^[a-z]+: /i.test(s.title ?? '');
        return !isAgentTask;
      })
      .map((s) => ({ ...s, rowKind: 'remote' as const }));

    const localRows: FarmRow[] = showLocal
      ? this.localInstances.map((inst) => ({
          rowKind: 'local',
          instanceId: inst.config.id,
          name: inst.config.name || inst.config.id,
          status: 0,
          awaitingInput: inst.awaitingInput,
        }))
      : [];

    return this.sortRows([...localRows, ...remoteRows]);
  }

  /** Remote sessions after the archived filter (if showArchived is off). */
  private visibleSessions(): SessionSummary[] {
    const showArchived = this.farmView?.showArchived ?? false;
    const showMirrors = this.farmView?.showMirrors ?? false;
    const showExternal = this.farmView?.showExternal ?? true;
    return this.sessions.filter((s) => {
      // Hide external sessions when the External toolbar toggle is off.
      if (s.kind === 'external' && !showExternal) return false;

      // Hide local pi mirrors (relay kind) by default — they're
      // LiveMirror mirrors of the user's local pi sessions (~100+).
      // Show them only if the user toggles 'Show mirrors'.
      // Hide relay (local pi mirror) sessions by default — BUT show ones with
      // real content (non-default title OR turns > 0) so the user's actual work
      // sessions (fix-ahp_mobile, plan-CGI, etc.) are visible. Only hide the
      // empty "New session" mirrors (0 turns, default title).
      if (s.kind === 'relay' && !showMirrors) {
        const hasContent = (s.turns ?? 0) > 0 || (s.title && s.title !== 'New session');
        if (!hasContent) return false;
      }
      if (showArchived) return true;
      return !statusInfo(s.status ?? 0).isArchived;
    });
  }

  /** N3 session-nesting: parent session URI → its child sessions, built from
   *  the visible catalogue. Re-derived on every render so the full post-connect
   *  listSessions rebuild (root/sessionAdded does NOT re-fire after a server
   *  restart) reconstructs the tree without relying on incremental events. */
  private buildChildrenMap(sessions: SessionSummary[]): Map<string, SessionSummary[]> {
    const map = new Map<string, SessionSummary[]>();
    for (const s of sessions) {
      if (!s.parentSessionUri) continue;
      const list = map.get(s.parentSessionUri) ?? [];
      list.push(s);
      map.set(s.parentSessionUri, list);
    }
    return map;
  }

  /** Total visible children (nested sessions + tool-origin child chats) of a session. */
  private childCount(
    session: SessionSummary,
    childrenMap: Map<string, SessionSummary[]>,
  ): number {
    return (childrenMap.get(session.resource) ?? []).length + (session.childChatCount ?? 0);
  }

  /** Visible child-session count, for the Subagents column. */
  private childSessionCount(session: SessionSummary): number {
    let n = 0;
    for (const s of this.visibleSessions()) {
      if (s.parentSessionUri === session.resource) n++;
    }
    return n;
  }

  /** Child-session row name: title, else the working-directory basename (like
   *  top-level rows), else a placeholder. */
  private childSessionName(session: SessionSummary): string {
    if (session.title) return session.title;
    if (session.workingDirectory) {
      const name = deriveProjectName(session.workingDirectory);
      if (name && name !== '—') return name;
    }
    return '(untitled subagent)';
  }

  private sortRows(rows: FarmRow[]): FarmRow[] {
    // Local rows render as a single block; remote rows are sorted by the
    // configured session sort inside their own block.
    const local = rows.filter((r): r is FarmRow & { rowKind: 'local' } => r.rowKind === 'local');
    const remote = rows.filter((r): r is FarmRow & { rowKind: 'remote' } => r.rowKind === 'remote');
    return [...local, ...this.sortSessions(remote)];
  }

  private renderTable(): void {
    if (this.rendering) {
      // A render is in progress — queue a follow-up so live catalogue updates
      // (root/sessionAdded, sessionSummaryChanged) that arrive mid-render aren't
      // silently dropped (which left the view stale until a manual reload).
      this.renderPending = true;
      return;
    }
    this.rendering = true;
    try {
      this.rootEl.empty();
      this.renderDevicesHeader();

      if (!this.connected) {
        this.rootEl.createEl('p', {
          text: this.connectError ? `Not connected: ${this.connectError}` : 'Connecting to AHP server…',
          cls: 'pi-farm-empty',
        });
        this.updateSelectionCount();
        return;
      }

      const rows = this.buildRows();
      if (rows.length === 0) {
        this.rootEl.createEl('p', { text: 'No remote AHP sessions or local instances found.', cls: 'pi-farm-empty' });
        this.updateSelectionCount();
        return;
      }

      // N3 session-nesting: re-derive the parent→children tree from the full
      // catalogue on every render (listSessions seeds it after connect/reconnect).
      const childrenMap = this.buildChildrenMap(this.visibleSessions());

      // Close stale subagent subscriptions for sessions that vanished or no
      // longer report any children (nested sessions or child chats).
      for (const uri of Array.from(this.collapsedSessions)) {
        const session = this.sessions.find((s) => s.resource === uri);
        if (!session || this.childCount(session, childrenMap) === 0) {
          this.collapseSession(uri);
        }
      }
      for (const [uri] of this.sessionChatUnsubs) {
        const session = this.sessions.find((s) => s.resource === uri);
        if (!session || this.childCount(session, childrenMap) === 0) {
          this.collapseSession(uri);
        }
      }

      const table = this.rootEl.createEl('table', {
        cls: `pi-farm-table pi-farm-density-${this.farmView?.density ?? 'compact'}`,
      });
      const thead = table.createEl('thead');
      const headerRow = thead.createEl('tr');
      headerRow.createEl('th'); // checkbox column
      for (const col of this.getVisibleColumns()) {
        const th = headerRow.createEl('th', { cls: `col-${col.id} pi-farm-sortable-th` });
        th.createEl('span', { text: col.label });
        if (this.sortColumn === col.id) th.createEl('span', { text: this.sortDirection === 'asc' ? ' ▲' : ' ▼', cls: 'pi-farm-sort-arrow' });
        th.addEventListener('click', () => {
          if (this.sortColumn === col.id) this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
          else { this.sortColumn = col.id; this.sortDirection = 'desc'; }
          this.renderTable();
        });
      }

      const tbody = table.createEl('tbody');

      if (this.farmView?.groupByProject) {
        const localRows = rows.filter((r): r is FarmRow & { rowKind: 'local' } => r.rowKind === 'local');
        if (localRows.length > 0) {
          const localGroup = tbody.createEl('tr', { cls: 'pi-farm-group-header' });
          const th = localGroup.createEl('th', { cls: 'pi-farm-group-label', text: 'Local' });
          th.colSpan = this.getVisibleColumns().length + 1;
          for (const row of localRows) {
            this.renderRow(tbody, row, childrenMap);
          }
        }
        const groups = new Map<string, (FarmRow & { rowKind: 'remote' })[]>();
        for (const row of rows) {
          if (row.rowKind !== 'remote') continue;
          const key = deriveProjectName(row.workingDirectory);
          const list = groups.get(key) ?? [];
          list.push(row);
          groups.set(key, list);
        }
        const sortedKeys = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
        for (const key of sortedKeys) {
          const groupRow = tbody.createEl('tr', { cls: 'pi-farm-group-header' });
          const th = groupRow.createEl('th', { cls: 'pi-farm-group-label', text: key });
          th.colSpan = this.getVisibleColumns().length + 1;
          for (const session of this.sortSessions(groups.get(key)!)) {
            this.renderRow(tbody, session, childrenMap);
          }
        }
      } else {
        for (const row of rows) {
          this.renderRow(tbody, row, childrenMap);
        }
      }

      this.updateSelectionCount();
    } finally {
      this.rendering = false;
      if (this.renderPending) {
        this.renderPending = false;
        this.renderTable();
      }
    }
  }

  private renderRow(
    tbody: HTMLElement,
    row: FarmRow,
    childrenMap: Map<string, SessionSummary[]>,
  ): void {
    if (row.rowKind === 'local') {
      this.renderLocalRow(tbody, row);
      return;
    }
    // Strip the row discriminant so the session passed to the shared
    // openAhpTerminalForSession path is a clean SessionSummary.
    const { rowKind: _rowKind, ...session } = row;
    // N3 session-nesting: children are nested SESSIONS (parentSessionUri) plus
    // any tool-origin child chats. Both default to expanded.
    const childSessions = childrenMap.get(session.resource) ?? [];
    const childChatCount = session.childChatCount ?? 0;
    const hasChildren = childSessions.length + childChatCount > 0;
    const expanded = hasChildren && !this.collapsedSessions.has(session.resource);
    const info = statusInfo(session.status ?? 0);
    const isExternal = session.kind === 'external';
    const isHostOffline = isExternal && session.hostOnline === false;
    const tr = tbody.createEl('tr', {
      cls: `pi-farm-row${info.isArchived ? ' pi-farm-row-archived' : ''}${isHostOffline ? ' pi-farm-row-offline' : ''}`,
    });
    const checked = this.selected.has(session.resource);

    const cellCheckbox = tr.createEl('td');
    const checkbox = cellCheckbox.createEl('input', { type: 'checkbox' });
    checkbox.checked = checked;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) this.selected.add(session.resource);
      else this.selected.delete(session.resource);
      this.renderTable();
    });

    const visibleColumns = this.getVisibleColumns();
    for (const col of visibleColumns) {
      if (col.id === 'name') {
        this.renderNameCell(tr.createEl('td', { cls: `col-${col.id}` }), session, hasChildren, expanded, childSessions.length);
        continue;
      }
      this.renderDataCell(tr.createEl('td', { cls: `col-${col.id}` }), col.id, session, isExternal);
    }

    if (expanded && hasChildren) {
      // N3: nested child SESSIONS first (recursively — grandchildren nest under
      // their child), then the tool-origin child chats for this session.
      for (const child of childSessions) {
        this.renderChildSessionRow(tbody, child, childrenMap);
      }
      this.ensureSessionChatsSubscribed(session.resource);
      const parentWaiting = statusInfo(session.status ?? 0).label === 'waiting';
      const chats = this.sessionChats.get(session.resource) ?? [];
      for (const chat of chats) {
        this.renderSubagentRow(tbody, chat, parentWaiting);
      }
    }
  }

  private renderLocalRow(tbody: HTMLElement, row: FarmRow & { rowKind: 'local' }): void {
    const instance = this.plugin.instanceManager?.get(row.instanceId);
    const info = instance ? localStatusInfo(instance) : { label: 'idle', cls: 'pi-farm-status-idle' };
    const tr = tbody.createEl('tr', { cls: 'pi-farm-row pi-farm-row-local' });
    tr.createEl('td'); // checkbox column stays blank

    const visibleColumns = this.getVisibleColumns();
    for (const col of visibleColumns) {
      const cell = tr.createEl('td');
      switch (col.id) {
        case 'name':
          this.renderLocalNameCell(cell, row);
          break;
        case 'status': {
          const statusEl = cell.createEl('span', {
            text: info.label,
            cls: `pi-farm-status ${info.cls}`,
          });
          if (info.cls === 'pi-farm-status-running') {
            statusEl.createSpan({ cls: 'pi-farm-status-spinner', text: '●' });
          }
          break;
        }
        case 'actions':
          this.createLocalOpenButton(cell.createDiv({ cls: 'pi-farm-actions-cell' }), row.instanceId);
          break;
        default:
          // Local rows intentionally leave rollup columns blank.
          break;
      }
    }
  }

  private renderLocalNameCell(cell: HTMLElement, row: FarmRow & { rowKind: 'local' }): void {
    const badge = cell.createSpan({ cls: 'pi-farm-local-badge', text: 'local' });
    setIcon(badge, 'monitor');
    const name = cell.createSpan({
      text: ` ${row.name}`,
      cls: 'pi-farm-name pi-farm-name-local',
    });
    name.addEventListener('click', (e: Event) => {
      e.preventDefault();
      this.openLocalInstance(row.instanceId);
    });
  }

  private openLocalInstance(instanceId: string): void {
    if (!Platform.isDesktop) {
      new Notice('Local terminal only available on desktop', 4000);
      return;
    }
    void this.plugin.activateTerminalView(instanceId);
  }

  private createLocalOpenButton(container: HTMLElement, instanceId: string): HTMLElement {
    return this.createCompositeOpenButton(container, 'Open', () => this.openLocalInstance(instanceId));
  }

  private renderSubagentRow(tbody: HTMLElement, chat: ChatSummary, parentWaiting: boolean): void {
    const chatInfo = statusInfo(chat.status ?? 0);
    const isRunning = chatInfo.label === 'running';
    const isDone = ((chat.status ?? 0) & STATUS_DONE) !== 0 || chatInfo.label === 'done';
    const clsParts = ['pi-farm-row', 'pi-farm-subagent-row'];
    if (parentWaiting && isRunning) clsParts.push('pi-farm-subagent-running');
    if (parentWaiting && isDone) clsParts.push('pi-farm-subagent-done');
    const row = tbody.createEl('tr', { cls: clsParts.join(' ') });
    row.createEl('td'); // checkbox column stays blank

    for (const col of this.getVisibleColumns()) {
      if (col.id === 'name') {
        const cell = row.createEl('td');
        cell.createSpan({ cls: 'pi-farm-connector', text: '└─ ' });
        const nameEl = cell.createSpan({
          cls: 'pi-farm-subagent-name',
          text: chat.title || '(untitled subagent)',
        });
        if (parentWaiting && isRunning) {
          nameEl.addClass('pi-farm-subagent-name-running');
          cell.createSpan({ cls: 'pi-farm-subagent-pulse', text: ' ●' });
        }
        continue;
      }
      if (col.id === 'subagents') {
        row.createEl('td'); // subagent rows don't repeat a child count
        continue;
      }
      this.renderDataCell(row.createEl('td'), col.id, chat);
    }
  }

  /**
   * N3: dimmed nested row for a child SESSION spawned via the subagent tool
   * (parentSessionUri set). Reuses the existing `pi-farm-subagent-row` styling
   * and the `└─` connector. A child is a REAL AHP session, so its Open action
   * opens its terminal/chat via openAhpTerminalForSession (like top-level rows),
   * and like the existing subagent rows it carries no Archive/Kill/Pause.
   * Renders recursively: a child that itself has children nests them under it,
   * followed by any tool-origin child chats. Defaults to expanded.
   */
  private renderChildSessionRow(
    tbody: HTMLElement,
    session: SessionSummary,
    childrenMap: Map<string, SessionSummary[]>,
  ): void {
    const childSessions = childrenMap.get(session.resource) ?? [];
    const childChatCount = session.childChatCount ?? 0;
    const hasChildren = childSessions.length + childChatCount > 0;
    const expanded = hasChildren && !this.collapsedSessions.has(session.resource);
    const info = statusInfo(session.status ?? 0);
    const isExternal = session.kind === 'external';
    const isHostOffline = isExternal && session.hostOnline === false;
    const tr = tbody.createEl('tr', {
      cls: `pi-farm-row pi-farm-subagent-row${isHostOffline ? ' pi-farm-row-offline' : ''}`,
    });
    tr.createEl('td'); // checkbox column stays blank

    for (const col of this.getVisibleColumns()) {
      const cell = tr.createEl('td');
      if (col.id === 'name') {
        if (hasChildren) {
          const total = childSessions.length + childChatCount;
          const twisty = cell.createEl('button', {
            cls: 'pi-farm-twisty',
            text: expanded ? '▾' : `▸ ${total} subagent${total === 1 ? '' : 's'}`,
          });
          twisty.addEventListener('click', (e: Event) => {
            e.stopPropagation();
            if (expanded) {
              this.collapseSession(session.resource);
            } else {
              this.expandSession(session.resource);
            }
            this.renderTable();
          });
        }
        cell.createSpan({ cls: 'pi-farm-connector', text: '└─ ' });
        const nameEl = cell.createEl('a', {
          cls: 'pi-farm-subagent-name',
          text: this.childSessionName(session),
        });
        nameEl.addEventListener('click', (e: Event) => {
          e.preventDefault();
          void this.openSession(session);
        });
        continue;
      }
      if (col.id === 'subagents') {
        continue; // subagent rows don't repeat a child count
      }
      if (col.id === 'actions') {
        // Child sessions get Open only — no Archive/Kill/Pause, matching the
        // existing subagent-row action set (Open opens the real AHP session).
        const actionsCell = cell.createDiv({ cls: 'pi-farm-actions-cell' });
        this.createOpenButton(actionsCell, session);
        continue;
      }
      this.renderDataCell(cell, col.id, session, isExternal);
    }

    if (expanded && hasChildren) {
      for (const child of childSessions) {
        this.renderChildSessionRow(tbody, child, childrenMap);
      }
      // Subagent chats not rendered here either — child sessions cover them.
      this.ensureSessionChatsSubscribed(session.resource);
    }
  }

  private renderNameCell(
    cell: HTMLElement,
    session: SessionSummary,
    hasChildren: boolean,
    expanded: boolean,
    childSessionCount = 0,
  ): void {
    if (hasChildren) {
      // Combined count: nested child sessions + tool-origin child chats.
      const total = childSessionCount + (session.childChatCount ?? 0);
      const twisty = cell.createEl('button', {
        cls: 'pi-farm-twisty',
        text: expanded ? '▾' : `▸ ${total} subagent${total === 1 ? '' : 's'}`,
      });
      twisty.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        if (expanded) {
          this.collapseSession(session.resource);
        } else {
          this.expandSession(session.resource);
        }
        this.renderTable();
      });
    }

    // M4 host tag: external sessions (host-agent relayed) show the owning
    // device's name next to a laptop icon; hosted/relay rows get no badge, so
    // the three kinds (server-hosted / external-relayed / local-fallback) stay
    // visually distinguishable from the existing 'local' monitor badge.
    if (session.kind === 'external') {
      const hostBadge = cell.createSpan({ cls: 'pi-farm-host-badge' });
      setIcon(hostBadge, 'laptop');
      hostBadge.createSpan({ text: ` ${session.hostAgentName ?? 'remote host'}` });
      if (session.hostOnline === false) {
        cell.createSpan({ cls: 'pi-farm-host-offline-badge', text: 'host offline' });
      }
    }

    // Local-by-default badge: a relay/external row that actually maps back to
    // a local instance on this device is marked so it isn't mistaken for a
    // true remote session.
    if (this.isLocalRelaySession(session)) {
      const localBadge = cell.createSpan({ cls: 'pi-farm-local-mirror-badge' });
      setIcon(localBadge, 'monitor');
      localBadge.createSpan({ text: ' local' });
    }

    const nameLink = cell.createEl('a', {
      text: session.title || '(untitled)',
      cls: 'pi-farm-name',
    });
    nameLink.addEventListener('click', (e: Event) => {
      e.preventDefault();
      void this.openSession(session);
    });

    // Actions button as a second line under the name (more accessible than a
    // separate actions column, especially on mobile).
    const actionsLine = cell.createDiv({ cls: 'pi-farm-name-actions' });
    const openBtn = actionsLine.createEl('button', { text: 'Open', cls: 'pi-farm-open-btn' });
    openBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      void this.openSession(session);
    });
  }

  private renderDataCell(
    cell: HTMLElement,
    colId: string,
    row: SessionSummary | ChatSummary,
    isExternal = false,
  ): void {
    switch (colId) {
      case 'status': {
        const info = statusInfo(row.status ?? 0);
        // Detect question_user (agent waiting for the user to pick an option):
        // the broker's deriveCurrentAction returns 'tool: question_user' while
        // the tool call is active. Show an "asking" badge so the user knows the
        // session is blocked on their input.
        const action = 'currentAction' in row ? (row as { currentAction?: string }).currentAction : undefined;
        const isAsking = !!action && /question[_-]?user|\bquestion\b/i.test(action);
        if (isAsking) {
          const askEl = cell.createEl('span', {
            text: 'asking',
            cls: 'pi-farm-status pi-farm-status-asking',
            title: `Agent is waiting for your input (${action})`,
          });
          askEl.createSpan({ cls: 'pi-farm-status-pulse', text: '?' });
        } else {
          const statusEl = cell.createEl('span', {
            text: info.label,
            cls: `pi-farm-status ${info.cls}`,
          });
          if (info.cls === 'pi-farm-status-running') {
            statusEl.createSpan({ cls: 'pi-farm-status-spinner', text: '●' });
          }
        }
        // Session-level scheduler annotations (not chat-level).
        if ('paused' in row && row.paused) {
          cell.createSpan({ cls: 'pi-farm-paused-badge', text: 'paused' });
        }
        if ('priority' in row && typeof row.priority === 'number' && row.priority !== 0) {
          cell.createSpan({ cls: 'pi-farm-priority-badge', text: String(row.priority) });
        }
        if (
          info.label === 'waiting' &&
          'waitingOnCount' in row &&
          typeof row.waitingOnCount === 'number' &&
          row.waitingOnCount > 0
        ) {
          cell.createSpan({
            cls: 'pi-farm-waiting-badge',
            text: `waiting on ${row.waitingOnCount}`,
          });
        }
        break;
      }
      case 'modifiedAt':
        cell.textContent = formatDate(row.modifiedAt);
        break;
      case 'workingDirectory':
        cell.textContent = formatWorkingDirectory(row.workingDirectory);
        break;
      case 'model': {
        cell.createEl('div', { text: row.model ?? '—', cls: 'pi-farm-model' });
        if (row.modelProvider) {
          cell.createEl('small', { text: row.modelProvider, cls: 'pi-farm-provider' });
        }
        break;
      }
      case 'tokens':
        cell.textContent = formatTokens(row, isExternal);
        break;
      case 'cost':
        cell.textContent = formatCost(row.cost);
        break;
      case 'turns':
        cell.textContent = row.turns != null ? String(row.turns) : '—';
        break;
      case 'activity':
        cell.textContent = row.currentAction ?? (row as SessionSummary).activity ?? '—';
        break;
      case 'subagents': {
        // N3: combined count of nested child sessions + tool-origin child chats.
        const sessionRow = row as SessionSummary;
        const total = this.childSessionCount(sessionRow) + (sessionRow.childChatCount ?? 0);
        cell.textContent = total > 0 ? String(total) : '—';
        break;
      }
      case 'actions': {
        const chatRow = row as ChatSummary;
        if (chatRow.origin?.kind === 'tool') {
          const actionsCell = cell.createDiv({ cls: 'pi-farm-actions-cell' });
          this.createOpenInTuiButton(actionsCell, chatRow);
          break;
        }
        const sessionRow = row as SessionSummary;
        const isArchived = statusInfo(sessionRow.status ?? 0).isArchived;
        const actionsCell = cell.createDiv({ cls: 'pi-farm-actions-cell' });

        this.createOpenButton(actionsCell, sessionRow);

        // Swarm dispatch: worker/external rows (host-agent relayed, e.g. arthur's
        // ahp-session:/ext-arthur-arthur-default) get a "Dispatch task" action that
        // routes a headless `pi -p "<task>"` to the worker via the AHP relay.
        if (sessionRow.kind === 'external' && sessionRow.hostAgentName) {
          const dispatchBtn = this.createIconButton(actionsCell, {
            icon: 'send',
            label: 'Dispatch task',
          });
          dispatchBtn.addEventListener('click', () => void this.dispatchTaskPrompt(sessionRow));
        }

        const archiveLabel = isArchived ? 'Unarchive' : 'Archive';
        const archiveIcon = isArchived ? 'archive-restore' : 'archive';
        const archiveBtn = this.createIconButton(actionsCell, {
          icon: archiveIcon,
          label: archiveLabel,
        });
        archiveBtn.addEventListener('click', () =>
          void this.setSessionArchive(sessionRow.resource, !isArchived),
        );

        const killBtn = this.createIconButton(actionsCell, { icon: 'trash-2', label: 'Kill' });
        killBtn.addEventListener('click', () => void this.killSession(sessionRow));

        // Phase 3 scheduler row actions.
        const isPaused = !!sessionRow.paused;
        const pauseBtn = this.createIconButton(actionsCell, {
          icon: isPaused ? 'play' : 'pause',
          label: isPaused ? 'Resume' : 'Pause',
        });
        pauseBtn.addEventListener('click', () =>
          void this.toggleSessionPause(sessionRow.resource, isPaused),
        );

        const retryBtn = this.createIconButton(actionsCell, { icon: 'rotate-ccw', label: 'Retry' });
        retryBtn.addEventListener('click', () => void this.retryTurn(sessionRow.resource));

        const priorityBtn = this.createIconButton(actionsCell, {
          icon: 'arrow-up',
          label: 'Set priority',
        });
        priorityBtn.addEventListener('click', () =>
          void this.setSessionPriorityPrompt(sessionRow.resource),
        );
        break;
      }
      default:
        cell.textContent = '—';
    }
  }

  private ensureSessionChatsSubscribed(uri: string): void {
    if (this.sessionChatUnsubs.has(uri)) return;
    this.subscribeSessionChats(uri);
  }

  private subscribeSessionChats(uri: string): void {
    const client = this.plugin.ahpClient;
    if (client && typeof client.subscribeSessionChats === 'function') {
      const unsub = client.subscribeSessionChats(uri, (chats) => {
        this.sessionChats.set(uri, chats);
        this.renderTable();
      });
      this.sessionChatUnsubs.set(uri, unsub);
    }
  }

  private expandSession(uri: string): void {
    if (!this.collapsedSessions.has(uri)) return;
    this.collapsedSessions.delete(uri);
    this.subscribeSessionChats(uri);
  }

  private collapseSession(uri: string): void {
    if (!this.collapsedSessions.has(uri)) {
      this.collapsedSessions.add(uri);
    }
    this.sessionChats.delete(uri);
    const unsub = this.sessionChatUnsubs.get(uri);
    if (unsub) {
      try {
        unsub();
      } catch {
        /* ignore */
      }
      this.sessionChatUnsubs.delete(uri);
    }
  }

  private async openSession(session: SessionSummary): Promise<void> {
    // Single open path (AUDIT FIX SLICE H): the plugin-level entry point does
    // the prefer-local routing itself — an own-device ext-<device>-<instanceId>
    // row opens the local PTY with session resume, everything else (true
    // remote external, offline-host gate, hosted) attaches via AHP. Keeping
    // the routing in ONE place means the session browser and the Farm view
    // can never drift apart.
    await this.plugin.openAhpTerminalForSession(session);
  }

  /** Return the local instance backing a relay/external row for THIS device, if any. */
  private parseLocalRelay(session: SessionSummary): { device: string; instanceId: string } | null {
    const localDevice = (this.plugin.settings.hostAgentDeviceName || 'Voyager').trim();
    const match = matchLocalRelaySession(session, localDevice);
    if (!match) return null;
    const instance = this.plugin.instanceManager?.get(match.instanceId);
    return instance ? match : null;
  }

  private isLocalRelaySession(session: SessionSummary): boolean {
    return this.parseLocalRelay(session) !== null;
  }

  /**
   * "Dispatch task" row action: prompt for the task (and the pool, defaulting to
   * the row's host agent device), then route it to the worker via the AHP relay
   * (headless `pi -p "<task>"`) and show the streamed result.
   */
  private async dispatchTaskPrompt(session: SessionSummary): Promise<void> {
    const device = session.hostAgentName ?? '';
    const task = await TextInputModal.prompt(
      this.app,
      'Dispatch task to worker',
      device ? `Task for ${device} (headless pi -p)` : 'Task for the worker (headless pi -p)',
      '',
    );
    if (!task) return;
    const pool = await TextInputModal.prompt(
      this.app,
      'Worker pool',
      'Host agent device name (e.g. arthur)',
      device,
    );
    if (!pool) return;
    await this.plugin.dispatchTaskToWorkerInteractive(pool, task);
  }

  private async setSessionArchive(uri: string, archived: boolean): Promise<void> {
    const client = this.plugin.ahpClient;
    if (!client || client.state !== 'connected') {
      new Notice('AHP client not connected', 4000);
      return;
    }
    try {
      await client.setSessionStatus(uri, archived ? 'archived' : 'active');
    } catch (err) {
      const msg = errorMessage(err);
      new Notice(`Failed to ${archived ? 'archive' : 'unarchive'} ${uri}: ${msg}`, 5000);
    }
  }

  private async toggleSessionPause(uri: string, paused: boolean): Promise<void> {
    const client = this.plugin.ahpClient;
    if (!client || client.state !== 'connected') {
      new Notice('AHP client not connected', 4000);
      return;
    }
    try {
      if (paused) {
        await client.resumeSession(uri);
      } else {
        await client.pauseSession(uri);
      }
    } catch (err) {
      const msg = errorMessage(err);
      new Notice(`Failed to ${paused ? 'resume' : 'pause'} ${uri}: ${msg}`, 5000);
    }
  }

  private async retryTurn(uri: string): Promise<void> {
    const client = this.plugin.ahpClient;
    if (!client || client.state !== 'connected') {
      new Notice('AHP client not connected', 4000);
      return;
    }
    try {
      await client.retryTurn(uri);
    } catch (err) {
      const msg = errorMessage(err);
      new Notice(`Failed to retry ${uri}: ${msg}`, 5000);
    }
  }

  private async setSessionPriorityPrompt(uri: string): Promise<void> {
    const client = this.plugin.ahpClient;
    if (!client || client.state !== 'connected') {
      new Notice('AHP client not connected', 4000);
      return;
    }
    const current = this.sessions.find((s) => s.resource === uri)?.priority ?? 0;
    const raw = window.prompt(`Set priority for ${uri} (current: ${current})`, String(current));
    if (raw === null) return;
    const trimmed = raw.trim();
    if (trimmed === '' || Number.isNaN(Number(trimmed))) {
      new Notice('Priority must be a number', 3000);
      return;
    }
    const priority = Number(trimmed);
    try {
      await client.setSessionPriority(uri, priority);
    } catch (err) {
      const msg = errorMessage(err);
      new Notice(`Failed to set priority for ${uri}: ${msg}`, 5000);
    }
  }

  private async killSelected(): Promise<void> {
    if (this.selected.size === 0) {
      new Notice('No sessions selected', 3000);
      return;
    }
    const uris = Array.from(this.selected);
    const names = uris.map((uri) => this.sessions.find((s) => s.resource === uri)?.title || uri);
    const confirmed = window.confirm(
      `Kill ${uris.length} selected session${uris.length > 1 ? 's' : ''}?\n\n${names.join('\n')}`,
    );
    if (!confirmed) return;
    const client = this.plugin.ahpClient;
    if (!client) {
      new Notice('AHP client not connected', 4000);
      return;
    }
    for (const uri of uris) {
      try {
        await client.disposeSession(uri);
      } catch (err) {
        const msg = errorMessage(err);
        new Notice(`Failed to kill ${uri}: ${msg}`, 5000);
      }
    }
    this.selected.clear();
    this.renderTable();
  }

  private async killSession(session: SessionSummary): Promise<void> {
    const confirmed = window.confirm(
      `Kill session?\n\n${session.title || session.resource}`,
    );
    if (!confirmed) return;
    const client = this.plugin.ahpClient;
    if (!client) {
      new Notice('AHP client not connected', 4000);
      return;
    }
    try {
      await client.disposeSession(session.resource);
    } catch (err) {
      const msg = errorMessage(err);
      new Notice(`Failed to kill ${session.resource}: ${msg}`, 5000);
    }
  }

  private createIconButton(
    container: HTMLElement,
    opts: { icon: string; label: string },
  ): HTMLElement {
    const btn = container.createEl('button', { cls: 'pi-farm-action-btn' });
    setIcon(btn, opts.icon);
    btn.setAttribute('aria-label', opts.label);
    btn.title = opts.label;
    return btn;
  }

  private createOpenButton(container: HTMLElement, session: SessionSummary): HTMLElement {
    return this.createCompositeOpenButton(container, 'Open', () => void this.openSession(session));
  }

  private createOpenInTuiButton(container: HTMLElement, chat: ChatSummary): HTMLElement {
    return this.createCompositeOpenButton(container, 'Open in TUI', () =>
      void this.plugin.openAhpTerminalForChat(chat.resource),
    );
  }

  private createCompositeOpenButton(
    container: HTMLElement,
    label: string,
    handler: () => void,
  ): HTMLElement {
    const btn = container.createEl('button', { cls: 'pi-farm-action-btn' });
    const outer = btn.createSpan({ cls: 'pi-farm-tui-icon' });
    setIcon(outer, 'squircle-dashed');
    const inner = outer.createSpan({ cls: 'pi-farm-tui-icon-inner' });
    setIcon(inner, 'chevron-right');
    btn.setAttribute('aria-label', label);
    btn.title = label;
    btn.addEventListener('click', () => handler());
    return btn;
  }
}
