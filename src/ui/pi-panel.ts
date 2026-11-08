/**
 * Pi block — the observational surface for the pi coding service (agent
 * v0.7.0 GET /api/pi/status + tail endpoint). v0.11 redesign: the standalone
 * 'Pi' section is GONE — this block is owned by the merged SERVICES section
 * (dashboard-view) and renders FIRST inside it (device headers + session
 * cards), above the GPU grid within the same section (pi is not
 * hardware-bound). The section's collapse state persists as the Services
 * section's instancesCollapsed; the pi block itself has no head of its own.
 *
 * It renders:
 *
 *   warning line  — 'pi status unavailable (pi-sync status pipe not set up)'
 *                   whenever there is no usable device data (pipe absent →
 *                   the agent answers with devices: [], or the collector
 *                   failed); muted, never crash, never a card.
 *   device header — hostname (device id fallback), active session count, a
 *                   'stale' badge when the device reports stale:true.
 *   session cards — registry-driven SERVICE ROWS (src/icons.ts: id → row
 *                   icon + label; 'pi' renders the lucide 'terminal' glyph —
 *                   no official logo exists): row icon, name-or-cwd (fallback
 *                   = last path segment of cwd), model · provider, duration
 *                   (now − startedAt / lastActivity), active dot (green
 *                   active / grey inactive), subagent child-count badge,
 *                   and a compact stats LINE below the main line: device ·
 *                   last-activity age · session tokens (· $cost) — the
 *                   producer's heartbeat usage rollup (pi-arthur ≥0.1.3;
 *                   older feeds simply omit the numbers) — and, on ACTIVE
 *                   sessions with a persisted path only, a 'Peek' button
 *                   opening an inline mini-log of the session tail (last 10
 *                   entries, preview text only, via
 *                   GET /api/pi/sessions/…/tail; a pathless one-shot has no
 *                   file to tail → no Peek). Pathless + inactive sessions
 *                   (dead one-shot worker pollution) never render at all
 *                   (piRenderableSession, shared with the queue).
 *   expanded card — the session's subagent runs (agent name, task preview,
 *                   state icon: running → spinner, done → check, failed →
 *                   red cross, canceled → grey dash), and — when the feed
 *                   carries producer progress (pi-arthur ≥0.1.7 additives:
 *                   structured progress counts / detail / usage /
 *                   heartbeatAt) — an accessible progress line UNDER the row:
 *                   bar width from valid done/total counts only, percent +
 *                   current/note text + heartbeat age, a visible 'stale'
 *                   label once the heartbeat is >90s old, an indeterminate
 *                   'no plan' bar without counts, and distinct static/muted
 *                   endings for the terminal states (see piSubProgressLine). The badge + expansion
 *                   render as soon as the status feed carries entries whose
 *                   parentSessionId matches the session id (the in-pi pi-arthur
 *                   live-run listener populates them).
 *
 * NO lifecycle actions exist anywhere in this block: pi is observational —
 * no start/stop/restart, only the read-only Peek affordance. Active sessions
 * additionally surface in the JOB QUEUE (dashboard-view) as parent job
 * cards; the block keeps showing every session regardless of active state.
 */
import type {
	AgentPiDevice,
	AgentPiSession,
	AgentPiStatus,
	AgentPiSubagent,
	AgentPiSubProgress,
	AgentPiTail,
} from "../api/agent";
import { injectServiceIcon, serviceLabel } from "../icons";
import { el, fmtDuration, truncate } from "../util";

/**
 * Session-row surface: the status contract plus the producer's heartbeat
 * usage rollup (pi-arthur ≥0.1.3 adds totalTokens/costUsd on the session
 * entry; the agent passes session dicts through verbatim, so absent fields
 * just mean the row's stats line omits the numbers). Declared locally —
 * src/api/* is owned by a later worker (pi service button/dropdown).
 */
export interface PiSessionRow extends AgentPiSession {
	/** Cumulative response tokens of the session (usage rollup), if reported. */
	totalTokens?: number | null;
	/** Cumulative response cost in USD, if reported. */
	costUsd?: number | null;
}

export interface PiPanelOpts {
	/** Session-tail fetch backing the read-only 'Peek' mini-log. */
	fetchTail: (device: string, sessionId: string) => Promise<AgentPiTail>;
	/** The persisted collapsed state of the device-session ARCHIVES group
	 *  (one bool for the whole group, settings.piArchivesCollapsed). */
	archivesCollapsed: () => boolean;
	/** Persist a changed archives-collapse state. */
	setArchivesCollapsed: (collapsed: boolean) => void;
	/** Optional 'pi sessions (AHP)' affordance (slice 1 wiring: dashboard-view
	 *  bridges it to the plugin's open-AHP command/view activation path). */
	openAhp?: () => void;
}

export interface PiPanelData {
	/** Last GET /api/pi/status result (null = collector failed / not yet). */
	status: AgentPiStatus | null;
	/** Last collector error text (tooltip material on the warning line). */
	error: string | null;
	/** True while the agent answers /api/status at all (mutes the line). */
	agentOk: boolean;
}

