/**
 * Local pi terminal picker (Modal) — the local-pty entry point of the 'Open pi
 * terminal' command and the pi-panel opts-callback. Lists local pi sessions by
 * scanning `~/.pi/agent/sessions/` (one subdir per cwd; dir names encode the
 * cwd slug, the authoritative cwd is read from the most-recent session jsonl's
 * first `{"type":"session","cwd":"…"}` line), sorted most-recent first.
 *
 * No remote anything — pure Node `fs`/`path`/`os` (desktop-only; the command
 * is hidden on mobile in main.ts). Rows: cwd + a relative mtime. Selecting a
 * row routes through `onPick(cwd)` → `TerminalManager.openTerminal(cwd)` (an
 * already-open cwd focuses its leaf). A top 'New terminal in vault root'
 * action spawns a terminal at the vault's filesystem root, and a cwd input row
 * lets the user type any absolute path + Enter.
 *
 * The listing is read once via `opts.loadSessions()` (so tests inject a fake
 * sessions dir / fake reader); `defaultPiSessionsDir()` + `listLocalPiSessions`
 * are the production backing (re-exported for smoke).
 */
import { App, Modal } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { el, truncate } from "../util";

/** One local pi session row: a cwd + its most-recent session mtime + the
 *  most-recent `.jsonl` file path (for `pi --session <file>` resume). */
export interface LocalPiSession {
	cwd: string;
	mtimeMs: number;
	/** Absolute path to the most-recent `.jsonl` session file for this cwd
	 *  (undefined when the subdir held no jsonl — a decoded-name-only entry). */
	file?: string;
	/** Size in bytes of the most-recent `.jsonl` session file (undefined when
	 *  the subdir held no jsonl). Populated by `listLocalPiSessions`; the
	 *  picker ignores it, the pi-farm view renders it in its size column. */
	size?: number;
}

/** One `.jsonl` session file in a cwd's sessions subdir (newest first). */
export interface SessionFileInfo {
	/** Absolute path to the `.jsonl` file. */
	path: string;
	/** Filename without the `.jsonl` extension. */
	name: string;
	/** mtime (epoch ms). */
	mtime: number;
}

/** The production sessions directory: `~/.pi/agent/sessions/`. */
export function defaultPiSessionsDir(): string {
	return path.join(os.homedir(), ".pi", "agent", "sessions");
}

/** Best-effort decode of a sessions subdir name into a cwd. The name encodes
 *  the absolute path with `/` → `-` and a `--…--` wrap (e.g. `/home/slix` →
 *  `--home-slix--`); literal dashes in path components make this ambiguous, so
 *  the authoritative cwd is read from the session jsonl — this is only a
 *  fallback when a subdir holds no jsonl. */
export function decodeSessionDirName(name: string): string {
	let s = name;
	if (s.startsWith("--")) s = s.slice(2);
	if (s.endsWith("--")) s = s.slice(0, -2);
	if (!s) return "/";
	return "/" + s.replace(/-/g, "/");
}

/**
 * Scan a sessions directory: one entry per subdir, cwd read from the
 * most-recent `.jsonl` session file's first line (falling back to the decoded
 * subdir name), mtime = that file's mtime (or the subdir's when empty). Sorted
 * most-recent first. Returns [] when the directory is missing/unreadable.
 */
export function listLocalPiSessions(dir: string): LocalPiSession[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const out: LocalPiSession[] = [];
	for (const name of entries) {
		const full = path.join(dir, name);
		let st: fs.Stats;
		try {
			st = fs.statSync(full);
		} catch {
			continue;
		}
		if (!st.isDirectory()) continue;
		// Find the most-recent .jsonl session file inside the subdir.
		let files: string[];
		try {
			files = fs.readdirSync(full);
		} catch {
			files = [];
		}
		let best: { file: string; mtime: number; size: number } | null = null;
		for (const f of files) {
			if (!f.endsWith(".jsonl")) continue;
			const fp = path.join(full, f);
			let fst: fs.Stats;
			try {
				fst = fs.statSync(fp);
			} catch {
				continue;
			}
			if (!best || fst.mtimeMs > best.mtime)
				best = { file: fp, mtime: fst.mtimeMs, size: fst.size };
		}
		let cwd = decodeSessionDirName(name);
		const mtimeMs = best?.mtime ?? st.mtimeMs;
		if (best) {
			// Authoritative cwd: the first jsonl line's `{"cwd":"…"}`.
			try {
				const fd = fs.openSync(best.file, "r");
				try {
					const buf = Buffer.alloc(8192);
					const n = fs.readSync(fd, buf, 0, 8192, 0);
					const firstLine = buf.subarray(0, n).toString("utf8").split("\n")[0];
					const parsed = JSON.parse(firstLine) as { cwd?: unknown };
					if (typeof parsed?.cwd === "string" && parsed.cwd.trim()) cwd = parsed.cwd;
				} finally {
					fs.closeSync(fd);
				}
			} catch {
				// keep the decoded name
			}
		}
		out.push({
			cwd,
			mtimeMs,
			...(best ? { file: best.file, size: best.size } : {}),
		});
	}
	out.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return out;
}

