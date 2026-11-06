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
 *                        ('Single GPU'/'Multi-GPUs' mode checkboxes + one
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
}

export class ServiceBar {
	readonly el: HTMLElement;
	/** Cached buttons by service id — classList toggles, no rebuilds. */
	readonly buttons = new Map<string, ServiceButton>();

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
		// answering null keeps it closed). JS mouseenter/mouseleave — the most
		// robust host signal inside Obsidian's DOM (no :has() dependency).
		wrap.addEventListener("mouseenter", () => this.openMenu(entry));
		wrap.addEventListener("mouseleave", () => this.closeMenu(entry));
		this.buttons.set(svc.id, entry);
		this.order.push(svc.id);
		this.el.append(wrap);
	}

	/** Open the hover GPU dropdown under the service button (multi-instance
	 *  services with available menu data only; content is rebuilt fresh on
	 *  every open so the GPU stats/occupants are current). */
	private openMenu(entry: ServiceButton): void {
		if (!entry.svc.multi_instance) return;
		const data = this.callbacks.gpuMenuData?.(entry.svc.id) ?? null;
		if (!data) return;
		if (!entry.menu) {
			entry.menu = document.createElement("span");
			entry.menu.className = "arthur-svc-menu";
			entry.menu.setAttribute("role", "menu");
			entry.wrap.append(entry.menu);
		}
		this.buildMenuContent(entry, data);
		entry.menu.addClass("arthur-svc-menu--open");
	}

	/** Hide the dropdown on mouse-leave (content is rebuilt on next hover). */
	private closeMenu(entry: ServiceButton): void {
		entry.menu?.removeClass("arthur-svc-menu--open");
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
	 *  checkboxes, a separator, then one checkbox line per machine GPU
	 *  ('GPU 0 — RTX 3060 · 9.4G/12G · 12%' + '(comfy-0)' occupant suffix).
	 *  Mode marks are DERIVED from the checked GPU set (0/1 checked = single
	 *  mode, ≥2 = multi mode) so the two surfaces can never disagree. */
	private buildMenuContent(entry: ServiceButton, data: GpuMenuData): void {
		const menu = entry.menu;
		if (!menu) return;
		const svcId = entry.svc.id;
		menu.empty();
		const sel = [...(this.callbacks.gpuSelection?.(svcId) ?? [])].sort((a, b) => a - b);
		const multi = sel.length >= 2;
		menu.append(
			this.menuRow("Single GPU", !multi, () =>
				// Back to the default: no pinned GPUs (agent modulo rotation).
				this.callbacks.setGpuSelection?.(svcId, []),
			),
			// 'Multi-GPUs' is indicative: it lights up as soon as ≥2 GPUs are
			// checked — a single GPU can never be a multi-GPU spawn.
			this.menuRow("Multi-GPUs", multi),
		);
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