/** State icons of a subagent run (shared with the queue child rows). */
export function piStateIcon(state: string): HTMLElement {
	const glyph = state === "running" ? "⟳" : state === "done" ? "✓" : state === "failed" ? "✕" : "–";
	return el("span", {
		cls: `arthur-pi-st arthur-pi-st--${state}`,
		text: glyph,
		attrs: { "data-state": state },
	});
}

// ------------------------------------------------------------------
// subagent grouping (v0.12.0) — current-run batch vs archives
// ------------------------------------------------------------------

/**
 * The grouped view of a session's subagent runs (v0.12.0):
 *
 *  - `current` — the CURRENT-RUN group, TOP of the list: every RUNNING run
 *    (never hidden, regardless of batch) + every terminal (done/failed/
 *    canceled) run of the MOST RECENT batchId — the latest dispatch wave.
 *    When a new batch starts, the previous batch's terminal runs move down
 *    into the archives.
 *  - `currentBatchId` — the batchId containing the most-recently-started run
 *    (null when NO entry carries a usable batchId).
 *  - `archived` — every OTHER terminal run, most-recent-first (finishedAt
 *    desc, fallback startedAt desc); rendered inside the collapsible
 *    'Archives' separator group (collapsed by default).
 *
 * batchId semantics: a missing, non-string, or blank batchId is null —
 * terminal null-batch runs are OLD entries the producer (pi-arthur) can date
 * to no batch; they group under ARCHIVES ordered by timestamp. Running
 * null-batch runs stay in `current` (running runs are never hidden, never
 * archived).
 */
export interface PiSubGroups {
	current: AgentPiSubagent[];
	currentBatchId: string | null;
	archived: AgentPiSubagent[];
}

const TERMINAL_SUB_STATES = new Set(["done", "failed", "canceled"]);

// ------------------------------------------------------------------
// subagent progress line (pi-arthur v0.1.7 additive optional fields)
// ------------------------------------------------------------------

/** Heartbeat staleness budget (ms) — mirrors pi-agents' STALE_MS: a running
 *  run whose last heartbeat/progress report is older than this renders a
 *  visible 'stale' label (never color-only). */
export const PI_SUB_STALE_MS = 90_000;