/** Find the sessions subdir for a cwd by scanning the sessions root and
 *  matching the authoritative cwd read from each subdir's most-recent jsonl
 *  first line (the slug-based dir name is ambiguous with literal dashes, so
 *  we read the real cwd). Returns null when no subdir matches. */
function findCwdSessionDir(dir: string, cwd: string): string | null {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return null;
	}
	for (const name of entries) {
		const full = path.join(dir, name);
		let st: fs.Stats;
		try {
			st = fs.statSync(full);
		} catch {
			continue;
		}
		if (!st.isDirectory()) continue;
		let files: string[];
		try {
			files = fs.readdirSync(full);
		} catch {
			continue;
		}
		let best: { file: string; mtime: number } | null = null;
		for (const f of files) {
			if (!f.endsWith(".jsonl")) continue;
			const fp = path.join(full, f);
			let fst: fs.Stats;
			try {
				fst = fs.statSync(fp);
			} catch {
				continue;
			}
			if (!best || fst.mtimeMs > best.mtime) best = { file: fp, mtime: fst.mtimeMs };
		}
		if (!best) continue;
		let dirCwd = decodeSessionDirName(name);
		try {
			const fd = fs.openSync(best.file, "r");
			try {
				const buf = Buffer.alloc(8192);
				const n = fs.readSync(fd, buf, 0, 8192, 0);
				const firstLine = buf.subarray(0, n).toString("utf8").split("\n")[0];
				const parsed = JSON.parse(firstLine) as { cwd?: unknown };
				if (typeof parsed?.cwd === "string" && parsed.cwd.trim()) dirCwd = parsed.cwd;
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			/* keep decoded */
		}
		if (dirCwd === cwd) return full;
	}
	return null;
}

/** List the `.jsonl` session files for a cwd, newest first. Used by the
 *  slash toolbar's "Resume…" action to respawn `pi --session <file>`. Returns
 *  [] when the cwd has no sessions subdir (or it's unreadable). */
export function listSessionFilesForCwd(sessionsDir: string, cwd: string): SessionFileInfo[] {
	const sub = findCwdSessionDir(sessionsDir, cwd);
	if (!sub) return [];
	let files: string[];
	try {
		files = fs.readdirSync(sub);
	} catch {
		return [];
	}
	const out: SessionFileInfo[] = [];
	for (const f of files) {
		if (!f.endsWith(".jsonl")) continue;
		const fp = path.join(sub, f);
		let st: fs.Stats;
		try {
			st = fs.statSync(fp);
		} catch {
			continue;
		}
		if (!st.isFile()) continue;
		out.push({ path: fp, name: f.replace(/\.jsonl$/, ""), mtime: st.mtimeMs });
	}
	out.sort((a, b) => b.mtime - a.mtime);
	return out;
}

/** The picker's opts bag — `loadSessions` is injectable for tests. */
export interface TerminalPickerOpts {
	/** Load the local session list (injected so tests can fake the dir). */
	loadSessions(): Promise<LocalPiSession[]>;
	/** The vault's filesystem root — the 'New terminal in vault root' target. */
	vaultRootCwd: string;
	/** A cwd was chosen (row click, vault-root button, or cwd-input Enter).
	 *  `sessionFile` is the most-recent `.jsonl` for that cwd when a row was
	 *  picked (so the terminal resumes that exact session via `pi --session`). */
	onPick(cwd: string, title?: string, sessionFile?: string): void;
	/** Optional 'browse all sessions' affordance rendered in the empty state —
	 *  wired by main.ts to open the pi farm view. */
	onBrowseAll?(): void;
}

