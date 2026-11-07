/**
 * Service bar — the dashboard's top row of service buttons, one per service
 * from the agent's /api/status (in agent order). State → interaction map:
 *
 *   agent unreachable  → configured services rendered as disabled grey
 *                        buttons, tooltip "agent unreachable (<error>)"
 *   service inactive   → grey (desaturated) button
 *                        click → start the default instance → toast + re-poll
 *   service active     → accent-colored button (sliced: right ~10% end is a full-
 *                        height red stop-all slice)
 *   pi (PSEUDO-service) → appended AFTER the agent services; pi is NOT
 *                        agent-lifecycle-managed (no start/spawn/stop-all —
 *                        no red kill slice): ACCENT when any device reports
 *                        sessionsActive > 0, grey otherwise; hover → the
 *                        pi DEVICE dropdown (one row per device, offline rows
 *                        greyed + red dot), hovering an ONLINE row → a second
 *                        menu to the RIGHT of the row ('New…' + the device's
 *                        live sessions); click → the directory-picker modal
 *                        (new pi session) pinned to the last-used / only-
 *                        online device; /api/pi/status unreachable entirely →
 *                        disabled-with-tooltip (never hidden)
 *                        hover (every registered service) → compact GPU
 *                        dropdown; multi-instance: 'Single GPU'/'Multi-GPUs'
 *                        segmented mode toggle (accent-highlighted, no
 *                        checkbox glyph) + one checkbox line per machine GPU
 *                        with VRAM/util, persisted per service in the plugin
 *                        settings (spawnGpuSel); single-instance: the SAME
 *                        GPU lines READ-ONLY (no toggle, no checkboxes —
 *                        spawn never applies, it is a live GPU-usage
 *                        overview)
 *                        a GPU occupied by an up instance or a busy ai-toolkit
 *                        job (running/queued/stopping) renders RED; hovering
 *                        the line tooltips its occupants ('In use: …') or a
 *                        free-VRAM summary ('Free — XG of 12G used · % · °')
 *                        main-area click → spawn a new instance (with the
 *                        checked GPU set as the request body; success: "Spawned
 *                        <name> instance on port X"; 409 single-instance /
 *                        max reached: toast the agent's error, no crash)
 *                        red slice click → confirm "Stop all <name>
 *                        instances?" → stop ALL instances; 409 busy → second
 *                        modal offering force → stop(force=true)
 *
 * Buttons are cached DOM nodes keyed by service id: state changes only toggle
 * classes/text/attributes — never a full rebuild.
 */
import { setIcon, setTooltip } from "obsidian";

import type { AgentPiSession, AgentService } from "../api/agent";
import { injectIcon, injectServiceIcon } from "../icons";
import { fmtGigCompact, fmtDuration, gpuShortName } from "../util";
import { piMenuSessionLabel } from "./pi-picker";

/** Parse an ISO-ish timestamp into epoch ms (0 when absent/unparseable). */
function tsMs(raw?: string | null): number {
	if (!raw) return 0;
	const t = Date.parse(raw);
	return Number.isFinite(t) ? t : 0;
}

/** Tiny element builder (string text lands as an escaped text node). */
function el(tag: string, opts: { cls?: string; text?: string } = {}): HTMLElement {
	const node = document.createElement(tag);
	if (opts.cls) node.className = opts.cls;
	if (opts.text !== undefined) node.textContent = opts.text;
	return node;
}
/**
 * Fallback service list for when the agent is unreachable (ids the currently
 * deployed agent registry knows; buttons render disabled).
 */
const FALLBACK_SERVICES: Array<{ id: string; name: string }> = [
	{ id: "comfyui", name: "ComfyUI" },
	{ id: "aitoolkit", name: "AI Toolkit" },
];

/** The pi PSEUDO-service: never part of the agent's /api/status registry (pi
 *  is not agent-lifecycle-managed) — always appended AFTER the real services.
 *  `active` is repainted per tick from the pi feed (any sessionsActive > 0). */
const PI_PSEUDO_SERVICE: AgentService = {
	id: "pi",
	name: "pi",
	active: false,
	multi_instance: false,
	max_instances: 1,
	default_port: 0,
	instances: [],
};

/** Render input gathered from the latest agent poll. */
export interface ServiceBarState {
	/** /api/status answered? anything but true → disabled fallback buttons. */
	agentOk: boolean | null;
	/** Last agent error (tooltip material), used when agentOk !== true. */
	error: string | null;
	/** Services in the order the agent returned them. */
	services: AgentService[];
	/** Pi feed snapshot for the pseudo-service button (null → pi disabled). */
	pi?: PiMenuData | null;
	/** The profile's ai-toolkit integration toggle (undefined/true = ON).
	 *  false → the aitoolkit pill renders a distinct USER-DISABLED state
	 *  (grey + muted 'disabled' label — NOT the error-offline styling) and
	 *  is inert (no start/spawn/hover dropdown). */
	aiToolkitEnabled?: boolean;
}

/** One pi device row of the pi DEVICE dropdown: the /api/pi/devices entry
 *  merged with the device's session list from the /api/pi/status snapshot. */
