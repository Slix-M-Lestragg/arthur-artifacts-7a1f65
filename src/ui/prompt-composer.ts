/**
 * PromptComposer — the Wave 2 docked prompt panel at the BOTTOM of a pi
 * terminal leaf (the reference's `embedded` surface, minus its
 * popout/docked-window modes and its MarkdownView/CodeMirror machinery — a
 * plain multiline textarea here, since our submit path is bracketed paste,
 * not the APC marker that needs the obsidian-bridge pi extension).
 *
 * Contents (top → bottom): drag resizer → full-width textarea BLOCK that
 * fills the panel's remaining height edge to edge and AUTO-GROWS with content
 * up to the composer max-height setting (Wave 5a — the text element is the
 * panel's BODY, never a squeezed row item) → ONE slim FOOTER toolbar strip
 * (Wave 5a moved the Wave 4/FIX C pi command buttons New / Resume… /
 * Compact / Thinking onto the terminal view's TOP toolbar; the strip carries
 * the reference-ported composer controls — send / clear / insert note /
 * insert selection / slash-command picker / insert `[[wikilink]]` token /
 * word-char count — as a right-aligned icon-only cluster, then the
 * count/flash/hide tail) → transient "sent" flash. An `@`-file suggester
 * (at-suggester.ts) rides the textarea, and the `square-slash` button opens
 * the LOCAL command picker (pi-commands.ts).
 *
 * Submit semantics — BRACKETED PASTE (reference PtyClient
 * `submitPromptViaPaste`): the composer hands the raw text to the host, which
 * rewrites Obsidian links to absolute paths and writes
 * `\x1b[200~<text>\x1b[201~\r` into the pty — the trailing Enter lands AFTER
 * the paste-end marker, so newlines inside the text can never submit
 * mid-paste. ESC bytes are stripped from the text first (embedded note content
 * containing `ESC[201~` would otherwise break out of the paste and inject raw
 * keystrokes into the pi TUI).
 *
 * Focus: the composer is a separate element from xterm — keystrokes in the
 * textarea never reach the terminal. Mod+Enter submits; plain Enter inserts a
 * newline (never submits).
 *
 * Drafts: per-instance, IN-MEMORY on the TerminalManager (keyed by the leaf's
 * cwd) — written on every input, restored on leaf focus and view rebuild.
 */
import { getIcon, setIcon } from "obsidian";

import { PI_ROW_ICONS } from "../icons";
import type ArthurPlugin from "../main";
import { el } from "../util";
import type { LinkResolver } from "./link-rewrite";
import { rewriteContextLinks } from "./link-rewrite";
import { FileAtSuggester, insertCompletion, type FsDeps } from "./at-suggester";
import { listPiCommands, PiCommandPickerModal, type PiCommand } from "./pi-commands";

/** Bracketed-paste markers + the single trailing Enter of a submit. */
export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

/**
 * Build the exact byte sequence a submit writes into the pty:
 * `ESC[200~` + text + `ESC[201~` + ONE trailing `\r`. ESC bytes are stripped
 * from the text so it cannot break out of the paste (see module doc).
 * Pure — exported for smoke.
 */
export function buildPasteSubmit(text: string): string {
	return PASTE_START + String(text ?? "").replace(/\x1b/g, "") + PASTE_END + "\r";
}

/** Minimum composer height (px) the resizer will not shrink past. */
export const COMPOSER_MIN_HEIGHT = 72;
/** Hard ceiling for the composer's share of the leaf (settings clamp to this). */
export const COMPOSER_MAX_HEIGHT_PCT = 60;
/** CSS default panel height (px) — the auto-grow floor before content grows. */
export const COMPOSER_DEFAULT_HEIGHT = 140;
/** Fixed chrome the auto-grow math must budget above the textarea content:
 *  resizer strip (6px, matches CSS) + footer toolbar (~28px) + padding. */
const COMPOSER_GROW_CHROME = 6 + 28 + 8;

/**
 * Clamp a dragged composer height: ≥ COMPOSER_MIN_HEIGHT px and ≤ `maxPct`
 * percent of the leaf's height (the setting, itself capped at
 * COMPOSER_MAX_HEIGHT_PCT by `maxHeightPct()`). Pure — exported for smoke.
 */
export function clampComposerHeight(px: number, viewHeight: number, maxPct: number): number {
	const max = Math.max(COMPOSER_MIN_HEIGHT, Math.round((viewHeight || 0) * (maxPct / 100)));
	return Math.min(Math.max(px, COMPOSER_MIN_HEIGHT), max);
}

