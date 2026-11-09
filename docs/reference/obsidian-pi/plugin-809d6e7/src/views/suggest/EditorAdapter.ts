/**
 * Editor adapter abstraction for inline suggesters.
 *
 * Hides the differences between an HTMLTextAreaElement and Obsidian's
 * CodeMirror 6-backed Editor so the @-file-reference suggester can work on both
 * the PromptPopout markdown editor and the ChatView / modal textareas.
 */

export interface LineContext {
  lineText: string;
  ch: number;
  lineNumber: number;
}

export interface SuggesterEditorAdapter {
  /** Text of the current line and cursor position within it. */
  getLineContext(): LineContext;

  /** Replace the range [fromCh, toCh] on the current line with `text`. */
  replaceInLine(fromCh: number, toCh: number, text: string): void;

  /** Move the cursor to (line, ch). */
  setCursor(line: number, ch: number): void;

  /**
   * Get a DOM rectangle suitable for anchoring the suggestion popup.
   * Should be positioned near the cursor if possible, otherwise at the
   * bottom-left of the editor element.
   */
  getAnchorRect(): DOMRect;

  /**
   * Get the document that owns the editor element. Used to append the
   * suggestion popup to the correct document (e.g. a popout window).
   */
  getDocument(): Document;

  /** The element that should receive focus after a suggestion is inserted. */
  focus(): void;

  /** Subscribe to input events. */
  onInput(handler: () => void): void;

  /** Subscribe to keydown events. */
  onKeydown(handler: (e: KeyboardEvent) => void): void;

  /** Subscribe to blur events. */
  onBlur(handler: () => void): void;

  /** Remove all subscriptions created by this adapter. */
  destroy(): void;
}
