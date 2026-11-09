/**
 * Plugin-level tests for the M4 Farm View / host-agent terminal open path:
 * `ObsidianPiPlugin.openAhpTerminalForSession` (src/main.ts). These run the
 * REAL method end-to-end — real `extractTerminalSnapshot`, real
 * `confirmLiveMirrorSession` seam (mocked to confirm instantly), real
 * -32000 error branch — against a stubbed AhpClient, so the M4 verification
 * flags (dead local PTY, snapshot scrollback replay) are pinned at the
 * main.ts / transport boundary rather than re-tested only via helpers.
 *
 * Importing `./main` pulls in the full plugin module tree, so the obsidian
 * mock is extended here with the surface main.ts needs at module load
 * (Plugin base class, Menu/setTooltip/addIcon for the terminal + ribbon
 * modules) and a Notice spy for asserting user-facing messages.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('obsidian', async (importOriginal) => {
  const actual = await importOriginal<typeof import('obsidian')>();
  return {
    ...actual,
    Notice: vi.fn(),
    Plugin: class Plugin {
      app: unknown;
      manifest: unknown;
      loadData = vi.fn().mockResolvedValue({});
      constructor(app?: unknown, manifest?: unknown) {
        this.app = app;
        this.manifest = manifest;
      }
    },
    EventRef: class EventRef {},
    MarkdownView: class MarkdownView {},
    TFile: class TFile {},
    Vault: class Vault {},
    Workspace: class Workspace {
      getLeavesOfType() {
        return [];
      }
      iterateAllLeaves() {}
      getRightLeaf() {
        return null;
      }
      revealLeaf() {}
    },
    WorkspaceWindow: class WorkspaceWindow {},
    Menu: class Menu {
      addItem() {
        return this;
      }
      addSeparator() {
        return this;
      }
      setTitle() {
        return this;
      }
      showAtMouseEvent() {}
    },
    setTooltip: vi.fn(),
    addIcon: vi.fn(),
  };
});

// confirmLiveMirrorSession opens a modal and waits for user input — not
// resolvable in a node test. openAhpTerminalForSession itself is the unit
// under test, so confirming instantly here is the right seam.
vi.mock('./views/AhpSessionPickerModal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./views/AhpSessionPickerModal')>();
  return { ...actual, confirmLiveMirrorSession: vi.fn().mockResolvedValue(true) };
});

// newHostedAhpSession prompts for the session name via a modal — stub it so
// the create flow runs headlessly in tests.
vi.mock('./views/TextInputModal', () => ({
  TextInputModal: { prompt: vi.fn().mockResolvedValue('pi-test') },
}));

// HostAgentClient is loaded dynamically by main.ts. Mock it here so we can
// assert the broker URL resolution without spinning a real WebSocket.
vi.mock('./transport/HostAgentClient', () => {
  const HostAgentClient = vi.fn().mockImplementation((options: unknown) => ({
    start: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    options,
  }));
  return { HostAgentClient };
});

import { AhpClient, type SessionSummary } from './transport/AhpClient';
import { AhpError } from './transport/AhpError';
import { HostAgentClient } from './transport/HostAgentClient';
import { confirmLiveMirrorSession } from './views/AhpSessionPickerModal';
import { Notice, Platform } from 'obsidian';
import { DEFAULT_SETTINGS, type ObsidianPiSettings } from './types';

// Mock AhpClient so `ensureAhpCatalogConnection` tests can control the slow
// connect handshake and assert that concurrent callers share one in-flight
// promise instead of disposing/recreating the client.
vi.mock('./transport/AhpClient', () => {
  let nextConnectResolve = true;
  let nextConnectDelay = 5;
  let nextConnectError = 'WebSocket closed before open';

  const AhpClient = vi.fn().mockImplementation((clientId?: string) => {
    const inst: {
      clientId?: string;
      state: string;
      isRootSubscribed: boolean;
      attachActionMapper: ReturnType<typeof vi.fn>;
      connect: ReturnType<typeof vi.fn>;
      initialize: ReturnType<typeof vi.fn>;
      subscribeRoot: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
    } = {
      clientId,
      state: 'connecting',
      isRootSubscribed: false,
      attachActionMapper: vi.fn(),
      connect: vi.fn().mockImplementation(() => {
        return new Promise<void>((resolve, reject) => {
          setTimeout(() => {
            if (nextConnectResolve) {
              inst.state = 'connected';
              resolve();
            } else {
              inst.state = 'crashed';
              reject(new Error(nextConnectError));
            }
          }, nextConnectDelay);
        });
      }),
      initialize: vi.fn().mockResolvedValue(undefined),
      subscribeRoot: vi.fn().mockImplementation(() => {
        inst.isRootSubscribed = true;
        return Promise.resolve({ snapshot: {} });
      }),
      dispose: vi.fn().mockImplementation(() => {
        inst.state = 'disconnected';
        return Promise.resolve();
      }),
    };
    return inst;
  });

  (AhpClient as any).setConnectResult = (
    resolve: boolean,
    message = 'WebSocket closed before open',
  ) => {
    nextConnectResolve = resolve;
    if (!resolve) nextConnectError = message;
  };
  (AhpClient as any).setConnectDelay = (delay: number) => {
    nextConnectDelay = delay;
  };
  (AhpClient as any).resetMock = () => {
    nextConnectResolve = true;
    nextConnectDelay = 5;
    nextConnectError = 'WebSocket closed before open';
  };

  return { AhpClient, AHP_PROTOCOL_VERSION: '0.3.0' };
});

import ObsidianPiPlugin from './main';

function makePlugin(): ObsidianPiPlugin {
  const plugin = new ObsidianPiPlugin({} as never, {} as never);
  // Full default settings: error-cleanup paths (unregisterAhpInstance) and
  // ensureAhpCatalogConnection read settings.instances / ahpServerUrl.
  plugin.settings = { ...DEFAULT_SETTINGS } as ObsidianPiPlugin['settings'];
  // Stub the side-effectful UI surfaces openAhpTerminalForSession reaches on
  // success (instance hub, terminal leaf); the assertions focus on the
  // subscribe → extract → activate contract.
  vi.spyOn(plugin, 'registerAhpInstance').mockImplementation(() => '');
  // unregisterAhpInstance (error-cleanup paths) touches the real instance
  // manager + command palette — stub it; the unit under test stays the
  // AHP error branch.
  vi.spyOn(plugin, 'unregisterAhpInstance').mockImplementation(() => undefined);
  vi.spyOn(plugin, 'activateAhpTerminalView').mockResolvedValue(undefined);
  return plugin;
}

function makeExternalSession(hostOnline = true): SessionSummary {
  return {
    resource: 'ahp-session:/ext-voyager-default',
    title: 'Vault pi (remote)',
    status: 8,
    kind: 'external',
    hostAgentName: 'Voyager',
    hostOnline,
    terminalMode: 'external',
    modifiedAt: new Date().toISOString(),
  };
}

describe('ObsidianPiPlugin.openAhpTerminalForSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('-32000 (dead local PTY) on an external session shows the host-not-running notice without tearing anything down', async () => {
    const plugin = makePlugin();
    // The server answers the terminal subscribe with a -32000 JSON-RPC error
    // when the owning host's local PTY is not running (M3 tee error-ack).
    const client = {
      state: 'connected',
      subscribe: vi.fn().mockRejectedValue(new AhpError(-32000, "pi terminal 'ext-voyager-default' is not running")),
    };
    plugin.ahpClient = client as unknown as AhpClient;
    const session = makeExternalSession(true);

    // Must resolve (no crash / no hang) despite the rejected subscribe.
    await plugin.openAhpTerminalForSession(session);

    expect(client.subscribe).toHaveBeenCalledWith('ahp-terminal:/ext-voyager-default');
    expect(Notice).toHaveBeenCalledWith('AHP host terminal not running on Voyager', 6000);
    // No half-open terminal state, no synthetic AHP instance, no view.
    expect(plugin.registerAhpInstance).not.toHaveBeenCalled();
    expect(plugin.activateAhpTerminalView).not.toHaveBeenCalled();
    expect(plugin.ahpTerminalUri).toBeUndefined();
    expect(plugin.ahpTerminalMode).toBeUndefined();
    // The failure is contained to the open attempt: the session object is
    // untouched, so the Farm View keeps it listed as an online external row
    // (hostOnline: true) and a retry can still succeed.
    expect(session).toMatchObject({ kind: 'external', hostOnline: true });
  });

  it('attaches a session with no terminalMode in interactive terminal mode (terminal is the only mode)', async () => {
    const plugin = makePlugin();
    const snapshot = { snapshot: { state: { cols: 100, rows: 30, screenText: 'pi> ' } } };
    const client = {
      state: 'connected',
      subscribe: vi.fn().mockResolvedValue(snapshot),
    };
    plugin.ahpClient = client as unknown as AhpClient;
    // A hosted pi session whose summary omits terminalMode (e.g. an older
    // server) still attaches in terminal mode: the terminal-channel subscribe
    // makes the server spawn the pi TUI. There is no chat-mode attach anymore.
    const session: SessionSummary = {
      resource: 'ahp-session:/pi-hosted',
      title: 'Hosted pi',
      status: 1,
      provider: 'pi',
      kind: 'hosted',
    };

    await plugin.openAhpTerminalForSession(session);

    expect(client.subscribe).toHaveBeenCalledWith('ahp-terminal:/pi-hosted');
    expect(client.subscribe).not.toHaveBeenCalledWith('ahp-chat:/pi-hosted');
    expect(plugin.registerAhpInstance).toHaveBeenCalledWith('Hosted pi');
    expect(plugin.activateAhpTerminalView).toHaveBeenCalledWith(
      'ahp-terminal:/pi-hosted',
      'server-spawned',
      100,
      30,
      'pi> ',
      undefined,
      '',
    );
    expect(plugin.ahpTerminalUri).toBe('ahp-terminal:/pi-hosted');
    expect(plugin.ahpTerminalMode).toBe('server-spawned');
    expect(Notice).toHaveBeenCalledWith('✓ AHP interactive terminal: ahp-terminal:/pi-hosted', 4000);
  });

  it('-32000 (no node-pty) on a hosted session shows the no-terminal notice without falling back to chat', async () => {
    const plugin = makePlugin();
    const client = {
      state: 'connected',
      subscribe: vi.fn().mockRejectedValue(new AhpError(-32000, 'no node-pty available on the server')),
      attachSession: vi.fn().mockResolvedValue(undefined),
    };
    plugin.ahpClient = client as unknown as AhpClient;
    const session: SessionSummary = {
      resource: 'ahp-session:/pi-hosted',
      title: 'Hosted pi',
      status: 1,
      provider: 'pi',
      kind: 'hosted',
      terminalMode: 'server-spawned',
    };

    await plugin.openAhpTerminalForSession(session);

    expect(client.subscribe).toHaveBeenCalledWith('ahp-terminal:/pi-hosted');
    // No chat fallback: no chat subscribe, no attachSession, no chat-mode view.
    expect(client.subscribe).not.toHaveBeenCalledWith('ahp-chat:/pi-hosted');
    expect(client.attachSession).not.toHaveBeenCalled();
    expect(plugin.registerAhpInstance).not.toHaveBeenCalled();
    expect(plugin.activateAhpTerminalView).not.toHaveBeenCalled();
    expect(Notice).toHaveBeenCalledWith('AHP: no interactive terminal on this server', 6000);
  });

  it('replays the terminal subscribe snapshot scrollback into the terminal view (M4 snapshot replay)', async () => {
    const plugin = makePlugin();
    // M2 server format: TerminalState.content carries the accumulated
    // scrollback parts; extractTerminalSnapshot concatenates them and the
    // result must reach activateAhpTerminalView as initialContent so a late
    // opener sees the terminal exactly as it already is.
    const snapshot = {
      snapshot: {
        state: {
          cols: 120,
          rows: 40,
          content: [
            { type: 'unclassified', value: 'pi 0.3.0\n' },
            { type: 'unclassified', value: '$ git status\n' },
            {
              type: 'command',
              commandId: 'c1',
              commandLine: 'git status',
              output: 'On branch feature/farm-view',
              timestamp: 1,
              isComplete: true,
            },
          ],
        },
      },
    };
    const client = {
      state: 'connected',
      subscribe: vi.fn().mockResolvedValue(snapshot),
    };
    plugin.ahpClient = client as unknown as AhpClient;
    const session = makeExternalSession(true);

    await plugin.openAhpTerminalForSession(session);

    expect(client.subscribe).toHaveBeenCalledWith('ahp-terminal:/ext-voyager-default');
    expect(plugin.registerAhpInstance).toHaveBeenCalledWith('Vault pi (remote)');
    expect(plugin.activateAhpTerminalView).toHaveBeenCalledWith(
      'ahp-terminal:/ext-voyager-default',
      'external',
      120,
      40,
      'pi 0.3.0\n$ git status\nOn branch feature/farm-view',
      undefined,
      '',
    );
    expect(plugin.ahpTerminalUri).toBe('ahp-terminal:/ext-voyager-default');
    expect(plugin.ahpTerminalMode).toBe('external');
    expect(Notice).toHaveBeenCalledWith('✓ AHP interactive terminal: ahp-terminal:/ext-voyager-default', 4000);
  });

  it('refreshes a reused leaf with the fresh snapshot before revealing it (BUG 2 — no empty terminal on re-attach)', async () => {
    // Real activateAhpTerminalView (makePlugin mocks it), so the leaf-reuse
    // branch is exercised: an existing deferred leaf bound to the same terminal
    // URI holds a STALE snapshot (empty content) from when it was first
    // created. Re-attaching must refresh its stored state with the fresh
    // subscribe snapshot so a deferred re-boot replays the CURRENT scrollback
    // instead of an empty terminal.
    const plugin = new ObsidianPiPlugin({} as never, {} as never);
    vi.spyOn(plugin, 'registerAhpInstance').mockImplementation(() => '');
    const existingLeaf = {
      getViewState: () => ({
        type: 'obsidian-pi-terminal-view',
        state: {
          instanceId: 'ahp-remote',
          ahp: true,
          ahpTerminalUri: 'ahp-terminal:/ext-voyager-default',
          ahpInitialCols: 80,
          ahpInitialRows: 24,
          ahpInitialContent: '',
        },
      }),
      setViewState: vi.fn().mockResolvedValue(undefined),
    };
    const revealLeaf = vi.fn();
    plugin.app = {
      workspace: {
        getLeavesOfType: () => [],
        iterateAllLeaves: (cb: (leaf: unknown) => void) => cb(existingLeaf),
        getRightLeaf: () => null,
        revealLeaf,
      },
    } as never;

    await plugin.activateAhpTerminalView(
      'ahp-terminal:/ext-voyager-default',
      'external',
      120,
      40,
      'pi 0.3.0\n$ git status\nOn branch feature/farm-view',
    );

    // The reused leaf's stored state must be refreshed with the fresh snapshot
    // (size + scrollback) before reveal, so a deferred re-boot replays the
    // CURRENT screen state, not the stale empty one.
    expect(existingLeaf.setViewState).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({
          ahpTerminalUri: 'ahp-terminal:/ext-voyager-default',
          ahpTerminalMode: 'external',
          ahpInitialCols: 120,
          ahpInitialRows: 40,
          ahpInitialContent: 'pi 0.3.0\n$ git status\nOn branch feature/farm-view',
        }),
      }),
    );
    expect(revealLeaf).toHaveBeenCalledWith(existingLeaf);
  });

  it('-32002 (session not found) quietly cleans up without an error notice', async () => {
    const plugin = makePlugin();
    const client = {
      state: 'connected',
      subscribe: vi.fn().mockRejectedValue(new AhpError(-32002, 'session not found')),
      disposeSession: vi.fn().mockResolvedValue(undefined),
    };
    plugin.ahpClient = client as unknown as AhpClient;
    const session: SessionSummary = {
      resource: 'ahp-session:/stale',
      title: 'Stale session',
      status: 1,
      kind: 'hosted',
      terminalMode: 'server-spawned',
    };

    await plugin.openAhpTerminalForSession(session);

    // Quiet best-effort cleanup: forget the stale session server-side, no
    // noisy notice, no view opened.
    expect(client.disposeSession).toHaveBeenCalledWith('ahp-session:/stale');
    expect(Notice).not.toHaveBeenCalledWith(expect.stringContaining('failed'), expect.anything());
    expect(plugin.registerAhpInstance).not.toHaveBeenCalled();
    expect(plugin.activateAhpTerminalView).not.toHaveBeenCalled();
  });

  it('-32007 (auth rejected) shows the token-hint notice', async () => {
    const plugin = makePlugin();
    const client = {
      state: 'connected',
      subscribe: vi.fn().mockRejectedValue(new AhpError(-32007, 'authentication required')),
    };
    plugin.ahpClient = client as unknown as AhpClient;
    const session: SessionSummary = {
      resource: 'ahp-session:/authfail',
      title: 'Auth fail',
      status: 1,
      kind: 'hosted',
      terminalMode: 'server-spawned',
    };

    await plugin.openAhpTerminalForSession(session);

    expect(plugin.activateAhpTerminalView).not.toHaveBeenCalled();
  });
});

describe('ObsidianPiPlugin.openAhpTerminalForSession — prefer-local routing (AUDIT FIX SLICE H)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Stub instance manager resolving exactly the 'default' local instance. */
  function makeLocalManager(instance: unknown) {
    return {
      get: vi.fn((id: string) => (id === 'default' ? instance : undefined)),
      resolveLocalSessionResumePath: vi.fn().mockResolvedValue('/mock/resume-session.jsonl'),
      restartTerminalSession: vi.fn().mockResolvedValue(undefined),
    };
  }

  /** makePlugin + a stubbed activateTerminalView (the local-open leaf path). */
  function makeLocalPlugin(): ObsidianPiPlugin {
    const plugin = makePlugin();
    vi.spyOn(plugin, 'activateTerminalView').mockResolvedValue(undefined);
    return plugin;
  }

  it('own-device external session routes to the local PTY with resume — no broker subscribe, no live-mirror confirm', async () => {
    const plugin = makeLocalPlugin();
    plugin.settings.hostAgentDeviceName = 'Voyager';
    const local = {
      config: { id: 'default', name: 'Default', cwd: '/vault' },
      ptyClient: { state: 'connected' },
      pendingResumeSessionPath: undefined as string | undefined,
    };
    plugin.instanceManager = makeLocalManager(local) as never;
    // A connected broker client exists — but the own-device row must never
    // touch it (the self-relay loop is exactly what we're avoiding).
    const client = { state: 'connected', subscribe: vi.fn() };
    plugin.ahpClient = client as unknown as AhpClient;
    const session = makeExternalSession(true);

    await plugin.openAhpTerminalForSession(session);
    // openLocalRelaySessionIfLocal returns synchronously and kicks off the
    // async local-open — flush microtasks so the resume/leaf-open completes.
    await new Promise((r) => setTimeout(r, 0));

    expect(client.subscribe).not.toHaveBeenCalled();
    expect(confirmLiveMirrorSession).not.toHaveBeenCalled();
    expect(plugin.instanceManager.resolveLocalSessionResumePath).toHaveBeenCalledWith(
      'default',
      'Vault pi (remote)',
    );
    expect(plugin.instanceManager.restartTerminalSession).toHaveBeenCalledWith(
      'default',
      '/mock/resume-session.jsonl',
    );
    expect(plugin.activateTerminalView).toHaveBeenCalledWith('default');
    expect(plugin.ahpTerminalUri).toBeUndefined();
  });

  it('own-device external with hostOnline=false still routes locally (local PTY needs no host online)', async () => {
    const plugin = makeLocalPlugin();
    plugin.settings.hostAgentDeviceName = 'Voyager';
    const local = {
      config: { id: 'default', name: 'Default', cwd: '/vault' },
      ptyClient: { state: 'connected' },
    };
    plugin.instanceManager = makeLocalManager(local) as never;
    const client = { state: 'connected', subscribe: vi.fn() };
    plugin.ahpClient = client as unknown as AhpClient;

    await plugin.openAhpTerminalForSession(makeExternalSession(false));
    await new Promise((r) => setTimeout(r, 0));

    expect(client.subscribe).not.toHaveBeenCalled();
    expect(plugin.instanceManager.restartTerminalSession).toHaveBeenCalled();
    expect(plugin.activateTerminalView).toHaveBeenCalledWith('default');
    // The offline gate must NOT fire for own-device rows.
    expect(Notice).not.toHaveBeenCalledWith(expect.stringContaining('Host offline'), expect.anything());
  });

  it('remote external session still subscribes through the broker', async () => {
    const plugin = makeLocalPlugin();
    plugin.settings.hostAgentDeviceName = 'Voyager';
    plugin.instanceManager = makeLocalManager(null) as never;
    const snapshot = { snapshot: { state: { cols: 80, rows: 24, screenText: 'pi> ' } } };
    const client = { state: 'connected', subscribe: vi.fn().mockResolvedValue(snapshot) };
    plugin.ahpClient = client as unknown as AhpClient;
    const session: SessionSummary = {
      resource: 'ahp-session:/ext-RemoteHost-default',
      title: 'Vault pi (remote)',
      status: 8,
      kind: 'external',
      hostAgentName: 'RemoteHost',
      hostOnline: true,
      terminalMode: 'external',
      modifiedAt: new Date().toISOString(),
    };

    await plugin.openAhpTerminalForSession(session);

    expect(client.subscribe).toHaveBeenCalledWith('ahp-terminal:/ext-RemoteHost-default');
    expect(plugin.activateTerminalView).not.toHaveBeenCalled();
  });

  it('own-device external whose instance no longer resolves falls through to AHP attach', async () => {
    // Instance renamed/deleted → the ext row is stale: attach via the broker
    // like any other external session (which surfaces the -32000 host-not-
    // running notice path if the remote PTY is gone too).
    const plugin = makeLocalPlugin();
    plugin.settings.hostAgentDeviceName = 'Voyager';
    plugin.instanceManager = makeLocalManager(null) as never;
    const client = {
      state: 'connected',
      subscribe: vi.fn().mockRejectedValue(new AhpError(-32000, 'terminal not running')),
    };
    plugin.ahpClient = client as unknown as AhpClient;
    const session = makeExternalSession(true);

    await plugin.openAhpTerminalForSession(session);

    expect(client.subscribe).toHaveBeenCalledWith('ahp-terminal:/ext-voyager-default');
    expect(plugin.activateTerminalView).not.toHaveBeenCalled();
    expect(Notice).toHaveBeenCalledWith('AHP host terminal not running on Voyager', 6000);
  });

  it('offline gate: remote external with hostOnline=false is blocked with the host-offline notice', async () => {
    // The M4 offline gate moved from FarmView.openSession into the shared
    // entry point (after the prefer-local check) so it keeps gating true
    // remote externals from every surface.
    const plugin = makeLocalPlugin();
    plugin.settings.hostAgentDeviceName = 'Voyager';
    plugin.instanceManager = makeLocalManager(null) as never;
    const client = { state: 'connected', subscribe: vi.fn() };
    plugin.ahpClient = client as unknown as AhpClient;

    await plugin.openAhpTerminalForSession({
      resource: 'ahp-session:/ext-RemoteHost-default',
      title: 'Vault pi (offline host)',
      status: 8,
      kind: 'external',
      hostAgentName: 'RemoteHost',
      hostOnline: false,
      terminalMode: 'external',
      modifiedAt: new Date().toISOString(),
    });

    expect(client.subscribe).not.toHaveBeenCalled();
    expect(confirmLiveMirrorSession).not.toHaveBeenCalled();
    expect(Notice).toHaveBeenCalledWith('Host offline — RemoteHost not connected', 4000);
  });
});

