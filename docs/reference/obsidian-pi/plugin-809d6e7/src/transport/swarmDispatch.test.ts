/**
 * Unit tests for swarmDispatch — the Farm View "Dispatch task" transport.
 * Covers the pure helpers (shell quoting, ANSI stripping, answer extraction)
 * and the full headless broker flow against a fake WebSocket that simulates
 * the broker's terminal/data + terminal/exited relay.
 */

import { describe, expect, it, afterEach } from 'vitest';
import {
  dispatchTaskToWorker,
  extractAnswer,
  looksInteractive,
  shq,
  stripAnsi,
} from './swarmDispatch';

const TERMINAL_URI = 'ahp-terminal:/ext-arthur-arthur-default';

/** Minimal fake WebSocket that auto-responds to the broker RPC flow. */
class FakeWebSocket {
  static OPEN = 1;
  readyState = 1;
  private _onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {}

  /** Fire onopen on the next microtask once the client assigns it. */
  set onopen(fn: (() => void) | null) {
    this._onopen = fn;
    queueMicrotask(() => this._onopen?.());
  }

  get onopen(): (() => void) | null {
    return this._onopen;
  }

  send(raw: string): void {
    this.sent.push(raw);
    const msg = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> };
    if (msg.method === 'initialize') {
      this.respond(msg.id, {});
    } else if (msg.method === 'subscribe' && msg.params.channel === 'ahp-root://') {
      this.respond(msg.id, {
        snapshot: { state: { terminals: [{ resource: TERMINAL_URI, title: 'arthur default' }] } },
      });
    } else if (msg.method === 'subscribe') {
      // Terminal subscribe (with command) → stream headless output, then exit.
      this.respond(msg.id, {});
      this.emitAction({ type: 'terminal/data', data: 'pi v0.1.0\nReply with exactly: ok\narthur-swarm-ok\n' });
      this.emitAction({ type: 'terminal/exited', exitCode: 0 });
    }
  }

  private respond(id: number, result: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id, result }) });
  }

  private emitAction(action: Record<string, unknown>): void {
    this.onmessage?.({
      data: JSON.stringify({ jsonrpc: '2.0', method: 'action', params: { channel: TERMINAL_URI, action } }),
    });
  }

  close(): void {
    this.readyState = 3;
  }
}

afterEach(() => {
  delete (globalThis as unknown as { WebSocket?: unknown }).WebSocket;
});

describe('swarmDispatch helpers', () => {
  it('shq single-quotes and escapes embedded quotes', () => {
    expect(shq('hello world')).toBe("'hello world'");
    expect(shq("it's a test")).toBe("'it'\\''s a test'");
  });

  it('stripAnsi removes SGR sequences, CRs, and bells', () => {
    expect(stripAnsi('\x1b[32mgreen\x1b[0m\r\n')).toBe('green\n');
  });

  it('looksInteractive detects the pi TUI chrome', () => {
    expect(looksInteractive('─── ⬡ pi v0.1')).toBe(true);
    expect(looksInteractive('clean headless log line')).toBe(false);
  });

  it('extractAnswer returns the meaningful lines after the task echo', () => {
    const clean = 'pi v0.1.0\nReply with exactly: ok\narthur-swarm-ok\n';
    expect(extractAnswer(clean, 'Reply with exactly: ok')).toBe('arthur-swarm-ok');
  });
});

describe('dispatchTaskToWorker', () => {
  it('streams the headless result via the broker relay', async () => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    const result = await dispatchTaskToWorker({
      brokerUrl: 'ws://test:4500',
      pool: 'arthur',
      task: 'Reply with exactly: ok',
    });
    expect(result.error).toBeUndefined();
    expect(result.timedOut).toBe(false);
    expect(result.interactiveFallback).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.terminalUri).toBe(TERMINAL_URI);
    expect(result.text).toBe('arthur-swarm-ok');
  });

  it('reports a missing terminal for an unknown pool', async () => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    const result = await dispatchTaskToWorker({
      brokerUrl: 'ws://test:4500',
      pool: 'nobody',
      task: 'hi',
    });
    expect(result.error).toContain("no external terminal for pool 'nobody'");
    expect(result.terminalUri).toBe('');
  });
});
