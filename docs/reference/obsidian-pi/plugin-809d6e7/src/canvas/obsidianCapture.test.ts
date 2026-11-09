/**
 * Tests for the Obsidian-native canvas capture path.
 *
 * These tests never launch a real Electron window. They inject a fake Electron
 * surface via the test-only `__setCanvasCaptureTestSeams` seam and mock
 * Obsidian's global `app`, then verify:
 *   • hidden popout leaf is opened,
 *   • canvas DOM readiness is polled,
 *   • capturePage is called,
 *   • the popout window and leaf are cleaned up,
 *   • any failure falls back to the SVG renderer and still returns a PNG.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { TFile, App, Workspace, Vault } from 'obsidian';
import { captureCanvasToPng, __setCanvasCaptureTestSeams } from './obsidianCapture';
import * as renderCanvas from './renderCanvas';

const sampleCanvas = {
  nodes: [{ id: 'n1', type: 'text' as const, x: 0, y: 0, width: 100, height: 50, text: 'hi' }],
};

const FAKE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function makeFakeBrowserWindow(win: any) {
  return {
    BrowserWindow: vi.fn().mockImplementation(() => win),
  };
}

function makeTFile(_canvasPath: string): TFile {
  return new TFile();
}

function makeMockApp(tfile: TFile, basePath: string, win: any): App {
  const leaf = {
    view: {
      containerEl: {
        ownerDocument: {
          defaultView: {},
        },
      },
    },
    openFile: vi.fn().mockResolvedValue(undefined),
    detach: vi.fn(),
  };

  __setCanvasCaptureTestSeams({
    electronSurface: makeFakeBrowserWindow(win),
    popoutWindowForLeaf: () => win,
  });

  return {
    vault: {
      adapter: { basePath },
      getAbstractFileByPath: vi.fn().mockReturnValue(tfile),
    } as unknown as Vault,
    workspace: {
      openPopoutLeaf: vi.fn().mockReturnValue(leaf),
    } as unknown as Workspace,
  } as unknown as App;
}

function setGlobalApp(app: App): void {
  (globalThis as unknown as { app: App }).app = app;
}

describe('captureCanvasToPng native path', () => {
  let tmpDir: string;
  let canvasFile: string;
  let tfile: TFile;
  let fakeNativeImage: { toPNG: ReturnType<typeof vi.fn> };
  let fakeWebContents: {
    executeJavaScript: ReturnType<typeof vi.fn>;
    capturePage: ReturnType<typeof vi.fn>;
  };
  let fakeWin: any;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-canvas-'));
    canvasFile = path.join(tmpDir, 'diagrams', 'test.canvas');
    await fs.mkdir(path.dirname(canvasFile), { recursive: true });
    await fs.writeFile(canvasFile, JSON.stringify(sampleCanvas), 'utf-8');
    tfile = makeTFile(canvasFile);

    fakeNativeImage = { toPNG: vi.fn().mockReturnValue(FAKE_PNG) };
    fakeWebContents = {
      executeJavaScript: vi.fn().mockResolvedValue(true),
      capturePage: vi.fn().mockResolvedValue(fakeNativeImage),
    };
    fakeWin = {
      hide: vi.fn(),
      close: vi.fn(),
      destroy: vi.fn(),
      isDestroyed: vi.fn().mockReturnValue(false),
      webContents: fakeWebContents,
    };
  });

  afterEach(async () => {
    __setCanvasCaptureTestSeams(null);
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    vi.clearAllMocks();
  });

  it('creates a hidden popout leaf, captures the canvas, and cleans up', async () => {
    const app = makeMockApp(tfile, tmpDir, fakeWin);
    setGlobalApp(app);

    const png = await captureCanvasToPng('diagrams/test.canvas');

    expect(png).toBe(FAKE_PNG);
    expect(app.vault.getAbstractFileByPath).toHaveBeenCalledWith('diagrams/test.canvas');
    expect(app.workspace.openPopoutLeaf).toHaveBeenCalledWith({ size: { width: 800, height: 600 } });
    expect(fakeWebContents.capturePage).toHaveBeenCalled();
    expect(fakeWin.hide).toHaveBeenCalled();
    expect(fakeWin.close).toHaveBeenCalled();

    const leaf = (app.workspace as any).openPopoutLeaf.mock.results[0].value;
    expect(leaf.detach).toHaveBeenCalled();
  });

  it('waits for the canvas DOM before capturing', async () => {
    const app = makeMockApp(tfile, tmpDir, fakeWin);
    setGlobalApp(app);
    fakeWebContents.executeJavaScript.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const png = await captureCanvasToPng('diagrams/test.canvas');
    expect(png).toBe(FAKE_PNG);
    expect(fakeWebContents.executeJavaScript).toHaveBeenCalledWith(
      `!!document.querySelector('.canvas-wrapper, .canvas')`,
    );
    expect(fakeWebContents.executeJavaScript).toHaveBeenCalledTimes(2);
  });

  it('falls back to the SVG renderer when capturePage rejects', async () => {
    const app = makeMockApp(tfile, tmpDir, fakeWin);
    setGlobalApp(app);
    fakeWebContents.capturePage.mockRejectedValue(new Error('capture failed'));

    const fallbackSpy = vi.spyOn(renderCanvas, 'renderCanvasToPng');

    const png = await captureCanvasToPng('diagrams/test.canvas');

    expect(fallbackSpy).toHaveBeenCalledWith(canvasFile);
    expect(Buffer.isBuffer(png)).toBe(true);
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50);
    expect(png[2]).toBe(0x4e);
    expect(png[3]).toBe(0x47);
  });

  it('falls back to the SVG renderer when Electron is unavailable', async () => {
    const app = makeMockApp(tfile, tmpDir, fakeWin);
    __setCanvasCaptureTestSeams(null); // simulate no Electron surface
    setGlobalApp(app);
    const fallbackSpy = vi.spyOn(renderCanvas, 'renderCanvasToPng');

    const png = await captureCanvasToPng('diagrams/test.canvas');

    expect(fallbackSpy).toHaveBeenCalledWith(canvasFile);
    expect(Buffer.isBuffer(png)).toBe(true);
    expect(png[0]).toBe(0x89);
  });

  it('falls back to the SVG renderer when the file is not found', async () => {
    const app = makeMockApp(tfile, tmpDir, fakeWin);
    setGlobalApp(app);
    (app.vault.getAbstractFileByPath as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const fallbackSpy = vi.spyOn(renderCanvas, 'renderCanvasToPng');

    const png = await captureCanvasToPng('diagrams/test.canvas');

    expect(fallbackSpy).toHaveBeenCalledWith(canvasFile);
    expect(Buffer.isBuffer(png)).toBe(true);
  });
});
