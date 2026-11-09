/**
 * Unit tests for RpcClient's id-correlation and event dispatch, using a mocked
 * `child_process.spawn` so no real `pi` subprocess is spawned.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mock child_process.spawn with a controllable fake child ────────────────

class FakeStdin extends EventEmitter {
  destroyed = false;
  written: string[] = [];
  write(data: string) { this.written.push(data); }
}

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = new FakeStdin();
  exitCode: number | null = null;
  killed = false;
  kill(_signal?: string) {
    this.killed = true;
  }
}

let lastChild: FakeChildProcess;
function defaultSpawn(): FakeChildProcess {
  lastChild = new FakeChildProcess();
  return lastChild;
}
const spawnMock = vi.fn((...args: unknown[]) => {
  lastChild = new FakeChildProcess();
  return lastChild;
});

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...(args as [])),
}));

// Avoid real filesystem/PATH lookups in ensureNodeOnPath().
vi.mock('../binary', () => ({
  findNodeExecutable: vi.fn(async () => undefined),
}));

import { RpcClient } from './RpcClient';

const FAKE_BINARY = { path: '/fake/pi', version: '1.0.0' };
/** Mirrors RpcClient's private STARTUP_SETTLE_MS — used to advance fake timers. */
const STARTUP_SETTLE_MS = 100;

function send(child: FakeChildProcess, obj: unknown): void {
  child.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'));
}

/** Parse all JSONL lines written to stdin so far. */
function writtenCommands(child: FakeChildProcess): Array<Record<string, unknown>> {
  return child.stdin.written.map((l) => JSON.parse(l));
}

