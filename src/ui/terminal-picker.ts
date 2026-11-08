/**
 * Fuzzy terminal picker (Modal) — PI-TERMINAL-PORT-PLAN §3/T4. Lists the AHP
 * catalogue from the TerminalManager's SHARED AhpClient so picking a session
 * routes straight into `TerminalManager.openTerminal(sessionId)` — re-attaching
 * to a session already open in another leaf focuses that leaf (the T3
 * manager's per-session routing; no second leaf for the same session).
 *
 * Rows: every catalogued session appears, but only sessions with a REGISTERED
 * terminal channel are selectable — detected from the summary's host-agent
 * fields (`hostOnline === true` / a `terminalMode` / a set `hostAgentId`, the
 * `pi-ahp-tty` Path B registration). A Path A tmux spawn (no
 * `ahp-terminal:/<id>` channel ever registered) renders present-but-disabled:
 * marked "no terminal channel", aria-disabled, no click wiring, and a tooltip
 * explaining the Path B requirement (§3/T4 acceptance, R-T4).
 *
 * Stable-id dedup (TESTING #92): rows are keyed by `resource`
 * (`ahp-session:/<id>`) — a resumed session re-served across two paged
 * listSessions pages renders exactly one row. The client's catalogue map is
 * already resource-keyed; the picker dedupes again defensively so the one-row
 * invariant holds for ANY list source handed to it.
 *
 * Modal pattern mirrors PiPickerModal (src/ui/pi-picker.ts): the modal owns
 * query/state/render; backing calls arrive through the opts bag —
 * `loadSessions` (main.ts) acquires the manager's shared client and re-pages
 * the catalogue, `onPick` routes the selection back into the manager.
 */
import { App, Modal } from "obsidian";

import type { AhpSessionSummary } from "../api/ahp";
import { el, truncate } from "../util";

/** Tooltip on a session WITHOUT a terminal channel — the Path A/Path B split
 *  (§5): tmux spawns register nothing; `pi-ahp-tty` on the device is what
 *  creates the attachable `ahp-terminal:/<id>` channel. */
export const NO_TERMINAL_TOOLTIP =
	"no terminal channel — this session has no ahp-terminal:/<id> registration to attach. A tmux (Path A) spawn never registers one; run `pi-ahp-tty --working-dir <cwd>` on the device (Path B) to make it terminal-capable.";

export interface TerminalPickerOpts {
	/** Load the catalogue — main.ts acquires the TerminalManager's shared
	 *  client (connecting it lazily) and re-pages `listSessions` so a just-
	 *  spawned session shows up. Rejects with an error the modal displays. */
	loadSessions(): Promise<AhpSessionSummary[]>;
	/** A selectable (terminal-registered) session was chosen. */
	onPick(sessionId: string, title: string): void;
}

/** `ahp-session:/<id>` → the bare sessionId the `ahp-terminal:/<id>` channel
 *  keys on. Resources without the prefix pass through unchanged. */
export function sessionIdFromResource(resource: string): string {
	const m = /^ahp-session:\/\/?/.exec(resource);
	return m ? resource.slice(m[0].length) : resource;
}

/** True when the summary indicates a REGISTERED terminal channel (Path B):
 *  the host agent is online, or a terminalMode / host agent id is present —
 *  the fields `pi-ahp-tty`'s registration leaves on the session summary. */
export function hasTerminalChannel(summary: AhpSessionSummary): boolean {
	return (
		summary.hostOnline === true ||
		(summary.terminalMode ?? "").trim() !== "" ||
		(summary.hostAgentId ?? "").trim() !== ""
	);
}

