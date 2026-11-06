/**
 * Status bar pill — compact always-on summary fed by the light poll cycle:
 * "G0 9.2/12G 36° · G1 4.1/12G 41° · q1 · ⏳train 123/500" (per-GPU VRAM from
 * /api/gpus when the agent answers, per-port free bytes otherwise). Click
 * opens the dashboard view. The pill root is built once; segment spans are
 * added/updated in place.
 */
import { el, fmtBytes, fmtClockTime, fmtGigCompact } from "../util";

/** One ComfyUI port as seen by the light cycle. */
export interface StatusBarGpu {
	port: number;
	/** GPU index reported by the arthur-agent, when reachable. */
	gpuIndex: number | null;
	/** system_stats succeeded? null = no data yet. */
	online: boolean | null;
	freeBytes: number | null;
}

/** One GPU from /api/gpus (agent v0.5.2) — per-GPU VRAM + temp. */
export interface StatusBarGpuStats {
	index: number;
	usedMb: number | null;
	totalMb: number | null;
	tempC: number | null;
	utilPercent: number | null;
}

export interface StatusBarState {
	profileName: string;
	host: string;
	gpus: StatusBarGpu[];
	/** Live per-GPU stats from /api/gpus when available — replaces the
	 *  per-port free-bytes segments and gains used/total + temperature. */
	gpuStats: StatusBarGpuStats[];
	/** Summed running+pending prompts across all comfy ports. */
	queueDepth: number;
	/** Most advanced RUNNING training job, or null when nothing is training. */
	train: { step: number; total: number | null } | null;
	lastUpdated: number | null;
}

export class StatusBarPill {
	readonly el: HTMLElement;

	private readonly gpuEls = new Map<string, HTMLElement>();
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
	 * Re-render from fresh poll data. Per-GPU segments (from /api/gpus) win
	 * when present; otherwise the per-port system_stats fallback renders.
	 * Segment spans are the only children that may be (re)created, and only
	 * when the segment key set changes.
	 */
	update(state: StatusBarState): void {
		interface Segment {
			key: string;
			text: string;
			offline: boolean;
			tooltip?: string;
		}
		const segments: Segment[] =
			(state.gpuStats?.length ?? 0) > 0
				? state.gpuStats.map((g) => {
						const used = fmtGigCompact(g.usedMb);
						const total = fmtGigCompact(g.totalMb);
						return {
							key: `g${g.index}`,
							text:
								`G${g.index} ${used}/${total}` +
								(g.tempC != null ? ` ${Math.round(g.tempC)}\u00b0` : ""),
							offline: used === "?",
							tooltip:
								g.utilPercent != null
									? `GPU ${g.index} — util ${g.utilPercent}%`
									: undefined,
						};
				})
				: state.gpus.map((g) => ({
						key: `p${g.port}`,
						text:
							g.gpuIndex != null
								? `G${g.gpuIndex} ${g.online === null ? "?" : g.online === false ? "—" : fmtBytes(g.freeBytes)}`
								: `P${g.port} ${g.online === null ? "?" : g.online === false ? "—" : fmtBytes(g.freeBytes)}`,
						offline: g.online === false,
					}));
		const wantKeys = segments.map((s) => s.key);
		if (
			wantKeys.length !== this.gpuEls.size ||
			wantKeys.some((key) => !this.gpuEls.has(key))
		) {
			for (const span of this.gpuEls.values()) span.remove();
			this.gpuEls.clear();
			for (const s of segments) {
				const span = el("span", { cls: "arthur-status-part" });
				this.el.insertBefore(span, this.queueEl);
				this.gpuEls.set(s.key, span);
			}
		}
		for (const s of segments) {
			const span = this.gpuEls.get(s.key);
			if (!span) continue;
			span.textContent = s.text;
			if (s.tooltip) span.setAttribute("title", s.tooltip);
			if (s.offline) span.addClass("arthur-status-offline");
			else span.removeClass("arthur-status-offline");
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
