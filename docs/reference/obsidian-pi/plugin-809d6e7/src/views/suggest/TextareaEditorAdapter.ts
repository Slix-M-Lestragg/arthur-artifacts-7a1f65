/**
 * SuggesterEditorAdapter implementation for a plain HTMLTextAreaElement.
 *
 * Maps textarea.selectionStart into (line, ch) coordinates so the rest of the
 * suggester can work in line-relative offsets.
 */

import type { LineContext, SuggesterEditorAdapter } from './EditorAdapter';

function offsetToLineContext(textarea: HTMLTextAreaElement): LineContext {
  const value = textarea.value;
  const offset = Math.min(textarea.selectionStart ?? 0, value.length);
  const before = value.slice(0, offset);
  const lineNumber = before.split('\n').length - 1;
  const lineStart = before.lastIndexOf('\n') + 1;
  const lineText = value.slice(lineStart).split('\n')[0];
  return { lineText, ch: offset - lineStart, lineNumber };
}

function lineOffsetToGlobal(textarea: HTMLTextAreaElement, line: number, ch: number): number {
  const lines = textarea.value.split('\n');
  let offset = 0;
  for (let i = 0; i < Math.min(line, lines.length); i++) {
    offset += lines[i].length + 1; // +1 for newline
  }
  return offset + Math.min(ch, lines[line]?.length ?? 0);
}

export class TextareaEditorAdapter implements SuggesterEditorAdapter {
  private inputHandler: (() => void) | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private blurHandler: (() => void) | null = null;

  constructor(private readonly textarea: HTMLTextAreaElement) {}

  getLineContext(): LineContext {
    return offsetToLineContext(this.textarea);
  }

  replaceInLine(fromCh: number, toCh: number, text: string): void {
    const { lineNumber } = this.getLineContext();
    const start = lineOffsetToGlobal(this.textarea, lineNumber, fromCh);
    const end = lineOffsetToGlobal(this.textarea, lineNumber, toCh);
    const value = this.textarea.value;
    this.textarea.value = value.slice(0, start) + text + value.slice(end);
  }

  setCursor(line: number, ch: number): void {
    const offset = lineOffsetToGlobal(this.textarea, line, ch);
    this.textarea.setSelectionRange(offset, offset);
  }

  getAnchorRect(): DOMRect {
    return this.textarea.getBoundingClientRect();
  }

  getDocument(): Document {
    return this.textarea.ownerDocument;
  }

  focus(): void {
    this.textarea.focus();
  }

  onInput(handler: () => void): void {
    this.inputHandler = handler;
    this.textarea.addEventListener('input', this.inputHandler);
  }

  onKeydown(handler: (e: KeyboardEvent) => void): void {
    this.keydownHandler = handler;
    this.textarea.addEventListener('keydown', this.keydownHandler);
  }

  onBlur(handler: () => void): void {
    this.blurHandler = handler;
    this.textarea.addEventListener('blur', this.blurHandler);
  }

  destroy(): void {
    if (this.inputHandler) {
      this.textarea.removeEventListener('input', this.inputHandler);
    }
    if (this.keydownHandler) {
      this.textarea.removeEventListener('keydown', this.keydownHandler);
    }
    if (this.blurHandler) {
      this.textarea.removeEventListener('blur', this.blurHandler);
    }
  }
}
