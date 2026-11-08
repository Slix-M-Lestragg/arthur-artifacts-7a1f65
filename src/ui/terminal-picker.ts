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
 * FEATURE 1 ("New pi session…"): an always-visible top action gated by
 * arthur-agent reachability (the spawn goes through the agent's v0.8.2
 * POST /api/pi/terminal-sessions endpoint, NOT the AHP broker — so the gate
 * is the companion service being reachable, re-checked on every paint AND on
 * click, so a disabled render can never leak a spawn). Clicking it opens the
 * EXISTING PiPickerModal (device + fuzzy directory picker from pi-picker.ts);
 * the chosen {device, cwd} drives `agent.piTerminalSpawn`, then a bounded
 * poll of the AHP catalogue waits for the EXACT `ahp-session:/<id>` the
 * 201's `detail.sessionId` names (agent v0.8.3) to gain a registered
 * terminal channel — pi-ahp-tty RESUMES the existing pi session for a cwd,
 * so its channel registers on the OLD session resource a cwd-prefix poll
 * for a NEW session can never match. `sessionId` null/absent (older agent,
 * async mint) → fall back to the cwd-prefix heuristic (most recent wins).
 * Success attaches via `onPick` and closes; a timeout keeps the picker open with the
 * matching row highlighted and a note mentioning the supervisor log path
 * (attach later). Spawn rejections (422/503/502) surface the server's error
 * message verbatim as one inline error line — never a thrown stack or Notice.
 * The AHP-broker createSession path is intentionally NOT used here: it cannot
 * produce a terminal channel (only pi-ahp-tty registers terminal/registerExternal).
 *
 * FEATURE 2 (progressive rendering): rows paint as the shared client's paged
 * catalogue commits (the initial load plus live `watchSessions` ticks); a
 * listing error renders as an inline note over whatever rows already
 * rendered — never a blanked list (§32 fallback semantics).
 */
import { App, Modal } from "obsidian";

import type { AhpSessionSummary } from "../api/ahp";
import type { AgentPiTerminalSpawnDetail, AgentPiTerminalSpawnResult } from "../api/agent";
import { el, truncate } from "../util";

/** Tooltip on a session WITHOUT a terminal channel — the Path A/Path B split
 *  (§5): tmux spawns register nothing; `pi-ahp-tty` on the device is what
 *  creates the attachable `ahp-terminal:/<id>` channel. */
export const NO_TERMINAL_TOOLTIP =
	"no terminal channel — this session has no ahp-terminal:/<id> registration to attach. A tmux (Path A) spawn never registers one; run `pi-ahp-tty --working-dir <cwd>` on the device (Path B) to make it terminal-capable.";

/** Tooltip on the DISABLED 'New pi session…' action while the arthur agent
 *  is unreachable — the spawn goes through the agent's v0.8.2
 *  POST /api/pi/terminal-sessions endpoint (NOT the AHP broker), so the
 *  gate is agent reachability, not the AHP controller role / ahpEnableControl. */
export const NEW_SESSION_DISABLED_TOOLTIP =
	"creating a pi terminal session requires the arthur agent to be reachable (the companion service on the server)";

/** 'New pi session…' poll pacing: re-catalogue every second, give the
 *  pi-ahp-tty supervisor up to 45s to resume/mint the session, connect its
 *  broker link and register the `ahp-terminal:/<id>` channel — resume +
 *  broker connect + TUI startup legitimately takes 20-30s on a busy box.
 *  With agent v0.8.3's `detail.sessionId` the poll targets that EXACT
 *  catalogue resource; without it, a terminal-bearing session whose
 *  workingDirectory matches the chosen cwd prefix is used instead. */
const NEW_SESSION_POLL_INTERVAL_MS = 1_000;
const NEW_SESSION_POLL_TIMEOUT_MS = 45_000;

/** The 'New pi session…' control surface — main.ts wires it to the
 *  arthur agent (v0.8.2 terminal-spawn endpoint) + the PiPickerModal device
 *  + directory picker; absent, the action renders disabled. */
