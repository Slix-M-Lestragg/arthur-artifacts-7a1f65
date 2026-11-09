import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { InstanceManager } from './InstanceManager';
import { instanceSessionsDir } from './InstancePaths';
import type ObsidianPiPlugin from '../main';
import type { PiInstanceConfig } from '../types';

function makePlugin(vaultPath: string, instances: PiInstanceConfig[]): ObsidianPiPlugin {
  return {
    app: { vault: { adapter: { basePath: vaultPath } } },
    manifest: { dir: '.obsidian/plugins/obsidian-pi' },
    settings: {
      instances,
      restoreSessionOnRestart: true,
      lastTerminalSessionFile: null,
    },
    saveSettings: vi.fn(async () => {}),
  } as unknown as ObsidianPiPlugin;
}

describe('InstanceManager.dispose', () => {
  function makeMgr(): { plugin: ObsidianPiPlugin; mgr: InstanceManager } {
    const plugin = makePlugin('/tmp/pi-inst-dispose-test', []);
    return { plugin, mgr: new InstanceManager(plugin) };
  }

  function fakePty(impl: () => Promise<void>): { dispose: ReturnType<typeof vi.fn> } {
    return { dispose: vi.fn(impl) };
  }

  it('awaits the PTY kill so the child cannot outlive the plugin (AUDIT §3 findings 5/9)', async () => {
    const { mgr } = makeMgr();
    const inst = mgr.getOrCreate('default');
    let killed = false;
    const pty = fakePty(async () => {
      await new Promise((r) => setTimeout(r, 10));
      killed = true;
    });
    (inst as unknown as { ptyClient: unknown }).ptyClient = pty;
    let popoutClosed = false;
    (inst as unknown as { promptPopout: unknown }).promptPopout = { close: () => { popoutClosed = true; } };

    const p = mgr.dispose('default');
    // Instance removed synchronously; the kill is still in flight.
    expect(mgr.get('default')).toBeUndefined();
    expect(popoutClosed).toBe(true);
    expect(killed).toBe(false);
    await p;
    expect(killed).toBe(true);
    expect(pty.dispose).toHaveBeenCalledTimes(1);
  });

  it('contains PTY kill rejections instead of letting them escape as unhandled rejections', async () => {
    const { mgr } = makeMgr();
    const inst = mgr.getOrCreate('default');
    const pty = fakePty(async () => {
      throw new Error('kill failed');
    });
    (inst as unknown as { ptyClient: unknown }).ptyClient = pty;

    await expect(mgr.dispose('default')).resolves.toBeUndefined();
    expect(pty.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposeAll awaits every PTY kill', async () => {
    const { mgr } = makeMgr();
    const a = mgr.getOrCreate('a');
    const b = mgr.getOrCreate('b');
    const kills: string[] = [];
    (a as unknown as { ptyClient: unknown }).ptyClient = fakePty(async () => {
      await new Promise((r) => setTimeout(r, 5));
      kills.push('a');
    });
    (b as unknown as { ptyClient: unknown }).ptyClient = fakePty(async () => {
      kills.push('b');
    });

    await mgr.disposeAll();

    expect(kills.sort()).toEqual(['a', 'b']);
    expect(mgr.all()).toHaveLength(0);
  });
});

describe('InstanceManager.recordTerminalSessionFile', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-inst-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('persists per-instance lastSessionFile; default instance also syncs legacy setting', async () => {
    const instances: PiInstanceConfig[] = [
      { id: 'default', name: 'Default', cwd: '' },
      { id: 'sdk', name: 'SDK', cwd: '' },
    ];
    const plugin = makePlugin(tmp, instances);
    const mgr = new InstanceManager(plugin);

    const sdkInst = mgr.getOrCreate('sdk');
    const sdkSession = path.join(instanceSessionsDir(plugin, sdkInst.config), 'sdk-session.jsonl');
    fs.mkdirSync(path.dirname(sdkSession), { recursive: true });
    fs.writeFileSync(sdkSession, '');

    await mgr.recordTerminalSessionFile(sdkInst, sdkSession);

    expect(sdkInst.config.lastSessionFile).toBe(sdkSession);
    expect(plugin.settings.lastTerminalSessionFile).toBeNull();
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);

    const defaultInst = mgr.getOrCreate('default');
    const defaultSession = path.join(
      instanceSessionsDir(plugin, defaultInst.config),
      'default-session.jsonl',
    );
    fs.mkdirSync(path.dirname(defaultSession), { recursive: true });
    fs.writeFileSync(defaultSession, '');

    vi.mocked(plugin.saveSettings).mockClear();
    await mgr.recordTerminalSessionFile(defaultInst, defaultSession);

    expect(defaultInst.config.lastSessionFile).toBe(defaultSession);
    expect(plugin.settings.lastTerminalSessionFile).toBe(defaultSession);
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when restoreSessionOnRestart is disabled', async () => {
    const instances: PiInstanceConfig[] = [{ id: 'sdk', name: 'SDK', cwd: '' }];
    const plugin = makePlugin(tmp, instances);
    plugin.settings.restoreSessionOnRestart = false;
    const mgr = new InstanceManager(plugin);
    const inst = mgr.getOrCreate('sdk');

    await mgr.recordTerminalSessionFile(inst, '/fake/session.jsonl');

    expect(inst.config.lastSessionFile).toBeUndefined();
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });
});

describe('InstanceManager.resolveLocalSessionResumePath', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-resume-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('prefers a session file whose display name matches the requested title', async () => {
    const instances: PiInstanceConfig[] = [{ id: 'default', name: 'Default', cwd: '' }];
    const plugin = makePlugin(tmp, instances);
    const mgr = new InstanceManager(plugin);
    const inst = mgr.getOrCreate('default');
    const dir = instanceSessionsDir(plugin, inst.config);
    fs.mkdirSync(dir, { recursive: true });

    const named = path.join(dir, 'named-session.jsonl');
    const newest = path.join(dir, 'newest-session.jsonl');
    fs.writeFileSync(
      named,
      JSON.stringify({ type: 'session_info', name: 'NP300-Equipements' }) + '\n',
    );
    fs.writeFileSync(newest, '');

    const now = Date.now();
    fs.utimesSync(named, now / 1000, now / 1000);
    fs.utimesSync(newest, (now + 1000) / 1000, (now + 1000) / 1000);

    const result = await mgr.resolveLocalSessionResumePath('default', 'NP300-Equipements');
    expect(result).toBe(named);
  });

  it('falls back to the newest session file when no name matches', async () => {
    const instances: PiInstanceConfig[] = [{ id: 'default', name: 'Default', cwd: '' }];
    const plugin = makePlugin(tmp, instances);
    const mgr = new InstanceManager(plugin);
    const inst = mgr.getOrCreate('default');
    const dir = instanceSessionsDir(plugin, inst.config);
    fs.mkdirSync(dir, { recursive: true });

    const older = path.join(dir, 'older.jsonl');
    const newer = path.join(dir, 'newer.jsonl');
    fs.writeFileSync(older, '');
    fs.writeFileSync(newer, '');

    const now = Date.now();
    fs.utimesSync(older, (now - 1000) / 1000, (now - 1000) / 1000);
    fs.utimesSync(newer, now / 1000, now / 1000);

    const result = await mgr.resolveLocalSessionResumePath('default', 'Unknown');
    expect(result).toBe(newer);
  });
});
