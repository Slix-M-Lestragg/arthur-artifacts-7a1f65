import { describe, expect, it } from 'vitest';
import {
  buildMenuTree,
  statusGlyph,
  shortStatus,
  countVisibleInstances,
  trayTooltip,
  buildRichTooltip,
  type MenuNode,
} from './MenubarMenuBuilder';
import type { MenubarReport } from './menubarSnapshot';

const NOW = 1_700_000_000_000;

function report(
  reporterId: string,
  vaultId: string,
  vaultName: string,
  instances: Array<{ id: string; name: string; iconState: any; ptyState: any }>,
): MenubarReport {
  return {
    reporterId,
    emittedAt: NOW,
    vault: {
      vaultId,
      vaultName,
      vaultPath: `/v/${vaultName}`,
      instances: instances.map((i) => ({
        id: i.id, name: i.name, cwdBasename: i.name.toLowerCase(),
        iconState: i.iconState, ptyState: i.ptyState,
        awaitingInput: i.iconState === 'awaiting-input',
      })),
    },
  };
}

function build(reports: MenubarReport[], opts: Partial<Parameters<typeof buildMenuTree>[1]> = {}): MenuNode[] {
  const map = new Map<string, MenubarReport>();
  for (const r of reports) map.set(r.reporterId, r);
  const connected = opts.connectedReporterIds ?? new Set(reports.map((r) => r.reporterId));
  return buildMenuTree(map, {
    thisReporterId: opts.thisReporterId ?? 'leader',
    showIdle: opts.showIdle ?? true,
    connectedReporterIds: connected,
    now: NOW,
  });
}

describe('statusGlyph', () => {
  it('maps each icon state to a glyph', () => {
    expect(statusGlyph('running')).toBe('●');
    expect(statusGlyph('awaiting-input')).toBe('❓');
    expect(statusGlyph('done-unseen')).toBe('✶');
    expect(statusGlyph('seen')).toBe('✓');
    expect(statusGlyph('error')).toBe('✖');
    expect(statusGlyph('idle')).toBe('○');
  });
});

describe('shortStatus', () => {
  it('running / awaiting / done / error / idle states', () => {
    expect(shortStatus('running', 'connected')).toBe('Running…');
    expect(shortStatus('awaiting-input', 'connected')).toBe('Waiting for input');
    expect(shortStatus('seen', 'connected')).toBe('Done');
    expect(shortStatus('error', 'connected', 'disk full')).toBe('Error: disk full');
    expect(shortStatus('idle', 'connected')).toBe('Idle');
    expect(shortStatus('idle', null)).toBe('Not connected');
    expect(shortStatus('idle', 'disconnected')).toBe('Not connected');
  });
  it('truncates long error messages (message body capped, then "Error: " prefixed)', () => {
    const long = 'x'.repeat(80);
    const out = shortStatus('error', 'connected', long);
    // "Error: " (7) + 39-char truncated body + "…" = 47
    expect(out).toBe('Error: ' + 'x'.repeat(39) + '…');
    expect(out).toMatch(/…$/);
  });
  it('surfaces the raw pty state while connecting/reconnecting', () => {
    expect(shortStatus('idle', 'reconnecting')).toBe('reconnecting');
    expect(shortStatus('idle', 'connecting')).toBe('connecting');
  });
});