describe('RpcClient', () => {
  beforeEach(() => {
    spawnMock.mockClear();
  });

  it('spawns the subprocess and reaches "connected" state', async () => {
    const client = new RpcClient({ binaryInfo: FAKE_BINARY });
    const states: string[] = [];
    client.onStateChange((s) => states.push(s));

    await client.connect();

    expect(client.state).toBe('connected');
    expect(states).toContain('connecting');
    expect(states).toContain('connected');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('correlates a command with its response by id', async () => {
    const client = new RpcClient({ binaryInfo: FAKE_BINARY });
    await client.connect();

    const promise = client.getCommands();

    // The command written to stdin should carry a generated id.
    const [cmd] = writtenCommands(lastChild);
    expect(cmd.type).toBe('get_commands');
    expect(typeof cmd.id).toBe('string');

    // Reply with a matching response.
    send(lastChild, { type: 'response', id: cmd.id, success: true, data: { commands: [{ name: 'model' }] } });

    const commands = await promise;
    expect(commands[0].name).toBe('model');
  });

  it('rejects the command promise on an error response', async () => {
    const client = new RpcClient({ binaryInfo: FAKE_BINARY });
    await client.connect();

    const promise = client.getCommands();
    const [cmd] = writtenCommands(lastChild);
    send(lastChild, { type: 'response', id: cmd.id, success: false, error: 'boom' });

    await expect(promise).rejects.toThrow('boom');
  });

  it('does not resolve a command with a mismatched id', async () => {
    const client = new RpcClient({ binaryInfo: FAKE_BINARY });
    await client.connect();

    const promise = client.getCommands();
    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });

    send(lastChild, { type: 'response', id: 'not-the-real-id', success: true, data: {} });
    await new Promise((r) => setTimeout(r, 10));

    expect(settled).toBe(false);
  });

  it('dispatches agent events to onEvent listeners (no id, streamed async)', async () => {
    const client = new RpcClient({ binaryInfo: FAKE_BINARY });
    await client.connect();

    const events: unknown[] = [];
    client.onEvent((ev) => events.push(ev));

    send(lastChild, { type: 'agent_start' });
    send(lastChild, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } });

    expect(events).toEqual([
      { type: 'agent_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } },
    ]);
  });

  it('routes extension_ui_request lines as plain events (no UI sub-protocol handling)', async () => {
    const client = new RpcClient({ binaryInfo: FAKE_BINARY });
    await client.connect();

    const events: unknown[] = [];
    client.onEvent((ev) => events.push(ev));

    send(lastChild, { type: 'extension_ui_request', id: 'ui1', method: 'confirm', message: 'Proceed?' });

    // No dedicated UI routing anymore — the line is just another stdout event
    // that no listener acts on. The PTY/AHP terminal flows handle UI via APC
    // markers in the obsidian-bridge extension.
    expect(events).toEqual([{ type: 'extension_ui_request', id: 'ui1', method: 'confirm', message: 'Proceed?' }]);
  });

  it('rejects all pending commands when the process exits unexpectedly', async () => {
    const client = new RpcClient({ binaryInfo: FAKE_BINARY });
    await client.connect();

    const promise = client.getCommands();
    lastChild.emit('exit', 1, null);

    await expect(promise).rejects.toThrow();
  });

  it('rejects pending commands and stops the subprocess on dispose()', async () => {
    const client = new RpcClient({ binaryInfo: FAKE_BINARY });
    await client.connect();

    const promise = client.getCommands();
    const disposePromise = client.dispose();
    lastChild.emit('exit', 0, null); // simulate graceful shutdown ack

    await disposePromise;
    await expect(promise).rejects.toThrow();
    expect(client.state).toBe('disconnected');
  });

  it('rejects sending a command while not connected', async () => {
    const client = new RpcClient({ binaryInfo: FAKE_BINARY });
    await expect(client.getCommands()).rejects.toThrow(/not connected/);
  });

  it('does NOT restart after a clean exit (code 0, no signal)', async () => {
    const client = new RpcClient({ binaryInfo: FAKE_BINARY });
    await client.connect();

    const states: string[] = [];
    client.onStateChange((s) => states.push(s));

    lastChild.emit('exit', 0, null); // intentional shutdown
    await new Promise((r) => setTimeout(r, 10));

    expect(client.state).toBe('disconnected');
    expect(states).not.toContain('reconnecting');
    expect(spawnMock).toHaveBeenCalledTimes(1); // no respawn
  });

  it('schedules a restart after a crash exit (non-zero code)', async () => {
    const client = new RpcClient({ binaryInfo: FAKE_BINARY });
    await client.connect();

    const states: string[] = [];
    client.onStateChange((s) => states.push(s));

    lastChild.emit('exit', 1, null); // crash
    await new Promise((r) => setTimeout(r, 10));

    expect(states).toContain('reconnecting');
    await client.dispose(); // cancel the pending restart timer
  });

  it('caps the retained stderr buffer', async () => {
    const client = new RpcClient({ binaryInfo: FAKE_BINARY });
    await client.connect();

    lastChild.stderr.emit('data', Buffer.from('x'.repeat(20_000)));
    lastChild.stderr.emit('data', Buffer.from('TAIL'));

    const stderr = client.getStderr();
    expect(stderr.length).toBeLessThanOrEqual(8_192);
    expect(stderr.endsWith('TAIL')).toBe(true);
    await client.dispose();
  });

  it('racing connect() callers join the SAME in-flight handshake (AUDIT §3 finding 2)', async () => {
    // A child that dies immediately makes the handshake REJECT — a caller that
    // had short-circuited 'connecting' with a resolved no-op would silently
    // proceed against a half-started subprocess instead of failing with it.
    spawnMock.mockImplementation(() => {
      lastChild = new FakeChildProcess();
      lastChild.exitCode = 1;
      return lastChild;
    });
    const client = new RpcClient({ binaryInfo: FAKE_BINARY });

    const p1 = client.connect();
    const p2 = client.connect(); // arrives while state === 'connecting'

    await expect(p1).rejects.toThrow(/exited immediately/);
    // p2 joined the same in-flight connect instead of resolving early.
    await expect(p2).rejects.toThrow(/exited immediately/);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    spawnMock.mockImplementation(defaultSpawn as never);
  });

  it('connect() during a crash-recovery spawn joins it instead of spawning a second subprocess', async () => {
    vi.useFakeTimers();
    try {
      const client = new RpcClient({ binaryInfo: FAKE_BINARY });
      const first = client.connect();
      await vi.advanceTimersByTimeAsync(STARTUP_SETTLE_MS); // settle → connected
      await first;
      expect(spawnMock).toHaveBeenCalledTimes(1);

      // Crash → 'reconnecting' with a 1s recovery timer.
      lastChild.emit('exit', 1, null);
      // Fire the recovery timer: spawn() runs and parks in its settle delay,
      // leaving an in-flight connectPromise while state === 'connecting'.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(client.state).toBe('connecting');
      expect(spawnMock).toHaveBeenCalledTimes(2);

      // A connect() arriving mid-recovery must JOIN the recovery spawn.
      const p2 = client.connect();
      await vi.advanceTimersByTimeAsync(STARTUP_SETTLE_MS);
      await p2;

      expect(client.state).toBe('connected');
      expect(spawnMock).toHaveBeenCalledTimes(2); // no third spawn
      // dispose() awaits the kill grace timer — advance it under fake timers.
      const disposed = client.dispose();
      await vi.advanceTimersByTimeAsync(1_100);
      await disposed;
    } finally {
      vi.useRealTimers();
    }
  });
});
