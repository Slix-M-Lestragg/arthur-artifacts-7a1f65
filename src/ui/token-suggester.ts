/**
 * Shared textarea token-completion controller. Drivers only detect the token
 * at the caret and return suggestions; this class owns the body-portaled hover
 * overlay, keyboard/mouse interaction, insertion, dismissal, and positioning.
 */
import { el } from "../util";

export interface TokenSuggestion {
	/** Literal replacement for the active token. */
	value: string;
	label: string;
	description?: string;
	/** Caret movement from the end of the inserted value (wikilinks use -2). */
	caretOffset?: number;
	/** Consume an existing suffix (for example the `]]` from the link button). */
	consumeSuffix?: string;
}

export interface TokenSuggesterOptions {
	maxVisibleItems?: number;
	/** Sync the draft after a programmatic insert without re-opening the popup. */
	onInsert?: () => void;
	ariaLabel?: string;
}

const DEBOUNCE_MS = 150;
const MAX_VISIBLE_ITEMS = 12;

/** Splice a completion into text and report the caret at the insertion end. */
export function insertCompletion(
	text: string,
	start: number,
	end: number,
	value: string,
): { value: string; cursor: number } {
	const s = Math.max(0, Math.min(start, text.length));
	const e = Math.max(s, Math.min(end, text.length));
	return { value: text.slice(0, s) + value + text.slice(e), cursor: s + value.length };
}

export abstract class TokenSuggester<TOptions extends TokenSuggesterOptions = TokenSuggesterOptions> {
	protected popup: HTMLElement | null = null;
	protected itemEls: HTMLElement[] = [];
	protected items: TokenSuggestion[] = [];
	protected selectedIndex = 0;
	protected active = false;
	protected currentPrefix: string | null = null;
	protected debounceTimer: number | null = null;
	protected readonly maxVisible: number;

	protected readonly onInput = (): void => this.scheduleCheck();
	protected readonly onKeydown = (e: KeyboardEvent): void => this.handleKeydown(e);
	protected readonly onBlur = (): void => {
		// Delay so a row mousedown (preventDefault → no blur) still registers.
		window.setTimeout(() => this.hide(), 150);
	};
	protected readonly onReposition = (): void => this.reposition();

	constructor(
		protected readonly textarea: HTMLTextAreaElement,
		protected readonly opts: TOptions,
	) {
		this.maxVisible = opts.maxVisibleItems ?? MAX_VISIBLE_ITEMS;
		textarea.addEventListener("input", this.onInput);
		textarea.addEventListener("keydown", this.onKeydown);
		textarea.addEventListener("blur", this.onBlur);
		const doc = textarea.ownerDocument ?? document;
		(doc.defaultView ?? window).addEventListener("resize", this.onReposition);
		doc.addEventListener("scroll", this.onReposition, true);
	}

	get isActive(): boolean {
		return this.active;
	}

	/** Token including its trigger, or null when the caret is not completing. */
	protected abstract getPrefix(): string | null;
	/** Build the current driver's suggestions for a detected token. */
	protected abstract getSuggestions(prefix: string): TokenSuggestion[];

	private scheduleCheck(): void {
		if (this.debounceTimer != null) window.clearTimeout(this.debounceTimer);
		this.debounceTimer = window.setTimeout(() => {
			this.debounceTimer = null;
			this.checkAndShow();
		}, DEBOUNCE_MS);
	}

	private checkAndShow(): void {
		const prefix = this.getPrefix();
		if (!prefix) {
			this.hide();
			return;
		}
		let items: TokenSuggestion[];
		try {
			items = this.getSuggestions(prefix);
		} catch {
			// A vault/fs read must never make ordinary typing fail.
			this.hide();
			return;
		}
		if (items.length === 0) {
			this.hide();
			return;
		}
		this.currentPrefix = prefix;
		this.items = items.slice(0, this.maxVisible);
		this.selectedIndex = 0;
		this.active = true;
		this.render();
	}

	private render(): void {
		if (!this.active || this.items.length === 0) {
			this.hide();
			return;
		}
		const doc = this.textarea.ownerDocument ?? document;
		if (!this.popup) {
			this.popup = el("div", {
				cls: "arthur-pi-file-suggest arthur-pi-file-suggest--hover",
				attrs: { role: "listbox", "aria-label": this.opts.ariaLabel ?? "Completions" },
			});
			doc.body.appendChild(this.popup);
		}
		const popup = this.popup;
		popup.empty();
		this.itemEls = [];
		this.items.forEach((item, i) => {
			const row = el("div", {
				cls: "arthur-pi-file-item" + (i === this.selectedIndex ? " is-selected" : ""),
				attrs: { role: "option", "aria-selected": String(i === this.selectedIndex) },
			});
			row.append(el("span", { cls: "arthur-pi-file-item-name", text: item.label }));
			if (item.description) {
				row.append(el("span", { cls: "arthur-pi-file-item-path", text: ` — ${item.description}` }));
			}
			row.addEventListener("mouseenter", () => {
				this.selectedIndex = i;
				this.updateSelection();
			});
			row.addEventListener("mousedown", (e) => e.preventDefault());
			row.addEventListener("click", (e) => {
				e.preventDefault();
				this.select(i);
			});
			popup.append(row);
			this.itemEls.push(row);
		});
		popup.style.display = "block";
		this.reposition();
	}

