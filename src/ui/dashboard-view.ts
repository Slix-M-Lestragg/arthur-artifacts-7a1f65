/**
 * Arthur dashboard — desktop ItemView with three stacked sections:
 *   1. INSTANCES   — per ComfyUI port: agent-reported up/uptime, HTTP
 *                    liveness, VRAM bar, lifecycle buttons (via arthur-agent)
 *   2. GENERATION  — per ComfyUI port: queue depth, running prompt info,
 *                    live WS progress bar, job control buttons
 *   3. TRAINING    — ai-toolkit job table + per-GPU-set queue toggles
 *
 * The DOM skeleton (top bar, section boxes, cards, table header) is built
 * once in onOpen; poll ticks and WS events only update text, classes,
 * attributes and bar widths. The training <tbody> and the pending-prompt
 * list are refilled per tick because their rows legitimately appear and
 * disappear — everything else is cached.
 *
 * The view never mutates state optimistically: everything rendered comes
 * from the last poll fetch or the last WS event.
 *
 * WS lifecycle decision (per PLAN 2.1): one WsConnection per comfy port is
 * opened when the dashboard opens (not at plugin load — idle reconnect loops
 * would otherwise hammer an offline server forever) and closed when the
 * dashboard closes. Plugin unload detaches the dashboard leaf first, which
 * triggers onClose → close; a register() callback also closes the sockets in
 * case component teardown skips onClose. On WS (re)open the view re-polls to
 * resync queue/progress state.
 */
import { ItemView, WorkspaceLeaf } from "obsidian";

import type ArthurPlugin from "../main";
import { AGENT_VERSION } from "../api/agent";
import type { AgentInstanceSummary, AgentStatus } from "../api/agent";
import type { AiToolkitJob } from "../api/aitoolkit";
import type { ComfyUIClient, QueueResponse, SystemStats } from "../api/comfy";
import { WsConnection, WsState } from "../connection";
import { el, fmtBytes, fmtClockTime, fmtDuration, truncate } from "../util";
import { confirmModal, describeError, run, toastErr } from "./actions";

export const VIEW_TYPE_ARTHUR_DASHBOARD = "arthur-dashboard";

interface ComfyPortDetail {
	/** system_stats succeeded? null = no data yet. */
	online: boolean | null;
	stats: SystemStats | null;
	queue: QueueResponse | null;
	error: string | null;
}

interface AgentDetail {
	/** /health succeeded (process reachable, no auth involved). */
	healthOk: boolean | null;
	/** /api/status succeeded (token accepted) — gates lifecycle buttons. */
	statusOk: boolean | null;
	status: AgentStatus | null;
	error: string | null;
}

interface AiToolkitDetail {
	reachable: boolean | null;
	jobs: AiToolkitJob[];
	/** Flattened per-GPU-set queue rows. */
	queues: Array<{ id: string | number; gpu_ids: string; is_running: boolean }>;
	error: string | null;
}

/** Latest WS-driven progress tick for one comfy port. */
interface GenProgress {
	value: number;
	max: number;
	nodeLabel: string;
}

/** Cached DOM widgets + bookkeeping for one comfy port. */
interface ComfyPanel {
	port: number;
	// instance card
	instDot: HTMLElement;
	instName: HTMLElement;
	instMeta: HTMLElement;
	vramFill: HTMLElement;
	vramLabel: HTMLElement;
	btnStart: HTMLButtonElement;
	btnStop: HTMLButtonElement;
	btnRestart: HTMLButtonElement;
	// generation card
	genDot: HTMLElement;
	wsDot: HTMLElement;
	wsLabel: HTMLElement;
	queueEl: HTMLElement;
	runningEl: HTMLElement;
	progressFill: HTMLElement;
	progressLabel: HTMLElement;
	btnCancel: HTMLButtonElement;
	btnFree: HTMLButtonElement;
	btnClear: HTMLButtonElement;
	pendingWrap: HTMLElement;
	// bookkeeping
	progress: GenProgress | null;
	/** node id → node definition of the running prompt (from /queue). */
	promptGraph: Record<string, any> | null;
	runningPromptId: string | null;
	pendingIds: string[];
}

/** Per-GPU-set queue row as consumed by the training queue list. */
interface AiToolkitQueueRow {
	id: string | number;
	gpu_ids: string;
	is_running: boolean;
}

