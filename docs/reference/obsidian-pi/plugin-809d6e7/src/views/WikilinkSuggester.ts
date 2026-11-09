/**
 * WikilinkSuggester — inline [[ ]] autocomplete for the chat input.
 *
 * Three modes based on what the user has typed:
 *   • `[[query`        → file suggestions (prefix-first alphabetical sort)
 *   • `[[file#query`   → heading suggestions from that file
 *   • `[[file^query`   → block-ID suggestions from that file
 *
 * Arrow keys navigate, Enter / Tab selects, Escape dismisses.
 */

import { App, TFile } from 'obsidian';

interface SuggestionItem {
  text: string;     // text to insert after [[file# or [[file^ or [[
  display: string;  // text shown in the popup
}

type SuggestMode = 'file' | 'heading' | 'block';

interface WikilinkContext {
  mode: SuggestMode;
  fileQuery: string;
  subQuery: string;
  file: TFile | null;  // resolved file (for heading/block modes)
}

export class WikilinkSuggester {
  private popup: HTMLElement | null = null;
  private items: SuggestionItem[] = [];
  private selectedIndex = 0;
  private active = false;
  private currentCtx: WikilinkContext | null = null;

  /** Whether the suggester is currently showing a popup. */
  get isActive(): boolean { return this.active; }

  constructor(
    private textarea: HTMLTextAreaElement,
    private app: App,
  ) {
    textarea.addEventListener('input', () => this.onInput());
    textarea.addEventListener('keydown', (e) => this.onKeydown(e));
    textarea.addEventListener('blur', () => setTimeout(() => this.hide(), 150));
  }

  // ─── Detection ─────────────────────────────────────────────────────────────

