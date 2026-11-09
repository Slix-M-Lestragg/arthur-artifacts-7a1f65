/**
 * Recover pi's unsubmitted TUI editor text from xterm's headless screen buffer.
 *
 * The reference plugin used its obsidian-bridge APC extension (`pi:get-text`
 * followed by a base64 `pi:text` reply, then `pi:clear-text`). Arthur starts a
 * stock pi process and has no such RPC/APC peer, so this module deliberately
 * uses only the rendered screen. That makes it a conservative heuristic, not
 * an editor-state API: an unrecognised layout returns null and the caller must
 * leave the TUI untouched.
 *
 * Current pi-tui renders its Editor as horizontal `─` borders around one or
 * more text rows. The hardware cursor remains inside that box. Older/custom
 * prompt renderers with a leading `>`/`❯` are also accepted, including boxed
 * variants with vertical `│` borders. xterm's `isWrapped` distinguishes soft
 * continuations (joined) from logical lines (joined with `\n`).
 *
 * Limit: a screen cannot faithfully represent trailing padding or collapsed
 * paste-marker contents. Soft-wrap joining repairs the usual word-boundary
 * space, but an unusually wrapped token can be ambiguous; no scrollback or
 * off-screen editor rows are guessed at.
 */

export interface ScreenLineLike {
	translateToString(trimRight?: boolean): string;
	/** True when this row continues the preceding logical terminal line. */
	isWrapped?: boolean;
}

export interface TerminalScreenLike {
	cols?: number;
	buffer: {
		active: {
			cursorY: number;
			length: number;
			getLine(row: number): ScreenLineLike | undefined;
		};
	};
}

export interface PendingInput {
	text: string;
	/** Absolute active-buffer row where the recovered editor text starts. */
	lineStartRow: number;
}

interface CleanRow {
	text: string;
	wrapped: boolean;
}

// Do not scan the whole scrollback: the editable editor is a small bottom
// component, and an old transcript box must never become a pull candidate.
const MAX_EDITOR_ROWS = 60;
const PROMPT_PREFIX_RE = /^(?:>|❯)(?:\s+|$)/;
const VERTICAL_LEFT_RE = /^(?:│|┃)\s?/;
const VERTICAL_RIGHT_RE = /\s?(?:│|┃)$/;

function rawLine(term: TerminalScreenLike, row: number): ScreenLineLike | null {
	if (!Number.isInteger(row) || row < 0 || row >= term.buffer.active.length) return null;
	return term.buffer.active.getLine(row) ?? null;
}

function lineText(line: ScreenLineLike): string {
	try {
		return line.translateToString(true).replace(/[\r\n]+$/g, "");
	} catch {
		return "";
	}
}

/** Horizontal editor border, including pi's status/scroll-label variants and
 *  conventional decorated-box corners. Requiring dashes at both ends avoids
 *  treating an arbitrary transcript sentence as a border. */
function isHorizontalBorder(raw: string): boolean {
	const text = raw.trim();
	if (!text) return false;
	if (/^[╭┌][─━═]+[╮┐]$/.test(text) || /^[╰└][─━═]+[╯┘]$/.test(text)) return true;
	const dashes = (text.match(/[─━═]/g) ?? []).length;
	return dashes >= 3 && /^[─━═]{2,}/.test(text) && /[─━═]{2,}$/.test(text);
}

function cleanRow(raw: string, first: boolean): string {
	let text = raw.trim();
	text = text.replace(VERTICAL_LEFT_RE, "").replace(VERTICAL_RIGHT_RE, "").trim();
	if (first) text = text.replace(PROMPT_PREFIX_RE, "").trimStart();
	return text.trimEnd();
}

/** Join one soft-wrapped row. pi's word wrapper can leave the separating
 *  space in right-trimmed screen padding; restore it when the previous row
 *  was not a full-width, unbroken token. The full-token case is the common
 *  character-forced wrap and must not acquire a synthetic space. */
function joinSoft(text: string, row: CleanRow, previous: CleanRow, cols: number): string {
	if (!text || !row.text) return text + row.text;
	const previousWidth = previous.text.length + (PROMPT_PREFIX_RE.test(previous.text) ? 2 : 0);
	const fullUnbrokenToken = cols > 0 && previousWidth >= cols - 3 && !/\s/.test(previous.text);
	return text + (fullUnbrokenToken ? "" : " ") + row.text;
}

function joinRows(rows: CleanRow[], cols: number): string {
	let text = rows[0]?.text ?? "";
	for (let i = 1; i < rows.length; i++) {
		const row = rows[i];
		const previous = rows[i - 1];
		text = row.wrapped ? joinSoft(text, row, previous, cols) : `${text}\n${row.text}`;
	}
	return text;
}

/** The clear sequence can only walk backwards from the cursor's logical line.
 *  Refuse an editor with later logical lines rather than leaving a suffix in
 *  the TUI after copying the whole visible prompt. */