export interface TerminalPickerNewSession {
	/** Live gate: null = creation is available right now, else the tooltip
	 *  rendered on the disabled action. Re-checked on every paint AND click.
	 *  Gated on arthur-agent reachability (NOT AHP controller role). */
	gate(): string | null;
	/** Open the device + directory picker (PiPickerModal). The callback fires
	 *  with the chosen {device, cwd} — the picker then spawns the pi-ahp-tty
	 *  supervisor via `spawn` and polls the AHP catalogue for the new
	 *  terminal-bearing session. Only ever called after gate() returned null. */
	openPicker(onChoose: (device: string, cwd: string) => void): void;
	/** Spawn the pi-ahp-tty terminal supervisor on the device (POST
	 *  /api/pi/terminal-sessions). Resolves the 201 result (its `detail.log`
	 *  path is surfaced on a poll timeout); rejects with the server's error
	 *  message on 4xx/5xx (422/503/502 — surfaced verbatim in the modal). */
	spawn(device: string, cwd: string): Promise<AgentPiTerminalSpawnResult>;
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
	// 'New pi session…' flow state (FEATURE 1) — the spawn+poll runs detached
	// after the PiPickerModal closes on a 201; the terminal picker stays open
	// showing 'waiting for terminal…' until the catalogue gains a
	// terminal-bearing session for the chosen cwd (attach + close) or the
	// poll budget runs out (note + highlighted row).
	private createBusy: "create" | "wait" | null = null;
	private createError: string | null = null;
	private createNote: string | null = null;
	/** The pi-ahp-tty spawn detail (carries the log path surfaced on timeout). */
	private spawnDetail: AgentPiTerminalSpawnDetail | null = null;
	/** cwd whose matching row renders highlighted after a poll timeout. */
	private newCwd: string | null = null;
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
	 *  tick never disturbs the control row mid-flow. */
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
	 *  the spawn/poll status lines (FEATURE 1). Clicking the action opens the
	 *  PiPickerModal (device + directory picker); the cwd no longer lives in
	 *  this modal. */
	private paintControl(): void {
		const control = this.controlEl;
		if (!control) return;
		const ns = this.opts.newSession;
		const deny = ns ? ns.gate() : NEW_SESSION_DISABLED_TOOLTIP;
		const sig = JSON.stringify([
			deny !== null,
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
		btn.setAttribute("title", deny ?? "Create a new pi terminal session (spawns pi-ahp-tty on a device and attaches its terminal)");
		btn.disabled = deny !== null || this.createBusy !== null;
		btn.addEventListener("click", () => {
			// Re-evaluate the LIVE gate on click: the agent can go offline under
			// a stale render, and a disabled action must leak NOTHING.
			const cur = this.opts.newSession;
			if (!cur || cur.gate() !== null || this.createBusy !== null) return;
			this.createError = null;
			this.createNote = null;
			this.paint();
			cur.openPicker((device, cwd) => {
				void this.runSpawn(cur, device, cwd);
			});
		});
		control.append(btn);
		if (this.createBusy === "create") control.append(note("spawning pi-ahp-tty…"));
		else if (this.createBusy === "wait") control.append(note("waiting for terminal…"));
		if (this.createError) control.append(note(this.createError, "arthur-terminal-note--err"));
		else if (this.createNote) control.append(note(this.createNote));
	}

	/** One spawn → poll cycle: spawn the pi-ahp-tty supervisor (awaited — the
	 *  PiPickerModal closes once this resolves), then poll the AHP catalogue
	 *  detached for the EXACT session resource `detail.sessionId` names to
	 *  gain a terminal channel (cwd-prefix heuristic when sessionId is
	 *  null/absent). Spawn rejections (422/503/502) surface verbatim as a
	 *  single inline error line (never a thrown stack / Notice). */
	private async runSpawn(
		ns: TerminalPickerNewSession,
		device: string,
		cwd: string,
	): Promise<void> {
		this.createBusy = "create";
		this.createError = null;
		this.createNote = null;
		this.newCwd = null;
		this.spawnDetail = null;
		this.paint();
		try {
			const res = await ns.spawn(device, cwd);
			this.spawnDetail = res.detail ?? null;
		} catch (err) {
			this.createBusy = null;
			this.createError = truncate(
				err instanceof Error ? err.message : String(err ?? "pi-ahp-tty spawn failed"),
				200,
			);
			this.paint();
			return; // error inlined; the dir picker already closed on resolve
		}
		if (!this.bodyEl) return; // closed while the spawn was in flight
		this.createBusy = "wait";
		this.paint();
		await this.pollNewSession(ns, cwd);
	}

	/** Bounded poll for the new terminal session: re-catalogue on an interval
	 *  until the session `detail.sessionId` names (agent v0.8.3 — normalized
	 *  through `sessionIdFromResource` on BOTH sides, so 'ahp-session:/x' and
	 *  bare 'x' compare equal) carries a registered terminal channel → attach
	 *  + close. sessionId null/absent (older agent, async mint) → the previous
	 *  heuristic: a terminal-bearing session whose workingDirectory matches
	 *  the chosen cwd prefix (most recent wins). Budget exhausted → the picker
	 *  stays open, the cwd-matching row highlighted, a note mentions the
	 *  supervisor log path — the user can retry / attach later. */
	private async pollNewSession(ns: TerminalPickerNewSession, cwd: string): Promise<void> {
		const interval = ns.poll?.intervalMs ?? NEW_SESSION_POLL_INTERVAL_MS;
		const timeout = ns.poll?.timeoutMs ?? NEW_SESSION_POLL_TIMEOUT_MS;
		const targetId = sessionIdFromResource((this.spawnDetail?.sessionId ?? "").trim());
		const deadline = Date.now() + timeout;
		for (;;) {
			try {
				await this.refresh(); // re-catalogue — a listing failure just shows its note
			} catch {
				// keep polling: the supervisor may register the channel later
			}
			if (!this.bodyEl) return; // modal closed mid-poll — never attach late
			const found = targetId
				? this.rows.find(
						(s) => sessionIdFromResource(s.resource) === targetId && hasTerminalChannel(s),
				  ) ?? null
				: this.matchingTerminalSession(cwd);
			if (found) {
				this.createBusy = null;
				this.opts.onPick(sessionIdFromResource(found.resource), (found.title ?? "").trim());
				this.close();
				return;
			}
			if (Date.now() >= deadline) break;
			await new Promise<void>((resolve) => window.setTimeout(resolve, interval));
			if (!this.bodyEl) return;
		}
		// Timeout: keep the picker open with the cwd-matching row highlighted +
		// a note mentioning the supervisor's log path (from the spawn detail).
		this.createBusy = null;
		this.newCwd = cwd;
		const log = this.spawnDetail?.log;
		this.createNote = log
			? `pi-ahp-tty launched — its terminal channel isn't registered yet; the matching row stays highlighted, attach later once it registers (supervisor log: ${log})`
			: "pi-ahp-tty launched — its terminal channel isn't registered yet; the matching row stays highlighted, attach later once it registers";
		this.paint();
	}

	/** True when `wd` is the chosen cwd or a path beneath it (prefix match with
	 *  a trailing-slash boundary so '/home/slix' does NOT match '/home/slixar'). */
	private static cwdMatches(wd: string | undefined, cwd: string): boolean {
		const w = (wd ?? "").trim();
		if (!w) return false;
		if (w === cwd) return true;
		const prefix = cwd.endsWith("/") ? cwd : cwd + "/";
		return w.startsWith(prefix);
	}

	/** The terminal-bearing session whose workingDirectory matches the chosen
	 *  cwd prefix — most recent (by modifiedAt) wins. null when none match. */
	private matchingTerminalSession(cwd: string): AhpSessionSummary | null {
		const matches = this.rows.filter(
			(s) => hasTerminalChannel(s) && TerminalPickerModal.cwdMatches(s.workingDirectory, cwd),
		);
		if (matches.length === 0) return null;
		if (matches.length === 1) return matches[0];
		matches.sort((a, b) => {
			const ma = (a.modifiedAt ?? "").trim();
			const mb = (b.modifiedAt ?? "").trim();
			if (ma === mb) return 0;
			return ma < mb ? 1 : -1; // descending — most recent first
		});
		return matches[0];
	}

	/** One catalogue row: title + working directory; terminal-capable rows are
	 *  clickable, Path A rows render marked/disabled with the Path B tooltip. */
	private rowFor(summary: AhpSessionSummary): HTMLElement {
		const title = titleOf(summary);
		const hasTerminal = hasTerminalChannel(summary);
		const isNew = this.newCwd != null && TerminalPickerModal.cwdMatches(summary.workingDirectory, this.newCwd);
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
		this.createError = null;
		this.createNote = null;
		this.newCwd = null;
		this.spawnDetail = null;
	}
}

/** Small muted/error note line inside the list (mirrors arthur-pi-dirnote). */
function note(text: string, cls = ""): HTMLElement {
	return el("span", { cls: `arthur-terminal-note ${cls}`.trim(), text });
}