/** ms epoch of a numeric value, else 0. */
function numMs(n: unknown): number {
	return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/** The run's VALID structured progress (total > 0, done a finite number ≥ 0
 *  — anything else simply has no plan to draw a bar from), else null. */
export function piSubProgressOf(sub: AgentPiSubagent): AgentPiSubProgress | null {
	const p: unknown = (sub as { progress?: unknown }).progress;
	if (!p || typeof p !== "object") return null;
	const { total, done } = p as Record<"total" | "done", unknown>;
	if (!Number.isFinite(total) || !Number.isFinite(done)) return null;
	if ((total as number) <= 0 || (done as number) < 0) return null;
	return p as AgentPiSubProgress;
}

/** Compact heartbeat age: "8s" / "2m" / "1h" (pi-agents' formatHeartbeatAge). */
export function piSubHeartbeatAge(ageMs: number): string {
	const s = Math.max(0, Math.round(ageMs / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	return `${Math.floor(m / 60)}h`;
}

/** Clamped plan percent from valid progress counts (0..100). */
function piSubPct(p: AgentPiSubProgress): number {
	return Math.min(100, Math.max(0, Math.round((Math.min(p.done, p.total) / p.total) * 100)));
}

/**
 * The progress line rendered UNDER one subagent row (plain DOM, a11y-
 * annotated — the status words are plain text, never color-only):
 *
 *  - valid `progress` counts → a bar whose fill width is done/total (the
 *    ONLY trustable source) + the percent, the current/note step text and
 *    the heartbeat age; a heartbeat older than {@link PI_SUB_STALE_MS}
 *    switches the line to a visible 'stale …' label (--stale class);
 *  - RUNNING with no usable progress → an INDETERMINATE bar + the explicit
 *    'no plan' word (the producer's compact `detail` line as fallback info);
 *  - terminal states render distinctly: done keeps its (usually full)
 *    STATIC bar, failed/canceled show a muted static bar at the frozen
 *    width, and terminal rows NEVER show heartbeat-age/'stale' text (the
 *    feed never stamps those on terminal runs).
 *
 * Null = nothing worth showing (a terminal run with no progress, detail
 * AND usage keeps its row exactly as before — old feeds are untouched).
 */
export function piSubProgressLine(sub: AgentPiSubagent, now: number): HTMLElement | null {
	const p = piSubProgressOf(sub);
	const running = sub.state === "running";
	const detail = (sub.detail ?? "").trim();
	const usage = (sub.usage ?? "").trim();
	const pct = p ? piSubPct(p) : null;

	// Heartbeat only means something on RUNNING runs (terminal entries never
	// carry heartbeatAt); a recent progress report counts as a heartbeat too.
	const hbMs = running ? Math.max(tsMs(sub.heartbeatAt), numMs(p?.updatedAt)) : 0;
	const stale = running && hbMs > 0 && now - hbMs > PI_SUB_STALE_MS;

	if (!running && !p && !detail && !usage) return null;
	const line = el("div", {
		cls: `arthur-pi-subline arthur-pi-subline--${sub.state}${stale ? " arthur-pi-subline--stale" : ""}`,
	});

	const partBits = p ? [p.current?.trim() ?? "", p.note?.trim() ?? ""].filter((s) => s) : [];
	if (p) {
		const bar = el("div", {
			cls: `arthur-bar arthur-pi-subline-bar${stale ? " arthur-pi-subline-bar--stale" : ""}`,
			attrs: {
				role: "progressbar",
				"aria-valuemin": "0",
				"aria-valuemax": "100",
				"aria-valuenow": String(pct),
				"aria-valuetext": `${pct}%${partBits.length > 0 ? ` — ${partBits.join(" — ")}` : ""}`,
				"aria-label": `${sub.agent} — plan progress`,
			},
		});
		const fill = el("div", {
			cls: `arthur-bar-fill arthur-pi-subline-fill${running || sub.state === "done" ? "" : " arthur-pi-subline-fill--muted"}`,
		});
		fill.style.width = `${pct}%`;
		bar.append(fill);
		line.append(bar);
	} else if (running) {
		// No usable plan → indeterminate bar + the explicit 'no plan' word.
		const bar = el("div", {
			cls: "arthur-bar arthur-pi-subline-bar arthur-pi-subline-bar--indeterminate",
			attrs: {
				role: "progressbar",
				"aria-valuemin": "0",
				"aria-valuemax": "100",
				"aria-valuetext": "no plan",
				"aria-label": `${sub.agent} — no plan reported yet`,
			},
		});
		bar.append(el("div", { cls: "arthur-bar-fill arthur-bar-fill--indeterminate arthur-pi-subline-fill" }));
		line.append(bar);
	}

	const parts: string[] = [];
	if (running && p) {
		parts.push(`${pct}%`);
		parts.push(...partBits.map((s) => truncate(s, 72)));
	} else if (running) {
		parts.push("no plan");
		if (detail) parts.push(truncate(detail, 72));
	} else if (p) {
		parts.push(sub.state === "done" ? `${pct}% complete` : `${Math.min(p.done, p.total)}/${p.total} of plan, ${sub.state}`);
	}
	if (!running) {
		// Terminal states: distinct muted final line — never a heartbeat/'stale'.
		if (detail) parts.push(truncate(detail, 72));
	}
	if (running && hbMs > 0) {
		parts.push(
			stale
				? `stale — heartbeat ${piSubHeartbeatAge(now - hbMs)} ago`
				: `heartbeat ${piSubHeartbeatAge(now - hbMs)} ago`,
		);
	}
	if (usage) parts.push(truncate(usage, 72));
	if (line.children.length === 0 && parts.length === 0) return null;
	line.append(el("span", { cls: "arthur-pi-subline-meta", text: parts.join(" · ") }));
	return line;
}

/** The entry's usable batchId (trimmed non-empty string), else null. */
function piSubBatchOf(sub: AgentPiSubagent): string | null {
	const raw = (sub as { batchId?: unknown }).batchId;
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	return trimmed ? trimmed : null;
}

/**
 * Group a session's subagent runs (see {@link PiSubGroups}). All inputs are
 * returned in most-recent-first order (startedAt desc).
 */
export function piSubGroups(subs: AgentPiSubagent[]): PiSubGroups {
	const startMs = (s: AgentPiSubagent): number => tsMs(s.startedAt) || tsMs(s.finishedAt);

	// Most recent batchId = the batch holding the latest-started run.
	let currentBatchId: string | null = null;
	let bestStart = -1;
	for (const s of subs) {
		const batch = piSubBatchOf(s);
		if (!batch) continue;
		const st = startMs(s);
		if (st > bestStart) {
			bestStart = st;
			currentBatchId = batch;
		}
	}

	const current: AgentPiSubagent[] = [];
	const archived: AgentPiSubagent[] = [];
	for (const s of subs) {
		const terminal = TERMINAL_SUB_STATES.has(s.state);
		if (!terminal || s.state === "running") {
			// Guard for odd states: running (or unknown) runs never archive.
			current.push(s);
		} else if (currentBatchId !== null && piSubBatchOf(s) === currentBatchId) {
			current.push(s); // still the current dispatch wave (its terminal runs)
		} else {
			archived.push(s);
		}
	}

	const recency = (s: AgentPiSubagent): number => tsMs(s.finishedAt) || tsMs(s.startedAt);
	current.sort((a, b) => startMs(b) - startMs(a));
	archived.sort((a, b) => recency(b) - recency(a));
	return { current, currentBatchId, archived };
}

/**
 * Counts badge text for a grouped session row: 'N running', or
 * 'N running · M archived' with archives, or 'N done' when everything in the
 * current batch already finished (never hidden), or '' with no runs at all.
 */
export function piSubBadgeText(groups: PiSubGroups): string {
	const running = groups.current.filter((s) => s.state === "running").length;
	const archived = groups.archived.length;
	const parts: string[] = [];
	if (running > 0) parts.push(`${running} running`);
	if (archived > 0) parts.push(`${archived} archived`);
	if (parts.length === 0 && groups.current.length > 0) {
		parts.push(`${groups.current.length} done`);
	}
	return parts.join(" · ");
}

/**
 * One subagent run row (shared by the session panel and the queue parent
 * cards): state icon, agent name, task preview, live duration (running:
 * now − startedAt; finished: finishedAt − startedAt) and — below — the
 * producer's progress line ({@link piSubProgressLine}) when the run carries
 * anything worth showing (pi-arthur v0.1.7 additive fields).
 */
export function piSubRow(sub: AgentPiSubagent, now: number, cls: string): HTMLElement {
	const startMs = tsMs(sub.startedAt);
	const endMs = tsMs(sub.finishedAt) || (sub.state === "running" ? now : 0);
	const dur = startMs > 0 && endMs > startMs ? fmtDuration((endMs - startMs) / 1000) : null;
	const row = el("div", { cls: `${cls} ${cls}--${sub.state}` });
	const head = el("div", { cls: `${cls}-line` });
	head.append(
		piStateIcon(sub.state),
		el("span", { cls: `${cls}-agent`, text: truncate(sub.agent, 24) }),
		el("span", { cls: `arthur-card-meta ${cls}-task`, text: truncate(sub.taskPreview ?? "", 64), attrs: { title: sub.taskPreview ?? "" } }),
		dur ? el("span", { cls: "arthur-card-meta arthur-pi-duration", text: dur }) : el("span"),
	);
	row.append(head);
	const prog = piSubProgressLine(sub, now);
	if (prog) row.append(prog);
	return row;
}

export interface PiGroupedListOpts {
	/** True = the 'Archives' group is expanded (session-scoped, in-memory). */
	archiveOpen: boolean;
	/** Toggles the archives group (the caller re-renders). */
	onToggleArchive: () => void;
}

/**
 * The GROUPED subagent list of one session (expanded panel content):
 * TOP the 'current run' group (a small label only when archives exist too),
 * BELOW the collapsible 'Archives' separator (collapsed by default; hidden
 * entirely when there is nothing archived).
 */
export function piGroupedSubList(
	groups: PiSubGroups,
	now: number,
	cls: string,
	o: PiGroupedListOpts,
): HTMLElement {
	const panel = el("div", { cls: `${cls}s` });
	if (groups.current.length === 0 && groups.archived.length === 0) {
		panel.append(el("span", { cls: "arthur-card-meta arthur-pi-note", text: "no subagent runs" }));
		return panel;
	}
	if (groups.archived.length > 0) {
		panel.append(el("span", { cls: "arthur-card-meta arthur-pi-sublabel", text: "Current run" }));
	}
	for (const sub of groups.current) panel.append(piSubRow(sub, now, cls));
	if (groups.current.length === 0) {
		panel.append(el("span", { cls: "arthur-card-meta arthur-pi-note", text: "no current run" }));
	}
	if (groups.archived.length > 0) {
		const toggle = el("div", {
			cls: `arthur-pi-archives-toggle${o.archiveOpen ? " arthur-pi-archives-toggle--open" : ""}`,
			attrs: {
				role: "button",
				tabindex: "0",
				"aria-expanded": String(o.archiveOpen),
				title: `Toggle the ${groups.archived.length} archived subagent run${groups.archived.length === 1 ? "" : "s"}`,
			},
		});
		toggle.append(
			el("span", { cls: "arthur-pi-archives-chev", text: o.archiveOpen ? "▾" : "▸" }),
			el("span", { text: "Archives" }),
			el("span", { cls: "arthur-card-meta", text: String(groups.archived.length) }),
		);
		const toggleIt = (ev?: Event): void => {
			ev?.stopPropagation?.();
			o.onToggleArchive();
		};
		toggle.addEventListener("click", (ev) => toggleIt(ev));
		toggle.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				toggleIt();
			}
		});
		panel.append(toggle);
		if (o.archiveOpen) {
			for (const sub of groups.archived) panel.append(piSubRow(sub, now, cls));
		}
	}
	return panel;
}

