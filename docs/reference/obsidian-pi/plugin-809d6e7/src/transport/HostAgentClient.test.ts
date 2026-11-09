/**
 * Unit tests for HostAgentClient (M3 host-agent relay, plugin side) — the
 * register/sync handshake, the terminal tee (attach/detach/input/resize/exit),
 * heartbeat, unregister-on-dispose, announcedIds, and the mobile-safety import
 * contract.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  HostAgentClient,
  mapLocalStatus,
  mapCurrentAction,
  type HostAgentClientOptions,
} from './HostAgentClient';
import type { InstanceManager, PiInstance } from '../instance/InstanceManager';
import type { PtyClient } from './PtyClient';

// ─── Fakes ───────────────────────────────────────────────────────────────────

interface FakePty {
  state: string;
  cols: number;
  rows: number;
  options: { cols: number; rows: number };
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  onResize: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
  onNotify: ReturnType<typeof vi.fn>;
}

function makePty(): { pty: FakePty; unsubData: ReturnType<typeof vi.fn>; unsubResize: ReturnType<typeof vi.fn>; unsubExit: ReturnType<typeof vi.fn> } {
  const unsubData = vi.fn();
  const unsubResize = vi.fn();
  const unsubExit = vi.fn();
  const pty: FakePty = {
    state: 'connected',
    cols: 80,
    rows: 24,
    options: { cols: 80, rows: 24 },
    write: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn(() => unsubData),
    onResize: vi.fn(() => unsubResize),
    onExit: vi.fn(() => unsubExit),
    onNotify: vi.fn(() => vi.fn()),
  };
  return { pty, unsubData, unsubResize, unsubExit };
}

function makeInstance(
  id: string,
  overrides: Partial<PiInstance> = {},
): PiInstance {
  return {
    config: { id, name: id === 'default' ? 'Default' : id, cwd: '/vault' },
    ptyClient: null,
    terminalView: null,
    promptPopout: null,
    pendingResumeSessionPath: null,
    stateNoticesWired: false,
    awaitingInput: false,
    iconState: 'idle',
    stats: {},
    ...overrides,
  } as PiInstance;
}

interface ManagerHarness {
  manager: InstanceManager;
  fireChanged: () => void;
}

function makeManager(instances: PiInstance[]): ManagerHarness {
  let cb: (() => void) | null = null;
  const manager = {
    all: vi.fn(() => instances),
    get: vi.fn((id: string) => instances.find((i) => i.config.id === id)),
    onChanged: vi.fn((fn: () => void) => {
      cb = fn;
      return vi.fn();
    }),
    notifyChanged: vi.fn(() => cb?.()),
  };
  return { manager: manager as unknown as InstanceManager, fireChanged: () => cb?.() };
}

interface ClientHarness {
  client: HostAgentClient;
  manager: InstanceManager;
  fireChanged: () => void;
  sent: string[];
  ws: { readyState: number; send: (m: string) => void; close: ReturnType<typeof vi.fn> };
  cast: {
    register(): Promise<void>;
    hostAgentHandshake(): Promise<void>;
    subscribeInstanceChanges(): void;
    startHeartbeat(): void;
    handleMessage(raw: string): void;
    setState(s: string): void;
  };
}

function makeClient(
  instances: PiInstance[],
  opts: Partial<HostAgentClientOptions> = {},
): ClientHarness {
  const { manager, fireChanged } = makeManager(instances);
  const client = new HostAgentClient({
    url: 'ws://test:4500',
    deviceName: 'TestMac',
    token: 'tok-123',
    instanceManager: manager,
    ...opts,
  });
  const sent: string[] = [];
  const ws = { readyState: 1, send: (m: string) => sent.push(m), close: vi.fn() };
  (client as unknown as { ws: typeof ws }).ws = ws;
  const cast = client as unknown as ClientHarness['cast'];
  return { client, manager, fireChanged, sent, ws, cast };
}

/** Resolve the most recently sent request by echoing a response back in. */
function respond(h: ClientHarness, result: unknown): void {
  const last = JSON.parse(h.sent[h.sent.length - 1]);
  h.cast.handleMessage(
    JSON.stringify({ jsonrpc: '2.0', id: last.id, result }),
  );
}

