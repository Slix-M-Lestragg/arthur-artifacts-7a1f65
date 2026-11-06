/**
 * Arthur dashboard — desktop ItemView with four stacked sections:
 *   0. SERVICES    — one pill button per agent service (src/ui/service-bar.ts):
 *                    click = start (inactive) / spawn (active), red kill zone
 *                    = stop ALL instances (confirm + force modals)
 *   1. INSTANCES   — agent-reported per-instance rows (id, port, GPU, up/
 *                    uptime, VRAM) with lifecycle buttons via arthur-agent;
 *                    when the agent is unreachable the settings comfyPorts
 *                    render as unmanaged rows without lifecycle controls
 *   2. GENERATION  — per ComfyUI port: queue depth, running prompt info,
 *                    live WS progress bar, job control buttons; ports come
 *                    from the agent's discovered instances (settings list is
 *                    the fallback only)
 *   3. TRAINING    — ai-toolkit job table + per-GPU-set queue toggles, bound
 *                    to the settings aiToolkitPort; its header shows the
 *                    aitoolkit service active state from the agent
 *
 * The DOM skeleton (service bar, top bar, section boxes, cards, table header)
 * is built once in onOpen; poll ticks and WS events only update text,
 * classes, attributes and bar widths. The instance rows, training <tbody>,
 * the pending-prompt list and preview strip are refilled because their rows
 * legitimately appear and disappear (spawn/stop) — everything else is cached
 * per port.
 *
 * Instance discovery (agent API v0.5.0): /api/status lists services with
 * computed instances; the generation panels + WS sockets attach to the
 * comfyui service's instance ports in agent order. The panel set is rebuilt
 * only when that ordered port list changes (or the profile host changed).
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
import type { AgentInstance, AgentService, AgentStatus } from "../api/agent";
import type { AiToolkitJob } from "../api/aitoolkit";
import type { ComfyUIClient, QueueResponse, SystemStats } from "../api/comfy";
import { parseComfyBinaryFrame } from "../comfy-frame";
import { WsConnection, WsState } from "../connection";
import { renderLossChart } from "./loss-chart";
import { el, fmtBytes, fmtClockTime, fmtDuration, truncate } from "../util";
import { ArthurApiError } from "../api/transport";
import { ServiceBar } from "./service-bar";
import { confirmModal, describeError, run, toastErr, toastOk } from "./actions";

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
	/** /api/status succeeded (token accepted) — gates lifecycle UI. */
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

/** One comfy port the generation cards are attached to. */
interface DesiredPort {
	port: number;
	/** Card title + topbar dot label: instance id + GPU, or "unmanaged". */
	label: string;
}

/** Cached DOM widgets + bookkeeping for one comfy port. */
interface GenPanel {
	port: number;
	// generation card
	titleEl: HTMLElement;
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
	previewStrip: HTMLElement;
	// bookkeeping
	progress: GenProgress | null;
	/** node id → node definition of the running prompt (from /queue). */
	promptGraph: Record<string, any> | null;
	runningPromptId: string | null;
	pendingIds: string[];
	/** Live preview object URLs, newest first (ring buffer, revoked on evict). */
	previewUrls: string[];
}

/** Accordion state for one training job row (local to the view, not persisted). */
interface JobPanelUi {
	chart: boolean;
	logs: boolean;
}

/** Accumulated (incremental) one metric key of a training job's loss series. */
interface JobLossEntry {
	steps: number[];
	values: Array<number | null>;
	/** Highest step merged so far — dedupe floor for incremental appends. */
	lastStep: number;
}

interface JobLossCache {
	keys: string[];
	series: Map<string, JobLossEntry>;
}

/** Incrementally tailed training log, capped to the newest lines. */
interface JobLogCache {
	/** Byte offset to pass back as ?offset= on the next poll. */
	offset: number;
	text: string;
}

/** Per-GPU-set queue row as consumed by the training queue list. */
interface AiToolkitQueueRow {
	id: string | number;
	gpu_ids: string;
	is_running: boolean;
}

/** Never-throw wrapper for best-effort probes — keeps the error for diagnostics. */
async function tryCall<T>(fn: () => Promise<T>): Promise<{ value: T | null; error: unknown }> {
	try {
		return { value: await fn(), error: null };
	} catch (err) {
		return { value: null, error: err };
	}
}

/**
 * Offline tooltip text for a failed service probe: WHAT failed, WHY (last
 * error) and WHERE (the host:port actually attempted — no token material).
 */
