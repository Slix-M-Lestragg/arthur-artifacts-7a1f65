/**
 * Pure-Node Obsidian `.canvas` → SVG → PNG renderer.
 *
 * Implements the JSON Canvas spec v1.0 (https://jsoncanvas.org). It has no
 * Obsidian/Electron imports and can run inside the pi child Node process.
 *
 * z-order: group nodes first (behind), then edges, then non-group nodes on top.
 * Edges are rendered below nodes so arrowheads do not obscure node borders.
 */

import * as fs from 'fs/promises';
import sharp from 'sharp';

export type CanvasColor = '1' | '2' | '3' | '4' | '5' | '6' | string;

export interface JsonCanvasNode {
  id: string;
  type: 'text' | 'file' | 'link' | 'group';
  x: number;
  y: number;
  width: number;
  height: number;
  color?: CanvasColor;
  z?: number;
  // type-specific
  text?: string;
  file?: string;
  subpath?: string;
  url?: string;
  label?: string;
  background?: string;
  backgroundStyle?: string;
}

export interface JsonCanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: 'top' | 'right' | 'bottom' | 'left';
  toSide?: 'top' | 'right' | 'bottom' | 'left';
  fromEnd?: 'none' | 'arrow';
  toEnd?: 'none' | 'arrow';
  color?: CanvasColor;
  label?: string;
}

export interface JsonCanvas {
  nodes?: JsonCanvasNode[];
  edges?: JsonCanvasEdge[];
}

export interface RenderResult {
  png: Buffer;
  svg: string;
  width: number;
  height: number;
}

export const CANVAS_PALETTE: Record<'1' | '2' | '3' | '4' | '5' | '6' | 'default', string> = {
  '1': '#aa363d',
  '2': '#a56c3a',
  '3': '#aba960',
  '4': '#199e5c',
  '5': '#249391',
  '6': '#795fac',
  default: '#7e7e7e',
};

const PADDING = 40;
const GRID_SPACING = 20;

