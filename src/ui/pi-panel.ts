/**
 * Pi panel — the observational surface for the pi coding service (agent v0.7.0
 * GET /api/pi/status + tail endpoint). Rendered as an outlined card section
 * ABOVE the GPU grid (pi is not hardware-bound): after the service bar/error
 * banner, before the Instances section. It reuses the section-head collapse
 * pattern (persisted piCollapsed setting, default expanded) and renders:
 *
 *   warning line  — 'pi status unavailable (pi-sync status pipe not set up)'
 *                   whenever there is no usable device data (pipe absent →
 *                   the agent answers with devices: [], or the collector
 *                   failed); muted, never crash, never a card.
 *   device header — hostname (device id fallback), active session count, a
 *                   'stale' badge when the device reports stale:true.
 *   session cards — the pi 'instances': name-or-cwd (fallback = last path
 *                   segment of cwd), model · provider, duration
 *                   (now − startedAt / lastActivity), active dot (green
 *                   active / grey inactive), running-subagent count badge,
 *                   and — on ACTIVE sessions only — a 'Peek' button opening
 *                   an inline mini-log of the session tail (last 10 entries,
 *                   preview text only, via GET /api/pi/sessions/…/tail).
 *   expanded card — the session's subagent runs (agent name, task preview,
 *                   state icon: running → spinner, done → check, failed →
 *                   red cross, canceled → grey dash).
 *
 * NO lifecycle actions exist anywhere in this panel: pi is observational —
 * no start/stop/restart, only the read-only Peek affordance. Active sessions
 * additionally surface in the JOB QUEUE (dashboard-view) as parent job
 * cards; the panel keeps showing every session regardless of active state.
 */
import type { AgentPiDevice, AgentPiSession, AgentPiStatus, AgentPiSubagent, AgentPiTail } from "../api/agent";
import { el, fmtDuration, truncate } from "../util";

export interface PiPanelOpts {
	/** Persisted collapse state (settings.piCollapsed). */
	isCollapsed: () => boolean;
	/** Toggle callback (flips + persists the setting). */
	onToggle: () => void;
	/** Session-tail fetch backing the read-only 'Peek' mini-log. */
	fetchTail: (device: string, sessionId: string) => Promise<AgentPiTail>;
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

/** Parse an ISO-ish timestamp into epoch ms (0 when absent/unparseable). */
function tsMs(raw?: string | null): number {
	if (!raw) return 0;
	const t = Date.parse(raw);
	return Number.isFinite(t) ? t : 0;
}

/** Peek mini-log cap: last 10 entries, preview text only. */
const TAIL_LINES = 10;

export class PiPanel {
	readonly sectionEl: HTMLElement;
	private readonly headEl: HTMLElement;
	private readonly bodyEl: HTMLElement;
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
		this.sectionEl = parent.createEl("div", { cls: "arthur-section arthur-section--pi" });
		this.headEl = this.buildHead();
		this.sectionEl.append(this.headEl);
		this.bodyEl = this.sectionEl.createEl("div", { cls: "arthur-section-body" });
		this.headEl.setAttribute("aria-controls", "arthur-section-pi");
		this.bodyEl.setAttribute("id", "arthur-section-pi");
		this.warningEl = el("p", {
			cls: "arthur-note arthur-pi-warning",
			text: "",
		});
		this.warningEl.hide();
		this.bodyEl.append(this.warningEl);
		this.devicesEl = this.bodyEl.createEl("div", { cls: "arthur-cards arthur-pi-devices" });
		this.syncCollapse();
	}