export interface PiDeviceEntry {
	id: string;
	hostname: string | null;
	/** Recent feed heard from? false → greyed + red dot ('offline' state).
	 *  Reachable rows are still clickable (New…) for the spawn flow. */
	online: boolean;
	/** Usable for dirs/spawn: feed-fresh OR ssh-reachable (agent v0.8.1).
	 *  offline + reachable → greyed but clickable ('no active pi feed —
	 *  ssh ok'); offline + unreachable → greyed AND not clickable. */
	reachable: boolean;
	/** True for the machine the agent runs on (picker root = /home/slix). */
	self: boolean;
	/** Config ssh mapping ('user@host' or bare host) — picker root inference. */
	ssh: string | null;
	sessionsActive: number;
	sessionsTotal: number;
	/** Live sessions of the device (from /api/pi/status, device-keyed). */
	sessions: AgentPiSession[];
}

/** Pi hover data (the dashboard's merged devices + piStatus snapshot);
 *  reachable:false → the pi button renders disabled-with-tooltip. */
export interface PiMenuData {
	/** /api/pi/status answered? false → pi button disabled (never hidden). */
	reachable: boolean;
	/** Last pi collector error (tooltip material when unreachable). */
	error: string | null;
	devices: PiDeviceEntry[];
}

/** One machine occupant of a GPU (a live detail line for the tooltip). */
export interface GpuOccupant {
	/** e.g. 'comfy-0 (ComfyUI #0, :8188)' or 'job-name (AI Toolkit, running)'. */
	label: string;
}

/** GPU dropdown payload for one service — null → no dropdown for it. */
export interface GpuMenuData {
	/** Live GPUs from /api/gpus (stats null when the collector is degraded). */
	gpus: Array<{
		index: number;
		name: string;
		usedMb: number | null;
		totalMb: number | null;
		util: number | null;
		/** GPU temperature (°C; null when the collector is degraded). */
		temp: number | null;
	}>;
	/** GPU index → current occupants (up instances + busy ai-toolkit jobs). */
	occupants: Map<number, GpuOccupant[]>;
}

export const MENU_CLOSE_DELAY_MS = 300;

/** Service-level actions owned by the wiring layer (dashboard view). */
export interface ServiceBarCallbacks {
	/** Inactive service clicked → start the default instance. */
	onStart(svc: AgentService): void;
	/** Active service clicked → spawn a new instance. */
	onSpawn(svc: AgentService): void;
	/** Kill zone clicked → confirm → stop ALL instances (force path inside). */
	onKill(svc: AgentService): void;
	/** Hover GPU-menu data for a registered service (live GPUs + machine
	 *  occupancy); null → no dropdown for it (agent unreachable/unknown id). */
	gpuMenuData?(svcId: string): GpuMenuData | null;
	/** Persisted spawn GPU selection of a service (default: []). */
	gpuSelection?(svcId: string): number[];
	/** Persist a changed spawn GPU selection. */
	setGpuSelection?(svcId: string, gpus: number[]): void;
	/** Hover pi-device data (merged /api/pi/devices + /api/pi/status);
	 *  null / reachable:false → the pi device dropdown stays closed and the
	 *  pi button reads disabled. */
	piMenuData?(): PiMenuData | null;
	/** Pi button click → open the New-session flow (picker modal) pinned to
	 *  the last-used / only-online device. */
	onPiClick?(): void;
	/** 'New…' clicked on a device row → directory-picker modal for that device. */
	onPiNewSession?(deviceId: string): void;
	/** An existing session row clicked (observational handoff notice). */
	onPiSessionClick?(deviceId: string, sess: AgentPiSession): void;
}

/**
 * One cached service button, sliced: a main part (icon + name) and a full-height
 * red slice at the pill's right end (the stop-all kill zone).
 */
export interface ServiceButton {
	svc: AgentService;
	/** True for pseudo-services (pi): NOT agent-lifecycle-managed — no kill
	 *  slice, click opens the pi new-session flow instead of start/spawn. */
	pseudo: boolean;
	/** Latest rendered service-level state. */
	active: boolean;
	disabled: boolean;
	/** True when the USER turned this service off in the plugin settings
	 *  (ai-toolkit integration toggle) — distinct from agent-unreachable
	 *  disabled: grey + muted label, never error-styled, fully inert. */
	userOff: boolean;
	/** Hover wrapper (position:relative anchor for the GPU dropdown). */
	wrap: HTMLElement;
	btn: HTMLButtonElement;
	/** Sliced left part: icon + name (start/spawn click target). */
	main: HTMLElement;
	icon: HTMLElement;
	name: HTMLElement;
	/** Red right-end slice (stop-all click target); null on pseudo-services. */
	kill: HTMLElement | null;
	/** Hover dropdown (created lazily on first open; null until opened). */
	menu: HTMLElement | null;
	/** Pending hover-intent close timer id (null when none pending). */
	closeTimer: number | null;
	/** Pi only: the shared SECOND-LEVEL menu (device sessions), currently
	 *  attached to `subRow`; null when never opened / detached. */
	subMenu: HTMLElement | null;
	/** The device row the subMenu is attached to (null after close). */
	subRow: HTMLElement | null;
	/** Pending submenu close timer id (null when none pending). */
	subTimer: number | null;
}