/** Never-throw wrapper for best-effort probes. */
async function safeCall<T>(fn: () => Promise<T>): Promise<T | null> {
	try {
		return await fn();
	} catch {
		return null;
	}
}

function newBtn(text: string): HTMLButtonElement {
	const btn = document.createElement("button");
	btn.textContent = text;
	btn.addClass("arthur-btn");
	return btn;
}

/** Dot color by tri-state: true green · false red · null gray. */
function setDot(dot: HTMLElement, online: boolean | null): void {
	dot.removeClass("arthur-dot--green", "arthur-dot--red", "arthur-dot--gray");
	dot.addClass(
		online === true
			? "arthur-dot--green"
			: online === false
				? "arthur-dot--red"
				: "arthur-dot--gray",
	);
}

export class ArthurDashboardView extends ItemView {
	private open = false;
	private readonly panels = new Map<number, ComfyPanel>();
	private readonly wss = new Map<number, WsConnection>();
	private readonly comfyByPort = new Map<number, ComfyUIClient>();

	// cached section roots
	private profileEl!: HTMLElement;
	private readonly topDots = new Map<string, HTMLElement>();
	private updatedEl!: HTMLElement;
	private bannerEl!: HTMLElement;
	private trainingBodyEl!: HTMLElement;
	private trainingQueueEl!: HTMLElement;
	private trainingNoteEl!: HTMLElement;

