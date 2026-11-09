import { describe, expect, it, vi } from 'vitest';
import { attachAhpSessionWithMode, createHostedAhpSession, extractTerminalSnapshot } from './attachAhpSession';
import { AhpError } from './AhpError';
import type { AhpClient, SessionSummary } from './AhpClient';

function makeSession(terminalMode?: 'external' | 'server-spawned', provider?: string): SessionSummary {
  return {
    resource: 'ahp-session:/session-1',
    title: 'Test Session',
    status: 1,
    provider,
    terminalMode,
  };
}

function makeClient(snapshot?: unknown): AhpClient {
  return {
    subscribe: vi.fn().mockResolvedValue(snapshot),
    attachSession: vi.fn().mockResolvedValue(undefined),
  } as unknown as AhpClient;
}

type Host = {
  app: unknown;
  ahpClient: AhpClient | null;
  registerAhpInstance: ReturnType<typeof vi.fn>;
  activateAhpTerminalView: ReturnType<typeof vi.fn>;
};

function makeHost(client: AhpClient | null = makeClient()): Host {
  return {
    app: {},
    ahpClient: client,
    registerAhpInstance: vi.fn(),
    activateAhpTerminalView: vi.fn().mockResolvedValue(undefined),
  };
}

describe('attachAhpSessionWithMode', () => {
  it('attaches external sessions in interactive terminal mode after confirming', async () => {
    const client = makeClient();
    const host = makeHost(client);
    const confirm = vi.fn().mockResolvedValue(true);
    const notify = vi.fn();

    await attachAhpSessionWithMode(host, makeSession('external', 'pi-ahp-server'), { confirm, notify });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(client.subscribe).toHaveBeenCalledWith('ahp-terminal:/session-1');
    expect(client.attachSession).not.toHaveBeenCalled();
    expect(host.registerAhpInstance).toHaveBeenCalledWith('Test Session');
    expect(host.activateAhpTerminalView).toHaveBeenCalledWith('ahp-terminal:/session-1', 'external', undefined, undefined, undefined);
    expect(notify).toHaveBeenCalledWith('✓ AHP interactive terminal: ahp-terminal:/session-1', 4000);
  });

  it('applies the initial terminal size from the server snapshot for external sessions', async () => {
    const client = makeClient({ snapshot: { state: { cols: 218, rows: 50 } } });
    const host = makeHost(client);
    const confirm = vi.fn().mockResolvedValue(true);

    await attachAhpSessionWithMode(host, makeSession('external', 'pi-ahp-server'), { confirm });

    expect(client.subscribe).toHaveBeenCalledWith('ahp-terminal:/session-1');
    expect(host.activateAhpTerminalView).toHaveBeenCalledWith('ahp-terminal:/session-1', 'external', 218, 50, undefined);
  });

  it('falls back gracefully when the server snapshot omits cols/rows', async () => {
    const client = makeClient({ snapshot: { state: {} } });
    const host = makeHost(client);
    const confirm = vi.fn().mockResolvedValue(true);

    await attachAhpSessionWithMode(host, makeSession('external', 'pi-ahp-server'), { confirm });

    expect(host.activateAhpTerminalView).toHaveBeenCalledWith('ahp-terminal:/session-1', 'external', undefined, undefined, undefined);
  });

  it('falls back gracefully when client.subscribe returns nothing', async () => {
    const client = makeClient(undefined);
    const host = makeHost(client);
    const confirm = vi.fn().mockResolvedValue(true);

    await attachAhpSessionWithMode(host, makeSession('external', 'pi-ahp-server'), { confirm });

    expect(host.activateAhpTerminalView).toHaveBeenCalledWith('ahp-terminal:/session-1', 'external', undefined, undefined, undefined);
  });

  it('attaches server-spawned sessions in interactive terminal mode without treating them as live-mirror', async () => {
    const client = makeClient({ snapshot: { state: { cols: 120, rows: 30 } } });
    const host = makeHost(client);
    const confirm = vi.fn().mockResolvedValue(true);

    await attachAhpSessionWithMode(host, makeSession('server-spawned', 'pi'), { confirm });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(client.subscribe).toHaveBeenCalledWith('ahp-terminal:/session-1');
    expect(host.activateAhpTerminalView).toHaveBeenCalledWith('ahp-terminal:/session-1', 'server-spawned', 120, 30, undefined);
  });

  it('attaches a session with no terminalMode in interactive terminal mode (terminal is the only mode)', async () => {
    const client = makeClient({ snapshot: { state: { cols: 100, rows: 30, screenText: 'pi> ' } } });
    const host = makeHost(client);
    const confirm = vi.fn().mockResolvedValue(true);
    const notify = vi.fn();

    await attachAhpSessionWithMode(host, makeSession(undefined, 'pi'), { confirm, notify });

    // Terminal mode only: even without a declared terminalMode, attaching
    // subscribes to the terminal channel (the server spawns the pi TUI) and
    // opens the terminal view with the snapshot replayed — never a chat view.
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(client.subscribe).toHaveBeenCalledWith('ahp-terminal:/session-1');
    expect(client.subscribe).not.toHaveBeenCalledWith('ahp-chat:/session-1');
    expect(client.attachSession).not.toHaveBeenCalled();
    expect(host.registerAhpInstance).toHaveBeenCalledWith('Test Session');
    expect(host.activateAhpTerminalView).toHaveBeenCalledWith(
      'ahp-terminal:/session-1',
      'server-spawned',
      100,
      30,
      'pi> ',
    );
    expect(notify).toHaveBeenCalledWith('✓ AHP interactive terminal: ahp-terminal:/session-1', 4000);
  });

  it('attaches in terminal mode even when the session has no terminalMode (provider heuristic is not consulted)', async () => {
    const client = makeClient({ snapshot: { state: { turns: [] } } });
    const host = makeHost(client);
    const confirm = vi.fn().mockResolvedValue(true);
    const notify = vi.fn();

    await attachAhpSessionWithMode(host, makeSession(undefined, 'pi-ahp-server'), { confirm, notify });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(client.subscribe).toHaveBeenCalledWith('ahp-terminal:/session-1');
    expect(client.subscribe).not.toHaveBeenCalledWith('ahp-chat:/session-1');
    expect(host.activateAhpTerminalView).toHaveBeenCalledWith(
      'ahp-terminal:/session-1',
      'server-spawned',
      undefined,
      undefined,
      undefined,
    );
    expect(notify).toHaveBeenCalledWith('✓ AHP interactive terminal: ahp-terminal:/session-1', 4000);
  });

  it('reports no interactive terminal without falling back to chat when the terminal subscribe fails with -32000 (no node-pty)', async () => {
    const client = {
      subscribe: vi.fn().mockRejectedValue(new AhpError(-32000, 'no node-pty available on the server')),
      attachSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as AhpClient;
    const host = makeHost(client);
    const confirm = vi.fn().mockResolvedValue(true);
    const notify = vi.fn();

    await attachAhpSessionWithMode(host, makeSession('server-spawned', 'pi'), { confirm, notify });

    expect(client.subscribe).toHaveBeenCalledWith('ahp-terminal:/session-1');
    // No chat fallback: no chat subscribe, no attachSession, no chat-mode view.
    expect(client.subscribe).not.toHaveBeenCalledWith('ahp-chat:/session-1');
    expect(client.attachSession).not.toHaveBeenCalled();
    expect(host.registerAhpInstance).not.toHaveBeenCalled();
    expect(host.activateAhpTerminalView).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('AHP: no interactive terminal on this server', 6000);
  });

  it('-32002 (session not found) quietly disposes the stale session without a notice', async () => {
    const client = {
      subscribe: vi.fn().mockRejectedValue(new AhpError(-32002, 'session not found')),
      disposeSession: vi.fn().mockResolvedValue(undefined),
      attachSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as AhpClient;
    const host = makeHost(client);
    const confirm = vi.fn().mockResolvedValue(true);
    const notify = vi.fn();

    await attachAhpSessionWithMode(host, makeSession('server-spawned'), { confirm, notify });

    expect(client.disposeSession).toHaveBeenCalledWith('ahp-session:/session-1');
    expect(notify).not.toHaveBeenCalled();
    expect(host.registerAhpInstance).not.toHaveBeenCalled();
    expect(host.activateAhpTerminalView).not.toHaveBeenCalled();
  });

  it('-32007 (auth rejected) surfaces the token-hint notice', async () => {
    const client = {
      subscribe: vi.fn().mockRejectedValue(new AhpError(-32007, 'authentication required')),
      attachSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as AhpClient;
    const host = makeHost(client);
    const confirm = vi.fn().mockResolvedValue(true);
    const notify = vi.fn();

    await attachAhpSessionWithMode(host, makeSession('server-spawned'), { confirm, notify });

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('authentication failed'),
      8000,
    );
    expect(host.activateAhpTerminalView).not.toHaveBeenCalled();
  });

  it('aborts when the user cancels the live-mirror confirmation', async () => {
    const client = makeClient();
    const host = makeHost(client);
    const confirm = vi.fn().mockResolvedValue(false);

    await attachAhpSessionWithMode(host, makeSession('external'), { confirm });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(client.subscribe).not.toHaveBeenCalled();
    expect(client.attachSession).not.toHaveBeenCalled();
    expect(host.activateAhpTerminalView).not.toHaveBeenCalled();
  });

  it('notifies and returns early if the AHP client is missing', async () => {
    const host = makeHost(null);
    const confirm = vi.fn();
    const notify = vi.fn();

    await attachAhpSessionWithMode(host, makeSession('external'), { confirm, notify });

    expect(confirm).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('AHP client not connected', 5000);
  });

  it('replays screenText from the server snapshot into the terminal view', async () => {
    const client = makeClient({ snapshot: { state: { screenText: 'hello screen' } } });
    const host = makeHost(client);
    const confirm = vi.fn().mockResolvedValue(true);

    await attachAhpSessionWithMode(host, makeSession('external', 'pi-ahp-server'), { confirm });

    expect(host.activateAhpTerminalView).toHaveBeenCalledWith('ahp-terminal:/session-1', 'external', undefined, undefined, 'hello screen');
  });

  it('replays a multi-line ANSI screenText string from the server snapshot', async () => {
    const client = makeClient({ snapshot: { state: { screenText: 'before\n/home/user\nafter' } } });
    const host = makeHost(client);
    const confirm = vi.fn().mockResolvedValue(true);

    await attachAhpSessionWithMode(host, makeSession('external', 'pi-ahp-server'), { confirm });

    expect(host.activateAhpTerminalView).toHaveBeenCalledWith('ahp-terminal:/session-1', 'external', undefined, undefined, 'before\n/home/user\nafter');
  });

  it('replays TerminalState.content parts (M2 accumulator) into the terminal view', async () => {
    // M2 server format: TerminalState.content is an array of {type:'unclassified',
    // value} parts (raw PTY data) and {type:'command', output} parts — the
    // subscribe snapshot for external relayed terminals carries exactly this.
    const client = makeClient({
      snapshot: {
        state: {
          cols: 100,
          rows: 30,
          content: [
            { type: 'unclassified', value: 'pi 0.3.0\n' },
            { type: 'unclassified', value: '$ ls -la\n' },
            {
              type: 'command',
              commandId: 'c1',
              commandLine: 'ls -la',
              output: 'drwxr-xr-x',
              timestamp: 1,
              isComplete: true,
            },
          ],
        },
      },
    });
    const host = makeHost(client);
    const confirm = vi.fn().mockResolvedValue(true);

    await attachAhpSessionWithMode(host, makeSession('external', 'pi-ahp-server'), { confirm });

    expect(host.activateAhpTerminalView).toHaveBeenCalledWith(
      'ahp-terminal:/session-1',
      'external',
      100,
      30,
      'pi 0.3.0\n$ ls -la\ndrwxr-xr-x',
    );
  });

  it('falls back to undefined content when the server snapshot omits screenText entirely', async () => {
    const client = makeClient({ snapshot: { state: { cols: 80, rows: 24 } } });
    const host = makeHost(client);
    const confirm = vi.fn().mockResolvedValue(true);

    await attachAhpSessionWithMode(host, makeSession('external', 'pi-ahp-server'), { confirm });

    expect(host.activateAhpTerminalView).toHaveBeenCalledWith('ahp-terminal:/session-1', 'external', 80, 24, undefined);
  });

  it('falls back to undefined content when the server snapshot screenText is empty', async () => {
    const client = makeClient({ snapshot: { state: { screenText: '' } } });
    const host = makeHost(client);
    const confirm = vi.fn().mockResolvedValue(true);

    await attachAhpSessionWithMode(host, makeSession('external', 'pi-ahp-server'), { confirm });

    expect(host.activateAhpTerminalView).toHaveBeenCalledWith('ahp-terminal:/session-1', 'external', undefined, undefined, undefined);
  });
});

describe('createHostedAhpSession', () => {
  it('subscribes to the terminal channel and opens interactive terminal mode for a new hosted session', async () => {
    const client = makeClient({ snapshot: { state: { cols: 120, rows: 30 } } });
    const host = makeHost(client);

    await createHostedAhpSession(host, 'ahp-session:/new-hosted', 'New Hosted', client);

    expect(client.subscribe).toHaveBeenCalledWith('ahp-session:/new-hosted');
    expect(client.subscribe).toHaveBeenCalledWith('ahp-terminal:/new-hosted');
    expect(host.registerAhpInstance).toHaveBeenCalledWith('New Hosted');
    expect(host.activateAhpTerminalView).toHaveBeenCalledWith(
      'ahp-terminal:/new-hosted',
      'server-spawned',
      120,
      30,
      undefined,
    );
  });

  it('passes initial screen text from the terminal subscribe snapshot to the view', async () => {
    const client = makeClient({ snapshot: { state: { cols: 80, rows: 24, screenText: 'welcome\npi>' } } });
    const host = makeHost(client);

    await createHostedAhpSession(host, 'ahp-session:/new-hosted', 'New Hosted', client);

    expect(host.activateAhpTerminalView).toHaveBeenCalledWith(
      'ahp-terminal:/new-hosted',
      'server-spawned',
      80,
      24,
      'welcome\npi>',
    );
  });

  it('does not attach or subscribe to the chat channel for a new hosted session', async () => {
    const client = makeClient();
    const host = makeHost(client);

    await createHostedAhpSession(host, 'ahp-session:/new-hosted', 'New Hosted', client);

    expect(client.attachSession).not.toHaveBeenCalled();
    expect(client.subscribe).not.toHaveBeenCalledWith('ahp-chat:/new-hosted');
  });
});

describe('extractTerminalSnapshot', () => {
  it('extracts cols, rows, and screenText from a wrapped server snapshot', () => {
    const result = extractTerminalSnapshot({ snapshot: { state: { cols: 100, rows: 40, screenText: 'hello' } } });
    expect(result).toEqual({ initialCols: 100, initialRows: 40, initialContent: 'hello' });
  });

  it('treats an empty screenText as undefined content', () => {
    const result = extractTerminalSnapshot({ snapshot: { state: { cols: 80, rows: 24, screenText: '' } } });
    expect(result).toEqual({ initialCols: 80, initialRows: 24, initialContent: undefined });
  });

  it('returns undefined values when the snapshot is missing state', () => {
    const result = extractTerminalSnapshot({});
    expect(result).toEqual({ initialCols: undefined, initialRows: undefined, initialContent: undefined });
  });

  it('concatenates TerminalState.content unclassified parts into the initial content', () => {
    const result = extractTerminalSnapshot({
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
    });
    expect(result).toEqual({
      initialCols: 120,
      initialRows: 40,
      initialContent: 'pi 0.3.0\n$ git status\nOn branch feature/farm-view',
    });
  });

  it('returns undefined content for an empty content array', () => {
    const result = extractTerminalSnapshot({ snapshot: { state: { content: [] } } });
    expect(result).toEqual({ initialCols: undefined, initialRows: undefined, initialContent: undefined });
  });

  it('prefers legacy screenText over content when both are present', () => {
    const result = extractTerminalSnapshot({
      snapshot: {
        state: {
          screenText: 'legacy',
          content: [{ type: 'unclassified', value: 'accumulated' }],
        },
      },
    });
    expect(result.initialContent).toBe('legacy');
  });

  it('skips non-string / malformed content parts defensively', () => {
    const result = extractTerminalSnapshot({
      snapshot: {
        state: {
          content: [
            { type: 'unclassified', value: 'ok\n' },
            { type: 'unclassified' },
            null,
            'raw string',
          ],
        },
      },
    });
    expect(result.initialContent).toBe('ok\n');
  });
});