/**
 * Running vs active tri-state of one pi session (producer contract:
 * pi-arthur v0.1.6 adds `running?: boolean` — TRUE while a turn executes;
 * undefined on older producers → treat as false-but-active):
 *   'running'  — active AND running → pulsing accent cue
 *   'active'   — active but idle (no turn executing) → solid green
 *   'inactive' — not active → grey
 */
export type PiSessionState = "running" | "active" | "inactive";

/** The session's tri-state (see {@link PiSessionState}). */
export function piSessionState(sess: AgentPiSession): PiSessionState {
	if (sess.active !== true) return "inactive";
	return sess.running === true ? "running" : "active";
}

/**
 * Group one device's sessions (v0.12.x session archives):
 *
 *  - `current` — the CURRENT sessions area: RUNNING sessions first, then the
 *    active-idle ones; each group sorted by startedAt desc.
 *  - `archived` — ALL renderable inactive sessions, newest-lastActivity
 *    first; rendered inside the collapsible 'Archives' separator group
 *    below the current sessions (collapsed by default, persisted as ONE
 *    bool for the whole group).
 *
 * The piRenderableSession guard applies to BOTH groups: a pathless +
 * inactive dead one-shot entry never renders anywhere. Inactive sessions
 * never reach the JOB QUEUE — the queue keeps showing the active sessions
 * only.
 */
