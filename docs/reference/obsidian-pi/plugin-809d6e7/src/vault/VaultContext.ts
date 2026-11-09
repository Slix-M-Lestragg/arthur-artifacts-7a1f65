/**
 * VaultContext — bridge between the Obsidian vault and the pi agent.
 *
 * Responsibilities
 * ────────────────
 * • Provide the vault root absolute path (used as agent cwd — Phase 4-cwd).
 * • Resolve [[wikilink]] references to absolute vault paths (Phase 4-cwd).
 * • Capture the active note content / editor selection (Phase 4-context).
 * • Apply agent output back into notes: replace selection, append, new note
 *   (Phase 4-insert).
 */

import { App, MarkdownView, Notice, TFile } from 'obsidian';

export class VaultContext {
  private readonly app: App;

  constructor(app: App) {
    this.app = app;
  }

  // ─── Vault root ───────────────────────────────────────────────────────────

  /** Absolute filesystem path to the vault root. */
  getVaultPath(): string {
    return (this.app.vault.adapter as { basePath?: string }).basePath ?? '';
  }

  // ─── Active note / selection ───────────────────────────────────────────────

  /** The currently active file, or null. */
  getActiveFile(): TFile | null {
    return this.app.workspace.getActiveFile();
  }

  /** Read the full content of the active note. Returns null if no note is open. */
  async getActiveNoteContent(): Promise<{ file: TFile; content: string } | null> {
    const file = this.getActiveFile();
    if (!file) return null;
    const content = await this.app.vault.read(file);
    return { file, content };
  }

  /** Get the selected text from the active editor, or null if nothing is selected. */
  getSelection(): string | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return null;
    const sel = view.editor.getSelection();
    return sel || null;
  }

  // ─── Wikilink resolution ───────────────────────────────────────────────────

  /**
   * Resolve a [[wikilink]] target to an absolute vault path.
   * Strips aliases (|alias) and heading references (#heading).
   * Returns null if the link cannot be resolved to a file.
   */
  resolveWikilink(link: string): string | null {
    const path = require('path') as typeof import('path');
    const cleanLink = link
      .replace(/^\[\[/, '')
      .replace(/\]\]$/, '')
      .split('|')[0]
      .split('#')[0]
      .trim();
    if (!cleanLink) return null;
    const file = this.app.metadataCache.getFirstLinkpathDest(cleanLink, '');
    if (file) {
      return path.join(this.getVaultPath(), file.path);
    }
    return null;
  }

  /**
   * Find all [[wikilinks]] in text and resolve each to an absolute path.
   * Returns an array of { raw, link, resolved } triples.
   */
  resolveWikilinksInText(text: string): Array<{ raw: string; link: string; resolved: string | null }> {
    const results: Array<{ raw: string; link: string; resolved: string | null }> = [];
    const regex = /\[\[([^\]]+)\]\]/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const raw = match[0];
      const link = match[1];
      results.push({ raw, link, resolved: this.resolveWikilink(link) });
    }
    return results;
  }

  /**
   * Replace [[wikilinks]] in text with resolved absolute paths.
   * Unresolved links are left as-is so the agent can see the original reference.
   */
  replaceWikilinks(text: string): string {
    return text.replace(/\[\[([^\]]+)\]\]/g, (raw, link: string) => {
      const resolved = this.resolveWikilink(link);
      return resolved ?? raw;
    });
  }

  // ─── Apply agent output ────────────────────────────────────────────────────

  /** Replace the current selection in the active editor with the given text.
   *  Priority: active editor with a selection > sourceFile > active file. */
  async replaceSelection(text: string, sourceFile?: TFile): Promise<boolean> {
    // 1. Prefer the currently active editor (user may have opened a different note).
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && activeView.editor.somethingSelected()) {
      activeView.editor.replaceSelection(text);
      return true;
    }
    // 2. Fall back to the source file from the context send.
    const file = sourceFile ?? this.getActiveFile();
    if (!file) {
      new Notice('No note with a selection — select text in a note first', 3000);
      return false;
    }
    // Open the target file so we can access its editor.
    await this.app.workspace.openLinkText(file.path, '', false);
    await new Promise((r) => setTimeout(r, 100));
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice('Could not open the target note', 3000);
      return false;
    }
    const editor = view.editor;
    if (editor.somethingSelected()) {
      editor.replaceSelection(text);
    } else {
      editor.replaceRange(text, editor.getCursor());
    }
    return true;
  }

  /** Append text to the end of a note.
   *  Priority: active editor > sourceFile (via vault API) > active file. */
  async appendToNote(text: string, sourceFile?: TFile): Promise<boolean> {
    // 1. Prefer the currently active editor.
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView) {
      const editor = activeView.editor;
      const content = editor.getValue();
      const separator = content.endsWith('\n') ? '\n' : '\n\n';
      editor.setValue(content + separator + text);
      new Notice('Appended to active note', 2000);
      return true;
    }
    // 2. Fall back to the source file via vault API.
    const file = sourceFile ?? this.getActiveFile();
    if (!file) {
      new Notice('No note to append to', 3000);
      return false;
    }
    const content = await this.app.vault.read(file);
    const separator = content.endsWith('\n') ? '\n' : '\n\n';
    await this.app.vault.modify(file, content + separator + text);
    new Notice(`Appended to ${file.basename}`, 2000);
    return true;
  }

  /** Create a new note with the given text and open it in a new tab. */
  async createNewNote(text: string, filename?: string): Promise<TFile | null> {
    const name = filename ?? `pi-output-${Date.now()}.md`;
    const path = name.endsWith('.md') ? name : `${name}.md`;
    try {
      const file = await this.app.vault.create(path, text);
      await this.app.workspace.openLinkText(path, '', false);
      new Notice(`Created ${path}`, 3000);
      return file;
    } catch (err) {
      new Notice(`Failed to create note: ${err instanceof Error ? err.message : String(err)}`, 5000);
      return null;
    }
  }

  // ─── Prompt formatting ─────────────────────────────────────────────────────

  /**
   * Build a prompt string that sends the active note's content as context.
   * Wikilinks inside the content are resolved to absolute paths.
   */
  async buildNoteContextPrompt(): Promise<string | null> {
    const path = require('path') as typeof import('path');
    const note = await this.getActiveNoteContent();
    if (!note) return null;
    const { file, content } = note;
    const resolvedContent = this.replaceWikilinks(content);
    return `Here is the content of my note "${file.basename}" (at ${path.join(this.getVaultPath(), file.path)}):\n\n---\n${resolvedContent}\n---`;
  }

  /**
   * Build a prompt string that sends the current editor selection as context.
   * Wikilinks inside the selection are resolved to absolute paths.
   */
  buildSelectionContextPrompt(): string | null {
    const selection = this.getSelection();
    if (!selection) return null;
    const file = this.getActiveFile();
    const filename = file?.basename ?? 'unknown';
    const resolved = this.replaceWikilinks(selection);
    return `Here is the selected text from my note "${filename}":\n\n---\n${resolved}\n---`;
  }
}