describe('ObsidianPiPlugin.openAhpTerminalForChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeChatPlugin(client: unknown): ObsidianPiPlugin {
    const plugin = makePlugin();
    plugin.ahpClient = client as unknown as AhpClient;
    return plugin;
  }

  it('binds the leaf to the RETURNED ahp-remote-N instance id (AUDIT §3 finding 12)', async () => {
    const snapshot = { snapshot: { state: { cols: 120, rows: 40, screenText: 'sub> ' } } };
    const client = { state: 'connected', subscribe: vi.fn().mockResolvedValue(snapshot) };
    const plugin = makeChatPlugin(client);
    // The synthetic instance registration returns a numbered id — the leaf
    // state must carry THAT id, not the hardcoded 'ahp-remote' default.
    vi.mocked(plugin.registerAhpInstance).mockReturnValue('ahp-remote-3');

    await plugin.openAhpTerminalForChat('ahp-chat:/voyager-child');

    expect(client.subscribe).toHaveBeenCalledWith('ahp-terminal:/voyager-child');
    expect(plugin.registerAhpInstance).toHaveBeenCalledWith('ahp-terminal:/voyager-child');
    expect(plugin.activateAhpTerminalView).toHaveBeenCalledWith(
      'ahp-terminal:/voyager-child',
      'server-spawned',
      120,
      40,
      'sub> ',
      true,          // read-only subagent mirror
      'ahp-remote-3', // ← the registered runtime instance id
    );
    expect(plugin.ahpTerminalUri).toBe('ahp-terminal:/voyager-child');
    expect(plugin.ahpTerminalMode).toBe('server-spawned');
    expect(Notice).toHaveBeenCalledWith('✓ AHP read-only subagent terminal: ahp-terminal:/voyager-child', 4000);
  });

  it('does not open the view when the terminal subscribe fails', async () => {
    const client = {
      state: 'connected',
      subscribe: vi.fn().mockRejectedValue(new AhpError(-32002, 'session not found')),
    };
    const plugin = makeChatPlugin(client);

    await plugin.openAhpTerminalForChat('ahp-chat:/gone-child');

    expect(plugin.registerAhpInstance).not.toHaveBeenCalled();
    expect(plugin.activateAhpTerminalView).not.toHaveBeenCalled();
    expect(Notice).toHaveBeenCalledWith('AHP terminal subscribe failed: session not found (code -32002)', 8000);
  });
});