export interface PiDeviceSessionGroups {
	current: AgentPiSession[];
	archived: AgentPiSession[];
}

/** Group + sort one device's sessions (see {@link PiDeviceSessionGroups}). */
export function piDeviceSessionGroups(sessions: AgentPiSession[]): PiDeviceSessionGroups {
	const renderable = (sessions ?? []).filter(piRenderableSession);
	const byStartDesc = (a: AgentPiSession, b: AgentPiSession): number =>
		tsMs(b.startedAt) - tsMs(a.startedAt);
	const current: AgentPiSession[] = [];
	for (const sess of renderable.filter((s) => piSessionState(s) === "running").sort(byStartDesc)) {
		current.push(sess);
	}
	for (const sess of renderable.filter((s) => piSessionState(s) === "active").sort(byStartDesc)) {
		current.push(sess);
	}
	const archived = renderable
		.filter((s) => piSessionState(s) === "inactive")
		.sort((a, b) => tsMs(b.lastActivity) - tsMs(a.lastActivity));
	return { current, archived };
}

/** Session display name: friendly name, else the last path segment of cwd. */
export function piSessionLabel(sess: AgentPiSession): string {
	const named = (sess.name ?? "").trim();
	if (named) return named;
	const cwd = (sess.cwd ?? "").trim();
	if (cwd) {
		const last = cwd.split("/").filter(Boolean).pop();
		if (last) return last;
	}
	return sess.id;
}

/**
 * Renderability guard (belt-and-braces vs a polluted status file): a PATHLESS
 * (empty/whitespace path — never persisted) and INACTIVE session is a dead
 * one-shot entry (the pre-guard pi-arthur subagent self-registrations) — it
 * must never render as a session card or queue job. A pathless ACTIVE entry
 * still renders (a live one-shot process is meaningful in the report window)
 * but carries NO Peek affordance — piSessionTail needs the file path
 * (renderPeekableSession decides that).
 */
export function piRenderableSession(sess: AgentPiSession): boolean {
	const pathless = !(sess.path ?? "").trim();
	return !(pathless && sess.active === false);
}

/** Peek (session-tail) is for ACTIVE sessions with a persistable file only. */
export function piPeekableSession(sess: AgentPiSession): boolean {
	return Boolean(sess.active) && Boolean((sess.path ?? "").trim());
}

/** Parse an ISO-ish timestamp into epoch ms (0 when absent/unparseable). */
function tsMs(raw?: string | null): number {
	if (!raw) return 0;
	const t = Date.parse(raw);
	return Number.isFinite(t) ? t : 0;
}

/** Compact token count: 14194 → "14.2k tok", 2_400_000 → "2.4M tok". */
export function fmtTokens(n: number | null | undefined): string {
	if (n == null || !Number.isFinite(n) || n <= 0) return "";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M tok`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k tok`;
	return `${Math.round(n)} tok`;
}

/** Compact USD cost: "$0.42"; zero/absent → "". */
export function fmtUsd(n: number | null | undefined): string {
	if (n == null || !Number.isFinite(n) || n < 0.000005) return "";
	return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
}

/** Peek mini-log cap: last 10 entries, preview text only. */
const TAIL_LINES = 10;

export class PiPanel {
	/** The pi block's root — lives INSIDE the 'General' sub-container of the
	 *  'Instances' section, FIRST position (the GPU grid renders in the
	 *  'GPUs' sub-container below). */
	readonly rootEl: HTMLElement;
	private readonly warningEl: HTMLElement;
	private readonly devicesEl: HTMLElement;

	/** Expanded session cards (key = `${device}/${sessionId}`) — survives the
	 *  per-tick re-render because the state lives outside the DOM. */
	private readonly expanded = new Set<string>();
	/** Open peek mini-logs (same keys) + their last fetched tails. */
	private readonly peekOpen = new Set<string>();
	private readonly tails = new Map<string, AgentPiTail>();
	private readonly tailBusy = new Set<string>();

