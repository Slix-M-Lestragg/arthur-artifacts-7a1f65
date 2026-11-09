/**
 * SuggesterEditorAdapter implementation for Obsidian's CodeMirror 6 editor.
 *
 * Wraps the Obsidian Editor interface (view.editor) and reaches through to the
 * underlying CM6 EditorView for DOM access and cursor coordinates. Falls back
 * gracefully if the undocumented `cm` bridge is unavailable.
 */

import type { Editor, EditorPosition } from 'obsidian';
import type { LineContext, SuggesterEditorAdapter } from './EditorAdapter';

// Obsidian's Editor type intentionally hides the underlying CodeMirror view.
// In practice the CM6 EditorView lives at editor.cm on desktop builds.
interface Cm6EditorView {
  dom: HTMLElement;
  state: { selection: { main: { head: number } } };
  coordsAtPos(pos: number): { top: number; bottom: number; left: number; right: number } | null;
}

interface EditorWithCm extends Editor {
  cm?: Cm6EditorView;
}

export class CmEditorAdapter implements SuggesterEditorAdapter {
  private readonly editor: EditorWithCm;
  private readonly domEl: HTMLElement;
  private inputHandler: (() => void) | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private blurHandler: (() => void) | null = null;

  constructor(editor: Editor, domEl: HTMLElement) {
    this.editor = editor as EditorWithCm;
    this.domEl = domEl;
  }

  private getCmView(): Cm6EditorView | null {
    return this.editor.cm ?? null;
  }

  getLineContext(): LineContext {
    const pos = this.editor.getCursor();
    const lineText = this.editor.getLine(pos.line);
    return { lineText, ch: pos.ch, lineNumber: pos.line };
  }

  replaceInLine(fromCh: number, toCh: number, text: string): void {
    const pos = this.editor.getCursor();
    const from: EditorPosition = { line: pos.line, ch: fromCh };
    const to: EditorPosition = { line: pos.line, ch: toCh };
    this.editor.replaceRange(text, from, to);
  }

  setCursor(line: number, ch: number): void {
    this.editor.setSelection({ line, ch });
  }

  getAnchorRect(): DOMRect {
    const cmView = this.getCmView();
    if (cmView) {
      try {
        const pos = cmView.state.selection.main.head;
        const coords = cmView.coordsAtPos(pos);
        if (coords) {
          return new DOMRect(coords.left, coords.bottom, 0, 0);
        }
      } catch {
        // fall through to element rect
      }
    }
    const rect = this.domEl.getBoundingClientRect();
    return new DOMRect(rect.left, rect.bottom, rect.width, 0);
  }

  getDocument(): Document {
    return this.domEl.ownerDocument;
  }

  focus(): void {
    this.editor.focus();
  }

  onInput(handler: () => void): void {
    this.inputHandler = handler;
    this.domEl.addEventListener('input', this.inputHandler);
  }

  onKeydown(handler: (e: KeyboardEvent) => void): void {
    this.keydownHandler = handler;
    this.domEl.addEventListener('keydown', this.keydownHandler, true);
  }

  onBlur(handler: () => void): void {
    this.blurHandler = handler;
    this.domEl.addEventListener('blur', this.blurHandler, true);
  }

  destroy(): void {
    if (this.inputHandler) {
      this.domEl.removeEventListener('input', this.inputHandler);
    }
    if (this.keydownHandler) {
      this.domEl.removeEventListener('keydown', this.keydownHandler, true);
    }
    if (this.blurHandler) {
      this.domEl.removeEventListener('blur', this.blurHandler, true);
    }
  }
}