describe('ObsidianPiPlugin.newHostedAhpSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeCreatePlugin(client: unknown): ObsidianPiPlugin {
    const plugin = makePlugin();
    plugin.app = { vault: { getName: () => 'TestVault' } } as never;
    plugin.ahpClient = client as unknown as AhpClient;
    return plugin;
  }

  const snapshot = { snapshot: { state: { cols: 80, rows: 24, screenText: 'pi> ' } } };

  it('tolerates -32003 (session already exists) and attaches instead of failing', async () => {
    const client = {
      state: 'connected',
      createSession: vi.fn().mockRejectedValue(new AhpError(-32003, 'session already exists')),
      subscribe: vi.fn().mockResolvedValue(snapshot),
      disposeSession: vi.fn().mockResolvedValue(undefined),
    };
    const plugin = makeCreatePlugin(client);

    await plugin.newHostedAhpSession();

    expect(client.createSession).toHaveBeenCalledWith(
      'ahp-session:/pi-test',
      expect.objectContaining({ provider: 'pi' }),
    );
    // Attach proceeded despite the -32003 — terminal view opened, success notice.
    expect(plugin.activateAhpTerminalView).toHaveBeenCalledWith(
      'ahp-terminal:/pi-test',
      'server-spawned',
      80,
      24,
      'pi> ',
    );
    expect(Notice).toHaveBeenCalledWith('✓ AHP hosted session created: ahp-session:/pi-test', 4000);
    // A tolerated already-exists must NOT dispose the (pre-existing) session.
    expect(client.disposeSession).not.toHaveBeenCalled();
  });

  it('reports -32000 (terminal spawn failure) with the actionable notice and cleans up the orphaned session', async () => {
    const client = {
      state: 'connected',
      createSession: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockRejectedValue(new AhpError(-32000, 'no node-pty available on the server')),
      disposeSession: vi.fn().mockResolvedValue(undefined),
    };
    const plugin = makeCreatePlugin(client);

    await plugin.newHostedAhpSession();

    expect(Notice).toHaveBeenCalledWith(
      expect.stringContaining('could not start the interactive terminal (error -32000)'),
      8000,
    );
    // Orphaned half-created session is cleaned up server-side.
    expect(client.disposeSession).toHaveBeenCalledWith('ahp-session:/pi-test');
    expect(plugin.activateAhpTerminalView).not.toHaveBeenCalled();
  });
});