function sentMethods(h: ClientHarness): string[] {
  return h.sent.map((m) => (JSON.parse(m) as { method?: string }).method ?? '(response)');
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('HostAgentClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('register announces deviceName + token and stores the server hostAgentId', async () => {
    const h = makeClient([makeInstance('default')]);
    const reg = h.cast.register();
    const msg = JSON.parse(h.sent[0]);
    expect(msg.method).toBe('hostAgent.register');
    expect(msg.params).toMatchObject({ deviceName: 'TestMac', token: 'tok-123' });
    expect(h.client.agentId).toBeUndefined();

    h.cast.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { hostAgentId: 'ha-42' } }),
    );
    await reg;
    expect(h.client.agentId).toBe('ha-42');
  });

  it('register includes piVersion when provided, omits it otherwise', async () => {
    const withVersion = makeClient([makeInstance('default')], { piVersion: '0.84.1' });
    withVersion.cast.register();
    const msg1 = JSON.parse(withVersion.sent[0]);
    expect(msg1.params).toMatchObject({ deviceName: 'TestMac', token: 'tok-123', piVersion: '0.84.1' });

    const withoutVersion = makeClient([makeInstance('default')], { piVersion: undefined });
    withoutVersion.cast.register();
    const msg2 = JSON.parse(withoutVersion.sent[0]);
    expect(msg2.params).toMatchObject({ deviceName: 'TestMac', token: 'tok-123' });
    expect(msg2.params).not.toHaveProperty('piVersion');
  });

  it('register omits token when none is configured', async () => {
    const h = makeClient([makeInstance('default')], { token: undefined });
    const reg = h.cast.register();
    const msg = JSON.parse(h.sent[0]);
    expect(msg.params).not.toHaveProperty('token');
    h.cast.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { hostAgentId: 'ha-x' } }),
    );
    await reg;
    expect(h.client.agentId).toBe('ha-x');
  });

  it('uses opts.url when connecting instead of the localhost default', async () => {
    vi.useFakeTimers();
    const h = makeClient([makeInstance('default')], { url: 'ws://broker.example:4500' });
    expect((h.client as unknown as { url: string }).url).toBe('ws://broker.example:4500');

    const connectSpy = vi.spyOn(h.client, 'connect').mockResolvedValue(undefined);
    (h.client as unknown as { hostAgentHandshake: () => Promise<void> }).hostAgentHandshake = vi.fn().mockResolvedValue(undefined);

    await h.client.start();
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(connectSpy).toHaveBeenCalledWith('ws://broker.example:4500');
  });

  it('syncInstances announces the full set with mapped status and filters ahp entries', async () => {
    const instances = [
      makeInstance('default', {
        iconState: 'running',
        stats: { lastEventType: 'start' as const, model: 'claude-sonnet-4' },
      }),
      makeInstance('local-2', {
        awaitingInput: true,
        stats: { lastEventType: 'question' as const },
      }),
      makeInstance('local-3', {
        iconState: 'done-unseen',
        stats: {
          lastEventType: 'end' as const,
          model: 'claude-sonnet-4',
          turns: 3,
          tokens: 100,
          cost: 0.0123,
        },
      }),
      makeInstance('ahp-remote', {
        config: { id: 'ahp-remote', name: 'AHP', cwd: '', ahp: true },
      }),
    ];
    (instances[0] as { ptyClient: PtyClient | null }).ptyClient = {
      state: 'connected',
    } as PtyClient;
    const h = makeClient(instances);

    const sync = h.client.syncInstances();
    const msg = JSON.parse(h.sent[0]);
    expect(msg.method).toBe('hostAgent.syncInstances');
    h.cast.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { sessionUris: ['ahp-session:/ext-testmac-default'] },
      }),
    );
    await sync;

    const announced = msg.params.instances as Array<Record<string, unknown>>;
    // config.ahp === true filtered out
    expect(announced).toHaveLength(3);
    expect(announced.map((i) => i.instanceId)).toEqual(['default', 'local-2', 'local-3']);

    expect(announced[0]).toMatchObject({
      instanceId: 'default',
      name: 'Default',
      online: true,
      status: 8, // Running
      model: 'claude-sonnet-4',
      currentAction: 'running',
      workingDirectory: '/vault',
    });
    expect(announced[1]).toMatchObject({ instanceId: 'local-2', status: 24, currentAction: 'needs-input' });
    expect(announced[2]).toMatchObject({
      instanceId: 'local-3',
      status: 4, // Done
      turns: 3,
      tokensOut: 100,
      cost: 0.0123,
      currentAction: 'done',
    });

    // announcedIds mirrors the announced set (M4 dedup consumer)
    expect(h.client.announcedIds).toEqual(new Set(['default', 'local-2', 'local-3']));
  });

  it('fires a fresh syncInstances on every instanceManager change', async () => {
    const h = makeClient([makeInstance('default')]);
    h.cast.subscribeInstanceChanges();
    h.fireChanged();
    // The onChanged callback sends the request synchronously.
    expect(sentMethods(h)).toContain('hostAgent.syncInstances');
    respond(h, { sessionUris: [] });
    await new Promise((r) => setTimeout(r, 0));
  });

  it('accumulates turn rollups exactly once per completed turn', async () => {
    const instance = makeInstance('default', {
      iconState: 'seen',
      stats: { lastEventType: 'end' as const, turns: 1, tokens: 50, cost: 0.005 },
    });
    const h = makeClient([instance]);
    h.cast.subscribeInstanceChanges();

    h.fireChanged();
    expect(sentMethods(h)).toContain('hostAgent.syncInstances');
    const first = JSON.parse(h.sent[h.sent.length - 1]);
    expect(first.params.instances[0].tokensOut).toBe(50);
    respond(h, {});

    // Same snapshot again (no new completed turn) → no double accumulation.
    h.fireChanged();
    const second = JSON.parse(h.sent[h.sent.length - 1]);
    expect(second.params.instances[0].tokensOut).toBe(50);
    expect(second.params.instances[0].cost).toBe(0.005);
    respond(h, {});

    // A new completed turn folds in.
    instance.stats = { lastEventType: 'end', turns: 2, tokens: 70, cost: 0.007 };
    h.fireChanged();
    const third = JSON.parse(h.sent[h.sent.length - 1]);
    expect(third.params.instances[0].tokensOut).toBe(120);
    expect(third.params.instances[0].cost).toBe(0.012);
    expect(third.params.instances[0].turns).toBe(2);
    respond(h, {});
  });

  it('startTerminalStream attaches the onData/onResize/onExit tee and acks the server', async () => {
    const { pty, unsubData, unsubResize, unsubExit } = makePty();
    const instance = makeInstance('default');
    instance.ptyClient = pty as unknown as PtyClient;
    const h = makeClient([instance]);

    h.cast.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'startTerminalStream',
        params: {
          instanceId: 'default',
          terminalUri: 'ahp-terminal:/ext-testmac-default',
          cols: 80,
          rows: 24,
        },
      }),
    );

    expect(pty.onData).toHaveBeenCalledTimes(1);
    expect(pty.onResize).toHaveBeenCalledTimes(1);
    expect(pty.onExit).toHaveBeenCalledTimes(1);
    expect(unsubData).not.toHaveBeenCalled();
    expect(unsubResize).not.toHaveBeenCalled();
    expect(unsubExit).not.toHaveBeenCalled();

    // Ack (id 7) sent, plus the initial size report.
    const ack = h.sent.map((m) => JSON.parse(m)).find((m) => m.id === 7);
    expect(ack).toMatchObject({ jsonrpc: '2.0', result: null });
    const sizeReport = h.sent
      .map((m) => JSON.parse(m))
      .find((m) => (m as { method?: string }).method === 'hostAgent.terminalResized');
    expect(sizeReport?.params).toMatchObject({ instanceId: 'default', cols: 80, rows: 24 });
    // Resolve the size report request so no dangling promise.
    h.cast.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: sizeReport.id, result: null }));
  });

  it('terminalData flows from ptyClient.onData to hostAgent.terminalData', async () => {
    const { pty } = makePty();
    const instance = makeInstance('default');
    instance.ptyClient = pty as unknown as PtyClient;
    const h = makeClient([instance]);

    h.cast.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'startTerminalStream', params: { instanceId: 'default' } }),
    );

    const dataListener = pty.onData.mock.calls[0][0] as (data: string) => void;
    dataListener('hello\r\n');
    const dataMsg = h.sent
      .map((m) => JSON.parse(m))
      .find((m) => (m as { method?: string }).method === 'hostAgent.terminalData');
    expect(dataMsg?.params).toMatchObject({ instanceId: 'default', data: 'hello\r\n' });
    h.cast.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: dataMsg.id, result: null }));
  });

  it('local PTY resize/exit are relayed as terminalResized / terminalExited', async () => {
    const { pty } = makePty();
    const instance = makeInstance('default');
    instance.ptyClient = pty as unknown as PtyClient;
    const h = makeClient([instance]);
    h.cast.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'startTerminalStream', params: { instanceId: 'default' } }),
    );

    const resizeListener = pty.onResize.mock.calls[0][0] as (c: number, r: number) => void;
    resizeListener(132, 43);
    const resized = h.sent
      .map((m) => JSON.parse(m))
      .filter((m) => (m as { method?: string }).method === 'hostAgent.terminalResized')
      .pop();
    expect(resized?.params).toMatchObject({ instanceId: 'default', cols: 132, rows: 43 });
    h.cast.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: resized.id, result: null }));

    const exitListener = pty.onExit.mock.calls[0][0] as (code: number) => void;
    exitListener(0);
    const exited = h.sent
      .map((m) => JSON.parse(m))
      .find((m) => (m as { method?: string }).method === 'hostAgent.terminalExited');
    expect(exited?.params).toMatchObject({ instanceId: 'default', exitCode: 0 });
    h.cast.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: exited.id, result: null }));
  });

  it('startTerminalStream error-acks when the local PTY is not running (no spawn)', async () => {
    const instance = makeInstance('default'); // ptyClient null
    const h = makeClient([instance]);
    h.cast.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'startTerminalStream', params: { instanceId: 'default' } }),
    );
    const ack = h.sent.map((m) => JSON.parse(m)).find((m) => m.id === 3);
    expect(ack).toMatchObject({ jsonrpc: '2.0', id: 3 });
    expect(typeof ack.error?.code).toBe('number');
    expect(ack.error.message).toContain('not running');
  });

  it('terminalInput writes to the local PTY and terminalResize resizes it', async () => {
    const { pty } = makePty();
    const instance = makeInstance('default');
    instance.ptyClient = pty as unknown as PtyClient;
    const h = makeClient([instance]);

    h.cast.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'terminalInput', params: { instanceId: 'default', data: 'ls -la\r' } }),
    );
    expect(pty.write).toHaveBeenCalledWith('ls -la\r');

    h.cast.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'terminalResize', params: { instanceId: 'default', cols: 120, rows: 40 } }),
    );
    expect(pty.resize).toHaveBeenCalledWith(120, 40);
  });

  it('stopTerminalStream detaches the tee but leaves the local PTY alive', async () => {
    const { pty, unsubData, unsubResize, unsubExit } = makePty();
    const instance = makeInstance('default');
    instance.ptyClient = pty as unknown as PtyClient;
    const h = makeClient([instance]);

    h.cast.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'startTerminalStream', params: { instanceId: 'default' } }),
    );
    h.cast.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'stopTerminalStream', params: { instanceId: 'default' } }),
    );

    expect(unsubData).toHaveBeenCalledTimes(1);
    expect(unsubResize).toHaveBeenCalledTimes(1);
    expect(unsubExit).toHaveBeenCalledTimes(1);

    // The local PTY is untouched — writes still flow.
    pty.write('still-alive\r');
    expect(pty.write).toHaveBeenCalledWith('still-alive\r');
  });

  it('sends hostAgent.heartbeat every 15s', () => {
    vi.useFakeTimers();
    const h = makeClient([makeInstance('default')]);
    h.cast.startHeartbeat();
    expect(h.sent).toHaveLength(0);
    vi.advanceTimersByTime(15_000);
    expect(sentMethods(h)).toContain('hostAgent.heartbeat');
    const msg = JSON.parse(h.sent[0]);
    expect(typeof msg.params.ts).toBe('number');
    vi.advanceTimersByTime(15_000);
    expect(sentMethods(h).filter((m) => m === 'hostAgent.heartbeat')).toHaveLength(2);
  });

  it('start() retries connect+register on -32602 and succeeds on a later attempt', async () => {
    vi.useFakeTimers();
    const h = makeClient([makeInstance('default')]);
    const connectSpy = vi.spyOn(h.client, 'connect').mockResolvedValue(undefined);

    let attempts = 0;
    (h.client as unknown as { hostAgentHandshake: () => Promise<void> }).hostAgentHandshake = vi.fn(
      async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error('JSON-RPC -32602: hostAgent already registered for this device');
        }
        (h.client as unknown as { hostAgentId: string }).hostAgentId = 'ha-42';
      },
    );

    const startPromise = h.client.start();

    // First attempt runs immediately.
    await Promise.resolve();
    expect(attempts).toBe(1);
    expect(connectSpy).toHaveBeenCalledTimes(1);

    // Retry after the 2s backoff.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(attempts).toBe(2);

    await startPromise;
    expect(h.client.agentId).toBe('ha-42');
  });

  it('dispose() during start retry aborts further attempts', async () => {
    vi.useFakeTimers();
    const h = makeClient([makeInstance('default')]);
    vi.spyOn(h.client, 'connect').mockResolvedValue(undefined);

    let attempts = 0;
    (h.client as unknown as { hostAgentHandshake: () => Promise<void> }).hostAgentHandshake = vi.fn(
      async () => {
        attempts++;
        throw new Error('JSON-RPC -32602: hostAgent already registered for this device');
      },
    );

    const startPromise = h.client.start();
    await Promise.resolve();
    expect(attempts).toBe(1);

    // Dispose before the 2s retry backoff fires.
    const disposePromise = h.client.dispose();

    // The pending unregister request needs a response so dispose() completes.
    const unregister = h.sent.map((m) => JSON.parse(m)).find((m) => m.method === 'hostAgent.unregister');
    if (unregister) {
      h.cast.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: unregister.id, result: null }));
    }

    await vi.advanceTimersByTimeAsync(2_000);

    // No further handshake attempts after teardown.
    expect(attempts).toBe(1);
    await expect(startPromise).resolves.toBeUndefined();
    await disposePromise;
  });

  it('updateIdentity unregisters when connected so the reconnect re-registers with new params', () => {
    const h = makeClient([makeInstance('default')]);
    (h.client as unknown as { _state: string })._state = 'connected';

    h.client.updateIdentity('NewMac', 'tok-2');
    const msg = JSON.parse(h.sent[0]);
    expect(msg.method).toBe('hostAgent.unregister');

    // Same identity again → no-op.
    h.client.updateIdentity('NewMac', 'tok-2');
    expect(h.sent).toHaveLength(1);
  });

  it('dispose unregisters gracefully and clears announcedIds', async () => {
    const h = makeClient([makeInstance('default')]);
    const sync = h.client.syncInstances();
    respond(h, { sessionUris: [] });
    await sync;
    expect(h.client.announcedIds.size).toBe(1);

    const dispose = h.client.dispose();
    const msg = JSON.parse(h.sent[h.sent.length - 1]);
    expect(msg.method).toBe('hostAgent.unregister');
    h.cast.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null }));
    await dispose;

    expect(h.client.announcedIds.size).toBe(0);
    expect(h.ws.close).toHaveBeenCalled();
  });

  it('dispose() does NOT stall on a dead broker — unregister is raced against a ~3s grace window', async () => {
    vi.useFakeTimers();
    try {
      const h = makeClient([makeInstance('default')]);
      // A response arrives for the initial sync, then the broker goes silent.
      const sync = h.client.syncInstances();
      respond(h, { sessionUris: [] });
      await sync;

      // dispose() sends hostAgent.unregister but NEVER gets a response —
      // previously this awaited the full 30s RESPONSE_TIMEOUT_MS.
      const dispose = h.client.dispose();
      const msg = JSON.parse(h.sent[h.sent.length - 1]);
      expect(msg.method).toBe('hostAgent.unregister');

      // Just past the grace window (well under 30s) dispose must have completed.
      await vi.advanceTimersByTimeAsync(3_100);
      await expect(dispose).resolves.toBeUndefined();
      expect(h.ws.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose() still completes via the unregister response when it arrives before the grace window', async () => {
    vi.useFakeTimers();
    try {
      const h = makeClient([makeInstance('default')]);
      const sync = h.client.syncInstances();
      respond(h, { sessionUris: [] });
      await sync;

      const dispose = h.client.dispose();
      const msg = JSON.parse(h.sent[h.sent.length - 1]);
      // The unregister ack arrives after ~100ms — result-then-close is kept.
      await vi.advanceTimersByTimeAsync(100);
      h.cast.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null }));
      await expect(dispose).resolves.toBeUndefined();
      expect(h.client.announcedIds.size).toBe(0);
      expect(h.ws.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fires announcedIds listeners after every sync and on dispose (M4 reconcile)', async () => {
    const h = makeClient([makeInstance('default')]);
    const listener = vi.fn();
    h.client.onAnnouncedIdsChanged(listener);

    // Each successful syncInstances notifies consumers (FarmView re-runs its
    // local-row dedup against the fresh set).
    const sync = h.client.syncInstances();
    respond(h, { sessionUris: [] });
    await sync;
    expect(listener).toHaveBeenCalledTimes(1);
    expect(h.client.announcedIds).toEqual(new Set(['default']));

    // Clearing the set on dispose also notifies — the local rows reappear.
    const dispose = h.client.dispose();
    const msg = JSON.parse(h.sent[h.sent.length - 1]);
    expect(msg.method).toBe('hostAgent.unregister');
    h.cast.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null }));
    await dispose;
    expect(listener).toHaveBeenCalledTimes(2);
    expect(h.client.announcedIds.size).toBe(0);

    // Unsubscribing stops further notifications.
    const unsub = h.client.onAnnouncedIdsChanged(vi.fn());
    unsub();
  });

  it('maps local runtime state onto the server SessionStatus bits', () => {
    expect(mapLocalStatus(makeInstance('a', { iconState: 'running' }))).toBe(8);
    expect(mapLocalStatus(makeInstance('a', { awaitingInput: true }))).toBe(24);
    expect(mapLocalStatus(makeInstance('a', { iconState: 'done-unseen' }))).toBe(4);
    expect(mapLocalStatus(makeInstance('a', { iconState: 'seen' }))).toBe(4);
    expect(mapLocalStatus(makeInstance('a', { iconState: 'error' }))).toBe(2);
    expect(mapLocalStatus(makeInstance('a', { iconState: 'idle' }))).toBe(1);
  });

  it('maps the last agent event to a currentAction label', () => {
    expect(mapCurrentAction('start')).toBe('running');
    expect(mapCurrentAction('question')).toBe('needs-input');
    expect(mapCurrentAction('end')).toBe('done');
    expect(mapCurrentAction('error')).toBe('error');
    expect(mapCurrentAction('abort')).toBe('idle');
    expect(mapCurrentAction(undefined)).toBeUndefined();
  });

  it('never value-imports node-pty / child_process (mobile safety)', () => {
    const src = fs.readFileSync(__filename.replace('.test.ts', '.ts'), 'utf8');
    expect(src).not.toMatch(/from\s+['"]node-pty['"]/);
    expect(src).not.toMatch(/from\s+['"]child_process['"]/);
    expect(src).not.toMatch(/from\s+['"]fs['"]/);
    expect(src).not.toMatch(/from\s+['"]path['"]/);
    expect(src).not.toMatch(/from\s+['"]os['"]/);
    // PtyClient / PiInstance reachable only via type imports.
    expect(src).toMatch(/import type\s+\{[^}]*PtyClient/);
    expect(src).toMatch(/import type\s+\{[^}]*InstanceManager[^}]*PiInstance/);
  });

  it('main.ts constructs HostAgentClient only on desktop and only when enabled', () => {
    const mainSrc = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'src', 'main.ts'),
      'utf8',
    );
    // The start method guards desktop and the dynamic import is the module boundary.
    const startFn = mainSrc.slice(mainSrc.indexOf('async startHostAgentClient'));
    expect(startFn).toMatch(/if \(!Platform\.isDesktop\) return;/);
    expect(startFn).toMatch(/await import\('\.\/transport\/HostAgentClient'\)/);
    // The onload call site is gated by both desktop AND the opt-in setting.
    expect(mainSrc).toMatch(/if \(Platform\.isDesktop\)/);
    expect(mainSrc).toMatch(/if \(this\.settings\.hostAgentEnabled\) \{\s*void this\.startHostAgentClient\(\);/);
    // hostAgentClient is a type-only import in main.ts (no runtime load on mobile).
    expect(mainSrc).toMatch(/import type\s+\{\s*HostAgentClient\s*\}/);
  });
});