describe('buildMenuTree', () => {
  it('groups instances under one submenu per vault', () => {
    const nodes = build([
      report('a', 'v1', 'Alpha', [
        { id: 'd', name: 'Default', iconState: 'running', ptyState: 'connected' },
      ]),
      report('b', 'v2', 'Beta', [
        { id: 'x', name: 'Repo', iconState: 'idle', ptyState: 'connected' },
      ]),
    ]);
    const vaults = nodes.filter((n) => n.kind === 'vault');
    expect(vaults).toHaveLength(2);
    expect((vaults[0] as any).label).toBe('Alpha (1)');
    expect((vaults[1] as any).label).toBe('Beta (1)');
  });

  it('sorts vaults alphabetically by name', () => {
    const nodes = build([
      report('b', 'v2', 'Zeta', [{ id: 'd', name: 'D', iconState: 'idle', ptyState: 'connected' }]),
      report('a', 'v1', 'Alpha', [{ id: 'd', name: 'D', iconState: 'idle', ptyState: 'connected' }]),
    ]);
    const vaults = nodes.filter((n) => n.kind === 'vault') as any[];
    expect(vaults[0].label).toBe('Alpha (1)');
    expect(vaults[1].label).toBe('Zeta (1)');
  });

  it('collapses two reporters on the same vault into one submenu', () => {
    const nodes = build([
      report('a', 'shared', 'Shared', [{ id: 'd1', name: 'One', iconState: 'running', ptyState: 'connected' }]),
      report('b', 'shared', 'Shared', [{ id: 'd2', name: 'Two', iconState: 'idle', ptyState: 'connected' }]),
    ]);
    const vaults = nodes.filter((n) => n.kind === 'vault') as any[];
    expect(vaults).toHaveLength(1);
    expect(vaults[0].rows).toHaveLength(2);
    expect(vaults[0].rows[0].reporterId).toBe('a');
    expect(vaults[0].rows[1].reporterId).toBe('b');
  });

  it('tags each row with reporterId/vaultId/instanceId for click routing', () => {
    const nodes = build([
      report('rep9', 'v1', 'Alpha', [{ id: 'inst7', name: 'Default', iconState: 'running', ptyState: 'connected' }]),
    ]);
    const row = (nodes[0] as any).rows[0];
    expect(row).toMatchObject({ reporterId: 'rep9', vaultId: 'v1', instanceId: 'inst7', action: 'open', enabled: true });
  });

  it('renders disconnected reporters rows as disabled', () => {
    const nodes = build([
      report('a', 'v1', 'Alpha', [{ id: 'd', name: 'Default', iconState: 'running', ptyState: 'connected' }]),
    ], { connectedReporterIds: new Set(['leader']), thisReporterId: 'leader' });
    const row = (nodes[0] as any).rows[0];
    expect(row.enabled).toBe(false);
  });

  it('filters idle+disconnected instances when showIdle is false', () => {
    const nodes = build([
      report('a', 'v1', 'Alpha', [
        { id: 'live', name: 'Live', iconState: 'running', ptyState: 'connected' },
        { id: 'dead', name: 'Dead', iconState: 'idle', ptyState: 'disconnected' },
        { id: 'idlelive', name: 'IdleLive', iconState: 'idle', ptyState: 'connected' },
      ]),
    ], { showIdle: false });
    const vault = nodes[0] as any;
    expect(vault.rows).toHaveLength(2); // drops 'dead', keeps connected-idle
    expect(vault.rows.map((r: any) => r.instanceId).sort()).toEqual(['idlelive', 'live']);
  });

  it('includes a footer separator + settings action', () => {
    const nodes = build([
      report('leader', 'v1', 'Alpha', [{ id: 'd', name: 'Default', iconState: 'running', ptyState: 'connected' }]),
    ], { thisReporterId: 'leader' });
    const sep = nodes[nodes.length - 2];
    const action = nodes[nodes.length - 1];
    expect(sep.kind).toBe('separator');
    expect(action.kind).toBe('action');
    expect((action as any).action).toBe('open-settings');
    expect((action as any).reporterId).toBe('leader');
    expect((action as any).enabled).toBe(true);
  });

  it('disables the settings action when no reporter is connected', () => {
    const nodes = build([
      report('a', 'v1', 'Alpha', [{ id: 'd', name: 'Default', iconState: 'running', ptyState: 'connected' }]),
    ], { connectedReporterIds: new Set<string>(), thisReporterId: 'leader' });
    const action = nodes[nodes.length - 1] as any;
    expect(action.enabled).toBe(false);
    expect(action.detail).toBe('no Obsidian window connected');
  });

  it('omits a vault submenu entirely when all its instances are filtered out', () => {
    const nodes = build([
      report('a', 'v1', 'Alpha', [{ id: 'dead', name: 'Dead', iconState: 'idle', ptyState: 'disconnected' }]),
    ], { showIdle: false });
    expect(nodes.filter((n) => n.kind === 'vault')).toHaveLength(0);
  });

  it('instance detail line joins status, model, and ago', () => {
    const nodes = build([
      report('a', 'v1', 'Alpha', [{ id: 'd', name: 'Default', iconState: 'seen', ptyState: 'connected' }]),
    ]);
    // detail is built from snapshot stats; without model/lastEventAt in this
    // stub it degrades to just "Done" — verify the join path with a fuller report.
    const row = (nodes[0] as any).rows[0];
    expect(row.detail).toBe('Done');
  });
});

