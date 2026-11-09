/**
 * Tests for the pure `pi:render-canvas` APC protocol logic used by both the
 * plugin-side PtyClient and the pi-side extension.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  RenderCanvasRpc,
  encodeRenderCanvasRequest,
  encodeRenderCanvasResult,
} from './renderCanvasProtocol';

const FAKE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('encodeRenderCanvasRequest', () => {
  it('produces a well-formed ST-terminated APC marker', () => {
    const marker = encodeRenderCanvasRequest('r1', 'diagrams/map.canvas');
    expect(marker.startsWith('\x1b_pi:render-canvas:')).toBe(true);
    expect(marker.endsWith('\x1b\\')).toBe(true);

    const b64 = marker.slice('\x1b_pi:render-canvas:'.length, -'\x1b\\'.length);
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    expect(payload).toEqual({ requestId: 'r1', canvasPath: 'diagrams/map.canvas' });
  });
});

describe('encodeRenderCanvasResult', () => {
  it('produces a well-formed ST-terminated APC marker', () => {
    const marker = encodeRenderCanvasResult({
      requestId: 'r1',
      success: true,
      pngB64: FAKE_PNG.toString('base64'),
    });
    expect(marker.startsWith('\x1b_pi:render-canvas-result:')).toBe(true);
    expect(marker.endsWith('\x1b\\')).toBe(true);
  });
});

describe('RenderCanvasRpc round-trip', () => {
  it('resolves with the PNG bytes when the matching result marker arrives', async () => {
    const writer = vi.fn();
    const rpc = new RenderCanvasRpc(writer);

    const promise = rpc.requestCapture('diagrams/map.canvas', { requestId: 'r1' });
    expect(writer).toHaveBeenCalledTimes(1);
    const requestMarker = writer.mock.calls[0][0] as string;
    expect(requestMarker).toContain('pi:render-canvas:');

    const resultMarker = encodeRenderCanvasResult({
      requestId: 'r1',
      success: true,
      pngB64: FAKE_PNG.toString('base64'),
    });
    const payload = resultMarker.slice('\x1b_pi:render-canvas-result:'.length, -'\x1b\\'.length);
    expect(rpc.handleResultPayload(payload)).toBe(true);

    const png = await promise;
    expect(png).toEqual(FAKE_PNG);
    expect(rpc.pendingCount).toBe(0);
  });

  it('rejects when the plugin reports a capture error', async () => {
    const rpc = new RenderCanvasRpc(vi.fn());
    const promise = rpc.requestCapture('diagrams/map.canvas', { requestId: 'r2' });

    const resultMarker = encodeRenderCanvasResult({
      requestId: 'r2',
      success: false,
      error: 'Canvas file not found',
    });
    const payload = resultMarker.slice('\x1b_pi:render-canvas-result:'.length, -'\x1b\\'.length);
    expect(rpc.handleResultPayload(payload)).toBe(true);

    await expect(promise).rejects.toThrow('Canvas file not found');
    expect(rpc.pendingCount).toBe(0);
  });

  it('rejects after the timeout when no result arrives', async () => {
    const rpc = new RenderCanvasRpc(vi.fn());
    const promise = rpc.requestCapture('diagrams/map.canvas', {
      requestId: 'r3',
      timeoutMs: 10,
    });

    await expect(promise).rejects.toThrow('Timed out waiting for obsidian canvas capture');
    expect(rpc.pendingCount).toBe(0);
  });

  it('returns false for an unknown result payload', () => {
    const rpc = new RenderCanvasRpc(vi.fn());
    rpc.requestCapture('diagrams/map.canvas', { requestId: 'known' });
    const marker = encodeRenderCanvasResult({
      requestId: 'unknown',
      success: true,
      pngB64: FAKE_PNG.toString('base64'),
    });
    const payload = marker.slice('\x1b_pi:render-canvas-result:'.length, -'\x1b\\'.length);
    expect(rpc.handleResultPayload(payload)).toBe(false);
    expect(rpc.pendingCount).toBe(1);
  });
});

describe('obsidian-bridge.ts plugin-release safety', () => {
  const bridgePath = resolve(__dirname, '../../extensions/obsidian-bridge.ts');
  const bridgeSrc = readFileSync(bridgePath, 'utf8');

  it('has no static imports from ../src/', () => {
    expect(bridgeSrc).not.toMatch(/from "\.\.\/src\//);
  });

  it('has no static import from "typebox"', () => {
    expect(bridgeSrc).not.toMatch(/from "typebox"/);
  });

  it('has no require("sharp") or require(\'sharp\')', () => {
    expect(bridgeSrc).not.toMatch(/require\(['"]sharp['"]\)/);
  });

  it('keeps the ../src/ canvas renderer reference as a lazy dynamic import only', () => {
    // The only reference to ../src/canvas/renderCanvas must be inside a dynamic import().
    const matches = bridgeSrc.match(/\.\.\/src\/canvas\/renderCanvas/g) ?? [];
    expect(matches.length).toBe(1);
    expect(bridgeSrc).toContain('await import("../src/canvas/renderCanvas")');
  });
});
