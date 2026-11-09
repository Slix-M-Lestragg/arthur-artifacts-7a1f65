import type { PiTerminalIconState } from '../views/TerminalIcon';
import type { PtyClientState } from '../transport/PtyClient';
import type { MenubarInstance, MenubarReport, MenubarVaultSnapshot } from './menubarSnapshot';
import { formatAgo } from './menubarSnapshot';

/**
 * Pure, Electron-free description of the tray context menu. {@link MenubarIcon}
 * translates this into `Menu.buildFromTemplate(...)`. Keeping it as data makes
 * the grouping / glyph / status logic unit-testable without spinning up Electron.
 */

/** A single instance row: clicking it opens that terminal in the owning app. */
export interface MenuInstanceRow {
  kind: 'instance';
  reporterId: string;
  vaultId: string;
  instanceId: string;
  /** "● Default" — status glyph + instance name. */
  label: string;
  /** Short status text only (e.g. "Running…", "Idle", "Waiting for input"). */
  statusText: string;
  /** Secondary stats line (model · ctx% · cost · turns · ago) — empty string when nothing is known. */
  secondary: string;
  /** "Running · claude-sonnet-4-5 · 2m ago" — legacy combined detail line (status · model · ago), kept for the native menu sublabel. */
  detail: string;
  /** False when the owning reporter has disconnected (greyed out). */
  enabled: boolean;
  action: 'open';
}

/** A vault submenu: groups that vault's instance rows. */
export interface MenuVaultGroup {
  kind: 'vault';
  vaultId: string;
  /** "My Vault (2)" — vault display name + live instance count. */
  label: string;
  rows: MenuInstanceRow[];
}

export interface MenuSeparator { kind: 'separator'; }

/** A global footer action (settings, etc.). Routed to a connected reporter. */
export interface MenuActionRow {
  kind: 'action';
  label: string;
  detail?: string;
  enabled: boolean;
  action: 'open-settings';
  /** Which reporter should handle the action (first connected one). */
  reporterId?: string;
}

export type MenuNode = MenuVaultGroup | MenuSeparator | MenuActionRow;

export interface BuildMenuOptions {
  /** Reporter id of the leader (so it can prefer itself for footer actions). */
  thisReporterId: string;
  /** When false, idle + disconnected instances are omitted. */
  showIdle: boolean;
  /** Reporter ids still connected (others' rows render disabled). */
  connectedReporterIds: Set<string>;
  /** Override "now" for deterministic ago formatting in tests. */
  now?: number;
}

/** Status glyph for a terminal instance, mirroring the in-app tab icons. */
export function statusGlyph(state: PiTerminalIconState): string {
  switch (state) {
    case 'running':         return '●';
    case 'awaiting-input':  return '❓';
    case 'done-unseen':     return '✶';
    case 'seen':            return '✓';
    case 'error':           return '✖';
    default:                return '○';
  }
}

