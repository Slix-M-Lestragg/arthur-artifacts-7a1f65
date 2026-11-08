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
 * `loadSessions` (main.ts) acquires the manager's shared client and returns
 * its CURRENT catalogue (never blocking on the paged re-load),
 * `watchSessions` streams later pages + listing errors into the open modal,
 * `onPick` routes the selection back into the manager.
 *
 * FEATURE 1 ("New pi session…"): an always-visible top action gated by the
 * SAME control surface ahp-view's create-session row uses (the
 * `ahpEnableControl` setting AND the live controller role — re-checked on
 * every paint AND on click, so a disabled render can never leak a create).
 * The flow reveals a cwd prompt, calls the shared client's `createSession`
 * (client-minted ahp-session:/ URI, provider 'pi'), then re-catalogues on a
 * bounded poll until the new summary carries a registered terminal channel —
 * success attaches via `onPick` and closes; a timeout keeps the picker open
 * with the new row highlighted and a note (attach later). Rejections render
 * as one inline error line — never a thrown stack or Notice spam.
 *
 * FEATURE 2 (progressive rendering): rows paint as the shared client's paged
 * catalogue commits (the initial load plus live `watchSessions` ticks); a
 * listing error renders as an inline note over whatever rows already
 * rendered — never a blanked list (§32 fallback semantics).
 */
import { App, Modal } from "obsidian";

import type { AhpSessionSummary } from "../api/ahp";
import { el, truncate } from "../util";

/** Tooltip on a session WITHOUT a terminal channel — the Path A/Path B split
 *  (§5): tmux spawns register nothing; `pi-ahp-tty` on the device is what
 *  creates the attachable `ahp-terminal:/<id>` channel. */
export const NO_TERMINAL_TOOLTIP =
	"no terminal channel — this session has no ahp-terminal:/<id> registration to attach. A tmux (Path A) spawn never registers one; run `pi-ahp-tty --working-dir <cwd>` on the device (Path B) to make it terminal-capable.";

/** Tooltip on the DISABLED 'New pi session…' action while control is off —
 *  the same gate ahp-view's create-session control renders behind. */
export const NEW_SESSION_DISABLED_TOOLTIP =
	"creating a pi session requires the AHP control setting AND a live controller connection to the broker";

/** 'New pi session…' poll pacing: re-catalogue every second, give the host
 *  device up to 15s to register `ahp-terminal:/<id>` (pi-ahp-tty Path B). */
const NEW_SESSION_POLL_INTERVAL_MS = 1_000;
const NEW_SESSION_POLL_TIMEOUT_MS = 15_000;

/** The 'New pi session…' control surface — main.ts wires it to the shared
 *  AhpClient; absent, the action renders disabled. */
export interface TerminalPickerNewSession {
	/** Live gate: null = creation is available right now, else the tooltip
	 *  rendered on the disabled action. Re-checked on every paint AND click. */
	gate(): string | null;
	/** Create a hosted pi session in `cwd` — resolves the client-minted
	 *  ahp-session:/<id> URI (only ever called after gate() returned null). */
	create(cwd: string): Promise<string>;
	/** Poll pacing override (smoke): re-catalogue interval / total budget. */
	poll?: { intervalMs?: number; timeoutMs?: number };
}

