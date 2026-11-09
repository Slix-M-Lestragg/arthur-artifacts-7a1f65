/**
 * pi farm view — READ-ONLY local sessions overview (Wave 3 of the
 * obsidian-pi feature port). Two data sources merged into one plain-DOM
 * table:
 *
 *   (a) OPEN instances — from `TerminalManager.openInstances()`: every
 *       cwd-bound terminal leaf that is currently open, with its live
 *       activity state (idle | running | done-unseen | seen |
 *       awaiting-input | error — the Wave 1 vocabulary). A row for an open
 *       cwd carries an "open" badge; its action FOCUSES the leaf.
 *   (b) DORMANT sessions — a scan of `~/.pi/agent/sessions/` (the SAME
 *       scan the terminal picker uses — `listLocalPiSessions` in
 *       terminal-picker.ts, reused verbatim, never duplicated): one entry
 *       per cwd (the authoritative cwd read from the most-recent jsonl's
 *       first line), the newest `.jsonl`'s mtime + size. A dormant row's
 *       action RESUMES that session through the Wave 1 path
 *       (`pi --session <abs file>`).
 *
 * MERGE semantics (keyed by trimmed cwd): a cwd that is BOTH open AND has
 * a dormant sessions subdir collapses to ONE row — `open: true`, the open
 * instance's live state + title, the dormant session's file/size (so the
 * resume target is still visible), mtime = max(dormant mtime, now). A cwd
 * that is only open has no file/size; a cwd that is only dormant has
 * `open: false` and no live state. Sorted modified-desc by default; capped
 * at `MAX_FARM_ROWS` (200) rows — most recent first. This guarantees a
 * dormant session whose cwd matches an already-open terminal shows "open"
 * and focuses on click instead of spawning a duplicate (consistent with
 * the manager's leaf-reuse-by-cwd — `openTerminal(cwd)` focuses an
 * existing leaf rather than creating one).
 *
 * The table is READ-ONLY with respect to session files (no delete/cull/
 * rename this wave): the scan stats files but never writes. Refresh runs
 * on a 5s interval while the view is open + on demand (Refresh button);
 * the interval is started in onOpen and cleared in onClose (a `register`
 * backstop covers a teardown that skips onClose).
 *
 * The ItemView lifecycle follows the ahp-view/terminal-view conventions:
 * lazy build on open, full teardown on close. NOTE: never name a field
 * `open` on an ItemView subclass — Obsidian's View base has an internal
 * `open(containerEl)` that Leaf.setViewState awaits.
 */
import { ItemView, WorkspaceLeaf } from "obsidian";
import * as path from "path";

import type ArthurPlugin from "../main";
import { el, fmtBytes, truncate } from "../util";
import { terminalStateClass, type TerminalState } from "./terminal-state";
import type { InstanceRow } from "./instance-picker";
import {
	defaultPiSessionsDir,
	listLocalPiSessions,
	type LocalPiSession,
} from "./terminal-picker";

export const VIEW_TYPE_PI_FARM = "arthur-pi-farm";

/** Refresh cadence (ms) while the view is open. */
const FARM_REFRESH_MS = 5000;
/** Global row cap — most-recent first; the rest fold into a "+N more" note. */
const MAX_FARM_ROWS = 200;

/** One merged farm row (see file header for the merge rules). */
export interface FarmRow {
	/** Trimmed cwd — the merge key. */
	cwd: string;
	/** True when a terminal leaf is currently open for this cwd. */
	open: boolean;
	/** Live activity state for open rows (null for dormant-only rows). */
	state: TerminalState | null;
	/** Display title: the open leaf's display text, or the dormant session's
	 *  file name (fallback: the cwd's last segment). */
	title: string;
	/** Representative mtime (epoch ms) — dormant session mtime, bumped to
	 *  `now` for open rows so live rows sort to the top. */
	mtimeMs: number;
	/** Absolute path to the most-recent `.jsonl` (dormant rows; the resume
	 *  target). Undefined for open-only rows. */
	file?: string;
	/** Size in bytes of the most-recent `.jsonl` (dormant rows). */
	size?: number;
}

