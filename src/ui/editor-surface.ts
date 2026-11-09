/**
 * Shared editing surface for the composer and its custom `@` suggester.
 * Textareas remain the headless/failure fallback; production uses Obsidian's
 * public Editor facade over the MarkdownView's CodeMirror instance.
 */
import type { Editor } from "obsidian";

export interface EditorRect {
	top: number;
	bottom: number;
	left: number;
	right: number;
	width: number;
	height: number;
}

export interface EditorSelectionOffsets {
	start: number;
	end: number;
}

export interface EditorSurface {
	readonly dom: HTMLElement;
	/** CM/Obsidian keymaps run at bubble time, so native @ completion captures. */
	readonly captureKeydown?: boolean;
	readonly captureBlur?: boolean;
	getValue(): string;
	setValue(value: string): void;
	getSelection(): EditorSelectionOffsets;
	setSelection(start: number, end?: number): void;
	hasFocus(): boolean;
	focus(): void;
	getAnchorRect(): EditorRect;
	getContentHeight(): number;
}

function elementRect(el: HTMLElement): EditorRect {
	const rect = el.getBoundingClientRect();
	return {
		top: rect.top,
		bottom: rect.bottom,
		left: rect.left,
		right: rect.right,
		width: rect.width,
		height: rect.height,
	};
}

export class TextareaEditorSurface implements EditorSurface {
	readonly dom: HTMLTextAreaElement;

	constructor(textarea: HTMLTextAreaElement) {
		this.dom = textarea;
	}

	getValue(): string {
		return this.dom.value ?? "";
	}

	setValue(value: string): void {
		this.dom.value = value;
	}

	getSelection(): EditorSelectionOffsets {
		const value = this.getValue();
		const start = this.dom.selectionStart ?? value.length;
		return { start, end: this.dom.selectionEnd ?? start };
	}

	setSelection(start: number, end = start): void {
		if (typeof this.dom.setSelectionRange === "function") this.dom.setSelectionRange(start, end);
		else {
			this.dom.selectionStart = start;
			this.dom.selectionEnd = end;
		}
	}

	hasFocus(): boolean {
		return this.dom.ownerDocument?.activeElement === this.dom;
	}

	focus(): void {
		this.dom.focus();
	}

	getAnchorRect(): EditorRect {
		return elementRect(this.dom);
	}

	getContentHeight(): number {
		return Number(this.dom.scrollHeight) || 0;
	}
}

interface Cm6EditorView {
	state: { selection: { main: { head: number } } };
	coordsAtPos(pos: number): { top: number; bottom: number; left: number; right: number } | null;
}

type EditorWithCm = Editor & { cm?: Cm6EditorView };

/** Public Editor API for text/selection; `cm` is used only for popup geometry. */
export class ObsidianEditorSurface implements EditorSurface {
	readonly captureKeydown = true;
	readonly captureBlur = true;

	constructor(
		private readonly editor: Editor,
		readonly dom: HTMLElement,
	) {}

	getValue(): string {
		return this.editor.getValue();
	}

	setValue(value: string): void {
		this.editor.setValue(value);
	}

	getSelection(): EditorSelectionOffsets {
		return {
			start: this.editor.posToOffset(this.editor.getCursor("from")),
			end: this.editor.posToOffset(this.editor.getCursor("to")),
		};
	}

	setSelection(start: number, end = start): void {
		this.editor.setSelection(this.editor.offsetToPos(start), this.editor.offsetToPos(end));
	}

	hasFocus(): boolean {
		return this.editor.hasFocus();
	}

	focus(): void {
		this.editor.focus();
	}

	getAnchorRect(): EditorRect {
		const base = elementRect(this.dom);
		try {
			const cm = (this.editor as EditorWithCm).cm;
			if (!cm) return base;
			const coords = cm.coordsAtPos(cm.state.selection.main.head);
			if (!coords) return base;
			return {
				...base,
				top: coords.top,
				bottom: coords.bottom,
				height: Math.max(0, coords.bottom - coords.top),
			};
		} catch {
			return base;
		}
	}

	getContentHeight(): number {
		const content = this.dom.querySelector?.(".cm-content") as HTMLElement | null;
		return Number(content?.scrollHeight ?? this.dom.scrollHeight) || 0;
	}
}
