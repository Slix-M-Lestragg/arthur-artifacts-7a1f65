/**
 * Unit tests for AhpClient action helpers — verifying the exact action shapes
 * dispatched to the AHP server (e.g. terminal resize action names).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AhpClient } from './AhpClient';
import { AhpError } from './AhpError';

describe('AhpClient terminal helpers', () => {
  let client: AhpClient;
  let sent: string[];
  let ws: { readyState: number; send: (msg: string) => void };

  beforeEach(() => {
    client = new AhpClient('test-client');
    sent = [];
    ws = {
      readyState: 1, // WebSocket.OPEN
      send: (msg: string) => sent.push(msg),
    };
    // Inject the mock socket directly so we don't need a real WebSocket server.
    (client as unknown as { ws: typeof ws }).ws = ws;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resizeTerminal dispatches terminal/resized with cols and rows', () => {
    client.resizeTerminal('ahp-terminal:/pi-test', 80, 24);
    expect(sent).toHaveLength(1);
    const msg = JSON.parse(sent[0]);
    expect(msg).toMatchObject({
      jsonrpc: '2.0',
      method: 'dispatchAction',
      params: {
        channel: 'ahp-terminal:/pi-test',
        clientSeq: 1,
        action: { type: 'terminal/resized', cols: 80, rows: 24 },
      },
    });
  });

  it('sendTerminalInput dispatches terminal/input with raw data', () => {
    client.sendTerminalInput('ahp-terminal:/pi-test', 'ls -la\r');
    expect(sent).toHaveLength(1);
    const msg = JSON.parse(sent[0]);
    expect(msg).toMatchObject({
      jsonrpc: '2.0',
      method: 'dispatchAction',
      params: {
        channel: 'ahp-terminal:/pi-test',
        clientSeq: 1,
        action: { type: 'terminal/input', data: 'ls -la\r' },
      },
    });
  });
});

describe('AhpClient session chat subscription', () => {
  let client: AhpClient;

  beforeEach(() => {
    client = new AhpClient('test-client');
    const ws = {
      readyState: 1,
      send: vi.fn(),
    };
    (client as unknown as { ws: typeof ws }).ws = ws;
  });

  it('handles session/chatAdded, session/chatUpdated, and session/chatRemoved action envelopes', async () => {
    // The broker delivers chat mutations ONLY as `action` envelopes on the
    // session channel (dispatchServerAction) — never as JSON-RPC notification
    // methods. This exercises the live wire path.
    const listener = vi.fn();
    vi.spyOn(client, 'subscribe').mockResolvedValue({
      snapshot: { state: { chats: [] } },
    });

    client.subscribeSessionChats('ahp-session:/s1', listener);
    client.attachActionMapper();
    await new Promise((r) => setTimeout(r, 0));
    expect(listener.mock.calls.at(-1)?.[0]).toEqual([]);

    const deliver = (action: Record<string, unknown>, serverSeq: number): void => {
      (client as unknown as { handleMessage: (raw: string) => void }).handleMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'action',
          params: {
            channel: 'ahp-session:/s1',
            action,
            serverSeq,
            origin: { clientId: 'server', clientSeq: 0 },
          },
        }),
      );
    };

    // session/chatAdded uses action.summary (not action.chat).
    deliver(
      {
        type: 'session/chatAdded',
        summary: {
          resource: 'ahp-chat:/c1',
          title: 'Subagent one',
          origin: { kind: 'tool', toolCallId: 'call-1' },
        },
      },
      1,
    );
    let last = listener.mock.calls.at(-1)?.[0] as Array<{ resource: string; origin?: { kind: string } }> | undefined;
    expect(last).toHaveLength(1);
    expect(last![0].resource).toBe('ahp-chat:/c1');
    expect(last![0].origin?.kind).toBe('tool');

    // session/chatUpdated uses action.chat + action.changes.
    deliver({ type: 'session/chatUpdated', chat: 'ahp-chat:/c1', changes: { title: 'Renamed subagent' } }, 2);
    const updated = listener.mock.calls.at(-1)?.[0] as Array<{ resource: string; title?: string }> | undefined;
    expect(updated).toHaveLength(1);
    expect(updated![0].title).toBe('Renamed subagent');

    // session/chatRemoved uses action.chat.
    deliver({ type: 'session/chatRemoved', chat: 'ahp-chat:/c1' }, 3);
    const removed = listener.mock.calls.at(-1)?.[0] as Array<{ resource: string }> | undefined;
    expect(removed).toEqual([]);
  });
  it('subscribeSessionChats returns only tool-origin chats and live updates', async () => {
    const listener = vi.fn();
    const chats = [
      {
        resource: 'ahp-chat:/c1',
        title: 'Subagent one',
        origin: { kind: 'tool', toolCallId: 'call-1' },
      },
      {
        resource: 'ahp-chat:/c2',
        title: 'Normal chat',
        origin: { kind: 'user' },
      },
    ];
    vi.spyOn(client, 'subscribe').mockResolvedValue({
      snapshot: { state: { chats } },
    });

    client.subscribeSessionChats('ahp-session:/s1', listener);
    client.attachActionMapper();
    await new Promise((r) => setTimeout(r, 0));

    const last = listener.mock.calls.at(-1)?.[0] as Array<{ resource: string }> | undefined;
    expect(last).toBeDefined();
    expect(last!).toHaveLength(1);
    expect(last!.map((c) => c.resource)).toContain('ahp-chat:/c1');
    expect(last!.map((c) => c.resource)).not.toContain('ahp-chat:/c2');

    (client as unknown as { handleMessage: (raw: string) => void }).handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'action',
        params: {
          channel: 'ahp-session:/s1',
          action: {
            type: 'session/chatAdded',
            summary: {
              resource: 'ahp-chat:/c3',
              title: 'Subagent two',
              origin: { kind: 'tool', toolCallId: 'call-2' },
            },
          },
          serverSeq: 1,
          origin: { clientId: 'server', clientSeq: 0 },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    const updated = listener.mock.calls.at(-1)?.[0] as Array<{ resource: string }> | undefined;
    expect(updated).toBeDefined();
    expect(updated!).toHaveLength(2);
    expect(updated!.map((c) => c.resource)).toContain('ahp-chat:/c3');
  });
});

describe('AhpClient catalogue cache hygiene on reconnect', () => {
  let client: AhpClient;

  function makeSummary(resource: string, title: string): import('./AhpClient').SessionSummary {
    return {
      resource,
      title,
      status: 1,
      modifiedAt: new Date().toISOString(),
    };
  }

  beforeEach(() => {
    client = new AhpClient('test-client');
    const ws = {
      readyState: 1,
      send: vi.fn(),
    };
    (client as unknown as { ws: typeof ws }).ws = ws;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('subscribeRoot clears stale sessions and seeds from the fresh snapshot/listSessions', async () => {
    const sessionA = makeSummary('ahp-session:/a', 'Session A');
    const sessionB = makeSummary('ahp-session:/b', 'Session B');

    let rootSessions = [sessionA];
    let listSessions = [sessionA];
    vi.spyOn(client as unknown as { request: (method: string, params: Record<string, unknown>) => Promise<unknown> }, 'request').mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'subscribe' && params.channel === 'ahp-root://') {
        return { snapshot: { state: { sessions: rootSessions } } };
      }
      if (method === 'listSessions') {
        return { items: listSessions };
      }
      return {};
    });

    await client.subscribeRoot();
    expect(client.getSessions().map((s) => s.resource)).toEqual(['ahp-session:/a']);

    // Server restart: fresh catalogue contains only session B.
    rootSessions = [sessionB];
    listSessions = [sessionB];
    await client.subscribeRoot();
    expect(client.getSessions().map((s) => s.resource)).toEqual(['ahp-session:/b']);
  });

  it('refreshSessions clears stale sessions and rebuilds from listSessions', async () => {
    const sessionA = makeSummary('ahp-session:/a', 'Session A');
    const sessionB = makeSummary('ahp-session:/b', 'Session B');

    let listSessions = [sessionA];
    vi.spyOn(client as unknown as { request: (method: string, params: Record<string, unknown>) => Promise<unknown> }, 'request').mockImplementation(async (method: string) => {
      if (method === 'listSessions') {
        return { items: listSessions };
      }
      return {};
    });

    // Seed the cache with A first.
    await client.refreshSessions();
    expect(client.getSessions().map((s) => s.resource)).toEqual(['ahp-session:/a']);

    // A later full refresh with a dropped session removes the stale entry.
    listSessions = [sessionB];
    await client.refreshSessions();
    expect(client.getSessions().map((s) => s.resource)).toEqual(['ahp-session:/b']);
  });
});

describe('AhpClient reconnect: session chat snapshots + terminal resubscription', () => {
  let client: AhpClient;

  beforeEach(() => {
    client = new AhpClient('test-client');
    const ws = {
      readyState: 1,
      send: vi.fn(),
    };
    (client as unknown as { ws: typeof ws }).ws = ws;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applies reconnect session snapshots to registered sessionChatSubs (fix 1)', async () => {
    const listener = vi.fn();
    vi.spyOn(client, 'subscribe').mockResolvedValue({
      snapshot: { state: { chats: [] } },
    });
    client.subscribeSessionChats('ahp-session:/s1', listener);
    await new Promise((r) => setTimeout(r, 0));
    expect(listener.mock.calls.at(-1)?.[0]).toEqual([]);

    const chats = [
      {
        resource: 'ahp-chat:/c1',
        title: 'Subagent one',
        origin: { kind: 'tool', toolCallId: 'call-1' },
      },
      {
        resource: 'ahp-chat:/c2',
        title: 'Main chat',
        origin: { kind: 'user' },
      },
    ];
    vi.spyOn(client as unknown as { request: (method: string, params: Record<string, unknown>) => Promise<unknown> }, 'request').mockImplementation(async (method: string) => {
      if (method === 'reconnect') {
        return {
          type: 'snapshot',
          snapshots: {
            'ahp-root://': { resource: 'ahp-root://', state: { sessions: [], activeSessions: 1 }, fromSeq: 1 },
            'ahp-session:/s1': { resource: 'ahp-session:/s1', state: { chats }, fromSeq: 2 },
          },
        };
      }
      if (method === 'subscribe') return { snapshot: { state: {} } };
      if (method === 'listSessions') return { items: [] };
      return {};
    });

    await (client as unknown as { resumeFromReconnect: (subs: string[]) => Promise<void> }).resumeFromReconnect([
      'ahp-root://',
      'ahp-session:/s1',
    ]);

    // The reconnect snapshot's state.chats must be delivered to the listener
    // (tool-origin chats only), refreshing FarmView's subagent rows.
    const last = listener.mock.calls.at(-1)?.[0] as Array<{ resource: string }> | undefined;
    expect(last).toEqual([chats[0]]);
  });

  it('includes session chat subs and tracked terminals in reconnect subscriptions (fixes 1+3)', async () => {
    const chatListener = vi.fn();
    let reconnectSubscriptions: string[] | undefined;
    vi.spyOn(client as unknown as { request: (method: string, params: Record<string, unknown>) => Promise<unknown> }, 'request').mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'reconnect') {
        reconnectSubscriptions = params.subscriptions as string[];
        return { type: 'snapshot', snapshots: {} };
      }
      if (method === 'subscribe') {
        const channel = params.channel as string;
        // Terminal subscribe (attach flow) returns a terminal snapshot; session
        // subscribe seeds an empty chat list.
        return { snapshot: { state: channel.startsWith('ahp-terminal:') ? { cols: 80, rows: 24 } : { chats: [] } } };
      }
      if (method === 'listSessions') return { items: [] };
      return {};
    });
    client.subscribeSessionChats('ahp-session:/s1', chatListener);
    // Simulate the attach flow's terminal subscribe (real subscribe → tracking).
    await client.subscribe('ahp-terminal:/pi-hosted');
    await new Promise((r) => setTimeout(r, 0));
    vi.spyOn(client, 'connect').mockResolvedValue(undefined);

    await (client as unknown as { attemptReconnect: () => Promise<void> }).attemptReconnect();

    expect(reconnectSubscriptions).toContain('ahp-session:/s1');
    expect(reconnectSubscriptions).toContain('ahp-terminal:/pi-hosted');
  });

  it('tracks terminal channels on subscribe so reconnect re-subscribes them (fix 3)', async () => {
    vi.spyOn(client as unknown as { request: (method: string, params: Record<string, unknown>) => Promise<unknown> }, 'request').mockResolvedValue({
      snapshot: { state: { cols: 120, rows: 40 } },
    });
    await client.subscribe('ahp-terminal:/pi-hosted');
    expect(
      (client as unknown as { terminalSubs: Set<string> }).terminalSubs.has('ahp-terminal:/pi-hosted'),
    ).toBe(true);
  });
});

describe('AhpClient structured errors (audit 2026-09-01 remediation 3)', () => {
  let client: AhpClient;

  beforeEach(() => {
    client = new AhpClient('test-client');
    const ws = { readyState: 1, send: vi.fn() };
    (client as unknown as { ws: typeof ws }).ws = ws;
  });

  it('rejects requests with an AhpError preserving code + data (not a flattened string)', async () => {
    const pending = (client as unknown as { request: (m: string, p: Record<string, unknown>) => Promise<unknown> })
      .request('terminal/subscribe', { channel: 'ahp-terminal:/s1' });

    // Feed the matching error response through the real handleMessage path.
    const id = ((client as unknown as { nextId: number }).nextId) - 1;
    (client as unknown as { handleMessage: (raw: string) => void }).handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32000,
          message: "pi terminal 's1' is not running",
          data: { instanceId: 's1' },
        },
      }),
    );

    await expect(pending).rejects.toMatchObject({
      name: 'AhpError',
      code: -32000,
      data: { instanceId: 's1' },
      message: "pi terminal 's1' is not running (code -32000)",
    });
  });

  it('initialize resolves when the server negotiates a supported protocol version', async () => {
    vi.spyOn(client as unknown as { request: (m: string, p: Record<string, unknown>) => Promise<unknown> }, 'request')
      .mockResolvedValue({ protocolVersion: '0.3.0', sessionId: 'srv-1' });

    const result = await client.initialize(['0.3.0'], 'test-client');

    expect(result).toMatchObject({ protocolVersion: '0.3.0', sessionId: 'srv-1' });
  });

  it('initialize tolerates servers that omit protocolVersion', async () => {
    vi.spyOn(client as unknown as { request: (m: string, p: Record<string, unknown>) => Promise<unknown> }, 'request')
      .mockResolvedValue({});

    await expect(client.initialize(['0.3.0'], 'test-client')).resolves.toEqual({});
  });

  it('initialize throws a structured AhpError(-32005) on protocol version mismatch', async () => {
    vi.spyOn(client as unknown as { request: (m: string, p: Record<string, unknown>) => Promise<unknown> }, 'request')
      .mockResolvedValue({ protocolVersion: '9.9.9' });

    const err = await client.initialize(['0.3.0'], 'test-client').then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(AhpError);
    const ahpErr = err as AhpError;
    expect(ahpErr.code).toBe(-32005);
    expect(ahpErr.data).toEqual({ supportedVersions: ['0.3.0'], negotiatedVersion: '9.9.9' });
    expect(ahpErr.message).toContain('9.9.9');
    expect(ahpErr.message).toContain('(code -32005)');
  });
});