	/** Reuse of the section-head pattern ('Pi' + chevron, click-to-collapse). */
	private buildHead(): HTMLElement {
		const head = el("div", {
			cls: "arthur-section-head",
			attrs: {
				"data-section": "pi",
				role: "button",
				tabindex: "0",
				"aria-expanded": "true",
				title: "Toggle the pi panel section",
			},
		});
		head.append(
			el("span", { cls: "arthur-section-title", text: "Pi" }),
			el("span", { cls: "arthur-section-chevron", attrs: { "aria-hidden": "true" } }),
		);
		head.addEventListener("click", () => this.opts.onToggle());
		head.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				this.opts.onToggle();
			}
		});
		return head;
	}

	/** Repaint the persisted collapse state (body hidden + muted head). */
	syncCollapse(): void {
		const collapsed = this.opts.isCollapsed();
		if (collapsed) {
			this.bodyEl.hide();
			this.headEl.addClass("arthur-section-head--collapsed");
		} else {
			this.bodyEl.show();
			this.headEl.removeClass("arthur-section-head--collapsed");
		}
		this.headEl.setAttribute("aria-expanded", String(!collapsed));
	}

	/** The device's subagent runs grouped per parent session id. */
	private subsOf(dev: AgentPiDevice, sessionId: string): AgentPiSubagent[] {
		return (dev.subagents ?? []).filter((s) => s.parentSessionId === sessionId);
	}

	/** Repaint from the last poll snapshot. Never throws with devices: []. */
	render(data: PiPanelData): void {
		this.lastData = data;
		this.syncCollapse();
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

	/** One device: compact header (name, active count, stale badge) + cards. */
	private deviceBlock(dev: AgentPiDevice, now: number): HTMLElement {
		const wrap = el("div", { cls: "arthur-pi-device" });
		const active = dev.sessions?.filter((s) => s.active).length ?? 0;
		const head = el("div", { cls: "arthur-pi-device-head" });
		head.append(
			el("span", { cls: "arthur-pi-device-name", text: (dev.hostname ?? "").trim() || dev.device }),
			el("span", { cls: "arthur-card-meta", text: `${active} active` }),
		);
		if (dev.stale === true) {
			head.append(el("span", { cls: "arthur-badge arthur-badge--down arthur-pi-stale", text: "stale" }));
		}
		wrap.append(head);
		const cards = el("div", { cls: "arthur-pi-sessions" });
		for (const sess of dev.sessions ?? []) {
			cards.append(this.sessionCard(dev, sess, now));
		}
		wrap.append(cards);
		return wrap;
	}

	/** One compact session card — click expands the subagent run list. */
	private sessionCard(dev: AgentPiDevice, sess: AgentPiSession, now: number): HTMLElement {
		const key = `${dev.device}/${sess.id}`;
		const subs = this.subsOf(dev, sess.id);
		const runningSubs = subs.filter((s) => s.state === "running").length;
		const expanded = this.expanded.has(key);

		const card = el("div", {
			cls: `arthur-pi-card ${sess.active ? "arthur-pi-card--active" : "arthur-pi-card--inactive"}`,
			attrs: { "data-pi-session": key },
		});
		const dotCls = sess.active ? "arthur-dot arthur-dot--green" : "arthur-dot arthur-dot--gray";
		const head = el("div", { cls: "arthur-pi-card-head" });
		head.append(el("span", { cls: dotCls, attrs: { "aria-label": sess.active ? "active" : "inactive" } }));
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
		if (subs.length > 0) {
			head.append(
				el("span", {
					cls: `arthur-badge arthur-badge--idle arthur-pi-count${runningSubs > 0 ? " arthur-pi-count--running" : ""}`,
					text: String(subs.length),
					attrs: { title: `${runningSubs} running subagent${runningSubs === 1 ? "" : "s"}` },
				}),
			);
		}
		// Read-only 'Open session' affordance on ACTIVE cards (observational —
		// the ONLY button on a pi card; no lifecycle actions exist for pi).
		if (sess.active) {
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

		if (expanded) {
			card.addClass("arthur-pi-card--expanded");
			card.append(this.subagentList(subs, now));
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

	/** Expanded session panel: the parent session's subagent runs. */
	private subagentList(subs: AgentPiSubagent[], now: number): HTMLElement {
		const panel = el("div", { cls: "arthur-pi-subs" });
		if (subs.length === 0) {
			panel.append(el("span", { cls: "arthur-card-meta arthur-pi-note", text: "no subagent runs" }));
			return panel;
		}
		for (const sub of subs) {
			const startMs = tsMs(sub.startedAt);
			const endMs = tsMs(sub.finishedAt) || (sub.state === "running" ? now : 0);
			const dur = startMs > 0 && endMs > startMs ? fmtDuration((endMs - startMs) / 1000) : null;
			const row = el("div", { cls: `arthur-pi-sub arthur-pi-sub--${sub.state}` });
			row.append(
				piStateIcon(sub.state),
				el("span", { cls: "arthur-pi-sub-agent", text: truncate(sub.agent, 24) }),
				el("span", { cls: "arthur-card-meta arthur-pi-sub-task", text: truncate(sub.taskPreview ?? "", 64), attrs: { title: sub.taskPreview ?? "" } }),
				dur ? el("span", { cls: "arthur-card-meta arthur-pi-duration", text: dur }) : el("span"),
			);
			panel.append(row);
		}
		return panel;
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
			}
		}
	}
}