export class ServiceBar {
	readonly el: HTMLElement;
	/** Cached buttons by service id — classList toggles, no rebuilds. */
	readonly buttons = new Map<string, ServiceButton>();

	/** Id of the service whose dropdown is currently open — only ONE service's
	 *  dropdown may be open at a time (opening another closes this one). */
	private openId: string | null = null;
	/** Document-level close listeners (Escape / click-outside) attached? */
	private docCloseAttached = false;

	private readonly callbacks: ServiceBarCallbacks;
	/** Children currently attached, in displayed order. */
	private readonly order: string[] = [];
	private readonly icons = new Map<string, string>();

	constructor(parent: HTMLElement, callbacks: ServiceBarCallbacks) {
		this.callbacks = callbacks;
		this.el = parent.createEl("div", { cls: "arthur-service-bar" });
	}

	/**
	 * Sync the button set + state with fresh poll data. Membership changes
	 * create/remove only the affected buttons; order follows the agent, with
	 * the pi PSEUDO-service always appended LAST (pi is not managed by the
	 * agent's service registry — it exists even when /api/status fails).
	 */
	render(state: ServiceBarState): void {
		const reachable = state.agentOk === true;
		const wanted: AgentService[] = (reachable ? state.services : FALLBACK_SERVICES.map((s) => ({
			id: s.id,
			name: s.name,
			active: false,
			multi_instance: false,
			max_instances: 1,
			default_port: 0,
			instances: [] as AgentService["instances"],
		}))).slice();
		// The pi pseudo-service button is ALWAYS wanted (spec: never hidden —
		// only disabled-with-tooltip while the pi feed is entirely unreachable).
		wanted.push(PI_PSEUDO_SERVICE);
		const pi = state.pi ?? null;

		// Membership.
		for (const svc of wanted) {
			if (!this.buttons.has(svc.id)) this.createButton(svc, svc.id === "pi");
		}
		for (const [id, entry] of [...this.buttons]) {
			if (!wanted.some((s) => s.id === id)) {
				this.closeMenuNow(entry); // drop any pending close timer
				entry.wrap.remove();
				this.buttons.delete(id);
				this.order.splice(this.order.indexOf(id), 1);
			}
		}
		// Display order follows the agent's service list.
		let expected = 0;
		for (const svc of wanted) {
			if (this.order[expected] !== svc.id) {
				const entry = this.buttons.get(svc.id);
				if (entry) {
					this.el.append(entry.wrap); // re-append moves the node
					this.order.splice(this.order.indexOf(svc.id), 1);
					this.order.splice(expected, 0, svc.id);
				}
			}
			expected++;
		}

		// State per service.
		const tooltip =
			`agent unreachable (${state.error ?? "offline"})`;
		for (const svc of wanted) {
			const entry = this.buttons.get(svc.id);
			if (!entry) continue;
			// Pseudo-services (pi) own their state machine entirely.
			if (entry.pseudo) {
				this.renderPiButton(entry, pi);
				continue;
			}
			// USER-DISABLED service (ai-toolkit integration toggle OFF): the pill
			// renders a distinct grey 'disabled' label — never the red/error
			// offline styling — and the button is fully inert (no start/spawn,
			// no hover dropdown). The user intentionally stopped the service;
			// its silence is expected, not an error.
			const userOff = svc.id === "aitoolkit" && state.aiToolkitEnabled === false;
			if (userOff) {
				const name = svc.name ?? svc.id;
				entry.svc = svc;
				entry.active = false;
				entry.disabled = true;
				entry.userOff = true;
				entry.btn.disabled = true;
				entry.btn.className = "arthur-svc-btn arthur-svc-btn--useroff";
				entry.name.setText(`${name} · disabled`);
				entry.btn.setAttribute(
					"aria-label",
					`${name} — disabled in plugin settings (ai-toolkit integration off; no requests are made)`,
				);
				this.applyIcon(entry);
				if (entry.kill) {
					entry.kill.style.display = ""; // greyed out by the pill's filter
					entry.kill.removeAttribute("aria-label");
					entry.kill.removeAttribute("title");
				}
				continue;
			}
			entry.userOff = false;
			const active = reachable && svc.active;
			entry.svc = svc;
			entry.active = active;
			entry.disabled = !reachable;
			entry.btn.disabled = !reachable;
			entry.btn.className =
				"arthur-svc-btn" +
				(reachable ? (active ? " arthur-svc-btn--active" : " arthur-svc-btn--offline") : " arthur-svc-btn--disabled");
			entry.name.setText(svc.name ?? svc.id);
			entry.btn.setAttribute(
				"aria-label",
				!reachable
					? tooltip
					: active
						? `${svc.name ?? svc.id} — active; click to spawn a new instance`
						: `${svc.name ?? svc.id} — offline; click to start`,
			);
			this.applyIcon(entry);
			// The red slice stays visible in every state — offline/unreachable
			// pills grey + desaturate it via the button's grayscale filter, so
			// the sliced shape survives (muted, non-interactive there).
			if (entry.kill) {
				entry.kill.style.display = "";
				entry.kill.setAttribute("aria-label", `Stop all ${svc.name ?? svc.id} instances`);
				entry.kill.setAttribute("title", `Stop all ${svc.name ?? svc.id} instances`);
			}
			// Pseudo-services keep NO slice at all (no stop-all semantics): the
			// pi pill renders without the red end piece in every state.
			if (entry.pseudo && entry.kill) entry.kill.style.display = "none";
		}
	}