/**
 * Case-insensitive subsequence match: every query character must appear in
 * the haystack in order (classic fuzzy-picker semantics — "sA" matches
 * "session A"). An empty query matches everything.
 */
export function fuzzyMatch(query: string, haystack: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	const h = haystack.toLowerCase();
	let i = 0;
	for (const ch of h) {
		if (ch === q[i]) i += 1;
		if (i === q.length) return true;
	}
	return false;
}

/** A coarse relative age for an mtime (e.g. "3m ago", "2d ago"). */
function ageOf(mtimeMs: number): string {
	const s = Math.max(0, Math.floor((Date.now() - mtimeMs) / 1000));
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	return `${d}d ago`;
}

export class TerminalPickerModal extends Modal {
	private bodyEl: HTMLElement | null = null;
	/** Top control row container (vault-root button + cwd input + state). */
	private controlEl: HTMLElement | null = null;
	private query = "";
	private loading = true;
	private loadError: string | null = null;
	private rows: LocalPiSession[] = [];
	/** Stale-response guard for the async load chain. */
	private seq = 0;

	constructor(
		app: App,
		private readonly opts: TerminalPickerOpts,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("pi terminal — choose a working directory");
		this.contentEl.empty();
		this.contentEl.addClass("arthur-terminal-picker");
		// Top control row: 'New terminal in vault root' + a cwd input.
		this.controlEl = this.contentEl.createEl("div", { cls: "arthur-terminal-new" });
		// Fuzzy filter input (matches cwd).
		const filter = document.createElement("input");
		filter.className = "arthur-terminal-filter";
		filter.type = "text";
		filter.placeholder = "filter sessions by directory";
		filter.addEventListener("input", () => {
			this.query = filter.value ?? "";
			this.paintBody();
		});
		filter.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.enterFirstRow();
			}
		});
		this.contentEl.append(filter);
		this.bodyEl = this.contentEl.createEl("div", { cls: "arthur-terminal-picker-body" });
		this.paintControl();
		void this.refresh();
	}

	/** Load the session list through the backing call; a stale response never
	 *  paints over a newer one (seq guard). */
	private async refresh(): Promise<void> {
		const seq = ++this.seq;
		this.loading = true;
		this.loadError = null;
		this.paintBody();
		try {
			const sessions = await this.opts.loadSessions();
			if (seq !== this.seq) return;
			this.rows = sessions.slice();
		} catch (err) {
			if (seq !== this.seq) return;
			this.loadError = err instanceof Error ? err.message : String(err);
		} finally {
			if (seq === this.seq) this.loading = false;
		}
		this.paintBody();
	}

	/** Rows surviving the fuzzy filter (cwd match). */
	private visibleRows(): LocalPiSession[] {
		const q = this.query.trim();
		if (!q) return this.rows;
		return this.rows.filter((s) => fuzzyMatch(q, s.cwd));
	}

	/** Enter in the filter: acts as a click on the first row (if any). */
	private enterFirstRow(): void {
		const first = this.visibleRows()[0];
		if (first) this.pick(first);
	}

	/** Select a cwd: route into the manager, close. Resumes the row's exact
	 *  session file when present (picker rows carry the most-recent jsonl). */
	private pick(session: LocalPiSession): void {
		const cwd = session.cwd.trim();
		if (!cwd) return;
		this.opts.onPick(
			cwd,
			cwd.split("/").filter(Boolean).pop() || cwd,
			session.file,
		);
		this.close();
	}

	/** Full repaint of the control row + the list. */
	private paintControl(): void {
		const control = this.controlEl;
		if (!control) return;
		control.empty();
		const vaultRoot = (this.opts.vaultRootCwd ?? "").trim();
		const rootBtn = document.createElement("button");
		rootBtn.addClass("arthur-btn", "arthur-btn--tiny", "arthur-terminal-new-btn");
		rootBtn.textContent = vaultRoot ? "New terminal in vault root" : "New terminal";
		rootBtn.setAttribute(
			"title",
			vaultRoot
				? `Spawn a fresh pi terminal in the vault root (${truncate(vaultRoot, 64)})`
				: "Spawn a fresh pi terminal (no vault root available — type a path below)",
		);
		rootBtn.disabled = false;
		rootBtn.addEventListener("click", () => {
			const cwd = (this.opts.vaultRootCwd ?? "").trim();
			if (!cwd) return;
			this.opts.onPick(cwd, cwd.split("/").filter(Boolean).pop() || cwd);
			this.close();
		});
		control.append(rootBtn);
		// cwd input row: type an absolute path + Enter (or the Open button).
		const row = document.createElement("div");
		row.addClass("arthur-terminal-new-row");
		const input = document.createElement("input");
		input.className = "arthur-terminal-new-cwd";
		input.type = "text";
		input.placeholder = "or type an absolute path, then Enter";
		input.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter") {
				e.preventDefault();
				const cwd = (input.value ?? "").trim();
				if (!cwd) return;
				this.opts.onPick(cwd, cwd.split("/").filter(Boolean).pop() || cwd);
				this.close();
			}
		});
		row.append(input);
		const openBtn = document.createElement("button");
		openBtn.addClass("arthur-btn", "arthur-btn--tiny");
		openBtn.textContent = "Open";
		openBtn.addEventListener("click", () => {
			const cwd = (input.value ?? "").trim();
			if (!cwd) return;
			this.opts.onPick(cwd, cwd.split("/").filter(Boolean).pop() || cwd);
			this.close();
		});
		row.append(openBtn);
		control.append(row);
	}

	private paintBody(): void {
		if (!this.bodyEl) return; // onOpen not finished yet
		this.bodyEl.empty();
		const list = this.bodyEl.createEl("div", { cls: "arthur-terminal-list" });
		if (this.loading && this.rows.length === 0) {
			list.append(note("loading sessions…"));
			return;
		}
		if (this.loadError) {
			list.append(note(`session listing failed — ${this.loadError}`, "arthur-terminal-note--err"));
		}
		const rows = this.visibleRows();
		if (rows.length === 0) {
			if (!this.loadError) {
				list.append(
					note(
						this.rows.length === 0
							? "no local pi sessions — type a path above or use the vault-root button"
							: "no sessions match the filter",
					),
				);
				// 'browse all sessions →' affordance → opens the pi farm view (Wave 3).
				if (this.rows.length === 0 && typeof this.opts.onBrowseAll === "function") {
					const browse = el("div", {
						cls: "arthur-terminal-browse-all",
						attrs: {
							role: "button",
							title: "Open the pi farm view (all local sessions, open + dormant)",
						},
						text: "browse all sessions →",
					});
					browse.addEventListener("click", () => {
						this.opts.onBrowseAll?.();
						this.close();
					});
					list.append(browse);
				}
			}
			return;
		}
		for (const session of rows) list.append(this.rowFor(session));
		const buttons = this.bodyEl.createEl("div", { cls: "arthur-modal-buttons" });
		const cancel = buttons.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.close());
	}

	/** One session row: cwd + relative mtime; clickable. */
	private rowFor(session: LocalPiSession): HTMLElement {
		const cwd = session.cwd;
		const title = cwd.split("/").filter(Boolean).pop() || cwd;
		const row = el("div", {
			cls: "arthur-terminal-row",
			attrs: {
				"data-terminal-cwd": cwd,
				role: "button",
				title: `Open a pi terminal in ${truncate(cwd, 96)}`,
			},
		});
		row.append(el("span", { cls: "arthur-terminal-title", text: truncate(title, 64) }));
		row.append(
			el("span", { cls: "arthur-terminal-dir", text: cwd, attrs: { title: cwd } }),
		);
		row.append(el("span", { cls: "arthur-terminal-nolink", text: ageOf(session.mtimeMs) }));
		row.addEventListener("click", () => this.pick(session));
		return row;
	}

	onClose(): void {
		this.seq++; // orphan any in-flight load
		this.contentEl.empty();
		this.bodyEl = null;
		this.controlEl = null;
		this.query = "";
		this.rows = [];
	}
}

/** Small muted/error note line inside the list (mirrors arthur-pi-dirnote). */
function note(text: string, cls = ""): HTMLElement {
	return el("span", { cls: `arthur-terminal-note ${cls}`.trim(), text });
}
