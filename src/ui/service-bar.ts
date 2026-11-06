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
 *                        hover (multi-instance only) → compact GPU dropdown
 *                        ('Single GPU'/'Multi-GPUs' segmented mode toggle
 *                        (accent-highlighted, no checkbox glyph) + one
 *                        checkbox line per machine GPU with VRAM/util + the
 *                        instances occupying it); the choice persists per
 *                        service in the plugin settings (spawnGpuSel)
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
import { setIcon } from "obsidian";

import type { AgentService } from "../api/agent";
import { injectIcon } from "../icons";
import { fmtGigCompact, gpuShortName } from "../util";
/**
 * Fallback service list for when the agent is unreachable (ids the currently
 * deployed agent registry knows; buttons render disabled).
 */
const FALLBACK_SERVICES: Array<{ id: string; name: string }> = [
	{ id: "comfyui", name: "ComfyUI" },
	{ id: "aitoolkit", name: "AI Toolkit" },
];

/** Render input gathered from the latest agent poll. */
export interface ServiceBarState {
	/** /api/status answered? anything but true → disabled fallback buttons. */
	agentOk: boolean | null;
	/** Last agent error (tooltip material), used when agentOk !== true. */
	error: string | null;
	/** Services in the order the agent returned them. */
	services: AgentService[];
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
	}>;
	/** GPU index → instance ids currently occupying it (agent status). */
	occupants: Map<number, string[]>;
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
	/** Hover GPU-menu data (multi-instance services only); null → no dropdown. */
	gpuMenuData?(svcId: string): GpuMenuData | null;
	/** Persisted spawn GPU selection of a service (default: []). */
	gpuSelection?(svcId: string): number[];
	/** Persist a changed spawn GPU selection. */
	setGpuSelection?(svcId: string, gpus: number[]): void;
}

/**
 * One cached service button, sliced: a main part (icon + name) and a full-height
 * red slice at the pill's right end (the stop-all kill zone).
 */
export interface ServiceButton {
	svc: AgentService;
	/** Latest rendered service-level state. */
	active: boolean;
	disabled: boolean;
	/** Hover wrapper (position:relative anchor for the GPU dropdown). */
	wrap: HTMLElement;
	btn: HTMLButtonElement;
	/** Sliced left part: icon + name (start/spawn click target). */
	main: HTMLElement;
	icon: HTMLElement;
	name: HTMLElement;
	/** Red right-end slice (stop-all click target). */
	kill: HTMLElement;
	/** Hover GPU dropdown (created lazily on first open; null for
	 *  single-instance services — they never get a dropdown). */
	menu: HTMLElement | null;
	/** Pending hover-intent close timer id (null when none pending). */
	closeTimer: number | null;
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
	 * create/remove only the affected buttons; order follows the agent.
	 */
	render(state: ServiceBarState): void {
		const reachable = state.agentOk === true;
		const wanted = reachable ? state.services : FALLBACK_SERVICES.map((s) => ({
			id: s.id,
			name: s.name,
			active: false,
			multi_instance: false,
			max_instances: 1,
			default_port: 0,
			instances: [],
		}));

		// Membership.
		for (const svc of wanted) {
			if (!this.buttons.has(svc.id)) this.createButton(svc);
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
			entry.kill.style.display = "";
			entry.kill.setAttribute("aria-label", `Stop all ${svc.name ?? svc.id} instances`);
			entry.kill.setAttribute("title", `Stop all ${svc.name ?? svc.id} instances`);
		}
	}

	private createButton(svc: AgentService): void {
		const icon = document.createElement("span");
		icon.className = "arthur-svc-icon";
		const name = document.createElement("span");
		name.className = "arthur-svc-name";
		// Sliced pill: left part (icon + name), right part (red stop-all slice).
		const main = document.createElement("span");
		main.className = "arthur-svc-main";
		main.append(icon, name);
		const kill = document.createElement("span");
		kill.className = "arthur-svc-kill";
		kill.setAttribute("role", "button");
		setIcon(kill, "trash-2");

		const btn = document.createElement("button");
		btn.className = "arthur-svc-btn";
		btn.append(main, kill);

		// Hover wrapper: the position:relative anchor the GPU dropdown hangs
		// off (the dropdown must NOT live inside the <button>). Multi-instance
		// services open a compact GPU menu on hover; single-instance ones never
		// do (openMenu no-ops on them).
		const wrap = document.createElement("span");
		wrap.className = "arthur-svc-wrap";
		wrap.append(btn);

		const entry: ServiceButton = {
			svc,
			active: false,
			disabled: true,
			wrap,
			btn,
			main,
			icon,
			name,
			kill,
			menu: null,
			closeTimer: null,
		};
		btn.addEventListener("click", () => {
			if (entry.disabled) return;
			if (entry.active) this.callbacks.onSpawn(entry.svc);
			else this.callbacks.onStart(entry.svc);
		});
		kill.addEventListener("click", (e) => {
			// The kill zone is its own click target — never a spawn.
			e.stopPropagation();
			if (entry.active) this.callbacks.onKill(entry.svc);
		});
		// Hover GPU dropdown (multi-instance services only; the data callback
		// answering null keeps it closed). Hover-intent protocol: mouseenter of
		// the wrap opens (and cancels any pending close); mouseleave schedules
		// a ~300ms-delayed close that entering the wrap OR the dropdown cancels.
		// The dropdown is a DOM child of the wrap and a CSS bridge zone
		// (::before on .arthur-svc-menu) tiles the button→menu gap, so the
		// pointer can travel onto the checkboxes without ever counting as a
		// leave. Clicking the button still performs its start/spawn action —
		// the dropdown is purely hover. JS mouseenter/mouseleave — the most
		// robust host signal inside Obsidian's DOM (no :has() dependency).
		wrap.addEventListener("mouseenter", () => this.enterHover(entry));
		wrap.addEventListener("mouseleave", () => this.scheduleClose(entry));
		this.buttons.set(svc.id, entry);
		this.order.push(svc.id);
		this.el.append(wrap);
	}

