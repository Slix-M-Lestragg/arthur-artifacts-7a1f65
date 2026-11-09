import { describe, it, expect, vi } from 'vitest';
import {
  executeRenderCanvas,
  registerRenderCanvasTool,
  type SvgCaptureResult,
  type ToolContentText,
} from './renderCanvasTool';

/** Build a tiny fake PNG buffer that still has a readable IHDR width/height. */
function makeFakePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  // PNG signature
  buf[0] = 0x89;
  buf[1] = 0x50;
  buf[2] = 0x4e;
  buf[3] = 0x47;
  buf[4] = 0x0d;
  buf[5] = 0x0a;
  buf[6] = 0x1a;
  buf[7] = 0x0a;
  // IHDR chunk length
  buf.writeUInt32BE(13, 8);
  // IHDR chunk type
  buf.write('IHDR', 12);
  // width / height (big-endian)
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

const fakeSvgResult = (w: number, h: number): SvgCaptureResult => ({
  png: makeFakePng(w, h),
  width: w,
  height: h,
});

describe('executeRenderCanvas', () => {
  it('uses native capture when hostEnabled=true and returns image block + dimensions', async () => {
    const nativePng = makeFakePng(100, 80);
    const nativeCapture = vi.fn().mockResolvedValue(nativePng);
    const svgCapture = vi.fn().mockRejectedValue(new Error('should not be called'));

    const result = await executeRenderCanvas({
      path: 'Boards/My.canvas',
      cwd: '/vault',
      hostEnabled: true,
      nativeCapture,
      svgCapture,
    });

    expect(nativeCapture).toHaveBeenCalledTimes(1);
    expect(nativeCapture).toHaveBeenCalledWith('/vault/Boards/My.canvas', { timeoutMs: 12_000 });
    expect(svgCapture).not.toHaveBeenCalled();

    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining("Rendered canvas 'Boards/My.canvas' to a 100x80 PNG via native."),
    });
    expect(result.content[1]).toMatchObject({
      type: 'image',
      data: nativePng,
      mimeType: 'image/png',
    });
    expect(result.details).toEqual({
      path: 'Boards/My.canvas',
      method: 'native',
      width: 100,
      height: 80,
    });
  });

  it('falls back to SVG capture when native capture rejects', async () => {
    const nativeCapture = vi.fn().mockRejectedValue(new Error('native timeout'));
    const svgCapture = vi.fn().mockResolvedValue(fakeSvgResult(640, 480));

    const result = await executeRenderCanvas({
      path: 'Boards/My.canvas',
      cwd: '/vault',
      hostEnabled: true,
      nativeCapture,
      svgCapture,
    });

    expect(nativeCapture).toHaveBeenCalledTimes(1);
    expect(svgCapture).toHaveBeenCalledTimes(1);
    expect(svgCapture).toHaveBeenCalledWith('/vault/Boards/My.canvas');

    expect(result.content).toHaveLength(2);
    expect(result.details).toMatchObject({
      path: 'Boards/My.canvas',
      method: 'svg',
      width: 640,
      height: 480,
    });
  });

  it('skips native capture entirely when hostEnabled=false', async () => {
    const nativeCapture = vi.fn().mockResolvedValue(makeFakePng(1, 1));
    const svgCapture = vi.fn().mockResolvedValue(fakeSvgResult(320, 240));

    const result = await executeRenderCanvas({
      path: 'Boards/My.canvas',
      cwd: '/vault',
      hostEnabled: false,
      nativeCapture,
      svgCapture,
    });

    expect(nativeCapture).not.toHaveBeenCalled();
    expect(svgCapture).toHaveBeenCalledWith('/vault/Boards/My.canvas');
    expect(result.details).toMatchObject({ method: 'svg' });
  });

  it('returns text-only error content when both capture paths fail', async () => {
    const nativeCapture = vi.fn().mockRejectedValue(new Error('native timeout'));
    const svgCapture = vi.fn().mockRejectedValue(new Error('file not found'));

    const result = await executeRenderCanvas({
      path: 'Boards/Missing.canvas',
      cwd: '/vault',
      hostEnabled: true,
      nativeCapture,
      svgCapture,
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining("Could not render canvas 'Boards/Missing.canvas'"),
    });
    expect((result.content[0] as ToolContentText).text).toContain('file not found');
    expect((result.content[0] as ToolContentText).text).toContain('native timeout');
    expect(result.content.some((c) => c.type === 'image')).toBe(false);
    expect(result.details).toMatchObject({
      path: 'Boards/Missing.canvas',
      error: expect.stringContaining('file not found'),
    });
  });
});

describe('registerRenderCanvasTool', () => {
  it('registers a tool with the correct name, schema, and vision guidelines', () => {
    const registerTool = vi.fn();
    const fakeType = {
      Object: (properties: Record<string, unknown>) => ({
        type: 'object',
        properties,
        required: Object.keys(properties),
      }),
      String: (metadata?: Record<string, unknown>) => ({ type: 'string', ...metadata }),
    };

    registerRenderCanvasTool(
      { registerTool },
      {
        nativeCapture: vi.fn(),
        svgCapture: vi.fn(),
      },
      fakeType,
    );

    expect(registerTool).toHaveBeenCalledTimes(1);
    const definition = registerTool.mock.calls[0][0] as Record<string, unknown>;

    expect(definition.name).toBe('render_canvas');
    expect(definition.label).toBe('Render Canvas');
    expect(definition.description).toContain('vision-capable model');
    expect(definition.promptSnippet).toBe('Render a .canvas file to an image for visual analysis');
    expect(Array.isArray(definition.promptGuidelines)).toBe(true);
    expect(definition.promptGuidelines).toEqual(
      expect.arrayContaining([
        expect.stringContaining('vision-capable model (e.g. ollama-cloud/glm-5.3-flash)'),
      ]),
    );

    const parameters = definition.parameters as Record<string, unknown>;
    expect(parameters.type).toBe('object');
    expect(parameters.required).toEqual(['path']);
    const props = parameters.properties as Record<string, Record<string, unknown>>;
    expect(props.path).toMatchObject({
      type: 'string',
      description: expect.stringContaining("Vault-relative path to the .canvas file"),
    });
  });
});