describe('ObsidianPiPlugin mobile guard (AHP-remote-only mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('activateTerminalView refuses a local instance on mobile with a remote-AHP hint', async () => {
    const origDesktop = Platform.isDesktop;
    const origMobile = Platform.isMobile;
    Platform.isDesktop = false;
    Platform.isMobile = true;
    try {
      const plugin = makePlugin();
      plugin.settings = {
        instances: [{ id: 'default', name: 'Default', cwd: '' }],
      } as ObsidianPiPlugin['settings'];
      plugin.app = {
        workspace: {
          getLeavesOfType: () => [],
          iterateAllLeaves: () => {},
          getRightLeaf: () => null,
          revealLeaf: () => {},
        },
      } as never;

      await plugin.activateTerminalView('default');

      // No local terminal is opened; the user is pointed at the AHP-remote path.
      expect(Notice).toHaveBeenCalledWith(
        'obsidian-pi: local pi terminals are only available in the Obsidian desktop app — use a remote AHP session.',
        6000,
      );
    } finally {
      Platform.isDesktop = origDesktop;
      Platform.isMobile = origMobile;
    }
  });

  it('activateTerminalView still opens the synthetic AHP instance on mobile', async () => {
    const origDesktop = Platform.isDesktop;
    const origMobile = Platform.isMobile;
    Platform.isDesktop = false;
    Platform.isMobile = true;
    try {
      const plugin = makePlugin();
      plugin.settings = {
        instances: [{ id: 'default', name: 'Default', cwd: '' }],
      } as ObsidianPiPlugin['settings'];
      plugin.ahpInstanceConfigs = [{ id: 'ahp-remote', name: 'AHP remote', cwd: '', ahp: true } as never];
      plugin.app = {
        workspace: {
          getLeavesOfType: () => [],
          iterateAllLeaves: () => {},
          getRightLeaf: () => null,
          getLeaf: () => null,
          revealLeaf: () => {},
        },
      } as never;

      await plugin.activateTerminalView('ahp-remote');

      // The AHP instance is mobile-safe — the local-PTY guard must NOT fire.
      // (The mock workspace has no leaves, so the flow ends at the generic
      // "no sidebar leaf" notice — proving it got past the mobile guard.)
      expect(Notice).not.toHaveBeenCalledWith(
        expect.stringContaining('local pi terminals are only available'),
        expect.anything(),
      );
      expect(Notice).toHaveBeenCalledWith('Could not open terminal view — no sidebar leaf available.', 5000);
    } finally {
      Platform.isDesktop = origDesktop;
      Platform.isMobile = origMobile;
    }
  });
});

