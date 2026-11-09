/**
 * Tests for the Node-side Obsidian `.canvas` → SVG → PNG renderer.
 */

import { describe, expect, it } from 'vitest';
import {
  CANVAS_PALETTE,
  renderCanvasJsonToPng,
  renderCanvasToPng,
  renderCanvasToSvg,
} from './renderCanvas';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';

const sampleCanvas = {
  nodes: [
    {
      id: 'group1',
      type: 'group' as const,
      x: 0,
      y: 0,
      width: 320,
      height: 200,
      color: '6',
      label: 'My group',
    },
    {
      id: 'text1',
      type: 'text' as const,
      x: 20,
      y: 40,
      width: 120,
      height: 60,
      color: '1',
      text: 'Hello **world**',
    },
    {
      id: 'file1',
      type: 'file' as const,
      x: 160,
      y: 40,
      width: 140,
      height: 60,
      color: '2',
      file: 'notes/daily.md',
      subpath: '#heading',
    },
    {
      id: 'link1',
      type: 'link' as const,
      x: 40,
      y: 120,
      width: 220,
      height: 50,
      url: 'https://example.com',
    },
  ],
  edges: [
    {
      id: 'e1',
      fromNode: 'text1',
      toNode: 'file1',
      fromSide: 'right' as const,
      toSide: 'left' as const,
      toEnd: 'arrow' as const,
      color: '5',
      label: 'uses',
    },
    {
      id: 'e2',
      fromNode: 'link1',
      toNode: 'text1',
      fromSide: 'top' as const,
      toSide: 'bottom' as const,
      fromEnd: 'arrow' as const,
      toEnd: 'none' as const,
    },
  ],
};

describe('renderCanvasToSvg', () => {
  it('renders all node types and a group behind them', () => {
    const svg = renderCanvasToSvg(sampleCanvas);

    // Group rendered first (before other rects) with label.
    expect(svg).toContain('My group');
    expect(svg).toContain('rx="8"');

    // Node rectangles at correct coordinates.
    expect(svg).toContain('x="20" y="40" width="120" height="60"');
    expect(svg).toContain('x="160" y="40" width="140" height="60"');
    expect(svg).toContain('x="40" y="120" width="220" height="50"');

    // File and link prefixes.
    expect(svg).toContain('📄 daily.md');
    expect(svg).toContain('🔗 https://example.com');

    // Markdown stripped.
    expect(svg).toContain('Hello world');
    expect(svg).not.toContain('**world**');

    // Edge anchor: text1 right side → (20+120, 40+30) = (140, 70).
    expect(svg).toContain('M 140.0 70.0');
    // Edge anchor: file1 left side → (160, 40+30) = (160, 70).
    expect(svg).toContain('160.0 70.0');

    // Arrow marker and edge label.
    expect(svg).toContain('marker-end="url(#arrow)"');
    expect(svg).toContain('uses');

    // Palette colors present (text, edge, group).
    expect(svg).toContain(CANVAS_PALETTE['1']);
    expect(svg).toContain(CANVAS_PALETTE['5']);
    expect(svg).toContain(CANVAS_PALETTE['6']);

    // ViewBox covers bounds with padding.
    const bounds = { minX: 0, minY: 0, maxX: 300, maxY: 170 }; // approximate
    const pad = 40;
    expect(svg).toContain(`viewBox="${bounds.minX - pad} ${bounds.minY - pad}`);
    expect(svg).toContain(`width="`);
    expect(svg).toContain(`height="`);
  });

  it('defaults edge side to geometric midpoint toward the target', () => {
    const canvas = {
      nodes: [
        { id: 'a', type: 'text' as const, x: 0, y: 0, width: 50, height: 50, text: 'a' },
        { id: 'b', type: 'text' as const, x: 200, y: 10, width: 50, height: 50, text: 'b' },
      ],
      edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
    };
    const svg = renderCanvasToSvg(canvas);
    // a center (25,25), b center (225,35): a should face right, b faces left.
    expect(svg).toContain('M 50.0 25.0');
    expect(svg).toContain('200.0 35.0');
  });
});

describe('renderCanvasJsonToPng', () => {
  it('returns a valid PNG buffer', async () => {
    const result = await renderCanvasJsonToPng(sampleCanvas);
    expect(Buffer.isBuffer(result.png)).toBe(true);
    expect(result.png.length).toBeGreaterThan(1000);
    expect(result.png[0]).toBe(0x89);
    expect(result.png[1]).toBe(0x50);
    expect(result.png[2]).toBe(0x4e);
    expect(result.png[3]).toBe(0x47);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
  });

  it('produces a tiny PNG for an empty canvas', async () => {
    const result = await renderCanvasJsonToPng('{}');
    expect(Buffer.isBuffer(result.png)).toBe(true);
    expect(result.png.length).toBeGreaterThan(0);
    expect(result.png[0]).toBe(0x89);
    expect(result.png[1]).toBe(0x50);
    expect(result.png[2]).toBe(0x4e);
    expect(result.png[3]).toBe(0x47);
  });

  it('throws a clear error for invalid JSON', async () => {
    await expect(renderCanvasJsonToPng('{not json')).rejects.toThrow(/Invalid canvas JSON/);
  });
});

describe('renderCanvasToPng', () => {
  it('reads a canvas file and returns PNG', async () => {
    const tmp = path.join(os.tmpdir(), `obsidian-pi-test-${Date.now()}.canvas`);
    await fs.writeFile(tmp, JSON.stringify(sampleCanvas), 'utf-8');
    try {
      const result = await renderCanvasToPng(tmp);
      expect(Buffer.isBuffer(result.png)).toBe(true);
      expect(result.png[0]).toBe(0x89);
      expect(result.png[1]).toBe(0x50);
      expect(result.png[2]).toBe(0x4e);
      expect(result.png[3]).toBe(0x47);
      expect(result.svg).toContain('Hello world');
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  });
});