	/** The pi pseudo-service button: disabled-with-tooltip while the pi feed
	 *  is unreachable entirely, ACCENT when any device has sessionsActive > 0,
	 *  grey otherwise — and NEVER a kill slice (no stop-all semantics). */
	private renderPiButton(entry: ServiceButton, pi: PiMenuData | null): void {
		const reachable = pi?.reachable === true;
		const activeCount = reachable
			? (pi?.devices ?? []).reduce((n, d) => n + (typeof d.sessionsActive === "number" ? d.sessionsActive : 0), 0)
			: 0;
		const active = reachable && activeCount > 0;
		entry.svc = { ...PI_PSEUDO_SERVICE, active };
		entry.active = active;
		entry.disabled = !reachable;
		entry.btn.disabled = !reachable;
		entry.btn.className =
			"arthur-svc-btn arthur-svc-btn--pseudo"
			+ (reachable ? (active ? " arthur-svc-btn--active" : " arthur-svc-btn--offline") : " arthur-svc-btn--disabled");
		entry.name.setText("pi");
		const online = (pi?.devices ?? []).filter((d) => d.online === true).length;
		entry.btn.setAttribute(
			"aria-label",
			!reachable
				? `pi unavailable (${pi?.error ?? "pi status unreachable"})`
				: active
					? `pi — ${activeCount} active session${activeCount === 1 ? "" : "s"}; click to start a new pi session`
					: `pi — no active pi sessions; click to open the new-session flow`,
			);
		this.applyIcon(entry);
		if (entry.kill) {
			// No red kill slice for pseudo-services — hidden in every state.
			entry.kill.style.display = "none";
			entry.kill.removeAttribute("aria-label");
			entry.kill.removeAttribute("title");
			void online;
		}
	}

	private createButton(svc: AgentService, pseudo = false): void {
		const icon = document.createElement("span");
		icon.className = "arthur-svc-icon";
		const name = document.createElement("span");
		name.className = "arthur-svc-name";
		// Sliced pill: left part (icon + name), right part (red stop-all slice).
		// Pseudo-services (pi) render WITHOUT the slice — no lifecycle actions.
		const main = document.createElement("span");
		main.className = "arthur-svc-main";
		main.append(icon, name);
		let kill: HTMLElement | null = null;
		const btn = document.createElement("button");
		if (pseudo) {
			btn.className = "arthur-svc-btn arthur-svc-btn--pseudo";
			btn.append(main);
		} else {
			kill = document.createElement("span");
			kill.className = "arthur-svc-kill";
			kill.setAttribute("role", "button");
			setIcon(kill, "trash-2");
			btn.className = "arthur-svc-btn";
			btn.append(main, kill);
		}

		// Hover wrapper: the position:relative anchor the GPU dropdown hangs
		// off (the dropdown must NOT live inside the <button>). Multi-instance
		// services open a compact GPU menu on hover; single-instance ones never
		// do (openMenu no-ops on them).
		const wrap = document.createElement("span");
		wrap.className = "arthur-svc-wrap";
		wrap.append(btn);

		const entry: ServiceButton = {
			svc,
			pseudo,
			active: false,
			disabled: true,
			userOff: false,
			wrap,
			btn,
			main,
			icon,
			name,
			kill,
			menu: null,
			closeTimer: null,
			subMenu: null,
			subRow: null,
			subTimer: null,
		};
		btn.addEventListener("click", () => {
			if (entry.disabled) return;
			if (entry.pseudo) {
				this.callbacks.onPiClick?.();
				return;
			}
			if (entry.active) this.callbacks.onSpawn(entry.svc);
			else this.callbacks.onStart(entry.svc);
		});
		if (kill) {
			kill.addEventListener("click", (e) => {
				// The kill zone is its own click target — never a spawn.
				e.stopPropagation();
				if (entry.active) this.callbacks.onKill(entry.svc);
			});
		}
		// Hover GPU dropdown (every registered service; the data callback
		// answering null keeps it closed — e.g. agent unreachable).
		// Hover-intent protocol: mouseenter of the wrap opens (and cancels any
		// pending close); mouseleave schedules a ~300ms-delayed close that
		// entering the wrap OR the dropdown cancels. The dropdown is a DOM child
		// of the wrap and a CSS bridge zone (::before on .arthur-svc-menu) tiles
		// the button→menu gap, so the pointer can travel onto the dropdown
		// without ever counting as a leave. Clicking the button still performs
		// its start/spawn action —
		// the dropdown is purely hover. JS mouseenter/mouseleave — the most
		// robust host signal inside Obsidian's DOM (no :has() dependency).
		wrap.addEventListener("mouseenter", () => this.enterHover(entry));
		wrap.addEventListener("mouseleave", () => this.scheduleClose(entry));
		this.buttons.set(svc.id, entry);
		this.order.push(svc.id);
		this.el.append(wrap);
	}