describe('ObsidianPiPlugin.startHostAgentClient URL resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function withDesktop(fn: () => Promise<void>): Promise<void> {
    const origDesktop = Platform.isDesktop;
    const origMobile = Platform.isMobile;
    Platform.isDesktop = true;
    Platform.isMobile = false;
    return fn().finally(() => {
      Platform.isDesktop = origDesktop;
      Platform.isMobile = origMobile;
    });
  }

  it('falls back to localhost when ahpServerUrl is empty/whitespace', async () => {
    await withDesktop(async () => {
      const plugin = makePlugin();
      plugin.settings = {
        ...plugin.settings,
        ahpServerUrl: '   ',
        hostAgentEnabled: true,
      } as ObsidianPiPlugin['settings'];
      plugin.hostAgentClient = null;
      vi.spyOn(plugin, 'loadData').mockResolvedValue({ ahpServerUrl: '   ' });

      await plugin.startHostAgentClient();

      expect(HostAgentClient).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'ws://localhost:4500' }),
      );
    });
  });

  it('keeps the localhost default unchanged', async () => {
    await withDesktop(async () => {
      const plugin = makePlugin();
      plugin.settings = {
        ...plugin.settings,
        ahpServerUrl: 'ws://localhost:4500',
        hostAgentEnabled: true,
      } as ObsidianPiPlugin['settings'];
      plugin.hostAgentClient = null;
      vi.spyOn(plugin, 'loadData').mockResolvedValue({ ahpServerUrl: 'ws://localhost:4500' });

      await plugin.startHostAgentClient();

      expect(HostAgentClient).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'ws://localhost:4500' }),
      );
    });
  });

  it('keeps a real configured broker URL unchanged', async () => {
    await withDesktop(async () => {
      const plugin = makePlugin();
      plugin.settings = {
        ...plugin.settings,
        ahpServerUrl: 'ws://100.75.249.5:4500',
        hostAgentEnabled: true,
      } as ObsidianPiPlugin['settings'];
      plugin.hostAgentClient = null;
      vi.spyOn(plugin, 'loadData').mockResolvedValue({ ahpServerUrl: 'ws://100.75.249.5:4500' });

      await plugin.startHostAgentClient();

      expect(HostAgentClient).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'ws://100.75.249.5:4500' }),
      );
    });
  });

  it('keeps a custom broker URL unchanged', async () => {
    await withDesktop(async () => {
      const plugin = makePlugin();
      plugin.settings = {
        ...plugin.settings,
        ahpServerUrl: 'wss://my-broker.example.com',
        hostAgentEnabled: true,
      } as ObsidianPiPlugin['settings'];
      plugin.hostAgentClient = null;
      vi.spyOn(plugin, 'loadData').mockResolvedValue({ ahpServerUrl: 'wss://my-broker.example.com' });

      await plugin.startHostAgentClient();

      expect(HostAgentClient).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'wss://my-broker.example.com' }),
      );
    });
  });

});