  /** Parse the text before the cursor to determine the wikilink mode. */
  private getWikilinkContext(): WikilinkContext | null {
    const pos = this.textarea.selectionStart;
    const before = this.textarea.value.substring(0, pos);

    // Heading mode: [[file#query
    let m = before.match(/\[\[([^#\]\|^]+)#([^\]|]*)$/);
    if (m) {
      return { mode: 'heading', fileQuery: m[1], subQuery: m[2], file: this.resolveFile(m[1]) };
    }

    // Block mode: [[file^query
    m = before.match(/\[\[([^#\]\|^]+)\^([^\]|]*)$/);
    if (m) {
      return { mode: 'block', fileQuery: m[1], subQuery: m[2], file: this.resolveFile(m[1]) };
    }

    // File mode: [[query
    m = before.match(/\[\[([^\]|#\^]*)$/);
    if (m) {
      return { mode: 'file', fileQuery: m[1], subQuery: '', file: null };
    }

    return null;
  }

  /** Resolve a link path to a TFile via metadataCache. */
  private resolveFile(link: string): TFile | null {
    const clean = link.split('|')[0].split('#')[0].split('^')[0].trim();
    if (!clean) return null;
    return this.app.metadataCache.getFirstLinkpathDest(clean, '');
  }

  private onInput(): void {
    const ctx = this.getWikilinkContext();
    if (ctx) {
      this.currentCtx = ctx;
      this.showSuggestions(ctx);
    } else {
      this.hide();
    }
  }

  // ─── Suggestions ───────────────────────────────────────────────────────────

  private showSuggestions(ctx: WikilinkContext): void {
    let items: SuggestionItem[] = [];
    if (ctx.mode === 'file') {
      items = this.getFileSuggestions(ctx.fileQuery);
    } else if (ctx.mode === 'heading' && ctx.file) {
      items = this.getHeadingSuggestions(ctx.file, ctx.subQuery);
    } else if (ctx.mode === 'block' && ctx.file) {
      items = this.getBlockSuggestions(ctx.file, ctx.subQuery);
    }

    if (items.length === 0) {
      this.hide();
      return;
    }

    this.items = items.slice(0, 12);
    this.selectedIndex = 0;
    this.active = true;
    this.render();
  }

  /**
   * File suggestions sorted prefix-first, then alphabetical.
   * "te" → "testing" (prefix match) before "architecture" (substring match).
   */
  private getFileSuggestions(query: string): SuggestionItem[] {
    const files = this.app.vault.getMarkdownFiles();
    const q = query.toLowerCase();

    const prefix: string[] = [];
    const substring: string[] = [];

    for (const f of files) {
      const name = f.basename;
      const lower = name.toLowerCase();
      if (q && lower.startsWith(q)) {
        prefix.push(name);
      } else if (!q || lower.includes(q)) {
        substring.push(name);
      }
    }

    prefix.sort((a, b) => a.localeCompare(b));
    substring.sort((a, b) => a.localeCompare(b));

    return [...prefix, ...substring].map((name) => ({ text: name, display: name }));
  }

  /** Heading suggestions from a file, filtered by query. */
  private getHeadingSuggestions(file: TFile, query: string): SuggestionItem[] {
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache?.headings) return [];

    const q = query.toLowerCase();
    return cache.headings
      .map((h) => h.heading)
      .filter((h) => !q || h.toLowerCase().includes(q))
      .sort((a, b) => {
        const ap = a.toLowerCase().startsWith(q) ? 0 : 1;
        const bp = b.toLowerCase().startsWith(q) ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return a.localeCompare(b);
      })
      .map((h) => ({ text: h, display: h }));
  }

  /** Block-ID suggestions from a file, filtered by query. */
  private getBlockSuggestions(file: TFile, query: string): SuggestionItem[] {
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache?.blocks) return [];

    const q = query.toLowerCase();
    const ids = Object.keys(cache.blocks);
    return ids
      .filter((id) => !q || id.toLowerCase().includes(q))
      .sort((a, b) => a.localeCompare(b))
      .map((id) => ({ text: id, display: `^${id}` }));
  }

  // ─── Rendering ─────────────────────────────────────────────────────────────

  private render(): void {
    if (!this.popup) {
      this.popup = document.createElement('div');
      this.popup.className = 'pi-wikilink-suggest';
      document.body.appendChild(this.popup);
    }
    const popup = this.popup;
    popup.empty();
    this.items.forEach((item, i) => {
      const div = popup.createDiv({
        cls: 'pi-wikilink-item' + (i === this.selectedIndex ? ' is-selected' : ''),
        text: item.display,
      });
      div.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.select(i);
      });
    });

    const rect = this.textarea.getBoundingClientRect();
    this.popup.style.cssText = `position: fixed; top: ${rect.bottom + 4}px; left: ${rect.left}px; min-width: ${rect.width}px; display: block;`;
  }

  // ─── Keyboard ──────────────────────────────────────────────────────────────

  private onKeydown(e: KeyboardEvent): void {
    if (!this.active) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.selectedIndex = (this.selectedIndex + 1) % this.items.length;
      this.updateSelection();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.selectedIndex = (this.selectedIndex - 1 + this.items.length) % this.items.length;
      this.updateSelection();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (this.getWikilinkContext()) {
        e.preventDefault();
        this.select(this.selectedIndex);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.hide();
    }
  }

  private updateSelection(): void {
    if (!this.popup) return;
    this.popup.querySelectorAll('.pi-wikilink-item').forEach((el, i) => {
      el.toggleClass('is-selected', i === this.selectedIndex);
    });
  }

  // ─── Insert ────────────────────────────────────────────────────────────────

  private select(index: number): void {
    const item = this.items[index];
    if (!item || !this.currentCtx) return;
    const ctx = this.currentCtx;

    const pos = this.textarea.selectionStart;
    const before = this.textarea.value.substring(0, pos);
    const after = this.textarea.value.substring(pos);

    let replaced: string;
    if (ctx.mode === 'file') {
      // Replace [[query with [[filename
      replaced = before.replace(/\[\[([^\]|#\^]*)$/, `[[${item.text}`);
    } else if (ctx.mode === 'heading') {
      // Replace [[file#query with [[file#heading
      replaced = before.replace(/(\[\[[^#\]\|^]+#)([^\]|]*)$/, `$1${item.text}`);
    } else {
      // Replace [[file^query with [[file^blockid
      replaced = before.replace(/(\[\[[^#\]\|^]+\^)([^\]|]*)$/, `$1${item.text}`);
    }

    this.textarea.value = replaced + after;
    const newPos = replaced.length;
    this.textarea.setSelectionRange(newPos, newPos);
    this.textarea.focus();
    this.hide();
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  hide(): void {
    this.active = false;
    this.currentCtx = null;
    if (this.popup) this.popup.style.display = 'none';
  }

  destroy(): void {
    this.popup?.remove();
    this.popup = null;
    this.active = false;
  }
}