	/** Wrap mouseenter: cancel any pending close, then (re)open the dropdown
	 *  for this service (opening a sibling first closes it, no delay). A
	 *  user-disabled service (ai-toolkit off) never opens a dropdown. */
	private enterHover(entry: ServiceButton): void {
		this.cancelScheduledClose(entry);
		if (entry.userOff) return;
		this.openMenu(entry);
	}

	/** Open the hover dropdown under the service button (registered services
	 *  with available GPU menu data, or the pi device dropdown on the
	 *  pseudo-service; content is rebuilt fresh on every open so the data is
	 *  current). */
	private openMenu(entry: ServiceButton): void {
		const data = entry.pseudo
			? (this.callbacks.piMenuData?.() ?? null)
			: (this.callbacks.gpuMenuData?.(entry.svc.id) ?? null);
		if (!data) return;
		// Pseudo-services additionally require a reachable pi feed.
		if (entry.pseudo && (data as PiMenuData).reachable !== true) return;
		this.cancelScheduledClose(entry);
		// Hover-intent invariant: at most ONE dropdown open at a time — opening
		// this one closes a sibling's immediately (no delay).
		if (this.openId != null && this.openId !== entry.svc.id) {
			const other = this.buttons.get(this.openId);
			if (other) this.closeMenuNow(other);
		}
		if (!entry.menu) {
			entry.menu = document.createElement("span");
			entry.menu.className = "arthur-svc-menu";
			entry.menu.setAttribute("role", "menu");
			// Hovering INSIDE the dropdown must never close it: the dropdown is
			// a DOM child of the wrap (hover events on it keep the wrap in its
			// ancestry) and it carries its own enter/leave to (de)schedule the
			// close timer when the pointer crosses into it from outside the
			// wrap (through the CSS bridge zone or past the button's edge).
			entry.menu.addEventListener("mouseenter", () => this.cancelScheduledClose(entry));
			entry.menu.addEventListener("mouseleave", () => this.scheduleClose(entry));
			entry.wrap.append(entry.menu);
		}
		if (entry.pseudo) this.buildPiMenuContent(entry, data as PiMenuData);
		else this.buildMenuContent(entry, data as GpuMenuData);
		entry.menu.addClass("arthur-svc-menu--open");
		this.openId = entry.svc.id;
		this.attachDocClose();
	}

	/** Mouseleave of the wrap OR the dropdown: schedule the close after the
	 *  hover-intent delay (entering either element before it fires cancels). */
	private scheduleClose(entry: ServiceButton): void {
		if (!entry.menu?.hasClass("arthur-svc-menu--open")) return;
		this.cancelScheduledClose(entry);
		entry.closeTimer = window.setTimeout(() => {
			entry.closeTimer = null;
			this.closeMenuNow(entry);
		}, MENU_CLOSE_DELAY_MS);
	}

	/** Entering the button or the dropdown while a close is pending cancels it. */
	private cancelScheduledClose(entry: ServiceButton): void {
		if (entry.closeTimer != null) {
			window.clearTimeout(entry.closeTimer);
			entry.closeTimer = null;
		}
	}

	/** Close immediately (content is rebuilt on next hover). */
	private closeMenuNow(entry: ServiceButton): void {
		this.cancelScheduledClose(entry);
		this.closePiSub(entry);
		entry.menu?.removeClass("arthur-svc-menu--open");
		if (this.openId === entry.svc.id) this.openId = null;
	}

	/** Close every open dropdown immediately (click-outside / Escape path). */
	closeAllMenus(): void {
		for (const entry of this.buttons.values()) {
			if (entry.menu?.hasClass("arthur-svc-menu--open")) this.closeMenuNow(entry);
		}
		this.openId = null;
	}

	/** Escape / click-outside closing — registered lazily once per bar, and
	 *  guarded: the smoke-test DOM shim has no document.addEventListener, so
	 *  these would be a no-op there but work on the real Obsidian host. */
	private attachDocClose(): void {
		if (this.docCloseAttached || typeof document?.addEventListener !== "function") return;
		this.docCloseAttached = true;
		document.addEventListener("keydown", (e) => {
			if ((e as { key?: string })?.key === "Escape") this.closeAllMenus();
		});
		document.addEventListener("pointerdown", (e) => {
			const target = (e as { target?: unknown })?.target;
			if (target == null) return;
			for (const entry of this.buttons.values()) {
				if (entry.menu?.hasClass("arthur-svc-menu--open") && !this.contains(entry.wrap, target)) {
					this.closeMenuNow(entry);
				}
			}
		});
	}

	/** Ancestor containment that also works under the smoke-test DOM shim
	 *  (parents are modeled as `_parent` instead of parentNode). */
	private contains(node: HTMLElement, target: unknown): boolean {
		let cur: unknown = target;
		while (cur != null) {
			if (cur === node) return true;
			const n = cur as { parentNode?: unknown; _parent?: unknown };
			cur = n.parentNode ?? n._parent ?? null;
		}
		return false;
	}

