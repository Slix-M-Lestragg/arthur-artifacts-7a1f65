import { TFile, type Vault } from 'obsidian';

/**
 * HiddenNoteRegistry — lets a MarkdownView open markdown files that live under
 * a hidden folder (e.g. `.obsidian/plugins/<id>/prompts/`) which Obsidian does
 * NOT track in its normal vault index.
 *
 * Obsidian's Vault API only exposes files "visible inside the app"; files under
 * the config dir (`.obsidian/`) are not indexed, so `getAbstractFileByPath()`
 * returns null and `vault.create()` throws. They can only be read/written via
 * the raw `vault.adapter`. But a MarkdownView editor needs a real `TFile`.
 *
 * Technique (mirrors the RnD-Env plugin): build a *synthetic* TFile via
 * `Object.create(TFile.prototype)`, inject it into the internal
 * `app.vault.fileMap`, then `leaf.openFile(tfile)` treats it as a generic vault
 * markdown file — Live Preview, edits, and saves all work, reading/writing the
 * real file on disk through `vault.adapter`. On unload the injected entries are
 * removed from `fileMap` so we don't leak undocumented state.
 *
 * NOTE: relies on the undocumented `vault.fileMap` internal; could change in a
 * future Obsidian version. The on-disk files themselves are plain `.md` and
 * remain accessible via the adapter regardless.
 */
export class HiddenNoteRegistry {
  private readonly tempFiles = new Set<string>();

  constructor(private readonly vault: Vault) {}

  /** Ensure a hidden note file exists on disk, creating parent folders. */
  async ensureFile(path: string, defaultContent = ''): Promise<void> {
    const a = this.vault.adapter;
    if (await a.exists(path)) return;
    if (path.includes('/')) await this.ensureDir(path.slice(0, path.lastIndexOf('/')));
    try { await a.write(path, defaultContent); } catch { /* best-effort */ }
  }

  private async ensureDir(dir: string): Promise<void> {
    if (!dir) return;
    const a = this.vault.adapter;
    let cur = '';
    for (const seg of dir.split('/')) {
      cur = cur ? `${cur}/${seg}` : seg;
      try { if (!(await a.exists(cur))) await a.mkdir(cur); } catch { /* may already exist */ }
    }
  }

  /** Return a TFile for a hidden path, injecting a synthetic one into
   *  `vault.fileMap` if the vault doesn't already track it. */
  getOrCreate(path: string): TFile {
    const existing = this.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) return existing;
    const tfile = this.syntheticTFile(path);
    const fileMap = (this.vault as unknown as { fileMap?: Record<string, TFile> }).fileMap;
    if (fileMap && !fileMap[path]) {
      fileMap[path] = tfile;
      this.tempFiles.add(path);
    }
    return tfile;
  }

  private syntheticTFile(path: string): TFile {
    const name = path.split('/').pop() ?? path;
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot + 1) : '';
    const basename = ext ? name.slice(0, -(ext.length + 1)) : name;
    return Object.assign(Object.create(TFile.prototype), {
      path,
      name,
      extension: ext,
      basename,
      stat: { mtime: Date.now(), ctime: Date.now(), size: 0 },
      vault: this.vault,
      parent: this.vault.getRoot(),
    }) as TFile;
  }

  /** Rename a hidden note on disk and update the injected `fileMap` entry in
   *  place — mutating the existing synthetic TFile so any open MarkdownView
   *  stays bound to the same object (now pointing at the new path). Preserves
   *  the note's content. */
  async renameFile(oldPath: string, newPath: string): Promise<TFile | null> {
    if (oldPath === newPath) return this.getOrCreate(newPath);
    const a = this.vault.adapter;
    const fileMap = (this.vault as unknown as { fileMap?: Record<string, TFile> }).fileMap;
    const tfile = fileMap?.[oldPath];
    try {
      if (newPath.includes('/')) await this.ensureDir(newPath.slice(0, newPath.lastIndexOf('/')));
      if (await a.exists(oldPath)) await a.rename(oldPath, newPath);
    } catch { /* best-effort; content may remain at oldPath */ }
    if (tfile) {
      const name = newPath.split('/').pop() ?? newPath;
      const dot = name.lastIndexOf('.');
      const ext = dot > 0 ? name.slice(dot + 1) : (tfile as any).extension ?? '';
      const basename = ext ? name.slice(0, -(ext.length + 1)) : name;
      (tfile as any).path = newPath;
      (tfile as any).name = name;
      (tfile as any).basename = basename;
      if (ext) (tfile as any).extension = ext;
      if (fileMap) { delete fileMap[oldPath]; fileMap[newPath] = tfile; }
      this.tempFiles.delete(oldPath);
      this.tempFiles.add(newPath);
      return tfile;
    }
    return this.getOrCreate(newPath);
  }

  /** Remove every synthetic `fileMap` entry we injected. Call on plugin unload. */
  cleanup(): void {
    const fileMap = (this.vault as unknown as { fileMap?: Record<string, TFile> }).fileMap;
    if (fileMap) for (const p of this.tempFiles) delete fileMap[p];
    this.tempFiles.clear();
  }
}