/** The terminal view's side of the composer — everything the panel needs from
 *  its leaf (drafts, pty submit, resolver, vault reads). Injected so the
 *  composer stays view-agnostic and smoke can drive it through the real view. */
export interface ComposerHost {
	/** The leaf's cwd — the draft key + the `@` suggester's base dir (null =
	 *  unbound leaf: no drafts, no suggestions). */
	cwd(): string | null;
	/** Read the stored draft for the current cwd ('' when none). */
	getDraft(): string;
	/** Store the draft for the current cwd ('' clears it). */
	setDraft(text: string): void;
	/** Wikilink/embed → absolute-path resolver for submit + note insertion. */
	resolver(): LinkResolver;
	/** Rewrite links + bracketed-paste the text into the pty. False when the
	 *  leaf has no live pty (refused). */
	submit(text: string): boolean;
	/** Available leaf height (px) for the resizer clamp. */
	viewHeight(): number;
	/** Re-fit xterm after the composer's height changed. */
	scheduleFit(): void;
	/** The active note (name + absolute path + content) for the insert button,
	 *  or null when there is none / the vault can't read it. */
	activeNote(): Promise<{ name: string; absPath: string; content: string } | null>;
	/** The active editor's selection (note basename + text), or null/empty. */
	activeSelection(): { note: string; text: string } | null;
}

/** One pi command button definition for the terminal view's TOP toolbar
 *  (Wave 5a moved New/Resume…/Compact/Thinking OUT of the composer row; the
 *  VIEW renders these itself so the pty wiring stays there). */
export interface PiRowAction {
	/** Stable id → the button's `id="pi-btn-<id>"` (smoke asserts order). */
	id: string;
	/** Lucide icon name (PI_ROW_ICONS values in production). */
	icon: string;
	/** Tooltip / aria-label (the buttons are icon-only). */
	label: string;
	/** Click handler — receives the anchor button (popovers position off it). */
	run: (btn: HTMLButtonElement) => void;
}

export interface PromptComposerOpts {
	/** Injected fs for the `@` suggester (tests); production = real fs. */
	fs?: FsDeps;
	/** Command-list source for the slash picker (tests inject a fake ~.pi
	 *  tree); production default = listPiCommands()' local scan. */
	piCommands?: () => PiCommand[];
}

export class PromptComposer {
	/** Panel root (appended last in the view → sits at the BOTTOM). */
	readonly rootEl: HTMLElement;
	/** Drag handle strip on the panel's top edge. */
	readonly resizerEl: HTMLElement;
	readonly toolbarEl: HTMLElement;
	/** The panel-body textarea (full width, fills the panel's height). */
	readonly textarea: HTMLTextAreaElement;
	/** Transient "✓ sent" flash element. */
	readonly sentEl: HTMLElement;
	/** Word/char count readout (toggled). */
	readonly statsEl: HTMLElement;
	readonly hideBtn: HTMLButtonElement;
	/** The @-file suggester riding the textarea. */
	readonly suggester: FileAtSuggester;

	private visible = true;
	private statsOn = false;
	private sentTimer: number | null = null;
	/** Bound drag listeners (removed on destroy so a mid-drag close is clean). */
	private dragMove: ((e: MouseEvent) => void) | null = null;
	private dragUp: (() => void) | null = null;