function resolveColor(color?: CanvasColor): string {
  if (!color) return CANVAS_PALETTE.default;
  if (color in CANVAS_PALETTE) return CANVAS_PALETTE[color as keyof typeof CANVAS_PALETTE];
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return color;
  return CANVAS_PALETTE.default;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function stripMarkdown(text: string): string {
  // Minimal markdown stripping: remove bold/italic markers, code fences/backticks, links.
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .trim();
}

function basename(pathOrUrl?: string): string {
  if (!pathOrUrl) return '';
  return pathOrUrl.replace(/\\/g, '/').split('/').pop() || pathOrUrl;
}

function computeBounds(nodes: JsonCanvasNode[]): { minX: number; minY: number; maxX: number; maxY: number } {
  if (nodes.length === 0) {
    return { minX: 0, minY: 0, maxX: PADDING, maxY: PADDING };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const x2 = n.x + n.width;
    const y2 = n.y + n.height;
    minX = Math.min(minX, n.x, x2);
    minY = Math.min(minY, n.y, y2);
    maxX = Math.max(maxX, n.x, x2);
    maxY = Math.max(maxY, n.y, y2);
  }
  return { minX, minY, maxX, maxY };
}

function anchorPoint(node: JsonCanvasNode, side?: 'top' | 'right' | 'bottom' | 'left' | undefined, target?: JsonCanvasNode): { x: number; y: number; side: 'top' | 'right' | 'bottom' | 'left' } {
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  if (side === 'top') return { x: cx, y: node.y, side };
  if (side === 'right') return { x: node.x + node.width, y: cy, side };
  if (side === 'bottom') return { x: cx, y: node.y + node.height, side };
  if (side === 'left') return { x: node.x, y: cy, side };

  // Default side: choose the side that faces the target node.
  if (target) {
    const tcx = target.x + target.width / 2;
    const tcy = target.y + target.height / 2;
    const dx = tcx - cx;
    const dy = tcy - cy;
    if (Math.abs(dx) >= Math.abs(dy)) {
      side = dx >= 0 ? 'right' : 'left';
    } else {
      side = dy >= 0 ? 'bottom' : 'top';
    }
    return anchorPoint(node, side, undefined);
  }

  return { x: cx, y: cy, side: 'bottom' };
}

function buildEdgePath(from: { x: number; y: number; side: string }, to: { x: number; y: number; side: string }): string {
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  const d = Math.max(80, Math.max(dx, dy) * 0.5);

  // Control points follow the axis implied by the side.
  const horizontalSide = (s: string) => s === 'left' || s === 'right';
  const verticalSide = (s: string) => s === 'top' || s === 'bottom';

  let cp1x = from.x;
  let cp1y = from.y;
  let cp2x = to.x;
  let cp2y = to.y;

  if (horizontalSide(from.side) && horizontalSide(to.side)) {
    const direction = from.x <= to.x ? 1 : -1;
    cp1x = from.x + d * direction;
    cp2x = to.x - d * direction;
  } else if (verticalSide(from.side) && verticalSide(to.side)) {
    const direction = from.y <= to.y ? 1 : -1;
    cp1y = from.y + d * direction;
    cp2y = to.y - d * direction;
  } else if (horizontalSide(from.side) && verticalSide(to.side)) {
    const xDirection = from.x <= to.x ? 1 : -1;
    cp1x = from.x + d * xDirection;
    cp2y = to.y - (from.y <= to.y ? d : -d);
  } else if (verticalSide(from.side) && horizontalSide(to.side)) {
    const yDirection = from.y <= to.y ? 1 : -1;
    cp1y = from.y + d * yDirection;
    cp2x = to.x - (from.x <= to.x ? d : -d);
  }

  return `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
}

function renderTextLines(text: string, availableWidth: number, charWidth: number, lineHeight: number): { lines: string[]; contentHeight: number } {
  const rawLines = stripMarkdown(text).split(/\r?\n/);
  const maxChars = Math.max(1, Math.floor(availableWidth / charWidth));
  const lines: string[] = [];
  for (const raw of rawLines) {
    const words = raw.split(/\s+/).filter(Boolean);
    let current = '';
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (next.length <= maxChars) {
        current = next;
      } else {
        if (current) lines.push(current);
        // Hard-wrap very long words.
        for (let i = 0; i < word.length; i += maxChars) {
          const chunk = word.slice(i, i + maxChars);
          if (i + maxChars < word.length) {
            lines.push(chunk);
          } else {
            current = chunk;
          }
        }
      }
    }
    if (current || words.length === 0) lines.push(current || '');
  }
  const contentHeight = lines.length * lineHeight;
  return { lines, contentHeight };
}

function wrapSvg(svgBody: string, x: number, y: number, width: number, height: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x} ${y} ${width} ${height}">\n${svgBody}</svg>`;
}

/**
 * Renders a JSON Canvas value to an SVG string.
 */
export function renderCanvasToSvg(input: string | object): string {
  let canvas: JsonCanvas;
  if (typeof input === 'string') {
    try {
      canvas = JSON.parse(input) as JsonCanvas;
    } catch (err) {
      throw new Error(`Invalid canvas JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    canvas = input as JsonCanvas;
  }

  const nodes = canvas.nodes || [];
  const edges = canvas.edges || [];

  const bounds = computeBounds(nodes);
  const viewX = bounds.minX - PADDING;
  const viewY = bounds.minY - PADDING;
  const viewW = Math.max(1, bounds.maxX - bounds.minX + PADDING * 2);
  const viewH = Math.max(1, bounds.maxY - bounds.minY + PADDING * 2);

  // We keep width/height identical to viewBox dimensions so coordinates in the
  // markup match pixel values; downstream callers may resize the PNG separately.
  const parts: string[] = [];

  // Definitions: arrowhead marker.
  const arrowColor = '#333333';
  parts.push(`<defs>
  <marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth">
    <path d="M0,0 L0,6 L9,3 z" fill="${arrowColor}" />
  </marker>
</defs>`);

  // Background.
  parts.push(`<rect x="${viewX}" y="${viewY}" width="${viewW}" height="${viewH}" fill="#ffffff" />`);

  // Subtle dot grid.
  const dotRadius = 1.2;
  const gridStartX = Math.floor(viewX / GRID_SPACING) * GRID_SPACING;
  const gridStartY = Math.floor(viewY / GRID_SPACING) * GRID_SPACING;
  const gridDots: string[] = [];
  for (let gx = gridStartX; gx <= viewX + viewW; gx += GRID_SPACING) {
    for (let gy = gridStartY; gy <= viewY + viewH; gy += GRID_SPACING) {
      gridDots.push(`${gx.toFixed(1)},${gy.toFixed(1)}`);
    }
  }
  if (gridDots.length) {
    parts.push(`<g fill="#dddddd">${gridDots.map((d) => `<circle cx="${d.split(',')[0]}" cy="${d.split(',')[1]}" r="${dotRadius}" />`).join('')}</g>`);
  }

  // Sort nodes: groups first, then others by z if present.
  const groups = nodes.filter((n) => n.type === 'group');
  const nonGroups = nodes.filter((n) => n.type !== 'group').sort((a, b) => (a.z ?? 0) - (b.z ?? 0));

  // Render groups behind everything.
  for (const group of groups) {
    const color = resolveColor(group.color);
    const label = escapeXml(group.label || '');
    const labelEl = label
      ? `<text x="${group.x + 10}" y="${group.y + 22}" font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="14" fill="${color}">${label}</text>`
      : '';
    parts.push(`<g>
  <rect x="${group.x}" y="${group.y}" width="${Math.max(1, group.width)}" height="${Math.max(1, group.height)}" rx="8" fill="${color}22" stroke="${color}" stroke-width="2" />
  ${labelEl}
</g>`);
  }

  // Render edges between nodes.
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  for (const edge of edges) {
    const fromNode = nodeById.get(edge.fromNode);
    const toNode = nodeById.get(edge.toNode);
    if (!fromNode || !toNode) continue;
    const from = anchorPoint(fromNode, edge.fromSide, toNode);
    const to = anchorPoint(toNode, edge.toSide, fromNode);
    const color = resolveColor(edge.color);
    const path = buildEdgePath(from, to);
    const marker = edge.toEnd === 'none' || edge.toEnd === undefined ? '' : 'marker-end="url(#arrow)"';
    const labelMidX = (from.x + to.x) / 2;
    const labelMidY = (from.y + to.y) / 2;
    const label = escapeXml(edge.label || '');
    let labelEl = '';
    if (label) {
      const approxWidth = label.length * 6 + 8;
      labelEl = `<rect x="${labelMidX - approxWidth / 2}" y="${labelMidY - 10}" width="${approxWidth}" height="18" rx="4" fill="#ffffff" fill-opacity="0.9" stroke="${color}" stroke-width="1" />
      <text x="${labelMidX}" y="${labelMidY + 4}" font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="10" text-anchor="middle" fill="${color}">${label}</text>`;
    }
    parts.push(`<g>
  <path d="${path}" fill="none" stroke="${color}" stroke-width="2" ${marker} />
  ${labelEl}
</g>`);
  }

  // Render non-group nodes on top.
  for (const node of nonGroups) {
    const color = resolveColor(node.color);
    const rectFill = node.type === 'text' ? `${color}18` : '#f7f7f7';
    const borderColor = node.type === 'text' || node.type === 'group' ? color : CANVAS_PALETTE.default;
    const x = node.x;
    const y = node.y;
    const w = Math.max(1, node.width);
    const h = Math.max(1, node.height);

    let content = '';
    let strokeStyle = '';

    if (node.type === 'text') {
      const fontSize = Math.min(16, Math.max(10, h / 4));
      const charWidth = fontSize * 0.55;
      const lineHeight = fontSize * 1.25;
      const pad = 10;
      const { lines } = renderTextLines(node.text || '', w - pad * 2, charWidth, lineHeight);
      const textEls = lines
        .slice(0, Math.max(1, Math.floor((h - pad * 2) / lineHeight)))
        .map((line, i) => `<tspan x="${x + pad}" y="${y + pad + lineHeight * (i + 1) - fontSize * 0.25}">${escapeXml(line)}</tspan>`)
        .join('');
      content = `<text font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="${fontSize}" fill="#222222">${textEls}</text>`;
    } else if (node.type === 'file') {
      const fileName = escapeXml(basename(node.file));
      const sub = node.subpath ? ` ${escapeXml(node.subpath)}` : '';
      content = `<text x="${x + 10}" y="${y + 24}" font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="14" fill="#222222">📄 ${fileName}${sub}</text>`;
    } else if (node.type === 'link') {
      const url = escapeXml(node.url || '');
      strokeStyle = 'stroke-dasharray="6,4"';
      content = `<text x="${x + 10}" y="${y + 24}" font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="14" fill="#1a73e8">🔗 ${url}</text>`;
    }

    parts.push(`<g>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${rectFill}" stroke="${borderColor}" stroke-width="2" ${strokeStyle} />
  ${content}
</g>`);
  }

  const svgBody = parts.join('\n');
  return wrapSvg(svgBody, viewX, viewY, viewW, viewH);
}

/**
 * Converts a JSON Canvas value to a PNG buffer via sharp.
 */
export async function renderCanvasJsonToPng(input: string | object): Promise<RenderResult> {
  const svg = renderCanvasToSvg(input);
  // Parse width/height from the wrapper we control.
  const widthMatch = /width="(\d+)"/.exec(svg);
  const heightMatch = /height="(\d+)"/.exec(svg);
  const width = widthMatch ? parseInt(widthMatch[1], 10) : 0;
  const height = heightMatch ? parseInt(heightMatch[1], 10) : 0;

  const png = await sharp(Buffer.from(svg, 'utf-8'))
    .resize({ width, height, fit: 'fill' })
    .png()
    .toBuffer();

  return { png, svg, width, height };
}

/**
 * Reads a `.canvas` file from disk and renders it to PNG.
 */
export async function renderCanvasToPng(canvasPath: string): Promise<RenderResult> {
  const content = await fs.readFile(canvasPath, 'utf-8');
  return renderCanvasJsonToPng(content);
}
