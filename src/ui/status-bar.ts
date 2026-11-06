/**
 * Status bar pill — compact always-on summary fed by the light poll cycle:
 * "G0 9.2G · G1 4.1G · q1 · ⏳train 123/500". Click opens the dashboard view.
 * The pill root is built once; per-port spans are added/updated in place.
 */
import { el, fmtBytes, fmtClockTime } from "../util";

/** One ComfyUI port as seen by the light cycle. */
export interface StatusBarGpu {
	port: number;
	/** GPU index reported by the arthur-agent, when reachable. */
	gpuIndex: number | null;
	/** system_stats succeeded? null = no data yet. */
	online: boolean | null;
	freeBytes: number | null;
}

export interface StatusBarState {
	profileName: string;
	host: string;
	gpus: StatusBarGpu[];
	/** Summed running+pending prompts across all comfy ports. */
	queueDepth: number;
	/** Most advanced RUNNING training job, or null when nothing is training. */
	train: { step: number; total: number | null } | null;
	lastUpdated: number | null;
}

export class StatusBarPill {
	readonly el: HTMLElement;

	private readonly gpuEls = new Map<number, HTMLElement>();
	private readonly queueEl: HTMLElement;
	private readonly trainEl: HTMLElement;
	private readonly openDashboard: () => void;

	constructor(parent: HTMLElement, openDashboard: () => void) {
		this.openDashboard = openDashboard;
		this.el = parent.createEl("div", { cls: "arthur-status-pill" });
		this.el.addClass("clickable-icon");
		this.el.setAttribute("aria-label", "Open arthur dashboard");
		this.el.addEventListener("click", () => this.openDashboard());
		this.queueEl = el("span", { cls: "arthur-status-part" });
		this.trainEl = el("span", { cls: "arthur-status-part" });
		this.el.append(this.queueEl, this.trainEl);
		this.queueEl.hide();
		this.trainEl.hide();
	}

	/**
	 * Re-render from fresh poll data. The per-port spans are the only children
	 * that may be (re)created, and only when the configured port set changes.
	 */
	update(state: StatusBarState): void {
		// Per-port VRAM segments.
		const wantPorts = state.gpus.map((g) => g.port);
		if (
			wantPorts.length !== this.gpuEls.size ||
			wantPorts.some((port) => !this.gpuEls.has(port))
		) {
			for (const span of this.gpuEls.values()) span.remove();
			this.gpuEls.clear();
			for (const g of state.gpus) {
				const span = el("span", { cls: "arthur-status-part" });
				this.el.insertBefore(span, this.queueEl);
				this.gpuEls.set(g.port, span);
			}
		}
		for (const g of state.gpus) {
			const span = this.gpuEls.get(g.port);
			if (!span) continue;
			const label = g.gpuIndex != null ? `G${g.gpuIndex}` : `P${g.port}`;
			if (g.online === false) {
				span.textContent = `${label} —`;
				span.addClass("arthur-status-offline");
			} else {
				span.textContent = `${label} ${g.online === null ? "?" : fmtBytes(g.freeBytes)}`;
				span.removeClass("arthur-status-offline");
			}
		}

		// Total comfy queue depth (shown only when work is queued).
		if (state.queueDepth > 0) {
			this.queueEl.textContent = `q${state.queueDepth}`;
			this.queueEl.show();
		} else {
			this.queueEl.hide();
		}

		// Most advanced running training job.
		if (state.train) {
			this.trainEl.textContent = `⏳train ${state.train.step}/${state.train.total ?? "?"}`;
			this.trainEl.show();
		} else {
			this.trainEl.hide();
		}

		this.el.setAttribute(
			"aria-label",
			`arthur ${state.profileName} @ ${state.host}` +
				(state.lastUpdated ? ` · updated ${fmtClockTime(state.lastUpdated)}` : "") +
				// All configured instances dead? Point at the dashboard diagnostics.
				(state.gpus.length > 0 && state.gpus.every((g) => g.online === false)
					? " · no response — open dashboard for last errors"
					: ""),
		);
	}
}
