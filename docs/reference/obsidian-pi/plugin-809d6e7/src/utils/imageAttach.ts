/**
 * Image-attachment helpers for the prompt editor + terminal surface.
 *
 * The pi TUI's own image-paste flow (`handleClipboardImagePaste` in
 * interactive-mode.js) works by reading the system clipboard image, writing it
 * to a temp file, and inserting that file's path into the editor — pi / the
 * model then reads the file via the standard `@path` mention mechanism. This
 * module mirrors that approach so the plugin's PTY-submitted prompts behave
 * identically to a real pi TUI session, and provides the listing/clipboard
 * primitives the PromptPopout's "add image" UI needs.
 */

import { App, MarkdownView, Notice, TFile } from 'obsidian';

let fsMod: typeof import('fs') | null = null;
function getFs(): typeof import('fs') { return fsMod ?? (fsMod = require('fs')); }
let osMod: typeof import('os') | null = null;
function getOs(): typeof import('os') { return osMod ?? (osMod = require('os')); }
let pathMod: typeof import('path') | null = null;
function getPath(): typeof import('path') { return pathMod ?? (pathMod = require('path')); }

/** File extensions pi / the model will treat as images via the `read` tool. */
export const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp',
]);

/** True if `filePath` looks like an image by extension. */
export function isImageFile(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.has(filePath.slice(dot + 1).toLowerCase());
}

export interface ClipboardImage {
  /** Image bytes (always PNG — Electron normalises to PNG via toPNG()). */
  bytes: Buffer;
  /** MIME type (always image/png when read via Electron's NativeImage). */
  mimeType: string;
}

/**
 * Read the system clipboard image through Electron's renderer-accessible
 * `clipboard` module. Returns null if the clipboard holds no image (or Electron
 * is unreachable). On macOS / Linux / Windows the OS clipboard is shared with
 * the rest of the app, so this sees the same image the user just copied.
 */
export function readClipboardImage(): ClipboardImage | null {
  let clipboard: any;
  try {
    // `electron` is marked external in esbuild.js; resolved at runtime.
    clipboard = (require('electron') as any)?.clipboard;
  } catch {
    return null;
  }
  if (!clipboard?.readImage) return null;
  let img: any;
  try { img = clipboard.readImage(); } catch { return null; }
  if (!img || typeof img.isEmpty === 'function' && img.isEmpty()) return null;
  let png: Buffer | Uint8Array | null = null;
  try { png = img.toPNG(); } catch { return null; }
  if (!png || png.length === 0) return null;
  const bytes = png instanceof Buffer ? png : Buffer.from(png);
  return { bytes, mimeType: 'image/png' };
}

/**
 * Write image bytes to a uniquely-named temp file and return its absolute
 * path. The filename mirrors pi's own `pi-clipboard-<uuid>.<ext>` convention so
 * the temp files are easy to identify / clean up.
 */
export function writeImageToTemp(bytes: Buffer, ext: string = 'png'): string {
  const safeExt = ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png';
  const file = getPath().join(getOs().tmpdir(), `pi-prompt-${globalThis.crypto.randomUUID()}.${safeExt}`);
  getFs().writeFileSync(file, bytes);
  return file;
}

/** Convenience: read the clipboard image and persist it to a temp file. */
export function writeClipboardImageToTemp(): string | null {
  const img = readClipboardImage();
  if (!img) return null;
  const ext = img.mimeType.split('/')[1] || 'png';
  return writeImageToTemp(img.bytes, ext);
}

/** True if a paste ClipboardEvent carries an image item (any image/* MIME). */
export function pasteEventHasImage(e: ClipboardEvent): boolean {
  const items = e.clipboardData?.items;
  if (!items) return false;
  for (let i = 0; i < items.length; i++) {
    if (items[i].type.startsWith('image/')) return true;
  }
  return false;
}

/** Maximum files returned by {@link listImageFiles} (keeps the picker snappy). */
const MAX_IMAGE_RESULTS = 400;

/**
 * List image files under `baseDir`, preferring the `fd` binary when available
 * (fast, .gitignore-aware) and falling back to a bounded Node.js walk. Paths
 * are absolute. Hidden files / `.git` are excluded.
 */
export async function listImageFiles(
  baseDir: string,
  fdPath: string | null,
  signal?: AbortSignal,
): Promise<string[]> {
  if (fdPath) {
    const out = await listImagesViaFd(baseDir, fdPath, signal);
    if (out !== null) return out;
  }
  return listImagesViaWalk(baseDir);
}

async function listImagesViaFd(baseDir: string, fdPath: string, signal?: AbortSignal): Promise<string[] | null> {
  const args = [
    '--base-directory', baseDir,
    '--type', 'f',
    '--follow',
    '--hidden',
    '--exclude', '.git',
    '-e', 'png', '-e', 'jpg', '-e', 'jpeg', '-e', 'webp', '-e', 'gif', '-e', 'bmp',
    '--max-results', String(MAX_IMAGE_RESULTS),
  ];
  const { spawn } = require('child_process') as typeof import('child_process');
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(null); return; }
    const child = spawn(fdPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let done = false;
    const finish = (val: string[] | null) => { if (done) return; done = true; resolve(val); };
    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* */ } };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (code !== 0 || !stdout) { finish(null); return; }
      const lines = stdout.trim().split('\n').filter(Boolean);
      const abs = lines
        .map((l) => l.replace(/\\/g, '/'))
        .filter((l) => isImageFile(l))
        .map((l) => getPath().join(baseDir, l));
      finish(abs);
    });
  });
}

function listImagesViaWalk(baseDir: string): string[] {
  const out: string[] = [];
  const visited = new Set<string>();
  const stack: string[] = [baseDir];
  let count = 0;
  while (stack.length > 0 && count < MAX_IMAGE_RESULTS) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = getFs().readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (name === '.git' || name === '.obsidian' || name === 'node_modules') continue;
      const full = getPath().join(dir, name);
      if (visited.has(full)) continue;
      visited.add(full);
      let st: import('fs').Stats;
      try { st = getFs().statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile() && isImageFile(name)) {
        out.push(full);
        count++;
      }
    }
  }
  return out.sort();
}

/** Convert a vault-relative TFile path to an absolute filesystem path. */
export function vaultPathToAbsolute(vaultBasePath: string, vaultRelativePath: string): string {
  // Normalise separators across platforms; vault paths use '/'.
  const rel = vaultRelativePath.split('/').filter(Boolean).join(getPath().sep);
  return getPath().join(vaultBasePath, rel);
}