export interface TerminalPickerOpts {
	/** Load the catalogue — main.ts acquires the TerminalManager's shared
	 *  client and resolves with the catalogue it ALREADY holds (progressive:
	 *  never blocks on the paged re-load). Rejects with an error the modal
	 *  displays. */
	loadSessions(): Promise<AhpSessionSummary[]>;
	/** Subscribe to LIVE catalogue updates while the modal is open: rows
	 *  stream in as background pages commit, plus a listingError (the
	 *  client's error surface — state stays `ready` on a mid-paging failure).
	 *  Returns an unsubscribe function (invoked onClose). */
	watchSessions?(
		onUpdate: (rows: AhpSessionSummary[], listingError: string | null) => void,
	): () => void;
	/** The new-session control (absent → the action renders disabled). */
	newSession?: TerminalPickerNewSession;
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
	/** Top control row container ('New pi session…' + cwd prompt/state). */
	private controlEl: HTMLElement | null = null;
	/** Live catalogue subscription (watchSessions) — dropped onClose. */
	private unsubWatch: (() => void) | null = null;
	/** Watcher tick counter — a tick DURING an in-flight load already delivered
	 *  fresher rows than the load's pre-commit capture (race guard). */
	private watchTick = 0;
	private query = "";
	private loading = true;
	private loadError: string | null = null;
	/** Deduped catalogue rows from the last successful load. */
	private rows: AhpSessionSummary[] = [];
	/** Stale-response guard for the async load chain (pi-picker pattern). */
	private seq = 0;
	// 'New pi session…' flow state (FEATURE 1).
	private createOpen = false;
	private createBusy: "create" | "wait" | null = null;
	private createError: string | null = null;
	private createNote: string | null = null;
	private cwdDraft = "";
	/** Resource whose row renders highlighted after a poll timeout. */
	private newResource: string | null = null;
	/** Last built control-row state signature (focus-preserving rebuild guard:
	 *  live catalogue ticks repaint without stealing the cwd input's focus). */
	private controlSig = "";

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
		// The 'New pi session…' action sits at the TOP — always visible, even
		// while the listing below is still loading (FEATURE 1).
		this.controlEl = this.contentEl.createEl("div", { cls: "arthur-terminal-new" });
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
		// Live catalogue (FEATURE 2): rows stream in as background pages commit
		// and a mid-paging failure arrives as listingError over the SURVIVING
		// rows — never a blanked list.
		this.unsubWatch =
			this.opts.watchSessions?.((rows, listingError) => {
				if (!this.bodyEl) return; // closed — orphan the tick
				this.watchTick++;
				this.rows = dedupeByResource(rows ?? []);
				this.loadError = listingError;
				if (this.rows.length > 0 || listingError !== null) this.loading = false;
				this.paint();
			}) ?? null;
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
			const watchTickAtLoad = this.watchTick;
			const sessions = await this.opts.loadSessions();
			if (seq !== this.seq) return;
			// Race guard: a live watcher tick during the load already delivered
			// fresher rows (page commits beat the load promise's continuation) —
			// never overwrite them with the pre-commit capture.
			if (this.watchTick === watchTickAtLoad) this.rows = dedupeByResource(sessions);
		} catch (err) {
			if (seq !== this.seq) return;
			// §32 fallback: a failed (re)load NEVER blanks rendered rows — the
			// note renders over whatever the catalogue already showed.
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

	/** Full repaint (small modal — rebuild is cheap and keeps state linear).
	 *  The top control row repaints on every tick too, but only rebuilds its
	 *  DOM when its visible state changed (sig guard) so a live catalogue
	 *  tick never steals focus from the cwd input mid-typing. */
	private paint(): void {
		if (!this.bodyEl) return; // onOpen not finished yet (early refresh tick)
		this.paintControl();
		this.bodyEl.empty();
		const list = this.bodyEl.createEl("div", { cls: "arthur-terminal-list" });
		if (this.loading && this.rows.length === 0) {
			list.append(note("loading sessions…"));
		} else {
			// A listing error renders OVER the surviving rows (first-load failure:
			// rows are empty, so the note stands alone — exactly §32(a)).
			if (this.loadError) {
				list.append(note(`session listing failed — ${this.loadError}`, "arthur-terminal-note--err"));
			}
			const rows = this.visibleRows();
			if (rows.length === 0) {
				if (!this.loadError) {
					list.append(
						note(
							this.rows.length === 0 ? "no pi sessions in the catalogue" : "no sessions match the filter",
						),
					);
				}
			} else {
				for (const summary of rows) list.append(this.rowFor(summary));
			}
		}
		const buttons = this.bodyEl.createEl("div", { cls: "arthur-modal-buttons" });
		const cancel = buttons.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.close());
	}

	/** The top control row: the always-visible 'New pi session…' action plus
	 *  the cwd prompt / state lines once the flow starts (FEATURE 1). */
	private paintControl(): void {
		const control = this.controlEl;
		if (!control) return;
		const ns = this.opts.newSession;
		const deny = ns ? ns.gate() : NEW_SESSION_DISABLED_TOOLTIP;
		const sig = JSON.stringify([
			deny !== null,
			this.createOpen,
			this.createBusy,
			this.createError,
			this.createNote,
		]);
		if (sig === this.controlSig) return; // nothing visible changed — keep DOM (and focus)
		this.controlSig = sig;
		control.empty();
		const btn = document.createElement("button");
		btn.addClass("arthur-btn", "arthur-btn--tiny", "arthur-terminal-new-btn");
		btn.textContent = "New pi session…";
		btn.setAttribute("title", deny ?? "Create a new pi session in a working directory (controller connection)");
		btn.disabled = deny !== null || this.createBusy !== null;
		btn.addEventListener("click", () => {
			// Re-evaluate the LIVE gate on click: roles/settings can change under
			// a stale render, and a disabled action must leak NOTHING.
			const cur = this.opts.newSession;
			if (!cur || cur.gate() !== null || this.createBusy !== null) return;
			this.createOpen = true;
			this.createError = null;
			this.paint();
		});
		control.append(btn);
		if (!this.createOpen && this.createBusy === null && this.createError === null && this.createNote === null) {
			return;
		}
		const row = control.createEl("div", { cls: "arthur-terminal-new-row" });
		const cwd = document.createElement("input");
		cwd.type = "text";
		cwd.addClass("arthur-terminal-new-cwd");
		cwd.placeholder = "working directory for the new pi session";
		cwd.setAttribute("title", "The new pi session starts in this directory");
		cwd.value = this.cwdDraft;
		if (this.createBusy !== null || deny !== null) cwd.disabled = true;
		cwd.addEventListener("input", () => {
			this.cwdDraft = cwd.value ?? "";
		});
		cwd.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.onCreate();
			}
		});
		row.append(cwd);
		const create = document.createElement("button");
		create.addClass("arthur-btn", "arthur-btn--tiny", "arthur-terminal-new-create");
		create.textContent = "create";
		create.setAttribute("title", "Create the pi session, then attach its terminal once the channel registers");
		create.disabled = this.createBusy !== null || deny !== null;
		create.addEventListener("click", () => this.onCreate());
		row.append(create);
		control.append(row);
		if (this.createBusy === "create") control.append(note("creating session…"));
		else if (this.createBusy === "wait") control.append(note("waiting for terminal…"));
		if (this.createError) control.append(note(this.createError, "arthur-terminal-note--err"));
		else if (this.createNote) control.append(note(this.createNote));
	}

	/** Create the session from the cwd prompt: gate + draft re-checked here
	 *  (never trust a stale render), then the bounded terminal poll runs. */
	private onCreate(): void {
		const ns = this.opts.newSession;
		if (!ns || this.createBusy !== null) return;
		if (ns.gate() !== null) return; // control vanished (roles/setting) — send NOTHING
		const cwd = this.cwdDraft.trim();
		if (!cwd) {
			this.createError = "enter a working directory to create a pi session";
			this.paint();
			return;
		}
		this.createOpen = true;
		void this.runCreate(ns, cwd);
	}

	/** One create → poll cycle: surface rejections as a single inline error
	 *  line (never a thrown stack / Notice), then re-catalogue on a bounded
	 *  poll until the new summary carries a registered terminal channel. */
	private async runCreate(ns: TerminalPickerNewSession, cwd: string): Promise<void> {
		this.createBusy = "create";
		this.createError = null;
		this.createNote = null;
		this.newResource = null;
		this.paint();
		let channel: string;
		try {
			channel = String((await ns.create(cwd)) ?? "").trim();
		} catch (err) {
			this.createBusy = null;
			this.createError = truncate(
				err instanceof Error ? err.message : String(err ?? "createSession failed"),
				200,
			);
			this.paint();
			return;
		}
		if (!channel) {
			this.createBusy = null;
			this.createError = "createSession returned no session resource";
			this.paint();
			return;
		}
		if (!this.bodyEl) return; // closed while the create was in flight
		this.createBusy = "wait";
		this.paint();
		await this.pollNewSession(ns, channel);
	}

	/** Bounded poll for the new session's terminal channel: re-catalogue on an
	 *  interval until `hasTerminalChannel` holds for the minted resource (→
	 *  attach + close), or the budget runs out (→ picker stays open, row
	 *  highlighted, note shown — the user can retry / attach later). */
	private async pollNewSession(ns: TerminalPickerNewSession, channel: string): Promise<void> {
		const interval = ns.poll?.intervalMs ?? NEW_SESSION_POLL_INTERVAL_MS;
		const timeout = ns.poll?.timeoutMs ?? NEW_SESSION_POLL_TIMEOUT_MS;
		const deadline = Date.now() + timeout;
		for (;;) {
			try {
				await this.refresh(); // re-catalogue — a listing failure just shows its note
			} catch {
				// keep polling: the host device may register the channel later
			}
			if (!this.bodyEl) return; // modal closed mid-poll — never attach late
			const found = this.rows.find((r) => r.resource === channel);
			if (found && hasTerminalChannel(found)) {
				this.createBusy = null;
				this.createOpen = false;
				this.opts.onPick(sessionIdFromResource(channel), (found.title ?? "").trim());
				this.close();
				return;
			}
			if (Date.now() >= deadline) break;
			await new Promise<void>((resolve) => window.setTimeout(resolve, interval));
			if (!this.bodyEl) return;
		}
		// Timeout: keep the picker open with the new row highlighted + a note.
		this.createBusy = null;
		this.newResource = channel;
		this.createNote =
			"session created — its terminal channel isn't registered yet; the row stays highlighted, attach later once pi-ahp-tty registers it";
		this.paint();
	}

	/** One catalogue row: title + working directory; terminal-capable rows are
	 *  clickable, Path A rows render marked/disabled with the Path B tooltip. */
	private rowFor(summary: AhpSessionSummary): HTMLElement {
		const title = titleOf(summary);
		const hasTerminal = hasTerminalChannel(summary);
		const isNew = summary.resource === this.newResource;
		const row = el("div", {
			cls: `arthur-terminal-row${hasTerminal ? "" : " arthur-terminal-row--disabled"}${
				isNew ? " arthur-terminal-row--new" : ""
			}`,
			attrs: {
				"data-terminal-session": summary.resource,
				...(isNew ? { "data-terminal-new": "true" } : {}),
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
		this.unsubWatch?.(); // stop live catalogue ticks
		this.unsubWatch = null;
		this.contentEl.empty();
		this.bodyEl = null;
		this.controlEl = null;
		this.controlSig = "";
		this.query = "";
		// New-session flow reset: bodyEl null already stops an in-flight poll
		// from attaching late (its next step checks before acting).
		this.createBusy = null;
		this.createOpen = false;
		this.createError = null;
		this.createNote = null;
		this.newResource = null;
		this.cwdDraft = "";
	}
}

/** Small muted/error note line inside the list (mirrors arthur-pi-dirnote). */
function note(text: string, cls = ""): HTMLElement {
	return el("span", { cls: `arthur-terminal-note ${cls}`.trim(), text });
}
