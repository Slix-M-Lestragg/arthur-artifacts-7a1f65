/**
 * Unit tests for the image-attachment helpers (extension detection, vault path
 * absolutisation, paste-event detection, temp-file writing, and the fd/Node
 * image-file listing fallbacks).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  IMAGE_EXTENSIONS,
  isImageFile,
  listImageFiles,
  pasteEventHasImage,
  vaultPathToAbsolute,
  writeImageToTemp,
} from './imageAttach';

describe('isImageFile', () => {
  it('matches image extensions case-insensitively', () => {
    expect(isImageFile('photo.PNG')).toBe(true);
    expect(isImageFile('photo.jpg')).toBe(true);
    expect(isImageFile('photo.JPEG')).toBe(true);
    expect(isImageFile('icon.webp')).toBe(true);
    expect(isImageFile('anim.gif')).toBe(true);
    expect(isImageFile('logo.bmp')).toBe(true);
  });

  it('rejects non-image files and extensionless paths', () => {
    expect(isImageFile('note.md')).toBe(false);
    expect(isImageFile('README')).toBe(false);
    expect(isImageFile('archive.zip')).toBe(false);
    expect(isImageFile('')).toBe(false);
  });

  it('treats IMAGE_EXTENSIONS as the canonical set', () => {
    expect(IMAGE_EXTENSIONS.has('png')).toBe(true);
    expect(IMAGE_EXTENSIONS.has('jpg')).toBe(true);
    expect(IMAGE_EXTENSIONS.has('jpeg')).toBe(true);
    expect(IMAGE_EXTENSIONS.has('webp')).toBe(true);
    expect(IMAGE_EXTENSIONS.has('gif')).toBe(true);
    expect(IMAGE_EXTENSIONS.has('bmp')).toBe(true);
    expect(IMAGE_EXTENSIONS.has('svg')).toBe(false);
  });
});

describe('vaultPathToAbsolute', () => {
  it('joins a vault-relative path onto the vault root', () => {
    const abs = vaultPathToAbsolute('/Users/me/Vault', 'attachments/img.png');
    expect(abs).toBe(join('/Users/me/Vault', 'attachments/img.png'));
  });

  it('normalises leading/trailing separators in the relative path', () => {
    const abs = vaultPathToAbsolute('/vault', '/sub/img.png');
    expect(abs).toBe(join('/vault', 'sub/img.png'));
  });
});

describe('pasteEventHasImage', () => {
  function makeEvent(items: { type: string; getAsFile?: () => File | null }[]): ClipboardEvent {
    const dt = {
      items: items.map((it) => ({ type: it.type, getAsFile: () => it.getAsFile?.() ?? null })),
    } as unknown as DataTransfer;
    return { clipboardData: dt } as unknown as ClipboardEvent;
  }

  it('is true when an image item is present', () => {
    expect(pasteEventHasImage(makeEvent([
      { type: 'image/png', getAsFile: () => new File([], 'x.png', { type: 'image/png' }) },
    ]))).toBe(true);
  });

  it('is false for text-only pastes', () => {
    expect(pasteEventHasImage(makeEvent([
      { type: 'text/plain', getAsFile: () => null },
    ]))).toBe(false);
  });

  it('is false when clipboardData is absent', () => {
    expect(pasteEventHasImage({} as ClipboardEvent)).toBe(false);
  });
});

describe('writeImageToTemp', () => {
  it('writes bytes to a uniquely-named temp file and returns the absolute path', () => {
    const path = writeImageToTemp(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'png');
    expect(path).toContain(tmpdir());
    expect(path.endsWith('.png')).toBe(true);
    // Two consecutive writes must not collide.
    const path2 = writeImageToTemp(Buffer.from([1, 2, 3]), 'png');
    expect(path2).not.toBe(path);
  });

  it('falls back to a safe png extension for an empty ext', () => {
    const path = writeImageToTemp(Buffer.from([0]), '');
    expect(path.endsWith('.png')).toBe(true);
  });

  it('neutralises path-traversal in the extension (no .. or separators in the filename)', () => {
    const path = writeImageToTemp(Buffer.from([0]), '../../../etc');
    const name = path.replace(/^.*[\\/]/, '');
    expect(name.includes('..')).toBe(false);
    expect(name.includes('/')).toBe(false);
    expect(name.endsWith('.etc')).toBe(true);
  });
});

describe('listImageFiles', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-img-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists image files under the base directory (Node walk fallback, no fd)', async () => {
    writeFileSync(join(dir, 'a.png'), 'x');
    writeFileSync(join(dir, 'b.jpg'), 'x');
    writeFileSync(join(dir, 'notes.md'), 'x');
    writeFileSync(join(dir, 'doc.txt'), 'x');
    // fdPath null forces the Node walk.
    const files = await listImageFiles(dir, null);
    expect(files).toContain(join(dir, 'a.png'));
    expect(files).toContain(join(dir, 'b.jpg'));
    expect(files.some((f) => f.endsWith('notes.md'))).toBe(false);
    expect(files.some((f) => f.endsWith('doc.txt'))).toBe(false);
  });

  it('descends into subdirectories', async () => {
    writeFileSync(join(dir, 'top.png'), 'x');
    // mkdirSync would be needed; use nested writeFileSync via fs directly.
    const sub = join(dir, 'sub');
    const { mkdirSync } = require('fs');
    mkdirSync(sub);
    writeFileSync(join(sub, 'deep.jpeg'), 'x');
    const files = await listImageFiles(dir, null);
    expect(files).toContain(join(dir, 'top.png'));
    expect(files).toContain(join(sub, 'deep.jpeg'));
  });

  it('skips .git / node_modules / .obsidian', async () => {
    const { mkdirSync } = require('fs');
    mkdirSync(join(dir, '.git'));
    mkdirSync(join(dir, 'node_modules'));
    mkdirSync(join(dir, '.obsidian'));
    writeFileSync(join(dir, '.git/ignored.png'), 'x');
    writeFileSync(join(dir, 'node_modules/pkg.png'), 'x');
    writeFileSync(join(dir, '.obsidian/config.png'), 'x');
    writeFileSync(join(dir, 'keep.png'), 'x');
    const files = await listImageFiles(dir, null);
    expect(files).toContain(join(dir, 'keep.png'));
    expect(files.some((f) => f.includes('.git'))).toBe(false);
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(files.some((f) => f.includes('.obsidian'))).toBe(false);
  });
});