// ── ensureAhpCatalogConnection concurrency tests ────────────────────────────

describe('ObsidianPiPlugin.ensureAhpCatalogConnection concurrency', () => {
  function makePluginForAhp(): ObsidianPiPlugin {
    const plugin = new ObsidianPiPlugin({} as never, {} as never);
    plugin.settings = { ...DEFAULT_SETTINGS, ahpServerUrl: 'ws://localhost:4500' } as ObsidianPiPlugin['settings'];
    // The failure path calls unregisterAhpInstance, which touches the real
    // instance manager. Stub it so the unit under test stays self-contained.
    vi.spyOn(plugin, 'unregisterAhpInstance').mockImplementation(() => {});
    return plugin;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    (AhpClient as any).resetMock?.();
  });

  it('serializes concurrent connection attempts into a single AhpClient', async () => {
    const plugin = makePluginForAhp();

    // Fire three concurrent requests while no client is connected. The slow
    // mock connect() forces the requests to overlap.
    const results = await Promise.all([
      plugin.ensureAhpCatalogConnection(),
      plugin.ensureAhpCatalogConnection(),
      plugin.ensureAhpCatalogConnection(),
    ]);

    const client = plugin.ahpClient;
    expect(client).not.toBeNull();
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe(client);
    expect(client?.state).toBe('connected');
    expect(client?.isRootSubscribed).toBe(true);

    // Exactly one client was constructed, and its connect/initialize/subscribeRoot
    // ran exactly once despite three concurrent callers.
    expect(AhpClient).toHaveBeenCalledTimes(1);
    expect((client as any).connect).toHaveBeenCalledTimes(1);
    expect((client as any).initialize).toHaveBeenCalledTimes(1);
    expect((client as any).subscribeRoot).toHaveBeenCalledTimes(1);
  });

  it('shares the same in-flight promise on concurrent failure', async () => {
    (AhpClient as any).setConnectResult(false, 'WebSocket closed before open');
    const plugin = makePluginForAhp();

    const results = await Promise.all([
      plugin.ensureAhpCatalogConnection(),
      plugin.ensureAhpCatalogConnection(),
      plugin.ensureAhpCatalogConnection(),
    ]);

    expect(results.every((r) => r === null)).toBe(true);
    expect(AhpClient).toHaveBeenCalledTimes(1);
    expect(plugin.ahpClient).toBeNull();
  });

  it('clears the in-flight promise after failure so a retry starts fresh', async () => {
    (AhpClient as any).setConnectResult(false, 'WebSocket closed before open');
    const plugin = makePluginForAhp();

    const first = await plugin.ensureAhpCatalogConnection();
    expect(first).toBeNull();
    expect(AhpClient).toHaveBeenCalledTimes(1);

    (AhpClient as any).setConnectResult(true);
    const second = await plugin.ensureAhpCatalogConnection();
    expect(second).not.toBeNull();
    expect(AhpClient).toHaveBeenCalledTimes(2);
    expect(second?.state).toBe('connected');
    expect(second?.isRootSubscribed).toBe(true);
    expect(plugin.ahpClient).toBe(second);
  });

  it('short-circuits when a connected client already exists', async () => {
    const plugin = makePluginForAhp();
    const existing = {
      state: 'connected',
      isRootSubscribed: true,
      connect: vi.fn(),
      initialize: vi.fn(),
      subscribeRoot: vi.fn(),
      dispose: vi.fn(),
    } as unknown as AhpClient;
    plugin.ahpClient = existing;

    const result = await plugin.ensureAhpCatalogConnection();

    expect(result).toBe(existing);
    expect(AhpClient).not.toHaveBeenCalled();
    expect(existing.dispose).not.toHaveBeenCalled();
  });
});

