/**
 * Deterministic PTY-mode tests for AhpTerminalAdapter. A fake terminal captures
 * every write(); a fake client feeds terminal channel actions so these tests
 * assert the server-authoritative terminal rendering.
 */

import { describe, expect, it } from 'vitest';
import { AhpTerminalAdapter, type AhpTerminalIconState } from './AhpTerminalAdapter';
import type { AhpTerminalApi, ActionEnvelope, URI } from './AhpClient';

/** Strip ANSI SGR escape sequences so assertions match visible text. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

interface FakeTerm {
  out: string;
  writes: string[];
  cleared: boolean;
  resized: Array<{ cols: number; rows: number }>;
  write(s: string): void;
  clear(): void;
  resize(cols: number, rows: number): void;
  onData(cb: (d: string) => void): { dispose(): void };
}

function makeFakeTerm(): FakeTerm {
  return {
    out: '',
    writes: [],
    cleared: false,
    resized: [],
    write(s: string) { this.out += s; this.writes.push(s); },
    clear() { this.cleared = true; },
    resize(cols: number, rows: number) { this.resized.push({ cols, rows }); },
    onData(cb) { dataCb = cb; return { dispose() { /* noop */ } }; },
  };
}

let dataCb: ((d: string) => void) | null = null;

function terminalHarness(
  terminalUri = 'ahp-terminal:/pi-test',
  terminalMode?: 'external' | 'server-spawned' | 'none',
  clientId = 'obsidian-client',
  readOnly = false,
): {
  adapter: AhpTerminalAdapter;
  term: FakeTerm;
  inputs: { uri: string; data: string }[];
  resizes: { uri: string; cols: number; rows: number }[];
  fireAction: (channel: string, action: Record<string, unknown>, origin?: { clientId: string; clientSeq: number }) => void;
  type: (d: string) => void;
  states: AhpTerminalIconState[];
} {
  let actionCb: ((params: Record<string, unknown>) => void) | null = null;
  const inputs: { uri: string; data: string }[] = [];
  const resizes: { uri: string; cols: number; rows: number }[] = [];
  const states: AhpTerminalIconState[] = [];
  const term = makeFakeTerm();
  const client = {
    clientId,
    prompt() { return Promise.resolve(); },
    onEvent() { return () => {}; },
    onNotification(method: string, handler: (params: Record<string, unknown>) => void) {
      if (method === 'action') actionCb = handler;
      return () => { actionCb = null; };
    },
    dispatchAction(channel: URI, action: Record<string, unknown>) { return { clientSeq: 1 }; },
    subscribe(channel: URI) { return Promise.resolve({}); },
    sendTerminalInput(uri: URI, data: string) { inputs.push({ uri, data }); },
    resizeTerminal(uri: URI, cols: number, rows: number) { resizes.push({ uri, cols, rows }); },
  };
  const adapter = new AhpTerminalAdapter(
    term as unknown as import('@xterm/xterm').Terminal,
    client as unknown as AhpTerminalApi,
    (s) => states.push(s),
    { terminalUri, terminalMode, readOnly },
  );
  adapter.attach();
  term.out = '';
  return {
    adapter,
    term,
    inputs,
    resizes,
    fireAction: (channel: string, action: Record<string, unknown>, origin = { clientId: 'remote-client', clientSeq: 1 }) => {
      const envelope = { channel, action, serverSeq: 1, origin } as unknown as ActionEnvelope;
      actionCb?.(envelope as unknown as Record<string, unknown>);
    },
    type: (d) => dataCb?.(d),
    states,
  };
}

