import { describe, expect, it } from 'vitest';
import {
  deriveMenubarSnapshot,
  vaultIdFromPath,
  vaultNameOf,
  formatAgo,
} from './menubarSnapshot';
import type { MenubarReport } from './menubarSnapshot';
import type ObsidianPiPlugin from '../main';
import type { PiInstanceConfig } from '../types';

interface StubOpts {
  vaultPath?: string;
  vaultName?: string;
  instances?: PiInstanceConfig[];
  runtimes?: Record<string, {
    iconState?: string; ptyState?: string; model?: string;
    contextPercent?: number | null; cost?: number; lastEventAt?: number;
    awaitingInput?: boolean;
  }>;
}

function makePlugin(opts: StubOpts = {}): unknown {
  const instances = opts.instances ?? [{ id: 'default', name: 'Default', cwd: '' }];
  return {
    app: {
      vault: {
        getName: () => opts.vaultName ?? 'My Vault',
        adapter: { basePath: opts.vaultPath ?? '/home/me/My Vault' },
      },
    },
    settings: { instances },
    instanceManager: {
      get(id: string) {
        const rt = opts.runtimes?.[id];
        if (!rt) return undefined;
        return {
          iconState: rt.iconState ?? 'idle',
          awaitingInput: rt.awaitingInput ?? false,
          ptyClient: rt.ptyState ? { state: rt.ptyState } : null,
          stats: {
            model: rt.model,
            contextPercent: rt.contextPercent,
            cost: rt.cost,
            lastEventAt: rt.lastEventAt,
          },
        };
      },
    },
  };
}

describe('vaultIdFromPath', () => {
  it('is deterministic for the same path', () => {
    expect(vaultIdFromPath('/a/b')).toBe(vaultIdFromPath('/a/b'));
  });
  it('differs for different paths', () => {
    expect(vaultIdFromPath('/a/b')).not.toBe(vaultIdFromPath('/a/c'));
  });
});

describe('vaultNameOf', () => {
  it('prefers the Obsidian-configured vault name', () => {
    expect(vaultNameOf(makePlugin({ vaultName: 'Lab' }) as ObsidianPiPlugin)).toBe('Lab');
  });
  it('falls back to the basename when the name is empty', () => {
    expect(vaultNameOf(makePlugin({ vaultName: '', vaultPath: '/x/Research' }) as ObsidianPiPlugin)).toBe('Research');
  });
});

describe('deriveMenubarSnapshot', () => {
  it('builds a vault-scoped report with a stable vault id', () => {
    const plugin = makePlugin({ runtimes: { default: { iconState: 'running', ptyState: 'connected' } } }) as ObsidianPiPlugin;
    const report: MenubarReport = deriveMenubarSnapshot(plugin, 'rep-1');

    expect(report.reporterId).toBe('rep-1');
    expect(report.vault.vaultName).toBe('My Vault');
    expect(report.vault.vaultId).toBe(vaultIdFromPath('/home/me/My Vault'));
    expect(report.vault.instances).toHaveLength(1);
    expect(report.vault.instances[0]).toMatchObject({
      id: 'default', name: 'Default', iconState: 'running', ptyState: 'connected', awaitingInput: false,
    });
    expect(report.emittedAt).toBeTypeOf('number');
  });

  it('uses cwd basename for the instance, falling back to the vault root', () => {
    const plugin = makePlugin({
      instances: [
        { id: 'a', name: 'SDK', cwd: '/repos/sdk' },
        { id: 'b', name: 'No-cwd', cwd: '' },
      ],
      runtimes: {},
    }) as ObsidianPiPlugin;
    const report = deriveMenubarSnapshot(plugin, 'rep');

    expect(report.vault.instances[0].cwdBasename).toBe('sdk');
    expect(report.vault.instances[1].cwdBasename).toBe('My Vault');
  });

  it('defaults untouched instances to idle + null pty state', () => {
    const plugin = makePlugin() as ObsidianPiPlugin;
    const report = deriveMenubarSnapshot(plugin, 'rep');
    expect(report.vault.instances[0].iconState).toBe('idle');
    expect(report.vault.instances[0].ptyState).toBeNull();
  });

  it('carries live stats fields when present', () => {
    const at = Date.now() - 120_000;
    const plugin = makePlugin({
      runtimes: { default: { iconState: 'seen', ptyState: 'connected', model: 'claude-sonnet-4-5', contextPercent: 42, cost: 0.07, lastEventAt: at, awaitingInput: false } },
    }) as ObsidianPiPlugin;
    const report = deriveMenubarSnapshot(plugin, 'rep');
    expect(report.vault.instances[0]).toMatchObject({
      model: 'claude-sonnet-4-5', contextPercent: 42, cost: 0.07, lastEventAt: at,
    });
  });
});

describe('formatAgo', () => {
  const now = 1_000_000_000_000;
  it('just now / seconds', () => {
    expect(formatAgo(now, now)).toBe('just now');
    expect(formatAgo(now - 30_000, now)).toBe('30s ago');
  });
  it('minutes', () => {
    expect(formatAgo(now - 65_000, now)).toBe('1m ago');
  });
  it('hours', () => {
    expect(formatAgo(now - 3_600_000 * 2, now)).toBe('2h ago');
  });
});