	constructor(parent: HTMLElement, private readonly opts: PiPanelOpts) {
		this.rootEl = parent.createEl("div", { cls: "arthur-pi-block" });
		// Optional read-only 'pi sessions (AHP)' affordance (a plain callback on
		// the opts-bag contract — the panel owns no AHP client itself).
		if (opts.openAhp) {
			const ahpBtn = document.createElement("button");
			ahpBtn.addClass("arthur-btn", "arthur-btn--tiny", "arthur-pi-ahp-open");
			ahpBtn.textContent = "pi sessions (AHP)";
			ahpBtn.setAttribute("title", "Open the AHP broker session catalogue (read-only view)");
			ahpBtn.addEventListener("click", (e) => {
				e?.stopPropagation?.();
				opts.openAhp?.();
			});
			this.rootEl.append(ahpBtn);
		}
		this.warningEl = el("p", {
			cls: "arthur-note arthur-pi-warning",
			text: "",
		});
		this.warningEl.hide();
		this.rootEl.append(this.warningEl);
		this.devicesEl = this.rootEl.createEl("div", { cls: "arthur-cards arthur-pi-devices" });
	}

	/** The device's subagent runs grouped per parent session id. */
	private subsOf(dev: AgentPiDevice, sessionId: string): AgentPiSubagent[] {
		return (dev.subagents ?? []).filter((s) => s.parentSessionId === sessionId);
	}

	/** In-memory 'Archives' group expansion, per session (collapsed by default;
	  * pruned with dead sessions alongside the expansion/peek state). */
	private readonly archivesOpen = new Set<string>();

	private toggleArchives(key: string): void {
		if (this.archivesOpen.has(key)) this.archivesOpen.delete(key);
		else this.archivesOpen.add(key);
		this.repaint();
	}

	/** Repaint from the last poll snapshot. Never throws with devices: []. */
	render(data: PiPanelData): void {
		this.lastData = data;
		const status = data.status;
		const devices = status?.devices ?? [];
		this.devicesEl.empty();

		if (devices.length === 0) {
			this.warningEl.setText("pi status unavailable (pi-sync status pipe not set up)");
			this.warningEl.setAttribute(
				"title",
				data.error ? `last attempt — ${data.error}` : "no pi-sync devices reported",
			);
			this.warningEl.show();
			this.devicesEl.hide();
			return;
		}

		this.warningEl.hide();
		this.devicesEl.show();
		const now = Date.now();
		for (const dev of devices) {
			this.devicesEl.append(this.deviceBlock(dev, now));
		}
	}

	/** One device: compact header (name, active count + archived count, stale
	 *  badge) + the session cards: the CURRENT sessions area (running first,
	 *  then active-idle, startedAt desc) and — below — the collapsible
	 *  'Archives' separator (collapsed by default, persisted) holding ALL
	 *  inactive sessions, newest-lastActivity first. */
	private deviceBlock(dev: AgentPiDevice, now: number): HTMLElement {
		const wrap = el("div", { cls: "arthur-pi-device" });
		const groups = piDeviceSessionGroups(dev.sessions);
		const active = dev.sessions?.filter((s) => s.active).length ?? 0;
		const countBadge = groups.archived.length > 0
			? `${active} active (${groups.archived.length} archived)`
			: `${active} active`;
		const head = el("div", { cls: "arthur-pi-device-head" });
		head.append(
			el("span", { cls: "arthur-pi-device-name", text: (dev.hostname ?? "").trim() || dev.device }),
			el("span", { cls: "arthur-card-meta", text: countBadge }),
		);
		if (dev.stale === true) {
			head.append(el("span", { cls: "arthur-badge arthur-badge--down arthur-pi-stale", text: "stale" }));
		}
		wrap.append(head);
		const cards = el("div", { cls: "arthur-pi-sessions" });
		// Current sessions area — running first, then active-idle (groups are
		// pre-sorted). Inactive sessions NEVER enter the job queue; they live
		// in the archives group below.
		for (const sess of groups.current) {
			cards.append(this.sessionCard(dev, sess, now));
		}
		if (groups.archived.length > 0) {
			cards.append(this.archivesToggle(groups.archived.length));
			if (this.opts.archivesCollapsed() !== true) {
				for (const sess of groups.archived) {
					cards.append(this.sessionCard(dev, sess, now));
				}
			}
		}
		wrap.append(cards);
		return wrap;
	}