	constructor(
		parent: HTMLElement,
		private readonly host: ComposerHost,
		private readonly plugin: ArthurPlugin,
		private readonly opts: PromptComposerOpts = {},
	) {
		this.rootEl = el("div", { cls: "arthur-pi-composer" });
		this.resizerEl = el("div", { cls: "arthur-pi-composer-resizer", attrs: { title: "drag to resize" } });
		this.toolbarEl = el("div", { cls: "arthur-pi-composer-toolbar" });
		this.textarea = el("textarea", {
			cls: "arthur-pi-composer-input",
			attrs: { placeholder: "Prompt pi…  (Mod+Enter to send, Enter for newline)" },
		}) as HTMLTextAreaElement;
		this.textarea.value = "";
		this.sentEl = el("span", { cls: "arthur-pi-composer-sent" });
		this.statsEl = el("span", { cls: "arthur-pi-composer-stats" });
		this.statsEl.style.display = "none";

		this.hideBtn = this.iconBtn("chevron-down", "Hide the prompt composer", () => this.setVisible(false), "hide");

		// WAVE 5a: the pi command buttons (New/Resume…/Compact/Thinking) moved
		// OUT of this row onto the terminal view's TOP toolbar — this strip is a
		// slim FOOTER below the textarea (right-aligned icon-only cluster after
		// a spacer). Every button carries a stable `pi-btn-<id>` id for smoke.
		const sendBtn = this.iconBtn(PI_ROW_ICONS.send, "Send to pi (Mod+Enter)", () => this.submitNow(), "send");
		const clearBtn = this.iconBtn(PI_ROW_ICONS.clear, "Clear the composer", () => this.clearNow(), "clear");
		const noteBtn = this.iconBtn(PI_ROW_ICONS.note, "Insert the active note as context", () => void this.insertActiveNote(), "note");
		const selBtn = this.iconBtn(PI_ROW_ICONS.selection, "Insert the current selection", () => this.insertSelection(), "selection");
		const cmdBtn = this.iconBtn(PI_ROW_ICONS.command, "Insert a pi slash command", () => this.openCommandPicker(), "command");
		const linkBtn = this.iconBtn(PI_ROW_ICONS.link, "Insert a [[wikilink]] token", () => this.insertWikilinkToken(), "link");
		const statsBtn = this.iconBtn(PI_ROW_ICONS.stats, "Toggle word/char count", () => this.toggleStats(), "stats");
		this.toolbarEl.append(
			this.spacer(),
			sendBtn,
			clearBtn,
			this.sep(),
			noteBtn,
			selBtn,
			cmdBtn,
			linkBtn,
			this.sep(),
			statsBtn,
			this.statsEl,
			this.sentEl,
			this.hideBtn,
		);

		// WAVE 5a DOM order: resizer → TEXTAREA (the panel body — full panel
		// width, grows to fill the panel's height) → slim footer toolbar. The
		// text element never shares a row with the buttons, so nothing can
		// squeeze it.
		this.rootEl.append(this.resizerEl, this.textarea, this.toolbarEl);
		parent.append(this.rootEl);

		// NOTE: the composer's own input/keydown listeners are registered BEFORE
		// the suggester so they run FIRST — the keydown handler must be able to
		// see `suggester.isActive` and yield every key to it (reference order).
		this.textarea.addEventListener("input", this.onInput);
		this.textarea.addEventListener("keydown", this.onKeydown);
		this.resizerEl.addEventListener("mousedown", this.onResizeStart);

		this.suggester = new FileAtSuggester(this.textarea, {
			baseDir: () => this.host.cwd(),
			fs: this.opts.fs,
			onInsert: () => this.afterInput(),
		});

		this.restoredDraft();
		// FIX D: the prompt font size is applied at CONSTRUCT time (settings
		// change → new terminals/new leaves pick it up, mirroring xterm's font
		// settings), then the panel is fit to the restored content.
		this.applyPromptFont();
		this.autoGrow();
		this.setVisible(this.plugin.settings.piTerminalComposerVisible);
	}

	// ------------------------------------------------------------- behavior

	get isVisible(): boolean {
		return this.visible;
	}

	/** Show/hide the panel (the `hide` button + the state-line toggle). */
	setVisible(visible: boolean): void {
		this.visible = visible;
		this.rootEl.style.display = visible ? "" : "none";
		this.resizerEl.style.display = visible ? "" : "none";
		if (visible) this.host.scheduleFit();
	}

	toggle(): void {
		this.setVisible(!this.visible);
	}

	/** Pull the stored draft into the textarea (leaf focus / cwd change).
	 *  Skipped while the user is typing in it — their text wins. */
	restoreDraft(): void {
		if (document.activeElement === this.textarea) return;
		this.restoredDraft();
	}

	/** Unconditional draft pull (constructor + cwd change). */
	private restoredDraft(): void {
		const draft = this.host.getDraft();
		if ((this.textarea.value ?? "") !== draft) this.textarea.value = draft;
		this.autoGrow();
	}

	/** Persist every input into the per-instance draft store. */
	private onInput = (): void => this.afterInput();

	private afterInput(): void {
		this.host.setDraft(this.textarea.value ?? "");
		if (this.statsOn) this.updateStats();
		this.autoGrow();
	}