	/** One dropdown MODE row ('Single GPU' / 'Multi-GPUs'): NOT a checkbox —
	 *  the effective mode's row is highlighted in the accent color (segmented-
	 *  toggle look); clicking applies the mode (see buildMenuContent). */
	private modeRow(label: string, active: boolean, onClick?: () => void): HTMLElement {
		const row = document.createElement("span");
		row.className = "arthur-gpu-mode" + (active ? " arthur-gpu-mode--active" : "");
		row.setAttribute("role", "menuitemradio");
		row.setAttribute("aria-checked", String(active));
		const text = document.createElement("span");
		text.className = "arthur-gpu-mode-text";
		text.textContent = label;
		row.append(text);
		if (onClick) row.addEventListener("click", () => onClick());
		return row;
	}

	/** One dropdown row: custom check glyph + label (clickable). */
	private menuRow(
		label: string,
		checked: boolean,
		used: boolean,
		tooltip: string,
		onClick?: () => void,
	): HTMLElement {
		const row = document.createElement("div");
		row.className = "arthur-gpu-opt" + (used ? " arthur-gpu-opt--used" : "");
		row.setAttribute("role", "menuitemcheckbox");
		row.setAttribute("aria-checked", String(checked));
		const check = document.createElement("span");
		check.className = "arthur-gpu-check" + (checked ? " arthur-gpu-check--checked" : "");
		check.textContent = checked ? "✓" : "";
		const text = document.createElement("span");
		text.className = "arthur-gpu-text";
		text.textContent = label;
		row.append(check, text);
		setTooltip(row, tooltip);
		if (onClick) row.addEventListener("click", () => onClick());
		return row;
	}

	/** One READ-ONLY dropdown row (single-instance services): no check glyph,
	 *  no click — a live GPU-usage overview line. Carries the same red
	 *  used-state + occupant/free tooltip as the interactive rows. */
	private staticRow(label: string, used: boolean, tooltip: string): HTMLElement {
		const row = document.createElement("div");
		row.className =
			"arthur-gpu-opt arthur-gpu-opt--static" + (used ? " arthur-gpu-opt--used" : "");
		const text = document.createElement("span");
		text.className = "arthur-gpu-text";
		text.textContent = label;
		row.append(text);
		setTooltip(row, tooltip);
		return row;
	}

	/** Hover tooltip for one GPU line: the occupant list when ANY up instance
	 *  or busy job sits on it ('In use: <first occupant>' + '\n+ <next>'),
	 *  else the free-VRAM summary with the collector's live stats. */
	private gpuTooltipText(gpu: GpuMenuData["gpus"][number], occupants: GpuOccupant[]): string {
		if (occupants.length > 0) {
			return `In use: ${occupants.map((o) => o.label).join("\n+ ")}`;
		}
		let first = "Free";
		if (gpu.usedMb != null && gpu.totalMb != null) {
			first = `Free — ${fmtGigCompact(gpu.usedMb)} of ${fmtGigCompact(gpu.totalMb)} used`;
		}
		const rest: string[] = [];
		if (gpu.util != null) rest.push(`${Math.round(gpu.util)}%`);
		if (gpu.temp != null) rest.push(`${Math.round(gpu.temp)}°`);
		return [first, ...rest].join(" · ");
	}

	/** (Re)build the dropdown's rows: for MULTI-instance services the 'Single
	 *  GPU' / 'Multi-GPUs' mode toggle (segmented, accent-highlighted — no
	 *  checkbox glyphs), a separator, then one checkbox line per machine GPU
	 *  ('GPU 0 — RTX 3060 · 9.4G/12G · 12%'). For SINGLE-instance services the
	 *  toggle and checkboxes are OMITTED — the same lines render read-only as
	 *  a live GPU-usage context (spawn never applies to them). A GPU occupied
	 *  by an up instance or a busy ai-toolkit job renders RED (spawn may still
	 *  be pinned onto it — the checkbox stays interactive); the occupant list
	 *  (or free-VRAM summary) lives on the line's hover tooltip via
	 *  setTooltip. The mode highlight is DERIVED from the checked GPU set
	 *  (0/1 checked = single mode, ≥2 = multi mode) so the two surfaces can
	 *  never disagree. */
	private buildMenuContent(entry: ServiceButton, data: GpuMenuData): void {
		const menu = entry.menu;
		if (!menu) return;
		const svcId = entry.svc.id;
		menu.empty();
		// The editable spawn-selection surface exists only where spawn applies.
		const interactive = entry.svc.multi_instance === true;
		const sel = interactive
			? [...(this.callbacks.gpuSelection?.(svcId) ?? [])].sort((a, b) => a - b)
			: [];
		const multi = sel.length >= 2;
		// The mode pair is a segmented toggle: exactly ONE side is accent-
		// highlighted at a time, DERIVED from the checked GPU set (0/1 checked =
		// single mode, ≥2 = multi mode). Clicking applies the mode: 'Single
		// GPU' clears every GPU check (back to the default modulo rotation),
		// 'Multi-GPUs' checks ALL GPUs so multi actually becomes effective
		// (a single checked GPU can never be a multi-GPU spawn).
		if (interactive) {
			const modeGroup = document.createElement("div");
			modeGroup.className = "arthur-gpu-mode-group";
			modeGroup.append(
				this.modeRow("Single GPU", !multi, () => {
					this.callbacks.setGpuSelection?.(svcId, []);
					this.buildMenuContent(entry, data); // repaint the highlight
				}),
				this.modeRow("Multi-GPUs", multi, () => {
					this.callbacks.setGpuSelection?.(svcId, data.gpus.map((g) => g.index));
					this.buildMenuContent(entry, data); // repaint the highlight
				}),
			);
			menu.append(modeGroup);
			const sep = document.createElement("div");
			sep.className = "arthur-svc-menu-sep";
			menu.append(sep);
		}
		if (data.gpus.length === 0) {
			const note = document.createElement("span");
			note.className = "arthur-svc-menu-note";
			note.textContent = "no GPU stats available";
			menu.append(note);
			return;
		}
		for (const gpu of data.gpus) {
			const occ = data.occupants.get(gpu.index) ?? [];
			const used = occ.length > 0;
			const tooltip = this.gpuTooltipText(gpu, occ);
			const stats: string[] = [];
			if (gpu.usedMb != null && gpu.totalMb != null) {
				stats.push(`${fmtGigCompact(gpu.usedMb)}/${fmtGigCompact(gpu.totalMb)}`);
			}
			if (gpu.util != null) stats.push(`${Math.round(gpu.util)}%`);
			const label =
				`GPU ${gpu.index} — ${gpuShortName(gpu.name)}`
				+ (stats.length ? ` · ${stats.join(" · ")}` : "");
			if (interactive) {
				const checked = sel.includes(gpu.index);
				menu.append(
					this.menuRow(label, checked, used, tooltip, () => {
						const cur = [...(this.callbacks.gpuSelection?.(svcId) ?? [])];
						const i = cur.indexOf(gpu.index);
						if (i >= 0) cur.splice(i, 1);
						else cur.push(gpu.index);
						// Exactly one → single GPU spawn; ≥2 → multi-GPU spawn;
						// none → default (no body, modulo rotation).
						this.callbacks.setGpuSelection?.(svcId, cur);
						this.buildMenuContent(entry, data); // repaint the marks
					}),
				);
			} else {
				menu.append(this.staticRow(label, used, tooltip));
			}
		}
	}