function cursorIsInFinalLogicalLine(lines: ScreenLineLike[], cursorOffset: number): boolean {
	for (let i = cursorOffset + 1; i < lines.length; i++) {
		if (!lines[i].isWrapped) return false;
	}
	return true;
}

function fromBorderedEditor(term: TerminalScreenLike): PendingInput | null {
	const buffer = term.buffer.active;
	const cursorY = buffer.cursorY;
	if (!Number.isInteger(cursorY)) return null;
	let top = -1;
	let bottom = -1;
	for (let row = cursorY - 1; row >= Math.max(0, cursorY - MAX_EDITOR_ROWS); row--) {
		const line = rawLine(term, row);
		if (line && isHorizontalBorder(lineText(line))) {
			top = row;
			break;
		}
	}
	for (let row = cursorY + 1; row < Math.min(buffer.length, cursorY + MAX_EDITOR_ROWS + 1); row++) {
		const line = rawLine(term, row);
		if (line && isHorizontalBorder(lineText(line))) {
			bottom = row;
			break;
		}
	}
	if (top < 0 || bottom <= top + 1 || cursorY <= top || cursorY >= bottom) return null;
	const lines: ScreenLineLike[] = [];
	for (let row = top + 1; row < bottom; row++) {
		const line = rawLine(term, row);
		if (!line) return null;
		lines.push(line);
	}
	if (!cursorIsInFinalLogicalLine(lines, cursorY - top - 1)) return null;
	const rows = lines.map((line, i) => ({
		text: cleanRow(lineText(line), i === 0),
		wrapped: i > 0 && line.isWrapped === true,
	}));
	const text = joinRows(rows, term.cols ?? 0);
	return text.trim() ? { text, lineStartRow: top + 1 } : null;
}

/** Fallback for older/custom single-prompt rendering without horizontal
 *  borders. An explicit prompt glyph is mandatory here: cursor proximity alone
 *  is not enough evidence to copy arbitrary terminal output. */
function fromPromptGlyph(term: TerminalScreenLike): PendingInput | null {
	const buffer = term.buffer.active;
	const cursorLine = rawLine(term, buffer.cursorY);
	if (!cursorLine) return null;
	let start = buffer.cursorY;
	while (start > 0) {
		const line = rawLine(term, start);
		if (!line?.isWrapped) break;
		start--;
	}
	const firstLine = rawLine(term, start);
	if (!firstLine) return null;
	let firstText = lineText(firstLine).trim().replace(VERTICAL_LEFT_RE, "").trimStart();
	if (!PROMPT_PREFIX_RE.test(firstText)) return null;
	const lines: ScreenLineLike[] = [];
	for (let row = start; row < buffer.length; row++) {
		const line = rawLine(term, row);
		if (!line || (row > start && !line.isWrapped)) break;
		lines.push(line);
		if (row >= buffer.cursorY && !rawLine(term, row + 1)?.isWrapped) break;
	}
	if (buffer.cursorY < start || buffer.cursorY >= start + lines.length) return null;
	const rows = lines.map((line, i) => ({
		text: cleanRow(lineText(line), i === 0),
		wrapped: i > 0 && line.isWrapped === true,
	}));
	const text = joinRows(rows, term.cols ?? 0);
	return text.trim() ? { text, lineStartRow: start } : null;
}

/** Extract the visible pending editor text, or null when the screen does not
 *  provide enough evidence. Pure and side-effect free (notably, no pty write). */
export function extractPendingInput(term: TerminalScreenLike | null | undefined): PendingInput | null {
	if (!term?.buffer?.active || typeof term.buffer.active.getLine !== "function") return null;
	return fromBorderedEditor(term) ?? fromPromptGlyph(term);
}

/**
 * Clear pi's editor WITHOUT submitting it. Ctrl+E moves to the logical line
 * end; Ctrl+U deletes that logical line regardless of how many soft-wrapped
 * screen rows it occupies. In pi-tui, Ctrl+U at column 0 of a later logical
 * line first merges it with the previous one, so N logical lines need N clears
 * plus N−1 merges: `Ctrl+E + Ctrl+U.repeat(2N−1)`. Never emit Enter/CR.
 */
export function buildClearPendingInput(text: string): string {
	const logicalLines = Math.max(1, String(text).split("\n").length);
	return "\x05" + "\x15".repeat(logicalLines * 2 - 1);
}

/** Move pulled text into a draft without concatenating two prompt fragments.
 *  Empty composers are replaced; existing drafts are kept and separated by a
 *  newline (less surprising than inserting at a possibly stale cursor). */
export function mergePulledPrompt(existing: string, pulled: string): string {
	if (!existing) return pulled;
	return existing + (existing.endsWith("\n") ? "" : "\n") + pulled;
}
