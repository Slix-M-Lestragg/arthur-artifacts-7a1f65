import { describe, expect, it } from 'vitest';
import {
  OBSIDIAN_BG_PATH,
  OBSIDIAN_ARROW_PATH,
  OBSIDIAN_FALLBACK_ACCENT,
  clampByte,
  shade,
  rgbCss,
  parseComputedRgb,
  resolveAccentColor,
  computeIconPalette,
  renderObsidianIconDataUrl,
  type AccentProbeDoc,
  type IconCanvas,
} from './MenubarIconArt';

describe('path data', () => {
  it('bg path is a well-formed closed SVG path', () => {
    expect(OBSIDIAN_BG_PATH.startsWith('M')).toBe(true);
    expect(OBSIDIAN_BG_PATH.trim().endsWith('Z')).toBe(true);
  });
  it('arrow path is a well-formed closed SVG path', () => {
    expect(OBSIDIAN_ARROW_PATH.startsWith('M')).toBe(true);
    expect(OBSIDIAN_ARROW_PATH.trim().endsWith('Z')).toBe(true);
    expect(OBSIDIAN_ARROW_PATH.length).toBeGreaterThan(50);
  });
});

describe('clampByte', () => {
  it('clamps to [0,255] and rounds', () => {
    expect(clampByte(-10)).toBe(0);
    expect(clampByte(300)).toBe(255);
    expect(clampByte(127.6)).toBe(128);
  });
});

describe('shade', () => {
  const c = { r: 124, g: 58, b: 237 };
  it('darkens toward black when factor < 1', () => {
    const d = shade(c, 0.5);
    expect(d).toEqual({ r: 62, g: 29, b: 119 });
  });
  it('lightens toward white when factor > 1', () => {
    const l = shade(c, 1.5);
    expect(l.r).toBeGreaterThan(c.r);
    expect(l.g).toBeGreaterThan(c.g);
    expect(l.b).toBeGreaterThan(c.b);
    expect(l.r).toBeLessThanOrEqual(255);
  });
  it('factor 1 is a no-op', () => {
    expect(shade(c, 1)).toEqual(c);
  });
});

describe('rgbCss', () => {
  it('formats opaque and alpha variants', () => {
    expect(rgbCss({ r: 1, g: 2, b: 3 })).toBe('rgb(1, 2, 3)');
    expect(rgbCss({ r: 1, g: 2, b: 3 }, 0.5)).toBe('rgba(1, 2, 3, 0.5)');
  });
});

describe('parseComputedRgb', () => {
  it('parses rgb() and rgba()', () => {
    expect(parseComputedRgb('rgb(124, 58, 237)')).toEqual({ r: 124, g: 58, b: 237 });
    expect(parseComputedRgb('rgba(124, 58, 237, 0.8)')).toEqual({ r: 124, g: 58, b: 237 });
  });
  it('returns null for unparseable input', () => {
    expect(parseComputedRgb('transparent')).toBeNull();
    expect(parseComputedRgb('')).toBeNull();
  });
});

describe('resolveAccentColor', () => {
  function fakeDoc(computedColor: string): AccentProbeDoc {
    const appended: unknown[] = [];
    return {
      createElement: () => ({ style: { color: '' } }),
      body: {
        appendChild: (el) => { appended.push(el); return el; },
        removeChild: (el) => el,
      },
      defaultView: { getComputedStyle: () => ({ color: computedColor }) },
    };
  }

  it('resolves a normalized rgb() computed value', () => {
    expect(resolveAccentColor(fakeDoc('rgb(200, 100, 50)'))).toEqual({ r: 200, g: 100, b: 50 });
  });

  it('falls back to Obsidian brand purple when computed value is unparseable', () => {
    expect(resolveAccentColor(fakeDoc('not-a-color'))).toEqual(OBSIDIAN_FALLBACK_ACCENT);
  });

  it('falls back when no document is provided (headless/test env)', () => {
    // vitest runs in node — no global `document` — so the default param is undefined.
    expect(resolveAccentColor(undefined)).toEqual(OBSIDIAN_FALLBACK_ACCENT);
  });

  it('falls back gracefully if the probe element throws', () => {
    const doc: AccentProbeDoc = {
      createElement: () => { throw new Error('boom'); },
      body: { appendChild: (el) => el, removeChild: (el) => el },
      defaultView: null,
    };
    expect(resolveAccentColor(doc)).toEqual(OBSIDIAN_FALLBACK_ACCENT);
  });
});

