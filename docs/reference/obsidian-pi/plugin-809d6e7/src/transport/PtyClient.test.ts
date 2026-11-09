/**
 * Unit tests for PtyClient's reverse-APC (`pi:text:`) response interception —
 * specifically the chunk-boundary reassembly logic, which must handle payloads
 * far longer than a single PTY chunk. No PTY is spawned: the private
 * stripApcTextResponse path is exercised directly.
 */

import { describe, expect, it, vi } from 'vitest';

// PtyClient → ../binary → 'obsidian' (not resolvable outside the app) — mock it.
vi.mock('../binary', () => ({
  findNodeExecutable: vi.fn(async () => undefined),
}));

import { PtyClient } from './PtyClient';

const APC = '\x1b_';
const ST = '\x1b\\';

function makeClient(): PtyClient {
  return new PtyClient({
    bridgeExtensionPath: '/fake/bridge.ts',
    nodePtyPath: '/fake/node-pty',
  });
}

/** Access the private strip method + pending-request plumbing. */
function harness(client: PtyClient) {
  const c = client as unknown as {
    pendingTextResolve: ((text: string) => void) | null;
    pendingTextReject: ((err: Error) => void) | null;
    apcScanRemainder: string;
    stripApcTextResponse(data: string): string;
    cancelPendingTextRequest(): void;
  };
  let resolved: string | null = null;
  c.pendingTextResolve = (text: string) => { resolved = text; };
  c.pendingTextReject = () => {};
  return {
    feed: (data: string) => c.stripApcTextResponse(data),
    getResolved: () => resolved,
    getRemainder: () => c.apcScanRemainder,
  };
}

describe('PtyClient APC pi:text response interception', () => {
  it('passes data through untouched when no request is pending', () => {
    const client = makeClient();
    const c = client as unknown as { stripApcTextResponse(d: string): string };
    const data = 'plain terminal output ' + APC + 'pi:text:AAAA' + ST;
    expect(c.stripApcTextResponse(data)).toBe(data);
  });

  it('resolves and strips a complete marker in a single chunk', () => {
    const client = makeClient();
    const h = harness(client);
    const text = 'hello world';
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    const out = h.feed('before' + APC + 'pi:text:' + b64 + ST + 'after');
    expect(out).toBe('beforeafter');
    expect(h.getResolved()).toBe(text);
  });

  it('reassembles a marker split mid-payload across chunks (long payload)', () => {
    const client = makeClient();
    const h = harness(client);
    // Long editor text → base64 payload much larger than the marker prefix,
    // split at an arbitrary point well past an 11-char tail window.
    const text = 'x'.repeat(5000);
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    const marker = APC + 'pi:text:' + b64 + ST;
    const splitAt = marker.length - 100; // mid-payload

    const out1 = h.feed('leading output' + marker.slice(0, splitAt));
    expect(out1).toBe('leading output'); // partial marker held back
    expect(h.getRemainder().length).toBeGreaterThan(0);

    const out2 = h.feed(marker.slice(splitAt) + 'trailing');
    expect(out2).toBe('trailing');
    expect(h.getResolved()).toBe(text);
  });

  it('reassembles a marker split inside the prefix itself', () => {
    const client = makeClient();
    const h = harness(client);
    const text = 'abc';
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    const marker = APC + 'pi:text:' + b64 + ST;

    const out1 = h.feed('out' + marker.slice(0, 4)); // "\x1b_pi"
    expect(out1).toBe('out');
    const out2 = h.feed(marker.slice(4));
    expect(out2).toBe('');
    expect(h.getResolved()).toBe(text);
  });

  it('reassembles when the chunk ends on a lone ESC byte', () => {
    const client = makeClient();
    const h = harness(client);
    const text = 'ok';
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    const marker = APC + 'pi:text:' + b64 + ST;

    const out1 = h.feed('data' + '\x1b'); // could be the start of ESC _
    expect(out1).toBe('data');
    const out2 = h.feed(marker.slice(1)); // rest of the marker
    expect(out2).toBe('');
    expect(h.getResolved()).toBe(text);
  });

  it('forwards a non-marker APC sequence unchanged while a request is pending', () => {
    const client = makeClient();
    const h = harness(client);
    const other = APC + 'other-apc-payload' + ST;
    expect(h.feed(other)).toBe(other);
    expect(h.getResolved()).toBe(null);
  });
});

