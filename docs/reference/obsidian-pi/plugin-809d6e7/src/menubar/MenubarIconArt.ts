/**
 * The Obsidian app icon glyph, rasterized on demand for the tray icon and for
 * the settings-tab style picker.
 *
 * Path data is from Obsidian's official app icon SVG
 * (https://obsidian.md/blog/new-obsidian-icon/), viewBox 512x512:
 *  - a rounded-square background (`rect x=0 y=0 512x512 rx=100`, expressed
 *    below as an equivalent path so it renders through the same fill/stroke
 *    pipeline as the glyph — no extra canvas API surface needed), and
 *  - the single "arrow"/mountain silhouette path (the outer contour of the
 *    stone shape — Obsidian ships this as one clean path, not a facet union).
 *
 * Colors are resolved separately (see {@link resolveAccentColor}) and applied
 * at render time via {@link computeIconPalette} — this file has no opinion on
 * light/dark or accent color.
 */

export const OBSIDIAN_VIEWBOX = 512;

/** Equivalent to `<rect width="512" height="512" rx="100"/>` as an SVG path. */
export const OBSIDIAN_BG_PATH =
  'M100,0 H412 A100,100 0 0 1 512,100 V412 A100,100 0 0 1 412,512 H100 ' +
  'A100,100 0 0 1 0,412 V100 A100,100 0 0 1 100,0 Z';

/** The Obsidian stone/arrow silhouette (single path, from the official app icon). */
export const OBSIDIAN_ARROW_PATH =
  'M359.9 434.3c-2.6 19.1-21.3 34-40 28.9-26.4-7.3-57-18.7-84.7-20.8l-42.3-3.2a27.9 27.9 0 0 1-18-8.4l-73-75a27.9 27.9 0 0 1-5.4-31s45.1-99 46.8-104.2c1.7-5.1 7.8-50 11.4-74.2a28 28 0 0 1 9-16.6l86.2-77.5a28 28 0 0 1 40.6 3.5l72.5 92a29.7 29.7 0 0 1 6.2 18.3c0 17.4 1.5 53.2 11.1 76.3a303 303 0 0 0 35.6 58.5 14 14 0 0 1 1.1 15.7c-6.4 10.8-18.9 31.4-36.7 57.9a143.3 143.3 0 0 0-20.4 59.8Z';

/** Obsidian's app-icon background color (`#262626`), used behind the accent-filled glyph. */
export const OBSIDIAN_BG_DARK = '#262626';

export interface Rgb { r: number; g: number; b: number; }

/** Obsidian's brand purple (`#6C31E3`) — used when the live accent color can't be resolved. */
export const OBSIDIAN_FALLBACK_ACCENT: Rgb = { r: 108, g: 49, b: 227 };

export function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

/**
 * Shade a color toward black (factor < 1, e.g. 0.62 = 62% brightness) or
 * toward white (factor > 1, e.g. 1.4 = 40% of the way to white). Used to
 * derive the glyph's darker seam/shadow stroke from the resolved accent.
 */
export function shade(c: Rgb, factor: number): Rgb {
  if (factor <= 1) {
    return { r: clampByte(c.r * factor), g: clampByte(c.g * factor), b: clampByte(c.b * factor) };
  }
  const t = Math.min(1, factor - 1);
  return {
    r: clampByte(c.r + (255 - c.r) * t),
    g: clampByte(c.g + (255 - c.g) * t),
    b: clampByte(c.b + (255 - c.b) * t),
  };
}

export function rgbCss(c: Rgb, alpha = 1): string {
  return alpha >= 1 ? `rgb(${c.r}, ${c.g}, ${c.b})` : `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`;
}

/** Parse a browser-computed `rgb(r, g, b)` / `rgba(r, g, b, a)` string. Null if unparseable. */
export function parseComputedRgb(css: string): Rgb | null {
  const m = css.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!m) return null;
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
}

/** Minimal surface of `Document` this module needs — lets tests pass a fake. */
export interface AccentProbeDoc {
  createElement(tag: string): { style: { color: string } } & Record<string, unknown>;
  body: { appendChild(el: unknown): unknown; removeChild(el: unknown): unknown };
  defaultView: { getComputedStyle(el: unknown): { color: string } } | null;
}

/**
 * Resolve Obsidian's configured accent color (the `--interactive-accent` CSS
 * custom property) to RGB by letting the browser normalize it — this handles
 * hsl()/hex/var()-chain definitions uniformly, however Obsidian happens to
 * define it internally. Falls back to Obsidian's brand purple if `document`
 * is unavailable or the value can't be parsed.
 */
export function resolveAccentColor(doc?: AccentProbeDoc): Rgb {
  const d: AccentProbeDoc | undefined = doc ?? (typeof document !== 'undefined' ? (document as unknown as AccentProbeDoc) : undefined);
  if (!d) return OBSIDIAN_FALLBACK_ACCENT;
  try {
    const probe = d.createElement('span');
    probe.style.color = 'var(--interactive-accent)';
    d.body.appendChild(probe);
    const computed = d.defaultView?.getComputedStyle(probe).color ?? '';
    d.body.removeChild(probe);
    return parseComputedRgb(computed) ?? OBSIDIAN_FALLBACK_ACCENT;
  } catch {
    return OBSIDIAN_FALLBACK_ACCENT;
  }
}

export type MenubarIconStyle = 'template' | 'accent' | 'accent-outline';