	/** Mod+Enter submits; plain Enter is a plain newline. When the @-suggester
	 *  owns the keyboard (active popup) every key goes to it untouched. */
	private onKeydown = (e: KeyboardEvent): void => {
		if (this.suggester.isActive) return;
		if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
			e.preventDefault();
			e.stopPropagation();
			this.submitNow();
		}
		// plain Enter → default textarea newline (NEVER submits)
	};

	/** Hand the draft to the host for rewrite + bracketed-paste submit.
	 *  Returns true when the bytes were written. Empty text → refused. */
	submitNow(): boolean {
		const text = this.textarea.value ?? "";
		if (!text.trim()) {
			this.flash("nothing to send");
			return false;
		}
		if (!this.host.submit(text)) {
			this.flash("no live terminal");
			return false;
		}
		if (this.plugin.settings.piTerminalClearPromptOnSubmit) {
			this.textarea.value = "";
			this.host.setDraft("");
		}
		if (this.statsOn) this.updateStats();
		this.autoGrow();
		this.flash("✓ sent");
		return true;
	}

	/** Transient affordance: set the flash text, re-arm the auto-hide timer. */
	private flash(text: string): void {
		this.sentEl.setText(text);
		if (this.sentTimer !== null) window.clearTimeout(this.sentTimer);
		this.sentTimer = window.setTimeout(() => {
			this.sentTimer = null;
			this.sentEl.setText("");
		}, 1200);
	}

	// -------------------------------------------------------------- inserts

	/** Reference `eraser` action: empty the composer (draft + count follow). */
	private clearNow(): void {
		this.textarea.value = "";
		this.afterInput();
		this.flash("cleared");
		if (typeof this.textarea.focus === "function") this.textarea.focus();
	}

	/** Reference `square-slash` action: the LOCAL command picker (pi-commands.ts
	 *  scans ~/.pi/agent/{prompts,skills} + builtins — no RPC), inserting
	 *  `/<name>` at the cursor. */
	private openCommandPicker(): void {
		const commands = this.opts.piCommands ? this.opts.piCommands() : listPiCommands();
		new PiCommandPickerModal(this.plugin.app, commands, (commandText) => this.insertAtCursor(commandText)).open();
	}

	/** Splice `text` at the cursor, store the draft, restore focus. */
	insertAtCursor(text: string): void {
		const value = this.textarea.value ?? "";
		const start = this.textarea.selectionStart ?? value.length;
		const end = this.textarea.selectionEnd ?? start;
		const res = insertCompletion(value, start, end, text);
		this.textarea.value = res.value;
		if (typeof this.textarea.setSelectionRange === "function") {
			this.textarea.setSelectionRange(res.cursor, res.cursor);
		}
		this.textarea.focus();
		this.afterInput();
	}

	/** Insert the active note as a context block (links rewritten to
	 *  absolute paths — same payload shape as the send-note command, minus the
	 *  trailing Enter: the composer submits when the user is ready). */
	private async insertActiveNote(): Promise<void> {
		const note = await this.host.activeNote();
		if (!note) {
			this.flash("no active note");
			return;
		}
		const content = rewriteContextLinks(note.content, this.host.resolver());
		this.insertAtCursor(
			`Here is the content of my note "${note.name}" (at ${note.absPath}):\n\n---\n${content}\n---\n`,
		);
		this.flash(`+ note (${note.name})`);
	}

	/** Insert the active editor's selection (links rewritten). */
	private insertSelection(): void {
		const sel = this.host.activeSelection();
		if (!sel || !sel.text) {
			this.flash("no selection");
			return;
		}
		const content = rewriteContextLinks(sel.text, this.host.resolver());
		this.insertAtCursor(
			`Here is the selected text from my note "${sel.note}":\n\n---\n${content}\n---\n`,
		);
		this.flash(`+ selection (${sel.text.length} chars)`);
	}

	/** Insert a bare `[[…]]` wikilink token with the cursor between the
	 *  brackets (Obsidian-style) — resolved on submit like any other link. */
	private insertWikilinkToken(): void {
		this.insertAtCursor("[[]]");
		const cursor = this.textarea.selectionStart ?? 0;
		const pos = Math.max(0, cursor - 2);
		if (typeof this.textarea.setSelectionRange === "function") {
			this.textarea.setSelectionRange(pos, pos);
		}
	}

	// ---------------------------------------------------------- stats/resizer

	/** FIX D: apply the `promptFontSize` setting to the textarea (construct time
	 *  + settings change → new leaves). The class/style pair is what smoke
	 *  asserts. */
	private applyPromptFont(): void {
		const size = this.plugin.settings.promptFontSize || 16;
		this.textarea.style.fontSize = `${size}px`;
		this.textarea.addClass("arthur-pi-composer-input");
		this.textarea.setAttribute("data-prompt-font-size", String(size));
	}

	/**
	 * FIX D: content-driven growth — the textarea has NO line cap; the PANEL
	 * grows to fit it, clamped to the composer max-height % of the view (the
	 * setting). GROW-ONLY: a user drag or an earlier larger content is never
	 * yanked back mid-typing; shrink happens only via the drag handle / hide.
	 * No-op where layout metrics are unavailable (smoke's zero-sized stubs
	 * report scrollHeight 0), and it keeps the text scrollable once the panel
	 * is at its max-height ceiling.
	 */
	autoGrow(): void {
		if (!this.visible) return;
		const contentH = Number(this.textarea.scrollHeight) || 0;
		if (!(contentH > 0)) return;
		const toolbarH = Number(this.toolbarEl.getBoundingClientRect?.().height) || 0;
		const needed = COMPOSER_GROW_CHROME + (toolbarH || 28) + contentH;
		const target = Math.max(this.currentHeight(), needed, COMPOSER_MIN_HEIGHT);
		const h = clampComposerHeight(target, this.host.viewHeight(), this.maxHeightPct());
		if (Number.isFinite(h) && h > 0) this.rootEl.style.height = `${h}px`;
	}

	toggleStats(): void {
		this.statsOn = !this.statsOn;
		this.statsEl.style.display = this.statsOn ? "" : "none";
		if (this.statsOn) this.updateStats();
	}

	private updateStats(): void {
		const text = this.textarea.value ?? "";
		const words = text.split(/\s+/).filter(Boolean).length;
		this.statsEl.setText(`${words} words · ${text.length} chars`);
	}

	/** The configured max-height %, clamped to the hard 20–60% window. */
	maxHeightPct(): number {
		const raw = this.plugin.settings.piTerminalComposerMaxHeight;
		return Math.min(COMPOSER_MAX_HEIGHT_PCT, Math.max(20, raw || 50));
	}

	/** Drag start: capture the anchor height, then move/up on the document. */
	private onResizeStart = (e: MouseEvent): void => {
		e.preventDefault();
		if (!this.visible) return;
		this.startHeight();
		const startY = e.clientY;
		const startH = this.currentHeight();
		this.dragMove = (ev: MouseEvent) => {
			const h = clampComposerHeight(startH + (startY - ev.clientY), this.host.viewHeight(), this.maxHeightPct());
			this.rootEl.style.height = `${h}px`;
			this.host.scheduleFit();
		};
		this.dragUp = () => this.stopDrag();
		document.addEventListener("mousemove", this.dragMove);
		document.addEventListener("mouseup", this.dragUp);
	};

	private stopDrag(): void {
		if (this.dragMove) document.removeEventListener("mousemove", this.dragMove);
		if (this.dragUp) document.removeEventListener("mouseup", this.dragUp);
		this.dragMove = null;
		this.dragUp = null;
	}

	/** Current height in px: inline style → measured box → CSS default. */
	private currentHeight(): number {
		const inline = parseInt(String(this.rootEl.style?.height ?? ""), 10);
		if (Number.isFinite(inline) && inline > 0) return inline;
		return this.startHeight();
	}

	/** Measure (or fall back to the CSS default height) once per drag. */
	private startHeight(): number {
		const measured = this.rootEl.getBoundingClientRect?.().height ?? 0;
		return measured > 0 ? measured : COMPOSER_DEFAULT_HEIGHT;
	}

	// ---------------------------------------------------------------- misc

	/** Small lucide icon button (falls back to the label text when the icon
	 *  registry lacks the id — mirrors TerminalView.getIcon's fallback).
	 *  `id` (optional) becomes `id="pi-btn-<id>"` — smoke's row-order probe. */
	private iconBtn(icon: string, label: string, onClick: () => void, id?: string): HTMLButtonElement {
		const btn = el("button", {
			cls: "arthur-pi-composer-btn",
			attrs: {
				"aria-label": label,
				title: label,
				...(id ? { id: `pi-btn-${id}` } : {}),
			},
		}) as HTMLButtonElement;
		if (getIcon(icon)) setIcon(btn, icon);
		else btn.setText(label);
		btn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			onClick();
		});
		return btn;
	}

	private sep(): HTMLElement {
		return el("span", { cls: "arthur-pi-composer-sep" });
	}

	/** Flexible gap: pushes everything after it into the right-aligned cluster. */
	private spacer(): HTMLElement {
		return el("span", { cls: "arthur-pi-composer-spacer" });
	}

	/** Teardown (view close): timers, drag listeners, suggester. Idempotent. */
	destroy(): void {
		if (this.sentTimer !== null) {
			window.clearTimeout(this.sentTimer);
			this.sentTimer = null;
		}
		this.stopDrag();
		this.suggester.destroy();
		this.textarea.removeEventListener("input", this.onInput);
		this.textarea.removeEventListener("keydown", this.onKeydown);
	}
}