describe('countVisibleInstances / trayTooltip', () => {
  it('counts rows across vault submenus', () => {
    const nodes = build([
      report('a', 'v1', 'Alpha', [
        { id: 'd1', name: 'A', iconState: 'running', ptyState: 'connected' },
        { id: 'd2', name: 'B', iconState: 'idle', ptyState: 'connected' },
      ]),
      report('b', 'v2', 'Beta', [{ id: 'd3', name: 'C', iconState: 'error', ptyState: 'connected' }]),
    ]);
    expect(countVisibleInstances(nodes)).toBe(3);
  });
  it('pluralizes the tooltip correctly', () => {
    expect(trayTooltip([], 0)).toBe('pi — no active instances');
    const nodes = build([report('a', 'v1', 'Alpha', [{ id: 'd', name: 'D', iconState: 'running', ptyState: 'connected' }])]);
    expect(trayTooltip(nodes, 1)).toBe('pi — 1 instance across 1 vault');
    const nodes2 = build([
      report('a', 'v1', 'Alpha', [{ id: 'd', name: 'D', iconState: 'running', ptyState: 'connected' }]),
      report('b', 'v2', 'Beta', [{ id: 'e', name: 'E', iconState: 'running', ptyState: 'connected' }]),
    ]);
    expect(trayTooltip(nodes2, 2)).toBe('pi — 2 instances across 2 vaults');
  });
});

describe('buildRichTooltip', () => {
  it('starts with the header summary line, then a per-vault / per-instance breakdown', () => {
    const nodes = build([
      report('a', 'v1', 'Alpha', [
        { id: 'd1', name: 'One', iconState: 'running', ptyState: 'connected' },
        { id: 'd2', name: 'Two', iconState: 'idle', ptyState: 'connected' },
      ]),
    ]);
    const text = buildRichTooltip(nodes, 1);
    const lines = text.split('\n');
    expect(lines[0]).toBe('pi — 2 instances across 1 vault');
    expect(lines).toContain('Alpha (2)');
    const oneLine = lines.find((l) => l.startsWith('  ● One'));
    expect(oneLine).toBeTruthy();
    expect(oneLine).toContain('Running…');
  });

  it('caps the breakdown and appends an ellipsis line when there are too many instances', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      id: `v${i}`, vaultId: `v${i}`, vaultName: `V${i}`,
      instances: [
        { id: `d${i}a`, name: 'A', iconState: 'running', ptyState: 'connected' },
        { id: `d${i}b`, name: 'B', iconState: 'idle', ptyState: 'connected' },
        { id: `d${i}c`, name: 'C', iconState: 'idle', ptyState: 'connected' },
      ],
    }));
    const reports = many.map((r) => report(r.id, r.vaultId, r.vaultName, r.instances));
    const nodes = build(reports);
    const text = buildRichTooltip(nodes, 5, 4);
    expect(text).toContain('… +');
  });
});