	/** Re-anchor above the textarea after render, resize, scroll, or refit. */
	reposition(): void {
		const popup = this.popup;
		if (!this.active || !popup) return;
		const rect = this.textarea.getBoundingClientRect();
		const doc = this.textarea.ownerDocument ?? document;
		const win = doc.defaultView ?? window;
		const viewportH = Number(win.innerHeight) || 0;
		const viewportW = Number(win.innerWidth) || 0;
		const gap = 6;
		const margin = 8;
		const available = Math.max(0, rect.top - gap - margin);
		const maxHeight = rect.top > 0 ? Math.max(48, Math.min(240, available)) : 240;
		const width = Math.max(0, rect.width);
		const left = viewportW > 0 && width > 0
			? Math.max(margin, Math.min(rect.left, viewportW - width - margin))
			: rect.left;
		popup.style.position = "fixed";
		popup.style.left = `${left}px`;
		popup.style.width = `${width}px`;
		popup.style.minWidth = "0";
		popup.style.maxWidth = "none";
		popup.style.maxHeight = `${maxHeight}px`;
		const measured = Number(popup.offsetHeight) || Math.min(maxHeight, this.items.length * 28 + 4);
		const height = Math.min(maxHeight, measured);
		let top = Math.max(margin, rect.top - height - gap);
		if (viewportH > 0) top = Math.min(top, Math.max(margin, viewportH - height - margin));
		popup.style.top = `${top}px`;
		popup.style.bottom = "auto";
		popup.style.display = "block";
	}

	private updateSelection(): void {
		this.itemEls.forEach((elm, i) => {
			elm.classList.toggle("is-selected", i === this.selectedIndex);
			elm.setAttribute("aria-selected", String(i === this.selectedIndex));
		});
		this.itemEls[this.selectedIndex]?.scrollIntoView?.({ block: "nearest" });
	}

	private handleKeydown(e: KeyboardEvent): void {
		if (!this.active) return;
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			this.selectedIndex = (this.selectedIndex + 1) % this.items.length;
			this.updateSelection();
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			this.selectedIndex = (this.selectedIndex - 1 + this.items.length) % this.items.length;
			this.updateSelection();
		} else if (e.key === "Enter" || e.key === "Tab") {
			if (this.currentPrefix !== null && this.getPrefix() === this.currentPrefix) {
				e.preventDefault();
				e.stopPropagation();
				this.select(this.selectedIndex);
			}
		} else if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			this.hide();
		}
	}

	private select(index: number): void {
		const item = this.items[index];
		const prefix = this.currentPrefix;
		if (!item || !prefix) return;
		const value = this.textarea.value ?? "";
		const cursor = this.textarea.selectionStart ?? value.length;
		const start = cursor - prefix.length;
		const suffix = item.consumeSuffix ?? "";
		const end = suffix && value.slice(cursor, cursor + suffix.length) === suffix
			? cursor + suffix.length
			: cursor;
		const res = insertCompletion(value, start, end, item.value);
		this.textarea.value = res.value;
		const caret = Math.max(start, Math.min(res.value.length, res.cursor + (item.caretOffset ?? 0)));
		if (typeof this.textarea.setSelectionRange === "function") {
			this.textarea.setSelectionRange(caret, caret);
		}
		this.textarea.focus();
		this.hide();
		this.opts.onInsert?.();
	}

	hide(): void {
		if (this.debounceTimer != null) {
			window.clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		this.active = false;
		this.currentPrefix = null;
		this.items = [];
		this.itemEls = [];
		this.selectedIndex = 0;
		if (this.popup) this.popup.style.display = "none";
	}

	destroy(): void {
		if (this.debounceTimer != null) {
			window.clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		this.textarea.removeEventListener("input", this.onInput);
		this.textarea.removeEventListener("keydown", this.onKeydown);
		this.textarea.removeEventListener("blur", this.onBlur);
		const doc = this.textarea.ownerDocument ?? document;
		(doc.defaultView ?? window).removeEventListener("resize", this.onReposition);
		doc.removeEventListener("scroll", this.onReposition, true);
		this.popup?.remove();
		this.popup = null;
		this.active = false;
	}
}