	/** Inject the service's official inline-SVG mark (cached per id);
	 *  pseudo-services render their REGISTRY row icon instead (pi → the lucide
	 *  'terminal' glyph — no official logo exists). */
	private applyIcon(entry: ServiceButton): void {
		if (this.icons.get(entry.svc.id) === entry.svc.id) return;
		this.icons.set(entry.svc.id, entry.svc.id);
		if (entry.pseudo) injectServiceIcon(entry.icon, entry.svc.id);
		else injectIcon(entry.icon, entry.svc.id);
	}

	// --------------------------------------------------------------- pi ----

	/** Close (detach) the pi second-level submenu and drop its close timer. */
	private closePiSub(entry: ServiceButton): void {
		if (entry.subTimer != null) {
			window.clearTimeout(entry.subTimer);
			entry.subTimer = null;
		}
		entry.subMenu?.removeClass("arthur-pi-submenu--open");
		entry.subRow = null;
	}

	/** Submenu leaving: schedule the close after the same hover-intent delay
	 *  (re-entering the row OR the submenu before it fires cancels). */
	private cancelPiSubClose(entry: ServiceButton): void {
		if (entry.subTimer != null) {
			window.clearTimeout(entry.subTimer);
			entry.subTimer = null;
		}
	}

	private schedulePiSubClose(entry: ServiceButton): void {
		if (!entry.subMenu?.hasClass("arthur-pi-submenu--open")) return;
		if (entry.subTimer != null) window.clearTimeout(entry.subTimer);
		entry.subTimer = window.setTimeout(() => {
			entry.subTimer = null;
			this.closePiSub(entry);
		}, MENU_CLOSE_DELAY_MS);
	}

	/** (Re)build the pi DEVICE dropdown: one row per /api/pi device — name
	 *  (id) + dimmed hostname suffix; ONLINE rows are hoverable (they open
	 *  the device's second-level sessions menu to the right); OFFLINE rows
	 *  render greyed + red-dot: reachable ones ('no active pi feed — ssh
	 *  ok') are clickable → the New… picker; unreachable ones are NOT
	 *  clickable ('offline — no feed in 5min'). */
	private buildPiMenuContent(entry: ServiceButton, data: PiMenuData): void {
		const menu = entry.menu;
		if (!menu) return;
		this.closePiSub(entry); // a rebuild must drop any attached submenu
		entry.subMenu = null;
		menu.empty();
		const devices = data.devices ?? [];
		if (devices.length === 0) {
			const note = document.createElement("span");
			note.className = "arthur-svc-menu-note";
			note.textContent = "no pi devices reported";
			menu.append(note);
			return;
		}
		for (const dev of devices) {
			menu.append(this.piDeviceRow(entry, dev));
		}
	}