function errTooltip(hostPort: string, error: string | null): string {
	return `last attempt ${hostPort} — ${error ?? "not responding"}`;
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
	// NOTE: never name a field `open` on an ItemView subclass — Obsidian's
	// View base class has an internal open(containerEl) method that
	// Leaf.setViewState → Leaf.open calls (await view.open(el) → load() +
	// onOpen()). An `open` class field shadows it with a boolean and the leaf
	// dies with "TypeError: e.open is not a function" (blank dashboard).
	private isOpened = false;
	private readonly panels = new Map<number, GenPanel>();
	private readonly wss = new Map<number, WsConnection>();
	/** Host the current cards + WS sockets were built for (staleness check). */
	private wsHost: string | null = null;
	/** Ports the generation cards are attached to, in render order. */
	private activePorts: DesiredPort[] = [];
	private skeletonBuilt = false;

	// cached section roots
	private serviceBarEl!: HTMLElement;
	private serviceBar!: ServiceBar;
	private profileEl!: HTMLElement;
	private readonly topDots = new Map<string, HTMLElement>();
	private updatedEl!: HTMLElement;
	/** One-line last-errors summary (hidden while everything answers). */
	private lastErrorsEl!: HTMLElement;
	private bannerEl!: HTMLElement;
	private instanceCardsEl!: HTMLElement;
	private trainingSvcEl!: HTMLElement;
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

	// training accordion state (job id → state; cleared on close/unload/job delete)
	private readonly jobUi = new Map<string, JobPanelUi>();
	private readonly jobLoss = new Map<string, JobLossCache>();
	private readonly jobLog = new Map<string, JobLogCache>();
	/** In-flight guard per loss/log fetch ("loss:<id>" / "log:<id>"). */
	private readonly jobFetchBusy = new Set<string>();
	/** Mounted accordion containers per job id, replaced on each tbody refill. */
	private readonly jobPanelEls = new Map<
		string,
		{ chart?: HTMLElement; log?: HTMLElement }
	>();

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
		return this.isOpened && this.contentEl.isShown();
	}

	/**
	 * The plugin runtime was rebuilt (settings change) — repaint immediately
	 * so an open dashboard never needs manual refresh / view recreation.
	 */
	onRuntimeChanged(): Promise<void> {
		return this.refreshData();
	}

	/** Settings comfyPorts list — the offline fallback for instance discovery. */
	private comfyPorts(): number[] {
		return this.plugin.comfyPorts;
	}

	/**
	 * Comfy ports to attach generation cards to: the comfyui service's
	 * discovered instances (agent order) when /api/status answers — the
	 * settings comfyPorts list (labeled unmanaged) only when it doesn't.
	 */
	private desiredPorts(): DesiredPort[] {
		const comfy = this.agentDetail.status?.services.find((s) => s.id === "comfyui");
		if (this.agentDetail.statusOk === true && comfy) {
			return comfy.instances.map((i) => ({
				port: i.port,
				label: `${i.id}${i.gpu != null ? ` · GPU ${i.gpu}` : ""} · :${i.port}`,
			}));
		}
		return this.comfyPorts().map((p) => ({ port: p, label: `ComfyUI :${p} · unmanaged` }));
	}

	/** Both pollers, handed to run() so mutations trigger an immediate re-poll. */
	private pollers(): Array<{ pollNow(): void }> {
		const clients = this.plugin.clients;
		return clients ? [clients.lightPoller, clients.detailPoller] : [];
	}

	/** Comfy client for a dynamically discovered port (settings client or on-demand). */
	private clientFor(port: number): ComfyUIClient | null {
		return this.plugin.comfyClientFor(port);
	}

	// ------------------------------------------------------------------
	// lifecycle
	// ------------------------------------------------------------------

	async onOpen(): Promise<void> {
		this.isOpened = true;
		this.contentEl.empty();
		this.panels.clear();
		this.wsHost = null;
		this.activePorts = [];
		this.skeletonBuilt = false;
		this.buildSkeleton(this.desiredPorts());
		this.openWss();
		this.plugin.dashboardView = this;
		// Belt-and-braces: if teardown ever skips onClose, sockets and caches
		// (object URLs, loss series, log tails) still get released.
		this.register(() => {
			this.closeWss();
			this.clearAllPreviews();
			this.clearTrainingState();
		});
		// Immediate first fill after the synchronously rendered skeleton: without
		// this, the user's first paint of data waits for the next 3s detail tick
		// (and the gate below no-ops that tick if layout isn't finished yet).
		void this.refreshData();
	}

	async onClose(): Promise<void> {
		this.isOpened = false;
		this.closeWss();
		this.clearAllPreviews();
		this.clearTrainingState();
		if (this.plugin.dashboardView === this) this.plugin.dashboardView = null;
		this.contentEl.empty();
	}

	/** Detail poller entry point — fetch everything, then paint. */
	async refreshData(): Promise<void> {
		const clients = this.plugin.clients;
		if (!this.visible() || !clients) return;
		const profile = clients.profile;

		// Not configured yet (still empty host) — paint the placeholder state,
		// never the network. The skeleton + cards above are already up.
		if (!profile.host) {
			this.comfyDetail = [];
			this.agentDetail = {
				healthOk: null,
				statusOk: null,
				status: null,
				error: null,
			};
			this.aiDetail = {
				reachable: false,
				jobs: [],
				queues: [],
				error: "not configured",
			};
			this.lastTick = null;
			// Port set may have changed in settings while the view sat open.
			this.syncSkeleton();
			this.renderTopBar(profile.name, "");
			this.renderBanner();
			this.renderServiceBar();
			this.renderInstanceRows();
			this.renderGeneration();
			this.renderTraining();
			return;
		}

		// Agent status first — it defines the instance list every other card
		// hangs off of (the settings port list is the unreachable fallback).
		const health = await tryCall(() => clients.agent.health());
		const healthOk = health.value !== null;
		const statusRes = healthOk
			? await tryCall(() => clients.agent.status())
			: { value: null as AgentStatus | null, error: null as unknown };
		const status: AgentStatus | null = statusRes.value;
		this.agentDetail = {
			healthOk,
			statusOk: status !== null,
			status,
			error: !healthOk
				? health.error
					? describeError(health.error)
					: "unreachable"
				: status !== null
					? null
					: statusRes.error
						? describeError(statusRes.error)
						: "status failed (token rejected?)",
		};

		// Settings may have changed, or the agent discovered/removed instances
		// (spawn/stop) — resync the cached cards + WS sockets with the current
		// host/port set before fetching. Rebuild only, never per tick; when the
		// port set is unchanged the labels still follow each tick's discovery
		// (e.g. discovered ↔ unmanaged fallback flips without a card rebuild).
		this.syncSkeleton();
		const desired = this.desiredPorts();
		this.activePorts = desired;
		const stale =
			profile.host !== this.wsHost ||
			!this.skeletonBuilt ||
			desired.map((p) => p.port).join(",") !==
				this.activePorts.map((p) => p.port).join(",");
		if (stale) this.rebuildPortPanels(desired);

		// Inner promises never reject; per-port failures land in .error.
		this.comfyDetail = await Promise.all(
			desired.map(async ({ port }): Promise<ComfyPortDetail> => {
				const client = this.clientFor(port);
				if (!client) return { online: null, stats: null, queue: null, error: null };
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
		this.renderServiceBar();
		this.renderInstanceRows();
		this.renderGeneration();
		this.renderTraining();
	}

	// ------------------------------------------------------------------
	// skeleton
	// ------------------------------------------------------------------

	private syncSkeleton(): void {
		const clients = this.plugin.clients;
		const desired = this.desiredPorts();
		const stale =
			(clients?.profile.host ?? null) !== this.wsHost ||
			!this.skeletonBuilt ||
			desired.map((p) => p.port).join(",") !==
				this.activePorts.map((p) => p.port).join(",");
		if (!stale) return;
		this.rebuildPortPanels(desired);
	}

	/**
	 * Tear down and rebuild the port cards + WS sockets so they match the
	 * current profile (host or discovered port set changed while open).
	 * Called from refreshData before any fetch — the poll cycle fills in data.
	 */
	private rebuildPortPanels(desired: DesiredPort[]): void {
		this.closeWss();
		this.clearAllPreviews();
		this.panels.clear();
		this.contentEl.empty();
		this.buildSkeleton(desired);
		this.openWss();
		this.wsHost = this.plugin.clients?.profile.host ?? null;
	}

	private buildSkeleton(ports: DesiredPort[]): void {
		this.topDots.clear();
		const root = this.contentEl.createEl("div", { cls: "arthur-dashboard" });

		// service pill row — top surface for service-level lifecycle
		this.serviceBarEl = root.createEl("div", { cls: "arthur-service-bar" });
		this.serviceBar = new ServiceBar(this.serviceBarEl, {
			onStart: (svc) => void this.serviceStartAction(svc),
			onSpawn: (svc) => void this.serviceSpawnAction(svc),
			onKill: (svc) => this.serviceKillAction(svc),
		});

		// thin top summary bar
		const top = root.createEl("div", { cls: "arthur-topbar" });
		this.profileEl = top.createEl("span", { cls: "arthur-topbar-profile" });
		const dotsBox = top.createEl("span", { cls: "arthur-topbar-dots" });
		const dotSpecs: Array<[string, string]> = [
			...ports.map((p) => [`c${p.port}`, p.label] as [string, string]),
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
		this.lastErrorsEl = top.createEl("span", { cls: "arthur-topbar-errors" });
		this.lastErrorsEl.hide();
		this.updatedEl = top.createEl("span", { cls: "arthur-topbar-updated" });

		// banner slot (agent unreachable / token / version mismatch)
		this.bannerEl = root.createEl("div", { cls: "arthur-banner" });
		this.bannerEl.hide();

		// instances section — rows refilled per tick (instances legitimately
		// appear/disappear on spawn/stop)
		const instancesSection = root.createEl("div", { cls: "arthur-section" });
		instancesSection.createEl("h4", { text: "Instances" });
		this.instanceCardsEl = instancesSection.createEl("div", { cls: "arthur-cards" });
		this.instanceCardsEl.append(
			el("p", { cls: "arthur-note", text: "loading…" }),
		);

		// generation section — one cached card per discovered/fallback port
		const genSection = root.createEl("div", { cls: "arthur-section" });
		genSection.createEl("h4", { text: "Generation" });
		const generationBox = genSection.createEl("div", { cls: "arthur-cards" });
		for (const p of ports) {
			generationBox.append(this.buildGenCard(p));
		}
		if (ports.length === 0) {
			const note = "no ComfyUI instances configured — set Host and ComfyUI ports in the arthur settings";
			generationBox.append(el("p", { cls: "arthur-note", text: note }));
		}

		// training section
		const trainingSection = root.createEl("div", { cls: "arthur-section" });
		const trainingHead = trainingSection.createEl("h4", { text: "Training (ai-toolkit)" });
		this.trainingSvcEl = trainingHead.createEl("span", {
			cls: "arthur-training-service",
		});
		this.trainingSvcEl.hide();
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

		// Port list the cards+WS are now built for.
		this.activePorts = ports;
		this.skeletonBuilt = true;
	}

	/** Build the generation card for one port and cache its widgets. */
	private buildGenCard(p: DesiredPort): HTMLElement {
		const port = p.port;
		const buttonRow = (...btns: HTMLButtonElement[]) =>
			el("div", { cls: "arthur-btn-row", children: btns });

		const titleEl = el("span", { cls: "arthur-card-title", text: p.label });
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
		const previewStrip = el("div", { cls: "arthur-preview-strip" });
		previewStrip.hide();
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
				children: [genDot, titleEl, wsDot, wsLabel, queueEl],
			}),
			el("div", { cls: "arthur-bar", children: [progressFill] }),
			progressLabel,
			runningEl,
			pendingWrap,
			previewStrip,
			buttonRow(btnCancel, btnClear, btnFree),
		);

		this.panels.set(port, {
			port,
			titleEl,
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
			previewStrip,
			progress: null,
			promptGraph: null,
			runningPromptId: null,
			pendingIds: [],
			previewUrls: [],
		});
		return genCard;
	}

	// ------------------------------------------------------------------
	// rendering
	// ------------------------------------------------------------------

	private renderTopBar(profileName: string, host: string): void {
		this.profileEl.setText(host ? `${profileName} @ ${host}` : profileName);
		const clients = this.plugin.clients;
		const hostPort = (port: number) => (host ? `${host}:${port}` : "(not configured)");
		this.activePorts.forEach((p, i) => {
			const dot = this.topDots.get(`c${p.port}`);
			const d = this.comfyDetail[i] ?? null;
			if (dot) {
				setDot(dot, d?.online ?? null);
				// Offline diagnostics: why the dot is red + the URL attempted.
				dot.setAttribute(
					"title",
					(d?.online === false
						? errTooltip(hostPort(p.port), d.error)
						: `${p.label} — ${d?.online === true ? "ok" : "waiting for data…"}`),
				);
			}
		});
		const aitk = this.topDots.get("aitk");
		const aiReachable = this.aiDetail.reachable ?? null;
		if (aitk) {
			setDot(aitk, aiReachable);
			aitk.setAttribute(
				"title",
				aiReachable === false
					? errTooltip(hostPort(clients?.profile.aiToolkitPort ?? 0), this.aiDetail.error)
					: `ai-toolkit — ${aiReachable === true ? "ok" : "waiting for data…"}`,
			);
		}
		const agent = this.topDots.get("agent");
		const agentOk = this.agentDetail.statusOk ?? this.agentDetail.healthOk;
		if (agent) {
			setDot(agent, agentOk);
			agent.setAttribute(
				"title",
				agentOk === false
					? errTooltip(hostPort(clients?.profile.agentPort ?? 0), this.agentDetail.error)
					: `arthur-agent — ${agentOk === true ? "ok" : "waiting for data…"}`,
			);
		}

		// One-line last-errors summary: every service that failed on the last
		// tick with its last error + attempted host:port (no token material).
		const errors: string[] = [];
		this.activePorts.forEach((p, i) => {
			const d = this.comfyDetail[i];
			if (d?.online === false) errors.push(`ComfyUI ${hostPort(p.port)} — ${d.error ?? "not responding"}`);
		});
		if (this.aiDetail.reachable === false && this.aiDetail.error) {
			errors.push(`ai-toolkit ${hostPort(clients?.profile.aiToolkitPort ?? 0)} — ${this.aiDetail.error}`);
		}
		if (this.agentDetail.error) {
			errors.push(`agent ${hostPort(clients?.profile.agentPort ?? 0)} — ${this.agentDetail.error}`);
		}
		if (errors.length > 0) {
			this.lastErrorsEl.setText(`errors: ${errors.join(" · ")}`);
			this.lastErrorsEl.setAttribute("title", errors.join("\n"));
			this.lastErrorsEl.show();
		} else {
			this.lastErrorsEl.hide();
		}
		this.updatedEl.setText(`upd ${fmtClockTime(this.lastTick)}`);
	}

	private renderBanner(): void {
		const clients = this.plugin.clients;
		if (clients && !clients.profile.host) {
			this.bannerEl.setText(
				"arthur is not configured — set the server host in the plugin settings",
			);
			this.bannerEl.show();
			return;
		}
		const ad = this.agentDetail;
		let message: string | null = null;
		if (ad.healthOk === false) {
			message = `agent unreachable (${ad.error ?? "offline"}) — instance lifecycle disabled`;
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

	/** Service pills: disabled unless /api/status answered (health AND token). */
	private renderServiceBar(): void {
		this.serviceBar.render({
			agentOk: this.agentDetail.statusOk === true,
			error: this.agentDetail.error,
			services: this.agentDetail.status?.services ?? [],
		});
	}

	/** Instance rows, refilled per tick (spawns/stops change the set). */
	private renderInstanceRows(): void {
		const container = this.instanceCardsEl;
		container.empty();
		const host = this.plugin.clients?.profile.host ?? "";
		const hostPort = (port: number) => (host ? `${host}:${port}` : "(not configured)");
		const ad = this.agentDetail;

		if (ad.statusOk === true && ad.status) {
			for (const svc of ad.status.services) {
				container.append(
					el("h5", {
						cls: "arthur-inst-group",
						children: [
							el("span", { text: svc.name ?? svc.id }),
							el("span", {
								cls: "arthur-card-meta",
								text: `${svc.active ? "active" : "idle"} · ${svc.instances.length} instance${svc.instances.length === 1 ? "" : "s"}`,
							}),
						],
					}),
				);
				if (svc.instances.length === 0) {
					container.append(el("p", { cls: "arthur-note", text: "no instances" }));
					continue;
				}
				for (const inst of svc.instances) {
					container.append(this.buildInstanceRow(svc, inst, hostPort));
				}
			}
			return;
		}

		// Agent unreachable / token rejected — the settings port list renders
		// unmanaged: HTTP state is visible, lifecycle controls are not offered.
		const reason = ad.healthOk === false ? "unreachable" : "token rejected";
		container.append(
			el("h5", {
				cls: "arthur-inst-group",
				children: [
					el("span", { text: "ComfyUI" }),
					el("span", { cls: "arthur-card-meta", text: `unmanaged — agent ${reason}` }),
				],
			}),
		);
		if (this.activePorts.length === 0) {
			container.append(
				el("p", {
					cls: "arthur-note",
					text: "no ComfyUI instances configured — set Host and ComfyUI ports in the arthur settings",
				}),
			);
			return;
		}
		for (const p of this.activePorts) {
			container.append(this.buildUnmanagedRow(p, hostPort));
		}
	}

	/** One agent-reported instance card (lifecycle buttons + VRAM). */
	private buildInstanceRow(svc: AgentService, inst: AgentInstance, hostPort: (port: number) => string): HTMLElement {
		const detailIdx = this.activePorts.findIndex((p) => p.port === inst.port);
		const detail = detailIdx >= 0 ? this.comfyDetail[detailIdx] ?? null : null;
		const name = inst.name ?? inst.id;
		const offlineTip = errTooltip(hostPort(inst.port), detail?.error ?? null);

		const dot = el("span", { cls: "arthur-dot arthur-dot--gray" });
		setDot(dot, inst.up);
		dot.setAttribute(
			"title",
			`agent: ${inst.up ? "instance up" : "instance down"}` +
				(detail?.online === false ? ` · HTTP not responding (${offlineTip})` : ""),
		);
		const metaParts = [`:${inst.port}`];
		if (inst.gpu != null) metaParts.push(`GPU ${inst.gpu}`);
		metaParts.push(`agent: ${inst.up ? `up · uptime ${fmtDuration(inst.uptime ?? undefined)}` : "down"}`);
		if (detail?.online === false) metaParts.push("HTTP not responding");
		const meta = el("span", { cls: "arthur-card-meta", text: metaParts.join(" · ") });

		const card = el("div", { cls: "arthur-card" });
		card.append(el("div", { cls: "arthur-card-head", children: [dot, el("span", { cls: "arthur-card-title", text: name }), meta] }));

		// VRAM bar — devices[0] (instances are single-GPU).
		if (inst.service === "comfyui") {
			const vramFill = el("div", { cls: "arthur-bar-fill" });
			vramFill.style.width = "0%";
			const vramLabel = el("span", { cls: "arthur-card-meta", text: "VRAM ?" });
			const device = detail?.stats?.devices?.[0];
			if (device && device.vram_total > 0) {
				const used = Math.max(0, device.vram_total - device.vram_free);
				vramFill.style.width = `${Math.round((100 * used) / device.vram_total)}%`;
				vramLabel.setText(`VRAM ${fmtBytes(used)} / ${fmtBytes(device.vram_total)}`);
			} else if (detail?.online === false) {
				vramLabel.setText("VRAM n/a — not responding");
				vramLabel.setAttribute("title", offlineTip);
			}
			card.append(el("div", { cls: "arthur-bar", children: [vramFill] }), vramLabel);
		}

		// Lifecycle — the agent refuses destructive ops while a generation runs
		// (409), which the handlers escalate to a force-confirmation modal.
		const label = (action: string) => `${action} ${name}`;
		const btnStart = newBtn("Start");
		const btnStop = newBtn("Stop");
		const btnRestart = newBtn("Restart");
		btnStart.addEventListener("click", () => void this.instanceLifecycle(svc.id, inst.id, label("start"), "start"));
		btnStop.addEventListener("click", () => {
			confirmModal(
				this.app,
				"Stop instance",
				`Gracefully stop ${name} on port ${inst.port}? The agent refuses while a generation is running.`,
				() => void this.instanceLifecycle(svc.id, inst.id, label("stop"), "stop"),
			);
		});
		btnRestart.addEventListener("click", () => {
			confirmModal(
				this.app,
				"Restart instance",
				`Restart ${name} on port ${inst.port}? It is down until the port comes back up (~30s).`,
				() => void this.instanceLifecycle(svc.id, inst.id, label("restart"), "restart"),
			);
		});
		card.append(el("div", { cls: "arthur-btn-row", children: [btnStart, btnStop, btnRestart] }));
		return card;
	}

	/** Unmanaged row for a settings port (no lifecycle controls). */
	private buildUnmanagedRow(p: DesiredPort, hostPort: (port: number) => string): HTMLElement {
		const i = this.activePorts.findIndex((q) => q.port === p.port);
		const detail = i >= 0 ? this.comfyDetail[i] ?? null : null;
		const offlineTip = errTooltip(hostPort(p.port), detail?.error ?? null);

		const dot = el("span", { cls: "arthur-dot arthur-dot--gray" });
		setDot(dot, detail?.online ?? null);
		dot.setAttribute(
			"title",
			detail?.online === false
				? offlineTip
				: `ComfyUI :${p.port} HTTP — ${detail?.online === true ? "ok" : "waiting for data…"}`,
		);
		const meta = el("span", { cls: "arthur-card-meta", text: `:${p.port} · unmanaged — lifecycle disabled` });
		meta.setAttribute("title", detail?.online === false ? offlineTip : "");

		const card = el("div", { cls: "arthur-card" });
		card.append(el("div", { cls: "arthur-card-head", children: [dot, el("span", { cls: "arthur-card-title", text: `ComfyUI :${p.port}` }), meta] }));

		const vramFill = el("div", { cls: "arthur-bar-fill" });
		vramFill.style.width = "0%";
		const vramLabel = el("span", { cls: "arthur-card-meta", text: "VRAM ?" });
		const device = detail?.stats?.devices?.[0];
		if (device && device.vram_total > 0) {
			const used = Math.max(0, device.vram_total - device.vram_free);
			vramFill.style.width = `${Math.round((100 * used) / device.vram_total)}%`;
			vramLabel.setText(`VRAM ${fmtBytes(used)} / ${fmtBytes(device.vram_total)}`);
		} else if (detail?.online === false) {
			vramLabel.setText("VRAM n/a — not responding");
			vramLabel.setAttribute("title", offlineTip);
		}
		card.append(el("div", { cls: "arthur-bar", children: [vramFill] }), vramLabel);
		return card;
	}

	private renderGeneration(): void {
		const host = this.plugin.clients?.profile.host ?? "";
		this.activePorts.forEach((p, i) => {
			const panel = this.panels.get(p.port);
			if (!panel) return;
			const detail = this.comfyDetail[i] ?? null;
			const online = detail?.online === true;
			const running = Array.isArray(detail?.queue?.queue_running)
				? (detail!.queue!.queue_running as unknown[])
				: [];
			const pending = Array.isArray(detail?.queue?.queue_pending)
				? (detail!.queue!.queue_pending as unknown[])
				: [];

			panel.titleEl.setText(p.label);
			setDot(panel.genDot, detail?.online ?? null);
			panel.genDot.setAttribute(
				"title",
				detail?.online === false
					? errTooltip(host ? `${host}:${p.port}` : "(not configured)", detail.error)
					: `${p.label} — ${detail?.online === true ? "ok" : "waiting for data…"}`,
			);
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
					del.addEventListener("click", () => void this.deletePending(p.port, id));
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

	private renderProgress(panel: GenPanel): void {
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
		// Header service state: the aitoolkit service's live state from the agent.
		const aitk = this.agentDetail.status?.services.find((s) => s.id === "aitoolkit");
		if (this.agentDetail.statusOk === true && aitk) {
			this.trainingSvcEl.setText(` — agent: ${aitk.active ? "active" : "idle"}`);
			this.trainingSvcEl.show();
		} else {
			this.trainingSvcEl.hide();
		}

		const detail = this.aiDetail;
		if (detail.reachable !== true) {
			const host = this.plugin.clients?.profile.host ?? "";
			const aiPort = this.plugin.clients?.profile.aiToolkitPort ?? 0;
			this.trainingNoteEl.setText(
				`ai-toolkit not responding — ${detail.error ?? "no data"}` +
					(detail.error?.includes("401") === true ? " · check ai-toolkit token in settings" : ""),
			);
			this.trainingNoteEl.setAttribute(
				"title",
				`${host ? `${host}:${aiPort}` : "(not configured)"} — ${detail.error ?? "no data"}`,
			);
			this.trainingNoteEl.show();
			this.trainingBodyEl.empty();
			this.trainingQueueEl.empty();
			return;
		}
		this.trainingNoteEl.hide();
		// Drop caches/state for jobs that no longer exist (deleted or job list rebuilt).
		this.pruneTrainingState();
		this.trainingBodyEl.empty();
		this.jobPanelEls.clear();
		for (const job of detail.jobs) {
			this.trainingBodyEl.append(this.jobRow(job));
			const ui = this.jobUi.get(job.id);
			if (ui?.chart === true) void this.fetchJobLoss(job.id);
			if (ui?.logs === true) void this.fetchJobLog(job.id);
		}
		this.trainingQueueEl.empty();
		if (detail.queues.length === 0) {
			this.trainingQueueEl.append(
				el("span", { cls: "arthur-card-meta", text: "no queues" }),
			);
			return;
		}
		for (const q of detail.queues) this.trainingQueueEl.append(this.queueRow(q));
	}

	private jobRow(job: AiToolkitJob): DocumentFragment {
		const clients = this.plugin.clients!;
		const pollers = this.pollers();
		const name = truncate(job.name, 28);
		const label = (action: string) => `${action} ${name}`;
		const ui = this.jobUiState(job.id);

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
		const toggle = (key: "chart" | "logs", text: string) => {
			const b = btn(text, () => this.toggleJobPanel(job.id, key), false);
			if (ui[key] === true) b.addClass("arthur-btn--active");
			return b;
		};
		actions.append(
			toggle("chart", "Chart"),
			toggle("logs", "Logs"),
			btn("Start", () => void run(pollers, label("Start"), () => clients.aitoolkit.jobStart(job.id)), running || job.status === "stopping"),
			btn("Stop", () => void run(pollers, label("Stop (graceful)"), () => clients.aitoolkit.jobStop(job.id)), !running && job.status !== "stopping"),
			btn("Kill", () => confirmRun("Kill job", `Force-kill "${job.name}" (SIGKILL)? The trainer gets no chance to save or clean up.`, () => clients.aitoolkit.jobKill(job.id)), job.pid == null),
			btn("Delete", () => confirmRun("Delete job", `Delete training job "${job.name}"? Results already written stay on disk.`, () => clients.aitoolkit.jobDelete(job.id)), false),
			btn("Mark stopped", () => void run(pollers, label("Mark stopped"), () => clients.aitoolkit.jobMarkStopped(job.id)), job.status !== "error"),
			btn("Save now", () => void run(pollers, label("Save now"), () => clients.aitoolkit.jobSaveNow(job.id)), !running || job.save_now),
			btn("Sample now", () => void run(pollers, label("Sample now"), () => clients.aitoolkit.jobSampleNow(job.id)), !running || job.sample_now),
		);

		const row = el("tr", {
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

		const frag = document.createDocumentFragment();
		frag.append(row);
		if (ui.chart || ui.logs) frag.append(this.jobPanelRow(job.id, ui));
		return frag;
	}

	// ------------------------------------------------------------------
	// training accordion — loss chart + incremental log tail
	// ------------------------------------------------------------------

	private jobUiState(jobId: string): JobPanelUi {
		let ui = this.jobUi.get(jobId);
		if (!ui) {
			ui = { chart: false, logs: false };
			this.jobUi.set(jobId, ui);
		}
		return ui;
	}

	private toggleJobPanel(jobId: string, key: "chart" | "logs"): void {
		const ui = this.jobUiState(jobId);
		ui[key] = !ui[key];
		this.renderTraining();
	}

	/** Drop caches + accordion state for jobs that no longer exist. */
	private pruneTrainingState(): void {
		const ids = new Set(this.aiDetail.jobs.map((j) => j.id));
		for (const map of [this.jobUi, this.jobLoss, this.jobLog]) {
			for (const id of map.keys()) {
				if (!ids.has(id)) map.delete(id);
			}
		}
		for (const busy of [...this.jobFetchBusy]) {
			const id = busy.split(":")[1];
			if (id && !ids.has(id)) this.jobFetchBusy.delete(busy);
		}
	}

	/** Clear all accordion caches/state (view close / plugin unload). */
	private clearTrainingState(): void {
		this.jobUi.clear();
		this.jobLoss.clear();
		this.jobLog.clear();
		this.jobFetchBusy.clear();
		this.jobPanelEls.clear();
	}

	/** Expandable <tr> under a job row, holding the chart and/or log panels. */
	private jobPanelRow(jobId: string, ui: JobPanelUi): HTMLElement {
		const mounted: { chart?: HTMLElement; log?: HTMLElement } = {};
		const stack = el("div", { cls: "arthur-panel-stack" });
		if (ui.chart) {
			mounted.chart = el("div", { cls: "arthur-chart-wrap" });
			stack.append(mounted.chart);
		}
		if (ui.logs) {
			mounted.log = el("div", { cls: "arthur-log-panel" });
			stack.append(mounted.log);
		}
		const cell = el("td", {
			cls: "arthur-job-panel-cell",
			attrs: { colspan: "7" },
			children: [stack],
		});
		this.jobPanelEls.set(jobId, mounted);
		if (mounted.chart) this.renderJobChart(mounted.chart, jobId);
		if (mounted.log) this.renderJobLog(mounted.log, jobId);
		return el("tr", { cls: "arthur-job-panel-row", children: [cell] });
	}

	/** Paint the loss chart panel from the accumulated cache (no fetch). */
	private renderJobChart(container: HTMLElement, jobId: string): void {
		container.empty();
		const cache = this.jobLoss.get(jobId);
		if (!cache) {
			container.createEl("div", { cls: "arthur-note", text: "loading loss data…" });
			return;
		}
		const maxKeys = this.plugin.settings.maxChartKeys;
		const series = cache.keys
			.filter((key) => cache.series.has(key))
			.slice(0, maxKeys)
			.map((key) => ({ key, data: cache.series.get(key)! }));
		renderLossChart(container, series);
	}

	/** Paint the log tail panel from the accumulated cache (no fetch). */
	private renderJobLog(container: HTMLElement, jobId: string): void {
		container.empty();
		const cache = this.jobLog.get(jobId);
		const pre = container.createEl("pre", { cls: "arthur-log-pre" });
		pre.textContent = cache ? (cache.text || "log is empty") : "loading log…";
		// Tail behavior: keep the newest lines in view while expanded.
		container.scrollTop = container.scrollHeight;
	}

	/**
	 * Incremental loss fetch (runs on each detail tick while expanded). Request
	 * floor = min over keys of the merged highest step: keys that update on a
	 * slower cadence (per-epoch metrics) re-deliver the span since their last
	 * step, which the merge dedupes; keeps byte traffic bounded per key.
	 */
	private async fetchJobLoss(jobId: string): Promise<void> {
		const busyKey = `loss:${jobId}`;
		if (this.jobFetchBusy.has(busyKey)) return;
		this.jobFetchBusy.add(busyKey);
		try {
			const clients = this.plugin.clients;
			if (!clients) return;
			const cache = this.jobLoss.get(jobId) ?? { keys: [], series: new Map<string, JobLossEntry>() };
			if (!this.jobLoss.has(jobId)) this.jobLoss.set(jobId, cache);
			let sinceStep = 0;
			for (const entry of cache.series.values()) {
				sinceStep = sinceStep === 0 ? entry.lastStep : Math.min(sinceStep, entry.lastStep);
			}
			const resp = await clients.aitoolkit.jobLoss(jobId, sinceStep);
			cache.keys = resp.keys;
			for (const [key, incoming] of Object.entries(resp.series)) {
				let entry = cache.series.get(key);
				if (!entry) {
					entry = { steps: [], values: [], lastStep: -1 };
					cache.series.set(key, entry);
				}
				for (let i = 0; i < incoming.steps.length; i++) {
					const step = incoming.steps[i];
					if (step <= entry.lastStep) continue; // already merged
					entry.steps.push(step);
					entry.values.push(incoming.values[i] ?? null);
					entry.lastStep = step;
				}
			}
			const mounted = this.jobPanelEls.get(jobId);
			if (mounted?.chart) this.renderJobChart(mounted.chart, jobId);
		} catch {
			// Offline / transient failure — next tick retries.
		} finally {
			this.jobFetchBusy.delete(busyKey);
		}
	}

	/** Incremental log tail (runs on each detail tick while expanded). */
	private async fetchJobLog(jobId: string): Promise<void> {
		const busyKey = `log:${jobId}`;
		if (this.jobFetchBusy.has(busyKey)) return;
		this.jobFetchBusy.add(busyKey);
		try {
			const clients = this.plugin.clients;
			if (!clients) return;
			const cache = this.jobLog.get(jobId) ?? { offset: 0, text: "" };
			if (!this.jobLog.has(jobId)) this.jobLog.set(jobId, cache);
			const resp = await clients.aitoolkit.jobLog(jobId, cache.offset);
			if (resp.reset) cache.text = resp.log; // file truncated/rewritten — fresh tail
			else cache.text += resp.log;
			cache.offset = resp.offset;
			// Cap the panel to the newest ~200 lines.
			const lines = cache.text.split("\n");
			if (lines.length > 200) cache.text = lines.slice(-200).join("\n");
			const mounted = this.jobPanelEls.get(jobId);
			if (mounted?.log) this.renderJobLog(mounted.log, jobId);
		} catch {
			// Offline / transient failure — next tick retries.
		} finally {
			this.jobFetchBusy.delete(busyKey);
		}
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
	// service-level controls (service bar) + instance lifecycle (rows)
	// — all funnel through run()/toast + pollNow(): never optimistic UI
	// ------------------------------------------------------------------

	/** Inactive service clicked — start the default instance. */
	private async serviceStartAction(svc: AgentService): Promise<void> {
		const name = svc.name ?? svc.id;
		await run(this.pollers(), `start ${name}`, () =>
			this.plugin.clients!.agent.serviceStart(svc.id),
		);
	}

	/** Active service clicked — spawn a new instance. */
	private async serviceSpawnAction(svc: AgentService): Promise<void> {
		const agent = this.plugin.clients?.agent;
		if (!agent) return;
		const name = svc.name ?? svc.id;
		try {
			const res = await agent.serviceSpawn(svc.id);
			toastOk(`Spawned ${name} instance on port ${res.instance?.port ?? "?"}`);
		} catch (err) {
			// 409 single-instance service / max instances reached — surface the
			// agent's verbatim message; never crash on it.
			toastErr(`spawn ${name} — ${describeError(err)}`);
		} finally {
			for (const p of this.pollers()) p.pollNow();
		}
	}

	/** Kill zone clicked — confirm, then stop ALL instances (with force escalation). */
	private serviceKillAction(svc: AgentService): void {
		const name = svc.name ?? svc.id;
		confirmModal(
			this.app,
			`Stop all ${name} instances`,
			`Stop all ${name} instances? The agent refuses while a generation is running unless forced.`,
			() => void this.serviceStopAll(svc),
		);
	}

	private async serviceStopAll(svc: AgentService, force = false): Promise<void> {
		const agent = this.plugin.clients?.agent;
		if (!agent) return;
		const name = svc.name ?? svc.id;
		try {
			await agent.serviceStop(svc.id, force || undefined);
			toastOk(`stop ${name} — done`);
		} catch (err) {
			if (!force && err instanceof ArthurApiError && err.status === 409) {
				// Busied by running generations — offer the force path.
				confirmModal(
					this.app,
					`Force stop ${name}`,
					`Generations are running — ${describeError(err)}. Force stop all ${name} instances? Running generations are lost.`,
					() => void this.serviceStopAll(svc, true),
				);
			} else {
				toastErr(`stop ${name} — ${describeError(err)}`);
			}
		} finally {
			for (const p of this.pollers()) p.pollNow();
		}
	}

	/**
	 * One instance's lifecycle via the agent's per-instance endpoints; 409
	 * (generation running) escalates to a force-confirmation modal — exactly
	 * the service-level kill-zone contract, scoped to one instance.
	 */
	private async instanceLifecycle(
		svcId: string,
		instId: string,
		opLabel: string,
		action: "start" | "stop" | "restart",
		force = false,
	): Promise<void> {
		const agent = this.plugin.clients?.agent;
		if (!agent) return;
		const pollers = this.pollers();
		try {
			if (action === "start") await agent.instanceStart(svcId, instId);
			else if (action === "stop") await agent.instanceStop(svcId, instId, force || undefined);
			else await agent.instanceRestart(svcId, instId, force || undefined);
			toastOk(`${opLabel} — done`);
		} catch (err) {
			if (!force && action !== "start" && err instanceof ArthurApiError && err.status === 409) {
				confirmModal(
					this.app,
					"Generation running",
					`${describeError(err)}. Force ${action} ${instId}? Running generations are lost.`,
					() => void this.instanceLifecycle(svcId, instId, `${opLabel} (force)`, action, true),
				);
			} else {
				toastErr(`${opLabel} — ${describeError(err)}`);
			}
		} finally {
			for (const p of pollers) p.pollNow();
		}
	}

	private async cancelRunning(port: number): Promise<void> {
		const client = this.clientFor(port);
		if (!client) return;
		const pid = this.panels.get(port)?.runningPromptId ?? undefined;
		await run(this.pollers(), `cancel :${port}`, () => client.interrupt(pid));
	}

	private async deletePending(port: number, id: string): Promise<void> {
		const client = this.clientFor(port);
		if (!client) return;
		await run(this.pollers(), `delete queued prompt :${port}`, () =>
			client.deleteQueueItems([id]),
		);
	}

	private async clearQueue(port: number): Promise<void> {
		const client = this.clientFor(port);
		if (!client) return;
		await run(this.pollers(), `clear queue :${port}`, () => client.clearQueue());
	}

	private async freeVram(port: number): Promise<void> {
		const client = this.clientFor(port);
		if (!client) return;
		await run(this.pollers(), `free VRAM :${port}`, () => client.free(true, true));
	}

	// ------------------------------------------------------------------
	// websocket — live progress
	// ------------------------------------------------------------------

	private openWss(): void {
		const clients = this.plugin.clients;
		if (!clients) return;
		const profile = clients.profile;
		for (const p of this.activePorts) {
			const port = p.port;
			if (this.wss.has(port)) continue;
			if (!profile.host) continue; // nothing to connect to without a host
			const client = this.clientFor(port);
			if (!client) continue;
			const clientId = `arthur-${port}-${Math.random().toString(36).slice(2, 8)}`;
			const url = `${client.baseUrl.replace(/^http:/, "ws:")}/ws?clientId=${clientId}`;
			const conn = new WsConnection(url, {
				onProgress: (data) => this.wsProgress(port, data),
				onBinary: (data) => this.wsBinary(port, data),
				onEvent: (type, data) => this.wsEvent(port, type, data),
				onStateChanged: (state) => this.wsStateChanged(port, state),
			});
			conn.open();
			this.wss.set(port, conn);
		}
	}

	private closeWss(): void {
		for (const conn of this.wss.values()) conn.close();
		this.wss.clear();
	}

	private wsStateChanged(port: number, state: WsState): void {
		if (!this.isOpened) return;
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
		if (!this.isOpened) return;
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
	private parseProgress(data: any, panel: GenPanel): GenProgress | null {
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
		if (!this.isOpened) return;
		const panel = this.panels.get(port);
		if (!panel) return;
		switch (type) {
			case "execution_success":
			case "execution_error":
			case "execution_interrupted":
				panel.progress = null;
				panel.runningPromptId = null;
				panel.promptGraph = null;
				// Terminal event: generation is over — clear the preview strip too.
				this.clearPreviews(port);
				this.renderProgress(panel);
				return;
			default:
				return;
		}
	}

	// ------------------------------------------------------------------
	// websocket — live preview strip (typed binary frames)
	// ------------------------------------------------------------------

	/** Parse a typed ComfyUI binary frame and slot it into the preview ring. */
	private wsBinary(port: number, buffer: ArrayBuffer): void {
		if (!this.isOpened) return;
		const panel = this.panels.get(port);
		if (!panel) return;
		const frame = parseComfyBinaryFrame(buffer);
		if (!frame) return; // text frames / unknown types are not renderable
		const url = URL.createObjectURL(new Blob([frame.data], { type: frame.mimeType }));
		panel.previewUrls.unshift(url); // newest first
		const max = Math.max(1, this.plugin.settings.previewCount);
		while (panel.previewUrls.length > max) {
			const evicted = panel.previewUrls.pop();
			if (evicted) URL.revokeObjectURL(evicted);
		}
		this.renderPreviewStrip(panel);
	}

	private renderPreviewStrip(panel: GenPanel): void {
		panel.previewStrip.empty();
		if (panel.previewUrls.length === 0) {
			panel.previewStrip.hide();
			return;
		}
		for (const url of panel.previewUrls) {
			const img = document.createElement("img");
			img.className = "arthur-preview-thumb";
			img.src = url;
			panel.previewStrip.append(img);
		}
		panel.previewStrip.show();
	}

	/** Drop one instance's preview ring, revoking every object URL. */
	private clearPreviews(port: number): void {
		const panel = this.panels.get(port);
		if (!panel) return;
		for (const url of panel.previewUrls) URL.revokeObjectURL(url);
		panel.previewUrls = [];
		this.renderPreviewStrip(panel);
	}

	private clearAllPreviews(): void {
		for (const port of [...this.panels.keys()]) this.clearPreviews(port);
	}
}