	/** The collapsible 'Archives' separator row (device-session archives;
	 *  same pattern as the subagent archives toggle, one persisted collapsed
	 *  bool for the whole group across all devices). */
	private archivesToggle(count: number): HTMLElement {
		const open = this.opts.archivesCollapsed() !== true;
		const toggle = el("div", {
			cls: `arthur-pi-archives-toggle arthur-pi-sess-archives${open ? " arthur-pi-archives-toggle--open" : ""}`,
			attrs: {
				role: "button",
				tabindex: "0",
				"aria-expanded": String(open),
				title: `Toggle the ${count} archived session${count === 1 ? "" : "s"}`,
			},
		});
		toggle.append(
			el("span", { cls: "arthur-pi-archives-chev", text: open ? "▾" : "▸" }),
			el("span", { text: "Archives" }),
			el("span", { cls: "arthur-card-meta", text: String(count) }),
		);
		const toggleIt = (): void => {
			this.opts.setArchivesCollapsed(open); // open → collapse, closed → expand
			this.repaint();
		};
		toggle.addEventListener("click", (ev?: Event) => {
			ev?.stopPropagation?.();
			toggleIt();
		});
		toggle.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				toggleIt();
			}
		});
		return toggle;
	}

	/**
	 * One compact session row — registry-driven service row (icon + label),
	 * a MAIN line (dot · icon · name · model·provider · duration · subagent
	 * count badge · Peek) and ONE compact stats line below (device ·
	 * last-activity age · tokens · cost). Click expands the subagent list.
	 */
	private sessionCard(dev: AgentPiDevice, sess: AgentPiSession, now: number): HTMLElement {
		const key = `${dev.device}/${sess.id}`;
		const subs = this.subsOf(dev, sess.id);
		const groups = piSubGroups(subs);
		const badgeText = piSubBadgeText(groups);
		const runningSubs = groups.current.filter((s) => s.state === "running").length;
		const expanded = this.expanded.has(key);
		// Running vs active tri-state (producer contract v0.1.6): undefined
		// running on older producers reads as active-only (idle).
		const sessState = piSessionState(sess);
		const card = el("div", {
			cls: `arthur-pi-card ${sess.active ? "arthur-pi-card--active" : "arthur-pi-card--inactive"}`
				+ (sessState === "running" ? " arthur-pi-card--running" : ""),
			attrs: { "data-pi-session": key, "data-pi-service": "pi", "data-pi-state": sessState },
		});
		const dotCls = sessState === "running"
			? "arthur-dot arthur-dot--pulse"
			: sess.active
				? "arthur-dot arthur-dot--green"
				: "arthur-dot arthur-dot--gray";
		const head = el("div", { cls: "arthur-pi-card-head" });
		head.append(el("span", { cls: dotCls, attrs: { "aria-label": sessState } }));
		// The state label (running / active / inactive) right after the dot.
		head.append(el("span", { cls: `arthur-pi-state arthur-pi-state--${sessState}`, text: sessState }));
		// Registry-driven service row icon + label ('pi' → lucide terminal
		// glyph; new non-GPU services render their own entry for free).
		const icon = el("span", { cls: "arthur-pi-row-icon", attrs: { "data-service": "pi", "aria-label": serviceLabel("pi") } });
		injectServiceIcon(icon, "pi");
		head.append(icon);
		head.append(el("span", { cls: "arthur-pi-card-title", text: truncate(piSessionLabel(sess), 32), attrs: { title: sess.cwd || sess.id } }));
		head.append(el("span", {
			cls: "arthur-card-meta arthur-pi-card-meta",
			text: [sess.model ?? null, sess.provider ?? null].filter((s) => s != null && String(s).trim()).join(" · "),
		}));
		// duration: now − startedAt (active) / lastActivity (inactive)
		const durMs = sess.active ? tsMs(sess.startedAt) || tsMs(sess.lastActivity) : tsMs(sess.lastActivity);
		if (durMs > 0) {
			head.append(el("span", { cls: "arthur-card-meta arthur-pi-duration", text: fmtDuration(Math.max(0, (now - durMs) / 1000)) }));
		}
		// Subagent grouped counts badge (v0.12.0) — 'N running · M archived':
		// N = RUNNING runs of the current-run group, M = archived terminal runs;
		// all-terminal current batch folds into 'N done'. Click expands the
		// grouped list (current run on top, collapsible Archives below).
		if (subs.length > 0 && badgeText) {
			head.append(
				el("span", {
					cls: `arthur-badge arthur-badge--idle arthur-pi-count${runningSubs > 0 ? " arthur-pi-count--running" : ""}`,
					text: badgeText,
					attrs: { title: `${runningSubs} running subagent${runningSubs === 1 ? "" : "s"}` },
				}),
			);
		}
		// Read-only 'Open session' affordance (observational — the ONLY button
		// on a pi row; no lifecycle actions exist for pi). Needs an active
		// session WITH a persisted file: piSessionTail tails the jsonl path, a
		// pathless one-shot has nothing to tail (would 404).
		if (piPeekableSession(sess)) {
			const peek = document.createElement("button");
			peek.textContent = this.peekOpen.has(key) ? "Hide log" : "Peek";
			peek.addClass("arthur-btn", "arthur-btn--tiny", "arthur-pi-peek");
			peek.setAttribute("title", "Open session — last transcript entries (preview text)");
			peek.addEventListener("click", (e) => {
				e?.stopPropagation?.();
				this.togglePeek(dev.device, sess.id);
			});
			head.append(peek);
		}
		card.append(head);

		// ONE compact stats line: device · last-activity age · session tokens
		// (· cost) — the producer's usage rollup when the feed carries it.
		const stats: string[] = [(dev.hostname ?? "").trim() || dev.device];
		const activityMs = tsMs(sess.lastActivity);
		if (activityMs > 0) {
			stats.push(`activity ${fmtDuration(Math.max(0, Math.floor((now - activityMs) / 1000)))} ago`);
		}
		const tok = fmtTokens((sess as PiSessionRow).totalTokens);
		if (tok) stats.push(tok);
		const cost = fmtUsd((sess as PiSessionRow).costUsd);
		if (cost) stats.push(cost);
		card.append(el("span", { cls: "arthur-card-meta arthur-pi-card-stats", text: stats.join(" · ") }));

		if (expanded) {
			card.addClass("arthur-pi-card--expanded");
			// v0.12.0 grouped subagent list: the current run (top) + the
			// collapsible, collapsed-by-default Archives below.
			card.append(piGroupedSubList(groups, now, "arthur-pi-sub", {
				archiveOpen: this.archivesOpen.has(key),
				onToggleArchive: () => this.toggleArchives(key),
			}));
		}
		card.setAttribute("title", expanded ? "Click to collapse" : "Click to expand");
		card.addEventListener("click", (e) => this.toggleExpanded(key, e));
		// An open peek mini-log is NOT the subagent expansion — it renders
		// additionally, below the (possibly expanded) subagent list.
		if (this.peekOpen.has(key)) {
			card.append(this.miniLog(key));
		}
		return card;
	}

	/** Toggle a session card's subagent expansion (buttons own their clicks). */
	private toggleExpanded(key: string, ev?: Event): void {
		if (ev) {
			const target = (ev.target ?? null) as { closest?: (sel: string) => Element | null } | null;
			if (typeof target?.closest === "function" && (target.closest("button") || target.closest("a"))) return;
		}
		if (this.expanded.has(key)) {
			this.expanded.delete(key);
		} else {
			this.expanded.add(key);
		}
		this.repaint();
	}

	/**
	 * Toggle the read-only 'Peek' mini-log of an ACTIVE session: opens the
	 * inline log (last 10 tail entries, preview text only) and fetches the
	 * tail via GET /api/pi/sessions/{device}/{id}/tail once per open stretch.
	 */
	private togglePeek(device: string, sessionId: string): void {
		const key = `${device}/${sessionId}`;
		if (this.peekOpen.has(key)) {
			this.peekOpen.delete(key);
			this.repaint();
			return;
		}
		this.peekOpen.add(key);
		if (!this.tails.has(key) && !this.tailBusy.has(key)) {
			this.tailBusy.add(key);
			void this.opts
				.fetchTail(device, sessionId)
				.then((tail) => {
					this.tails.set(key, tail);
				})
				.catch(() => {
					this.tails.set(key, { lines: [{ type: "error", preview: "tail unavailable" }] });
				})
				.finally(() => {
					this.tailBusy.delete(key);
					if (this.peekOpen.has(key)) this.repaint();
				});
		}
		this.repaint();
	}

	/** One peek mini-log: last 10 entries, preview text only. */
	private miniLog(key: string): HTMLElement {
		const box = el("div", { cls: "arthur-pi-log" });
		if (this.tailBusy.has(key) && !this.tails.has(key)) {
			box.append(el("span", { cls: "arthur-card-meta arthur-pi-note", text: "loading tail…" }));
			return box;
		}
		const tail = this.tails.get(key);
		const lines = (tail?.lines ?? []).slice(-TAIL_LINES);
		if (lines.length === 0) {
			box.append(el("span", { cls: "arthur-card-meta arthur-pi-note", text: "log is empty" }));
			return box;
		}
		for (const line of lines) {
			const row = el("div", { cls: "arthur-pi-log-row" });
			const role = (line.role ?? line.type ?? "").trim();
			row.append(el("span", { cls: "arthur-pi-log-role", text: role || "·" }));
			row.append(el("span", { cls: "arthur-pi-log-preview", text: truncate(line.preview ?? "", 96) }));
			box.append(row);
		}
		return box;
	}

	/** Repaint with the previously rendered data snapshot (toggle handlers). */
	private lastData: PiPanelData = { status: null, error: null, agentOk: false };
	private repaint(): void {
		this.render(this.lastData);
	}

	/** Drop stale peek state for sessions/devices that no longer exist. */
	prune(devices: AgentPiDevice[]): void {
		const live = new Set<string>();
		for (const dev of devices) {
			for (const sess of dev.sessions ?? []) live.add(`${dev.device}/${sess.id}`);
		}
		for (const key of [...this.expanded, ...this.peekOpen]) {
			if (!live.has(key)) {
				this.expanded.delete(key);
				this.peekOpen.delete(key);
				this.tails.delete(key);
				this.archivesOpen.delete(key);
			}
		}
	}
}