/** Short human status, mirroring InstanceStats.statusLine (kept compact for a menu). */
export function shortStatus(
  state: PiTerminalIconState,
  ptyState: PtyClientState | null,
  lastErrorMessage?: string,
): string {
  switch (state) {
    case 'running':         return 'Running…';
    case 'awaiting-input':  return 'Waiting for input';
    case 'done-unseen':
    case 'seen':            return 'Done';
    case 'error':           return lastErrorMessage ? `Error: ${truncate(lastErrorMessage, 40)}` : 'Error';
    default:
      if (!ptyState || ptyState === 'disconnected') return 'Not connected';
      if (ptyState === 'connected') return 'Idle';
      return ptyState; // connecting / reconnecting / crashed
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function instanceRow(
  inst: MenubarInstance,
  vaultId: string,
  reporterId: string,
  connected: boolean,
  now: number,
): MenuInstanceRow {
  const status = shortStatus(inst.iconState, inst.ptyState, inst.lastErrorMessage);
  return {
    kind: 'instance',
    reporterId,
    vaultId,
    instanceId: inst.id,
    label: `${statusGlyph(inst.iconState)} ${inst.name}`,
    statusText: status,
    secondary: secondaryLine(inst, now),
    detail: buildDetail(inst, now),
    enabled: connected,
    action: 'open',
  };
}

/** Secondary stats line: "model · 67% ctx · $0.42 · 14t · 2m ago" — parts with no data are omitted, empty string when nothing is known. */
export function secondaryLine(inst: MenubarInstance, now: number): string {
  const parts: string[] = [];
  if (inst.model) parts.push(inst.model);
  if (inst.contextPercent != null) parts.push(`${Math.round(inst.contextPercent)}% ctx`);
  if (inst.cost != null && inst.cost > 0) parts.push(`$${inst.cost.toFixed(2)}`);
  if (inst.turns != null && inst.turns > 0) parts.push(`${inst.turns}t`);
  if (inst.lastEventAt) parts.push(formatAgo(inst.lastEventAt, now));
  return parts.join(' · ');
}

function buildDetail(inst: MenubarInstance, now: number): string {
  const parts: string[] = [shortStatus(inst.iconState, inst.ptyState)];
  if (inst.model) parts.push(inst.model);
  if (inst.lastEventAt) parts.push(formatAgo(inst.lastEventAt, now));
  return parts.join(' · ');
}

function isIdle(inst: MenubarInstance): boolean {
  if (inst.iconState !== 'idle') return false;
  return !inst.ptyState || inst.ptyState === 'disconnected';
}

/**
 * Build the full tray context-menu tree from the leader's aggregated reports.
 * Vaults are sorted alphabetically by name; within a vault, instances preserve
 * their configured order. Idle/disconnected instances are filtered when
 * `showIdle` is false. The footer gets a separator + "Open pi settings",
 * routed to the leader if connected, else the first connected reporter.
 */
export function buildMenuTree(
  reports: Map<string, MenubarReport>,
  opts: BuildMenuOptions,
): MenuNode[] {
  const now = opts.now ?? Date.now();

  // Group reports by vault id; a vault published by multiple reporters (rare:
  // two Obsidian apps on the same vault) collapses into one submenu.
  const byVault = new Map<string, { name: string; rows: MenuInstanceRow[] }>();
  for (const report of reports.values()) {
    const v: MenubarVaultSnapshot = report.vault;
    let bucket = byVault.get(v.vaultId);
    if (!bucket) {
      bucket = { name: v.vaultName, rows: [] };
      byVault.set(v.vaultId, bucket);
    }
    const connected = opts.connectedReporterIds.has(report.reporterId);
    for (const inst of v.instances) {
      if (!opts.showIdle && isIdle(inst)) continue;
      bucket.rows.push(instanceRow(inst, v.vaultId, report.reporterId, connected, now));
    }
  }

  const nodes: MenuNode[] = [];
  const vaultIds = Array.from(byVault.keys()).sort((a, b) => {
    const na = byVault.get(a)!.name.toLowerCase();
    const nb = byVault.get(b)!.name.toLowerCase();
    return na < nb ? -1 : na > nb ? 1 : 0;
  });
  for (const vaultId of vaultIds) {
    const bucket = byVault.get(vaultId)!;
    if (bucket.rows.length === 0) continue;
    nodes.push({
      kind: 'vault',
      vaultId,
      label: `${bucket.name} (${bucket.rows.length})`,
      rows: bucket.rows,
    });
  }

  // Footer: settings action, routed to the leader if it's connected, else the
  // first connected reporter. Disabled entirely when nobody is connected.
  const connected = Array.from(reports.keys()).filter((id) => opts.connectedReporterIds.has(id));
  const settingsReporter =
    connected.includes(opts.thisReporterId) ? opts.thisReporterId : connected[0];
  nodes.push({ kind: 'separator' });
  nodes.push({
    kind: 'action',
    label: 'Open pi settings',
    detail: settingsReporter ? undefined : 'no Obsidian window connected',
    enabled: !!settingsReporter,
    action: 'open-settings',
    reporterId: settingsReporter,
  });

  return nodes;
}

/** Total visible instance count across all vaults (after idle filtering). */
export function countVisibleInstances(nodes: MenuNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.kind === 'vault') n += node.rows.length;
  }
  return n;
}

/** Tooltip for the tray icon: "pi — N instances across M vaults". */
export function trayTooltip(nodes: MenuNode[], vaultCount: number): string {
  const instances = countVisibleInstances(nodes);
  if (instances === 0) return 'pi — no active instances';
  const instWord = instances === 1 ? 'instance' : 'instances';
  const vaultWord = vaultCount === 1 ? 'vault' : 'vaults';
  return `pi — ${instances} ${instWord} across ${vaultCount} ${vaultWord}`;
}

/**
 * Multi-line rich tooltip for the tray icon: a header summary line followed by
 * each visible vault + its instances with per-instance detail (status · model ·
 * context % · cost · "Xm ago"). Obsidian/Electron's native macOS tray tooltip
 * renders `\n` as line breaks. Capped so a big workspace doesn't produce a
 * wall of text — excess instances are summarised as an ellipsis line.
 */
export function buildRichTooltip(nodes: MenuNode[], vaultCount: number, maxInstances = 12): string {
  const header = trayTooltip(nodes, vaultCount);
  const lines = [header, ''];
  let shown = 0;
  let truncated = 0;
  for (const node of nodes) {
    if (node.kind !== 'vault') continue;
    if (node.rows.length === 0) continue;
    if (shown >= maxInstances) { truncated += node.rows.length; continue; }
    lines.push(node.label);
    for (const row of node.rows) {
      if (shown >= maxInstances) { truncated++; continue; }
      lines.push(`  ${row.label}  ${row.detail}`);
      shown++;
    }
    lines.push('');
  }
  if (truncated > 0) lines.push(`… +${truncated} more`);
  return lines.join('\n').trimEnd();
}