/**
 * Pure merge of the two data sources into one sorted, capped row list.
 * Exported so smoke can assert the merge semantics deterministically (no
 * fs, no DOM). `now` is injected so the open-row sort bump is stable in
 * tests.
 */
export function mergeFarmRows(
	openInstances: InstanceRow[],
	dormant: LocalPiSession[],
	now: number,
): FarmRow[] {
	const map = new Map<string, FarmRow>();
	// Dormant first (so the merge key + file/size land), then open instances
	// overlay their live state + mark the row open.
	for (const d of dormant) {
		const cwd = d.cwd.trim();
		if (!cwd) continue;
		map.set(cwd, {
			cwd,
			open: false,
			state: null,
			title: dormantTitle(d, cwd),
			mtimeMs: d.mtimeMs,
			...(d.file ? { file: d.file } : {}),
			...(typeof d.size === "number" ? { size: d.size } : {}),
		});
	}
	for (const o of openInstances) {
		const cwd = o.cwd.trim();
		if (!cwd) continue;
		const ex = map.get(cwd);
		if (ex) {
			ex.open = true;
			ex.state = o.state;
			if (o.title) ex.title = o.title;
			ex.mtimeMs = Math.max(ex.mtimeMs, now);
		} else {
			map.set(cwd, {
				cwd,
				open: true,
				state: o.state,
				title: o.title || lastSegment(cwd),
				mtimeMs: now,
			});
		}
	}
	const rows = [...map.values()];
	rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return rows.slice(0, MAX_FARM_ROWS);
}

/** Display title for a dormant session: the jsonl file name (sans ext) when
 *  present, else the cwd's last segment. */
function dormantTitle(d: LocalPiSession, cwd: string): string {
	if (d.file) {
		const base = path.basename(d.file);
		return base.replace(/\.jsonl$/, "") || lastSegment(cwd);
	}
	return lastSegment(cwd);
}

/** Last non-empty segment of a cwd (fallback display title). */
function lastSegment(cwd: string): string {
	return cwd.split("/").filter(Boolean).pop() || cwd || "/";
}

/** Coarse relative age for an mtime (e.g. "3m ago"). Mirrors the picker's. */
function ageOf(mtimeMs: number, now: number): string {
	const s = Math.max(0, Math.floor((now - mtimeMs) / 1000));
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	return `${d}d ago`;
}

export class PiFarmView extends ItemView {
	/** Header row: state line + Refresh + density toggle. */
	private stateEl: HTMLElement | null = null;
	/** Table body (refilled each refresh). */
	private bodyEl: HTMLElement | null = null;
	/** "+N more" cap note (refilled each refresh). */
	private capEl: HTMLElement | null = null;
	/** The merged row table root (kept stable; only the tbody refills). */
	private tableEl: HTMLElement | null = null;

	/** 5s refresh interval id (null when not running). */
	private refreshTimer: number | null = null;
	/** View-open gate for the refresh path. */
	private opened = false;
	/** compact / comfortable density (persisted in view state, in-memory only). */
	private compact = false;
	/** Last rendered rows (for action handlers + tests). */
	private rows: FarmRow[] = [];

	/**
	 * Injectable dormant-session loader (default: scan the production
	 * `~/.pi/agent/sessions/`). Smoke tests set this to a fake before
	 * calling `refresh()` so the merge + table render deterministically
	 * without touching the real sessions dir.
	 */
	farmLoadDormant: () => LocalPiSession[] = () => listLocalPiSessions(defaultPiSessionsDir());

	constructor(leaf: WorkspaceLeaf, private readonly plugin: ArthurPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_PI_FARM;
	}

	getDisplayText(): string {
		return "pi farm";
	}

	getIcon(): string {
		return "tractor";
	}