describe('AhpTerminalAdapter', () => {
  describe('terminal mode', () => {
    it('writes server-authoritative terminal/data to xterm', () => {
      const h = terminalHarness();
      h.fireAction('ahp-terminal:/pi-test', { type: 'terminal/data', data: 'hello pty' });
      expect(h.term.writes[h.term.writes.length - 1]).toBe('hello pty');
      expect(stripAnsi(h.term.out)).toContain('hello pty');
    });

    it('ignores chat RpcEvents in terminal mode', () => {
      const h = terminalHarness();
      const before = h.term.out;
      h.fireAction('ahp-terminal:/pi-test', { type: 'chat/delta', content: 'should not render' });
      h.fireAction('ahp-terminal:/pi-test', { type: 'chat/turnStarted', turnId: 't1', message: { text: 'x' } });
      expect(h.term.out).toBe(before);
    });

    it('forwards raw keystrokes via sendTerminalInput, not client.prompt', () => {
      const h = terminalHarness();
      h.type('ls -la\r');
      expect(h.inputs).toEqual([{ uri: 'ahp-terminal:/pi-test', data: 'ls -la\r' }]);
    });

    it('clears the screen on terminal/cleared', () => {
      const h = terminalHarness();
      h.fireAction('ahp-terminal:/pi-test', { type: 'terminal/cleared' });
      expect(h.term.cleared).toBe(true);
    });

    it('sets the xterm title on terminal/titleChanged', () => {
      const h = terminalHarness();
      h.fireAction('ahp-terminal:/pi-test', { type: 'terminal/titleChanged', title: 'my-pty' });
      expect(h.term.writes[h.term.writes.length - 1]).toContain('\x1b]0;my-pty\x07');
    });

    it('writes a dim exit line and sets state idle on terminal/exited', () => {
      const h = terminalHarness();
      h.fireAction('ahp-terminal:/pi-test', { type: 'terminal/exited', code: 42 });
      expect(stripAnsi(h.term.out)).toContain('remote terminal exited (code 42)');
      expect(h.states[h.states.length - 1]).toBe('idle');
    });

    it('resizes the local xterm on terminal/resized', () => {
      const h = terminalHarness();
      h.fireAction('ahp-terminal:/pi-test', { type: 'terminal/resized', cols: 100, rows: 40 });
      expect(h.term.resized).toEqual([{ cols: 100, rows: 40 }]);
    });

    it('does not re-apply a self-echoed terminal/resized action (avoids flicker loop)', () => {
      const h = terminalHarness('ahp-terminal:/pi-test', undefined, 'self-client');
      h.fireAction(
        'ahp-terminal:/pi-test',
        { type: 'terminal/resized', cols: 100, rows: 40 },
        { clientId: 'self-client', clientSeq: 1 },
      );
      expect(h.term.resized).toEqual([]);
    });

    it('still resizes on terminal/resized from a different client (supervisor PTY resize)', () => {
      const h = terminalHarness('ahp-terminal:/pi-test', undefined, 'self-client');
      h.fireAction(
        'ahp-terminal:/pi-test',
        { type: 'terminal/resized', cols: 120, rows: 50 },
        { clientId: 'supervisor-client', clientSeq: 7 },
      );
      expect(h.term.resized).toEqual([{ cols: 120, rows: 50 }]);
    });

    it('ignores malformed terminal/resized values', () => {
      const h = terminalHarness();
      h.fireAction('ahp-terminal:/pi-test', { type: 'terminal/resized', cols: -1, rows: 0 });
      h.fireAction('ahp-terminal:/pi-test', { type: 'terminal/resized', cols: 'abc', rows: 'def' });
      expect(h.term.resized).toEqual([]);
    });

    it('dispatches resize requests uniformly for all terminal modes', () => {
      const external = terminalHarness('ahp-terminal:/pi-test', 'external');
      external.adapter.resize(80, 24);
      expect(external.resizes).toEqual([{ uri: 'ahp-terminal:/pi-test', cols: 80, rows: 24 }]);

      const serverSpawned = terminalHarness('ahp-terminal:/pi-test', 'server-spawned');
      serverSpawned.adapter.resize(80, 24);
      expect(serverSpawned.resizes).toEqual([{ uri: 'ahp-terminal:/pi-test', cols: 80, rows: 24 }]);

      const legacy = terminalHarness('ahp-terminal:/pi-test');
      legacy.adapter.resize(100, 30);
      expect(legacy.resizes).toEqual([{ uri: 'ahp-terminal:/pi-test', cols: 100, rows: 30 }]);
    });

    it('does not forward keystrokes in read-only terminal mode', () => {
      const h = terminalHarness('ahp-terminal:/pi-test', undefined, 'obsidian-client', true);
      h.type('ls -la\r');
      expect(h.inputs).toEqual([]);
    });

    it('shows a read-only banner and still renders terminal/data', () => {
      const h = terminalHarness('ahp-terminal:/pi-test', undefined, 'obsidian-client', true);
      expect(stripAnsi(h.term.writes[0] ?? '')).toContain('Read-only mirror of subagent terminal');
      h.fireAction('ahp-terminal:/pi-test', { type: 'terminal/data', data: 'live output' });
      expect(h.term.writes[h.term.writes.length - 1]).toBe('live output');
    });
  });
});