	// latest poll data (single source of truth for rendering)
	private comfyDetail: ComfyPortDetail[] = [];
	private agentDetail: AgentDetail = {
		healthOk: null,
		statusOk: null,
		status: null,
		error: null,
	};
	private aiDetail: AiToolkitDetail = {
		reachable: null,
		jobs: [],
		queues: [],
		error: null,
	};
	private lastTick: number | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: ArthurPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_ARTHUR_DASHBOARD;
	}

	getDisplayText(): string {
		return "Arthur dashboard";
	}

	getIcon(): string {
		return "monitor-cog";
	}

	/** Poll gate: no detail fetches while the view is closed or hidden. */
	private visible(): boolean {
		return this.open && this.contentEl.isShown();
	}

	private comfyPorts(): number[] {
		return this.plugin.comfyPorts;
	}

	/** Both pollers, handed to run() so mutations trigger an immediate re-poll. */
	private pollers(): Array<{ pollNow(): void }> {
		const clients = this.plugin.clients;
		return clients ? [clients.lightPoller, clients.detailPoller] : [];
	}

	private agentInstanceFor(port: number): AgentInstanceSummary | null {
		const list = this.agentDetail.status?.instances ?? [];
		return list.find((i) => i.port === port) ?? null;
	}

	// ------------------------------------------------------------------
	// lifecycle
	// ------------------------------------------------------------------

	async onOpen(): Promise<void> {
		this.open = true;
		this.contentEl.empty();
		this.panels.clear();
		this.comfyByPort.clear();
		this.buildSkeleton();
		this.openWss();
		this.plugin.dashboardView = this;
		// Belt-and-braces: if teardown ever skips onClose, sockets still close.
		this.register(() => this.closeWss());
	}

	async onClose(): Promise<void> {
		this.open = false;
		this.closeWss();
		if (this.plugin.dashboardView === this) this.plugin.dashboardView = null;
		this.contentEl.empty();
	}

	/** Detail poller entry point — fetch everything, then paint. */
	async refreshData(): Promise<void> {
		const clients = this.plugin.clients;
		if (!this.visible() || !clients) return;
		const profile = clients.profile;

		// Inner promises never reject; per-port failures land in .error.
		this.comfyDetail = await Promise.all(
			clients.comfy.map(async (client): Promise<ComfyPortDetail> => {
				try {
					const stats = await client.systemStats();
					const queue = await client.queue();
					return { online: true, stats, queue, error: null };
				} catch (err) {
					return {
						online: false,
						stats: null,
						queue: null,
						error: describeError(err),
					};
				}
			}),
		);

		const healthOk = (await safeCall(() => clients.agent.health())) !== null;
		let status: AgentStatus | null = null;
		if (healthOk) status = await safeCall(() => clients.agent.status());
		this.agentDetail = {
			healthOk,
			statusOk: status !== null,
			status,
			error: healthOk ? (status ? null : "token rejected") : "unreachable",
		};

		try {
			const [jobs, queue] = await Promise.all([
				clients.aitoolkit.jobs(),
				clients.aitoolkit.queueList(),
			]);
			this.aiDetail = {
				reachable: true,
				jobs: jobs.jobs ?? [],
				queues: (queue.queues ?? []).map(
					(q): AiToolkitQueueRow => ({
						id: q.id,
						gpu_ids: q.gpu_ids,
						is_running: q.is_running,
					}),
				),
				error: null,
			};
		} catch (err) {
			this.aiDetail = {
				reachable: false,
				jobs: [],
				queues: [],
				error: describeError(err),
			};
		}

		this.lastTick = Date.now();
		this.renderTopBar(profile.name, profile.host);
		this.renderBanner();
		this.renderInstances();
		this.renderGeneration();
		this.renderTraining();
	}

	// ------------------------------------------------------------------
	// skeleton
	// ------------------------------------------------------------------

	private buildSkeleton(): void {
		const root = this.contentEl.createEl("div", { cls: "arthur-dashboard" });

		// thin top summary bar
		const top = root.createEl("div", { cls: "arthur-topbar" });
		this.profileEl = top.createEl("span", { cls: "arthur-topbar-profile" });
		const dotsBox = top.createEl("span", { cls: "arthur-topbar-dots" });
		const dotSpecs: Array<[string, string]> = [
			...this.comfyPorts().map((p) => [`c${p}`, `ComfyUI :${p}`] as [string, string]),
			["aitk", "ai-toolkit"],
			["agent", "arthur-agent"],
		];
		for (const [key, label] of dotSpecs) {
			const dot = el("span", {
				cls: "arthur-dot arthur-dot--gray",
				attrs: { "aria-label": label },
			});
			dotsBox.append(
				el("span", {
					cls: "arthur-dot-wrap",
					children: [dot, el("span", { cls: "arthur-dot-label", text: label })],
				}),
			);
			this.topDots.set(key, dot);
		}
		this.updatedEl = top.createEl("span", { cls: "arthur-topbar-updated" });

		// banner slot (agent unreachable / token / version mismatch)
		this.bannerEl = root.createEl("div", { cls: "arthur-banner" });
		this.bannerEl.hide();

		// instances + generation sections (one cached card pair per port)
		const instancesSection = root.createEl("div", { cls: "arthur-section" });
		instancesSection.createEl("h4", { text: "Instances" });
		const instancesBox = instancesSection.createEl("div", { cls: "arthur-cards" });
		const genSection = root.createEl("div", { cls: "arthur-section" });
		genSection.createEl("h4", { text: "Generation" });
		const generationBox = genSection.createEl("div", { cls: "arthur-cards" });
		for (const port of this.comfyPorts()) {
			const [instCard, genCard] = this.buildPortCards(port);
			instancesBox.append(instCard);
			generationBox.append(genCard);
		}

		// training section
		const trainingSection = root.createEl("div", { cls: "arthur-section" });
		trainingSection.createEl("h4", { text: "Training (ai-toolkit)" });
		this.trainingNoteEl = trainingSection.createEl("p", {
			cls: "arthur-note",
			text: "loading…",
		});
		const table = trainingSection.createEl("table", { cls: "arthur-table" });
		const head = table.createEl("thead").createEl("tr");
		head.append(
			...["Name", "GPUs", "Status", "Progress", "Speed", "Queue", "Actions"].map((h) =>
				el("th", { text: h }),
			),
		);
		this.trainingBodyEl = table.createEl("tbody");
		trainingSection.createEl("h5", { text: "Queues" });
		this.trainingQueueEl = trainingSection.createEl("div", { cls: "arthur-queue-rows" });
	}

	/** Build the instance card + generation card for one port and cache them. */
	private buildPortCards(port: number): [HTMLElement, HTMLElement] {
		const buttonRow = (...btns: HTMLButtonElement[]) =>
			el("div", { cls: "arthur-btn-row", children: btns });

		// ---- instance card ------------------------------------------------
		const instDot = el("span", { cls: "arthur-dot arthur-dot--gray" });
		const instName = el("span", { cls: "arthur-card-title", text: `ComfyUI :${port}` });
		const instMeta = el("span", { cls: "arthur-card-meta", text: "agent: n/a" });
		const vramFill = el("div", { cls: "arthur-bar-fill" });
		vramFill.style.width = "0%";
		const vramLabel = el("span", { cls: "arthur-card-meta", text: "VRAM ?" });

		const btnStart = newBtn("Start");
		const btnStop = newBtn("Stop");
		const btnRestart = newBtn("Restart");
		btnStart.addEventListener("click", () => void this.startInstance(port));
		btnStop.addEventListener("click", () => {
			confirmModal(
				this.app,
				"Stop instance",
				`Gracefully stop ComfyUI on port ${port}? The agent refuses while a generation is running.`,
				() => void this.stopInstance(port),
			);
		});
		btnRestart.addEventListener("click", () => {
			confirmModal(
				this.app,
				"Restart instance",
				`Restart ComfyUI on port ${port}? It is down until the port comes back up (~30s).`,
				() => void this.restartInstance(port),
			);
		});

		const instanceCard = el("div", { cls: "arthur-card" });
		instanceCard.append(
			el("div", {
				cls: "arthur-card-head",
				children: [instDot, instName, instMeta],
			}),
			el("div", { cls: "arthur-bar", children: [vramFill] }),
			vramLabel,
			buttonRow(btnStart, btnStop, btnRestart),
		);

		// ---- generation card ----------------------------------------------
		const genDot = el("span", { cls: "arthur-dot arthur-dot--gray" });
		const wsDot = el("span", { cls: "arthur-dot arthur-dot--gray" });
		const wsLabel = el("span", { cls: "arthur-card-meta", text: "ws off" });
		const queueEl = el("span", { cls: "arthur-card-meta", text: "…" });
		const progressFill = el("div", { cls: "arthur-bar-fill" });
		progressFill.style.width = "0%";
		const progressLabel = el("span", { cls: "arthur-card-meta", text: "idle" });
		const runningEl = el("span", { cls: "arthur-card-meta" });
		runningEl.hide();
		const pendingWrap = el("div", { cls: "arthur-pending-list" });
		pendingWrap.hide();
		const btnCancel = newBtn("Cancel");
		const btnClear = newBtn("Clear queue");
		const btnFree = newBtn("Free VRAM");

		btnCancel.addEventListener("click", () => void this.cancelRunning(port));
		btnClear.addEventListener("click", () => {
			const n = this.panels.get(port)?.pendingIds.length ?? 0;
			confirmModal(
				this.app,
				"Clear queue",
				`Delete all ${n} pending prompt${n === 1 ? "" : "s"} on port ${port}?`,
				() => void this.clearQueue(port),
			);
		});
		btnFree.addEventListener("click", () => {
			confirmModal(
				this.app,
				"Free VRAM",
				`Unload models and free memory on port ${port}? Models reload on the next generation.`,
				() => void this.freeVram(port),
			);
		});

		const genCard = el("div", { cls: "arthur-card" });
		genCard.append(
			el("div", {
				cls: "arthur-card-head",
				children: [
					genDot,
					el("span", { cls: "arthur-card-title", text: `ComfyUI :${port}` }),
					wsDot,
					wsLabel,
					queueEl,
				],
			}),
			el("div", { cls: "arthur-bar", children: [progressFill] }),
			progressLabel,
			runningEl,
			pendingWrap,
			buttonRow(btnCancel, btnClear, btnFree),
		);

		this.panels.set(port, {
			port,
			instDot,
			instName,
			instMeta,
			vramFill,
			vramLabel,
			btnStart,
			btnStop,
			btnRestart,
			genDot,
			wsDot,
			wsLabel,
			queueEl,
			runningEl,
			progressFill,
			progressLabel,
			btnCancel,
			btnFree,
			btnClear,
			pendingWrap,
			progress: null,
			promptGraph: null,
			runningPromptId: null,
			pendingIds: [],
		});
		return [instanceCard, genCard];
	}

	// ------------------------------------------------------------------
	// rendering
	// ------------------------------------------------------------------

	private renderTopBar(profileName: string, host: string): void {
		this.profileEl.setText(`${profileName} @ ${host}`);
		this.comfyPorts().forEach((port, i) => {
			const dot = this.topDots.get(`c${port}`);
			if (dot) setDot(dot, this.comfyDetail[i]?.online ?? null);
		});
		const aitk = this.topDots.get("aitk");
		if (aitk) setDot(aitk, this.aiDetail.reachable);
		const agent = this.topDots.get("agent");
		if (agent) setDot(agent, this.agentDetail.statusOk ?? this.agentDetail.healthOk);
		this.updatedEl.setText(`upd ${fmtClockTime(this.lastTick)}`);
	}

	private renderBanner(): void {
		const ad = this.agentDetail;
		let message: string | null = null;
		if (ad.healthOk === false) {
			message = "agent unreachable — instance lifecycle disabled";
		} else if (ad.healthOk === true && ad.statusOk === false) {
			message = "agent token rejected — check Agent token in settings";
		} else if (ad.status && ad.status.version !== AGENT_VERSION) {
			message = `agent version mismatch: server ${ad.status.version}, expected ${AGENT_VERSION} — update server/`;
		}
		if (message) {
			this.bannerEl.setText(message);
			this.bannerEl.show();
		} else {
			this.bannerEl.hide();
		}
	}

	/** Lifecycle buttons: enabled only when /api/status answered (health AND token). */
	private setLifecycleGating(panel: ComfyPanel): void {
		const ad = this.agentDetail;
		const enabled = ad.statusOk === true;
		for (const btn of [panel.btnStart, panel.btnStop, panel.btnRestart]) {
			btn.disabled = !enabled;
			btn.setAttribute(
				"aria-label",
				enabled ? "" : `agent ${ad.healthOk === false ? "unreachable" : "token rejected"} — lifecycle disabled`,
			);
		}
	}

	private renderInstances(): void {
		this.comfyPorts().forEach((port, i) => {
			const panel = this.panels.get(port);
			if (!panel) return;
			const detail = this.comfyDetail[i] ?? null;
			const inst = this.agentInstanceFor(port);

			setDot(panel.instDot, detail?.online ?? null);

			if (inst) {
				panel.instName.setText(inst.name ?? inst.id);
				const agentText = inst.up
					? `up · uptime ${fmtDuration(inst.uptime ?? undefined)}`
					: "down";
				panel.instMeta.setText(
					`GPU ${inst.gpu ?? "?"} · agent: ${agentText}` +
						(detail?.online === false ? " · HTTP not responding" : ""),
				);
			} else {
				panel.instName.setText(`ComfyUI :${port}`);
				panel.instMeta.setText(
					this.agentDetail.statusOk === true
						? "agent: no registry entry for this port"
						: this.agentDetail.healthOk === false
							? "agent unreachable"
							: detail?.online === false
								? "not responding"
								: "waiting for data…",
				);
			}

			// VRAM bar — devices[0] (instances are single-GPU).
			const device = detail?.stats?.devices?.[0];
			if (device && device.vram_total > 0) {
				const used = Math.max(0, device.vram_total - device.vram_free);
				panel.vramFill.style.width = `${Math.round((100 * used) / device.vram_total)}%`;
				panel.vramLabel.setText(`VRAM ${fmtBytes(used)} / ${fmtBytes(device.vram_total)}`);
			} else {
				panel.vramFill.style.width = "0%";
				panel.vramLabel.setText(
					detail?.online === false ? "VRAM n/a — not responding" : "VRAM ?",
				);
			}

			this.setLifecycleGating(panel);
		});
	}

	private renderGeneration(): void {
		this.comfyPorts().forEach((port, i) => {
			const panel = this.panels.get(port);
			if (!panel) return;
			const detail = this.comfyDetail[i] ?? null;
			const online = detail?.online === true;
			const running = Array.isArray(detail?.queue?.queue_running)
				? (detail!.queue!.queue_running as unknown[])
				: [];
			const pending = Array.isArray(detail?.queue?.queue_pending)
				? (detail!.queue!.queue_pending as unknown[])
				: [];

			setDot(panel.genDot, detail?.online ?? null);
			panel.queueEl.setText(`${running.length} running · ${pending.length} pending`);

			// running prompt info: queue entries are [exec, prompt_id, graph, extra, …]
			const entry = (running[0] ?? null) as unknown[];
			const pid = entry && typeof entry[1] === "string" ? entry[1] : null;
			panel.runningPromptId = pid;
			panel.promptGraph =
				entry && entry[2] && typeof entry[2] === "object"
					? (entry[2] as Record<string, any>)
					: null;
			const classes = Object.values(panel.promptGraph ?? {})
				.map((n) => (n as any)?.class_type)
				.filter((s) => typeof s === "string") as string[];
			const runningText = pid
				? `${truncate(pid, 12)} · ${classes.slice(0, 4).join(" → ")}${classes.length > 4 ? " → …" : ""}`
				: running.length > 0
					? "running (prompt id unknown)"
					: "";
			if (runningText) {
				panel.runningEl.setText(runningText);
				panel.runningEl.show();
			} else {
				panel.runningEl.hide();
			}

			// pending list (refilled — rows come and go)
			panel.pendingIds = pending.flatMap((e) =>
				Array.isArray(e) && typeof e[1] === "string" ? [e[1] as string] : [],
			);
			panel.pendingWrap.empty();
			if (panel.pendingIds.length > 0) {
				for (const id of panel.pendingIds) {
					const del = newBtn("✕");
					del.addClass("arthur-btn--tiny");
					del.addEventListener("click", () => void this.deletePending(port, id));
					panel.pendingWrap.append(
						el("div", {
							cls: "arthur-pending-row",
							children: [
								el("span", { cls: "arthur-card-meta", text: truncate(id, 14) }),
								del,
							],
						}),
					);
				}
				panel.pendingWrap.show();
			} else {
				panel.pendingWrap.hide();
			}

			panel.btnCancel.disabled = !online || running.length === 0;
			panel.btnClear.disabled = !online || pending.length === 0;
			panel.btnFree.disabled = !online;

			this.renderProgress(panel);
		});
	}

	private renderProgress(panel: ComfyPanel): void {
		const p = panel.progress;
		if (p && p.max > 0) {
			panel.progressFill.style.width = `${Math.min(100, Math.round((100 * p.value) / p.max))}%`;
			panel.progressLabel.setText(`${p.nodeLabel} ${p.value}/${p.max}`);
		} else {
			panel.progressFill.style.width = "0%";
			panel.progressLabel.setText("idle");
		}
	}

	private renderTraining(): void {
		const detail = this.aiDetail;
		if (detail.reachable !== true) {
			this.trainingNoteEl.setText(
				`ai-toolkit not responding — ${detail.error ?? "no data"}` +
					(detail.error?.includes("401") === true ? " · check ai-toolkit token in settings" : ""),
			);
			this.trainingNoteEl.show();
			this.trainingBodyEl.empty();
			this.trainingQueueEl.empty();
			return;
		}
		this.trainingNoteEl.hide();
		this.trainingBodyEl.empty();
		this.trainingBodyEl.append(...detail.jobs.map((job) => this.jobRow(job)));
		this.trainingQueueEl.empty();
		if (detail.queues.length === 0) {
			this.trainingQueueEl.append(
				el("span", { cls: "arthur-card-meta", text: "no queues" }),
			);
			return;
		}
		for (const q of detail.queues) this.trainingQueueEl.append(this.queueRow(q));
	}

	private jobRow(job: AiToolkitJob): HTMLElement {
		const clients = this.plugin.clients!;
		const pollers = this.pollers();
		const name = truncate(job.name, 28);
		const label = (action: string) => `${action} ${name}`;

		const btn = (
			text: string,
			onClick: () => void,
			disabled: boolean,
		): HTMLButtonElement => {
			const b = newBtn(text);
			b.addClass("arthur-btn--tiny");
			b.disabled = disabled;
			b.addEventListener("click", onClick);
			return b;
		};
		const confirmRun = (
			action: string,
			message: string,
			call: () => Promise<unknown>,
		) =>
			confirmModal(this.app, action, message, () =>
				void run(pollers, label(action.toLowerCase()), call),
			);

		const running = job.status === "running";
		const actions = el("td", { cls: "arthur-actions" });
		actions.append(
			btn("Start", () => void run(pollers, label("Start"), () => clients.aitoolkit.jobStart(job.id)), running || job.status === "stopping"),
			btn("Stop", () => void run(pollers, label("Stop (graceful)"), () => clients.aitoolkit.jobStop(job.id)), !running && job.status !== "stopping"),
			btn("Kill", () => confirmRun("Kill job", `Force-kill "${job.name}" (SIGKILL)? The trainer gets no chance to save or clean up.`, () => clients.aitoolkit.jobKill(job.id)), job.pid == null),
			btn("Delete", () => confirmRun("Delete job", `Delete training job "${job.name}"? Results already written stay on disk.`, () => clients.aitoolkit.jobDelete(job.id)), false),
			btn("Mark stopped", () => void run(pollers, label("Mark stopped"), () => clients.aitoolkit.jobMarkStopped(job.id)), job.status !== "error"),
			btn("Save now", () => void run(pollers, label("Save now"), () => clients.aitoolkit.jobSaveNow(job.id)), !running || job.save_now),
			btn("Sample now", () => void run(pollers, label("Sample now"), () => clients.aitoolkit.jobSampleNow(job.id)), !running || job.sample_now),
		);

		return el("tr", {
			cls: `arthur-job--${job.status}`,
			children: [
				el("td", { text: name, attrs: { title: job.name } }),
				el("td", { text: job.gpu_ids || "?" }),
				el("td", { text: job.status }),
				el("td", {
					text: job.total_steps != null && job.total_steps > 0
						? `${Math.round((100 * job.step) / job.total_steps)}% (${job.step}/${job.total_steps})`
						: `${job.step}/?`,
				}),
				el("td", { text: job.speed_string || "—" }),
				el("td", { text: job.queue_position != null ? String(job.queue_position) : "—" }),
				actions,
			],
		});
	}

	private queueRow(q: AiToolkitQueueRow): HTMLElement {
		const clients = this.plugin.clients!;
		const pollers = this.pollers();
		const dot = el("span", { cls: "arthur-dot" });
		setDot(dot, q.is_running);
		const toggle = newBtn(q.is_running ? "Stop queue" : "Start queue");
		toggle.addClass("arthur-btn--tiny");
		toggle.addEventListener("click", () =>
			void run(
				pollers,
				`${q.is_running ? "stop" : "start"} queue ${q.gpu_ids}`,
				() =>
					q.is_running
						? clients.aitoolkit.queueStop(q.id)
						: clients.aitoolkit.queueStart(q.id),
			),
		);
		return el("div", {
			cls: "arthur-queue-row",
			children: [
				dot,
				el("span", { text: `GPUs ${q.gpu_ids}` }),
				el("span", {
					cls: "arthur-card-meta",
					text: q.is_running ? "running" : "paused",
				}),
				toggle,
			],
		});
	}

	// ------------------------------------------------------------------
	// controls — all funnel through run(): toast on result + pollNow()
	// ------------------------------------------------------------------

	private async startInstance(port: number): Promise<void> {
		const id = this.agentInstanceFor(port)?.id;
		if (!id) {
			toastErr(`no agent instance registered for port ${port}`);
			return;
		}
		await run(this.pollers(), `start ${id}`, () =>
			this.plugin.clients!.agent.start(id),
		);
	}

	private async stopInstance(port: number): Promise<void> {
		const id = this.agentInstanceFor(port)?.id;
		if (!id) {
			toastErr(`no agent instance registered for port ${port}`);
			return;
		}
		await run(this.pollers(), `stop ${id}`, () =>
			this.plugin.clients!.agent.stop(id),
		);
	}

	private async restartInstance(port: number): Promise<void> {
		const id = this.agentInstanceFor(port)?.id;
		if (!id) {
			toastErr(`no agent instance registered for port ${port}`);
			return;
		}
		await run(this.pollers(), `restart ${id}`, () =>
			this.plugin.clients!.agent.restart(id),
		);
	}

	private async cancelRunning(port: number): Promise<void> {
		const client = this.comfyByPort.get(port);
		if (!client) return;
		const pid = this.panels.get(port)?.runningPromptId ?? undefined;
		await run(this.pollers(), `cancel :${port}`, () => client.interrupt(pid));
	}

	private async deletePending(port: number, id: string): Promise<void> {
		const client = this.comfyByPort.get(port);
		if (!client) return;
		await run(this.pollers(), `delete queued prompt :${port}`, () =>
			client.deleteQueueItems([id]),
		);
	}

	private async clearQueue(port: number): Promise<void> {
		const client = this.comfyByPort.get(port);
		if (!client) return;
		await run(this.pollers(), `clear queue :${port}`, () => client.clearQueue());
	}

	private async freeVram(port: number): Promise<void> {
		const client = this.comfyByPort.get(port);
		if (!client) return;
		await run(this.pollers(), `free VRAM :${port}`, () => client.free(true, true));
	}

	// ------------------------------------------------------------------
	// websocket — live progress
	// ------------------------------------------------------------------

	private openWss(): void {
		const ports = this.comfyPorts();
		const clients = this.plugin.clients?.comfy ?? [];
		ports.forEach((port, i) => {
			const client = clients[i];
			if (!client || this.wss.has(port)) return;
			this.comfyByPort.set(port, client);
			const clientId = `arthur-${port}-${Math.random().toString(36).slice(2, 8)}`;
			const url = `${client.baseUrl.replace(/^http:/, "ws:")}/ws?clientId=${clientId}`;
			const conn = new WsConnection(url, {
				onProgress: (data) => this.wsProgress(port, data),
				onEvent: (type, data) => this.wsEvent(port, type, data),
				onStateChanged: (state) => this.wsStateChanged(port, state),
			});
			conn.open();
			this.wss.set(port, conn);
		});
	}

	private closeWss(): void {
		for (const conn of this.wss.values()) conn.close();
		this.wss.clear();
	}

	private wsStateChanged(port: number, state: WsState): void {
		if (!this.open) return;
		const panel = this.panels.get(port);
		if (!panel) return;
		switch (state) {
			case WsState.Open:
				setDot(panel.wsDot, true);
				panel.wsLabel.setText("ws live");
				// (re)connect resync: re-poll queue + progress state
				void this.refreshData();
				return;
			case WsState.Connecting:
				setDot(panel.wsDot, null);
				panel.wsLabel.setText("ws connecting");
				return;
			case WsState.Backoff:
				setDot(panel.wsDot, false);
				panel.wsLabel.setText("ws down — reconnecting");
				return;
			case WsState.Closed:
				setDot(panel.wsDot, null);
				panel.wsLabel.setText("ws off");
				return;
		}
	}

	private wsProgress(port: number, data: any): void {
		if (!this.open) return;
		const panel = this.panels.get(port);
		if (!panel) return;
		const parsed = this.parseProgress(data, panel);
		if (parsed) {
			panel.progress = parsed;
			this.renderProgress(panel);
		}
	}

	/** ComfyUI emits both the classic "progress" event and the newer
	 *  "progress_state" batch — accept either shape. */
	private parseProgress(data: any, panel: ComfyPanel): GenProgress | null {
		if (!data || typeof data !== "object") return null;
		const graph = (panel.promptGraph ?? {}) as Record<string, any>;
		const classify = (nodeId: unknown, fallback: string | null): string => {
			if (fallback) return fallback;
			const id = String(nodeId ?? "");
			const def = id && Object.prototype.hasOwnProperty.call(graph, id)
				? graph[id]
				: null;
			return def?.class_type ?? (id ? `node ${id}` : "node");
		};

		if (Array.isArray(data.nodes)) {
			// progress_state: {prompt_id, nodes: [{id, state, progress,
			// progress_value, progress_total, node_type}]}
			let best: GenProgress | null = null;
			let bestRatio = -1;
			for (const n of data.nodes) {
				if (!n || typeof n !== "object") continue;
				if (typeof n.state === "string" && n.state !== "running") continue;
				let value = typeof n.progress_value === "number" ? n.progress_value : null;
				const max = typeof n.progress_total === "number" ? n.progress_total : 0;
				if (value == null && typeof n.progress === "number" && max > 0) {
					value = Math.round(n.progress * max);
				}
				if (value == null || value <= 0) continue;
				const ratio = value / (max > 0 ? max : 1);
				if (ratio > bestRatio) {
					bestRatio = ratio;
					best = {
						value,
						max,
						nodeLabel: classify(
							n.id ?? n.node,
							typeof n.node_type === "string" ? n.node_type : null,
						),
					};
				}
			}
			return best;
		}

		// classic: {value, max, node, prompt_id}
		if (typeof data.value !== "number") return null;
		return {
			value: data.value,
			max: typeof data.max === "number" ? data.max : 0,
			nodeLabel: classify(data.node, null),
		};
	}

	/** Non-progress WS events we care about — terminal execution states clear
	 *  the progress bar (PLAN 2.3: "job ended → clear progress"). */
	private wsEvent(port: number, type: string, _data: any): void {
		if (!this.open) return;
		const panel = this.panels.get(port);
		if (!panel) return;
		switch (type) {
			case "execution_success":
			case "execution_error":
			case "execution_interrupted":
				panel.progress = null;
				panel.runningPromptId = null;
				panel.promptGraph = null;
				this.renderProgress(panel);
				return;
			default:
				return;
		}
	}
}