export const MENUBAR_ICON_STYLES: readonly MenubarIconStyle[] = ['template', 'accent', 'accent-outline'];

export const MENUBAR_ICON_STYLE_LABELS: Record<MenubarIconStyle, string> = {
  template: 'Template',
  accent: 'Accent',
  'accent-outline': 'Accent outline',
};

/** One filled/stroked shape in the render — background square, then the glyph. */
export interface IconLayer {
  path: string;
  fill: string | null;
  stroke: string | null;
  lineWidth: number;
}

export interface IconPalette {
  layers: IconLayer[];
  /** Whether the resulting image should be marked as a macOS template image. */
  template: boolean;
}

/**
 * Map an icon style + resolved accent color to the layers to draw. Pure and
 * unit-testable — the actual canvas rendering lives in
 * {@link renderObsidianIconDataUrl}.
 *
 * All three styles keep the rounded-square badge background from the real
 * Obsidian app icon so the glyph reads as "the Obsidian icon", not a bare
 * silhouette floating in the menu bar:
 *
 *  - 'template'      — badge background is a translucent black (55% alpha),
 *                       the stone glyph fully opaque black on top. This is
 *                       still a valid macOS template image (only alpha is
 *                       used to derive the drawn color) — the alpha contrast
 *                       between badge and glyph is what keeps the mark
 *                       legible instead of one flat block.
 *                       `setTemplateImage(true)` lets macOS recolor the whole
 *                       thing for light/dark menu bars.
 *  - 'accent'         — badge filled with Obsidian's app-icon dark
 *                       (`#262626`, matching the real icon); glyph filled with
 *                       the live accent color, seam stroked in a darker shade
 *                       of it.
 *  - 'accent-outline' — same dark badge as 'accent', but the glyph is drawn
 *                       as a stroke-only outline in the accent color instead
 *                       of a solid fill.
 */
export function computeIconPalette(style: MenubarIconStyle, accent: Rgb): IconPalette {
  switch (style) {
    case 'accent-outline':
      return {
        template: false,
        layers: [
          { path: OBSIDIAN_BG_PATH, fill: OBSIDIAN_BG_DARK, stroke: null, lineWidth: 0 },
          { path: OBSIDIAN_ARROW_PATH, fill: null, stroke: rgbCss(accent), lineWidth: 10 },
        ],
      };
    case 'accent':
      return {
        template: false,
        layers: [
          { path: OBSIDIAN_BG_PATH, fill: OBSIDIAN_BG_DARK, stroke: null, lineWidth: 0 },
          { path: OBSIDIAN_ARROW_PATH, fill: rgbCss(accent), stroke: rgbCss(shade(accent, 0.62)), lineWidth: 6 },
        ],
      };
    case 'template':
    default:
      return {
        template: true,
        layers: [
          { path: OBSIDIAN_BG_PATH, fill: 'rgba(0, 0, 0, 0.55)', stroke: null, lineWidth: 0 },
          { path: OBSIDIAN_ARROW_PATH, fill: '#000', stroke: null, lineWidth: 0 },
        ],
      };
  }
}

/** Minimal 2D canvas surface this module needs (matches HTMLCanvasElement + CanvasRenderingContext2D). */
export interface IconCanvas {
  width: number;
  height: number;
  getContext(kind: '2d'): {
    clearRect(x: number, y: number, w: number, h: number): void;
    save(): void;
    restore(): void;
    translate(x: number, y: number): void;
    scale(x: number, y: number): void;
    fill(path: Path2D): void;
    stroke(path: Path2D): void;
    fillStyle: string;
    strokeStyle: string;
    lineWidth: number;
    lineJoin: CanvasLineJoin;
  } | null;
  toDataURL(type?: string): string;
}

/**
 * Fraction of the canvas reserved as empty margin on each side. A small
 * amount keeps the badge from touching the very edge of the status item, but
 * most of the perceived "size" comes from macOS's own status-item padding —
 * over-padding here makes the icon look tiny next to system icons.
 */
const CANVAS_PADDING = 0.06;

/** Render the Obsidian icon glyph to a PNG data URL at `size`px, in the given style. */
export function renderObsidianIconDataUrl(
  size: number,
  style: MenubarIconStyle,
  accent: Rgb,
  createCanvas: (size: number) => IconCanvas = defaultCreateCanvas,
  createPath: (d: string) => Path2D = (d) => new Path2D(d),
): string {
  const palette = computeIconPalette(style, accent);
  const canvas = createCanvas(size);
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.clearRect(0, 0, size, size);
  ctx.save();

  const contentSize = size * (1 - CANVAS_PADDING * 2);
  const offset = size * CANVAS_PADDING;
  ctx.translate(offset, offset);
  ctx.scale(contentSize / OBSIDIAN_VIEWBOX, contentSize / OBSIDIAN_VIEWBOX);
  ctx.lineJoin = 'round';

  for (const layer of palette.layers) {
    const p = createPath(layer.path);
    if (layer.fill) {
      ctx.fillStyle = layer.fill;
      ctx.fill(p);
    }
    if (layer.stroke) {
      ctx.strokeStyle = layer.stroke;
      ctx.lineWidth = layer.lineWidth;
      ctx.stroke(p);
    }
  }
  ctx.restore();
  return canvas.toDataURL('image/png');
}

function defaultCreateCanvas(size: number): IconCanvas {
  const el = document.createElement('canvas');
  el.width = size;
  el.height = size;
  return el as unknown as IconCanvas;
}