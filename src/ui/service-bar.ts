/**
 * Service bar — the dashboard's top row of service buttons, one per service
 * from the agent's /api/status (in agent order). State → interaction map:
 *
 *   agent unreachable  → configured services rendered as disabled grey
 *                        buttons, tooltip "agent unreachable (<error>)"
 *   service inactive   → grey (desaturated) button
 *                        click → start the default instance → toast + re-poll
 *   service active     → accent-colored button
 *                        click → spawn a new instance (success: "Spawned
 *                        <name> instance on port X"; 409 single-instance /
 *                        max reached: toast the agent's error, no crash)
 *                        right ~8% red kill zone → confirm "Stop all <name>
 *                        instances?" → stop ALL instances; 409 busy → second
 *                        modal offering force → stop(force=true)
 *
 * Buttons are cached DOM nodes keyed by service id: state changes only toggle
 * classes/text/attributes — never a full rebuild.
 */
import { setIcon } from "obsidian";

import type { AgentService } from "../api/agent";
import { injectIcon } from "../icons";
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

/** Service-level actions owned by the wiring layer (dashboard view). */
export interface ServiceBarCallbacks {
	/** Inactive service clicked → start the default instance. */
	onStart(svc: AgentService): void;
	/** Active service clicked → spawn a new instance. */
	onSpawn(svc: AgentService): void;
	/** Kill zone clicked → confirm → stop ALL instances (force path inside). */
	onKill(svc: AgentService): void;
}

/** One cached service button (main pill + its red kill zone). */
export interface ServiceButton {
	svc: AgentService;
	/** Latest rendered service-level state. */
	active: boolean;
	disabled: boolean;
	btn: HTMLButtonElement;
	icon: HTMLElement;
	name: HTMLElement;
	kill: HTMLElement;
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
				entry.btn.remove();
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
					this.el.append(entry.btn); // re-append moves the node
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
			// Kill zone exists only on active buttons.
			entry.kill.style.display = active ? "" : "none";
			entry.kill.setAttribute("aria-label", `Stop all ${svc.name ?? svc.id} instances`);
			entry.kill.setAttribute("title", `Stop all ${svc.name ?? svc.id} instances`);
		}
	}

	private createButton(svc: AgentService): void {
		const icon = document.createElement("span");
		icon.className = "arthur-svc-icon";
		const name = document.createElement("span");
		name.className = "arthur-svc-name";
		const kill = document.createElement("span");
		kill.className = "arthur-svc-kill";
		kill.setAttribute("role", "button");
		setIcon(kill, "trash-2");

		const btn = document.createElement("button");
		btn.className = "arthur-svc-btn";
		btn.append(icon, name, kill);

		const entry: ServiceButton = {
			svc,
			active: false,
			disabled: true,
			btn,
			icon,
			name,
			kill,
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
		this.buttons.set(svc.id, entry);
		this.order.push(svc.id);
		this.el.append(btn);
	}

	/** Inject the service's official inline-SVG mark (cached per id). */
	private applyIcon(entry: ServiceButton): void {
		if (this.icons.get(entry.svc.id) === entry.svc.id) return;
		this.icons.set(entry.svc.id, entry.svc.id);
		injectIcon(entry.icon, entry.svc.id);
	}
}