	/** One device row of the pi dropdown (+ its hover submenu wiring).
	 *  online → hoverable (sessions submenu); offline+reachable → clickable
	 *  straight into the New… picker (no live feed → no session list);
	 *  offline+unreachable → greyed, inert. */
	private piDeviceRow(entry: ServiceButton, dev: PiDeviceEntry): HTMLElement {
		const online = dev.online === true;
		const usable = online || dev.reachable === true;
		const row = document.createElement("div");
		row.className = "arthur-pi-dev-row"
			+ (online ? ""
				: dev.reachable === true ? " arthur-pi-dev-row--offline arthur-pi-dev-row--sshok"
				: " arthur-pi-dev-row--offline");
		if (usable) row.setAttribute("role", "menuitem");
		row.setAttribute("data-pi-device", dev.id);
		const name = document.createElement("span");
		name.className = "arthur-pi-dev-name";
		name.textContent = dev.id;
		row.append(name);
		if (dev.hostname && dev.hostname !== dev.id) {
			row.append(el("span", { cls: "arthur-pi-dev-host", text: dev.hostname }));
		}
		if (!online) {
			row.append(el("span", { cls: "arthur-dot arthur-dot--red arthur-pi-dev-offline-dot" }));
			if (dev.reachable === true) {
				// stale feed but ssh answers: still spawnable — say so
				row.append(el("span", { cls: "arthur-pi-dev-note", text: "no active pi feed — ssh ok" }));
				setTooltip(row, "no active pi feed — ssh ok (click for New…)");
				row.addEventListener("click", () => {
					this.callbacks.onPiNewSession?.(dev.id);
					this.closeAllMenus();
				});
			} else {
				setTooltip(row, "offline — no feed in 5min");
			}
		} else {
			const host = dev.hostname ?? dev.id;
			setTooltip(
				row,
				`${host} — ${dev.sessionsActive} active · ${dev.sessionsTotal} session${dev.sessionsTotal === 1 ? "" : "s"}`,
			);
			// Online rows open the SECOND-level menu on hover (same hover-
			// intent protocol; the submenu is a DOM child of the row, so moving
			// onto it never counts as leaving the row).
			row.addEventListener("mouseenter", () => this.openPiSub(entry, row, dev));
			row.addEventListener("mouseleave", () => this.schedulePiSubClose(entry));
		}
		return row;
	}

	/** Open (or reparent + rebuild) the device's second-level menu to the
	 *  RIGHT of its row, top-aligned with the row: 'New…' first, then the
	 *  device's live sessions (label = name or 'session <8-char-id>', second
	 *  line = cwd · duration · active dot). */
	private openPiSub(entry: ServiceButton, row: HTMLElement, dev: PiDeviceEntry): void {
		this.cancelPiSubClose(entry);
		this.closePiSub(entry);
		if (!entry.subMenu) {
			entry.subMenu = document.createElement("span");
			entry.subMenu.className = "arthur-pi-submenu";
			entry.subMenu.setAttribute("role", "menu");
			entry.subMenu.addEventListener("mouseenter", () => this.cancelPiSubClose(entry));
			entry.subMenu.addEventListener("mouseleave", () => this.schedulePiSubClose(entry));
		}
		this.buildPiSubContent(dev);
		row.append(entry.subMenu);
		entry.subRow = row;
		entry.subMenu.addClass("arthur-pi-submenu--open");
	}

	/** (Re)fill the second-level menu for one device. */
	private buildPiSubContent(dev: PiDeviceEntry): void {
		const sub = this.buttons.get("pi")?.subMenu;
		if (!sub) return;
		sub.empty();
		// 'New…' — the directory-picker entry point for this device.
		const newBtn = document.createElement("div");
		newBtn.className = "arthur-pi-sub-item arthur-pi-new";
		const plus = document.createElement("span");
		plus.className = "arthur-pi-new-icon";
		setIcon(plus, "plus");
		newBtn.append(plus, el("span", { cls: "arthur-pi-new-text", text: "New…" }));
		newBtn.addEventListener("click", () => {
			this.callbacks.onPiNewSession?.(dev.id);
			this.closeAllMenus();
		});
		sub.append(newBtn);
		// Existing sessions of the device (from the piStatus snapshot):
		// label = friendly name or 'session <8-char-id>'; meta line = cwd ·
		// duration. Click is OBSERVATIONAL (view-handoff notice only).
		const now = Date.now();
		for (const sess of dev.sessions ?? []) {
			const item = el("div", {
				cls: `arthur-pi-sub-item arthur-pi-sess ${sess.active ? "arthur-pi-sess--active" : "arthur-pi-sess--idle"}`,
			});
			item.append(el("span", { cls: "arthur-pi-sess-name", text: piMenuSessionLabel(sess) }));
			// Meta line (second row line): cwd path · duration · active dot.
			const meta = el("span", { cls: "arthur-pi-sess-meta" });
			const startMs = tsMs(sess.startedAt);
			const refMs = sess.active ? startMs || tsMs(sess.lastActivity) : tsMs(sess.lastActivity);
			const dur = refMs > 0 && now > refMs ? fmtDuration((now - refMs) / 1000) : null;
			meta.append(el("span", { cls: `arthur-dot ${sess.active ? "arthur-dot--green" : "arthur-dot--gray"}` }));
			meta.append(document.createTextNode([sess.cwd ?? "", dur].filter((s): s is string => Boolean(s)).join(" · ")));
			item.append(meta);
			item.addEventListener("click", () => {
				this.callbacks.onPiSessionClick?.(dev.id, sess);
				this.closeAllMenus();
			});
			sub.append(item);
		}
		if ((dev.sessions ?? []).length === 0) {
			sub.append(el("span", { cls: "arthur-svc-menu-note", text: "no sessions on this device" }));
		}
	}
}