describe('computeIconPalette', () => {
  const accent = { r: 124, g: 58, b: 237 };

  it('template: translucent black badge, glyph fully opaque black, marked as a template image', () => {
    const p = computeIconPalette('template', accent);
    expect(p.template).toBe(true);
    expect(p.layers).toHaveLength(2);
    const [bg, glyph] = p.layers;
    expect(bg).toMatchObject({ path: OBSIDIAN_BG_PATH, fill: 'rgba(0, 0, 0, 0.55)', stroke: null });
    expect(glyph).toMatchObject({ path: OBSIDIAN_ARROW_PATH, fill: '#000', stroke: null });
  });

  it('accent: badge filled with the app-icon dark, glyph filled with accent + darker seam', () => {
    const p = computeIconPalette('accent', accent);
    expect(p.template).toBe(false);
    const [bg, glyph] = p.layers;
    expect(bg.fill).toBe('#262626');
    expect(bg.stroke).toBeNull();
    expect(glyph.fill).toBe(rgbCss(accent));
    expect(glyph.stroke).toBe(rgbCss(shade(accent, 0.62)));
  });

  it('accent-outline: same dark badge as accent, but the glyph is stroke-only in the accent color', () => {
    const p = computeIconPalette('accent-outline', accent);
    expect(p.template).toBe(false);
    const [bg, glyph] = p.layers;
    expect(bg.fill).toBe('#262626');
    expect(bg.stroke).toBeNull();
    expect(glyph.fill).toBeNull();
    expect(glyph.stroke).toBe(rgbCss(accent));
  });
});

describe('renderObsidianIconDataUrl', () => {
  function fakeCanvas(): { canvas: IconCanvas; calls: string[] } {
    const calls: string[] = [];
    const ctx = {
      clearRect: () => calls.push('clearRect'),
      save: () => calls.push('save'),
      restore: () => calls.push('restore'),
      translate: (x: number, y: number) => calls.push(`translate(${x},${y})`),
      scale: (x: number, y: number) => calls.push(`scale(${x},${y})`),
      fill: () => calls.push('fill'),
      stroke: () => calls.push('stroke'),
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      lineJoin: 'round' as CanvasLineJoin,
    };
    const canvas: IconCanvas = {
      width: 0,
      height: 0,
      getContext: () => ctx,
      toDataURL: () => 'data:image/png;base64,FAKE',
    };
    return { canvas, calls };
  }
  const fakePath = (d: string) => d as unknown as Path2D;

  it('accent style: fills both layers, strokes only the glyph, applies padding translate/scale', () => {
    const { canvas, calls } = fakeCanvas();
    const url = renderObsidianIconDataUrl(22, 'accent', { r: 1, g: 2, b: 3 }, () => canvas, fakePath);
    expect(url).toBe('data:image/png;base64,FAKE');
    expect(calls.filter((c) => c === 'fill')).toHaveLength(2); // bg + glyph
    expect(calls.filter((c) => c === 'stroke')).toHaveLength(1); // glyph seam only
    const padded = 22 * (1 - 0.06 * 2);
    expect(calls).toContain(`translate(${22 * 0.06},${22 * 0.06})`);
    expect(calls).toContain(`scale(${padded / 512},${padded / 512})`);
  });

  it('accent-outline style: fills the badge, strokes only the glyph outline', () => {
    const { canvas, calls } = fakeCanvas();
    renderObsidianIconDataUrl(22, 'accent-outline', { r: 1, g: 2, b: 3 }, () => canvas, fakePath);
    expect(calls.filter((c) => c === 'fill')).toHaveLength(1); // bg only
    expect(calls.filter((c) => c === 'stroke')).toHaveLength(1); // glyph outline only
  });

  it('template style: fills both layers (translucent badge + opaque glyph), strokes neither', () => {
    const { canvas, calls } = fakeCanvas();
    renderObsidianIconDataUrl(22, 'template', { r: 0, g: 0, b: 0 }, () => canvas, fakePath);
    expect(calls.filter((c) => c === 'fill')).toHaveLength(2);
    expect(calls.filter((c) => c === 'stroke')).toHaveLength(0);
  });

  it('returns an empty string if 2D context is unavailable', () => {
    const canvas: IconCanvas = { width: 0, height: 0, getContext: () => null, toDataURL: () => 'x' };
    expect(renderObsidianIconDataUrl(22, 'template', { r: 0, g: 0, b: 0 }, () => canvas, fakePath)).toBe('');
  });
});