/** Display title: summary title, else the cwd's last segment, else resource. */
function titleOf(summary: AhpSessionSummary): string {
	return (
		(summary.title ?? "").trim() ||
		(summary.workingDirectory ?? "").trim().split("/").filter(Boolean).pop() ||
		summary.resource
	);
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

/** Stable-id dedup (TESTING #92): first occurrence per `resource` wins. */
function dedupeByResource(sessions: AhpSessionSummary[]): AhpSessionSummary[] {
	const seen = new Set<string>();
	const out: AhpSessionSummary[] = [];
	for (const s of sessions) {
		if (!s || typeof s.resource !== "string" || !s.resource || seen.has(s.resource)) continue;
		seen.add(s.resource);
		out.push(s);
	}
	return out;
}

export class TerminalPickerModal extends Modal {
	/** Rows container (rebuilt on every paint), built in onOpen. */
	private bodyEl: HTMLElement | null = null;
	private query = "";
	private loading = true;
	private loadError: string | null = null;
	/** Deduped catalogue rows from the last successful load. */
	private rows: AhpSessionSummary[] = [];
	/** Stale-response guard for the async load chain (pi-picker pattern). */
	private seq = 0;

	constructor(
		app: App,
		private readonly opts: TerminalPickerOpts,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("pi terminal — choose a session");
		this.contentEl.empty();
		this.contentEl.addClass("arthur-terminal-picker");
		// Fuzzy filter input (top): matches title + workingDirectory.
		const filter = document.createElement("input");
		filter.className = "arthur-terminal-filter";
		filter.type = "text";
		filter.placeholder = "filter sessions by title or directory";
		filter.addEventListener("input", () => {
			this.query = filter.value ?? "";
			this.paint();
		});
		filter.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.enterFirstSelectable();
			}
		});
		this.contentEl.append(filter);
		this.bodyEl = this.contentEl.createEl("div", { cls: "arthur-terminal-picker-body" });
		void this.refresh();
	}

	/** Load the catalogue through the backing call; a stale response never
	 *  paints over a newer one (seq guard). */
	private async refresh(): Promise<void> {
		const seq = ++this.seq;
		this.loading = true;
		this.loadError = null;
		this.paint();
		try {
			const sessions = await this.opts.loadSessions();
			if (seq !== this.seq) return;
			this.rows = dedupeByResource(sessions);
		} catch (err) {
			if (seq !== this.seq) return;
			this.rows = [];
			this.loadError = err instanceof Error ? err.message : String(err);
		} finally {
			if (seq === this.seq) this.loading = false;
		}
		this.paint();
	}

	/** Rows surviving the fuzzy filter (title OR workingDirectory match). */
	private visibleRows(): AhpSessionSummary[] {
		const q = this.query.trim();
		if (!q) return this.rows;
		return this.rows.filter(
			(s) => fuzzyMatch(q, titleOf(s)) || fuzzyMatch(q, (s.workingDirectory ?? "").trim()),
		);
	}

	/** Enter in the filter: acts as a click on the first SELECTABLE row
	 *  (disabled no-terminal rows are skipped). */
	private enterFirstSelectable(): void {
		const first = this.visibleRows().find((s) => hasTerminalChannel(s));
		if (first) this.pick(first);
	}

	/** Select a terminal-capable session: route into the manager, close. */
	private pick(summary: AhpSessionSummary): void {
		if (!hasTerminalChannel(summary)) return; // belt-and-braces: disabled rows never pick
		const sessionId = sessionIdFromResource(summary.resource);
		if (!sessionId) return;
		this.opts.onPick(sessionId, (summary.title ?? "").trim());
		this.close();
	}

	/** Full repaint (small modal — rebuild is cheap and keeps state linear). */
	private paint(): void {
		if (!this.bodyEl) return; // onOpen not finished yet (early refresh tick)
		this.bodyEl.empty();
		const list = this.bodyEl.createEl("div", { cls: "arthur-terminal-list" });
		if (this.loading) {
			list.append(note("loading sessions…"));
		} else if (this.loadError) {
			list.append(note(`session listing failed — ${this.loadError}`, "arthur-terminal-note--err"));
		} else {
			const rows = this.visibleRows();
			if (rows.length === 0) {
				list.append(
					note(this.rows.length === 0 ? "no pi sessions in the catalogue" : "no sessions match the filter"),
				);
			}
			for (const summary of rows) list.append(this.rowFor(summary));
		}
		const buttons = this.bodyEl.createEl("div", { cls: "arthur-modal-buttons" });
		const cancel = buttons.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.close());
	}

	/** One catalogue row: title + working directory; terminal-capable rows are
	 *  clickable, Path A rows render marked/disabled with the Path B tooltip. */
	private rowFor(summary: AhpSessionSummary): HTMLElement {
		const title = titleOf(summary);
		const hasTerminal = hasTerminalChannel(summary);
		const row = el("div", {
			cls: `arthur-terminal-row${hasTerminal ? "" : " arthur-terminal-row--disabled"}`,
			attrs: {
				"data-terminal-session": summary.resource,
				...(hasTerminal
					? { role: "button", title: `Attach the pi terminal to ${truncate(title, 64)}` }
					: { "aria-disabled": "true", title: NO_TERMINAL_TOOLTIP }),
			},
		});
		row.append(el("span", { cls: "arthur-terminal-title", text: truncate(title, 64) }));
		const dir = (summary.workingDirectory ?? "").trim();
		if (dir) row.append(el("span", { cls: "arthur-terminal-dir", text: dir, attrs: { title: dir } }));
		if (hasTerminal) {
			row.addEventListener("click", () => this.pick(summary));
		} else {
			row.append(el("span", { cls: "arthur-terminal-nolink", text: "no terminal channel" }));
			// No click wiring on purpose: the action stays disabled (tooltip above).
		}
		return row;
	}

	onClose(): void {
		this.seq++; // orphan any in-flight load
		this.contentEl.empty();
		this.bodyEl = null;
		this.query = "";
	}
}

/** Small muted/error note line inside the list (mirrors arthur-pi-dirnote). */
function note(text: string, cls = ""): HTMLElement {
	return el("span", { cls: `arthur-terminal-note ${cls}`.trim(), text });
}