describe('PtyClient paste-mode sanitization', () => {
  it('strips ESC bytes so note content cannot break out of the bracketed paste', () => {
    const client = new PtyClient(
      { bridgeExtensionPath: '/fake/bridge.ts', nodePtyPath: '/fake/node-pty' },
      'paste',
    );
    const written: string[] = [];
    (client as unknown as { proc: { write(d: string): void } }).proc = {
      write: (d: string) => written.push(d),
    } as never;

    // Malicious note content embedding paste-end + injected keystrokes.
    client.submitPrompt('safe text \x1b[201~rm -rf /\r\x1b[200~ more');

    expect(written).toHaveLength(1);
    const payload = written[0];
    // Exactly one paste-start at the beginning and one paste-end before \r.
    expect(payload.startsWith('\x1b[200~')).toBe(true);
    expect(payload.endsWith('\x1b[201~\r')).toBe(true);
    const inner = payload.slice('\x1b[200~'.length, -'\x1b[201~\r'.length);
    expect(inner).not.toContain('\x1b');
  });
});

describe('PtyClient APC pi:render-canvas request handling', () => {
  const FAKE_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  function harness(client: PtyClient) {
    const c = client as unknown as {
      proc: { write: (d: string) => void };
      stripApcRenderCanvasRequest(data: string): string;
    };
    const written: string[] = [];
    c.proc = { write: (d: string) => written.push(d) } as never;
    return {
      feed: (data: string) => c.stripApcRenderCanvasRequest(data),
      getWritten: () => written,
    };
  }

  function makeRequestMarker(requestId: string, canvasPath: string): string {
    const payload = JSON.stringify({ requestId, canvasPath });
    const b64 = Buffer.from(payload, 'utf8').toString('base64');
    return APC + 'pi:render-canvas:' + b64 + ST;
  }

  it('calls the registered handler and writes a result marker with the PNG', async () => {
    const client = makeClient();
    client.setRenderCanvasHandler(async (path) => {
      expect(path).toBe('diagrams/map.canvas');
      return FAKE_PNG;
    });
    const h = harness(client);

    const out = h.feed('leading' + makeRequestMarker('r1', 'diagrams/map.canvas') + 'trailing');
    expect(out).toBe('leadingtrailing');

    // The handler is async, so wait for the result marker to be written.
    await new Promise((r) => setTimeout(r, 10));

    const written = h.getWritten();
    expect(written).toHaveLength(1);
    const marker = written[0];
    expect(marker.startsWith(APC + 'pi:render-canvas-result:')).toBe(true);
    expect(marker.endsWith(ST)).toBe(true);

    const b64 = marker.slice((APC + 'pi:render-canvas-result:').length, -ST.length);
    const result = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    expect(result).toMatchObject({ requestId: 'r1', success: true });
    expect(Buffer.from(result.pngB64, 'base64')).toEqual(FAKE_PNG);
  });

  it('writes an error result marker when the handler rejects', async () => {
    const client = makeClient();
    client.setRenderCanvasHandler(async () => {
      throw new Error('capture exploded');
    });
    const h = harness(client);

    h.feed(makeRequestMarker('r2', 'diagrams/bad.canvas'));
    await new Promise((r) => setTimeout(r, 10));

    const marker = h.getWritten()[0];
    const b64 = marker.slice((APC + 'pi:render-canvas-result:').length, -ST.length);
    const result = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    expect(result).toEqual({ requestId: 'r2', success: false, error: 'capture exploded' });
  });

  it('reassembles a request marker split across chunks', async () => {
    const client = makeClient();
    client.setRenderCanvasHandler(async () => FAKE_PNG);
    const h = harness(client);

    const marker = makeRequestMarker('r3', 'diagrams/split.canvas');
    const splitAt = marker.length - 10;

    const out1 = h.feed('start' + marker.slice(0, splitAt));
    expect(out1).toBe('start');

    const out2 = h.feed(marker.slice(splitAt) + 'end');
    expect(out2).toBe('end');

    await new Promise((r) => setTimeout(r, 10));
    const marker2 = h.getWritten()[0];
    const b64 = marker2.slice((APC + 'pi:render-canvas-result:').length, -ST.length);
    const result = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    expect(result.requestId).toBe('r3');
  });

  it('ignores a request marker when no handler is registered', () => {
    const client = makeClient();
    const h = harness(client);
    const out = h.feed(makeRequestMarker('r4', 'diagrams/ignored.canvas') + 'after');
    expect(out).toBe('after');
    expect(h.getWritten()).toHaveLength(0);
  });
});
