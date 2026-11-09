/**
 * FileAtSuggester — inline @-file-reference autocomplete.
 *
 * Detects an `@` trigger at a token boundary and shows a fuzzy-search popup of
 * filesystem files relative to the agent's cwd (the same base directory pi uses
 * to resolve @path references). Selecting a file inserts `@path/to/file`; for
 * directories it inserts `@folder/` so the user can keep drilling down.
 *
 * Works on any surface that provides a SuggesterEditorAdapter (PromptPopout's
 * CodeMirror 6 editor, ChatView textarea, modal textarea).
 */

import {
  buildCompletionValue,
  extractAtPrefix,
  getFuzzyFileSuggestions,
  parsePathPrefix,
  type FileSuggestion,
} from '../../utils/fileSearch';
import type { SuggesterEditorAdapter } from './EditorAdapter';

const DEBOUNCE_MS = 150;
const MAX_VISIBLE_ITEMS = 12;

export interface FileAtSuggesterOptions {
  /** Directory that pi uses as its cwd — @ paths are relative to this. */
  baseDir: string;
  /** Optional fd binary path; falls back to a Node.js directory walk if null. */
  fdPath: string | null;
  /** Max number of results shown in the popup. */
  maxVisibleItems?: number;
}

interface ActiveContext {
  prefix: string;
  startCh: number;
  lineNumber: number;
}

export class FileAtSuggester {
  private popup: HTMLElement | null = null;
  private items: FileSuggestion[] = [];
  private selectedIndex = 0;
  private active = false;
  private currentCtx: ActiveContext | null = null;
  private abortController: AbortController | null = null;
  private debounceTimer: number | null = null;
  private readonly maxVisibleItems: number;

  private readonly onInput = () => this.handleInput();
  private readonly onKeydown = (e: KeyboardEvent) => this.handleKeydown(e);
  private readonly onBlur = () => this.scheduleHide();

  constructor(
    private readonly adapter: SuggesterEditorAdapter,
    private readonly options: FileAtSuggesterOptions,
  ) {
    this.maxVisibleItems = options.maxVisibleItems ?? MAX_VISIBLE_ITEMS;
    this.adapter.onInput(this.onInput);
    this.adapter.onKeydown(this.onKeydown);
    this.adapter.onBlur(this.onBlur);
  }

  get isActive(): boolean {
    return this.active;
  }

  // ─── Detection ─────────────────────────────────────────────────────────────

  private getAtPrefix(): { prefix: string; startCh: number; lineNumber: number } | null {
    const { lineText, ch, lineNumber } = this.adapter.getLineContext();
    const before = lineText.slice(0, ch);
    const prefix = extractAtPrefix(before);
    if (!prefix) return null;
    return { prefix, startCh: ch - prefix.length, lineNumber };
  }

  private handleInput(): void {
    if (this.debounceTimer != null) {
      window.clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.checkAndShow();
    }, DEBOUNCE_MS);
  }

  private async checkAndShow(): Promise<void> {
    const ctx = this.getAtPrefix();
    if (!ctx) {
      this.hide();
      return;
    }
    await this.showSuggestions(ctx);
  }

  // ─── Suggestions ───────────────────────────────────────────────────────────

  private async showSuggestions(ctx: ActiveContext): Promise<void> {
    this.currentCtx = ctx;

    if (this.abortController) {
      this.abortController.abort();
    }
    const controller = new AbortController();
    this.abortController = controller;

    const { rawPrefix, isQuotedPrefix } = parsePathPrefix(ctx.prefix);
    const items = await getFuzzyFileSuggestions(this.options.baseDir, this.options.fdPath, rawPrefix, {
      isQuotedPrefix,
      signal: controller.signal,
    });

    if (controller.signal.aborted) {
      return;
    }
    this.abortController = null;

    if (items.length === 0) {
      this.hide();
      return;
    }

    this.items = items.slice(0, this.maxVisibleItems);
    this.selectedIndex = 0;
    this.active = true;
    this.render();
  }

  // ─── Rendering ─────────────────────────────────────────────────────────────

  private render(): void {
    if (!this.active || this.items.length === 0) {
      this.hide();
      return;
    }

    const doc = this.adapter.getDocument();
    if (!this.popup || this.popup.ownerDocument !== doc) {
      this.popup?.remove();
      this.popup = doc.createElement('div');
      this.popup.className = 'pi-file-suggest';
      doc.body.appendChild(this.popup);
    }

    const popup = this.popup;
    popup.empty();

    this.items.forEach((item, i) => {
      const div = popup.createDiv({
        cls: 'pi-file-item' + (i === this.selectedIndex ? ' is-selected' : ''),
      });

      const nameSpan = div.createSpan({ cls: 'pi-file-item-name' });
      nameSpan.textContent = item.label;

      if (item.description) {
        const descSpan = div.createSpan({ cls: 'pi-file-item-path' });
        descSpan.textContent = ` — ${item.description}`;
      }

      div.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.select(i);
      });
    });

    const rect = this.adapter.getAnchorRect();
    popup.style.position = 'fixed';
    popup.style.top = `${rect.bottom + 4}px`;
    popup.style.left = `${rect.left}px`;
    popup.style.minWidth = `${Math.max(rect.width, 200)}px`;
    popup.style.display = 'block';
  }

  private updateSelection(): void {
    if (!this.popup) return;
    this.popup.querySelectorAll('.pi-file-item').forEach((el, i) => {
      el.toggleClass('is-selected', i === this.selectedIndex);
    });
  }

  // ─── Keyboard ──────────────────────────────────────────────────────────────

  private handleKeydown(e: KeyboardEvent): void {
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
      if (this.currentCtx && this.getAtPrefix()?.prefix === this.currentCtx.prefix) {
        e.preventDefault();
        e.stopPropagation();
        this.select(this.selectedIndex);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.hide();
    }
  }

  // ─── Insert ─────────────────────────────────────────────────────────────────

  private select(index: number): void {
    const item = this.items[index];
    const ctx = this.currentCtx;
    if (!item || !ctx) return;

    const isDirectory = item.label.endsWith('/');
    const { isQuotedPrefix } = parsePathPrefix(ctx.prefix);
    const value = buildCompletionValue(item.value.replace(/^@/, ''), {
      isDirectory,
      isAtPrefix: true,
      isQuotedPrefix,
    });

    this.adapter.replaceInLine(ctx.startCh, ctx.startCh + ctx.prefix.length, value);

    // Position cursor at the end of the inserted value on the same line.
    const newCh = ctx.startCh + value.length;
    this.adapter.setCursor(ctx.lineNumber, newCh);

    this.adapter.focus();
    this.hide();
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  private scheduleHide(): void {
    window.setTimeout(() => this.hide(), 150);
  }

  hide(): void {
    this.active = false;
    this.currentCtx = null;
    this.items = [];
    this.selectedIndex = 0;
    if (this.popup) {
      this.popup.style.display = 'none';
    }
  }

  destroy(): void {
    if (this.debounceTimer != null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.adapter.destroy();
    this.popup?.remove();
    this.popup = null;
    this.active = false;
  }
}
