/**
 * Obsidian-native high-fidelity canvas capture.
 *
 * Opens the target `.canvas` file in a hidden popout BrowserWindow, waits for
 * Obsidian's own canvas view to render, then captures it via
 * `webContents.capturePage()`. Any failure (file missing, Electron unavailable,
 * capture timeout, etc.) falls back to the pure-Node SVG renderer so callers
 * always receive a PNG buffer.
 *
 * All Electron access is dynamic so this module can be imported in vitest
 * without a real Electron environment.
 */

import type { App, TFile as TFileType, WorkspaceLeaf } from 'obsidian';
import { TFile } from 'obsidian';
import { vaultPathToAbsolute } from '../utils/imageAttach';

export interface CaptureOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8000;
const SETTLE_MS = 300;
const POLL_MS = 100;

// Obsidian exposes `app` globally in the renderer process.
declare const app: App;

interface BrowserWindowLike {
  hide(): void;
  close(): void;
  destroy(): void;
  isDestroyed(): boolean;
  webContents: {
    executeJavaScript<T = unknown>(code: string): Promise<T>;
    capturePage(): Promise<NativeImageLike>;
  };
}

interface NativeImageLike {
  toPNG(): Buffer;
}

interface TestSeams {
  electronSurface?: { BrowserWindow: new (opts: Record<string, unknown>) => BrowserWindowLike };
  popoutWindowForLeaf?: (leaf: WorkspaceLeaf) => BrowserWindowLike | null;
}

let testSeams: TestSeams | null = null;

/**
 * Test-only seam. Allows unit tests to inject a fake Electron surface and
 * popout window without relying on module mocking of dynamic `require` calls.
 * Not part of the public API.
 */
export function __setCanvasCaptureTestSeams(seams: TestSeams | null): void {
  testSeams = seams;
}

/** Lazily resolve the Electron BrowserWindow constructor. */
function getElectronModule(): {
  BrowserWindow?: new (opts: Record<string, unknown>) => BrowserWindowLike;
} | null {
  if (testSeams?.electronSurface) return testSeams.electronSurface;
  try {
    const remote = require('@electron/remote');
    if (remote?.BrowserWindow) return remote;
  } catch {
    /* ignore — Electron not available in test environment */
  }
  try {
    const electron = require('electron');
    if (electron?.BrowserWindow) return electron;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Resolve the Electron BrowserWindow backing an Obsidian popout leaf.
 * Mirrors PromptPopout.getPopoutBrowserWindow(): tries a cross-window require
 * first, then falls back to matching by webContents id.
 */
function getPopoutBrowserWindow(leaf: WorkspaceLeaf): BrowserWindowLike | null {
  if (testSeams?.popoutWindowForLeaf) return testSeams.popoutWindowForLeaf(leaf);
  try {
    const view = (leaf as any).view;
    const win = view?.containerEl?.ownerDocument?.defaultView as
      | (Window & { require?: typeof require })
      | undefined;
    if (!win || typeof win.require !== 'function') return null;

    let remote: any;
    try {
      remote = win.require('@electron/remote');
    } catch {
      /* not present */
    }
    if (!remote) {
      try {
        remote = win.require('electron')?.remote;
      } catch {
        /* old electron */
      }
    }

    const bw = remote?.getCurrentWindow?.();
    if (bw) return bw as BrowserWindowLike;

    const id = remote?.getCurrentWebContents?.()?.id;
    if (typeof id === 'number') {
      let mainRemote: any;
      try {
        mainRemote = require('@electron/remote');
      } catch {
        /* ignore */
      }
      if (!mainRemote) {
        try {
          mainRemote = require('electron')?.remote;
        } catch {
          /* ignore */
        }
      }
      const all = mainRemote?.BrowserWindow?.getAllWindows?.() ?? [];
      const match = all.find((w: any) => w.webContents?.id === id);
      if (match) return match as BrowserWindowLike;
    }
  } catch (err) {
    console.warn('[obsidian-pi:canvas] getPopoutBrowserWindow failed:', err);
  }
  return null;
}

/**
 * Resolve a vault-relative canvas path to a PNG buffer.
 *
 * Strategy:
 * 1. Resolve the path to a TFile via `app.vault.getAbstractFileByPath`.
 * 2. Open the file in a hidden popout leaf (popouts have a real Obsidian
 *    workspace, so the native canvas view renders, while the main window stays
 *    untouched).
 * 3. Wait for the canvas DOM, settle, capture the popout window, and close it.
 * 4. On any failure, log a one-line warning and fall back to the SVG renderer.
 */
export async function captureCanvasToPng(
  canvasPath: string,
  opts?: CaptureOptions,
): Promise<Buffer> {
  let leaf: WorkspaceLeaf | null = null;
  let win: BrowserWindowLike | null = null;

  try {
    const tfile = app.vault.getAbstractFileByPath(canvasPath);
    if (!tfile || !(tfile instanceof TFile)) {
      throw new Error(`Canvas file not found or is not a file: ${canvasPath}`);
    }

    const electron = getElectronModule();
    if (!electron?.BrowserWindow) {
      throw new Error('Electron BrowserWindow is not available');
    }

    // Open the canvas in a popout leaf. The popout gets its own workspace and
    // renders Obsidian's real canvas view, but we immediately hide its OS
    // window so the user's main view is undisturbed.
    leaf = app.workspace.openPopoutLeaf({ size: { width: 800, height: 600 } });
    await leaf.openFile(tfile as TFileType, { state: { mode: 'source' } });

    win = getPopoutBrowserWindow(leaf);
    if (!win) {
      throw new Error('Could not resolve popout BrowserWindow for capture');
    }
    try {
      win.hide();
    } catch {
      /* ignore */
    }

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    let ready = false;
    while (Date.now() < deadline) {
      ready = await win.webContents.executeJavaScript(
        `!!document.querySelector('.canvas-wrapper, .canvas')`,
      );
      if (ready) break;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    if (!ready) {
      throw new Error('Timed out waiting for canvas DOM to render');
    }

    await new Promise((r) => setTimeout(r, SETTLE_MS));

    const nativeImage = await win.webContents.capturePage();
    return nativeImage.toPNG();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[obsidian-pi:canvas] native capture failed for ${canvasPath}, falling back to SVG: ${msg}`,
    );
    const basePath = (app.vault.adapter as { basePath?: string }).basePath ?? '';
    const absPath = vaultPathToAbsolute(basePath, canvasPath);
    try {
      const { renderCanvasToPng } = await import('./renderCanvas');
      return (await renderCanvasToPng(absPath)).png;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Canvas SVG fallback unavailable (sharp may be missing): ${msg}`,
      );
    }
  } finally {
    try {
      win?.hide();
    } catch {
      /* ignore */
    }
    try {
      win?.close();
    } catch {
      /* ignore */
    }
    try {
      leaf?.detach();
    } catch {
      /* ignore */
    }
  }
}