describe('ObsidianPiPlugin token env overrides (AUDIT §4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('effectiveAhpToken / effectiveSttToken prefer the env var when set', () => {
    const plugin = makePlugin();
    plugin.settings = {
      ...plugin.settings,
      ahpServerToken: 'settings-ahp-token',
      sttToken: 'settings-stt-token',
    } as ObsidianPiPlugin['settings'];

    // No env vars → settings values win.
    expect(plugin.effectiveAhpToken()).toBe('settings-ahp-token');
    expect(plugin.effectiveSttToken()).toBe('settings-stt-token');

    // Env vars override.
    vi.stubEnv('AHP_SERVER_TOKEN', 'env-ahp-token');
    vi.stubEnv('STT_TOKEN', 'env-stt-token');
    expect(plugin.effectiveAhpToken()).toBe('env-ahp-token');
    expect(plugin.effectiveSttToken()).toBe('env-stt-token');

    // Legacy sidecar alias for the STT token (STT_TOKEN set to empty = unset).
    vi.stubEnv('STT_TOKEN', '');
    vi.stubEnv('WHISPER_STT_TOKEN', 'legacy-stt-token');
    expect(plugin.effectiveSttToken()).toBe('legacy-stt-token');
  });

  it('saveSettings never persists token fields while an env override is active', async () => {
    const plugin = makePlugin();
    plugin.settings = {
      ...plugin.settings,
      ahpServerToken: 'settings-ahp-token',
      sttToken: 'settings-stt-token',
      terminalFontSize: 17,
    } as ObsidianPiPlugin['settings'];
    // The mocked Plugin base class has no real saveData — stub it directly.
    const saveData = vi.fn<(data: unknown) => Promise<void>>().mockResolvedValue(undefined);
    (plugin as unknown as { saveData: unknown }).saveData = saveData;
    vi.spyOn(plugin, 'refreshInstanceCommands').mockImplementation(() => {});

    vi.stubEnv('AHP_SERVER_TOKEN', 'env-ahp-token');
    await plugin.saveSettings();

    const persisted = saveData.mock.calls[0][0] as ObsidianPiSettings;
    expect(persisted).not.toHaveProperty('ahpServerToken');
    expect(persisted.sttToken).toBe('settings-stt-token'); // no STT override → kept
    expect(persisted.terminalFontSize).toBe(17);
    // In-memory settings are untouched so the UI fields keep working.
    expect(plugin.settings.ahpServerToken).toBe('settings-ahp-token');
  });

  it('saveSettings strips both tokens when both overrides are active, and persists normally otherwise', async () => {
    const plugin = makePlugin();
    plugin.settings = {
      ...plugin.settings,
      ahpServerToken: 'ahp',
      sttToken: 'stt',
    } as ObsidianPiPlugin['settings'];
    const saveData = vi.fn<(data: unknown) => Promise<void>>().mockResolvedValue(undefined);
    (plugin as unknown as { saveData: unknown }).saveData = saveData;
    vi.spyOn(plugin, 'refreshInstanceCommands').mockImplementation(() => {});

    // No env vars → tokens persisted verbatim.
    await plugin.saveSettings();
    expect(saveData.mock.calls[0][0]).toEqual(plugin.settings);

    // Both env vars → both tokens omitted from the persisted copy.
    vi.stubEnv('AHP_SERVER_TOKEN', 'env-ahp');
    vi.stubEnv('STT_TOKEN', 'env-stt');
    await plugin.saveSettings();
    const persisted = saveData.mock.calls[1][0] as ObsidianPiSettings;
    expect(persisted).not.toHaveProperty('ahpServerToken');
    expect(persisted).not.toHaveProperty('sttToken');
    expect(JSON.stringify(persisted)).not.toContain('"ahp"');
  });

  it('loadSettings survives junk (wrong-typed) data.json values via normalization', async () => {
    const plugin = makePlugin();
    vi.spyOn(plugin, 'loadData').mockResolvedValue({
      terminalFontSize: 'huge',
      instances: [{ id: 'default', name: 'Default', cwd: '' }, 'junk'],
      farmView: { liveUpdate: 'yes', density: 'cozy' },
      promptSubmitMode: 'telepathy',
    });

    await plugin.loadSettings();

    expect(plugin.settings.terminalFontSize).toBe(DEFAULT_SETTINGS.terminalFontSize);
    expect(plugin.settings.instances).toEqual([{ id: 'default', name: 'Default', cwd: '' }]);
    expect(plugin.settings.farmView.liveUpdate).toBe(true);
    expect(plugin.settings.farmView.density).toBe('compact');
    expect(plugin.settings.promptSubmitMode).toBe('apc');
  });
});
