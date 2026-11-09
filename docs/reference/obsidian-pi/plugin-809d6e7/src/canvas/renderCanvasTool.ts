/**
 * Tool logic for the `render_canvas` pi extension tool.
 *
 * Extracted into a pure, testable module with no pi-coding-agent dependency,
 * so vitest can exercise the native-first + SVG fallback decision flow.
 */

import * as path from 'node:path';

export interface ToolContentText {
  type: 'text';
  text: string;
}

export interface ToolContentImage {
  type: 'image';
  data: Uint8Array | Buffer;
  mimeType: 'image/png';
}

export type ToolContent = ToolContentText | ToolContentImage;

export interface SvgCaptureResult {
  png: Buffer;
  width?: number | null;
  height?: number | null;
}

export interface ExecuteRenderCanvasOptions {
  /** Vault-relative or absolute path to the .canvas file. */
  path: string;
  /** Working directory used to resolve relative paths. */
  cwd?: string;
  /** True when pi is hosted by the obsidian-pi plugin and can use Obsidian-native capture. */
  hostEnabled: boolean;
  /** Native capture function (Obsidian plugin path). */
  nativeCapture: (canvasPath: string, opts?: { timeoutMs?: number }) => Promise<Buffer>;
  /** SVG fallback capture function. */
  svgCapture: (canvasPath: string) => Promise<SvgCaptureResult>;
}

export interface RenderCanvasToolResult {
  content: ToolContent[];
  details: {
    path: string;
    method?: 'native' | 'svg';
    width?: number | null;
    height?: number | null;
    error?: string;
  };
}

/** Best-effort parse width/height from a PNG buffer's IHDR chunk. */
function parsePngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47 ||
      buffer[4] !== 0x0d || buffer[5] !== 0x0a || buffer[6] !== 0x1a || buffer[7] !== 0x0a) {
    return null;
  }
  // IHDR is always the first chunk, starting at offset 8 (length) + 12 (chunk type).
  const chunkType = buffer.toString('ascii', 12, 16);
  if (chunkType !== 'IHDR') return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

/** Core render_canvas logic: native-first, SVG fallback. */
export async function executeRenderCanvas(options: ExecuteRenderCanvasOptions): Promise<RenderCanvasToolResult> {
  const { path: inputPath, cwd, hostEnabled, nativeCapture, svgCapture } = options;
  const resolvedPath = path.resolve(cwd ?? process.cwd(), inputPath);

  let lastError: Error | undefined;

  if (hostEnabled) {
    try {
      const png = await nativeCapture(resolvedPath, { timeoutMs: 12_000 });
      const dims = parsePngDimensions(png);
      const width = dims?.width ?? null;
      const height = dims?.height ?? null;
      const dimText = width != null && height != null ? `to a ${width}x${height} PNG` : 'to a PNG';
      return {
        content: [
          { type: 'text', text: `Rendered canvas '${inputPath}' ${dimText} via native.` },
          { type: 'image', data: png, mimeType: 'image/png' },
        ],
        details: { path: inputPath, method: 'native', width, height },
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Fall through to SVG capture.
    }
  }

  try {
    const { png, width, height } = await svgCapture(resolvedPath);
    const w = width ?? null;
    const h = height ?? null;
    const dimText = w != null && h != null ? `to a ${w}x${h} PNG` : 'to a PNG';
    return {
      content: [
        { type: 'text', text: `Rendered canvas '${inputPath}' ${dimText} via svg.` },
        { type: 'image', data: png, mimeType: 'image/png' },
      ],
      details: { path: inputPath, method: 'svg', width: w, height: h },
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const message = lastError
      ? `${error.message} (native attempt: ${lastError.message})`
      : error.message;
    return {
      content: [{ type: 'text', text: `Could not render canvas '${inputPath}': ${message}` }],
      details: { path: inputPath, error: message },
    };
  }
}

/** Minimal Type factory interface used by `registerRenderCanvasTool`. */
export interface TypeFactory {
  Object: <T extends Record<string, unknown>>(properties: T) => unknown;
  String: (metadata?: Record<string, unknown>) => unknown;
}

/** Minimal pi registerTool interface used by `registerRenderCanvasTool`. */
export interface RegisterToolApi {
  registerTool: (definition: Record<string, unknown>) => void;
}

/** Registers the `render_canvas` tool with the pi ExtensionAPI. */
export function registerRenderCanvasTool(
  pi: RegisterToolApi,
  deps: {
    nativeCapture: (canvasPath: string, opts?: { timeoutMs?: number }) => Promise<Buffer>;
    svgCapture: (canvasPath: string) => Promise<SvgCaptureResult>;
  },
  Type: TypeFactory,
): void {
  pi.registerTool({
    name: 'render_canvas',
    label: 'Render Canvas',
    description:
      "Render an Obsidian .canvas file to a PNG image and return it as an attachment, so you can visually analyze node placement, connections, and layout. Pairs with a vision-capable model (e.g. ollama-cloud/glm-5.3-flash).",
    promptSnippet: 'Render a .canvas file to an image for visual analysis',
    promptGuidelines: [
      "Use this tool when you need to SEE an Obsidian canvas's spatial layout (node positions, edges, groupings) rather than just reading the .canvas JSON.",
      'After rendering, analyze the returned image visually — describe placement, clusters, connector flow, and any layout issues. Use a vision-capable model (e.g. ollama-cloud/glm-5.3-flash) for the analysis.',
    ],
    parameters: Type.Object({
      path: Type.String({
        description: "Vault-relative path to the .canvas file (e.g. 'Boards/My.canvas')",
      }),
    }),
    async execute(_toolCallId: string, params: { path: string }, _signal: unknown, _onUpdate: unknown, ctx?: { cwd?: string }) {
      return executeRenderCanvas({
        path: params.path,
        cwd: ctx?.cwd,
        hostEnabled: !!process.env.OBSIDIAN_PI_HOST,
        nativeCapture: deps.nativeCapture,
        svgCapture: deps.svgCapture,
      });
    },
  });
}
