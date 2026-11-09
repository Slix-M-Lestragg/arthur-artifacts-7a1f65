import { describe, expect, it } from 'vitest';
import { buildPopoverHtml, parsePopoverRoute, POPOVER_ROUTE_MARKER } from './MenubarPopover';
import type { MenubarReport } from './menubarSnapshot';

const NOW = 1_700_000_000_000;

function report(reporterId: string, vaultId: string, vaultName: string, instances: Array<{ id: string; name: string; iconState: any; ptyState: any; model?: string; contextPercent?: number | null; cost?: number; turns?: number; lastEventAt?: number }>): MenubarReport {
  return {
    reporterId,
    emittedAt: NOW,
    vault: {
      vaultId, vaultName, vaultPath: `/v/${vaultName}`,
      instances: instances.map((i) => ({
        id: i.id, name: i.name, cwdBasename: i.name.toLowerCase(),
        iconState: i.iconState, ptyState: i.ptyState, awaitingInput: false,
        model: i.model, contextPercent: i.contextPercent, cost: i.cost,
        turns: i.turns, lastEventAt: i.lastEventAt,
      })),
    },
  };
}

describe('buildPopoverHtml', () => {
  it('renders a flat panel with one vault section header + its instance rows (no <a> navigation, no submenus)', () => {
    const reports = new Map([
      ['a', report('a', 'v1', 'Alpha', [
        { id: 'd', name: 'Default', iconState: 'running', ptyState: 'connected' },
      ])],
    ]);
    const html = buildPopoverHtml(reports, {
      thisReporterId: 'a', showIdle: true, connectedReporterIds: new Set(['a']), now: NOW,
    });
    expect(html).toContain('class="vault">Alpha (1)<');
    expect(html).toContain('class="row"');
    expect(html).toContain('Default');
    expect(html).not.toContain('<a '); // rows are divs, not links — no navigation
    expect(html).not.toContain('href=');
  });

  it('emits multiple vault sections separated by dividers', () => {
    const reports = new Map([
      ['a', report('a', 'v1', 'Alpha', [{ id: 'd', name: 'A', iconState: 'running', ptyState: 'connected' }])],
      ['b', report('b', 'v2', 'Beta', [{ id: 'e', name: 'B', iconState: 'idle', ptyState: 'connected' }])],
    ]);
    const html = buildPopoverHtml(reports, {
      thisReporterId: 'a', showIdle: true, connectedReporterIds: new Set(['a', 'b']), now: NOW,
    });
    expect(html).toContain('Alpha (1)');
    expect(html).toContain('Beta (1)');
    const sepCount = (html.match(/class="sep"/g) || []).length;
    expect(sepCount).toBeGreaterThanOrEqual(1);
  });

  it('row data-url encodes reporterId + instanceId for click routing', () => {
    const reports = new Map([
      ['rep9', report('rep9', 'v1', 'Alpha', [{ id: 'inst7', name: 'Default', iconState: 'running', ptyState: 'connected' }])],
    ]);
    const html = buildPopoverHtml(reports, {
      thisReporterId: 'rep9', showIdle: true, connectedReporterIds: new Set(['rep9']), now: NOW,
    });
    expect(html).toContain('data-url="open/rep9/inst7"');
  });

  it('disabled (disconnected) rows get the disabled class', () => {
    const reports = new Map([
      ['a', report('a', 'v1', 'Alpha', [{ id: 'd', name: 'D', iconState: 'running', ptyState: 'connected' }])],
    ]);
    const html = buildPopoverHtml(reports, {
      thisReporterId: 'leader', showIdle: true, connectedReporterIds: new Set(['leader']), now: NOW,
    });
    expect(html).toContain('class="row disabled"');
  });

  it('escapes HTML in vault/instance names', () => {
    const reports = new Map([
      ['a', report('a', 'v1', 'Alpha', [{ id: 'd', name: '<b>x</b>', iconState: 'idle', ptyState: 'connected' }])],
    ]);
    const html = buildPopoverHtml(reports, {
      thisReporterId: 'a', showIdle: true, connectedReporterIds: new Set(['a']), now: NOW,
    });
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('<b>x</b>');
  });

  it('renders a secondary stats line (model · ctx% · cost · turns · ago) when stats are present', () => {
    const reports = new Map([
      ['a', report('a', 'v1', 'Alpha', [{
        id: 'd', name: 'Default', iconState: 'seen', ptyState: 'connected',
        model: 'glm-5', contextPercent: 67.3, cost: 0.42, turns: 14, lastEventAt: NOW - 120_000,
      }])],
    ]);
    const html = buildPopoverHtml(reports, {
      thisReporterId: 'a', showIdle: true, connectedReporterIds: new Set(['a']), now: NOW,
    });
    expect(html).toContain('class="status"');
    expect(html).toContain('class="secondary"');
    expect(html).toContain('glm-5');
    expect(html).toContain('67% ctx');
    expect(html).toContain('$0.42');
    expect(html).toContain('14t');
    expect(html).toContain('2m ago');
  });

  it('footer rows carry a settings data-url', () => {
    const reports = new Map([
      ['a', report('a', 'v1', 'Alpha', [{ id: 'd', name: 'D', iconState: 'running', ptyState: 'connected' }])],
    ]);
    const html = buildPopoverHtml(reports, {
      thisReporterId: 'a', showIdle: true, connectedReporterIds: new Set(['a']), now: NOW,
    });
    expect(html).toContain('data-url="settings"');
  });
});

describe('parsePopoverRoute', () => {
  it('parses an open-instance token', () => {
    expect(parsePopoverRoute('open/rep9/inst7')).toEqual({
      kind: 'open', reporterId: 'rep9', instanceId: 'inst7',
    });
  });
  it('decodes url-encoded ids', () => {
    expect(parsePopoverRoute('open/re%20p/ins%2F7')).toEqual({
      kind: 'open', reporterId: 're p', instanceId: 'ins/7',
    });
  });
  it('parses settings / focus tokens', () => {
    expect(parsePopoverRoute('settings')).toEqual({ kind: 'settings' });
    expect(parsePopoverRoute('focus')).toEqual({ kind: 'focus' });
  });
  it('returns null for unknown tokens', () => {
    expect(parsePopoverRoute('unknown')).toBeNull();
    expect(parsePopoverRoute('open/onlyone')).toBeNull(); // missing instance id
  });
});

describe('POPOVER_ROUTE_MARKER', () => {
  it('is a non-empty string the injected script prefixes its console.log with', () => {
    expect(typeof POPOVER_ROUTE_MARKER).toBe('string');
    expect(POPOVER_ROUTE_MARKER.length).toBeGreaterThan(0);
  });
});