	/** Wrap mouseenter: cancel any pending close, then (re)open the dropdown
	 *  for this service (opening a sibling first closes it, no delay). */
	private enterHover(entry: ServiceButton): void {
		this.cancelScheduledClose(entry);
		this.openMenu(entry);
	}

	/** Open the hover GPU dropdown under the service button (multi-instance
	 *  services with available menu data only; content is rebuilt fresh on
	 *  every open so the GPU stats/occupants are current). */
	private openMenu(entry: ServiceButton): void {
		if (!entry.svc.multi_instance) return;
		const data = this.callbacks.gpuMenuData?.(entry.svc.id) ?? null;
		if (!data) return;
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
		this.buildMenuContent(entry, data);
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
	private menuRow(label: string, checked: boolean, onClick?: () => void): HTMLElement {
		const row = document.createElement("div");
		row.className = "arthur-gpu-opt";
		row.setAttribute("role", "menuitemcheckbox");
		row.setAttribute("aria-checked", String(checked));
		const check = document.createElement("span");
		check.className = "arthur-gpu-check" + (checked ? " arthur-gpu-check--checked" : "");
		check.textContent = checked ? "✓" : "";
		const text = document.createElement("span");
		text.className = "arthur-gpu-text";
		text.textContent = label;
		row.append(check, text);
		if (onClick) row.addEventListener("click", () => onClick());
		return row;
	}

	/** (Re)build the dropdown's rows: the 'Single GPU' / 'Multi-GPUs' mode
	 *  toggle (segmented, accent-highlighted — no checkbox glyphs), a sep-
	 *  arator, then one checkbox line per machine GPU
	 *  ('GPU 0 — RTX 3060 · 9.4G/12G · 12%' + '(comfy-0)' occupant suffix).
	 *  The mode highlight is DERIVED from the checked GPU set (0/1 checked =
	 *  single mode, ≥2 = multi mode) so the two surfaces can never disagree. */
	private buildMenuContent(entry: ServiceButton, data: GpuMenuData): void {
		const menu = entry.menu;
		if (!menu) return;
		const svcId = entry.svc.id;
		menu.empty();
		const sel = [...(this.callbacks.gpuSelection?.(svcId) ?? [])].sort((a, b) => a - b);
		const multi = sel.length >= 2;
		// The mode pair is a segmented toggle: exactly ONE side is accent-
		// highlighted at a time, DERIVED from the checked GPU set (0/1 checked =
		// single mode, ≥2 = multi mode). Clicking applies the mode: 'Single
		// GPU' clears every GPU check (back to the default modulo rotation),
		// 'Multi-GPUs' checks ALL GPUs so multi actually becomes effective
		// (a single checked GPU can never be a multi-GPU spawn).
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
		if (data.gpus.length === 0) {
			const note = document.createElement("span");
			note.className = "arthur-svc-menu-note";
			note.textContent = "no GPU stats available";
			menu.append(note);
			return;
		}
		for (const gpu of data.gpus) {
			const checked = sel.includes(gpu.index);
			const occ = data.occupants.get(gpu.index) ?? [];
			const stats: string[] = [];
			if (gpu.usedMb != null && gpu.totalMb != null) {
				stats.push(`${fmtGigCompact(gpu.usedMb)}/${fmtGigCompact(gpu.totalMb)}`);
			}
			if (gpu.util != null) stats.push(`${Math.round(gpu.util)}%`);
			const label =
				`GPU ${gpu.index} — ${gpuShortName(gpu.name)}`
				+ (stats.length ? ` · ${stats.join(" · ")}` : "")
				+ (occ.length ? ` (${occ.join(", ")})` : "");
			menu.append(
				this.menuRow(label, checked, () => {
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
		}
	}

	/** Inject the service's official inline-SVG mark (cached per id). */
	private applyIcon(entry: ServiceButton): void {
		if (this.icons.get(entry.svc.id) === entry.svc.id) return;
		this.icons.set(entry.svc.id, entry.svc.id);
		injectIcon(entry.icon, entry.svc.id);
	}
}