	async onOpen(): Promise<void> {
		this.opened = true;
		this.buildSkeleton();
		// Belt-and-braces: if teardown ever skips onClose the interval still dies.
		this.register(() => this.stopRefresh());
		this.startRefresh();
		this.refresh();
	}

	async onClose(): Promise<void> {
		this.stopRefresh();
		this.opened = false;
		this.rows = [];
		this.stateEl = null;
		this.bodyEl = null;
		this.capEl = null;
		this.tableEl = null;
		this.contentEl.empty();
	}

	// ------------------------------------------------------------- interval

	/** Start the 5s refresh interval (idempotent). */
	private startRefresh(): void {
		if (this.refreshTimer !== null) return;
		this.refreshTimer = window.setInterval(() => this.refresh(), FARM_REFRESH_MS);
	}

	/** Clear the refresh interval (idempotent). */
	private stopRefresh(): void {
		if (this.refreshTimer !== null) {
			window.clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	// --------------------------------------------------------------- refresh

	/**
	 * Rebuild the merged table from the two live sources. Public so tests can
	 * drive a deterministic repaint after injecting `farmLoadDormant`.
	 */
	refresh(): void {
		if (!this.opened) return;
		const now = Date.now();
		const open = this.plugin.terminalManager?.openInstances() ?? [];
		const dormant = this.farmLoadDormant();
		this.rows = mergeFarmRows(open, dormant, now);
		this.renderState(now);
		this.renderTable(now);
	}

	// --------------------------------------------------------------- render

	private buildSkeleton(): void {
		this.contentEl.empty();
		const wrap = this.contentEl.createEl("div", { cls: "arthur-farm" });
		if (this.compact) wrap.addClass("arthur-farm--compact");
		this.stateEl = wrap.createEl("div", { cls: "arthur-ahp-state-line arthur-farm-state-line" });
		this.tableEl = wrap.createEl("table", { cls: "arthur-farm-table" });
		const thead = this.tableEl.createEl("thead");
		const headRow = thead.createEl("tr");
		for (const h of ["state", "cwd", "session", "modified", "size", "actions"]) {
			headRow.createEl("th", { text: h });
		}
		this.bodyEl = this.tableEl.createEl("tbody");
		this.capEl = wrap.createEl("div", { cls: "arthur-farm-cap arthur-note" });
		this.capEl.hide();
	}

	/** State line: row count + Refresh + density toggle. */
	private renderState(now: number): void {
		const stateEl = this.stateEl;
		if (!stateEl) return;
		stateEl.empty();
		const n = this.rows.length;
		stateEl.append(
			el("span", {
				cls: "arthur-ahp-state arthur-ahp-state--ready",
				text: n === 0 ? "no sessions" : `${n} session${n === 1 ? "" : "s"}`,
			}),
		);
		const refreshBtn = document.createElement("button");
		refreshBtn.addClass("arthur-btn", "arthur-btn--tiny", "arthur-farm-refresh");
		refreshBtn.textContent = "Refresh";
		refreshBtn.setAttribute("title", "Reload the open + dormant session list");
		refreshBtn.addEventListener("click", () => this.refresh());
		stateEl.append(refreshBtn);
		const densityBtn = document.createElement("button");
		densityBtn.addClass("arthur-btn", "arthur-btn--tiny", "arthur-farm-density");
		densityBtn.textContent = this.compact ? "comfortable" : "compact";
		densityBtn.setAttribute(
			"title",
			this.compact ? "Switch to comfortable row spacing" : "Switch to compact row spacing",
		);
		densityBtn.addEventListener("click", () => {
			this.compact = !this.compact;
			const wrap = this.contentEl.querySelector(".arthur-farm") as HTMLElement | null;
			wrap?.classList.toggle("arthur-farm--compact", this.compact);
			this.renderState(now);
		});
		stateEl.append(densityBtn);
	}

	/** The merged table body (+ empty-state note). */
	private renderTable(now: number): void {
		const bodyEl = this.bodyEl;
		const capEl = this.capEl;
		if (!bodyEl || !capEl) return;
		bodyEl.empty();
		capEl.empty();
		if (this.rows.length === 0) {
			capEl.append(
				el("p", {
					cls: "arthur-note",
					text: "no local pi sessions — open a terminal or run pi somewhere to populate the farm",
				}),
			);
			capEl.show();
			return;
		}
		// mergeFarmRows already caps at MAX_FARM_ROWS (most-recent first), so the
		// view renders every merged row — no separate overflow note here.
		for (const row of this.rows) bodyEl.append(this.rowFor(row, now));
		capEl.hide();
	}

	/** One merged row: state dot · cwd (short, title=full) · session title ·
	 *  modified (relative) · size · actions. */
	private rowFor(row: FarmRow, now: number): HTMLElement {
		const tr = el("tr", {
			cls: `arthur-farm-row${row.open ? " arthur-farm-row--open" : " arthur-farm-row--dormant"}`,
			attrs: { "data-farm-cwd": row.cwd },
		});

		// state dot — open rows use the live state color; dormant rows a muted dot.
		const dotCls = row.open && row.state ? terminalStateClass(row.state) : "arthur-pi-state-idle";
		const dot = el("span", { cls: `arthur-farm-dot ${dotCls}`, text: "•" });
		tr.append(el("td", { children: [dot] }));

		// cwd — shortened for display, full path in the title attr.
		tr.append(
			el("td", {
				cls: "arthur-farm-cwd",
				text: truncate(row.cwd, 48),
				attrs: { title: row.cwd },
			}),
		);

		// session title/name.
		tr.append(
			el("td", {
				cls: "arthur-farm-title",
				text: truncate(row.title, 64),
				attrs: { title: row.file ?? row.title },
			}),
		);

		// modified (relative).
		tr.append(el("td", { cls: "arthur-farm-modified", text: ageOf(row.mtimeMs, now) }));

		// size — bytes of the most-recent jsonl (open-only rows show "—").
		tr.append(
			el("td", {
				cls: "arthur-farm-size",
				text: typeof row.size === "number" ? fmtBytes(row.size) : "—",
			}),
		);

		// actions: open badge (open rows) + focus / resume button.
		const actions = el("td", { cls: "arthur-farm-actions" });
		if (row.open) {
			actions.append(el("span", { cls: "arthur-badge arthur-badge--running arthur-farm-open-badge", text: "open" }));
			const focusBtn = document.createElement("button");
			focusBtn.addClass("arthur-btn", "arthur-btn--tiny");
			focusBtn.textContent = "focus";
			focusBtn.setAttribute("title", `Focus the open pi terminal in ${truncate(row.cwd, 64)}`);
			focusBtn.addEventListener("click", () => {
				void this.plugin.activatePiTerminal({ cwd: row.cwd });
			});
			actions.append(focusBtn);
		} else {
			const resumeBtn = document.createElement("button");
			resumeBtn.addClass("arthur-btn", "arthur-btn--tiny");
			resumeBtn.textContent = row.file ? "resume" : "open";
			resumeBtn.setAttribute(
				"title",
				row.file
					? `Resume this session (pi --session <file>) in ${truncate(row.cwd, 64)}`
					: `Open a pi terminal in ${truncate(row.cwd, 64)} (resume newest)`,
			);
			resumeBtn.addEventListener("click", () => {
				// A dormant row by construction has no open leaf for its cwd, but the
				// manager's openTerminal(cwd) focuses an existing leaf if one opened
				// since the last refresh — no duplicate is ever spawned.
				void this.plugin.activatePiTerminal({
					cwd: row.cwd,
					...(row.file ? { sessionFile: row.file } : {}),
				});
			});
			actions.append(resumeBtn);
		}
		tr.append(actions);
		return tr;
	}
}
